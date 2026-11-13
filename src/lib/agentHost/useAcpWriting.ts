import { useEffect, useState } from 'react'
import { acpWritingContext } from './acpBridge'

export type AcpWritingState = Awaited<ReturnType<typeof acpWritingContext>>

/**
 * 订阅当前 ACP 写作上下文（模式 + Agent 名称 + 设置代次）。
 *
 * 只读 `acp:status`，不建会话、不发请求。模式不是稳定 ACP 时返回 `null`，
 * 调用方据此回退到 API 就绪判断（网页版 / 便携版 / API 模式行为不变）。
 */
export function useAcpWriting(): AcpWritingState {
  const [acpWriting, setAcpWriting] = useState<AcpWritingState>(null)
  useEffect(() => {
    let active = true
    const refresh = () => void acpWritingContext().then(value => {
      if (active) setAcpWriting(value)
    }).catch(() => {
      if (active) setAcpWriting(null)
    })
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  return acpWriting
}