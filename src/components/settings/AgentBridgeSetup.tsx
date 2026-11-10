import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/common/Button'
import EmphasisText from '@/components/common/EmphasisText'
import { copyText, showToast } from '@/components/dialogs/dialogs'
import { DESKTOP, agentBridgeDataPath, agentBridgeScriptPath } from '@/lib/app/desktop'
import { PORTABLE } from '@/lib/storage/fileBackend'
import { makeAgentBridgeConfig, makeAgentConnectionPrompt, makeCodexAgentBridgeConfig, makeBridgeConfig, type BridgeDataSource } from '@/lib/aiCore/backend/bridgeConfig'
import * as db from '@/lib/db'
import type { Project } from '@/lib/types'
import {
  AGENT_ACTION_LABELS, AGENT_ACTIONS, normalizeAgentScope,
  type AgentAction, type AgentScope,
} from '@/lib/agentHost/contract'
import {
  agentHostStatus, agentWriteBridgeScriptPath, updateAgentHostConfig,
  type AgentHostStatus,
} from '@/lib/agentHost/host'
import { AGENT_TASKS_KEY, type AgentTaskRecord } from '@/lib/agentHost/taskOps'

const field = 'mt-1 w-full rounded border border-ink-700 bg-ink-900 px-2 py-1 text-12 text-ink-200'
const labelCls = 'block text-11 text-ink-400'

/** 授权动作按用途分组：21 项平铺难以扫描，分组后每组不超过 6 项。 */
const ACTION_GROUPS: { label: string; actions: AgentAction[] }[] = [
  { label: '设定与表格', actions: ['setting:create', 'setting:write', 'form:write', 'table:create', 'table:write'] },
  { label: '分卷与章节', actions: ['volume:create', 'volume:write', 'chapter:create', 'chapter:write', 'chapter:delete', 'chapter:restore'] },
  { label: '灵感与地图', actions: ['inspiration:write', 'map:create', 'map:write', 'map:delete', 'canvas:write'] },
  { label: '世界包与备份', actions: ['world:read', 'world:write', 'backup:restore'] },
  { label: '检查与任务', actions: ['report:write', 'task:write'] },
]

export default function AgentBridgeSetup() {
  const [node, setNode] = useState('node')
  const [script, setScript] = useState('')
  const [kind, setKind] = useState<BridgeDataSource['kind']>('desktop')
  const [target, setTarget] = useState('')
  const [config, setConfig] = useState('')
  const [desktopData, setDesktopData] = useState('')
  const [loadingPaths, setLoadingPaths] = useState(true)
  useEffect(() => {
    let active = true
    void Promise.all([agentBridgeScriptPath(), agentBridgeDataPath()]).then(([scriptPath, dataPath]) => {
      if (!active) return
      if (scriptPath) setScript(previous => previous || scriptPath)
      setDesktopData(dataPath)
      setLoadingPaths(false)
    })
    return () => { active = false }
  }, [])
  function generate() {
    try {
      if (kind === 'desktop' && DESKTOP && !desktopData) throw new Error('无法取得桌面数据路径，请选择指定数据文件')
      const source: BridgeDataSource = kind === 'desktop' ? { kind, ...(desktopData ? { dataFile: desktopData } : {}) } : kind === 'portable' ? { kind, root: target } : { kind, path: target }
      setConfig(makeBridgeConfig(node, script, source))
    } catch (error) {
      setConfig('')
      showToast(error instanceof Error ? error.message : '无法生成配置', 'error')
    }
  }
  async function copy() {
    await copyText(config, '配置已复制')
  }
  return <div className="mt-2 text-12 text-ink-300">
    <WriteConnection node={node} onNodeChange={setNode} />
    <details className="mt-4 border-t border-ink-700 pt-3">
    <summary className="cursor-pointer text-12 text-ink-200">只读桥配置（可选）</summary>
    <div className="mt-2 space-y-2">
      <p className="text-11 text-ink-500"><EmphasisText text="在你的 Agent 客户端的 **MCP 服务配置（mcpServers）**中找到配置文件，将下方条目**合并**进去。桥可读取本机所有项目中的允许字段，**请只连接可信客户端**。读取的是**已保存到磁盘**的数据，请先在引擎中保存。配置前请先安装 Node.js。" /></p>
      <label className="block">Node.js 命令或完整路径<input className={field} value={node} onChange={e => { setNode(e.target.value); setConfig('') }} /></label>
      <label className="block">只读桥脚本完整路径<input className={field} value={script} onChange={e => { setScript(e.target.value); setConfig('') }} placeholder="…/scripts/mcp/yfe-readonly.mjs" /></label>
      <label className="block">数据位置<select className={field} value={kind} onChange={e => { setKind(e.target.value as BridgeDataSource['kind']); setTarget(''); setConfig('') }}>
        <option value="desktop">桌面版默认或自定义数据位置</option><option value="portable">便携版根目录</option><option value="file">指定数据文件</option>
      </select></label>
      {kind !== 'desktop' && <label className="block">{kind === 'portable' ? '便携版根目录' : '数据文件完整路径'}<input className={field} value={target} onChange={e => { setTarget(e.target.value); setConfig('') }} /></label>}
      {kind === 'desktop' && DESKTOP && !loadingPaths && !desktopData && <p className="text-11 text-amber">无法取得桌面数据路径，请选择「指定数据文件」。</p>}
      <Button variant="secondary" onClick={generate} disabled={loadingPaths}>生成配置</Button>
      {config && <><textarea aria-label="只读桥连接配置" className={`${field} min-h-32 font-mono`} value={config} readOnly /><Button variant="secondary" onClick={() => void copy()}>复制配置</Button><p className="text-11 text-ink-500">若已有其他 MCP 服务，只将 yfe-readonly 条目合并进已有的 mcpServers，避免覆盖原配置。</p></>}
    </div>
    </details>
  </div>
}

/** 可写连接：开关 + 项目 / 动作授权 + 配置生成（3.4.3） */
function WriteConnection({ node, onNodeChange }: { node: string; onNodeChange(value: string): void }) {
  const [status, setStatus] = useState<AgentHostStatus | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [scope, setScope] = useState<AgentScope>({ projects: [] })
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [writeScript, setWriteScript] = useState('')
  const [portableRoot, setPortableRoot] = useState('')
  const [writeConfig, setWriteConfig] = useState('')
  const [clientFormat, setClientFormat] = useState<'json' | 'codex'>('json')
  const [tasks, setTasks] = useState<AgentTaskRecord[]>([])
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(() => db.getCurrentProjectId())
  // 轮询会用宿主真源覆盖表单；用户正在改（dirty）或正在保存（busy）时不得覆盖，
  // 否则程序化改配置 / 保存失败后，界面会悄悄丢掉用户刚勾的授权。
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)

  useEffect(() => {
    let active = true
    void Promise.all([agentHostStatus(), db.getAllProjects(), agentWriteBridgeScriptPath()]).then(([st, list, script]) => {
      if (!active) return
      setStatus(st)
      setProjects(list)
      if (!dirtyRef.current) {
        setScope(normalizeAgentScope(st.scope))
        setEnabled(st.enabled)
      }
      if (script) setWriteScript(script)
    }).catch(() => { /* 状态读取失败由轮询展示，不阻塞设置页 */ })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    const loadTasks = () => {
      void db.getSetting<{ tasks?: AgentTaskRecord[] }>(AGENT_TASKS_KEY, { tasks: [] }).then(state => {
        if (active) setTasks((state.tasks ?? []).slice(0, 10))
      }).catch(() => undefined)
    }
    loadTasks()
    const timer = setInterval(() => {
      setCurrentProjectId(db.getCurrentProjectId())
      void agentHostStatus().then(st => {
        setStatus(st)
        if (!dirtyRef.current && !busyRef.current) {
          setScope(normalizeAgentScope(st.scope))
          setEnabled(st.enabled)
        }
      }).catch(() => undefined)
      loadTasks()
    }, 4000)
    return () => { active = false; clearInterval(timer) }
  }, [])

  const actionsOf = (projectId: string): AgentAction[] => scope.projects.find(p => p.projectId === projectId)?.actions ?? []
  /** 只改目标项目的授权条目；其它项目的既有授权原样保留（授权按项目隔离，数据不互相清除）。 */
  function applyActions(projectId: string, nextActions: AgentAction[]) {
    dirtyRef.current = true
    setDirty(true)
    const rest = scope.projects.filter(p => p.projectId !== projectId)
    setScope(normalizeAgentScope({ projects: nextActions.length ? [...rest, { projectId, actions: nextActions }] : rest }))
  }
  function toggle(projectId: string, action: AgentAction) {
    const current = actionsOf(projectId)
    applyActions(projectId, current.includes(action) ? current.filter(a => a !== action) : [...current, action])
  }
  function toggleAll(projectId: string) {
    const current = actionsOf(projectId)
    applyActions(projectId, current.length === AGENT_ACTIONS.length ? [] : [...AGENT_ACTIONS])
  }
  function toggleGroup(projectId: string, actions: AgentAction[]) {
    const current = actionsOf(projectId)
    const allOn = actions.every(a => current.includes(a))
    applyActions(projectId, allOn ? current.filter(a => !actions.includes(a)) : [...new Set([...current, ...actions])])
  }
  async function save() {
    busyRef.current = true
    setBusy(true)
    try {
      const result = await updateAgentHostConfig({ enabled, scope })
      if (!result.ok) { showToast(result.error ?? '保存失败', 'error'); return }
      // 以宿主回传的真源为准（宿主可能规范化过 scope），保存成功后解除 dirty。
      const next = result.status
      if (next) {
        setStatus(next)
        setScope(normalizeAgentScope(next.scope))
        setEnabled(next.enabled)
      }
      dirtyRef.current = false
      setDirty(false)
      showToast('Agent 连接设置已保存', 'success')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  function generateWriteConfig() {
    try {
      const hostFile = status?.bridgeFile ?? ''
      const source = PORTABLE ? { kind: 'portable' as const, root: portableRoot } : { kind: 'hostFile' as const, path: hostFile }
      setWriteConfig(clientFormat === 'codex' ? makeCodexAgentBridgeConfig(node, writeScript, source) : makeAgentBridgeConfig(node, writeScript, source))
    } catch (error) {
      setWriteConfig('')
      showToast(error instanceof Error ? error.message : '无法生成配置', 'error')
    }
  }
  async function copyWrite() {
    await copyText(writeConfig, '配置已复制')
  }

  const source = PORTABLE ? { kind: 'portable' as const, root: portableRoot } : { kind: 'hostFile' as const, path: status?.bridgeFile ?? '' }
  let connectionPrompt = ''
  try { connectionPrompt = makeAgentConnectionPrompt(node, writeScript, source) } catch { /* 路径尚未就绪 */ }
  async function copyPrompt() {
    await copyText(connectionPrompt, '连接提示词已复制')
  }

  const unavailable = status?.mode === 'web'
  const currentProject = projects.find(p => p.id === currentProjectId) ?? null
  return <details open className="mt-2">
    <summary className="cursor-pointer text-13 font-medium text-ink-100">Agent 写入连接 <span className="ml-1 text-11 font-normal text-ink-500">可创建章节、设定与正文</span></summary>
    <div className="mt-2.5 space-y-4">
      <p className="max-w-3xl text-11 text-ink-400 leading-relaxed">
        <EmphasisText text="开启后，外部 Agent 可通过 MCP 工具直接创建设定卡、创建章节、追加 / 覆盖正文。写入会进入**正在运行的引擎**（沿用它的保存、快照与索引），**不会直接改数据文件**。默认只读；只有在这里**勾选的项目与动作**才会被接受。**请只连接可信客户端**。" />
      </p>
      {unavailable && <p className="text-11 text-amber">网页版没有本机宿主进程，无法使用 Agent 写入连接。</p>}
      {!unavailable && status?.connectionMode?.phase === 'stable' && status.connectionMode.mode !== 'agent' && (
        <p className="text-11 text-amber">当前为 API 调用模式：开启 Agent 连接会被拒绝。请先在页签切换到「Agent 模式」。</p>
      )}
      {!unavailable && status && !status.running && <p className="text-11 text-amber">{status.lastError || 'Agent 宿主尚未运行，请确认引擎已启动并稍候重试。'}</p>}
      {!unavailable && <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
          <p className="text-11 text-ink-500">写入连接</p>
          <p className={`mt-0.5 text-12 ${enabled ? 'text-amber' : 'text-ink-200'}`}>{enabled ? '已开启' : '未开启'}</p>
        </div>
        <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
          <p className="text-11 text-ink-500">宿主</p>
          <p className={`mt-0.5 text-12 ${status ? (status.running ? 'text-emerald-400' : 'text-amber') : 'text-ink-400'}`}>{status ? (status.running ? '运行中' : '未运行') : '读取中…'}</p>
        </div>
        <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
          <p className="text-11 text-ink-500">已连接页面</p>
          <p className="mt-0.5 text-12 text-ink-200">{status?.clients ?? '—'}</p>
        </div>
      </div>}
      <label className="flex items-start justify-between gap-3 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2.5">
        <span>
          <span className="block text-12 text-ink-100">开启 Agent 写入连接</span>
          <span className="mt-0.5 block text-11 text-ink-500">关闭后此连接不可用；如需只读访问，可另行配置只读桥。</span>
        </span>
        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={enabled} onChange={e => { dirtyRef.current = true; setDirty(true); setEnabled(e.target.checked) }} />
      </label>
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-12 text-ink-100">授权项目与动作</p>
          <span className="text-11 text-ink-500">未勾选 = 只读</span>
        </div>
        <p className="text-11 text-ink-500"><EmphasisText text="授权**按项目隔离**：这里只显示**当前打开项目**的授权；其它项目的既有授权**保留不变**，切回对应项目后可见。" /></p>
        {projects.length === 0 && <p className="rounded-lg border border-dashed border-ink-700 px-3 py-3 text-11 text-ink-500">还没有项目。请先在引擎中新建 / 打开一个项目。</p>}
        {projects.length > 0 && !currentProject && <p className="rounded-lg border border-dashed border-ink-700 px-3 py-3 text-11 text-ink-500">当前没有打开的项目。请先在引擎中打开一个项目，再为它设置授权。</p>}
        {currentProject && (() => {
          const project = currentProject
          const granted = actionsOf(project.id)
          const allOn = granted.length === AGENT_ACTIONS.length
          return <div className="rounded-lg border border-ink-700 bg-ink-900/30">
            <div className="flex items-center justify-between gap-3 border-b border-ink-700/70 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-12 text-ink-100">{project.name}<span className="ml-1.5 text-11 font-normal text-ink-500">当前项目</span></p>
                <p className="mt-0.5 text-11 text-ink-500">{granted.length ? `已授权 ${granted.length} / ${AGENT_ACTIONS.length} 项` : '未授权 · 只读'}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <label className="flex items-center gap-1.5 text-11 text-ink-300">
                  <input type="checkbox" checked={allOn} ref={el => { if (el) el.indeterminate = granted.length > 0 && !allOn }} onChange={() => toggleAll(project.id)} />
                  全选以下所有内容
                </label>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-11 ${granted.length ? 'bg-amber/10 text-amber' : 'bg-ink-800 text-ink-400'}`}>{granted.length ? '可写入' : '只读'}</span>
              </div>
            </div>
            <div className="space-y-2.5 px-3 py-2.5">
              {ACTION_GROUPS.map(group => {
                const groupOn = group.actions.every(a => granted.includes(a))
                const groupPartial = !groupOn && group.actions.some(a => granted.includes(a))
                return <div key={group.label}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-11 text-ink-500">{group.label}</p>
                    <label className="flex items-center gap-1.5 text-11 text-ink-400">
                      <input type="checkbox" checked={groupOn} ref={el => { if (el) el.indeterminate = groupPartial }} onChange={() => toggleGroup(project.id, group.actions)} />
                      全选本组
                    </label>
                  </div>
                  <div className="mt-1 grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
                    {group.actions.map(action => {
                      const on = granted.includes(action)
                      return <label key={action} className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-11 leading-snug ${on ? 'bg-amber/10 text-amber' : 'text-ink-300 hover:bg-ink-800/60'}`}>
                        <input type="checkbox" checked={on} onChange={() => toggle(project.id, action)} />
                        {AGENT_ACTION_LABELS[action]}
                      </label>
                    })}
                  </div>
                </div>
              })}
            </div>
          </div>
        })()}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
          <Button size="sm" variant="secondary" onClick={() => void save()} disabled={busy || !dirty}>保存授权</Button>
          <span className={`text-11 ${dirty ? 'text-amber' : 'text-ink-500'}`}>{busy ? '正在保存…' : dirty ? '有未保存的修改' : '授权已与宿主同步'}</span>
          <span className="ml-auto text-11 text-ink-500">
            {status?.running ? `宿主端口 ${status.port ?? '—'} · 已连接页面 ${status.clients}` : '宿主未运行'}
          </span>
        </div>
      </div>
      <div className="space-y-2 border-t border-ink-700 pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-12 text-ink-100">外部 Agent 任务{tasks.length > 0 && <span className="ml-1.5 text-11 text-ink-500">{tasks.length}</span>}</p>
        </div>
        <p className="max-w-3xl text-11 text-ink-500 leading-relaxed"><EmphasisText text="Agent 可通过任务台账登记「全书审读 / 逐章改写」这类跨多次调用的进度；**断线重连后可继续**。引擎不能强制终止外部进程，「取消请求」只是**协作式标记**。" /></p>
        {tasks.length === 0 && <p className="rounded-lg border border-dashed border-ink-700 px-3 py-3 text-11 text-ink-500">当前项目还没有 Agent 任务记录。</p>}
        {tasks.map(task => <div key={task.id} className="rounded-lg border border-ink-700 bg-ink-900/30 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate text-12 text-ink-100">{task.title}</span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-11 ${taskStatusClass(task)}`}>{taskStatusLabel(task)}</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-800"><div className={`h-1 rounded-full ${task.status === 'done' ? 'bg-emerald-500' : task.status === 'failed' ? 'bg-red-500' : 'bg-amber'}`} style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }} /></div>
          <div className="mt-1 flex justify-between gap-2 text-11 text-ink-500">
            <span className="truncate">{task.note || task.kind}</span>
            <span className="shrink-0">{task.progress}%{task.totalSteps ? ` · ${task.currentStep ?? 0}/${task.totalSteps}` : ''}</span>
          </div>
        </div>)}
      </div>
      <div className="space-y-2 border-t border-ink-700 pt-3">
        <div>
          <p className="text-12 text-ink-100">客户端连接配置</p>
          <p className="mt-0.5 text-11 text-ink-500"><EmphasisText text="生成后粘贴到 MCP 客户端；已有服务**只合并 yfe-agent 条目**，不要整体覆盖。" /></p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className={labelCls}>Node.js 命令或完整路径<input className={field} value={node} onChange={e => { onNodeChange(e.target.value); setWriteConfig('') }} /></label>
          <label className={labelCls}>Agent 客户端配置格式<select className={field} value={clientFormat} onChange={e => { setClientFormat(e.target.value as 'json' | 'codex'); setWriteConfig('') }}><option value="json">通用 MCP JSON</option><option value="codex">TOML 格式</option></select></label>
        </div>
        <label className={labelCls}>可写桥脚本完整路径<input className={field} value={writeScript} onChange={e => { setWriteScript(e.target.value); setWriteConfig('') }} placeholder="…/scripts/mcp/yfe-agent.mjs" /></label>
        {PORTABLE && <label className={labelCls}>便携版根目录<input className={field} value={portableRoot} onChange={e => { setPortableRoot(e.target.value); setWriteConfig('') }} /></label>}
        {!PORTABLE && status?.bridgeFile && <p className="break-all text-11 text-ink-500">宿主配置：{status.bridgeFile}</p>}
        <Button size="sm" variant="secondary" onClick={generateWriteConfig} disabled={unavailable}>生成可写配置</Button>
        {writeConfig && <>
          <textarea aria-label="可写桥连接配置" className={`${field} min-h-32 font-mono`} value={writeConfig} readOnly />
          <Button size="sm" variant="secondary" onClick={() => void copyWrite()}>复制可写配置</Button>
          <p className="text-11 text-ink-500">{clientFormat === 'codex' ? '将 yfe_agent 表合并进 Agent 客户端的 TOML 配置文件（如 config.toml），保留已有设置；重启客户端后检查连接。' : '把 yfe-agent 条目合并进已有的 mcpServers，不要覆盖其它服务。'} 宿主配置含本机随机连接令牌，请勿分享。</p>
        </>}
      </div>
      <div className="space-y-2 border-t border-ink-700 pt-3">
        <div>
          <p className="text-12 text-ink-100">复制给 Agent 的连接提示词</p>
          <p className="mt-0.5 text-11 text-ink-500"><EmphasisText text="包含本机路径、**不包含连接令牌**；请只发送给**可信 Agent**。" /></p>
        </div>
        {connectionPrompt ? <>
          <textarea aria-label="Agent 连接提示词" className={`${field} min-h-44 font-mono`} value={connectionPrompt} readOnly />
          <Button size="sm" variant="secondary" onClick={() => void copyPrompt()}>复制连接提示词</Button>
        </> : <p className="text-11 text-amber">请先确认桥脚本和宿主路径；便携版还需填写根目录。</p>}
      </div>
    </div>
  </details>
}

function taskStatusClass(task: AgentTaskRecord): string {
  if (task.status === 'failed') return 'bg-red-500/10 text-red-400'
  if (task.cancelRequested) return 'bg-amber/10 text-amber'
  if (task.status === 'done') return 'bg-emerald-500/10 text-emerald-400'
  if (task.status === 'running') return 'bg-amber/10 text-amber'
  return 'bg-ink-800 text-ink-400'
}

function taskStatusLabel(task: AgentTaskRecord): string {
  if (task.cancelRequested && task.status !== 'cancelled') return '已请求取消（等待 Agent 停止）'
  switch (task.status) {
    case 'running': return '进行中'
    case 'paused': return '已暂停'
    case 'done': return '已完成'
    case 'cancelled': return '已取消'
    case 'failed': return '失败'
    default: return task.status
  }
}
