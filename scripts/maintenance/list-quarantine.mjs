#!/usr/bin/env node
// 隔离目录只读盘点：列出工作区根目录下的 `_待清理确认-*`
//
// 用途：给每周核查任务提供确定输出，避免每次临场拼 find/du。
// 纪律：**只读**。本脚本不删除、不移动、不改名任何文件。
//
// 用法：
//   node scripts/maintenance/list-quarantine.mjs           # 人读表格
//   node scripts/maintenance/list-quarantine.mjs --json    # 机器可读
//   node scripts/maintenance/list-quarantine.mjs --budget 120   # 单目录扫描秒数上限（默认 90）

import fs from 'fs'
import path from 'path'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const budgetIdx = args.indexOf('--budget')
const BUDGET_MS = (budgetIdx >= 0 ? Number(args[budgetIdx + 1]) : 90) * 1000 || 90000

const ROOT = process.cwd()
const PREFIX = '_待清理确认-'

// 保护名单：隔离目录里若出现这些名字，说明可能有不该被整目录删除的东西
const PROTECTED = [
  { re: /^repo-backup.*\.bundle$/i, why: 'Git 恢复包' },
  { re: /\.bundle$/i, why: 'bundle 恢复包' },
  { re: /^audit$/, why: '审计报告根目录' },
  { re: /ledger/i, why: '账本/台账' },
  { re: /recovery|restore/i, why: '恢复工具/现场' },
  { re: /\.patch$/i, why: '补丁基线' },
]

function parseDate (name) {
  const m = name.match(/(\d{8})$/)
  if (!m) return null
  const s = m[1]
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

function daysSince (iso) {
  if (!iso) return null
  const t = Date.parse(`${iso}T00:00:00+08:00`)
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / 86400000)
}

// 单次遍历：同时统计总体积与每个顶层子项的体积／文件数
function measure (dir) {
  const started = Date.now()
  let files = 0
  let bytes = 0
  let timedOut = false
  const children = new Map() // 顶层子项 → { bytes, files }
  const stack = [dir]
  let steps = 0

  while (stack.length) {
    if ((++steps & 0x3ff) === 0 && Date.now() - started > BUDGET_MS) { timedOut = true; break }
    const cur = stack.pop()
    let entries
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      const rel = path.relative(dir, full)
      const top = rel.split(path.sep)[0]
      if (!children.has(top)) children.set(top, { bytes: 0, files: 0 })
      const bucket = children.get(top)
      if (e.isDirectory()) {
        stack.push(full)
      } else if (e.isFile()) {
        let st
        try { st = fs.lstatSync(full) } catch { continue }
        files++; bytes += st.size
        bucket.files++; bucket.bytes += st.size
      }
    }
  }
  return { files, bytes, timedOut, children }
}

function suggest (days, protectedHits, timedOut) {
  if (protectedHits.length) return '需人工逐项确认（含保护命中）'
  if (timedOut) return '体积未扫完，先补扫再定'
  if (days === null) return '无日期，人工判断'
  if (days >= 30) return '建议清空'
  if (days >= 7) return '可清空（复述后再删）'
  return '观察（本周刚隔离）'
}

function human (bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const names = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith(PREFIX))
    .map(d => d.name)
    .sort()
  : []

const report = names.map(name => {
  const dir = path.join(ROOT, name)
  const date = parseDate(name)
  const days = daysSince(date)
  const m = measure(dir)

  let topLevel = 0
  try { topLevel = fs.readdirSync(dir).length } catch { topLevel = 0 }

  const protectedHits = []
  for (const child of m.children.keys()) {
    for (const p of PROTECTED) {
      if (p.re.test(child)) { protectedHits.push({ name: child, why: p.why }); break }
    }
  }

  const largest = [...m.children.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 3)
    .map(([k, v]) => ({ name: k, 体积: human(v.bytes), files: v.files }))

  return {
    目录: name,
    隔离日期: date,
    天数: days,
    顶层条目: topLevel,
    递归文件数: m.files,
    体积: human(m.bytes),
    体积字节: m.bytes,
    最大子项: largest,
    保护命中: protectedHits,
    扫描完整: !m.timedOut,
    建议: suggest(days, protectedHits, m.timedOut),
  }
})

const totals = report.reduce((a, r) => {
  a.目录数++; a.体积字节 += r.体积字节; a.递归文件数 += r.递归文件数
  return a
}, { 目录数: 0, 体积字节: 0, 递归文件数: 0 })
totals.体积 = human(totals.体积字节)

if (asJson) {
  console.log(JSON.stringify({
    mode: 'scan',
    生成时间: new Date().toISOString(),
    合计: totals,
    隔离目录: report,
  }, null, 2))
} else {
  console.log('隔离目录只读盘点（_待清理确认-*）\n')
  if (!report.length) {
    console.log('当前没有隔离目录 —— 没有待确认清空的批次。')
  } else {
    console.log('目录'.padEnd(34) + '日期'.padEnd(12) + '天数'.padStart(5) + '顶层'.padStart(7) + '文件'.padStart(8) + '体积'.padStart(11) + '  建议')
    for (const r of report) {
      console.log(
        r.目录.padEnd(34) +
        String(r.隔离日期 ?? '-').padEnd(12) +
        String(r.天数 ?? '-').padStart(5) +
        String(r.顶层条目).padStart(7) +
        String(r.递归文件数).padStart(8) +
        String(r.体积).padStart(11) +
        `  ${r.建议}`
      )
      if (r.最大子项.length) {
        console.log('    最大子项：' + r.最大子项.map(x => `${x.name}(${x.体积})`).join('、'))
      }
      if (r.保护命中.length) {
        console.log('    ⚠ 保护命中：' + r.保护命中.map(x => `${x.name}（${x.why}）`).join('、'))
      }
      if (!r.扫描完整) console.log('    ⚠ 体积扫描超时，数字为部分结果')
    }
    console.log(`\n合计 ${totals.目录数} 个隔离目录 / ${totals.递归文件数} 文件 / ${totals.体积}`)
    console.log('确认无误后可删除整个隔离目录释放空间；反悔用 cleanup:stale:restore / cleanup:tmp:restore。')
  }
  console.log('\n（只读盘点：本脚本未删除、未移动任何文件）')
}
