// UX09 · AI 整理「0 条」的成因分类（organizeEmptyKind / organizeEmptyMessage）
//
// 旧实现把所有「0 条」压成一句话：「要么已经登记过，要么这段文本里没有可抽取的信息」——
// 其中「模型返回解析不出来」被算进了「文本里没东西」，等于替模型背书。
// 这里锁住：五种成因必须可区分，且文案不许把「没读懂」说成「没问题」。
import assert from 'node:assert/strict'
import { organizeEmptyKind, organizeEmptyMessage, type OrganizeResult } from '../src/lib/aiTasks/organize'

let assertions = 0
const check = (name: string, run: () => void) => { run(); assertions++; console.log('PASS ' + name) }

const mk = (patch: Partial<OrganizeResult>): OrganizeResult => ({
  rows: [], rawCount: 0, dupSkipped: 0, invalidSkipped: 0, parseOutcome: 'valid', parseNotes: [], ...patch,
})

check('有条目 ⇒ 不判空（null）', () => {
  assert.equal(organizeEmptyKind(mk({ rows: [{ 人物A: '甲' }] })), null)
})

check('🔴 解析不出来 ⇒ parse-failed（不是「没有可整理内容」）', () => {
  assert.equal(organizeEmptyKind(mk({ parseOutcome: 'invalid' })), 'parse-failed')
  // 即使 rawCount 为 0、也没有去重/缺列，也不能落进 nothing-found
  assert.notEqual(organizeEmptyKind(mk({ parseOutcome: 'invalid' })), 'nothing-found')
})

check('🔴 元素被丢光（repaired 且 0 条）⇒ repaired-empty', () => {
  assert.equal(organizeEmptyKind(mk({ parseOutcome: 'repaired', rawCount: 0 })), 'repaired-empty')
})

check('模型明确返回空数组（valid + 0 条）⇒ nothing-found', () => {
  assert.equal(organizeEmptyKind(mk({ parseOutcome: 'valid', rawCount: 0 })), 'nothing-found')
})

check('有条目但与已有重复 ⇒ all-duplicate', () => {
  assert.equal(organizeEmptyKind(mk({ parseOutcome: 'valid', rawCount: 3, dupSkipped: 3 })), 'all-duplicate')
})

check('有条目但都缺关键列 ⇒ all-invalid', () => {
  assert.equal(organizeEmptyKind(mk({ parseOutcome: 'valid', rawCount: 2, invalidSkipped: 2 })), 'all-invalid')
})

check('去重与缺列都有 ⇒ 不算纯 all-duplicate（不能只说「都登记过」）', () => {
  assert.equal(organizeEmptyKind(mk({ parseOutcome: 'valid', rawCount: 4, dupSkipped: 2, invalidSkipped: 2 })), 'all-invalid')
})

check('🔴 解析失败的文案必须点明「不是没有可整理的内容」并建议重试', () => {
  const text = organizeEmptyMessage('parse-failed')
  assert.match(text, /没能从模型返回里解析出条目/)
  assert.match(text, /不是「没有可整理的内容」/)
  assert.match(text, /重试/)
  assert.ok(!text.includes('没有可抽取的信息'))
})

check('🔴 repaired-empty 不许声称「已经登记过」', () => {
  const text = organizeEmptyMessage('repaired-empty')
  assert.ok(!text.includes('全部登记过'))
  assert.match(text, /没有一条能用/)
})

check('只有 nothing-found 才允许说「没有可抽取的新信息」', () => {
  assert.match(organizeEmptyMessage('nothing-found'), /没有可抽取的新信息/)
  for (const kind of ['parse-failed', 'repaired-empty', 'all-duplicate', 'all-invalid'] as const) {
    assert.ok(!organizeEmptyMessage(kind).includes('没有可抽取的新信息'), kind)
  }
})

check('每类成因都有独立可读文案（互不重复）', () => {
  const kinds = ['parse-failed', 'repaired-empty', 'nothing-found', 'all-duplicate', 'all-invalid'] as const
  const texts = kinds.map(kind => organizeEmptyMessage(kind))
  assert.equal(new Set(texts).size, kinds.length)
  for (const text of texts) assert.ok(text.trim().length >= 12, text)
})

console.log(`\norganizeEmpty: ${assertions} assertions passed`)
