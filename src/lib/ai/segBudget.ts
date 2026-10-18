/**
 * 上下文装配的**单段预算**（3.1.3 · R3 修复）。纯函数，好测。
 *
 * 【要解决什么】
 *   `buildProjectContext` 里的 `push()` 原来是「全有或全无」：一段放不下就整段丢。
 *   而前几段（世界设定 / 力量体系 / 四个制度页签 / 势力 / 地理）单段就 3000-7000 字符，
 *   累积到后期预算见底 —— 实测示范项目 **11842 / 12000（98.7%）**，一口气丢了 **19 段**，
 *   其中包括 **章节清单 / 种族生物 / 物品资源 / 地理风物 / 伏笔追踪 / 时间脉络 / 章节细纲 / NPC 角色**。
 *   后果最阴的一点：**不报错**。作者以为 AI 读了魔兽设定，其实一段都没进去。
 *
 * 【怎么解决】
 *   单段最多占预算的 30%（不低于 2000 字符），超出就**按整行裁剪**并在段末注明
 *   「本段按预算只带了前 N 行 / 共 M 行」。宁可每段都少带几行，也不要整段消失 ——
 *   少几行模型至少知道「有这么个东西」，整段丢它就当成不存在。
 *
 * 🔴 两条边界：
 *   · **不裁整块**（`whole`）：作者显式递进来的附件、以及本来就只有几百字的摘要段；
 *   · **小预算不裁**（budget < 2×SEG_MIN，如伴写 1300）：那里一共只放三四段，
 *     裁剪只会把每段都切成半截，退回原行为更稳。
 */

/** 单段最多占预算的比例 */
export const SEG_RATIO = 0.3
/** 单段上限的下限（字符）；预算太小时不启用裁剪，见文件头 */
export const SEG_MIN = 2000

/** 某预算下允许的单段上限 */
export function segCapOf(budget: number): number {
  return Math.max(SEG_MIN, Math.floor(budget * SEG_RATIO))
}

/** 该预算要不要启用单段裁剪（小预算保持原行为） */
export function trimEnabledFor(budget: number): boolean {
  return Number.isFinite(budget) && budget >= SEG_MIN * 2
}

export interface FitResult {
  text: string
  trimmed: boolean
  /** 实际带了几行（未裁剪时为 0） */
  keptLines: number
  /** 原本共几行（未裁剪时为 0） */
  totalLines: number
}

/**
 * 把一段正文按**整行**裁到 `limit` 字符。
 *
 * 三条保留规则（都不是装饰）：
 *   1. **第一行必留** —— 表格的第一行是表头，没表头的数据行模型读不懂；
 *   2. **末尾的「另有 N 行未列出」提示必留** —— 那是 renderTable 自己生成的口径，
 *      丢了它模型会以为「到这里就是全部」；
 *   3. 末尾再加一句「本段按预算只带了前 N 行 / 共 M 行」—— 让模型知道这不是全集。
 */
export function fitBlock(body: string, limit: number, opts: { keepTail?: boolean } = {}): FitResult {
  const text = body.trim()
  if (text.length <= limit) return { text, trimmed: false, keptLines: 0, totalLines: 0 }

  const lines = text.split('\n')
  const total = lines.length
  const last = lines[lines.length - 1] ?? ''
  const tail = /^（(另有|本段|其余)/.test(last) ? (lines.pop() as string) : ''

  /**
   * **保尾**裁剪（给「章节清单」用）：留第一行（卷标题）+ 最近若干行。
   *
   * 🔴 为什么不能一律"保头"：章节清单是按叙事序从上往下排的，保头等于只留第 1~15 章，
   *    最新那几章（也就是"刚写到哪"）全被砍掉 —— 那恰恰是续写最需要的信息。
   *    表格段则相反（表头在头、数据行谁留都行），所以保头仍是默认。
   */
  if (opts.keepTail && lines.length > 2) {
    const head = lines[0]
    const room = Math.max(0, limit - 60 - head.length - 1)
    const kept: string[] = []
    let n = 0
    for (let i = lines.length - 1; i >= 1; i--) {
      const ln = lines[i]
      if (n + ln.length + 1 > room) break
      kept.unshift(ln)
      n += ln.length + 1
    }
    const skipped = lines.length - 1 - kept.length
    const more = `（本段按预算省略了中间 ${skipped} 行，保留最近 ${kept.length} 行 / 共 ${total} 行）`
    return {
      text: [head, more, ...kept, tail].filter(Boolean).join('\n'),
      trimmed: true,
      keptLines: kept.length + 1,
      totalLines: total,
    }
  }

  const out: string[] = []
  let n = 0
  // 给末尾提示语留出余量，别让"本段只带了…"这句自己被截掉
  const room = Math.max(0, limit - 60)
  for (const ln of lines) {
    if (out.length >= 1 && n + ln.length + 1 > room) break
    out.push(ln)
    n += ln.length + 1
  }
  const more = `（本段按预算只带了前 ${out.length} 行 / 共 ${total} 行）`
  return {
    text: [out.join('\n'), tail, more].filter(Boolean).join('\n'),
    trimmed: true,
    keptLines: out.length,
    totalLines: total,
  }
}
