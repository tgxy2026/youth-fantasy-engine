import { useEffect, useState } from 'react'
import { acpWritingContext } from './acpBridge'

export type AcpWritingState = Awaited<ReturnType<typeof acpWritingContext>>

/**
 * 订阅当前 ACP 写作上下文（模式 + Agent 名称 + 设置代次）。
 *
 * 只读 `acp:status`，不建会话、不发请求。模式不是稳定 ACP 时返回 `null`，
 * 调用方据此回退到 API 就绪判断（网页版 / 便携版 / API 模式行为不变）。
 *
 * 🔴 3.5.6 复核：实现改成**进程内共享一份订阅**。
 *    原先每个调用点各挂一个 2 秒 interval —— 3.5.6 之后用到它的组件有十几处
 *    （表单 / 大纲 / 表格 / 工单 / 校对……），各自轮询会让 `acp:status` 被反复调用。
 *    现在只在**第一个**订阅者出现时启动轮询、最后一个离开时停掉，值变化广播给所有订阅者。
 */
let current: AcpWritingState = null
const listeners = new Set<(value: AcpWritingState) => void>()
let timer: ReturnType<typeof setInterval> | null = null
let inflight = false

function publish(next: AcpWritingState) {
  current = next
  for (const fn of listeners) fn(next)
}

async function refresh() {
  // 上一轮还没回来就跳过：IPC 慢时不要排队堆请求
  if (inflight) return
  inflight = true
  try {
    publish(await acpWritingContext())
  } catch {
    publish(null)
  } finally {
    inflight = false
  }
}

function startPolling() {
  if (timer) return
  void refresh()
  timer = setInterval(() => void refresh(), 2000)
}

function stopPolling() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

export function useAcpWriting(): AcpWritingState {
  const [value, setValue] = useState<AcpWritingState>(current)
  useEffect(() => {
    listeners.add(setValue)
    // 新订阅者立刻同步一次当前值（可能在上次轮询后变化过）
    setValue(current)
    startPolling()
    return () => {
      listeners.delete(setValue)
      if (listeners.size === 0) stopPolling()
    }
  }, [])
  return value
}

/** 仅测试用：清掉共享订阅与轮询，避免用例之间互相影响。 */
export function __resetAcpWritingSubscription(): void {
  listeners.clear()
  stopPolling()
  current = null
  inflight = false
}
