import { useEffect, useState, useCallback, useRef } from 'react'
import { writerBudgetFor } from '../lib/aiWriterBudget'
import * as db from '../lib/db'
import { scanText, BUILTIN_WORDS, getCustomSensitiveWords, setCustomSensitiveWords } from '../lib/sensitiveWords'
import {
  Sparkles, ShieldAlert, ScanSearch, RefreshCw, FileDown, Upload, Loader2, Stethoscope, EyeOff, RotateCcw, Trash2
} from 'lucide-react'
import HelpPopover from './HelpPopover'
import AIDataSourceNote from './AIDataSourceNote'
import AutoTextarea from './AutoTextarea'
import { confirmDialog, showToast } from './dialogs'
import { downloadBlob } from '../lib/zip'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { aiReviewSensitive, aiContinuityAudit, type SensitiveReview, type ContinuityFinding } from '../lib/aiTasks'
import { buildProjectContext } from '../lib/aiContext'
import { runDataHealthCheck } from '../lib/dataHealth'
import { SEVERITY_LABEL, type AuditIssue, type AuditLocation } from '../lib/audit'
import { Button } from './Button'

// 风险 / 严重度色标签
const riskBadge = (r: string) =>
  r === '误报' ? 'bg-ink-700 text-ink-300 border border-ink-600'
  : r === '高' ? 'bg-red-500/15 text-red-300 border border-red-500/30'
  : r === '中' ? 'bg-amber/15 text-amber border border-amber/30'
  : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
const levelBadge = (l: string) =>
  l === '严重' ? 'bg-red-500/15 text-red-300 border border-red-500/30'
  : l === '中等' ? 'bg-amber/15 text-amber border border-amber/30'
  : 'bg-ink-700 text-ink-300 border border-ink-600'

// 数据体检严重度色标签（复用 audit.ts 的 SEVERITY_LABEL 文案）
const sevBadge = (s: 'error' | 'warn' | 'info') =>
  s === 'error' ? 'bg-red-500/15 text-red-300 border border-red-500/30'
  : s === 'warn' ? 'bg-amber/15 text-amber border border-amber/30'
  : 'bg-ink-700 text-ink-300 border border-ink-600'

export default function CheckTools() {
  // ---- 敏感词 ----
  const [customWords, setCustomWords] = useState<string[]>([])
  const [wordInput, setWordInput] = useState('')
  const [scanResult, setScanResult] = useState<{ title: string; hits: ReturnType<typeof scanText> }[]>([])
  const [scanning, setScanning] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  // ---- 数据体检：被用户忽略的冲突 id（持久化，下次体检仍隐藏）----
  const [ignoredIds, setIgnoredIds] = useState<string[]>([])

  const load = useCallback(async () => {
    setCustomWords(await getCustomSensitiveWords())
    setIgnoredIds(await db.getSetting<string[]>('healthIgnoredIds', []))
  }, [])
  useEffect(() => { load() }, [load])

  const addWord = async () => {
    const parts = wordInput.split(/[，,、\n\s]+/).map(s => s.trim()).filter(Boolean)
    if (parts.length === 0) return
    const next = Array.from(new Set([...customWords, ...parts]))
    setCustomWords(next)
    setWordInput('')
    await setCustomSensitiveWords(next)
  }
  const removeWord = async (w: string) => {
    const next = customWords.filter(x => x !== w)
    setCustomWords(next)
    await setCustomSensitiveWords(next)
  }
  const clearCustom = async () => {
    if (!await confirmDialog({ title: '清空敏感词', message: '清空所有自定义敏感词？', danger: true })) return
    setCustomWords([])
    await setCustomSensitiveWords([])
  }
  const exportWords = () => {
    downloadBlob('custom-sensitive-words.txt', new Blob([customWords.join('\n')], { type: 'text/plain;charset=utf-8' }))
  }
  const onFile = async (file: File) => {
    const text = await file.text()
    // 支持按行 / 逗号 / 中文逗号 / 制表符 / 空格分隔；同时忽略空行与 # 注释
    const parts = text.split(/[\n\r，,、\t\s]+/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))
    if (parts.length === 0) return
    const next = Array.from(new Set([...customWords, ...parts]))
    setCustomWords(next)
    await setCustomSensitiveWords(next)
    showToast(`已导入 ${parts.length} 个词（去重后总计 ${next.length}）`)
  }

  /** 系统词库扫描（无 AI 也能用，始终可用）。返回扫描结果以便 AI 检测复用。 */
  const scanBook = async (): Promise<{ title: string; hits: ReturnType<typeof scanText> }[]> => {
    setScanning(true)
    try {
      const chapters = await db.getAllChapters()
      const result: { title: string; hits: ReturnType<typeof scanText> }[] = []
      for (const ch of chapters) {
        const hits = scanText(ch.content || '', customWords)
        if (hits.length > 0) result.push({ title: ch.title, hits })
      }
      setScanResult(result)
      return result
    } catch (e) {
      showToast('扫描失败：' + (e instanceof Error ? e.message : String(e)), 'error')
      return []
    } finally {
      setScanning(false)
    }
  }

  const totalWords = scanResult.reduce((s, r) => s + r.hits.reduce((x, h) => x + h.count, 0), 0)

  // ---- AI 扩展：敏感词语境复核 / 一致性深度自查（均无模型时禁用，本地能力不受影响）----
  const { ready: aiReady } = useAIReady()
  const [review, setReview] = useState<SensitiveReview[]>([])
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewErr, setReviewErr] = useState('')
  const [auditText, setAuditText] = useState('')
  const [findings, setFindings] = useState<ContinuityFinding[]>([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditErr, setAuditErr] = useState('')
  const [auditRun, setAuditRun] = useState(false)
  /** 三个 AI 功能共用的流式实时预览（仅加载中显示） */
  const [streamText, setStreamText] = useState('')

  // ---- 数据体检（机械扫描，不依赖 AI）----
  const [healthIssues, setHealthIssues] = useState<AuditIssue[]>([])
  const [healthScanning, setHealthScanning] = useState(false)
  const [healthRun, setHealthRun] = useState(false)
  const runHealth = useCallback(async () => {
    setHealthScanning(true); setHealthIssues([]); setHealthRun(false)
    try {
      const res = await runDataHealthCheck()
      setHealthIssues(res.issues)
      setHealthRun(true)
    } finally { setHealthScanning(false) }
  }, [])
  useEffect(() => { runHealth() }, [runHealth])
  /** 跳转到问题所在的具体行（跨组件：App 监听 yfe:navigate 切表并高亮） */
  const jumpToRow = (loc?: AuditLocation) => {
    if (loc?.kind === 'row') window.dispatchEvent(new CustomEvent('yfe:navigate', { detail: { tabId: loc.tabId, rowId: loc.rowId } }))
  }
  /** 忽略单条冲突：写入持久化忽略列表，后续体检不再汇报（弹窗提醒） */
  const ignoreIssue = async (id: string) => {
    if (!await confirmDialog({
      title: '忽略此条冲突',
      message: '忽略后，后续重新体检将不再汇报这条冲突。\n（点「重新体检」旁的「清除忽略」可恢复显示。）',
    })) return
    const next = Array.from(new Set([...ignoredIds, id]))
    setIgnoredIds(next)
    await db.setSetting('healthIgnoredIds', next)
    showToast('已忽略，重新体检将不再提示此条')
  }
  /** 清除全部忽略记录：下次重新体检会重新汇报这些冲突 */
  const clearIgnored = async () => {
    if (ignoredIds.length === 0) return
    if (!await confirmDialog({
      title: '清除忽略记录',
      message: `将清空全部 ${ignoredIds.length} 条被忽略的冲突，下次重新体检会重新出现。确定？`,
      danger: true,
    })) return
    setIgnoredIds([])
    await db.setSetting('healthIgnoredIds', [])
    showToast('已清除忽略记录，下次体检会重新汇报')
  }

  /** 敏感词 AI 检测：复用 aiReviewSensitive 复核命中词；无扫描结果时先自动跑一次系统扫描 */
  const aiDetect = async () => {
    if (!aiReady || reviewLoading) return
    let hits = scanResult.flatMap(r => r.hits.map(h => ({ word: h.word, snippet: h.context }))).slice(0, 40)
    if (hits.length === 0) {
      const res = await scanBook()
      hits = res.flatMap(r => r.hits.map(h => ({ word: h.word, snippet: h.context }))).slice(0, 40)
    }
    if (hits.length === 0) { showToast('未检出敏感词，无需 AI 检测'); return }
    setReviewLoading(true); setReviewErr(''); setReview([]); setStreamText('')
    try { setReview(await aiReviewSensitive(hits, { onToken: (d) => setStreamText(prev => prev + d) })) }
    catch (e) { setReviewErr(e instanceof Error ? e.message : String(e)) }
    finally { setReviewLoading(false) }
  }

  const aiAudit = async () => {
    if (!aiReady || auditLoading) return
    setAuditLoading(true); setAuditErr(''); setFindings([]); setStreamText('')
    try {
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('consistency-selfcheck') }).catch(() => ({ text: '' }))
      setFindings(await aiContinuityAudit(ctx.text, auditText.trim(), { onToken: (d) => setStreamText(prev => prev + d) }))
      setAuditRun(true)
    } catch (e) { setAuditErr(e instanceof Error ? e.message : String(e)) }
    finally { setAuditLoading(false) }
  }

  // 数据体检：剔除已被忽略的冲突
  const visibleIssues = healthIssues.filter(i => !ignoredIds.includes(i.id))

  return (
    <div className="w-full page-enter">
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-ink-50">检查工具</h1>
          <HelpPopover title="检查工具怎么用" width="22rem" size={14}>
            {'三个发布前自检能力：\n\n· 敏感词检测：系统词库扫描（始终可用）+ 可选 AI 复核（需接入 AI）；\n· AI 一致性深度自查：对照设定资料查人名/时间脉络/能力的前后矛盾（需 AI）；\n· 数据体检：机械确定性扫描引用断链/编号重复/必填空/酒馆列表残留，不靠 AI，离线可用，每条可忽略或清除忽略。\n\n建议改动过名称/删过条目后跑一次数据体检，发布前至少跑一次敏感词与数据体检。'}
          </HelpPopover>
        </div>
        <p className="mt-1 text-13 text-ink-300">敏感词检测 · AI 一致性深度自查 · 数据体检</p>
      </header>

      <div className="space-y-4">
        {/* ============ 敏感词 ============ */}
        <section className="bg-ink-850 border border-ink-700 rounded-xl p-5">
          <h2 className="text-13 font-semibold text-ink-100 mb-1 flex items-center gap-2">
            <ShieldAlert size={14} className="text-red-400" /> 敏感词检测
            <HelpPopover title="敏感词检测怎么用" width="22rem" className="ml-auto">
              {'两个能力：\n\n· 系统扫描（始终可用）：内置基础违禁词库 + 你的自定义词，逐章检查并列出命中词、次数与上下文；\n· AI 检测（需接入 AI）：让模型结合上下文判断每个命中词是误报还是真有风险，并给出替换建议。无 AI 时该按钮禁用，本地扫描不受影响。\n\n· 添加：输入框支持逗号 / 顿号 / 换行批量粘贴；\n· 一键导入文件：支持 .txt（一行一词）/.csv/.tsv/.json 数组，井号 # 开头视为注释。\n只做提示不自动改字——是否规避请自行判断（编辑器工具栏也有单章版敏感词检测，可直接替换）。'}
              <AIDataSourceNote feature="sensitive-check" />
            </HelpPopover>
          </h2>
          <p className="text-11 text-ink-500 mb-4">
            内置基础词库（涉毒/涉暴/赌博/色情低俗/违法等 {Object.values(BUILTIN_WORDS).flat().length} 词）。
            各平台屏蔽词不同，建议把目标平台官方词库粘贴到下方或一键导入 .txt / .csv / .json 文件。
          </p>

          <div className="flex flex-wrap gap-2 mb-3">
            <input
              value={wordInput}
              onChange={e => setWordInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && addWord()}
              placeholder="输入自定义敏感词，支持用逗号/换行分隔批量添加…"
              className="flex-1 min-w-[200px] !py-1.5 text-12"
            />
            <Button onClick={addWord} variant="secondary" size="md" className="text-12">添加</Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.csv,.json,.tsv"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) onFile(f)
                if (fileInputRef.current) fileInputRef.current.value = ''
              }}
            />
            <Button variant="danger" onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 border-red-500/25 rounded-lg text-12 transition-colors" title="支持 .txt（一行一词）/ .csv / .json 数组 / .tsv">
              <FileDown size={12} /> 一键导入文件
            </Button>
            {customWords.length > 0 && (
              <>
                <Button onClick={exportWords}
                  
                  title="导出为 .txt" variant="secondary" size="md" className="flex items-center text-12">
                  <Upload size={12} /> 导出
                </Button>
                <Button onClick={clearCustom} variant="secondary" size="md" className="flex items-center text-12">
                  <Trash2 size={12} /> 清空
                </Button>
              </>
            )}
          </div>
          {customWords.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3 max-h-32 overflow-y-auto p-2 bg-ink-900/40 rounded border border-ink-700/50">
              <span className="text-10 text-ink-500 py-1">自定义 {customWords.length} 词：</span>
              {customWords.map(w => (
                <span key={w} className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 border border-red-500/20 rounded-md text-11 text-red-300">
                  {w}
                  <Button variant="bare" onClick={() => removeWord(w)} className="hover:text-red-400"><Trash2 size={9} /></Button>
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="danger" onClick={() => scanBook()} disabled={scanning} className="flex items-center gap-1.5 px-4 py-2 border-red-500/25 rounded-lg text-12 transition-colors disabled:opacity-50">
              <ScanSearch size={13} /> {scanning ? '扫描中…' : '系统扫描全书'}
            </Button>
            {aiReady ? (
              <Button onClick={aiDetect}
                disabled={reviewLoading}
                title="AI 结合上下文判断每个命中词是误报还是真有风险" variant="secondary" size="md" className="flex items-center text-12">
                <Sparkles size={13} /> {reviewLoading ? 'AI 检测中…' : 'AI 检测'}
              </Button>
            ) : (
              <Button disabled
                title={AI_DISABLED_HINT} variant="secondary" size="md" className="flex items-center text-12 cursor-not-allowed">
                <Sparkles size={13} /> AI 检测
              </Button>
            )}
          </div>

          {scanResult.length > 0 && (
            <div className="mt-4 space-y-3">
              <div className={`text-12 ${totalWords > 0 ? 'text-red-300' : 'text-emerald-400'}`}>
                {totalWords > 0
                  ? `系统扫描检出 ${scanResult.length} 章共 ${totalWords} 处命中，发布前建议逐处确认`
                  : '全书干净，未检出敏感词 ✓'}
              </div>
              {scanResult.map(r => (
                <div key={r.title} className="bg-ink-800/60 border border-ink-700 rounded-lg p-3">
                  <div className="text-12 font-semibold text-ink-100 mb-2">{r.title}</div>
                  <div className="space-y-1.5">
                    {r.hits.map(h => (
                      <div key={h.word} className="text-11 text-ink-300 flex items-start gap-2">
                        <span className="px-1.5 py-0.5 bg-red-500/15 text-red-300 rounded shrink-0">{h.word} ×{h.count}</span>
                        <span className="text-ink-500 truncate">{h.context}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {reviewLoading && streamText && (
            <div className="mt-2">
              <div className="text-11 text-ink-500 mb-1">AI 实时输出</div>
              <pre className="whitespace-pre-wrap text-11 text-ink-300 bg-ink-900/60 border border-ink-700 rounded-lg p-2.5 max-h-48 overflow-auto">{streamText}</pre>
            </div>
          )}
          {reviewErr && (
            <div className="mt-2 flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-12 text-red-300">
              <ShieldAlert size={13} className="mt-0.5 shrink-0" /> <span className="whitespace-pre-wrap">{reviewErr}</span>
            </div>
          )}
          {review.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="text-11 text-ink-500">AI 检测结论（按风险分级，误报可忽略）</div>
              {review.map((r, i) => (
                <div key={i} className="flex items-start gap-2 text-11 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2">
                  <span className={`px-1.5 py-0.5 rounded border shrink-0 whitespace-nowrap text-10 ${riskBadge(r.risk)}`}>{r.risk}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-ink-200">「{r.word}」{r.suggestion && <span> → 建议「<span className="text-emerald-300">{r.suggestion}</span>」</span>}</div>
                    {r.reason && <div className="text-ink-500 mt-0.5">{r.reason}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ============ AI 一致性深度自查 ============ */}
        <section className="bg-ink-850 border border-ink-700 rounded-xl p-5">
          <h2 className="text-13 font-semibold text-ink-100 mb-1 flex items-center gap-2">
            <ScanSearch size={14} className="text-sky-400" /> AI 一致性深度自查
            <HelpPopover title="AI 一致性深度自查怎么用" width="22rem" className="ml-auto">
              {'把你的世界观 / 角色 / 时间脉络设定交给 AI，对照检查前后矛盾与逻辑硬伤。\n\n· 上方文本框可粘贴一段正文（可选），AI 会同时核对正文与设定；留空则只在设定资料内部互查；\n· 结果按 严重 / 中等 / 提示 分级，并给出冲突依据与涉及位置；\n· 需先接入 AI 模型，未接入时按钮禁用；本地能力不受影响。'}
              <AIDataSourceNote feature="continuity-audit" />
            </HelpPopover>
          </h2>
          <p className="text-11 text-ink-500 mb-3">
            对照全项目设定资料，找出人名 / 时间脉络 / 能力 / 关系的前后矛盾（可选粘贴一段正文一并核查）。
          </p>
          <AutoTextarea
            value={auditText}
            onChange={setAuditText}
            placeholder="（可选）粘贴一段正文，让 AI 同时核对正文与设定；留空则只在设定资料内部互查"
            minHeight={64}
            maxHeight={200}
            className="!px-3 !py-2 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 focus:border-amber/40 outline-none placeholder:text-ink-600 w-full mb-3"
          />
          <div className="flex items-center gap-2">
            {aiReady ? (
              <Button variant="info" onClick={aiAudit} disabled={auditLoading} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-12 transition-colors disabled:opacity-50">
                <Sparkles size={13} /> {auditLoading ? '自查中…' : 'AI 深度自查'}
              </Button>
            ) : (
              <Button disabled
                title={AI_DISABLED_HINT} variant="secondary" size="md" className="flex items-center text-12 cursor-not-allowed">
                <Sparkles size={13} /> AI 深度自查
              </Button>
            )}
            {auditLoading && (
              <span className="text-11 text-ink-400 flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" /> 正在对照设定…
              </span>
            )}
          </div>
          {auditLoading && streamText && (
            <div className="mt-3">
              <div className="text-11 text-ink-500 mb-1">AI 实时输出</div>
              <pre className="whitespace-pre-wrap text-11 text-ink-300 bg-ink-900/60 border border-ink-700 rounded-lg p-2.5 max-h-60 overflow-auto">{streamText}</pre>
            </div>
          )}
          {auditErr && (
            <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-12 text-red-300">
              <ShieldAlert size={13} className="mt-0.5 shrink-0" /> <span className="whitespace-pre-wrap">{auditErr}</span>
            </div>
          )}
          {auditRun && !auditLoading && findings.length === 0 && (
            <div className="mt-4 py-3 text-center text-12 text-emerald-400">AI 自查完成，未发现明显的前后矛盾 ✓</div>
          )}
          {findings.length > 0 && (
            <div className="mt-4 space-y-2">
              <div className="text-12 text-amber/80">共 {findings.length} 处疑似冲突：</div>
              {findings.map((f, i) => (
                <div key={i} className="bg-ink-800 border border-ink-700 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-1.5 py-0.5 rounded border text-10 ${levelBadge(f.level)}`}>{f.level}</span>
                    <span className="text-12 font-semibold text-ink-100">{f.title}</span>
                  </div>
                  {f.detail && <div className="text-11 text-ink-400">{f.detail}</div>}
                  {f.where && <div className="text-10 text-ink-500 mt-0.5">涉及：{f.where}</div>}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ============ 数据体检（机械扫描，与 AI 一致性自查互补） ============ */}
        <section className="bg-ink-850 border border-ink-700 rounded-xl p-5">
          <h2 className="text-13 font-semibold text-ink-100 mb-1 flex items-center gap-2">
            <Stethoscope size={14} className="text-emerald-400" /> 数据体检
            <HelpPopover title="数据体检怎么用" width="23rem" className="ml-auto">
              {'与上方「AI 一致性深度自查」互补：AI 查"故事通不通"（语义矛盾），本工具查"链接断没断"（数据结构）。\n\n· 纯程序毫秒级扫描，不依赖 AI 模型，离线可用；\n· 五类检查：跨表引用悬空（改名/删除后残留）、孤儿项（父级被删）、编号重复、主名称列必填空、酒馆列表残留（酒馆列表项指向的正文已不在，列表里看得见、点开是空的；此类只报告、不自动清理），另含伏笔编号引用悬空；\n· 每条问题精确到行，「跳转 ↗」一键飞到那一行手改；\n· 单条可「忽略」（不再汇报），「清除忽略」一键恢复全部被忽略的冲突；\n· 进入本页自动体检一次，也可点「重新体检」。建议改动过名称/删过条目后跑一遍。'}
            </HelpPopover>
          </h2>
          <p className="text-11 text-ink-500 mb-3">
            对照全项目设定，扫描引用断链 / 编号重复 / 必填空 / 酒馆列表残留（确定性检查，不靠 AI 推理）。
          </p>
          <div className="flex items-center gap-2">
            <Button variant="success" onClick={runHealth} disabled={healthScanning} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-12 transition-colors disabled:opacity-50">
              <RefreshCw size={13} className={healthScanning ? 'animate-spin' : ''} /> {healthScanning ? '体检中…' : '重新体检'}
            </Button>
            <Button onClick={clearIgnored}
              disabled={ignoredIds.length === 0}
              title={ignoredIds.length === 0 ? '暂无被忽略的冲突' : '清空全部忽略记录，下次体检会重新汇报'} variant="danger" size="md" className="flex items-center text-12">
              <RotateCcw size={12} /> 清除忽略{ignoredIds.length > 0 ? `（${ignoredIds.length}）` : ''}
            </Button>
            {healthScanning && (
              <span className="text-11 text-ink-400 flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" /> 正在扫描所有设定表…
              </span>
            )}
          </div>
          {healthRun && !healthScanning && visibleIssues.length === 0 && (
            <div className="mt-4 py-3 text-center text-12 text-emerald-400">
              {healthIssues.length === 0 ? '数据健康，未发现引用断链 / 编号重复 / 必填空 / 酒馆列表残留 ✓' : '已忽略全部冲突，数据干净 ✓'}
            </div>
          )}
          {visibleIssues.length > 0 && (
            <div className="mt-4 space-y-2">
              <div className="text-12 text-amber/80">
                检出 {visibleIssues.length} 处需关注{ignoredIds.length > 0 && `（已忽略 ${ignoredIds.length} 处）`}：
              </div>
              {visibleIssues.map(issue => (
                <div key={issue.id} className="bg-ink-800 border border-ink-700 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-1.5 py-0.5 rounded border text-10 ${sevBadge(issue.severity)}`}>{SEVERITY_LABEL[issue.severity]}</span>
                    <span className="text-12 font-semibold text-ink-100">{issue.title}</span>
                    <div className="ml-auto flex items-center gap-1">
                      <Button variant="bare"
                        onClick={() => ignoreIssue(issue.id)}
                        className="flex items-center gap-1 px-2 py-0.5 text-11 rounded-md bg-ink-700 text-ink-300 border border-ink-600 hover:text-ink-100 transition-colors"
                        title="忽略此条冲突（之后不再汇报）"
                      >
                        <EyeOff size={11} /> 忽略
                      </Button>
                      <Button variant="bare"
                        onClick={() => jumpToRow(issue.location)}
                        disabled={issue.location?.kind !== 'row'}
                        className="flex items-center gap-1 px-2 py-0.5 text-11 rounded-md bg-ink-700 text-ink-200 border border-ink-600 hover:bg-ink-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title="跳到该设定行"
                      >
                        跳转 ↗
                      </Button>
                    </div>
                  </div>
                  {issue.detail && <div className="text-11 text-ink-400 leading-relaxed">{issue.detail}</div>}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
