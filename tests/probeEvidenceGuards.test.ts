// 3.2.6 · 两个新证据校验器的「守门」测试
//
// 🔴 为什么要单独测校验器：校验器一旦被放宽（少一个场景也过、指纹不符也过），
//    对应契约就变成了「跑过即通过」的假绿。这里只用**构造的证据**测判定逻辑，
//    不去跑浏览器 —— 真跑一遍的活归统一验收（`reliability.mjs --profile local`）。
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateModelFailureEvidence, MODEL_FAILURE_CASES, MODEL_FAILURE_MIN_ASSERTS } from '../scripts/verify/model-failure-evidence.mjs'
import { validateLayoutEvidence } from '../scripts/verify/layout-evidence.mjs'
import { hashBuildDir } from '../scripts/verify/build-hash.mjs'

let passed = 0
function test(name: string, fn: () => Promise<void>) { return fn().then(() => { passed++; console.log('PASS ' + name) }) }

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-guard-'))
const buildDir = path.join(root, 'build')
await fs.mkdir(buildDir, { recursive: true })
await fs.writeFile(path.join(buildDir, 'index.html'), '<!doctype html><title>b</title>')
const buildHash = hashBuildDir(buildDir)
const FP = 'fp-current'

const modelFile = path.join(root, 'model', 'results.json')
await fs.mkdir(path.dirname(modelFile), { recursive: true })
for (const shot of ['01-refusal.png', '02-cancel.png', '03-timeout.png']) await fs.writeFile(path.join(path.dirname(modelFile), shot), 'x')
const modelEvidence = (over: Record<string, unknown> = {}) => ({
  kind: 'model-failure-evidence',
  sourceFingerprint: FP,
  buildHash,
  asserts: Array.from({ length: MODEL_FAILURE_MIN_ASSERTS }, (_, i) => ({ name: 'a' + i, ok: true })),
  passed: MODEL_FAILURE_MIN_ASSERTS,
  total: MODEL_FAILURE_MIN_ASSERTS,
  cases: MODEL_FAILURE_CASES.map(id => ({ id, ok: true })),
  observations: [{ id: 'timeout.user-message', visible: false, note: 'x' }],
  ...over,
})
const writeModel = async (over: Record<string, unknown> = {}) => {
  const body = modelEvidence(over)
  await fs.writeFile(modelFile, JSON.stringify(body))
  return body
}
const checkModel = () => validateModelFailureEvidence(root, modelFile, { expectedSourceFingerprint: FP, buildDir })

await test('model.failure：完整证据通过，断言数如实返回', async () => {
  await writeModel()
  const verified = await checkModel()
  assert.equal(verified.assertions, MODEL_FAILURE_MIN_ASSERTS)
})

await test('model.failure：源码指纹不符必须拒绝（否则是上一轮的结果）', async () => {
  await writeModel({ sourceFingerprint: 'fp-old' })
  await assert.rejects(checkModel, /源码不符/)
})

await test('model.failure：构建哈希不符必须拒绝', async () => {
  await writeModel({ buildHash: 'deadbeef' })
  await assert.rejects(checkModel, /别的构建/)
})

await test('model.failure：少一条断言、或有一条不过，都不能算过', async () => {
  await writeModel({ asserts: Array.from({ length: MODEL_FAILURE_MIN_ASSERTS - 1 }, () => ({ name: 'a', ok: true })), passed: MODEL_FAILURE_MIN_ASSERTS - 1 })
  await assert.rejects(checkModel, /少于下限/)
  const asserts = Array.from({ length: MODEL_FAILURE_MIN_ASSERTS }, () => ({ name: 'a', ok: true }))
  asserts[3].ok = false
  await writeModel({ asserts, passed: MODEL_FAILURE_MIN_ASSERTS - 1 })
  await assert.rejects(checkModel, /未通过的断言/)
})

await test('model.failure：拒答/取消/超时三条场景缺一不可', async () => {
  await writeModel({ cases: [{ id: 'refusal', ok: true }, { id: 'timeout', ok: true }] })
  await assert.rejects(checkModel, /cancel/)
})

await test('model.failure：缺少「超时提示」观测也必须拒绝', async () => {
  await writeModel({ observations: [] })
  await assert.rejects(checkModel, /观测/)
})

const layoutFile = path.join(root, 'layout.json')
const cases = (n: number, zoomCount = 4, issues = false) => Array.from({ length: n }, (_, i) => ({
  width: 1000, height: 640, zoom: [100, 125, 160, 200][i % zoomCount], id: 'tab' + (i % 55), issues: issues && i === 0 ? ['页面溢出 12px'] : [],
}))
const writeLayout = async (over: Record<string, unknown> = {}) => {
  await fs.writeFile(layoutFile, JSON.stringify({ sourceFingerprint: FP, stale: false, errors: [], cases: cases(120), ...over }))
}
const checkLayout = () => validateLayoutEvidence(root, layoutFile, { expectedSourceFingerprint: FP })

await test('layout.affected：无越界用例通过，断言数＝用例数', async () => {
  await writeLayout()
  const verified = await checkLayout()
  assert.equal(verified.assertions, 120)
})

await test('layout.affected：指纹不符 / stale / 页面异常都拒绝', async () => {
  await writeLayout({ sourceFingerprint: 'fp-old' })
  await assert.rejects(checkLayout, /源码不符/)
  await writeLayout({ stale: true })
  await assert.rejects(checkLayout, /stale/)
  await writeLayout({ errors: ['boom'] })
  await assert.rejects(checkLayout, /页面异常/)
})

await test('layout.affected：用例太少、缩放档不足 3 个都拒绝', async () => {
  await writeLayout({ cases: cases(50) })
  await assert.rejects(checkLayout, /少于下限/)
  await writeLayout({ cases: cases(120, 2) })
  await assert.rejects(checkLayout, /缩放档/)
})

await test('layout.affected：任何一条用例带 issues 即失败，并指出是哪条', async () => {
  await writeLayout({ cases: cases(120, 4, true) })
  await assert.rejects(checkLayout, /布局越界/)
})

await fs.rm(root, { recursive: true, force: true })
console.log(`probeEvidenceGuards：${passed} 通过 / 0 失败`)
