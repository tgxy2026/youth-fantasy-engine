// ============ 创作参考契约闸（3.6.0 · C 首期）============
//
// 盯四件事：
//   ① 默认不勾选：没选就一段都不发（绝不自动注入成果）；
//   ② 过期不发：来源变了/不明的卡只能看，不能自动进提示词；
//   ③ 预算可核：张数、总字数、单卡长度都有上限，被剔除的要说原因；
//   ④ 说清是谁的文字：注入块必须写明「非本项目原文、不要照搬、不是设定」。
import { readFileSync } from 'node:fs'
import {
  REFERENCE_LIMITS, buildReferenceBlock, describeReferenceBlock, dimensionLabelOf,
  referenceCardsOf, type ReferenceCard,
} from '@/lib/creative/reference'
import { referenceBlockForIds } from '@/lib/creative/referenceLoad'
import {
  REFERENCE_LOG_LIMIT, REFERENCE_SENT_NOTE, appendReferenceSend, loadReferenceSends,
} from '@/lib/creative/referenceLog'
import { saveArtefacts } from '@/lib/artefacts/store'
import type { ArtefactRecord, ArtefactStore } from '@/lib/artefacts/types'
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => readFileSync(p, 'utf8')

const art = (over: Partial<ArtefactRecord> = {}): ArtefactRecord => ({
  id: 'ar-1', kind: 'analysis', projectId: 'p1',
  source: { chapterTitle: '第一章 雪夜', fingerprint: 'f1', quote: '林照推开木门' },
  deps: [], state: 'draft',
  payload: {
    dimension: 'scene', title: '开场用动作带出环境', content: '以推门、挂斗笠两个动作交代季节与身份',
    claim: 'observed', evidenceVerified: true,
  },
  createdAt: 1, updatedAt: 1, ...over,
})
const store = (items: ArtefactRecord[]): ArtefactStore => ({ formatVersion: 1, items })
const card = (over: Partial<ReferenceCard> = {}): ReferenceCard => ({
  artefactId: 'ar-1', kind: 'analysis', dimension: 'scene',
  title: '开场用动作带出环境', content: '以推门、挂斗笠两个动作交代季节与身份',
  claim: 'observed', evidenceVerified: true, sourceLabel: '第一章 雪夜', stale: false, kept: false,
  ...over,
})

console.log('—— creativeReference：创作参考契约闸（3.6.0 · C）——')

// ---------- ① 候选与默认 ----------
{
  const cards = referenceCardsOf(store([
    art(),
    art({ id: 'ar-2', kind: 'reference' }),
    art({ id: 'ar-3', kind: 'candidate' }),
    art({ id: 'ar-4', payload: { title: '', content: '' } }),
    art({ id: 'ar-5', stale: { at: 9, reason: 'source-changed' } }),
  ]))
  ok('① 只收 analysis / reference 两类', cards.map(c => c.artefactId).join('|') === 'ar-1|ar-2|ar-5')
  ok('① 坏 payload（缺标题）不出现', !cards.some(c => c.artefactId === 'ar-4'))
  ok('① 过期卡带 stale 标记', cards.find(c => c.artefactId === 'ar-5')?.stale === true)
  ok('① 草稿标「未审」（kept=false）', cards.every(c => c.kept === false))
  ok('① 来源标签取章名快照', cards[0].sourceLabel === '第一章 雪夜')

  const empty = buildReferenceBlock(cards, [])
  ok('🔴 ① 没勾选 ⇒ 空块（默认不发送）', empty.text === '' && empty.usedIds.length === 0)
  ok('① 空块也说明「默认不发送」', /未选择创作参考/.test(describeReferenceBlock(empty)))
}

// ---------- ② 过期与缺失 ----------
{
  const cards = [card(), card({ artefactId: 'stale-1', stale: true })]
  const block = buildReferenceBlock(cards, ['ar-1', 'stale-1', 'gone'])
  ok('② 过期卡被剔除且记原因', block.dropped.some(d => d.id === 'stale-1' && d.reason === 'stale'))
  ok('② 找不到的 id 记 missing', block.dropped.some(d => d.id === 'gone' && d.reason === 'missing'))
  ok('② 只发可用的那张', block.usedIds.join('|') === 'ar-1')
  ok('② 剔除原因写进摘要', /过期 1/.test(describeReferenceBlock(block)))
}

// ---------- ③ 顺序、预算与文本 ----------
{
  const a = card({ artefactId: 'a', title: 'A' })
  const b = card({ artefactId: 'b', title: 'B' })
  const ordered = buildReferenceBlock([a, b], ['b', 'a'])
  ok('③ 发送顺序 = 作者勾选顺序', ordered.text.indexOf('B') < ordered.text.indexOf('A'))
  ok('③ 编号从 1 连续', /1\. \[/.test(ordered.text) && /2\. \[/.test(ordered.text))

  const many = Array.from({ length: 20 }, (_, i) => card({ artefactId: `m${i}`, title: `T${i}` }))
  const capped = buildReferenceBlock(many, many.map(c => c.artefactId))
  ok('③ 张数受上限约束', capped.usedIds.length === REFERENCE_LIMITS.maxCards)
  ok('③ 超出张数的记 budget', capped.dropped.some(d => d.reason === 'budget'))

  const long = card({ artefactId: 'long', content: 'x'.repeat(2000) })
  const cut = buildReferenceBlock([long], ['long'], { maxCardChars: 200 })
  ok('③ 单卡正文按 maxCardChars 截断', cut.text.includes('x'.repeat(200)) && !cut.text.includes('x'.repeat(201)))

  const tiny = buildReferenceBlock([a, b], ['a', 'b'], { maxChars: 60 })
  ok('③ 总字数预算生效（后续卡被剔除）', tiny.dropped.some(d => d.reason === 'budget'))

  const text = buildReferenceBlock([card()], ['ar-1']).text
  ok('🔴 ③ 写明「非本项目原文」', text.includes('非本项目原文'))
  ok('🔴 ③ 写明「不要照搬情节 / 人名」', /不要照搬/.test(text) && /人物名/.test(text))
  ok('🔴 ③ 写明「不是设定 / 不是已发生的事实」', /不是本项目的设定|不是项目/.test(text) || /已经发生的事实/.test(text))
  ok('③ 带维度标签与来源', text.includes('场景与冲突') && text.includes('来源：第一章 雪夜'))
  ok('③ 未审卡有标记', buildReferenceBlock([card({ kept: false })], ['ar-1']).text.includes('未审'))
  ok('③ 维度中文映射（未知维度原样）', dimensionLabelOf('scene') === '场景与冲突' && dimensionLabelOf('xx') === 'xx')
}

// ---------- ④ 真实存储读取 ----------
{
  __resetMockStores()
  const pid = (await db.createProject('参考读取')).id
  const saved = await saveArtefacts(pid, store([art({ projectId: pid })]), undefined, [art({ projectId: pid })])
  ok('④ 先写入一条成果', saved.ok)

  const block = await referenceBlockForIds(['ar-1'], {}, pid)
  ok('④ 按 id 读得到并拼成块', block.usedIds.join('|') === 'ar-1' && block.text.length > 0)

  const none = await referenceBlockForIds([], {}, pid)
  ok('④ 空选择不读库、返回空块', none.text === '' && none.dropped.length === 0)

  const missing = await referenceBlockForIds(['nope'], {}, pid)
  ok('④ 不存在的 id 记 missing（不抛）', missing.text === '' && missing.dropped[0]?.reason === 'missing')
}

// ---------- ⑤ 接线闸 ----------
{
  const wf = read('src/lib/ai/aiWorkflow.ts')
  ok('⑤ 工作流按勾选读参考（referenceBlockForIds）', /referenceBlockForIds/.test(wf))
  ok('🔴 ⑤ 只有非空才传（不传空块）', /\.\.\.\(referenceText \? \{ referenceBlock: referenceText \} : \{\}\)/.test(wf))
  ok('⑤ 参考在探测项目后快照一次（三阶段共用）', /const referenceBlock = inp\.referenceIds/.test(wf) && /const referenceText = referenceBlock\?\.text/.test(wf))
  ok('⑤ 设定奠基阶段注入', /aiGenerateBible\(inp\.seed[\s\S]{0,400}referenceBlock: referenceText/.test(wf))
  ok('⑤ 大纲规划阶段注入', /aiPlanOutline\(material[\s\S]{0,400}referenceBlock: referenceText/.test(wf))
  ok('⑤ 逐章正文阶段注入', /runAutoContinue\([\s\S]{0,1200}referenceBlock: referenceText/.test(wf))

  const auto = read('src/lib/outline/autoContinue.ts')
  ok('🔴 ⑤ 提示词只在有参考块时插入', /\.\.\.\(opts\.referenceBlock \? \[opts\.referenceBlock, ''\] : \[\]\)/.test(auto))

  const types = read('src/lib/creative/sessionTypes.ts')
  ok('⑤ 输入类型有 referenceIds 且说明默认不勾选', /referenceIds\?: string\[\]/.test(types) && /默认.*不勾选/.test(types))

  const picker = read('src/components/creative/ReferencePicker.tsx')
  ok('⑤ 选择器不预选任何卡（受控于 selected）', !/useState<.*\[\]>?\(\[card/.test(picker) && /selected\.includes/.test(picker))
  // 3.6.0 审计：禁用条件扩成「过期 或 已排除」，断言改成检查这个合并判据本身
  ok('⑤ 过期卡禁用勾选', /const locked = c\.stale \|\| !!c\.excluded/.test(picker) && /disabled=\{locked\}/.test(picker))
  ok('⑤ 显示将发送量与剔除原因', /describeReferenceBlock/.test(picker))

  const tasks = read('src/lib/aiTasks/creative.ts')
  ok('⑤ 设定提示词把参考插在「一句话想法」之后', /const ref = opts\.referenceBlock/.test(tasks))
  ok('⑤ 大纲提示词把参考独立成段（不混进【资料】）', /const refBlock = opts\.referenceBlock/.test(tasks) && /\$\{refBlock\}/.test(tasks))

  const sources = read('src/lib/ai/aiDataSources.ts')
  ok('⑤ 数据来源表登记了「作品分析」', /'book-analysis':/.test(sources))
  ok('⑤ 创意写作登记了「创作参考（默认不勾选）」', /你勾选的创作参考（默认不勾选）/.test(sources))
  ok('⑤ 明确写了「不勾选就不发」', /不勾选，就一段都不发/.test(sources))
}

// ---------- ⑤-b 排除 ≠ 未审（3.6.0 审计修正） ----------
{
  const cards = referenceCardsOf(store([
    art({ id: 'ar-keep', state: 'kept' }),
    art({ id: 'ar-draft', state: 'draft' }),
    art({ id: 'ar-excluded', state: 'excluded' }),
  ]))
  const byId = new Map(cards.map(c => [c.artefactId, c]))
  ok('⑤-b 排除项带 excluded 标记', byId.get('ar-excluded')?.excluded === true)
  ok('⑤-b 未审项只有 kept:false，不算排除', byId.get('ar-draft')?.kept === false && !byId.get('ar-draft')?.excluded)

  const block = buildReferenceBlock(cards, ['ar-keep', 'ar-draft', 'ar-excluded'])
  ok('🔴 ⑤-b 作者排除的卡不会被发出去（即使被勾上）',
    !block.usedIds.includes('ar-excluded'), JSON.stringify(block.usedIds))
  ok('⑤-b 剔除原因写「已排除」', block.dropped.some(d => d.id === 'ar-excluded' && d.reason === 'excluded'))
  ok('⑤-b 未审卡仍然可以发（只是标注）', block.usedIds.includes('ar-draft'))
  ok('⑤-b 摘要里出现「已排除 N」', /已排除 1/.test(describeReferenceBlock(block)), describeReferenceBlock(block))

  const picker = read('src/components/creative/ReferencePicker.tsx')
  ok('🔴 ⑤-b 界面把已排除项设为不可勾选', /disabled=\{locked\}/.test(picker) && /已排除（不可选）/.test(picker))
}

// ---------- ⑥ 发送记录：实际发出的是什么 ----------
{
  __resetMockStores()
  const pid = (await db.createProject('发送记录')).id

  const w = await appendReferenceSend(pid, {
    stage: 'draft', usedIds: ['ar-1'], dropped: [{ id: 'ar-9', reason: 'stale' }],
    text: '【创作参考（作者选定，非本项目原文）】\n1. [场景与冲突] …', chars: 120, channel: 'acp',
    taskId: 't-1',
  })
  ok('⑥ 写入成功', w.ok)
  const loaded = await loadReferenceSends(pid)
  ok('⑥ 读回一条且字段齐全', loaded.list.length === 1
    && loaded.list[0].stage === 'draft' && loaded.list[0].channel === 'acp' && loaded.list[0].taskId === 't-1')
  ok('⑥ 记录里存的是**实际注入的文字**', loaded.list[0].text.includes('非本项目原文'))
  ok('⑥ 剔除原因一起存', loaded.list[0].dropped[0]?.reason === 'stale')

  ok('⑥ 空文本拒写（没发就不该有记录）',
    !(await appendReferenceSend(pid, { stage: 'bible', usedIds: [], dropped: [], text: '   ', chars: 0, channel: 'api' })).ok)

  // 滚动上限
  for (let i = 0; i < REFERENCE_LOG_LIMIT + 5; i++) {
    await appendReferenceSend(pid, {
      stage: 'outline', usedIds: [], dropped: [], text: `t${i}`, chars: 2, channel: 'api', at: 1000 + i,
    })
  }
  const capped = await loadReferenceSends(pid)
  ok('⑥ 只留最近 50 条', capped.list.length === REFERENCE_LOG_LIMIT)
  ok('⑥ 按时间倒序（新的在前）', capped.list.every((r, i) => i === 0 || capped.list[i - 1].at >= r.at))
  ok('⑥ 最新写入的那条在列表里', capped.list.some(r => r.text === `t${REFERENCE_LOG_LIMIT + 4}`))

  ok('⑥ 单条文字过长会被截断（不无限膨胀）', (await (async () => {
    await appendReferenceSend(pid, { stage: 'draft', usedIds: [], dropped: [], text: 'x'.repeat(5000), chars: 5000, channel: 'api' })
    const l = await loadReferenceSends(pid)
    return l.list[0].text.length <= 2600
  })()))

  ok('⑥ 空项目读回空列表', (await loadReferenceSends('')).list.length === 0)
  ok('⑥ 「已发出无法撤回」有固定说明', /无法撤回/.test(REFERENCE_SENT_NOTE))
}

// ---------- ⑦ 发送记录接线 ----------
{
  const wf = read('src/lib/ai/aiWorkflow.ts')
  ok('⑦ 三个阶段都写发送记录', ['bible', 'outline', 'draft'].every(st => new RegExp(`noteReferenceSent\\('${st}'`).test(wf)))
  ok('⑦ 通道按该阶段实际 ACP 判断（连写用 acpContinue）', /noteReferenceSent\('draft', acpContinue \? 'acp' : 'api'\)/.test(wf))
  ok('⑦ 记录在请求之前写（失败也算发出过）', /await noteReferenceSent\('outline'[\s\S]{0,120}aiPlanOutline\(/.test(wf))
  ok('🔴 ⑦ 写记录失败不挡写作', /\.catch\(\(\) => undefined\)/.test(wf))

  const picker = read('src/components/creative/ReferencePicker.tsx')
  ok('⑦ 界面可回看实际发送的文字', /loadReferenceSends/.test(picker) && /看实际发送的文字/.test(picker))
  ok('⑦ 界面显示阶段 / 张数 / 字数 / 通道', /REFERENCE_STAGE_LABEL/.test(picker) && /r\.channel === 'acp'/.test(picker))
  ok('⑦ 界面写明「已发出无法撤回」', /REFERENCE_SENT_NOTE/.test(picker))
}

console.log(`\n———— creativeReference：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
