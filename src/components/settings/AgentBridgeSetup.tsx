import { useEffect, useState } from 'react'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'
import { DESKTOP, agentBridgeDataPath, agentBridgeScriptPath } from '@/lib/app/desktop'
import { PORTABLE } from '@/lib/storage/fileBackend'
import { makeAgentBridgeConfig, makeCodexAgentBridgeConfig, makeBridgeConfig, type BridgeDataSource } from '@/lib/aiCore/backend/bridgeConfig'
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

const field = 'w-full rounded border border-ink-700 bg-ink-900 px-2 py-1 text-12 text-ink-200'

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
    try { await navigator.clipboard.writeText(config); showToast('配置已复制', 'success') }
    catch { showToast('复制失败，请手动选择并复制下方配置', 'error') }
  }
  return <details className="mt-2 text-12 text-ink-300">
    <summary className="cursor-pointer text-accent">生成外部 Agent 的只读连接配置</summary>
    <div className="mt-2 space-y-2">
      <p className="text-11 text-ink-500">在 Antigravity 的「Customizations → Installed → MCP Servers」找到配置文件，将下方条目合并进去。桥可读取本机所有项目中的允许字段，请只连接可信客户端。读取的是已保存到磁盘的数据，请先在引擎中保存。配置前请先安装 Node.js。</p>
      <label className="block">Node.js 命令或完整路径<input className={field} value={node} onChange={e => { setNode(e.target.value); setConfig('') }} /></label>
      <label className="block">只读桥脚本完整路径<input className={field} value={script} onChange={e => { setScript(e.target.value); setConfig('') }} placeholder="…/scripts/mcp/yfe-readonly.mjs" /></label>
      <label className="block">数据位置<select className={field} value={kind} onChange={e => { setKind(e.target.value as BridgeDataSource['kind']); setTarget(''); setConfig('') }}>
        <option value="desktop">桌面版默认或自定义数据位置</option><option value="portable">便携版根目录</option><option value="file">指定数据文件</option>
      </select></label>
      {kind !== 'desktop' && <label className="block">{kind === 'portable' ? '便携版根目录' : '数据文件完整路径'}<input className={field} value={target} onChange={e => { setTarget(e.target.value); setConfig('') }} /></label>}
      {kind === 'desktop' && DESKTOP && !loadingPaths && !desktopData && <p className="text-11 text-amber">无法取得桌面数据路径，请选择「指定数据文件」。</p>}
      <Button variant="secondary" onClick={generate} disabled={loadingPaths}>生成配置</Button>
      {config && <><textarea aria-label="只读桥连接配置" className={`${field} min-h-32 font-mono`} value={config} readOnly /><Button variant="secondary" onClick={() => void copy()}>复制配置</Button><p className="text-11 text-ink-500">若已有其他 MCP 服务，只将 yfe-readonly 条目合并进已有的 mcpServers，避免覆盖原配置。</p></>}
      <WriteConnection node={node} />
    </div>
  </details>
}

/** 可写连接：开关 + 项目 / 动作授权 + 配置生成（3.4.3） */
function WriteConnection({ node }: { node: string }) {
  const [status, setStatus] = useState<AgentHostStatus | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [scope, setScope] = useState<AgentScope>({ projects: [] })
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [writeScript, setWriteScript] = useState('')
  const [portableRoot, setPortableRoot] = useState('')
  const [writeConfig, setWriteConfig] = useState('')
  const [clientFormat, setClientFormat] = useState<'json' | 'codex'>('json')

  useEffect(() => {
    let active = true
    void Promise.all([agentHostStatus(), db.getAllProjects(), agentWriteBridgeScriptPath()]).then(([st, list, script]) => {
      if (!active) return
      setStatus(st)
      setProjects(list)
      setScope(normalizeAgentScope(st.scope))
      setEnabled(st.enabled)
      if (script) setWriteScript(script)
    }).catch(() => { /* 状态读取失败由轮询展示，不阻塞设置页 */ })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => {
      void agentHostStatus().then(st => setStatus(st)).catch(() => undefined)
    }, 4000)
    return () => clearInterval(timer)
  }, [])

  const actionsOf = (projectId: string): AgentAction[] => scope.projects.find(p => p.projectId === projectId)?.actions ?? []
  function toggle(projectId: string, action: AgentAction) {
    const current = actionsOf(projectId)
    const nextActions = current.includes(action) ? current.filter(a => a !== action) : [...current, action]
    const rest = scope.projects.filter(p => p.projectId !== projectId)
    setScope(normalizeAgentScope({ projects: nextActions.length ? [...rest, { projectId, actions: nextActions }] : rest }))
  }
  async function save() {
    setBusy(true)
    try {
      const result = await updateAgentHostConfig({ enabled, scope })
      if (!result.ok) { showToast(result.error ?? '保存失败', 'error'); return }
      if (result.status) setStatus(result.status)
      showToast('Agent 连接设置已保存', 'success')
    } finally { setBusy(false) }
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
    try { await navigator.clipboard.writeText(writeConfig); showToast('配置已复制', 'success') }
    catch { showToast('复制失败，请手动选择并复制下方配置', 'error') }
  }

  const unavailable = status?.mode === 'web'
  return <details className="mt-4 border-t border-ink-700 pt-2">
    <summary className="cursor-pointer text-accent">Agent 写入连接（可创建设定 / 录入正文）</summary>
    <div className="mt-2 space-y-3">
      <p className="text-11 text-ink-500">
        开启后，外部 Agent 可通过 MCP 工具直接创建设定卡、创建章节、追加 / 覆盖正文。
        写入会进入正在运行的引擎（沿用它的保存、快照与索引），不会直接改数据文件。
        默认只读；只有在这里勾选的项目与动作才会被接受。请只连接可信客户端。
      </p>
      {unavailable && <p className="text-11 text-amber">网页版没有本机宿主进程，无法使用 Agent 写入连接。</p>}
      {!unavailable && status && !status.running && <p className="text-11 text-amber">{status.lastError || 'Agent 宿主尚未运行，请确认引擎已启动并稍候重试。'}</p>}
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        开启 Agent 写入连接
      </label>
      <div className="space-y-1">
        <p className="text-11 text-ink-400">授权项目与动作（未勾选 = 只读）：</p>
        {projects.length === 0 && <p className="text-11 text-ink-500">还没有项目。请先在引擎中新建 / 打开一个项目。</p>}
        {projects.map(project => <div key={project.id} className="rounded border border-ink-700 px-2 py-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-ink-200">{project.name}</span>
            <span className="text-11 text-ink-500">{actionsOf(project.id).length ? (agentActionSummary(actionsOf(project.id))) : '未授权'}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-3">
            {AGENT_ACTIONS.map(action => <label key={action} className="flex items-center gap-1 text-11 text-ink-300">
              <input type="checkbox" checked={actionsOf(project.id).includes(action)} onChange={() => toggle(project.id, action)} />
              {AGENT_ACTION_LABELS[action]}
            </label>)}
          </div>
        </div>)}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={() => void save()} disabled={busy}>保存授权</Button>
        <span className="text-11 text-ink-500">
          {status?.running ? `宿主端口 ${status.port ?? '—'} · 已连接页面 ${status.clients}` : '宿主未运行'}
        </span>
      </div>
      <div className="space-y-1 border-t border-ink-700 pt-2">
        <label className="block">Agent 客户端配置格式<select className={field} value={clientFormat} onChange={e => { setClientFormat(e.target.value as 'json' | 'codex'); setWriteConfig('') }}><option value="json">通用 MCP JSON</option><option value="codex">Codex TOML</option></select></label>
        <label className="block">可写桥脚本完整路径<input className={field} value={writeScript} onChange={e => { setWriteScript(e.target.value); setWriteConfig('') }} placeholder="…/scripts/mcp/yfe-agent.mjs" /></label>
        {PORTABLE && <label className="block">便携版根目录<input className={field} value={portableRoot} onChange={e => { setPortableRoot(e.target.value); setWriteConfig('') }} /></label>}
        {!PORTABLE && status?.bridgeFile && <p className="break-all text-11 text-ink-500">宿主配置：{status.bridgeFile}</p>}
        <Button variant="secondary" onClick={generateWriteConfig} disabled={unavailable}>生成可写配置</Button>
        {writeConfig && <>
          <textarea aria-label="可写桥连接配置" className={`${field} min-h-32 font-mono`} value={writeConfig} readOnly />
          <Button variant="secondary" onClick={() => void copyWrite()}>复制可写配置</Button>
          <p className="text-11 text-ink-500">{clientFormat === 'codex' ? '将 yfe_agent 表合并进 Codex 的 config.toml，保留已有设置；重启客户端后检查连接。' : '把 yfe-agent 条目合并进已有的 mcpServers，不要覆盖其它服务。'} 宿主配置含本机随机连接令牌，请勿分享。</p>
        </>}
      </div>
    </div>
  </details>
}

function agentActionSummary(actions: AgentAction[]): string {
  return actions.map(a => AGENT_ACTION_LABELS[a]).join(' / ')
}
