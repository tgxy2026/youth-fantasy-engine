// ============ 3.4.0 · E 具名导出方案 ============
//
// 导出方案钉住四件事：
//   ① 方案按项目隔离（存在 settingsKV，键为 exportSchemes），不跨项目共享章节引用；
//   ② 方案只保存章节 id 和格式意图，绝不存储章节正文内容；
//   ③ 章节失效（被删除）时通过 resolveSchemeChapters 明确拆出失效列表；
//   ④ 接线核对：ExportFormatDialog 包含导出方案与失效章节提示。

import fs from 'node:fs'
import path from 'node:path'
import {
  validateSchemeName,
  createScheme,
  resolveSchemeChapters,
  updateScheme,
  SCHEME_MAX_NAME_LEN,
  SCHEME_SETTING_KEY,
} from '../src/lib/app/exportScheme'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ---------- ① 方案名称校验 ----------
{
  ok('空名拒绝', !validateSchemeName('').ok)
  ok('空格名拒绝（trim 后为空）', !validateSchemeName('   ').ok)
  ok('超长名拒绝', !validateSchemeName('x'.repeat(SCHEME_MAX_NAME_LEN + 1)).ok)
  ok('正常名通过', validateSchemeName('投稿前五章').ok)
  ok('带空格的正常名通过', validateSchemeName(' 比赛精选集 ').ok)
}

// ---------- ② 创建方案与默认全书 ----------
{
  const s1 = createScheme('全书方案', 'markdown', null)
  ok('创建方案有 id', typeof s1.id === 'string' && s1.id.length > 0)
  ok('名称正确 trim', s1.name === '全书方案')
  ok('chapterIds 为 null 代表全书', s1.chapterIds === null)
  ok('格式记录正确', s1.format === 'markdown')
  ok('创建时间与更新时间有效', s1.createdAt > 0 && s1.updatedAt >= s1.createdAt)

  const s2 = createScheme('选章方案', 'docx', ['c1', 'c2'], { preset: 'submission' })
  ok('指定章节方案正确记录 chapterIds', Array.isArray(s2.chapterIds) && s2.chapterIds.length === 2)
  ok('可携带 layoutHint', s2.layoutHint?.preset === 'submission')
}

// ---------- ③ 有效与失效章节拆分 ----------
{
  const allIds = new Set(['c1', 'c2', 'c3'])

  const sNull = createScheme('全书', 'platform', null)
  const resNull = resolveSchemeChapters(sNull, allIds)
  ok('chapterIds 为 null 时 valid 包含全部现有章节', resNull.valid.length === 3 && resNull.invalid.length === 0)

  const sPartial = createScheme('部分', 'platform', ['c1', 'c99', 'c2', 'c100'])
  const resPartial = resolveSchemeChapters(sPartial, allIds)
  ok('有效章节拆出 c1, c2', resPartial.valid.length === 2 && resPartial.valid.includes('c1') && resPartial.valid.includes('c2'))
  ok('失效章节拆出 c99, c100', resPartial.invalid.length === 2 && resPartial.invalid.includes('c99') && resPartial.invalid.includes('c100'))
}

// ---------- ④ 更新方案 ----------
{
  const s = createScheme('原名', 'docx', ['c1'])
  const t0 = s.updatedAt
  const updated = updateScheme(s, { name: '新名', chapterIds: ['c1', 'c2'] })
  ok('更新方案名称成功', updated.name === '新名')
  ok('更新章节列表成功', updated.chapterIds?.length === 2)
  ok('updatedAt 更新', updated.updatedAt >= t0)
}

// ---------- ⑤ 接线核对 ----------
{
  const libSrc = read('src/lib/app/exportScheme.ts')
  ok('方案存储走 getSettingFor/setSettingFor', libSrc.includes('db.getSettingFor') && libSrc.includes('db.setSettingFor'))
  ok('存储 key 使用 exportSchemes', libSrc.includes(SCHEME_SETTING_KEY))

  const dialogSrc = read('src/components/dialogs/ExportFormatDialog.tsx')
  ok('ExportFormatDialog 引入 exportScheme 模块', dialogSrc.includes('@/lib/app/exportScheme'))
  ok('ExportFormatDialog 包含 loadSchemes 或 saveSchemes 调用', dialogSrc.includes('loadSchemes') || dialogSrc.includes('saveSchemes'))
  ok('ExportFormatDialog 包含 projectId 字段', dialogSrc.includes('projectId'))
  ok('ExportFormatDialog 明确说明稿件导出不是完整备份', dialogSrc.includes('完整备份') || dialogSrc.includes('备份'))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
