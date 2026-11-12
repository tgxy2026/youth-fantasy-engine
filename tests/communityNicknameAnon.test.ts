// ============ 投稿广场 · 昵称冷却 + 匿名周代号（3.5.2）============
//
// 守的是「服务端是唯一裁判」与「代号/冷却的边界不能靠前端挡」：
//   A 纯分配：周口径（北京周一 00:00）、碰撞序号、容量、批量线性、幂等、克隆语义；
//   B 存储层：启用边界、写失败无幽灵、映射损坏/缺失/冲突拒绝启动、昵称冷却全边界；
//   C 接口层：profile 字段、409 冷却、混合请求守卫、冒名变体、代号一致、示例标签、
//             公开读不写盘、周榜/月榜归属周、跨周编辑/审核、撤回再发布、旧客户端兼容；
//   D 备份恢复：密钥/词表版本不符拒绝恢复、指纹键序不报假差异。
//
// ?? 本地文件系统 + 合成数据 + 固定时钟；不是生产密钥、真实多设备或断电演练。

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCommunityStore } from '../server/lib/communityStore.mjs'
import { createCommunityApi } from '../server/lib/communityApi.mjs'
import { rateLimit } from '../server/lib/ratelimit.mjs'
import {
  allocateAnonymousHandle, allocateAnonymousHandlesBatch, anonymousWeekKey, anonymousRankWeeks,
  validAnonymousWeek, validAnonymousHandle, BEAST_NAMES, BEAST_DICTIONARY_SHA256,
} from '../server/lib/communityAnon.mjs'
import { validateNickname } from '../server/lib/communityRules.mjs'
import { createBackup, restoreBackup, diffVisibility, BACKUP_MANIFEST } from '../server/lib/communityBackup.mjs'
import { writeTextAtomicSync } from '../server/lib/atomic.mjs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---- 固定时钟：2026-11-11 12:00 北京时间（周三）。所有 Date.now 走这里。----
const BASE_NOW = Date.UTC(2026, 10, 11, 4, 0, 0)
const realDateNow = Date.now
let mockNow = BASE_NOW
Date.now = () => mockNow
const setNow = (ms: number) => { mockNow = ms }
const advance = (ms: number) => { mockNow += ms }
const DAY = 86400000
const WEEK = 7 * DAY

const SECRET = Buffer.alloc(32, 7)
const OTHER_SECRET = Buffer.alloc(32, 9)
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const KEY_ID = sha256(SECRET)

const roots: string[] = []
function mkRoot(prefix = 'yfe-nickanon-') {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(r)
  return r
}
function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}
function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
// 最小可启动社区目录（posts/comments 空表 + 指定 profiles），供映射校验测试直接写盘
function seedCommunity(root: string, profiles: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(root, { recursive: true })
  writeJson(path.join(root, 'posts.json'), extra.posts ?? { version: 1, items: {} })
  writeJson(path.join(root, 'comments.json'), extra.comments ?? { version: 1, items: {} })
  writeJson(path.join(root, 'profiles.json'), { version: 1, items: profiles })
  if (extra.rank) writeJson(path.join(root, 'rank.json'), extra.rank)
}
function expectThrow(fn: () => unknown, match: RegExp): boolean {
  try { fn(); return false } catch (e) { return match.test(e instanceof Error ? e.message : String(e)) }
}
function throwsCode(fn: () => unknown, code: string): boolean {
  try { fn(); return false } catch (e: any) { return e?.code === code }
}

console.log('\n—— communityNicknameAnon 用例开始 ——')

// ===================== A 纯分配 =====================
try {
  ok('词表 1672 条且哈希自洽', BEAST_NAMES.length === 1672 && sha256(Buffer.from(BEAST_NAMES.join('\n') + '\n')) === BEAST_DICTIONARY_SHA256)

  // 周口径：北京周一 00:00 = UTC 周日 16:00
  const weekStart = Date.UTC(2026, 10, 8, 16, 0, 0) // 2026-11-09 00:00 北京
  ok('周界前一毫秒归上一周', anonymousWeekKey(weekStart - 1) === '2026-11-02')
  ok('周界当刻归本周', anonymousWeekKey(weekStart) === '2026-11-09')
  ok('周日 23:59 北京仍归本周', anonymousWeekKey(Date.UTC(2026, 10, 15, 15, 59, 59)) === '2026-11-09')
  ok('坏时间戳受控错误码', (() => { try { anonymousWeekKey(0); return false } catch (e: any) { return e.code === 'COMMUNITY_ANON_UNAVAILABLE' } })())
  ok('非整数时间戳受控错误码', (() => { try { anonymousWeekKey(1.5); return false } catch (e: any) { return e.code === 'COMMUNITY_ANON_UNAVAILABLE' } })())

  ok('validAnonymousWeek 认周一', validAnonymousWeek('2026-11-09') && !validAnonymousWeek('2026-11-10') && !validAnonymousWeek('2026-13-99'))
  ok('validAnonymousHandle 认词表名与序号', validAnonymousHandle(BEAST_NAMES[0]) && validAnonymousHandle(`${BEAST_NAMES[0]}-02`) && validAnonymousHandle(`${BEAST_NAMES[0]}-101`) && !validAnonymousHandle(`${BEAST_NAMES[0]}-01`) && !validAnonymousHandle('不存在的兽'))

  // 排行归属周：report 日所在周 + 月首所在周（去重）
  ok('anonymousRankWeeks 跨月返回两周', JSON.stringify(anonymousRankWeeks('2026-11-11')) === JSON.stringify(['2026-11-09', '2026-10-26']))
  ok('anonymousRankWeeks 月首即周一时去重', JSON.stringify(anonymousRankWeeks('2026-06-01')) === JSON.stringify(['2026-06-01']))
  ok('anonymousRankWeeks 坏日期受控错误码', (() => { try { anonymousRankWeeks('2026-11-31'); return false } catch (e: any) { return e.code === 'COMMUNITY_ANON_UNAVAILABLE' } })())

  // 单条分配：幂等 + 克隆语义（不改原映射）
  const w = '2026-11-09'
  const first = allocateAnonymousHandle({}, 'u1', w, SECRET)
  ok('首次分配 created=true', first.created === true && validAnonymousHandle(first.handle))
  const again = allocateAnonymousHandle(first.mapping, 'u1', w, SECRET)
  ok('同 (周,账号) 幂等不新建', again.created === false && again.handle === first.handle)
  ok('分配克隆原映射不被改动', Object.keys(first.mapping[w]).length === 1 && JSON.stringify(again.mapping) === JSON.stringify(first.mapping))
  const second = allocateAnonymousHandle(first.mapping, 'u2', w, SECRET)
  ok('同周不同账号必不同代号', second.handle !== first.handle)
  ok('不同周独立分配', allocateAnonymousHandle({}, 'u1', '2026-11-16', SECRET).created === true)

  // 碰撞序号：单词词表强制同名，-02…-99…-100…-101
  const one = ['唯一兽']
  let map: any = {}
  const handles: string[] = []
  for (let i = 0; i < 101; i++) {
    const r = allocateAnonymousHandle(map, `u${i}`, w, SECRET, one)
    map = r.mapping
    handles.push(r.handle)
  }
  ok('碰撞首位无后缀', handles[0] === '唯一兽')
  ok('碰撞第二位 -02', handles[1] === '唯一兽-02')
  ok('碰撞第 99 位 -99', handles[98] === '唯一兽-99')
  ok('碰撞第 100 位扩三位 -100', handles[99] === '唯一兽-100')
  ok('碰撞第 101 位 -101', handles[100] === '唯一兽-101')
  ok('碰撞序号全部唯一', new Set(handles).size === handles.length)

  // 容量上限：预占 50000 个同名序号后再分配即满（用真实词表名，批量会校验既有代号合法性）
  const full: any = { [w]: {} }
  full[w].full0 = BEAST_NAMES[0]
  for (let i = 2; i <= 50000; i++) full[w][`full${i}`] = `${BEAST_NAMES[0]}-${String(i).padStart(2, '0')}`
  ok('容量满时受控拒绝', (() => { try { allocateAnonymousHandlesBatch(full, [[w, 'overflow']], SECRET, [BEAST_NAMES[0]]); return false } catch (e: any) { return e.code === 'COMMUNITY_ANON_UNAVAILABLE' && /容量已满/.test(e.message) } })())

  // 批量：线性、幂等、created 清单
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < 200; i++) pairs.push([i % 2 ? '2026-11-16' : w, `b${i}`])
  const batch = allocateAnonymousHandlesBatch({}, pairs, SECRET)
  ok('批量创建数与对数一致', batch.created.length === 200)
  ok('批量同周代号唯一', new Set(Object.values(batch.mapping[w])).size === Object.values(batch.mapping[w]).length)
  const batch2 = allocateAnonymousHandlesBatch(batch.mapping, pairs, SECRET)
  ok('批量重跑幂等零新建', batch2.created.length === 0 && JSON.stringify(batch2.mapping) === JSON.stringify(batch.mapping))
  ok('批量拒绝短密钥', expectThrow(() => allocateAnonymousHandlesBatch({}, [[w, 'x']], Buffer.alloc(8)), /密钥不可用/))
  ok('批量拒绝重复词表', expectThrow(() => allocateAnonymousHandlesBatch({}, [[w, 'x']], SECRET, ['甲', '甲']), /词表不可用/))
  ok('批量拒绝同周重复代号', expectThrow(() => allocateAnonymousHandlesBatch({ [w]: { a: BEAST_NAMES[0], b: BEAST_NAMES[0] } }, [[w, 'x']], SECRET), /冲突/))
  ok('批量拒绝非法周', expectThrow(() => allocateAnonymousHandlesBatch({}, [['2026-11-10', 'x']], SECRET), /参数无效/))
  ok('单条拒绝短密钥', expectThrow(() => allocateAnonymousHandle({}, 'x', w, Buffer.alloc(8)), /密钥不可用/))
} catch (e) {
  fail++; console.log('FAIL A 段异常 :: ' + (e instanceof Error ? e.stack : String(e)))
}

// ===================== B 存储层 =====================
try {
  // 启用边界
  const noKeyRoot = mkRoot()
  seedCommunity(noKeyRoot, {})
  const noKey = createCommunityStore({ root: noKeyRoot })
  ok('无密钥 anonymousEnabled=false', noKey.anonymousEnabled() === false)
  ok('无密钥取代号受控拒绝', expectThrow(() => noKey.getAnonymousHandle('u1', '2026-11-09'), /密钥未配置/))
  ok('无密钥 ensure 受控拒绝', expectThrow(() => noKey.ensureAnonymousHandle('u1', '2026-11-09'), /密钥未配置/))
  ok('无密钥无映射可启动校验', (() => { noKey.assertAnonymousMappings(); return true })())

  const keyRoot = mkRoot()
  seedCommunity(keyRoot, {})
  const store = createCommunityStore({ root: keyRoot, anonSecret: SECRET })
  ok('有密钥 anonymousEnabled=true', store.anonymousEnabled() === true)
  const h1 = store.ensureAnonymousHandle('u1', '2026-11-09')
  ok('ensure 分配并持久化', validAnonymousHandle(h1) && store.getAnonymousHandle('u1', '2026-11-09') === h1)
  ok('ensure 幂等', store.ensureAnonymousHandle('u1', '2026-11-09') === h1)
  const h2 = store.ensureAnonymousHandle('u2', '2026-11-09')
  ok('同周第二账号不同代号', h2 !== h1)
  ok('映射写入 anonKeyId/anonDict', store.getProfile('u1')!.anonKeyId === KEY_ID && store.getProfile('u1')!.anonDict === BEAST_DICTIONARY_SHA256)
  ok('合法映射启动校验通过', (() => { store.assertAnonymousMappings(); return true })())

  // 写失败：注入 profiles 写盘失败 -> 无幽灵、可重试
  const failRoot = mkRoot()
  seedCommunity(failRoot, {})
  let failProfiles = false
  const failStore = createCommunityStore({
    root: failRoot, anonSecret: SECRET,
    writeText: (abs: string, text: string) => {
      if (failProfiles && abs.endsWith('profiles.json')) throw new Error('注入：profiles 写盘失败')
      return writeTextAtomicSync(abs, text)
    },
  })
  failProfiles = true
  ok('ensure 写失败抛出', expectThrow(() => failStore.ensureAnonymousHandle('ghost', '2026-11-09'), /写盘失败/))
  ok('写失败后无幽灵代号', failStore.getProfile('ghost') === null)
  failProfiles = false
  ok('写失败恢复后重试成功', validAnonymousHandle(failStore.ensureAnonymousHandle('ghost', '2026-11-09')))

  // 映射损坏 / 缺失 / 冲突 -> assertAnonymousMappings 拒绝
  const goodProfile = (handle: string, week = '2026-11-09') => ({
    nickname: '', postDisplay: 'anonymous', commentDisplay: 'anonymous', rankDisplay: 'anonymous',
    rankOptIn: false, updatedAt: 1, anonKeyId: KEY_ID, anonDict: BEAST_DICTIONARY_SHA256, anonHandles: { [week]: handle },
  })
  const beast0 = BEAST_NAMES[0], beast1 = BEAST_NAMES[1]
  const cases: Array<[string, () => void]> = [
    ['无密钥但有映射拒绝启动', () => { const r = mkRoot(); seedCommunity(r, { u1: goodProfile(beast0) }); createCommunityStore({ root: r }).assertAnonymousMappings() }],
    ['密钥不符拒绝启动', () => { const r = mkRoot(); seedCommunity(r, { u1: { ...goodProfile(beast0), anonKeyId: sha256(OTHER_SECRET) } }); createCommunityStore({ root: r, anonSecret: SECRET }).assertAnonymousMappings() }],
    ['词表版本不符拒绝启动', () => { const r = mkRoot(); seedCommunity(r, { u1: { ...goodProfile(beast0), anonDict: 'f'.repeat(64) } }); createCommunityStore({ root: r, anonSecret: SECRET }).assertAnonymousMappings() }],
    ['跨档案同周同代号冲突拒绝', () => { const r = mkRoot(); seedCommunity(r, { u1: goodProfile(beast0), u2: goodProfile(beast0) }); createCommunityStore({ root: r, anonSecret: SECRET }).assertAnonymousMappings() }],
    ['非法周标识拒绝', () => { const r = mkRoot(); seedCommunity(r, { u1: goodProfile(beast0, '2026-11-10') }); createCommunityStore({ root: r, anonSecret: SECRET }).assertAnonymousMappings() }],
    ['非法代号拒绝', () => { const r = mkRoot(); seedCommunity(r, { u1: goodProfile('不存在的兽') }); createCommunityStore({ root: r, anonSecret: SECRET }).assertAnonymousMappings() }],
    ['帖子引用缺失拒绝', () => {
      const r = mkRoot()
      seedCommunity(r, { u1: goodProfile(beast0) }, { posts: { version: 1, items: { p1: { id: 'p1', uid: 'u2', status: 'published', display: 'anonymous', createdAt: BASE_NOW, publishedVersionId: 'v1', versions: [{ vid: 'v1', title: 't', body: 'b', tags: [], createdAt: BASE_NOW }] } } } })
      createCommunityStore({ root: r, anonSecret: SECRET }).assertAnonymousMappings()
    }],
    ['评论引用缺失拒绝', () => {
      const r = mkRoot()
      seedCommunity(r, { u1: goodProfile(beast0) }, { comments: { version: 1, items: { c1: { id: 'c1', postId: 'p1', uid: 'u2', body: 'b', status: 'visible', display: 'anonymous', createdAt: BASE_NOW } } } })
      createCommunityStore({ root: r, anonSecret: SECRET }).assertAnonymousMappings()
    }],
    ['排行引用缺失拒绝', () => {
      const r = mkRoot()
      seedCommunity(r, { u1: goodProfile(beast0) }, { rank: { version: 1, items: { 'u2::dev::proj::2026-11-11': { uid: 'u2', deviceId: 'dev', projectId: 'proj', date: '2026-11-11', netDelta: 100, seq: 1 } } } })
      createCommunityStore({ root: r, anonSecret: SECRET }).assertAnonymousMappings()
    }],
  ]
  for (const [name, fn] of cases) ok(name, expectThrow(fn, /匿名代号|密钥/))

  // 完整一致映射（帖子/评论/排行同账号同周）-> 通过
  const consistentRoot = mkRoot()
  const bothWeeks: any = { '2026-11-09': beast0, '2026-10-26': beast1 }
  seedCommunity(consistentRoot, {
    u1: { nickname: '', postDisplay: 'anonymous', commentDisplay: 'anonymous', rankDisplay: 'anonymous', rankOptIn: true, updatedAt: 1, anonKeyId: KEY_ID, anonDict: BEAST_DICTIONARY_SHA256, anonHandles: bothWeeks },
  }, {
    posts: { version: 1, items: { p1: { id: 'p1', uid: 'u1', status: 'published', display: 'anonymous', createdAt: BASE_NOW, publishedVersionId: 'v1', versions: [{ vid: 'v1', title: 't', body: 'b', tags: [], createdAt: BASE_NOW }] } } },
    comments: { version: 1, items: { c1: { id: 'c1', postId: 'p1', uid: 'u1', body: 'b', status: 'visible', display: 'anonymous', createdAt: BASE_NOW } } },
    rank: { version: 1, items: { 'u1::dev::proj::2026-11-09': { uid: 'u1', deviceId: 'dev', projectId: 'proj', date: '2026-11-09', netDelta: 100, seq: 1 } } },
  })
  ok('帖子/评论/排行一致映射通过校验', (() => { createCommunityStore({ root: consistentRoot, anonSecret: SECRET }).assertAnonymousMappings(); return true })())

  // ---- 昵称冷却（直接 putProfile，精确控制时钟）----
  const nickRoot = mkRoot()
  const nickStore = createCommunityStore({ root: nickRoot })
  setNow(BASE_NOW)
  const n1 = nickStore.putProfile('n1', { nickname: '甲' })
  ok('首建昵称记录时间戳', n1.nicknameChangedAt === BASE_NOW)
  ok('首建后 7 天内再改被拒', (() => { try { nickStore.putProfile('n1', { nickname: '乙' }); return false } catch (e: any) { return e.code === 'NICKNAME_COOLDOWN' && e.retryAfter > 0 } })())
  ok('同昵称保存不耗额度', nickStore.putProfile('n1', { nickname: '甲' }).nicknameChangedAt === BASE_NOW)
  ok('只改展示设置不耗额度', nickStore.putProfile('n1', { postDisplay: 'nickname' }).nicknameChangedAt === BASE_NOW)
  setNow(BASE_NOW + WEEK - 1)
  ok('冷却差一毫秒仍被拒', throwsCode(() => nickStore.putProfile('n1', { nickname: '丙' }), 'NICKNAME_COOLDOWN'))
  setNow(BASE_NOW + WEEK)
  ok('整 7 天边界放行', nickStore.putProfile('n1', { nickname: '丙' }).nickname === '丙')
  ok('放行后刷新时间戳', nickStore.getProfile('n1')!.nicknameChangedAt === BASE_NOW + WEEK)

  // 老账号（无 nicknameChangedAt）允许一次修正
  const oldRoot = mkRoot()
  seedCommunity(oldRoot, { old: { nickname: '旧名', postDisplay: 'anonymous', commentDisplay: 'anonymous', rankDisplay: 'anonymous', rankOptIn: false, updatedAt: 1 } })
  const oldStore = createCommunityStore({ root: oldRoot })
  setNow(BASE_NOW)
  ok('老账号无时间戳允许一次修改', oldStore.putProfile('old', { nickname: '新名' }).nickname === '新名')
  ok('老账号修改后进入冷却', throwsCode(() => oldStore.putProfile('old', { nickname: '再新' }), 'NICKNAME_COOLDOWN'))

  // 损坏 / 未来时间 -> 失败关闭
  for (const [label, bad] of [['字符串', 'bad'], ['负数', -1], ['未来', BASE_NOW + DAY]] as Array<[string, unknown]>) {
    const r = mkRoot()
    seedCommunity(r, { t: { nickname: '名', nicknameChangedAt: bad, postDisplay: 'anonymous', commentDisplay: 'anonymous', rankDisplay: 'anonymous', rankOptIn: false, updatedAt: 1 } })
    const s = createCommunityStore({ root: r })
    setNow(BASE_NOW)
    ok(`时间戳${label}拒绝修改`, (() => { try { s.putProfile('t', { nickname: '改名' }); return false } catch (e: any) { return e.code === 'NICKNAME_TIME_INVALID' } })())
  }
  setNow(BASE_NOW)
} catch (e) {
  fail++; console.log('FAIL B 段异常 :: ' + (e instanceof Error ? e.stack : String(e)))
}

// ===================== C 接口层 =====================
const apiRoot = mkRoot()
seedCommunity(apiRoot, {})
const apiStore = createCommunityStore({ root: apiRoot, anonSecret: SECRET })
const USERS: Record<string, { id: string; name: string; role?: string }> = {
  alice: { id: 'u_alice', name: 'alice' },
  bob: { id: 'u_bob', name: 'bob' },
  carol: { id: 'u_carol', name: 'carol' },
  dave: { id: 'u_dave', name: 'dave' },
  erin: { id: 'u_erin', name: 'erin' },
  mod: { id: 'u_mod', name: 'mod', role: 'moderator' },
  admin: { id: 'u_admin', name: 'admin', role: 'admin' },
}
const byId = new Map(Object.values(USERS).map((u) => [u.id, u]))
const api = createCommunityApi({
  store: apiStore,
  authCheck: (req: any) => {
    const who = String(req.headers['x-test-user'] || '')
    const u = USERS[who]
    return { user: u || null, reason: u ? '' : 'NO_TOKEN' }
  },
  rateLimit,
})
const server = createServer((req, res) => {
  const url = req.url || '/'
  const pathOnly = url.split('?')[0]
  const qs = new URLSearchParams(url.split('?')[1] || '')
  if (!pathOnly.startsWith('/api/community')) { res.writeHead(404); res.end('{"ok":false}'); return }
  const who = String(req.headers['x-test-user'] || '')
  const user = USERS[who] ? byId.get(USERS[who].id)! : null
  api.handle({ req, res, path: pathOnly, qs, user, authReason: user ? '' : 'NO_TOKEN', ip: '127.0.0.1' })
    .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: String(e) })) })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const addr = server.address()
const port = typeof addr === 'object' && addr ? addr.port : 0
const base = `http://127.0.0.1:${port}`
interface Result { status: number; json: any; raw: string }
async function call(p: string, opts: { method?: string; body?: unknown; as?: string } = {}): Promise<Result> {
  const headers: Record<string, string> = {}
  if (opts.as) headers['x-test-user'] = opts.as
  let body: string | undefined
  if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body) }
  const res = await fetch(base + p, { method: opts.method || 'GET', headers, body })
  const raw = await res.text()
  let json: any = null
  try { json = JSON.parse(raw) } catch { json = null }
  return { status: res.status, json, raw }
}
const body = (n = 30) => '字'.repeat(n) + '，雨落在城墙上。'
const approve = (pid: string, vid: string) => call('/api/community/admin/decision', { method: 'POST', as: 'mod', body: { targetType: 'post', id: pid, versionId: vid, action: 'approve' } })

try {
  setNow(BASE_NOW)
  // profile 字段下发
  const prof = await call('/api/community/profile', { as: 'alice' })
  ok('profile 下发 serverNow', prof.json.profile.serverNow === BASE_NOW)
  ok('profile 下发 anonymousHandlesEnabled', prof.json.profile.anonymousHandlesEnabled === true)
  ok('新账号 nicknameNextChangeAt=0', prof.json.profile.nicknameNextChangeAt === 0 && prof.json.profile.nicknameTimeInvalid === false)

  // 昵称冷却（API）
  const set1 = await call('/api/community/profile', { method: 'PUT', as: 'bob', body: { nickname: '青灯' } })
  ok('API 首建昵称成功', set1.status === 200 && set1.json.profile.nicknameNextChangeAt === BASE_NOW + WEEK)
  const blocked = await call('/api/community/profile', { method: 'PUT', as: 'bob', body: { nickname: '青灯二' } })
  ok('API 冷却期 409 + retryAfter', blocked.status === 409 && blocked.json.code === 'NICKNAME_COOLDOWN' && blocked.json.retryAfter > 0)
  const same = await call('/api/community/profile', { method: 'PUT', as: 'bob', body: { nickname: '青灯' } })
  ok('API 同昵称不耗额度', same.status === 200 && same.json.profile.nicknameNextChangeAt === BASE_NOW + WEEK)
  const dispOnly = await call('/api/community/profile', { method: 'PUT', as: 'bob', body: { postDisplay: 'nickname' } })
  ok('API 只改展示不耗额度', dispOnly.status === 200 && dispOnly.json.profile.nicknameNextChangeAt === BASE_NOW + WEEK)

  // 冒名变体（全角/半角括号、零宽、NFKC）
  for (const bad of ['匿名用户', '匿名用户（匿名用户）', '匿名用户(匿名用户)', '匿名\u200b用户', '匿 名 用 户', '官方客服', '管理员小王']) {
    const r = await call('/api/community/profile', { method: 'PUT', as: 'dave', body: { nickname: bad } })
    ok(`冒名/非法昵称被拒：${JSON.stringify(bad)}`, r.status === 400)
  }
  ok('validateNickname 全角括号结尾拒绝', validateNickname('某某（匿名用户）').ok === false)
  ok('validateNickname 零宽拼接拒绝', validateNickname('匿名\u200b用户').ok === false)
  ok('validateNickname 正常名放行', validateNickname('雨声').ok === true)

  // 匿名代号一致：同周帖子与评论同代号
  const pa = await call('/api/community/posts', { method: 'POST', as: 'alice', body: { title: '匿名甲', body: body(), display: 'anonymous' } })
  const pidA = pa.json.post.id as string
  await approve(pidA, pa.json.post.pendingVersionId)
  const weekNow = '2026-11-09'
  const handleAlice = apiStore.getAnonymousHandle('u_alice', weekNow)
  const detailA = await call(`/api/community/posts/${pidA}`)
  ok('匿名帖子显示代号（匿名用户）', detailA.json.post.displayName === `${handleAlice}（匿名用户）`)
  ok('公开载荷不泄露账号标识', !detailA.raw.includes('u_alice') && !detailA.raw.includes('alice'))
  const ca = await call(`/api/community/posts/${pidA}/comments`, { method: 'POST', as: 'alice', body: { body: '作者自评论，雨声很好。' } })
  ok('同周评论与帖子同代号', ca.json.comment.displayName === `${handleAlice}（匿名用户）`)
  const pd = await call('/api/community/posts', { method: 'POST', as: 'dave', body: { title: '匿名丁', body: body(), display: 'anonymous' } })
  await approve(pd.json.post.id, pd.json.post.pendingVersionId)
  ok('同周不同账号代号唯一（接口层）', (await call(`/api/community/posts/${pd.json.post.id}`)).json.post.displayName !== `${handleAlice}（匿名用户）`)

  // 示例帖标签
  apiStore.putPost({
    id: 'example_test', uid: '__example__', isExample: true, status: 'published', display: 'anonymous',
    createdAt: BASE_NOW, updatedAt: BASE_NOW, publishedVersionId: 'ev1', pendingVersionId: '',
    versions: [{ vid: 'ev1', title: '示例', body: body(), tags: ['短篇'], createdAt: BASE_NOW }], counts: { up: 0, down: 0, comments: 0 },
  })
  ok('示例帖显示「示例投稿」不分配代号', (await call('/api/community/posts/example_test')).json.post.displayName === '示例投稿')

  // 公开读不写盘：GET 前后 profiles.json 不变
  const profilesPath = path.join(apiRoot, 'profiles.json')
  const before = fs.readFileSync(profilesPath, 'utf8')
  await call('/api/community/posts')
  await call(`/api/community/posts/${pidA}`)
  await call(`/api/community/posts/${pidA}/comments`)
  ok('公开读不触发 profiles 写盘', fs.readFileSync(profilesPath, 'utf8') === before)

  // 周榜 / 月榜归属周
  await call('/api/community/profile', { method: 'PUT', as: 'carol', body: { rankOptIn: true, rankDisplay: 'anonymous' } })
  const rep = await call('/api/community/rank/report', { method: 'POST', as: 'carol', body: { deviceId: 'dev-carol-01', entries: [{ projectId: 'proj', date: '2026-11-11', netDelta: 5000, seq: 1 }] } })
  ok('排行上报接受', rep.status === 200 && rep.json.accepted.length === 1)
  const hWeek = apiStore.getAnonymousHandle('u_carol', '2026-11-09')
  const hMonth = apiStore.getAnonymousHandle('u_carol', '2026-10-26')
  const dayRank = await call('/api/community/rank?period=day&date=2026-11-11')
  ok('日榜用报告日所在周代号', dayRank.json.entries[0]?.displayName === `${hWeek}（匿名用户）`)
  const weekRank = await call('/api/community/rank?period=week&date=2026-11-11')
  ok('周榜用本周代号', weekRank.json.entries[0]?.displayName === `${hWeek}（匿名用户）` && weekRank.json.entries[0]?.value === 5000)
  const monthRank = await call('/api/community/rank?period=month&date=2026-11-11')
  ok('月榜用月首所在周代号（非报告周）', monthRank.json.entries[0]?.displayName === `${hMonth}（匿名用户）` && monthRank.json.entries[0]?.value === 5000)
  ok('月榜与周榜代号不同周', hMonth !== hWeek)
  ok('排行不泄露账号标识', !monthRank.raw.includes('u_carol') && !monthRank.raw.includes('carol'))
  // 昵称排行并存
  await call('/api/community/profile', { method: 'PUT', as: 'erin', body: { rankOptIn: true, rankDisplay: 'nickname', nickname: ' Erin 灯' } })
  await call('/api/community/rank/report', { method: 'POST', as: 'erin', body: { deviceId: 'dev-erin-01', entries: [{ projectId: 'proj', date: '2026-11-11', netDelta: 9000, seq: 1 }] } })
  const mixRank = await call('/api/community/rank?period=day&date=2026-11-11')
  ok('昵称排行与匿名代号并存', mixRank.json.entries.some((e: any) => e.displayName === 'Erin 灯') && mixRank.json.entries.some((e: any) => e.displayName === `${hWeek}（匿名用户）`))

  // 混合请求守卫：昵称 + 撤回排行（有数据）整体拒绝，且不删排行
  const conflict = await call('/api/community/profile', { method: 'PUT', as: 'carol', body: { nickname: '冲突名', rankOptIn: false } })
  ok('昵称+排行撤回混合请求 400', conflict.status === 400 && conflict.json.code === 'PROFILE_FIELDS_CONFLICT')
  ok('混合请求拒绝后排行数据仍在', (await call('/api/community/rank?period=day&date=2026-11-11')).json.entries.some((e: any) => e.displayName === `${hWeek}（匿名用户）`))

  // 跨周编辑 / 审核：代号冻结在创建周
  advance(8 * DAY) // -> 2026-11-19，周 2026-11-16
  const edited = await call(`/api/community/posts/${pidA}`, { method: 'PUT', as: 'alice', body: { title: '匿名甲（修）', body: body(40) } })
  await approve(pidA, edited.json.post.pendingVersionId)
  ok('跨周编辑审核后代号不变', (await call(`/api/community/posts/${pidA}`)).json.post.displayName === `${handleAlice}（匿名用户）`)
  const pb = await call('/api/community/posts', { method: 'POST', as: 'alice', body: { title: '跨周新稿', body: body(), display: 'anonymous' } })
  await approve(pb.json.post.id, pb.json.post.pendingVersionId)
  const handleNewWeek = apiStore.getAnonymousHandle('u_alice', '2026-11-16')
  ok('跨周新稿用新周代号', (await call(`/api/community/posts/${pb.json.post.id}`)).json.post.displayName === `${handleNewWeek}（匿名用户）`)

  // 撤回再发布：代号仍冻结创建周
  await call(`/api/community/posts/${pidA}/withdraw`, { method: 'POST', as: 'alice' })
  ok('撤回后退出公开', (await call(`/api/community/posts/${pidA}`)).json?.post === undefined)
  const resub = await call(`/api/community/posts/${pidA}/submit`, { method: 'POST', as: 'alice' })
  await approve(pidA, resub.json.post.pendingVersionId)
  ok('撤回再发布后代号不变', (await call(`/api/community/posts/${pidA}`)).json.post.displayName === `${handleAlice}（匿名用户）`)

  // 旧客户端兼容：无账号上下文头、旧式 PUT 仍可用
  const legacyGet = await call('/api/community/profile', { as: 'bob' })
  ok('旧客户端 GET profile 仍可用', legacyGet.status === 200 && typeof legacyGet.json.profile.postDisplay === 'string')
  const legacyPut = await call('/api/community/profile', { method: 'PUT', as: 'bob', body: { postDisplay: 'anonymous' } })
  ok('旧式 PUT 仍可用且下发新字段', legacyPut.status === 200 && 'anonymousHandlesEnabled' in legacyPut.json.profile)

  // 账号切换隔离：dave 的代号与 alice 不同，互不串
  ok('账号切换代号隔离', apiStore.getAnonymousHandle('u_dave', weekNow) !== handleAlice)
} catch (e) {
  fail++; console.log('FAIL C 段异常 :: ' + (e instanceof Error ? e.stack : String(e)))
}

// ===================== D 备份恢复 =====================
try {
  setNow(BASE_NOW)
  const live = mkRoot()
  seedCommunity(live, {})
  const liveStore = createCommunityStore({ root: live, anonSecret: SECRET })
  liveStore.ensureAnonymousHandle('u1', '2026-11-09')
  const backupDir = path.join(mkRoot(), 'backup')
  ok('含匿名映射备份成功', createBackup({ root: live, dest: backupDir, stopConfirmed: true }).ok)

  const restoreRoot = () => path.join(mkRoot(), 'community')
  const mismatch = restoreBackup({ backupDir, root: restoreRoot(), stopConfirmed: true, acceptVisibilityChanges: true, anonKeyId: sha256(OTHER_SECRET) })
  ok('错误密钥拒绝恢复', mismatch.ok === false && mismatch.code === 'ANON_KEY_MISMATCH')
  const badFormat = restoreBackup({ backupDir, root: restoreRoot(), stopConfirmed: true, acceptVisibilityChanges: true, anonKeyId: 'not-hex' })
  ok('非法密钥标识拒绝恢复', badFormat.ok === false && badFormat.code === 'ANON_KEY_INVALID')
  const correct = restoreBackup({ backupDir, root: restoreRoot(), stopConfirmed: true, acceptVisibilityChanges: true, anonKeyId: KEY_ID })
  ok('正确密钥恢复成功', correct.ok === true)
  const noKey = restoreBackup({ backupDir, root: restoreRoot(), stopConfirmed: true, acceptVisibilityChanges: true })
  ok('未提供密钥给出警告而非静默', noKey.ok === true && (noKey.warnings || []).some((w: string) => /匿名代号映射/.test(w)))

  // 词表版本不符：改备份 profiles.anonDict 并重算清单哈希，使校验通过但版本不符
  const dictBackup = path.join(mkRoot(), 'backup-dict')
  ok('准备词表测试备份', createBackup({ root: live, dest: dictBackup, stopConfirmed: true }).ok)
  const pf = path.join(dictBackup, 'profiles.json')
  const pdata = readJson(pf)
  for (const p of Object.values(pdata.items) as any[]) if (p.anonDict) p.anonDict = 'a'.repeat(64)
  const ptext = JSON.stringify(pdata, null, 2)
  fs.writeFileSync(pf, ptext, 'utf8')
  const manifestPath = path.join(dictBackup, BACKUP_MANIFEST)
  const manifest = readJson(manifestPath)
  manifest.files['profiles.json'] = { bytes: Buffer.byteLength(ptext, 'utf8'), sha256: sha256(Buffer.from(ptext)) }
  writeJson(manifestPath, manifest)
  const dictMismatch = restoreBackup({ backupDir: dictBackup, root: restoreRoot(), stopConfirmed: true, acceptVisibilityChanges: true, anonKeyId: KEY_ID })
  ok('词表版本不符拒绝恢复', dictMismatch.ok === false && dictMismatch.code === 'ANON_DICT_MISMATCH')

  // 指纹键序：anonHandles 键序不同不应报 profiles 差异
  const orderA = path.join(mkRoot(), 'order-a')
  const orderB = path.join(mkRoot(), 'order-b')
  const pa = { nickname: '', anonKeyId: KEY_ID, anonDict: BEAST_DICTIONARY_SHA256, anonHandles: { '2026-11-09': BEAST_NAMES[0], '2026-11-16': BEAST_NAMES[1] } }
  const pb = { nickname: '', anonKeyId: KEY_ID, anonDict: BEAST_DICTIONARY_SHA256, anonHandles: { '2026-11-16': BEAST_NAMES[1], '2026-11-09': BEAST_NAMES[0] } }
  seedCommunity(orderA, { u1: pa })
  seedCommunity(orderB, { u1: pb })
  const diff = diffVisibility({ 'profiles.json': readJson(path.join(orderA, 'profiles.json')) }, { 'profiles.json': readJson(path.join(orderB, 'profiles.json')) })
  ok('anonHandles 键序不同不报假差异', diff.summary.profilesChanged === 0 && diff.changes.length === 0)
} catch (e) {
  fail++; console.log('FAIL D 段异常 :: ' + (e instanceof Error ? e.stack : String(e)))
}

// ---- 收尾 ----
await new Promise<void>((resolve) => server.close(() => resolve()))
Date.now = realDateNow
for (const r of roots) {
  const target = fs.realpathSync(r)
  if (path.dirname(target) !== fs.realpathSync(os.tmpdir()) || !path.basename(target).startsWith('yfe-nickanon-')) {
    throw new Error('拒绝清理不安全的测试目录')
  }
  fs.rmSync(target, { recursive: true, force: true })
}

console.log(`communityNicknameAnon: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1