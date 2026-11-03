// ============ 3.3.5 · A1/A2/A3 连写恢复三态判定与极端异常保护 ============
import {
  classifyResumeState,
  describeResumeEvidence,
  verifyResumeEvidence,
  type CreatedChapterEvidence,
} from '../src/lib/creative/resumeEvidence'
import { validateResumeForStart } from '../src/lib/creative/resumeValidation'
import { textFingerprint } from '../src/lib/tasks/unitLedger'
import type { CreativeResume } from '../src/lib/ai/aiWorkflow'
import { captureOwnedOperation } from '../src/lib/storage/ownedOperation'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const ch = (id: string, content: string) => ({ id, content })
const ev = (id: string, content: string, no = 1): CreatedChapterEvidence => ({
  id, title: `第${no}章`, no, fingerprint: textFingerprint(content),
})

async function run() {
  console.log('--- 1. 三态判定 (A1: resumable / review-needed / blocked) ---')

  // 1.1 健康可直接续跑 (resumable)
  const resumeOk: CreativeResume = {
    bag: {}, from: 'draft', doneChapters: 2, totalChapters: 10, label: '已写 2/10 章',
    evidence: [ev('c1', '第一章正文', 1), ev('c2', '第二章正文', 2)],
  }
  const chaptersOk = [ch('c1', '第一章正文'), ch('c2', '第二章正文')]
  const verdictOk = verifyResumeEvidence(resumeOk.evidence, chaptersOk, 2)
  const classOk = classifyResumeState(verdictOk, resumeOk, 10)

  ok('完整匹配判定为 resumable', classOk.state === 'resumable')
  ok('resumable 允许直接续跑', classOk.canResumeDirectly === true)
  ok('resumable 无阻断原因', verdictOk.ok === true && verdictOk.reason === '')

  // 1.2 正文被改动 (blocked: 坚决拒绝)
  const chaptersTampered = [ch('c1', '第一章被作者修改了'), ch('c2', '第二章正文')]
  const verdictTampered = verifyResumeEvidence(resumeOk.evidence, chaptersTampered, 2)
  const classTampered = classifyResumeState(verdictTampered, resumeOk, 10)

  ok('正文被改动判定为 blocked', classTampered.state === 'blocked')
  ok('正文被改动禁止直接续跑', classTampered.canResumeDirectly === false)
  ok('正文被改动禁止跳过恢复', classTampered.canResumeFromSafeCheckpoint === false)
  ok('正文被改动记录 changed 章节', verdictTampered.changed.includes('c1'))
  ok('正文被改动提示明确剧情冲突风险', classTampered.detail.includes('剧情冲突'))

  // 1.3 章节被删除 (blocked: 坚决拒绝)
  const chaptersMissing = [ch('c1', '第一章正文')] // c2 被删
  const verdictMissing = verifyResumeEvidence(resumeOk.evidence, chaptersMissing, 2)
  const classMissing = classifyResumeState(verdictMissing, resumeOk, 10)

  ok('章节被删除判定为 blocked', classMissing.state === 'blocked')
  ok('章节被删除禁止直接续跑', classMissing.canResumeDirectly === false)
  ok('章节被删除禁止安全检查点跳过', classMissing.canResumeFromSafeCheckpoint === false)
  ok('记录 missing 章节', verdictMissing.missing.includes('c2'))

  // 1.4 元数据条数损坏 (blocked: count mismatch)
  const verdictCountBroken = verifyResumeEvidence(resumeOk.evidence, chaptersOk, 5) // doneChapters=5 != evidence.length 2
  const classCountBroken = classifyResumeState(verdictCountBroken, resumeOk, 10)

  ok('章数与证据不符判定为 blocked', classCountBroken.state === 'blocked')
  ok('章数不符原因文案准确', describeResumeEvidence(verdictCountBroken).includes('已损坏'))

  // 1.5 证据数据格式非法/包含重复章 ID (blocked: invalid)
  const verdictDuplicate = verifyResumeEvidence([ev('dup', '正文'), ev('dup', '正文')], [ch('dup', '正文')], 2)
  const classDuplicate = classifyResumeState(verdictDuplicate, resumeOk, 10)
  ok('重复章 ID 判定为 blocked', classDuplicate.state === 'blocked')

  // 1.6 旧版无证据记录 (review-needed: 允许用户显式决定)
  const legacyResume: CreativeResume = {
    bag: {}, from: 'draft', doneChapters: 3, totalChapters: 10, label: '已写 3/10 章',
    evidence: undefined,
  }
  const verdictLegacy = verifyResumeEvidence(legacyResume.evidence, chaptersOk, 3)
  const classLegacy = classifyResumeState(verdictLegacy, legacyResume, 10)

  ok('旧版无证据判定为 review-needed', classLegacy.state === 'review-needed')
  ok('旧版无证据禁止静默直接续跑', classLegacy.canResumeDirectly === false)
  ok('旧版无证据允许显式从最近记录点恢复', classLegacy.canResumeFromSafeCheckpoint === true)
  ok('旧版无证据允许从头重写', classLegacy.canRestartFromScratch === true)

  // 1.7 断点后存在新章节 (review-needed: 尾部非致命差异)
  const chaptersWithTrailing = [ch('c1', '第一章正文'), ch('c2', '第二章正文'), ch('c3_manual', '作者手动写的新章')]
  const verdictTrailing = verifyResumeEvidence(resumeOk.evidence, chaptersWithTrailing, 2)
  const classTrailing = classifyResumeState(verdictTrailing, resumeOk, 10)

  ok('断点后有新章判定为 review-needed', classTrailing.state === 'review-needed')
  ok('尾部新章禁止静默直接续跑（防止章节顺序错乱）', classTrailing.canResumeDirectly === false)
  ok('尾部新章允许显式确认从安全断点恢复', classTrailing.canResumeFromSafeCheckpoint === true)
  ok('记录 trailing 章节 id', verdictTrailing.trailing.includes('c3_manual'))

  // 1.8 目标章数变更 (review-needed: 参数差异)
  const classParamMismatch = classifyResumeState(verdictOk, resumeOk, 20) // 当前目标从 10 改为 20
  ok('连写目标改动判定为 review-needed', classParamMismatch.state === 'review-needed')
  ok('目标改动禁止直接续跑', classParamMismatch.canResumeDirectly === false)
  ok('提示需恢复原章数或从头重写', classParamMismatch.detail.includes('恢复原章数'))

  console.log('--- 2. validateResumeForStart 覆盖与越权防御 ---')

  const { ops } = await import('../src/lib/db/core')
  const { __resetMockStores } = await import('./mock-memory')
  const db = await import('../src/lib/db')
  __resetMockStores()
  db.setCurrentProject('test-p1')
  const mockOwner = captureOwnedOperation('test-p1')

  const putCh = async (id: string, content: string, order = 1, pid?: string) => {
    const targetPid = pid ?? db.getCurrentProjectId()
    await ops.put('chapters', {
      id, projectId: targetPid, volumeId: 'v1', order, title: '章', content, summary: '', status: '草稿',
    })
  }

  // 2.1 针对 blocked 状态，即使传入 allowReviewOverride 依然坚决阻止
  __resetMockStores()
  await putCh('c1', '第一章被作者修改了', 1)
  await putCh('c2', '第二章正文', 2)

  const blockedValidation = await validateResumeForStart(
    resumeOk, 10, mockOwner, 'draft', { allowReviewOverride: true }
  )
  ok('正文篡改即使请求 allowReviewOverride 依然被拒绝', !!blockedValidation.reason && blockedValidation.classification.state === 'blocked')

  // 2.2 针对 review-needed 状态（尾部新章），传入 allowReviewOverride 允许放行
  __resetMockStores()
  await putCh('c1', '第一章正文', 1)
  await putCh('c2', '第二章正文', 2)
  await putCh('c3_manual', '作者手动写的新章', 3)

  const trailingNormalValidation = await validateResumeForStart(
    resumeOk, 10, mockOwner, 'draft', { allowReviewOverride: false }
  )
  ok('尾部新章默认需要确认 (reason 非空)', !!trailingNormalValidation.reason && trailingNormalValidation.classification.state === 'review-needed')

  const trailingOverrideValidation = await validateResumeForStart(
    resumeOk, 10, mockOwner, 'draft', { allowReviewOverride: true }
  )
  ok('用户显式确认后放行 (reason 为空)', trailingOverrideValidation.reason === '' && trailingOverrideValidation.classification.state === 'review-needed')

  // 2.3 正文断点尝试用于大纲规划：一律阻止
  const outlineValidation = await validateResumeForStart(
    resumeOk, 10, mockOwner, 'outline'
  )
  ok('正文断点用于仅大纲被阻止', outlineValidation.classification.state === 'blocked' && outlineValidation.parameters === true)

  console.log('--- 3. CreativeSession 会话级状态联动与保护 ---')
  const creative = await import('../src/lib/creative/creativeSession')

  // 3.1 带有被篡改章节的会话加载：被判定为 blocked
  __resetMockStores()
  db.setCurrentProject('pSessionTampered')
  await putCh('c1', '被改写后的正文', 1)
  await putCh('c2', '第二章正文', 2)
  await db.setMeta('creativeSession:pSessionTampered', {
    resume: resumeOk,
  })

  await creative.hydrateCreativeSession()
  const snapTampered = creative.getCreativeSnapshot()
  ok('会话加载时检测到篡改标记 resumeNeedsReview=true', snapTampered.resumeNeedsReview === true)
  ok('会话状态被归类为 blocked', snapTampered.resumeState === 'blocked')
  ok('阻断文案提示明确', snapTampered.resumeBlockedReason.includes('正文被修改') || snapTampered.resumeBlockedReason.includes('正文已被改动') || snapTampered.resumeBlockedReason.includes('剧情冲突'))

  // 尝试强制启动 blocked 会话：被坚决拦截
  await creative.startCreativeRun({ forceCheckpoint: true })
  ok('blocked 状态下即使传入 forceCheckpoint 依然被拦截（running=false）', creative.getCreativeSnapshot().running === false)

  // 3.2 带有尾部新章节的会话加载：被判定为 review-needed
  __resetMockStores()
  db.setCurrentProject('pSessionTrailing')
  await putCh('c1', '第一章正文', 1)
  await putCh('c2', '第二章正文', 2)
  await putCh('c3_new', '第三章新手写内容', 3)
  await db.setMeta('creativeSession:pSessionTrailing', {
    resume: resumeOk,
  })

  await creative.hydrateCreativeSession()
  const snapTrailing = creative.getCreativeSnapshot()
  ok('尾部新章会话标记 resumeNeedsReview=true', snapTrailing.resumeNeedsReview === true)
  ok('会话状态归类为 review-needed', snapTrailing.resumeState === 'review-needed')
  ok('提示需确认续跑点', snapTrailing.resumeBlockedReason.includes('后续章节') || snapTrailing.resumeBlockedReason.includes('安全断点'))

  creative.clearCreativeSession()
  db.setCurrentProject('')

  console.log(`\ncreativeRecoveryFailures: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

await run()
