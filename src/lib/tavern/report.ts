/**
 * 酒馆模式 · 推演报告生成（方案 §6.6 / §6.7）
 *
 * 报告的价值全在 `findings[]`：**每条必须能指回具体条目**
 * （targetTabId + targetRecordId + targetLabel）。否则作者拿到的是一堆
 * 「感觉有点问题」的废话，没法处理。
 *
 * 因此这里做两件事：
 *   1. 提示词要求模型给出「指向哪张表 + 指向谁」
 *   2. **回填 targetRecordId** —— 拿到 label 后回表里查真实记录 id；
 *      查不到就把该条降级为「存疑」并留空 id（UI 单独分组显示），而不是硬编一个假 id
 *
 * 只诊断、不写回任何项目表（作者已定）。
 */
import { chat, isCancelled } from '@/lib/ai'
import * as db from '@/lib/db'
import { TABS } from '@/lib/schema'
import { parsePlainObject, parseObjectArray, asText } from '@/lib/ai/aiParse'
import { uid } from '@/lib/app/id'
import { resolveTavernProvider, type ChatFn } from '@/lib/tavern/provider'
import { getTavernSettings, timeoutMsOf } from '@/lib/tavern/settings'
import { authorBlock, newAuthorFence } from '@/lib/ai/promptGuard'
import type { TavernSession, TavernReport, TavernFinding, TavernFindingLevel } from '@/lib/tavern/types'
import { withIndependentAttribution } from '@/lib/tavern/attribution'

/**
 * 可被指向的表（白名单）：只允许指向**能定位到具体条目**的页签。
 *
 * 🔴 审计 P1-5：这里曾经把 `worldbase` / `power` 也放进来 —— 它们是 `type: 'form'` 的
 *    **单表单**页签，压根没有「哪一条记录」的概念。模型指对了也只会切个页签、指不到任何东西，
 *    等于给作者一个点过去发现没反应的链接。所以只留两类：
 *      · `type: 'table'` —— 走 `TableSheet` 的 `focusRowId`（高亮并滚到那一行）
 *      · `type: 'card'`  —— 走 `CharacterSheet` 的多记录目录（选中并打开那张卡）
 * ⚠️ 新增条目时请先确认该页签属于上面两类之一。
 */
const TARGETABLE = [
  'char-main', 'char-secondary', 'char-npc', 'relations', 'secrets',
  'terms', 'nations', 'geography', 'races', 'items', 'history',
  'timeline', 'foreshadow',
]

const REPORT_SYS = `你是小说的一致性与合理性审读员。作者刚刚扮演一个角色、你扮演了另一个角色，
试演了一场戏。现在请判断：**这场戏里的角色反应，与项目设定是否自洽**。

只做诊断，不要改写剧情，不要给写作建议（除非直接关系到设定矛盾）。

对每条问题，必须给出：
- level：三档之一
    「矛盾」= 与已有设定明确冲突（姓名、身份、境界、势力归属、已发生的事对不上）
    「漏洞」= 设定缺失或逻辑跳跃（该有交代的地方没有，行为缺乏动机）
    「存疑」= 你有疑虑，但**指不出具体条目**（这类会被单独分组）
- targetTabId：问题出在哪张表。可选值：${TARGETABLE.join(' / ')}
- targetLabel：指向那条记录的名称（人物名、条目名）。矛盾与漏洞**必须给**；存疑可留空
- detail：问题描述，一句话说清「哪里对不上」
- suggestion：可选的修改建议

宁可少报几条，也不要凑数。没有发现问题就返回空数组。`

/**
 * 模糊命中**只在唯一时**采用。
 *
 * 为什么必须唯一：本模块的全部价值就是「每条问题能指回具体条目」——
 * 命中多条时宁可当作定位失败（调用方会把「存疑」降级处理），也不能静默指错一条。
 */
function fuzzyUnique<T>(rows: T[], pick: (r: T) => string, needle: string): T | undefined {
  const hits = rows.filter(r => {
    const v = pick(r)
    if (!v) return false
    // 🔴 2026-09-22 六维审计 P2：只允许「记录名以 label 开头」或全等，去掉 `needle.includes(v)`
    //    —— 那个方向会把「label 是长句、某条记录名恰是其子串」也判成命中，
    //    于是作者被引到一条**并非模型所指**的记录上（虽有唯一性闸兜底，但闸只看命中条数）。
    //    与红线「判定/匹配一律整行・整词，禁子串」同口径。
    return v === needle || v.startsWith(needle)
  })
  return hits.length === 1 ? hits[0] : undefined
}

/** 按 label 回表里查真实记录 id（best-effort；查不到就留空，由调用方降级） */
async function resolveTargetRecord(tabId: string, label: string): Promise<string | null> {
  if (!tabId || !label) return null
  const tab = TABS.find(t => t.id === tabId)
  if (!tab) return null
  const needle = label.trim()
  if (!needle) return null
  try {
    if (tab.type === 'card') {
      const recs = await db.getCardRecords(tabId)
      const hit = recs.find(r => r.name === needle) ?? fuzzyUnique(recs, r => String(r.name ?? ''), needle)
      return hit?.id ?? null
    }
    if (tab.type === 'table') {
      const rows = await db.getTableRows(tabId)
      const col = tab.displayCol
      const hit = col
        ? rows.find(r => String(r.data?.[col] ?? '') === needle) ?? fuzzyUnique(rows, r => String(r.data?.[col] ?? ''), needle)
        : undefined
      return hit?.id ?? null
    }
  } catch {
    /* 查不到就当定位失败，交由调用方降级 */
  }
  return null
}

export type ReportOptions = {
  signal?: AbortSignal
  /** 模型调用注入点（见 engine.ts 的 ChatFn）；不传即用真实 chat */
  chatFn?: ChatFn
  onPhase?: (phase: string) => void
  /** 对话正文送入报告的最大字符数（超出取最近的） */
  maxTranscriptChars?: number
}

/**
 * 把模型给出的原始条目规范化：**回填真实记录 id**，定位不到就把该条降级为「存疑」（方案 §6.7）。
 * resolver 以参数注入，便于单测；生产环境传 resolveTargetRecord（回表里按名称查 id）。
 */
export async function normalizeFindings(
  raw: Record<string, unknown>[],
  resolve: (tabId: string, label: string) => Promise<string | null>,
): Promise<TavernFinding[]> {
  const findings: TavernFinding[] = []
  for (const it of raw) {
    const levelRaw = asText(it.level ?? it.等级 ?? '').trim()
    // 先排否定：「无矛盾 / 没有漏洞 / 未发现矛盾」是「没问题」，别被子串匹配误判成「矛盾」
    // 🔴 否定判据原先只看**行首**（2026-09-20 六维审计 P2）——「基本没有矛盾」「未发现任何漏洞」
    //    这类"否定词不在开头"的写法会漏网，随后被子串匹配判成「矛盾」。
    //    现在放宽成"否定词出现在关键词前 6 字内"，同时保留行首那条最常见的形态。
    const negated = /^\s*(无|没|未|不)/.test(levelRaw)
      || /(无|没有|没|未|不)[^，。；、]{0,6}(矛盾|漏洞|问题)/.test(levelRaw)
    let level: TavernFindingLevel
    if (negated) level = '存疑'
    /**
     * 等级判定：**整词 + 前后缀**双向匹配（2026-10-02 六维审计 P2 修订）。
     *
     * 🔴 为什么不能只用 `startsWith`（上一版的错法）：模型实际输出的是**前缀式**等级 ——
     *    「严重矛盾」「逻辑漏洞」而不是干净的「矛盾」「漏洞」；只判 `startsWith` 会全落进「存疑」，
     *    报告里一个矛盾都看不到（`tavernReport` 测试就是钉这一条的）。
     * 🔴 为什么又不能回到 `includes`：项目红线（同 `fuzzyUnique`、同六维审计口径）要求
     *    **禁子串匹配** ——「逻辑漏洞较多」这种长句用 `includes` 会被判成「漏洞」，与模型原意背离。
     * ⇒ 正解：**短等级词出现在开头或结尾就算命中**（长度受限、方向受限），
     *    既接住「严重矛盾 / 逻辑漏洞」，又不让「逻辑漏洞较多」这种长句蒙混过关。
     */
    else if (levelRaw === '矛盾' || levelRaw.startsWith('矛盾') || levelRaw.endsWith('矛盾')) level = '矛盾'
    else if (levelRaw === '漏洞' || levelRaw.startsWith('漏洞') || levelRaw.endsWith('漏洞')) level = '漏洞'
    else level = '存疑'
    const targetTabId = asText(it.targetTabId ?? it.表 ?? '').trim()
    const targetLabel = asText(it.targetLabel ?? it.条目 ?? it.指向 ?? '').trim()
    const detail = asText(it.detail ?? it.问题 ?? it.描述 ?? '').trim()
    if (!detail) continue

    // 回填真实记录 id。表不在白名单就直接不查 —— 省一次库读，也避免拿非法表去 UI 跳转
    const validTab = TARGETABLE.includes(targetTabId)
    let targetRecordId: string | undefined
    if (validTab && targetLabel) {
      const rid = await resolve(targetTabId, targetLabel)
      if (rid) targetRecordId = rid
      // 「矛盾 / 漏洞」却指不回具体条目 → 降级为「存疑」（方案 §6.7：这类单独分组显示，
      // 不硬编一个假 id 让作者点了跳空）
      else if (level !== '存疑') level = '存疑'
    } else if (level !== '存疑') {
      // 没给条目名、或表不在白名单 —— 同样属于「指不回去」，按同一规矩降级
      level = '存疑'
    }

    findings.push({
      id: uid(),
      level,
      targetTabId: validTab ? targetTabId : '',
      targetRecordId,
      targetLabel: targetLabel || undefined,
      detail,
      suggestion: asText(it.suggestion ?? it.建议 ?? '').trim() || undefined,
    })
  }

  return findings
}

/**
 * 生成推演报告。**不落库**（调用方决定保存时机）。
 */
/**
 * 生成推演报告。**不落库**（调用方决定保存时机）。
 */
export async function generateReport(session: TavernSession, opts: ReportOptions = {}): Promise<TavernReport> {
  const { provider } = await resolveTavernProvider(session.model)
  const cap = opts.maxTranscriptChars ?? 12000

  // 场景 + 对话正文（超出上限时保留最近的）
  const sceneLine = [
    session.scene.place && `地点：${session.scene.place}`,
    session.scene.time && `时间：${session.scene.time}`,
    session.scene.present.length && `在场：${session.scene.present.join('、')}`,
  ].filter(Boolean).join(' · ')
  const castLine = session.cast.map(c => `${c.name}（${c.role === 'user' ? '作者扮演' : c.role === 'ai' ? 'AI 扮演' : '在场不出声'}）`).join('、')
  const transcript = session.messages
    // 🔴 2026-09-22 六维审计 P1：**必须同滤 hidden**。
    //    「隐藏 = 不进上下文」是本项目对作者的一致承诺（prompt.ts / memory.ts / revise.ts 都这么滤），
    //    报告只滤 system 会漏 —— 作者特意藏起来的内容反倒成了判定合理性的依据，
    //    与下面「请按角色当场能知道的信息判断」的〖信息边界〗自相矛盾。
    .filter(m => m.role !== 'system' && !m.hidden)
    .map(m => `${m.role === 'user' ? '〖作者〗' : '〖AI〗'}${m.content}`)
    .join('\n')
  const body = transcript.length > cap ? transcript.slice(-cap) : transcript

  const user = [
    `〖叙事锚点〗${session.anchorChapterLabel || '（未标注）'}`,
    `〖参演角色〗${castLine || '（未分配）'}`,
    sceneLine ? `〖场景〗${sceneLine}` : '',
    session.scene.description ? `〖场景补充〗${session.scene.description}` : '',
    session.mode === 'immersive'
      ? '〖信息边界〗沉浸推演 —— 请按「角色当场能知道的信息」判断合理性，不要用后面的剧情要求它。'
      : '〖信息边界〗导演推演 —— 可参照设定判断，但仍以锚点时刻的状态为准。',
    '',
    '〖推演记录〗',
    // 🔴 包边界（审计 P1-12）：推演记录是作者与模型写的自由文本
    body ? authorBlock(newAuthorFence(), body) : '（这场没有对话内容）',
    '',
    '请输出 JSON：{"overview": "三五句话评价这场戏成不成立", "findings": [ ... ]}',
  ].filter(Boolean).join('\n')

  const runChat = withIndependentAttribution(opts.chatFn ?? chat)
  opts.onPhase?.('分析推演记录')
  const reply = await runChat(
    provider,
    [{ role: 'system', content: REPORT_SYS }, { role: 'user', content: user }],
    { timeoutMs: timeoutMsOf(await getTavernSettings()), signal: opts.signal, json: true, think: false },
  )

  const obj: Record<string, unknown> = parsePlainObject(reply) ?? {}
  const overview = asText(obj.overview ?? obj.概览 ?? '').trim() || '（模型未给出概览）'

  // 优先取解析出来的对象里的数组（模型返回的 {overview, findings[]} 已是结构化数组）；
  // 拿不到再退回按文本解析 —— 直接对整段 reply 切片有风险：overview 里若含「[」，切片会切错位置。
  const findingsRaw = obj.findings ?? obj.问题
  const rawFindings: Record<string, unknown>[] = Array.isArray(findingsRaw)
    ? (findingsRaw as Record<string, unknown>[])
    : parseObjectArray(reply)
  const findings = await normalizeFindings(rawFindings, resolveTargetRecord)

  return {
    id: uid(),
    projectId: db.getCurrentProjectId(),
    sessionId: session.id,
    sessionTitle: session.title,
    anchorChapterId: session.anchorChapterId,
    anchorChapterLabel: session.anchorChapterLabel,
    cast: session.cast,
    mode: session.mode,
    overview,
    findings,
    createdAt: Date.now(),
  }
}

export { isCancelled }
