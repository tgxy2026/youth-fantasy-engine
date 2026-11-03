/**
 * 拆书 · AI 章节切分核对层单测（2.6.1 · R2）
 * 覆盖：采样组装 / applyAiSplit 严格采信（逐字命中 → 采信；编造行 → 弃用）/ 重建口径与本地切分一致
 */
import assert from 'node:assert/strict'
import { sampleTextForSplit, applyAiSplit } from '../src/lib/bookbreak/aiSplit'
import { splitNovelText } from '../src/lib/bookbreak/split'

// 构造一篇「非标标题」原文：正则认不出，但人类一眼能看出章节
const chap = (no: number) => `${String(no).padStart(2, '0')}|第${no}章风雨`
// ⚠️ 每章 14 段而非更少：applyAiSplit 有 MIN_GAP=200（相邻章起点的最小字符间距，
// 防 AI 密集误报的现实防御参数）。段数太少时章间距会跌破 200，合法短章被间距闸
// 静默丢弃 —— 那是测试数据尺度失真，不是实现缺陷（真实章节远长于 200 字符）。
const body = (no: number) => Array.from({ length: 14 }, (_, i) => `这是第${no}章的第${i + 1}段正文，讲一些剧情。`).join('\n')
const RAW = Array.from({ length: 5 }, (_, i) => `${chap(i + 1)}\n${body(i + 1)}`).join('\n\n')

// ---------- ① 采样：短文原样返回 ----------
{
  const short = '很短的一段'
  assert.equal(sampleTextForSplit(short), short, '短文应原样返回')
}

// ---------- ② 采样：长文被截断并带省略标记 ----------
{
  const long = Array.from({ length: 2000 }, (_, i) => `第${i}段内容。`).join('\n')
  const s = sampleTextForSplit(long)
  assert.ok(s.length < long.length, '长文采样应比原文短')
  assert.ok(s.includes('……'), '采样应带省略标记')
}

// ---------- ③ 本地正则先跑：非标标题确实认不出（回归基线） ----------
{
  const local = splitNovelText(RAW)
  assert.equal(local.mode, 'chunks', '非标标题应落入字数兜底（现状行为）')
}

// ---------- ④ applyAiSplit：AI 逐字报对 → 采信，重建 5 章 ----------
{
  const lines = [chap(1), chap(2), chap(3), chap(4), chap(5)]
  const r = applyAiSplit(RAW, lines)
  assert.ok(r, '逐字命中应采信')
  assert.equal(r!.mode, 'chapters')
  assert.equal(r!.chapters.length, 5, `应重建 5 章，实际 ${r!.chapters.length}`)
  assert.equal(r!.chapters[0].title, chap(1))
  // 回定位正确：第 2 章的正文里应含第 2 章的句子
  assert.ok(r!.chapters[1].text.includes('第2章的第1段正文'), '正文区间应落在对应章内')
}

// ---------- ⑤ applyAiSplit：AI 编造原文没有的行 → 弃用（防幻觉闸） ----------
{
  const fake = applyAiSplit(RAW, ['第九十九章 绝不存在', '第一百章 也是编的'])
  assert.equal(fake, null, '编造行必须整体弃用')
}

// ---------- ⑥ applyAiSplit：混合（2 行真实 + 1 行编造）→ 真实行仍采信 ----------
{
  const r = applyAiSplit(RAW, [chap(1), chap(3), '不存在的行 XX'])
  assert.ok(r, '真实命中的行应采信（编造行只是被忽略）')
  assert.equal(r!.chapters.length, 2, `应重建 2 章，实际 ${r!.chapters.length}`)
}

// ---------- ⑦ applyAiSplit：前缀匹配兜底（AI 漏抄行尾）→ 仍采信 ----------
{
  const r = applyAiSplit(RAW, [chap(1).slice(0, 4), chap(2).slice(0, 4)]) // 「00|第」「01|第」前缀
  // 前缀「00|第」其实是 chap(1) 的前 4 字 —— 行以它开头即命中
  assert.ok(r, '前缀兜底应采信')
  assert.ok(r!.chapters.length >= 2, `前缀应命中 ≥2 章，实际 ${r!.chapters.length}`)
}

// ---------- ⑧ applyAiSplit：空数组 / 单行 → 弃用 ----------
{
  assert.equal(applyAiSplit(RAW, []), null, '空数组弃用')
  assert.equal(applyAiSplit(RAW, [chap(1)]), null, '单行不足 2 章弃用')
}

// ---------- ⑨ 标准标题文本：本地正则已命中时根本不该走 AI（口径提示：面板会显示） ----------
{
  const std = Array.from({ length: 3 }, (_, i) => `第${i + 1}章 标准标题\n${body(i + 1)}`).join('\n\n')
  const local = splitNovelText(std)
  assert.equal(local.mode, 'chapters', '标准标题本地就该命中（面板据此提示「示例不会被用到」）')
  // 同一文本 AI 重建口径也应一致
  const ai = applyAiSplit(std, ['第1章 标准标题', '第2章 标准标题', '第3章 标准标题'])
  assert.equal(ai!.chapters.length, 3)
  assert.equal(ai!.chapters[0].text, local.chapters[0].text, '重建口径应与本地切分一致')
}

// ---------- ⑩ 采样预算（2026-10-10 六维审计 P2）：传 budget 时四段按比例缩放 ----------
{
  const long = Array.from({ length: 3000 }, (_, i) => `第${i}段正文内容。`).join('\n')
  const dflt = sampleTextForSplit(long)
  const half = sampleTextForSplit(long, 3750)
  const big = sampleTextForSplit(long, 15000)
  assert.ok(half.length < dflt.length, '预算减半 → 采样应更短（登记系数真的生效了）')
  assert.ok(big.length > dflt.length, '预算加倍 → 采样应更长（接大窗口模型时能跟着放大）')
  assert.ok(half.includes('……') && big.includes('……'), '缩放后仍保留省略标记')
  // 不传 budget 必须与出厂口径完全一致（向后兼容，升级后默认行为一个字都不变）
  assert.equal(sampleTextForSplit(long), sampleTextForSplit(long, 7500), '不传应等价于出厂 7500')
}

console.log('✅ bookbreak-ai-split 全部通过（10 组断言）')
