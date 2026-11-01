// ============ 3.3.3 · G-04 3.3.2 旧项目升级与"新格式只读"回退 ============
//
// 钉住（规划 §14.4 / 验收 G-04）：
//   ① 旧格式项目包（缺少 snapshots/aiRuns/customOptions 等可选字段）能导入，正文、表格字段、图鉴图片、
//      项目设置与 AI 账本都不丢；
//   ② 图鉴字段配置来自更高 formatVersion 时：读取标 `newerFormat`，写入**明确拒绝**（不能盲目降格式）；
//   ③ 导入旧包不会激活文件里的任务台账（B-08 已在 exportIsolation 覆盖，这里补"升级路径"视角）。
// 🔴 这是合成旧格式夹具（不碰真实用户库）；桌面/便携/云端真实升级与回退仍需实机。
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { atlasSchemaKey, loadAtlasSchema, saveAtlasSchema } from '../src/lib/atlas/persistence'
import type { ProjectBundle } from '../src/lib/db/projects'
import type { TableRow } from '../src/lib/types'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const OLD_PID = 'p-old-332'

function oldBundle(): ProjectBundle {
  return {
    app: 'youth-fantasy-engine',
    version: 3,
    exportedAt: 1,
    project: {
      id: OLD_PID, name: '3.3.2 旧项目', genre: '玄幻', projectType: 'long',
      createdAt: 1, updatedAt: 1, description: '',
    },
    volumes: [{ id: 'v1', projectId: OLD_PID, title: '卷一', order: 0, createdAt: 1, updatedAt: 1 }],
    chapters: [{
      id: 'c1', projectId: OLD_PID, volumeId: 'v1', order: 0, title: '旧章',
      content: '旧版正文一字不改', summary: '', status: 'draft', wordCount: 8, createdAt: 1, updatedAt: 1,
    }],
    formData: [{ tabId: 'style', data: { '叙述口径::人称': '第三人称限知' } }],
    tableRows: [{
      id: 'r1', projectId: OLD_PID, tabId: 'races', order: 0,
      data: { 名称: '霜族', cf_lore: '旧版图鉴字段' },
      atlasImage: { dataUrl: 'data:image/png;base64,OLD_IMAGE', mime: 'image/png', width: 1, height: 1, bytes: 4 },
    } as TableRow],
    cardRecords: [],
    settings: [{ key: 'syncBinding', value: { cloudProjectId: 'cloud-old', baseRevision: 7 } }],
    aiRuns: [{ id: 'run1', projectId: OLD_PID, kind: 'creative', title: '旧账本', startedAt: 1, status: 'done' } as never],
  } as unknown as ProjectBundle
}

async function main() {
  __resetMockStores()
  const newPid = await db.importProject(oldBundle())
  db.setCurrentProject(newPid)
  ok('旧包导入返回新项目 id', !!newPid && newPid !== OLD_PID)

  const chapters = await db.getAllChapters()
  ok('正文逐字保留', chapters.length === 1 && chapters[0].content === '旧版正文一字不改')
  const style = await db.getFormDataFor(newPid, 'style')
  ok('表单字段保留', style['叙述口径::人称'] === '第三人称限知')
  const rows = await db.getTableRowsFor(newPid, 'races')
  ok('表格字段与图鉴图片保留',
    rows.length === 1 && rows[0].data.cf_lore === '旧版图鉴字段'
      && (rows[0] as TableRow).atlasImage?.dataUrl === 'data:image/png;base64,OLD_IMAGE',
    JSON.stringify(rows))
  const binding = await db.getSettingFor<{ cloudProjectId?: string }>(newPid, 'syncBinding', {})
  ok('同步绑定随设置保留（值整体搬运）', binding.cloudProjectId === 'cloud-old')
  const runs = await db.listProjectAiRuns(newPid)
  ok('AI 账本随包导入并换 projectId', runs.length === 1 && runs[0].projectId === newPid)

  // ② 新格式只读：formatVersion 高于本版
  const future = {
    formatVersion: 99, revision: 3,
    fields: [{ id: 'cf_future', label: '未来字段', type: 'text', description: '', options: [], appliesTo: '*', groupId: 'g', order: 0, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: true, archived: false }],
    groups: [], builtinPresentation: {}, summaryKeys: [],
  }
  await db.setSettingFor(newPid, atlasSchemaKey('races'), future)
  const loaded = await loadAtlasSchema(newPid, 'races')
  ok('更高格式读取标 newerFormat', loaded.newerFormat === true && loaded.config.revision === 3)

  let rejected: unknown = null
  try {
    await saveAtlasSchema(newPid, 'races', { ...loaded.config, revision: 3 })
  } catch (e) { rejected = e }
  ok('更高格式写入明确拒绝', !!rejected && /更新版本|只读/.test(String(rejected)), String(rejected))
  const after = await db.getSettingFor<{ revision?: number; formatVersion?: number }>(newPid, atlasSchemaKey('races'), {})
  ok('拒绝后没有降格式写回', after.formatVersion === 99 && after.revision === 3, JSON.stringify(after))
  ok('旧记录仍在（没被静默删除）', after.formatVersion === 99)

  console.log(`\nupgradeCompat: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()