/**
 * 导出增强（v1.3）
 * - TXT 整书 / 单卷 / 单章（原有，参考橙瓜码字）
 * - Markdown 整书
 * - 平台粘贴版（干净纯文本，适配起点 / 番茄等网文平台粘贴）
 * - 设定集导出（汇总全部世界观 / 人物 / 设定表为一份 Markdown）
 * - EPUB / DOCX（依赖零依赖的极简 ZIP 打包器，见 zip.ts）
 */
import type { Volume, Chapter } from './types'
import * as db from './db'
import { TABS } from './schema'
import { ZipBuilder, downloadBlob } from './zip'
import { chapterSeqMap } from './chapterSeq'

/** 文本下载（带 UTF-8 BOM，Windows 记事本/Excel 打开不乱码）；仅本模块内部使用 */
function downloadFile(filename: string, content: string) {
  downloadBlob(filename, new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' }))
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_')
}

// ============ TXT（原有） ============
export function chaptersToTxt(chapters: Chapter[], volumes: Volume[]): string {
  const parts: string[] = []
  for (const vol of volumes) {
    const chs = chapters.filter(c => c.volumeId === vol.id).sort((a, b) => a.order - b.order)
    if (chs.length === 0) continue
    parts.push(`\n\n─────────────\n${vol.title}\n─────────────\n`)
    for (const ch of chs) {
      parts.push(`\n${ch.title}\n\n${ch.content || '（本章暂无内容）'}\n`)
    }
  }
  const orphan = chapters.filter(c => !volumes.some(v => v.id === c.volumeId))
  if (orphan.length > 0) {
    parts.push(`\n\n─────────────\n未分卷章节\n─────────────\n`)
    for (const ch of orphan) parts.push(`\n${ch.title}\n\n${ch.content || '（本章暂无内容）'}\n`)
  }
  return parts.join('').trim() + '\n'
}

export function exportWholeBook(projectName: string, volumes: Volume[], chapters: Chapter[]) {
  const head = `${projectName}\n\n`
  downloadFile(sanitize(`${projectName}-全书.txt`), head + chaptersToTxt(chapters, volumes))
}

export function exportVolume(projectName: string, vol: Volume, chapters: Chapter[]) {
  const chs = chapters.filter(c => c.volumeId === vol.id).sort((a, b) => a.order - b.order)
  downloadFile(sanitize(`${projectName}-${vol.title}.txt`), `${projectName} · ${vol.title}\n\n` + chaptersToTxt(chs, [vol]))
}

export function exportChapter(projectName: string, ch: Chapter) {
  downloadFile(sanitize(`${projectName}-${ch.title}.txt`), `${ch.title}\n\n${ch.content || '（本章暂无内容）'}\n`)
}

// ============ Markdown 整书 ============

/**
 * Markdown 正文行首缩进的**防御性转换**。
 *
 * 🔴 问题：Markdown 把「行首 4 个半角空格」或「Tab」当作**代码块** ——
 *    作者若把缩进单位设成「半角×4 / Tab」，整章正文在 Markdown 里会被渲染成大段代码
 *    （字体变等宽、换行全保留），完全没法读。
 *
 * 策略（**按需转换 + 头部注释明示**，默认路径一个字符都不动）：
 *   · 默认单位是「全角空格」—— Markdown 不把它当缩进，因此**如实导出**（守住验收⑥）；
 *   · 只有某行确实以「Tab」或「≥4 个半角空格」开头时才转成**视觉等宽的全角空格**
 *     （1 个全角 ≈ 2 个半角宽度）；
 *   · 发生过转换就在文件顶部留一行注释 —— 作者需要知道这里被动过。
 */
function mdIndentSafe(line: string): string {
  const m = /^[ \t]+/.exec(line)
  if (!m) return line
  const raw = m[0]
  // 1–3 个纯半角空格：Markdown 不当代码块，保持原样 —— 少动一处，就少一分不一致
  if (!raw.includes('\t') && raw.length < 4) return line
  const width = raw.replace(/\t/g, '    ').length
  return '　'.repeat(Math.floor(width / 2)) + ' '.repeat(width % 2) + line.slice(raw.length)
}

/** 整书 Markdown 正文（纯计算、不触发下载 —— 导出便于单测断言缩进等格式约定） */
export interface MarkdownOptions {
  /** 标题层级整体下移：0（默认）= # 书 / ## 卷 / ### 章；1 = ## 书 / ### 卷 / #### 章，上限 3。用于把导出稿并进别的文档时避免层级冲突 */
  headingOffset?: 0 | 1 | 2 | 3
}

export function bookToMarkdown(projectName: string, volumes: Volume[], chapters: Chapter[], opts: MarkdownOptions = {}): string {
  const off = Math.min(3, Math.max(0, opts.headingOffset ?? 0))
  const h = (level: number) => '#'.repeat(level + off)
  let converted = false
  /** 章正文 → MD 安全正文（折叠多余空行 + 行首缩进防御性转换） */
  const mdBody = (content: string): string =>
    (content || '（本章暂无内容）')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map(l => {
        const safe = mdIndentSafe(l)
        if (safe !== l) converted = true
        return safe
      })
      .join('\n')

  const parts = [`${h(1)} ${projectName}`, '']
  for (const vol of volumes) {
    const chs = chapters.filter(c => c.volumeId === vol.id).sort((a, b) => a.order - b.order)
    if (chs.length === 0) continue
    parts.push(`${h(2)} ${vol.title}`, '')
    for (const ch of chs) parts.push(`${h(3)} ${ch.title}`, '', mdBody(ch.content), '')
  }
  const orphan = chapters.filter(c => !volumes.some(v => v.id === c.volumeId))
  if (orphan.length) {
    parts.push(`${h(2)} 未分卷章节`, '')
    for (const ch of orphan) parts.push(`${h(3)} ${ch.title}`, '', mdBody(ch.content), '')
  }
  if (converted) {
    // 插在书名之后（不能放第一行 —— 那会被当成正文）；HTML 注释不影响 Markdown 渲染
    parts.splice(2, 0,
      '<!-- 本文件的正文行首缩进已转为全角空格：Markdown 会把「4 个半角空格 / Tab」渲染成代码块，' +
      '转换只为保住阅读版式。原始缩进请以 TXT、平台粘贴版或软件内正文为准。 -->',
      '')
  }
  return parts.join('\n')
}

export function exportBookMD(projectName: string, volumes: Volume[], chapters: Chapter[], opts: MarkdownOptions = {}) {
  downloadFile(sanitize(`${projectName}-全书.md`), bookToMarkdown(projectName, volumes, chapters, opts))
}

/** Markdown → 可读纯文本（给「粘贴版附设定集」用）：去掉行首 # 与加粗星号，其余原样 */
function markdownToPlain(md: string): string {
  return md
    .split('\n')
    .map(l => l.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, ''))
    .join('\n')
}

// ============ 段落切分（TXT / MD / 平台粘贴 / EPUB / DOCX 共用口径） ============

/**
 * 章节正文 → 规范段落数组：折叠连续空行、清掉行尾空白，**保留行首缩进**。
 *
 * 🔴 2.4.0 · A5 修正：此前这段逻辑（以及 EPUB / DOCX 里各自的副本）用的是 `s.trim()` ——
 *    行首缩进被整段抹掉，导出的 TXT / 平台粘贴版 / EPUB / DOCX 与编辑器里看到的样子对不上。
 *    缩进是作者的排版主权，多级缩进可能是有意为之（对白、补充说明），导出必须如实带上。
 *    ⚠️ 判空仍然用 trim：整行只有空白的，不该被当成一个段落。
 */
function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n+/)
    .map(s => s.replace(/[ \t\u3000]+$/, ''))
    .filter(s => s.trim() !== '')
}

/**
 * EPUB 专用：HTML 会把**连续半角空格**折叠成一个、Tab 直接吃掉，
 * 行首缩进得靠 `&nbsp;` 才能如实呈现（全角空格「　」不折叠，原样即可）。
 */
function indentToNbsp(line: string): string {
  return line.replace(/^[ \t]+/, m => m.replace(/\t/g, '    ').replace(/ /g, '&nbsp;'))
}

// ============ 平台粘贴版（干净纯文本 · C6 · 2.4.2 可配置格式） ============

/**
 * 平台粘贴版格式选项。全都有默认值 —— 不传时行为与 2.4.1 完全一致（老调用零回归）。
 * 各家平台后台的粘贴表现随时会变，这里只提供「格式怎么排」的开关，不断言某平台必须怎样。
 */
export interface PlatformTextOptions {
  /** 章节标题行：`as-is`=原样（默认）；`numbered`=补「第N章 」前缀（按叙事序派生，标记「不计入序号」的章保留原题）；`none`=不带标题行 */
  chapterTitle?: 'as-is' | 'numbered' | 'none'
  /** 段落间距：`blank`=段间空一行（默认）；`compact`=单换行 */
  paragraphGap?: 'blank' | 'compact'
  /** 是否输出卷标题行（默认 true） */
  includeVolumeTitle?: boolean
}

function normalizeParagraphs(text: string, gap: 'blank' | 'compact'): string {
  return splitParagraphs(text).join(gap === 'compact' ? '\n' : '\n\n')
}

/** 平台粘贴版正文（纯计算、不触发下载 —— 同样为了可单测） */
export function bookToPlatformText(volumes: Volume[], chapters: Chapter[], opts: PlatformTextOptions = {}): string {
  const title = opts.chapterTitle ?? 'as-is'
  const gap = opts.paragraphGap ?? 'blank'
  const withVolTitle = opts.includeVolumeTitle ?? true
  // 序号只在 numbered 模式才需要：与编辑器/连续性检查同一权威来源（chapterSeq 派生，永不解析标题）
  const seqMap = title === 'numbered' ? chapterSeqMap(volumes, chapters) : null

  const titleLine = (ch: Chapter): string | null => {
    if (title === 'none') return null
    if (title === 'numbered') {
      const no = seqMap?.get(ch.id) ?? 0
      return no > 0 ? `第${no}章 ${ch.title}` : ch.title
    }
    return ch.title
  }

  const emitChapter = (parts: string[], ch: Chapter) => {
    const t = titleLine(ch)
    if (t) parts.push(t, '')
    parts.push(normalizeParagraphs(ch.content, gap), '')
  }

  const parts: string[] = []
  for (const vol of volumes) {
    const chs = chapters.filter(c => c.volumeId === vol.id).sort((a, b) => a.order - b.order)
    if (chs.length === 0) continue
    if (withVolTitle) parts.push(vol.title, '')
    for (const ch of chs) emitChapter(parts, ch)
  }
  const orphan = chapters.filter(c => !volumes.some(v => v.id === c.volumeId))
  if (orphan.length) {
    if (withVolTitle) parts.push('未分卷章节', '')
    for (const ch of orphan) emitChapter(parts, ch)
  }
  return parts.join('\n')
}

/**
 * 导出平台粘贴版（下载文件）。
 * 🔴 C6 起**变 async**：可选项「附设定集」需要读库生成 —— 旧调用方（不带附录）结果不变，
 * 只是多了个可 await 的 Promise。
 */
export async function exportBookPlatformText(
  projectName: string,
  volumes: Volume[],
  chapters: Chapter[],
  opts: PlatformTextOptions = {},
  includeAppendix = false,
): Promise<void> {
  let text = bookToPlatformText(volumes, chapters, opts)
  if (includeAppendix) {
    const compendium = markdownToPlain(await buildSettingCompendium(projectName))
    text += `\n\n${'═'.repeat(20)}\n附录 · 设定集\n${'═'.repeat(20)}\n\n${compendium}`
  }
  downloadFile(sanitize(`${projectName}-粘贴版.txt`), text)
}

// ============ EPUB ============
function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!))
}
function contentToXhtml(text: string): string {
  const paras = splitParagraphs(text)
  if (paras.length === 0) return '<p>（本章暂无内容）</p>'
  // 行首半角空白转 &nbsp;，否则 HTML 会把缩进折叠掉、导出后看不出来（A5）
  return paras.map(p => `<p>${escapeXml(indentToNbsp(p))}</p>`).join('')
}

/** 生成符合 urn:uuid: 规范的版本 4 UUID（EPUB 的 dc:identifier 必须是真 UUID，不能拿书名硬塞） */
function uuidV4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function exportEPUB(projectName: string, volumes: Volume[], chapters: Chapter[]) {
  const zip = new ZipBuilder()
  zip.add('mimetype', 'application/epub+zip')
  zip.add('META-INF/container.xml',
    '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles>\n<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n</rootfiles>\n</container>')

  let manifest = ''
  let spine = ''
  let nav = ''
  let order = 1
  for (const vol of volumes) {
    const chs = chapters.filter(c => c.volumeId === vol.id).sort((a, b) => a.order - b.order)
    for (const ch of chs) {
      const id = `c${order}`
      const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(ch.title)}</title></head><body><h1>${escapeXml(ch.title)}</h1>${contentToXhtml(ch.content)}</body></html>`
      zip.add(`OEBPS/${id}.xhtml`, xhtml)
      manifest += `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>\n`
      spine += `<itemref idref="${id}"/>\n`
      nav += `<li><a href="${id}.xhtml">${escapeXml(ch.title)}</a></li>\n`
      order++
    }
  }
  const opf = `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n<dc:identifier id="bookid">urn:uuid:${uuidV4()}</dc:identifier>\n<dc:title>${escapeXml(projectName)}</dc:title>\n<dc:language>zh</dc:language>\n</metadata>\n<manifest>\n<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n${manifest}</manifest>\n<spine>\n${spine}</spine>\n</package>`
  zip.add('OEBPS/content.opf', opf)
  zip.add('OEBPS/nav.xhtml',
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${escapeXml(projectName)}</title></head><body><nav epub:type="toc"><ol>${nav}</ol></nav></body></html>`)

  const blob = new Blob([zip.build() as BlobPart], { type: 'application/epub+zip' })
  downloadBlob(sanitize(`${projectName}.epub`), blob)
}

// ============ DOCX ============
function docxRun(text: string, bold = false): string {
  const t = escapeXml(text)
  return bold
    ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`
    : `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`
}
function docxPara(inner: string): string {
  return `<w:p>${inner}</w:p>`
}

export function exportDOCX(projectName: string, volumes: Volume[], chapters: Chapter[]) {
  const zip = new ZipBuilder()
  zip.add('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
  zip.add('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.add('word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
  zip.add('word/styles.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:styles>')

  const body: string[] = []
  body.push(docxPara(docxRun(projectName, true)))
  for (const vol of volumes) {
    const chs = chapters.filter(c => c.volumeId === vol.id).sort((a, b) => a.order - b.order)
    if (chs.length === 0) continue
    body.push(docxPara(docxRun(vol.title, true)))
    for (const ch of chs) {
      body.push(docxPara(docxRun(ch.title, true)))
      // 与 TXT / 平台粘贴版同一口径：保留行首缩进（2.4.0 · A5）
      const paras = splitParagraphs(ch.content)
      for (const p of paras) body.push(docxPara(docxRun(p)))
    }
  }
  const document = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr/></w:body></w:document>`
  zip.add('word/document.xml', document)

  const blob = new Blob([zip.build() as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  downloadBlob(sanitize(`${projectName}.docx`), blob)
}

// ============ 设定集导出（汇总全部世界观 / 人物 / 设定） ============
function hasContent(data: Record<string, string>): boolean {
  return Object.values(data).some(v => v && v.trim())
}

async function buildSettingCompendium(projectName: string): Promise<string> {
  const lines: string[] = [`# ${projectName} · 设定集`, '']
  for (const tab of TABS) {
    if (tab.type === 'dashboard' || tab.type === 'guide' || tab.type === 'about' || tab.id === 'editor') continue
    if (tab.type === 'form') {
      const data = await db.getFormData(tab.id)
      if (!hasContent(data)) continue
      lines.push(`## ${tab.name}`, '')
      for (const mod of tab.modules ?? []) {
        lines.push(`### ${mod.name}`, '')
        for (const f of mod.fields) {
          const v = data[`${mod.name}::${f.name}`]
          if (v && v.trim()) lines.push(`- **${f.name}**：${v}`)
        }
        lines.push('')
      }
    } else if (tab.type === 'table') {
      const rows = await db.getTableRows(tab.id)
      if (!rows.length) continue
      lines.push(`## ${tab.name}`, '')
      for (const r of rows) {
        const parts = Object.entries(r.data).filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}：${v}`)
        lines.push(`- ${parts.join('；')}`)
      }
      lines.push('')
    } else if (tab.type === 'card') {
      const records = await db.getCardRecords(tab.id)
      if (!records.length) continue
      lines.push(`## ${tab.name}`, '')
      for (const rec of records) {
        lines.push(`### ${rec.name}`, '')
        for (const [k, v] of Object.entries(rec.data)) {
          if (v && v.trim()) lines.push(`- **${k.split('::').pop()}**：${v}`)
        }
        lines.push('')
      }
    }
  }
  return lines.join('\n')
}

export async function exportSettingCompendium(projectName: string) {
  const md = await buildSettingCompendium(projectName)
  downloadFile(sanitize(`${projectName}-设定集.md`), md)
}
