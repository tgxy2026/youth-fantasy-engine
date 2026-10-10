// ============ 「正文概要 → 章节细纲卡」回填的回归用例 ============
//
// 这条链路是 P2 勾稽完整性的一段（老大 09-18 拍板口径：正文定稿后回填细纲卡，且**不覆盖作者手改**）。
// 三个"错了也不报错"的点必须钉死：
//   ① **覆盖了作者手写的计划** —— 这是最不能犯的错（细纲卡是作者心血，被一键抹掉无从察觉）；
//   ② **凭空新建细纲卡** —— 给"没写过细纲的章"建一张，把"没计划"变成"有计划但内容是正文摘要"；
//   ③ **匹配错章** —— 同名标题在多章出现时（「风云」这种常见章名）填错卡，比不填更糟。
// 另外锁住"只在摘要变化时才回填"这条性能契约（保存章节是很热的路径）。
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { backfillOutlineEvent, syncChapterMaster } from '../src/lib/outline/chapterMaster'
import { chapterNoOf, outlineCardName, outlineEventKey } from '../src/lib/outline/outlineCard'
import type { CardRecord, Chapter } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

__resetMockStores()
const PID = 'outline-backfill-test'
db.setCurrentProject(PID)

const KEY = outlineEventKey() as string

async function mkOutlineCard(no: number, title: string, event = '', id?: string): Promise<CardRecord> {
  const rec: CardRecord = {
    id: id ?? `oc-${no}`, projectId: PID, tabId: 'chapter-outline',
    name: outlineCardName(no, title), data: { [KEY]: event }, order: no - 1,
  }
  await db.saveCardRecord(rec)
  return rec
}

/** 读回某张细纲卡的「本章一句话事件」 */
async function eventOf(id: string): Promise<string> {
  const cards = await db.getCardRecords('chapter-outline')
  return cards.find(c => c.id === id)?.data[KEY] ?? ''
}
async function cardCount(): Promise<number> {
  return (await db.getCardRecords('chapter-outline')).length
}

// ---------- ① 卡名约定（三处共用同一份实现，先锁住它本身） ----------
{
  ok('卡名生成：`第3章 风云`', outlineCardName(3, '风云') === '第3章 风云', outlineCardName(3, '风云'))
  ok('卡名生成：标题为空时退化为 `第3章`', outlineCardName(3, '') === '第3章', outlineCardName(3, ''))
  ok('卡名解析：取回章号', chapterNoOf('第12章 剑鸣中州') === 12, String(chapterNoOf('第12章 剑鸣中州')))
  ok('卡名解析：非细纲卡名 → 0', chapterNoOf('番外·铁柱传') === 0, String(chapterNoOf('番外·铁柱传')))
  ok('🔴 字段真键可解析（拿不到就必须让调用方停手）', !!KEY, String(KEY))
}

// ---------- ② 原本为空 → 回填 ----------
{
  await mkOutlineCard(1, '风起云州', '', 'oc-1')
  const r = await backfillOutlineEvent('陈渊被判废脉，当夜觉醒吞天诀', 1, '风起云州')
  ok('空字段 → 填上', (await eventOf('oc-1')) === '陈渊被判废脉，当夜觉醒吞天诀', await eventOf('oc-1'))
  ok('返回值报告填了 1 张', r?.filled === 1 && r?.skipped === 0, JSON.stringify(r))
}

// ---------- ③ 🔴 已有内容 → 绝不覆盖（作者手改优先） ----------
{
  await mkOutlineCard(2, '剑鸣中州', '（作者手写：萧景行入京，暗线 B 起）', 'oc-2')
  const r = await backfillOutlineEvent('正文概要：萧景行入京面圣', 2, '剑鸣中州')
  ok('🔴 已有内容保持原样（不被正文概要覆盖）',
    (await eventOf('oc-2')) === '（作者手写：萧景行入京，暗线 B 起）', await eventOf('oc-2'))
  ok('返回值报告跳过了 1 张', r?.filled === 0 && r?.skipped === 1, JSON.stringify(r))
}

// ---------- ④ 🔴 同名标题多章时按章号匹配（不填错卡） ----------
{
  await mkOutlineCard(5, '风云', '', 'oc-5')
  await mkOutlineCard(9, '风云', '', 'oc-9')
  await backfillOutlineEvent('第五章的概要', 9, '风云')
  ok('🔴 按章号落到第 9 章那张（不是先匹配到的第 5 张）', (await eventOf('oc-9')) === '第五章的概要', await eventOf('oc-9'))
  ok('第 5 章那张没被动', (await eventOf('oc-5')) === '', await eventOf('oc-5'))
}

// ---------- ⑤ 🔴 匹配不上 → 什么都不做，尤其**不新建卡** ----------
{
  const before = await cardCount()
  const r = await backfillOutlineEvent('一个没有细纲的章的概要', 77, '不存在的章标题')
  ok('🔴 不新建细纲卡（卡数不变）', (await cardCount()) === before, `${before} → ${await cardCount()}`)
  ok('返回值是"没做事"，不是报错', r?.filled === 0 && r?.skipped === 0, JSON.stringify(r))
}

// ---------- ⑥ 边界：序章 / 空摘要 ----------
{
  const before = await cardCount()
  ok('章号为 0（序章/不计入序号）→ 直接返回 null', (await backfillOutlineEvent('序章概要', 0, '序章')) === null)
  ok('空摘要 → 返回 null（不乱填空串）', (await backfillOutlineEvent('   ', 3, '风云')) === null)
  ok('两种情况都没写库', (await cardCount()) === before)
}

// ---------- ⑦ 集成：syncChapterMaster 在**摘要变化**时回填 ----------
{
  await mkOutlineCard(3, '血月夜', '', 'oc-3')
  const ch = {
    id: 'ch-3', projectId: PID, volumeId: 'v-1', order: 2, title: '血月夜',
    content: '正文…', summary: '', wordCount: 1800, status: '草稿', createdAt: Date.now(),
  } as Chapter

  // 首次保存：summary 仍是空 → 不回填
  await syncChapterMaster(ch, 3)
  ok('摘要为空时不动细纲卡', (await eventOf('oc-3')) === '', await eventOf('oc-3'))

  // 摘要出现（＝作者压了概要）→ 回填
  const withSummary = { ...ch, summary: '陈渊借雷劫破境，引动青铜小塔吞噬雷池' } as Chapter
  await syncChapterMaster(withSummary, 3)
  ok('🔴 摘要出现后自动回填细纲卡',
    (await eventOf('oc-3')) === '陈渊借雷劫破境，引动青铜小塔吞噬雷池', await eventOf('oc-3'))

  // 台账那一侧仍照常同步（回填不能破坏原有链路）
  const rows = await db.getTableRows('chapter-vol-v-1')
  ok('台账「一句话事件」照常同步（原链路未被破坏）',
    rows[0]?.data['一句话事件'] === '陈渊借雷劫破境，引动青铜小塔吞噬雷池', JSON.stringify(rows[0]?.data))
}

// ---------- ⑧ 集成：细纲卡已有作者内容时，保存章节也不覆盖 ----------
{
  await mkOutlineCard(4, '雨夜截杀', '（作者手写计划：留一个伏笔）', 'oc-4')
  const ch = {
    id: 'ch-4', projectId: PID, volumeId: 'v-1', order: 3, title: '雨夜截杀',
    content: '正文…', summary: '陈渊雨夜截杀黑风寨三人', wordCount: 2000, status: '草稿', createdAt: Date.now(),
  } as Chapter
  await syncChapterMaster(ch, 4)
  ok('🔴 保存章节时也不覆盖作者已写的细纲事件',
    (await eventOf('oc-4')) === '（作者手写计划：留一个伏笔）', await eventOf('oc-4'))
}

console.log(`\n—— outlineBackfill 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
