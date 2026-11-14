#!/usr/bin/env node
// .workbuddy/tmp 定期治理 —— 把超期且不在保护名单的顶层条目移入隔离区，由人确认后删除。
//
//   node scripts/maintenance/collect-tmp-stale.mjs              # 只读盘点
//   node scripts/maintenance/collect-tmp-stale.mjs --json       # 机器可读（供定时盘点）
//   node scripts/maintenance/collect-tmp-stale.mjs --apply      # 隔离（只移动，不删除）
//   node scripts/maintenance/collect-tmp-stale.mjs --restore    # 按 manifest 一键还原
//   node scripts/maintenance/collect-tmp-stale.mjs --days 21    # 覆盖日志类默认保留期
//
// 🔴 本脚本永不删除文件。确认与删除由人执行（删掉隔离目录即可）。
// 🔴 只处理 .workbuddy/tmp 的顶层条目，不递归挑子文件，避免误伤目录内的恢复证据。
// 🔴 保护名单里的东西（恢复包、审计报告、账本、恢复工具、故障现场）永不动。

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  statSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TMP = '.workbuddy/tmp'
const BOX_PREFIX = '_待清理确认-tmp-'
const argv = process.argv.slice(2)
const MODE = argv.includes('--apply') ? 'apply' : argv.includes('--restore') ? 'restore' : 'scan'
const AS_JSON = argv.includes('--json')
const daysArg = argv.indexOf('--days')
const overrideDays = daysArg >= 0 ? Number(argv[daysArg + 1]) : null
if (overrideDays !== null && (!Number.isInteger(overrideDays) || overrideDays < 1)) {
  console.error('❌ --days 必须是正整数')
  process.exit(1)
}

const CONFIG = {
  // 永久保护：这些是「删了回不来」的恢复包／历史证据／恢复链路本身。
  // 依据 MEMORY.md 红线「禁止清理 .workbuddy/tmp 的恢复包」与 2026-10-12
  // 那次 rm -rf 误删 5 个 repo-backup-*.bundle 的事故。
  protect: [
    /^repo-backup-.*\.bundle$/,
    /^gitee-releases-backup\.json$/,
    /^pkg-backup$/,
    /^audit$/,                       // 51 个审计报告子目录，绑定当时源码指纹
    /ledger/i,                       // 累积账本，重跑是从头开始而非重建
    /recovery|restore|backup/i,      // 恢复/回滚工具与备份
    /\.patch$/,                      // 未提交改动的 diff 基线
    /\.bundle$/,
    /edge-history-copy|userdata|profile-copy|browser-profile/i, // 故障/强杀现场
    /^_待清理确认-/,
  ],
  // 分类保留期：一次性运行产物短，日志/报告长；保护类永久。
  retentionDays: { artifact: 7, log: 30 },
  // 明确可再生的运行产物：esbuild 打包件、带随机后缀的一次性探针目录。
  artifact: [
    /^card-io-bundle-.*\.mjs$/,
    /^.*-bundle-\d{10,}\.mjs$/,
    /-[A-Za-z0-9]{6}$/,             // frontend-xxx-A1b2C3 / 354-xxx-X9y8Z7 之类
  ],
}

const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
const DAY = 86400000

function entries() {
  const dir = path.join(ROOT, TMP)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).map((e) => {
    const p = path.join(dir, e.name)
    let st
    try { st = statSync(p) } catch { return null }
    return { name: e.name, isDir: e.isDirectory(), size: e.isDirectory() ? 0 : st.size, mtime: st.mtime }
  }).filter(Boolean)
}

function classify(e) {
  if (CONFIG.protect.some((re) => re.test(e.name))) return { kind: 'protected', days: Infinity, reason: '保护名单' }
  const isArtifact = CONFIG.artifact.some((re) => re.test(e.name))
  const kind = isArtifact ? 'artifact' : 'log'
  const days = overrideDays ?? CONFIG.retentionDays[kind]
  return { kind, days, reason: `${kind === 'artifact' ? '可再生产物' : '日志/报告'} 保留 ${days} 天` }
}

function collect() {
  const all = entries()
  const result = { protected: [], candidate: { artifact: [], log: [] }, fresh: [], bytes: 0 }
  const now = Date.now()
  for (const e of all) {
    const c = classify(e)
    if (c.kind === 'protected') { result.protected.push({ ...e, reason: c.reason }); continue }
    if (now - e.mtime.getTime() < c.days * DAY) { result.fresh.push({ ...e, reason: c.reason }); continue }
    result.candidate[c.kind].push({ ...e, kind: c.kind, reason: c.reason })
    result.bytes += e.size // 目录体积不递归统计，见下方说明
  }
  return result
}

function flat(result) { return [...result.candidate.artifact, ...result.candidate.log] }

function validate(result) {
  const errors = []
  for (const e of flat(result)) {
    const src = path.join(ROOT, TMP, e.name)
    if (!existsSync(src)) errors.push(`源不存在：${TMP}/${e.name}`)
    if (CONFIG.protect.some((re) => re.test(e.name))) errors.push(`候选误含保护项：${e.name}`)
  }
  return errors
}

function summary(result) {
  const c = flat(result)
  const lines = [
    `.workbuddy/tmp 定期治理（${MODE} 模式）`,
    '',
    `顶层条目 ${result.protected.length + result.fresh.length + c.length} 个`,
    `  永久保护     ${String(result.protected.length).padStart(4)} 个（恢复包/审计报告/账本/恢复工具/故障现场）`,
    `  保留期内     ${String(result.fresh.length).padStart(4)} 个`,
    `  超期候选     ${String(c.length).padStart(4)} 个  → 产物 ${result.candidate.artifact.length} / 日志报告 ${result.candidate.log.length}`,
    '',
    `候选顶层文件合计 ${(result.bytes / 1048576).toFixed(2)} MB（目录体积未递归统计）`,
    '保留期：可再生产物 7 天 / 日志报告 30 天，可用 --days N 覆盖；保护类永久。',
  ]
  return lines.join('\n')
}

function apply(result) {
  const errors = validate(result)
  if (errors.length) { console.error('❌ 校验未通过，未移动任何文件：\n  ' + errors.join('\n  ')); process.exit(1) }
  const boxRel = `${BOX_PREFIX}${today}`
  const box = path.join(ROOT, boxRel)
  if (existsSync(box)) { console.error(`❌ 隔离目录已存在：${boxRel}。请先确认删除或还原旧目录。`); process.exit(1) }
  const c = flat(result)
  if (!c.length) { console.log('✅ 没有超期候选，无需隔离。'); return }
  mkdirSync(box, { recursive: true })
  const files = {}
  for (const e of c) {
    const src = path.join(ROOT, TMP, e.name)
    const dst = path.join(box, e.name)
    renameSync(src, dst)
    files[`${boxRel}/${e.name}`] = `${TMP}/${e.name}`
  }
  const manifest = {
    生成时间: new Date().toISOString(),
    用途: '待人工确认后删除；本工具只移动、不删除、不做副本备份。files 为「隔离区路径 → 原路径」映射。',
    合计: { 条目数: c.length, 顶层文件MB: +(result.bytes / 1048576).toFixed(2) },
    判定规则: {
      保护名单: CONFIG.protect.map(String),
      保留期天数: CONFIG.retentionDays,
      覆盖天数: overrideDays,
      说明: '只处理 .workbuddy/tmp 顶层条目；目录体积未递归统计；移动只隔离不删除',
    },
    候选: c.map((e) => ({ 名称: e.name, 类型: e.isDir ? 'DIR' : 'FILE', 分类: e.kind, 依据: e.reason, 修改时间: e.mtime.toISOString() })),
    还原命令: 'node scripts/maintenance/collect-tmp-stale.mjs --restore',
    红线: '不删恢复包与历史证据；不做 git stash、手工 gc、git add -A；确认删除前不得清空隔离目录。',
    files,
  }
  writeFileSync(path.join(box, 'manifest.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(path.join(box, '.gitignore'), '*\n')
  console.log(`✅ 已隔离 ${c.length} 个条目 → ${boxRel}/`)
  console.log('   确认后直接删除该目录即可；撤销：node scripts/maintenance/collect-tmp-stale.mjs --restore')
}

function restore() {
  const boxes = readdirSync(ROOT).filter((n) => n.startsWith(BOX_PREFIX)).sort()
  if (!boxes.length) { console.error('❌ 找不到隔离目录，无法还原。'); process.exit(1) }
  const boxRel = boxes[boxes.length - 1]
  const mf = path.join(ROOT, boxRel, 'manifest.json')
  if (!existsSync(mf)) { console.error(`❌ ${boxRel}/manifest.json 缺失。`); process.exit(1) }
  const files = JSON.parse(readFileSync(mf, 'utf8')).files
  let n = 0
  const skipped = []
  for (const [k, v] of Object.entries(files)) {
    if (existsSync(path.join(ROOT, v))) { skipped.push(v); continue }
    renameSync(path.join(ROOT, k), path.join(ROOT, v))
    n++
  }
  console.log(`✅ 从 ${boxRel}/ 还原 ${n} 个条目；跳过已存在 ${skipped.length} 个（不覆盖）`)
  console.log('   隔离目录及其 manifest 仍保留，确认无误后可自行删除。')
}

const result = collect()
if (AS_JSON) {
  console.log(JSON.stringify({
    mode: MODE, 生成时间: new Date().toISOString(),
    合计: { 保护: result.protected.length, 保留期内: result.fresh.length, 超期候选: flat(result).length, 候选顶层文件MB: +(result.bytes / 1048576).toFixed(2) },
    候选: flat(result).map((e) => ({ 名称: e.name, 类型: e.isDir ? 'DIR' : 'FILE', 分类: e.kind, 依据: e.reason })),
    校验错误: validate(result),
  }, null, 2))
} else if (MODE === 'scan') {
  console.log(summary(result))
  const errors = validate(result)
  if (errors.length) { console.error('\n❌ 校验错误：\n  ' + errors.join('\n  ')); process.exit(1) }
  console.log('\n只扫描，未改动任何文件。确认后执行 --apply 移入隔离区。')
} else if (MODE === 'apply') {
  console.log(summary(result)); console.log(''); apply(result)
} else {
  restore()
}
