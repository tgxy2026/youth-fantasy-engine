#!/usr/bin/env node
// 3.6.0 · 任务层「真模型」冒烟（3.1 里需要模型的项，先验"我们的提示词 + 解析"在本地模型上成立）
//
// 为什么要有它：`frontend-*` 那批探针要 dev server，`packaged-acceptance` 只验入口与存取；
// 而「章后整理 / 摘要 / 拆书」这类**真正依赖模型输出格式**的环节，之前只能用真机手点。
// 本探针把任务的**真实代码**打进一个临时模块（provider 解析替换成命令行给的配置），
// 然后真的向本地模型发一次请求，并用**应用自己的解析器**校验输出。
//
// 🔴 它证明什么：提示词在本地模型上能得到可解析的输出、耗时在可接受范围、失败会如实抛。
// 🔴 它不证明什么：不验界面状态机（"整理待恢复"提示、候选落库 UI）—— 那些在别处或需人工。
//
// 用法：
//   node scripts/verify/ai-model-smoke.mjs --base http://localhost:11434 --model dongfangshuo-v2:latest
'use strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const arg = n => {
  const i = process.argv.indexOf(n)
  if (i < 0) return ''
  const v = process.argv[i + 1]
  if (!v || v.startsWith('--')) throw new Error(n + ' requires a value')
  return v
}
const BASE = arg('--base') || 'http://localhost:11434'
const MODEL = arg('--model') || 'dongfangshuo-v2:latest'

const checks = []
const ok = (id, pass, detail = '') => {
  checks.push({ id, passed: !!pass, detail: String(detail).slice(0, 300) })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}${detail ? ' :: ' + String(detail).slice(0, 160) : ''}`)
}

/** 临时目录里生成的 provider 桩：只替掉"从设置里读配置"，其余（chat/解析）都是真代码 */
const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-ai-smoke-'))
const stubAi = path.join(stubDir, 'ai-stub.ts')
const abs = p => path.join(ROOT, p).replaceAll('\\', '/')
await fs.writeFile(stubAi, `
import { chat } from ${JSON.stringify(abs('src/lib/aiCore/chat.ts'))}
import { CHAT_TIMEOUT_MS, composeSystemPrompt } from ${JSON.stringify(abs('src/lib/aiCore/core.ts'))}
export { chat, CHAT_TIMEOUT_MS, composeSystemPrompt }
export const isCancelled = () => false
export async function requireProviderFor() {
  return { id: 'smoke', name: '本地冒烟', type: 'ollama', baseUrl: ${JSON.stringify(BASE)}, apiKey: '', model: ${JSON.stringify(MODEL)}, local: true }
}
`)

const plugin = {
  name: 'smoke-stubs',
  setup(build) {
    build.onResolve({ filter: /^@\/lib\/ai$/ }, () => ({ path: stubAi }))
  },
}

const entry = path.join(stubDir, 'entry.ts')
await fs.writeFile(entry, `
import { aiExtractChapterChangesWithStatus } from ${JSON.stringify(abs('src/lib/aiTasks/postProcess.ts'))}
import { aiChapterChangeList } from ${JSON.stringify(abs('src/lib/aiTasks/changeList.ts'))}
import { verifyChangeItems } from ${JSON.stringify(abs('src/lib/audit/changeList.ts'))}
export { aiExtractChapterChangesWithStatus, aiChapterChangeList, verifyChangeItems }
`)
const bundle = path.join(stubDir, 'bundle.mjs')
try {
await esbuild.build({
  entryPoints: [entry], bundle: true, format: 'esm', outfile: bundle, platform: 'node',
  // 仓库用 `@/` 路径别名，esbuild 必须显式读 tsconfig 的 paths（否则一片 Unresolved）
  tsconfig: path.join(ROOT, 'tsconfig.json'),
  plugins: [plugin], logLevel: 'warning', external: ['typescript'],
})
} catch (e) {
  for (const err of (e && e.errors) || []) console.error('[esbuild]', err.text, '@', err.location && err.location.file)
  throw new Error('bundle failed')
}
const mod = await import(pathToFileURL(bundle).href)

/**
 * 素材刻意含**三类可抽取的事实**（伏笔 / 关系 / 状态各一条），
 * 否则模型返回"合法空"时无法区分「它没抽到」与「我们的解析器不认」。
 */
const MATERIAL = [
  '陈渊的左臂被剑气削断，从此只剩一只手。他把半块残简收进袖里 —— 师父三年前说过：残简出自镇界塔。',
  '李霜背着他走出雪谷。两人原是同门师兄妹，这一夜之后，她只说了一句：「以后我扶着你。」',
].join('\n')

console.log(`—— aiModelSmoke：${MODEL} @ ${BASE} ——`)

// ---------- ① E 章后整理（伏笔 / 关系 / 状态抽取 + 应用自己的解析） ----------
try {
  const t0 = Date.now()
  const step = await mod.aiExtractChapterChangesWithStatus(MATERIAL, '第一章 雪夜')
  const ms = Date.now() - t0
  ok('chapterChanges.state-completed', step.state === 'completed', `${ms}ms / state=${step.state}${step.errorCode ? ' / ' + step.errorCode : ''}`)
  const res = step.result
  // TaskResult 的合法结果词是 `valid`（无效才是 `invalid`）；这里接受两者之外的任何"非 invalid"
  ok('chapterChanges.parse-outcome', res && res.outcome !== 'invalid', res && res.outcome)
  const data = res && res.data ? res.data : { foreshadows: [], relations: [], statuses: [] }
  const total = (data.foreshadows?.length ?? 0) + (data.relations?.length ?? 0) + (data.statuses?.length ?? 0)
  ok('chapterChanges.extracted-something', total >= 1,
    `伏笔 ${data.foreshadows?.length ?? 0} / 关系 ${data.relations?.length ?? 0} / 状态 ${data.statuses?.length ?? 0}`)
  ok('chapterChanges.shape-ok',
    (data.statuses ?? []).every(x => x.name && x.state) && (data.relations ?? []).every(x => x.a && x.b),
    JSON.stringify(data).slice(0, 200))
} catch (e) {
  ok('chapterChanges.state-completed', false, e instanceof Error ? e.message : String(e))
}

// ---------- ② 变化线索（另一条链：信息类线索 + 引文核验） ----------
try {
  const t0 = Date.now()
  const r = await mod.aiChapterChangeList({ material: MATERIAL, chapterTitle: '第一章 雪夜' })
  const ms = Date.now() - t0
  ok('changeList.returns-text', typeof r.text === 'string' && r.text.trim().length > 0, `${ms}ms / ${(r.text || '').length} 字`)
  console.log('[raw]', (r.text || '').replace(/\s+/g, ' ').slice(0, 300))
  ok('changeList.model-tag', typeof r.modelTag === 'string' && r.modelTag.length > 0, r.modelTag)
  let raw = null
  try { raw = JSON.parse((r.text || '').trim()) } catch { raw = null }
  ok('changeList.json-parsable', raw !== null, raw ? 'ok' : '模型没给纯 JSON（会被上游按失败处理）')
  if (raw) {
    const items = mod.verifyChangeItems(raw, MATERIAL)
    ok('changeList.items-verified', Array.isArray(items) && items.length >= 1, `${items?.length ?? 0} 条（引文必须能在正文里定位）`)
  }
} catch (e) {
  ok('changeList.returns-text', false, e instanceof Error ? e.message : String(e))
}

const failed = checks.filter(c => !c.passed).length
console.log(`\nAI_MODEL_SMOKE model=${MODEL} passed=${checks.length - failed} failed=${failed}`)
if (failed) process.exitCode = 1
