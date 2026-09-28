/**
 * 正文编辑器的**纯函数、常量与模块级类型**（从 `useNovelEditorModel.ts` 拆出来的，2026-09-19 D4-2）。
 *
 * 【为什么单独成文件】它们是模块级件、不碰 React 状态，却被三处共用：
 *   · `scanRefHighlight` —— 高亮叠层与 textarea 盒模型逐项一致的前提（🔴 引用名高亮唯一入口）；
 *   · 卷/章重排算法 —— 拖拽排序与序号重排共用；
 *   · ghost 常量 —— 伴写防抖/缓存/熔断阈值。
 * 抽出来之后，任何一处改阈值都只有一个落点（原先散在 1100 行文件的中段，容易被误改）。
 *
 * 🔴 搬动时保住的红线：`scanRefHighlight` 的**行为一个字符都没动** —— 引用名按长度降序拼接
 *   （避免「陈渊」抢在「陈渊清欢」之前匹配）、超长正文降级只读纯文本、零宽匹配防御，全照原样。
 */
import type { Volume, Chapter } from '../lib/types'
import { chapterSeqMap, flattenChapters } from '../lib/chapterSeq'
import { syncChapterMaster } from '../lib/chapterMaster'

const HTML_ESCAPE_RE = /[&<>]/g
const HTML_ESCAPE_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
function escapeHtml(s: string): string {
  HTML_ESCAPE_RE.lastIndex = 0
  return HTML_ESCAPE_RE.test(s) ? s.replace(HTML_ESCAPE_RE, c => HTML_ESCAPE_MAP[c]) : s
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 超长正文降级阈值：超过则只读纯文本（仍转义），避免逐千字 + 数百引用名的扫描拖垮输入 */
const HIGHLIGHT_MAX_LEN = 60_000

export interface RefScan { html: string; hits: Set<string> }

/**
 * 一次正则扫描同时产出「命中的引用名」与「高亮 HTML」。
 *
 * ⚠️ 性能修复（2.0.1）：旧实现是两趟全量扫描——先在别处做
 *   `refNames.filter(r => text.includes(r.name))`（O(引用数 × 正文长度)），
 *   再用 `text.split(re)` 把所有片段摊成数组、逐段 escapeHtml 后 join。
 *   上百个引用名 + 上万字章节时，每 120ms 防抖就要跑几万次字符串操作，直接卡住输入，
 *   表现为「打开/切换到长章节明显变慢」。现改为一次 exec 循环流式拼接，命中集合用 Set。
 *
 * 引用名按长度降序拼接，避免「陈渊」抢在「陈渊清欢」之前匹配导致截断。
 */
export function scanRefHighlight(text: string, names: string[]): RefScan {
  const dict = [...new Set(names)].filter(n => n && n.length >= 2).sort((a, b) => b.length - a.length)
  if (dict.length === 0 || text.length > HIGHLIGHT_MAX_LEN) return { html: escapeHtml(text), hits: new Set() }
  const re = new RegExp(`(${dict.map(escapeRe).join('|')})`, 'g')
  const hits = new Set<string>()
  let html = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue } // 防御零宽匹配导致死循环
    if (m.index > last) html += escapeHtml(text.slice(last, m.index))
    html += `<mark class="ref-mark">${escapeHtml(m[0])}</mark>`
    hits.add(m[0])
    last = m.index + m[0].length
  }
  if (last < text.length) html += escapeHtml(text.slice(last))
  return { html, hits }
}

/** 工作区可用的引用名（角色卡 + 世界构建设定表条目），用于本章引用侧栏与内联高亮。
 *  别称条目也在此登记（aliasOf 指向原本名称），正文出现别称时高亮并归入原名条目。 */
export interface RefName { name: string; type: 'character' | 'setting'; tabId: string; aliasOf?: string }

// ---- AI 伴写（2.2.0）常量 ----
/** 停笔多久才请求。本地 27B 出一句话约 1~3s，太快会在正常停顿处疯狂起请求 */
export const GHOST_DEBOUNCE_MS = 800
/** 取光标前多少字作前文：两三千字足够带稳语气、人称与专名，再多是浪费上下文窗口 */
export const GHOST_CONTEXT_CHARS = 2000
/** 连续失败多少次自动静默禁用（避免每次停笔都白等一轮超时） */
export const GHOST_MAX_FAILS = 3
/** 同前文缓存上限（LRU） */
export const GHOST_CACHE_MAX = 20

/**
 * 全书顺序的章节平铺：卷按 order、卷内章按 order（同一口径也见于编辑器模型的 flat）。
 * 伴写取「上一章」必须走这个顺序 —— 跨卷时上一章＝上一卷的最后一章，而不是同卷的上一章。
 */
export function orderedChapters(vols: Volume[], chs: Chapter[]): Chapter[] {
  return vols.flatMap(v => chs.filter(c => c.volumeId === v.id).sort((a, b) => a.order - b.order))
}

/**
 * 伴写前文拼上一章（2026-09-28 · 章首语境补齐）：当前章光标前不足 limit 字时，
 * 用上一章末尾补齐差额，凑满 limit 字作上文 —— 章首几行字也能带稳上一章的语气、人称与情节惯性。
 * 当前章前文够长 / 上一章无正文（第一卷第一章、上一章还没写）时原样返回，行为与旧版零差异。
 */
export function stitchGhostBefore(currentBefore: string, prevTail: string, limit = GHOST_CONTEXT_CHARS): string {
  if (currentBefore.length >= limit || !prevTail) return currentBefore
  return prevTail.slice(-(limit - currentBefore.length)) + currentBefore
}


/**
 * v1.6.3：卷/章拖拽排序的纯计算函数（不触碰状态/存储，便于复用）。
 * order 字段决定排序；跨卷移动章节须同时改 volumeId + order。
 */
export function reorderVolumes(vols: Volume[], dragId: string, overId: string, pos: 'before' | 'after'): Volume[] {
  if (dragId === overId) return vols
  const sorted = [...vols].sort((a, b) => a.order - b.order)
  const fromIdx = sorted.findIndex(v => v.id === dragId)
  if (fromIdx < 0) return vols
  const [moved] = sorted.splice(fromIdx, 1)
  let toIdx = sorted.findIndex(v => v.id === overId)
  if (toIdx < 0) return vols
  if (pos === 'after') toIdx++
  sorted.splice(toIdx, 0, moved)
  return sorted.map((v, i) => ({ ...v, order: i }))
}

export function reorderChapters(chs: Chapter[], dragId: string, overId: string, pos: 'before' | 'after'): Chapter[] {
  if (dragId === overId) return chs
  const sorted = [...chs].sort((a, b) => a.order - b.order)
  const fromIdx = sorted.findIndex(c => c.id === dragId)
  if (fromIdx < 0) return chs
  const [moved] = sorted.splice(fromIdx, 1)
  let toIdx = sorted.findIndex(c => c.id === overId)
  if (toIdx < 0) return chs
  if (pos === 'after') toIdx++
  sorted.splice(toIdx, 0, moved)
  return sorted.map((c, i) => ({ ...c, order: i }))
}

/** 把章节移动（或追加）到目标卷；overId 为 null 表示追加到卷尾 */
export function moveChapterToVolume(ch: Chapter, targetVolId: string, targetChs: Chapter[], overId: string | null, pos: 'before' | 'after'): Chapter[] {
  const sorted = [...targetChs].sort((a, b) => a.order - b.order)
  const moved: Chapter = { ...ch, volumeId: targetVolId }
  if (overId == null) {
    sorted.push(moved)
  } else {
    let toIdx = sorted.findIndex(c => c.id === overId)
    if (toIdx < 0) { sorted.push(moved) }
    else { if (pos === 'after') toIdx++; sorted.splice(toIdx, 0, moved) }
  }
  return sorted.map((c, i) => ({ ...c, volumeId: targetVolId, order: i }))
}

/**
 * 重排后按**全局连续**重算「章节号」（1.9.2 起）。
 * 序号由 (卷序, 章序) 派生，与章节标题无关；标了「不计入序号」的章不占号。
 * 各章仍分别 resync 到自己所在卷的 chapter-vol-<vid> 台账表。
 */
export async function resyncChapterMasterNumbers(vols: Volume[], chs: Chapter[]) {
  const seqs = chapterSeqMap(vols, chs)
  const tasks: Promise<void>[] = []
  flattenChapters(vols, chs).forEach((c, i) => {
    tasks.push(syncChapterMaster(c, seqs.get(c.id) ?? 0, i))
  })
  await Promise.all(tasks)
}
