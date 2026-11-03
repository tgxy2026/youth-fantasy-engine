// ============ 表格行首操作列「2×2」闸（3.1.2 · OPT-008）============
//
// 需求口径（主人 2026-10-17）：世界构建组表格页签行首的图标钮从竖排改为 2×2 ——
//   「之前这里是两个或三个按钮，每行数据的高度不会被撑得太长。但现在……表头都变成了
//     竖排四个按钮，导致页面变得很长、很难看。希望能将其修改成 2×2 的格式。」
//
// 根因：行首列 `w-7`(28px) 窄列 `flex-col` 竖排；3.1 P1「资料提及反向导航」给
//   nations 等 MENTION_TABS 表加了第 4 个钮（查看提及）——国家势力恰好 4 个
//   （查看提及/删除/AI 补全/新增子条目），竖排 4 枚 24px 钮 ≈ 每行撑高 100px。
//
// 结构口径：列宽单一真源 `ROW_ACTION_COL_W = 64`（useTableSheetModel.ts），
//   三处同源——totalWidth 累加 / 表头 th 设宽 / 行首 td 设宽。table-fixed 下
//   列宽由 thead 决定，只改 td 不改 th 会出现头体宽度不一致。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

console.log('—— tableSheetRowActions：行首操作列 2×2 闸（3.1.2）——')

const model = read('src/components/sheets/useTableSheetModel.ts')
const sheet = read('src/components/sheets/TableSheet.tsx')
const row = read('src/components/sheets/TableSheetRow.tsx')

// ---------- ① 列宽单一真源 ----------
{
  ok('① ROW_ACTION_COL_W = 64 在模型文件导出（2×2 容量：2×24px 钮 + 2px 距 + 8px 内边距 ≈ 58px）',
    model.includes('export const ROW_ACTION_COL_W = 64'))
  ok('① totalWidth 累加该常量（旧写死 + 28 与漂移注释「操作列(48)」一并清除）',
    model.includes('+ 40 + ROW_ACTION_COL_W') && !model.includes('+ 40 + 28'))
}

// ---------- ② 行首列本体：可换行居中（4 钮即 2×2，奇数钮自动收窄） ----------
{
  ok('② 行首 td 用常量设宽（不再写死 w-7）',
    row.includes('<td className="px-1 py-1 align-middle" style={{ width: ROW_ACTION_COL_W }}>'))
  ok('② 行首容器为 flex-wrap + 双向居中（content-center 防多行钮组在高的行里贴顶）',
    row.includes('flex flex-wrap items-center justify-center content-center gap-0.5 h-full'))
  ok('② 负向：竖排布局 flex-col 在行首容器根除',
    !row.includes('flex flex-col items-center justify-center gap-0.5 h-full'))
}

// ---------- ③ 表头 th 同步（table-fixed 列宽由 thead 定） ----------
{
  ok('③ 表头行动列 th 同步用常量设宽（头体一致，防 table-fixed 下错位）',
    sheet.includes('<th className="bg-ink-800 px-1 py-2.5 align-middle" style={{ width: ROW_ACTION_COL_W }} />'))
}

// ---------- ④ 负向控制：三文件 className 里不许残留 w-7 令牌 ----------
// 注释里提旧值没关系（那是史料），但类名回退=窄列竖排复活。
{
  const CLS = /className=(?:"([^"]*)"|'([^']*)')/g
  const bad: string[] = []
  for (const [name, src] of [['useTableSheetModel.ts', model], ['TableSheet.tsx', sheet], ['TableSheetRow.tsx', row]] as const) {
    for (const m of src.matchAll(CLS)) {
      const cls = m[1] ?? m[2] ?? ''
      if (/(?:^|\s)w-7(?:\s|$)/.test(cls)) bad.push(`${name} → className 含 w-7`)
    }
  }
  ok('④ 负向：三文件 className 无 w-7 令牌（防窄列竖排复活）', bad.length === 0, bad.join(' | '))
}

// ---------- ⑤ 按钮集合不动（只改排布，不改谁显示） ----------
// 行首钮按条件渲染：查看提及（MENTION_TABS）/ 删除 / AI 补全 / 新增子条目 / 打开正文。
// 本闸只锁排布与列宽，不锁显示逻辑——但四个入口必须都在，防止被「顺手简化」。
{
  const entries = ['title="删除此行"', 'AI 补全本行空白', '在「${tree.nameOf(row)', 'title="打开本章正文编辑"', '查看']
  const missing = entries.filter(e => !row.includes(e))
  ok('⑤ 行首钮入口齐全（删除 / AI 补全 / 新增子条目 / 打开正文 / 查看提及——只改排布不改显示逻辑）',
    missing.length === 0, `缺：${missing.join(' | ')}`)
}

console.log(`\ntableSheetRowActions: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
