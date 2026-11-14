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
  /** 运行方式：默认当前 Windows 用户；隔离需作者主动选择并开通。 */
  runAs?: 'current-user' | 'isolated' | null
  isolation?: 'required' | 'configured' | null
}

interface AcpDesktopSettings {
  status(): Promise<AcpSettingsStatus | null>
  select(id: string): Promise<{ ok: boolean; error?: string }>
  install(id: string): Promise<{ ok: boolean; error?: string }>
  setupIsolation(id: string): Promise<{ ok: boolean; error?: string }>
  selectBinary(id: string): Promise<{ ok: boolean; error?: string }>
  connect(id: string, login: boolean): Promise<{ ok: boolean; error?: string }>
  disconnect(id: string): Promise<{ ok: boolean; error?: string }>
  logout(id: string): Promise<{ ok: boolean; error?: string }>
  configure(id: string, patch: { key: 'model' | 'thinking' | 'runAs'; value: string }): Promise<{ ok: boolean; error?: string }>
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

  async function setRunAs(next: 'current-user' | 'isolated') {
    if (!api || !selected || controlsDisabled || runAs === next) return
    await run(
      next === 'isolated' ? '正在切换到 Windows 隔离…' : '正在切换到当前 Windows 用户…',
      id => api.configure(id, { key: 'runAs', value: next }),
      next === 'isolated' ? '已切换到 Windows 隔离，请在隔离环境中登录 Google' : '已切换到当前 Windows 用户',
    )
  }

  if (error) return <p className="text-12 text-amber">{error}</p>
  if (!status) return <p className="text-12 text-ink-500">正在读取 ACP 设置…</p>
  const selected = status.adapters.find(adapter => adapter.id === status.selected)
  const configured = !!status.config?.binary
  const connected = !!status.ready
  const controlsDisabled = disabled || busy || !!operation
  // 未设置一律按当前 Windows 用户 —— 与运行时 `runAsOf` 同口径，界面不能自己另立默认值。
  const runAs: 'current-user' | 'isolated' = status.runAs === 'isolated' ? 'isolated' : 'current-user'
  /** 选了隔离但专用账户还没开通：连接按钮要挡住，并就地给出开通入口。 */
  const isolationBlocked = runAs === 'isolated' && status.isolation === 'required'
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
    {/* 🔴 2026-11-14 R4：运行方式可选。R3 强制隔离，未开通专用账户就看不到下面的「账号与连接」，
        等于把「先能用起来」堵死了；现在默认当前 Windows 用户，隔离是作者主动选择的一项能力。 */}
    {selected?.available && <section aria-labelledby="acp-runas-heading" className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
      <h3 id="acp-runas-heading" className="text-12 font-medium text-ink-200">运行方式</h3>
      <p className="mt-1 text-11 leading-relaxed text-ink-500">
        切换会先停掉当前 ACP 任务并重建进程；两种方式各自使用自己的登录资料，互不覆盖、互不清理。
      </p>
      <div className="mt-2 space-y-2">
        <label className="flex items-start gap-2 text-12">
          <input type="radio" name="acp-runas" className="mt-0.5" checked={runAs === 'current-user'} disabled={controlsDisabled}
            onChange={() => void setRunAs('current-user')} />
          <span className="min-w-0">
            <span className={runAs === 'current-user' ? 'text-ink-100' : 'text-ink-300'}>以当前 Windows 用户运行</span>
            <span className="block text-11 leading-relaxed text-ink-500">
              不需要创建账户或管理员批准，直接复用已有登录。Agent 及其子进程拥有当前 Windows 用户的文件权限，只连可信的 Agent。
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-12">
          <input type="radio" name="acp-runas" className="mt-0.5" checked={runAs === 'isolated'} disabled={controlsDisabled}
            onChange={() => void setRunAs('isolated')} />
          <span className="min-w-0">
            <span className={runAs === 'isolated' ? 'text-ink-100' : 'text-ink-300'}>使用 Windows 隔离</span>
            <span className="block text-11 leading-relaxed text-ink-500">
              在专用标准账户中运行，需要一次性管理员批准创建账户，并在隔离环境中单独登录 Google。
            </span>
          </span>
        </label>
      </div>
      {isolationBlocked && (
        <div className="mt-2 rounded border border-ink-700 bg-ink-900/60 p-2">
          <p className="text-11 leading-relaxed text-ink-400">还差一步：开通专用标准账户后才能用隔离方式连接。Windows 会请求管理员批准。</p>
          <Button size="sm" variant="primary" className="mt-1.5" disabled={controlsDisabled}
            onClick={() => api && void run('等待 Windows 管理员确认…', id => api.setupIsolation(id), 'Windows ACP 隔离已开通')}>开通 Windows 隔离</Button>
        </div>
      )}
    </section>}
    {selected?.available && configured && <section aria-labelledby="acp-connection-heading" className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 id="acp-connection-heading" className="text-12 font-medium text-ink-200">账号与连接</h3>
        <span className="inline-flex items-center gap-1.5 text-12 text-ink-400">
          <span aria-hidden="true" className={`size-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-ink-500'}`} />
          {connectionLabel}
        </span>
      </div>
      {/* 🔴 3.5.5：作者最容易困惑的一点 —— 明明昨天能用，今天开机却是「等待验证会话」。
          会话状态是进程内的（`runtime.sessionReady`），不跨进程保存；Google 登录态才是持久化的。
          不写明这一点，作者会以为 ACP 坏了，然后跑去切 API 模式（而那个选择又会掩盖真问题）。 */}
      {!connected && (
        <p className="mt-1.5 text-11 leading-relaxed text-ink-500">
          会话状态不跨进程保存：<span className="text-ink-300">每次重启应用后都要点一次「连接已有会话」</span>
          （Google 登录态会保留，不用重新登录）。没连接时各 AI 功能会直接提示你先连接，不会悄悄改走 API 模式。
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!connected && <Button size="sm" variant="primary" disabled={controlsDisabled || isolationBlocked}
          title={isolationBlocked ? '请先开通 Windows 隔离' : undefined}
          onClick={() => api && void run('等待 Google 登录，首次启动约需 20–30 秒…', id => api.connect(id, true))}>登录 Google 账号</Button>}
        <Button size="sm" variant="secondary" disabled={controlsDisabled || isolationBlocked}
          title={isolationBlocked ? '请先开通 Windows 隔离' : undefined}
          onClick={() => api && void run('正在连接并读取模型选项…', id => api.connect(id, false))}>{connected ? '刷新模型选项' : '连接已有会话'}</Button>
        {status.options && <Button size="sm" variant="secondary" disabled={controlsDisabled} onClick={() => api && void run('正在停用连接…', id => api.disconnect(id))}>停用连接</Button>}
        {connected && <Button size="sm" variant="secondary" disabled={controlsDisabled} onClick={() => api && void run('等待 Google 登录，首次启动约需 20–30 秒…', id => api.connect(id, true))}>重新登录 Google</Button>}
        <Button size="sm" variant="secondary" disabled={controlsDisabled} onClick={() => api && void run('正在退出 ACP 账号…', id => api.logout(id), 'ACP 账号已退出')}>退出 ACP 账号</Button>
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
