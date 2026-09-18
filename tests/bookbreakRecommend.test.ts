// ============ 拆书「导入量 / 耗时」推荐的回归用例 ============
//
// 口径是这个模块的核心，必须被测试钉住（老大 2026-09-18 需求原话是「按模型处理能力推荐导入数据量」）：
// 拆书是**逐章抽取**，单次只喂一章 → **导入量不会撞模型窗口**；真正受限的是**调用次数与耗时**。
// 所以断言不测"最多能喂多少字"，只测「调用次数 / 耗时 / 推荐值 / 分级」是否算对。
import { adviseImport, COMFORT_CALLS, HARD_CALLS } from '../src/lib/bookbreak/recommend'
import { splitNovelText, type SplitResult } from '../src/lib/bookbreak/split'
import { adviseCapacity } from '../src/lib/modelCapacity'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const LOCAL = adviseCapacity({ type: 'ollama', model: 'qwen3.5-27b' }, { numCtx: 32768, contextBudget: 24000 })
const CLOUD = adviseCapacity({ type: 'openai', local: false, model: 'Qwen/Qwen3.5-35B-A3B' }, { numCtx: 32768, contextBudget: 24000 })

function mkSplit(chapters: number, charsPerChapter: number, truncated = false): SplitResult {
  const chapters_ = Array.from({ length: chapters }, (_, i) => ({
    index: i + 1, title: `第${i + 1}章`, text: '字'.repeat(charsPerChapter), charStart: 0, charEnd: charsPerChapter,
  }))
  return {
    chapters: chapters_, mode: 'chapters',
    stats: { count: chapters, chars: chapters * charsPerChapter, estTokens: chapters * charsPerChapter, truncated },
  }
}

// ---------- ① 小体量：放心跑 ----------
{
  const sp = mkSplit(10, 3000)
  const a = adviseImport(sp, LOCAL)
  ok('10 章 × 3000 字 → 调用次数 = 10（每章一次）', a.calls === 10, String(a.calls))
  ok('  · 分级 ok', a.level === 'ok', a.level)
  ok('  · 平均章字数 = 3000', a.avgChapterChars === 3000, String(a.avgChapterChars))
  ok('  · 推荐字数 = 舒适次数 × 平均章字数', a.recommendedChars === COMFORT_CALLS * 3000, String(a.recommendedChars))
  ok('  · 推荐章数 = 舒适次数', a.recommendedChapters === COMFORT_CALLS, String(a.recommendedChapters))
  ok('  · 文案说明了「不受模型窗口限制」', a.note.includes('不受模型窗口限制'), a.note)
}

// ---------- ② 超长单章会被拆成多次调用（每 4000 字一次）----------
{
  const sp = mkSplit(3, 10000)
  const a = adviseImport(sp, LOCAL)
  ok('3 章 × 1 万字 → 每章拆 3 次 = 9 次调用', a.calls === 9, String(a.calls))
}

// ---------- ③ 大体重：建议先试跑 ----------
{
  const sp = mkSplit(COMFORT_CALLS + 10, 3000)
  const a = adviseImport(sp, CLOUD)
  ok(`超过舒适线（${COMFORT_CALLS} 次）→ 分级 large`, a.level === 'large', a.level)
  ok('  · 文案建议先跑 5~10 万字', a.note.includes('5~10 万字'), a.note)
}

// ---------- ④ 超硬顶：会被截断，必须说清 ----------
{
  const sp = mkSplit(HARD_CALLS + 30, 3000)
  const a = adviseImport(sp, LOCAL)
  ok(`调用次数被钳到硬顶 ${HARD_CALLS}`, a.calls === HARD_CALLS, String(a.calls))
  ok('  · 分级 too-large', a.level === 'too-large', a.level)
  ok('  · 文案提示要拆成几份', a.note.includes('拆成几份'), a.note)
}
{
  const sp = mkSplit(5, 3000, /* truncated */ true)
  ok('切分被截断（truncated）也判 too-large', adviseImport(sp, LOCAL).level === 'too-large')
}

// ---------- ⑤ 本地比云端慢（耗时区间更宽），且都是分钟量级 ----------
{
  const sp = mkSplit(20, 3000)
  const l = adviseImport(sp, LOCAL)
  const c = adviseImport(sp, CLOUD)
  ok('本地耗时区间下界 ≥ 云端', l.minutes[0] >= c.minutes[0], `本地 ${l.minutes} / 云端 ${c.minutes}`)
  ok('  两者都给出了正整数分钟区间', l.minutes[0] >= 1 && c.minutes[1] >= 1, `${l.minutes} / ${c.minutes}`)
  ok('  模型描述取自模型能力推算（不是写死的）', l.model.length > 0 && c.model.length > 0 && l.model !== c.model,
    `${l.model} | ${c.model}`)
}

// ---------- ⑥ 空输入不炸 ----------
{
  const empty: SplitResult = { chapters: [], mode: 'chapters', stats: { count: 0, chars: 0, estTokens: 0, truncated: false } }
  const a = adviseImport(empty, LOCAL)
  ok('空切分 → 0 次调用且不抛错', a.calls === 0 && a.level === 'ok', `${a.calls}/${a.level}`)
}

// ---------- ⑦ 端到端：真实切分文本走一遍 ----------
{
  const text = Array.from({ length: 12 }, (_, i) => `第${i + 1}章 标题${i + 1}\n${'正文内容。'.repeat(200)}`).join('\n')
  const sp = splitNovelText(text)
  const a = adviseImport(sp, CLOUD)
  ok('真实文本：调用次数 = 识别出的章数', a.calls === sp.chapters.length, `${a.calls} vs ${sp.chapters.length}`)
}

console.log(`\n—— bookbreakRecommend 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
