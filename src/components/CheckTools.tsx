import Panel from './Panel'
import { useEffect, useState, useCallback, useRef } from 'react'
import { AI_STREAM_LABEL } from '../lib/constants'
import { writerBudgetFor } from '../lib/aiWriterBudget'
import * as db from '../lib/db'
import { scanText, BUILTIN_WORDS, getCustomSensitiveWords, setCustomSensitiveWords } from '../lib/sensitiveWords'
import {
  Sparkles, ShieldAlert, ScanSearch, RefreshCw, FileDown, Upload, Loader2, Stethoscope, EyeOff, RotateCcw, Trash2
} from 'lucide-react'
import HelpPopover from './HelpPopover'
import ManuscriptCheckPanel from './ManuscriptCheckPanel'
import PaceAnalysisPanel from './PaceAnalysisPanel'
import StructurePacePanel from './StructurePacePanel'
import ReaderProbePanel from './ReaderProbePanel'
import ChapterCheckPanel from './ChapterCheckPanel'
import OptimizeTicketPanel from './OptimizeTicketPanel'
import PlatformCheckPanel from './PlatformCheckPanel'
import AIDataSourceNote from './AIDataSourceNote'
import AutoTextarea from './AutoTextarea'
import { confirmDialog, showToast } from './dialogs'
import { downloadText } from '../lib/zip'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { aiReviewSensitive, aiContinuityAudit, type SensitiveReview, type ContinuityFinding } from '../lib/aiTasks'
import { buildProjectContext } from '../lib/aiContext'
import { runDataHealthCheck, type TavernGhostInfo } from '../lib/dataHealth'
import { checkAuditChapters, formatGap } from '../lib/evidenceGate'
import { SEVERITY_LABEL, type AuditIssue, type AuditLocation } from '../lib/audit'
import { Button } from './Button'

// 风险 / 严重度色标签
const riskBadge = (r: string) =>
  r === '误报' ? 'bg-ink-700 text-ink-300 border border-ink-600'
  : r === '高' ? 'bg-danger/15 text-danger border border-danger/30'
  : r === '中' ? 'bg-amber/15 text-amber border border-amber/30'
  : 'bg-success/15 text-success border border-success/30'
const levelBadge = (l: string) =>
  l === '严重' ? 'bg-danger/15 text-danger border border-danger/30'
  : l === '中等' ? 'bg-amber/15 text-amber border border-amber/30'
  : 'bg-ink-700 text-ink-300 border border-ink-600'

// 数据体检严重度色标签（复用 audit.ts 的 SEVERITY_LABEL 文案）
const sevBadge = (s: 'error' | 'warn' | 'info') =>
  s === 'error' ? 'bg-danger/15 text-danger border border-danger/30'
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
    downloadText('custom-sensitive-words.txt', customWords.join('\n'))
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
  /** 第 5 类里「可清理」的分组（靠 issueId 与上面 issues 关联，用于在卡片上挂「清理」按钮） */
  const [ghosts, setGhosts] = useState<TavernGhostInfo[]>([])
  const runHealth = useCallback(async () => {
    setHealthScanning(true); setHealthIssues([]); setHealthRun(false)
    try {
      const res = await runDataHealthCheck()
      setHealthIssues(res.issues)
      setGhosts(res.tavernGhosts ?? [])
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

  /**
   * 清理某一组酒馆索引残留。
   *
   * 真正的前置判断**不在界面这层**，而在 `pruneGhostsSafely` 里（写盘锁拒绝 / 二次复判 / 先备份）——
   * 放 lib 层是为了无论谁调都安全；界面只负责弹确认、把 blocked 原因原样告诉作者。
   */
  const cleanGhosts = async (info: TavernGhostInfo) => {
    if (!await confirmDialog({
      title: '清理索引残留',
      message: `将把这 ${info.count} 条「${info.label}」的列表项从索引里移除。\n\n`
        + `它们指向的内容本来就已经不在了（列表里看得见、点开是空的），所以这一步不会影响你任何还能打开的对话或角色卡。\n`
        + `清理前会再复判一次，并自动留一份索引备份。\n\n`
        + `此操作不能从界面撤销。确定清理吗？`,
      confirmText: '清理',
      danger: true,
    })) return
    try {
      // ⚠️ 动态 import：check-tools 是 locked、酒馆那套是 optional —— 静态引入会把酒馆存储层并进本页 chunk
      const { pruneGhostsSafely } = await import('../lib/tavern/store')
      const r = await pruneGhostsSafely(info.group)
      if (r.blocked) { showToast(r.blocked, 'error'); return }
      if (r.pruned === 0) { showToast('复判后没有可清理的条目，未做改动'); await runHealth(); return }
      showToast(`已清理 ${r.pruned} 条索引残留${r.backupKey ? '（已留备份）' : ''}`)
      await runHealth()
    } catch (e) {
      showToast(`清理失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
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
    // 🔴 缺失即停（§10.3 #2）：跨章审计至少要两章有正文 —— 单章无从「跨章核对」，
    //    与其发一次注定没用的 AI 请求，不如先如实说明并停下。
    const chapters = await db.getAllChapters().catch(() => [])
    const gap = checkAuditChapters(chapters.filter(c => (c.content ?? '').trim()).length)
    if (gap) { showToast(formatGap(gap), 'error'); return }
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
            {'十个发布前自检能力：\n\n· 敏感词检测：系统词库扫描（始终可用）+ 可选 AI 复核（需接入 AI）；\n· AI 一致性深度自查：对照设定资料查人名/时间脉络/能力的前后矛盾（需 AI）；\n· 数据体检：机械确定性扫描引用断链/编号重复/必填空/酒馆列表残留，不靠 AI，离线可用，每条可忽略或清除忽略。\n· 投稿前自检：行文分布（句长/段长离散度、过渡语密度、重复用词）与全书节奏（章节字数分布、更新节奏），外加复用连续性与伏笔引擎的汇总数字。全部本地统计，不发 AI 请求。\n· 全书结构配比：把结构模板（三幕式 / 十五拍等）的理想节拍占比与实际各拍承载的字数占比对照，看哪一拍写多了、哪一拍写少了。纯本地统计。与「节奏与章末钩子」分工：这个看全书卷章结构，那个看单章内部节奏。\n· 节奏与章末钩子：挑一章看爆点落在前 / 中 / 后哪几段、章末有没有留钩子（需 AI）。段位由程序按原文位置算，只给观察不给分。\n· 本章体检：对选中的一章串五个确定性引擎（连续性 / 伏笔 / 敏感词 / 错别字 / 文风），全部本地计算，手动触发。\n· 分平台投稿预检：挑晋江 / 起点档位，看哪些命中属于该平台重点关注的类别，以及分章字数事实；只摆事实不判定。\n· 读者视角审问：让 AI 扮成一个具体读者（追更读者 / 新读者 / 老书虫）读这一章，回答「哪里看不下去 / 哪里没看懂 / 最想知道什么」（需 AI）。读者提到的位置会标出段号，是程序按原文查出来的。\n· 全书优化工单：把全书的问题汇总成一张可勾选的待办表（诊断全部本地完成、不花额度），勾好后按章合并改写，改完可逐行看前后对照。\n\n建议改动过名称/删过条目后跑一次数据体检，发布前至少跑一次敏感词与数据体检。\n\n说明：「投稿前自检」给的是分布事实与参考区间，帮你看平时注意不到的倾向，不做评分也不判「像不像机器写的」——具体怎么改由你定。'}
          </HelpPopover>
        </div>
        <p className="mt-1 text-13 text-ink-300">敏感词检测 · AI 一致性深度自查 · 数据体检 · 投稿前自检 · 全书结构配比 · 节奏与章末钩子 · 本章体检 · 全书优化工单 · 分平台投稿预检 · 读者视角审问</p>
      </header>

      <div className="space-y-4">
        {/* ============ 敏感词 ============ */}
        <Panel>
          <h2 className="text-13 font-semibold text-ink-100 mb-1 flex items-center gap-2">
            <ShieldAlert size={14} className="text-danger" /> 敏感词检测
            <HelpPopover title="敏感词检测怎么用" width="22rem">
              {'两个能力：\n\n· 系统扫描（始终可用）：内置基础违禁词库 + 你的自定义词，逐章检查并列出命中词、次数与上下文；\n· AI 检测（需接入 AI）：让模型结合上下文判断每个命中词是误报还是真有风险，并给出替换建议。无 AI 时该按钮禁用，本地扫描不受影响。\n\n· 添加：输入框支持逗号 / 顿号 / 换行批量粘贴；\n· 导入：支持 .txt（一行一词）/.csv/.tsv/.json 数组，井号 # 开头视为注释。\n只做提示不自动改字——是否规避请自行判断（编辑器工具栏也有单章版敏感词检测，可直接替换）。'}
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
            <Button onClick={addWord} variant="secondary" size="md">添加</Button>
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
            <Button variant="danger" onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 border-danger/25 transition-colors" title="支持 .txt（一行一词）/ .csv / .json 数组 / .tsv">
              <FileDown size={12} /> 导入
            </Button>
            {customWords.length > 0 && (
              <>
                <Button onClick={exportWords}
                  
                  title="导出为 .txt" variant="secondary" size="md" className="flex items-center">
                  <Upload size={12} /> 导出
                </Button>
                <Button onClick={clearCustom} variant="secondary" size="md" className="flex items-center">
                  <Trash2 size={12} /> 清空
                </Button>
              </>
            )}
          </div>
          {customWords.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3 max-h-32 overflow-y-auto p-2 bg-ink-900/40 rounded border border-ink-700/50">
              <span className="text-10 text-ink-500 py-1">自定义 {customWords.length} 词：</span>
              {customWords.map(w => (
                <span key={w} className="inline-flex items-center gap-1 px-2 py-0.5 bg-danger/10 border border-danger/20 rounded-md text-11 text-danger">
                  {w}
                  <Button variant="bare" onClick={() => removeWord(w)} className="hover:text-danger"><Trash2 size={9} /></Button>
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="danger" onClick={() => scanBook()} disabled={scanning} className="flex items-center gap-1.5 border-danger/25 transition-colors disabled:opacity-50">
              <ScanSearch size={13} /> {scanning ? '扫描中…' : '系统扫描全书'}
            </Button>
            {aiReady ? (
              <Button onClick={aiDetect}
                disabled={reviewLoading}
                title="AI 结合上下文判断每个命中词是误报还是真有风险" variant="secondary" size="md" className="flex items-center">
                <Sparkles size={13} /> {reviewLoading ? 'AI 检测中…' : 'AI 检测'}
              </Button>
            ) : (
              <Button disabled
                title={AI_DISABLED_HINT} variant="secondary" size="md" className="flex items-center cursor-not-allowed">
                <Sparkles size={13} /> AI 检测
              </Button>
            )}
          </div>

          {scanResult.length > 0 && (
            <div className="mt-4 space-y-3">
              <div className={`text-12 ${totalWords > 0 ? 'text-danger' : 'text-success'}`}>
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
                        <span className="px-1.5 py-0.5 bg-danger/15 text-danger rounded shrink-0">{h.word} ×{h.count}</span>
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
              <div className="text-11 text-ink-500 mb-1">{AI_STREAM_LABEL}</div>
              <pre className="whitespace-pre-wrap text-11 text-ink-300 bg-ink-900/60 border border-ink-700 rounded-lg p-2.5 max-h-48 overflow-auto">{streamText}</pre>
            </div>
          )}
          {reviewErr && (
            <div className="mt-2 flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/25 text-12 text-danger">
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
                    <div className="text-ink-200">「{r.word}」{r.suggestion && <span> → 建议「<span className="text-success">{r.suggestion}</span>」</span>}</div>
                    {r.reason && <div className="text-ink-500 mt-0.5">{r.reason}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* ============ AI 一致性深度自查 ============ */}
        <Panel>
          <h2 className="text-13 font-semibold text-ink-100 mb-1 flex items-center gap-2">
            <ScanSearch size={14} className="text-info" /> AI 一致性深度自查
            <HelpPopover title="AI 一致性深度自查怎么用" width="22rem">
              {'把你的世界观 / 角色 / 时间脉络设定交给 AI，对照检查前后矛盾与逻辑硬伤。\n\n· 上方文本框可粘贴一段正文（可选），AI 会同时核对正文与设定；留空则只在设定资料内部互查；\n· 结果按 严重 / 中等 / 提示 分级，并给出冲突依据与涉及位置；\n· 需先接入 AI 模型，未接入时按钮禁用；本地能力不受影响。'}
              <AIDataSourceNote feature="consistency-selfcheck" />
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
              <Button variant="info" onClick={aiAudit} disabled={auditLoading} className="transition-colors disabled:opacity-50">
                <Sparkles size={13} /> {auditLoading ? '自查中…' : 'AI 深度自查'}
              </Button>
            ) : (
              <Button disabled
                title={AI_DISABLED_HINT} variant="secondary" size="md" className="flex items-center cursor-not-allowed">
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
              <div className="text-11 text-ink-500 mb-1">{AI_STREAM_LABEL}</div>
              <pre className="whitespace-pre-wrap text-11 text-ink-300 bg-ink-900/60 border border-ink-700 rounded-lg p-2.5 max-h-60 overflow-auto">{streamText}</pre>
            </div>
          )}
          {auditErr && (
            <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/25 text-12 text-danger">
              <ShieldAlert size={13} className="mt-0.5 shrink-0" /> <span className="whitespace-pre-wrap">{auditErr}</span>
            </div>
          )}
          {auditRun && !auditLoading && findings.length === 0 && (
            <div className="mt-4 py-3 text-center text-12 text-success">AI 自查完成，未发现明显的前后矛盾 ✓</div>
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
        </Panel>

        {/* ============ 数据体检（机械扫描，与 AI 一致性自查互补） ============ */}
        <Panel>
          <h2 className="text-13 font-semibold text-ink-100 mb-1 flex items-center gap-2">
            <Stethoscope size={14} className="text-success" /> 数据体检
            <HelpPopover title="数据体检怎么用" width="23rem">
              {'与上方「AI 一致性深度自查」互补：AI 查「故事通不通」（语义矛盾），本工具查「链接断没断」（数据结构）。\n\n· 纯程序毫秒级扫描，不依赖 AI 模型，离线可用；\n· 五类检查：跨表引用悬空（改名/删除后残留）、孤儿项（父级被删）、编号重复、主名称列必填空、酒馆列表残留（酒馆列表项指向的正文已不在，列表里看得见、点开是空的；此类不会自动清理，需要你在那条结果上点「清理」），另含伏笔编号引用悬空；\n· 每条问题精确到行，「跳转 ↗」一键飞到那一行手改；\n· 单条可「忽略」（不再汇报），「清除忽略」一键恢复全部被忽略的冲突；\n· 进入本页自动体检一次，也可点「重新体检」。建议改动过名称/删过条目后跑一遍。'}
            </HelpPopover>
          </h2>
          <p className="text-11 text-ink-500 mb-3">
            对照全项目设定，扫描引用断链 / 编号重复 / 必填空 / 酒馆列表残留（确定性检查，不靠 AI 推理）。
          </p>
          <div className="flex items-center gap-2">
            <Button variant="success" onClick={runHealth} disabled={healthScanning} className="transition-colors disabled:opacity-50">
              <RefreshCw size={13} className={healthScanning ? 'animate-spin' : ''} /> {healthScanning ? '体检中…' : '重新体检'}
            </Button>
            <Button onClick={clearIgnored}
              disabled={ignoredIds.length === 0}
              title={ignoredIds.length === 0 ? '暂无被忽略的冲突' : '清空全部忽略记录，下次体检会重新汇报'} variant="danger" size="md" className="flex items-center">
              <RotateCcw size={12} /> 清除忽略{ignoredIds.length > 0 ? `（${ignoredIds.length}）` : ''}
            </Button>
            {healthScanning && (
              <span className="text-11 text-ink-400 flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" /> 正在扫描所有设定表…
              </span>
            )}
          </div>
          {healthRun && !healthScanning && visibleIssues.length === 0 && (
            <div className="mt-4 py-3 text-center text-12 text-success">
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
                      {/* 第 5 类（酒馆列表残留）才有这个键：其余几类靠改数据修，这一类靠清索引修。
                          与同排「忽略 / 跳转」同为 bare + 同一套尺寸 class（danger 只换配色），这样才真等高 ——
                          ⚠️ 用 variant="danger" 而不传 size 时，SIZE 的 h-9 / px-4 / text-13 恒覆盖下面这串 class。 */}
                      {ghosts.filter(g => g.issueId === issue.id).map(g => (
                        <Button key={g.group} variant="bare"
                          onClick={() => void cleanGhosts(g)}
                          title={`把这 ${g.count} 条指向已不存在内容的列表项从索引里移除（只动索引，不碰正文）`}
                          className="flex items-center gap-1 px-2 py-0.5 text-11 rounded-md bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20 transition-colors"
                        >
                          <Trash2 size={11} /> 清理 {g.count} 条
                        </Button>
                      ))}
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
        </Panel>

        {/* ============ 投稿前自检（B2 · 2.4.1）：行文分布与节奏，纯本地统计 ============
            独立组件而非继续在本文件堆 —— 本文件已 500+ 行、是既定的「巨型组件收尾」对象。 */}
        <ManuscriptCheckPanel />

        {/* ============ 分平台投稿预检（C4 · 2.4.2）：按平台档位看命中与分章事实 ============
            与上面的「本章体检」分工：那个是单章确定性检查，这个按**平台**分档看全书。 */}
        <PlatformCheckPanel />

        {/* ============ 本章体检（C3 · 2.4.2）：单章串五个确定性引擎，全部本地 ============
            与上面「投稿前自检」分工：那个看全书分布，这个看单章确定性检查；与「节奏与章末钩子」分工：那个需 AI，这个纯本地。 */}
        <ChapterCheckPanel />

        {/* ============ 全书优化工单（P4 · 2.8.0）：全书诊断 → 勾选 → 逐章改写 → 前后对照 ============
            与「本章体检」分工：那个只读单章、只报告；这个汇总全书并且**能直接改**（复用整章改写链）。
            与「投稿前自检」分工：那个给分布事实，这个给可执行待办。 */}
        <OptimizeTicketPanel />

        {/* ============ 全书结构配比（A2 · 2.5.0）：模板理想节拍占比 vs 实际字数占比 ============
            纯本地、零 AI。与下面的「节奏与章末钩子」分工：这个看全书卷章结构，那个看单章内部节奏。 */}
        <StructurePacePanel />

        {/* ============ 节奏与章末钩子（B5 · 2.4.1）：单章 AI 审读 + 本地定位段位 ============
            与上面的「投稿前自检」分工：那个看全书分布（纯本地），这个看单章节奏（需 AI）。 */}
        <PaceAnalysisPanel />

        {/* ============ 读者视角审问（C5 · 2.4.2）：让 AI 扮成一个具体读者读这一章 ============
            与上面「节奏与章末钩子」分工：那个是结构视角（爆点位置 / 章末钩子，客观），
            这个是**读者视角**（走神 / 看不懂 / 想知道，主观）；两者都要 AI，但问的是不同的事。 */}
        <ReaderProbePanel />
      </div>
    </div>
  )
}
