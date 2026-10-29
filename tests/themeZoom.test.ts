// 3.0 · 界面缩放（自动适配 + 侧栏缩放行）契约闸 —— 2026-10-10
//
// 为什么要有这一道：这次修的两个问题都属于「不报错、要盯很久才看出来」的类型 ——
//   ① 自动缩放的 resize 监听写成**挂载时一次性**判断 ⇒ 启动为「手动」时监听永不挂上，
//      之后点「自动」只按当时的宽度算一次，再改窗口大小就不跟了（2026-10-10 真机复现）；
//   ② 侧栏「缩放比例」输入框的类名被 index.css 里**未分层**的全局 input 规则压掉 ⇒
//      48px 宽的框只剩 22px 可用、「132」只显示成「1」，且高度比同排控件高一截。
// 判据：autoZoom 的纯函数映射 + 两处源码契约。
import fs from 'node:fs'
import { autoZoom, foldZoomLength, getStoredZoom } from '../src/lib/settings/theme'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— themeZoom 用例开始 ——')

ok('固定浮层尺寸按界面缩放折算', foldZoomLength('18rem') === 'calc(18rem / var(--ui-zoom, 1))')

// ---------- ① autoZoom：窗口宽 → 缩放百分比（1280 宽起 100%，上限 140%） ----------
// 🔴 用最小 window 桩：theme.ts 的 autoZoom 只在 `typeof window !== 'undefined'` 时读 innerWidth
const stubWindow = (w: number) => {
  ;(globalThis as unknown as { window: { innerWidth: number } }).window = { innerWidth: w }
}
const CASES: [number, number][] = [
  [1000, 100], [1280, 100], [1440, 104], [1920, 116], [2560, 132], [2880, 140], [3840, 140],
]
for (const [w, want] of CASES) {
  stubWindow(w)
  const got = autoZoom()
  ok(`窗口 ${w} ⇒ ${want}%`, got === want, `实得 ${got}`)
}
{
  let mono = true, prev = -1
  for (let w = 800; w <= 4000; w += 40) { stubWindow(w); const z = autoZoom(); if (z < prev) mono = false; prev = z }
  ok('随窗口宽度单调不减', mono)
  let inRange = true
  for (let w = 600; w <= 5000; w += 40) { stubWindow(w); const z = autoZoom(); if (z < 100 || z > 140) inRange = false }
  ok('恒落在 100~140 闭区间', inRange)
}
{
  stubWindow(2560)
  ok('未手动指定时 getStoredZoom 走 autoZoom（跟随窗口）', getStoredZoom() === 132, `实得 ${getStoredZoom()}`)
}

// ---------- ② 源码契约：resize 监听必须常驻 ----------
const read = (p: string) => fs.readFileSync(p, 'utf8')
/** 🔴 去掉整行注释后再判 —— 注释里会引用那句被删掉的旧代码，不能误伤 */
const codeOnly = (src: string) => src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
{
  const app = codeOnly(read('src/App.tsx'))
  ok('🔴 resize 监听不再有「挂载时一次性早退」', !app.includes('if (!isZoomAuto()) return'))
  ok('🔴 resize 回调内仍按当前模式判定（非跟随则早退）', /onResize[\s\S]{0,240}isZoomAuto\(\)/.test(app))
}

// ---------- ③ 源码契约：侧栏缩放输入框必须压得过全局 input 规则 ----------
{
  const sb = read('src/components/app/Sidebar.tsx')
  const m = sb.match(/title="手动输入缩放比例[^"]*"[\s\S]{0,220}?className="([^"]+)"/)
  ok('能取到侧栏缩放输入框的 className', !!m, m ? '' : '未匹配')
  const cls = m ? m[1] : ''
  // index.css 的全局 `input` 规则（**未分层**，优先于 @layer utilities）设了 px-3 / py-1.5
  ok('🔴 内边距用 `!` 覆盖（否则 48px 宽只剩 22px 可用 → 132 只显示成 1）', /!p[xy]-/.test(cls), cls)
  ok('🔴 显式高度（与同排 toggle 的 h-6 对齐，防「比周围按钮高一截」）', /(^|\s)h-\d/.test(cls), cls)
}

// ---------- ④ 3.3.1 · P5：缩放面板的排布与无障碍名称 ----------
{
  const sb = read('src/components/app/Sidebar.tsx')
  const ws = read('src/components/app/WorkspaceSidebar.tsx')

  ok('缩放面板有稳定锚点（探针按它测量，不靠猜 class）', /data-zoom-panel/.test(sb))

  // 标题独立成行：`界面缩放` 那段先闭合，`自动` 按钮出现在其后
  // 面板到 `DensityControl inline` 结束（同一行右侧就是密度键）
  const panelStart = sb.indexOf('data-zoom-panel')
  const panelEnd = sb.indexOf('DensityControl inline', panelStart)
  const panel = sb.slice(panelStart, panelEnd > panelStart ? panelEnd : panelStart + 4000)
  const titleAt = panel.indexOf('界面缩放')
  const autoAt = panel.indexOf('跟随窗口自动调整')
  ok('🔴 第一行只有标题与帮助，自动按钮在下一行（不与标题同排）', titleAt >= 0 && autoAt > titleAt)
  ok('🔴 标题行在自动按钮之前就闭合了（不是同一个 flex 行）',
    panel.slice(titleAt, autoAt).includes('</div>'), panel.slice(titleAt, autoAt).slice(-60))

  ok('🔴 自动按钮带可读名称「跟随窗口自动调整」', /aria-label="跟随窗口自动调整"/.test(panel))
  ok('🔴 自动按钮暴露选中态（aria-pressed 绑到真实状态）', /aria-pressed=\{zoomAuto\}/.test(panel))
  ok('百分比输入框有名称「界面缩放百分比」', /ariaLabel="界面缩放百分比"/.test(panel))
  ok('增减按钮都有可读名称（图标键不靠 title 猜）',
    /aria-label="缩小界面"/.test(panel) && /aria-label="放大界面"/.test(panel))
  ok('🔴 百分比框宽度容得下三位数（w-9 及以上，160% 不被裁）',
    /className="h-6 w-(9|1\d|2\d)\b/.test(panel), (panel.match(/className="h-6 w-[\w[\]]+/) ?? [''])[0])

  // 窄屏抽屉复用同一份侧栏实例 —— 两处形态不能各写一套缩放控件
  ok('窄屏抽屉复用同一个 Sidebar（不另写一套缩放控件）',
    /width < 900/.test(ws) && /<Sidebar/.test(ws) && /sidebar/.test(ws))
  ok('未展开时把侧栏放进隐藏容器（不留可聚焦的重复控件）', /className="hidden"/.test(ws))
}

console.log(`\nthemeZoom: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
