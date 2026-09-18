// ============ 原文切分的回归用例 ============
//
// split.ts 是纯函数，零 AI 依赖 —— 正因为纯，它的错误最容易被忽略：
// 切错了不会报错，只会让后续「抽取」少抽几章、或把标题混进正文。
// 更危险的是 charStart/charEnd 算错：抽取出的实体带原文引用，引用核对靠它回定位，
// 算了错区间就会把「原文有据」判成「无据」，置信度静默掉档。
import { chunkText, cnToNum, estTokens, splitNovelText } from '../src/lib/bookbreak/split'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- ① 中文数字归一 ----------
ok('中文数字：一 → 1', cnToNum('一') === 1, String(cnToNum('一')))
ok('中文数字：十 → 10（单独出现按 10 算）', cnToNum('十') === 10, String(cnToNum('十')))
ok('中文数字：十八 → 18', cnToNum('十八') === 18, String(cnToNum('十八')))
ok('中文数字：二十 → 20', cnToNum('二十') === 20, String(cnToNum('二十')))
ok('中文数字：三十一 → 31', cnToNum('三十一') === 31, String(cnToNum('三十一')))
ok('中文数字：壹佰 → 100（大写）', cnToNum('壹佰') === 100, String(cnToNum('壹佰')))
ok('中文数字：两千一百 → 2100', cnToNum('两千一百') === 2100, String(cnToNum('两千一百')))
ok('阿拉伯数字直通：123 → 123', cnToNum('123') === 123, String(cnToNum('123')))
ok('空串 → NaN', Number.isNaN(cnToNum('')))
ok('estTokens：2 个汉字 → 2', estTokens('你好') === 2, String(estTokens('你好')))

// ---------- ② 章节识别（主流格式） ----------
{
  const raw = [
    '第1章 风起云州',
    '云州城外，少年负剑而行。',
    '',
    '第二章 剑鸣中州',
    '剑光如练，照彻长夜。',
    '',
    'Chapter 3',
    'Later that night, the gate opened.',
    '',
    '卷一 大争之世',
    '天下大势，浩浩汤汤。',
  ].join('\n')
  const r = splitNovelText(raw)
  ok('章节模式：识别出 4 章', r.mode === 'chapters' && r.chapters.length === 4, `${r.mode}/${r.chapters.length}`)
  ok('章节标题保留原样', r.chapters[0].title === '第1章 风起云州', r.chapters[0].title)
  ok('中文数字章节标题被识别', r.chapters[1].title === '第二章 剑鸣中州', r.chapters[1].title)
  ok('Chapter N 被识别', r.chapters[2].title === 'Chapter 3', r.chapters[2].title)
  ok('「卷X」被识别', r.chapters[3].title === '卷一 大争之世', r.chapters[3].title)
  ok('正文不含标题行', !r.chapters[0].text.includes('第1章'), r.chapters[0].text)
  ok('正文取到本章内容', r.chapters[0].text.includes('少年负剑而行'), r.chapters[0].text)
  ok('下一章正文不串进上一章', !r.chapters[0].text.includes('剑光如练'))
  ok('章序号 1 起且连续', r.chapters.map(c => c.index).join(',') === '1,2,3,4', r.chapters.map(c => c.index).join(','))
  ok('索引号正确', r.chapters[0].index === 1, String(r.chapters[0].index))
}

// ---------- ③ charStart/charEnd 能回定位到原文（引用核对靠它） ----------
{
  const raw = '第1章 甲\n正文一。\n第2章 乙\n正文二。\n'
  const r = splitNovelText(raw)
  ok('🔴 charStart/charEnd 区间的原文包含该章标题',
    raw.slice(r.chapters[0].charStart, r.chapters[0].charEnd).includes('第1章 甲'))
  ok('🔴 charStart/charEnd 区间的原文包含该章正文',
    raw.slice(r.chapters[1].charStart, r.chapters[1].charEnd).includes('正文二'))
  ok('相邻两章区间不重叠', r.chapters[1].charStart >= r.chapters[0].charEnd,
    `${r.chapters[0].charEnd} vs ${r.chapters[1].charStart}`)
}

// ---------- ④ 无章节标题 → 兜底分块 ----------
{
  const para = '这是一段没有章节标题的连续叙述。'.repeat(30)
  const raw = [para, para, para, para].join('\n\n')
  const r = splitNovelText(raw, { chunkTokens: 300 })
  ok('无章节 → chunks 模式', r.mode === 'chunks', r.mode)
  ok('无章节 → 至少切出 2 块', r.chapters.length >= 2, String(r.chapters.length))
  ok('兜底块标题形如「第N段」', /^第\d+段$/.test(r.chapters[0].title), r.chapters[0].title)
  ok('兜底块正文非空', r.chapters.every(c => c.text.trim().length > 0))
}

// ---------- ⑤ 只有 1 个章节标题时退化为分块（1 章说明多半是标题误判） ----------
{
  const raw = '第1章 唯一一章\n' + '正文字数很少。'.repeat(60)
  const r = splitNovelText(raw, { chunkTokens: 300 })
  ok('只识别到 1 个标题 → 退化为分块（≥2 才算章节结构）', r.mode === 'chunks', `${r.mode}/${r.chapters.length}`)
}

// ---------- ⑥ maxChunks 截断 + truncated 标记（界面必须据此提示用户） ----------
{
  const raw = Array.from({ length: 12 }, (_, i) => `第${i + 1}章 标题${i + 1}\n正文内容${i + 1}。`).join('\n')
  const r = splitNovelText(raw, { maxChunks: 5 })
  ok('maxChunks 生效：只留前 5 章', r.chapters.length === 5, String(r.chapters.length))
  ok('🔴 截断时置 truncated=true（否则用户以为整本都抽了）', r.stats.truncated === true, String(r.stats.truncated))
  ok('未截断时不置 truncated', splitNovelText(raw).stats.truncated === false)
}

// ---------- ⑦ 兜底分块的重叠（避免实体正好落在切缝上被漏抽） ----------
{
  const text = Array.from({ length: 40 }, (_, i) => `第${i}行内容内容内容。`).join('\n')
  const chunks = chunkText(text, { chunkTokens: 120, overlapTokens: 40 })
  ok('分块数 ≥ 2', chunks.length >= 2, String(chunks.length))
  let overlapped = false
  for (let i = 1; i < chunks.length; i++) if (chunks[i].start < chunks[i - 1].end) overlapped = true
  ok('相邻块存在重叠（有重叠才会重复覆盖切缝）', overlapped)
  ok('每块区间切回原文等于该块文本',
    chunks.every(c => text.slice(c.start, c.end) === c.text))
}

// ---------- ⑧ 空 / 极短输入不炸 ----------
{
  ok('空串 → 0 章不抛错', splitNovelText('').chapters.length === 0)
  const tiny = splitNovelText('很短。')
  ok('极短文本 → 0 章或 1 块，不抛错', tiny.chapters.length <= 1, String(tiny.chapters.length))
}

console.log(`\n—— bookbreakSplit 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
