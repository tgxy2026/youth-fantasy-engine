// ============ 2.9.2 · ② 选区改稿的「要求」拼装（lib/rewriteAsk.ts） ============
//
// 覆盖：动作单行 / 动作+额外要求 / 动作+目标字数 / 三段齐全（含顺序）/
//      边界（空白与非法值**不产生空行**）/ 空动作回落 / 不改动入参，
//      外加一组**源码断言**守住「提示词 ↔ 调用点」同步。
//
// 🔴 为什么值得给这几行拼装写测试：它决定作者填的「额外要求」到底有没有进提示词，
//    而这类"没进去"不会报错 —— 作者只会觉得"AI 没听可的话"。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buildRewriteAsk, INSTRUCTION_PLACEHOLDERS } from '../src/lib/rewriteAsk'

const readSrc = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8')

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ rewriteAsk')

// ---------- ① 只有动作 ----------
{
  const out = buildRewriteAsk({ instruction: '润色' }, 50)
  ok('只有动作 ⇒ 单行', out === '润色', JSON.stringify(out))
}

// ---------- ② 动作 + 额外要求 ----------
{
  const out = buildRewriteAsk({ instruction: '润色', detail: '少用形容词，对白不要书面语' }, 50)
  ok('动作 + 额外要求 ⇒ 两行', out.split('\n').length === 2, JSON.stringify(out.split('\n')))
  ok('🔴 额外要求那行带「不得放宽动作纪律」的约束语（安全网不能丢）',
    out.includes('不得放宽上面的动作纪律'), JSON.stringify(out))
  ok('作者原文一字不改地带进去', out.includes('少用形容词，对白不要书面语'))
}

// ---------- ③ 动作 + 目标字数 ----------
{
  const out = buildRewriteAsk({ instruction: '扩写', targetWords: 200 }, 50)
  ok('含目标字数与「选区现字数」', out.includes('约 200 字') && out.includes('现约 50 字'), JSON.stringify(out))
  ok('选区字数为 0 时不显示「现约」',
    !buildRewriteAsk({ instruction: '扩写', targetWords: 200 }, 0).includes('现约'))
  ok('小数目标取整（200.7 ⇒ 201）',
    buildRewriteAsk({ instruction: '扩写', targetWords: 200.7 }, 10).includes('约 201 字'),
    JSON.stringify(buildRewriteAsk({ instruction: '扩写', targetWords: 200.7 }, 10)))
}

// ---------- ④ 三段齐全 + 顺序 ----------
{
  const lines = buildRewriteAsk({ instruction: '语气', detail: '改成冷峻克制', targetWords: 300 }, 120).split('\n')
  ok('三段齐全 ⇒ 三行', lines.length === 3, JSON.stringify(lines))
  ok('顺序＝动作 → 额外要求 → 目标字数',
    lines[0] === '语气' && lines[1].includes('作者的额外要求') && lines[2].includes('目标字数'),
    JSON.stringify(lines))
}

// ---------- ⑤ 边界：空值/非法值**不产生空行** ----------
// 空壳行会白占预算、还会让模型以为"作者写了个空要求"。
{
  ok('detail 只有空白 ⇒ 不产生行', buildRewriteAsk({ instruction: '精简', detail: '   ' }, 10) === '精简')
  ok('targetWords = 0 ⇒ 不产生行', buildRewriteAsk({ instruction: '精简', targetWords: 0 }, 10) === '精简')
  ok('targetWords 负数 ⇒ 不产生行', buildRewriteAsk({ instruction: '精简', targetWords: -5 }, 10) === '精简')
  ok('targetWords = NaN ⇒ 不产生行', buildRewriteAsk({ instruction: '精简', targetWords: NaN }, 10) === '精简')
  ok('action 是空白 ⇒ 回落「润色」', buildRewriteAsk({ instruction: '  ' }, 10) === '润色')
}

// ---------- ⑥ 纯函数：不改动入参 ----------
{
  const ask = { instruction: '润色', detail: 'x', targetWords: 100 }
  const snap = JSON.stringify(ask)
  buildRewriteAsk(ask, 10)
  ok('不改动入参（纯函数）', JSON.stringify(ask) === snap)
}

// ---------- ⑦ 源码断言：提示词 ↔ 调用点必须同步 ----------
// 这类不一致破了不会报错，只会静默失效（作者以为生效了）。
{
  const task = readSrc('src/lib/aiTasks/jieWenJi.ts')
  ok('🔴 提示词写明「额外要求优先，但不得放宽第 2 条的动作纪律」',
    task.includes('不得放宽第 2 条的动作纪律'))
  ok('🔴 提示词写明「不得为了凑字数注水」', task.includes('不得为了凑字数注水'))
  ok('🔴 装配处调 buildRewriteAsk（拼装只有一处真源）',
    task.includes('buildRewriteAsk(ask, countWords(passage))'))
  ok('🔴 拼装住在零依赖层（否则测试会把传输层 ./ai 拉进 Node）',
    readSrc('src/lib/rewriteAsk.ts').includes('export function buildRewriteAsk'))
  ok('🔴 autoContinue 的第二调用点也改成传对象',
    readSrc('src/lib/autoContinue.ts').includes('aiRewritePassage(body, { instruction:'))
  ok('🔴 组件不自己拼提示词（不许在 UI 层再写一份【修改要求】）',
    !readSrc('src/components/useJieWenJiModel.ts').includes('【修改要求】'))
}

// ---------- ⑦ 每个动作都有**专属**的「额外要求」示例 ----------
// 🔴 为什么守这条：五个动作要回答的问题不同（润色问「偏向哪一面」、视角问「从什么换成什么」），
//    共用一个示例等于没给提示 —— 而这类「提示与动作不匹配」不会报错，
//    只是作者照着填会填歪（2026-10-09 主人发现五个动作的示例一模一样）。
{
  // 动作清单住在 .tsx 里（含 JSX 的文件不能直接 import 进 Node 测试）⇒ 从源码里取
  const parts = readSrc('src/components/jieWenJiParts.tsx')
  const m = parts.match(/export const INSTRUCTIONS = \[([^\]]+)\]/)
  const actions = m ? m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : []
  ok('能从源码取到动作清单（5 个）', actions.length === 5, JSON.stringify(actions))
  ok('🔴 每个动作都有示例文案',
    actions.every(a => (INSTRUCTION_PLACEHOLDERS[a] ?? '').trim().length > 0),
    `缺示例：${actions.filter(a => !INSTRUCTION_PLACEHOLDERS[a]).join('、') || '(无)'}`)
  ok('🔴 各动作的示例**互不相同**（同一个示例套五个动作等于没提示）',
    new Set(Object.values(INSTRUCTION_PLACEHOLDERS)).size === Object.keys(INSTRUCTION_PLACEHOLDERS).length,
    JSON.stringify(Object.values(INSTRUCTION_PLACEHOLDERS)))
  ok('示例表没有多余条目（键集合 ＝ 动作集合）',
    Object.keys(INSTRUCTION_PLACEHOLDERS).sort().join(',') === [...actions].sort().join(','),
    `表 [${Object.keys(INSTRUCTION_PLACEHOLDERS).join(',')}] vs 动作 [${actions.join(',')}]`)
  ok('🔴 组件用的是这张表（不是写死一个 placeholder）',
    readSrc('src/components/JieWenJiEdit.tsx').includes('INSTRUCTION_PLACEHOLDERS[instruction]'))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
