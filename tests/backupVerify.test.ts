// ============ 备份载荷结构校验 · 单测（3.6.2 · W3）============
//
// 这条闸守的是**恢复动作本身**：
//   结构不完整的备份若被放行，`applyBundleToProject` 会先写新、再删旧，
//   半路在 `bundle.volumes.length` 上炸掉 —— 那时原数据已被大量新记录覆盖。
//   所以要么在**任何写入之前**拒绝，要么就让用户面对"恢复失败且书也乱了"。
//
// 除了纯函数断言，这里还有两条端到端断言：
//   · 结构坏 → `restoreBackup` 抛错且**一个字节都没写**（store.put 调用次数为 0）；
//   · 结构好 → 照常恢复（证明校验没有误伤正常路径）。
import * as db from '../src/lib/db'
import { verifyBackupPayload } from '../src/lib/db/backups'
import { __resetMockStores, memoryOps } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const goodBundle = () => ({
  app: 'youth-fantasy-engine',
  version: 2,
  exportedAt: Date.now(),
  project: { id: 'p1', name: '测试作品', updatedAt: Date.now() },
  volumes: [],
  chapters: [],
  tableRows: [],
  cardRecords: [],
  formData: [],
})

// ---------- 1. 合法载荷 ----------
{
  ok('1a 合法文字片 → ok',
    verifyBackupPayload({ id: 'b1', projectId: 'p1', kind: 'text', bundle: goodBundle() }).ok === true)
  ok('1b 旧整包（无 kind）也算合法',
    verifyBackupPayload({ id: 'b1', projectId: 'p1', bundle: goodBundle() }).ok === true)
  ok('1c 媒体片合法（有 blobs 数组）',
    verifyBackupPayload({ id: 'm1', projectId: 'p1', kind: 'media', media: { blobs: [], links: [] } }).ok === true)
}

// ---------- 2. 结构不符 → 拒绝且给可读原因 ----------
{
  const cases: Array<[string, unknown, RegExp]> = [
    ['null', null, /不是对象/],
    ['字符串', '{"id":"x"}', /不是对象/],
    ['数组', [], /不是对象/],
    ['空对象', {}, /缺少 id/],
    ['缺 id', { projectId: 'p1', bundle: goodBundle() }, /缺少 id/],
    ['缺 projectId', { id: 'b1', bundle: goodBundle() }, /所属项目/],
    ['缺 bundle', { id: 'b1', projectId: 'p1' }, /缺少数据包/],
    ['bundle 是字符串（JSON 截断的典型形态）', { id: 'b1', projectId: 'p1', bundle: '{"volumes":' }, /缺少数据包/],
    ['bundle 缺 project', { id: 'b1', projectId: 'p1', bundle: { volumes: [] } }, /缺少项目信息/],
    ['bundle 缺 volumes', { id: 'b1', projectId: 'p1', bundle: { ...goodBundle(), volumes: undefined } }, /volumes/],
    ['bundle 缺 chapters', { id: 'b1', projectId: 'p1', bundle: { ...goodBundle(), chapters: undefined } }, /chapters/],
    ['bundle 缺 tableRows', { id: 'b1', projectId: 'p1', bundle: { ...goodBundle(), tableRows: undefined } }, /tableRows/],
    ['bundle 缺 cardRecords', { id: 'b1', projectId: 'p1', bundle: { ...goodBundle(), cardRecords: undefined } }, /cardRecords/],
    ['media 片缺内容', { id: 'm1', projectId: 'p1', kind: 'media' }, /媒体片缺少内容/],
    ['media 片缺 blobs', { id: 'm1', projectId: 'p1', kind: 'media', media: { links: [] } }, /图片列表/],
  ]
  for (const [label, input, re] of cases) {
    let threw = false
    let verdict: ReturnType<typeof verifyBackupPayload> | null = null
    try { verdict = verifyBackupPayload(input) } catch { threw = true }
    const rejected = verdict !== null && verdict.ok === false && re.test(verdict.reason)
    ok(`2·${label} → 拒绝且原因可读`, !threw && rejected,
      threw ? '抛错了' : (verdict && !verdict.ok ? verdict.reason : '被放行了'))
  }
}

// ---------- 3. 端到端：结构坏 → 恢复被拒且零写入 ----------
async function endToEnd() {
  __resetMockStores()
  const p = await db.createProject('结构校验用书', '东方修真', '', '', 'full')
  db.setCurrentProject(p.id)
  // 造一份真实备份（这里会经过 createAutoBackup 的正常路径）
  const meta = await db.createAutoBackup(p.id, 'manual', '正常备份')
  ok('3a 正常备份已创建', !!meta)

  // 把载荷弄坏：删掉 chapters 数组（模拟截断/迁移中断）
  const raw = await memoryOps.get<Record<string, unknown>>('backupPayloads', meta!.id)
  const broken = JSON.parse(JSON.stringify(raw)) as { bundle: Record<string, unknown> }
  delete broken.bundle.chapters
  await memoryOps.put('backupPayloads', broken)

  // 记录写入次数：结构校验必须在**任何写入之前**拦住
  let writes = 0
  const countingStore = {
    ...memoryOps,
    put: async (store: string, value: unknown) => { writes++; return memoryOps.put(store, value) },
    putStrict: async (store: string, value: unknown) => { writes++; return memoryOps.put(store, value) },
    bulkDel: async (store: string, keys: string[]) => {
      for (const k of keys) { writes++; await memoryOps.del(store, k) }
    },
  }

  let err: unknown = null
  try {
    await db.restoreBackup(meta!.id, { skipPreBackup: true }, countingStore as never)
  } catch (e) { err = e }

  ok('🔴 3b 结构坏的备份 → restoreBackup 明确拒绝',
    err instanceof Error && /结构不完整/.test(err.message), err instanceof Error ? err.message : String(err))
  ok('🔴 3c 拒绝发生在**任何写入之前**（put / bulkDel 调用 0 次）', writes === 0, String(writes))
  ok('3d 拒绝原因里说明了缺什么', err instanceof Error && /chapters/.test(err.message),
    err instanceof Error ? err.message : '')

  // 修好结构 → 应当能恢复（证明校验没误伤正常路径）
  const fixed = JSON.parse(JSON.stringify(raw)) as { bundle: Record<string, unknown> }
  fixed.bundle.chapters = []
  await memoryOps.put('backupPayloads', fixed)
  let okRestore = false
  try {
    const out = await db.restoreBackup(meta!.id, { skipPreBackup: true })
    okRestore = out.ok === true
  } catch { /* 下面统一断言 */ }
  ok('3e 结构修好后照常恢复（校验不误伤正常路径）', okRestore)
}

await endToEnd()

console.log(`\nbackupVerify: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
