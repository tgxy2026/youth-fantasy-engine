// ============ 源码自述闸（3.0 · 建议级两项 · 2026-10-10）============
//
// 来源：`docs/3.0-开发方案.md` §11.2 的两条建议 —— 2.9.3 六维审计里**命中率最高**的两类问题：
//   ⑪「**文件自己写着规则、自己又违反**」（本轮 1×P0 + 3×P1 全中：aiDataSources 的 excludes、
//      GuidePage 的 GROUP_ORDER、protocol.ts 的版本注释）。
//   ⑫「**数字承诺 ↔ 常量**」（本轮抓到文案写「约 120 字」、实际 `contextSnippet` 是前后各 12 字，差 5 倍）。
//
// 🔴 判据的三次收紧（记录在此，免得后来者再走一遍；2026-10-10 试跑实测）：
//   1. 第一版用「剥注释/剥字符串」的**字符状态机**（照 `structureGates` 抄）—— 在含**正则字面量**
//      （`/.../`）的大文件上状态错位，把代码整段误判成注释、报错行号全塌到 `:1`。
//      ⇒ **本闸不用状态机，改行级判据**（行首/行中 `//`、`*` 识别注释行）。同理更稳、更短。
//   2. ⑪ 第一版连**中文词**一起查 → 「功能模块」「确定」「创意写作」这类普通词全线误报
//      （注释在解释概念，代码侧用的是别的名字）⇒ **只查 ASCII 标识符**。
//   3. ⑫ 第一版按「同句式不同数字」判失败 → 抓到的是 `aiDataSources` 各功能**各自的**预算
//      （6000/8000/12000，那是设计不是错）⇒ 退化为**线索清单**（正是 §11.2 原话：
//      「回源码找它引用的那个常量」＝人工）。用途：**改额度时跑一遍**。
//
// 定位：纯静态文本分析、不 import 业务代码、毫秒级（与 `structureGates` 同族）。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const note = (s: string) => console.log(`  · ${s}`)

function findSrc(): string | null {
  for (const c of [path.join(process.cwd(), 'src'), path.join(process.cwd(), '..', 'src')]) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c
  }
  return null
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

/** 注释行判定：行首 `//` `*` `/*`，或行中出现 `//` 之后的部分 */
const isCommentLine = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l)
/** 取一行的**注释部分**（行首注释整行；行尾注释取 `//` 之后） */
function commentPart(line: string): string {
  const head = line.match(/^\s*(\/\/|\*|\/\*)\s?(.*)$/)
  if (head) return head[2]
  const i = line.indexOf('//')
  return i >= 0 ? line.slice(i + 2) : ''
}
/** 取一行的**代码部分**（行尾注释之前） */
function codePart(line: string): string {
  if (isCommentLine(line)) return ''
  const i = line.indexOf('//')
  return i >= 0 ? line.slice(0, i) : line
}

console.log('—— sourceClaims：源码自述闸（⑪ 规范措辞 / ⑫ 数字承诺线索）——')

const SRC = findSrc()
if (!SRC) {
  ok('找到 src 目录', false, 'cwd=' + process.cwd())
} else {
  const files = walk(SRC).map(f => path.resolve(f))
  const rel = (f: string) => path.relative(path.dirname(SRC), f).replace(/\\/g, '/')
  const split = new Map<string, string[]>()
  for (const f of files) split.set(f, fs.readFileSync(f, 'utf8').split('\n'))
  ok('扫描到源文件', files.length > 100, String(files.length))

  // ---------- 判据自检（它失效则本闸静默放过一切） ----------
  {
    ok('自检：识别行注释', isCommentLine('  // 必须走 aiParse'))
    ok('自检：识别块注释续行', isCommentLine(' * 必须走 aiParse'))
    ok('自检：代码行不算注释', !isCommentLine('const a = 1'))
    ok('自检：行尾注释被取出', commentPart('const a = 1 // 必须走 aiParse').includes('aiParse'))
    ok('自检：代码行取出的代码部分不含注释', !codePart('const a = 1 // 必须走 aiParse').includes('aiParse'))
  }

  // ============ ⑪ 规范措辞 ↔ 常量存在性 ============
  //
  // 查法：**注释部分**含规范措辞 → 取其中被引号括起的**全大写常量名** → 看它在**全仓代码**里是否出现。
  // 🔴 两次收敛的依据（试跑实测，别再放宽）：
  //   · 只认 ASCII 标识符：中文词在注释里多半是解释概念，代码侧常用别的名字 ⇒ 全线误报。
  //   · 只认**全大写常量名**（`EXCLUDED_META_KEYS` 型）+ **全仓**比对：注释天然会引用跨文件标识符
  //     （`useTavernFreeModel`）、Tailwind 类名（`mb-6`）、浏览器 API（`SVGImageElement`）、
  //     提示词 id（`P_rewrite_passage`）—— 这些都不该管；而全大写常量名几乎只在本仓出现，
  //     注释点到它就意味着「本模块依赖它」，全仓找不到才是真异常。
  {
    const RULE_WORDS = /(必须|一律|务必|不要|禁止|不得|永远不要|千万别|绝不可)/
    const QUOTED = /[「『`"'“]([^」』`"'”]{2,48})[」』`"'”]/g
    const IS_CONST_NAME = /^[A-Z][A-Z0-9_]{3,}$/

    const allCode = files.map(f => split.get(f)!.map(codePart).join('\n')).join('\n')
    const bad: string[] = []
    let scanned = 0
    for (const f of files) {
      const lines = split.get(f)!
      for (let i = 0; i < lines.length; i++) {
        const c = commentPart(lines[i])
        if (!c || !RULE_WORDS.test(c)) continue
        QUOTED.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = QUOTED.exec(c))) {
          const w = m[1].trim()
          if (!IS_CONST_NAME.test(w)) continue
          scanned++
          if (!allCode.includes(w)) bad.push(`${rel(f)}:${i + 1} 注释强调「${w}」，但全仓代码里找不到这个常量`)
        }
      }
    }
    note(`⑪ 共核对了 ${scanned} 个「注释里带规范措辞的全大写常量名」`)
    ok('⑪ 注释强调的常量名，全仓都真的存在', bad.length === 0, bad.slice(0, 8).join(' ｜ '))
    if (bad.length) bad.slice(0, 8).forEach(b => note('  ' + b))
  }

  // ============ ⑫ 数字承诺清单（线索级 · 不判失败）============
  //
  // 🔴 为什么不做硬判据：各功能/各段文案的额度**本来就不同**（试跑实证：aiDataSources 里
  //    6000 / 8000 / 12000 是各功能各自的预算，属设计）。自动判定「这句引用的常量是哪个」不可靠，
  //    故按 §11.2 原话出**清单**供人工核对（改额度时跑一遍）。
  {
    const CLAIM = /(\d+)\s*(字|个字符|条|天|轮|次|秒|分钟|小时|张|人)/g
    const STR = /'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g
    const rows: string[] = []
    let total = 0
    for (const f of files) {
      const lines = split.get(f)!
      for (let i = 0; i < lines.length; i++) {
        const code = codePart(lines[i])
        if (!code) continue
        STR.lastIndex = 0
        let s: RegExpExecArray | null
        while ((s = STR.exec(code))) {
          const lit = s[1] ?? s[2] ?? s[3] ?? ''
          CLAIM.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = CLAIM.exec(lit))) {
            const ctx = lit.slice(Math.max(0, m.index - 12), m.index + m[0].length + 12).trim()
            rows.push(`${rel(f)}:${i + 1}  ${m[1]}${m[2]}  ……${ctx}……`)
            total++
          }
        }
      }
    }
    note(`⑫ 共扫到 ${total} 处数字承诺（文案里的「N 字 / N 条 / N 天」等）—— 改额度时按此清单回源码核对`)
    rows.slice(0, 10).forEach(r => note('  ' + r))
    if (rows.length > 10) note(`  …（其余 ${rows.length - 10} 处已省略；要看全量把上面的 slice(0,10) 调大）`)
    ok('⑫ 数字承诺清单可生成（线索级，不判失败）', total > 0, String(total))
  }

  console.log(`\nsourceClaims: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}
