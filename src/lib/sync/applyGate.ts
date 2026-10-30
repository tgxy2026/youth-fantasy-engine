// ============ 3.3.2 · B3-2 覆盖判定（叶子模块）============
//
// 【为什么单独一个文件】"能不能覆盖"是这条流程里**唯一可以脱离数据库穷举验证**的判断，
// 而 `projectPullApply` 顶层 import 了 db / 备份 / 下载一整串模块 —— 单测会把它们全拉起来。
// 判据放这里，测试就能只证明这条规则本身。

/** 覆盖流程的结局码（界面据此说人话） */
export type ApplyInPlaceCode =
  | 'OK'
  /** 本机还有未同步改动，且调用方没有明确确认 */
  | 'LOCAL_DIRTY'
  /** 本机项目不存在（可能刚被删 / 换过项目） */
  | 'NO_PROJECT'
  /** 云端内容没下齐 */
  | 'DOWNLOAD'
  /** 备份没建成 —— 没有退路，中止 */
  | 'BACKUP'
  /** 写入失败（旧数据按实现应当仍在） */
  | 'WRITE'

/**
 * 本机有未同步改动时，必须显式同意才允许覆盖。
 *
 * 🔴 这条判据存在的理由：覆盖会丢掉本机这一版里"还没传上去"的改动。
 *    默认拒绝、要去确认里再点一次 —— 与"不擅自替作者决定"同一口径。
 */
export function canApplyInPlace(input: { localDirty: boolean; allowLocalChanges: boolean }): boolean {
  return !input.localDirty || input.allowLocalChanges
}