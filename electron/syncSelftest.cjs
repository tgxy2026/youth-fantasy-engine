// ============ 3.3.2 · 桌面端同步整链自检（`--desktop-sync-selftest`） ============
//
// 【为什么需要它】3.3.2 的验收项里有两条一直卡着：
//   ① 2.2–2.5「云 → 桌面 → 改 → 云」整链；
//   ② 4.x 冲突三选一的界面闭环。
// 卡的原因不是功能没写，而是**自动化工具只能控制 Chrome，控制不到 Electron 窗口** ——
// 于是桌面包里"点一个按钮"这件事以前只能靠人工。
//
// 【做法】主进程本来就是那个窗口的宿主：`webContents.executeJavaScript()` 可以把脚本注入
// **真实渲染层**（与用户看到的同一份 React 应用、同一份 IndexedDB、同一条 IPC 链路），
// 再配合主进程侧用令牌直连服务端做断言（云端 revision 是多少，只能从服务器读才可信）。
// 于是整条链路可以在一个进程里跑完，跑完即退，输出机器可读的结果行。
//
// 【为什么不写"测试专用后门"】注入的脚本只做三件事：读 `document.body.innerText`、
// 派发 `click`、给 textarea 设值并派发 `input`。它不 import 任何应用模块、不调用任何
// 应用内部函数 —— 走的全是用户点击会走的同一条路。这一点很重要：项目里已经有过
// "补丁打在死代码上、单测全绿而线上无变化"的教训（3.3.2 L7），
// 所以判据必须落在"界面上真的出现了/云端真的变了"，而不是"某个函数返回了 true"。
//
// 🔴 只在显式传 `--desktop-sync-selftest=<服务器地址>` 时生效；正常启动完全不经过本模块。
// 🔴 断言必须自证前提：任何一个环节没出现预期元素，就报 FAIL 并 dump 当时的界面文本，
//    绝不"没找到就当通过"。
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

/**
 * 注入到渲染层的工具函数。
 *
 * 刻意用「找可点击元素 + 按文案匹配」而不是 CSS 类名：类名会随样式重构变，
 * 而按钮上的中文文案是产品语言的一部分，改它本来就是一次可见的改动。
 */
const PRELUDE = `
const norm = (s) => (s || '').replace(/\\s+/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyText = () => document.body ? document.body.innerText : '';
const clickable = () => Array.from(document.querySelectorAll('button,a,[role="button"],[role="tab"],li,label'));
const findText = (t) => clickable().find((e) => norm(e.textContent).includes(norm(t))) || null;
const waitFor = async (fn, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    let v = null;
    try { v = fn() } catch (e) { v = null }
    if (v) return v;
    await sleep(120);
  }
  return null;
};
const waitText = (t, ms) => waitFor(() => (norm(bodyText()).includes(norm(t)) ? true : null), ms);
const clickText = (t) => { const e = findText(t); if (!e) return false; e.scrollIntoView({ block: 'center' }); e.click(); return true; };
const clickAny = (list) => { for (const t of list) { if (clickText(t)) return t } return null; };
/** 关闭最上层的弹窗（Modal 的关闭键统一带 aria-label="关闭"） */
const closeModal = () => {
  const btns = Array.from(document.querySelectorAll('button[aria-label="关闭"],button[title="关闭"]'));
  const last = btns[btns.length - 1];
  if (!last) return false;
  last.click();
  return true;
};
/**
 * 给 textarea 设值。
 * 🔴 必须走原型上的 value setter：React 会在 input 事件里读 e.target.value，
 *    直接 el.value = x 时 React 自己的值跟踪器认为"没变"，onChange 不会触发 ——
 *    界面看着有新字，应用状态里还是旧的（典型的"改了但没生效"）。
 */
const setTextarea = (selector, value) => {
  const el = document.querySelector(selector);
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  el.focus();
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
};
const clickSelector = (sel) => { const e = document.querySelector(sel); if (!e) return false; e.click(); return true; };
`;

/** 把当前界面快照写到磁盘：断言失败时唯一的现场证据 */
function dumpDom(dir, label, payload) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${label}.txt`)
    const lines = []
    if (payload && payload.text) lines.push('=== 界面文本 ===', payload.text, '')
    if (payload && payload.buttons) lines.push('=== 可点元素（文案 / aria-label / title） ===', ...payload.buttons, '')
    if (payload && payload.error) lines.push('=== 错误 ===', String(payload.error))
    fs.writeFileSync(file, lines.join('\n'), 'utf-8')
    return file
  } catch {
    return ''
  }
}

/**
 * 业务接口的最小客户端。
 * 🔴 判据只能从**服务器**读：本机说"已同步"是自我声明，云端 revision 才是事实。
 */
function makeCloud(baseUrl, getToken) {
  const call = async (method, p, body) => {
    const token = getToken()
    if (!token) return { ok: false, status: 0, error: '主进程没有令牌', json: null }
    const headers = { Authorization: `Bearer ${token}` }
    if (body) headers['Content-Type'] = 'application/json'
    try {
      const r = await fetch(baseUrl + p, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      })
      const text = await r.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* 非 JSON 由调用方看 status */ }
      return { ok: r.ok, status: r.status, json, text, error: json && json.error ? String(json.error) : '' }
    } catch (err) {
      return { ok: false, status: 0, error: err && err.message ? String(err.message) : '请求失败', json: null }
    }
  }
  return {
    call,
    list: () => call('GET', '/api/v2/projects'),
    state: (pid) => call('GET', `/api/v2/projects/${pid}`),
    manifest: (pid) => call('GET', `/api/v2/projects/${pid}/manifest`),
    object: (pid, hash) => call('GET', `/api/v2/projects/${pid}/objects/${hash}`),
    commit: (pid, payload) => call('POST', `/api/v2/projects/${pid}/commit`, payload),
    /** 原始字节上传（对象是内容寻址的，正文不能当 JSON 字符串拼） */
    putObject: async (pid, hash, bytes) => {
      const token = getToken()
      if (!token) return { ok: false, status: 0, error: '主进程没有令牌' }
      try {
        const r = await fetch(`${baseUrl}/api/v2/projects/${pid}/objects/${hash}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
          body: bytes,
        })
        const text = await r.text()
        let json = null
        try { json = JSON.parse(text) } catch { /* 非 JSON 忽略 */ }
        return { ok: r.ok, status: r.status, json, error: json && json.error ? String(json.error) : '' }
      } catch (err) {
        return { ok: false, status: 0, error: err && err.message ? String(err.message) : '上传失败' }
      }
    },
  }
}

/** 用用户名密码换一次会话 Cookie（桌面授权地址需要已登录的浏览器会话） */
async function apiLogin(baseUrl, name, password) {
  const r = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password }),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, status: r.status, error: String((body && body.error) || `HTTP ${r.status}`) }
  const raw = r.headers.get('set-cookie') || ''
  const m = /yfe_sid=([^;]+)/.exec(raw)
  if (!m) return { ok: false, status: r.status, error: '登录成功但没有拿到会话 Cookie' }
  return { ok: true, sid: m[1], user: body && body.user ? body.user : null }
}

/** 注册一个一次性测试账号（服务端需 `YFE_REGISTER=open`） */
async function apiRegister(baseUrl, name, password) {
  const r = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password }),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, status: r.status, error: String((body && body.error) || `HTTP ${r.status}`) }
  return { ok: true }
}

/**
 * 跑一遍整链。
 *
 * @param {object} o
 * @param {import('electron').BrowserWindow} o.win 主窗口（已开始加载）
 * @param {string} o.baseUrl 服务器根地址，如 http://localhost:8323
 * @param {{name:string,password:string}} o.account 测试账号
 * @param {(x:object)=>Promise<object>} o.login 主进程里的 `runDesktopLogin`
 * @param {() => string} o.getToken 读当前令牌（空串=未登录）
 * @param {(s:string)=>void} [o.log] 输出一行
 * @param {string} [o.dumpDir] DOM 快照目录
 * @param {number} [o.stepTimeout] 单步超时（毫秒）
 */
async function runSyncSelftest(o) {
  const { win, baseUrl, account, login, getToken } = o
  const log = o.log || ((s) => console.log(s))
  const dumpDir = o.dumpDir || path.join(process.cwd(), '.workbuddy', 'tmp', 'selftest')
  const stepTimeout = o.stepTimeout || 90_000
  const cloud = makeCloud(baseUrl, getToken)

  /** 在渲染层里跑一段脚本；PRELUDE 每次都注入（页面可能被应用自己 reload 过） */
  const js = (code) => win.webContents.executeJavaScript(`(async () => {${PRELUDE}\n${code}\n})()`, true)

  /**
   * 重载渲染层并等它重新加载完。
   *
   * 【为什么必须做】本自检是在**页面已经挂载之后**由主进程代劳登录的（回环 + PKCE），
   * 而界面上的「云端账号 / 云端同步」状态是组件挂载时读一次的快照 ——
   * 于是主进程里令牌已经落盘，侧边栏却还写着"未登录"，同步面板也跟着报未登录（已实机踩到）。
   * 真实用户是**在界面里点登录**的，那条路径自己会刷新状态，所以这不是产品缺陷，
   * 是「绕过界面登录」带来的时序差；重载一次让界面重新读一遍令牌即可对齐真实场景。
   */
  const reloadRenderer = () => new Promise((resolve) => {
    const done = () => setTimeout(resolve, 800)
    win.webContents.once('did-finish-load', done)
    win.webContents.reload()
  })

  /** 取界面现场（文本 + 可点元素清单），失败时用 */
  const snapshot = async () => {
    try {
      return await js(`
        return {
          text: bodyText().slice(0, 4000),
          buttons: clickable().map((e) => norm(e.textContent).slice(0, 40) + ' | ' + (e.getAttribute('aria-label') || '') + ' | ' + (e.getAttribute('title') || '')).slice(0, 200),
        };
      `)
    } catch (e) {
      return { text: '', buttons: [], error: e && e.message ? e.message : e }
    }
  }

  const results = []
  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms)),
  ])

  /**
   * 跑一步。失败即停：后面的步骤都建立在前一步的状态上，
   * 硬撑着往下跑只会产出一串误导性的红。
   */
  const steps = []
  /** 跨步骤传递的现场信息（比如"刚下载的副本叫什么名字""这一步改了什么"） */
  const ctx = {}
  /** 登记一步；`ms` 可单独覆盖这一步的超时（等待自动同步的步骤需要更久） */
  const step = (name, fn, ms) => steps.push({ name, fn, ms })

  // ---------------- 步骤定义 ----------------

  step('01 账号就绪（主进程直连服务器）', async () => {
    let r = await apiLogin(baseUrl, account.name, account.password)
    // 401 = 账号还不存在（服务端开了开放注册时直接建一个一次性账号）
    if (!r.ok && r.status === 401) {
      const reg = await apiRegister(baseUrl, account.name, account.password)
      if (!reg.ok) throw new Error(`注册失败：${reg.error}（服务端需 YFE_REGISTER=open）`)
      r = await apiLogin(baseUrl, account.name, account.password)
    }
    if (!r.ok) throw new Error(`登录失败：${r.error}`)
    const who = r.user && r.user.name ? r.user.name : account.name
    return `账号 ${who} 会话就绪`
  })

  step('02 桌面登录（回环 + PKCE + 安全存储）', async () => {
    if (getToken()) return '已有令牌，跳过'
    const sess = await apiLogin(baseUrl, account.name, account.password)
    if (!sess.ok) throw new Error(`拿会话失败：${sess.error}`)
    const r = await login({
      baseUrl,
      name: '同步自检设备',
      // 生产是 shell.openExternal；自检里换成"自己去请求那个授权地址"，
      // 效果与用户在浏览器里点「授权」一致（服务端照样 302 到回环、回环照样换令牌）
      openBrowser: async (url) => {
        const resp = await fetch(url, { headers: { cookie: `yfe_sid=${sess.sid}` }, redirect: 'manual' })
        const loc = resp.headers.get('location')
        if (!loc) throw new Error(`授权地址没有跳转（HTTP ${resp.status}）`)
        await fetch(loc, { redirect: 'manual' })
      },
    })
    if (!r.ok) throw new Error(`桌面登录失败：${r.error}`)
    if (!getToken()) throw new Error('登录返回成功但令牌没落盘')
    await reloadRenderer()
    return `已登录 persisted=${r.persisted === true}（界面已重载）`
  })

  step('02b 渲染层看得见登录态（通道装配）', async () => {
    const r = await js(`
      const has = !!(window.electronAuth && typeof window.electronAuth.status === 'function');
      if (!has) return { has: false, ua: navigator.userAgent.slice(0, 120) };
      let st = null, origin = '';
      try { st = await window.electronAuth.status() } catch (e) { st = { error: String(e && e.message ? e.message : e) } }
      try { origin = (await window.electronAuth.origin()).origin } catch (e) { origin = 'ERR:' + String(e) }
      return { has: true, st, origin };
    `)
    if (!r.has) throw new Error(`渲染层没有 window.electronAuth（桌面判定或 preload 没生效）：${r.ua}`)
    if (!r.st || r.st.signedIn !== true) throw new Error(`渲染层读到的登录态是未登录：${JSON.stringify(r.st)}`)
    if (!r.origin) throw new Error('主进程没有回登录服务器 origin（同步请求没法拼地址）')
    return `signedIn=true origin=${r.origin}`
  })

  step('03 界面就绪', async () => {
    const r = await js(`
      const ok = await waitFor(() => (norm(bodyText()).length > 40 ? true : null), 60000);
      return { ok: !!ok, text: bodyText().slice(0, 600) };
    `)
    if (!r.ok) throw new Error('界面 60 秒内没有渲染出内容')
    return `首屏：${String(r.text).replace(/\s+/g, ' ').slice(0, 80)}…`
  })

  step('04 首次引导（若有则跳过）', async () => {
    const r = await js(`
      const skipped = clickAny(['跳过，直接进入项目管理', '跳过', '以后再说', '开始使用']);
      await sleep(400);
      return { skipped: skipped || '', text: bodyText().slice(0, 300) };
    `)
    return r.skipped ? `已点「${r.skipped}」` : '没有引导页，直接进入'
  })

  step('05 本地建一本有正文的作品', async () => {
    // 已经有项目就不重复建（重复跑自检时同一资料区会被复用）
    const has = await js(`return { n: document.querySelectorAll('button[aria-label="打开项目"]').length }`)
    if (has.n > 0) return `已有 ${has.n} 本，跳过创建`

    const opened = await js(`return { ok: clickText('创建示范项目') }`)
    if (!opened.ok) throw new Error('项目中心没有「创建示范项目」按钮')
    // 确认框
    const confirmed = await js(`
      const ok = await waitFor(() => findText('确定'), 8000);
      if (ok) ok.click();
      return { ok: !!ok };
    `)
    if (!confirmed.ok) throw new Error('创建示范项目的确认框没有出现')
    /**
     * 🔴 等"项目卡片出现"或"已经进入编辑页"，不能等文案：`创建示范项目` 这个按钮本身
     *    就一直带着"示范"两个字 —— 第一版用 `bodyText 包含 示范` 当条件，于是**立刻**
     *    判成功，实际项目还没建出来，下一步必然找不到「打开项目」（已实机踩到）。
     *    判据要盯"数量变化 / 目标元素出现"，不能盯"页面里出现过某个词"。
     * ⚠️ 示范项目建完会直接进入编辑页（ProjectHub → onOpen），所以这里两种终态都算成功。
     */
    const done = await js(`
      const inEditor = () => document.querySelector('textarea[placeholder^="落笔即入江湖"]');
      const inProject = () => norm(bodyText()).includes('当前项目');
      const ok = await waitFor(() => (inEditor() || inProject() || document.querySelectorAll('button[aria-label="打开项目"]').length > 0 ? true : null), 120000);
      return { ok: !!ok, editor: !!inEditor(), project: !!inProject(), n: document.querySelectorAll('button[aria-label="打开项目"]').length };
    `)
    if (!done.ok) throw new Error('示范项目 120 秒内没建出来（约九万字，正常需要几秒）')
    if (done.editor) return '已建好并直接进入编辑页'
    // 建完落在「写作面板」，还没进正文（下一对步骤负责进去）
    return done.project ? '已建好并进入作品（落在写作面板）' : `项目数 ${done.n}`
  })

  step('06 打开这本并写一段正文', async () => {
    const entered = await js(`
      const body = () => document.querySelector('textarea[placeholder^="落笔即入江湖"]');
      if (!body()) {
        const btn = document.querySelector('button[aria-label="打开项目"]');
        if (btn) btn.click();
      }
      let ok = await waitFor(() => body(), 6000);
      // 落在写作面板：点「继续写作」进正文（面板上的快捷入口，与用户手动点一致）
      if (!ok) { clickAny(['继续写作', '继续创作']); ok = await waitFor(() => body(), 15000); }
      // 还不行就试页签 / 侧边栏的「正文编辑」
      if (!ok) { clickAny(['正文编辑']); ok = await waitFor(() => body(), 20000); }
      return { ok: !!ok, text: ok ? '' : bodyText().slice(0, 400) };
    `)
    if (!entered.ok) throw new Error('没能进入正文编辑页')
    const typed = await js(`
      const el = document.querySelector('textarea[placeholder^="落笔即入江湖"]');
      if (!el) return { ok: false };
      const at = new Date().toISOString();
      const mark = '【桌面自检标记 ' + at + '】';
      setTextarea('textarea[placeholder^="落笔即入江湖"]', el.value + '\\n\\n' + mark);
      return { ok: true, mark };
    `)
    if (!typed.ok) throw new Error('正文写入失败')
    // 等自动保存（正文草稿有 2 秒防抖，落盘后 project.updatedAt 才会更新）
    await new Promise((r) => setTimeout(r, 3500))
    return `已写入标记 ${typed.mark}`
  })

  step('07 云端同步面板读到服务器', async () => {
    const r = await js(`
      if (!clickText('云端同步')) return { ok: false, why: '侧边栏没有「云端同步」入口' };
      const ok = await waitFor(() => (findText('刷新') ? true : null), 15000);
      await sleep(1200);
      // 面板自己的报错行带 role="alert"；只看它，避免把侧边栏的"未登录"当成面板报错
      const alert = document.querySelector('[role="alert"]');
      return { ok: !!ok, alert: alert ? norm(alert.textContent).slice(0, 120) : '', text: bodyText().slice(0, 1500) };
    `)
    if (!r.ok) throw new Error(r.why || '同步面板没有打开')
    if (r.alert) throw new Error(`面板报错：${r.alert}`)
    return '面板已打开且无报错'
  })

  step('08 上传这本到云端（建绑定）', async () => {
    const clicked = await js(`
      if (findText('立即同步')) return { skipped: true };
      if (!clickText('上传这本到云端')) return { ok: false, why: '没有「上传这本到云端」按钮' };
      return { ok: true };
    `)
    if (clicked.skipped) return '本机这本已绑定，跳过'
    if (!clicked.ok) throw new Error(clicked.why || '点不到上传按钮')
    /**
     * 🔴 不能等"按钮文案变成立即同步"：绑定是先建后推的，按钮几乎立刻翻字，
     *    而真正的上传要几秒（示范项目 40+ 个对象）。第一版就在这里判成功，
     *    随即读到空列表（已实机踩到）。判据必须是**服务器上真的多了一本**。
     */
    const got = await pollUntil(async () => {
      const l = await cloud.list()
      const ps = (l.json && l.json.projects) || []
      return ps.length ? ps : 0
    }, 120_000, 2000)
    if (!got) throw new Error('120 秒内云端还没出现这本作品（上传没成）')
    const p = got.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]
    if (!(p.revision >= 1)) throw new Error(`云端作品 revision 还是 ${p.revision}，内容没提交上去`)
    return `云端《${p.name}》第 ${p.revision} 版`
  })

  step('09 下载为新书（副本绑定基线是否正确）', async () => {
    const before = await cloud.list()
    const pid = ((before.json && before.json.projects) || [])[0]
    if (!pid) throw new Error('云端列表为空，无法下载')
    const r = await js(`
      const name = ${JSON.stringify(pid.name || '')};
      if (!clickText('云端同步')) return { ok: false, why: '打不开面板' };
      await sleep(600);
      // 找到包含这本书名的那一行，点它自己的「下载为新书」
      const rows = Array.from(document.querySelectorAll('div')).filter((d) => norm(d.textContent).includes(name) && d.querySelector('button') && norm(d.textContent).includes('下载为新书'));
      const row = rows[rows.length - 1];
      if (!row) return { ok: false, why: '云端列表里没有这本书', text: bodyText().slice(0, 800) };
      const btn = Array.from(row.querySelectorAll('button')).find((b) => norm(b.textContent).includes('下载为新书'));
      if (!btn) return { ok: false, why: '这一行没有「下载为新书」' };
      btn.click();
      const ok = await waitFor(() => (norm(bodyText()).includes('已下载为') ? true : null), 90000);
      return { ok: !!ok, text: bodyText().slice(0, 800) };
    `)
    if (!r.ok) throw new Error(r.why || '下载没有完成')
    /**
     * 记下副本名。**不依赖 toast 文案**：副本名是程序拼的固定后缀
     * （`downloadCloudAsNew` 里 `${row.name}（云端副本）`），直接按云端名推更可靠；
     * toast 只当兜底（第一版靠解析 toast，实测取不到名字）。
     */
    const named = /已下载为\s*《([^》]+)》/.exec(String(r.text))
    ctx.copyName = (named && named[1]) || `${pid.name || ''}（云端副本）`
    return `云端第 ${pid.revision} 版已落地为《${ctx.copyName || '（未取到名字）'}》`
  })

  step('10 打开副本并确认基线不落后', async () => {
    const r = await js(`
      closeModal();
      await sleep(400);
      // 回到项目中心：编辑器里没有项目卡片（下载完仍停在原来那本的编辑页）
      if (!document.querySelector('button[aria-label="打开项目"]')) {
        clickAny(['切换项目']);
        await waitFor(() => document.querySelector('button[aria-label="打开项目"]'), 20000);
      }
      if (!document.querySelector('button[aria-label="打开项目"]')) return { ok: false, why: '回不到项目中心' };
      // 🔴 认准"刚下载的那一本"：重复跑自检会留下多份副本，
      //    取"最后一个卡片"会挑到旧副本，于是基线对比必然对不上（实机踩到过）。
      const want = ${JSON.stringify(ctx.copyName || '')};
      const cards = Array.from(document.querySelectorAll('div')).filter((d) => (want ? norm(d.textContent).includes(norm(want)) : norm(d.textContent).includes('云端副本')) && d.querySelector('button[aria-label="打开项目"]'));
      // 🔴 同名副本可能有多份（重复跑自检留下）。项目中心按更新时间**倒序**，最新的一本在最前 ——
      //    取最后一张会挑到最早那本，基线必然对不上（实机踩到过）。
      const card = cards[0];
      if (!card) return { ok: false, why: '项目中心里没有刚下载的副本' };
      card.querySelector('button[aria-label="打开项目"]').click();
      // 打开后一般落在「写作面板」，编辑器不会自己出来 —— 先等 6 秒再点「继续写作」，
      // 不要在这里空等 30 秒（实测每次都白等）
      let ok = await waitFor(() => document.querySelector('textarea[placeholder^="落笔即入江湖"]'), 6000);
      // 打开后落在写作面板，正文入口要再点一下
      if (!ok) { clickAny(['继续写作', '继续创作']); ok = await waitFor(() => document.querySelector('textarea[placeholder^="落笔即入江湖"]'), 15000); }
      await sleep(1500);
      return { ok: true, editor: !!document.querySelector('textarea[placeholder^="落笔即入江湖"]') };
    `)
    if (!r.ok) throw new Error(r.why || '没能打开副本')
    // 打开同步面板，读「本机基于 第 N 版」与「云端版本 第 M 版」是否一致
    const panel = await js(`
      if (!clickText('云端同步')) return { ok: false };
      await sleep(1500);
      const t = bodyText();
      const base = (t.match(/本机基于 第 (\\d+) 版/) || [])[1] || '';
      const remote = (t.match(/云端版本 第 (\\d+) 版/) || [])[1] || '';
      return { ok: true, base: Number(base) || 0, remote: Number(remote) || 0, text: t.slice(0, 900) };
    `)
    if (!panel.ok) throw new Error('打不开同步面板')
    if (panel.base !== panel.remote) {
      throw new Error(`副本基线没钉住：本机基于第 ${panel.base} 版，云端第 ${panel.remote} 版（会立刻判成假冲突）`)
    }
    return `本机与云端都是第 ${panel.base} 版`
  })

  step('11 改副本正文 → 自动同步把改动推回云端', async () => {
    const revBefore = await readCloudRevision(baseUrl, cloud, log)
    const r = await js(`
        closeModal();
        await sleep(400);
        if (!document.querySelector('textarea[placeholder^="落笔即入江湖"]')) {
          clickAny(['继续写作', '继续创作', '正文编辑']);
          await waitFor(() => document.querySelector('textarea[placeholder^="落笔即入江湖"]'), 20000);
        }
        const el = document.querySelector('textarea[placeholder^="落笔即入江湖"]');
        if (!el) return { ok: false, why: '不在正文编辑页' };
        const mark = '【云端改稿 ' + Date.now() + '】';
        setTextarea('textarea[placeholder^="落笔即入江湖"]', el.value + ' ' + mark);
        return { ok: true, mark };
      `)
    if (!r.ok) throw new Error(r.why || '改正文失败')
    // 等自动保存落盘（正文有 2 秒防抖）：`updatedAt` 变了自动同步才认为"有改动"
    await new Promise((res) => setTimeout(res, 4000))

    /**
     * 桌面端**不会自动起自动同步**（规划 D6：每本显式开启），下载下来的副本也一样。
     * 所以这里先像用户那样把开关打开，再等 20 秒那一跳 —— 这才是真实操作序列。
     */
    const auto = await js(`
      if (!clickText('云端同步')) return { ok: false };
      await sleep(1200);
      if (norm(bodyText()).includes('自动同步已开启')) return { ok: true, already: true };
      const rows = Array.from(document.querySelectorAll('div')).filter((d) => norm(d.textContent).includes('自动同步') && d.querySelector('button'));
      const row = rows[rows.length - 1];
      const btn = row ? Array.from(row.querySelectorAll('button')).find((b) => norm(b.textContent) === '开启') : null;
      if (!btn) return { ok: false, why: '面板里没有「开启」自动同步的按钮' };
      btn.click();
      await sleep(1000);
      closeModal();
      return { ok: true, already: false };
    `)
    if (!auto.ok) throw new Error(auto.why || '打不开同步面板')

    const pushed = await pollUntil(async () => {
      const s = await readCloudRevision(baseUrl, cloud, log)
      return s > revBefore ? s : 0
    }, 75_000, 3000)
    if (!pushed) throw new Error(`75 秒内云端 revision 没变（仍是第 ${revBefore} 版）`)
    ctx.mark = r.mark
    return `云端 ${revBefore} → ${pushed} 版（本机标记 ${r.mark}，自动同步${auto.already ? '本已开启' : '刚开启'}）`
  }, 150_000)

  step('12 云端内容确实是刚改的那一句', async () => {
    /**
     * 🔴 只看 revision 变大不够：别的作品（比如自检第 6 步改过的原书）也可能在那几秒推一版，
     *    版本号照样变大，但推上去的不是我们改的那句。判据必须落在**云端对象里有没有这句话**。
     */
    if (!ctx.mark) throw new Error('上一步没拿到本次改稿的标记')
    const l = await cloud.list()
    const ps = (l.json && l.json.projects) || []
    if (!ps.length) throw new Error('云端没有作品')
    const pid = ps.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0].cloudProjectId
    const man = await cloud.manifest(pid)
    if (!man.ok || !man.json || !man.json.manifest) throw new Error(`读云端清单失败：${man.error || man.status}`)
    const entries = [...(man.json.manifest.objects || []), ...(man.json.manifest.assets || [])]
    const hashes = [...new Set(entries.map((e) => e && e.hash).filter((h) => typeof h === 'string' && h))]
    for (const h of hashes) {
      const o = await cloud.object(pid, h)
      if (o.ok && String(o.text || '').includes(ctx.mark)) {
        ctx.markHash = h
        ctx.cloudPid = pid
        return `第 ${man.json.revision} 版里找到了「${ctx.mark}」（对象 ${h.slice(0, 8)}…，共查 ${hashes.length} 个）`
      }
    }
    throw new Error(`第 ${man.json.revision} 版的 ${hashes.length} 个对象里都没有「${ctx.mark}」`)
  })

  step('13 制造真实冲突（模拟另一台设备写了新版本）', async () => {
    /**
     * 【为什么要造】冲突三选一要有两边都改过才谈得上选。这里用主进程直连服务器
     * 扮演"另一台设备"：把云端正在用的那个正文对象**改一个字**、以内容寻址重新传一份，
     * 再以当前 revision 为基线提交一版 —— 这与另一台桌面/网页设备提交的效果完全一致
     * （服务端只看 protocol / epoch / baseRevision / 对象齐备，不区分谁提交）。
     */
    if (!ctx.cloudPid || !ctx.markHash) throw new Error('上一步没记下云端作品/对象')
    const man = await cloud.manifest(ctx.cloudPid)
    if (!man.ok || !man.json) throw new Error(`读云端清单失败：${man.error || man.status}`)
    const base = man.json.revision
    const next = JSON.parse(JSON.stringify(man.json.manifest))

    const src = await cloud.object(ctx.cloudPid, ctx.markHash)
    if (!src.ok) throw new Error('读不到云端那个正文对象')
    const marker = `【另一台设备改的 ${Date.now()}】`
    const bytes = Buffer.from(String(src.text) + '\n' + marker, 'utf8')
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    const put = await cloud.putObject(ctx.cloudPid, hash, bytes)
    if (!put.ok) throw new Error(`上传对象失败：${put.error || put.status}`)

    let replaced = 0
    for (const k of ['objects', 'assets']) {
      for (const e of next[k] || []) {
        if (e && e.hash === ctx.markHash) { e.hash = hash; e.bytes = bytes.length; replaced++ }
      }
    }
    if (!replaced) throw new Error('清单里没找到要替换的对象（结构变了？）')

    const c = await cloud.commit(ctx.cloudPid, {
      manifest: next, baseRevision: base, opId: `selftest-remote-${Date.now()}`,
    })
    if (!c.ok) throw new Error(`模拟另一台设备提交失败：${c.error || c.status}（${c.json && c.json.code || ''}）`)
    ctx.remoteMarker = marker
    ctx.revisionAfterRemote = c.json.revision
    return `云端 ${base} → ${c.json.revision} 版，正文对象 ${ctx.markHash.slice(0, 8)}… → ${hash.slice(0, 8)}…`
  })

  step('14 本地也改一处 → 面板弹出三选一', async () => {
    // 本地再改一次：此时云端已经比本机的基线新，两边都改了
    const r = await js(`
      if (!document.querySelector('textarea[placeholder^="落笔即入江湖"]')) {
        clickAny(['继续写作', '继续创作', '正文编辑']);
        await waitFor(() => document.querySelector('textarea[placeholder^="落笔即入江湖"]'), 20000);
      }
      const el = document.querySelector('textarea[placeholder^="落笔即入江湖"]');
      if (!el) return { ok: false, why: '不在正文编辑页' };
      const mark = '【冲突时的本机改动 ' + Date.now() + '】';
      setTextarea('textarea[placeholder^="落笔即入江湖"]', el.value + ' ' + mark);
      return { ok: true, mark };
    `)
    if (!r.ok) throw new Error(r.why || '本地改稿失败')
    ctx.localMark = r.mark
    await new Promise((res) => setTimeout(res, 4000)) // 等自动保存落盘

    // 打开面板：load() 会读云端 revision 与本机 updatedAt，从而算出"冲突"
    const panel = await js(`
      if (!clickText('云端同步')) return { ok: false, why: '打不开面板' };
      await sleep(600);
      // 🔴 面板可能**本来就开着**（上一步刚用过），此时再点入口不会触发 open 变化 ⇒ 不重新 load，
      //    界面上还是"改稿前"的判断。统一先点一次「刷新」，保证读的是当前状态（实测省 30 秒）。
      const refresh = findText('刷新');
      if (refresh) refresh.click();
      let hit = await waitFor(() => (norm(bodyText()).includes('本机与云端各有改动') ? true : null), 20000);
      if (!hit) { clickAny(['刷新']); hit = await waitFor(() => (norm(bodyText()).includes('本机与云端各有改动') ? true : null), 15000); }
      const t = bodyText();
      const has = (s) => norm(t).includes(norm(s));
      return {
        ok: !!hit,
        keep: has('保留本机并上传'),
        overwrite: has('用云端覆盖本机'),
        both: has('两份都留'),
        text: t.slice(0, 1200),
      };
    `)
    if (!panel.ok) throw new Error('面板没有出现「本机与云端各有改动」')
    if (!panel.keep || !panel.overwrite || !panel.both) {
      throw new Error(`三选一入口不全：保留本机=${panel.keep} 云端覆盖=${panel.overwrite} 两份都留=${panel.both}`)
    }
    return `冲突框已出现，三个选项齐全（本机标记 ${ctx.localMark}）`
  }, 120_000)

  step('15 选「保留本机并上传」→ 云端变成本机这一版', async () => {
    const before = ctx.revisionAfterRemote || 0
    const clicked = await js(`
      const btn = findText('保留本机并上传');
      if (!btn) return { ok: false, why: '点不到「保留本机并上传」' };
      btn.click();
      return { ok: true };
    `)
    if (!clicked.ok) throw new Error(clicked.why)

    const pushed = await pollUntil(async () => {
      const s = await readCloudRevision(baseUrl, cloud, log)
      return s > before ? s : 0
    }, 90_000, 3000)
    if (!pushed) throw new Error(`90 秒内云端没有新版本（仍是第 ${before} 版）`)

    // 判据：云端现在应当是**本机**这一版 —— 含本机标记、不含"另一台设备改的"
    const man = await cloud.manifest(ctx.cloudPid)
    if (!man.ok || !man.json) throw new Error('读不到最新云端清单')
    const hashes = [...new Set([...(man.json.manifest.objects || []), ...(man.json.manifest.assets || [])]
      .map((e) => e && e.hash).filter((h) => typeof h === 'string' && h))]
    let sawLocal = false
    let sawRemote = false
    for (const h of hashes) {
      const o = await cloud.object(ctx.cloudPid, h)
      const body = String(o.text || '')
      if (body.includes(ctx.localMark)) sawLocal = true
      if (ctx.remoteMarker && body.includes(ctx.remoteMarker)) sawRemote = true
    }
    if (!sawLocal) throw new Error('云端最新版里没有本机这次的改动')
    if (sawRemote) throw new Error('云端最新版里仍带着"另一台设备"的内容（覆盖没生效）')
    return `云端 ${before} → ${pushed} 版，内容已经是本机这一版（无对方标记）`
  }, 150_000)

  // ---------------- 执行 ----------------

  const t0 = Date.now()
  log(`[sync-selftest] 目标 ${baseUrl}，账号 ${account.name}，单步上限 ${Math.round(stepTimeout / 1000)}s`)
  for (const s of steps) {
    const started = Date.now()
    try {
      const detail = await withTimeout(s.fn(), s.ms || stepTimeout, s.name)
      const ms = Date.now() - started
      results.push({ name: s.name, ok: true, detail: detail || '', ms })
      log(`SYNC_STEP_OK ${s.name} (${ms}ms)${detail ? ' :: ' + detail : ''}`)
    } catch (err) {
      const ms = Date.now() - started
      const msg = err && err.message ? String(err.message) : String(err)
      const shot = await snapshot()
      const file = dumpDom(dumpDir, s.name.replace(/[^0-9A-Za-z一-龥]+/g, '_'), shot)
      results.push({ name: s.name, ok: false, detail: msg, ms })
      log(`SYNC_STEP_FAIL ${s.name} (${ms}ms) :: ${msg}`)
      if (file) log(`SYNC_STEP_DUMP ${file}`)
      break
    }
  }

  const okCount = results.filter((r) => r.ok).length
  const failed = results.find((r) => !r.ok)
  log(`SYNC_SELFTEST ${failed ? 'FAIL' : 'OK'} ${okCount}/${steps.length} 用时 ${Math.round((Date.now() - t0) / 1000)}s`)
  if (failed) log(`SYNC_SELFTEST_FIRST_FAIL ${failed.name} :: ${failed.detail}`)
  return { ok: !failed && okCount === steps.length, results }
}

/** 读云端当前 revision（取列表里最近更新的一本）：判据只认服务器 */
async function readCloudRevision(baseUrl, cloud, log) {
  const l = await cloud.list()
  if (!l.ok) {
    if (log) log(`[sync-selftest] 读云端列表失败：${l.error}`)
    return 0
  }
  const ps = (l.json && l.json.projects) || []
  if (!ps.length) return 0
  const target = ps.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]
  const s = await cloud.state(target.cloudProjectId)
  if (s.ok && s.json && typeof s.json.revision === 'number') return s.json.revision
  return target.revision || 0
}

/** 轮询直到 fn 返回真值；返回该真值，超时返回 0 */
async function pollUntil(fn, totalMs, everyMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < totalMs) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, everyMs))
  }
  return 0
}

module.exports = { runSyncSelftest, apiLogin, apiRegister, prelude: PRELUDE }
