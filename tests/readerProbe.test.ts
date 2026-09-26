// ============ C5（2.4.2）读者视角审问 ============
//
// 这一层最怕的三种静默失败：
//   ① 模型没按结构回（或回了数组）时**整份结果变空白** —— 作者以为"AI 什么都没说"，
//      实际是解析层把内容丢了。必须留 `raw` 兜底。
//   ② 引文定位到错的地方：读者说"这里走神"，标出来的段号却是另一段 —— 比标不出来更糟。
//   ③ 滑回"审稿腔"：本该是「有人读到这里会走神」，写成「建议修改此处句式」。
//      由立场断言守（直接读源码，所以**连注释里都不能出现那些词**）。
import { readFileSync } from 'node:fs'
import {
  groupNotes, paragraphAt, parseReaderProbe, readerLensOf, readerProbeToText,
  READER_LENSES, READER_QUESTIONS,
} from '../src/lib/readerProbe'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ readerProbe')

// ---------- 1. 三问与三档视角的完整性 ----------
{
  ok('三个固定问题齐全（看不下去 / 没看懂 / 最想知道什么）',
    READER_QUESTIONS.length === 3 && ['bored', 'lost', 'want'].every(k => READER_QUESTIONS.some(q => q.key === k)),
    READER_QUESTIONS.map(q => q.key).join(','))
  ok('每个问题都有具体问法（不是只有标题）',
    READER_QUESTIONS.every(q => q.ask.length >= 15 && q.label.length >= 4))
  ok('三档读者视角 + 写作导师（D1）齐全', READER_LENSES.length === 4, READER_LENSES.map(l => l.key).join(','))
  ok('每个视角都写了「你是谁」与「最在意什么」',
    READER_LENSES.every(l => l.brief.length >= 20 && l.care.length >= 10))
  ok('readerLensOf 认未知 key 时兜底到第一个（不返回 undefined）',
    readerLensOf('不存在的').key === READER_LENSES[0].key)
}

// ---------- 2. paragraphAt：段号换算 ----------
{
  const text = '第一段。\n第二段。\n第三段。'
  ok('段首位置 → 对应段号', paragraphAt(text, 0) === 1 && paragraphAt(text, 5) === 2, `${paragraphAt(text, 5)}`)
  ok('段中位置 → 仍是该段号', paragraphAt(text, 2) === 1 && paragraphAt(text, 7) === 2)
  ok('🔴 未定位（-1）→ 0，而不是 1（0 表示"查不到"，别伪装成第一段）', paragraphAt(text, -1) === 0)
  ok('超范围下标 → 0', paragraphAt(text, 999) === 0)
}

// ---------- 3. parseReaderProbe：结构解析 + 本地定位 ----------
{
  const text = '风起了。\n他握紧了剑。\n远处的城门缓缓打开。'

  const good = JSON.stringify({
    notes: [
      { q: 'bored', quote: '他握紧了剑。', comment: '到这里我有点想快进。' },
      { q: 'lost', quote: '风起了。', comment: '没交代风起意味着什么。' },
      { q: 'want', quote: '远处的城门缓缓打开。', comment: '我想知道门后是谁。' },
    ],
    summary: '会点下一章，因为门后面的事还没说。',
  })
  const r = parseReaderProbe(good, text)
  ok('三条意见都解析出来', r.notes.length === 3, `${r.notes.length}`)
  ok('🔴 引文定位到正确段号（1 / 2 / 3）',
    r.notes.map(n => n.paragraph).sort().join(',') === '1,2,3',
    r.notes.map(n => `${n.q}:${n.paragraph}`).join(' '))
  ok('summary 解析出来', r.summary.includes('下一章'), r.summary)
  ok('正常解析时 raw 为空（不重复展示）', r.raw === '')

  // 模型直接回数组（无外层对象）
  const arr = JSON.stringify([
    { q: 'lost', quote: '风起了。', comment: '不知道风起是什么意思。' },
  ])
  const r2 = parseReaderProbe(arr, text)
  ok('兼容「模型直接回数组」', r2.notes.length === 1 && r2.notes[0].paragraph === 1,
    `${r2.notes.length} seg=${r2.notes[0]?.paragraph}`)

  // 🔴 完全解析不出来 → 原文兜底（不静默丢）
  const junk = '这一章读起来挺顺的，就是节奏有点慢，我看到中间有点走神。'
  const r3 = parseReaderProbe(junk, text)
  ok('🔴 解析失败时把原文整段兜住（而不是给一个空白结果）',
    r3.notes.length === 0 && r3.raw.includes('走神'), r3.raw.slice(0, 20))

  // 问题 key 归一化：模型写中文/近义也要认
  const loose = JSON.stringify({
    notes: [
      { q: '看不下去', quote: '风起了。', comment: '这里想跳。' },
      { q: '没看懂', quote: '他握紧了剑。', comment: '为什么握剑？' },
      { q: '想知道后面', quote: '远处的城门缓缓打开。', comment: '门后是谁？' },
    ],
  })
  const r4 = parseReaderProbe(loose, text)
  ok('问题 key 归一化（中文近义 → bored/lost/want）',
    r4.notes.map(n => n.q).sort().join(',') === 'bored,lost,want',
    r4.notes.map(n => n.q).join(','))

  // 🔴 引文被模型改写几个字：只截前 12 字兜底匹配，仍要能定位
  const fuzzy = JSON.stringify({
    notes: [{ q: 'want', quote: '远处的城门慢慢打开了。', comment: '想知道门后。' }],
  })
  const r5 = parseReaderProbe(fuzzy, text)
  ok('🔴 引文被改写 → 兜底匹配仍能定位（或明确未定位，不指错处）',
    r5.notes[0].paragraph === 3 || r5.notes[0].paragraph === 0,
    `seg=${r5.notes[0].paragraph}`)

  // 编造的引文（正文里没有）→ 未定位，但意见本身保留
  const fake = JSON.stringify({
    notes: [{ q: 'bored', quote: '这段话正文里根本没有出现过。', comment: '无聊。' }],
  })
  const r6 = parseReaderProbe(fake, text)
  ok('🔴 正文里找不到的引文 → 标「未定位」但**不丢这条意见**',
    r6.notes.length === 1 && r6.notes[0].paragraph === 0, `seg=${r6.notes[0].paragraph}`)

  // 没引文（读者只是说"这一章没问题"）→ 也是合法一条
  const noQuote = JSON.stringify({ notes: [{ q: 'bored', quote: '', comment: '这章没让我走神。' }] })
  const r7 = parseReaderProbe(noQuote, text)
  ok('没有引文的意见也是合法一条（quote 空 = 未定位）',
    r7.notes.length === 1 && r7.notes[0].quote === '' && r7.notes[0].paragraph === 0)
}

// ---------- 4. groupNotes：三组都在（空组保留，让作者看到"这项没意见"） ----------
{
  const text = '甲。\n乙。'
  const r = parseReaderProbe(JSON.stringify({
    notes: [{ q: 'bored', quote: '甲。', comment: '一般。' }],
  }), text)
  const groups = groupNotes(r.notes)
  ok('恒返回三组（空组保留）', groups.length === 3, `${groups.length}`)
  ok('空组 items 为空数组', groups.filter(g => g.items.length === 0).length === 2)
  ok('非空组带上正确的标签', groups.find(g => g.items.length > 0)?.q.label === '哪里看不下去')
}

// ---------- 5. 导出文本：可复制、含段号、未定位要说出来 ----------
{
  const text = '甲。\n乙。\n丙。'
  const r = parseReaderProbe(JSON.stringify({
    notes: [
      { q: 'bored', quote: '乙。', comment: '这里想跳。' },
      { q: 'lost', quote: '正文里没有的句子', comment: '没看懂。' },
    ],
    summary: '还行。',
  }), text)
  const out = readerProbeToText(r, '第1章 风起', '追更读者')
  ok('导出文本含章节名与读者身份', out.includes('第1章 风起') && out.includes('追更读者'))
  ok('导出文本含段号', out.includes('第 2 段'), out.split('\n').find(l => l.includes('段'))?.slice(0, 30))
  ok('导出文本对未定位的明确写「未定位」', out.includes('未定位'))
  ok('没意见的那一组在导出文本里也写明（不是空白）', out.includes('（读者没提这一项）'))
}

// ---------- 6. D1（2.5.1）写作导师：自带问题集 ----------
{
  const mentor = readerLensOf('mentor')
  const mqs = mentor.questions ?? []
  const text = '风起了。\n他握紧了剑。\n远处的城门缓缓打开。'

  ok('导师身份存在且带自己的问题集', mentor.key === 'mentor' && mqs.length === 4, mqs.map(q => q.key).join(','))
  ok('导师四问：主题句 / 核心冲突 / 人物弧光 / 代价',
    mqs.map(q => q.key).join(',') === 'theme,conflict,arc,cost')
  ok('读者三问的 lens 不带自定义问题集（缺省走 READER_QUESTIONS，行为零变化）',
    READER_LENSES.filter(l => l.key !== 'mentor').every(l => !l.questions))

  // 解析：导师模式下认四问 key；按 mentor 的问题集分组
  const good = JSON.stringify({
    notes: [
      { q: 'theme', quote: '风起了。', comment: '主题在这里立住了一半。' },
      { q: 'cost', quote: '他握紧了剑。', comment: '代价还没显出来。' },
      { q: 'conflict', quote: '远处的城门缓缓打开。', comment: '冲突偏口头。' },
      { q: 'arc', quote: '他握紧了剑。', comment: '变化落在这个动作上。' },
    ],
    summary: '骨架在，代价感不足。',
  })
  const rm = parseReaderProbe(good, text, mqs)
  ok('导师模式：四条意见的 key 原样认出（不落回 bored）',
    rm.notes.every(n => mqs.some(q => q.key === n.q)), rm.notes.map(n => n.q).join(','))
  const gm = groupNotes(rm.notes, mqs)
  ok('导师模式：分组按四问顺序、每组各归其位',
    gm.map(g => g.q.key).join(',') === 'theme,conflict,arc,cost'
    && gm.every(g => g.items.length === 1))
  const outM = readerProbeToText(rm, '第1章', '写作导师', mqs)
  ok('导师模式：导出文本含四问 label', ['主题句', '核心冲突', '人物弧光', '代价'].every(s => outM.includes(s)))

  // 兜底：认不出的 key 落到问题集第一个（导师 = theme；读者三问 = bored，与旧行为一致）
  const weird = JSON.stringify({ notes: [{ q: '莫名其妙', quote: '风起了。', comment: '说不上来。' }], summary: '' })
  ok('导师模式：认不出的 key 兜底到第一问（theme）',
    parseReaderProbe(weird, text, mqs).notes[0].q === 'theme')
  ok('读者三问：认不出的 key 兜底到第一问（bored，旧行为不变）',
    parseReaderProbe(weird, text).notes[0].q === 'bored')

  // 🔴 读者三问路径零回归：不传问题集时，解析与分组结果与 D1 之前完全一致
  const legacy = JSON.stringify({
    notes: [
      { q: 'bored', quote: '他握紧了剑。', comment: '想快进。' },
      { q: 'lost', quote: '风起了。', comment: '没看懂。' },
      { q: 'want', quote: '远处的城门缓缓打开。', comment: '想知道门后是谁。' },
    ],
    summary: '会点下一章。',
  })
  const rl = parseReaderProbe(legacy, text)
  const gl = groupNotes(rl.notes)
  ok('🔴 读者三问零回归：分组仍是三组、key 照旧、每组一条',
    gl.length === 3 && gl.map(g => g.q.key).join(',') === 'bored,lost,want' && gl.every(g => g.items.length === 1))
}

// ---------- 7. 🔴 立场与技术约定（读源码全文） ----------
{
  const read = (p: string) => {
    try { return readFileSync(p, 'utf8') } catch { return '' }
  }
  const srcLocal = read('src/lib/readerProbe.ts')
  const srcTask = read('src/lib/aiTasks/readerProbe.ts')
  const srcPanel = read('src/components/ReaderProbePanel.tsx')

  const banned = ['规避检测', '降低AI命中', '降低 AI 命中', '命中率', '反检测', 'AI率', 'AI 率', '洗稿', '合格', '过审']
  for (const [name, src] of [['readerProbe.ts', srcLocal], ['aiTasks/readerProbe.ts', srcTask], ['ReaderProbePanel.tsx', srcPanel]] as const) {
    const hit = banned.filter(w => src.includes(w))
    ok(`🔴 立场：${name} 不含反检测/通过与否类表述`, hit.length === 0, hit.join('/'))
  }

  ok('提示词要求「扮演」驱动（而不是评估腔）', srcTask.includes('扮演') && srcTask.includes('按用户消息里给你的身份'))
  ok('提示词明确要求 quote 逐字照抄（段号靠它算）', srcTask.includes('逐字照抄') || srcTask.includes('逐字照抄原文'))
  ok('提示词明确「不评分、不给等级、不排名」', srcTask.includes('不评分') && srcTask.includes('不给等级'))
  ok('🔴 问题措辞只有一处源：任务文件经 questionsOf 取问题集，不重抄一份',
    srcTask.includes('questionsOf(lens)') && !srcTask.includes('哪里看不下去：'))
  ok('面板注明了段号由本地算（不是模型报的）', srcPanel.includes('段号') && srcPanel.includes('本地'))
  ok('面板对「未定位」有显式展示分支', srcPanel.includes('未定位'))
  ok('提示词已在门面登记（否则设置页看不到它）',
    read('src/lib/aiTasks.ts').includes("'reader-probe'"))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
