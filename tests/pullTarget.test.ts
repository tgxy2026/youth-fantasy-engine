// ============ 3.3.3 · B1「用云端新版更新本机」的判定与操作记录 ============
//
// 钉住：
//   ① 版本钉住：云端在确认后推进 ⇒ 中止，不悄悄换目标（A-06/B-01 的判据之一）；
//   ② 写前复检：本机更新时间 / 项目 / 绑定任一变化 ⇒ 中止；
//   ③ 操作记录：备份完成与首次写入之间落盘；未完成时**挡住该项目的自动推送**；
//   ④ 记录是本机专属：不进云同步 / 数据文件导出。
import { __resetMockStores, memoryOps } from './mock-memory'
import {
  checkLocalVersionUnchanged, checkPinnedRevision, checkSameBinding, checkSameProject,
  describePullPhase, verifyTargets,
} from '../src/lib/sync/pullTarget'
import {
  PULL_OP_KEY_PREFIX, beginPullOperation, clearPullOperation, finishPullOperation,
  isPullOperationPending, listPendingPullOperations, readPullOperation, updatePullOperation,
} from '../src/lib/sync/pullOperation'
import { isLocalOnlyMetaKey, isSensitiveMetaKey } from '../src/lib/storage/sensitiveMeta'
import { autoSyncTick, decideTick, nextTickDelay, tickMessage } from '../src/lib/app/syncAuto'
import type { SyncBinding } from '../src/lib/sync/projectBinding'
import type { SyncController } from '../src/lib/sync/syncController'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-b1-pull'
const bindingOf = (over: Partial<SyncBinding> = {}): SyncBinding => ({
  cloudProjectId: 'cloud-1',
  baseRevision: 3,
  lastSyncedAt: 1000,
  enabled: true,
  accountId: 'acc-1',
  ...over,
})

async function main() {
  __resetMockStores()

  // ───────────────── ① 版本钉住 ─────────────────
  {
    ok('仍是确认的那一版 ⇒ 通过', checkPinnedRevision({ pinned: 7, fetched: 7 }).ok)
    const advanced = checkPinnedRevision({ pinned: 7, fetched: 9 })
    ok('云端推进 ⇒ 中止（CLOUD_ADVANCED）', !advanced.ok && advanced.code === 'CLOUD_ADVANCED')
    ok('原因里写清两边的版本号', advanced.reason.includes('9') && advanced.reason.includes('7'), advanced.reason)
    const unknown = checkPinnedRevision({ fetched: 9 })
    ok('没有钉住版本 ⇒ 拒绝（不按"最新"猜）', !unknown.ok && unknown.code === 'CLOUD_ADVANCED')
  }

  // ───────────────── ② 写前复检 ─────────────────
  {
    ok('本机没有新改动 ⇒ 通过', checkLocalVersionUnchanged({ expectedUpdatedAt: 100, currentUpdatedAt: 100 }).ok)
    const dirty = checkLocalVersionUnchanged({ expectedUpdatedAt: 100, currentUpdatedAt: 120 })
    ok('确认后又保存过 ⇒ 中止（STALE_TARGET）', !dirty.ok && dirty.code === 'STALE_TARGET')
    ok('原因说明"内容又变了"', dirty.reason.includes('又发生了变化'), dirty.reason)

    ok('还在同一本作品 ⇒ 通过', checkSameProject({ expectedId: 'p1', currentId: 'p1' }).ok)
    ok('切到另一本 ⇒ 中止', !checkSameProject({ expectedId: 'p1', currentId: 'p2' }).ok)
    ok('项目为空 ⇒ 中止', !checkSameProject({ expectedId: 'p1', currentId: '' }).ok)

    ok('绑定没变 ⇒ 通过', checkSameBinding({ expected: 'cloud-1|3|acc-1', current: 'cloud-1|3|acc-1' }).ok)
    ok('绑定变了 ⇒ 中止', !checkSameBinding({ expected: 'cloud-1|3|acc-1', current: 'cloud-1|4|acc-1' }).ok)

    const first = verifyTargets([
      { ok: true, code: 'OK', reason: '' },
      { ok: false, code: 'STALE_TARGET', reason: '第二个不通过' },
      { ok: false, code: 'CLOUD_ADVANCED', reason: '第三个不通过' },
    ])
    ok('verifyTargets 返回第一个不通过项', first.reason === '第二个不通过' && first.code === 'STALE_TARGET')
    ok('全通过时返回 OK', verifyTargets([{ ok: true, code: 'OK', reason: '' }]).ok)
  }

  // ───────────────── ③ 操作记录落盘与查询 ─────────────────
  {
    const op = await beginPullOperation({
      projectId: PID, cloudProjectId: 'cloud-1', confirmedRevision: 7, fromBaseRevision: 3, accountId: 'acc-1',
    }, memoryOps)
    ok('记录写到本机 meta（带固定前缀）', !!(await memoryOps.get<{ key: string }>('meta', `${PULL_OP_KEY_PREFIX}${PID}`)))
    ok('初始阶段是 prepared', op.phase === 'prepared' && op.confirmedRevision === 7 && op.fromBaseRevision === 3)

    ok('有记录 ⇒ 该项目自动推送被挡', await isPullOperationPending(PID, memoryOps))
    const read = await readPullOperation(PID, memoryOps)
    ok('读回内容一致', read?.id === op.id && read?.cloudProjectId === 'cloud-1')

    const backed = await updatePullOperation(op, { phase: 'backup-done', backupId: 'b-123' }, memoryOps)
    ok('备份成功后补上 backupId', backed.backupId === 'b-123' && backed.phase === 'backup-done')

    const all = await listPendingPullOperations(memoryOps)
    ok('列表只含未完成记录', all.length === 1 && all[0].projectId === PID)

    await finishPullOperation(op, memoryOps)
    ok('收尾后记录删除', !(await readPullOperation(PID, memoryOps)))
    ok('收尾后自动推送解除', !(await isPullOperationPending(PID, memoryOps)))

    // 不同项目互不干扰
    await beginPullOperation({ projectId: 'p-other', cloudProjectId: 'c2', confirmedRevision: 1, fromBaseRevision: 0 }, memoryOps)
    await clearPullOperation('p-other', memoryOps)
    ok('clearPullOperation 只清指定项目', !(await isPullOperationPending('p-other', memoryOps)))

    // 本机专属：不进云同步 / 数据文件导出
    ok('记录键被登记为本机专属 meta 前缀', isLocalOnlyMetaKey(`${PULL_OP_KEY_PREFIX}${PID}`))
    ok('敏感/本机专属判据包含它', isSensitiveMetaKey(`${PULL_OP_KEY_PREFIX}${PID}`))
    ok('阶段文案覆盖四种', ['prepared', 'backup-done', 'writing', 'written']
      .every(p => describePullPhase(p) !== '状态未知'))
  }

  // ───────────────── ④ 自动同步：未完成操作优先于一切推送判断 ─────────────────
  {
    const local = { id: PID, updatedAt: 5000 }
    const binding = bindingOf({ lastSyncedAt: 1000 })
    const d = decideTick({ local, binding, accountId: 'acc-1', remoteRevision: 5, busy: false, pullPending: true })
    ok('decideTick：有未完成操作 ⇒ skip pull-pending', d.action === 'skip' && d.reason === 'pull-pending')
    ok('pull-pending 退避到最长档（不反复问）', nextTickDelay(20_000, d) === 300_000)
    ok('状态文案点明去同步面板处理', tickMessage(d).includes('同步面板'))

    // autoSyncTick：连云端 revision 都不查
    let remoteCalls = 0
    const controller = { isRunning: () => false, requestPush: async () => {} } as unknown as SyncController
    const decision = await autoSyncTick({
      getCurrentProject: async () => local,
      getBinding: async () => binding,
      getRemoteRevision: async () => { remoteCalls++; return 5 },
      controller,
      getAccountId: () => 'acc-1',
      hasPendingPullOp: async () => true,
    })
    ok('autoSyncTick：有未完成操作时一次云端请求都不发', remoteCalls === 0, String(remoteCalls))
    ok('autoSyncTick：结论同样是 pull-pending', decision.action === 'skip' && decision.reason === 'pull-pending')
  }

  // ───────────────── ⑤ 静态契约：界面/流程接线 ─────────────────
  {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
    const apply = read('src/lib/sync/projectPullApply.ts')
    ok('覆盖实现支持 expectedRevision / onBackup / beforeWrite',
      /expectedRevision/.test(apply) && /onBackup/.test(apply) && /beforeWrite/.test(apply))
    ok('版本前进时返回 CLOUD_ADVANCED', /code: revCheck\.code/.test(apply) && /checkPinnedRevision/.test(apply))
    ok('复检在备份之后、写库之前',
      apply.indexOf('await input.onBackup') > apply.indexOf('await createAutoBackup(')
      && apply.indexOf('input.beforeWrite') < apply.indexOf('await restoreBundleToProject('))

    const panel = read('src/components/app/CloudSyncPanel.tsx')
    // 3.3.3 · B1：四步流程抽到 cloudPullApply.ts（面板撞 1200 行硬上限），顺序与文案断言看那一份
    const pull = read('src/components/app/cloudPullApply.ts')
    ok('界面钉住确认版本', /expectedRevision: pinned/.test(pull) && /rev: pinned/.test(pull))
    ok('界面写操作记录并在成功后收尾',
      /beginPullOperation/.test(pull) && /finishPullOperation/.test(pull) && /clearPullOperation/.test(pull))
    ok('界面在覆盖期间暂停自动同步', /stopAutoSync\(\)/.test(pull) && /isAutoSyncRunning\(\)/.test(pull))
    ok('界面有恢复入口（从备份 / 核对当前内容）',
      /restoreBackup\(/.test(pull) && /acceptCloudPullCurrent/.test(panel))
    ok('覆盖前提示"先创建备份"而不是"已备份"',
      /会先创建一份备份/.test(pull) && !/覆盖前的本机版本已自动备份/.test(
        pull.slice(pull.indexOf('export async function runCloudPull'), pull.indexOf('restoreCloudPullBackup'))))
  }

  console.log(`\nPULL_TARGET ${pass} passed, ${fail} failed`)
  process.exitCode = fail === 0 ? 0 : 1
}

main().catch(e => { console.error(e); process.exitCode = 1 })