// ============ 3.3.5 · D2/D3 还原工程前强制预备份与状态可信校验 ============
import * as db from '../src/lib/db'
import { createDemoProject } from '../src/lib/app/seedData'
import { __resetMockStores } from './mock-memory'
import { ops } from '../src/lib/db/core'
import { setKbBackend, importDoc, listDocs, getDocText, restoreDocsFromBundle, type KbDoc } from '../src/lib/search/knowledgeBase'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function run() {
  __resetMockStores()

  // 准备测试项目 A
  const pid = await createDemoProject()
  db.setCurrentProject(pid)
  await db.updateProject({ id: pid, name: '还原安全测试作品' })

  // 1. 生成一份历史备份快照
  const snap1 = (await db.createAutoBackup(pid, 'manual', '历史快照 V1'))!
  ok('成功创建历史快照 V1', !!snap1 && !!snap1.id)

  // 2. 修改项目数据（新增一章、修改项目简介）
  const vols = await db.getAllVolumes()
  const newChapterId = 'ch-new-' + Date.now()
  await db.saveChapter({
    id: newChapterId,
    projectId: pid,
    volumeId: vols[0].id,
    order: 999,
    title: '修改后的最新章',
    content: '这是在快照 V1 之后写的新内容',
    summary: '',
    status: '草稿',
    wordCount: 14,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.updateProject({ id: pid, intro: '修改后的最新简介' })

  const chaptersBeforeRestore = await db.getAllChapters()
  const hasNewChapterBefore = chaptersBeforeRestore.some(c => c.id === newChapterId)
  ok('还原前库中存在最新章', hasNewChapterBefore)

  const backupsCountBefore = (await db.listBackups(pid)).length

  // 3. 执行 restoreBackup，断言强制自动预备份已生成且返回 RestoreOutcome
  const outcome = await db.restoreBackup(snap1.id)
  ok('restoreBackup 返回 ok=true', outcome.ok === true)
  ok('返回 targetProjectId 正确', outcome.targetProjectId === pid)
  ok('返回预备份 id (preBackupId)', !!outcome.preBackupId)
  ok('返回预备份标签包含安全备份说明', !!outcome.preBackupLabel && outcome.preBackupLabel.includes('还原前安全备份'))
  ok('返回还原的卷数与章数', outcome.restoredVolumes > 0 && outcome.restoredChapters > 0)

  // 4. 验证预备份是否存在于备份列表中且可以完整读取
  const backupsAfter = await db.listBackups(pid)
  ok('备份列表中新增了预备份', backupsAfter.length === backupsCountBefore + 1)
  const preBackupRecord = backupsAfter.find(b => b.id === outcome.preBackupId)
  ok('预备份记录存在', !!preBackupRecord)
  ok('预备份类型为 manual（不被高频自动轮转淘汰）', preBackupRecord?.kind === 'manual')

  const preBackupPayload = await db.getBackupPayload(outcome.preBackupId!)
  ok('预备份载荷可正常读回', !!preBackupPayload && !!preBackupPayload.project)
  const preBackupHasNewChapter = preBackupPayload?.chapters.some(c => c.title === '修改后的最新章')
  ok('预备份完整保留了被覆盖前的最新章', !!preBackupHasNewChapter)

  // 5. 验证目标项目已被安全还原到 V1
  const chaptersAfterRestore = await db.getAllChapters()
  const hasNewChapterAfter = chaptersAfterRestore.some(c => c.id === newChapterId)
  ok('还原后最新章已回退（被 V1 覆盖）', !hasNewChapterAfter)

  // 6. 验证预备份写入失败时的失败保护：不能覆盖原数据
  // 模拟写入损坏：向 ops 注入故障使得 putStrict / payload 损坏
  const originalPutStrict = ops.putStrict
  let simulateFail = true
  ops.putStrict = async (store: string, val: unknown) => {
    if (simulateFail && store === 'backupPayloads') {
      throw new Error('SIMULATED_DISK_FULL: ENOSPC')
    }
    if (originalPutStrict) return originalPutStrict(store, val)
    return ops.put(store, val)
  }

  // 记录此时的目标章节内容
  const chaptersBeforeFailedRestore = await db.getAllChapters()
  let restoreFailedAsExpected = false
  try {
    await db.restoreBackup(snap1.id)
  } catch (e) {
    restoreFailedAsExpected = true
    ok('预备份写入失败时抛出错误阻止还原', (e as Error).message.includes('SIMULATED_DISK_FULL') || (e as Error).message.includes('预备份'))
  }
  ok('预备份失败时 restoreBackup 抛出异常', restoreFailedAsExpected)

  // 恢复 ops.putStrict
  simulateFail = false
  ops.putStrict = originalPutStrict

  // 验证目标项目数据未受任何破坏
  const chaptersAfterFailedRestore = await db.getAllChapters()
  ok('预备份失败后，目标项目章节数完全未受损', chaptersAfterFailedRestore.length === chaptersBeforeFailedRestore.length)

  // 7. 验证 D3：还原后项目修改时间保持真实历史快照时间（语义明确）
  const histBundle = (await db.getBackupPayload(snap1.id))!
  const docs = new Map<string, KbDoc>(), bodies = new Map<string, string>()
  let failBody = false
  let mutateDuringRestore = false
  setKbBackend({
    list: async projectId => [...docs.values()].filter(d => d.projectId === projectId),
    put: async doc => { docs.set(doc.id, doc) }, del: async id => { docs.delete(id) },
    getBody: async id => bodies.get(id) ?? '', putBody: async (id, text) => {
      if (failBody && text === '第二篇正文') throw new Error('模拟写入失败')
      if (mutateDuringRestore && text === '新资料正文') { const old = [...docs.values()][0]; if (old) bodies.set(old.id, '并发编辑的资料') }
      bodies.set(id, text)
    },
    delBody: async id => { bodies.delete(id) }, clearProject: async () => { throw new Error('不应先清空') },
  })
  await importDoc({ projectId: pid, title: '旧资料', text: '必须保留的资料', sourceType: 'paste', enabled: true })
  const incoming = { ...histBundle, knowledgeBase: [{ title: '新资料', text: '新资料正文', sourceType: 'paste' as const, chars: 5, importedAt: 1, enabled: true }] }
  const kbRestore = await db.restoreBundleToProject(pid, incoming)
  const safety = await db.getBackupPayload(kbRestore.preBackupId!)
  ok('覆盖前备份可回读完整旧参考资料', safety?.knowledgeBase?.[0]?.text === '必须保留的资料')
  ok('参考资料覆盖成功且报告成功', kbRestore.knowledgeBase?.ok === true && (await listDocs(pid))[0]?.title === '新资料')
  const damaged = { ...incoming, knowledgeBase: [{ ...incoming.knowledgeBase[0], text: '' }] }
  const partial = await db.restoreBundleToProject(pid, damaged)
  const retained = (await listDocs(pid))[0]
  ok('空资料恢复明确报告部分失败', partial.knowledgeBase?.ok === false)
  ok('无效资料不能清空原有资料', retained?.title === '新资料' && await getDocText(retained.id) === '新资料正文')
  let staleRejected = false
  try { await restoreDocsFromBundle(pid, incoming.knowledgeBase, safety?.knowledgeBase) } catch { staleRejected = true }
  ok('安全备份后的资料变化阻止覆盖', staleRejected && await getDocText(retained.id) === '新资料正文')
  failBody = true
  const failing = { ...incoming, knowledgeBase: [incoming.knowledgeBase[0], { ...incoming.knowledgeBase[0], title: '第二篇', text: '第二篇正文' }] }
  const failedWrite = await db.restoreBundleToProject(pid, failing)
  const afterFailure = await listDocs(pid)
  ok('中途写入失败时报告部分失败', failedWrite.knowledgeBase?.ok === false)
  ok('中途写入失败保留旧资料且撤除新片段', afterFailure.length === 1 && afterFailure[0].id === retained.id && await getDocText(retained.id) === '新资料正文')
  failBody = false
  mutateDuringRestore = true
  const raced = await db.restoreBundleToProject(pid, incoming)
  const afterRace = await listDocs(pid)
  ok('恢复期间参考资料变化时拒绝替换', raced.knowledgeBase?.ok === false && afterRace.length === 1 && await getDocText(afterRace[0].id) === '并发编辑的资料')
  mutateDuringRestore = false
  setKbBackend(null)
  let missingTargetRejected = false
  try { await db.restoreBundleToProject('missing-target', histBundle) } catch { missingTargetRejected = true }
  ok('目标不存在时拒绝跳过预备份', missingTargetRejected)
  const originalGet = ops.get
  ops.get = async (store, id) => {
    if (store === 'projects' && id === pid) throw new Error('模拟项目读取失败')
    return originalGet(store, id)
  }
  let readFailedRejected = false
  try { await db.restoreBundleToProject(pid, histBundle) } catch { readFailedRejected = true }
  ops.get = originalGet
  ok('目标项目读取失败时拒绝恢复', readFailedRejected)
  const expectedHistoricalUpdatedAt = histBundle.project.updatedAt || 1234567890
  histBundle.project.updatedAt = expectedHistoricalUpdatedAt

  await db.restoreBundleToProject(pid, histBundle, { skipPreBackup: true })
  const restoredProj = await db.getProject(pid)
  ok('还原后 updatedAt 保持历史包中的真实时间，不虚假更新为当前时间', restoredProj?.updatedAt === expectedHistoricalUpdatedAt)

  // 8. 验证知识库还原异常透明报告
  const mockKbBundle = {
    ...histBundle,
    knowledgeBase: [{ id: 'doc-1', title: '设定资料', content: '测试内容' }] as any,
  }
  const kbOutcomeGood = await db.restoreBundleToProject(pid, mockKbBundle, { skipPreBackup: true })
  ok('知识库尝试还原时报告 attempted=true 并准确捕获状态/错误', kbOutcomeGood.knowledgeBase?.attempted === true && (kbOutcomeGood.knowledgeBase.ok === true || typeof kbOutcomeGood.knowledgeBase.error === 'string'))

  const noKbBundle = { ...histBundle, knowledgeBase: undefined }
  const kbOutcomeNoKb = await db.restoreBundleToProject(pid, noKbBundle, { skipPreBackup: true })
  ok('未携带知识库的包还原时 knowledgeBase 为 undefined', kbOutcomeNoKb.knowledgeBase === undefined)

  console.log(`\nbackupSafety: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

await run()
