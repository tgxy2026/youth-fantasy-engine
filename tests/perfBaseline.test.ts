// ============ A2 · 长篇性能基线闸（300 章 / 100 万字） ============
//
// 老大 2026-09-21 定的目标：**「写到几十万字也不卡」**。
// 这句话要能验证，就不能靠感觉 —— 得有数字、有阈值、超了就红。
//
// 设计取舍（三条，改这个文件前必须读）：
//
// ① **数据程序化生成，不落压测库文件**
//    · 100 万字的库文件 ≈ 数 MB，入库会污染仓库；
//    · 固定种子 ⇒ 每次数据完全一致 ⇒ 数字可比、可复现、能看出劣化；
//    · 不依赖"先造库再导入"两步，想跑就跑。
//
// ② **阈值先宽后紧**（规划明文要求，避免偶发抖动误报）
//    当前阈值 = 本机实测 × 约 6~10 倍。理由：跑测试的机器负载差异很大，
//    宁可先"只拦断崖式劣化"，跑稳几轮再按真实分布收紧。
//    🔴 收紧阈值时**必须**重跑一次并把新实测写进下面的 MEASURED 注释，
//       否则下一个人无从判断该阈值是"量出来的"还是"拍出来的"。
//
// ③ **口径限制，不许假装这是真机耗时**
//    本闸跑在**内存存储桩**上（tests/mock-memory.ts），没有真实 IndexedDB IO。
//    数字反映**算法与数据量**，不反映磁盘 / 浏览器开销。
//    真实 UI 耗时由浏览器实机脚本量：skill 下的 `ui-perf-longbook.mjs`（手动跑）。
//    两条腿缺一条，"长篇不卡"就是半句话。
//
// 本机实测（2026-09-22，Win / RTX 5090 / 64G，正文 101.4 万字符 + 900 份快照 + 3000 表格行）：
//   造数 105ms｜冷启动 6~17ms｜切章 0.1ms｜保存 1.4ms｜建索引 121~151ms｜查询 3.2~4.5ms
//   TXT 0.9ms｜MD 2.3ms｜平台版 3.6ms｜大表格 0.4ms｜AI 摘要 0.5ms｜整书包 0.6ms
//   注：冷启动与建索引两次跑有可见抖动（6.4 / 16.3ms、150 / 121ms）——这正是阈值要留 6 倍+ 的原因。
import * as db from '../src/lib/db'
import { SearchEngine } from '../src/lib/search/search'
import { chaptersToTxt, bookToMarkdown, bookToPlatformText } from '../src/lib/storage/exporter'
import { buildChapterDigest } from '../src/lib/ai/aiContext'
import { buildBookEvidencePack } from '../src/lib/audit/bookEvidence'
import { countWords } from '../src/lib/editor/textStats'
import { chunkChapter } from '../src/lib/semantic/chunk'
import { parseImportText, mapHeaders, matrixToRows } from '../src/lib/storage/tableIO'
import { scanText } from '../src/lib/editor/sensitiveWords'
import type { Chapter, Volume, TableRow, CardRecord, TabDef } from '../src/lib/types'

let pass = 0, fail = 0
/**
 * 🔴 与别处不同：这里 **PASS 也打印 extra**。
 * 本闸的产出之一就是那张耗时表（规划验收要「拿到真实耗时」），
 * 数字只在失败时可见的话，跑一次全绿就等于什么都没留下。
 */
function ok(name: string, cond: boolean, extra = '') {
  const tail = extra ? `  ${extra}` : ''
  if (cond) { pass++; console.log(`PASS ${name}${tail}`) }
  else { fail++; console.log(`FAIL ${name}${tail}`) }
}

// ---------- 固定种子的伪随机（保证每次数据完全一致） ----------
let seed = 42
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
function pick<T>(arr: T[]): T { return arr[Math.floor(rnd() * arr.length)] }

const WORDS = [
  '剑光', '山门', '青石', '夜色', '灵气', '经脉', '丹田', '师尊', '弟子', '阵法',
  '符箓', '妖兽', '洞府', '秘境', '传承', '血脉', '神识', '真元', '法宝', '禁制',
  '风声', '火光', '寒意', '血迹', '残垣', '断壁', '钟声', '雾气', '雷劫', '道韵',
]
const VERBS = ['掠过', '斩下', '凝聚', '溃散', '翻涌', '沉寂', '燃烧', '剥落', '震颤', '流转']
const PARTICLES = ['的', '了', '着', '与', '在', '从', '向', '却', '便', '又']

function sentence(): string {
  const n = 4 + Math.floor(rnd() * 5)
  let s = ''
  for (let i = 0; i < n; i++) {
    s += pick(WORDS)
    if (i % 3 === 1) s += pick(VERBS)
    if (rnd() < 0.35) s += pick(PARTICLES)
    if (rnd() < 0.25) s += '，'
  }
  return s + '。'
}
function paragraph(): string {
  const n = 2 + Math.floor(rnd() * 3)
  const parts: string[] = []
  for (let i = 0; i < n; i++) parts.push(sentence())
  return '　　' + parts.join('')
}

// ---------- 规模：A2 规划要求 300 章 / 约 100 万字 ----------
const VOLUMES = 10
const PER_VOLUME = 30
const CHAPTERS = VOLUMES * PER_VOLUME
const PARAS_PER_CHAPTER = 52        // ≈ 4100 字/章 × 300 ≈ 123 万字符 → 约 100 万「字」
const SNAPS_PER_CHAPTER = 3
const TABLE_ROWS = 3000
const CARDS = 60

// ---------- 阈值（先宽后紧；收紧时须同步更新上面 MEASURED 注释） ----------
const LIMIT = {
  seed: 3000,      // 造数：只在数据规模变了才会超
  boot: 800,       // 冷启动读全量章节
  openChapter: 200,
  save: 300,
  index: 2500,     // 检索建索引（实测最重的一项）
  search: 300,
  txt: 300,
  md: 300,
  platform: 400,
  table: 300,
  digest: 300,
  bookPack: 1500,  // 整书证据包（含 900 份快照的归类）
  // ── 2.7~2.8 新增路径（2026-10-06 补入：语义切块 / 表格导入 / 敏感词扫描）──
  chunk: 200,       // 全书切块（100 万字 → 数千块）
  importParse: 200, // 表格导入：文本 → 表格（3000 行）
  importMap: 200,   // 表格导入：表头映射 → 行对象
  scan: 1500,       // 敏感词扫描（100 万字 × 千余词）：纯算法、复杂度 O(词数×字数)，
                    //   本项余量天然比别的项小（实测 ≈256ms）—— 阈值按本文件口径「实测 × ≈6」定
}

const PID = 'p-perf'
const now = Date.now()

function msOf(fn: () => Promise<unknown> | unknown): Promise<number> {
  const t0 = performance.now()
  return Promise.resolve(fn()).then(() => performance.now() - t0)
}
const pct = (v: number, limit: number) => `${v.toFixed(1)}ms / 阈值 ${limit}ms（余量 ${(limit / Math.max(v, 0.01)).toFixed(1)}×）`

async function main() {
  console.log(`\n规模：${VOLUMES} 卷 × ${PER_VOLUME} 章 = ${CHAPTERS} 章　快照 ${CHAPTERS * SNAPS_PER_CHAPTER} 份　表格 ${TABLE_ROWS} 行　卡片 ${CARDS} 张\n`)

  // ══════════ 造数（不参与判定，但它本身不能慢到离谱） ══════════
  let totalChars = 0
  const tSeed = await msOf(async () => {
    await db.createProject('压测书', '玄幻', '')
    // 🔴 压测数据硬编码 projectId，必须显式切过去才读得到（存储层按当前项目过滤）
    db.setCurrentProject(PID)
    const vols: Volume[] = []
    for (let v = 0; v < VOLUMES; v++) {
      const vol: Volume = {
        id: `v${v}`, projectId: PID, order: v, title: `第${v + 1}卷 卷名${v + 1}`,
        description: '压测卷', createdAt: now + v,
      }
      vols.push(vol)
      await db.saveVolume(vol)
    }
    for (let v = 0; v < VOLUMES; v++) {
      for (let c = 0; c < PER_VOLUME; c++) {
        const idx = v * PER_VOLUME + c
        const paras: string[] = []
        for (let p = 0; p < PARAS_PER_CHAPTER; p++) paras.push(paragraph())
        const content = paras.join('\n')
        totalChars += content.length
        const ch: Chapter = {
          id: `c${idx}`, projectId: PID, volumeId: `v${v}`, order: c,
          title: `第${idx + 1}章 标题${idx + 1}`,
          content, summary: '', status: '草稿',
          wordCount: countWords(content),
          createdAt: now + idx, updatedAt: now + idx,
        }
        await db.saveChapter(ch)
        // 每章 3 份快照：让「整书证据包」这条测的是真实负载，而不是空跑
        for (let s = 0; s < SNAPS_PER_CHAPTER; s++) {
          await db.createSnapshot({ ...ch, content: content.slice(0, content.length - s * 300) }, s === 0 ? 'ai-rewrite' : 'auto')
        }
      }
    }
    for (let i = 0; i < TABLE_ROWS; i++) {
      const row: TableRow = {
        id: `r${i}`, projectId: PID, tabId: 'characters', order: i,
        data: {
          姓名: `角色${i}`, 身份: pick(['主角', '配角', '反派', '路人']),
          简介: sentence() + sentence(), 备注: i % 7 === 0 ? sentence() : '',
        },
        createdAt: now + i,
      }
      await db.saveTableRow(row)
    }
    for (let i = 0; i < CARDS; i++) {
      const rec: CardRecord = {
        id: `k${i}`, projectId: PID, tabId: 'characters', name: `角色卡${i}`,
        data: { 姓名: `角色${i}`, 性格: sentence(), 背景: sentence() + sentence() },
        order: i, createdAt: now + i,
      }
      await db.saveCardRecord(rec)
    }
  })
  console.log(`· 造数（写库）      ${pct(tSeed, LIMIT.seed)}　正文 ${(totalChars / 10000).toFixed(1)} 万字符`)

  // 🔴 规模自检：规模变了而阈值没跟着调，这条会先红，避免"阈值失效还全绿"的假象
  const words100k = totalChars / 10000
  ok(`🔴 规模自检：正文 ≥ 100 万字符（实测 ${words100k.toFixed(1)} 万）`, totalChars >= 1_000_000)
  ok(`🔴 造数耗时 ≤ ${LIMIT.seed}ms`, tSeed <= LIMIT.seed, pct(tSeed, LIMIT.seed))

  // ══════════ ① 冷启动：读全量章节 ══════════
  let chs: Chapter[] = []
  const tBoot = await msOf(async () => {
    await db.getAllVolumes()
    chs = await db.getAllChapters()
  })
  ok(`🔴 ① 冷启动读全量 ≤ ${LIMIT.boot}ms`, tBoot <= LIMIT.boot, pct(tBoot, LIMIT.boot))
  ok('① 章节数对得上（300）', chs.length === CHAPTERS, String(chs.length))

  // ══════════ ② 切章：定位 + 计字 ══════════
  const tOpen = await msOf(() => countWords(chs[Math.floor(chs.length / 2)].content))
  ok(`② 切章（含计字）≤ ${LIMIT.openChapter}ms`, tOpen <= LIMIT.openChapter, pct(tOpen, LIMIT.openChapter))

  // ══════════ ③ 保存落盘 ══════════
  const target = chs[Math.floor(chs.length / 2)]
  const tSave = await msOf(async () => {
    const next = target.content + '\n　　' + sentence()
    await db.saveChapter({ ...target, content: next, wordCount: countWords(next), updatedAt: Date.now() })
  })
  ok(`③ 保存一章 ≤ ${LIMIT.save}ms`, tSave <= LIMIT.save, pct(tSave, LIMIT.save))

  // ══════════ ④ 全文检索 ══════════
  const engine = new SearchEngine()
  const tIndex = await msOf(() => engine.build({ type: 'full', features: [] }))
  const tSearch = await msOf(() => { engine.search('剑光 灵气 秘境') })
  ok(`🔴 ④a 检索·建索引 ≤ ${LIMIT.index}ms`, tIndex <= LIMIT.index, pct(tIndex, LIMIT.index))
  ok(`④b 检索·查询 ≤ ${LIMIT.search}ms`, tSearch <= LIMIT.search, pct(tSearch, LIMIT.search))

  // ══════════ ⑤ 导出全书 ══════════
  const vols = await db.getAllVolumes()
  const tTxt = await msOf(() => { chaptersToTxt(chs, vols) })
  const tMd = await msOf(() => { bookToMarkdown('压测书', vols, chs) })
  const tPlat = await msOf(() => { bookToPlatformText(vols, chs) })
  ok(`⑤a 导出 TXT ≤ ${LIMIT.txt}ms`, tTxt <= LIMIT.txt, pct(tTxt, LIMIT.txt))
  ok(`⑤b 导出 Markdown ≤ ${LIMIT.md}ms`, tMd <= LIMIT.md, pct(tMd, LIMIT.md))
  ok(`⑤c 导出平台粘贴版 ≤ ${LIMIT.platform}ms`, tPlat <= LIMIT.platform, pct(tPlat, LIMIT.platform))

  // ══════════ ⑥ 打开大表格 ══════════
  const tTable = await msOf(async () => {
    const rows = await db.getTableRows('characters')
    rows.sort((a, b) => a.order - b.order)
  })
  ok(`⑥ 打开大表格（${TABLE_ROWS} 行）≤ ${LIMIT.table}ms`, tTable <= LIMIT.table, pct(tTable, LIMIT.table))

  // ══════════ ⑦ AI 上下文组装 ══════════
  const tDigest = await msOf(() => buildChapterDigest(200))
  ok(`⑦ AI 上下文摘要 ≤ ${LIMIT.digest}ms`, tDigest <= LIMIT.digest, pct(tDigest, LIMIT.digest))

  // ══════════ ⑧ 整书证据包（A4 刚落地，长篇下最容易炸） ══════════
  const snaps = await db.getAllSnapshots()
  const outlineCards = await db.getCardRecords('chapter-outline')
  const tPack = await msOf(() => {
    buildBookEvidencePack({
      projectName: '压测书', volumes: vols, chapters: chs,
      snapshots: snaps, outlineCards, dailyStats: [],
    })
  })
  ok(`🔴 ⑧ 整书证据包（${snaps.length} 份快照）≤ ${LIMIT.bookPack}ms`, tPack <= LIMIT.bookPack, pct(tPack, LIMIT.bookPack))
  ok('⑧ 快照数对得上（900）', snaps.length === CHAPTERS * SNAPS_PER_CHAPTER, String(snaps.length))

  // ══════════ ⑨ 语义切块（2.8.0 新增；索引链路里最重的一段纯算法） ══════════
  {
    let chunks = 0
    const t = await msOf(() => { for (const c of chs) chunks += chunkChapter(c.content).length })
    ok(`⑨ 全书切块（${chs.length} 章 → ${chunks} 块）≤ ${LIMIT.chunk}ms`, t <= LIMIT.chunk, pct(t, LIMIT.chunk))
    // 规模自检：块数与字数强相关，掉了说明切块参数被改动过（4 千块级是 100 万字的正常量）
    ok('⑨ 块数在合理区间（100 万字 ≈ 3~6 千块）', chunks >= 1500 && chunks <= 9000, String(chunks))
  }

  // ══════════ ⑩ 表格导入（2.7 新增；「粘表格文本 → 落库」的真实链路） ══════════
  //   链路＝ parseImportText（认格式）→ mapHeaders（表头→schema 列）→ matrixToRows（出记录）。
  //   ⚠️ 别用 textToRows 当这条路：它是「纯文本兜底」（整段塞主列、逐行一条），不是 TSV 表格映射器。
  {
    const rowsAll = await db.getTableRows('characters')
    const probeTab = {
      id: 'characters', name: '角色', columns: [
        { name: '名称', type: 'text' }, { name: '简介', type: 'textarea' }, { name: '等级', type: 'number' },
      ],
    } as unknown as TabDef
    const tsv = ['名称\t简介\t等级', ...rowsAll.map((_r, i) => `条目${i}\t这是用来占位的简介文字${i}\t${i % 10}`)].join('\n')
    let parsedFormat = ''
    const tParse = await msOf(() => { parsedFormat = parseImportText(tsv).format })
    let mapped = 0
    const tMap = await msOf(() => {
      const parsed = parseImportText(tsv)
      if (parsed.table) mapped = matrixToRows(parsed.table, mapHeaders(parsed.table.headers, probeTab), probeTab).length
    })
    ok(`⑩a 表格导入·解析（${rowsAll.length} 行 TSV）≤ ${LIMIT.importParse}ms`, tParse <= LIMIT.importParse, pct(tParse, LIMIT.importParse))
    ok('⑩a2 认出了制表符格式', parsedFormat === 'tsv', parsedFormat)
    ok(`⑩b 表格导入·映射 → ${mapped} 行 ≤ ${LIMIT.importMap}ms`, tMap <= LIMIT.importMap, pct(tMap, LIMIT.importMap))
    // 表头行被 mapHeaders 消耗掉，所以出参行数应等于源数据行数（多一条少一条都说明映射漏/重了）
    ok('⑩b2 映射行数与源数据行数一致（表头不计入）', mapped === rowsAll.length, `${mapped} vs ${rowsAll.length}`)
  }

  // ══════════ ⑪ 敏感词扫描（发布前自检的确定性项，全本地、不花额度） ══════════
  {
    const words = Array.from({ length: 500 }, (_, i) => `禁用词${i}`)
    // ⚠️ 拼接必须在计时之外 —— 否则量到的是「拼串 + 扫描」，不是扫描本身
    const whole = chs.map(c => c.content).join('\n')
    const t = await msOf(() => { scanText(whole, words) })
    ok(`⑪ 敏感词扫描（100 万字 × ${words.length} 词）≤ ${LIMIT.scan}ms`, t <= LIMIT.scan, pct(t, LIMIT.scan))
  }

  console.log(`\n—— perfBaseline：${pass} 通过 / ${fail} 失败 ——`)
  console.log('（口径：内存存储桩，无真实 IndexedDB IO；反映算法与数据量，非真机耗时）\n')
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error('性能闸异常：', e); process.exit(1) })
