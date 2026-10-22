// ============ AI 任务层 · 对外唯一入口（门面）============
// 2026-09-19 结构优化 D1：原 2,338 行的巨石已按域拆进 ./aiTasks/ 目录，本文件只做**再导出 + 提示词注册**。
//
// 分层约定（沿用原文件）：
//   ai.ts      —— 传输与配置（provider / chat / 就绪状态 / 设定补全）
//   aiContext  —— 全项目资料打包
//   aiTasks.ts —— 本文件（门面）；具体任务的 prompt 与结果解析在 ./aiTasks/*.ts
//
// 铁律：本层所有函数都是「可选增强」。调用方必须保证——
//   未配置模型 → 按钮禁用，绝不调用；调用失败 → 只提示，绝不破坏已有数据。
//
// 依赖方向（严格自下而上，禁止反向 import）：
//   ./aiTasks/stream（长文流式共享件）
//     ├─ ./aiTasks/extract → 供 creative 取类型
//     ├─ ./aiTasks/{organize, proofread, suggest, audit, jieWenJi, rewrite, inline, formSummary}
//     └─ ./aiTasks/creative
//
// 🔴 对外 API 的名字与签名一字未改 —— 13 处真 import（含 tests/）+ 2 处源码正则已同步指向新位置。
// ⚠️ 注册顺序 = 设置页显示顺序，见下方 PROMPT_ORDER（原注册表的书写顺序逐条还原）。
import { registerPrompt } from '@/lib/ai/promptSettings'
import type { PromptDef } from '@/lib/ai/promptSettings'
import { PLAN_COMPARE_PROMPTS } from '@/lib/aiTasks/planCompareAi'
import { ORGANIZE_PROMPTS } from '@/lib/aiTasks/organize'
import { PROOFREAD_PROMPTS } from '@/lib/aiTasks/proofread'
import { SUGGEST_PROMPTS } from '@/lib/aiTasks/suggest'
import { AUDIT_PROMPTS } from '@/lib/aiTasks/audit'
import { JIEWENJI_PROMPTS } from '@/lib/aiTasks/jieWenJi'
import { REWRITE_PROMPTS } from '@/lib/aiTasks/rewrite'
import { EXTRACT_PROMPTS } from '@/lib/aiTasks/extract'
import { INLINE_PROMPTS } from '@/lib/aiTasks/inline'
import { CREATIVE_PROMPTS } from '@/lib/aiTasks/creative'
import { PACE_PROMPTS } from '@/lib/aiTasks/pace'
import { READER_PROBE_PROMPTS } from '@/lib/aiTasks/readerProbe'
import { INSPIRATION_PROMPTS } from '@/lib/aiTasks/inspiration'
import { BOOKBREAK_SPLIT_PROMPTS } from '@/lib/aiTasks/bookBreakSplit'
import { TABLE_IMPORT_PROMPTS } from '@/lib/aiTasks/tableImport'
import { MARKET_RADAR_PROMPTS } from '@/lib/ai/marketRadar'
import { STYLE_FINGERPRINT_PROMPTS } from '@/lib/ai/styleFingerprint'
import { POST_PROCESS_PROMPTS } from '@/lib/aiTasks/postProcess'

export { rowFingerprint, aiOrganizeRows, keyRowToLine } from '@/lib/aiTasks/organize'
export type { OrganizeColumn, OrganizeRequest, OrganizeResult } from '@/lib/aiTasks/organize'
// 2026-09-20 拆分：`aiProofread`（混查五类）→ `aiProofreadText`（错别字/语病/标点，不读设定）
// 与 `aiProofreadLogic`（逻辑/设定矛盾，读设定）。两条独立提示词、两个独立入口。
export { aiProofreadText, aiProofreadLogic } from '@/lib/aiTasks/proofread'
export type { ProofreadIssue, ProofreadOptions, ProofreadResult } from '@/lib/aiTasks/proofread'
export { aiSuggestNames, aiReviewSensitive } from '@/lib/aiTasks/suggest'
export type { NameSuggestRequest, NameSuggestion, SensitiveHitInput, SensitiveReview } from '@/lib/aiTasks/suggest'
// 2026-09-26（2.5.1·A3）：灵感融合 —— 勾选灵感夹条目 → 融合成情节创意卡落推演画布；basedOn 溯源
export { aiFuseInspiration, parseFusedIdeas, INSPIRATION_PROMPTS } from '@/lib/aiTasks/inspiration'
export type { FuseIdeaRequest, FusedIdea } from '@/lib/aiTasks/inspiration'
// 2026-09-27（2.6.1·R2）：拆书 AI 章节边界识别 —— 本地正则认不出标题时按作者示例挑行；严格采信在 bookbreak/aiSplit
export { aiBookBreakSplitChapters, parseChapterLines, BOOKBREAK_SPLIT_PROMPTS } from '@/lib/aiTasks/bookBreakSplit'
export type { BookBreakSplitRequest } from '@/lib/aiTasks/bookBreakSplit'
// 2026-10-02（2.7.0·社区反馈）：表格批量导入 · AI 智能拆分 —— 把粘贴的表格/散文解析成多条表格行，供导入预览勾选
// 与「AI 整理」分工：整理是「从正文抽尚未登记的事实」（判重+增量），本任务是「把粘进来的内容解析成行」（不判重）
export { aiSplitTableRows } from '@/lib/aiTasks/tableImport'
export type { ImportSplitColumn, ImportSplitRequest, ImportSplitResult } from '@/lib/aiTasks/tableImport'
export { aiContinuityAuditWithStatus, aiAnalyzeFeedback, aiDiagnoseProject, aiForeshadowReviewWithStatus, aiDedupTerms, aiStyleCheck } from '@/lib/aiTasks/audit'
export type { ContinuityFinding, FeedbackEntry, FeedbackAnalysis, ProjectDiagnosis, ForeshadowReviewFinding, TermDupGroup, StyleCheckFinding } from '@/lib/aiTasks/audit'
export { aiEditorDiagnosis, aiChapterReview, aiOocCheck, aiOocCheckWithStatus, aiRewritePassage, aiContinuationAdvice, aiContinuePassage, aiPleasureCheck, aiOpeningCheck, aiBriefing, aiChapterSummary } from '@/lib/aiTasks/jieWenJi'
export type { EditorDiagnosis, ReviewDimension, ChapterReview, OocFinding, RewriteResult, ContinuationAdvice, ContinueAsk, PleasureReport, OpeningReport, BriefingReport } from '@/lib/aiTasks/jieWenJi'
export { CHAPTER_REWRITE_META, aiRewriteChapter, cleanChapterOutput, stripInlineMarkdown } from '@/lib/aiTasks/rewrite'
export type { ChapterRewriteAction, ChapterRewriteOpts } from '@/lib/aiTasks/rewrite'
export { SLOT_HINT, EXTRACT_FIELD_KEYS, EXTRACT_FIELDS_SPEC, extractSysFull, aiExtractSettingEntities, aiExtractSettingEntitiesWithStatus, parseExtractedEntities, parseExtractedEntitiesDetailed } from '@/lib/aiTasks/extract'
export type { SettingEntityType, ExtractedEntity } from '@/lib/aiTasks/extract'
export { INLINE_SUGGEST_LIMITS, trimInlineSuggestion, aiInlineSuggest, foldGhostNewlines } from '@/lib/aiTasks/inline'
export type { InlineSuggestLength, InlineSuggestOptions } from '@/lib/aiTasks/inline'
// 2026-09-20：`aiGenerateOutline`（从零排）与 `aiExtendOutline`（接着排）**合并为 `aiPlanOutline`** ——
// 差别只剩「材料装的是什么」，两条路产出的都是 `OutlineResult`（卷 + 章），落库走同一个 `commitOutline`。
export {
  DEFAULT_BIBLE_COUNTS, collectBibleEntities, aiGenerateBible, aiPlanOutline,
  MAX_OUTLINE_VOLUMES, MAX_CHAPTERS_PER_VOLUME, MAX_OUTLINE_CHAPTERS,
} from '@/lib/aiTasks/creative'
export type { BibleCounts, OutlineVolume, OutlineChapter, OutlineResult, PlanOutlineInput } from '@/lib/aiTasks/creative'
export { aiSummarizeFormSettings } from '@/lib/aiTasks/formSummary'
// 2026-09-22（2.4.1·B5）：节奏与章末钩子 —— 结构化输出，位置由 lib/paceAnalysis 本地换算
export { aiPaceAnalysis, PACE_PROMPTS } from '@/lib/aiTasks/pace'
export { parsePaceReport, PACE_SEGMENTS, HOOK_KINDS, PACE_BEAT_KINDS } from '@/lib/outline/paceAnalysis'
export type { PaceReport, PaceBeat, PaceDistribution, HookKind } from '@/lib/outline/paceAnalysis'
// 2026-09-23（2.4.2·C5）：读者视角审问 —— 扮演一个具体读者读这一章，三问；位置由本地换算
// 2026-09-26（2.5.1·D1）：身份可带自己的问题集（写作导师四问），questionsOf 是问题集单一源
export { aiReaderProbe, READER_PROBE_PROMPTS } from '@/lib/aiTasks/readerProbe'
export {
  READER_LENSES, READER_QUESTIONS, readerLensOf, questionsOf,
  parseReaderProbe, groupNotes, paragraphAt, readerProbeToText,
} from '@/lib/audit/readerProbe'
export type { ReaderLens, ReaderQuestion, ReaderNote, ReaderProbeResult } from '@/lib/audit/readerProbe'
// 2026-10-04（2.8.0 · #018）：市场雷达 —— 选题趋势参考。复用现成联网检索（webSearch），**只读不写项目数据**。
export { runMarketRadar, buildRadarQueries, RADAR_DISCLAIMER, RADAR_MAX_QUERIES, MARKET_RADAR_PROMPTS } from '@/lib/ai/marketRadar'
export type { RadarInput, RadarReport, RadarTrendItem, RadarSource } from '@/lib/ai/marketRadar'
// 2026-10-04（2.8.0 · #015）：文风指纹 —— 从参考文本提炼可命名文风档，续写 / 整章改写 / 伴写三处自动注入。
// 🔴 它只产出「注入文本」，**不写任何项目数据**（档按项目存在 settingsKV 前缀键里，不碰 volumes/chapters 那些）。
export {
  extractFingerprint, analyzeStyleMetrics, buildFingerprintNote, metricsLine,
  loadFingerprints, saveFingerprints, loadActiveFingerprint, loadActiveFingerprintId,
  saveActiveFingerprintId, upsertFingerprint, removeFingerprint, activeFingerprintNote,
  invalidateFingerprintCache, countPunctuation, countFourCharRuns, countDialogueWords,
  MIN_SAMPLE_WORDS, STYLE_FINGERPRINT_PROMPTS,
} from '@/lib/ai/styleFingerprint'
export type { StyleProfile, StyleMetrics, ExtractOptions } from '@/lib/ai/styleFingerprint'
// 2026-10-10（3.0 · W2-1）：章后整理抽取 —— 从本章正文抽「伏笔 / 关系 / 人物状态」三类变化候选。
// 🔴 AI 只抽候选，「是否已登记 / 是否真变了」由 lib/chapterPostProcess.ts 确定性比对。
export { aiExtractChapterChangesWithStatus, parseChapterChanges, parseChapterChangesDetailed, POST_PROCESS_PROMPTS } from '@/lib/aiTasks/postProcess'
export type { ChapterChanges, ExtractedForeshadow, ExtractedRelation, ExtractedStatus } from '@/lib/aiTasks/postProcess'
// 3.2.1 · T-09：细纲与正文对照（AI 语义判定 + 本地引文闸）
export { aiComparePlanWithBody, reviewPlanCompare, MAX_PLAN_COMPARE_ITEMS, PLAN_COMPARE_PROMPTS } from '@/lib/aiTasks/planCompareAi'
export type { PlanItemInput, PlanCompareReview, PlanCompareAiOutcome } from '@/lib/aiTasks/planCompareAi'

/**
 * 提示词的**注册顺序**（🔴 有语义：`listPrompts()` 只按 group 稳定排序，组内保持登记顺序）。
 *
 * 因此本数组的先后 = 「模型设置 → AI 提示词」界面里组内从上到下的顺序。
 * ⚠️ 改这个数组等于改 UI 顺序。新增提示词必须在这里登记，否则界面上看不到（下面会 console.warn 出来）。
 * ⚠️ 注意第 14/15 条：选区改稿（属于 jieWenJi）**排在**整章改写（属于 rewrite）之前 ——
 *    这是原文件注册表的书写顺序，属于既定 UI，别"顺手理顺"。
 */
const PROMPT_ORDER = [
  'organize-rows',
  'proofread-text',
  'proofread-logic',
  'name-suggest',
  'inspiration-fuse',
  'sensitive-recheck',
  'continuity-audit',
  'feedback-analysis',
  'project-diagnosis',
  'foreshadow-review',
  'term-dedup',
  'style-audit',
  'editor-diagnosis',
  'chapter-review',
  'ooc-check',
  'rewrite-passage',
  'chapter-rewrite',
  'chapter-rewrite-history',
  'chapter-rewrite-latest',
  'extend-outline',
  'continuation-advice',
  'pleasure-check',
  'opening-check',
  'pace-analysis',
  'reader-probe',
  'writing-briefing',
  'extract-entities',
  'bookbreak-split',
  'deai-rule',
  // 2.7.0 追加在末尾：既可读又不动其它条目的既有顺序（数组先后 = 组内 UI 顺序）
  'table-import-split',
  // 2.8.0 追加在末尾：市场雷达（#018）—— 只往末尾加，不动其它条目的既有 UI 顺序
  'market-radar',
  // 2.8.0 追加在末尾：文风指纹（#015）
  'style-fingerprint',
  // 2.9.2 追加在末尾：颉文姬续写 —— 只往末尾加，不动其它条目的既有 UI 顺序
  'continue-passage',
  // 3.0 追加在末尾：章后整理抽取（W2-1）—— 只往末尾加，不动其它条目的既有 UI 顺序
  'chapter-post-process',
  // 3.2.1 追加在末尾：细纲与正文对照（T-09）—— 只往末尾加，不动其它条目的既有 UI 顺序
  'plan-compare',
]

const PROMPT_SETS: PromptDef[][] = [
  ORGANIZE_PROMPTS,
  PROOFREAD_PROMPTS,
  SUGGEST_PROMPTS,
  INSPIRATION_PROMPTS,
  AUDIT_PROMPTS,
  JIEWENJI_PROMPTS,
  PACE_PROMPTS,
  READER_PROBE_PROMPTS,
  REWRITE_PROMPTS,
  EXTRACT_PROMPTS,
  BOOKBREAK_SPLIT_PROMPTS,
  INLINE_PROMPTS,
  CREATIVE_PROMPTS,
  TABLE_IMPORT_PROMPTS,
  MARKET_RADAR_PROMPTS,
  STYLE_FINGERPRINT_PROMPTS,
  POST_PROCESS_PROMPTS,
  PLAN_COMPARE_PROMPTS,
]

const byId = new Map<string, PromptDef>()
for (const set of PROMPT_SETS) for (const p of set) byId.set(p.meta.id, p)
for (const id of PROMPT_ORDER) {
  const p = byId.get(id)
  if (!p) {
    console.warn(`[aiTasks] PROMPT_ORDER 里的提示词没找到：${id}（设置页会少这一条）`)
    continue
  }
  registerPrompt(p.meta, p.read, p.write)
}
for (const id of byId.keys()) {
  if (!PROMPT_ORDER.includes(id)) console.warn(`[aiTasks] 提示词未登记进 PROMPT_ORDER：${id}（设置页看不到它）`)
}
