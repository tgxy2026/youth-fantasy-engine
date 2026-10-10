// ============ C9（2.4.2）拆书支持 .docx —— 手写解析、零依赖 ============
//
// 这一层最怕的四种静默失败：
//   ① 只支持自己写出来的 zip（store 方式），而**用户手里 Word 导出的 docx 是 deflate 压缩** ——
//      只测前者就会「自己 round-trip 全绿、真文件一导入就报错」；
//   ② 解析时把整段文字丢了还不吭声（批注 / 脚注 / 图片 / 公式读不到，必须如实回报）；
//   ③ `.doc`（旧二进制）与 `.epub` 混进来，只给一句「读取失败」让人无从下手；
//   ④ Word 的**首行缩进是段落属性**（`<w:ind w:firstLineChars="200"/>`）不是字符，纯文本化会丢
//      —— 与导出侧「禁行首 trim」的 A5 口径不对等。
import { ZipBuilder } from '../src/lib/storage/zip'
import {
  decodeXmlEntities, documentXmlToText, isDocxFileName, isLegacyDocFileName, readDocxText,
} from '../src/lib/storage/docxImport'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ docxImport')

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
/** 把一个 body 片段包成最小可用的 document.xml */
const doc = (body: string) => `<w:document ${NS}><w:body>${body}</w:body></w:document>`
/** 一个普通段（可选首行缩进属性） */
const para = (text: string, indAttrs = '') =>
  `<w:p>${indAttrs ? `<w:pPr><w:ind ${indAttrs}/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

// ---------- 1. 纯函数：XML → 文本 ----------
{
  const r = documentXmlToText(doc(para('第一段。') + para('第二段。')))
  ok('两段 → 两行', r.text === '第一段。\n第二段。' && r.paragraphs === 2, JSON.stringify(r.text))

  // 首尾空段去掉、中间空段保留
  const r2 = documentXmlToText(doc('<w:p/>' + para('甲') + '<w:p/>' + para('乙') + '<w:p/>'))
  ok('首尾空段去掉、中间空段保留', r2.text === '甲\n\n乙' && r2.paragraphs === 3, JSON.stringify(r2.text))

  // 段内 <w:br/> 换行、<w:tab/> 制表
  const br = documentXmlToText(doc('<w:p><w:r><w:t>上句</w:t><w:br/><w:t>下句</w:t></w:r></w:p>'))
  ok('段内 <w:br/> 变成换行', br.text === '上句\n下句', JSON.stringify(br.text))
  const tab = documentXmlToText(doc('<w:p><w:r><w:t>甲</w:t><w:tab/><w:t>乙</w:t></w:r></w:p>'))
  ok('段内 <w:tab/> 变成制表符', tab.text === '甲\t乙', JSON.stringify(tab.text))

  // 🔴 <w:pPr> / <w:pStyle> 不能被当成段落开标签（同前缀误匹配）
  const style = documentXmlToText(doc(
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第1章 风起</w:t></w:r></w:p>',
  ))
  ok('🔴 <w:pPr>/<w:pStyle> 不被误当段落（段数=1）', style.paragraphs === 1 && style.text === '第1章 风起',
    `segments=${style.paragraphs} text=${JSON.stringify(style.text)}`)

  // 首行缩进：Word 的两种写法都要认
  const indChars = documentXmlToText(doc(para('缩进段。', 'w:firstLineChars="200"')))
  ok('🔴 首行缩进（firstLineChars=200）→ 补全角缩进',
    indChars.text === '\u3000\u3000缩进段。', JSON.stringify(indChars.text))
  const indTwips = documentXmlToText(doc(para('缩进段。', 'w:firstLine="420"')))
  ok('🔴 首行缩进（firstLine=420 twips）→ 补全角缩进',
    indTwips.text === '\u3000\u3000缩进段。', JSON.stringify(indTwips.text))
  const noInd = documentXmlToText(doc(para('不缩进段。', 'w:firstLine="0"')))
  ok('firstLine=0 不补缩进', noInd.text === '不缩进段。', JSON.stringify(noInd.text))
  const hanging = documentXmlToText(doc(para('列表项。', 'w:firstLineChars="200" w:hanging="420"')))
  ok('悬挂缩进（列表项）不补缩进', hanging.text === '列表项。', JSON.stringify(hanging.text))
  const already = documentXmlToText(doc(para('\u3000\u3000已带缩进。', 'w:firstLineChars="200"')))
  ok('🔴 段落已带全角缩进 → 不重复补',
    already.text === '\u3000\u3000已带缩进。', JSON.stringify(already.text))

  // 实体
  const ent = documentXmlToText(doc(para('&lt;标题&gt; &amp; 作者&#x4e2d;&#25991;&quot;&#39;')))
  ok('XML 实体解码（含十六进制与十进制数字实体）',
    ent.text === '<标题> & 作者中文"\'', JSON.stringify(ent.text))
}

// ---------- 2. 实体解码不能二次解码 ----------
{
  ok('🔴 &amp;lt; 解成 &lt; 而不是 <（单次扫描）',
    decodeXmlEntities('&amp;lt;') === '&lt;', decodeXmlEntities('&amp;lt;'))
  ok('数字实体越界不炸（退回原文）',
    decodeXmlEntities('&#x110000;') === '&#x110000;', decodeXmlEntities('&#x110000;'))
}

// ---------- 3. 端到端：两种压缩方式都要读得出来 ----------
/** 造一个最小 zip（store 或 deflate-raw），用来分别覆盖两条解压路径 */
async function makeZip(files: { name: string; content: string; store?: boolean }[]): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const deflate = async (s: string) => {
    const cs = new CompressionStream('deflate-raw')
    const w = cs.writable.getWriter()
    void w.write(enc.encode(s) as unknown as BufferSource)
    void w.close()
    return new Uint8Array(await new Response(cs.readable).arrayBuffer())
  }
  const blocks: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const nameBytes = enc.encode(f.name)
    const raw = enc.encode(f.content)
    const data = f.store ? raw : await deflate(f.content)
    const method = f.store ? 0 : 8
    const local = new Uint8Array(30 + nameBytes.length)
    const dv = new DataView(local.buffer)
    dv.setUint32(0, 0x04034b50, true)
    dv.setUint16(4, 20, true)
    dv.setUint16(8, method, true)
    dv.setUint32(18, data.length, true)   // 解析器不校验 CRC，这里填 0
    dv.setUint32(22, raw.length, true)
    dv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    blocks.push(local, data)

    const cen = new Uint8Array(46 + nameBytes.length)
    const cd = new DataView(cen.buffer)
    cd.setUint32(0, 0x02014b50, true)
    cd.setUint16(4, 20, true)
    cd.setUint16(6, 20, true)
    cd.setUint16(10, method, true)
    cd.setUint32(20, data.length, true)
    cd.setUint32(24, raw.length, true)
    cd.setUint16(28, nameBytes.length, true)
    cd.setUint32(42, offset, true)
    cen.set(nameBytes, 46)
    centrals.push(cen)
    offset += local.length + data.length
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const all = [...blocks, ...centrals, eocd]
  const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0))
  let p = 0
  for (const a of all) { out.set(a, p); p += a.length }
  return out
}

const BODY = doc(para('第1章 风起') + para('风起了。', 'w:firstLineChars="200"') + para('云涌。'))

{
  // store：项目自己 exportDOCX 写出来的那种
  const { text } = await readDocxText(await makeZip([{ name: 'word/document.xml', content: BODY, store: true }]))
  ok('端到端：store（未压缩）docx 能读',
    text === '第1章 风起\n\u3000\u3000风起了。\n云涌。', JSON.stringify(text))

  // deflate：🔴 Word 导出的真实情况，只测 store 会漏
  const { text: t2, paragraphs } = await readDocxText(await makeZip([{ name: 'word/document.xml', content: BODY }]))
  ok('🔴 端到端：deflate 压缩 docx 能读（Word 的真实情况）',
    t2 === '第1章 风起\n\u3000\u3000风起了。\n云涌。' && paragraphs === 3, JSON.stringify(t2))

  // 与 exportDOCX 对称：自己写出来的 zip 自己读得回来
  const zb = new ZipBuilder()
  zb.add('[Content_Types].xml', '<Types/>')
  zb.add('word/document.xml', doc(para('第2章 云涌') + para('　　正文一。')))
  const { text: t3 } = await readDocxText(zb.build())
  ok('往返：ZipBuilder 写出的 docx 能原样读回（与 exportDOCX 对称）',
    t3 === '第2章 云涌\n\u3000\u3000正文一。', JSON.stringify(t3))
}

// ---------- 4. 失败理由必须能直接给用户看 ----------
async function expectError(name: string, input: Uint8Array | ArrayBuffer, mustInclude: string) {
  try {
    await readDocxText(input)
    ok(name, false, '本该报错却成功了')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ok(name, msg.includes(mustInclude), msg)
  }
}

{
  const cfb = new Uint8Array(64)
  cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0)
  await expectError('.doc（CFB 头）→ 明确劝「另存为 .docx / .txt」', cfb, '另存为')

  await expectError('不是 zip（PK 开头）→ 明确说这不是 docx',
    new TextEncoder().encode('这是一篇小说正文，不是 docx 文件，长度够 64 字节用来过最小长度检查。'.repeat(3)),
    '不是 .docx')

  await expectError('缺 word/document.xml → 说文件可能损坏',
    await makeZip([{ name: 'word/other.xml', content: '<x/>' }]), '找不到 word/document.xml')

  await expectError('epub 混进来 → 指路「导出为 .txt 或 .docx」',
    await makeZip([{ name: 'OEBPS/ch1.xhtml', content: '<html/>' }, { name: 'content.opf', content: '<package/>' }]),
    'epub')

  await expectError('文件太小 → 直接说不是有效 docx', new Uint8Array(4), '太小')
}

// ---------- 5. 读不到的东西必须如实回报（不静默丢） ----------
{
  const withExtras = doc(
    '<w:p><w:r><w:drawing/></w:r><w:r><m:oMath><m:t>x</m:t></m:oMath></w:r>'
    + '<w:r><w:delText>删掉的</w:delText></w:r><w:r><w:t>留下的</w:t></w:r></w:p>',
  )
  const { text, skipped } = await readDocxText(await makeZip([
    { name: 'word/document.xml', content: withExtras },
    { name: 'word/comments.xml', content: '<w:comments/>' },
    { name: 'word/header1.xml', content: '<w:hdr/>' },
    { name: 'word/footnotes.xml', content: '<w:footnotes/>' },
  ]))
  ok('图片 / 公式 / 修订删除 / 批注 / 页眉页脚 / 脚注 全部如实回报',
    ['图片/图形', '公式', '修订中已删除的文字', '批注', '页眉页脚', '脚注/尾注']
      .every(s => skipped.includes(s)),
    skipped.join('、'))
  ok('回报了「读不到的」同时，读得到的照读',
    text === '留下的', JSON.stringify(text))
  ok('没有批注等部件时不虚报', (await readDocxText(await makeZip([{ name: 'word/document.xml', content: BODY }]))).skipped.length === 0)

  // 纯文本 docx：不该有任何 skipped
  ok('扩展名判定：.docx / .DOCX 都算，.doc / .docx.txt 不算',
    isDocxFileName('a.docx') && isDocxFileName('A.DOCX') && !isDocxFileName('a.doc') && !isDocxFileName('a.docx.txt'))
  ok('旧格式判定：.doc 命中（.docx 不命中）',
    isLegacyDocFileName('a.doc') && isLegacyDocFileName('A.DOC') && !isLegacyDocFileName('a.docx'))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
