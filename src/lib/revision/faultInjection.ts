// ============ W7 版本整合 · 故障注入与跨设备验收 ============
// 2026-10-20 · 方案 §11 / W7
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① 故障注入（写盘失败、读失败、网络错误）
//    ② 跨设备冲突检测
//    ③ 数据文件版本校验
//    ④ 迁移隔离与恢复

// ============ 故障类型 ============
export type FaultType =
  | 'write-fail'      // 写盘失败
  | 'read-fail'       // 读失败
  | 'network-error'   // 网络错误
  | 'timeout'         // 超时
  | 'corruption'      // 数据损坏
  | 'version-mismatch' // 版本不匹配
  | 'conflict'        // 跨设备冲突

// ============ 故障注入配置 ============
export interface FaultInjectionConfig {
  /** 是否启用故障注入 */
  enabled: boolean
  /** 故障类型 */
  faultType: FaultType
  /** 故障概率（0-1） */
  probability: number
  /** 故障延迟（毫秒） */
  delayMs?: number
  /** 目标 store（可选） */
  targetStore?: string
  /** 目标 key（可选） */
  targetKey?: string
}

// ============ 故障注入结果 ============
export interface FaultInjectionResult {
  /** 是否注入故障 */
  injected: boolean
  /** 故障类型 */
  faultType: FaultType
  /** 错误信息 */
  error?: string
  /** 是否应重试 */
  shouldRetry: boolean
}

/** 判断是否注入故障 */
export function shouldInjectFault(config: FaultInjectionConfig): boolean {
  if (!config.enabled) return false
  return Math.random() < config.probability
}

/** 执行故障注入 */
export function injectFault<T>(
  config: FaultInjectionConfig,
  operation: () => T,
): T | FaultInjectionResult {
  if (!shouldInjectFault(config)) {
    return operation()
  }

  switch (config.faultType) {
    case 'write-fail':
      return {
        injected: true,
        faultType: 'write-fail',
        error: '写盘失败：磁盘空间不足或权限被拒绝',
        shouldRetry: true,
      }
    case 'read-fail':
      return {
        injected: true,
        faultType: 'read-fail',
        error: '读失败：文件不存在或已损坏',
        shouldRetry: false,
      }
    case 'network-error':
      return {
        injected: true,
        faultType: 'network-error',
        error: '网络错误：无法连接到服务器',
        shouldRetry: true,
      }
    case 'timeout':
      return {
        injected: true,
        faultType: 'timeout',
        error: '操作超时',
        shouldRetry: true,
      }
    case 'corruption':
      return {
        injected: true,
        faultType: 'corruption',
        error: '数据损坏：校验和不匹配',
        shouldRetry: false,
      }
    case 'version-mismatch':
      return {
        injected: true,
        faultType: 'version-mismatch',
        error: '版本不匹配：数据文件版本过高，需要升级程序',
        shouldRetry: false,
      }
    case 'conflict':
      return {
        injected: true,
        faultType: 'conflict',
        error: '跨设备冲突：另一设备已修改此数据',
        shouldRetry: false,
      }
    default:
      return operation()
  }
}

// ============ 跨设备冲突检测 ============
export interface ConflictInfo {
  /** 是否冲突 */
  hasConflict: boolean
  /** 冲突类型 */
  conflictType?: 'content' | 'metadata' | 'structure'
  /** 本地版本 */
  localVersion: number
  /** 远端版本 */
  remoteVersion: number
  /** 冲突摘要 */
  summary?: string
}

/** 检测跨设备冲突 */
export function detectConflict(
  localRev: number,
  remoteRev: number,
  localChecksum: string,
  remoteChecksum: string,
): ConflictInfo {
  if (localRev === remoteRev && localChecksum === remoteChecksum) {
    return { hasConflict: false, localVersion: localRev, remoteVersion: remoteRev }
  }

  if (localRev !== remoteRev) {
    return {
      hasConflict: true,
      conflictType: 'structure',
      localVersion: localRev,
      remoteVersion: remoteRev,
      summary: `版本不一致：本地 v${localRev}，远端 v${remoteRev}`,
    }
  }

  return {
    hasConflict: true,
    conflictType: 'content',
    localVersion: localRev,
    remoteVersion: remoteRev,
    summary: `内容不一致：本地 ${localChecksum.slice(0, 8)}…，远端 ${remoteChecksum.slice(0, 8)}…`,
  }
}

// ============ 数据文件版本校验 ============
export interface VersionCheckResult {
  /** 是否兼容 */
  compatible: boolean
  /** 当前版本 */
  currentVersion: number
  /** 文件版本 */
  fileVersion: number
  /** 需要的最小版本 */
  minVersion: number
  /** 建议操作 */
  action?: 'upgrade' | 'downgrade' | 'readonly' | 'ok'
}

/** 校验数据文件版本 */
export function checkDataVersion(
  fileVersion: number,
  currentVersion: number,
  minVersion: number,
): VersionCheckResult {
  if (fileVersion > currentVersion) {
    return {
      compatible: false,
      currentVersion,
      fileVersion,
      minVersion,
      action: 'upgrade',
    }
  }
  if (fileVersion < minVersion) {
    return {
      compatible: false,
      currentVersion,
      fileVersion,
      minVersion,
      action: 'downgrade',
    }
  }
  return {
    compatible: true,
    currentVersion,
    fileVersion,
    minVersion,
    action: 'ok',
  }
}

// ============ 迁移隔离与恢复 ============
export interface MigrationState {
  /** 迁移 ID */
  migrationId: string
  /** 迁移状态 */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'rolled-back'
  /** 开始时间 */
  startedAt: number
  /** 完成时间 */
  finishedAt?: number
  /** 备份 ID（用于恢复） */
  backupId?: string
  /** 错误信息 */
  error?: string
}

/** 创建迁移状态 */
export function createMigrationState(migrationId: string): MigrationState {
  return {
    migrationId,
    status: 'pending',
    startedAt: Date.now(),
  }
}

/** 开始迁移 */
export function startMigration(state: MigrationState): MigrationState {
  return { ...state, status: 'running' }
}

/** 完成迁移 */
export function completeMigration(state: MigrationState, backupId: string): MigrationState {
  return {
    ...state,
    status: 'completed',
    finishedAt: Date.now(),
    backupId,
  }
}

/** 失败迁移 */
export function failMigration(state: MigrationState, error: string): MigrationState {
  return {
    ...state,
    status: 'failed',
    finishedAt: Date.now(),
    error,
  }
}

/** 回滚迁移 */
export function rollbackMigration(state: MigrationState): MigrationState {
  return {
    ...state,
    status: 'rolled-back',
    finishedAt: Date.now(),
  }
}

// ============ 写盘失败严格返回 ============
export interface WriteResult {
  /** 是否成功 */
  ok: boolean
  /** 错误信息 */
  error?: string
  /** 是否应重试 */
  shouldRetry: boolean
}

/** 严格写盘：写入失败必须返回失败，不能静默吞掉 */
export async function strictWrite<T>(
  writeOp: () => Promise<T>,
  readBackOp: () => Promise<T | undefined>,
  validator: (written: T, readBack: T) => boolean,
): Promise<WriteResult> {
  try {
    const written = await writeOp()
    const readBack = await readBackOp()
    if (!readBack) {
      return { ok: false, error: '写盘后回读失败', shouldRetry: true }
    }
    // 🔴 原先这里"简化处理"直接返回成功 —— 传进来的 validator 从未被调用，
    //    「严格写盘」退化成「写一次就算成功」，回读不一致也报绿（本项目明令禁止的假绿）。
    //    现在拿**写入值**与回读值交给 validator 比对，不一致即失败。
    if (!validator(written, readBack)) {
      return { ok: false, error: '写盘后回读校验不一致', shouldRetry: true }
    }
    return { ok: true, shouldRetry: false }
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      shouldRetry: true,
    }
  }
}
