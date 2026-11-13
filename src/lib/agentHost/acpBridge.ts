import { connectionModeStatus } from './modeBridge'

export interface AcpStatus {
  generation: string
  selected: string | null
  adapters: { id: string; name: string; available: boolean }[]
  requiresConnection?: boolean
  ready?: boolean
}

interface AcpBridge {
  status(): Promise<AcpStatus | null>
  generate(request: { id: string; task: 'continuation' | 'rewrite'; generation: string; text: string }): Promise<{ ok: boolean; text?: string; error?: string }>
  cancel(id: string): Promise<boolean>
  onChunk(handler: (chunk: { id: string; delta: string }) => void): () => void
}

function bridge(): AcpBridge | undefined {
  return typeof window === 'undefined' ? undefined : (window as Window & { electronAcp?: AcpBridge }).electronAcp
}

export async function acpWritingContext() {
  const api = bridge()
  if (!api) return null
  const mode = await connectionModeStatus()
  if (mode.phase !== 'stable' || mode.mode !== 'acp') return null
  const status = await api.status()
  if (!status) throw new Error('ACP 模式状态无法核对。')
  const agent = status.adapters.find(adapter => adapter.id === status.selected)
  return {
    generation: status.generation, name: agent?.name ?? 'ACP Agent',
    ready: agent?.available === true && (!status.requiresConnection || status.ready === true),
  }
}

export async function assertAcpWritingCurrent(generation: string) {
  const current = await acpWritingContext()
  if (current?.generation !== generation) throw new Error('ACP 模式或 Agent 设置已变化，请重新生成。')
}

export async function acpWrite(task: 'continuation' | 'rewrite', generation: string, text: string, opts?: {
  signal?: AbortSignal
  onToken?: (delta: string) => void
}): Promise<string> {
  const api = bridge()
  if (!api) throw new Error('ACP 写作仅在桌面端可用。')
  await assertAcpWritingCurrent(generation)
  opts?.signal?.throwIfAborted()
  const id = crypto.randomUUID()
  const unsubscribe = api.onChunk(chunk => {
    if (chunk.id === id && !opts?.signal?.aborted) opts?.onToken?.(chunk.delta)
  })
  const cancel = () => { void api.cancel(id).catch(() => false) }
  opts?.signal?.addEventListener('abort', cancel, { once: true })
  try {
    const result = await api.generate({ id, task, generation, text })
    opts?.signal?.throwIfAborted()
    if (!result.ok || !result.text) throw new Error(result.error ?? 'ACP 没有返回可用正文。')
    await assertAcpWritingCurrent(generation)
    opts?.signal?.throwIfAborted()
    return result.text
  } finally {
    unsubscribe()
    opts?.signal?.removeEventListener('abort', cancel)
  }
}
