// ============ 大纲卡片「换选择不冲刷草稿」回归闸（2026-10-19 全量审计）============
//
// 审计规则原文（scripts/audit/ast.mjs · draft.switch）：
//   「同一操作替换选择与草稿，未见显式冲刷旧草稿；核对未保存及保存失败路径」
//
// 为什么值得固化成闸：这是一类**反复出现**的缺陷 —— 角色卡 R8（2026-10-16）、
// 本轮的大纲页「新建 / 复制 / AI 新增」都是同一个形状：
//   作者正在编辑 A → 点新建 → 直接 setActiveId(new) → 切换 effect 才去补存 A
//   → 补存失败时人已经站在 B 上，A 的编辑被 draft 顶掉，只剩一句 toast。
// 正确做法只有一个：**先 `switchTo(id)`（内部 await saveCardRecord，失败返回 false 不切换）**。
//
// 本闸只做静默漏检最狠的那半：**卡片操作函数里出现 `setActiveId` 就算违规**。
// 换选择必须走 `switchTo`；`switchTo` 自己是唯一定义 setActiveId 的地方。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const FILE = path.join(process.cwd(), 'src/components/outline/OutlineSheet.tsx')
const src = fs.readFileSync(FILE, 'utf8')

/**
 * 按「两级缩进的 `const name = …` / `function name` / `useEffect(`」切块 —— 本文件的卡片操作都是这种形状。
 * 切不准也不致命：宁可块切大了多报，也不切小漏报。
 * （`const switchTo = useCallback(…)` 也算：只认 `= 名字`，后面跟什么都行。）
 */
function blocks(text: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = []
  const re = /\n {2}(?:const|let|function|useEffect|useLayoutEffect)\b\s*([A-Za-z_$][\w$]*)?/g
  const hits: Array<{ name: string; start: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) hits.push({ name: m[1] ?? 'useEffect', start: m.index })
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : text.length
    out.push({ name: hits[i].name, body: text.slice(hits[i].start, end) })
  }
  return out
}

const list = blocks(src)
ok('切出了卡片操作函数块（样本 > 0）', list.length >= 5, `blocks=${list.length}`)

/**
 * 允许直接 setActiveId 的两处，理由都写在这里（新增白名单必须给理由）：
 *   · `switchTo` —— 它就是唯一的换选择入口，冲刷逻辑在它内部；
 *   · `removeRecord` —— 删掉的是**当前**这一张，草稿跟着卡一起没了，不存在"旧编辑被顶掉"；
 *   · **加载 effect**（块体里调 `getCardRecords` 的那个）—— 项目/页签刚打开时还没有草稿。
 */
const ALLOWED = new Set(['switchTo', 'removeRecord'])

/** 扫描一份源码，返回"除白名单外还直接 setActiveId"的函数名 */
function scanActiveId(text: string): string[] {
  return blocks(text)
    .filter(b => !ALLOWED.has(b.name))
    .filter(b => !(b.name === 'useEffect' && /getCardRecords/.test(b.body)))
    .filter(b => /\bsetActiveId\s*\(/.test(b.body))
    .map(b => b.name)
}

const offenders = scanActiveId(src)
ok('除 switchTo / removeRecord / 加载 effect 外没有任何函数直接调用 setActiveId', offenders.length === 0, offenders.join(', '))

// 🔴 负向控制：闸必须**真能红**。修复前 submitNamePrompt 里就是 setActiveId，
//    这里用同形状的坏样本确认检测器抓得到；抓不到说明这条闸是摆设。
const BAD_SAMPLE = `
  const submitNamePrompt = async (v) => {
    setRecords([rec, ...records])
    setActiveId(rec.id)
    setDraft(rec)
  }
  const switchTo = useCallback(async (id) => {
    setActiveId(id)
    return true
  }, [])
`
const badHit = scanActiveId(BAD_SAMPLE)
ok('闸自检：坏样本（直接 setActiveId）能被抓出来', badHit.join(',') === 'submitNamePrompt', badHit.join(','))
ok('闸自检：白名单里的 switchTo 不会被误报', !badHit.includes('switchTo'), badHit.join(','))

// 三个已知入口逐一点名（修复前这三块各有一行 setActiveId，会红）
for (const fn of ['submitNamePrompt', 'duplicateRecord', 'handleFillNew']) {
  const b = list.find(x => x.name === fn)
  ok(`${fn} 存在`, !!b)
  if (!b) continue
  ok(`${fn} 走 switchTo 换选择（不直接 setActiveId）`, !/\bsetActiveId\s*\(/.test(b.body))
  ok(`${fn} 真的调了 switchTo 且等它返回`, /await\s+switchTo\s*\(/.test(b.body))
}

// switchTo 必须把失败当失败（返回 false 且不 setActiveId）
const sw = list.find(x => x.name === 'switchTo')
ok('switchTo 存在', !!sw)
if (sw) {
  ok('switchTo 检查 flushDraft 失败并 return false', /await flushDraft\(\)[\s\S]{0,100}if \(!result.ok\)[\s\S]{0,250}return false/.test(sw.body))
  ok('失败分支在真正提交选择之前，且连续新修改有界停止',
    sw.body.indexOf('setActiveId') > sw.body.indexOf('if (!result.ok)') && sw.body.includes('attempt < 3'))
  const flush = list.find(block => block.name === 'flushDraft')
  ok('flushDraft 接到串行资料写入器并保持真实保存入口', !!flush && /createRecordDraftFlusher<CardRecord>/.test(flush.body)
    && /write: async record =>[\s\S]{0,60}await saveCardRecord\(record\)/.test(flush.body)
    // Recording a persistent UI failure cannot convert a failed write into a successful flush.
    && /catch \(error\)[\s\S]{0,130}throw error/.test(flush.body))
}

console.log(`\noutlineDraftSwitch: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
