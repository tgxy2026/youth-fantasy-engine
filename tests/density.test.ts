import assert from 'node:assert/strict'
import { DENSITIES, DENSITY_CHANGED, DENSITY_PREF, applyDensity, getStoredDensity, installDensityPreferences, normalizeDensity } from '../src/lib/settings/density'
import { PREF_EVENT, clearEnumSession, readEnumPref, writeEnumPref } from '../src/lib/settings/uiPrefs'
import { reflowRowAnchor } from '../src/components/sheets/useRowWindow'

let assertions = 0
const check = (name: string, run: () => void) => { run(); assertions++; console.log('PASS ' + name) }
const globals = ['window', 'document', 'localStorage'] as const
const descriptors = globals.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const)
const values = new Map<string, string>()
const target = new EventTarget()
const dataset: Record<string, string> = { theme: 'sepia' }
let denied = false
let geometryChanges = 0
Object.defineProperty(globalThis, 'window', { configurable: true, value: target })
Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset } } })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem(key: string) { if (denied) throw new Error('storage denied'); return values.get(key) ?? null },
  setItem(key: string, value: string) { if (denied) throw new Error('storage denied'); values.set(key, value) },
} })
target.addEventListener(DENSITY_CHANGED, () => geometryChanges++)
let cleanup = () => {}
try {
  check('missing, corrupt and old density values fall back to compact', () => {
    for (const v of [null, undefined, false, 0, 'legacy', 'COMFORTABLE', {}, ['comfortable']]) assert.equal(normalizeDensity(v), 'compact')
    assert.equal(normalizeDensity('comfortable'), 'comfortable')
    assert.equal(getStoredDensity(), 'compact')
  })
  check('appearance changes geometry once and leaves theme/manuscript keys alone', () => {
    cleanup = installDensityPreferences()
    assert.equal(dataset.density, 'compact')
    assert.equal(geometryChanges, 1)
    applyDensity('compact')
    assert.equal(geometryChanges, 1)
    target.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { key: DENSITY_PREF, value: 'comfortable' } }))
    assert.equal(dataset.density, 'comfortable')
    assert.equal(geometryChanges, 2)
    assert.equal(dataset.theme, 'sepia')
    assert.deepEqual([...values.keys()], [])
  })
  check('unrelated preferences do not change density', () => {
    target.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { key: 'editor-indent-unit', value: 'compact' } }))
    assert.equal(dataset.density, 'comfortable')
  })
  check('denied persistence keeps the enum for the session and validates values', () => {
    denied = true
    assert.equal(writeEnumPref(DENSITY_PREF, 'comfortable', DENSITIES, 'compact'), 'comfortable')
    assert.equal(readEnumPref(DENSITY_PREF, DENSITIES, 'compact'), 'comfortable')
    assert.equal(getStoredDensity(), 'comfortable')
    writeEnumPref(DENSITY_PREF, 'invalid' as 'compact', DENSITIES, 'compact')
    assert.equal(getStoredDensity(), 'compact')
    clearEnumSession()
    assert.equal(getStoredDensity(), 'compact')
    denied = false
  })
  check('external storage update refreshes the real preference; cleanup unsubscribes', () => {
    values.set('yfe-ui:density', 'comfortable')
    const event = new Event('storage')
    Object.defineProperty(event, 'key', { value: 'yfe-ui:density' })
    target.dispatchEvent(event)
    assert.equal(dataset.density, 'comfortable')
    cleanup()
    target.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { key: DENSITY_PREF, value: 'compact' } }))
    assert.equal(dataset.density, 'comfortable')
  })
  check('row reflow preserves the same row and fractional offset', () => {
    const ids = ['a', 'b', 'c', 'd']
    const old = new Map(ids.map(id => [id, 40]))
    const next = new Map(ids.map(id => [id, 60]))
    assert.equal(reflowRowAnchor(ids, old, next, 90, 40), 135)
    assert.equal(reflowRowAnchor(ids, old, next, 80, 40), 120)
    assert.equal(reflowRowAnchor(ids, old, new Map([['c', 60]]), 90, 40), 135)
  })
  check('row reflow handles empty, invalid and stale measurements', () => {
    assert.equal(reflowRowAnchor([], new Map(), new Map(), 100, 40), 0)
    assert.equal(reflowRowAnchor(['a'], new Map([['a', -1]]), new Map([['a', NaN]]), NaN, 40), 0)
    assert.equal(reflowRowAnchor(['a'], new Map(), new Map(), -10, 40), 0)
    assert.equal(reflowRowAnchor(['a'], new Map(), new Map(), 100, 40), 40)
  })
} finally {
  cleanup()
  clearEnumSession()
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
}
console.log(`density: ${assertions}/${assertions} passed`)
