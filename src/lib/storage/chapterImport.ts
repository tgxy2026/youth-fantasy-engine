/**
 * 正文批量导入（3.0.1 · 方案 B）—— 把「在别处已经写好的大量正文」搬进正文编辑的卷/章。
 *
 * ## 它解决什么问题
 * 作者常年在别的软件 / 网页 / Word 里存稿，换到本项目时只能一章章手动复制。
 * 本模块提供一条**不依赖 AI** 的纯本地通路：选文件（或粘贴）→ 切成卷章 → 预览确认 → 落库到正文编辑。
 *
 * ## 支持格式
 * - `.txt` / `.md` / 无扩展名 → 按纯文本读（UTF-8；带 BOM 自动剥）
 * - `.docx` → 走 `docxImport.readDocxText`（手写零依赖解析，见该文件）
 * - `.json` → 本项目自定义的**导入格式**（见下方 `ImportJsonFile`），可无损往返
 * - `.doc`（旧二进制）→ 明确劝退（给「另存为 docx/txt」的提示），不静默失败
 *
 * ## 与「一键拆书」的关系
 * 拆书是「切分 + AI 抽设定」的大流程；本模块只做**切分 + 落库**这一段，
 * 复用同一套切分算法（`lib/bookbreak/split.ts`）与同一个落库口径（`lib/bookbreak/persist.ts`），
 * 保证两条通路的产物形状完全一致 —— 不会出现「拆书导进来是 A 样、批量导入是 B 样」。
 *
 * 🔴 三条纪律（与拆书落库一致）：
 *   ① **只追加，绝不覆盖**：新建卷接在已有卷之后，已有卷章分毫不动。
 *   ② **重复导入要能看出来**：同名卷 + 同章标题集合 → 判定「已导入过」整体跳过。
 *   ③ **写一半能停**：中止时返回已写入的部分，不留半截脏数据。
 */

import { splitNovelText, type SplitResult } from '@/lib/bookbreak/split'
import { readDocxText, isDocxFileName, isLegacyDocFileName } from '@/lib/storage/docxImport'
import { planVolumes, persistPlanToChapters, type PersistPlan, type PersistResult, type PlannedVolume } from '@/lib/bookbreak/persist'

/** 单文件大小上限（与拆书一致，20MB） */
export const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024

/** 一次最多导入的文件数（防止误选整个文件夹） */
export const MAX_IMPORT_FILES = 50

// ============ 导入格式（JSON） ============

/**
 * 本项目自定义的**正文导入 JSON 格式**（方案 B 的「JSON 双向」）。
 *
 * 设计目标：既能承接本项目自身导出的结构，也能让作者手写 / 让别的工具生成。
 * 🔴 向后兼容靠 `version` 字段；认不出的版本明确报错，不猜。
 */
export interface ImportJsonFile {
  /** 格式标识（可选；有则必须是下面这个值） */
  format?: 'youth-fantasy-engine-chapters'
  /** 格式版本（可选，默认 1） */
  version?: number
  /** 书名（可选，仅作参考，不写库） */
  book?: string
  /** 卷章结构 */
  volumes: ImportJsonVolume[]
}

export interface ImportJsonVolume {
  /** 卷名 */
  title: string
  /** 该卷的章 */
  chapters: ImportJsonChapter[]
}

export interface ImportJsonChapter {
  /** 章名（不含「第N章」编号 —— 编号由本项目系统派生，见 persist.stripChapterNumber） */
  title: string
  /** 正文 */
  content?: string
  /** 状态（可选；认不出就用「完稿」） */
  status?: string
  /** 是否不计入序号（可选；序章/番外/后记） */
  excludeFromNumbering?: boolean
}

// ============ 读文件 → 原始文本 / JSON ============

export type ImportSourceKind = 'text' | 'docx' | 'json'

export interface RawImport {
  /** 文件名（含扩展名） */
  fileName: string
  /** 读取方式 */
  kind: ImportSourceKind
  /** 纯文本（text/docx 有值；json 为空串） */
  text: string
  /** 解析出的 JSON 结构（仅 json 有值） */
  json: ImportJsonFile | null
  /** 本次实际发现但未读取的内容类型（docx 才有；诚实告知） */
  skipped: string[]
  /** 字符数（text/docx）或 null（json） */
  chars: number | null
}

/** 按扩展名判定读取方式（未知扩展名一律当纯文本，尽力而为） */
export function classifyImportFile(fileName: string): ImportSourceKind {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.docx')) return 'docx'
  return 'text'
}

/** 是否是我们接受的导入文件（.doc 故意收进来，好给明确劝退） */
export function isAcceptedImportFile(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return (
    lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.markdown') ||
    lower.endsWith('.docx') || lower.endsWith('.json') || lower.endsWith('.doc') ||
    !/\.[a-z0-9]+$/i.test(lower)  // 无扩展名
  )
}

/** 校验并规整 JSON 结构（纯函数，可单测）。失败抛「能直接给用户看」的中文原因。 */
export function parseImportJson(raw: string): ImportJsonFile {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    throw new Error('JSON 解析失败：文件不是合法的 JSON（请检查是否损坏或含多余字符）')
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('JSON 顶层必须是对象，且含 volumes 数组')
  }
  const o = obj as Record<string, unknown>
  if (o.format !== undefined && o.format !== 'youth-fantasy-engine-chapters') {
    throw new Error(`这不是本项目的正文导入格式（format=${String(o.format)}）`)
  }
  if (o.version !== undefined && (typeof o.version !== 'number' || o.version > 1)) {
    throw new Error(`导入格式版本过高（version=${String(o.version)}），请升级软件后再试`)
  }
  if (!Array.isArray(o.volumes)) {
    throw new Error('JSON 里没有 volumes 数组（应为：{ "volumes": [{ "title": "卷一", "chapters": [...] }] }）')
  }
  const volumes: ImportJsonVolume[] = []
  for (let i = 0; i < o.volumes.length; i++) {
    const v = o.volumes[i] as Record<string, unknown>
    if (!v || typeof v !== 'object') throw new Error(`第 ${i + 1} 个卷不是对象`)
    const title = typeof v.title === 'string' ? v.title.trim() : ''
    if (!title) throw new Error(`第 ${i + 1} 个卷缺少 title`)
    if (!Array.isArray(v.chapters)) throw new Error(`卷「${title}」缺少 chapters 数组`)
    const chapters: ImportJsonChapter[] = []
    for (let j = 0; j < v.chapters.length; j++) {
      const c = v.chapters[j] as Record<string, unknown>
      if (!c || typeof c !== 'object') throw new Error(`卷「${title}」第 ${j + 1} 章不是对象`)
      const ct = typeof c.title === 'string' ? c.title.trim() : ''
      if (!ct) throw new Error(`卷「${title}」第 ${j + 1} 章缺少 title`)
      chapters.push({
        title: ct,
        content: typeof c.content === 'string' ? c.content : '',
        ...(typeof c.status === 'string' ? { status: c.status } : {}),
        ...(c.excludeFromNumbering === true ? { excludeFromNumbering: true } : {}),
      })
    }
    volumes.push({ title, chapters })
  }
  if (volumes.length === 0) throw new Error('JSON 里没有任何卷')
  return { format: 'youth-fantasy-engine-chapters', version: 1, volumes, ...(typeof o.book === 'string' ? { book: o.book } : {}) }
}

/** 从 File 读出一个 `RawImport`。失败一律抛「能直接给用户看」的中文原因。 */
export async function readImportFile(f: File): Promise<RawImport> {
  if (f.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error(`「${f.name}」超过 20MB，请先拆成若干份再导入`)
  }
  if (isLegacyDocFileName(f.name)) {
    throw new Error('「' + f.name + '」是旧版 .doc 二进制格式，请在 Word 里「另存为」.docx 或 .txt 后再导入')
  }
  const kind = classifyImportFile(f.name)
  if (kind === 'json') {
    const json = parseImportJson(await f.text())
    return { fileName: f.name, kind, text: '', json, skipped: [], chars: null }
  }
  if (kind === 'docx' || isDocxFileName(f.name)) {
    const { text, skipped } = await readDocxText(await f.arrayBuffer())
    if (!text.trim()) throw new Error(`「${f.name}」里没抽到正文（可能整篇都在文本框或图片里）`)
    return { fileName: f.name, kind: 'docx', text, json: null, skipped, chars: text.length }
  }
  // 纯文本：剥掉 UTF-8 BOM（记事本另存常带）
  const text = (await f.text()).replace(/^\uFEFF/, '')
  return { fileName: f.name, kind: 'text', text, json: null, skipped: [], chars: text.length }
}

// ============ 原始文本 → 预览计划（卷 / 章，可编辑） ============

/** 预览用的一个章（可被作者改名 / 剔除） */
export interface PreviewChapter {
  /** 稳定 id（预览内用，落库时另分配真 id） */
  key: string
  title: string
  content: string
  /** 是否勾选导入（默认 true） */
  include: boolean
  /** 来源文件名（多文件时用于溯源） */
  source: string
}

/** 预览用的一个卷（可被作者改名 / 剔除） */
export interface PreviewVolume {
  key: string
  title: string
  chapters: PreviewChapter[]
}

/** 预览整体（呈现给作者，确认后才落库） */
export interface ImportPreview {
  volumes: PreviewVolume[]
  totalChapters: number
  totalWords: number
  /** 被剔空 / 空卷丢弃的说明（诚实告知） */
  notes: string[]
  /**
   * 本地切分的识别状态（3.0.1 增）：
   *   'chapters' = 认出了章节标题，按标题切章；
   *   'chunks'   = 没认出章节标题，退化成按段落分块（此时界面应引导去「一键拆书」用 AI 按标题样式识别）；
   *   'given'    = 结构已给定（JSON 导入）/ 多份合并，无需切分。
   * 缺省视为 'given'（旧数据 / 合并结果）。
   */
  splitMode?: 'chapters' | 'chunks' | 'given'
}

let previewSeq = 0
const nextKey = (prefix: string) => `${prefix}-${++previewSeq}`

/**
 * 由**单份原始文本**生成预览（走拆书的切分 + 分层算法）。
 * 这是「整本一个大文件自动切卷章」那条路。
 */
export function previewFromText(text: string, source: string, volumeTitle?: string): ImportPreview {
  if (!text.trim()) return { volumes: [], totalChapters: 0, totalWords: 0, notes: ['内容为空'], splitMode: 'chunks' }
  const sp: SplitResult = splitNovelText(text, { maxChunks: 9999 })
  const plan: PersistPlan = planVolumes(sp, volumeTitle !== undefined ? { volumeTitle } : {})
  const notes: string[] = []
  if (sp.mode === 'chunks') {
    notes.push('没有识别到章节标题，已按段落分成若干「第N段」；可导入后在正文编辑里逐章改名。')
  }
  const volumes: PreviewVolume[] = plan.volumes.map(v => ({
    key: nextKey('v'),
    title: v.title,
    chapters: v.chapters.map(c => ({
      key: nextKey('c'),
      title: c.title,
      content: c.text,
      include: true,
      source,
    })),
  }))
  return { volumes, totalChapters: plan.chapterCount, totalWords: plan.words, notes, splitMode: sp.mode }
}

/**
 * 由 **JSON 结构**生成预览（`.json` 文件那条路；结构已明确，无需切分）。
 */
export function previewFromJson(json: ImportJsonFile, source: string): ImportPreview {
  const volumes: PreviewVolume[] = json.volumes.map(v => ({
    key: nextKey('v'),
    title: v.title,
    chapters: v.chapters.map(c => ({
      key: nextKey('c'),
      title: c.title,
      content: c.content ?? '',
      include: true,
      source,
    })),
  }))
  const totalChapters = volumes.reduce((n, v) => n + v.chapters.length, 0)
  const totalWords = volumes.reduce((n, v) => n + v.chapters.reduce((m, c) => m + countWordsLoose(c.content), 0), 0)
  return { volumes, totalChapters, totalWords, notes: [], splitMode: 'given' }
}

/** 合并多份预览（多文件批量导入：按传入顺序首尾相接） */
export function mergePreviews(previews: ImportPreview[], notes: string[] = []): ImportPreview {
  const volumes: PreviewVolume[] = []
  const allNotes = [...notes]
  // 合并后结构由多份来源拼成，统一标 'given'：不再对整体做「识别成功/失败」的单一判断
  for (const p of previews) {
    for (const v of p.volumes) {
      // 同名卷合并到同一条（作者选了一堆「第X卷.txt」时更合理）
      const hit = volumes.find(x => x.title === v.title)
      if (hit) hit.chapters.push(...v.chapters)
      else volumes.push({ key: nextKey('v'), title: v.title, chapters: [...v.chapters] })
    }
    allNotes.push(...p.notes)
  }
  const totalChapters = volumes.reduce((n, v) => n + v.chapters.length, 0)
  const totalWords = volumes.reduce((n, v) => n + v.chapters.reduce((m, c) => m + countWordsLoose(c.content), 0), 0)
  return { volumes, totalChapters, totalWords, notes: allNotes, splitMode: 'given' }
}

/** 轻量字数（预览用，避免依赖编辑器模块；中文按字、英文按词） */
function countWordsLoose(text: string): number {
  const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const en = (text.replace(/[\u4e00-\u9fff]/g, ' ').match(/[a-zA-Z0-9]+/g) || []).length
  return cn + en
}

/** 预览 → 落库计划（过滤掉未勾选的章与空卷）。纯函数。 */
export function previewToPlan(preview: ImportPreview): PersistPlan {
  const volumes: PlannedVolume[] = []
  let chapterCount = 0
  let words = 0
  for (const v of preview.volumes) {
    const chapters = v.chapters
      .filter(c => c.include && c.content.trim())
      .map(c => ({ title: c.title.trim() || '未命名', text: c.content, sourceIndex: 0 }))
    if (chapters.length === 0) continue
    volumes.push({ title: v.title.trim() || '导入正文', chapters })
    chapterCount += chapters.length
    words += chapters.reduce((m, c) => m + countWordsLoose(c.text), 0)
  }
  return { volumes, chapterCount, words }
}

// ============ 落库（把预览写进正文编辑） ============

export interface CommitImportOptions {
  /** 中止信号 */
  signal?: AbortSignal
  /** 每写完一章回调一次（done 从 1 起） */
  onProgress?: (done: number, total: number) => void
}

/**
 * 把预览写入当前项目的正文编辑。
 *
 * 落库本体复用拆书的 `persistPlanToChapters`（只追加 / 重复守卫 / 可中止三条纪律同源），
 * 此处只负责把预览换算成计划并转发。
 */
export async function commitImportPreview(
  preview: ImportPreview,
  opts: CommitImportOptions = {},
): Promise<PersistResult> {
  const plan = previewToPlan(preview)
  return persistPlanToChapters(plan, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  })
}
