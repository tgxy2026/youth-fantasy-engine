import { useEffect, useState } from 'react'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { Button } from '@/components/common/Button'
import { ChevronDown } from 'lucide-react'
import { grantAcpConsent, revokeAcpConsent } from '@/lib/agentHost/acpConsent'

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
      // 换 Agent 就是换了接收方，旧的一次性授权不能顺延。
      revokeAcpConsent()
      setStatus(await api.status())
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'ACP Agent 切换失败。', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function run(
    label: string,
    action: (id: string) => Promise<{ ok: boolean; error?: string }>,
    success?: string,
    /** 成功并刷新状态后执行（用来做「连上之后提示一次」这类收尾） */
    after?: (next: AcpSettingsStatus) => Promise<void>,
  ) {
    if (!api || operation || disabled || busy) return
    const id = crypto.randomUUID()
    setOperation({ id, label })
    try {
      const result = await action(id)
      if (!result.ok) throw new Error(result.error || 'ACP 操作失败。')
      const next = await api.status()
      setStatus(next)
      if (success) showToast(success, 'success')
      if (next && after) await after(next)
    } catch (error) {
      setStatus(await api.status().catch(() => null))
      showToast(error instanceof Error ? error.message : 'ACP 操作失败。', 'error')
    } finally {
      setOperation(null)
    }
  }

  /**
   * 连接（登录或重连）。
   *
   * 🔴 2026-11-14 主人要求：外发确认从「每调一次弹一次」改成「连接成功后提示一次」。
   *    这里连上之后主动说明一次「资料会发给谁」，并把该 Agent 记进一次性账本；
   *    之后同进程内所有 AI 功能不再逐次弹（闸门读同一个账本）。
   */
  async function connectFlow(login: boolean) {
    if (!api) return
    await run(
      login ? '等待 Google 登录，首次启动约需 20–30 秒…' : '正在连接并读取模型选项…',
      id => api.connect(id, login),
      undefined,
      async next => {
        if (!next.ready) return
        const name = next.adapters.find(a => a.id === next.selected)?.name ?? 'ACP Agent'
        grantAcpConsent(name)
        await confirmDialog({
          title: `已连接 ${name}`,
          message: `接下来使用 AI 功能时，引擎会把当前功能需要的正文、草稿与设定资料发送给 ${name}，由它转交给该 Agent 登录的账号。\n\n不同功能读取的范围不同，界面上的「本次会读」会逐项列出。\n\n本提示每次连接只出现一次；重启应用、停用连接或更换 Agent 会重新提示。随时可以点「停用连接」或切回 API 模式。`,
          confirmText: '知道了',
        })
      },
    )
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

  /** 模型/档位的显示名（会话没连时退回保存值或「Agent 默认」）。 */
  const labelOf = (key: 'model' | 'thinking') => {
    const current = status.config?.[key] ?? ''
    if (!current) return 'Agent 默认'
    return status.options?.[key]?.values.find(v => v.value === current)?.name ?? current
  }

  // 🔴 2026-11-14：试过「右窄状态卡」与「居中限宽」，都被否掉。最终：**铺满父容器、不留左右留白**；
  //    「运行方式」两项并排、模型/档位两列撑开，避免宽屏显空。
  //    状态条放在**最底部**（主人的口径：它表达的是「连接状态」，属于结果，不该压在最上面）。
  return <div className="space-y-3" data-acp-settings>
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <label className="grid w-72 max-w-full gap-1 text-12 font-medium text-ink-200">
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
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <label className={`flex items-start gap-2 rounded-lg border p-2.5 text-12 transition-colors ${
          runAs === 'current-user' ? 'border-amber/40 bg-ink-800/60' : 'border-ink-700 bg-ink-900/40 hover:border-ink-600'
        }`}>
          <input type="radio" name="acp-runas" className="mt-0.5 shrink-0" checked={runAs === 'current-user'} disabled={controlsDisabled}
            onChange={() => void setRunAs('current-user')} />
          <span className="min-w-0">
            <span className={runAs === 'current-user' ? 'text-ink-100' : 'text-ink-300'}>以当前 Windows 用户运行</span>
            <span className="mt-0.5 block text-11 leading-relaxed text-ink-500">
              不需要创建账户或管理员批准，直接复用已有登录。Agent 及其子进程拥有当前用户的文件权限，只连可信的 Agent。
            </span>
          </span>
        </label>
        <label className={`flex items-start gap-2 rounded-lg border p-2.5 text-12 transition-colors ${
          runAs === 'isolated' ? 'border-amber/40 bg-ink-800/60' : 'border-ink-700 bg-ink-900/40 hover:border-ink-600'
        }`}>
          <input type="radio" name="acp-runas" className="mt-0.5 shrink-0" checked={runAs === 'isolated'} disabled={controlsDisabled}
            onChange={() => void setRunAs('isolated')} />
          <span className="min-w-0">
            <span className={runAs === 'isolated' ? 'text-ink-100' : 'text-ink-300'}>使用 Windows 隔离</span>
            <span className="mt-0.5 block text-11 leading-relaxed text-ink-500">
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
          onClick={() => void connectFlow(true)}>登录 Google 账号</Button>}
        <Button size="sm" variant="secondary" disabled={controlsDisabled || isolationBlocked}
          title={isolationBlocked ? '请先开通 Windows 隔离' : undefined}
          onClick={() => void connectFlow(false)}>{connected ? '刷新模型选项' : '连接已有会话'}</Button>
        {status.options && <Button size="sm" variant="secondary" disabled={controlsDisabled}
          onClick={() => api && void run('正在停用连接…', id => api.disconnect(id)).then(() => revokeAcpConsent())}>停用连接</Button>}
        {connected && <Button size="sm" variant="secondary" disabled={controlsDisabled} onClick={() => void connectFlow(true)}>重新登录 Google</Button>}
        <Button size="sm" variant="secondary" disabled={controlsDisabled}
          onClick={() => api && void run('正在退出 ACP 账号…', id => api.logout(id), 'ACP 账号已退出').then(() => revokeAcpConsent())}>退出 ACP 账号</Button>
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
    <section aria-labelledby="acp-summary-heading" className="rounded-lg border border-ink-700 bg-ink-900/40">
      <h3 id="acp-summary-heading" className="sr-only">ACP 连接概览</h3>
      <dl className="grid grid-cols-2 divide-ink-700 sm:grid-cols-4 sm:divide-x">
        <div className="px-3 py-2.5">
          <dt className="text-11 text-ink-500">连接</dt>
          <dd className={`mt-0.5 flex items-center gap-1.5 text-12 ${connected ? 'text-emerald-400' : 'text-ink-300'}`}>
            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${connected ? 'bg-emerald-400' : 'bg-ink-500'}`} />
            <span className="truncate">{connectionLabel}</span>
          </dd>
        </div>
        <div className="px-3 py-2.5">
          <dt className="text-11 text-ink-500">接收方</dt>
          <dd className="mt-0.5 truncate text-12 text-ink-200" title={selected?.name}>
            {selected?.name ?? '—'}{selected?.componentVersion ? ` · ${selected.componentVersion}` : ''}
          </dd>
        </div>
        <div className="px-3 py-2.5">
          <dt className="text-11 text-ink-500">运行方式</dt>
          <dd className="mt-0.5 truncate text-12 text-ink-200">{runAs === 'isolated' ? 'Windows 隔离' : '当前 Windows 用户'}</dd>
        </div>
        <div className="px-3 py-2.5">
          <dt className="text-11 text-ink-500">{optionKeys.includes('thinking') ? '模型 / 档位' : '模型'}</dt>
          <dd className="mt-0.5 truncate text-12 text-ink-200" title={`${labelOf('model')}${optionKeys.includes('thinking') ? ` · ${labelOf('thinking')}` : ''}`}>
            {labelOf('model')}{optionKeys.includes('thinking') ? ` · ${labelOf('thinking')}` : ''}
          </dd>
        </div>
      </dl>
      <p className="border-t border-ink-700 px-3 py-2 text-11 leading-relaxed text-ink-500">
        连接成功时提示一次「资料会发给谁」，之后不再逐次打扰；各功能读取范围见该功能的「本次会读」。
        {runAs === 'isolated' ? '隔离方式下 Agent 只能访问专用账户授权的目录。' : '当前用户方式下 Agent 及其子进程拥有你的文件权限，只连可信的 Agent。'}
      </p>
    </section>
  </div>
}
