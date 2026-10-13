// ============ 下拉浮层定位的界面缩放折算（2026-10-13 六维审计补修）============
//
// 病根（与 2026-10-13 修的 HelpPopover 同一个）：`<html style="zoom:X">` 下
//   · `getBoundingClientRect()` / `window.innerWidth/Height` 返回的是**视觉像素**（已乘 zoom）；
//   · 写回 `style.left/top/minWidth/maxHeight` 的值会被浏览器**再乘一次 zoom**；
//   · 而 `gap / margin / estH / minWidth` 是**逻辑像素**常量。
// ⇒ 三者混算：zoom 1.08 时下拉整体右移 ~8%、翻转判断偏、限高偏小。
// 5 个下拉（CalendarSelect / CalendarPicker / CharacterSelect / CustomSelect / TableRefSelect）
// 全部走 `computeDropdownPos` ⇒ 一处修、五处好。
//
// 🔴 为什么这个测试必须 mock 浏览器环境：`foldPx` 在 `typeof document === 'undefined'`
//    时**原样返回**（Node 端与 SSR 安全），不 mock 的话折算分支根本不会被执行 ——
//    测试会"全绿"但一行都没验到（本项目最忌讳的假绿）。
import { computeDropdownPos } from '../src/lib/app/dropdownPos'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const near = (a: number, b: number, tol = 1.5) => Math.abs(a - b) <= tol

console.log('\n▶ dropdownPos')

/** 装浏览器桩：zoom 由 getComputedStyle 提供，视口按**视觉像素**给（与真实一致） */
function env(zoom: number, vwLogical: number, vhLogical: number) {
  ;(globalThis as Record<string, unknown>).document = { documentElement: {} }
  ;(globalThis as Record<string, unknown>).getComputedStyle = () => ({
    getPropertyValue: (k: string) => (k === '--ui-zoom' ? String(zoom) : ''),
  })
  ;(globalThis as Record<string, unknown>).window = {
    innerWidth: vwLogical * zoom,
    innerHeight: vhLogical * zoom,
  }
}

/** 逻辑坐标 → 视觉 rect（浏览器量到的就是这个） */
function rectOf(zoom: number, left: number, top: number, w: number, h: number): DOMRect {
  return {
    left: left * zoom, top: top * zoom, width: w * zoom, height: h * zoom,
    right: (left + w) * zoom, bottom: (top + h) * zoom, x: left * zoom, y: top * zoom,
    toJSON: () => ({}),
  } as unknown as DOMRect
}

// ---------- 1. 基线：zoom = 1 时与旧行为完全一致 ----------
{
  env(1, 1600, 1080)
  const p = computeDropdownPos(rectOf(1, 100, 500, 200, 32))
  ok('zoom=1：left 原样', p.left === 100, String(p.left))
  ok('zoom=1：top = bottom + gap', p.top === 536, String(p.top))
  ok('zoom=1：minWidth 取 max(160, width)', p.minWidth === 200, String(p.minWidth))
  ok('zoom=1：不翻转', p.flip === false)
}

// ---------- 2. 🔴 核心：zoom = 1.08（1600px 窗口的自动档）必须折算 ----------
{
  const Z = 1.08
  env(Z, 1600, 1080)
  const p = computeDropdownPos(rectOf(Z, 100, 500, 200, 32))

  ok('🔴 left 折算回逻辑像素（100，而非视觉值 108）', p.left === 100, String(p.left))
  ok('🔴 top 折算回逻辑像素（532+4=536，而非视觉值 576）', near(p.top, 536, 1), String(p.top))
  ok('🔴 minWidth 折算（200，而非视觉值 216）', p.minWidth === 200, String(p.minWidth))
  ok('🔴 未折算时会整体右移 8px（= 100 × 0.08）', Math.abs(108 - p.left) === 8)

  // 负控：把旧算法（不折算）写出来，确认它给出的确实是**错的**值 ——
  // 证明上面几条断言真的能抓到「没折算」这个坏形态，而不是恒真。
  const legacy = (r: DOMRect) => ({
    left: Math.max(8, Math.round(r.left)),
    top: Math.round(r.bottom + 4),
  })
  const old = legacy(rectOf(Z, 100, 500, 200, 32))
  ok('  · 负控：旧算法给出 left=108（错）', old.left === 108, String(old.left))
  // 视觉 bottom = (500+32)×1.08 = 574.56 → 旧算法 round(574.56+4) = 579（比正确的 536 低 43px）
  ok('  · 负控：旧算法给出 top=579（错）', old.top === 579, String(old.top))
  ok('  · 负控：新旧结果确实不同（断言不是恒真）', old.left !== p.left && old.top !== p.top)
}

// ---------- 3. 翻转判断也在逻辑坐标系里算 ----------
{
  const Z = 1.08
  env(Z, 1600, 1080)
  // 按钮贴近视口底部（逻辑 top=1000 / bottom=1032，视口高 1080）
  const p = computeDropdownPos(rectOf(Z, 100, 1000, 200, 32), { flipBelow: 200 })
  ok('🔴 底部空间不足 → 上翻', p.flip === true)
  ok('🔴 上翻时 top = 按钮顶 - gap（逻辑 996）', near(p.top, 996, 1), String(p.top))
  ok('  未折算的旧算法会给出 1076（跑出视口）', Math.abs(1076 - p.top) > 70)
}

// ---------- 4. maxHeight 折算 + clampRight 折算 ----------
{
  const Z = 1.25
  env(Z, 1200, 800)
  const p = computeDropdownPos(rectOf(Z, 900, 100, 200, 32), { estH: 264, clampRight: 220 })
  ok('maxHeight 有值且在逻辑坐标系内', typeof p.maxHeight === 'number' && p.maxHeight! > 0, String(p.maxHeight))
  ok('clampRight 按逻辑视口夹左边缘（≤ 1200-220=980）', p.left <= 980, String(p.left))
}

// ---------- 5. 无 document（Node / SSR）时安全退化为不折算 ----------
{
  delete (globalThis as Record<string, unknown>).document
  ;(globalThis as Record<string, unknown>).window = { innerWidth: 1728, innerHeight: 1166 }
  const p = computeDropdownPos(rectOf(1, 100, 500, 200, 32))
  ok('无 document 时不炸、按原值输出', p.left === 100 && p.top === 536, `${p.left}/${p.top}`)
}

console.log(`\ndropdownPos: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
