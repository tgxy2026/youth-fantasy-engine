// 单宿主模式协调器。只有获得唯一宿主所有权的进程才能创建一个实例；
// 页面、MCP 和模型请求必须通过同一宿主申请租约。此模块不自行判定进程唯一性。
import { randomBytes } from 'node:crypto'
import { createModeFilePersistence } from './mode-file.mjs'
import { acquireModeOwnerLock } from './mode-owner-lock.mjs'

function decode(raw, supportedModes) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) return { phase: 'blocked', reason: '模式状态缺失或版本未知' }
  if (raw.phase === 'stable' && supportedModes.includes(raw.mode)) return { phase: 'stable', mode: raw.mode }
  return { phase: 'blocked', reason: '模式状态无效或上次切换未完成' }
}

/**
 * @param {string} file 模式记录文件
 * @param {'api'|'agent'|undefined} initialMode 仅在记录文件**从未存在**且调用方已核对旧配置后给出；
 *   缺失的原因不明（损坏、中断、权限）时不要给出，保持 blocked。
 */
async function createModeManager(store, initialMode, supportedModes, verifyQuiescent) {
  const readMode = async () => decode(await store.read(), supportedModes)
  let state
  let missing = false
  try {
    state = await store.hasPending()
      ? { phase: 'blocked', reason: '上次模式切换未确认' }
      : await readMode()
    await verifyQuiescent()
  } catch (error) {
    missing = error?.code === 'ENOENT' && state === undefined
    state = { phase: 'blocked', reason: missing ? '模式记录尚未建立' : state ? error.message : '无法读取模式状态' }
  }
  if (missing && supportedModes.includes(initialMode)) {
    try {
      await verifyQuiescent()
      await store.initialize(initialMode)
      state = await readMode()
    } catch (error) {
      if (error?.code === 'EEXIST') {
        // 另一个写者在我们持有锁期间创建了记录：只接受能严格解析的稳定状态。
        try {
          if (await store.hasPending()) throw new Error('模式切换未确认')
          await verifyQuiescent()
          state = await readMode()
        } catch { state = { phase: 'blocked', reason: '模式初始化发生竞争' } }
      } else {
        state = { phase: 'blocked', reason: '模式记录初始化失败' }
      }
    }
  }
  const leases = new Map()
  const waiters = new Set()
  let busy = false
  let committing = false
  const snapshot = () => {
    const active = { api: 0, agent: 0, acp: 0 }
    for (const lease of leases.values()) active[lease.mode]++
    return { ...state, busy, active }
  }
  const drain = signal => {
    if (signal?.aborted) return Promise.reject(new Error('等待任务结束已取消'))
    if (!leases.size) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const cleanup = () => { waiters.delete(done); signal?.removeEventListener('abort', abort) }
      const done = () => {
        cleanup()
        if (state.phase === 'blocked') reject(new Error(state.reason))
        else resolve()
      }
      const abort = () => { cleanup(); reject(new Error('等待任务结束已取消')) }
      waiters.add(done)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  return {
    snapshot,
    async initialize(mode, confirmPreviousStopped) {
      if (busy || state.phase !== 'blocked' || leases.size) throw new Error('当前状态不能初始化')
      if (typeof confirmPreviousStopped !== 'function') throw new Error('缺少旧宿主检查')
      if (mode !== 'api' && mode !== 'agent') throw new Error('初始模式无效')
      busy = true
      try {
        if (!await confirmPreviousStopped()) throw new Error('旧 Agent 宿主未确认关闭，不能初始化')
        await store.initialize(mode)
        const confirmed = await readMode()
        if (confirmed.phase !== 'stable' || confirmed.mode !== mode) throw new Error('初始模式回读失败')
        state = confirmed
        return snapshot()
      } catch (error) {
        state = { phase: 'blocked', reason: '初始化未确认完成' }
        throw error
      } finally { busy = false }
    },
    async initializeApi(confirmAgentDisabled) {
      return this.initialize('api', confirmAgentDisabled)
    },
    // 恢复仅由可信宿主调用：必须先确认旧进程及所有任务已终止。
    // 不推断残留锁或超时任务的状态，也不从损坏记录自动恢复。
    async recover(mode, confirmQuiescent) {
      if (busy || state.phase !== 'blocked' || leases.size) throw new Error('当前状态不能恢复')
      if (typeof confirmQuiescent !== 'function') throw new Error('缺少任务终止确认')
      if (mode !== 'api' && mode !== 'agent') throw new Error('恢复目标模式无效')
      busy = true
      try {
        if (!await confirmQuiescent()) throw new Error('未确认旧宿主和任务均已停止')
        await store.write({ version: 1, phase: 'stable', mode })
        const confirmed = await readMode()
        if (confirmed.phase !== 'stable' || confirmed.mode !== mode) throw new Error('恢复模式回读失败')
        state = confirmed
        return snapshot()
      } catch (error) {
        state = { phase: 'blocked', reason: '恢复未确认完成' }
        throw error
      } finally { busy = false }
    },
    async recoverApi(confirmQuiescent) {
      return this.recover('api', confirmQuiescent)
    },
    acquire(mode, owner) {
      if (!supportedModes.includes(mode) || typeof owner !== 'string' || !owner || owner.length > 200) throw new Error('任务租约参数无效或当前平台不支持该模式')
      if (state.phase !== 'stable' || state.mode !== mode) throw new Error('当前连接模式不允许启动该任务')
      const id = randomBytes(24).toString('hex')
      leases.set(id, { mode, owner })
      return id
    },
    release(id, owner) {
      const lease = leases.get(id)
      if (!lease || lease.owner !== owner) return false
      leases.delete(id)
      if (!leases.size) for (const wake of [...waiters]) wake()
      return true
    },
    canCancel(id) {
      return state.phase === 'switching' && state.transitionId === id && !committing
    },
    block(reason) {
      state = { phase: 'blocked', reason }
      for (const wake of [...waiters]) wake()
    },
    async switchTo(to, id, prepare, signal, reconfigure = false) {
      if (busy) throw new Error('模式切换正在进行')
      if (state.phase !== 'stable') throw new Error('模式不可用，需要恢复')
      if (!supportedModes.includes(to) || typeof id !== 'string' || !id.trim() || id.length > 200 || typeof prepare !== 'function') throw new Error('模式切换参数无效或当前平台不支持该模式')
      if (reconfigure && (state.mode !== 'acp' || to !== 'acp')) throw new Error('仅 ACP 模式允许切换 ACP Agent')
      if (state.mode === to && !reconfigure) return snapshot()
      if (signal?.aborted) throw new Error('切换已取消')
      busy = true
      const from = state.mode
      state = { phase: 'switching', from, to, transitionId: id }
      try {
        const record = { version: 1, ...state }
        await store.markPending(record)
        await store.write(record)
        const written = await store.read()
        if (written?.version !== 1 || written?.phase !== 'switching' || written?.from !== from || written?.to !== to || written?.transitionId !== id) throw new Error('切换记录回读失败')
        await drain(signal)
        if (signal?.aborted) throw new Error('切换已取消')
        const commit = await prepare(from)
        if (signal?.aborted) throw new Error('切换已取消')
        committing = true
        if (typeof commit === 'function') await commit()
        await store.write({ version: 1, phase: 'stable', mode: to })
        const confirmed = await readMode()
        if (confirmed.phase !== 'stable' || confirmed.mode !== to) throw new Error('模式回读失败')
        await store.clearPending()
        state = confirmed
      } catch (error) {
        state = { phase: 'blocked', reason: '切换结果未确认' }
        throw error
      } finally { busy = false; committing = false }
      return snapshot()
    },
  }
}

/** 获取本机排他锁后创建宿主；不自动清理遗留锁或损坏状态，恢复须用户明确确认。 */
export async function openOwnedModeManager(file, lockFile, {
  initialMode, supportedModes = ['api', 'agent'], verifyQuiescent = async () => {},
  store = createModeFilePersistence(file),
} = {}) {
  const lock = await acquireModeOwnerLock(lockFile)
  let manager
  try { manager = await createModeManager(store, initialMode, supportedModes, verifyQuiescent) }
  catch (error) { await lock.release(); throw error }
  let closing = false
  return {
    snapshot: () => manager.snapshot(),
    initializeApi(confirmAgentDisabled) {
      if (closing) throw new Error('模式宿主正在关闭')
      return manager.initializeApi(confirmAgentDisabled)
    },
    recoverApi(confirmQuiescent) {
      if (closing) throw new Error('模式宿主正在关闭')
      return manager.recoverApi(confirmQuiescent)
    },
    acquire(mode, owner) {
      if (closing) throw new Error('模式宿主正在关闭')
      return manager.acquire(mode, owner)
    },
    release: (id, owner) => manager.release(id, owner),
    canCancel: id => manager.canCancel(id),
    block: reason => manager.block(reason),
    switchTo(to, id, prepare, signal, reconfigure) {
      if (closing) throw new Error('模式宿主正在关闭')
      return manager.switchTo(to, id, prepare, signal, reconfigure)
    },
    beginClose() {
      if (closing) throw new Error('模式宿主正在关闭')
      closing = true
      const current = manager.snapshot()
      if (current.busy || Object.values(current.active).some(Boolean)) {
        closing = false
        throw new Error('仍有模式切换或在途任务，不能释放宿主锁')
      }
    },
    cancelClose() { closing = false },
    async finishClose() {
      if (!closing) throw new Error('尚未进入关闭状态')
      await lock.release()
    },
    async close() {
      this.beginClose()
      try { await this.finishClose() } catch (error) { this.cancelClose(); throw error }
    },
  }
}
