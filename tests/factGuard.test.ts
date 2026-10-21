// 3.2.0 · WQ8 文本守卫（方案 A：登记实体 + 只报告不判定）· 单测
//
// 主人 2026-10-21 拍板「按推荐处理」= A 方案：knownFacts 取本章正文出现过的登记实体，
// **只报告不判定**。本测试盯住这条口径的四类风险：
//   ① **不在正文出现的实体绝不进集合** —— 否则保留率永远上不去，误报是必然的；
//   ② **别名算保留** —— 只用正式名会把「正文用简称、改写后简称还在」误报成丢失；
//   ③ **一切正常就不出声**（summary 空 ⇒ 界面不渲染），没有"0 个丢失"的废话；
//   ④ **不接 `passed` 阈值** —— 十条里九条是合理润色，有阈值就会假阴性刷屏。
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import './mock-memory'
import {
  collectFacts, checkFactRetention, MIN_NAME_LEN,
} from '@/lib/ai/factGuard'
import type { EntityRegistry } from '@/lib/settings/settingLedger'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const reg = (): EntityRegistry => ({
  人物: [
    { name: '王铁柱', aliases: ['铁柱', '王师傅'], tabId: 'char-main', id: 'c1' },
    { name: '李二狗', aliases: [], tabId: 'char-npc', id: 'c2' },
  ],
  势力: [{ name: '玄天宗', aliases: ['玄天'], tabId: 'nations', id: 'n1' }],
  地点: [{ name: '云州城', aliases: ['云州'], tabId: 'geography', id: 'g1' }],
  种族: [], 物品: [], 术语: [],
})

const BODY = '王铁柱提着刀走进云州城。玄天宗的人早已等候多时。李二狗跟在后面。'

async function main() {
  // ---------- 一、集合装配 ----------
  {
    const facts = collectFacts(reg(), BODY)
    ok('① 正文出现过的实体全部入集合', facts.length === 4, facts.map(f => f.name).join(','))
    ok('🔴 ① 没在正文出现的实体**不进**集合（否则必然误报）',
      collectFacts(reg(), '只有王铁柱一个人。').map(f => f.name).join(',') === '王铁柱')
    ok('① 别名命中也算出现过', collectFacts(reg(), '铁柱来了。').length === 1)
    ok('🔴 ① 单字名不参与（误报主力）',
      MIN_NAME_LEN === 2
      && collectFacts({ ...reg(), 物品: [{ name: '剑', aliases: [], tabId: 'items', id: 'i1' }] }, '他拔出剑。').length === 0)
    ok('① 空正文 ⇒ 空集合（checked:false，界面不渲染）', collectFacts(reg(), '').length === 0)
    ok('① 同名条目只留一条（留第一个，来源够核对）',
      collectFacts({ ...reg(), 术语: [{ name: '王铁柱', aliases: [], tabId: 'terms', id: 't1' }] }, BODY)
        .filter(f => f.name === '王铁柱').length === 1)
    ok('① 每条都带来源（作者能指回设定表哪一行）',
      collectFacts(reg(), BODY).every(f => !!f.tabId && !!f.entryId && !!f.type))
  }

  // ---------- 二、保留判定 ----------
  {
    const all = await checkFactRetention(reg(), BODY, BODY)
    ok('② 一字不改 ⇒ 0 丢失且**不出声**（summary 空）',
      all.lost.length === 0 && all.summary === '', JSON.stringify(all))

    const kept = await checkFactRetention(reg(), BODY, BODY.replace('王铁柱', '铁柱'))
    ok('🔴 ② 正式名换成别名 ⇒ 不算丢失', kept.lost.length === 0 && kept.retained === 4, JSON.stringify(kept.lost))

    const lost = await checkFactRetention(reg(), BODY, BODY.replace('李二狗', '一个小贩'))
    ok('② 真的少了实体 ⇒ lost 1 且带来源', lost.lost.length === 1 && lost.lost[0].name === '李二狗'
      && lost.lost[0].tabId === 'char-npc', JSON.stringify(lost.lost))
    ok('② 摘要点名实体与类别（作者能判断该不该在）',
      lost.summary.includes('李二狗') && lost.summary.includes('人物'), lost.summary)

    const more = await checkFactRetention(reg(), BODY, '他走进城里。')
    ok('② 丢多个 ⇒ 摘要最多列 3 个 + "等"',
      more.lost.length === 4 && more.summary.includes('等'), `${more.lost.length} / ${more.summary}`)

    // 空集合 ⇒ checked:false，界面不该渲染这一段（没查过 ≠ 查过没事）
    const none = await checkFactRetention(reg(), '这里什么都没有。', '改写后。')
    ok('🔴 ② 正文里没有登记实体 ⇒ checked:false 且不出声',
      none.checked === false && none.summary === '', JSON.stringify(none))
    const empty = await checkFactRetention(reg(), '', 'x')
    ok('② 空原文 ⇒ checked:false', empty.checked === false)
  }

  // ---------- 三、过度缩短提示（guardText 的 falsePositives，只取提示） ----------
  {
    const short = await checkFactRetention(reg(), BODY, '王铁柱来了。')
    ok('③ 正文被砍到一半以下 ⇒ 有提示', short.notes.some(n => n.includes('过度缩短')), JSON.stringify(short.notes))
    ok('③ 提示进摘要（但不产生"通过/不通过"）', short.summary.includes('过度缩短'), short.summary)
    ok('③ 报告里**没有** passed 字段（只报告不判定）',
      !('passed' in short) && !('factRetentionRate' in short))
  }

  // ---------- 四、接线断言 ----------
  {
    const ticket = readFileSync(path.join(process.cwd(), 'src/lib/app/optimizeTicket.ts'), 'utf8')
    const cand = readFileSync(path.join(process.cwd(), 'src/lib/revision/candidateRunner.ts'), 'utf8')

    ok('④ 两处都接：工单改写 + 候选应用',
      ticket.includes('checkFactRetention') && cand.includes('checkFactRetention'))
    ok('🔴 ④ 工单侧按「改写前正文 → 改写后正文」比',
      /checkFactRetention\(await loadRegistry\(\), body, text\)/.test(ticket))
    ok('🔴 ④ 候选侧按「候选 beforeText → 应用后正文」比',
      /checkFactRetention\(await loadRegistry\(\), candidate\.beforeText/.test(cand))
    ok('🔴 ④ 两处都是旁路（catch 只 warn，不影响已落库正文）',
      /实体保留自检没跑成/.test(ticket) && /实体保留自检没跑成/.test(cand))
    ok('🔴 ④ 只在真有话要说时才往下传（summary 空就不带字段）',
      cand.includes('if (!facts.summary) facts = undefined')
      && ticket.includes('...(facts?.summary ? { facts } : {})'))

    const ui = readFileSync(path.join(process.cwd(), 'src/components/tools/OptimizeTicketPanel.tsx'), 'utf8')
    ok('④ 界面渲染（工单每章标题旁 + toast 一句）',
      ui.includes('factsOf') && ui.includes('只提示不判定') && ui.includes('登记实体没再出现'))
    const panel = readFileSync(path.join(process.cwd(), 'src/components/revision/CandidatePanel.tsx'), 'utf8')
    ok('④ 候选面板显示自检结论（并说明"只是参考"）', panel.includes('note.facts') && panel.includes('只是参考'))
  }

  console.log(`\n———— factGuard：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

void main()
