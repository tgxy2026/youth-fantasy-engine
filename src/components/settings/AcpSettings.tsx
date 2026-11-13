import { useEffect, useState } from 'react'
import { showToast } from '@/components/dialogs/dialogs'
import { Button } from '@/components/common/Button'

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
  const [installId, setInstallId] = useState<string | null>(null)
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
    if (!api || busy || disabled) return
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

  async function run(action: (id: string) => Promise<{ ok: boolean; error?: string }>, success?: string) {
    if (!api || installId || disabled || busy) return
    const id = crypto.randomUUID()
    setInstallId(id)
    try {
      const result = await action(id)
      if (!result.ok) throw new Error(result.error || 'ACP 操作失败。')
      setStatus(await api.status())
      if (success) showToast(success, 'success')
    } catch (error) {
      setStatus(await api.status().catch(() => null))
      showToast(error instanceof Error ? error.message : 'ACP 操作失败。', 'error')
    } finally {
      setInstallId(null)
    }
  }

  if (error) return <p className="text-12 text-amber">{error}</p>
  if (!status) return <p className="text-12 text-ink-500">正在读取 ACP 设置…</p>
  const selected = status.adapters.find(adapter => adapter.id === status.selected)
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2 text-12 text-ink-300">
      <label htmlFor="acp-agent-select">ACP Agent</label>
      <select
        id="acp-agent-select"
        className="rounded border border-ink-700 bg-ink-900 px-2 py-1"
        value={selected?.id ?? ''}
        disabled={disabled || busy || !!installId}
        onChange={event => void select(event.target.value)}
      >
        {!selected && <option value="" disabled>请选择 ACP Agent</option>}
        {status.adapters.map(adapter => <option key={adapter.id} value={adapter.id}>{adapter.name}</option>)}
      </select>
      {installId && <Button size="sm" variant="secondary" onClick={() => void api?.cancel(installId)}>取消 ACP 操作</Button>}
      {installId && <span className="text-ink-500">正在等待 ACP 组件响应，首次启动约需 20–30 秒…</span>}
    </div>
    {busy && <p className="text-12 text-ink-500">正在等待当前 ACP 任务结束…</p>}
    {selected?.componentVersion && <div className="flex items-center gap-2 text-12 text-ink-500">
      <span>官方组件 {selected.componentVersion}{status.config?.binary ? ' · 已配置' : ''}</span>
      <Button size="sm" variant="secondary" disabled={disabled || busy || !!installId}
        onClick={() => api && void run(id => api.install(id), 'Antigravity 组件已校验并保存')}>
        从 Google 安装组件
      </Button>
      <Button size="sm" variant="secondary" disabled={disabled || busy || !!installId}
        onClick={() => api && void run(id => api.selectBinary(id))}>选择已有官方组件</Button>
    </div>}
    {selected?.available && status.config?.binary && <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" disabled={disabled || busy || !!installId} onClick={() => api && void run(id => api.connect(id, false))}>连接并刷新选项</Button>
        <Button size="sm" variant="secondary" disabled={disabled || busy || !!installId} onClick={() => api && void run(id => api.connect(id, true))}>登录 Google 账号</Button>
        {status.options && <Button size="sm" variant="secondary" disabled={disabled || busy || !!installId} onClick={() => api && void run(id => api.disconnect(id))}>停用连接</Button>}
        <Button size="sm" variant="secondary" disabled={disabled || busy || !!installId} onClick={() => api && void run(id => api.logout(id), 'ACP 账号已退出')}>退出 ACP 账号</Button>
        <span className="text-12 text-ink-500">{status.ready ? '会话已验证' : status.options ? '请核对已保存的模型选项' : '等待验证会话'}</span>
      </div>
      {(['model', 'thinking'] as const).map(key => {
        const option = status.options?.[key]
        if (!option) return null
        const current = status.config?.[key] ?? ''
        const missing = current && !option.values.some(item => item.value === current)
        return <label key={key} className="block text-12 text-ink-300">
          {key === 'model' ? '模型' : '推理档位'}
          <select className="ml-2 rounded border border-ink-700 bg-ink-900 px-2 py-1" value={current}
            disabled={disabled || busy || !!installId}
            onChange={event => {
              const value = event.target.value
              if (api) void run(id => api.configure(id, { key, value }))
            }}>
            <option value="">使用 Agent 默认设置</option>
            {missing && <option value={current} disabled>已保存的选项不可用</option>}
            {option.values.map(item => <option key={item.value} value={item.value}>{item.name}</option>)}
          </select>
        </label>
      })}
    </div>}
    {selected && !selected.available && <p className="text-12 text-ink-500">组件连接等待验证。</p>}
  </div>
}
