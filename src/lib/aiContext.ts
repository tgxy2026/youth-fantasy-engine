// ============ 全项目资料上下文 ============
//
// 作用：把当前项目的「所有设定资料」打包成一份紧凑的纯文本，作为 AI 的背景知识。
//
// 为什么要单独一层：
//   1. 模型有上下文长度上限（本地小模型尤其吃紧），必须按重要性排序 + 预算裁剪，
//      而不是把库里所有字符一股脑塞过去。
//   2. 页签是 schema 驱动的，这里也按 TABS 遍历，以后新增页签自动纳入，不用改这里。
//   3. 任一存储读取失败都不能拖垮整体——AI 只是锦上添花，拿不到资料就少带一段，
//      绝不能报错阻断作者。

import * as db from './db'
import { tabVisible, type VisCtx, TABS } from './schema'
import { readAliases } from './aliases'
import { sortChapters, flattenChapters, chapterSeqMap } from './chapterSeq'
import type { Chapter, TabDef, Volume } from './types'

export interface ProjectContextOptions {
  /** 总字符预算，默认 12000。本地小模型建议 6000~8000 */
  budget?: number
  /** 只包含这些页签（不传则按默认优先级全量） */
  onlyTabIds?: string[]
  /** 排除这些页签（例如「AI 整理」时正在整理的那张表另行单独完整给出） */
  excludeTabIds?: string[]
  /** 是否附带章节清单（卷 / 章标题 / 字数 / 摘要），默认 true */
  includeChapterList?: boolean
  /**
   * #015：焦点章节 id。指定后，上下文会优先带入与它**相关**的章节（人物共现 + 叙事邻接），
   * 而不是把章节清单从头截断 —— 长篇时后者喂给模型的往往只有开头几章，越写到后面越失准。
   */
  focusChapterId?: string
  /** 相关章节召回条数上限，默认 8 */
  relatedChapterLimit?: number
}

export interface ProjectContextResult {
  /** 拼好的上下文文本（可能为空串，表示项目还没填任何资料） */
  text: string
  /** 实际带入的段落名，供 UI 展示「已带入：世界设定 / 主要角色 …」 */
  sections: string[]
  /** 因预算不足被丢弃的段落名 */
  dropped: string[]
  chars: number
}

/**
 * 上下文段落优先级：越靠前越先塞进预算。
 * 依据：世界观与主角设定是一致性的根，其次是结构性大纲，最后才是运营台账。
 * 刻意排除 progress（写作进度）——纯码字流水，对模型是纯噪音。
 */
const PRIORITY: string[] = [
  'positioning',      // 作品定位
  'worldbase',        // 世界设定
  'power',            // 力量体系
  'master',           // 全书总纲
  'char-main',        // 主要角色
  'relations',        // 人物关系
  'char-secondary',   // 次要角色
  'terms',            // 名词术语
  'nations',          // 国家势力
  'geography',        // 地理风物
  'races',            // 种族生物
  'items',            // 物品资源
  'history',          // 历史事件
  'volume-outline',   // 分卷大纲
  'chapter-master',   // 章节总表
  'chapter-outline',  // 章节细纲
  'foreshadow',       // 伏笔追踪
  'timeline',         // 时间脉络
  'subplots',         // 支线剧情
  'secrets',          // 知情权限
  'hookpoints',       // 爽点节奏
  'char-npc',         // NPC 角色卡
  'style',            // 写作规范
  'changelog',        // 设定变更
  'ideas',            // 灵感素材
]

/** 各表最多带入的条目数（防止长篇几百行表格直接吃满预算） */
const ROW_CAP: Record<string, number> = {
  'char-main': 30,
  'char-secondary': 24,
  'char-npc': 20,
  relations: 60,
  terms: 60,
  'chapter-master': 60,
  'chapter-outline': 40,
}
const DEFAULT_ROW_CAP = 40

/** 单个字段值的字符上限，超出截断（设定里偶有超长自由文本） */
const CELL_CAP = 200

function clip(s: string, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** 表单/卡片的存储 key 形如「模块::字段」，取字段名 */
function fieldName(key: string): string {
  const i = key.lastIndexOf('::')
  return i >= 0 ? key.slice(i + 2) : key
}

/** 按 schema 里的模块顺序渲染表单型数据，空字段跳过 */
function renderForm(tab: TabDef, data: Record<string, string>): string {
  const lines: string[] = []
  const used = new Set<string>()
  for (const mod of tab.modules ?? []) {
    for (const f of mod.fields) {
      const key = `${mod.name}::${f.name}`
      const v = data[key] ?? data[f.name] ?? ''
      used.add(key)
      if (v.trim()) lines.push(`${f.name}：${clip(v, CELL_CAP)}`)
    }
  }
  // 兼容历史遗留 key（schema 改过字段名的老项目），不丢数据
  for (const [k, v] of Object.entries(data)) {
    if (used.has(k) || !v?.trim()) continue
    lines.push(`${fieldName(k)}：${clip(v, CELL_CAP)}`)
  }
  return lines.join('\n')
}

/** 卡片型（角色卡 / 分卷大纲 / 章节细纲）：每条一段 */
function renderCards(tab: TabDef, recs: { name: string; data: Record<string, string> }[]): string {
  const cap = ROW_CAP[tab.id] ?? DEFAULT_ROW_CAP
  const out: string[] = []
  for (const r of recs.slice(0, cap)) {
    const body = renderForm(tab, r.data)
    out.push(`【${r.name || '未命名'}】${body ? '\n' + body : ''}`)
  }
  if (recs.length > cap) out.push(`（另有 ${recs.length - cap} 条未列出）`)
  return out.join('\n')
}

/** 表格型：首行列名，之后每行用 ｜ 分隔（比 JSON 省 token 得多） */
function renderTable(tab: TabDef, rows: { data: Record<string, string> }[]): string {
  const cols = (tab.columns ?? []).map(c => c.name)
  if (cols.length === 0) return ''
  const cap = ROW_CAP[tab.id] ?? DEFAULT_ROW_CAP
  const use = rows.slice(0, cap).filter(r => cols.some(c => (r.data[c] ?? '').trim()))
  if (use.length === 0) return ''
  const out = [cols.join(' ｜ ')]
  for (const r of use) out.push(cols.map(c => clip(r.data[c] ?? '', CELL_CAP)).join(' ｜ '))
  if (rows.length > cap) out.push(`（另有 ${rows.length - cap} 行未列出）`)
  return out.join('\n')
}

/** 单个页签的资料段（空数据返回空串） */
async function sectionOf(tab: TabDef): Promise<string> {
  try {
    if (tab.type === 'form') return renderForm(tab, await db.getFormData(tab.id))
    if (tab.type === 'card') return renderCards(tab, await db.getCardRecords(tab.id))
    if (tab.type === 'table') return renderTable(tab, await db.getTableRows(tab.id))
  } catch {
    // 单段读取失败就当这段没有，不影响其他资料
  }
  return ''
}

/** 章节清单：卷 → 章（标题 / 字数 / 摘要），不含正文 */
export async function buildChapterDigest(maxChapters = 200): Promise<string> {
  let vols: Volume[] = []
  let chs: Chapter[] = []
  try {
    ;[vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
  } catch {
    return ''
  }
  if (chs.length === 0) return ''
  const lines: string[] = []
  // 必须按 (卷序, 章序) 展平：order 是卷内序号，直接全局按 order 排会把各卷同序号的章
  // 交错在一起，超过 maxChapters 截断时砍掉的子集也是错的（与 getChapterTexts 同源问题）。
  // 孤儿章（volumeId 指向不存在的卷）追加在叙事序末尾参与截断，否则会被 maxChapters 静默吞掉。
  const flat = flattenChapters(vols, chs)
  const orphans = chs.filter(c => !vols.some(v => v.id === c.volumeId))
  const sorted = [...flat, ...orphans]
  const listed = sorted.slice(0, maxChapters)
  const byVol = new Map<string, Chapter[]>()
  for (const c of listed) {
    const arr = byVol.get(c.volumeId) ?? []
    arr.push(c)
    byVol.set(c.volumeId, arr)
  }
  const volOrder = [...vols].sort((a, b) => a.order - b.order)
  const emit = (title: string, items: Chapter[]) => {
    if (items.length === 0) return
    lines.push(title)
    for (const c of items) {
      const sum = c.summary?.trim() ? ` — ${clip(c.summary, 120)}` : ''
      lines.push(`  ${c.title || '未命名章节'}（${c.wordCount || 0}字·${c.status}）${sum}`)
    }
  }
  for (const v of volOrder) emit(`◆ ${v.title || '未命名卷'}`, byVol.get(v.id) ?? [])
  const orphan = listed.filter(c => !volOrder.some(v => v.id === c.volumeId))
  emit('◆ 未分卷', orphan)
  if (sorted.length > listed.length) lines.push(`（另有 ${sorted.length - listed.length} 章未列出）`)
  return lines.join('\n')
}

/**
 * 已建档的角色姓名清单。
 * 用途：告诉模型「人物列只能填这些名字」，避免整理出「黑衣男子」「那个少年」这类无主人物。
 */
export async function loadCharacterNames(ctx: VisCtx = { type: 'full', features: [] }): Promise<string[]> {
  const npcDef = TABS.find(t => t.id === 'char-npc')
  // NPC 页签「可见」才纳入：此处不可写成 !tabVisible —— 那会让完整项目反而丢掉全部 NPC 姓名
  const showNpc = npcDef ? tabVisible(npcDef.id, ctx) : false
  const ids = ['char-main', 'char-secondary', ...(showNpc ? ['char-npc'] : [])]
  const out = new Set<string>()
  for (const id of ids) {
    try {
      for (const r of await db.getCardRecords(id)) {
        if (r.name?.trim()) out.add(r.name.trim())
        // v1.6：别称一并纳入——模型识别正文/关系里的别称，且不会把它当成无主人物
        for (const a of readAliases(id, r.data)) out.add(a)
      }
    } catch { /* 单个页签读失败就跳过 */ }
  }
  return [...out]
}

/** 取指定章节的完整正文（AI 整理 / 校对用），带总字符上限 */
export async function getChapterTexts(ids: string[], charCap = 20000): Promise<string> {
  if (ids.length === 0) return ''
  let chs: Chapter[] = []
  let vols: Volume[] = []
  try {
    ;[chs, vols] = await Promise.all([db.getAllChapters(), db.getAllVolumes()])
  } catch {
    return ''
  }
  // 必须按 (卷序, 章序) 排：order 是卷内序号，卷二第 1 章的 order 同样是 0，
  // 只按 order 排会让跨卷勾选的正文顺序错乱（1.9.2 修复）。
  const pick = sortChapters(
    vols,
    ids.map(id => chs.find(c => c.id === id)).filter((c): c is Chapter => !!c),
  )
  const out: string[] = []
  // 正文头带全局派生章号：模型引用「第N章」时与台账/时间线口径一致；
  // 「不计入序号」的章（seq=0）只给标题，避免模型臆造编号。
  const seqs = chapterSeqMap(vols, chs)
  let used = 0
  for (const c of pick) {
    const seq = seqs.get(c.id) ?? 0
    const head = `【${seq > 0 ? `第${seq}章 · ` : ''}${c.title || '未命名章节'}】\n`
    const room = charCap - used - head.length
    if (room <= 200) {
      out.push(`（其余章节因长度限制未带入）`)
      break
    }
    const body = c.content.length > room ? c.content.slice(0, room) + '…（本章后续因长度限制截断）' : c.content
    out.push(head + body)
    used += head.length + body.length
  }
  return out.join('\n\n')
}

/** 取最近 n 章有正文的章节（按真实叙事序），供「AI 深度审计」等全书级检查喂正文 */
export async function getRecentChapterTexts(n = 6, charCap = 16000): Promise<string> {
  try {
    const [vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
    const ids = flattenChapters(vols, chs).filter(c => c.content.trim()).slice(-n).map(c => c.id)
    return getChapterTexts(ids, charCap)
  } catch {
    return ''
  }
}

/** 拆「出场人物」类字段为名字集合（支持 、，,；;/| 分隔） */
function splitNames(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  return raw.split(/[、,，;；/|]/).map(s => s.trim()).filter(s => s.length > 0)
}

/**
 * #015 相关章节召回：找出与指定章节最相关的若干章（按真实叙事序返回）。
 *
 * 为什么需要：AI 上下文有长度预算，长篇时章节清单往往只能塞进开头一部分，
 * 于是写到第 300 章时，模型看到的「前文」还是第 1～20 章 —— 诊断自然失准。
 * 与其平铺截断，不如优先带与「当前这章」真正相关的章节。
 *
 * 打分规则：
 *   · 人物共现 ×2 —— 取自章节台账的「出场人物」字段（数据驱动，比解析章节标题可靠）
 *   · 叙事邻接加成 —— 紧邻的前后章 +2，隔一章 +1（连续性校验最吃这一档）
 * 台账未登记时退化为「正文中出现过的角色名」共现，仍好过纯截断。
 */
export async function findRelatedChapters(focusChapterId: string, limit = 8): Promise<Chapter[]> {
  let vols: Volume[] = []
  let chs: Chapter[] = []
  try {
    ;[vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
  } catch {
    return []
  }
  const flat = flattenChapters(vols, chs)
  const idx = flat.findIndex(c => c.id === focusChapterId)
  if (idx < 0 || flat.length <= 1) return []

  // 台账只读一次：既取焦点章的实体，也建好各章实体表
  let rows: { id: string; data?: Record<string, string> }[] = []
  try {
    rows = (await db.getAllChapterLedgerRows()) as unknown as { id: string; data?: Record<string, string> }[]
  } catch {
    rows = []
  }
  const entityOf = new Map<string, Set<string>>()
  for (const r of rows) entityOf.set(String(r.id), new Set(splitNames(r?.data?.['出场人物'])))

  let focusEntities = entityOf.get(`ch-${focusChapterId}`) ?? new Set<string>()
  // 台账没登记 → 退化为焦点章正文里出现过的角色名
  if (focusEntities.size === 0) {
    try {
      const names = await loadCharacterNames()
      const text = `${flat[idx].title} ${flat[idx].summary ?? ''} ${flat[idx].content ?? ''}`
      for (const n of names) if (n.length >= 2 && text.includes(n)) focusEntities.add(n)
    } catch {
      /* 拿不到角色名就只按邻接排序 */
    }
  }

  const scored = flat
    .map((c, i) => {
      if (c.id === focusChapterId) return { c, i, score: -1 }
      let score = 0
      if (focusEntities.size > 0) {
        const ents = entityOf.get(`ch-${c.id}`)
        if (ents && ents.size > 0) {
          let hit = 0
          for (const e of focusEntities) if (ents.has(e)) hit++
          score += hit * 2
        } else {
          // 台账缺登记时按正文共现补分
          const text = `${c.title} ${c.summary ?? ''} ${c.content ?? ''}`
          let hit = 0
          for (const e of focusEntities) if (text.includes(e)) hit++
          score += hit
        }
      }
      const d = Math.abs(i - idx)
      if (d === 1) score += 2
      else if (d === 2) score += 1
      return { c, i, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)

  return scored.slice(0, limit).map(x => x.c)
}

/**
 * 打包当前项目的全部设定资料。
 * 按 PRIORITY 顺序累加，超预算的段落被丢弃并记录在 dropped 里（UI 可提示作者）。
 */
export async function buildProjectContext(opts: ProjectContextOptions = {}): Promise<ProjectContextResult> {
  const budget = opts.budget ?? 12000
  const only = opts.onlyTabIds ? new Set(opts.onlyTabIds) : null
  const exclude = new Set(opts.excludeTabIds ?? [])

  const parts: string[] = []
  const sections: string[] = []
  const dropped: string[] = []
  let used = 0

  const push = (title: string, body: string) => {
    if (!body.trim()) return
    const block = `## ${title}\n${body.trim()}`
    if (used + block.length > budget) {
      dropped.push(title)
      return
    }
    parts.push(block)
    sections.push(title)
    used += block.length + 2
  }

  // 头部：项目基本信息 + 体量统计（几乎不占预算，但对模型判断"写到哪了"很关键）
  try {
    const pid = db.getCurrentProjectId()
    const proj = await db.getProject(pid)
    if (proj) {
      const st = await db.getProjectStats(pid).catch(() => ({ chapters: 0, words: 0, volumes: 0 }))
      const head = [
        `书名：${proj.name}`,
        proj.genre ? `类型：${proj.genre}` : '',
        proj.intro ? `简介：${clip(proj.intro, 200)}` : '',
        `体量：${st.volumes} 卷 / ${st.chapters} 章 / ${st.words} 字`,
      ]
        .filter(Boolean)
        .join('\n')
      push('作品概览', head)
    }
  } catch {
    // 拿不到项目信息也照常往下走
  }

  const byId = new Map(TABS.map(t => [t.id, t]))
  const ordered = PRIORITY.filter(id => byId.has(id))
  // 兜底：schema 里新增但没写进 PRIORITY 的页签，追加在末尾（除 progress）
  for (const t of TABS) {
    if (t.type !== 'form' && t.type !== 'card' && t.type !== 'table') continue
    if (t.id === 'progress' || ordered.includes(t.id)) continue
    ordered.push(t.id)
  }

  for (const id of ordered) {
    if (only && !only.has(id)) continue
    if (exclude.has(id)) continue
    const tab = byId.get(id)!
    // 章节总表按卷建表后，行分散在 chapter-vol-* 各表，需合并所有卷台账再渲染
    const body = id === 'chapter-master'
      ? renderTable(tab, await db.getAllChapterLedgerRows())
      : await sectionOf(tab)
    push(tab.name, body)
  }

  // #015：若指定焦点章节，优先召回与之相关的章节（人物共现 + 叙事邻接），
  // 取代"从头截断"——长篇时模型看到的"前文"不再只有开头几章，诊断更准。
  // 该段在「章节清单」之前注入，预算紧张时优先于通用清单占位。
  if (opts.focusChapterId) {
    try {
      const related = await findRelatedChapters(opts.focusChapterId, opts.relatedChapterLimit ?? 8)
      if (related.length > 0) {
        const relLines: string[] = [
          `（与当前章节关联度最高的 ${related.length} 章，含人物共现与叙事邻接，供判断前后文一致性）`,
        ]
        for (const c of related) {
          const sum = c.summary?.trim() ? ` — ${clip(c.summary, 120)}` : ''
          const snippet = c.content?.trim() ? '\n' + clip(c.content, 500) : ''
          relLines.push(`◆ ${c.title || '未命名章节'}（${c.wordCount || 0}字·${c.status}）${sum}${snippet}`)
        }
        push('相关章节召回', relLines.join('\n'))
      }
    } catch {
      /* 召回失败不阻断主流程，少带一段即可 */
    }
  }

  if (opts.includeChapterList !== false) {
    const digest = await buildChapterDigest()
    push('章节清单', digest)
  }

  // 被预算丢弃的段落必须在文末声明，否则模型会把自己没看到的资料当成不存在
  const note = dropped.length > 0
    ? `\n\n（注：以下资料因长度预算未带入本提示，仅供参考时留意其可能存在：${dropped.join('、')}）`
    : ''
  const text = parts.join('\n\n') + note
  return { text, sections, dropped, chars: text.length }
}
