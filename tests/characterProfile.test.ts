import assert from 'node:assert/strict'
import { TABS } from '../src/lib/schema'
import { resolveTemplateForTab } from '../src/lib/templates/resolve'
import { characterProfileFields, characterProfileFacts } from '../src/lib/world/characterProfile'
import type { EffectiveField } from '../src/lib/templates/types'

const tab = TABS.find(item => item.id === 'char-main')!
const template = resolveTemplateForTab(tab)
const identity = template.fields.find(field => field.sourceKey.endsWith('::身份定位'))!
assert.ok(identity)
let count = 0
const check = (name: string, run: () => void) => { run(); count++; console.log('PASS ' + name) }
const custom = (id: string, label: string): EffectiveField => ({ ...identity, id, sourceKey: id, label, source: 'custom' })
check('source keys survive renamed display labels and summaries never mutate data', () => {
  const renamed = { ...identity, label: '江湖身份' }
  const fields = characterProfileFields({ ...template, fields: [renamed] })
  const data = Object.freeze({ [identity.sourceKey]: '  守门人\n第二行  ', unrelated: '隐藏资料' })
  assert.deepEqual(characterProfileFacts(fields, data), [{ key: identity.sourceKey, label: '江湖身份', value: '  守门人\n第二行  ' }])
  assert.equal(fields.length, 1, 'identity/desc sharing a field must be deduplicated')
})
check('declared custom bindings override builtin meaning and preserve zero/false', () => {
  const zero = custom('cf_zero', '修行年数'), no = custom('cf_false', '所属组织')
  const tpl = { ...template, fields: [identity, zero, no] }
  const fields = characterProfileFields(tpl, { identity: [zero.id], realm: [no.id], desc: [] })
  assert.deepEqual(characterProfileFacts(fields, { [zero.id]: 0, [no.id]: false, [identity.sourceKey]: '不应替代' }).map(fact => fact.value), ['0', 'false'])
  assert.equal(characterProfileFacts(fields, { [zero.id]: '', [no.id]: null }).length, 0)
})
check('detail visibility is independent of AI read permission', () => {
  const privateField = { ...identity, permissions: { ...identity.permissions, aiRead: false } }
  assert.equal(characterProfileFields({ ...template, fields: [privateField] }).length, 1)
  const hidden = { ...privateField, permissions: { ...privateField.permissions, detail: false } }
  assert.equal(characterProfileFields({ ...template, fields: [hidden] }).length, 0)
})
check('hidden archived pending and unavailable declarations do not invent fallback facts', () => {
  const declared = { ...custom('cf_declared', '作者绑定'), permissions: { ...identity.permissions, detail: false } }
  for (const candidate of [declared, { ...declared, permissions: identity.permissions, archived: true }, { ...declared, permissions: identity.permissions, meaningStatus: 'pending' as const }]) {
    const fields = characterProfileFields({ ...template, fields: [identity, candidate] }, { identity: [declared.id], desc: [] })
    assert.equal(fields.length, 0)
  }
  assert.equal(characterProfileFields({ ...template, fields: [identity] }, { identity: ['missing'], desc: [] }).length, 0)
  assert.equal(characterProfileFields({ ...template, fields: [identity] }, {}, new Set([identity.sourceKey])).length, 0)
})
check('unknown tabs and unrelated template fields yield no artificial summary', () => {
  assert.equal(characterProfileFields({ ...template, tabId: 'unknown-custom-tab' }).length, 0)
  const field = custom('cf_unrelated', '作者笔记')
  assert.equal(characterProfileFields({ ...template, fields: [field] }).length, 0)
  assert.equal(characterProfileFacts([field], { [field.id]: { nested: 'not a display scalar' } }).length, 0)
})
console.log(`${count} character profile groups passed`)
