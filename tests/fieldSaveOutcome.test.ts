import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describeFieldSave, FIELD_SAVE_MISSING } from '../src/lib/settings/fieldSaveOutcome'
let count = 0
function test(name: string, run: () => void) { run(); count++; console.log('PASS ' + name) }
test('missing records explicitly fail rather than claiming submission', () => {
  assert.deepEqual(describeFieldSave({ written: false }), { ok: false, kind: 'missing', message: FIELD_SAVE_MISSING })
  assert.ok(!FIELD_SAVE_MISSING.includes('已保存'))
})
test('a confirmed interface receipt is successful without implying disk durability', () => {
  assert.deepEqual(describeFieldSave({ written: true }), { ok: true })
  assert.deepEqual(describeFieldSave({ written: true, error: null }), { ok: true })
})
test('native failure types remain understandable while private messages are omitted', () => {
  const error = new Error('C:\\private-library\\secret-book.json?token=private')
  error.name = 'QuotaExceededError'
  const outcome = describeFieldSave({ written: false, error })
  assert.equal(outcome.ok, false)
  if (outcome.ok) throw Error('unexpected success')
  assert.equal(outcome.kind, 'failed'); assert.ok(outcome.message.includes('QuotaExceededError'))
  assert.ok(outcome.message.includes('未确认保存')); assert.ok(!outcome.message.includes('private'))
})
test('arbitrary thrown values cannot leak payloads or execute a hostile stringifier', () => {
  for (const error of ['secret request body', { toString() { throw Error('must not run') } }, null, undefined]) {
    const outcome = describeFieldSave({ written: false, error })
    assert.equal(outcome.ok, false)
    if (!outcome.ok) { assert.equal(outcome.kind, 'failed'); assert.ok(!outcome.message.includes('secret')) }
  }
})
test('the real setting editor delegates storage and exposes field-level retry and stable targets', () => {
  const code = fs.readFileSync('src/components/settings/SettingSearch.tsx', 'utf8')
  assert.ok(code.includes('createIndexedFieldWriter'))
  assert.ok(code.includes('data-setting-doc={doc.key}') && code.includes('data-setting-field={f.dataKey}'))
  assert.ok(code.includes('重试提交') && code.includes('role="status"'))
  assert.ok(!code.includes('await db.saveCardRecord') && !code.includes('await db.saveTableRow'))
})
console.log(`${count} field-save outcome groups passed`)
