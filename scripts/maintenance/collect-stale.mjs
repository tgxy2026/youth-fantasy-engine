#!/usr/bin/env node
// 工作区过时测试／脚本／临时产物清理 —— 两阶段：先隔离，再由人确认删除。
//
// 判定规则与 2026-11-14 首次清理一致；新增旧版本后缀或保护项请改下面的 CONFIG。
//
//   node scripts/maintenance/collect-stale.mjs              # 只扫描，不动任何文件
//   node scripts/maintenance/collect-stale.mjs --json       # 机器可读输出（供定时盘点）
//   node scripts/maintenance/collect-stale.mjs --apply      # 移入 _待清理确认-YYYYMMDD/
//   node scripts/maintenance/collect-stale.mjs --restore    # 按 manifest 还原最近一次隔离
//
// 🔴 本脚本永不删除文件。确认与删除由人执行（直接删掉隔离目录即可）。
// 🔴 判定用「明确规则」，不用「零引用」这类模糊判据：
//    动态拼接的入口（run-all-332.mjs 扫描 *-332.*、npm 脚本、reliability 契约）
//    不会被静态引用分析发现，按零引用清会误删在役脚本。

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  statSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const MODE = argv.includes('--apply') ? 'apply' : argv.includes('--restore') ? 'restore' : 'scan'
const AS_JSON = argv.includes('--json')

const CONFIG = {
  // B 组：一次性验收探针的版本后缀。新增一批旧版探针时在这里登记。
  staleProbeVersions: ['331', '334', '335', '340'],
  // C 组：本地一次性工具的命名前缀。
  oneShotToolPrefixes: ['patch-', 'commit-msg-', 'verify-3.1', 'verify-3.2.0', 'verify-opt-', 'verify-web-'],
  // 活跃入口关键词：B 组命中即跳过（双保险，防止版本后缀误伤在役脚本）。
  activeEntrypoints: ['-332', 'run-all', 'reliability', 'release-check', 'test-plan', 'render-readme-art', 'table-performance', 'check-doc-refs'],
  // C 组保护名单：TESTING-GUIDE 点名的兼容入口、与本项目无关的工具、基准／代理类。
  protectedTools: new Set([
    'audit-platform.mjs', 'verify-mono-charts.cjs', 'verify-custom-headers.cjs',
    'searx-cors-proxy.mjs', 'tw4-css-diff.cjs', 'measure-chapter-load.cjs',
    'bench-capacity-1000x60.cjs', 'bench-release-500ch.cjs', 'gh-meta.json',
    'cleanup-list.json', 'cleanup-workspace.cjs', 'make-cleanup-list.cjs',
    'cleanup-packaging-artifacts.cjs', 'rm-tree.cjs', 'probe-update-bridge.mjs',
    'probe-update-download.cjs', 'aliasize-imports.mjs', 'apply-many.mjs',
    'regroup.mjs', 'retarget-imports.mjs',
  ]),
  // 绝不扫描的路径前缀：用户数据、恢复证据、交付物、正式源码与全部文档。
  neverTouch: [
    'docs/', '.workbuddy/memory/', '.workbuddy/tmp/', '.workbuddy/automations/',
    'release/', 'dist/', 'data/', 'node_modules/', 'src/', 'server/', 'electron/',
    'tests/browser/', 'tests/fixtures/',
  ],
}

const BOX_PREFIX = '_待清理确认-'
const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '')

function dir(rel) {
  const p = path.join(ROOT, rel)
  return existsSync(p) ? readdirSync(p) : []
}
function size(rel) { return statSync(path.join(ROOT, rel)).size }
function isFile(rel) { return statSync(path.join(ROOT, rel)).isFile() }

/** 按三条明确规则收集候选；返回分组、跳过项与体积。 */
function collect() {
  const groups = { A: [], B: [], C: [] }
  const skipped = []

  // A：tests/ 顶层隐藏的 esbuild 打包运行包。
  //    必须有对应 *.test.ts/tsx 源码才收，确保「可随时重建」而不是误判脚本。
  for (const f of dir('tests')) {
    if (!/^\..+\.mjs$/.test(f)) continue
    if (!isFile('tests/' + f)) continue
    const stem = f.replace(/^\./, '').replace(/\.mjs$/, '')
    if (!existsSync(path.join(ROOT, 'tests', stem + '.ts')) &&
        !existsSync(path.join(ROOT, 'tests', stem + '.tsx'))) {
      skipped.push({ file: 'tests/' + f, reason: '找不到对应测试源码，保守跳过' })
      continue
    }
    groups.A.push('tests/' + f)
  }

  // B：scripts/verify/ 下带旧版本后缀的一次性验收探针。
  const verRe = new RegExp(`-(${CONFIG.staleProbeVersions.join('|')})(?:-|\\.)`)
  for (const f of dir('scripts/verify')) {
    if (!/\.(mjs|cjs)$/.test(f) || !verRe.test(f)) continue
    if (CONFIG.activeEntrypoints.some((k) => f.includes(k))) {
      skipped.push({ file: 'scripts/verify/' + f, reason: '命中活跃入口关键词，保护跳过' })
      continue
    }
    groups.B.push('scripts/verify/' + f)
  }

  // C：.workbuddy/tools/ 下的一次性补丁器／提交信息／旧版验证脚本。
  for (const f of dir('.workbuddy/tools')) {
    if (!CONFIG.oneShotToolPrefixes.some((p) => f.startsWith(p))) continue
    if (CONFIG.protectedTools.has(f) || /^shots-tw/.test(f)) {
      skipped.push({ file: '.workbuddy/tools/' + f, reason: '保护名单／与本项目无关，跳过' })
      continue
    }
    if (!isFile('.workbuddy/tools/' + f)) continue
    groups.C.push('.workbuddy/tools/' + f)
  }

  const flat = Object.values(groups).flat()
  const bytes = flat.reduce((s, f) => s + size(f), 0)
  return { groups, skipped, bytes, count: flat.length }
}

/** 移动前的安全校验；任何一项不过就中止，不做部分移动。 */
function validate({ groups }) {
  const errors = []
  const flat = Object.values(groups).flat()
  for (const f of flat) {
    if (CONFIG.neverTouch.some((p) => f.startsWith(p))) errors.push(`越界路径：${f}`)
    if (!existsSync(path.join(ROOT, f))) errors.push(`源不存在：${f}`)
  }
  // A 组必须全部可重建
  for (const f of groups.A) {
    const stem = path.basename(f).replace(/^\./, '').replace(/\.mjs$/, '')
    if (!existsSync(path.join(ROOT, 'tests', stem + '.ts')) &&
        !existsSync(path.join(ROOT, 'tests', stem + '.tsx'))) errors.push(`A 组无源码：${f}`)
  }
  // B 组不得含 -332 自检与活跃入口
  for (const f of groups.B) {
    if (f.includes('-332') || CONFIG.activeEntrypoints.some((k) => f.includes(k))) {
      errors.push(`B 组误含活跃入口：${f}`)
    }
  }
  // 同名文件不要出现在多组
  if (new Set(flat).size !== flat.length) errors.push('分组出现重复路径')
  return errors
}

function human(result) {
  const { groups, skipped, bytes, count } = result
  const lines = [
    `工作区过时文件盘点（${MODE} 模式）`,
    '',
    '组   来源                          数量      体积     说明',
    `A    tests/ 隐藏打包产物          ${String(groups.A.length).padStart(4)}  ${(groups.A.reduce((s, f) => s + size(f), 0) / 1048576).toFixed(2).padStart(8)} MB   esbuild 运行包，可自动重建`,
    `B    scripts/verify/ 旧版探针    ${String(groups.B.length).padStart(4)}  ${(groups.B.reduce((s, f) => s + size(f), 0) / 1048576).toFixed(2).padStart(8)} MB   ${CONFIG.staleProbeVersions.join('/')} 时代一次性探针`,
    `C    .workbuddy/tools/ 一次性工具 ${String(groups.C.length).padStart(4)}  ${(groups.C.reduce((s, f) => s + size(f), 0) / 1048576).toFixed(2).padStart(8)} MB   补丁器／提交信息／旧版验证脚本`,
    '',
    `合计 ${count} 个文件 / ${(bytes / 1048576).toFixed(2)} MB；保护跳过 ${skipped.length} 个。`,
  ]
  return lines.join('\n')
}

function apply(result) {
  const errors = validate(result)
  if (errors.length) {
    console.error('❌ 校验未通过，未移动任何文件：\n  ' + errors.join('\n  '))
    process.exit(1)
  }
  const boxRel = `${BOX_PREFIX}${today}`
  const box = path.join(ROOT, boxRel)
  if (existsSync(box)) {
    console.error(`❌ 隔离目录已存在：${boxRel}。请先确认删除或还原旧目录，避免覆盖。`)
    process.exit(1)
  }
  if (result.count === 0) { console.log('✅ 没有符合条件的候选，无需隔离。'); return }

  mkdirSync(box, { recursive: true })
  const files = {}
  for (const f of Object.values(result.groups).flat()) {
    const src = path.join(ROOT, f)
    const dst = path.join(box, f)
    mkdirSync(path.dirname(dst), { recursive: true })
    renameSync(src, dst)
    files[`${boxRel}/${f}`] = f
  }
  const manifest = {
    生成时间: new Date().toISOString(),
    用途: '待人工确认后删除；本工具只移动、不删除、不做副本备份。files 为「隔离区路径 → 原路径」映射。',
    合计: { 文件数: result.count, 体积MB: +(result.bytes / 1048576).toFixed(2) },
    分组: {
      A: { 数量: result.groups.A.length, 说明: 'tests/ 隐藏 esbuild 打包运行包，可随时由 build-test.mjs 重建' },
      B: { 数量: result.groups.B.length, 说明: '旧版本一次性验收探针，不属于任何当前门禁入口' },
      C: { 数量: result.groups.C.length, 说明: '本地一次性补丁器与旧版验证脚本' },
    },
    判定规则: {
      旧版探针后缀: CONFIG.staleProbeVersions,
      一次性工具前缀: CONFIG.oneShotToolPrefixes,
      活跃入口关键词: CONFIG.activeEntrypoints,
      保护名单: [...CONFIG.protectedTools],
      绝不扫描: CONFIG.neverTouch,
    },
    保护跳过: result.skipped,
    还原命令: 'node scripts/maintenance/collect-stale.mjs --restore',
    红线: '不要删除 .workbuddy/tmp 恢复证据与 release/eb-cache；不要 git stash、手工 gc、git add -A。',
    files,
  }
  writeFileSync(path.join(box, 'manifest.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(path.join(box, '.gitignore'), '*\n')
  console.log(`✅ 已隔离 ${result.count} 个文件 / ${(result.bytes / 1048576).toFixed(2)} MB → ${boxRel}/`)
  console.log('   manifest.json 含完整还原索引；确认后直接删除该目录即可。')
  console.log('   撤销：node scripts/maintenance/collect-stale.mjs --restore')
}

function restore() {
  const boxes = readdirSync(ROOT).filter((n) => n.startsWith(BOX_PREFIX)).sort()
  if (!boxes.length) { console.error('❌ 找不到隔离目录，无法还原。'); process.exit(1) }
  const boxRel = boxes[boxes.length - 1]
  const mf = path.join(ROOT, boxRel, 'manifest.json')
  if (!existsSync(mf)) { console.error(`❌ ${boxRel}/manifest.json 缺失，无法还原。`); process.exit(1) }
  const files = JSON.parse(readFileSync(mf, 'utf8')).files
  let n = 0
  const skipped = []
  for (const [k, v] of Object.entries(files)) {
    if (existsSync(path.join(ROOT, v))) { skipped.push(v); continue }
    mkdirSync(path.dirname(path.join(ROOT, v)), { recursive: true })
    renameSync(path.join(ROOT, k), path.join(ROOT, v))
    n++
  }
  console.log(`✅ 从 ${boxRel}/ 还原 ${n} 个文件；跳过已存在 ${skipped.length} 个（不覆盖）：`)
  for (const f of skipped) console.log('   ' + f)
  console.log('   隔离目录及其 manifest 仍保留，确认无误后可自行删除。')
}

const result = collect()
if (AS_JSON) {
  console.log(JSON.stringify({
    mode: MODE, 生成时间: new Date().toISOString(),
    合计: { 文件数: result.count, 体积MB: +(result.bytes / 1048576).toFixed(2) },
    分组: Object.fromEntries(Object.entries(result.groups).map(([k, v]) => [k, { 数量: v.length, 文件: v }])),
    保护跳过: result.skipped,
    校验错误: validate(result),
  }, null, 2))
} else if (MODE === 'scan') {
  console.log(human(result))
  const errors = validate(result)
  if (errors.length) { console.error('\n❌ 校验错误：\n  ' + errors.join('\n  ')); process.exit(1) }
  console.log('\n只扫描，未改动任何文件。确认后执行 --apply 移入隔离区。')
} else if (MODE === 'apply') {
  console.log(human(result))
  console.log('')
  apply(result)
} else {
  restore()
}
