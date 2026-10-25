import assert from 'node:assert/strict'
import { TABS } from '../src/lib/schema'
import { atlasColumnsOf } from '../src/lib/atlas/columns'
import { parseMultiSelectValues } from '../src/lib/atlas/values'
import { FIXTURE_NAMES, generateTableFixture, hash } from '../scripts/verify/fixtures/table-fixtures.mjs'
import { summarize, validateSamples, comparisonKey, compareBaseline, SAMPLE_PLAN, MEASUREMENT_VERSION } from '../scripts/verify/table-metrics.mjs'

let passed = 0
function test(name: string, fn: () => void) { fn(); passed++; console.log('PASS ' + name) }
const schema = { tab: TABS.find(t => t.id === 'races')!, columnsOf: atlasColumnsOf }
test('固定七类样本与seed，拒绝未知夹具', () => {
  assert.equal(FIXTURE_NAMES.length, 7)
  const a = generateTableFixture(schema, 'medium'), b = generateTableFixture(schema, 'medium')
  assert.deepEqual(a, b)
  assert.notEqual(a.manifest.sha256, generateTableFixture(schema, 'medium', 324).manifest.sha256)
  assert.throws(() => generateTableFixture(schema, 'bogus'))
  assert.throws(() => generateTableFixture(schema, 'small', NaN))
})
test('规模、列定义由当前schema和resolver取得，内容哈希可独立复核', () => {
  for (const [name, rows, customs] of [['small', 30, 0], ['medium', 300, 60], ['large', 1000, 60]] as const) {
    const fixture = generateTableFixture(schema, name)
    assert.equal(fixture.stores.tableRows.length, rows)
    assert.equal(fixture.manifest.customFields, customs)
    assert.deepEqual(fixture.columns.map(c => c.key), atlasColumnsOf(schema.tab, fixture.stores.settingsKV[0].value).map(c => c.name))
    const { manifest, ...content } = fixture
    assert.equal(hash(content), manifest.sha256)
    assert.equal(Buffer.byteLength(JSON.stringify(content)), manifest.bytes)
  }
})
test('树形固定四层，parent必须同项目、前序且没有循环', () => {
  const fixture = generateTableFixture(schema, 'tree'), rows = fixture.stores.tableRows
  assert.deepEqual(rows.slice(0, 5).map(r => r.data['上级']), ['', rows[0].data['名称'], rows[1].data['名称'], rows[2].data['名称'], ''])
  for (let i = 0; i < rows.length; i++) {
    assert.equal(fixture.expected.parents[rows[i].id], i % 4 === 0 ? null : rows[i - 1].id)
  }
})
test('mixed覆盖六种真实自定义类型、JSON多选和日期文本', () => {
  const f = generateTableFixture(schema, 'mixed'), r = f.stores.tableRows[0]
  assert.equal(new Set(f.stores.settingsKV[0].value.fields.map(x => x.type)).size, 6)
  assert.deepEqual(parseMultiSelectValues(r.data.cf_perf_4), ['甲', '乙'])
  assert.equal(r.data.cf_perf_5, 'false')
  assert.match(r.data['备注'], /^2026-10-01\n/)
})
test('项目A/B共享tabId但id/名称/配置作用域完全隔离', () => {
  const f = generateTableFixture(schema, 'project-switch')
  assert.equal(f.stores.projects.length, 2); assert.equal(f.manifest.rows, 600)
  assert.equal(new Set(f.stores.tableRows.map(r => r.id)).size, 600)
  assert.equal(new Set(f.stores.tableRows.map(r => r.tabId)).size, 1)
  assert.notEqual(f.stores.settingsKV[0].key, f.stores.settingsKV[1].key)
  assert.notEqual(f.stores.tableRows[0].data['名称'], f.stores.tableRows[300].data['名称'])
})
test('longbook确有500章/百万字符/200个实际载荷', () => {
  const f = generateTableFixture(schema, 'longbook')
  assert.equal(f.stores.chapters.length, 500); assert.equal(f.expected.chapterChars, 1000000)
  assert.equal(f.stores.revisionPayloads.length, 200)
  for (const p of f.stores.revisionPayloads) assert.equal(p.bytes, Buffer.byteLength(JSON.stringify(p.report)))
})
test('独立小例子的顺序/筛选答案，不复用产品排序筛选实现', () => {
  const f = generateTableFixture(schema, 'small')
  assert.equal(f.expected.order[0], 'perf-small-323-A-row-0')
  assert.equal(f.expected.order[29], 'perf-small-323-A-row-29')
  assert.deepEqual(f.expected.filter.ids, ['perf-small-323-A-row-0'])
})
test('nearest-rank统计保留原始顺序，拒绝低样本/异常数字', () => {
  const a = [50, 10, 40, 20, 30]
  assert.deepEqual(summarize(a, 5), { count: 5, p50: 30, p95: 50, worst: 50 })
  assert.deepEqual(a, [50, 10, 40, 20, 30])
  assert.throws(() => summarize([], 1)); assert.throws(() => summarize([NaN])); assert.throws(() => summarize([-1]))
  assert.throws(() => validateSamples({ open: [1], input: [1], save: [1] }))
  // 新增指标（筛选/清筛选/滚动）同样要够样本，缺一就拒绝
  const full = { open: Array(5).fill(1), input: Array(30).fill(1), save: Array(SAMPLE_PLAN.save).fill(1), filter: Array(SAMPLE_PLAN.filter).fill(1), clear: Array(SAMPLE_PLAN.clear).fill(1), scroll: Array(SAMPLE_PLAN.scroll).fill(1) }
  assert.doesNotThrow(() => validateSamples(full))
  assert.throws(() => validateSamples({ ...full, scroll: Array(SAMPLE_PLAN.scroll - 1).fill(1) }))
})
test('基线比较拒绝环境/夹具/工具漂移、smoke冒充以及篡改原始样本', () => {
  const metricsSamples = { open: Array(5).fill(10) as number[], input: Array(30).fill(20) as number[], save: Array(SAMPLE_PLAN.save).fill(30) as number[],
    filter: Array(SAMPLE_PLAN.filter).fill(40) as number[], clear: Array(SAMPLE_PLAN.clear).fill(45) as number[], scroll: Array(SAMPLE_PLAN.scroll).fill(16) as number[] }
  const current = { measurementVersion: MEASUREMENT_VERSION, measurementHash: 'tool-v1', environmentHash: 'machine', fixtureHash: 'fixture', backend: 'web-guest', samplePlan: SAMPLE_PLAN, thresholds: {}, metricsSamples }
  const body = { ...current, baselineId: comparisonKey(current), mode: 'measure', status: 'baseline-recorded', checks: [{ name: 'readback', ok: true }] }
  const baseline = { ...body, integrityHash: hash(body) }
  assert.ok(compareBaseline(current, baseline))
  // 3.2.3 · 计量 v6：相对退化闸 —— 与基线同速时不得报退化
  assert.deepEqual(compareBaseline(current, baseline).regressions, [])
  // 同一份代码抖动 +3ms（save 30→33）落在噪声地板（max(5ms, 20%)=6ms）内，不判退
  const noisy = { ...current, metricsSamples: { ...metricsSamples, save: Array(SAMPLE_PLAN.save).fill(33) } }
  assert.deepEqual(compareBaseline(noisy, baseline).regressions, [])
  // open 10→40ms（+300%）远未触及任何绝对阈值，但**必须**被判为退化
  const slow = { ...current, metricsSamples: { ...metricsSamples, open: Array(5).fill(40) } }
  const flagged = compareBaseline(slow, baseline)
  assert.equal(flagged.regressions.length, 2)
  assert.ok(flagged.regressions.every(r => r.key === 'open' && r.baselineMs === 10 && r.currentMs === 40))
  assert.equal(flagged.changes.open.p50Relative, 3)
  // 3.2.3 · v9：P95 的「绝对毫秒抖动」不算退化 —— input 20→29.8ms（+9.7ms）在 15ms 地板内
  const jitter = { ...current, metricsSamples: { ...metricsSamples, input: [...Array(29).fill(20), 29.8] } }
  assert.deepEqual(compareBaseline(jitter, baseline).regressions, [])
  // 但真的慢了必须报：input 20→45ms（+25ms，超 15ms 地板与 30% 比例）
  const slower = { ...current, metricsSamples: { ...metricsSamples, input: Array(30).fill(45) } }
  assert.ok(compareBaseline(slower, baseline).regressions.some(r => r.key === 'input'))
  for (const key of ['measurementHash', 'environmentHash', 'fixtureHash', 'backend']) assert.throws(() => compareBaseline({ ...current, [key]: 'changed' }, baseline))
  assert.throws(() => compareBaseline(current, { ...baseline, mode: 'smoke' }))
  assert.throws(() => compareBaseline(current, { ...baseline, metricsSamples: { ...metricsSamples, save: [1] } }))
  assert.throws(() => compareBaseline(current, { ...baseline, metricsSamples: { ...metricsSamples, filter: [] } }))
})
console.log(`tablePerformance：${passed} 通过 / 0 失败`)
