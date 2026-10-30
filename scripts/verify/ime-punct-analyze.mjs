// 中文标点配对的**事件序列**分析器（3.3.1 · §12 取证工具）
//
// 规划 §12.5 要求：结论必须建立在「真实输入法的事件序列日志」上，不接受只用 CDP 模拟。
// 这一步我在本机做不了（没有真实输入法矩阵），所以这里给的是**把日志变成判据**的那一半：
//
//   1. 在真实应用里按 `docs/3.3.1-标点配对-代码侧审查-2026-10-30.md` 的控制台片段录一段日志；
//   2. 导出 JSON（数组，或 {events:[...]}）；
//   3. `node scripts/verify/ime-punct-analyze.mjs <日志.json>` —— 输出每条判据的结论。
//
// 🔴 这个脚本**不产生证据**，只判读证据。它跑通不代表 §12 通过。
import fs from 'node:fs'

/** 一条事件的形状（控制台片段产出的就是这个） */
// { t, type, data, isComposing, caret, value, ... }

const REPEAT_CLOSE = /[”』》〉】）]{2}/
const REPEAT_OPEN = /[“‘「『《〈【（]{2}/

function readLog(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  const events = Array.isArray(parsed) ? parsed : Array.isArray(parsed.events) ? parsed.events : []
  if (events.length === 0) throw new Error('日志里没有事件')
  return events
}

/** 判读一段事件序列，返回「条目 + 结论」，不打印 */
export function analyzeImeLog(events) {
  const results = []
  const add = (name, ok, detail = '') => results.push({ name, ok, detail })

  // ① 组合期间应用是否动过光标（方向 1/2 的直接证据）
  const moveDuringComposing = events.filter((event, index) => {
    if (event.type !== 'app:setSelectionRange') return false
    for (let i = index - 1; i >= 0; i--) {
      const prev = events[i]
      if (prev.type === 'compositionstart') return true
      if (prev.type === 'compositionend') return false
    }
    return false
  })
  add('🔴 组合期间应用没有移动光标（否则会与输入法的收尾抢位置）',
    moveDuringComposing.length === 0, `${moveDuringComposing.length} 次`)

  // ② 有没有打出「两个相同右标点 / 两个相同左标点」（越打越多的那种）
  const doubled = events.filter(event => event.type === 'input'
    && (REPEAT_CLOSE.test(String(event.value ?? '')) || REPEAT_OPEN.test(String(event.value ?? ''))))
  add('🔴 没有出现连续两个相同标点（`““` / `””`）', doubled.length === 0, `${doubled.length} 处`)

  // ③ compositionend 与随后的 input 谁先谁后（决定两条补标点路径的实际命中情况）
  const ordering = []
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== 'compositionend') continue
    const next = events.slice(i + 1, i + 4).find(event => event.type === 'input' || event.type === 'beforeinput')
    ordering.push(next ? next.type : 'none')
  }
  const afterEnd = ordering.reduce((acc, type) => ({ ...acc, [type]: (acc[type] ?? 0) + 1 }), {})
  add('记录：组合结束后紧跟的事件类型（input / beforeinput / none）', true, JSON.stringify(afterEnd))

  // ④ 组合结束后应用是否立刻补了标点（若补了，看它补完有没有再触发一次 input）
  const appPairs = events.filter(event => event.type === 'app:setSelectionRange')
  add('记录：应用侧移动光标的次数（= 补标点命中次数）', true, `${appPairs.length}`)

  // ⑤ 每次「输入左标点」之后，光标是否落在两个标点之间
  const typedOpen = events.filter(event => event.type === 'input'
    && typeof event.data === 'string' && '“‘《〈「『（【'.includes(event.data))
  add('记录：录到了几次「输入中文左标点」', typedOpen.length > 0, `${typedOpen.length}`)

  return results
}

/** 自测：用两份合成日志证明判据能抓问题、也不误伤 */
function selfTest() {
  const clean = [
    { type: 'compositionstart', isComposing: true },
    { type: 'input', isComposing: true, data: '“', value: '“', caret: 1 },
    { type: 'compositionend', isComposing: false, data: '“' },
    { type: 'input', isComposing: false, data: '“', value: '“', caret: 1 },
    { type: 'app:setSelectionRange', to: 1, value: '“”', caret: 1 },
  ]
  const broken = [
    { type: 'compositionstart', isComposing: true },
    { type: 'app:setSelectionRange', to: 1, value: '“”', caret: 1 },
    { type: 'input', isComposing: true, data: '“', value: '““', caret: 2 },
  ]
  const a = analyzeImeLog(clean)
  const b = analyzeImeLog(broken)
  const pass = a[0].ok && a[1].ok && !b[0].ok && !b[1].ok
  console.log(pass ? 'PASS 分析器自测（干净日志全绿、坏日志被抓）' : 'FAIL 分析器自测')
  if (!pass) {
    console.log(JSON.stringify({ clean: a, broken: b }, null, 2))
    process.exitCode = 1
  }
}

const file = process.argv[2]
if (!file) {
  selfTest()
} else {
  const events = readLog(file)
  console.log(`事件 ${events.length} 条：${file}\n`)
  for (const item of analyzeImeLog(events)) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ' :: ' + item.detail : ''}`)
  }
}
