// 同步状态徽标元数据（#008：推送失败必须可见，不能让用户零感知地"写了一整晚白工"）
// 抽成独立模块，供 WebTools（网页版）与 CloudFileSyncBar（桌面/便携版）共用，避免重复维护。
import type { SyncStatus } from '@/lib/desktopCloudSync'

export const STATUS_META: Record<SyncStatus, { dot: string; text: string; title: string }> = {
  idle: { dot: 'bg-ink-500', text: '', title: '同步待命' },
  syncing: { dot: 'bg-amber animate-pulse', text: '同步中', title: '正在保存到同步目录…' },
  ok: { dot: 'bg-emerald-400', text: '已同步', title: '数据已保存到同步目录' },
  error: { dot: 'bg-rose-400', text: '同步失败', title: '写入失败，编辑已保留在本机，稍后自动重试' },
  'auth-failed': { dot: 'bg-rose-500', text: '已失效', title: '同步凭据已失效，已切回本机数据' },
  'rate-limited': { dot: 'bg-orange-400', text: '已限流', title: '操作过于频繁，已暂时暂停同步，稍后自动恢复' },
  // #025：推送体积超限（413）——必须让用户知道是"数据太大"而非网络/鉴权问题
  //   2026-10-06 补：与 error / offline 对齐，明确「编辑已保留在本机」——
  //   这条原本只说「请精简后重试」，用户第一反应是「我刚写的东西还在吗」。
  'too-large': { dot: 'bg-rose-500', text: '数据过大', title: '同步数据体积过大，已暂停写入（编辑已保留在本机）；请精简项目内容后重试' },
  // #011：断网/目录不可达 —— 关键是让用户知道编辑留在本地、没丢，恢复后会自动接管
  offline: { dot: 'bg-ink-400', text: '离线', title: '同步目录不可用，已切回本机保存（编辑不会丢）；恢复后自动重新同步' },
}
