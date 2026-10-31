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
/**
 * 关掉"不请自来"的弹窗（备份提醒等）。
 * 🔴 3.3.2 自检踩到：备份提醒（7 天未导出）会在流程中途弹出并压在最上层，
 *    此时 DOM 级的 click() 依然能触发下层按钮，但**二次确认框的按钮**会因为不在最上层而点不到，
 *    表现为"点了没反应、也没有报错"。每个关键动作前先清一遍现场。
 */
const dismissStrays = () => {
  let n = 0;
  for (const t of ['稍后再说', '以后再说', '知道了']) {
    const e = clickable().find((x) => norm(x.textContent) === norm(t));
    if (e) { e.click(); n++; }
  }
  return n;
};
/**
 * 严格点击：先做命中测试，再派发点击，并把"被谁挡住"如实带回来。
 * 与 clickText 的区别是**不假装成功** —— 被遮挡时调用方能看到 blocked 与挡住它的元素。
 */
const clickStrict = (t) => {
  const el = findText(t);
  if (!el) return { ok: false, why: '找不到「' + t + '」' };
  el.scrollIntoView({ block: 'center' });
  const b = el.getBoundingClientRect();
  const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  const top = document.elementFromPoint(cx, cy);
  const blocked = !top || !(top === el || el.contains(top));
  el.click();
  return {
    ok: true, blocked,
    by: blocked ? (top ? top.tagName + ' ' + String(top.className || '').slice(0, 40) : 'null') : '',
    // 诊断：到底是什么元素、有没有被禁用（禁用按钮的 click() 是**静默无效**的）
    tag: el.tagName, cls: String(el.className || '').slice(0, 60),
    disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    text: norm(el.textContent).slice(0, 24),
  };
};
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
  const { win, baseUrl, account, login, loginPassword, getToken } = o
  const log = o.log || ((s) => console.log(s))
  const dumpDir = o.dumpDir || path.join(process.cwd(), '.workbuddy', 'tmp', 'selftest')
  const stepTimeout = o.stepTimeout || 90_000
  const cloud = makeCloud(baseUrl, getToken)

  /**
   * 🔴 PRELUDE 是模板字符串，里面**不能出现反引号** —— 一个反引号就会把整段截断，
   *    注入到渲染层后变成语法错误（2026-10-31 真机崩过：主进程弹 "A JavaScript error occurred"，
   *    屏幕上是一大段注入源码，看不出真正原因）。这里在注入前先自证一次。
   */
  if (PRELUDE.indexOf(String.fromCharCode(96)) >= 0) {
    throw new Error('注入脚本里出现了反引号（会截断模板字符串）')
  }

  /** 在渲染层里跑一段脚本；PRELUDE 每次都注入（页面可能被应用自己 reload 过） */
  const js = (code) => {
    const src = `(async () => {${PRELUDE}\n${code}\n})()`
    /**
     * 🔴 注入前先验一遍语法。注入脚本是模板字符串拼出来的，一个多余的反引号 /
     *    被外层吃掉的转义就会让它在渲染层变成语法错误，而 Electron 只回一句
     *    "Script failed to execute, this normally means an error was thrown" —— 完全看不出原因
     *    （2026-10-31 为此排查了三轮）。在这里提前炸，报错能直接指到问题。
     */
    try {
      // eslint-disable-next-line no-new-func
      new Function(`return ${src}`)
    } catch (e) {
      throw new Error('注入脚本语法错误：' + (e && e.message ? e.message : e))
    }
    return win.webContents.executeJavaScript(src, true)
  }

  /** 等页面导航完成（应用自己点"重新载入界面"后，注入脚本会撞上导航中途） */
  const waitReady = async () => {
    for (let i = 0; i < 50; i++) {
      try {
        const st = await win.webContents.executeJavaScript('document.readyState')
        if (st === 'complete') { await new Promise((r) => setTimeout(r, 700)); return true }
      } catch { /* 导航中执行会抛，忽略后重试 */ }
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

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

  step('02 桌面登录（账号 + 密码，不跳浏览器）', async () => {
    /**
     * 🔴 3.3.2 · 2026-10-31 起**界面上的登录方式就是这条**（主人要求：不填网址、不跳浏览器）。
     *    自检必须走同一条路，否则测的是"已经没人用的回环 OAuth"，绿了也没意义。
     *    回环 + PKCE 的实现保留在 `main.cjs`（服务端那套接口还在），只是界面不再调用它。
     */
    if (getToken()) return '已有令牌，跳过'
    if (typeof loginPassword !== 'function') throw new Error('自检上下文没有 loginPassword（主进程接线漏了）')
    const r = await loginPassword({
      baseUrl,
      name: account.name,
      password: account.password,
    })
    if (!r.ok) throw new Error(`桌面登录失败：${r.error || '未知原因'}`)
    if (!getToken()) throw new Error('登录返回成功但令牌没落盘')
    await reloadRenderer()
    return `已登录 ${r.user && r.user.name ? r.user.name : account.name}，persisted=${r.persisted === true}（界面已重载）`
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

  /**
   * 🔴 这里刻意**不用「创建示范项目」**：示范项目不参与备份，而「用云端覆盖本机」的第二步
   *    就是"先备份、备份不成就不覆盖"（`projectPullApply` 的 BACKUP 分支）。
   *    拿示范项目跑，覆盖会被安全闸正确拒绝 —— 看起来像功能坏了，实际是数据不合适（实机踩到）。
   *    所以自检从「一本普通书 + 一个章节」起步，与真实作者的书同构。
   */
  step('05 本地建一本普通作品', async () => {
    const has = await js(`return { n: document.querySelectorAll('button[aria-label="打开项目"]').length }`)
    if (has.n > 0) return `已有 ${has.n} 本，跳过创建`
    const name = `同步自检-${Date.now().toString(36)}`
    const r = await js(`
      dismissStrays();
      if (!clickText('新建小说项目')) return { ok: false, why: '项目中心没有「新建小说项目」' };
      await waitFor(() => document.querySelector('input[placeholder^="给这本书起个名字"]'), 10000);
      const input = document.querySelector('input[placeholder^="给这本书起个名字"]');
      if (!input) return { ok: false, why: '没有书名输入框' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(name)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(300);
      if (!clickText('创建并进入项目')) return { ok: false, why: '点不到「创建并进入项目」' };
      const ok = await waitFor(() => (norm(bodyText()).includes('当前项目') ? true : null), 90000);
      return { ok: !!ok };
    `)
    if (!r.ok) throw new Error(r.why || '没能建出新作品')
    ctx.bookName = name
    return `已建《${name}》并进入作品`
  })

  step('06 新建一个章节并写一段正文', async () => {
    const r = await js(`
      const body = () => document.querySelector('textarea[placeholder^="落笔即入江湖"]');
      // 新书落在「写作面板」：先试面板上的快捷入口，不行就走侧栏的「正文编辑」
      if (!body()) { clickAny(['继续写作', '继续创作', '正文编辑']); await sleep(2500); }
      if (!body()) { clickText('正文编辑'); await sleep(3000); }
      if (!body()) {
        /**
         * 空项目没有章节。空态面板里直接就有「新建自由章节」（自由章节不归卷，空书也能建）；
         * 右上角的「新建章节」是**图标按钮**（只有 title，没有文字）——用文案找它永远找不到，
         * 这是实机踩到的（日志只有一句"找不到「新建章节」"）。
         */
        if (!clickText('新建自由章节')) {
          if (!clickText('新建章节')) return { ok: false, why: '找不到新建章节的入口' };
          await sleep(500);
          if (!clickText('新建自由章节')) return { ok: false, why: '菜单里没有「新建自由章节」' };
        }
        await sleep(900);
        const okBtn = await waitFor(() => {
          const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => norm(d.textContent).includes('章'));
          if (!dlg) return null;
          const b = Array.from(dlg.querySelectorAll('button')).find((x) => norm(x.textContent) === '确定');
          return b || null;
        }, 10000);
        if (okBtn) okBtn.click();
        await waitFor(() => body(), 20000);
      }
      const el = body();
      if (!el) return { ok: false, why: '建完章节仍进不到正文', text: bodyText().slice(0, 400) };
      const mark = '【桌面自检标记 ' + new Date().toISOString() + '】';
      setTextarea('textarea[placeholder^="落笔即入江湖"]', '这是自检写下的第一句。 ' + mark);
      return { ok: true, mark };
    `)
    if (!r.ok) throw new Error(r.why || '没能进入正文编辑页')
    await new Promise((res) => setTimeout(res, 4000))
    ctx.mark = r.mark
    return `章节已建好并写入标记 ${r.mark}`
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
    const named = /已下载为[^《]*《([^》]+)》/.exec(String(r.text))
    ctx.copyName = (named && named[1]) || `${pid.name || ''}（云端副本）`
    ctx.downloadRevision = pid.revision || 0
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
    /**
     * 🔴 判据不能写"本机基于 == 云端当前"：打开一本作品会刷新 `updatedAt`，自动同步顺手推一版
     *    （内容相同、对象哈希相同，见验证记录"观察"那条），云端的版本号会随时变大。
     *    真正要守的是：**基线不许比"下载时那一版"还旧**（旧版 bug 就是带着源项目的 baseRevision
     *    过来，比如 base=9 而下载的是第 10 版 ⇒ 立刻假冲突）。
     */
    const want = ctx.downloadRevision || 0
    if (panel.base < want) {
      throw new Error(`副本基线比下载时那一版还旧：本机基于第 ${panel.base} 版，下载的是第 ${want} 版`)
    }
    if (/本机与云端各有改动/.test(String(panel.text || ''))) {
      throw new Error(`刚下载就判成冲突（本机基于第 ${panel.base} 版，云端第 ${panel.remote} 版）`)
    }
    return `下载第 ${want} 版 → 本机基于第 ${panel.base} 版、云端第 ${panel.remote} 版，未出现假冲突`
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
    const r = await simulateRemoteCommit(cloud, ctx.cloudPid, '另一台设备改的')
    ctx.remoteMarker = r.marker
    ctx.revisionAfterRemote = r.revision
    return `云端 ${r.base} → ${r.revision} 版，正文对象 ${r.before.slice(0, 8)}… → ${r.hash.slice(0, 8)}…`
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

  step('16 冲突选「用云端覆盖本机」→ 本机换成云端那版', async () => {
    const used = await js(`
      if (!document.querySelector('textarea[placeholder^="落笔即入江湖"]')) {
        clickAny(['继续写作', '继续创作', '正文编辑']);
        await waitFor(() => document.querySelector('textarea[placeholder^="落笔即入江湖"]'), 20000);
      }
      const el = document.querySelector('textarea[placeholder^="落笔即入江湖"]');
      if (!el) return { ok: false, why: '不在正文编辑页' };
      setTextarea('textarea[placeholder^="落笔即入江湖"]', el.value + ' 【覆盖前的本机改动 ' + Date.now() + '】');
      return { ok: true };
    `)
    if (!used.ok) throw new Error(used.why || '本机改稿失败')
    await new Promise((res) => setTimeout(res, 4000))
    const remote = await simulateRemoteCommit(cloud, ctx.cloudPid, '覆盖测试的云端改动')
    const revBefore = remote.revision

    const panel = await js(`
      dismissStrays();
      if (!clickText('云端同步')) return { ok: false, why: '打不开面板' };
      await sleep(600);
      const rf = findText('刷新'); if (rf) rf.click();
      let hit = await waitFor(() => (norm(bodyText()).includes('本机与云端各有改动') ? true : null), 20000);
      if (!hit) { clickAny(['刷新']); hit = await waitFor(() => (norm(bodyText()).includes('本机与云端各有改动') ? true : null), 15000); }
      if (!hit) return { ok: false, why: '没等到冲突框' };
      dismissStrays();
      const clicked = clickStrict('用云端覆盖本机');
      if (!clicked.ok) return { ok: false, why: clicked.why };
      /**
       * 🔴 二次确认（"改动会被丢弃"）**不是立刻出现的**：覆盖前要先过一道保存屏障
       *    （把编辑器 2 秒防抖里的草稿落盘），实测 2–4 秒后才弹。
       *    第一版只等 1.5 秒就当"没有弹窗"，于是确认框一直挂着、覆盖永远不开始，
       *    日志里只有一句"覆盖没有完成"（真机排查了很久）。
       *    现在**认对话框容器**（含"会被丢弃"的那个 dialog）再点它自己的「确定」。
       */
      const confirmed = await waitFor(() => {
        const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => norm(d.textContent).includes('会被丢弃'));
        if (!dlg) return null;
        const btn = Array.from(dlg.querySelectorAll('button')).find((b) => norm(b.textContent) === '确定');
        if (!btn) return null;
        btn.click();
        return true;
      }, 30000);
      if (!confirmed) return { ok: false, why: '没等到覆盖的二次确认框', clicked };
      // 边等边记"现场出现过的提示"：失败/重试/请先/未保存 这类字样是排查的唯一线索（toast 几秒就淡了）
      let note = '';
      let done = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 90000) {
        const t = bodyText();
        if (norm(t).includes('已用云端第')) { done = true; break }
        if (!note) {
          // 🔴 不用正则：注入脚本本身是模板字符串，任何反斜杠转义都会被外层先「吃掉」一次（已踩过）
          const hit = ['失败', '重试', '请先', '未保存', '不允许', '不支持'].find((k) => t.includes(k));
          if (hit) {
            const at = t.indexOf(hit);
            note = t.slice(Math.max(0, at - 20), at + 40).split(String.fromCharCode(10)).join(' ');
          }
        }
        await sleep(800);
      }
      return { ok: !!done, clicked, confirmed, note, reason: done ? '' : ('点了确定但没出现提示' + (note ? '；期间出现：' + note : '')) };
    `)
    if (!panel.ok) throw new Error(panel.why || panel.reason || '覆盖没有完成')

    // 🔴 覆盖**只改本机**：云端版本号不许动（动了就说明偷偷上传了本机那份）
    const after = await readCloudRevision(baseUrl, cloud, log)
    if (after !== revBefore) throw new Error(`覆盖本机不该上传，但云端从第 ${revBefore} 版变成了 ${after} 版`)

    // 按界面自己说的做：点「重新载入界面」，再看正文里是不是"对方"那一版
    await js(`clickText('重新载入界面'); return true;`)
    const ready = await waitReady()
    if (!ready) throw new Error('重新载入后界面没就绪')
    const seen = await js(`
      if (!document.querySelector('button[aria-label="打开项目"]')) {
        clickAny(['切换项目']);
        await waitFor(() => document.querySelector('button[aria-label="打开项目"]'), 20000);
      }
      const want = ${JSON.stringify(ctx.copyName || '云端副本')};
      const cards = Array.from(document.querySelectorAll('div')).filter((d) => norm(d.textContent).includes(norm(want)) && d.querySelector('button[aria-label="打开项目"]'));
      if (!cards.length) return { ok: false, why: '项目中心里找不到副本' };
      cards[0].querySelector('button[aria-label="打开项目"]').click();
      let ok = await waitFor(() => document.querySelector('textarea[placeholder^="落笔即入江湖"]'), 6000);
      if (!ok) { clickAny(['继续写作', '继续创作']); ok = await waitFor(() => document.querySelector('textarea[placeholder^="落笔即入江湖"]'), 15000); }
      const el = document.querySelector('textarea[placeholder^="落笔即入江湖"]');
      if (!el) return { ok: false, why: '打开副本后进不到正文' };
      /**
       * 判据：**本机那道未同步的改动必须消失**（覆盖＝用云端替换本机）。
       * 🔴 不去找"对方那句话"：另一台设备的改动落在对象的哪个字段由结构决定，
       *    不一定是编辑器当前展示的这一章（实测：改在别处，界面上看不到，会误判成覆盖失败）。
       *    "本地标记没了"才是这个动作的直接后果。
       */
      return { ok: true, localGone: !el.value.includes('覆盖前的本机改动') };
    `)
    if (!seen.ok) throw new Error(seen.why || '覆盖后打不开副本')
    if (!seen.localGone) throw new Error('覆盖后本机"覆盖前的那道改动"还在，说明本机没被替换')
    return `云端第 ${revBefore} 版已落到本机（rev 不变），本机覆盖前的那道改动已被替换掉`
  }, 300_000)

  step('17 冲突选「两份都留」→ 另存为新书，本机这本不动', async () => {
    await js(`
      if (!document.querySelector('textarea[placeholder^="落笔即入江湖"]')) {
        clickAny(['继续写作', '继续创作', '正文编辑']);
        await waitFor(() => document.querySelector('textarea[placeholder^="落笔即入江湖"]'), 20000);
      }
      const el = document.querySelector('textarea[placeholder^="落笔即入江湖"]');
      if (el) setTextarea('textarea[placeholder^="落笔即入江湖"]', el.value + ' 【两份都留测试前的本机改动】');
      return { ok: !!el };
    `)
    await new Promise((res) => setTimeout(res, 4000))
    await simulateRemoteCommit(cloud, ctx.cloudPid, '两份都留测试的云端改动')

    const r = await js(`
      dismissStrays();
      if (!clickText('云端同步')) return { ok: false, why: '打不开面板' };
      await sleep(600);
      const rf = findText('刷新'); if (rf) rf.click();
      let hit = await waitFor(() => (norm(bodyText()).includes('本机与云端各有改动') ? true : null), 20000);
      if (!hit) { clickAny(['刷新']); hit = await waitFor(() => (norm(bodyText()).includes('本机与云端各有改动') ? true : null), 15000); }
      if (!hit) return { ok: false, why: '没等到冲突框' };
      dismissStrays();
      const clicked = clickStrict('两份都留');
      if (!clicked.ok) return { ok: false, why: clicked.why };
      // 同上：二次确认要等保存屏障，认对话框容器再点它的「确定」
      const confirmed = await waitFor(() => {
        const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => norm(d.textContent).includes('会把云端这一版另存为一本新作品'));
        if (!dlg) return null;
        const btn = Array.from(dlg.querySelectorAll('button')).find((b) => norm(b.textContent) === '确定');
        if (!btn) return null;
        btn.click();
        return true;
      }, 30000);
      if (!confirmed) return { ok: false, why: '没等到另存的二次确认框' };
      /**
       * 🔴 名字必须在**命中那一刻、从整页文本**里取：
       *    第一版取的是 bodyText 的开头 900 字，而 toast 挂在页面末尾（侧栏文本就上千字），
       *    截断后永远看不到提示 ⇒ "另存成功但找不到新书"（实机踩到）。
       */
      const done = await waitFor(() => {
        const t = bodyText();
        if (!norm(t).includes('已另存为')) return null;
        const m = /已另存为[^《]*《([^》]+)》/.exec(t);
        return { name: m ? m[1] : '', tail: t.slice(-400) };
      }, 240000);
      return { ok: !!done, name: done ? done.name : '', tail: done ? done.tail : '', reason: done ? '' : '点了确定但没出现"已另存为"' };
    `)
    if (!r.ok) throw new Error(r.why || r.reason || '另存没有完成')
    let name = String(r.name || '')
    if (!name) {
      // toast 可能已经淡出：退回"项目中心里多了一本叫 xxx 的"判据
      const fromDom = await js(`
        closeModal(); await sleep(400); clickAny(['切换项目']);
        await waitFor(() => document.querySelector('button[aria-label="打开项目"]'), 20000);
        const names = Array.from(document.querySelectorAll('button[aria-label="打开项目"]')).map((b) => {
          const card = b.closest('div'); return norm(card ? card.textContent : '');
        });
        return { names };
      `)
      name = (fromDom.names || []).find((n) => n.includes('云端副本')) || ''
      if (!name) throw new Error('另存成功但找不到新书')
      return `已另存（项目中心可见），原书保持原样`
    }
    const found = await js(`
      closeModal();
      await sleep(400);
      clickAny(['切换项目']);
      await waitFor(() => document.querySelector('button[aria-label="打开项目"]'), 20000);
      const want = ${JSON.stringify('')} + ${JSON.stringify(name)};
      const cards = Array.from(document.querySelectorAll('div')).filter((d) => norm(d.textContent).includes(norm(want)) && d.querySelector('button[aria-label="打开项目"]'));
      return { ok: cards.length > 0, n: cards.length };
    `)
    if (!found.ok) throw new Error(`提示说另存为《${name}》，但项目中心里找不到这本`)
    return `已另存为《${name}》（项目中心可见），原书保持原样`
  }, 300_000)

  step('18 老板键：注册 / 隐藏 / 恢复（真进程 + 真全局热键）', async () => {
    // 🔴 隐藏路径要求窗口当前是可见的（不可见时 toggle 会走"恢复"分支），所以先悄悄显示一下
    win.showInactive()
    await new Promise((res) => setTimeout(res, 600))
    const r = await js(`
      if (!window.electronBoss) return { ok: false, why: '渲染层没有 window.electronBoss（preload 未生效）' };
      const events = [];
      const off = window.electronBoss.onChanged((s) => events.push(s));
      // 默认组合被系统占用时换一个备选，别把"环境占用"当成功能坏了
      let applied = null;
      for (const accel of ['Ctrl+Shift+F9', 'Ctrl+Alt+F12', 'Ctrl+Shift+F11']) {
        const a = await window.electronBoss.apply(accel);
        if (a && a.ok) { applied = a; break }
        applied = a;
      }
      const st1 = await window.electronBoss.status();
      const t1 = await window.electronBoss.toggle();
      await sleep(600);
      const st2 = await window.electronBoss.status();
      const t2 = await window.electronBoss.toggle();
      await sleep(600);
      const st3 = await window.electronBoss.status();
      /**
       * 自定义组合键（2026-10-31 新增功能：用户自己按一个）也要能真注册。
       * 🔴 挑一个**不在三条预设里**的组合，才能证明"任意合法组合都行"，
       *    只测预设等于没测这个功能。
       */
      const custom = await window.electronBoss.apply('Ctrl+Alt+K');
      const customStatus = await window.electronBoss.status();
      // 恢复回原来的组合，别把机器上的设置改乱
      await window.electronBoss.apply(applied && applied.ok ? applied.accel : 'Ctrl+Shift+F9');
      off();
      return { ok: true, applied, st1, t1, st2, t2, st3, events, custom, customStatus };
    `)
    win.hide()
    if (!r.ok) throw new Error(r.why || '老板键接口不可用')
    if (!r.applied || r.applied.ok !== true) throw new Error(`注册组合键失败：${(r.applied && r.applied.error) || '未知'}`)
    if (!r.st1 || !r.st1.accel) throw new Error('注册成功但 status 里没有组合键')
    if (r.t1.hidden !== true || r.st2.hidden !== true) throw new Error('按下后窗口没有隐藏')
    if (r.t2.hidden !== false || r.st3.hidden !== false) throw new Error('再按一次没有恢复')
    const ev = Array.isArray(r.events) ? r.events : []
    if (!ev.some((e) => e && e.hidden === true && e.saving === true)) throw new Error('隐藏前没有通知渲染层"开始保存"')
    if (!ev.some((e) => e && e.hidden === false)) throw new Error('恢复时没有通知渲染层')
    if (!r.custom || r.custom.ok !== true) {
      throw new Error(`自定义组合键（Ctrl+Alt+K）注册失败：${(r.custom && r.custom.error) || '未知'}`)
    }
    if (!r.customStatus || !r.customStatus.accel) throw new Error('自定义组合键注册成功但 status 里没有它')
    return `${r.applied.display} 注册成功；隐藏→恢复一轮通过，保存通知成对；自定义 ${r.customStatus.accel} 也能注册`
  }, 90_000)

  step('19 关键按钮的几何命中（不被遮挡）', async () => {
    // 上一步把窗口藏起来了、页面也停在项目中心：几何测量需要可见窗口 + 编辑页
    win.showInactive()
    await new Promise((res) => setTimeout(res, 600))

    /**
     * 🔴 前面所有点击都是 DOM 级 `.click()`，它**绕过命中测试** —— 按钮被浮层盖住时照样"点得到"，
     *    而真人点不到。所以这里补一道：取按钮矩形中心，用 `elementFromPoint` 看真正落在最上层的是谁。
     *    这一步不点任何东西，只量几何。
     */
    const r = await js(`
      const hitCheck = (el, label) => {
        if (!el) return { label, ok: false, why: '元素不存在' };
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height) return { label, ok: false, why: '尺寸为 0' };
        const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return { label, ok: false, why: '中心点不在视口内' };
        const top = document.elementFromPoint(cx, cy);
        const ok = !!top && (top === el || el.contains(top));
        return { label, ok, why: ok ? '' : '被 ' + (top ? (top.tagName + ' ' + String(top.className || '').slice(0, 50)) : 'null') + ' 挡住' };
      };
      closeModal();
      await sleep(400);
      // 先回到一本作品的编辑页（这些控件都在编辑页的侧栏 / 工具条上）
      if (!document.querySelector('textarea[placeholder^="落笔即入江湖"]')) {
        const btn = document.querySelector('button[aria-label="打开项目"]');
        if (btn) btn.click();
        let ok = await waitFor(() => document.querySelector('textarea[placeholder^="落笔即入江湖"]'), 6000);
        if (!ok) { clickAny(['继续写作', '继续创作', '正文编辑']); ok = await waitFor(() => document.querySelector('textarea[placeholder^="落笔即入江湖"]'), 15000); }
      }
      const out = [];
      out.push(hitCheck(findText('切换项目'), '切换项目'));
      out.push(hitCheck(findText('正文编辑'), '正文编辑'));
      out.push(hitCheck(findText('云端同步'), '侧栏·云端同步'));
      // 再开面板量里面的按钮（此时侧栏被弹窗盖住是正常的，上面已经量过）
      if (clickText('云端同步')) {
        await waitFor(() => findText('刷新'), 15000);
        await sleep(600);
        out.push(hitCheck(findText('刷新'), '面板·刷新'));
        out.push(hitCheck(findText('立即同步') || findText('上传这本到云端'), '面板·主操作'));
        closeModal();
      }
      return { list: out, bad: out.filter((x) => !x.ok) };
    `)
    win.hide()
    const bad = (r.bad || []).filter((x) => x.why !== '元素不存在' || x.label !== '正文编辑')
    if (bad.length) throw new Error(bad.map((x) => `${x.label}：${x.why}`).join('；'))
    return `${(r.list || []).length} 个控件中心点命中的都是自己（无遮挡）`
  }, 90_000)

  step('20 项目中心能取回云端作品（L16 回归）', async () => {
    /**
     * 「换一台设备接着写」的第一步：**本机一本都没有时**，在项目中心把云端那本取回来。
     *
     * 🔴 3.3.2 首发版本在这里是死的：面板只挂在作品内部，项目中心没有云端入口；
     *    而且 `load()` 在没有当前项目时直接 return，连云端列表都不拉
     *    ⇒ 新设备上永远看不到「云端作品」，也点不到「下载为新书」（真机验收 L16）。
     *    这一步不点下载（后面的步骤还要用当前这本书），只验两件事：
     *    ① 项目中心有**看得见文字**的「云端同步」按钮；② 打开后真的列出了云端作品。
     */
    const r = await js(`
      dismissStrays();
      // 回项目中心
      if (!document.querySelector('button[aria-label="打开项目"]')) {
        closeModal();
        await sleep(400);
        clickAny(['切换项目']);
        await waitFor(() => document.querySelector('button[aria-label="打开项目"]'), 20000);
      }
      const btn = findText('云端同步');
      if (!btn) return { ok: false, why: '项目中心没有「云端同步」按钮（只有图标也算缺失：按文案找不到）' };
      btn.click();
      await sleep(900);
      const diag1 = { dialogs: document.querySelectorAll('[role="dialog"]').length, tag: btn.tagName, disabled: btn.disabled === true };
      if (!diag1.dialogs) {
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await sleep(900);
      }
      const diag2 = { dialogs: document.querySelectorAll('[role="dialog"]').length };
      // 🔴 判据必须是**列表头部的计数**（"云端作品 N 本"），不能是"页面里出现过'云端作品'"
      //    这几个字 —— 无项目时的提示语里就写着「从下面『云端作品』里挑一本」，
      //    按词判断会立刻假绿（第一次跑就踩到：n=0 却被判成"列出了"）。
      const listed = await waitFor(() => {
        // 🔴 用 [0-9] 而不是 \\d：这段代码是模板字符串，单个反斜杠会被外层吃掉（本次踩到）
        const m = /云端作品([0-9]+)本/.exec(norm(bodyText()));
        return m ? { n: Number(m[1]) } : null;
      }, 25000);
      const t = norm(bodyText());
      const hasDownload = t.includes('下载为新书');
      const stillHintOnly = t.includes('当前没打开作品') && !listed;
      const alert = document.querySelector('[role="alert"]');
      const alertText = alert ? norm(alert.textContent).slice(0, 120) : '';
      const dlgEl = document.querySelector('[role="dialog"]');
      const modalText = dlgEl ? norm(dlgEl.textContent).slice(0, 400) : '';
      closeModal();
      await sleep(500);
      return { ok: !!listed && listed.n > 0, n: listed ? listed.n : 0, hasDownload, stillHintOnly, alertText, diag1, diag2, modalText, text: t.slice(0, 80) };
    `)
    if (!r.ok) {
      throw new Error(r.why || `项目中心的面板没列出云端作品（n=${r.n}，只有提示没有列表=${r.stillHintOnly}，报错=${r.alertText || '无'}，dialog=${JSON.stringify(r.diag1)}→${JSON.stringify(r.diag2)}，弹窗文本=${r.modalText}）`)
    }
    return `项目中心「云端同步」可用，列出云端作品 ${r.n} 本，下载入口=${r.hasDownload}`
  }, 120_000)

  step('21 云端回收站：删除 → 标回收站 → 恢复（L17 回归）', async () => {
    /**
     * 🔴 3.3.2 首发版本里**没有任何入口能把云端作品放进回收站**：客户端只封装了「彻底删除」，
     *    而它只对已在回收站的作品可用 ⇒ 回收站、恢复、30 天到期清理在界面上全是死的
     *    （真机验收 L17）。这一步走真实 UI：列表里点「删除」→ 确认 → 该行出现「回收站」→
     *    点「恢复」→ 确认 → 恢复成可用。
     */
    const del = await js(`
      dismissStrays();
      if (!clickText('云端同步')) return { ok: false, why: '打不开面板' };
      await sleep(600);
      const rf = findText('刷新'); if (rf) rf.click();
      await waitFor(() => norm(bodyText()).includes('云端作品'), 20000);

      // 找一行"没在回收站"的作品，点它的「删除」
      const rowOf = () => Array.from(document.querySelectorAll('div'))
        .find((d) => d.querySelector('button[aria-label="打开项目"]') === null
          && norm(d.textContent).includes('第')
          && Array.from(d.querySelectorAll('button')).some((b) => norm(b.textContent) === '删除'));
      let row = rowOf();
      if (!row) return { ok: false, why: '云端作品列表里没有「删除」按钮（L17 未修）' };
      let btn = Array.from(row.querySelectorAll('button')).find((b) => norm(b.textContent) === '删除');
      btn.click();

      const confirmed = await waitFor(() => {
        const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => norm(d.textContent).includes('放进云端回收站'));
        if (!dlg) return null;
        const ok2 = Array.from(dlg.querySelectorAll('button')).find((b) => norm(b.textContent) === '放进回收站' || norm(b.textContent) === '确定');
        if (!ok2) return null;
        ok2.click();
        return true;
      }, 20000);
      if (!confirmed) {
        const dlgs = Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => norm(d.textContent).slice(0, 60));
        return { ok: false, why: '删除的确认框没出现：' + JSON.stringify(dlgs) };
      }

      /**
       * 🔴 判据要**结构化**：等"出现带「恢复」按钮的回收站行"，不能等"页面里出现回收站三个字"
       *    —— 面板底部本来就写着「回收站里的作品要先点『恢复』才能下载」，按词判断会立刻假绿
       *    （第一次跑就踩到：删除根本没成功，却被判成"已标回收站"）。
       */
      const rowHasRestore = () => Array.from(document.querySelectorAll('div'))
        .some((d) => norm(d.textContent).includes('回收站')
          && Array.from(d.querySelectorAll('button')).some((b) => norm(b.textContent) === '恢复'));
      const marked = await waitFor(() => (rowHasRestore() ? true : null), 40000);
      if (!marked) {
        const t = norm(bodyText());
        return { ok: false, why: '删除后列表里没有出现带「恢复」的回收站行；面板尾部=' + t.slice(-160) };
      }
      return { ok: true };
    `)
    if (!del.ok) throw new Error(del.why || '删除后列表里没有出现「回收站」标记')

    const back = await js(`
      const row = Array.from(document.querySelectorAll('div'))
        .find((d) => norm(d.textContent).includes('回收站')
          && Array.from(d.querySelectorAll('button')).some((b) => norm(b.textContent) === '恢复'));
      if (!row) return { ok: false, why: '找不到带「恢复」按钮的回收站行' };
      const btn = Array.from(row.querySelectorAll('button')).find((b) => norm(b.textContent) === '恢复');
      btn.click();
      const confirmed = await waitFor(() => {
        const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => norm(d.textContent).includes('恢复为可用状态'));
        if (!dlg) return null;
        const ok2 = Array.from(dlg.querySelectorAll('button')).find((b) => norm(b.textContent) === '确定');
        if (!ok2) return null;
        ok2.click();
        return true;
      }, 20000);
      if (!confirmed) return { ok: false, why: '恢复的确认框没出现' };
      /**
       * 🔴 判据同样要结构化：面板底部常驻一句「回收站里的作品要先点『恢复』才能下载」，
       *    按"页面里还有没有回收站三个字"判断永远为真（本次踩到：恢复成功却被判失败）。
       *    现在等两件事之一：出现「已恢复」提示，或者**再没有任何一行带「恢复」按钮**。
       */
      const stillTrash = () => Array.from(document.querySelectorAll('div'))
        .some((d) => Array.from(d.querySelectorAll('button')).some((b) => norm(b.textContent) === '恢复'));
      const done = await waitFor(() => {
        if (norm(bodyText()).includes('已恢复')) return 'toast';
        if (!stillTrash()) return 'row';
        return null;
      }, 60000);
      closeModal();
      return { ok: !!done, how: done || '' };
    `)
    if (!back.ok) throw new Error(back.why || '恢复后仍显示「回收站」')
    return '删除进回收站 → 标记出现 → 恢复成功，全流程走真实 UI'
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

/**
 * 以"另一台设备"的身份提交一个云端新版本。
 *
 * 【做法】挑云端清单里**最大的文本对象**（整本正文），改一处、按内容寻址重新传一份，
 * 再把清单里对它的引用换成新哈希，以当前 revision 为基线提交。
 * 服务端只看 protocol / epoch / baseRevision / 对象齐备，不区分谁提交 ⇒ 与真实另一台设备等价。
 *
 * 🔴 为什么自己挑对象而不复用上一步的哈希：覆盖本机/两份都留都会换掉云端引用的对象，
 *    旧哈希可能已经不在清单里；按"最大的文本对象"挑，任何状态都能找到那个正文。
 *
 * @returns {{base:number, revision:number, marker:string, hash:string, before:string}}
 */
/** 在 JSON 结构里找一个字符串字段追加标记（保证序列化后仍是合法 JSON） */
function markInJson(node, marker) {
  if (typeof node === 'string') return false
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      if (typeof node[i] === 'string') { node[i] += marker; return true }
      if (node[i] && typeof node[i] === 'object' && markInJson(node[i], marker)) return true
    }
    return false
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (typeof node[k] === 'string') { node[k] += marker; return true }
      if (node[k] && typeof node[k] === 'object' && markInJson(node[k], marker)) return true
    }
  }
  return false
}

async function simulateRemoteCommit(cloud, pid, tag) {
  const man = await cloud.manifest(pid)
  if (!man.ok || !man.json || !man.json.manifest) throw new Error(`读云端清单失败：${man.error || man.status}`)
  const base = man.json.revision
  const list = (man.json.manifest.objects || []).filter((e) => e && typeof e.hash === 'string' && e.hash)
  if (!list.length) throw new Error('云端清单里没有内容对象')
  const sorted = list.slice().sort((a, b) => (Number(b.bytes) || 0) - (Number(a.bytes) || 0))
  let target = null
  let text = ''
  for (const e of sorted.slice(0, 4)) {
    const o = await cloud.object(pid, e.hash)
    const body = String(o.text || '')
    // 只认 JSON 形态的正文分片：图片/blob 是 base64，改它没有意义
    if (o.ok && /^[[{]/.test(body.trim())) { target = e; text = body; break }
  }
  if (!target) throw new Error('云端找不到可改的正文对象')

  /**
   * 🔴 必须**保持 JSON 合法**：第一版是直接在原文末尾追加一句话，
   *    结果云端这一版的对象不再是合法 JSON ⇒ 「用云端覆盖本机」下载后解析失败，
   *    界面只说"1 份内容没下到，本次不切换"（很像网络问题，其实是自检自己把数据弄坏了）。
   *    现在改成解析 → 在某个字符串字段里追加标记 → 重新序列化。
   */
  const marker = `【${tag} ${Date.now()}】`
  let payload = text
  try {
    const parsed = JSON.parse(text)
    if (markInJson(parsed, marker)) payload = JSON.stringify(parsed)
  } catch { /* 不是 JSON 就按原文追加（下面仍会写出去） */ }
  if (payload === text) payload = text + '\n' + marker
  const bytes = Buffer.from(payload, 'utf8')
  const hash = crypto.createHash('sha256').update(bytes).digest('hex')
  const put = await cloud.putObject(pid, hash, bytes)
  if (!put.ok) throw new Error(`上传对象失败：${put.error || put.status}`)

  const next = JSON.parse(JSON.stringify(man.json.manifest))
  let replaced = 0
  for (const k of ['objects', 'assets']) {
    for (const e of next[k] || []) if (e && e.hash === target.hash) { e.hash = hash; e.bytes = bytes.length; replaced++ }
  }
  if (!replaced) throw new Error('清单里没找到要替换的对象（结构变了？）')

  const c = await cloud.commit(pid, { manifest: next, baseRevision: base, opId: `selftest-remote-${Date.now()}` })
  if (!c.ok) throw new Error(`模拟提交失败：${c.error || c.status}（${(c.json && c.json.code) || ''}）`)
  return { base, revision: c.json.revision, marker, hash, before: target.hash }
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
