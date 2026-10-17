/**
 * 视觉巡检 A–G 闸（2026-10-18 拍板落地）
 *
 * 巡检报告 §三 的 8 条（H 不改），主人拍板「A 修改 + 其余按推荐」后全部落地。
 * 这一闸钉住每条的**关键结构判据**，防止后续改动悄悄改回去：
 *   A 正文列保底 + 「铺满/限宽」开关只在宽列显示（窄列下它是点了没反应的死开关）
 *   B 「导入/导出/清空全部」收进「更多」菜单（清空全部不许再常驻红按钮）
 *   C 表格横向溢出时的右侧渐隐提示
 *   D 说明段落字号 11px（badge / 序号 / 代码块刻意保留 10px，别误伤）
 *   E 表单型页签放宽到 max-w-5xl
 *   F 人物文件夹头的关系摘要 chips
 *   G 编号类列单元格不折行 + 默认 130
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++
    console.log(`PASS ${name}${extra ? ' :: ' + extra : ''}`)
  } else {
    fail++
    console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`)
  }
}

// ---------- A 正文列保底 + 铺满开关 ----------
{
  const model = read('src/components/editor/useNovelEditorModel.ts')
  ok('A 正文列保底常量在位（MAIN_MIN_W=560 / SEARCH_MIN_W=280）',
    model.includes('const MAIN_MIN_W = 560') && model.includes('const SEARCH_MIN_W = 280'))
  ok('🔴 A 检索栏只压渲染宽度、不写回 localStorage（偏好原样保留）',
    model.includes('const searchPaneW') && model.includes('Math.min(searchPane.size,'))
  ok('🔴 A 铺满开关判据：正文列 ≥900px 才显示（<768 时 max-w 不生效=死开关）',
    model.includes('const showPageWide = mainColW >= 900'))
  ok('🔴 A wrapRef 测宽 effect 依赖必须带 loaded（[] 会在 LoadingState 阶段拿空 ref 后永久失效）',
    /const ro = new ResizeObserver\(read\)\s+ro\.observe\(el\)\s+return \(\) => ro\.disconnect\(\)\s+\}, \[loaded\]\)/.test(model))

  const editor = read('src/components/editor/NovelEditor.tsx')
  ok('A 三栏容器挂上 wrapRef', /<div ref=\{wrapRef\} className="flex h-full page-enter overflow-hidden">/.test(editor))
  ok('A 检索栏渲染宽度用保底后的 searchPaneW', editor.includes('width: searchPaneW, minWidth: searchPaneW'))
  ok('🔴 A 铺满按钮包在 showPageWide 条件里（窄列不渲染）',
    /\{showPageWide && \(\s*<Button variant="bare"\s+onClick=\{\(\) => \{ const v = !pageWide/.test(editor))
}

// ---------- B 更多菜单 ----------
{
  const sheet = read('src/components/sheets/TableSheet.tsx')
  ok('B TableSheet 已接入 TableMoreMenu', sheet.includes("import TableMoreMenu, { type MoreMenuItem } from '@/components/sheets/TableMoreMenu'"))
  ok('🔴 B 清空全部不再常驻为 danger 按钮（危险色不常驻）', !sheet.includes('variant="danger"'))
  ok('B 导入 / 导出按钮已从工具条移除（收进菜单）',
    !/<FileDown size=\{14\} \/> 导入/.test(sheet) && !/<FileUp size=\{14\} \/> 导出/.test(sheet))

  const menu = read('src/components/sheets/TableMoreMenu.tsx')
  ok('B 菜单危险项常态中性、hover 才染红', menu.includes("'text-ink-400 hover:text-danger hover:bg-danger/10'"))
  ok('B 空菜单不渲染（母表不留一个点开是空的「更多」）', menu.includes('if (items.length === 0) return null'))
}

// ---------- C 右缘渐隐 ----------
{
  const sheet = read('src/components/sheets/TableSheet.tsx')
  ok('C 滚动容器挂 onScroll 同步提示', sheet.includes('onScroll={syncScrollHint}'))
  ok('C 渐隐条只在还有内容时出现（pointer-events-none 纯装饰）',
    /scrollHint && \(\s*<div\s+aria-hidden\s+className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l/.test(sheet))
}

// ---------- D 说明段落字号 ----------
{
  // 说明段落（text-10 + leading-relaxed + ink-500/600 的组合）应已全部升到 11px；
  // badge / 序号 / 代码块（text-10 但无 leading-relaxed，或 ink-400 的 pre）刻意保留。
  const files = [
    'src/components/tavern/TavernControlAdvanced.tsx',
    'src/components/tavern/TavernControlBasics.tsx',
    'src/components/tavern/TavernControlModes.tsx',
    'src/components/tavern/TavernWorld.tsx',
    'src/components/audit/CheckTools.tsx',
    'src/components/settings/AIConfigPanel.tsx',
    'src/components/editor/DraftBits.tsx',
  ]
  for (const f of files) {
    const src = read(f)
    ok(`D ${f.split('/').pop()} 不再有 10px 说明段落`,
      !/text-10 leading-relaxed text-ink-[56]00/.test(src) && !/text-10 text-ink-[56]00 leading-relaxed/.test(src))
  }
  const creative = read('src/components/creative/CreativeWritingPanel.tsx')
  ok('E 创意写作表单放宽到 max-w-5xl', creative.includes('mx-auto max-w-5xl'))
  const bookbreak = read('src/components/bookbreak/BookBreakPanel.tsx')
  ok('E 一键拆书表单放宽到 max-w-5xl', bookbreak.includes('mx-auto max-w-5xl'))
}

// ---------- F 关系摘要 ----------
{
  const rel = read('src/components/sheets/TableRelationGroups.tsx')
  ok('F 文件夹头补关系摘要 chips（关系类型去重）',
    rel.includes('const relTypes') && rel.includes('relTypes.slice(0, 3)'))
  ok('F 超出 3 个折叠成 +N（title 里能看全）',
    rel.includes("relTypes.length > 3") && rel.includes('relTypes.slice(3).join'))
}

// ---------- G 编号列不折行 ----------
{
  const shared = read('src/components/sheets/tableSheetShared.tsx')
  ok('G CellTextarea 支持 nowrap（编号是不可分割的标识）', shared.includes('nowrap') && shared.includes("'whitespace-pre'"))
  const row = read('src/components/sheets/TableSheetRow.tsx')
  ok('G 编号 / 章节号列启用 nowrap', row.includes('nowrap={isCodeLikeCol(col.name)}') && row.includes("n === '章节号'"))
  const model = read('src/components/sheets/useTableSheetModel.ts')
  ok('G 编号列默认宽 110 → 130', model.includes("if (col.name === '编号' || col.name === '章节号') return 130"))
}

console.log(`\n视觉巡检 A–G 闸: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
