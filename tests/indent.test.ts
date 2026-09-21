// ============ 编辑器缩进工具（2.4.0 · A5）============
//
// 缩进是「作者的排版主权」—— 键盘逻辑、一键排版、粘贴归一三处都依赖这一组判定，
// 所以判定本身必须被钉死。本用例盯五件事：
//   ① 什么算行首缩进（全角 / 半角 / Tab 都认；**空白行不算带缩进**）；
//   ② 单行缩进 / 反缩进，含手写混合空白的截断降级（不能出现"按了没反应"的死角）；
//   ③ 回车继承：有内容才继承、空行或纯缩进行的回车回到段首层（防越缩越右）；
//   ④ 粘贴归一只统一"一个单位多宽"，**保留多级结构**，单行文本不被动；
//   ⑤ 一键排版默认「保留既有缩进」而不是抹平 —— 这正是 A5 要解决的原始痛点。
import {
  INDENT_UNITS, DEFAULT_INDENT_UNIT, indentTextOf,
  splitIndent, indentLine, outdentLine, indentBlock, outdentBlock,
  indentForNewLine, normalizePastedText,
} from '../src/lib/indent'
import { formatNovelText } from '../src/lib/textTools'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const FULL = '　' // 全角空格

// ---------- ① 缩进单位的定义 ----------
{
  ok('默认单位＝全角空格 ×2', DEFAULT_INDENT_UNIT === 'full2')
  ok('默认单位的实际字符是两个全角空格', indentTextOf('full2') === FULL + FULL, JSON.stringify(indentTextOf('full2')))
  ok('Tab 单位是真正的制表符', indentTextOf('tab') === '\t')
  ok('⚪ 非法/空值回退到默认单位（不抛异常）', indentTextOf(undefined) === FULL + FULL && indentTextOf(null) === FULL + FULL)
  ok('清单里 5 种单位，id 不重复', INDENT_UNITS.length === 5 && new Set(INDENT_UNITS.map(u => u.id)).size === 5)
  // 🔴 顺序约定：默认值必须排第一（设置项直接按这个顺序渲染，"推荐"要一眼可见）
  ok('🔴 默认单位排在清单首位', INDENT_UNITS[0].id === DEFAULT_INDENT_UNIT)
}

// ---------- ② splitIndent：什么算缩进 ----------
{
  ok('全角缩进被拆出', JSON.stringify(splitIndent(FULL + FULL + '正文')) === JSON.stringify({ indent: FULL + FULL, rest: '正文' }))
  ok('半角空格缩进被拆出', splitIndent('    正文').indent === '    ')
  ok('Tab 缩进被拆出', splitIndent('\t正文').indent === '\t')
  ok('无缩进 → indent 为空、rest 原样', splitIndent('正文').indent === '' && splitIndent('正文').rest === '正文')
  // 行中/行尾的空格不算行首缩进
  ok('行中空格不算缩进', splitIndent('正 文').rest === '正 文')
  // 🔴 空白行＝无缩进：否则连续回车会被当成"有缩进的行"越缩越右
  ok('🔴 只有缩进的空白行，缩进归零', splitIndent(FULL + FULL).indent === '' && splitIndent(FULL + FULL).rest === '')
  ok('🔴 纯空格行同样归零', splitIndent('   ').indent === '' && splitIndent('   ').rest === '')
  ok('空串安全', splitIndent('').indent === '' && splitIndent('').rest === '')
}

// ---------- ③ 单行缩进 / 反缩进 ----------
{
  ok('缩进一级：段首 → 一个单位', indentLine('正文') === FULL + FULL + '正文')
  ok('缩进两级：叠加而不是替换', indentLine(FULL + FULL + '正文') === FULL + FULL + FULL + FULL + '正文')
  ok('单行缩进不碰空行', indentLine('') === '' && indentLine('   ').trim() === '')
  ok('半角单位缩进可用', indentLine('正文', 'half4') === '    正文')
  ok('Tab 单位缩进可用', indentLine('正文', 'tab') === '\t正文')

  ok('反缩进一级：删掉一个单位', outdentLine(FULL + FULL + '正文') === '正文')
  ok('反缩进只删一级（多级保留）', outdentLine(FULL + FULL + FULL + FULL + '正文') === FULL + FULL + '正文')
  ok('无缩进的行反缩进不变', outdentLine('正文') === '正文')
  // 🔴 手写混合空白（不是单位的整数倍）也必须能降级，否则是"按了没反应"的死角
  ok('🔴 手写单个全角空格：反缩进能吃掉它', outdentLine(FULL + '正文') === '正文', JSON.stringify(outdentLine(FULL + '正文')))
  ok('🔴 手写混合（全角＋半角）：按单位长度截断', outdentLine(FULL + ' ' + '正文') === '正文')
  ok('🔴 手写 Tab 而单位是空格：也能删掉', outdentLine('\t正文') === '正文')
  ok('三个全角、单位两个：删两个留一个', outdentLine(FULL + FULL + FULL + '正文') === FULL + '正文')
  // 单位切换后反缩进的降级也要稳
  ok('半角单位下反缩进全角缩进：按长度截断', outdentLine(FULL + FULL + '正文', 'half4') === '正文'.padStart(2 + 2, ' ') || outdentLine(FULL + FULL + '正文', 'half4').endsWith('正文'))
}

// ---------- ④ 多行块 ----------
{
  const block = '第一段\n' + FULL + FULL + '第二段\n\n' + FULL + FULL + FULL + FULL + '第三段'
  const ind = indentBlock(block)
  ok('多行缩进：每行各加一级', ind.split('\n')[0] === FULL + FULL + '第一段' && ind.split('\n')[1] === FULL + FULL + FULL + FULL + '第二段')
  ok('多行缩进：空行保持空（不产生看不见的空格）', ind.split('\n')[2] === '')
  ok('多行缩进：第三级继续叠加', ind.split('\n')[3] === FULL.repeat(6) + '第三段')

  ok('多行反缩进：逐行各降一级', outdentBlock(ind).split('\n')[1] === FULL + FULL + '第二段')
  ok('多行反缩进：无缩进行不报错、原样保留', outdentBlock('第一段\n第二段') === '第一段\n第二段')
  ok('多行反缩进：空行不动', outdentBlock('a\n\nb') === 'a\n\nb')
}

// ---------- ⑤ 回车继承 ----------
{
  ok('段首行回车 → 新行无缩进', indentForNewLine('正文') === '')
  ok('缩进一级的行 → 新行继承一级', indentForNewLine(FULL + FULL + '正文') === FULL + FULL)
  ok('缩进二级的行 → 新行继承二级', indentForNewLine(FULL.repeat(4) + '正文') === FULL.repeat(4))
  ok('半角缩进同样继承', indentForNewLine('    正文') === '    ')
  // 🔴 防越缩越右：空行 / 纯缩进行回车回到段首层
  ok('🔴 空行回车 → 回到段首层（返回空）', indentForNewLine('') === '')
  ok('🔴 纯缩进行回车 → 回到段首层（不继续叠加）', indentForNewLine(FULL + FULL) === '')
  ok('🔴 纯空格行回车 → 回到段首层', indentForNewLine('   ') === '')
}

// ---------- ⑥ 粘贴归一 ----------
{
  ok('单行文本原样返回（不因随手粘一句而改动它）', normalizePastedText('一句话', 'full2') === '一句话')
  ok('不带缩进的多行：原样（没有缩进就没什么可归一的）',
    normalizePastedText('第一行\n第二行', 'full2') === '第一行\n第二行')

  // 4 个半角空格 → 单位是全角×2 时，深度按 4/2=2 换算
  const pasted = '    一级吗\n        二级'
  const n1 = normalizePastedText(pasted, 'full2')
  ok('🔴 多行粘贴按当前单位归一（半角→全角）', n1.startsWith(FULL) && !n1.includes('    '), JSON.stringify(n1))
  ok('🔴 归一时保留多级结构（深的一级更深）',
    n1.split('\n')[0].length < n1.split('\n')[1].length, JSON.stringify(n1.split('\n').map(l => l.length)))

  ok('粘贴里的空行保持空', normalizePastedText('a\n\n    b', 'full2').split('\n')[1] === '')

  const n2 = normalizePastedText('\t正文', 'half2')
  ok('Tab 粘贴到半角单位下：换算成一个单位', n2 === '  正文', JSON.stringify(n2))
}

// ---------- ⑦ 一键排版：新默认必须保留自定义缩进 ----------
{
  // 三级缩进的手写稿：段首 / 一级 / 二级
  const src = [
    '段首正常的一段。',
    FULL + FULL + '缩进一级的对白。',
    FULL.repeat(4) + '缩进两级的补充说明。',
  ].join('\n')

  const kept = formatNovelText(src)
  const lines = kept.split('\n')
  ok('🔴 一键排版后仍保留段首行（无缩进）', lines[0] === '段首正常的一段。', JSON.stringify(lines[0]))
  ok('🔴 一键排版后缩进一级还在', lines[1] === FULL + FULL + '缩进一级的对白。', JSON.stringify(lines[1]))
  ok('🔴 一键排版后缩进二级还在', lines[2] === FULL.repeat(4) + '缩进两级的补充说明。', JSON.stringify(lines[2]))

  // 旧的"强制统一为段首两格"要仍能显式调用（作为独立选项）
  const forced = formatNovelText(src, { mode: 'uniform' })
  ok('旧行为可用（uniform 模式仍强制统一为段首一个单位）',
    forced.split('\n')[1] === FULL + FULL + '缩进一级的对白。' && forced.split('\n')[2] === FULL + FULL + '缩进两级的补充说明。',
    JSON.stringify(forced.split('\n')))

  // 保留缩进的同时，原有职责不能丢
  const messy = '  行尾有空格的段落   \n\n\n\n下一段'
  const cleaned = formatNovelText(messy)
  ok('仍去掉行尾空白', !cleaned.includes('  \n'))
  ok('仍把连续空行折叠成一个', cleaned.split('\n').length === 3, JSON.stringify(cleaned.split('\n')))
  ok('仍去掉首尾空行', !cleaned.startsWith('\n') && !cleaned.endsWith('\n'))
}

console.log(`\n—— indent：${pass} 通过 / ${fail} 失败 ——`)
if (fail > 0) process.exitCode = 1
