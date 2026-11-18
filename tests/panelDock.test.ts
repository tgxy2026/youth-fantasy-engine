// ============ 颉文姬面板：停靠 / 浮动几何（3.6.1 · B 方案）============
//
// 需求：面板默认贴边停靠（与改动前一致），打开开关后可拖动、松手吸附到最近边。
// 这里钉住四类最容易"静默出事"的地方：
//   ① 默认矩形与改动前**逐像素一致**（top 56 / 距底 40 / 边 12 / 宽 360）；
//   ② 浮动矩形永远夹在视口内（拖不出屏幕、不会只剩一条标题栏）；
//   ③ 窄窗口强制回落停靠，但**不改写**偏好（拉宽后自动恢复）；
//   ④ 坏偏好（手改 localStorage / 旧版本残留）一律退回默认，不出现"面板不见了"。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_PANEL_PREFS, PANEL_BOTTOM, PANEL_DEFAULT_WIDTH, PANEL_EDGE, PANEL_FLOAT_MIN_VIEWPORT,
  PANEL_MAX_WIDTH, PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH, PANEL_TOP,
  clampFloatingRect, dockedRect, effectiveMode, initialFloatingRect, normalizePanelPrefs,
  serializePanelPrefs, snapSide, snappedLeft, type PanelPrefs,
} from '../src/lib/app/panelDock'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const VP = { width: 1440, height: 900 }
const prefs = (over: Partial<PanelPrefs> = {}): PanelPrefs => ({ ...DEFAULT_PANEL_PREFS, ...over })

function main() {
  // ① 默认停靠 = 改动前的样子
  {
    const right = dockedRect(prefs(), VP)
    ok('默认贴右：left = 视口宽 - 宽 - 边', right.left === VP.width - PANEL_DEFAULT_WIDTH - PANEL_EDGE, JSON.stringify(right))
    ok('默认宽度 360', right.width === PANEL_DEFAULT_WIDTH, String(right.width))
    ok('顶部 56（工具栏下方）', right.top === PANEL_TOP, String(right.top))
    ok('高度 = 视口高 - 顶 - 距底', right.height === VP.height - PANEL_TOP - PANEL_BOTTOM, String(right.height))
    const left = dockedRect(prefs({ side: 'left' }), VP)
    ok('停靠左侧时 left = 12', left.left === PANEL_EDGE, String(left.left))
    const narrow = dockedRect(prefs(), { width: 360, height: 700 })
    ok('极窄视口下面板不超出屏幕', narrow.left >= 0 && narrow.width <= 360 - PANEL_EDGE, JSON.stringify(narrow))
  }

  // ② 浮动矩形夹取
  {
    const base = { left: 100, top: 100, width: 360, height: 500 }
    ok('正常矩形原样返回', JSON.stringify(clampFloatingRect(base, VP)) === JSON.stringify(base))
    ok('拖出左边界 → 回到 12', clampFloatingRect({ ...base, left: -400 }, VP).left === PANEL_EDGE)
    ok('拖出上边界 → 回到 12', clampFloatingRect({ ...base, top: -90 }, VP).top === PANEL_EDGE)
    const rightOut = clampFloatingRect({ ...base, left: 9999 }, VP)
    ok('拖出右边界 → 右边贴 12', rightOut.left === VP.width - rightOut.width - PANEL_EDGE, String(rightOut.left))
    const bottomOut = clampFloatingRect({ ...base, top: 9999 }, VP)
    ok('拖出下边界 → 底边贴 12', bottomOut.top === VP.height - bottomOut.height - PANEL_EDGE, String(bottomOut.top))
    ok('宽度小于下限 → 拉到下限', clampFloatingRect({ ...base, width: 100 }, VP).width === PANEL_MIN_WIDTH)
    ok('宽度大于上限 → 收到上限', clampFloatingRect({ ...base, width: 5000 }, VP).width === PANEL_MAX_WIDTH)
    ok('高度小于下限 → 拉到下限', clampFloatingRect({ ...base, height: 10 }, VP).height === PANEL_MIN_HEIGHT)
    const tiny = clampFloatingRect({ left: 0, top: 0, width: 560, height: 800 }, { width: 500, height: 420 })
    ok('视口比面板还小时也不越界', tiny.left >= 0 && tiny.top >= 0 && tiny.width <= 500 - PANEL_EDGE && tiny.height <= 420 - PANEL_EDGE, JSON.stringify(tiny))
  }

  // ③ 吸附
  {
    ok('中心偏左 → 吸附左侧', snapSide({ left: 100, width: 360 }, VP) === 'left')
    ok('中心偏右 → 吸附右侧', snapSide({ left: 1000, width: 360 }, VP) === 'right')
    ok('正好居中 → 右侧（与默认值一致）', snapSide({ left: VP.width / 2 - 180, width: 360 }, VP) === 'right')
    ok('左侧吸附位 = 12', snappedLeft('left', 360, VP) === PANEL_EDGE)
    ok('右侧吸附位 = 视口宽 - 宽 - 12', snappedLeft('right', 360, VP) === VP.width - 360 - PANEL_EDGE)
    ok('面板比视口宽时吸附位不出现负数', snappedLeft('right', 2000, VP) === PANEL_EDGE)
  }

  // ④ 窄窗口降级与切换初始矩形
  {
    ok('够宽时按偏好浮动', effectiveMode(prefs({ mode: 'floating' }), VP) === 'floating')
    ok('窄窗口把浮动降级为停靠', effectiveMode(prefs({ mode: 'floating' }), { width: PANEL_FLOAT_MIN_VIEWPORT - 1, height: 800 }) === 'docked')
    ok('偏好是停靠时始终停靠', effectiveMode(prefs(), VP) === 'docked')
    const fromRight = initialFloatingRect(dockedRect(prefs(), VP), prefs(), VP)
    ok('从右侧停靠切浮动：右边对齐不跳', fromRight.left + fromRight.width === VP.width - PANEL_EDGE, JSON.stringify(fromRight))
    const fromLeft = initialFloatingRect(dockedRect(prefs({ side: 'left' }), VP), prefs(), VP)
    ok('从左侧停靠切浮动：左边对齐不跳', fromLeft.left === PANEL_EDGE, JSON.stringify(fromLeft))
    const wide = initialFloatingRect(dockedRect(prefs(), VP), prefs({ width: 520 }), VP)
    ok('切换时用记忆宽度（520）', wide.width === 520, String(wide.width))
    const tooWide = initialFloatingRect(dockedRect(prefs(), VP), prefs({ width: 2000 }), VP)
    ok('记忆宽度超限时收敛到上限', tooWide.width === PANEL_MAX_WIDTH, String(tooWide.width))
  }

  // ⑤ 坏偏好归一
  {
    ok('null → 默认', JSON.stringify(normalizePanelPrefs(null)) === JSON.stringify(DEFAULT_PANEL_PREFS))
    ok('字符串 → 默认', normalizePanelPrefs('oops').mode === 'docked')
    ok('未知 mode → 停靠', normalizePanelPrefs({ mode: 'weird' }).mode === 'docked')
    ok('未知 side → 右', normalizePanelPrefs({ side: 'up' }).side === 'right')
    ok('超宽宽度被收敛', normalizePanelPrefs({ width: 9999 }).width === PANEL_MAX_WIDTH)
    ok('负数宽度回到默认', normalizePanelPrefs({ width: -20 }).width === PANEL_DEFAULT_WIDTH)
    const noRect = normalizePanelPrefs({ mode: 'floating', width: 400 })
    ok('声称浮动却没有矩形 → 退回停靠（不留漂在 0,0 的面板）', noRect.mode === 'docked' && noRect.rect === null, JSON.stringify(noRect))
    const good = normalizePanelPrefs({ mode: 'floating', side: 'left', width: 420, rect: { left: 20, top: 80, width: 420, height: 500 } })
    ok('合法偏好原样保留', good.mode === 'floating' && good.side === 'left' && good.rect?.left === 20, JSON.stringify(good))
  }

  // ⑥ 序列化
  {
    const text = serializePanelPrefs({ mode: 'floating', side: 'left', width: 400.4, rect: { left: 12.6, top: 80.2, width: 400.4, height: 500.5 } })
    const back = normalizePanelPrefs(JSON.parse(text))
    ok('写入时取整（不留浮点噪声）', text.includes('"left":13') && text.includes('"width":400'), text)
    ok('写—读—归一后一致', back.mode === 'floating' && back.side === 'left' && back.rect?.width === 400, text)
    ok('停靠态不写 rect', !serializePanelPrefs(DEFAULT_PANEL_PREFS).includes('rect'))
  }

  // ⑦ 源码闸：默认样式逐字保留、层级不越界、拖动只认标题栏
  {
    const hook = readFileSync(path.join(process.cwd(), 'src/components/jiewenji/useJieWenJiPanelLayout.ts'), 'utf8')
    const panel = readFileSync(path.join(process.cwd(), 'src/components/jiewenji/JieWenJi.tsx'), 'utf8')
    ok('源码闸：停靠样式与改动前逐字一致（右）', hook.includes("'absolute right-3 top-14 bottom-10 w-[360px]'"))
    ok('源码闸：停靠样式与改动前逐字一致（左）', hook.includes("'absolute left-3 top-14 bottom-10 w-[360px]'"))
    ok('源码闸：默认偏好是停靠', /mode: 'docked'/.test(hook))
    ok('🔴 源码闸：层级仍取 Z.pagePanel（不许盖住弹窗/toast）',
      panel.includes('zIndex: Z.pagePanel') && !/Z\.(modal|toast|prompt|boss)/.test(panel))
    ok('源码闸：拖动只从标题栏触发', panel.includes('{...layout.headerProps}'))
    ok('源码闸：标题栏内按钮/输入框不触发拖动',
      hook.includes('const INTERACTIVE =')
      && hook.includes('[data-no-drag]')
      && hook.includes('closest(INTERACTIVE)'))
    ok('源码闸：浮动时才有拉宽把手', panel.includes('{floating && (') && panel.includes("role=\"separator\""))
    ok('源码闸：开关是可访问的两态按钮', /aria-pressed=\{floating\}/.test(panel))
    ok('源码闸：双击标题栏可复位', hook.includes('onDoubleClick'))
    ok('源码闸：窄窗口用共享常量判定', hook.includes('PANEL_FLOAT_MIN_VIEWPORT'))
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} panelDock ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main()
