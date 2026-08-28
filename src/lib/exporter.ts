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
function bookToMarkdown(projectName: string, volumes: Volume[], chapters: Chapter[]): string {
  const parts = [`# ${projectName}`, '']
  for (const vol of volumes) {
    const chs = chapters.filter(c => c.volumeId === vol.id).sort((a, b) => a.order - b.order)
    if (chs.length === 0) continue
    parts.push(`## ${vol.title}`, '')
    for (const ch of chs) {
      parts.push(`### ${ch.title}`, '', (ch.content || '（本章暂无内容）').replace(/\n{3,}/g, '\n\n'), '')
    }
  }
  const orphan = chapters.filter(c => !volumes.some(v => v.id === c.volumeId))
  if (orphan.length) {
    parts.push(`## 未分卷章节`, '')
    for (const ch of orphan) parts.push(`### ${ch.title}`, '', (ch.content || '（本章暂无内容）').replace(/\n{3,}/g, '\n\n'), '')
  }
  return parts.join('\n')
}

export function exportBookMD(projectName: string, volumes: Volume[], chapters: Chapter[]) {
  downloadFile(sanitize(`${projectName}-全书.md`), bookToMarkdown(projectName, volumes, chapters))
}

// ============ 平台粘贴版（干净纯文本） ============
function normalizeParagraphs(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean)
    .join('\n\n')
}

export function exportBookPlatformText(projectName: string, volumes: Volume[], chapters: Chapter[]) {
  const parts: string[] = []
  for (const vol of volumes) {
    const chs = chapters.filter(c => c.volumeId === vol.id).sort((a, b) => a.order - b.order)
    if (chs.length === 0) continue
    parts.push(vol.title, '')
    for (const ch of chs) {
      parts.push(ch.title, '', normalizeParagraphs(ch.content), '')
    }
  }
  const orphan = chapters.filter(c => !volumes.some(v => v.id === c.volumeId))
  if (orphan.length) {
    parts.push('未分卷章节', '')
    for (const ch of orphan) parts.push(ch.title, '', normalizeParagraphs(ch.content), '')
  }
  downloadFile(sanitize(`${projectName}-粘贴版.txt`), parts.join('\n'))
}

// ============ EPUB ============
function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!))
}
function contentToXhtml(text: string): string {
  const paras = text.replace(/\r\n/g, '\n').split(/\n+/).map(s => s.trim()).filter(Boolean)
  if (paras.length === 0) return '<p>（本章暂无内容）</p>'
  return paras.map(p => `<p>${escapeXml(p)}</p>`).join('')
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
      const paras = ch.content.replace(/\r\n/g, '\n').split(/\n+/).map(s => s.trim()).filter(Boolean)
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

export async function buildSettingCompendium(projectName: string): Promise<string> {
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
