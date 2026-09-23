/**
 * .docx 抽取为纯文本（C9 · 2.4.2）—— 手写、**零运行时依赖**。
 *
 * ## 为什么自己写
 * 项目 `dependencies` 为空（打包体积基线），而写侧 `exportDOCX` 本来就是「手写 OOXML + 自研
 * `ZipBuilder`」——读侧对称地自己解 zip 即可，不必为一个导入功能引入 mammoth（数百 KB，
 * 且会破坏 `vite build` 的体积闸）。
 *
 * ## 读什么 / 不读什么
 * 只读 `word/document.xml`。**表格里的段落照常读出**（不丢字），文本框内容也在同一个 xml 里，
 * 同样会读到。以下内容**确实读不到**，抽完会把「本次实际发现了哪些」如实回报给作者
 * （`skipped`）——宁可多一句提示，也不静默丢东西：
 *   批注（comments.xml）/ 脚注尾注（footnotes・endnotes.xml）/ 页眉页脚（header*.xml）
 *   / 图片与图形（二进制，本来就变不成文字）/ 公式（OMML 的 `<m:t>`，不是 `<w:t>`）
 *   / 修订中「已删除」的文字（`<w:delText>`）
 *
 * ## 与编辑器口径的两处对齐
 * - 段落之间用 `\n` 分隔（与正文一致；落库前还会过一遍 `splitParagraphs`）；
 * - **首行缩进按段落属性补全角空格**：Word 的中文首行缩进是段落属性
 *   （`<w:ind w:firstLineChars="200"/>`）而不是字符，纯文本化会丢；这里按属性补
 *   `　　`，与导出侧「禁行首 trim」的 A5 口径对称。
 */

/** 段落之间与段内软换行都用 `\n`（与编辑器正文一致） */
export interface DocxText {
  /** 纯文本 */
  text: string
  /** 段落数（含保留的空段） */
  paragraphs: number
  /** 本次**实际发现且未读取**的内容类型（诚实告知，不静默丢） */
  skipped: string[]
}

const dec = new TextDecoder('utf-8')

/** 首行缩进补的字符 —— 与编辑器正文口径一致（两个全角空格） */
const INDENT = '\u3000\u3000'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

interface ZipEntry {
  name: string
  method: number
  compSize: number
  localOffset: number
}

/** 从尾部往前找 EOCD（结尾可能带最长 64KB 的 zip 注释） */
function findEocd(dv: DataView): number {
  const min = Math.max(0, dv.byteLength - 22 - 65535)
  for (let i = dv.byteLength - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) return i
  }
  return -1
}

/**
 * 列 zip 条目。优先走**中央目录**（信息最全：压缩方式 / 压缩后大小 / 本地头偏移都在这里）；
 * 中央目录缺失时才退到顺序扫本地头（极少数流式产物）。
 */
function listEntries(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const entries: ZipEntry[] = []
  const eocd = findEocd(dv)
  if (eocd >= 0) {
    const count = dv.getUint16(eocd + 10, true)
    let p = dv.getUint32(eocd + 16, true)
    for (let i = 0; i < count; i++) {
      if (p + 46 > dv.byteLength || dv.getUint32(p, true) !== CEN_SIG) break
      const method = dv.getUint16(p + 10, true)
      const compSize = dv.getUint32(p + 20, true)
      const nameLen = dv.getUint16(p + 28, true)
      const extraLen = dv.getUint16(p + 30, true)
      const commentLen = dv.getUint16(p + 32, true)
      const localOffset = dv.getUint32(p + 42, true)
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen))
      entries.push({ name, method, compSize, localOffset })
      p += 46 + nameLen + extraLen + commentLen
    }
    if (entries.length > 0) return entries
  }
  // 兜底：顺序扫本地头
  let p = 0
  while (p + 30 <= dv.byteLength) {
    if (dv.getUint32(p, true) !== LOC_SIG) break
    const method = dv.getUint16(p + 8, true)
    const compSize = dv.getUint32(p + 18, true)
    const nameLen = dv.getUint16(p + 26, true)
    const extraLen = dv.getUint16(p + 28, true)
    const name = dec.decode(buf.subarray(p + 30, p + 30 + nameLen))
    const dataStart = p + 30 + nameLen + extraLen
    entries.push({ name, method, compSize, localOffset: p })
    if (compSize === 0) break   // 流式产物：本地头里没写大小，停在这里
    p = dataStart + compSize
  }
  return entries
}

/** 取某个条目的**原始（可能已压缩）**字节 */
function readRaw(buf: Uint8Array, e: ZipEntry): Uint8Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const p = e.localOffset
  if (p + 30 > dv.byteLength || dv.getUint32(p, true) !== LOC_SIG) {
    throw new Error('docx 结构异常：本地文件头签名不符')
  }
  const nameLen = dv.getUint16(p + 26, true)
  const extraLen = dv.getUint16(p + 28, true)
  const start = p + 30 + nameLen + extraLen
  return buf.subarray(start, start + e.compSize)
}

/** raw deflate 解压（zip 的 method 8 用的是 raw deflate，**不是** zlib 包裹的 deflate） */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const writer = ds.writable.getWriter()
  void writer.write(data as unknown as BufferSource)
  void writer.close()
  const ab = await new Response(ds.readable).arrayBuffer()
  return new Uint8Array(ab)
}

/** 条目内容 → 字符串（method 0 直接读，method 8 解压） */
async function readEntryText(buf: Uint8Array, e: ZipEntry): Promise<string> {
  const raw = readRaw(buf, e)
  if (e.method === 0) return dec.decode(raw)
  if (e.method === 8) return dec.decode(await inflateRaw(raw))
  throw new Error(`docx 里的压缩方式不支持（method ${e.method}）`)
}

// ============ XML → 纯文本 ============

/** XML 实体解码（单次扫描，不会把 `&amp;lt;` 二次解码成 `<`） */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (whole, body: string) => {
    switch (body) {
      case 'lt': return '<'
      case 'gt': return '>'
      case 'amp': return '&'
      case 'quot': return '"'
      case 'apos': return "'"
      default: {
        const code = body.startsWith('#x') || body.startsWith('#X')
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
        // 🔴 上限必须挡：`&#x110000;` 会让 fromCodePoint 抛 RangeError，把整次导入炸掉
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
      }
    }
  })
}

/** 段落是否带「首行缩进」——Word 的中文缩进是段落属性，纯文本化会丢，这里补回来 */
function hasFirstLineIndent(pXml: string): boolean {
  const tag = (pXml.match(/<w:ind\b[^>]*>/) || [])[0]
  if (!tag) return false
  // 悬挂缩进（列表项）不算首行缩进
  const hanging = Number((tag.match(/w:hanging(?:Chars)?="(\d+)"/) || [])[1] ?? 0)
  if (hanging > 0) return false
  const chars = Number((tag.match(/w:firstLineChars="(\d+)"/) || [])[1] ?? 0)
  const twips = Number((tag.match(/w:firstLine="(\d+)"/) || [])[1] ?? 0)
  // 1 字符 ≈ 100；1 字符 ≈ 210 twips（小四）。阈值取「半字符」以免把 0 判成正
  return chars >= 100 || twips >= 200
}

/** 段落内部 → 文本（`<w:t>` 取字，`<w:br>`/`<w:cr>` 换行，`<w:tab>` 制表） */
function paragraphInnerText(pXml: string): string {
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/>|<w:cr\s*\/>|<w:tab\s*\/>|<w:noBreakHyphen\s*\/>/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(pXml))) {
    const whole = m[0]
    if (m[1] !== undefined) out.push(decodeXmlEntities(m[1]))
    else if (/^<w:br|^<w:cr/.test(whole)) out.push('\n')
    else if (/^<w:tab/.test(whole)) out.push('\t')
    else out.push('-')   // noBreakHyphen：不换行连字符
  }
  return out.join('').replace(/[ \t]+\n/g, '\n')
}

/**
 * `word/document.xml` → 纯文本（**纯函数**，单测直接喂 xml）。
 *
 * 🔴 `<w:p>` 之间不会互相嵌套，所以按非贪婪匹配到第一个 `</w:p>` 是安全的；
 *    但 `<w:pPr>` / `<w:pStyle>` 这类**同前缀标签不能被误当段落开头** ——
 *    开标签团 `(?:\s[^>]*)?>` 要求 `<w:p` 之后是空白或直接收口，故不会误匹配。
 */
export function documentXmlToText(xml: string): { text: string; paragraphs: number } {
  const lines: string[] = []
  const paraRe = /<w:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:p>)/g
  let m: RegExpExecArray | null
  while ((m = paraRe.exec(xml))) {
    const inner = m[1] ?? ''
    // 🔴 只能剥**半角**首尾空白：`String.prototype.trim()` 会把全角空格（\u3000）也吃掉，
    //    于是「作者手打的全角缩进」和「下面按属性补的缩进」都会被抹平（单测抓到）。
    const body = paragraphInnerText(inner).replace(/^[ \t]+|[ \t]+$/g, '')
    if (!body.replace(/\s/g, '')) { lines.push(''); continue }
    // 已有缩进（全角空格或半角空格）就不重复补
    const already = /^[\u3000 \t]/.test(body)
    lines.push(!already && hasFirstLineIndent(inner) ? INDENT + body : body)
  }
  // 收尾：去掉首尾空段，段间多余空行压成一个
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return { text: lines.join('\n'), paragraphs: lines.length }
}

/** 只从 document.xml 就能判断「读不到」的内容（其余要看 zip 里有没有对应部件） */
function xmlSkips(xml: string): string[] {
  const out: string[] = []
  if (/<w:drawing\b|<w:pict\b/.test(xml)) out.push('图片/图形')
  if (/<m:oMath\b|<m:oMathPara\b/.test(xml)) out.push('公式')
  if (/<w:delText\b/.test(xml)) out.push('修订中已删除的文字')
  return out
}

/**
 * 读一个 .docx（或 .docx 改名而来的 zip）→ 纯文本。
 * 失败一律抛出**能直接给用户看**的中文原因（UI 会原样显示）。
 */
export async function readDocxText(data: ArrayBuffer | Uint8Array): Promise<DocxText> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (buf.byteLength < 22) throw new Error('文件太小，不是有效的 .docx')
  // 旧版 .doc / .docx 里嵌的 OLE 都是 CFB 头（D0 CF 11 E0），给一句明确的话，别让人猜
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    throw new Error('.doc 是旧版二进制格式，请在 Word 里「另存为」.docx 或 .txt 后再导入')
  }
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new Error('这不是 .docx 文件（它是个 zip 包，应为 PK 开头）')
  }

  const entries = listEntries(buf)
  const doc = entries.find(e => e.name === 'word/document.xml')
  if (!doc) {
    const looksLikeEpub = entries.some(e => /\.xhtml$|\.opf$/.test(e.name))
    throw new Error(looksLikeEpub
      ? '这看着是 .epub 电子书；请先用阅读器导出为 .txt 或 .docx'
      : 'docx 里找不到 word/document.xml（文件可能损坏）')
  }

  const xml = await readEntryText(buf, doc)
  const { text, paragraphs } = documentXmlToText(xml)

  const skipped = [...xmlSkips(xml)]
  if (entries.some(e => e.name === 'word/comments.xml')) skipped.push('批注')
  if (entries.some(e => /^word\/(footnotes|endnotes)\.xml$/.test(e.name))) skipped.push('脚注/尾注')
  if (entries.some(e => /^word\/(header|footer)\d*\.xml$/.test(e.name))) skipped.push('页眉页脚')

  return { text, paragraphs, skipped }
}

/** 是否像 docx（按扩展名判定，UI 分流用） */
export function isDocxFileName(name: string): boolean {
  return /\.docx$/i.test(name)
}

/** 是否旧版 .doc（要明确劝退，不然会以「不是有效 docx」这种模糊理由失败） */
export function isLegacyDocFileName(name: string): boolean {
  return /\.doc$/i.test(name)
}
