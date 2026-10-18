/**
 * 上下文装配器（3.1.3 · R3）：把「往提示词里塞一段」这件事从 `aiContext` 里抽出来。
 *
 * 为什么单独成文件：`aiContext.ts` 贴着 1200 行结构闸，而装配是**独立的一小块状态机**
 * （used / parts / sections / dropped / trimmed），与「从各个页签取数并渲染」是两件事。
 *
 * 🔴 两条如实申报纪律（都是踩过坑写下的）：
 *   1. 放不下就丢，且**必须记进 dropped** —— 模型不知道的东西，作者得知道；
 *   2. 单段超限**按行裁剪**并记进 trimmed（「给了一半」≠「完全没给」）——
 *      原来整段丢，实测一个小项目就丢了 19 段（含章节清单与四张设定表），
 *      而作者完全无感。详见 `segBudget.ts` 的实测数据。
 */
import { fitBlock, segCapOf, trimEnabledFor } from '@/lib/ai/segBudget'

export interface PushOptions {
  /**
   * 整块进、不裁。
   * 🔴 只给「作者显式递进来的东西」（附件）用：他手动给的东西被切成半截，
   *    比参考资料没进来更让人困惑。
   */
  whole?: boolean
  /**
   * 允许动用**预留额度**（见 `AssemblerOptions.reserve`）。
   * 给「写到哪了」这类不可替代的段用（章节清单）：它们被挤掉，模型就不知道剧情进展。
   */
  reserved?: boolean
}

export interface AssemblerOptions {
  /** 是否在文末声明丢弃 / 裁剪（酒馆模式自己生成提示词段，传 false） */
  inlineDropNote?: boolean
  /**
   * 给「保留段」预留的字符数。
   * 🔴 为什么必须有：常规段按 PRIORITY 顺序累加，前期设定（世界设定 / 力量体系 / 四制度 / 势力）
   *    就能把预算吃光 —— 实测一个 22 章的小项目，`章节清单` 排在第 30 位，永远轮不到。
   *    预留相当于"先划一块地给它"，常规段只能用到 `budget - reserve`。
   */
  reserve?: number
}

/**
 * 剩余额度低于这个数就别硬塞了。
 * 200 是个折中：表格段带「表头 + 1 行」没意义，但表单/清单段带 1-2 行仍能提供线索
 * （实测被丢的「写作规范 284 字」「势力关系 339 字」都属于后者）。
 */
const MIN_TAIL = 200

export interface AssembledContext {
  text: string
  sections: string[]
  dropped: string[]
  trimmed: string[]
  chars: number
}

export interface ContextAssembler {
  push: (title: string, body: string, opts?: PushOptions) => void
  /**
   * 把已装入的段从**保底版升级成完整版**（第二遍；段不存在或放不下则什么都不做）。
   * 用于「人人有份，重要的多给」：第一遍每段先拿一小份，第二遍按优先级补满。
   */
  /** 收尾：拼出最终文本，并在文末如实声明「哪些没带」「哪些只带了一部分」 */
  build: () => AssembledContext
}

export function createContextAssembler(
  budget: number,
  opts: AssemblerOptions = {},
): ContextAssembler {
  const parts: string[] = []
  const sections: string[] = []
  const dropped: string[] = []
  const trimmed: string[] = []
  let used = 0

  // 小预算（如伴写 1300）不裁：那里总共只放三四段，裁了只会每段都半截
  const trimOn = trimEnabledFor(budget)
  const segCap = segCapOf(budget)
  const reserve = Math.max(0, Math.min(opts.reserve ?? 0, Math.floor(budget * 0.4)))

  /**
   * 段装进去了就从「未带入」名单里摘掉。
   * 🔴 两遍装载必须做这一步：第一遍放不下会 push 进 dropped，第二遍铺底又装进去了，
   *    不清就会在文末出现「…未带入本提示：次要角色、名词术语…」而它们明明就在上面 ——
   *    这种自相矛盾的申报比不申报更糟（模型会以为自己没看到，实际上看到了）。
   */
  const unmarkDropped = (title: string) => {
    const i = dropped.indexOf(title)
    if (i >= 0) dropped.splice(i, 1)
  }

  const push = (title: string, body: string, o: PushOptions = {}) => {
    if (!body.trim()) return
    const head = `〖${title}〗\n`
    const raw = body.trim()
    // 常规段只能用「预算 - 预留」；保留段（章节清单）能动用预留
    const limit = o.reserved ? budget : budget - reserve
    const room = limit - used
    const whole = head.length + raw.length

    // 一、放得下**且不超过单段上限**才整段进
    //    🔴 两个条件缺一不可：只看 room 的话，一段 8000 字的大表在「预算还剩 10000」时会整段吃进来，
    //       把后面十几段一起挤死 —— 单段上限就成了摆设（这条被单测抓过一次）。
    if (whole <= room && (o.whole || whole <= segCap)) {
      parts.push(head + raw)
      sections.push(title)
      used += whole + 2
      unmarkDropped(title)
      return
    }
    // 二、放不下：附件整块专用，不放就丢（绝不切）
    if (!trimOn || o.whole) {
      dropped.push(title)
      return
    }
    // 三、按**单段上限**裁（不是"能吃多少吃多少"）。
    // 🔴 别改成「按剩余额度裁」：那样第一个挤进来的段会把剩余全吃掉，
    //    后面 20 段照样全丢，还多出一堆半截内容 —— 实测把「次要角色」裁到 136/267 行、
    //    2648 字符全占满，比原来更糟。这里要的是"防巨段"，不是"贪心填充"。
    if (room < MIN_TAIL) {
      dropped.push(title)
      return
    }
    /**
     * 保留段（章节清单）按 **min(单段上限, 实际剩余)** 裁，并**保尾**：
     *   · 它的额度是被预留出来的，不存在"抢别人"的问题，所以可以吃满 room；
     *   · 清单按叙事序排，保头会砍掉最新章 ⇒ 必须保尾（见 `segBudget.fitBlock`）。
     * 普通段仍按单段上限裁（不许贪心），理由见下面那段注释。
     */
    const fitLimit = o.reserved
      ? Math.max(200, Math.min(segCap, room) - head.length)
      : Math.max(200, segCap - head.length)
    const fit = fitBlock(raw, fitLimit, { keepTail: !!o.reserved })
    if (!fit.trimmed) {
      dropped.push(title)
      return
    }
    const block = head + fit.text
    if (used + block.length > limit) {
      dropped.push(title)
      return
    }
    parts.push(block)
    sections.push(title)
    used += block.length + 2
    unmarkDropped(title)
    // 🔴 只有真的加进去了才记 trimmed —— 否则会出现「既说带了一部分、又在 dropped 里」
    trimmed.push(`${title}（${fit.keptLines}/${fit.totalLines} 行）`)
  }

  const build = (): AssembledContext => {
    /**
     * 文末申报**不占预算**：它是「必须说的话」（不写模型就把残缺当全集），
     * 让它去挤资料等于本末倒置。所以 `chars` 可能比 `budget` 大几十到两三百字符 ——
     * 这是设计，不是溢出 bug（早先有人把它当超标差点去"修"）。
     */
    const note = opts.inlineDropNote === false ? '' : [
      dropped.length > 0
        ? `\n\n（注：以下资料因长度预算未带入本提示，仅供参考时留意其可能存在：${dropped.join('、')}）`
        : '',
      // 🔴 与「完全没带」区分开：这些是带了一部分。不写清，模型会把残缺当全集。
      trimmed.length > 0
        ? `\n（注：以下资料因长度预算只带了一部分，未列出的内容同样存在：${trimmed.join('、')}）`
        : '',
    ].filter(Boolean).join('')
    const text = parts.join('\n\n') + note
    return { text, sections: [...sections], dropped: [...dropped], trimmed: [...trimmed], chars: text.length }
  }

  return { push, build }
}
