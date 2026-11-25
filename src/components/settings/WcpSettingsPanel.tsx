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
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Copy, Download, FlaskConical, Globe2, Package, RefreshCw, Settings2,
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
  WCP_BASE_MODULES,
  WCP_BUDGET_MAX,
  WCP_BUDGET_MIN,
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
  const [ps, setPs] = useState<WcpProjectState | null>(null)
  const [loading, setLoading] = useState(true)
  const [baseBusy, setBaseBusy] = useState(false)
  const [basePack, setBasePack] = useState<WcpPackResult | null>(null)
  const [baseNotes, setBaseNotes] = useState<string[]>([])
  const [baseFingerprint, setBaseFingerprint] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [testInput, setTestInput] = useState('')

  useEffect(() => {
    let active = true
    void (async () => {
      const [g, p] = await Promise.all([loadWcpGlobalConfig(), loadWcpProjectState()])
      if (!active) return
      setCfg(g)
      setPs(p)
      setLoading(false)
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
                    className="mt-0.5 shrink-0"
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
                <Download size={12} /> 下载底包
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
                ariaLabel="默认前文章数" onCommit={() => void saveField('prevChapterCount', cfg.prevChapterCount)}
                onChange={v => setCfg(prev => (prev ? { ...prev, prevChapterCount: v ?? 0 } : prev))} />
            </div>
            <div className={FIELD_ROW}>
              <span className={FIELD_LABEL}>默认摘要章数</span>
              <NumberField value={cfg.prevSummaryCount} min={0} max={WCP_PREV_SUMMARY_MAX} className="w-20"
                ariaLabel="默认摘要章数" onCommit={() => void saveField('prevSummaryCount', cfg.prevSummaryCount)}
                onChange={v => setCfg(prev => (prev ? { ...prev, prevSummaryCount: v ?? 0 } : prev))} />
            </div>
            <div className={FIELD_ROW}>
              <span className={FIELD_LABEL}>单包字符预算</span>
              <NumberField value={cfg.maxPackBudgetChars} min={WCP_BUDGET_MIN} max={WCP_BUDGET_MAX} step={1000}
                className="w-28" ariaLabel="单包字符预算"
                onCommit={() => void saveField('maxPackBudgetChars', cfg.maxPackBudgetChars)}
                onChange={v => setCfg(prev => (prev ? { ...prev, maxPackBudgetChars: v ?? WCP_BUDGET_MIN } : prev))} />
            </div>
            <label className="flex items-start gap-2 rounded-md border border-ink-700 bg-ink-900/40 px-2.5 py-2">
              <input type="checkbox" className="mt-0.5 shrink-0" checked={cfg.includeWriterNotes}
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

      {/* ③ 输出格式与试解析台 */}
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