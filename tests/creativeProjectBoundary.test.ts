// 3.2.2 · 创意写作跨项目守卫 · 单测
//
// 背景（用户 2026-10-23 反馈）：「我一个项目在创意写作，切换到另一个项目，创意写作也在进行」
// 核实结论：真 bug，且比反馈严重 —— 任务的**读与写全走 `db.*`（隐式取当前项目）**，
// 切项目后 A 的产出会带着 B 的 projectId 落库（新章 / 大纲 / 设定草稿 / 运行账本 / 改写候选）。
//
// 本测试钉的是**判定表**（`runBelongsTo`）——最容易写反、也最容易被后人"顺手简化"的那部分：
//   · 没在跑 ⇒ 永不打断；
//   · 同项目重开 ⇒ 不打断（App 允许：被中止的任务可「继续」）；
//   · 跑到别的项目 ⇒ 必须打断；
//   · 没有绑定项目（老状态）⇒ 保守不打断。
//
// ⚠️ 副作用部分（真的把 `running` 置 false、弹 notice、resolve 三个挂起弹窗）没有在这里起真任务验证 ——
//    `startCreativeRun` 需要模型端点。那部分靠代码审查 + `abortRunIfProjectChanged` 复用
//    `stopCreativeRun()`（后者已有既有测试覆盖）来保证；真机复现清单见
//    `docs/归档/3.2/3.2.2-创意写作跨项目修复-2026-10-23.md`。
import { runBelongsTo, abortRunIfProjectChanged } from '@/lib/creative/creativeSession'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

console.log('\n── ① 判定表 ──')
{
  // 没在跑：任何情况都不冲突
  ok('没在跑 + 无绑定 ⇒ 不冲突', runBelongsTo(null, false, 'pB') === true)
  ok('没在跑 + 有绑定 ⇒ 不冲突', runBelongsTo('pA', false, 'pB') === true)

  // 在跑：绑定项目决定
  ok('跑到 A、切到 A ⇒ 不冲突（同项目重开，任务可继续）', runBelongsTo('pA', true, 'pA') === true)
  ok('🔴 跑到 A、切到 B ⇒ 冲突（必须打断）', runBelongsTo('pA', true, 'pB') === false)
  ok('🔴 跑到 A、退出项目（空串）⇒ 冲突', runBelongsTo('pA', true, '') === false)

  // 老状态没有绑定：保守不打断（宁可少停一次，不误杀）
  ok('在跑但没有绑定项目 ⇒ 不冲突（保守）', runBelongsTo(null, true, 'pB') === true)
}

console.log('\n── ② 没有任务时调用：不该有副作用 ──')
{
  // 初始 snap.running 为 false（模块级默认值），此时调用应当直接返回 false
  const aborted = abortRunIfProjectChanged('some-other-project')
  ok('无任务时返回 false（没有可中止的东西）', aborted === false, String(aborted))
  // 幂等：连调两次也不该抛
  ok('连调两次不抛且仍返回 false', abortRunIfProjectChanged('') === false)
}

/**
 * ③ 切项目前的「未落盘想法」必须写回**原项目**（3.2.2 遗留修复 · 2026-10-23）
 *
 * 病灶：想法走 1 秒防抖落盘，而 `persistNow()` 原先无条件读全局「当前项目」。
 * 作者填完想法 1 秒内切项目 ⇒ 防抖在切换**之后**才触发 ⇒ 想法被写进新项目的键，
 * 原项目里反而没有（实机遗留第 2 条）。
 *
 * 这里用真（内存）存储走一遍：写想法 → **不等 1 秒**立刻切项目 → 等过防抖窗口 → 查两边的键。
 */
console.log('\n── ③ 切项目时未落盘的想法归属 ──')
{
  const db = await import('@/lib/db')
  const { hydrateCreativeSession, updateInputs } = await import('@/lib/creative/creativeSession')

  db.setCurrentProject('pA')
  await hydrateCreativeSession()          // 会话归属 = pA（面板挂载时就是这么做的）
  updateInputs({ seed: '一秒内切走也要保住的想法' })   // 排下 1 秒防抖

  // 立刻切项目（模拟 App：先判再切）
  const aborted = abortRunIfProjectChanged('pB')
  ok('③ 没在跑时仍返回 false（不误报"已中止任务"）', aborted === false, String(aborted))

  // 真的切过去
  db.setCurrentProject('pB')
  // 等过 1 秒防抖窗口：如果旧实现还留了定时器，这里就会把内容写进 pB
  await new Promise(r => setTimeout(r, 1300))

  type SessionRec = { inputs?: { seed?: string } } | null
  const aRec = await db.getMeta<SessionRec>('creativeSession:pA', null)
  const bRec = await db.getMeta<SessionRec>('creativeSession:pB', null)
  ok('🔴 ③ 想法写回了**原项目** pA', aRec?.inputs?.seed === '一秒内切走也要保住的想法',
    JSON.stringify(aRec?.inputs ?? null))
  ok('🔴 ③ 新项目 pB 里**没有**串味的会话', !bRec, JSON.stringify(bRec ?? null))

  // 收尾：回到干净状态，免得影响后续用例
  db.setCurrentProject('')
}

{
  const db = await import('@/lib/db')
  const { memoryOps } = await import('./mock-memory')
  const creative = await import('@/lib/creative/creativeSession')
  db.setCurrentProject('pLegacy')
  await db.setMeta('creativeSession:pLegacy', {
    resume: { from: 'draft', doneChapters: 2, totalChapters: 5, label: '已写 2/5 章' },
  })
  await creative.hydrateCreativeSession()
  const before = (await memoryOps.getAll('aiRuns')).length
  await creative.startCreativeRun()
  const after = (await memoryOps.getAll('aiRuns')).length
  ok('缺少可校验产物的旧断点不启动新任务', before === after)
  await creative.flushPersist('pLegacy')
  const saved = await db.getMeta<{ resume?: unknown } | null>('creativeSession:pLegacy', null)
  ok('旧断点保留供用户核对', !!saved?.resume)
  creative.clearCreativeSession()
  await creative.flushPersist('pLegacy')
  const cleared = await db.getMeta<{ resume?: unknown } | null>('creativeSession:pLegacy', null)
  ok('清空记录后不再保留旧断点', !cleared?.resume)
  db.setCurrentProject('')
}

// 加载通过后正文仍可能被作者修改；开始续跑时必须重新核验。
{
  const db = await import('@/lib/db')
  const { memoryOps } = await import('./mock-memory')
  const creative = await import('@/lib/creative/creativeSession')
  const { textFingerprint } = await import('@/lib/tasks/unitLedger')
  db.setCurrentProject('pResumeEdit')
  const chapter = { id: 'resume-edit-ch', projectId: 'pResumeEdit', title: '章', content: '原文', summary: '', wordCount: 2, createdAt: 1, updatedAt: 1, tags: [], status: 'draft', order: 1 }
  await db.saveChapter(chapter as never)
  await db.setMeta('creativeSession:pResumeEdit', {
    resume: { from: 'draft', doneChapters: 1, totalChapters: 10, label: '已写 1/10 章', evidence: [{ id: chapter.id, title: '章', no: 1, fingerprint: textFingerprint('原文') }] },
  })
  await creative.hydrateCreativeSession()
  creative.updateInputs({ chapters: 9 })
  const beforeMismatch = (await memoryOps.getAll('aiRuns')).length
  await creative.startCreativeRun()
  ok('修改总章数时拒绝静默从头开始', (await memoryOps.getAll('aiRuns')).length === beforeMismatch)
  creative.updateInputs({ chapters: 10 })
  const { invalidateStorageContext } = await import('@/lib/storage/contextEpoch')
  const originalGetAll = memoryOps.getAll
  memoryOps.getAll = async <T>(store: string): Promise<T[]> => {
    const rows = await originalGetAll<T>(store)
    if (store === 'chapters') invalidateStorageContext()
    return rows
  }
  try {
    await creative.startCreativeRun()
    ok('核验期间切换存储空间不启动任务', (await originalGetAll('aiRuns')).length === beforeMismatch)
  } finally { memoryOps.getAll = originalGetAll }
  await db.saveChapter({ ...chapter, content: '修改后' } as never)
  const before = (await memoryOps.getAll('aiRuns')).length
  await creative.startCreativeRun()
  ok('加载后正文修改，续跑前拒绝启动任务', (await memoryOps.getAll('aiRuns')).length === before)
  creative.clearCreativeSession()
  await creative.flushPersist('pResumeEdit')
  db.setCurrentProject('')
}

// A 的读取晚于 B 返回，不能将 A 的会话写到 B。
{
  const db = await import('@/lib/db')
  const { memoryOps } = await import('./mock-memory')
  const creative = await import('@/lib/creative/creativeSession')
  await db.setMeta('creativeSession:pRaceA', { inputs: { seed: 'A 原始想法' } })
  await db.setMeta('creativeSession:pRaceB', { inputs: { seed: 'B 原始想法' } })
  const originalGet = memoryOps.get
  let release!: () => void
  let started!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { started = resolve })
  memoryOps.get = async <T>(store: string, key: string): Promise<T | undefined> => {
    if (store === 'meta' && key === 'creativeSession:pRaceA') { started(); await pending }
    return originalGet<T>(store, key)
  }
  try {
    db.setCurrentProject('pRaceA')
    const a = creative.hydrateCreativeSession()
    await reading
    const before = (await memoryOps.getAll('aiRuns')).length
    const oldRun = creative.startCreativeRun()
    db.setCurrentProject('pRaceB')
    await creative.hydrateCreativeSession()
    creative.updateInputs({ seed: 'B 新想法' })
    release()
    await a; await oldRun
    ok('旧作品的启动请求不会跑到新作品', (await memoryOps.getAll('aiRuns')).length === before)
    await creative.flushPersist('pRaceB')
    const b = await db.getMeta<{ inputs?: { seed?: string } }>('creativeSession:pRaceB', {})
    ok('A 会话迟到不会覆盖 B 的会话和新输入', b.inputs?.seed === 'B 新想法')
  } finally { memoryOps.get = originalGet; release(); db.setCurrentProject('') }
}

// 读取失败不能把默认空会话写回原记录，且不能启动任务。
{
  const db = await import('@/lib/db')
  const { memoryOps, __failReads } = await import('./mock-memory')
  const creative = await import('@/lib/creative/creativeSession')
  db.setCurrentProject('pReadFailure')
  await db.setMeta('creativeSession:pReadFailure', { inputs: { seed: '必须保留的旧想法' } })
  __failReads((store, key) => store === 'meta' && key === 'creativeSession:pReadFailure')
  try {
    await creative.hydrateCreativeSession()
    creative.updateInputs({ seed: '读取失败时的新输入' })
    const before = (await memoryOps.getAll('aiRuns')).length
    await creative.startCreativeRun()
    ok('会话读取失败不启动任务', (await memoryOps.getAll('aiRuns')).length === before)
    ok('会话读取失败不允许将空会话写回', !(await creative.flushPersist('pReadFailure')))
  } finally { __failReads(null) }
  const original = await db.getMeta<{ inputs?: { seed?: string } }>('creativeSession:pReadFailure', {})
  ok('读取失败后原始记录保留', original.inputs?.seed === '必须保留的旧想法')
  await creative.hydrateCreativeSession()
  db.setCurrentProject('')
}

// 并发启动与正在进行的同项目加载必须等待同一结果。
{
  const db = await import('@/lib/db')
  const { memoryOps } = await import('./mock-memory')
  const creative = await import('@/lib/creative/creativeSession')
  db.setCurrentProject('pPendingLoad')
  await db.setMeta('creativeSession:pPendingLoad', { resume: { from: 'draft', doneChapters: 1, totalChapters: 10, label: '旧断点' } })
  const originalGet = memoryOps.get
  let release!: () => void
  let started!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { started = resolve })
  memoryOps.get = async <T>(store: string, key: string): Promise<T | undefined> => {
    if (store === 'meta' && key === 'creativeSession:pPendingLoad') { started(); await pending }
    return originalGet<T>(store, key)
  }
  try {
    const hydrate = creative.hydrateCreativeSession()
    await reading
    let finished = false
    const run = creative.startCreativeRun().then(() => { finished = true })
    await Promise.resolve(); await Promise.resolve()
    ok('会话仍在读取时启动操作会等待', !finished)
    release()
    await hydrate; await run
    ok('读取完成后旧断点仍不会启动任务', finished && (await memoryOps.getAll('aiRuns')).length === 0)
  } finally { memoryOps.get = originalGet; release(); db.setCurrentProject('') }
}

{
  const db = await import('@/lib/db')
  const creative = await import('@/lib/creative/creativeSession')
  db.setCurrentProject('pStructurePick')
  await db.setMeta('creativeSession:pStructurePick', { inputs: { seed: '原有想法' } })
  await creative.hydrateCreativeSession()
  creative.updateInputs({ structureId: 'structure-choice' })
  await creative.saveInputsQuiet()
  const saved = await db.getMeta<{ inputs?: { seed?: string; structureId?: string } }>('creativeSession:pStructurePick', {})
  ok('结构模板选择保留原有想法并落盘', saved.inputs?.seed === '原有想法' && saved.inputs?.structureId === 'structure-choice')
  const fs = await import('node:fs')
  const panel = fs.readFileSync('src/components/outline/StructurePacePanel.tsx', 'utf8')
  const pick = /const pickTemplate = async[\s\S]*?\n  \}/.exec(panel)?.[0] ?? ''
  ok('结构模板先等待读入再修改并检查作品归属', pick.indexOf('await hydrateCreativeSession()') < pick.indexOf('updateInputs(') && pick.includes('getProjectContextEpoch'))
  db.setCurrentProject('')
}

// 同一个作品 id 在另一个存储空间里也必须重新读取，旧输入不能写入新空间。
{
  const db = await import('@/lib/db')
  const { invalidateStorageContext } = await import('@/lib/storage/contextEpoch')
  const creative = await import('@/lib/creative/creativeSession')
  db.setCurrentProject('pSameId')
  await db.setMeta('creativeSession:pSameId', { inputs: { seed: '旧空间' } })
  await creative.hydrateCreativeSession()
  invalidateStorageContext()
  await db.setMeta('creativeSession:pSameId', { inputs: { seed: '新空间' } })
  creative.updateInputs({ seed: '旧会话迟到的输入' })
  ok('换存储后旧会话不能写盘', !(await creative.flushPersist('pSameId')))
  let saved = await db.getMeta<{ inputs?: { seed?: string } }>('creativeSession:pSameId', {})
  ok('换存储后新空间原记录保留', saved.inputs?.seed === '新空间')
  await creative.hydrateCreativeSession()
  creative.updateInputs({ seed: '新空间的新输入' })
  await creative.flushPersist('pSameId')
  saved = await db.getMeta<{ inputs?: { seed?: string } }>('creativeSession:pSameId', {})
  ok('重新读取后可以正常编辑新空间', saved.inputs?.seed === '新空间的新输入')
  db.setCurrentProject('')
}

{
  const db = await import('@/lib/db')
  const creative = await import('@/lib/creative/creativeSession')
  db.setCurrentProject('pFlushOld')
  await db.setMeta('creativeSession:pFlushOld', { inputs: { seed: '旧作品' } })
  await db.setMeta('creativeSession:pFlushNew', { inputs: { seed: '新作品' } })
  await creative.hydrateCreativeSession()
  db.setCurrentProject('pFlushNew')
  ok('切作品后未重读时默认保存被拒绝', !(await creative.flushPersist()))
  ok('指定新作品也不能保存旧作品会话', !(await creative.flushPersist('pFlushNew')))
  const saved = await db.getMeta<{ inputs?: { seed?: string } }>('creativeSession:pFlushNew', {})
  ok('默认保存不会把旧作品写入新作品', saved.inputs?.seed === '新作品')
  db.setCurrentProject('')
}

/**
 * ④ 源码闸：中止路径上的两件"必须做否则会反噬"的事
 *
 * 这两条**没法用行为测**（要走 `startCreativeRun`，需要模型端点），但它们一旦被后人删掉，
 * 症状都是**静默的数据事故**，所以逐条钉住：
 *   · 取消 set() 排下的落盘 —— 否则 1 秒后全局 pid 已换成新项目，
 *     那个定时器会把"清空后的会话"写进新项目，等于用空壳覆盖 B 自己的会话；
 *   · 清 `SESSION_BLANK` —— 否则切到 B 的当下会显示 A 的「已中止 · 继续写作」（实机遗留第 1 条）。
 */
console.log('\n── ④ 源码闸：中止路径的两个关键动作 ──')
{
  const fs = await import('node:fs')
  const src = fs.readFileSync('src/lib/creative/creativeSession.ts', 'utf8')
  const body = /export function abortRunIfProjectChanged[\s\S]*?\n\}/.exec(src)?.[0] ?? ''

  ok('④ 能找到 abortRunIfProjectChanged', body.length > 100, String(body.length))
  ok('🔴 ④ 切项目前先把未落盘草稿写回**所属项目**（显式 pid）',
    /flushPersist\(owner\)/.test(body))
  ok('④ 归属取 runProjectId 或 hydratedFor（不是全局当前项目）',
    /const owner = runProjectId \?\? hydratedFor/.test(body))
  ok('🔴 ④ 中止后取消排队的落盘（否则 1 秒后写进新项目）',
    /cancelScheduledPersist\(\)/.test(body))
  ok('🔴 ④ 中止后清 SESSION_BLANK（B 面板不再显示 A 的残留）',
    /\.\.\.SESSION_BLANK/.test(body))
  ok('④ 落盘函数支持指定项目（persistNow 接受 pid）',
    /async function persistNow\(pid\?: string\)/.test(src)
    && /const target = pid \?\? db\.getCurrentProjectId\(\)/.test(src))
  ok('④ flushPersist 同口径支持 pid', /export async function flushPersist\(pid\?: string\)/.test(src))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} creativeProjectBoundary: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
