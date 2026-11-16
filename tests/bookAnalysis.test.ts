// ============ 拆书 · 作品分析（只分析）契约闸（3.6.0 · B 首期）============
//
// 盯五件事：
//   ① **只分析**：管线里不许有任何写库调用（正文 / 设定 / 关系一个都不能有）；
//   ② 证据：引文逐字命中才算 observed；没命中就降级为推测，卡片仍保留但不冒充事实；
//   ③ 覆盖：完成 / 失败 / 跳过 / 截断分开计数，未处理范围不能算"未发现"；
//   ④ 复用与重试：同输入同配置可复用，重试必须由调用方点名；
//   ⑤ 成果：分析卡能转成作者成果（A1），默认 draft，不自动进正文。
import { readFileSync } from 'node:fs'
import {
  ANALYSIS_LIMITS, ANALYSIS_DIMENSIONS, analysisCardsToArtefacts, analyzeBook, parseAnalysisCards,
} from '@/lib/bookbreak/analysis'
import { saveArtefacts, loadArtefacts } from '@/lib/artefacts/store'
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => readFileSync(p, 'utf8')

// 合成原文：两章，各 ~600 字（足够切分，不触发单元再切）
const BODY_A = '林照推开木门，雪片顺着门缝灌进来。他把斗笠挂在钉子上，低声说了一句。'.repeat(10)
const BODY_B = '第二天清晨，城门外的脚印一直延伸到河边。沈青蹲下去看了很久，忽然笑了。'.repeat(10)
const RAW = `第一章 雪夜\n${BODY_A}\n第二章 脚印\n${BODY_B}\n`

const cardJson = (over: Record<string, unknown> = {}) => JSON.stringify([{
  dimension: 'scene', title: '开场用动作带出环境', content: '以推门、挂斗笠两个动作交代季节与身份',
  quote: '林照推开木门', claim: 'observed', ...over,
}])

console.log('—— bookAnalysis：只分析管线契约闸（3.6.0 · B）——')

// ---------- ① 只分析：无写库依赖 ----------
{
  const src = read('src/lib/bookbreak/analysis.ts')
  ok('① 不 import 正文写入', !/bookbreak\/persist/.test(src))
  ok('① 不 import 设定补登', !/settingLedger/.test(src))
  ok('① 不 import 关系整理', !/bookbreak\/relations/.test(src))
  ok('① 不 import flow 草稿', !/flow\/draft/.test(src))
  ok('① 不碰 db 层（只产出结果对象）', !/from '@\/lib\/db/.test(src))
  ok('① 卡片转成果只做格式转换（不调用保存）', !/saveArtefacts/.test(src))
}

// ---------- ② 解析与证据 ----------
{
  const unit = { index: 0, chapterTitle: '第一章 雪夜', text: BODY_A, unitKey: 'k1' }
  const dims = ANALYSIS_DIMENSIONS.map(d => d.id)
  const hit = parseAnalysisCards(cardJson(), { unit, dimensions: dims })
  ok('② 引文逐字命中 ⇒ observed + verified', hit.cards.length === 1
    && hit.cards[0].claim === 'observed' && hit.cards[0].evidence?.verified === true)

  const miss = parseAnalysisCards(cardJson({ quote: '这句话原文里没有' }), { unit, dimensions: dims })
  ok('🔴 ② 声称 observed 但引文没命中 ⇒ 降级为 inferred', miss.cards[0].claim === 'inferred'
    && miss.cards[0].evidence?.verified === false)
  ok('② 没命中的卡片仍保留（推测有用，但不能冒充事实）', miss.cards.length === 1)

  const inferred = parseAnalysisCards(cardJson({ claim: 'inferred', quote: '' }), { unit, dimensions: dims })
  ok('② inferred 且无引文 ⇒ 无 evidence 字段', inferred.cards[0].claim === 'inferred' && !inferred.cards[0].evidence)

  const blank = parseAnalysisCards(cardJson({ quote: '林照 推开 木门' }), { unit, dimensions: dims })
  ok('② 引文含空白差异也能命中（去空白后包含）', blank.cards[0].evidence?.verified === true)

  const bad = parseAnalysisCards(JSON.stringify([{ dimension: 'x', title: 't', content: 'c' }, { dimension: 'scene', title: '', content: 'c' }]), { unit, dimensions: dims })
  ok('② 非法维度 / 缺标题的条目被跳过（不整批丢）', bad.cards.length === 0 && bad.dropped === 2)

  const limit = parseAnalysisCards(JSON.stringify(Array.from({ length: 12 }, (_, i) => ({
    dimension: 'scene', title: `t${i}`, content: 'c', quote: '林照推开木门', claim: 'observed',
  }))), { unit, dimensions: dims })
  ok('② 单单元卡数受上限约束', limit.cards.length === ANALYSIS_LIMITS.maxCardsPerUnit)

  const filtered = parseAnalysisCards(cardJson({ dimension: 'pacing' }), { unit, dimensions: ['scene'] })
  ok('② 未选中的维度被过滤', filtered.cards.length === 0)
}

// ---------- ③ 全流程（ACP 假通道） ----------
{
  let calls = 0
  const res = await analyzeBook(RAW, {
    dimensions: ['scene', 'turning'],
    acpText: async () => { calls++; return cardJson() },
  })
  ok('③ 两章各一次调用', calls === 2 && res.units.length === 2, `calls=${calls} units=${res.units.length}`)
  ok('③ 覆盖统计：全部完成', res.coverage.completedUnits === 2 && res.coverage.failedUnits === 0)
  ok('③ 计划字数与实际处理字数一致', res.coverage.plannedChars > 0
    && res.coverage.processedChars === res.coverage.plannedChars)
  ok('③ 没有截断时不谎报截断', res.coverage.truncated === false)
  ok('③ 卡片带章名与单元下标', res.cards.every(c => c.chapterTitle && typeof c.unitIndex === 'number'))

  // 复用：同输入 + 同配置 ⇒ 一次都不调
  let calls2 = 0
  const reuse = await analyzeBook(RAW, {
    dimensions: ['scene', 'turning'],
    previous: res,
    acpText: async () => { calls2++; return cardJson() },
  })
  ok('③ 同输入同配置复用上次结果（不再调用模型）', calls2 === 0 && reuse.cards.length === res.cards.length)

  // 只重试指定单元
  let retried: number[] = []
  await analyzeBook(RAW, {
    dimensions: ['scene', 'turning'], previous: res, retryUnits: [1],
    acpText: async () => { retried.push(1); return cardJson() },
  })
  ok('③ 只重试被点名的单元', retried.length === 1)
}

// ---------- ④ 失败 / 跳过 / 截断 ----------
{
  let n = 0
  const res = await analyzeBook(RAW, {
    acpText: async () => {
      n++
      if (n === 2) throw new Error('boom')
      return cardJson()
    },
  })
  ok('④ 单单元失败 ⇒ failed + 原因码', res.units[1].state === 'failed' && !!res.units[1].errorCode)
  ok('④ 失败不影响已完成单元', res.units[0].state === 'completed' && res.coverage.failedUnits === 1)
  ok('④ 覆盖度如实区分失败', res.coverage.completedUnits === 1 && res.coverage.failedUnits === 1)

  // 截断：把单元上限压到 1
  const cut = await analyzeBook(RAW, { maxUnits: 1, acpText: async () => cardJson() })
  ok('④ 超上限 ⇒ truncated 且只处理 1 个单元',
    cut.coverage.truncated === true && cut.coverage.plannedUnits === 1)
  ok('④ 截断时计划字数只算已纳入范围（不冒充全书）', cut.coverage.plannedChars < RAW.length)

  // 中止：信号已取消
  const ac = new AbortController()
  ac.abort()
  const stop = await analyzeBook(RAW, { signal: ac.signal, acpText: async () => cardJson() })
  ok('④ 中止后未跑单元记 skipped（不是 failed）', stop.aborted === true
    && stop.coverage.skippedUnits === 2 && stop.coverage.failedUnits === 0)

  // 无模型也无 ACP：不能伪装成"没有内容"
  const noProvider = await analyzeBook(RAW, {})
  ok('④ 无模型 ⇒ failed + no-provider（不是空结果）',
    noProvider.coverage.failedUnits === 2 && noProvider.units.every(u => u.errorCode === 'no-provider'))
}

// ---------- ⑤ 成果转换与落库 ----------
{
  const res = await analyzeBook(RAW, { acpText: async () => cardJson() })
  const records = analysisCardsToArtefacts(res, 'p-b1', 1000)
  ok('⑤ 每张卡一条成果', records.length === res.cards.length)
  ok('⑤ 默认 draft（作者审阅后才 kept）', records.every(r => r.state === 'draft'))
  ok('⑤ 来源带章名快照（只分析不绑项目章节）',
    records.every(r => !!r.source.chapterTitle && !r.source.chapterId))
  ok('⑤ payload 带证据是否已验证', records.every(r => typeof (r.payload as { evidenceVerified?: boolean }).evidenceVerified === 'boolean'))

  __resetMockStores()
  const pid = (await db.createProject('分析成果')).id
  const store = { formatVersion: 1 as const, items: analysisCardsToArtefacts(res, pid, 2000) }
  const saved = await saveArtefacts(pid, store, undefined, store.items)
  ok('⑤ 成果能写入（A1 契约）', saved.ok)
  const loaded = await loadArtefacts(pid)
  ok('⑤ 读回条数一致', loaded.store.items.length === store.items.length && !loaded.error)
  ok('⑤ 读回后仍是 draft（不自动变成正式数据）', loaded.store.items.every(i => i.state === 'draft'))
}

console.log(`\n———— bookAnalysis：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
