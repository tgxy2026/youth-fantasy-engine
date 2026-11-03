/**
 * 示范项目种子数据 ↔ schema 对账检查
 * 运行：node tests/seed-schema-check.mjs
 *
 * 为什么需要它：
 * OutlineSheet / TableSheet 是按 schema 的「模块名::字段名」「列名」去 data 里取值的。
 * 种子数据里键名写错**不会报错**，只会在界面上静默显示空白——肉眼极难发现。
 * 本检查把 seedData.ts 里所有卡片键与表格列名逐一对账 schema，把这类哑 bug 挡在提交前。
 *
 * 真实案例：第二卷《秘境争锋》分卷大纲曾误用「三、本卷主线 / 四、伏笔与回收」
 * （schema 中并不存在这两个模块名），导致事件链、伏笔管理、角色变化三组字段全部空白。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 把 schema.ts 单独打包出来（./db 打桩，避免拉进 IndexedDB 等重依赖）
const stubDb = {
  name: 'stub-db',
  setup(build) {
    build.onResolve({ filter: /\.\/db$/ }, () => ({ path: 'db', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export function getAllVolumes(){return Promise.resolve([])}',
      loader: 'js',
    }))
  },
}

const tmp = path.join(os.tmpdir(), `yfe-schema-${Date.now()}.mjs`)
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'lib', 'schema.ts')],
  bundle: true, format: 'esm', outfile: tmp, platform: 'node', plugins: [stubDb], logLevel: 'silent',
})
const { TABS } = await import(pathToFileURL(tmp).href)
fs.rmSync(tmp, { force: true })

const schemaTabs = {}
for (const t of TABS) {
  schemaTabs[t.id] = {
    modules: (t.modules || []).map(m => ({ name: m.name, fields: m.fields.map(f => f.name) })),
    columns: (t.columns || []).map(c => c.name),
  }
}

const src = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'app', 'seedData.ts'), 'utf8')
const errors = []
const warns = []
let checked = 0

// ---- A) 卡片型：校验 '模块名::字段名' ----
for (const chunk of src.split('await db.saveCardRecord({').slice(1)) {
  const mTab = chunk.match(/tabId:\s*'([a-z-]+)'/)
  if (!mTab) continue
  const tabId = mTab[1]
  const def = schemaTabs[tabId]
  if (!def) { errors.push(`未知页签(卡片): ${tabId}`); continue }
  if (!def.modules.length) continue
  const valid = new Set()
  def.modules.forEach(mo => mo.fields.forEach(f => valid.add(`${mo.name}::${f}`)))
  const end = chunk.indexOf('\n  })')
  const body = end >= 0 ? chunk.slice(0, end) : chunk
  const keys = [...body.matchAll(/'([^']+)'\s*:/g)].map(x => x[1]).filter(k => k.includes('::'))
  for (const k of new Set(keys)) {
    checked++
    if (!valid.has(k)) errors.push(`[${tabId}] 无效卡片键「${k}」——界面上会显示为空白`)
  }
  const missing = [...valid].filter(v => !keys.includes(v))
  if (missing.length) warns.push(`[${tabId}] 未填字段 ${missing.length} 个: ${missing.slice(0, 4).join(' / ')}${missing.length > 4 ? ' …' : ''}`)
}

// ---- B) 表格型：校验列名（「上级」为通用树形列，各表可能未在 columns 声明）----
const EXTRA_OK = new Set(['上级'])
for (const line of src.split('\n')) {
  const m = line.match(/^\s*\['([a-z-]+)',\s*\{(.*)\}\],?\s*$/)
  if (!m) continue
  const [, tabId, body] = m
  const def = schemaTabs[tabId]
  if (!def) { errors.push(`未知页签(表格): ${tabId}`); continue }
  if (!def.columns.length) continue
  const valid = new Set(def.columns)
  for (const k of [...body.matchAll(/'([^']+)'\s*:/g)].map(x => x[1])) {
    checked++
    if (!valid.has(k) && !EXTRA_OK.has(k)) errors.push(`[${tabId}] 无效列名「${k}」`)
  }
}

for (const w of warns) console.log('· ' + w)
if (warns.length) console.log('---')
if (errors.length) {
  for (const e of errors) console.error('✗ ' + e)
  console.error(`\n❌ ${errors.length} 处问题（校验 ${checked} 个键）`)
  process.exit(1)
}
console.log(`✅ 种子数据与 schema 完全一致（校验 ${checked} 个键${warns.length ? `，${warns.length} 条未填提示` : ''}）`)
