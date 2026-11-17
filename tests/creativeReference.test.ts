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
  ok('⑤ 参考只作用于「写正文」阶段', /flow\.on\('draft'[\s\S]{0,1200}referenceBlockForIds/.test(wf))

  const auto = read('src/lib/outline/autoContinue.ts')
  ok('🔴 ⑤ 提示词只在有参考块时插入', /\.\.\.\(opts\.referenceBlock \? \[opts\.referenceBlock, ''\] : \[\]\)/.test(auto))

  const types = read('src/lib/creative/sessionTypes.ts')
  ok('⑤ 输入类型有 referenceIds 且说明默认不勾选', /referenceIds\?: string\[\]/.test(types) && /默认.*不勾选/.test(types))

  const picker = read('src/components/creative/ReferencePicker.tsx')
  ok('⑤ 选择器不预选任何卡（受控于 selected）', !/useState<.*\[\]>?\(\[card/.test(picker) && /selected\.includes/.test(picker))
  ok('⑤ 过期卡禁用勾选', /disabled=\{c\.stale\}/.test(picker))
  ok('⑤ 显示将发送量与剔除原因', /describeReferenceBlock/.test(picker))

  const sources = read('src/lib/ai/aiDataSources.ts')
  ok('⑤ 数据来源表登记了「作品分析」', /'book-analysis':/.test(sources))
  ok('⑤ 创意写作登记了「创作参考（默认不勾选）」', /你勾选的创作参考（默认不勾选）/.test(sources))
  ok('⑤ 明确写了「不勾选就不发」', /不勾选，就一段都不发/.test(sources))
}

console.log(`\n———— creativeReference：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
