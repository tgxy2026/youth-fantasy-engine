import assert from 'node:assert/strict'
import { summarizeFailure } from '../src/lib/app/failureSummary'

let assertions = 0
const check = (name: string, run: () => void) => { run(); assertions++; console.log('PASS ' + name) }
check('public summary keeps type and basename without message or private path', () => {
  const error = new TypeError('稿件原文 api_key=secret-value')
  error.stack = 'TypeError: 稿件原文 api_key=secret-value\n at render (C:\\Users\\private-user\\workspace\\Dashboard.tsx:42:6)\n at http://localhost:5199/src/App.tsx?token=secret-value:18:2'
  const summary = summarizeFailure(error)
  assert.match(summary, /TypeError/)
  assert.match(summary, /Dashboard\.tsx:42:6/)
  assert.match(summary, /App\.tsx/)
  for (const privateValue of ['稿件原文', 'api_key', 'secret-value', 'private-user', 'localhost', 'workspace', 'token=']) assert.ok(!summary.includes(privateValue))
})
check('untrusted error names and primitive thrown values cannot disclose payload', () => {
  for (const error of ['private manuscript', { name: 'secret-token', message: 'private manuscript' }, null, undefined]) {
    const summary = summarizeFailure(error)
    assert.match(summary, /错误类型：Error/)
    assert.ok(!summary.includes('secret-token') && !summary.includes('private manuscript'))
  }
})
check('throwing accessors cannot crash the fallback page', () => {
  const error = Object.defineProperty({}, 'name', { get() { throw new Error('access denied') } })
  assert.match(summarizeFailure(error), /文件位置：未取得/)
})
check('frames are deduplicated and bounded', () => {
  const lines = Array.from({ length: 30 }, (_, i) => ` at /private/path/Chunk${Math.floor(i / 2)}.mjs:42:1`)
  const summary = summarizeFailure({ name: 'RangeError', stack: ['private payload', ...lines].join('\n') })
  assert.equal(summary.split('\n').filter(line => line.startsWith('  ')).length, 8)
  assert.equal(summary.split('Chunk0.mjs').length - 1, 1)
  assert.ok(!summary.includes('private'))
})
console.log(`${assertions} failure summary groups passed`)
