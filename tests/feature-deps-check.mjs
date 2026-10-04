/**
 * 自定义项目 · 功能依赖关系回归检查
 * 运行：node tests/feature-deps-check.mjs
 *
 * 为什么需要它：
 * FEATURE_TIER / STRONG_DEPS / ANY_DEPS 这三张表全是**字符串 id 的弱引用**——
 * 把 'char-main' 写成 'char-mainn'、或漏掉一条互绑声明，**不会报任何错**，
 * 只会让"依赖联动"静默失效（用户勾了剧情推演却什么都没带出来），肉眼极难发现。
 * 本检查把三类问题挡在提交前：① id 不存在；② 互绑不对称；③ 闭包结果不符预期。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// schema.ts 会 import './db'（拉进 IndexedDB 等重依赖）→ 打桩绕开
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

const tmp = path.join(os.tmpdir(), `yfe-featdeps-${Date.now()}.mjs`)
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'lib', 'schema.ts')],
  bundle: true, format: 'esm', outfile: tmp, platform: 'node', plugins: [stubDb], logLevel: 'silent',
})
const S = await import(pathToFileURL(tmp).href)
fs.rmSync(tmp, { force: true })

const { TABS, EDITOR_ID, LOCKED_IDS, DEFAULT_IDS, FEATURE_TIER, STRONG_DEPS, ANY_DEPS, resolveFeatures, forcedByDeps, tabVisible } = S

const errors = []
const checks = []
let passed = 0
function ok(label, cond, detail = '') {
  checks.push({ label, cond, detail })
  if (cond) passed++
  else errors.push(label + (detail ? ' → ' + detail : ''))
}

const KNOWN = new Set([...TABS.map(t => t.id), EDITOR_ID])
const R = (arr) => new Set(resolveFeatures(new Set(arr)))

// ── 1) 所有 id 必须真实存在（防手滑写错，静默失效） ──
for (const [id, deps] of Object.entries(STRONG_DEPS)) {
  if (!KNOWN.has(id)) errors.push(`STRONG_DEPS 的 key「${id}」不是任何页签 / 编辑器 id`)
  for (const d of deps) if (!KNOWN.has(d)) errors.push(`STRONG_DEPS['${id}'] 依赖的「${d}」不存在`)
}
for (const [id, deps] of Object.entries(ANY_DEPS)) {
  if (!KNOWN.has(id)) errors.push(`ANY_DEPS 的 key「${id}」不是任何页签 id`)
  for (const d of deps) if (!KNOWN.has(d)) errors.push(`ANY_DEPS['${id}'] 候选「${d}」不存在`)
}
ok('依赖表里的 id 全部真实存在', errors.length === 0)

// ── 2) 酒馆模式不得出现在默认勾选里 ──
ok('DEFAULT_IDS 不含酒馆项', !DEFAULT_IDS.some(id => id.startsWith('tavern-')), 'DEFAULT_IDS=' + DEFAULT_IDS.join(','))
ok('酒馆各项档位为 optional', Object.entries(FEATURE_TIER).every(([id, tier]) => !id.startsWith('tavern-') || tier === 'optional'))

// ── 3) 勾任一项 → 控制面板必选 ──
const ALL_TAVERN = TABS.filter(t => t.group === '酒馆模式').map(t => t.id)
for (const id of ALL_TAVERN.filter(x => x !== 'tavern-control')) {
  ok(`勾「${id}」带动控制面板`, R([id]).has('tavern-control'))
}

// ── 4) 两组互绑：勾组内任一项 → 本组全齐，且**不带**另一组 ──
const GROUP_A = ['tavern-world', 'tavern-plot', 'tavern-report']
const GROUP_B = ['tavern-free', 'tavern-card', 'tavern-script']
for (const g of [GROUP_A, GROUP_B]) {
  const other = g === GROUP_A ? GROUP_B : GROUP_A
  for (const id of g) {
    const got = R([id])
    ok(`勾「${id}」带齐本组 ${g.length} 项`, g.every(x => got.has(x)), '缺 ' + g.filter(x => !got.has(x)).join(','))
    ok(`勾「${id}」不误带另一组`, other.every(x => !got.has(x)), '误带 ' + other.filter(x => got.has(x)).join(','))
  }
}

// ── 5) 互绑必须对称（单向声明 = 取消时会卡住） ──
for (const [a, b] of [
  ['tavern-world', 'tavern-plot'], ['tavern-world', 'tavern-report'], ['tavern-plot', 'tavern-report'],
  ['tavern-free', 'tavern-card'], ['tavern-free', 'tavern-script'], ['tavern-card', 'tavern-script'],
]) {
  ok(`互绑对称 ${a} ↔ ${b}`,
    (STRONG_DEPS[a] ?? []).includes(b) && (STRONG_DEPS[b] ?? []).includes(a),
    `a→b=${(STRONG_DEPS[a] ?? []).includes(b)} b→a=${(STRONG_DEPS[b] ?? []).includes(a)}`)
}

// ── 6) 只勾控制面板不带出别的（反向不成立） ──
{
  const got = R(['tavern-control'])
  ok('只勾控制面板不带其他酒馆项', ALL_TAVERN.filter(x => x !== 'tavern-control').every(x => !got.has(x)),
    '误带 ' + ALL_TAVERN.filter(x => x !== 'tavern-control' && got.has(x)).join(','))
}

// ── 7) 剧情推演必须有资料可喂（ANY_DEPS） ──
{
  const got = R(['tavern-plot'])
  ok('勾剧情推演时至少带上一个资料功能', ANY_DEPS['tavern-plot'].some(c => got.has(c)))
  // 已有资料时不应再补
  const got2 = R(['tavern-plot', 'chapter-outline'])
  const extra = ANY_DEPS['tavern-plot'].filter(c => got2.has(c))
  ok('已有资料功能时不再补入', extra.length === 1 && extra[0] === 'chapter-outline', '实际带 ' + extra.join(','))
  // 只剩一个候选时锁定它（forced），避免取消后弹回
  const forced = forcedByDeps(got2)
  ok('仅剩一个资料候选时锁定它', forced.has('chapter-outline') && !forced.has('char-main'))
}

// ── 8) 既有依赖未被破坏 ──
ok('人物关系仍带主要角色', R(['relations']).has('char-main'))
ok('保密信息仍带主要角色', R(['secrets']).has('char-main'))
ok('派系关系仍带国家设定', R(['faction-rels']).has('nations'))
ok('地图编辑仍带地理风物', R(['geography-map']).has('geography'))

// ── 9) 空选择 = 只有锁定项 ──
{
  const got = R([])
  ok('空选择只含锁定项', got.size === LOCKED_IDS.length && LOCKED_IDS.every(id => got.has(id)), [...got].join(','))
}

// ── 9b) 必选模块的档位与可见性保障（2.8.0：「关于打赏」由 default 升 locked） ──
// 为什么要专门钉：升档不只是改一个字 —— 老项目的 features 里没有 about，
//   必须靠 tabVisible 对锁定项放行 + migrateLockedFeatures 补数据，两条都不能掉。
ok('🔴「关于打赏」是必选模块（locked）', FEATURE_TIER['about'] === 'locked', `实际=${FEATURE_TIER['about']}`)
ok('🔴「关于打赏」不在默认可选清单（DEFAULT_IDS）里', !DEFAULT_IDS.includes('about'), DEFAULT_IDS.join(','))
ok('🔴 锁定项在自定义项目里恒可见（老项目 features 缺项也不消失）',
  tabVisible('about', { type: 'custom', features: [] }) === true
  && tabVisible('editor', { type: 'custom', features: [] }) === true)
ok('🔴 锁定项放行不越权：没勾的可选模块仍不可见',
  tabVisible('politics', { type: 'custom', features: [] }) === false
  && tabVisible('tavern-free', { type: 'custom', features: [] }) === false)

// ── 10) 未启用时 tabVisible 必须为 false（使用指南的置灰依赖它） ──
{
  const ctx = { type: 'custom', features: [...R(['tavern-plot'])] }
  ok('custom 项目里未启用的酒馆项不可见', tabVisible('tavern-free', ctx) === false)
  ok('custom 项目里已启用的酒馆项可见', tabVisible('tavern-plot', ctx) === true)
  ok('full 项目里全部可见', tabVisible('tavern-free', { type: 'full', features: [] }) === true)
}

// ── 输出 ──
console.log(`\n功能依赖检查：${passed}/${checks.length} 通过`)
if (errors.length) {
  console.log('\n失败项：')
  for (const e of errors) console.log('  ✗ ' + e)
  process.exit(1)
}
console.log('  ✓ 依赖表 id 有效性 / 默认档位 / 组内互绑 / 资料兜底 / 既有依赖 / 可见性 全部通过')
