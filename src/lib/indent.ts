/**
 * 缩进工具（2.4.0 · A5 编辑器自由缩进）
 *
 * 【为什么单独立一个模块】
 * 「缩进」在本项目里有一条容易被忽略的底线：**它是作者的排版主权**。
 * 伴写、改写、续写、拆书都不得增删正文里的缩进（见 `promptGuard.authorBlock()` 那条口径）。
 * 所以把「什么算缩进、缩进几级、怎么归一」收敛成一组**纯函数**：只有这里定义"缩进长什么样"，
 * 编辑器的键盘逻辑、一键排版、粘贴归一全部共用同一套判定，不会各写一套导致互相打架。
 *
 * 【为什么纯函数】
 * 不含任何 DOM / React 依赖 ⇒ 可以直接跑单测（`tests/indent.test.ts`）。
 * 编辑器那一层只负责「算出新文本 → 写回 textarea」，判定逻辑全在这里被测试覆盖。
 *
 * 【缩进＝什么】
 * 行首连续的 **全角空格 / 半角空格 / Tab 字符**。其余（如「　」出现在行中）不算缩进。
 * 注意：**不做全角半角混用的严格校验** —— 作者手写的东西可能有各种组合，
 * 工具要能容错处理，而不是要求作者先把格式修规范。
 */

/** 缩进单位：作者可选，默认全角空格 ×2（中文小说段首缩进的传统写法） */
export type IndentUnit = 'full2' | 'full1' | 'half4' | 'half2' | 'tab'

export interface IndentUnitDef {
  id: IndentUnit
  label: string
  /** 一个缩进单位的实际字符 */
  text: string
  /** 界面上的补充说明 */
  hint: string
  /**
   * 一个缩进单位的**视觉宽度**（em）。
   * 只服务「段首缩进参考线」的间距换算 —— 中文正文里全角 ≈ 1em、半角 ≈ 0.5em，
   * Tab 按「4 个半角」的通行约定算 2em。是估算值，用作对准参考线够用。
   */
  emWidth: number
}

/**
 * ⚠️ 顺序＝设置项里的展示顺序：默认值排第一。
 * 全角 ×2 放首位是因为它是中文小说最常见的段首缩进，也是本项目「一键排版」的历史行为。
 */
export const INDENT_UNITS: IndentUnitDef[] = [
  { id: 'full2', label: '全角空格 ×2', text: '　　', hint: '中文小说段首缩进的传统写法（推荐）', emWidth: 2 },
  { id: 'full1', label: '全角空格 ×1', text: '　', hint: '段首只留一个全角空格，版面更紧凑', emWidth: 1 },
  { id: 'half4', label: '半角空格 ×4', text: '    ', hint: '与部分编辑器、Markdown 预览观感一致', emWidth: 2 },
  { id: 'half2', label: '半角空格 ×2', text: '  ', hint: '与代码风格一致，适合导出给排版工具', emWidth: 1 },
  { id: 'tab', label: 'Tab 字符', text: '\t', hint: '真正的制表符；部分网文平台粘贴后会展开成空格', emWidth: 2 },
]

export const DEFAULT_INDENT_UNIT: IndentUnit = 'full2'

/** 全部单位的 id：供偏好读取时做「值是否合法」校验用（抽成常量，避免每次渲染现算数组） */
export const INDENT_UNIT_IDS: IndentUnit[] = INDENT_UNITS.map(u => u.id)

/** 取某个缩进单位的实际字符；非法值回退到默认单位 */
export function indentTextOf(unit: IndentUnit | undefined | null): string {
  return INDENT_UNITS.find(u => u.id === unit)?.text ?? INDENT_UNITS[0].text
}

/** 行首缩进的正则：全角空格 / 半角空格 / Tab 的连续串 */
const LEADING_WS = /^[ \t\u3000]+/

/**
 * 拆出行首缩进与其余部分。
 * `splitIndent('　　正文')` → `{ indent: '　　', rest: '正文' }`
 * 空行（只有空白）→ `{ indent: '', rest: '' }` —— 空白行**不算带缩进**，
 * 这样连续回车时不会被当成"有缩进的行"而越缩越右。
 */
export function splitIndent(line: string): { indent: string; rest: string } {
  const m = line.match(LEADING_WS)
  if (!m) return { indent: '', rest: line }
  const rest = line.slice(m[0].length)
  // 整行除了空白什么都没有 → 视作空行，缩进归零
  if (rest === '') return { indent: '', rest: '' }
  return { indent: m[0], rest }
}

/** 单行缩进一级；空行不动（避免给空行也加缩进、导出后多出一堆看不见的空格） */
export function indentLine(line: string, unit: IndentUnit = DEFAULT_INDENT_UNIT): string {
  const { indent, rest } = splitIndent(line)
  if (indent === '' && rest === '') return line
  return indentTextOf(unit) + indent + rest
}

/**
 * 单行反缩进一级。
 * 行首缩进不是单位的整数倍时（作者手写过、或从别处粘进来的混合空白），
 * **按单位长度截断**而不是直接放弃 —— 否则手写缩进会出现"按了没反应"的死角。
 */
export function outdentLine(line: string, unit: IndentUnit = DEFAULT_INDENT_UNIT): string {
  const { indent, rest } = splitIndent(line)
  if (indent === '') return line
  const u = indentTextOf(unit)
  if (indent.startsWith(u)) return indent.slice(u.length) + rest
  return indent.slice(Math.min(u.length, indent.length)) + rest
}

/** 多行块缩进（逐行；空行不动） */
export function indentBlock(block: string, unit: IndentUnit = DEFAULT_INDENT_UNIT): string {
  return block.split('\n').map(l => indentLine(l, unit)).join('\n')
}

/** 多行块反缩进（逐行；空行、无缩进行不动） */
export function outdentBlock(block: string, unit: IndentUnit = DEFAULT_INDENT_UNIT): string {
  return block.split('\n').map(l => outdentLine(l, unit)).join('\n')
}

/**
 * 回车换行时，新行应继承的缩进。
 *
 * 两条规则：
 *   ① 当前行**有内容** → 继承它已有的缩进（在缩进一级或二级的段落里连续写，不用每行重按）；
 *   ② 当前行是空行 / 只有缩进 → 返回空 ⇒ 回到段首层。
 *      （否则在缩进段落后连按回车会越缩越右，这是手工排版里很常见的一个坑。）
 */
export function indentForNewLine(currentLine: string): string {
  const { indent, rest } = splitIndent(currentLine)
  if (rest === '') return ''
  return indent
}

/**
 * 粘贴归一：把多行文本的行首空白按当前单位改写。
 *
 * 为什么要归一：从网页、Word、其它编辑器粘进来的文本，行首往往是 1~4 个不等宽的空格或 Tab，
 * 混进正文后与作者自己的缩进单位不一致，一眼就能看出"这不是在同一套排版里写的"。
 * 深度按「字符数 ÷ 单位长度」四舍五入换算 ⇒ 原来的多级缩进结构会被保留，只统一"一个单位有多宽"。
 *
 * 没有行首空白的行一律原样（不因随手粘一句话而改动它）；**单行但带行首空白的同样归一** ——
 * 否则「粘一段带缩进的文字」就会与正文单位不一致，正是这条规则要消灭的不一致。
 */
export function normalizePastedText(text: string, unit: IndentUnit = DEFAULT_INDENT_UNIT): string {
  const u = indentTextOf(unit)
  return text.split('\n').map(line => {
    const { indent, rest } = splitIndent(line)
    if (indent === '') return rest === '' ? '' : line
    const depth = Math.max(1, Math.round(indent.length / u.length))
    return u.repeat(depth) + rest
  }).join('\n')
}
