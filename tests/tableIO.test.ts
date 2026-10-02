// ============ 表格批量导入导出（2.6.4）============
//
// 锁六件事：
//   ① 四种输入的自动识别：Markdown 表格 / TSV（Excel 粘贴）/ CSV / 纯文本；
//   ② 列名映射（不靠列位置）—— 作者在 Excel 里调换列序也能导对；
//   ③ 纯文本两种拆法：「列名：值」块 与 逐行；
//   ④ 校验：判重（无序对 A-B = B-A）/ 缺必填 / tableRef 悬空 / 编号冲突；
//   ⑤ 落库行：编号走 nextAutoCode 补号（多行不撞号）；
//   ⑥ 导出转义：含逗号/引号的单元格要正确包裹。
import {
  splitCsvLine, splitMdRow, isMdSeparator, parseImportText, mapHeaders, matrixToRows,
  mainColumn, textToRows, validateImport, buildImportRows, exportRowsCsv, exportTemplateCsv,
  csvCell, buildImportGuide, splitIntoChunks, type ImportContext,
} from '../src/lib/tableIO'
import type { TabDef, TableRow } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'p1'
const nations: TabDef = {
  id: 'nations', name: '国家势力', group: '世界构建', type: 'table', description: '',
  displayCol: '名称',
  columns: [
    { name: '编号' },
    { name: '名称' },
    { name: '上级', type: 'tableRef', refTab: 'nations', refCol: '名称' },
    { name: '类别', type: 'select', options: ['王朝', '宗门', '世家'] },
  ],
}
const relations: TabDef = {
  id: 'relations', name: '人物关系', group: '世界构建', type: 'table', description: '',
  columns: [{ name: '人物A' }, { name: '人物B' }, { name: '关系类型' }],
}
function row(id: string, data: Record<string, string>, order = 0, tabId = 'nations'): TableRow {
  return { id, projectId: PID, tabId, data, order, createdAt: 0 }
}

// ---------- 1. CSV / Markdown 基础拆分 ----------
{
  ok('splitCsvLine 基本', splitCsvLine('a,b,c').join('|') === 'a|b|c')
  ok('splitCsvLine 引号包裹逗号', splitCsvLine('"a,b",c').join('|') === 'a,b|c', splitCsvLine('"a,b",c').join('|'))
  ok('splitCsvLine 双引号转义', splitCsvLine('"say ""hi""",x').join('|') === 'say "hi"|x', splitCsvLine('"say ""hi""",x').join('|'))
  ok('splitMdRow 去首尾竖线', splitMdRow('| a | b |').join('|') === 'a|b')
  ok('isMdSeparator 认分隔行', isMdSeparator('| --- | :--: |') && !isMdSeparator('| 名称 | 类别 |'))
}

// ---------- 2. parseImportText 四种输入 ----------
{
  const md = parseImportText('| 名称 | 类别 |\n| --- | --- |\n| 青云宗 | 宗门 |\n| 大炎王朝 | 王朝 |')
  ok('识别 Markdown 表格', md.format === 'md' && md.table!.headers.join(',') === '名称,类别' && md.table!.rows.length === 2, md.note)

  const tsv = parseImportText('名称\t类别\n青云宗\t宗门')
  ok('识别 TSV（Excel 粘贴）', tsv.format === 'tsv' && tsv.table!.rows[0].join(',') === '青云宗,宗门', tsv.note)

  const csv = parseImportText('名称,类别\n青云宗,宗门\n大炎王朝,王朝')
  ok('识别 CSV', csv.format === 'csv' && csv.table!.rows.length === 2, csv.note)

  const txt = parseImportText('青云宗，立派千年的宗门。\n大炎王朝，一统中原。')
  ok('中文逗号不误判为 CSV（走纯文本）', txt.format === 'text', txt.format)

  const maybe = parseImportText('这是第一行，有逗号\n这是第二行，也有逗号，还多一个')
  ok('逗号数不一致 → 不误判为 CSV', maybe.format === 'text', maybe.format)
}

// ---------- 3. 列名映射（不靠位置）----------
{
  const headers = ['类别', '名称', '不存在列']
  const map = mapHeaders(headers, nations)
  ok('按列名映射，位置任意', map.join(',') === '类别,名称,', map.join(','))
  ok('未知列映射为 null（忽略）', map[2] === null)

  // 列序颠倒也能导对
  const table = { headers, rows: [['宗门', '青云宗', 'x']] }
  const rows = matrixToRows(table, map, nations)
  ok('颠倒列序后值落到正确列', rows[0]['名称'] === '青云宗' && rows[0]['类别'] === '宗门', JSON.stringify(rows[0]))
}

// ---------- 4. mainColumn / textToRows ----------
{
  ok('mainColumn 取 displayCol', mainColumn(nations) === '名称')

  const kv = textToRows('名称：青云宗\n类别：宗门\n\n名称：大炎王朝\n类别：王朝', nations)
  ok('「列名：值」块 → 两条', kv.rows.length === 2 && kv.rows[0]['名称'] === '青云宗' && kv.rows[1]['类别'] === '王朝', JSON.stringify(kv.rows))

  const line = textToRows('青云宗\n大炎王朝', nations)
  ok('逐行拆分 → 内容进主列', line.rows.length === 2 && line.rows[0]['名称'] === '青云宗' && line.rows[1]['名称'] === '大炎王朝', JSON.stringify(line.rows))
}

// ---------- 5. validateImport：判重 / 无序对 ----------
{
  const ctx: ImportContext = { existing: [row('r1', { 名称: '青云宗' })], refValues: new Map() }
  const res = validateImport([{ 名称: '青云宗' }, { 名称: '大炎王朝' }], nations, ctx)
  ok('与库内同名 → dupExisting', res[0].dupExisting === true)
  ok('不重名 → 不标重复', res[1].dupExisting === false)

  // 无序对：A-B 与 B-A 视为同一条
  const relCtx: ImportContext = {
    existing: [row('x1', { 人物A: '林清欢', 人物B: '陈渊' }, 0, 'relations')],
    refValues: new Map(),
  }
  const relRes = validateImport([{ 人物A: '陈渊', 人物B: '林清欢' }], relations, relCtx)
  ok('人物关系无序对判重（A-B = B-A）', relRes[0].dupExisting === true)
  ok('批内重复也标出', validateImport([{ 名称: '甲' }, { 名称: '甲' }], nations, { existing: [], refValues: new Map() })[1].dupInBatch === true)
  ok('判重键全空的行不互相判重', validateImport([{ 名称: '' }, { 名称: '' }], nations, { existing: [], refValues: new Map() })[1].dupInBatch === false)
}

// ---------- 6. validateImport：缺必填 / 悬空 / 编号冲突 ----------
{
  const ctx: ImportContext = {
    existing: [row('r1', { 编号: 'N0001', 名称: '青云宗' })],
    refValues: new Map([['nations', new Set(['青云宗'])]]),
    refLabels: new Map([['nations', '国家势力']]),
  }
  const res = validateImport([
    { 名称: '', 上级: '青云宗' },
    { 名称: '魔教', 上级: '不存在的势力' },
    { 编号: 'N0001', 名称: '撞号宗' },
  ], nations, ctx)
  ok('缺必填（主列空）标出', res[0].missing.includes('名称'), JSON.stringify(res[0].missing))
  ok('tableRef 悬空标出', res[1].dangling.length === 1 && res[1].dangling[0].value === '不存在的势力', JSON.stringify(res[1].dangling))
  ok('有效引用不报警', validateImport([{ 名称: 'X', 上级: '青云宗' }], nations, ctx)[0].dangling.length === 0)
  ok('编号与库内冲突标出', res[2].codeConflict === true)
}

// ---------- 7. buildImportRows：编号补号 + order ----------
{
  const existing = [row('r1', { 编号: 'N0001' })]
  const picked = validateImport([{ 名称: 'A' }, { 名称: 'B' }], nations, { existing, refValues: new Map() })
  const built = buildImportRows(picked, nations, existing, PID, (() => { let n = 0; return () => `new-${++n}` })())
  ok('空编号自动补号（N0002 / N0003，不撞号）', built[0].data['编号'] === 'N0002' && built[1].data['编号'] === 'N0003', `${built[0].data['编号']},${built[1].data['编号']}`)
  ok('order 接在已有行之后', built[0].order === 1 && built[1].order === 2, `${built[0].order},${built[1].order}`)
  ok('不写库（纯构造行对象）', built.length === 2 && built[0].tabId === 'nations')
}

// ---------- 8. 导出 ----------
{
  ok('csvCell 含逗号要加引号', csvCell('a,b') === '"a,b"')
  ok('csvCell 含引号要转义', csvCell('a"b') === '"a""b"', csvCell('a"b'))
  ok('csvCell 换行折成空格（不破坏行结构）', csvCell('a\nb') === 'a b')

  const tmpl = exportTemplateCsv(nations)
  ok('空白模板只有一行表头', tmpl === '编号,名称,上级,类别', tmpl)

  const data = exportRowsCsv(nations, [row('r1', { 编号: 'N0001', 名称: '青,云宗', 类别: '宗门' })])
  ok('数据导出：表头 + 含逗号字段被引号包裹', data.split('\n')[0] === '编号,名称,上级,类别' && data.includes('"青,云宗"'), data)
}

// ---------- 9. 导入说明（三种方式 + 给外部 AI 的提示词包）----------
{
  const guide = buildImportGuide(nations)
  ok('说明含表头行（可复制）', guide.includes('编号,名称,上级,类别'))
  ok('说明含给外部 AI 的提示词', guide.includes('请把下面的设定整理成一张 CSV 表格'))
  ok('说明标注必填列', guide.includes('**必填**'))
  // 2.7.0：三种导入方式必须逐一说清「什么时候用哪一种」
  ok('说明讲了方式一（照着模板填）', guide.includes('方式一') && guide.includes('Excel'))
  ok('说明讲了方式二（交给别的 AI 整理）', guide.includes('方式二') && guide.includes('别的 AI'))
  ok('说明讲了方式三（AI 智能拆分）', guide.includes('方式三') && guide.includes('AI 智能拆分'))
  ok('说明重申勾稽靠名称一致（不会失效）', guide.includes('勾稽关系'))
  ok('外部 AI 提示词里加了「不合并成一行」的约束', guide.includes('不要把一个对象拆成多行'))
}

// ---------- 10. 长文分批（AI 智能拆分用）----------
{
  ok('短文本不分批', splitIntoChunks('一段很短的设定').length === 1)
  ok('空白串不分批（返回 0 段）', splitIntoChunks('   \n  ').length === 0)

  // 12 个由空行隔开的条目块，总长明显超过 1000
  const blocks = Array.from({ length: 12 }, (_, i) => `第${i + 1}条设定：${'填充'.repeat(200)}`).join('\n\n')
  const chunks = splitIntoChunks(blocks, 1000)
  ok('长文被切成多段', chunks.length > 1, String(chunks.length))
  ok('每段都非空', chunks.every(c => c.trim().length > 0))
  ok('🔴 每段都不超过预算上限（保证单次喂给模型的量可控）',
    chunks.every(c => c.length <= 1000), chunks.map(c => c.length).join(','))
  ok('分段不重叠：去掉空白后总字数基本不减',
    chunks.join('').replace(/\s/g, '').length >= blocks.replace(/\s/g, '').length * 0.98,
    `${chunks.join('').replace(/\s/g, '').length} vs ${blocks.replace(/\s/g, '').length}`)

  // 无换行的超长单段：必须按字数硬切，不能一整坨塞给模型
  const oneLine = 'x'.repeat(5000)
  const oneChunks = splitIntoChunks(oneLine, 1000)
  ok('无空行的超长单段也会被硬切', oneChunks.length === 5, String(oneChunks.length))
  ok('硬切结果可直接拼回原文', oneChunks.join('') === oneLine)
}

console.log(`\ntableIO: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
