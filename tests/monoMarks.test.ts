// 3.1.1 · 「纯黑白」图表的第二编码：线型 / 形状 / 纹理 / 边框（纯函数）
// 🔴 这里钉的是验收口径的核心判据：**同类同档、异类异档**（同一图内互不相同），
//    以及「不引入裸色值」（黑白一律走主题变量）。
import { readFileSync } from 'node:fs'
import {
  MONO_DASHES, MONO_SHAPES, MONO_BORDER_STYLES,
  monoDashOf, monoShapeOf, monoDashLookup, monoShapeLookup,
  monoShapePath, monoHatchBackground, monoCardBorder,
} from '../src/lib/settings/monoMarks'
import { typeHash } from '../src/lib/world/relationColors'

let failures = 0
function check(name: string, condition: boolean) {
  if (condition) console.log(`PASS ${name}`)
  else { failures++; console.error(`FAIL ${name}`) }
}

// ---- 档位表本身 ----
check('线型档位 6 档、第一档是实线（空串）', MONO_DASHES.length === 6 && MONO_DASHES[0] === '')
check('形状档位 6 档且互不相同', MONO_SHAPES.length === 6 && new Set(MONO_SHAPES).size === 6)
check('边框线型档位 4 种且互不相同', MONO_BORDER_STYLES.length === 4 && new Set(MONO_BORDER_STYLES).size === 4)

// ---- 哈希取档：同名同档、跨次稳定 ----
check('monoDashOf 同名稳定', monoDashOf('敌对') === monoDashOf('敌对') && monoDashOf('敌对') === MONO_DASHES[typeHash('敌对') % 6])
check('monoShapeOf 同名稳定', monoShapeOf('青岚宗') === monoShapeOf('青岚宗'))
check('空键也能取到档（不崩、不越界）', MONO_DASHES.includes(monoDashOf('')) && MONO_SHAPES.includes(monoShapeOf('')))

// ---- 顺序分配：同图内互不相同（验收口径 1 的硬要求）----
const types = ['亲属', '师徒', '盟友', '敌对', '竞争', 'CP感情线']
const dashOf = monoDashLookup(types)
check('六个类型拿到六个互不相同的线型', new Set(types.map(dashOf)).size === 6)
check('顺序分配：按出现次序逐档推进', dashOf('亲属') === MONO_DASHES[0] && dashOf('师徒') === MONO_DASHES[1] && dashOf('盟友') === MONO_DASHES[2])
const shapeOf = monoShapeLookup(['甲宗', '乙门', '丙阁'])
check('三个类别拿到三个互不相同的形状', new Set(['甲宗', '乙门', '丙阁'].map(shapeOf)).size === 3)
check('集合外的散值回落哈希（稳定不崩）', typeof dashOf('未登记类型') === 'string' && MONO_SHAPES.includes(shapeOf('未登记类别')))
check('档位用尽后回绕（第 7 个与第 1 个同档）',
  monoDashLookup(['a', 'b', 'c', 'd', 'e', 'f', 'g'])('g') === MONO_DASHES[0])
check('重复键不占额外档位', monoDashLookup(['x', 'x', 'y'])('y') === MONO_DASHES[1])

// ---- 形状 path ----
for (const shape of MONO_SHAPES) {
  const d = monoShapePath(shape, 100, 50, 10)
  check(`形状 ${shape} 产出合法闭合 path`, d.startsWith('M ') && d.endsWith('Z'))
}
check('形状 path 围绕给定中心与半径', monoShapePath('circle', 100, 50, 10).startsWith('M 100 40'))
check('正方形按外接半径收边（边长 r×0.82）', monoShapePath('square', 100, 50, 10).includes('91.8'))

// ---- 纹理（CSS）----
const hatches = [0, 1, 2, 3, 4, 5].map(monoHatchBackground)
check('六种纹理互不相同', new Set(hatches).size === 6)
check('纹理是 CSS 渐变且走主题变量', hatches.every(h => h.startsWith('repeating-linear-gradient(') && h.includes('rgb(var(--ink-100))')))

// ---- 卡片边框：前六类互不相同 ----
const borders = [0, 1, 2, 3, 4, 5].map(i => { const b = monoCardBorder(i); return `${b.borderStyle}/${b.borderWidth}` })
check('六类卡片拿到六个互不相同的边框组合', new Set(borders).size === 6)
check('double 用粗边（1px 渲染不出双线）', monoCardBorder(3).borderStyle === 'double' && monoCardBorder(3).borderWidth === 3)

// ---- 结构性自检：本模块不得出现裸色值（结构闸 ⑨ 的口径）----
const src = readFileSync('src/lib/settings/monoMarks.ts', 'utf8')
check('monoMarks 源码内无裸 hex 色值', !/#[0-9a-fA-F]{3,8}\b/.test(src))

if (failures) process.exit(1)
