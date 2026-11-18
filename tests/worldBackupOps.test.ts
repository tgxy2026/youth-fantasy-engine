// ============ Agent 侧「世界包引入 / 备份恢复」的门槛与回滚契约（3.6.1 · B1 零覆盖债）============
//
// 这两个操作都会**覆盖作者现有内容**，所以 worldBackupOps 的每条失败分支都对应一次
// 真实的数据损失风险。`tests/agentDomainOps.test.ts` 已经端到端跑过主干
// （preview / confirm / 目标表清单 / 跨项目授权 / 指纹过期 / 回滚），这里只补它**没碰的**门槛：
//   ① 没 preview 就直接执行 → 参数校验必须拦下，且一条数据都不写；
//   ② 操作前安全备份**回读失败** → 中止，不能"先改了再找备份"；
//   ③ 备份根本建不出来（示范项目）→ 中止且数据不动；
//   ④ 引入失败后回滚**成功** → 必须报 ROLLED_BACK（此前没有任何用例断言过这个成功码）；
//   ⑤ 引入失败且回滚**失败**（备份载荷被清理）→ 必须报 OUTCOME_UNKNOWN + rolledBack:false；
//   ⑥ 备份恢复没 preview（缺项目版本前置）→ 参数校验拦下。
//
// 🔴 用真实 `AgentExecutorDeps` + 内存 StoreOps（`tests/mock-memory.ts`）跑，不伪造整条存储链：
//    `deps` 与 `StoreOps` 本来就是两层端口，失败注入只在「flush 次数」与「store 读」上做。
import * as db from '../src/lib/db'
import type { TableRow } from '../src/lib/types'
import { AGENT_ACTIONS, AGENT_TOOL_NAMES, type AgentToolResult } from '../src/lib/agentHost/contract'
import { createAgentExecutor, defaultExecutorDeps } from '../src/lib/agentHost/executor'
import type { StoreOps } from '../src/lib/storage/storeOps'
import { DEMO_PROJECT_NAME } from '../src/lib/constants'
import { __resetMockStores, memoryOps } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
function valueOf<T>(result: AgentToolResult): T {
  if (!result.ok) throw new Error(JSON.stringify(result))
  return result.value as T
}
/** 失败提示文本（成功时为空串，避免在联合类型上直接取 error） */
function errOf(result: AgentToolResult): string {
  return result.ok ? '' : result.error
}
/** 失败时带回的上下文（成功时为空对象，避免在联合类型上直接取 current） */
function curOf(result: AgentToolResult): Record<string, unknown> {
  return result.ok ? {} : ((result.current ?? {}) as Record<string, unknown>)
}

const projectId = 'p-ops'
const otherProjectId = 'p-src'
const fullScope = { projects: [
  { projectId, actions: [...AGENT_ACTIONS] },
  { projectId: otherProjectId, actions: [...AGENT_ACTIONS] },
] }

async function seed(projectName = '合成正文书') {
  __resetMockStores()
  const now = Date.now()
  await memoryOps.put('projects', { id: projectId, name: projectName, genre: '', intro: '', projectType: 'full', createdAt: now, updatedAt: now })
  await memoryOps.put('projects', { id: otherProjectId, name: '来源项目', genre: '', intro: '', projectType: 'full', createdAt: now, updatedAt: now })
  await memoryOps.put('volumes', { id: 'v-1', projectId, order: 0, title: '第一卷', description: '', createdAt: now })
  db.setCurrentProject(projectId)
}

async function seedWorld(worldId: string, fingerprint: string) {
  const now = Date.now()
  await memoryOps.put('worlds', {
    id: worldId, name: '合成世界', origin: { projectId: otherProjectId, projectName: '来源项目', at: now },
    tables: [{ tabId: 'nations', kind: 'table', rows: [{ id: 'r1', data: { 名称: '北国' }, order: 0 }] }],
    activeSubs: {}, fingerprint, versions: [], createdAt: now, updatedAt: now,
  })
}

type ExecutorOverrides = {
  draft?: boolean
  blocked?: string
  flush?: () => Promise<boolean>
  /** 包一层 store（读失败 / 写入挂钩用）；不传就用真实内存 StoreOps */
  wrapStore?: (store: StoreOps) => StoreOps
}

function executor(overrides: ExecutorOverrides = {}) {
  const base = defaultExecutorDeps()
  return createAgentExecutor({
    ...base,
    flush: overrides.flush ?? (async () => true),
    unsavedDraft: () => overrides.draft === true,
    activeChapterId: () => null,
    storageBlockReason: () => overrides.blocked ?? '',
    notify: () => undefined,
    ...(overrides.wrapStore
      ? {
        captureOwner: pid => {
          const owner = base.captureOwner(pid)
          return { ...owner, store: overrides.wrapStore!(owner.store) }
        },
      }
      : {}),
  })
}

let seq = 0
async function call(
  tool: string,
  args: Record<string, unknown>,
  ex = executor(),
): Promise<AgentToolResult> {
  return ex.call({ sessionId: 'ops-test', requestId: `req-ops-${String(++seq).padStart(6, '0')}`, tool, args }, fullScope)
}

const nationsRows = async () =>
  (await memoryOps.getAll<TableRow>('tableRows')).filter(row => row.projectId === projectId && row.tabId === 'nations')

async function preview(worldId: string) {
  return valueOf<{ requiredTabs: string[]; projectUpdatedAt: number; fingerprint: string }>(
    await call(AGENT_TOOL_NAMES.previewWorldImport, { projectId, worldId }),
  )
}

async function main() {
  // ① 没 preview 就直接执行：参数校验必须拦下，且一条数据都不写
  {
    await seed()
    await seedWorld('w-1', 'fp-1')
    const missingFingerprint = await call(AGENT_TOOL_NAMES.importWorldPack, {
      projectId, worldId: 'w-1', expectedTabs: ['nations'], expectedProjectUpdatedAt: 0, confirm: true,
    })
    ok('缺预期指纹（没走 preview）时拒绝', missingFingerprint.ok === false && missingFingerprint.code === 'BAD_REQUEST', JSON.stringify(missingFingerprint))
    const missingTabs = await call(AGENT_TOOL_NAMES.importWorldPack, {
      projectId, worldId: 'w-1', expectedFingerprint: 'fp-1', expectedProjectUpdatedAt: 0, confirm: true,
    })
    ok('缺预期表清单（没走 preview）时拒绝', missingTabs.ok === false && missingTabs.code === 'BAD_REQUEST', JSON.stringify(missingTabs))
    ok('被参数校验拦下时一条行都没写', (await nationsRows()).length === 0)
    ok('被参数校验拦下时没有留下安全备份', (await memoryOps.getAll('backups')).length === 0)
  }

  // ② 操作前安全备份回读失败：中止，不改数据
  {
    await seed()
    await seedWorld('w-2', 'fp-2')
    const pv = await preview('w-2')
    const ex = executor({
      wrapStore: store => new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === 'get') {
            return async (name: string, key: string) => (name === 'backupPayloads' ? undefined : target.get(name, key))
          }
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }),
    })
    const result = await call(AGENT_TOOL_NAMES.importWorldPack, {
      projectId, worldId: 'w-2', expectedTabs: pv.requiredTabs, expectedFingerprint: pv.fingerprint,
      expectedProjectUpdatedAt: pv.projectUpdatedAt, confirm: true,
    }, ex)
    ok('安全备份回读失败时中止引入', result.ok === false && result.code === 'SAVE_FAILED', JSON.stringify(result))
    ok('中止发生在导入之前（目标表仍为空）', (await nationsRows()).length === 0)
    ok('回读失败的提示说清是备份读不回来', errOf(result).includes('回读失败'), errOf(result))
  }

  // ③ 备份根本建不出来（示范项目）：中止且数据不动
  {
    await seed(DEMO_PROJECT_NAME)
    await seedWorld('w-3', 'fp-3')
    // 示范项目的预览本身也会走备份判定，先确认预览仍可用
    const pv = await preview('w-3')
    const result = await call(AGENT_TOOL_NAMES.importWorldPack, {
      projectId, worldId: 'w-3', expectedTabs: pv.requiredTabs, expectedFingerprint: pv.fingerprint,
      expectedProjectUpdatedAt: pv.projectUpdatedAt, confirm: true,
    })
    ok('备份创建失败时中止引入', result.ok === false && result.code === 'SAVE_FAILED', JSON.stringify(result))
    ok('备份创建失败时提示已中止', errOf(result).includes('已中止'), errOf(result))
    ok('备份创建失败时目标表仍为空', (await nationsRows()).length === 0)
    ok('备份创建失败时不产生半份备份记录', (await memoryOps.getAll('backups')).length === 0)
  }

  // ④ 引入失败但回滚成功：必须报 ROLLED_BACK，且内容回到引入前
  {
    await seed()
    await seedWorld('w-4', 'fp-4')
    const pv = await preview('w-4')
    let flushes = 0
    // 第 2 次 flush = 引入后确认落盘 ⇒ 判为未确认，触发回滚；第 3 次（回滚后）恢复成功
    const result = await call(AGENT_TOOL_NAMES.importWorldPack, {
      projectId, worldId: 'w-4', expectedTabs: pv.requiredTabs, expectedFingerprint: pv.fingerprint,
      expectedProjectUpdatedAt: pv.projectUpdatedAt, confirm: true,
    }, executor({ flush: async () => ++flushes !== 2 }))
    ok('回滚成功时报告已回滚（ROLLED_BACK）', result.ok === false && result.code === 'ROLLED_BACK', JSON.stringify(result))
    ok('回滚成功时返回 rolledBack:true 与安全备份编号', curOf(result).rolledBack === true && typeof curOf(result).preBackupId === 'string', JSON.stringify(curOf(result)))
    ok('回滚成功后目标表回到引入前（无残留行）', (await nationsRows()).length === 0)
    // 🔴 回滚走的是 `restoreBackup`：内容按备份还原，**主键会重新生成**（既有行为，非本版改动），
    //    所以这里按「卷仍在且归属正确」断言，不能钉 id。
    const volumesAfterRollback = await memoryOps.getAll<{ id: string; projectId?: string; title: string }>('volumes')
    ok('回滚成功后原卷仍在（主键按备份重建）',
      volumesAfterRollback.length === 1 && volumesAfterRollback[0].projectId === projectId && volumesAfterRollback[0].title === '第一卷',
      JSON.stringify(volumesAfterRollback))
  }

  // ⑤ 引入失败且回滚失败（备份载荷被清理）：结果不明，不能报已回滚
  {
    await seed()
    await seedWorld('w-5', 'fp-5')
    const pv = await preview('w-5')
    let flushes = 0
    const result = await call(AGENT_TOOL_NAMES.importWorldPack, {
      projectId, worldId: 'w-5', expectedTabs: pv.requiredTabs, expectedFingerprint: pv.fingerprint,
      expectedProjectUpdatedAt: pv.projectUpdatedAt, confirm: true,
    }, executor({ flush: async () => {
      flushes++
      if (flushes === 2) {
        // 模拟「备份被外部清理 / 写到一半断电」：元数据还在，载荷没了
        for (const payload of await memoryOps.getAll<{ id: string }>('backupPayloads')) {
          await memoryOps.del('backupPayloads', payload.id)
        }
        return false
      }
      return true
    } }))
    ok('回滚也失败时报结果不明（OUTCOME_UNKNOWN）', result.ok === false && result.code === 'OUTCOME_UNKNOWN', JSON.stringify(result))
    ok('回滚失败时不得声称已回滚', curOf(result).rolledBack === false, JSON.stringify(curOf(result)))
    ok('回滚失败时仍交出安全备份编号供人工核对', typeof curOf(result).preBackupId === 'string', JSON.stringify(curOf(result)))
    ok('回滚失败的提示同时带原始错误与回滚错误', errOf(result).includes('回滚'), errOf(result))
  }

  // ⑥ 备份恢复没 preview（缺项目版本前置）→ 参数校验拦下
  {
    await seed()
    await seedWorld('w-6', 'fp-6')
    const noPreview = await call(AGENT_TOOL_NAMES.restoreProjectBackup, {
      projectId, backupId: 'b-any', confirm: true,
    })
    ok('恢复备份缺项目版本前置时拒绝', noPreview.ok === false && noPreview.code === 'BAD_REQUEST', JSON.stringify(noPreview))
    ok('被拦下的恢复没有动卷', (await memoryOps.getAll<{ id: string }>('volumes')).length === 1)
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} worldBackupOps ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

await main()
