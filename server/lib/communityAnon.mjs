// Pure anonymous-handle allocation. Persistence and migration must be supplied
// by a caller that commits the mapping before exposing community content.
import { createHash, createHmac } from 'node:crypto'
import { periodRange, todayKeyCn } from './communityRules.mjs'
import beastNames from './communityBeastNames.json' with { type: 'json' }

export const BEAST_DICTIONARY_VERSION = 1
export const BEAST_DICTIONARY_SHA256 = '235c3233f241b437279773e4b55bb2cbc8a9d2397cc07844c27df60e71ceab96'
export const BEAST_NAMES = Object.freeze(beastNames)
if (BEAST_NAMES.length !== 1672 || createHash('sha256').update(BEAST_NAMES.join('\n') + '\n').digest('hex') !== BEAST_DICTIONARY_SHA256) throw new Error('匿名代号词表校验失败')

// 公开读取路径遇到坏时间/容量耗尽时必须是受控 503，而不是裸 500
function anonError(message) { const e = new Error(message); e.code = 'COMMUNITY_ANON_UNAVAILABLE'; return e }

export function validAnonymousWeek(week) {
  if (typeof week !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(week)) return false
  const date = new Date(`${week}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === week && periodRange('week', week)?.start === week
}
export function validAnonymousHandle(handle) {
  const match = typeof handle === 'string' ? /^(.*?)(?:-([0-9]{2,}))?$/.exec(handle) : null
  return !!match && BEAST_NAMES.includes(match[1]) && (!match[2] || (Number.isSafeInteger(Number(match[2])) && Number(match[2]) >= 2))
}

export function anonymousWeekKey(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw anonError('内容创建时间无效')
  const range = periodRange('week', todayKeyCn(timestamp))
  if (!range) throw anonError('无法计算代号所属周')
  return range.start
}

export function anonymousRankWeeks(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw anonError('排行日期无效')
  const parsed = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw anonError('排行日期无效')
  const week = periodRange('week', date)
  const month = periodRange('month', date)
  if (!week || !month) throw anonError('排行日期无效')
  return [...new Set([week.start, periodRange('week', month.start).start])]
}

function assertAllocationInputs(uid, weekKey, secret, names) {
  if (!uid || typeof uid !== 'string' || !validAnonymousWeek(weekKey)) throw anonError('代号分配参数无效')
  if (!Buffer.isBuffer(secret) || secret.length < 32) throw anonError('代号密钥不可用')
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length) throw anonError('代号词表不可用')
}

function pickHandle(week, uid, weekKey, secret, names, occupied) {
  const digest = createHmac('sha256', secret).update(JSON.stringify([weekKey, uid])).digest()
  const name = names[digest.readUInt32BE(0) % names.length]
  let handle = name
  for (let i = 2; occupied.has(handle); i++) {
    if (i > 50000) throw anonError('本周代号容量已满')
    handle = `${name}-${String(i).padStart(2, '0')}`
  }
  week[uid] = handle
  occupied.add(handle)
  return handle
}

// map: { [weekKey]: { [uid]: handle } }. Callers own durable storage.
// Clone before use so a rejected/failed write cannot mutate cached state.
export function allocateAnonymousHandle(map, uid, weekKey, secret, names = BEAST_NAMES) {
  assertAllocationInputs(uid, weekKey, secret, names)
  const next = structuredClone(map || {})
  const week = next[weekKey] || (next[weekKey] = {})
  if (Object.hasOwn(week, uid)) return { mapping: next, handle: week[uid], created: false }
  const occupied = new Set(Object.values(week))
  const handle = pickHandle(week, uid, weekKey, secret, names, occupied)
  return { mapping: next, handle, created: true }
}

// 停写迁移用的批量分配：映射与占用表只构建一次，逐对 O(1) 追加，避免逐条 structuredClone 的二次方开销。
// pairs: Array<[weekKey, uid]>（调用方保证排序与去重）；existing 为已校验的既有映射。
// 返回 { mapping, created: Array<{uid, week, handle}> }；已存在的 (week, uid) 幂等跳过。
export function allocateAnonymousHandlesBatch(existing, pairs, secret, names = BEAST_NAMES) {
  if (!Buffer.isBuffer(secret) || secret.length < 32) throw anonError('代号密钥不可用')
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length) throw anonError('代号词表不可用')
  const mapping = structuredClone(existing || {})
  const occupied = new Map()
  for (const [weekKey, week] of Object.entries(mapping)) {
    if (!validAnonymousWeek(weekKey)) throw anonError('已有匿名代号周标识无效')
    const set = new Set()
    for (const handle of Object.values(week)) {
      if (!validAnonymousHandle(handle) || set.has(handle)) throw anonError('已有匿名代号冲突')
      set.add(handle)
    }
    occupied.set(weekKey, set)
  }
  const created = []
  for (const [weekKey, uid] of pairs) {
    if (!uid || typeof uid !== 'string' || !validAnonymousWeek(weekKey)) throw anonError('代号分配参数无效')
    const week = mapping[weekKey] || (mapping[weekKey] = {})
    if (Object.hasOwn(week, uid)) continue
    let set = occupied.get(weekKey)
    if (!set) { set = new Set(); occupied.set(weekKey, set) }
    const handle = pickHandle(week, uid, weekKey, secret, names, set)
    created.push({ uid, week: weekKey, handle })
  }
  return { mapping, created }
}
