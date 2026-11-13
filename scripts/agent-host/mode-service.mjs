// 桌面主进程与便携服务共用的连接模式服务。
//
// 职责（顺序即启动顺序）：
//   1. 以独占文件取得「同一资料范围只有一个可信宿主」的所有权锁；
//   2. 读取 / 迁移模式记录（缺失记录只在旧配置可核对时初始化，不猜测损坏记录）；
//   3. 启动 Agent 宿主，并把同一个模式闸注入全部 Agent 调用。
//
// 🔴 本模块不提供网络端点；IPC / 同源 HTTP 由桌面主进程与便携服务各自实现，
//    但两者必须调用同一个服务实例，否则「互斥」只是页面上的一个开关。
// 🔴 恢复只接受用户明确确认：遗留锁移入证据文件、未确认的配置先停用，不删除账本或作品数据。
import path from 'node:path'
import fs from 'node:fs/promises'
import { openOwnedModeManager } from './mode-manager.mjs'
import { createModeFilePersistence } from './mode-file.mjs'
import { createAgentHost, loadConfig, saveConfig } from './core.mjs'
import {
  acquireModeOwnerLock, isModeOwnerProcessAlive, quarantineModeOwnerLock, readModeOwnerLock,
} from './mode-owner-lock.mjs'

const MODE_FILE = 'connection-mode.json'
const LOCK_FILE = 'connection-mode.lock'

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function modePaths(root) {
  return {
    modeFile: path.join(root, MODE_FILE),
    lockFile: path.join(root, LOCK_FILE),
    configFile: path.join(root, 'agent-host.json'),
    pendingFile: path.join(root, 'agent-host.json.pending'),
  }
}

/** 停用未确认的 Agent 配置并保留原文件作为证据；不删除请求账本或作品数据。 */
async function repairAgentConfigAt(root) {
  const { configFile, pendingFile } = modePaths(root)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  try {
    await fs.rename(pendingFile, `${pendingFile}.stale-${stamp}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  let text
  try {
    text = await fs.readFile(configFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = null }
  const valid = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.enabled === 'boolean'
  if (valid && parsed.enabled !== true) return
  if (!valid) {
    // 无法确认授权状态：先留档再写入一份停用配置（沿用能读到的 token / 授权范围）。
    await fs.rename(configFile, `${configFile}.broken-${stamp}`)
  }
  const config = loadConfig(configFile)
  saveConfig(configFile, { ...config, enabled: false })
}

/** 旧配置缺失 = 全新安装；能严格读出 enabled 才算核对过；其余一律不猜测。 */
async function inspectLegacyAgentConfig(configFile, pendingFile) {
  try {
    await fs.lstat(pendingFile)
    return { mode: undefined, reason: '上次 Agent 配置更新未确认，需要人工恢复' }
  } catch (error) {
    if (error?.code !== 'ENOENT') return { mode: undefined, reason: `无法检查 Agent 配置更新标记：${messageOf(error)}` }
  }
  let text
  try {
    text = await fs.readFile(configFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { mode: 'api' }
    return { mode: undefined, reason: `无法读取旧 Agent 配置：${messageOf(error)}` }
  }
  let parsed
  try { parsed = JSON.parse(text) } catch { return { mode: undefined, reason: '旧 Agent 配置损坏，无法确认关闭状态' } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.enabled !== 'boolean') {
    return { mode: undefined, reason: '旧 Agent 配置无效，无法确认关闭状态' }
  }
  // 🔴 迁移一律落在 API 模式：旧版「已开启连接」不等于用户同意在互斥语义下停用引擎 API。
  //    原授权与项目范围保留在配置里，用户可在设置页显式切换回 MCP 模式。
  return { mode: 'api', legacyEnabled: parsed.enabled }
}

/**
 * 用户确认后的**文件级**恢复：释放遗留锁、停用未确认的 Agent 配置、
 * 把不可信的模式记录留档并写入 API 稳定状态。
 * 🔴 不在本函数内启动运行时，也不删除请求账本；调用方随后必须重新创建服务并回读状态。
 */
export async function recoverConnectionFiles({ dataDir, confirm = false, confirmPid = null, verifyQuiescent = async () => {} } = {}) {
  if (!path.isAbsolute(dataDir)) throw new Error('模式数据目录必须为绝对路径')
  if (confirm !== true) throw new Error('恢复连接模式需要用户明确确认')
  const root = path.resolve(dataDir)
  const { modeFile, lockFile } = modePaths(root)
  await quarantineModeOwnerLock(lockFile, { confirmPid })
  // 隔离旧锁后必须重新取得所有权，才允许检查和修改恢复记录。
  // 若其他宿主抢先取得锁，恢复直接失败，不触碰它的数据。
  const recoveryLock = await acquireModeOwnerLock(lockFile)
  try {
  await verifyQuiescent()
  await repairAgentConfigAt(root)

  const store = createModeFilePersistence(modeFile)
  const pending = await store.hasPending()
  let raw
  let readable = true
  try { raw = await store.read() } catch (error) {
    if (error?.code !== 'ENOENT') readable = false
  }
  const trusted = readable && raw && typeof raw === 'object' && raw.version === 1
    && raw.phase === 'stable' && raw.mode === 'api'
  if (!trusted || pending) {
    // 缺失记录交给服务按旧配置迁移；损坏 / 中断记录先留档再写 API，避免把不明状态当作已完成。
    if (raw !== undefined || !readable) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await fs.rename(modeFile, `${modeFile}.broken-${stamp}`).catch(error => {
        if (error?.code !== 'ENOENT') throw error
      })
    }
    await store.write({ version: 1, phase: 'stable', mode: 'api' })
    // 回读确认：写入失败或其它进程改写时保持阻断，不让恢复变成静默放行。
    const confirmed = await store.read()
    if (!confirmed || confirmed.version !== 1 || confirmed.phase !== 'stable' || confirmed.mode !== 'api') {
      throw new Error('恢复后的模式记录回读失败')
    }
  }
  if (pending) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.rename(`${modeFile}.pending`, `${modeFile}.pending.stale-${stamp}`)
  }
  return { modeFile, lockFile }
  } finally {
    await recoveryLock.release()
  }
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir  本机数据目录（桌面 userData / 便携根目录），必须为绝对路径
 * @param {(payload:object)=>Promise<object>} opts.callPage 把 Agent 调用交给页面
 * @param {()=>number} [opts.clientCount]
 */
export async function createModeService({ dataDir, callPage, clientCount = () => 0, acp = null, callReadonly }) {
  if (!path.isAbsolute(dataDir)) throw new Error('模式数据目录必须为绝对路径')
  if (typeof callPage !== 'function') throw new Error('缺少页面调用依赖')
  const root = path.resolve(dataDir)
  const modeFile = path.join(root, MODE_FILE)
  const lockFile = path.join(root, LOCK_FILE)
  const configFile = path.join(root, 'agent-host.json')
  const pendingFile = `${configFile}.pending`
  const supportedModes = acp ? ['api', 'agent', 'acp'] : ['api', 'agent']
  const verifyQuiescent = async () => { await acp?.verifyQuiescent() }

  let gate = null
  let host = null
  let startupError = ''
  let preconditionNote = ''
  let closingGate = null

  /** 打开所有权锁 + 模式记录 + Agent 宿主；宿主失败时保留模式闸以便界面读取状态与恢复。 */
  async function open({ initialModeOverride } = {}) {
    const legacy = await inspectLegacyAgentConfig(configFile, pendingFile)
    const initialMode = initialModeOverride ?? legacy.mode
    let nextGate
    try {
      nextGate = await openOwnedModeManager(modeFile, lockFile, { initialMode, supportedModes, verifyQuiescent })
    } catch (error) {
      startupError = `无法取得连接模式所有权：${messageOf(error)}`
      return false
    }
    gate = nextGate
    preconditionNote = legacy.mode ? '' : (legacy.reason || '')
    if (!legacy.mode) {
      // 旧配置无法核对时不能启动宿主：Agent 宿主启动会回写配置，直接覆盖待核对的损坏证据。
      host = null
      return true
    }
    try {
      const nextHost = createAgentHost({ configFile, callPage, clientCount, modeGate: gate, callReadonly })
      await nextHost.start()
      host = nextHost
      startupError = ''
    } catch (error) {
      // 宿主不可用时继续持有模式闸：API 请求仍可按记录判断，恢复入口也仍需所有权锁。
      host = null
      startupError = `Agent 宿主未启动：${messageOf(error)}`
    }
    return true
  }

  async function status() {
    let lock = null
    try {
      lock = await readModeOwnerLock(lockFile)
    } catch {
      lock = { pid: null, token: null, corrupt: true }
    }
    const snapshot = gate
      ? gate.snapshot()
      : { phase: 'blocked', reason: startupError || '连接模式服务尚未就绪', busy: false }
    const blockedReason = snapshot.phase === 'blocked' || preconditionNote
      ? (preconditionNote || startupError || snapshot.reason || '连接模式不可用')
      : ''
    const lockInfo = lock
      ? {
        pid: lock.pid,
        corrupt: lock.corrupt === true,
        alive: lock.pid === null ? null : isModeOwnerProcessAlive(lock.pid),
      }
      : null
    return {
      phase: preconditionNote ? 'blocked' : snapshot.phase,
      mode: preconditionNote ? null : (snapshot.mode ?? null),
      reason: blockedReason,
      busy: snapshot.busy === true,
      active: snapshot.active ?? { api: 0, agent: 0, acp: 0 },
      supportedModes,
      ownsLock: !!gate,
      lock: lockInfo,
      agent: host ? host.status() : null,
      // 只有在没有可信宿主或记录不可用时才提供恢复；正常运行时不得走恢复路径。
      canRecover: !gate || !!preconditionNote || snapshot.phase === 'blocked' || !host,
    }
  }

  async function closeRuntime() {
    // 仍有未知在途任务时拒绝关闭，避免把不明结果当作已完成。
    if (gate && closingGate !== gate) {
      gate.beginClose()
      closingGate = gate
    }
    await acp?.stop()
    await verifyQuiescent()
    if (host) {
      await host.stop()
      host = null
    }
    if (gate) {
      await gate.finishClose()
      gate = null
      closingGate = null
    }
  }

  try {
    await open()
  } catch (error) {
    // open() 已把宿主失败收敛为状态；这里只兜底未预期异常。
    startupError = `连接模式服务启动失败：${messageOf(error)}`
  }

  return {
    status,

    acquire(mode, owner) {
      if (!gate) throw new Error('连接模式服务未就绪，暂不能启动任务')
      if (preconditionNote) throw new Error(preconditionNote)
      return gate.acquire(mode, owner)
    },

    /** 仅由可信宿主接线调用（桌面 IPC / 便携同源页面）；不接受外部客户端直接改授权。 */
    setAgentConfig(patch) {
      if (!host) throw new Error(`Agent 宿主未启动：${startupError || '未运行'}`)
      return host.setConfig(patch)
    },

    release(id, owner) {
      return gate ? gate.release(id, owner) : false
    },

    async switchTo(to, transitionId, signal) {
      if (!gate) throw new Error(`连接模式服务未就绪：${startupError || '未知原因'}`)
      if (preconditionNote) throw new Error(preconditionNote)
      // 🔴 目标就绪在进入切换前核对：准备失败若发生在切换中，会按设计失败关闭并要求人工恢复。
      if (to === 'agent' && (!host || !host.status().running)) {
        throw new Error(`Agent 宿主未就绪，不能切换到 MCP 模式：${startupError || '宿主未运行'}`)
      }
      await gate.switchTo(to, transitionId, async from => {
        if (from === 'acp') {
          await acp.stop()
          await verifyQuiescent()
          acp.invalidateResults?.()
        }
      }, signal)
      return status()
    },

    canCancelSwitch(id) { return gate?.canCancel(id) === true },
    blockAcpRuntime() { gate?.block('ACP 进程退出未确认，请核对运行现场。') },

    async switchAcpAgent(transitionId, prepare, signal) {
      if (!acp || !gate || preconditionNote) throw new Error('ACP 模式服务未就绪')
      await gate.switchTo('acp', transitionId, async () => {
        await acp.stop()
        await verifyQuiescent()
        return prepare()
      }, signal, true)
      return status()
    },

    /** 用户确认后的恢复：固定回到 API 模式，Agent 连接保持停用。 */
    async recover({ confirm = false, confirmPid = null } = {}) {
      if (confirm !== true) throw new Error('恢复连接模式需要用户明确确认')
      // 关闭当前运行时；仍有在途租约时 closeRuntime 会抛错并保持阻断。
      if (gate && gate.snapshot().phase === 'blocked') await acp?.recover?.()
      await closeRuntime()
      await recoverConnectionFiles({
        dataDir: root, confirm: true, confirmPid,
        verifyQuiescent: async () => {
          await acp?.recover?.()
          await verifyQuiescent()
        },
      })
      startupError = ''
      const opened = await open()
      if (!opened) throw new Error(startupError || '无法重新取得连接模式所有权')
      if (gate && gate.snapshot().phase === 'blocked') {
        throw new Error(gate.snapshot().reason || '恢复后模式仍不可用')
      }
      return status()
    },

    async close() {
      await closeRuntime()
    },
  }
}
