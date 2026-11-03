/**
 * 设定表「摘要化」（3.1.3 · R3 第二半）—— `ai/tableDigest.ts`。
 *
 * 盯四件事（都是设计时就定死、改起来最容易悄悄跑偏的）：
 *   ① 放得下就**原样**（小表零变化，否则等于"为了大表改坏所有表"）；
 *   ② 超限先**减列**再减行（22 条 × 8 字段 比 11 条 × 20 字段 有用）；
 *   ③ 保留谁：名称 / 作者指定字段 → 填充率高的列 → 原列序（**输出顺序仍是原列序**）；
 *   ④ 排序完全确定（本地模型 prompt prefix cache 靠前缀逐字一致）。
 */
import fs from 'node:fs'
import { digestTable } from '@/lib/ai/tableDigest'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 造一张表：cols 列、rows 行，每格 `填充` 字符 */
function make(cols: string[], rows: number, fill = '内容', nameIdx = 0) {
  return {
    columns: cols.map(c => ({ key: c, label: c })),
    rows: Array.from({ length: rows }, (_, r) =>
      cols.map((_, c) => (c === nameIdx ? `名${r}` : fill))),
  }
}

// ---------- ① 放得下 ⇒ 原样 ----------
{
  const t = make(['名称', '说明'], 3)
  const r = digestTable({ ...t, maxChars: 10000 })
  ok('① 放得下不压缩', r.compressed === false, JSON.stringify(r))
  ok('① 原样输出含全部行', r.text.split('\n').length === 4, String(r.text.split('\n').length))
  ok('① 没有申报行', !/另有/.test(r.text))
  ok('① kept 计数正确', r.keptColumns === 2 && r.keptRows === 3)
}

// ---------- ② 超限：先减列 ----------
{
  // 8 列 × 12 行，格子 6 字符 ⇒ 全量约 700 字符；预算 420 必须减列才能保住 12 条
  const t = make(['名称', '甲', '乙', '丙', '丁', '戊', '己', '庚'], 12, '六字内容')
  const r = digestTable({ ...t, maxChars: 420 })
  ok('② 压缩后不超预算', r.text.length <= 420, `${r.text.length} > 420`)
  ok('② 压缩标记为 true', r.compressed === true)
  ok('② 先减列、保住全部条目（这是本模块的核心取舍）', r.keptRows === 12, `keptRows=${r.keptRows} keptCols=${r.keptColumns}`)
  ok('② 名称列一定还在（否则卡片没锚点）', r.text.includes('名11'), r.text.slice(0, 60))
  ok('② 减掉的列如实申报', r.droppedColumnLabels.length > 0 && /另有 \d+ 列未列出/.test(r.text))
}

// ---------- ③ 保留优先级 ----------
{
  // 第 3 列（索引 2）全空 ⇒ 填充率最低，应先被砍
  const columns = [
    { key: '名称', label: '名称' },
    { key: '有值', label: '有值' },
    { key: '空列', label: '空列' },
    { key: '也空', label: '也空' },
  ]
  const rows = Array.from({ length: 10 }, (_, i) => [`名${i}`, '内容内容内容内容', '', ''])
  // 全量约 260 字符；预算 200 必须减列（先减列、保住 10 条）
  const r = digestTable({ columns, rows, maxChars: 200, preferKeys: ['名称'] })
  ok('③ 全空列最先被砍', r.droppedColumnLabels.includes('空列') || r.droppedColumnLabels.includes('也空'), JSON.stringify(r.droppedColumnLabels))
  ok('③ 有值的列留下了', r.text.split('\n')[0].includes('有值'), r.text.split('\n')[0])
  ok('③ 条目没被杀（减列保行）', r.keptRows === 10, `keptRows=${r.keptRows}`)
  ok('③ 名称列（preferKeys）始终保留', r.text.includes('名0'))
  /**
   * 输出列序＝**原列序**，不是按填充率重排（作者在表里怎么排，模型就怎么看到）。
   * 不钉"恰好剩几列"：空列不占宽度（值是空串），能留下就留下，砍到第 4 列才是这条要的。
   */
  ok('③ 输出列序仍是原列序（名称 ｜ 有值 …，与录入一致）',
    r.text.split('\n')[0].startsWith('名称 ｜ 有值') && !r.text.split('\n')[0].includes('也空'),
    r.text.split('\n')[0])
}

// ---------- ④ 确定性 & 不改输入 ----------
{
  const t = make(['名称', '甲', '乙'], 20, '内容内容内容内容')
  const a = digestTable({ ...t, maxChars: 300 })
  const b = digestTable({ ...t, maxChars: 300 })
  ok('④ 同输入两次输出逐字一致（prefix cache 依赖它）', a.text === b.text)
  ok('④ 不改动传入的 column 对象', t.columns[0].label === '名称' && t.columns.length === 3)
  ok('④ 不改动传入的行数组', t.rows.length === 20 && t.rows[0][0] === '名0')
}

// ---------- ⑤ 边界 ----------
{
  const empty = digestTable({ columns: [], rows: [], maxChars: 100 })
  ok('⑤ 空表返回空串', empty.text === '' && empty.compressed === false)

  const t = make(['名称', '说明'], 30, '很长很长很长很长很长很长很长很长很长')
  const tiny = digestTable({ ...t, maxChars: 60 })
  // 极小预算：要么带 1~2 行 + 申报，要么彻底放弃 —— 不能返回半截乱码
  ok('⑤ 极小预算不炸（返回空或带申报）',
    tiny.text === '' || /另有|只带了/.test(tiny.text), JSON.stringify(tiny.text.slice(0, 60)))
}

// ---------- ⑥ totalRows 申报（上游按行数上限截断过） ----------
{
  const t = make(['名称', '说明'], 10)
  const r = digestTable({ ...t, maxChars: 10000, totalRows: 25 })
  ok('⑥ 上游截断的行如实申报', /另有 15 行未列出/.test(r.text), r.text.slice(-40))
  ok('⑥ keptRows 只算真正输出的', r.keptRows === 10)
}

// ---------- ⑦ 源码闸：不许在这里读库 / 读偏好（纯函数，好测） ----------
{
  const src = fs.readFileSync('src/lib/ai/tableDigest.ts', 'utf8')
  ok('⑦ 摘要器不读库', !/from '@\/lib\/db'/.test(src))
  ok('⑦ 摘要器不读本机偏好', !/read(String|Bool|Set)?Pref\(/.test(src))
}

console.log(`\n—— tableDigest 用例结束：${pass} 通过 / ${fail} 失败 ——`)
if (fail > 0) process.exit(1)
