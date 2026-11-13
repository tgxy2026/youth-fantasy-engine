import { useEffect, useState } from 'react'
import { showToast } from '@/components/dialogs/dialogs'
import { Button } from '@/components/common/Button'
import { ChevronDown } from 'lucide-react'

const selectClass = 'min-w-0 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-12 text-ink-100 disabled:opacity-50'

interface AcpSettingsStatus {
  adapters: { id: string; name: string; available: boolean; componentVersion: string | null }[]
  selected: string | null
  config: { binary: string; model: string; thinking: string } | null
  options?: Partial<Record<'model' | 'thinking', { current?: string; values: { value: string; name: string }[] }>> | null
  ready?: boolean
}

interface AcpDesktopSettings {
  status(): Promise<AcpSettingsStatus | null>
  select(id: string): Promise<{ ok: boolean; error?: string }>
  install(id: string): Promise<{ ok: boolean; error?: string }>
  selectBinary(id: string): Promise<{ ok: boolean; error?: string }>
  connect(id: string, login: boolean): Promise<{ ok: boolean; error?: string }>
  disconnect(id: string): Promise<{ ok: boolean; error?: string }>
  logout(id: string): Promise<{ ok: boolean; error?: string }>
  configure(id: string, patch: { key: 'model' | 'thinking'; value: string }): Promise<{ ok: boolean; error?: string }>
  cancel(id: string): Promise<boolean>
}

export default function AcpSettings({ disabled }: { disabled: boolean }) {
  const api = (window as Window & { electronAcp?: AcpDesktopSettings }).electronAcp
  const [status, setStatus] = useState<AcpSettingsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [operation, setOperation] = useState<{ id: string; label: string } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    void api?.status().then(value => {
      if (mounted) setStatus(value)
    }).catch(() => {
      if (mounted) setError('无法读取 ACP 设置。')
    })
    return () => { mounted = false }
  }, [api])

  async function select(id: string) {
    if (!api || busy || disabled || operation) return
    setBusy(true)
    try {
      const result = await api.select(id)
      if (!result.ok) throw new Error(result.error || 'ACP Agent 切换失败。')
      setStatus(await api.status())
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'ACP Agent 切换失败。', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function run(label: string, action: (id: string) => Promise<{ ok: boolean; error?: string }>, success?: string) {
    if (!api || operation || disabled || busy) return
    const id = crypto.randomUUID()
    setOperation({ id, label })
    try {
      const result = await action(id)
      if (!result.ok) throw new Error(result.error || 'ACP 操作失败。')
      setStatus(await api.status())
      if (success) showToast(success, 'success')
    } catch (error) {
      setStatus(await api.status().catch(() => null))
      showToast(error instanceof Error ? error.message : 'ACP 操作失败。', 'error')
    } finally {
      setOperation(null)
    }
  }

  if (error) return <p className="text-12 text-amber">{error}</p>
  if (!status) return <p className="text-12 text-ink-500">正在读取 ACP 设置…</p>
  const selected = status.adapters.find(adapter => adapter.id === status.selected)
  const configured = !!status.config?.binary
  const connected = !!status.ready
  const controlsDisabled = disabled || busy || !!operation
  const connectionLabel = connected ? '会话已验证' : status.options ? '模型选项待核对' : '等待验证会话'
  const optionKeys = (['model', 'thinking'] as const).filter(key => status.options?.[key])

  return <div className="max-w-3xl space-y-3" data-acp-settings>
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
      <label className="grid w-56 max-w-full gap-1 text-12 font-medium text-ink-200">
        ACP Agent
      <select
        id="acp-agent-select"
        className={selectClass}
        value={selected?.id ?? ''}
        disabled={controlsDisabled}
        onChange={event => void select(event.target.value)}
      >
        {!selected && <option value="" disabled>请选择 ACP Agent</option>}
        {status.adapters.map(adapter => <option key={adapter.id} value={adapter.id}>{adapter.name}</option>)}
      </select>
      </label>
      {operation && <Button size="sm" variant="secondary" onClick={() => void api?.cancel(operation.id)}>取消 ACP 操作</Button>}
    </div>
    {(operation || busy) && <p role="status" className="text-12 text-ink-400">{operation?.label ?? '正在等待当前 ACP 任务结束…'}</p>}
    {selected?.componentVersion && <details className="group rounded-lg border border-ink-700 bg-ink-900/40" open={!configured || undefined}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-12 [&::-webkit-details-marker]:hidden">
        <ChevronDown size={14} aria-hidden="true" className="shrink-0 -rotate-90 group-open:rotate-0" />
        <span className="font-medium text-ink-200">官方组件</span>
        <span className="text-ink-400">{selected.componentVersion} · {configured ? '已配置' : '待安装'}</span>
      </summary>
      <div className="flex flex-wrap gap-2 border-t border-ink-700 px-3 py-2.5">
        <Button size="sm" variant="secondary" disabled={controlsDisabled}
          onClick={() => api && void run('正在安装并校验官方组件…', id => api.install(id), 'Antigravity 组件已校验并保存')}>从 Google 安装组件</Button>
        <Button size="sm" variant="secondary" disabled={controlsDisabled}
          onClick={() => api && void run('正在选择官方组件…', id => api.selectBinary(id))}>选择已有官方组件</Button>
      </div>
    </details>}
    {selected?.available && configured && <section aria-labelledby="acp-connection-heading" className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 id="acp-connection-heading" className="text-12 font-medium text-ink-200">账号与连接</h3>
        <span className="inline-flex items-center gap-1.5 text-12 text-ink-400">
          <span aria-hidden="true" className={`size-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-ink-500'}`} />
          {connectionLabel}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!connected && <Button size="sm" variant="primary" disabled={controlsDisabled} onClick={() => api && void run('等待 Google 登录，首次启动约需 20–30 秒…', id => api.connect(id, true))}>登录 Google 账号</Button>}
        <Button size="sm" variant="secondary" disabled={controlsDisabled} onClick={() => api && void run('正在连接并读取模型选项…', id => api.connect(id, false))}>{connected ? '刷新模型选项' : '连接已有会话'}</Button>
        {status.options && <Button size="sm" variant="secondary" disabled={controlsDisabled} onClick={() => api && void run('正在停用连接…', id => api.disconnect(id))}>停用连接</Button>}
        <details className="group">
          <summary className="cursor-pointer list-none rounded-md px-2 py-1.5 text-12 text-ink-300 hover:bg-ink-800 [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-1">账号操作 <ChevronDown size={13} aria-hidden="true" className="group-open:rotate-180" /></span>
          </summary>
          <div className="mt-1 flex flex-wrap gap-2">
            {connected && <Button size="sm" variant="secondary" disabled={controlsDisabled} onClick={() => api && void run('等待 Google 登录，首次启动约需 20–30 秒…', id => api.connect(id, true))}>重新登录 Google</Button>}
            <Button size="sm" variant="secondary" disabled={controlsDisabled} onClick={() => api && void run('正在退出 ACP 账号…', id => api.logout(id), 'ACP 账号已退出')}>退出 ACP 账号</Button>
          </div>
        </details>
      </div>
      {optionKeys.length > 0 && <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3 border-t border-ink-700 pt-3">
      {optionKeys.map(key => {
        const option = status.options?.[key]
        if (!option) return null
        const current = status.config?.[key] ?? ''
        const missing = current && !option.values.some(item => item.value === current)
        return <label key={key} className="grid min-w-0 gap-1 text-12 font-medium text-ink-200">
          {key === 'model' ? '模型' : '推理档位'}
          <select className={selectClass} value={current}
            disabled={controlsDisabled}
            onChange={event => {
              const value = event.target.value
              if (api) void run('正在保存模型选项…', id => api.configure(id, { key, value }))
            }}>
            <option value="">使用 Agent 默认设置</option>
            {missing && <option value={current} disabled>已保存的选项不可用</option>}
            {option.values.map(item => <option key={item.value} value={item.value}>{item.name}</option>)}
          </select>
        </label>
      })}
      </div>}
    </section>}
    {selected && !selected.available && <p className="text-12 text-ink-500">当前构建尚未启用此 Agent 的连接功能。需要使用引擎模型时，请切回 API 模式。</p>}
  </div>
}
