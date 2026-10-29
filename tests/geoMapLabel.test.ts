// ============ 地图标签「格式统一 + 字号分档」闸（3.1.2 · OPT-006/007）============
//
// 需求口径（主人 2026-10-17，两轮发言合并）：
//   ① 粗精度模式：「所有的文字说明太大了」＋「不需要显示面积是多少格，只需要显示地理坐标的
//      名称即可。最多在后面加一个括号，注明地理坐标的类型。例如显示为'苍澜大陆（大陆）'」；
//   ② 精精度模式：「所有的文字又太小了」；
//   ③ 澄清（关键）：「地图标签的显示格式在两个精度下应该是一样的哈，都改成'地理位置的名称'
//      加上它的'类别'，都不要格数的显示了」⇒ **两档统一单行「名称（类别）」**。
//
// 根因：字号 `Math.max(11, 16 - depth * 2)` 只随层级深度变、与精度档位 cellKm 无关
//   ⇒ 精粗两种模式文字一样大，「粗了太大 / 精了太小」一次性命中。
//
// 口径落点：GeoMapEditor.tsx 画布标签（名称行 + 原「类别 · N 格」行 + 选中提示行）。
//   格数不是从产品里消失——右侧详情面板「当前形状：N 格」与左栏树列表「已画 N 格」保留
//   （那两处是查阅入口，画布上是冗余），本闸 ⑤ 钉住这点，防止被一并删光。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

console.log('—— geoMapLabel：地图标签格式统一 + 字号分档闸（3.1.2）——')

const editor = read('src/components/world/GeoMapEditor.tsx')

// ---------- ① 标签格式：单行「名称（类别）」，两档统一 ----------
{
  ok('① 画布标签为单行「名称（类别）」（主人示例口径：苍澜大陆（大陆））',
    editor.includes('>{mk.name}（{mk.category}）</text>'))
  // 负向：原两行布局（名称行 + 「类别 · N 格」行）不许复活
  ok('① 负向：画布上不再渲染「类别 · N 格」第二行',
    !editor.includes('· {vs.count} 格') && !/\} 格<\/text>/.test(editor))
}

// ---------- ② 字号按精度档位分档（精大 / 粗小） ----------
{
  // 精（cellKm=1）基础 20、粗（10km/格）基础 13；层级递减 -2/级；下限 13 / 10
  ok('② 字号基数按 cellKm 分档（精 20 / 粗 13）',
    editor.includes('const fsBase = cellKm >= 10 ? 13 : 20'))
  ok('② 下限随档位（精 15 / 粗 12），深度递减 -1.5/级',
    editor.includes('const fs = Math.max(cellKm >= 10 ? 12 : 15, fsBase - depth * 1.5)'))
  // 负向：原来与档位无关的固定算式不许回来
  ok('② 负向：不再有与精度无关的固定字号 Math.max(11, 16 - depth * 2)',
    !editor.includes('Math.max(11, 16 - depth * 2)'))
}

// ---------- ③ 选中提示行随单行标签上移 ----------
// 原布局假设标题占两行（y 偏移 fs*2+3）；单行后必须改为 fs+3，否则提示飘到离标题老远
{
  ok('③ 选中提示行偏移随单行标签调整（fs + 3，不再是 fs * 2 + 3）',
    editor.includes('y={vs.bbox.y - 5 + fs + 3}') && !editor.includes('fs * 2 + 3'))
}

// ---------- ④ 档位常量没被顺手改 ----------
// 精/粗两档是 CELL_KM_STEPS = [1, 10]；本闸只挪字号与格式，不动档位本身
{
  const geom = read('src/components/world/geoMapGeometry.ts')
  ok('④ 精度档位仍是 [1, 10]（G=36 不变；本次只改标签字号/格式）',
    geom.includes('export const CELL_KM_STEPS = [1, 10]') && geom.includes('export const G = 36'))
}

// ---------- ⑤ 格数查询入口保留（面板 + 左栏树列表） ----------
// 主人要的是「画布上不显示格数」，不是「产品里查不到格子数」——防过度删除
{
  const parts = read('src/components/world/GeoMapParts.tsx')
  ok('⑤ 详情面板仍显示「当前形状：N 格」（格数改去面板查，不从产品消失）',
    parts.includes('当前形状：<span className="text-amber">{cells} 格</span>'))
  ok('⑤ 左栏树列表仍显示「已画 N 格」',
    parts.includes('已画 {it.drawn} 格'))
}

console.log(`\ngeoMapLabel: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
