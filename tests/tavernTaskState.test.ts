// 3.0 · W2-5 酒馆长任务状态治理 · 单测
//
// 🔴 本项是「状态与生命周期跨层搬迁」—— 静态检查证明不了行为等价，所以这里**只钉结构与纪律**，
//    行为等价交给实机（方案 §11.1 L1 原文要求）。
// 盯四件事：
//   ① `useFreeRoundEnd` 的长任务状态**已不在组件内**（无 useState/useRef 持有 ending/stage/ctl/result）；
//   ② 已接入任务中心（`useTaskRunner`，ownerTab=tavern-free / kind=round-end）；
//   ③ 中止**只能**由作者触发（`stopEndRound` 走任务中心通道）；
//   ④ 取锁在 try 之外、release 在自己的 finally（审计 P1-3 的事故防线没被搬丢）；
//   ⑤ F3 的「未整理轮数」是**纯派生**（不在组件 state 里）。
import fs from 'node:fs'
import { pendingMessages } from '../src/lib/tavern/roundEnd'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const read = (p: string) => fs.readFileSync(p, 'utf8')
/** 剥注释：源码注释里常出现「旧写法是这样的」的反例文本（如 `releaseSummaryLock()`），
 *  判「不得再出现某形态」时必须先剥掉，否则会被注释里的说明文字误伤。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const roundEnd = read('src/components/tavern/useFreeRoundEnd.ts')
const free = read('src/components/tavern/TavernFree.tsx')
const center = read('src/lib/ai/aiTaskCenter.ts')

console.log('\n—— W2-5 用例开始 ——')

// ---------- ① 长任务状态已外移 ----------
{
  ok('① 已接入任务中心（useTaskRunner）', roundEnd.includes('useTaskRunner<'))
  ok('① ownerTab = tavern-free', roundEnd.includes("ownerTab: 'tavern-free'"))
  ok('① kind = round-end', roundEnd.includes("kind: 'round-end'"))
  ok('① 声明 writes（与其它写酒馆任务互斥提醒）', roundEnd.includes("writes: ['tavern']"))

  ok('① 🔴 组件内不再持有 ending/endStage/endResult 的 useState',
    !/const \[ending, setEnding\]/.test(roundEnd)
    && !/const \[endStage, setEndStage\]/.test(roundEnd)
    && !/const \[endResult, setEndResult\]/.test(roundEnd))
  // ⚠️ 只查**代码**（`endCtlRef` 在新加的说明注释里被提到过，那是解释历史，不算违规）
  ok('① 🔴 组件内不再持有取消把手 useRef（切页签不会丢中止能力）',
    !/endCtlRef\s*=\s*useRef/.test(roundEnd) && !/endCtlRef\.current/.test(roundEnd))
  ok('① 返回值形状与旧版一致（消费者零改动）',
    /ending: endT\.running/.test(roundEnd)
    && /endStage: endT\.task\?\.progress \?\? null/.test(roundEnd)
    && /endResult: endT\.result/.test(roundEnd))
  ok('① 「关掉即焚」语义保留（setEndResult(null) ⇒ endT.clear()）',
    /if \(r === null\) endT\.clear\(\)/.test(roundEnd))
}

// ---------- ② 中止只能作者触发 ----------
{
  ok('② 🔴 stopEndRound 走任务中心中止通道（不是本地 abort）',
    /const stopEndRound = useCallback\(\(\) => \{ endT\.stop\(\) \}/.test(roundEnd))
  ok('② 🔴 任务中心的 stop 只由用户动作调（源码注释钉着这条纪律）',
    center.includes('只有用户动作才会调它') && center.includes('切页签绝不中止'))
  ok('② 面板仍有「中止」按钮（行为入口没丢）', free.includes('onClick={stopEndRound}'))
}

// ---------- ③ 取锁纪律 ----------
{
  ok('③ 取锁仍在 try 之外（inspect：acquire 行在 try 之前）', (() => {
    const i = roundEnd.indexOf('acquireSummaryLock(')
    const t = roundEnd.indexOf('try {', i >= 0 ? i : 0)
    return i >= 0 && t > i
  })())
  ok('③ 🔴 取不到锁改为 throw（任务如实记 failed，不再只 toast 一句）',
    roundEnd.includes("throw new Error('另一个窗口正在收尾')"))
  // 🔴 3.0.4：锁带**所有权令牌**（acquire 返回 token、release 必须出示它），
  //    这样 TTL 到期的旧锁不会被别的实例误释放。闸跟着改为「必须带 token 释放」。
  ok('③ release 排在 fn 自己的 finally', /finally \{[\s\S]{0,240}?releaseSummaryLock\(lockToken\)/.test(roundEnd))
  ok('③ 🔴 释放锁必须出示所有权令牌（不再无参 release）',
    roundEnd.includes('releaseSummaryLock(lockToken)') && !/releaseSummaryLock\(\s*\)/.test(strip(roundEnd)))
  ok('③ 传 signal / progress 给真正干活的 runRoundEnd',
    roundEnd.includes('onProgress: ctx.progress') && roundEnd.includes('signal: ctx.signal'))
}

// ---------- ④ 提示（notify）与中止语义 ----------
{
  ok('④ 🔴 面板不再自己 toast「本轮已结束」（改由任务中心 store 发）',
    !roundEnd.includes("showToast(\n        `本轮已结束"))
  ok('④ 收尾结果作为任务结果返回（切回来看得到）', roundEnd.includes('return res'))
  ok('④ 中止文案仍说清「没有写入任何内容」',
    roundEnd.includes('已中止收尾 —— 没有写入任何内容，这一场仍是未结束状态'))
  ok('④ 有步骤没成如实说（warnings 原样带出，审计 P0-1）',
    roundEnd.includes('r.warnings.join'))
  ok('④ 🔴 不再自己用 isCancelled 判中止（交给任务中心的 status）',
    !roundEnd.includes('isCancelled('))
  ok('④ 卸载本地模型仍排最后（#11，在 return res 之前）',
    roundEnd.indexOf('unloadLocalModels()') < roundEnd.indexOf('return res'))
}

// ---------- ⑤ F3 未整理轮数是纯派生 ----------
{
  ok('⑤ TavernFree 直接 import 收尾的同一判据（口径同源）',
    free.includes("import { pendingMessages } from '../lib/tavern/roundEnd'") || free.includes("import { pendingMessages } from '@/lib/tavern/roundEnd'"))
  ok('⑤ 🔴 未整理轮数不进组件 state（无 useState 存它）',
    !/useState[^\n]*pendingMessages/.test(free) && /const n = pendingMessages\(session\)\.length/.test(free))
  ok('⑤ 已归档的场次不再显示徽标', free.includes('!session.endedAt && (() => {'))
  ok('⑤ 徽标文案含轮数与引导', free.includes('未整理 {n} 轮') && free.includes('结束本轮对话'))

  // 🔴 2026-10-11 补：徽标盒子规格必须与右侧 size="md" 按钮同源（h-9 / px-4 / text-13 / rounded-lg）。
  //   它不是可点入口（刻意保留 <span>，套 Button 会诱导作者去点），但并排时必须等高 ——
  //   否则会"塌一截"。这三条钉住规格，防止后续改样式时被手抖删掉而单测仍全绿。
  ok('⑤ 🔴 未整理徽标不是按钮（只提示不新增入口）', (() => {
    // 取「未整理 {n} 轮」所在的那个标签：往回找最近的 '<'
    const i = free.indexOf('未整理 {n} 轮')
    if (i < 0) return false
    const open = free.lastIndexOf('<', i)
    return open >= 0 && /^<span[\s>]/.test(free.slice(open))
  })())
  ok('⑤ 🔴 未整理徽标盒高对齐 size="md"（h-9 + text-13）',
    free.includes('inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg h-9 px-4 border border-amber/30 bg-amber/15 text-13 text-amber'))
  ok('⑤ 🔴 已归档说明也走同一盒口径（不与按钮高低不齐）',
    free.includes('inline-flex shrink-0 items-center rounded-lg h-9 px-4 text-13 text-amber/80'))

  // pendingMessages 口径：水位线之后的消息（空 session 不炸）
  const empty = { messages: [], watermark: 0 } as never
  ok('⑤ pendingMessages 空会话 ⇒ 空数组（不炸）', Array.isArray(pendingMessages(empty)) && pendingMessages(empty).length === 0)
}

console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
