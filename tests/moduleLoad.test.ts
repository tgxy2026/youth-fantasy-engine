import assert from 'node:assert/strict'
import { isModuleLoadFailure, moduleLoadFailure, ModuleLoadError, MODULE_FAILURE_MESSAGE } from '../src/lib/app/moduleLoad'
import { summarizeFailure } from '../src/lib/app/failureSummary'

let assertions = 0
const check = (name: string, run: () => void) => { run(); assertions++; console.log('PASS ' + name) }

check('wrapped failures are recognised and keep their cause for local diagnosis', () => {
  const cause = new TypeError('Failed to fetch dynamically imported module: http://localhost:5199/assets/CheckTools-a1b2.js?t=42')
  const error = moduleLoadFailure(cause)
  assert.ok(error instanceof ModuleLoadError)
  assert.equal(error.message, MODULE_FAILURE_MESSAGE)
  assert.equal(error.cause, cause)
  assert.ok(isModuleLoadFailure(error))
})

check('wrapping is idempotent', () => {
  const once = moduleLoadFailure(new Error('boom'))
  assert.equal(moduleLoadFailure(once), once)
})

check('raw browser and bundler messages are classified as module failures', () => {
  const raw = [
    new TypeError('Failed to fetch dynamically imported module: /assets/x.js'),
    new Error('error loading dynamically imported module'),
    new TypeError('Importing a module script failed.'),
    new Error('Loading chunk 17 failed.'),
    Object.assign(new Error('nope'), { name: 'ChunkLoadError' }),
    new Error('Unable to preload CSS for /assets/x.css'),
  ]
  for (const error of raw) assert.ok(isModuleLoadFailure(error), error.message)
})

check('ordinary render errors and unrelated values stay outside this class', () => {
  const others: unknown[] = [
    new TypeError("Cannot read properties of undefined (reading 'map')"),
    new RangeError('Invalid array length'),
    new Error('Failed to fetch'), // 普通网络请求失败（AI/同步），不是分包加载
    'Failed to fetch dynamically imported module', // 抛字符串：判定只认对象，避免误伤文案
    null,
    undefined,
    42,
    {},
  ]
  for (const value of others) assert.equal(isModuleLoadFailure(value), false, String(value))
})

check('throwing accessors cannot break classification or the public summary', () => {
  const hostile = Object.defineProperty({}, 'message', { get() { throw new Error('denied') } })
  assert.equal(isModuleLoadFailure(hostile), false)
  const error = moduleLoadFailure(hostile)
  assert.ok(isModuleLoadFailure(error))
  const summary = summarizeFailure(error)
  assert.match(summary, /错误类型：Error/)
  assert.ok(!summary.includes('denied'))
})

check('public summary never carries the raw chunk address or build hash', () => {
  const error = moduleLoadFailure(new TypeError('Failed to fetch dynamically imported module: http://localhost:5199/assets/CheckTools-a1b2.js?token=secret'))
  const summary = summarizeFailure(error)
  for (const secret of ['CheckTools', 'a1b2', 'localhost', 'assets', 'token', 'secret', 'dynamically imported']) {
    assert.ok(!summary.includes(secret), secret)
  }
})

console.log(`\nmoduleLoad: ${assertions} assertions passed`)
