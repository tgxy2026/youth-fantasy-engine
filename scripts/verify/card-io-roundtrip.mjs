#!/usr/bin/env node
// 六维审计契约 io.roundtrip 的证据生产者（3.2.3 起随仓入库）。
//
// 契约原文：「历史记录、空姓名、重复名、导出再导入的实际存储结果」。
// 这里跑的是 CharacterSheet 批量导入/导出的**同一条生产链路**（不重写逻辑）：
//   exportCardsCsv → parseImportText → mapHeaders → matrixToRows → validateImport → buildCardRecords
// 每个字段都断言"导出再导入后，存储键与值逐字一致"。
//
// 🔴 空姓名/重名/别名列名三类各是独立 case，任一不成立就 status=failed。
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const TAB_ID = 'char-main'

async function main() {
  const outDir = path.join(ROOT, '.workbuddy/tmp')
  await fs.mkdir(outDir, { recursive: true })
  const stamp = Date.now()
  const bundle = path.join(outDir, `card-io-bundle-${stamp}.mjs`)
  const artifact = path.join(outDir, `card-io-evidence-${stamp}.json`)

  await build({
    stdin: {
      contents: `export { TABS } from '@/lib/schema';
export { buildCardRecords, cardTabToTableTab, cardRecordsToTableRows, exportCardsCsv, cardFieldsOf, cardNamePath } from '@/lib/storage/cardIO';
export { parseImportText, mapHeaders, matrixToRows, validateImport } from '@/lib/storage/tableIO';`,
      resolveDir: ROOT, loader: 'ts',
    },
    alias: { '@': path.join(ROOT, 'src') },
    bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent',
  })
  const lib = await import(pathToFileURL(bundle).href)

  const tab = lib.TABS.find((t) => t.id === TAB_ID)
  if (!tab) throw new Error('找不到角色页签 ' + TAB_ID)
  const vtab = lib.cardTabToTableTab(tab)
  const fields = lib.cardFieldsOf(tab)
  const namePath = lib.cardNamePath(tab)
  if (!namePath) throw new Error('角色页签没有姓名字段')
  const pick = (name) => fields.find((f) => f.name === name)?.path

  const cases = []
  const fail = []
  const record = (kase, ok, detail) => {
    cases.push({ case: kase, ok, ...detail })
    if (!ok) fail.push(`${kase}: ${detail.reason}`)
  }

  let seq = 0
  const uid = () => `probe-${++seq}`
  /** 走完整生产链路：CSV 文本 → 行记录 */
  const importFromCsv = (csv, { extra = [], existing = [] } = {}) => {
    const parsed = lib.parseImportText(csv)
    if (parsed.format !== 'csv') throw new Error('解析结果不是 CSV：' + parsed.format + ' ' + parsed.note)
    const mapping = lib.mapHeaders(parsed.table.headers, vtab, extra)
    const rows = lib.matrixToRows(parsed.table, mapping, vtab)
    // refValues 空 Map：本场景不校验跨表引用悬空（那属于表格导入的另一条契约），但接口要求必须给
    const picked = lib.validateImport(rows, vtab, { existing, refValues: new Map() })
    return { parsed, mapping, rows, picked }
  }
  const mkRecord = (id, data, order = 0) => ({
    id, projectId: 'probe-project', tabId: tab.id,
    name: (data[namePath] ?? '').trim(), data, order,
  })

  // ---------- ① roundtrip：含逗号 / 引号 / 换行 / 中文标点 / 多值，逐字段比对 ----------
  {
    const data = {
      [namePath]: '沈砚之',
      [pick('别称')]: '砚之,「小砚」',
      [pick('外貌特征')]: '第一行描写\n第二行跟着换行',
      [pick('年龄/性别')]: '二十七 / 男',
      [pick('身份定位')]: '主角（既是"刀客"，也是账房）',
      [pick('种族')]: '人族',
    }
    const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v))
    const original = mkRecord('probe-origin', clean)
    const csv = lib.exportCardsCsv(tab, [original])
    const { picked } = importFromCsv(csv)
    const back = lib.buildCardRecords(picked, tab, [], 'probe-project', uid)[0]
    const diffs = []
    for (const [k, v] of Object.entries(clean)) {
      if ((back?.data?.[k] ?? '') !== v) diffs.push(`${k}: 「${back?.data?.[k] ?? ''}」≠「${v}」`)
    }
    // 导出的行数也必须是一条（含换行的字段不能被拆成两行）
    record('roundtrip', diffs.length === 0 && !!back && back.name === '沈砚之', {
      fields: Object.keys(clean).length,
      csvRows: picked.length,
      reason: diffs.length ? diffs.join('；') : (picked.length !== 1 ? `导出后再导入变成了 ${picked.length} 行` : undefined),
    })
    cases[cases.length - 1].sampleCount = Object.keys(clean).length
  }

  // ---------- ② 空姓名：没有姓名列的行必须给出可读的兜底名，不能产生空名记录 ----------
  {
    const data = { [pick('种族')]: '妖族' }
    const original = mkRecord('probe-noname', data)
    const csv = lib.exportCardsCsv(tab, [original])
    const { picked } = importFromCsv(csv)
    const back = lib.buildCardRecords(picked, tab, [], 'probe-project', uid)
    const name = back[0]?.name ?? ''
    const ok = back.length === 1 && !!name && name !== '' && /未命名/.test(name)
    record('roundtrip', ok, {
      scenario: 'empty-name',
      emptyNameFallback: name,
      reason: ok ? undefined : `空姓名得到的名字是「${name}」（期望「未命名角色」兜底，且不能是空串）`,
    })
  }

  // ---------- ③ 别名/历史列名：用显示名（旧版导出常见）导入，也要能落到正确存储键 ----------
  {
    const nameField = fields.find((f) => f.path === namePath)
    const raceField = fields.find((f) => f.name === '种族')
    if (!nameField || !raceField) throw new Error('缺少姓名/种族字段，无法构造别名场景')
    // 模拟历史导出的列头：写的是**显示名**而不是 schema 原名
    const aliasName = '角色姓名（旧版列名）'
    const aliasRace = '种族（旧版列名）'
    const csv = [`${aliasName},${aliasRace}`, '柳青梧,羽族'].join('\n')
    const extra = [{ name: nameField.name, label: aliasName }, { name: raceField.name, label: aliasRace }]
    const { picked } = importFromCsv(csv, { extra })
    const back = lib.buildCardRecords(picked, tab, [], 'probe-project', uid)[0]
    const ok = back?.name === '柳青梧' && back?.data?.[raceField.path] === '羽族'
    record('legacy-name', ok, {
      scenario: 'alias-header',
      mappedName: back?.name, mappedRace: back?.data?.[raceField.path],
      reason: ok ? undefined : '别名列名没有映射到存储键（姓名/种族落库失败）',
    })
  }

  // ---------- ④ 重名：同名两行都要被识别为批内重复，且不会静默合并成一条 ----------
  {
    // 至少两列：parseImportText 只把「首行含逗号且列数≥2」的输入当 CSV，单列会被当成纯文本
    const nameCol = fields.find((f) => f.path === namePath)?.name
    const raceCol = fields.find((f) => f.name === '种族')?.name
    const csv = [`${nameCol},${raceCol}`, '同名甲,人族', '同名甲,妖族'].join('\n')
    const { picked } = importFromCsv(csv)
    const dupFlagged = picked.filter((p) => p.dupInBatch).length
    const back = lib.buildCardRecords(picked, tab, [], 'probe-project', uid)
    const ok = picked.length === 2 && dupFlagged >= 1 && back.length === 2
    record('duplicate', ok, {
      rows: picked.length, dupFlagged, built: back.length,
      reason: ok ? undefined : '重名行没有被标出 dupInBatch，或落库条数不对（可能被静默合并）',
    })
  }

  const passed = cases.filter((c) => c.ok).length
  const payload = {
    schemaVersion: 1, contract: 'io.roundtrip', at: new Date().toISOString(),
    scope: `production cardIO+tableIO chain on tab ${TAB_ID}; offline, no project database written`,
    tab: TAB_ID, fields: fields.length, samples: cases.length, passed, failed: cases.length - passed,
    failures: fail, cases,
  }
  await fs.writeFile(artifact, JSON.stringify(payload, null, 2))
  console.log(`CARD_IO samples=${cases.length} passed=${passed} failed=${payload.failed}`)
  console.log(`artifact=${path.relative(ROOT, artifact).replaceAll('\\', '/')}`)
  if (payload.failed) { for (const f of fail) console.error('FAIL ' + f); process.exitCode = 1 }
}

main().catch((e) => { console.error('CARD_IO failed: ' + (e instanceof Error ? e.stack : e)); process.exitCode = 1 })
