/**
 * 「模型设置 → WCP 模式」综合管理面板（3.7.3 · W3）。
 *
 * 三块内容：
 *   ① 定位说明 + 并存状态：WCP 不占宿主三模式租约，后台是 API / MCP / ACP 都不影响导出；
 *   ② 常驻底包：模块勾选、过期判定、下载 / 复制 / 预览装入清单；
 *   ③ 全局偏好 + 输出格式与试解析台：JSON / Markdown 切换，粘贴回复即时验证双段拆分。
 *
 * 🔴 视图态由 `AIConfigPanel` 的独立本地 state 控制 —— 本面板不调用
 *    `switchConnectionMode`，也不读 `connectionView`；后台模式只作为提示展示。
 * 🔴 底包指纹与勾选存单项目 `settingsKV`，全局偏好存 `meta`（见 `wcpSettings.ts`）。
 * 🔴 视觉：统一共享 `Button` / `Panel` / `NumberField` / `AutoTextarea` / `HelpPopover`，
 *    不使用幽灵按钮、不在 className 里叠字号、不写死会导致缩放溢界的宽度。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Copy, Download, FileUp, FlaskConical, FolderOpen, Globe2, HardDrive,
  Package, RefreshCw, Settings2, ShieldCheck,
} from 'lucide-react'
import Panel from '@/components/common/Panel'
import { Button } from '@/components/common/Button'
import HelpPopover from '@/components/common/HelpPopover'
import NumberField from '@/components/common/NumberField'
import AutoTextarea from '@/components/common/AutoTextarea'
import { LoadingState } from '@/components/common/LoadingState'
import { copyText, showToast } from '@/components/dialogs/dialogs'
import { downloadText } from '@/lib/storage/zip'
import { collectWcpPack } from '@/lib/wcp/wcpCollect'
import { packWcpDocument, type WcpPackResult } from '@/lib/wcp/wcpPacker'
import { parseWcpReply } from '@/lib/wcp/wcpParser'
import { wcpContractSample } from '@/lib/wcp/wcpTemplates'
import {
  loadWcpGlobalConfig,
  loadWcpProjectState,
  markWcpBaseExported,
  saveWcpGlobalConfig,
  saveWcpProjectState,
} from '@/lib/wcp/wcpSettings'
import {
  hasWcpWorkspaceBridge,
  workspaceChooseRoot,
  workspaceReveal,
} from '@/lib/wcp/wcpWorkspaceClient'
import {
  invalidateWcpWorkspaceProbe,
  probeWcpWorkspace,
  syncWcpWorkspace,
  type WcpWorkspaceStatus,
} from '@/lib/wcp/wcpWorkspaceSync'
import { WCP_WORKSPACE_CONFIG_EVENT } from '@/components/wcp/useWcpWorkspaceSync'
import {
  WCP_BASE_MODULES,
  WCP_BUDGET_MAX,
  WCP_BUDGET_MIN,
  WCP_WORKSPACE_INTERVAL_OPTIONS,
  WCP_PREV_CHAPTER_MAX,
  WCP_PREV_SUMMARY_MAX,
  type WcpGlobalConfig,
  type WcpProjectState,
} from '@/lib/wcp/wcpTypes'

interface Props {
  /** 后台在线模式（仅用于「当前后台模式」提示，不参与任何逻辑） */
  backendMode?: 'api' | 'agent' | 'acp' | null
  backendPhase?: 'loading' | 'stable' | 'switching' | 'blocked'
}

const BACKEND_LABEL: Record<'api' | 'agent' | 'acp', string> = {
  api: 'API 模式',
  agent: 'MCP 模式',
  acp: 'ACP 模式',
}

/** 左「底包管理」自适应，右「全局偏好」定宽；窄屏回落单栏（与 AIConfigPanel 列表态同款） */
const WCP_GRID = 'grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_21rem] gap-x-6 gap-y-5 items-start'
const FIELD_ROW = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5'
const FIELD_LABEL = 'text-12 text-ink-300'

export default function WcpSettingsPanel({ backendMode = null, backendPhase = 'loading' }: Props) {
  const [cfg, setCfg] = useState<WcpGlobalConfig | null>(null)
  /** NumberField 失焦钳制时会紧接着调用 onCommit；ref 保证拿到同一帧刚写入的最新值 */
  const cfgRef = useRef<WcpGlobalConfig | null>(null)
  cfgRef.current = cfg
  const [ps, setPs] = useState<WcpProjectState | null>(null)
  const [loading, setLoading] = useState(true)
  const [baseBusy, setBaseBusy] = useState(false)
  const [basePack, setBasePack] = useState<WcpPackResult | null>(null)
  const [baseNotes, setBaseNotes] = useState<string[]>([])
  const [baseFingerprint, setBaseFingerprint] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [testInput, setTestInput] = useState('')
  const [ws, setWs] = useState<WcpWorkspaceStatus | null>(null)
  const [wsBusy, setWsBusy] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      const [g, p] = await Promise.all([loadWcpGlobalConfig(), loadWcpProjectState()])
      if (!active) return
      setCfg(g)
      setPs(p)
      setLoading(false)
      const st = await probeWcpWorkspace().catch(() => null)
      if (active && st) setWs(st)
    })()
    return () => { active = false }
  }, [])

  /** 重新取底包材料并组装（只用于预览 / 下载前确认，不写任何项目数据） */
  const rebuildBase = useCallback(async () => {
    if (!cfg || !ps) return
    setBaseBusy(true)
    try {
      const collected = await collectWcpPack({
        kind: 'base',
        scene: 'chapter-continue',
        summaryFormat: cfg.summaryFormat,
        baseModules: ps.baseModules,
        budgetChars: cfg.maxPackBudgetChars,
        ext: cfg.defaultFileExt,
      })
      const built = packWcpDocument(collected.pack)
      setBasePack(built)
      setBaseFingerprint(collected.baseFingerprint)
      setBaseNotes(collected.notes)
    } catch (e) {
      showToast('底包装配失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setBaseBusy(false)
    }
  }, [cfg, ps])

  useEffect(() => { void rebuildBase() }, [rebuildBase])

  const saveField = async <K extends keyof WcpGlobalConfig>(key: K, value: WcpGlobalConfig[K]) => {
    setCfg(prev => (prev ? { ...prev, [key]: value } : prev))
    try {
      const saved = await saveWcpGlobalConfig({ [key]: value } as Partial<WcpGlobalConfig>)
      setCfg(saved)
    } catch (e) {
      setCfg(await loadWcpGlobalConfig())
      showToast('偏好保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  const toggleModule = async (id: string) => {
    if (!ps) return
    const picked = ps.baseModules.includes(id)
      ? ps.baseModules.filter(x => x !== id)
      : [...ps.baseModules, id]
    const order = WCP_BASE_MODULES.map(m => m.id)
    const next = [...picked].sort((a, b) => order.indexOf(a) - order.indexOf(b))
    setPs({ ...ps, baseModules: next })
    try {
      setPs(await saveWcpProjectState({ baseModules: next }))
    } catch (e) {
      setPs(await loadWcpProjectState())
      showToast('底包勾选保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  const refreshWorkspace = useCallback(async (force = false) => {
    const st = await probeWcpWorkspace(undefined, { force }).catch(() => null)
    if (st) setWs(st)
  }, [])

  const saveWorkspaceField = async <K extends keyof WcpGlobalConfig>(key: K, value: WcpGlobalConfig[K]) => {
    await saveField(key, value)
    invalidateWcpWorkspaceProbe()
    window.dispatchEvent(new Event(WCP_WORKSPACE_CONFIG_EVENT))
    await refreshWorkspace(true)
  }

  const toggleWorkspaceEnabled = async () => {
    try {
      const next = await saveWcpProjectState({ workspaceEnabled: !(ps?.workspaceEnabled ?? false) })
      setPs(next)
      invalidateWcpWorkspaceProbe()
      window.dispatchEvent(new Event(WCP_WORKSPACE_CONFIG_EVENT))
      await refreshWorkspace(true)
    } catch (e) {
      showToast('启用状态保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  const chooseWorkspaceRoot = async () => {
    const picked = await workspaceChooseRoot()
    if (!picked) return
    await saveWorkspaceField('workspaceRoot', picked)
    showToast('工作区根目录已更新。', 'success')
  }

  const openWorkspaceFolder = async () => {
    if (!ws?.folder) return
    const r = await workspaceReveal(ws.root, ws.folder)
    if (!r.ok) showToast('打开目录失败：' + (r.error || '未知原因'), 'error')
  }

  const updateWorkspaceNow = async () => {
    setWsBusy(true)
    try {
      const r = await syncWcpWorkspace({ reason: 'manual' })
      if (!r.ok) showToast('工作区更新失败：' + (r.error || '未知原因'), 'error', 6000)
      else if (r.skipped) showToast('工作区已是最新，没有写盘。', 'info')
      else showToast(`工作区已更新：写入 ${r.wrote} 个文件${r.deleted ? `，清理 ${r.deleted} 个过期文件` : ''}。`, 'success')
      await refreshWorkspace(true)
    } finally {
      setWsBusy(false)
    }
  }

  const copyWorkspacePrompt = async () => {
    setWsBusy(true)
    try {
      const r = await syncWcpWorkspace({ reason: 'manual' })
      if (!r.ok) {
        showToast('工作区同步失败：' + (r.error || '未知原因'), 'error', 6000)
        return
      }
      if (r.mode === 'zip') {
        showToast('当前形态已改为打包下载；请解压后把工作区路径告诉 Agent。', 'info')
        return
      }
      const ok = await copyText(r.prompt, 'Agent 提示词已复制；粘贴给本地 Agent 即可开工。')
      if (ok) showToast(r.skipped ? '工作区已是最新，提示词已复制。' : `已同步 ${r.wrote} 个文件，提示词已复制。`, 'success')
      await refreshWorkspace(true)
    } finally {
      setWsBusy(false)
    }
  }

  const downloadWorkspaceZip = async () => {
    setWsBusy(true)
    try {
      const r = await syncWcpWorkspace({ reason: 'manual', allowZipFallback: true })
      if (!r.ok) showToast('打包工作区失败：' + (r.error || '未知原因'), 'error', 6000)
      else showToast('已打包下载离线工作区；解压后即可交给本地 Agent。', 'success')
    } finally {
      setWsBusy(false)
    }
  }
  const downloadBase = async () => {
    if (!basePack) return
    const mime = cfg?.defaultFileExt === 'txt' ? 'text/plain;charset=utf-8' : 'text/markdown;charset=utf-8'
    downloadText(basePack.filename, basePack.text, mime)
    try {
      setPs(await markWcpBaseExported(baseFingerprint))
      showToast('底包已下载。之后可在此对照「设定是否已更新」。', 'success')
    } catch {
      showToast('底包已下载，但导出记录保存失败；下次会仍提示「尚未导出」。', 'error')
    }
  }

  const copyBase = async () => {
    if (!basePack) return
    const ok = await copyText(basePack.text, '底包已复制到剪贴板')
    if (!ok) return
    try {
      setPs(await markWcpBaseExported(baseFingerprint))
    } catch {
      showToast('已复制，但导出记录保存失败；下次会仍提示「尚未导出」。', 'error')
    }
  }

  const parsed = useMemo(
    () => (testInput.trim() ? parseWcpReply(testInput, cfg?.summaryFormat ?? 'json') : null),
    [testInput, cfg?.summaryFormat],
  )

  const fingerprintMatched = !!baseFingerprint && baseFingerprint === ps?.lastBaseFingerprint
  const baseState = !ps?.lastBaseFingerprint
    ? { text: '尚未导出底包', cls: 'border-ink-700 bg-ink-800/60 text-ink-400' }
    : fingerprintMatched
      ? { text: '最新', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' }
      : { text: '设定已更新，建议重导', cls: 'border-amber/35 bg-amber/10 text-amber' }

  if (loading || !cfg || !ps) return <LoadingState text="正在读取 WCP 设置…" />

  return (
    <div className="space-y-4">
      {/* ① 定位说明 + 并存状态 */}
      <Panel className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Globe2 size={14} className="shrink-0 text-amber" />
          <h2 className="text-14 font-semibold text-ink-100">WCP 模式 · 网页资料包</h2>
          <HelpPopover title="WCP 模式怎么用" width="25rem" size={14}>
            <p>WCP 是第 4 种「离线接力」方式：不需要 API Key，也不占用 API / MCP / ACP 的运行态。它把项目里的设定、角色、细纲和前文打包成一份 Markdown 文档，交给 Gemini、Claude 等网页版模型接续创作。</p>
            <p className="mt-2">典型流程：先在「模型设置」导出常驻底包，放进网页模型的 Gem / Project；写作时在对应页面导出增量包，让网页模型按双段格式回复；把回复粘回回流弹窗，正文入章、变动摘要勾选后才写入资料库。</p>
            <p className="mt-2">常驻底包只装长期设定，不掺当前章草稿。底包涉及的世界观或角色改动后，这里会提示「设定已更新，建议重导」，但不会阻断增量包导出。</p>
            <p className="mt-2">桌面版、便携版、网页版都可使用；与后台在线模式互不干扰。</p>
          </HelpPopover>
          <span className={`ml-auto rounded-md border px-2 py-1 text-11 ${baseState.cls}`}>{baseState.text}</span>
        </div>
        <p className="mt-1.5 text-12 text-ink-400 leading-relaxed">
          当前后台在线模式：
          <span className="text-ink-200">{backendMode ? BACKEND_LABEL[backendMode] : '读取中'}</span>
          {backendPhase === 'blocked' ? '（不可用）' : backendPhase === 'switching' ? '（切换中）' : ''}
          <span className="text-ink-500">　·　WCP 可随时并存使用，不调用模式切换，也不受后台锁影响。</span>
        </p>
      </Panel>

      {/* ② 本地 Agent 工作区（WCP-Local · 3.7.4） */}
      <Panel className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <HardDrive size={14} className="shrink-0 text-amber" />
          <h2 className="text-14 font-semibold text-ink-100">本地 Agent 工作区（WCP-Local）</h2>
          <HelpPopover title="本地工作区怎么用" width="25rem" size={14}>
            <p>桌面版把设定、当前章上下文与输出契约按文件同步到本机安全目录。Claude Code、Codex、Cursor、Cline 等本地 Agent 只需读取工作区，不用你每次上传文件。</p>
            <p className="mt-2">工作区只读区随创作自动保鲜：打开项目会提醒过期，也可以选定时静默更新或只手动更新。每次只覆写有变化的文件，不留历史副本，也绝不碰 outbox/。</p>
            <p className="mt-2">Agent 的产物写入 outbox/：一步生成可导入的 .wcp.json 与方便阅读的 .md，回引擎在「WCP 回流」里一键核对入库并归档。</p>
            <p className="mt-2">网页版 / 便携版没有本地写盘权限，可改下载同等目录结构的 .zip，解压后交给本地 Agent。</p>
          </HelpPopover>
          <span className={`ml-auto rounded-md border px-2 py-1 text-11 ${ws?.freshness === 'fresh'
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
            : ws?.freshness === 'stale'
              ? 'border-amber/35 bg-amber/10 text-amber'
              : 'border-ink-700 bg-ink-800/60 text-ink-400'}`}>
            {ws?.label ?? '正在检查工作区…'}
          </span>
        </div>
        <p className="mt-1.5 text-12 text-ink-400 leading-relaxed">
          只读区按文件同步，唯一可写区是 <span className="text-ink-200">outbox/</span>；同步不占用 API / MCP / ACP 的运行态。
          {ws?.lastSyncAt ? <span className="text-ink-500">　·　上次同步：{new Date(ws.lastSyncAt).toLocaleString()}</span> : null}
        </p>

        <div className="mt-3 space-y-2.5">
          <div className="rounded-md border border-ink-700 bg-ink-900/40 px-2.5 py-2">
            <div className={FIELD_ROW}>
              <span className={FIELD_LABEL}>工作区目录</span>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button variant="secondary" size="xs" onClick={() => void chooseWorkspaceRoot()} disabled={!hasWcpWorkspaceBridge() || wsBusy}>
                  <FolderOpen size={12} /> 自定义目录
                </Button>
                <Button variant="secondary" size="xs" onClick={() => void saveWorkspaceField('workspaceRoot', '')}
                  disabled={!hasWcpWorkspaceBridge() || !cfg.workspaceRoot || wsBusy}>
                  恢复默认
                </Button>
                <Button variant="secondary" size="xs" onClick={() => void openWorkspaceFolder()} disabled={!hasWcpWorkspaceBridge() || !ws?.folder || wsBusy}>
                  打开文件夹
                </Button>
                <Button variant="secondary" size="xs" onClick={() => void refreshWorkspace(true)} disabled={wsBusy}>
                  <RefreshCw size={12} /> 刷新状态
                </Button>
              </div>
            </div>
            <p className="mt-1 break-all text-11 text-ink-300">
              {ws?.root || cfg.workspaceRoot || '默认：数据文件同级的 wcp-workspaces/'}
              {ws?.folder ? <span className="text-ink-500">　/　{ws.folder}</span> : null}
            </p>
          </div>

          <label className="flex items-start gap-2 rounded-md border border-ink-700 bg-ink-900/40 px-2.5 py-2">
            <input type="checkbox" className="mt-0.5 shrink-0 accent-amber" checked={ps.workspaceEnabled}
              onChange={() => void toggleWorkspaceEnabled()} />
            <span className="min-w-0">
              <span className="block text-12 text-ink-200">本书启用本地 Agent 工作区</span>
              <span className="block text-11 text-ink-500 leading-relaxed">未启用的书不参与打开提醒与定时更新，也不会写任何工作区文件。</span>
            </span>
          </label>

          <div className={FIELD_ROW}>
            <span className={FIELD_LABEL}>更新策略</span>
            <div className="inline-flex flex-wrap gap-1.5">
              <Button variant="toggle" size="xs" selected={cfg.workspaceSyncMode === 'remind-on-open'}
                onClick={() => void saveWorkspaceField('workspaceSyncMode', 'remind-on-open')}>打开时提醒</Button>
              <Button variant="toggle" size="xs" selected={cfg.workspaceSyncMode === 'auto-interval'}
                onClick={() => void saveWorkspaceField('workspaceSyncMode', 'auto-interval')}>定时自动</Button>
              <Button variant="toggle" size="xs" selected={cfg.workspaceSyncMode === 'manual'}
                onClick={() => void saveWorkspaceField('workspaceSyncMode', 'manual')}>仅手动</Button>
            </div>
          </div>

          {cfg.workspaceSyncMode === 'auto-interval' && (
            <div className={FIELD_ROW}>
              <span className={FIELD_LABEL}>自动刷新间隔</span>
              <div className="inline-flex flex-wrap gap-1.5">
                {WCP_WORKSPACE_INTERVAL_OPTIONS.map(min => (
                  <Button key={min} variant="toggle" size="xs" selected={cfg.workspaceSyncIntervalMin === min}
                    onClick={() => void saveWorkspaceField('workspaceSyncIntervalMin', min)}>{min} 分钟</Button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="flex items-start gap-2 rounded-md border border-ink-700 bg-ink-900/40 px-2.5 py-2">
              <input type="checkbox" className="mt-0.5 shrink-0 accent-amber" checked={cfg.syncFullChapters}
                onChange={e => void saveWorkspaceField('syncFullChapters', e.target.checked)} />
              <span className="min-w-0">
                <span className="block text-12 text-ink-200">同步全书历史章节（04-chapters/）</span>
                <span className="block text-11 text-ink-500 leading-relaxed">供大上下文 Agent 按索引翻查前文；默认关闭，开启后只增量刷新变化的章节。</span>
              </span>
            </label>
            <label className="flex items-start gap-2 rounded-md border border-ink-700 bg-ink-900/40 px-2.5 py-2">
              <input type="checkbox" className="mt-0.5 shrink-0 accent-amber" checked={cfg.archiveOutboxAfterImport}
                onChange={e => void saveWorkspaceField('archiveOutboxAfterImport', e.target.checked)} />
              <span className="min-w-0">
                <span className="block text-12 text-ink-200">导入后自动归档收件箱</span>
                <span className="block text-11 text-ink-500 leading-relaxed">成功载入后把 .wcp.json 与 .md 成对移入 outbox/imported/，避免重复导入。</span>
              </span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => void updateWorkspaceNow()} disabled={wsBusy || !hasWcpWorkspaceBridge()}>
              {wsBusy ? <RefreshCw size={12} className="animate-spin" /> : <ShieldCheck size={12} />} 立即更新工作区
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void copyWorkspacePrompt()} disabled={wsBusy || !hasWcpWorkspaceBridge()}>
              <Copy size={12} /> 同步并复制 Agent 提示词
            </Button>
            {!hasWcpWorkspaceBridge() && (
              <Button variant="secondary" size="sm" onClick={() => void downloadWorkspaceZip()} disabled={wsBusy}>
                <Download size={12} /> 下载离线工作区 .zip
              </Button>
            )}
          </div>

          {!hasWcpWorkspaceBridge() && (
            <p className="rounded-md border border-amber/30 bg-amber/10 px-2.5 py-1.5 text-11 text-amber">
              当前是网页 / 便携形态：没有本地写盘权限。下载 .zip 后解压，把目录路径告诉本地 Agent 即可；回流仍走「WCP 回流」的浏览文件 / 拖拽 / 粘贴。
            </p>
          )}
          {hasWcpWorkspaceBridge() && ws && !ws.writable && (
            <p className="rounded-md border border-amber/30 bg-amber/10 px-2.5 py-1.5 text-11 text-amber">
              {ws.error || '工作区目录当前不可写，请改选一个可写目录。'}
            </p>
          )}
          {ws && ws.freshness === 'stale' && (
            <p className="rounded-md border border-amber/30 bg-amber/10 px-2.5 py-1.5 text-11 text-amber">
              工作区有新的改动还没同步。点「立即更新工作区」只会覆写有变化的文件，不影响 outbox/ 里 Agent 的产物。
            </p>
          )}
          {ws?.notes.length ? (
            <ul className="space-y-0.5 text-11 text-ink-500">
              {ws.notes.map((n, i) => <li key={i}>· {n}</li>)}
            </ul>
          ) : null}
        </div>
      </Panel>
      {/* ② 底包管理 + 全局偏好 */}
      <Panel className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Package size={14} className="shrink-0 text-amber" />
          <h2 className="text-14 font-semibold text-ink-100">常驻底包与导出偏好</h2>
        </div>
        <div className={WCP_GRID}>
          <div className="min-w-0">
            <p className="text-11 text-ink-500 leading-relaxed">
              勾选要长期提供给网页模型的模块。底包不包含当前章草稿、前文或找茬正文 —— 那些属于增量包。
            </p>
            <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
              {WCP_BASE_MODULES.map(m => (
                <label key={m.id} className="flex items-start gap-2 rounded-md border border-ink-700 bg-ink-900/40 px-2.5 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 shrink-0 accent-amber"
                    checked={ps.baseModules.includes(m.id)}
                    onChange={() => void toggleModule(m.id)}
                  />
                  <span className="min-w-0">
                    <span className="block text-12 text-ink-200">{m.label}</span>
                    <span className="block text-11 text-ink-500 leading-relaxed">{m.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            {!ps.baseModules.length && (
              <p className="mt-2 rounded-md border border-amber/30 bg-amber/10 px-2.5 py-1.5 text-11 text-amber">
                一个模块都没勾选：导出的底包只会有只读声明、文风 / 去 AI 味规则与任务说明，不含任何项目资料。建议至少勾选「世界设定 / 核心角色」。
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" onClick={() => void downloadBase()} disabled={baseBusy || !basePack}>
                <FileUp size={12} /> 下载底包
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void copyBase()} disabled={baseBusy || !basePack}>
                <Copy size={12} /> 复制底包
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setPreviewOpen(v => !v)} disabled={!basePack}>
                {previewOpen ? '收起清单' : '预览清单'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void rebuildBase()} disabled={baseBusy}>
                <RefreshCw size={12} className={baseBusy ? 'animate-spin' : ''} /> 刷新
              </Button>
              {baseBusy && <span className="text-11 text-ink-500">正在装配…</span>}
            </div>

            {baseNotes.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-11 text-ink-500">
                {baseNotes.map((n, i) => <li key={i}>· {n}</li>)}
              </ul>
            )}

            {previewOpen && basePack && (
              <div className="mt-3 rounded-lg border border-ink-700 bg-ink-900/40 p-3">
                <p className="text-11 text-ink-400">
                  共 {basePack.toc.length} 段 · 全文 {basePack.chars} 字符
                  （完整 {basePack.fullCount} / 裁剪 {basePack.trimmedCount} / 省略 {basePack.droppedCount}）
                  · 单包预算 {basePack.budgetChars} 字符
                </p>
                <ul className="mt-1.5 space-y-0.5 text-11 text-ink-300">
                  {basePack.toc.map(e => (
                    <li key={e.id}>
                      · {e.title}：{e.chars} 字符（{e.scope === 'full' ? '完整' : e.scope === 'trimmed' ? '裁剪' : '省略'}）
                      {e.reason ? <span className="text-ink-500">　{e.reason}</span> : null}
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-11 text-ink-500">预览不会记录「已导出」；只有点「下载底包」或「复制底包」后才会更新导出时间与指纹。</p>
              </div>
            )}
          </div>

          {/* 全局偏好 */}
          <div className="min-w-0 space-y-3">
            <div className={FIELD_ROW}>
              <span className={FIELD_LABEL}>默认下载后缀</span>
              <div className="inline-flex gap-1.5">
                {(['md', 'txt'] as const).map(ext => (
                  <Button key={ext} variant="toggle" size="xs" selected={cfg.defaultFileExt === ext}
                    onClick={() => void saveField('defaultFileExt', ext)}>.{ext}</Button>
                ))}
              </div>
            </div>
            <div className={FIELD_ROW}>
              <span className={FIELD_LABEL}>就近入口默认形态</span>
              <div className="inline-flex gap-1.5">
                <Button variant="toggle" size="xs" selected={cfg.defaultPackKind === 'delta'}
                  onClick={() => void saveField('defaultPackKind', 'delta')}>增量包</Button>
                <Button variant="toggle" size="xs" selected={cfg.defaultPackKind === 'full'}
                  onClick={() => void saveField('defaultPackKind', 'full')}>完整包</Button>
              </div>
            </div>
            <div className={FIELD_ROW}>
              <span className={FIELD_LABEL}>摘要格式</span>
              <div className="inline-flex gap-1.5">
                <Button variant="toggle" size="xs" selected={cfg.summaryFormat === 'json'}
                  onClick={() => void saveField('summaryFormat', 'json')}>JSON（推荐）</Button>
                <Button variant="toggle" size="xs" selected={cfg.summaryFormat === 'markdown'}
                  onClick={() => void saveField('summaryFormat', 'markdown')}>Markdown 清单</Button>
              </div>
            </div>
            <div className={FIELD_ROW}>
              <span className={FIELD_LABEL}>默认前文章数</span>
              <NumberField value={cfg.prevChapterCount} min={0} max={WCP_PREV_CHAPTER_MAX} className="w-20"
                ariaLabel="默认前文章数" onCommit={() => { const cur = cfgRef.current; if (cur) void saveField('prevChapterCount', cur.prevChapterCount) }}
                onChange={v => {
                  const next = cfgRef.current ? { ...cfgRef.current, prevChapterCount: v ?? 0 } : null
                  cfgRef.current = next
                  setCfg(next)
                }} />
            </div>
            <div className={FIELD_ROW}>
              <span className={FIELD_LABEL}>默认摘要章数</span>
              <NumberField value={cfg.prevSummaryCount} min={0} max={WCP_PREV_SUMMARY_MAX} className="w-20"
                ariaLabel="默认摘要章数" onCommit={() => { const cur = cfgRef.current; if (cur) void saveField('prevSummaryCount', cur.prevSummaryCount) }}
                onChange={v => {
                  const next = cfgRef.current ? { ...cfgRef.current, prevSummaryCount: v ?? 0 } : null
                  cfgRef.current = next
                  setCfg(next)
                }} />
            </div>
            <div className={FIELD_ROW}>
              <span className={FIELD_LABEL}>单包字符预算</span>
              <NumberField value={cfg.maxPackBudgetChars} min={WCP_BUDGET_MIN} max={WCP_BUDGET_MAX} step={1000}
                className="w-28" ariaLabel="单包字符预算"
                onCommit={() => { const cur = cfgRef.current; if (cur) void saveField('maxPackBudgetChars', cur.maxPackBudgetChars) }}
                onChange={v => {
                  const next = cfgRef.current ? { ...cfgRef.current, maxPackBudgetChars: v ?? WCP_BUDGET_MIN } : null
                  cfgRef.current = next
                  setCfg(next)
                }} />
            </div>
            <label className="flex items-start gap-2 rounded-md border border-ink-700 bg-ink-900/40 px-2.5 py-2">
              <input type="checkbox" className="mt-0.5 shrink-0 accent-amber" checked={cfg.includeWriterNotes}
                onChange={e => void saveField('includeWriterNotes', e.target.checked)} />
              <span className="min-w-0">
                <span className="block text-12 text-ink-200">附带作者备注</span>
                <span className="block text-11 text-ink-500 leading-relaxed">导出弹窗里填写的补充说明会写进资料包</span>
              </span>
            </label>
            <p className="text-11 text-ink-500 leading-relaxed">
              这些偏好跨项目共享；底包勾选与过期指纹按当前项目单独保存，切换作品不会互相影响。
            </p>
          </div>
        </div>
      </Panel>

      {/* ④ 输出格式与试解析台 */}
      <Panel className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <FlaskConical size={14} className="shrink-0 text-amber" />
          <h2 className="text-14 font-semibold text-ink-100">输出格式与试解析</h2>
          <HelpPopover title="试解析怎么用" width="24rem" size={14}>
            <p>把网页模型返回的整段回复粘到下面，这里会即时拆出「第一部分正文」和「第二部分变动摘要」，只读、不写入任何项目数据。</p>
            <p className="mt-2">JSON 模式下，第二部分会被校验为 6 类变动；格式不完整时正文仍完整保留，并出现「一键切换为 Markdown 清单模式」。</p>
            <p className="mt-2">Markdown 清单模式对人眼更友好，但不会生成可勾选入库的候选。</p>
          </HelpPopover>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className="text-11 text-ink-500">当前格式</span>
            <Button variant="toggle" size="xs" selected={cfg.summaryFormat === 'json'}
              onClick={() => void saveField('summaryFormat', 'json')}>JSON</Button>
            <Button variant="toggle" size="xs" selected={cfg.summaryFormat === 'markdown'}
              onClick={() => void saveField('summaryFormat', 'markdown')}>Markdown 清单</Button>
          </div>
        </div>

        <div className="mt-3">
          <AutoTextarea value={testInput} onChange={setTestInput} minRows={6} maxHeight={320} textClass="text-12"
            placeholder={`把网页模型的完整回复粘到这里。示例：\n${wcpContractSample(cfg.summaryFormat)}`} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setTestInput(wcpContractSample(cfg.summaryFormat))}>
              填入示例
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setTestInput('')} disabled={!testInput}>
              清空
            </Button>
          </div>
        </div>

        {parsed && (
          <div className="mt-3 space-y-3">
            {parsed.jsonFailed && (
              <div className="rounded-lg border border-amber/35 bg-amber/10 px-3 py-2.5">
                <p className="flex items-start gap-1.5 text-12 text-amber">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  检测到当前网页模型返回的 JSON 格式不完整。正文已完整保留，可照常复制或入章；若该模型较难稳定输出 JSON，可一键切换为对人眼更友好的固定 Markdown 清单。
                </p>
                <Button variant="primary" size="sm" className="mt-2"
                  onClick={() => void saveField('summaryFormat', 'markdown')}>
                  一键切换为 Markdown 清单模式
                </Button>
              </div>
            )}
            <div className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
              <p className="flex flex-wrap items-center gap-2 text-11 text-ink-400">
                {parsed.format === 'json'
                  ? <><CheckCircle2 size={12} className="text-emerald-400" /> 第二部分已按 JSON 解析</>
                  : parsed.format === 'markdown'
                    ? <><CheckCircle2 size={12} className="text-emerald-400" /> 第二部分已按 Markdown 清单解析</>
                    : <><Settings2 size={12} /> 没有识别到第二部分（整段归入正文）</>}
                <span className="text-ink-500">· 正文 {parsed.body.length} 字符</span>
              </p>
              {parsed.warnings.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 text-11 text-ink-500">
                  {parsed.warnings.map((w, i) => <li key={i}>· {w}</li>)}
                </ul>
              )}
              <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div className="min-w-0">
                  <p className="mb-1 text-11 font-medium text-ink-300">第一部分 · 正文</p>
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-ink-700 bg-ink-950/60 p-2.5 text-11 text-ink-200">
                    {parsed.body || '（空）'}
                  </pre>
                </div>
                <div className="min-w-0">
                  <p className="mb-1 text-11 font-medium text-ink-300">第二部分 · 变动摘要</p>
                  {parsed.markdownCards.length > 0 ? (
                    <div className="max-h-56 overflow-auto rounded-md border border-ink-700 bg-ink-950/60 p-2.5 space-y-2">
                      {parsed.markdownCards.map((c, i) => (
                        <div key={i}>
                          <p className="text-11 font-medium text-ink-300">{c.section}</p>
                          <ul className="mt-0.5 space-y-0.5 text-11 text-ink-400">
                            {c.items.map((it, j) => <li key={j}>· {it}</li>)}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-ink-700 bg-ink-950/60 p-2.5 text-11 text-ink-200">
                      {parsed.rawChanges || '（空）'}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </Panel>
    </div>
  )
}