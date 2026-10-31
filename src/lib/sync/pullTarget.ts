// ============ 3.3.3 · B1 「用云端新版更新本机」的判定（叶子模块）============
//
// 【为什么单独成文件】"能不能把云端这一版落到本机"是这条流程里**唯一可以脱离数据库穷举验证**
// 的判断；`projectPullApply` 顶层 import 了 db / 备份 / 下载一整串模块，单测会把它们全拉起来。
// 判据放这里，测试就能只证明规则本身。
//
// 【它守的是什么】作者在确认框里看到的是「用它替换第 N 版」。确认之后到真正写库之间，
// 有三件事会变：云端可能又推进了几版、本机可能又被改过、项目/账号可能已经切走。
// 其中任何一件发生，都必须**停下来重新确认**，不能拿一个已经不对的目标继续写 ——
// 那等于替作者换掉了他没有同意的那一版。
import type { ApplyInPlaceCode } from '@/lib/sync/applyGate'

export interface TargetCheck {
  ok: boolean
  /** 不通过时的结局码（通过时为 'OK'） */
  code: ApplyInPlaceCode
  /** 中文原因（通过时为空串） */
  reason: string
}

const pass: TargetCheck = { ok: true, code: 'OK', reason: '' }

/**
 * 云端版本是否仍是作者确认的那一版。
 *
 * 🔴 云端在确认后前进 ⇒ **不自动改目标**：用户确认的是第 7 版，就不能悄悄写第 9 版。
 *    正确做法是中止并让他重新确认（界面上会重新显示最新版号）。
 */
export function checkPinnedRevision(input: { pinned?: number; fetched: number }): TargetCheck {
  if (!input.pinned || !Number.isFinite(input.pinned)) {
    // 没钉住版本本身就是缺陷：下载时"最新"可能已经换了一版
    return { ok: false, code: 'CLOUD_ADVANCED', reason: '没有确认到具体版本号，本次没有更新。请刷新后重新确认。' }
  }
  if (input.fetched !== input.pinned) {
    return {
      ok: false, code: 'CLOUD_ADVANCED',
      reason: `云端已经推进到第 ${input.fetched || '?'} 版（你确认的是第 ${input.pinned} 版），本次没有更新。请重新确认最新版本。`,
    }
  }
  return pass
}

/**
 * 备份之后、写库之前的最后一道：本机内容是否还是确认时的那一份。
 *
 * 🔴 为什么要比 `updatedAt` 而不是自己记开关：作者在确认期间继续打字是最常见的情况，
 *    此时覆盖会把这几分钟的新稿丢掉。`touchProject` 每次写卷/章/页签都会刷新它。
 */
export function checkLocalVersionUnchanged(input: { expectedUpdatedAt: number; currentUpdatedAt: number }): TargetCheck {
  if (input.currentUpdatedAt !== input.expectedUpdatedAt) {
    return {
      ok: false, code: 'STALE_TARGET',
      reason: '确认之后本机内容又发生了变化（可能刚保存了新的编辑），本次没有更新。请重新确认。',
    }
  }
  return pass
}

/** 项目是否还是确认时那一本（切书后晚回执不能写进新书） */
export function checkSameProject(input: { expectedId: string; currentId: string }): TargetCheck {
  if (!input.expectedId || input.expectedId !== input.currentId) {
    return { ok: false, code: 'STALE_TARGET', reason: '已经切换到另一本作品，本次更新没有写入。请回到原项目重新操作。' }
  }
  return pass
}

/**
 * 同步绑定是否还是确认时的那个（云端作品 / 基线没被别处改过）。
 * 传字符串而不是对象，便于跨层比较且避免误把可变对象当快照。
 */
export function checkSameBinding(input: { expected: string; current: string }): TargetCheck {
  if (input.expected !== input.current) {
    return { ok: false, code: 'STALE_TARGET', reason: '这本作品的同步绑定已经变化（可能在别处重绑或解绑），本次没有更新。请刷新后重新确认。' }
  }
  return pass
}

/** 依次跑完整套复检，返回第一个不通过的原因（全通过返回 `pass`） */
export function verifyTargets(checks: TargetCheck[]): TargetCheck {
  return checks.find(c => !c.ok) ?? pass
}

/** 操作记录阶段 → 给作者看的一句话（恢复面板用） */
export function describePullPhase(phase: string): string {
  switch (phase) {
    case 'prepared': return '已经确认目标版本，尚未创建备份'
    case 'backup-done': return '备份已经创建，还没有开始写入本机'
    case 'writing': return '正在写入本机（可能只写了一半）'
    case 'written': return '内容已经写入，但同步基线还没有更新'
    default: return '状态未知'
  }
}