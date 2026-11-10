// ============ 投稿广场 · 纯规则层回归（3.5.0） ============
//
// 守的是「口径」而不是实现细节：字数怎么算、什么能自动放行、审核要不要绑定版本、
// 排行怎么抵负数。这些都是规划里明确写了边界的地方，改坏了会静默算错钱（码字量）或放行违规内容。
//
// ?? 只测 communityRules.mjs（纯函数）：不起服务、不写盘、不联网。

import {
  COMMUNITY_LIMITS, COMMUNITY_TAGS, POST_STATUS,
  charCount, isBlank, validatePostInput, validateCommentInput, validateNickname, normalizeDisplayMode,
  screenContent, commentAutoVisible, encodeCursor, decodeCursor, pageRows, clampPageSize,
  validateDecision, dateKeyToUtc, periodRange, aggregateRank, applyRankReport, todayKeyCn,
} from '../server/lib/communityRules.mjs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— communityRules 用例开始 ——')

// ---- 字数口径 ----
ok('空值计 0 字', charCount('') === 0 && charCount(undefined as unknown as string) === 0)
ok('中文按码点计数', charCount('你好世界') === 4)
ok('emoji 算 1 个码点（不是 UTF-16 长度 2）', charCount('🙂') === 1 && '🙂'.length === 2)
ok('含标点与换行都计入', charCount('你好，\n世界。') === 7)
ok('空白判定覆盖全角空格与零宽字符', isBlank(' \u3000\u200b\ufeff\n') === true && isBlank('字') === false)

// ---- 投稿校验 ----
const baseBody = '字'.repeat(10)
ok('标题为空拒绝', validatePostInput({ title: '  ', body: baseBody }).ok === false)
ok('正文只有空白拒绝', validatePostInput({ title: '标题', body: ' \n\u3000 ' }).ok === false)
ok('正文 10000 字通过', (() => {
  const r = validatePostInput({ title: '标题', body: '字'.repeat(COMMUNITY_LIMITS.bodyMax) })
  return r.ok
})())
ok('正文 10001 字拒绝', (() => {
  const r = validatePostInput({ title: '标题', body: '字'.repeat(COMMUNITY_LIMITS.bodyMax + 1) })
  return !r.ok && r.code === 'BODY_TOO_LONG'
})())
ok('标题 100 字通过 / 101 字拒绝', (() => {
  const a = validatePostInput({ title: '字'.repeat(100), body: baseBody })
  const b = validatePostInput({ title: '字'.repeat(101), body: baseBody })
  return a.ok && !b.ok && b.code === 'TITLE_TOO_LONG'
})())
ok('非预设标签拒绝', (() => {
  const r = validatePostInput({ title: '标题', body: baseBody, tags: ['随便写'] })
  return !r.ok && r.code === 'TAG_UNKNOWN'
})())
ok('标签去重且最多 3 个', (() => {
  const r = validatePostInput({ title: '标题', body: baseBody, tags: [COMMUNITY_TAGS[0], COMMUNITY_TAGS[0], COMMUNITY_TAGS[1]] })
  return r.ok && r.value.tags.length === 2
})())
ok('标签超过 3 个拒绝', (() => {
  const r = validatePostInput({ title: '标题', body: baseBody, tags: COMMUNITY_TAGS.slice(0, 4) })
  return !r.ok && r.code === 'TAG_TOO_MANY'
})())

// ---- 评论校验 ----
ok('评论为空拒绝', validateCommentInput({ body: '   ' }).ok === false)
ok('评论 1000 字通过 / 1001 字拒绝', (() => {
  const a = validateCommentInput({ body: '字'.repeat(1000) })
  const b = validateCommentInput({ body: '字'.repeat(1001) })
  return a.ok && !b.ok && b.code === 'COMMENT_TOO_LONG'
})())

// ---- 昵称 ----
ok('昵称留空拒绝', validateNickname('').ok === false)
ok('昵称最多 16 个码点', (() => {
  const a = validateNickname('字'.repeat(16))
  const b = validateNickname('字'.repeat(17))
  return a.ok && !b.ok && b.code === 'NICKNAME_TOO_LONG'
})())
ok('不能叫「匿名用户」', (() => {
  const r = validateNickname('匿名用户')
  return !r.ok && r.code === 'NICKNAME_RESERVED'
})())
ok('昵称含控制字符拒绝', validateNickname('a\u0000b').ok === false)
ok('展示模式只认两个值，其余回落匿名', (() => {
  return normalizeDisplayMode('nickname') === 'nickname'
    && normalizeDisplayMode('anonymous') === 'anonymous'
    && normalizeDisplayMode('weird') === 'anonymous'
    && normalizeDisplayMode(undefined) === 'anonymous'
})())

// ---- 规则初筛 ----
ok('普通文学文本判低风险', (() => {
  const s = screenContent('雨落在旧城墙的青砖上，他忽然想起许多年前的那句话。', 'post')
  return s.level === 'low' && s.reasons.length === 0 && s.truncated === false
})())
ok('命中手机号至少提级（不自动判违规）', (() => {
  const s = screenContent('有事联系我 13812345678 谢谢', 'comment')
  return s.level !== 'low' && s.reasons.includes('PHONE')
})())
ok('QQ 联系方式提级', (() => {
  const s = screenContent('加我 QQ 123456789', 'comment')
  return s.level !== 'low' && s.reasons.includes('CONTACT_QQ')
})())
ok('网址提级', screenContent('看这里 https://example.com/x', 'comment').reasons.includes('URL'))
ok('风险词提级，但理由码不含原文', (() => {
  const s = screenContent('专业代写，价格优惠', 'comment')
  return s.level === 'high' && s.reasons.includes('RISK_WORD')
    && !JSON.stringify(s).includes('代写')
})())
ok('单字「顶」判低信息量', screenContent('顶', 'comment').reasons.includes('LOW_INFO'))
ok('重复刷屏被识别', screenContent('哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈', 'comment').reasons.includes('REPEAT'))
ok('只有低风险且无理由才自动放行', (() => {
  const clean = screenContent('这一段写得很稳，节奏舒服。', 'comment')
  const risky = screenContent('加我 QQ 123456789', 'comment')
  return commentAutoVisible(clean) && !commentAutoVisible(risky) && !commentAutoVisible(null)
})())

// ---- 分页 ----
ok('游标可往返', (() => {
  const c = { ts: 1699999999999, id: 'p_abc' }
  const back = decodeCursor(encodeCursor(c))
  return !!back && back.ts === c.ts && back.id === c.id
})())
ok('伪游标返回 null（不是抛错）', decodeCursor('not-base64!!') === null && decodeCursor('') === null)
ok('页大小被夹在 1..50', clampPageSize(0) === COMMUNITY_LIMITS.pageSize
  && clampPageSize(999) === COMMUNITY_LIMITS.pageSizeMax && clampPageSize(-3) === COMMUNITY_LIMITS.pageSize)
ok('同一毫秒的多条靠 id 做次序键，不重复不丢', (() => {
  const rows = [
    { id: 'p_3', ts: 200 }, { id: 'p_2', ts: 200 }, { id: 'p_1', ts: 200 },
    { id: 'p_0', ts: 100 },
  ]
  const p1 = pageRows(rows, { limit: 2 })
  const c = decodeCursor(p1.nextCursor)
  const p2 = pageRows(rows, { cursor: c, limit: 2 })
  const seen = [...p1.items, ...p2.items].map((r) => r.id)
  return seen.join(',') === 'p_3,p_2,p_1,p_0'
})())

// ---- 审核绑定版本 ----
const pendingPost = { status: POST_STATUS.PENDING, pendingVersionId: 'v_2', publishedVersionId: 'v_1' }
ok('审批作用于当前待审版本通过', validateDecision(pendingPost, 'v_2', 'approve').ok)
ok('旧版本迟到回执被拒（STALE_VERSION）', (() => {
  const r = validateDecision(pendingPost, 'v_1', 'approve')
  return !r.ok && r.code === 'STALE_VERSION'
})())
ok('不在待审状态不能再审', (() => {
  const r = validateDecision({ ...pendingPost, status: POST_STATUS.PUBLISHED }, 'v_2', 'approve')
  return !r.ok && r.code === 'NOT_PENDING'
})())
ok('下架/恢复必须绑定已发布版本', (() => {
  const published = { status: POST_STATUS.PUBLISHED, pendingVersionId: '', publishedVersionId: 'v_1' }
  return validateDecision(published, 'v_1', 'remove').ok
    && !validateDecision(published, 'v_9', 'restore').ok
})())
ok('未知动作拒绝', !validateDecision(pendingPost, 'v_2', 'delete-forever').ok)

// ---- 日期与周期 ----
ok('日期校验拒绝非法日期', dateKeyToUtc('2026-02-30') === null && dateKeyToUtc('2026-11-10') !== null)
ok('周范围是周一到周日（2026-11-10 周二）', (() => {
  const r = periodRange('week', '2026-11-10')
  return !!r && r.start === '2026-11-09' && r.end === '2026-11-15'
})())
ok('周日属于上一周（2026-11-01 周日）', (() => {
  const r = periodRange('week', '2026-11-01')
  return !!r && r.start === '2026-10-26' && r.end === '2026-11-01'
})())
ok('自然月边界', (() => {
  const r = periodRange('month', '2026-02-10')
  return !!r && r.start === '2026-02-01' && r.end === '2026-02-28'
})())
ok('北京时间日期按 +8 小时折算', todayKeyCn(Date.UTC(2026, 10, 9, 17, 0, 0)) === '2026-11-10')

// ---- 排行聚合 ----
const rowsOf = (list: Array<[string, string, number]>) => list.map(([id, date, netDelta]) => ({ id, date, netDelta }))
ok('同日新增 10000 删除 5000 = 净增 5000', (() => {
  const r = aggregateRank(rowsOf([['u1', '2026-11-10', 10000], ['u1', '2026-11-10', -5000]]), { period: 'day', date: '2026-11-10' })
  return r.length === 1 && r[0].value === 5000
})())
ok('跨日负数在周里抵扣（周一 +10000 周二 −5000 = 周 5000）', (() => {
  const r = aggregateRank(rowsOf([['u1', '2026-11-09', 10000], ['u1', '2026-11-10', -5000]]), { period: 'week', date: '2026-11-10' })
  return r.length === 1 && r[0].value === 5000 && r[0].raw === 5000
})())
ok('单日净减不显示负名次值，但 raw 保留负数', (() => {
  const r = aggregateRank(rowsOf([['u1', '2026-11-10', -3000]]), { period: 'day', date: '2026-11-10' })
  return r.length === 1 && r[0].value === 0 && r[0].raw === -3000
})())
ok('多项目汇总到同一作者', (() => {
  const r = aggregateRank(rowsOf([
    ['u1', '2026-11-10', 3000], ['u1', '2026-11-10', 2000], ['u2', '2026-11-10', 4000],
  ]), { period: 'day', date: '2026-11-10' })
  return r[0].id === 'u1' && r[0].value === 5000 && r[1].id === 'u2' && r[1].value === 4000
})())
ok('周期外的行不计入', (() => {
  const r = aggregateRank(rowsOf([['u1', '2026-10-01', 9999], ['u1', '2026-11-10', 10]]), { period: 'day', date: '2026-11-10' })
  return r.length === 1 && r[0].value === 10
})())
ok('并列同名次且次序稳定', (() => {
  const a = aggregateRank(rowsOf([['u2', '2026-11-10', 500], ['u1', '2026-11-10', 500], ['u3', '2026-11-10', 900]]), { period: 'day', date: '2026-11-10' })
  return a[0].rank === 1 && a[1].rank === 2 && a[2].rank === 2 && a[1].id === 'u1' && a[2].id === 'u2'
})())

// ---- 上报幂等 ----
ok('旧 seq 上报被丢弃', (() => {
  const r = applyRankReport({ seq: 5, netDelta: 100 }, { seq: 4, netDelta: 100 })
  return r.accept === false
})())
ok('同 seq 同值视为幂等重复', applyRankReport({ seq: 5, netDelta: 100 }, { seq: 5, netDelta: 100 }).accept === true)
ok('同 seq 不同值拒绝覆盖', applyRankReport({ seq: 5, netDelta: 100 }, { seq: 5, netDelta: 200 }).accept === false)
ok('新 seq 覆盖', (() => {
  const r = applyRankReport({ seq: 5, netDelta: 100 }, { seq: 6, netDelta: 250 })
  return r.accept === true && r.row.netDelta === 250
})())

console.log(`communityRules: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1