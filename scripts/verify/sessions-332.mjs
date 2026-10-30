// P1 · 会话数据层自检（不连服务器、不碰真实账号）
// 用法：node scripts/verify/sessions-332.mjs
// 退出码 0 = 全部通过；非 0 = 有断言失败（逐条打印）
import assert from 'node:assert/strict'
import {
  SESSION_LIMITS, createSession, findActive, touch, revoke, revokeOthers, revokeAll,
  prune, migrateLegacySession, summarize, expiryReason,
} from '../../server/lib/sessions.mjs'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0)
let passed = 0
const fails = []

function ok(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name) }
  catch (e) { fails.push({ name, message: e.message }); console.log('FAIL ' + name + ' — ' + e.message) }
}

function mk(i, now = T0) {
  return createSession([], { sid: `s${i}`, tokenHash: `h${i}`, kind: 'web', label: `d${i}`, now })
}

// 1. 软上限：第 11 台仍放行，但标记 limitExceeded
ok('软上限 10：第 11 台放行并提示撤销', () => {
  let list = []
  for (let i = 1; i <= SESSION_LIMITS.soft; i++) {
    const r = createSession(list, { sid: `s${i}`, tokenHash: `h${i}`, now: T0 })
    assert.equal(r.ok, true)
    assert.equal(r.limitExceeded, i > SESSION_LIMITS.soft ? true : false)
    list = r.list
  }
  const r11 = createSession(list, { sid: 's11', tokenHash: 'h11', now: T0 })
  assert.equal(r11.ok, true, '软上限不得拒绝登录（规划 §12：不自动踢人）')
  assert.equal(r11.limitExceeded, true)
  assert.equal(r11.activeCount, 11)
})

// 2. 硬上限：触顶拒绝
ok('硬上限 20：拒绝新会话并返回 SESSION_LIMIT_REACHED', () => {
  let list = []
  for (let i = 1; i <= SESSION_LIMITS.hard; i++) list = createSession(list, { sid: `s${i}`, tokenHash: `h${i}`, now: T0 }).list
  const r = createSession(list, { sid: 'sX', tokenHash: 'hX', now: T0 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SESSION_LIMIT_REACHED')
  assert.equal(r.list.length, SESSION_LIMITS.hard, '拒绝时不得改动会话表')
})

// 3. 30 天不活动过期 / 90 天绝对过期
ok('30 天不活动过期', () => {
  const { list } = mk(1)
  assert.ok(findActive(list, 'h1', T0 + 29 * DAY), '29 天应仍有效')
  assert.equal(findActive(list, 'h1', T0 + 31 * DAY), null, '31 天应失效')
  assert.equal(expiryReason(list[0], T0 + 31 * DAY), 'INACTIVITY')
})

ok('90 天绝对过期（活跃使用也不能越过）', () => {
  let { list } = mk(1)
  // 每 10 天活跃一次：不活动期限永远不到，但绝对期限必须到
  for (let d = 10; d <= 80; d += 10) {
    const r = touch(list, 's1', T0 + d * DAY)
    list = r.list
  }
  assert.ok(findActive(list, 'h1', T0 + 85 * DAY), '85 天且持续活跃应仍有效')
  assert.equal(findActive(list, 'h1', T0 + 91 * DAY), null, '91 天必须失效')
  assert.equal(expiryReason(list[0], T0 + 91 * DAY), 'ABSOLUTE')
})

// 4. touch 节流：1 小时内不落盘
ok('touch 节流：1 小时内 changed=false', () => {
  const { list } = mk(1)
  assert.equal(touch(list, 's1', T0 + 10 * 60 * 1000).changed, false, '10 分钟不该写盘')
  assert.equal(touch(list, 's1', T0 + 61 * 60 * 1000).changed, true, '61 分钟应写盘')
})

// 5. 撤销语义：单设备 / 其他 / 全部
ok('撤销单设备只影响目标', () => {
  let list = []
  for (let i = 1; i <= 3; i++) list = createSession(list, { sid: `s${i}`, tokenHash: `h${i}`, now: T0 }).list
  const r = revoke(list, 's2', T0 + 1000)
  assert.equal(r.changed, true)
  assert.equal(findActive(r.list, 'h2', T0 + 1000), null)
  assert.ok(findActive(r.list, 'h1', T0 + 1000))
  assert.ok(findActive(r.list, 'h3', T0 + 1000))
  assert.equal(revoke(r.list, 's2', T0 + 2000).changed, false, '重复撤销不该再写')
})

ok('退出其他设备保留当前', () => {
  let list = []
  for (let i = 1; i <= 3; i++) list = createSession(list, { sid: `s${i}`, tokenHash: `h${i}`, now: T0 }).list
  const r = revokeOthers(list, 's1', T0 + 1000)
  assert.equal(r.changed, 2)
  assert.ok(findActive(r.list, 'h1', T0 + 1000))
  assert.equal(findActive(r.list, 'h2', T0 + 1000), null)
  assert.equal(revokeAll(r.list, T0 + 2000).changed, 1)
})

// 6. 撤销记录保留 7 天后清理；过期行不占名额
ok('prune：撤销痕迹 7 天后清、过期行不占名额', () => {
  let list = []
  for (let i = 1; i <= 3; i++) list = createSession(list, { sid: `s${i}`, tokenHash: `h${i}`, now: T0 }).list
  list = revoke(list, 's3', T0 + 1000).list
  assert.equal(prune(list, T0 + 6 * DAY).removed, 0, '6 天时不得清')
  assert.equal(prune(list, T0 + 8 * DAY).removed, 1, '8 天时应清掉被撤销那条')
  // 硬上限不被过期行挤占
  const many = []
  for (let i = 1; i <= SESSION_LIMITS.hard; i++) many.push({ sid: `o${i}`, tokenHash: `t${i}`, kind: 'web', label: '', createdAt: T0 - 200 * DAY, lastSeenAt: T0 - 200 * DAY, revokedAt: null })
  const r = createSession(many, { sid: 'new', tokenHash: 'hnew', now: T0 })
  assert.equal(r.ok, true, '全是过期行时新会话必须能建')
})

// 7. 迁移：旧单会话继续有效，且不凭空续期
ok('迁移旧 session：token 仍是有效会话，createdAt 取旧 at', () => {
  const legacyAt = T0 - 10 * DAY
  const user = { id: 'u1', name: 'a', session: { token: 'uid.exp.sig', at: legacyAt } }
  const { user: next, changed } = migrateLegacySession(user, T0)
  assert.equal(changed, true)
  assert.equal(next.session, undefined, '旧字段应移除')
  assert.equal(next.sessionList.length, 1)
  assert.equal(next.sessionList[0].createdAt, legacyAt, '不得用 now 续期')
  assert.equal(findActive(next.sessionList, next.sessionList[0].tokenHash, T0)?.sid, next.sessionList[0].sid)
  // 迁移前已 10 天未活动 ⇒ 再过 21 天到 31 天，按不活动过期（不得因为迁移而重置计时）
  assert.equal(findActive(next.sessionList, next.sessionList[0].tokenHash, T0 + 21 * DAY), null)
})

ok('迁移空账号：得到空表，不报错', () => {
  const { user, changed } = migrateLegacySession({ id: 'u2' }, T0)
  assert.equal(changed, true)
  assert.deepEqual(user.sessionList, [])
  assert.equal(migrateLegacySession(user, T0).changed, false, '已迁移过应幂等')
})

// 8. 公开视图不得含凭据
ok('summarize 不返回 tokenHash', () => {
  const { list } = mk(1)
  const view = summarize(list, T0)
  assert.equal(JSON.stringify(view).includes('h1'), false, '视图里出现了 tokenHash')
  assert.equal(view[0].sid, 's1')
  assert.equal(view[0].active, true)
})

// 9. 参数校验
ok('非法输入早失败', () => {
  assert.throws(() => createSession([], { sid: '', tokenHash: 'h', now: T0 }))
  assert.throws(() => createSession([], { sid: 's', tokenHash: '', now: T0 }))
  assert.throws(() => createSession([], { sid: 's', tokenHash: 'h', kind: 'mobile', now: T0 }))
})

console.log('')
if (fails.length) {
  console.log(`FAILED ${fails.length} / ${passed + fails.length}`)
  console.log(JSON.stringify(fails, null, 2))
  process.exit(1)
}
console.log(`OK ${passed}/${passed}（${new Date().toISOString()}，Node ${process.version}）`)
