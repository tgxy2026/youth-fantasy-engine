// 3.3.2 · 实机验证（API 级）：对着**真实运行的服务端**跑一遍核心链路
//
// 与 `scripts/verify/project-api-332.mjs` 的区别：那个自己起服务、自己清目录；
// 这个打的是一个**已经在跑**的实例（`YFE_DATA` 隔离目录），用来做"实机"取证。
//
// 用法：
//   node scripts/verify/live-332-api.mjs [baseUrl]
//   默认 http://127.0.0.1:8321
//
// 🔴 只做合成数据：账号随机、内容是小对象，不碰任何真实书库。
// 🔴 每条都写「操作 / 期望 / 实际」，最后输出可贴进验证记录的表格。
// 🔴 全程手工管 Cookie（Node 的 fetch 不带 jar），这样才能模拟"两台设备"。
const BASE = (process.argv[2] || 'http://127.0.0.1:8321').replace(/\/+$/, '')

let pass = 0, fail = 0
const rows = []
function rec(name, ok, detail = '') {
  if (ok) pass++; else fail++
  rows.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` :: ${detail}`}`)
}

/** 极简 cookie jar：只关心 yfe_sid */
function client() {
  const jar = { sid: '' }
  const run = async (method, path, body, extraHeaders = {}) => {
    const headers = { ...extraHeaders }
    if (jar.sid) headers.cookie = `yfe_sid=${jar.sid}`
    let payload
    if (body !== undefined && body !== null) {
      if (body instanceof Uint8Array) { payload = body; headers['content-type'] = 'application/octet-stream' }
      else { payload = JSON.stringify(body); headers['content-type'] = 'application/json' }
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual' })
    const setCookie = res.headers.getSetCookie?.() || []
    for (const c of setCookie) {
      const m = /^yfe_sid=([^;]*)/.exec(c)
      if (m) jar.sid = m[1]
    }
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON（静态页） */ }
    return { status: res.status, json, text, headers: res.headers }
  }
  return {
    jar,
    get: (p, h) => run('GET', p, null, h),
    post: (p, b, h) => run('POST', p, b, h),
    put: (p, b, h) => run('PUT', p, b, h),
    del: (p, h) => run('DELETE', p, null, h),
  }
}

const sha256Hex = async (bytes) => {
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
const enc = (s) => new TextEncoder().encode(s)

async function main() {
  console.log(`▶ 目标：${BASE}\n`)

  // ---------- 0. 服务可达 ----------
  const ping = await fetch(`${BASE}/api/ping`).catch(() => null)
  if (!ping || !ping.ok) {
    console.error('服务端不可达，先启动：YFE_DATA=<临时目录> PORT=8321 node server/index.mjs')
    process.exit(1)
  }
  rec('服务端可达', true, `${ping.status}`)

  // ---------- 1. 注册（随机账号，隔离） ----------
  const a = client()
  const name = `live${Date.now().toString(36)}`
  const reg = await a.post('/api/auth/register', { name, password: 'live332test' })
  rec('注册并进入（隔离账号）', reg.status === 200 && reg.json?.ok === true, JSON.stringify(reg.json)?.slice(0, 120))
  const me = await a.get('/api/auth/me')
  rec('登录态可用', me.status === 200 && !!me.json?.user?.id, String(me.json?.user?.id || ''))

  // ---------- 2. 新建云端作品 ----------
  const created = await a.post('/api/v2/projects', { name: '实机验证书' })
  const pid = created.json?.cloudProjectId
  rec('新建云端作品', created.status === 200 && typeof pid === 'string' && pid.startsWith('prj_'), String(pid))

  // ---------- 3. 上传对象 + 提交（第 1 版）----------
  const chaptersPayload = JSON.stringify([
    { id: 'c1', projectId: 'p1', volumeId: 'v1', order: 0, title: '第1章', content: '实机验证正文' },
  ])
  const chapterBytes = enc(chaptersPayload)
  const chapterHash = await sha256Hex(chapterBytes)
  const up1 = await a.put(`/api/v2/projects/${pid}/objects/${chapterHash}`, chapterBytes)
  rec('上传内容对象（流式）', up1.status === 200, `HTTP ${up1.status}`)

  const up1b = await a.put(`/api/v2/projects/${pid}/objects/${chapterHash}`, chapterBytes)
  rec('同内容重复上传被复用（reused）', up1b.status === 200 && up1b.json?.reused === true, JSON.stringify(up1b.json))

  const manifest1 = {
    protocol: 1, createdAt: Date.now(), project: { name: '实机验证书', genre: '东方修真' }, counts: {},
    objects: [{ kind: 'chapters', hash: chapterHash, bytes: chapterBytes.length, records: 1 }],
    assets: [], tombstones: [],
  }
  const commit1 = await a.post(`/api/v2/projects/${pid}/commit`, { opId: 'live-op-1', baseRevision: 0, manifest: manifest1 })
  rec('首次提交成功（第 1 版）', commit1.status === 200 && commit1.json?.revision === 1, JSON.stringify(commit1.json)?.slice(0, 120))

  // ---------- 4. 幂等重放（清单 2.6）----------
  const replay = await a.post(`/api/v2/projects/${pid}/commit`, { opId: 'live-op-1', baseRevision: 0, manifest: manifest1 })
  rec('同 opId 重放返回 replayed，不产生第 2 版',
    replay.status === 200 && replay.json?.replayed === true && replay.json?.revision === 1,
    JSON.stringify(replay.json)?.slice(0, 140))

  const st1 = await a.get(`/api/v2/projects/${pid}`)
  rec('重放后云端仍是第 1 版', st1.json?.revision === 1, String(st1.json?.revision))

  // ---------- 5. 旧基线被拒（并发保护）----------
  const stale = await a.post(`/api/v2/projects/${pid}/commit`, { opId: 'live-op-stale', baseRevision: 0, manifest: manifest1 })
  rec('旧基线提交被拒（409）', stale.status === 409, `HTTP ${stale.status} ${stale.json?.code || ''}`)

  // ---------- 6. 清单可读回 ----------
  const man = await a.get(`/api/v2/projects/${pid}/manifest`)
  // 🔴 契约：`{ ok, revision, manifest, current }` —— 清单在 `manifest` 里层。
  //    客户端 `fetchManifest` 曾直接拿外层当清单用，导致拉取全线判"格式无法识别"（已修）。
  const innerObjects = man.json?.manifest?.objects
  rec('能读回清单（且契约是 manifest 里层）',
    man.status === 200 && Array.isArray(innerObjects) && innerObjects.length === 1,
    `outerHasObjects=${Array.isArray(man.json?.objects)} innerObjects=${innerObjects?.length}`)

  // ---------- 7. 跨账号隔离（A03 的一部分）----------
  const b = client()
  const name2 = `${name}b`
  await b.post('/api/auth/register', { name: name2, password: 'live332test' })
  const crossGet = await b.get(`/api/v2/projects/${pid}`)
  rec('他账号读不到本项目（404）', crossGet.status === 404, `HTTP ${crossGet.status}`)
  const crossObj = await b.get(`/api/v2/projects/${pid}/objects/${chapterHash}`)
  rec('他账号取不到本项目对象（404）', crossObj.status === 404, `HTTP ${crossObj.status}`)

  // ---------- 8. 来源校验（清单 7.1 / 7.2）----------
  const evil = await fetch(`${BASE}/api/v2/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `yfe_sid=${a.jar.sid}`, origin: 'https://evil.example' },
    body: JSON.stringify({ name: 'evil' }),
  })
  rec('跨站 Origin 写请求被拒（403）', evil.status === 403, `HTTP ${evil.status}`)

  const evilRead = await fetch(`${BASE}/api/v2/projects`, {
    headers: { cookie: `yfe_sid=${a.jar.sid}`, origin: 'https://evil.example' },
  })
  rec('跨站 Origin 读请求不受影响（只拦写）', evilRead.status === 200, `HTTP ${evilRead.status}`)

  // ---------- 9. 配额口径 ----------
  const listA = await a.get('/api/v2/projects')
  const row = (listA.json?.projects || []).find((p) => p.cloudProjectId === pid)
  rec('列表显示本轮作品与真实字节', !!row && row.revision === 1 && row.objectBytes > 0,
    `revision=${row?.revision} bytes=${row?.objectBytes}`)

  // ---------- 10. 回收站：删除 → 列表标记 → 恢复 ----------
  const del = await a.del(`/api/v2/projects/${pid}?opId=live-del-1`)
  rec('删除作品推进 revision', del.status === 200 && del.json?.revision === 2, JSON.stringify(del.json)?.slice(0, 100))

  const listDel = await a.get('/api/v2/projects')
  const deadRow = (listDel.json?.projects || []).find((p) => p.cloudProjectId === pid)
  rec('删除后在列表里带 deleted 标记', deadRow?.deleted === true, JSON.stringify(deadRow)?.slice(0, 120))

  const revive = await a.post(`/api/v2/projects/${pid}/commit`, { opId: 'live-op-old', baseRevision: 1, manifest: manifest1 })
  rec('删除后拿旧基线提交不能复活（409）', revive.status === 409, `HTTP ${revive.status}`)

  const restore = await a.post(`/api/v2/projects/${pid}/restore?opId=live-restore-1`)
  rec('从回收站恢复（推进 revision，不倒退）',
    restore.status === 200 && (restore.json?.revision ?? 0) > 2,
    JSON.stringify(restore.json)?.slice(0, 120))

  // ---------- 11. 彻底删除 ----------
  const del2 = await a.del(`/api/v2/projects/${pid}?opId=live-del-2`)
  rec('再次删除进回收站', del2.status === 200, `HTTP ${del2.status}`)

  const purgeEarly = await a.del(`/api/v2/projects/${pid}?opId=live-purge-x&purge=1`)
  rec('回收站内可彻底删除', purgeEarly.status === 200, `HTTP ${purgeEarly.status} ${purgeEarly.json?.code || ''}`)

  const afterPurge = await a.get(`/api/v2/projects/${pid}`)
  rec('彻底删除后查不到（404）', afterPurge.status === 404, `HTTP ${afterPurge.status}`)

  // ---------- 12. 旧令牌升级路径（清单 7.4 的 API 侧）----------
  const legacy = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: `yfe_sid=${a.jar.sid}` } })
  rec('新令牌正常鉴权', legacy.status === 200, `HTTP ${legacy.status}`)

  // ---------- 汇总 ----------
  console.log(`\n${fail ? 'FAILED' : 'OK'} ${pass}/${pass + fail}（${new Date().toISOString()}）`)
  console.log('\n| 项 | 结果 | 备注 |\n|---|---|---|')
  for (const r of rows) console.log(`| ${r.name} | ${r.ok ? '通过' : '**不通过**'} | ${r.detail || ''} |`)
  if (fail) process.exit(1)
}

main().catch((e) => {
  console.error('脚本异常：', e)
  process.exit(1)
})
