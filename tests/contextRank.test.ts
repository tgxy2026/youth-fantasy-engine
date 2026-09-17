// ============ 上下文条目排序 · 「保密等级」= 信息档位（2.2.0）============
//
// 改造前：renderCards / renderTable 一律 `slice(0, cap)` —— 按**录入顺序**取前 N 条，
//        跟重要性毫无关系。长篇写到后段就变成「琐碎的先占位、重要的挤不进来」。
// 改造后：先按「保密等级」（S > A > B > C）排预算优先级，再截断。
//
// 本用例盯两个不变量，它们都是**硬要求**而不是修饰：
//   ① 渲染出的条目，等级序列**单调不降**（S→A→B→C）—— 这是"分级真的生效了"的唯一证据；
//   ② 同等级内严格保持**录入序**（= order 升序）—— 本地模型的 prompt prefix cache
//      依赖前缀逐字一致；同级顺序若随排序抖动，每次请求都要重算 prefill，就成了"改了个好事反而更慢"。
// 另测兜底：无等级 / 未知等级必须当中性（B），**绝不能当 C** —— 否则老项目会因为当年没标等级，
//          被这个新功能静默降级到"最先丢"。
//
// ⚠️ 2026-09-17 起「保密等级」列**不再渲染进提示词**（SYSTEM_META_FIELDS：裸字母对模型是噪音），
//    所以等级只能从**原始数据**里查、不能从渲染文本里读。本用例已按此口径改写。
//
// 用示范项目的数据跑（与 tavernContext.test.ts 同源）。
import * as db from '../src/lib/db'
import { createDemoProject } from '../src/lib/seedData'
import { buildProjectContext, buildInlineBriefing } from '../src/lib/aiContext'
import { TABS } from '../src/lib/schema'
import { uid } from '../src/lib/id'
import { __resetMockStores } from './mock-memory'
import type { TableRow } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
function note(name: string, why: string) { pass++; console.log(`SKIP ${name}（${why}）`) }

const RANK: Record<string, number> = { S: 0, A: 1, B: 2, C: 3 }
const NEUTRAL = 2
const rankOf = (v: unknown) => RANK[String(v ?? '').trim().toUpperCase()] ?? NEUTRAL

/** 按 buildProjectContext 返回的 sections 顺序切出每段正文（比猜 〖 边界可靠） */
function splitSections(text: string, sections: string[]): Map<string, string[]> {
  const marks: { t: string; p: number }[] = []
  for (const t of sections) {
    const p = text.indexOf('〖' + t + '〗')
    if (p >= 0) marks.push({ t, p })
  }
  marks.sort((a, b) => a.p - b.p)
  const map = new Map<string, string[]>()
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].p + marks[i].t.length + 2
    const to = i + 1 < marks.length ? marks[i + 1].p : text.length
    map.set(marks[i].t, text.slice(from, to).split('\n').map(s => s.trim()).filter(Boolean))
  }
  return map
}

/** 表格型：按行序取「编号」列 */
function tableCodes(lines: string[], tabId: string): string[] {
  const tab = TABS.find(t => t.id === tabId)
  const cols = (tab?.columns ?? []).map(c => c.name)
  const ci = cols.indexOf('编号')
  if (ci < 0) return []
  return lines.slice(1).filter(l => !l.startsWith('（另有')).map(l => (l.split(' ｜ ')[ci] ?? '').trim())
}

/** 卡片型：按 〖卡名〗 取卡名序列 */
function cardNames(lines: string[]): string[] {
  return lines.filter(l => l.startsWith('〖') && l.endsWith('〗')).map(l => l.slice(1, -1))
}

/** 卡片等级存在复合键里（模块::字段），与 renderForm 的取值口径一致 */
function cardLv(data: Record<string, string>): string {
  if (data['保密等级'] !== undefined) return data['保密等级']
  for (const [k, v] of Object.entries(data)) if (k.endsWith('::保密等级')) return v
  return ''
}

const mono = (nums: number[]) => nums.every((n, i) => i === 0 || nums[i - 1] <= n)

async function main() {
  __resetMockStores()
  const pid = await createDemoProject()
  db.setCurrentProject(pid)

  // 预算给足：让"带没带 / 什么顺序"只取决于排序，而不是被预算裁掉
  const BIG = 200000
  const ctx = await buildProjectContext({ budget: BIG })
  const seg = splitSections(ctx.text, ctx.sections)

  // ---------- 0) 前提：排序前的数据确实是"混着的" ----------
  // 若种子数据本来就按等级排好了，下面的断言会假通过（测不出排序是否生效）。
  const rawTerms = await db.getTableRows('terms')
  const rawNums = rawTerms.map(r => rankOf(r.data['保密等级']))
  ok('前提：名词术语表原始录入序并非已按等级排好（否则测不出排序生效）', !mono(rawNums),
    '原始序=' + rawNums.join(','))

  // ---------- 1) 表格型：等级单调不降 + 同等级保持录入序 ----------
  let checkedTables = 0
  for (const id of ['terms', 'geography', 'items', 'nations', 'races', 'history']) {
    const name = TABS.find(t => t.id === id)?.name ?? id
    const lines = seg.get(name)
    if (!lines || lines.length < 2) { note(`【表格】${name}`, '该段未带入或无数据行'); continue }
    const codes = tableCodes(lines, id).filter(Boolean)
    if (codes.length < 2) { note(`【表格】${name}`, '可解析行不足 2'); continue }

    const raw = await db.getTableRows(id)                       // 已按 order 升序 = 录入序
    const lvOf = new Map(raw.map(r => [String(r.data['编号'] ?? '').trim(), r.data['保密等级']]))
    const idxOf = new Map(raw.map((r, i) => [String(r.data['编号'] ?? '').trim(), i]))

    const nums = codes.map(c => rankOf(lvOf.get(c)))
    ok(`【表格】${name}：条目按预算优先级排列（S→A→B→C）`, mono(nums),
      `实际=${nums.join(',')}`)

    // 稳定性判据：以「DB 实际返回顺序」（= order 升序 = 录入序）为基准，
    // 检查渲染序里**同等级**各行在基准中的下标是否递增。
    // ⚠️ 不能用「编号字典序」当录入序的代理 —— 实测 G0001-002 / I0004 / N0002 的编号序与录入序不一致。
    const byLv = new Map<number, number[]>()
    codes.forEach(c => {
      const lv = rankOf(lvOf.get(c))
      if (!byLv.has(lv)) byLv.set(lv, [])
      byLv.get(lv)!.push(idxOf.get(c) ?? -1)
    })
    let stable = true, bad = ''
    for (const [lv, arr] of byLv) {
      for (let i = 1; i < arr.length; i++) {
        if (arr[i - 1] >= 0 && arr[i] >= 0 && arr[i] < arr[i - 1]) {
          stable = false; bad = `等级档 ${lv}：录入序下标 ${arr[i - 1]} → ${arr[i]}`; break
        }
      }
      if (!stable) break
    }
    ok(`【表格】${name}：同等级内保持录入序（顺序稳定，护住 prefix cache）`, stable, bad)
    checkedTables++
  }
  ok('至少校验到一张表格型页签（否则上面几条是空转）', checkedTables > 0, `已校验 ${checkedTables} 张`)

  // ---------- 2) 卡片型：角色卡按等级排列 ----------
  let checkedCards = 0
  for (const id of ['char-main', 'char-secondary', 'char-npc']) {
    const name = TABS.find(t => t.id === id)?.name ?? id
    const lines = seg.get(name)
    if (!lines || lines.length < 2) { note(`【卡片】${name}`, '该段未带入'); continue }
    const names = cardNames(lines)
    if (names.length < 2) { note(`【卡片】${name}`, '可解析卡片不足 2 张'); continue }
    const recs = await db.getCardRecords(id)
    const lvByName = new Map(recs.map(r => [r.name, cardLv(r.data)]))
    const nums = names.map(n => rankOf(lvByName.get(n)))
    ok(`【卡片】${name}：角色卡按预算优先级排列`, mono(nums), `实际等级序=${nums.join(',')}`)
    checkedCards++
  }
  ok('至少校验到一个卡片型页签', checkedCards > 0, `已校验 ${checkedCards} 张`)

  // ---------- 3) 系统元数据列不再污染提示词（2026-09-17 改动） ----------
  ok('渲染文本里不再出现「保密等级」列名（纯系统调度元数据，不进提示词）',
    !ctx.text.includes('保密等级'), ctx.text.slice(0, 0) || '（若出现说明过滤失效）')

  // ---------- 4) 兜底：空等级 / 乱写等级一律中性档（排在 C 之前） ----------
  const mk = (code: string, lv: string): TableRow => ({
    id: uid(), projectId: '', tabId: 'terms', order: 9999,
    data: { '编号': code, '名称': '【用例】' + code, '定义（一句话）': '用例条目', '保密等级': lv, '状态': '使用中' },
  })
  await db.saveTableRow(mk('T9001', ''))     // 完全没填
  await db.saveTableRow(mk('T9002', 'X'))    // 乱写（非法值）
  await db.saveTableRow(mk('T9003', 's'))    // 小写 s —— 应当识别为 S 而非兜底

  const ctx2 = await buildProjectContext({ budget: BIG })
  const seg2 = splitSections(ctx2.text, ctx2.sections)
  const name2 = TABS.find(t => t.id === 'terms')?.name ?? '名词术语'
  const codes2 = tableCodes(seg2.get(name2) ?? [], 'terms')
  const raw2 = await db.getTableRows('terms')
  const lv2 = new Map(raw2.map(r => [String(r.data['编号'] ?? '').trim(), r.data['保密等级']]))
  const at = (code: string) => codes2.indexOf(code)
  const firstC = codes2.findIndex(c => rankOf(lv2.get(c)) === 3)
  const i1 = at('T9001'), i2 = at('T9002'), i3 = at('T9003')

  ok('三条用例行都进了上下文（前提）', i1 >= 0 && i2 >= 0 && i3 >= 0, `T9001@${i1} T9002@${i2} T9003@${i3}`)
  ok('空等级 → 中性档：排在所有 C 级之前（老数据不被静默降级）',
    i1 >= 0 && firstC >= 0 && i1 < firstC, `空等级@${i1}，首个 C@${firstC}`)
  ok('未知等级 "X" → 同样中性档', i2 >= 0 && firstC >= 0 && i2 < firstC, `X@${i2}，首个 C@${firstC}`)
  ok('小写 "s" 被正确识别为 S 档（不因大小写掉进兜底）', i3 >= 0 && i1 >= 0 && i3 < i1, `小写s@${i3}，空等级@${i1}`)
  ok('排序只调顺序、不改变条目总数（原 32 条 + 3 条用例 = 35）', codes2.length >= 35, `实际 ${codes2.length}`)

  // ---------- 5) 伴写专用设定切片 ----------
  const brief = await buildInlineBriefing()
  ok('伴写切片非空（示范项目有设定可带）', brief.length > 0, `长度 ${brief.length}`)
  ok('伴写切片不带「章节清单」目录（伴写已有光标前正文，目录纯属重复）',
    !brief.includes('章节清单'), brief.slice(0, 60))
  ok('伴写切片受预算约束（≤1200 字符）', brief.length <= 1200, `${brief.length} 字符`)

  console.log(`\n—— contextRank 用例结束：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.error('用例异常终止：', e)
  process.exitCode = 1
})
