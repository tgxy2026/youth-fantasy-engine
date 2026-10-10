/**
 * 酒馆模式 · 文档导出（路线图第 7 批 B5）
 *
 * 定位：把一场戏**带走**。推演完的东西留在软件里，作者没法拿去改稿、发群、存档；
 * 这里把它变成两种通用格式：
 *   · Markdown（.md）—— 给写作软件 / 笔记用，还能接着编辑
 *   · 单文件 HTML（.html）—— 排版好的阅读稿，双击就能看、能打印、能直接发给别人
 *
 * ── 架构：先建中立文档模型（DocModel），再渲染成两种格式 ──
 * 两种格式各自去读一遍会话，等于把「谁是说话人 / 隐藏消息怎么办 / 状态行怎么分类」
 * 这套逻辑写两遍 —— 本项目对「两处各写一份必然漂移」已有多次教训（TavernMessage、paramGuide）。
 * 所以：**builder 只产出模型，renderer 只消费模型**，渲染器完全不认识 TavernSession。
 *
 * 🔴 行类型判定（对白 / 动作 / 环境 / 状态）与界面渲染**共用** `classifyTavernLine`
 *    （TavernMessage.tsx 也调它）：两边样式可以不同，但「这一行算什么」必须同源。
 *
 * 📌 导出件是**独立文档**，不跟随软件主题 —— HTML 用中性的纸面排版，
 *    只在深浅色之间靠 `prefers-color-scheme` 自适应，打印另有一套。
 *    理由：导出的东西要发给别人、要打印、要在别的软件里打开，跟着 8 套主题走没有意义。
 */
import type { TavernMessage, TavernSession, TavernReport, FreeSession } from '@/lib/tavern/types'

// ==================== 行类型（与界面渲染同源） ====================

export type TavernLineKind = 'action' | 'state' | 'speech'

/**
 * 按行首符号判定这一行是什么（协议 O1）。
 * 认不出就算对白 —— 宁可样式朴素，也不能吃掉正文。
 *
 * ⚠️ v1.7 起只有三种：**（ ）**除对白外的一切 / **〔 〕**状态块 / 其余对白。
 *    旧的【】环境样式**已彻底移除**（老大 2026-09-15 定：测试阶段不留兼容，旧对话按对白渲染即可）。
 */
export function classifyTavernLine(line: string): TavernLineKind {
  const t = String(line ?? '').trim()
  if (t.startsWith('（') || t.startsWith('(')) return 'action'
  if (t.startsWith('〔')) return 'state'
  return 'speech'
}

/** 拆成非空行（与界面渲染同一套「按行 trim、丢空行」） */
export function tavernLines(content: string): string[] {
  return String(content ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
}

// ==================== 中立文档模型 ====================

export type DocItem = {
  /** 小标签（报告的三档：矛盾 / 漏洞 / 存疑） */
  tag?: string
  /** 粗体小标题（如「角色卡 · 小满」） */
  title?: string
  text: string
  /** 次级说明（如「建议：…」） */
  sub?: string
}

export type DocBlock =
  | { type: 'section'; text: string }
  | { type: 'para'; text: string }
  | { type: 'items'; items: DocItem[] }
  | { type: 'note'; text: string }
  /**
   * **原文块**：保留行首缩进与换行，原样呈现。
   *
   * 🔴 为什么不能拿 `para` 装正文：`para` 会逐行 `trim()` —— 那正好抹掉作者手写的
   *    段首缩进（2026-09-21 A5 在导出侧刚踩过同一个坑）。正文、旧稿这类**排版本身是内容**
   *    的文本，必须走这里。`label` 是可选的块标题（如「初稿 · 2026-09-20 11:30」）。
   */
  | { type: 'pre'; text: string; label?: string }
  | { type: 'msg'; speaker: string; side: 'user' | 'ai'; lines: string[]; hidden?: boolean; edited?: boolean }

export type DocModel = {
  title: string
  /** 顶部信息（渲染成一行一枚 chip / 一条引用） */
  meta: string[]
  blocks: DocBlock[]
  /** 文末脚注 */
  foot: string[]
}

export type SpeakerInfo = { label: string; side: 'user' | 'ai' }

export type SessionDocOptions = {
  /** 含已隐藏的消息（默认**含** —— 导出是给作者自己看的；隐藏只是「不让 AI 记得」） */
  includeHidden?: boolean
  /** 是否附顶部信息块（模式 / 锚点 / 角色 / 场景），默认附 */
  withMeta?: boolean
  /** 说话人解析。不传则按会话自带信息推断（剧情用 cast，自由用兜底名） */
  speakerOf?: (m: TavernMessage) => SpeakerInfo
  /** 自由模式的说话人兜底署名（没传 speakerOf 时用）。剧情不用它 —— 剧情的用户发言署「他演的角色名」更有信息量 */
  userLabel?: string
  /** 自由模式：角色 id → 名字（顶部「在场」用；剧情模式不需要，cast 里自带名字） */
  nameOf?: (charId: string) => string
}

// ==================== 剧情推演 → 文档模型 ====================

/** 剧情模式默认说话人：你演的角色 / AI 演的角色（多 AI 时按 speakerId 认人） */
export function plotSpeakerOf(s: TavernSession): (m: TavernMessage) => SpeakerInfo {
  const userChar = s.cast.find(c => c.role === 'user')
  const aiCast = s.cast.filter(c => c.role === 'ai')
  return (m) => {
    if (m.role === 'user') return { label: userChar?.name || '你', side: 'user' }
    const named = aiCast.find(c => c.cardId === m.speakerId)
    return { label: named?.name || aiCast[0]?.name || 'AI', side: 'ai' }
  }
}

export function plotDocModel(s: TavernSession, opts: SessionDocOptions = {}): DocModel {
  const userChar = s.cast.find(c => c.role === 'user')
  const aiCast = s.cast.filter(c => c.role === 'ai')
  const silent = s.cast.filter(c => c.role === 'silent')
  const includeHidden = opts.includeHidden ?? true
  const speakerOf = opts.speakerOf ?? plotSpeakerOf(s)

  const meta: string[] = []
  if (opts.withMeta ?? true) {
    meta.push(s.mode === 'immersive' ? '沉浸推演' : '导演推演')
    meta.push(`叙事锚点：${s.anchorChapterLabel || '（未标注）'}`)
    if (userChar) meta.push(`你演：${userChar.name}`)
    if (aiCast.length) meta.push(`AI 演：${aiCast.map(c => c.name).join('、')}`)
    if (silent.length) meta.push(`在场：${silent.map(c => c.name).join('、')}`)
    const scene = [s.scene.place, s.scene.time].filter(Boolean).join(' · ')
    if (scene) meta.push(`场景：${scene}`)
    meta.push(`${countVisible(s.messages, includeHidden)} 条对话`)
  }

  const blocks: DocBlock[] = []
  if ((opts.withMeta ?? true) && s.scene.description) {
    blocks.push({ type: 'section', text: '开场' })
    blocks.push({ type: 'para', text: s.scene.description })
  }
  blocks.push(...messageBlocks(s.messages, { includeHidden, speakerOf }))

  const foot: string[] = []
  const hiddenCount = (s.messages ?? []).filter(m => m.hidden).length
  if (hiddenCount > 0) {
    foot.push(includeHidden
      ? `本篇含 ${hiddenCount} 条已隐藏的对话 —— 它们当时没有被送进上下文，这里标出来备查。`
      : `本篇含 ${hiddenCount} 条已隐藏的对话，按你的选择没有导出。`)
  }
  foot.push(`导出时间：${fmtTime(Date.now())}`)

  return { title: s.title || '未命名推演', meta, blocks, foot }
}

// ==================== 自由对话 → 文档模型 ====================

export function freeDocModel(s: FreeSession, opts: SessionDocOptions = {}): DocModel {
  const includeHidden = opts.includeHidden ?? true
  const me = opts.userLabel || '你'
  const nameOf = opts.nameOf ?? (() => '')
  const speakerOf = opts.speakerOf ?? ((m: TavernMessage): SpeakerInfo => ({
    label: m.role === 'user' ? me : '角色',
    side: m.role === 'user' ? 'user' : 'ai',
  }))

  const meta: string[] = []
  if (opts.withMeta ?? true) {
    const names = (s.charIds ?? []).map(id => nameOf(id) || '（角色）')
    if (names.length) meta.push(`在场：${names.join('、')}`)
    const scene = s.scene ? [s.scene.place, s.scene.time].filter(Boolean).join(' · ') : ''
    if (scene) meta.push(`场景：${scene}`)
    meta.push(`${countVisible(s.messages, includeHidden)} 条对话`)
  }

  const blocks: DocBlock[] = []
  if ((opts.withMeta ?? true) && s.scene?.description) {
    blocks.push({ type: 'section', text: '开场' })
    blocks.push({ type: 'para', text: s.scene.description })
  }
  blocks.push(...messageBlocks(s.messages, { includeHidden, speakerOf }))

  const foot: string[] = []
  const hiddenCount = (s.messages ?? []).filter(m => m.hidden).length
  if (hiddenCount > 0) {
    foot.push(includeHidden
      ? `本篇含 ${hiddenCount} 条已隐藏的对话，已标出。`
      : `本篇含 ${hiddenCount} 条已隐藏的对话，按你的选择没有导出。`)
  }
  foot.push(`导出时间：${fmtTime(Date.now())}`)

  return { title: s.title || '未命名对话', meta, blocks, foot }
}

// ==================== 推演报告 → 文档模型 ====================

const REPORT_LEVELS: TavernReport['findings'][number]['level'][] = ['矛盾', '漏洞', '存疑']

export function reportDocModel(
  r: TavernReport,
  tabName: (id: string) => string,
  opts: { withMeta?: boolean } = {},
): DocModel {
  const withMeta = opts.withMeta ?? true
  const meta: string[] = []
  if (withMeta) {
    meta.push(r.anchorChapterLabel || '（无锚点）')
    meta.push(r.mode === 'immersive' ? '沉浸推演' : '导演推演')
    meta.push(fmtTime(r.createdAt))
    const cast = (r.cast ?? [])
      .map(c => `${c.name}（${c.role === 'user' ? '你演' : c.role === 'ai' ? 'AI 演' : '在场'}）`)
      .join('、')
    if (cast) meta.push(cast)
  }

  const blocks: DocBlock[] = []
  blocks.push({ type: 'section', text: '概览' })
  blocks.push({ type: 'para', text: r.overview || '（模型未给出概览）' })

  if ((r.findings ?? []).length === 0) {
    blocks.push({ type: 'note', text: '这一场没有发现问题 —— 角色反应与设定是自洽的。' })
  } else {
    for (const lv of REPORT_LEVELS) {
      const items = (r.findings ?? []).filter(f => f.level === lv)
      if (items.length === 0) continue
      blocks.push({ type: 'section', text: `${lv} · ${items.length} 条` })
      blocks.push({
        type: 'items',
        items: items.map(f => ({
          tag: lv,
          title: f.targetLabel ? `${f.targetTabId ? tabName(f.targetTabId) : '（未能定位）'} · ${f.targetLabel}` : undefined,
          text: f.detail,
          sub: f.suggestion ? `建议：${f.suggestion}` : undefined,
        })),
      })
    }
  }

  const foot = ['报告只做诊断，不会写回任何项目表 —— 是否采纳由你决定。']
  if ((r.findings ?? []).some(f => f.level === '存疑')) {
    foot.push('「存疑」是模型有疑虑但指不出具体条目的部分，未必是错。')
  }
  foot.push(`导出时间：${fmtTime(Date.now())}`)

  return { title: `${r.sessionTitle || '未命名'} · 推演报告`, meta, blocks, foot }
}

// ==================== 公共小件 ====================

function countVisible(messages: TavernMessage[] | undefined, includeHidden: boolean): number {
  return (messages ?? []).filter(m => m.role !== 'system' && (includeHidden || !m.hidden)).length
}

function messageBlocks(
  messages: TavernMessage[] | undefined,
  o: { includeHidden: boolean; speakerOf: (m: TavernMessage) => SpeakerInfo },
): DocBlock[] {
  const out: DocBlock[] = []
  for (const m of messages ?? []) {
    if (m.role === 'system') continue
    if (m.hidden && !o.includeHidden) continue
    const lines = tavernLines(m.content)
    if (lines.length === 0) continue
    const who = o.speakerOf(m)
    out.push({
      type: 'msg',
      speaker: who.label,
      side: m.role === 'user' ? 'user' : 'ai',
      lines,
      hidden: m.hidden || undefined,
      edited: m.edited || undefined,
    })
  }
  return out
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 文件名：去掉 Windows/macOS 不允许的字符，限长，空标题兜底 */
export function docFileName(title: string, ext: string): string {
  const base = String(title ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return `${base || '未命名'}${ext.startsWith('.') ? ext : `.${ext}`}`
}

// ==================== 渲染：Markdown ====================

/**
 * 一行 Markdown 的安全化：只处理**行首**会改变结构的字符。
 * 正文里的 * _ ` 一律不动 —— 作者的正文可能本来就带这些，替它转义反而是篡改。
 */
function mdSafe(line: string): string {
  return line.replace(/^(\s*)([#>])/, '$1\\$2').replace(/^(\s*)(\d+)\.\s/, '$1$2\\. ')
}

export function toMarkdown(doc: DocModel): string {
  const out: string[] = []
  out.push(`# ${mdSafe(String(doc.title).replace(/\n/g, ' '))}`)
  if (doc.meta.length) {
    out.push('')
    for (const m of doc.meta) out.push(`> ${mdSafe(m)}`)
  }
  for (const b of doc.blocks) {
    out.push('')
    switch (b.type) {
      case 'section':
        out.push(`## ${mdSafe(b.text)}`)
        break
      case 'para':
        // 段落里的换行按「多行引用块」不成立 —— 逐行成段，避免 Markdown 把相邻行并成一段
        for (const l of String(b.text).split('\n').map(s => s.trim()).filter(Boolean)) out.push(mdSafe(l))
        break
      case 'pre':
        // 原文块：逐行**原样**输出，不 trim（行首缩进是内容的一部分）。
        // 刻意不加代码围栏：正文里完全可能出现 ``` ，撞上会把后面的内容全吃进代码块。
        if (b.label) out.push(`**${mdSafe(b.label)}**`)
        out.push(...String(b.text).split('\n'))
        break
      case 'note':
        out.push(`_${mdSafe(b.text)}_`)
        break
      case 'items':
        for (const it of b.items) {
          const head = [it.tag ? `【${it.tag}】` : '', it.title ? `**${it.title}**` : ''].filter(Boolean).join(' ')
          out.push(`- ${head ? `${head} ` : ''}${mdSafe(it.text)}`)
          if (it.sub) out.push(`  - ${mdSafe(it.sub)}`)
        }
        break
      case 'msg': {
        const flags = [
          b.hidden ? '已隐藏 · 未进上下文' : '',
          b.edited ? '改过' : '',
        ].filter(Boolean)
        out.push(`**${b.speaker}**${flags.length ? `（${flags.join('，')}）` : ''}`)
        out.push('')
        // 🔴 每行**各成一段**（中间留空行）。Markdown 会把相邻行并成同一段落，
        //    不分段的话「（动作）」会和下一句对白糊在一起，格式意义就没了。
        b.lines.forEach((l, i) => {
          if (i > 0) out.push('')
          out.push(mdSafe(l))
        })
        break
      }
    }
  }
  if (doc.foot.length) {
    out.push('', '---', '')
    for (const f of doc.foot) out.push(mdSafe(f))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

// ==================== 渲染：单文件 HTML ====================

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const KIND_CLASS: Record<TavernLineKind, string> = {
  action: 'action',
  state: 'state',
  speech: 'speech',
}

/** 正文行 → 带样式的 HTML（行首符号**原样保留**，作者能自己核对格式） */
function lineToHtml(line: string): string {
  const cls = KIND_CLASS[classifyTavernLine(line)]
  return `<p class="line ${cls}">${esc(line)}</p>`
}

/**
 * 导出 HTML 的样式。
 * 放在这里而不是 index.css：导出件必须**自包含**（不引外部资源、不依赖软件主题），
 * 打开它的可能是别人的电脑、也可能是打印出来的纸。
 */
const DOC_CSS = `
:root{--paper:#fbf9f5;--ink:#2a2724;--soft:#6b6459;--rule:#e3ddd2;--accent:#a3661f;--ubg:#fdf6ea;--urule:#e0b878;--ubadge:#8a6a3a}
@media (prefers-color-scheme:dark){:root{--paper:#1b1a18;--ink:#e8e4dd;--soft:#a49c90;--rule:#34322e;--accent:#d9a05b;--ubg:#262320;--urule:#6b5327;--ubadge:#c8a870}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:"Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,serif;font-size:16px;line-height:1.9;-webkit-font-smoothing:antialiased}
.wrap{max-width:42rem;margin:0 auto;padding:3rem 1.25rem 5rem}
h1{font-size:1.5rem;line-height:1.4;margin:0;letter-spacing:.01em}
.meta{display:flex;flex-wrap:wrap;gap:.4rem .5rem;margin:.9rem 0 0}
.chip{font-family:ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:.72rem;color:var(--soft);border:1px solid var(--rule);border-radius:999px;padding:.1rem .55rem;white-space:nowrap}
.sep{border:0;border-top:1px solid var(--rule);margin:2rem 0 1.4rem}
h2{font-family:ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:.76rem;font-weight:600;letter-spacing:.16em;color:var(--soft);margin:2.1rem 0 .8rem}
.msg{margin:0 0 1.3rem}
.msg .speaker{font-family:ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:.76rem;font-weight:600;color:var(--accent);margin-bottom:.2rem}
.msg.user{background:var(--ubg);border-left:3px solid var(--urule);padding:.65rem .95rem;border-radius:0 .4rem .4rem 0}
.msg.user .speaker{color:var(--ubadge)}
.msg.hidden{opacity:.6}
.line{margin:0}
.line+.line{margin-top:.15rem}
.line.action{color:var(--soft);font-size:.95em}
.line.state{color:var(--soft);font-style:italic;font-size:.92em}
.para{margin:0}
.note{color:var(--soft);font-family:ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:.78rem}
.badge{font-family:ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:.66rem;font-weight:400;color:var(--soft);border:1px dashed var(--rule);border-radius:.25rem;padding:0 .3rem;margin-left:.4rem}
ul.items{margin:.5rem 0 0;padding-left:1.15rem}
ul.items li{margin:.55rem 0}
.tag{font-family:ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:.68rem;border:1px solid var(--rule);border-radius:.25rem;padding:.02rem .35rem;margin-right:.4rem;color:var(--soft)}
.sub{display:block;color:var(--soft);font-size:.94em;margin-top:.15rem}
footer{margin-top:3rem;border-top:1px solid var(--rule);padding-top:1rem;color:var(--soft);font-family:ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:.74rem;line-height:1.9}
.rawLabel{font-family:ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:.76rem;font-weight:600;color:var(--accent);margin:1.6rem 0 .45rem}
pre.raw{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;font-family:inherit;font-size:.95em;line-height:1.9;background:var(--ubg);border-left:3px solid var(--rule);border-radius:0 .4rem .4rem 0;padding:.7rem 1rem;margin:0 0 1.1rem}
@media print{body{background:#fff;color:#000}.wrap{max-width:none;padding:0}.meta{display:none}.msg.user{background:transparent}
pre.raw{background:transparent;border-left-color:#d8d2c8;padding-left:.9rem}
pre.raw,.msg,li{break-inside:avoid}
h2,.rawLabel{break-after:avoid}
}
`.trim()

export function toHtml(doc: DocModel): string {
  const body: string[] = []
  body.push(`<h1>${esc(doc.title)}</h1>`)
  if (doc.meta.length) {
    body.push(`<div class="meta">${doc.meta.map(m => `<span class="chip">${esc(m)}</span>`).join('')}</div>`)
  }
  let first = true
  for (const b of doc.blocks) {
    if (first) { body.push('<hr class="sep">'); first = false }
    switch (b.type) {
      case 'section':
        body.push(`<h2>${esc(b.text)}</h2>`)
        break
      case 'para':
        for (const l of String(b.text).split('\n').map(s => s.trim()).filter(Boolean)) {
          body.push(`<p class="para">${esc(l)}</p>`)
        }
        break
      case 'pre':
        // 原文块：靠 CSS 的 white-space:pre-wrap 保真 —— 换行与行首缩进都不动。
        // 🖨 打印时也要保住（分页规则见 DOC_CSS 的 @media print）。
        if (b.label) body.push(`<div class="rawLabel">${esc(b.label)}</div>`)
        body.push(`<pre class="raw">${esc(b.text)}</pre>`)
        break
      case 'note':
        body.push(`<p class="note">${esc(b.text)}</p>`)
        break
      case 'items':
        body.push('<ul class="items">')
        for (const it of b.items) {
          const head = [
            it.tag ? `<span class="tag">${esc(it.tag)}</span>` : '',
            it.title ? `<strong>${esc(it.title)}</strong>` : '',
          ].filter(Boolean).join('')
          body.push(`<li>${head ? `${head}<br>` : ''}${esc(it.text)}${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}</li>`)
        }
        body.push('</ul>')
        break
      case 'msg': {
        const flags = [b.hidden ? '已隐藏 · 未进上下文' : '', b.edited ? '改过' : ''].filter(Boolean)
        const cls = `msg ${b.side}${b.hidden ? ' hidden' : ''}`
        body.push(`<div class="${cls}">`)
        body.push(`<div class="speaker">${esc(b.speaker)}${flags.length ? `<span class="badge">${esc(flags.join('，'))}</span>` : ''}</div>`)
        for (const l of b.lines) body.push(lineToHtml(l))
        body.push('</div>')
        break
      }
    }
  }
  const foot = doc.foot.length
    ? `<footer>${doc.foot.map(f => `<div>${esc(f)}</div>`).join('')}</footer>`
    : ''
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(doc.title)}</title>`,
    `<style>${DOC_CSS}</style>`,
    '</head>',
    '<body>',
    '<main class="wrap">',
    ...body,
    foot,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

// ==================== 出口 ====================

export type ExportFormat = 'markdown' | 'html'

/** 把模型渲染成成品文件（供界面下载/复制用，也让单测能一次性验两种格式） */
export function renderDoc(doc: DocModel, format: ExportFormat): { filename: string; content: string; mime: string } {
  if (format === 'html') {
    return { filename: docFileName(doc.title, '.html'), content: toHtml(doc), mime: 'text/html;charset=utf-8' }
  }
  return { filename: docFileName(doc.title, '.md'), content: toMarkdown(doc), mime: 'text/markdown;charset=utf-8' }
}
