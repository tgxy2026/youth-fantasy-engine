/**
 * 《章节细纲》卡的**命名与解析** —— 唯一来源。
 *
 * 【为什么单独一个模块】
 * 细纲卡的卡名是「第N章 标题」这条约定，被三处用到：`aiWorkflow.commitOutline` 写卡名、
 * `loadChapterOutlines` 按卡名取章号、正文概要回填时按章号匹配。三处各自拼一次字符串或写一次正则，
 * 就一定会漂移 —— 而漂移的表现是「细纲读不回来」，两边看着却都对（红线里的经典坑）。
 * 所以把拼法与解析收在这里。
 *
 * ⚠️ 这是**卡名**约定，不是"章节标题里有没有章号"。后者在 `chapterSeq` 里是刻意**不解析**的
 *   （作者把章名叫「序章」「番外·铁柱传」都不影响叙事顺序）。别把两者混为一谈。
 */
import { resolveSlot } from '@/lib/flow/fieldMap'

/** 细纲卡所在的页签 id */
export const OUTLINE_TAB_ID = 'chapter-outline'

/** 「本章一句话事件」的**语义**槽位名；真键（`模块::字段`）用 `outlineEventKey()` 现查 */
const OUTLINE_EVENT_SLOT = '本章一句话事件'

/** 细纲卡的标准卡名：`第3章 风云`（标题为空时退化为 `第3章`） */
export function outlineCardName(no: number, title: string): string {
  return `第${no}章 ${(title ?? '').trim()}`.trim()
}

/** 中文数字 → 阿拉伯数字（细纲卡名写「第一章」时也能认出来） */
const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/**
 * 中文数字字符串 → 数字。**只认得下的话返回 0**（一 / 十 / 十一 / 二十 / 三十五 …）。
 * 🔴 出现不认识的字一律判失败 —— 章号宁可取不到（走「没找到细纲」的显式提示），
 *    也绝不能猜出一个**错章号**把别章的细纲喂进本章。
 */
function cnToNum(text: string): number {
  let total = 0, section = 0, num = 0
  for (const ch of text) {
    const v = CN_DIGITS[ch]
    if (v !== undefined) { num = v; continue }
    if (ch === '十') { section += (num || 1) * 10; num = 0; continue }
    if (ch === '百') { section += (num || 1) * 100; total += section; section = 0; num = 0; continue }
    return 0 // 认不出的字 → 整串判失败
  }
  return total + section + num
}

/**
 * 从细纲卡名取章号；取不到返回 0。
 *
 * 🔴 2026-10-03 放宽（原只认阿拉伯数字）：作者手打「第一章」这类中文数字时，
 *    解析失败会让**整张细纲表取不到**（`loadChapterOutlines` 静默返回空 map），
 *    正文生成时提示词里那行细纲整块消失，模型变成自由发挥 ——
 *    用户看到的就是「AI 没按细纲写，甚至写了后面章节的内容」，且界面零提示。
 *    中文数字只是其中一种形态；写不出数字时仍返回 0，由调用方走显式提示。
 */
export function chapterNoOf(cardName: string): number {
  const name = cardName ?? ''
  const arabic = name.match(/第\s*(\d+)\s*章/)
  if (arabic) return parseInt(arabic[1], 10)
  const cn = name.match(/第\s*([零〇一二两三四五六七八九十百]+)\s*章/)
  if (cn) return cnToNum(cn[1])
  return 0
}

/**
 * 「本章一句话事件」的真实存储键（`模块::字段`）。
 * 🔴 可能返回 null（schema 改过字段名）—— 调用方必须处理，别硬写一个不存在的键，
 *    那会写出一列幽灵数据。
 */
export function outlineEventKey(): string | null {
  return resolveSlot(OUTLINE_TAB_ID, OUTLINE_EVENT_SLOT)
}

// ==================== 「本卷章号范围」（分卷大纲卡，2026-09-20）====================
//
// 这组函数服务一件事：**长篇分批创作时，正文要知道"第 N 章该落进哪一卷"**。
// 没有它，逐章连写会把所有新章都塞进最后一卷（第 21 章留在卷一），卷归属与大纲对不上。

/** 卷大纲卡所在的页签 id */
export const VOLUME_OUTLINE_TAB_ID = 'volume-outline'

/** 「本卷章号范围」的**语义**槽位名（真键用 `volumeRangeKey()` 现查） */
const VOLUME_RANGE_SLOT = '本卷章号范围'

/** 「本卷章号范围」的真实存储键；schema 里没这一列时返回 null */
export function volumeRangeKey(): string | null {
  return resolveSlot(VOLUME_OUTLINE_TAB_ID, VOLUME_RANGE_SLOT)
}

/** 章号范围的规范写法：单章 `第7章`，多章 `第1-20章` */
export function formatChapterRange(from: number, to: number): string {
  return from === to ? `第${from}章` : `第${from}-${to}章`
}

/**
 * 解析「本卷章号范围」的值；取不到返回 null。
 *
 * 容错来自现实：这列作者**可以手改**，模型也可能在别处带出这个写法 ——
 * 波浪号全角半角、`到` / `至` / `-` 都得认（漏一种就是"这卷的章全落不进去"）。
 */
export function parseChapterRange(text: string): { from: number; to: number } | null {
  const s = (text ?? '').replace(/[～~—–－_]/g, '-').trim()
  if (!s) return null
  const two = s.match(/(\d+)\s*(?:-|到|至)\s*(\d+)/)
  const one = s.match(/第?\s*(\d+)\s*章/)
  const m = two ?? one
  if (!m) return null
  const from = parseInt(m[1], 10)
  const to = two && m[2] ? parseInt(m[2], 10) : from
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to < from) return null
  return { from, to }
}

/**
 * 按「每卷章数」硬指标算出每卷的章号范围并填进去。
 *
 * 🔴 **为什么由系统算、不让模型写**：每卷章数是硬指标（第 k 卷 = 第 (k-1)×M+1 ~ k×M 章），
 *    而模型经常从 1 重新数、或把卷边界写飘。这条边界直接决定"第 21 章落进哪一卷"，
 *    错一次就是整卷正文错位 —— 与「章号由系统定、不信模型返回的 no」是同一条纪律。
 *
 * @param volumes    本批产出的卷（顺序即卷序）
 * @param fromNo     本批第一卷的起始章号（接续时＝已有细纲最大章号 + 1）
 * @param perVolume  每卷章数（硬指标）
 */
export function fillChapterRanges<T extends { chapterRange: string }>(
  volumes: T[], fromNo: number, perVolume: number, actualChapters?: number,
): T[] {
  if (!(perVolume > 0)) return volumes
  const start = Math.max(1, fromNo)
  /**
   * 🔴 `actualChapters`（本批实际排出的章数）必须传，否则会落出**幽灵卷范围**：
   *    模型偶尔写一半就收尾（实测 2 卷 × 10 章只给了 10 章），若仍按"承诺的每卷章数"算，
   *    第二卷会拿到「第32-41章」而那 10 章**根本不存在** —— 作者以为大纲已排到 41 章，
   *    正文写到那里时会找不到对应细纲。
   *    给了它：最后一卷的范围按实际章数收敛，越界的卷**整卷丢弃**。
   */
  const lastNo = actualChapters === undefined ? null : start + Math.max(0, actualChapters) - 1
  const out: T[] = []
  for (let i = 0; i < volumes.length; i++) {
    const from = start + i * perVolume
    if (lastNo !== null && from > lastNo) break
    const to = lastNo === null ? from + perVolume - 1 : Math.min(from + perVolume - 1, lastNo)
    out.push({ ...volumes[i], chapterRange: formatChapterRange(from, to) })
  }
  return out
}

/**
 * 一卷的章号区间（含标题，正文切卷时要按标题找到真实的卷记录）。
 *
 * ⚠️ 判定**保留**（2026-10-03 六维审计 D6，见 `docs/2.7.3-六维审计修复记录-2026-10-03.md`）：
 *    「正文切卷」尚未落地 ⇒ 接口整体无消费者；但它是零运行时开销的导出类型，删掉只会让
 *    `docs/2.5.2-开发记录.md` 的引用悬空，收益为零。
 *    🔴 2026-10-04 补正：本注释原先自称「已在扫描器 KEEP 表登记」，但表里其实没登记它
 *    （文档漂移）⇒ 现已真正登记进 `audit-dead.mjs` 的 `KEEP`，报告不再把它列为死代码。
 */
export interface VolumeRange {
  title: string
  from: number
  to: number
}

// ==================== 「未排满的卷」检测（缺口优先，2026-09-20）====================
//
// 这一组函数服务一件事：**长篇分批排纲时，先把没排满的卷补齐，再谈开新卷**。
//
// 【为什么需要】老大 2026-09-20 的场景：规划是每卷 10 章，库里已有 3 卷、细纲排到第 21 章
//   ——前两卷满了，第三卷还差 9 章。此时若按"细纲最大章号 + 1"直接往下排，会**跳过第三卷的
//   后半段**、另开第四卷，作者规划的卷就成了残卷（第四卷的第 31 章接不上第三卷的第 22-30 章）。
//
// 【卷边界从哪来（三级取用）】
//   ① 「本卷章号范围」—— 系统排纲时写入的结构化字段（新数据，权威）；
//   ② 「本卷章数预估」—— 老数据里的自由文本，作者本来就爱写成 `第11-20章，约四万六千字`；
//   ③ 只解析到**单章起点**时（如 `第21章起（已写第21章）`），用本次的「每卷章数」把上界补成
//      `起点 + M - 1`。这一级是**推定**，但推定值会随状态行明示给作者，可被纠正。

/** 取卷边界时依次尝试的槽位名（顺序即优先级） */
export const VOLUME_BOUND_SLOTS = ['本卷章号范围', '本卷章数预估'] as const

/** 从一张卷大纲卡里取出章号范围的**候选文本**（按优先级；空串已滤掉） */
export function volumeBoundTextsOf(card: { data: Record<string, string> }): string[] {
  return VOLUME_BOUND_SLOTS
    .map(slot => {
      const key = resolveSlot(VOLUME_OUTLINE_TAB_ID, slot)
      return key ? (card.data[key] ?? '').trim() : ''
    })
    .filter(Boolean)
}

/**
 * 从候选文本里解出这一卷的目标章号区间；都解不出返回 null（＝该卷边界未知，跳过不猜）。
 *
 * `perVolume` 只在**单章式**文本上生效（见上「三级取用」③）。
 */
export function volumeBoundOf(
  texts: readonly (string | undefined)[], perVolume: number,
): { from: number; to: number } | null {
  const m = Math.max(1, Math.round(perVolume) || 1)
  for (const t of texts) {
    const r = parseChapterRange(t ?? '')
    if (!r) continue
    // 完整区间（`第11-20章`）直接用；单章（`第21章起` / `第21章`）用每卷章数补上界
    return r.to > r.from ? r : { from: r.from, to: r.from + m - 1 }
  }
  return null
}

/** 一卷的「未排满」信息（闭区间） */
export interface VolumeGap {
  /** 卷名（＝卷大纲卡的卡名） */
  title: string
  /** 该卷的目标章号范围 */
  from: number
  to: number
  /** 尚未排细纲的那一段：`gapFrom` ~ `gapTo` */
  gapFrom: number
  gapTo: number
}

/**
 * 找**第一个没排满的卷** —— 缺口补齐的依据；都排满了（或边界全不可知）返回 null。
 *
 * 🔴 缺口起点取 `maxOutlineNo + 1` 而不是"扫出第一个空洞"：细纲必须**连续**才能被
 *    `loadChapterOutlines` 按章号取到，补空洞（如已有 1-5 与 7-21，去补第 6 章）会与
 *    "接着往下排"的语义打架。老大的场景也一直是**末尾缺**（排到 21、缺 22-30）。
 */
export function detectVolumeGap(
  volumes: readonly { name: string; texts: readonly (string | undefined)[] }[],
  maxOutlineNo: number,
  perVolume: number,
): VolumeGap | null {
  for (const v of volumes) {
    const b = volumeBoundOf(v.texts, perVolume)
    if (!b) continue
    if (b.to > maxOutlineNo) {
      return { title: v.name, from: b.from, to: b.to, gapFrom: maxOutlineNo + 1, gapTo: b.to }
    }
  }
  return null
}

// ==================== 卷大纲「完整性」判定（缺口补齐用，2026-09-20）====================
//
// 老大 2026-09-20 定的口径：
//   · 卷大纲**完整** → 只按它排细纲（卷大纲卡一个字不动）；
//   · 卷大纲**不完整** → 补细纲的**同时**把这一卷的卷大纲补全。
// 所以先得能回答"这一卷规划得够不够细"。

/**
 * 判「卷大纲是否完整」时看的关键字段。
 *
 * 🔴 只挑**卷级走向**那四个：它们回答"这一卷要发生什么"，正是排细纲必须依据的东西。
 *    至于伏笔 / 角色 / 势力那些模块，作者常常在正文写完之后回头才补 ——
 *    拿它们当"没规划好"的证据，会把好好的卷判成残卷、白让模型重写一遍。
 */
export const VOLUME_CORE_SLOTS = ['第一大高潮', '卷中转折', '卷末高潮', '本卷结尾（卷末状态）'] as const

/**
 * 是不是"还没写"的占位文本（`（待写）` / `待定` / `暂无` / `TBD` / `—` …）。
 *
 * ⚠️ 只认**整段就是占位**的情况：像 `凝罡一重 → （待定）` 这种"部分待定"仍算有内容 ——
 *    它给出了实质信息，覆盖掉反而丢东西。
 */
export function isPlaceholderText(text: string): boolean {
  const s = (text ?? '').trim()
  if (!s) return true
  return /^[（(【[「]?\s*(?:待[写定续补填]|暂无|无|未定|不详|TBD|TODO|N\/A|[-—–~]+|\?+|。+|…+)\s*[）)】\]」]?$/i.test(s)
}

/**
 * 这一卷的卷大纲是否已经规划完整（`VOLUME_CORE_SLOTS` 四个字段都有实质内容）。
 *
 * ⚠️ 字段一个都对不上（schema 改过名）时返回 **true**：判不了就别动它 ——
 *    宁可少写（只补细纲），也不要因为"认不出字段"把作者的卷大纲整卷重写一遍。
 */
export function isVolumeOutlineComplete(card: { data: Record<string, string> }): boolean {
  const keys = VOLUME_CORE_SLOTS
    .map(slot => resolveSlot(VOLUME_OUTLINE_TAB_ID, slot))
    .filter((k): k is string => !!k)
  if (!keys.length) return true
  return keys.every(k => !isPlaceholderText(card.data[k] ?? ''))
}
