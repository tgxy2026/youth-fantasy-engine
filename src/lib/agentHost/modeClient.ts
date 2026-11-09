import type { ConnectionMode } from './modeTransition'

/** 由桌面主进程或便携服务提供；owner 身份由宿主校验，不能由模型决定。 */
export interface ModeLeaseTransport {
  acquire(mode: ConnectionMode): Promise<string>
  release(leaseId: string): Promise<boolean>
}

/**
 * 包住一次完整任务而非仅包住 fetch：流式任务必须等响应体结束或确认取消后返回。
 * 释放未确认时显式失败，不能报告模式切换安全；宿主仍须保留该租约。
 */
export async function runWithModeLease<T>(transport: ModeLeaseTransport, mode: ConnectionMode, work: () => Promise<T>): Promise<T> {
  const lease = await transport.acquire(mode)
  if (typeof lease !== 'string' || !lease) throw new Error('模式租约无效')
  let result: T
  try { result = await work() }
  catch (error) {
    try {
      if (!await transport.release(lease)) throw new Error('模式租约释放未确认')
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], '任务失败且模式租约未能确认释放')
    }
    throw error
  }
  if (!await transport.release(lease)) throw new Error('任务完成但模式租约释放未确认')
  return result
}
