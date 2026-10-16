// ============ 结构护栏闸（2.3.0 · 阶段 5）============
//
// 为什么要有这一道：2.3.0 把巨石拆了、把数据归了位、把同步层的 `any` 收窄了 ——
// 但**治好的结构不会自己保持**。项目里那 90+ 条红线已经反复证明「踩过的坑会重踩」：
// 每一次都是「当时知道、后来忘了」。唯一能防住的是闸，不是记性。
//
// 本闸只做**静态文本/依赖分析**：不 import 业务代码，故无 mock 依赖、跑得飞快（毫秒级）。
//
// 六条规则（与 `docs/2.3.0-项目重构必要性评估.md` §五·阶段 5 的表格一一对应）：
//   ① 单文件行数     —— 硬上限 1200 / 软上限 800（数据文件另算，见 SIZE_FROZEN）
//   ② 分层方向       —— 禁 `lib|data → components`（由 tests/importCycles 承担，本闸只做交叉自检）
//   ③ 目录归属白名单 —— `src/data/**` 不得有运行时 import；`src/lib/**` 下不得再冒出「纯数据文件」
//   ④ 禁裸 JSON.parse —— AI 链路的「模型文本 → 结构化数据」必须走 aiParse
//   ⑤ 禁原生弹窗     —— window.prompt/confirm/alert（应走 PromptModal / confirmDialog / toast）
//   ⑥ any 不得增长   —— 按文件记账（ANY_LEDGER）；超出即失败，新增 any 必须先说明理由再抬账
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const note = (s: string) => console.log(`  · ${s}`)

/** 找 src 根目录：优先 cwd/src，其次 cwd/../src（与 importCycles 同款，构建产物可能落在 tests/ 下） */
function findSrc(): string | null {
  for (const c of [path.join(process.cwd(), 'src'), path.join(process.cwd(), '..', 'src')]) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c
  }
  return null
}

/**
 * 剥掉注释与字符串字面量，保留行结构。
 *
 * 🔴 这一步不是洁癖，是本闸能不能用的前提：
 *   · 本项目注释极多，且**大量注释就在讲红线本身** —— 不剥会把「注释里提到的 prompt()」、
 *     「注释里解释的 JSON.parse」全算成违规，闸一亮就没人信了（同款坑见 importCycles 顶部：
 *     Modal.tsx 的注释里写着示例 import，被当成自环上报过）。
 *   · 字符串里的 `any`（如报错文案）同理。
 * 返回**长度与原串一致**的空白化文本，故行号可原样用于报错定位。
 */
function stripCommentsAndStrings(src: string): string {
  const out: string[] = src.split('').map(c => (c === '\n' ? '\n' : ' '))
  let i = 0
  const n = src.length
  let st: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code'
  while (i < n) {
    const c = src[i], c2 = src[i + 1]
    if (st === 'code') {
      if (c === '/' && c2 === '/') { st = 'line'; i += 2; continue }
      if (c === '/' && c2 === '*') { st = 'block'; i += 2; continue }
      if (c === "'") { st = 'sq'; i++; continue }
      if (c === '"') { st = 'dq'; i++; continue }
      if (c === '`') { st = 'tpl'; i++; continue }
      out[i] = c; i++; continue
    }
    if (st === 'line') { if (c === '\n') { st = 'code'; out[i] = c } i++; continue }
    if (st === 'block') {
      if (c === '*' && c2 === '/') { st = 'code'; i += 2; continue }
      if (c === '\n') out[i] = '\n'
      i++; continue
    }
    if (c === '\\') { i += 2; continue }
    if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')) { st = 'code'; i++; continue }
    i++
  }
  return out.join('')
}

/**
 * 只剥注释、**保留字符串字面量** —— 与上者的唯一区别就在这一点。
 * 用途：查「色值必须走 `lib/palette.ts`」（规则⑨）这类闸，要查的恰恰是**字符串里**的 `'#rrggbb'`；
 *   若用上者（连字符串一起剥）就等于把要查的东西擦干净了 —— 闸会永远全绿，看着最舒服也最没用。
 * 返回长度与原串一致的空白化文本（注释位置变成空白，字符串原样保留）。
 */
function stripComments(src: string): string {
  const out: string[] = src.split('')
  let i = 0
  const n = src.length
  let st: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code'
  while (i < n) {
    const c = src[i], c2 = src[i + 1]
    if (st === 'code') {
      if (c === '/' && c2 === '/') { st = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
      if (c === '/' && c2 === '*') { st = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
      if (c === "'") { st = 'sq'; i++; continue }
      if (c === '"') { st = 'dq'; i++; continue }
      if (c === '`') { st = 'tpl'; i++; continue }
      i++; continue
    }
    if (st === 'line') { if (c === '\n') st = 'code'; else out[i] = ' '; i++; continue }
    if (st === 'block') {
      if (c === '*' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; st = 'code'; i += 2; continue }
      if (c !== '\n') out[i] = ' '
      i++; continue
    }
    // 字符串态：内容**原样保留**（只整对吃掉转义）
    if (c === '\\') { i += 2; continue }
    if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')) { st = 'code'; i++; continue }
    i++
  }
  return out.join('')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

console.log('—— structureGates：结构护栏闸（2.3.0 阶段 5）——')

const SRC = findSrc()
if (!SRC) {
  ok('找到 src 目录', false, 'cwd=' + process.cwd())
} else {
  const files = walk(SRC).map(f => path.resolve(f))
  const rel = (f: string) => path.relative(path.dirname(SRC), f).replace(/\\/g, '/')
  // 原文（报行号用）与剥洗文（判定用）成对保存
  const text = new Map<string, string>()
  const clean = new Map<string, string>()
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8')
    text.set(f, t)
    clean.set(f, stripCommentsAndStrings(t))
  }
  ok('扫描到源文件', files.length > 100, String(files.length))

  // ---- 剥洗器自检：它哪天失效，本闸剩下的规则就会集体「静默放过」 ----
  {
    const s = stripCommentsAndStrings
    const cnt = (src: string, re: RegExp) => (s(src).match(re) ?? []).length
    ok('自检：行注释里的关键字被剥掉', cnt('// alert(1)\n', /alert\(/g) === 0)
    ok('自检：块注释里的关键字被剥掉', cnt('/* confirm(1) */\n', /confirm\(/g) === 0)
    ok('自检：字符串里的关键字被剥掉', cnt(`const a = "prompt(1)"\n`, /prompt\(/g) === 0)
    ok('自检：模板串里的关键字被剥掉', cnt('const a = `alert(1)`\n', /alert\(/g) === 0)
    ok('自检：真实代码里的关键字**保留**', cnt('window.alert(1)\n', /alert\(/g) === 1)
    ok('自检：剥洗后长度与原文一致（行号可原样用）', s('// x\nconst a=1\n').length === '// x\nconst a=1\n'.length)
  }

  // ============ ① 单文件行数 ============
  // 硬上限 1200：超过即失败（巨石就是从这个量级开始失控的 —— D1 的 aiTasks 2338、D2 的 db 1614）。
  // 软上限 800：只告警。800~1200 是「该留个心眼」的区间，不阻断提交。
  const HARD = 1200, SOFT = 800
  /**
   * 豁免账本：`文件 → { max, why }`。**冻结在当前体量，只准降不准升**。
   * 为什么不全按纯数据自动豁免：`seedData.ts`（1485 行）含工厂码，属于**真该拆**的那一类 ——
   * 给它记一个冻结上限，等于「这次放过、但从此不许再长」，比无条件豁免诚实。
   */
  const SIZE_FROZEN: Record<string, { max: number; why: string }> = {
    'src/data/seedContent.ts': { max: 8300, why: '纯正文数据（示范项目三卷 21 章全文），无逻辑' },
    'src/data/materialData.ts': { max: 6300, why: '纯资料数据（素材库条目），无逻辑' },
    'src/lib/app/seedData.ts': { max: 1600, why: '示范项目种子工厂：工厂码与卷章数据混排，⚠️ 已列 2.3.0 待拆分（纯数据应落 src/data/）' },
    'src/data/protocolLegacy.ts': { max: 2400, why: '纯数据：历代协议全文冻存（每版约 140 行，随协议版本单调增长）' },
  }
  const over: string[] = []
  const soft: string[] = []
  const grown: string[] = []
  for (const f of files) {
    const r = rel(f)
    const lines = text.get(f)!.split('\n').length
    const frozen = SIZE_FROZEN[r]
    if (frozen) {
      if (lines > frozen.max) grown.push(`${r} ${lines} > 冻结上限 ${frozen.max}`)
      continue
    }
    if (lines > HARD) over.push(`${r} ${lines} 行`)
    else if (lines > SOFT) soft.push(`${r} ${lines} 行`)
  }
  ok(`① 单文件行数：无逻辑文件超过硬上限 ${HARD} 行`, over.length === 0, over.join(' ｜ '))
  ok('① 已冻结的大文件没有继续变大', grown.length === 0, grown.join(' ｜ '))
  if (soft.length) note(`① 软上限 ${SOFT}~${HARD} 区间（告警，不阻断）：${soft.join('、')}`)
  note(`① 豁免账本 ${Object.keys(SIZE_FROZEN).length} 个（只准降不准升）`)

  // ============ ② 分层方向交叉自检 ============
  // 真正的规则在 tests/importCycles.test.ts（它已经建好了依赖图）。
  // 这里只钉住一件容易忘的事：**新增平级数据目录时必须同步登记到那份 NO_UI_DIRS**，
  // 漏登记不报错，只会让新目录的分层违规**静默漏检**。
  {
    const cyc = fs.existsSync(path.join(process.cwd(), 'tests', 'importCycles.test.ts'))
      ? fs.readFileSync(path.join(process.cwd(), 'tests', 'importCycles.test.ts'), 'utf8')
      : ''
    const declared = (cyc.match(/const NO_UI_DIRS = \[([^\]]*)\]/) ?? [])[1] ?? ''
    ok('② 分层白名单已登记 src/lib/ 与 src/data/',
      declared.includes("'src/lib/'") && declared.includes("'src/data/'"),
      declared || '（没找到 NO_UI_DIRS 声明，importCycles 可能被改过）')
  }

  // ============ ③ 目录归属白名单 ============
  // ③-a `src/data/**` 是**纯数据**目录：不得有运行时 import（`import type` 是编译期擦除，允许）。
  //     理由：D3 把数据搬出 lib 就是为了让它们不进依赖图；一个运行时 import 就把它拉回来了。
  {
    const bad: string[] = []
    for (const f of files) {
      const r = rel(f)
      if (!r.startsWith('src/data/')) continue
      const t = clean.get(f)!
      const runtimeImports = (t.match(/\bimport\b(?!\s+type\b)[^\n]*\bfrom\b|\bimport\s*\(/g) ?? []).length
      if (runtimeImports > 0) bad.push(`${r}（${runtimeImports} 条运行时 import）`)
    }
    ok('③-a src/data/ 内无运行时 import（只允许 import type）', bad.length === 0, bad.join(' ｜ '))
  }
  // ③-b `src/lib/**` 下不得再冒出「纯数据文件」：没有任何函数/箭头赋值、却超过 200 行的导出字面量。
  //     判据取「无 function / 无 => / 无 class」——`lib/seedData.ts` 有 12 处工厂函数，故不会误伤。
  //     ⚠️ 但纯**类型**文件（interface/type 为主）也天然没有函数，行数一涨就会被误伤
  //     （2026-09-25：types.ts 涨到 222 行后中招）—— 类型声明是代码结构不是数据，用具名豁免登记
  //     （同 ④ 的 JSON_PARSE_OK 手法：例外必须写清理由，否则就是给自己开后门）。
  const TYPE_FILE_OK: Record<string, string> = {
    'src/lib/types.ts': '类型定义文件：15 个 interface/type + 1 个单行默认值常量（DEFAULT_CALENDAR_RULE，随 CalendarRule 类型走才内聚），不是数据表',
    // 2026-10-03：TABS 数组体按原顺序切到 schemaTabs/part1..3（schema.ts 一度 1199 行、离硬闸只差 1 行）。
    // 它们**不是数据表**：靠 schemaShared 的构造器（c / cr / f…）与 getter 拼装，题材一变内容就变，
    // 落到 src/data/ 会把「TabDef 组装逻辑」与「数据」搅在一起（且 src/data/ 内禁止运行时 import）。
    // 判据「无 function / 箭头函数」对「纯字面量 + 构造器调用」这种写法失灵 —— 故在此登记豁免并写明理由。
    'src/lib/schemaTabs/part1.ts': 'TABS 第 1 段：TabDef 字面量 + 构造器调用（c / f）+ 题材 getter，非数据表',
    'src/lib/schemaTabs/part2.ts': 'TABS 第 2 段：同上（列定义为主）',
    'src/lib/schemaTabs/part3.ts': 'TABS 第 3 段：同上（列定义为主）',
    // 2026-10-10：W4-3 跑团互动的数据契约（RunSession / RunClue / RunSecret / RunEnding…）。
    // **纯类型文件**（全是 interface/type，零函数），217 行全是类型声明 —— 这是**代码结构不是数据表**，
    // 落 src/data/ 反而违背「data 只放数据、不放类型」的分工（且 src/data/ 内禁运行时 import，
    // 它需要 `import type` 复用 tavern/types 的 TavernMessage / TavernVars）。
    // 与 `src/lib/types.ts` 同款情形：类型声明随功能增长，按行数切出去毫无意义。
    'src/lib/run/runTypes.ts': '类型定义文件：跑团局契约（纯 interface/type，零运行时逻辑），复用 tavern/types 的会话底盘类型',
  }
  {
    const bad: string[] = []
    for (const f of files) {
      const r = rel(f)
      if (!r.startsWith('src/lib/')) continue
      if (TYPE_FILE_OK[r]) continue
      const t = clean.get(f)!
      const hasLogic = /\bfunction\b|=>|\bclass\b/.test(t)
      const lines = text.get(f)!.split('\n').length
      if (!hasLogic && lines > 200) bad.push(`${r}（${lines} 行纯字面量，应落 src/data/）`)
    }
    ok('③-b src/lib/ 下没有「纯数据文件」（应落 src/data/）', bad.length === 0, bad.join(' ｜ '))
  }

  // ============ ④ 禁裸 JSON.parse ============
  // 红线原文：「解析统一 aiParse.ts（禁裸 JSON.parse）」。
  // ⚠️ 它的**适用范围不是全项目**，而是「把**模型返回的文本**变成结构化数据」这条链 ——
  //    把加解密、传输解码、桌面 JSON 文件读取也一起禁掉是过头的（那些不是模型文本，
  //    aiParse 的「剥代码块 / 切最外层大括号」对它们没有意义）。
  //    故闸的作用域 = AI 链路模块 + `src/lib/ai*`；其余位置**不算违规**。
  const AI_CHAIN = (r: string) =>
    // 3.0 目录整理（G3）：AI 管线从 lib 顶层集中到 `lib/ai/`
    // （aiAssist / aiParse / aiTasks / aiWorkflow / contextLayers / promptGuard …）
    /^src\/lib\/ai\//.test(r) ||
    /^src\/lib\/ai(Tasks|Core)?\//.test(r) ||   // 既有子目录 aiCore/ · aiTasks/
    /^src\/lib\/ai\.ts$/.test(r) ||             // 顶层门面（门面留在顶层，与 db.ts 同款）
    /^src\/lib\/outline\/autoContinue\.ts$/.test(r) ||  // 自动续写（3.0 从顶层挪入 outline/）
    /^src\/lib\/(flow|bookbreak)\//.test(r) ||
    /^src\/lib\/tavern\/(engine|story|draft|vars)\.ts$/.test(r)
  /**
   * `JSON.parse` 的**具名例外**：`文件 → 理由`。
   * 🔴 例外必须写清「为什么它不是红线要管的那种解析」，否则就是给自己开后门。
   */
  const JSON_PARSE_OK: Record<string, string> = {
    'src/lib/ai/aiParse.ts': '唯一合法出口 —— 本规则要保护的就是它，它自己当然要实现 JSON.parse',
    'src/lib/aiCore/transport.ts': '2.8.0 起由 `ai.ts` 迁来。传输层两处**信封解析**：① SSE 行解析器（每行 `data:{…}` 或裸 JSON 增量）；② 服务商 HTTP 错误体（describeApiError 抠 error.message）—— 都不是「模型正文 → 结构化数据」',
    // 3.0 目录整理（G3）后本闸作用域从「lib 顶层个别 ai 文件」扩到整个 `lib/ai/` —— 扫出这处既有用法。
    // safeJsonText 解析的是**联网检索托管 API 的 HTTP 响应体**（各家字段名不一，失败即退回原文），
    // 与 transport.ts 的「信封解析」同类，不是「模型正文 → 结构化数据」。
    'src/lib/ai/webSearch.ts': '联网检索的 HTTP 响应体解析（safeJsonText），非模型文本解析；与 transport.ts 同属「信封解析」',
  }
  {
    const bad: string[] = []
    for (const f of files) {
      const r = rel(f)
      if (!AI_CHAIN(r) || JSON_PARSE_OK[r]) continue
      const t = clean.get(f)!
      const hits = (t.match(/\bJSON\.parse\s*\(/g) ?? []).length
      if (hits > 0) bad.push(`${r}（${hits} 处）`)
    }
    ok('④ AI 链路内无裸 JSON.parse（须走 aiParse）', bad.length === 0, bad.join(' ｜ '))
  }

  // ============ ⑤ 禁原生弹窗 ============
  // 🔴 三端（网页 / 便携 / 桌面）行为必须一致：原生弹窗在桌面版里样式与主题脱节，
  //    且**阻塞渲染进程**。统一走 PromptModal / confirmDialog / toast。
  {
    const bad: string[] = []
    const re = /(^|[^.\w$])(window\.)?(prompt|confirm|alert)\s*\(/g
    for (const f of files) {
      const t = clean.get(f)!
      const src = text.get(f)!
      let m: RegExpExecArray | null
      while ((m = re.exec(t))) {
        // 排除本项目自己的封装：confirmDialog( / PromptModal / showToast( 等都不匹配；
        // 但 `xxx.confirm(`（如自定义对象的同名方法）要放过 → 上面正则已用 [^.\w$] 挡掉点号前缀
        const lineNo = src.slice(0, m.index).split('\n').length
        bad.push(`${rel(f)}:${lineNo} → ${m[0].trim()}`)
      }
    }
    ok('⑤ 无原生弹窗（prompt / confirm / alert）', bad.length === 0, bad.slice(0, 5).join(' ｜ '))
  }

  // ============ ⑥ any 不得增长 ============
  // 为什么用「账本」而不是「全局禁 any」：存量里仍有若干处**真正无法静态描述**的边界
  //   （Electron preload 桥 / Node require 探测 / 动态 StoreOps 分发），一次性清零既不现实、
  //   也会逼出更差的写法（`as unknown as X` 满天飞）。账本的作用是**把增长变成一次显式决定**：
  //   新增 any 必须同时抬账，而抬账是一次看得见的 diff —— 这就是摩擦力。
  // ⚠️ 账本只减不增：收窄了 any 就顺手把数字降下来。
  // 本轮（2026-09-19 · D7）成果：全项目 112 处 → 35 处；`syncCore.ts` 69 处 → **0**。
  // 🎉 2026-09-20 第三轮收窄后：**全项目 any 归零**（112 → 35 → 8 → 0）。
  // 🔴 这些 0 不是冗余 —— 它们是「这件事做完了」的证据。哪天有人又写回一个 any，
  //    这条闸立刻红（已实测：注入 1 个 any → 报「1 > 账本 0」）。
  const ANY_LEDGER: Record<string, number> = {
    'src/lib/sync/syncCore.ts': 0,
    'src/lib/db/core.ts': 0,
    'src/lib/sync/desktopCloudSync.ts': 0,
    'src/lib/sync/syncTransport.ts': 0,
    'src/lib/outline/autoContinue.ts': 0,
    'src/lib/ai.ts': 0,
    'src/components/app/CloudFileSyncBar.tsx': 0,
    'src/components/app/Sidebar.tsx': 0,
    'src/lib/search/materialRef.ts': 0,
  }
  {
    const re = /(?<![\w.$])any(?![\w$])/g
    const found: Record<string, number> = {}
    for (const f of files) {
      const r = rel(f)
      const c = (clean.get(f)!.match(re) ?? []).length
      if (c) found[r] = c
    }
    const total = Object.values(found).reduce((a, b) => a + b, 0)
    const over: string[] = []
    for (const [r, c] of Object.entries(found)) {
      const cap = ANY_LEDGER[r]
      if (cap === undefined) { over.push(`${r} 新增 ${c} 处（账本未登记）`); continue }
      if (c > cap) over.push(`${r} ${c} > 账本 ${cap}`)
    }
    ok('⑥ 没有文件超出 any 账本', over.length === 0, over.join(' ｜ '))
    note(`⑥ any 现状共 ${total} 处 / ${Object.keys(found).length} 个文件：` +
      Object.entries(found).sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r}=${c}`).join('  '))
    // 账本里登记了、实际已归零的条目 → 提示可下调（不自动改，闸不该改自己）
    const stale = Object.entries(ANY_LEDGER).filter(([r, cap]) => cap > 0 && (found[r] ?? 0) < cap)
    if (stale.length) note(`⑥ 账本可下调（实际已少于登记）：${stale.map(([r, c]) => `${r} ${c} → ${found[r] ?? 0}`).join('；')}`)
  }

  // ============ ⑦ 保存类面板必须挂 Ctrl/Cmd+S ============
  // 🔴 2.7.3 社区反馈：作者在「世界设定 / 力量体系」里按 Ctrl+S 毫无反应 —— 根因不是快捷键坏了，
  //    而是「每个编辑面板各抄一份 keydown 监听」：2.4.2 的 WorldSetSheet、2.7.2 的 ParallelSetSheet、
  //    酒馆的 TavernCard **一个都没抄**。「抄写型代码」的必然结局就是新增面板时漏一处，
  //    故已把实现收敛到 `src/lib/app/useSaveHotkey.ts`；本条闸负责把「谁必须挂」钉死 ——
  //    以后新增带「保存」按钮的面板，要么挂上，要么把文件名加进这张表并说清为什么不用挂。
  const HOTKEY_PANELS = [
    'src/components/sheets/FormSheet.tsx',          // 一页一份的表单（作品信息等）
    'src/components/world/CharacterSheet.tsx',     // 角色卡（主要 / 次要 / NPC）
    'src/components/outline/OutlineSheet.tsx',        // 分卷大纲 / 章节细纲
    'src/components/sheets/WorldSetSheet.tsx',      // 世界设定 / 力量体系（母子结构）← 本次反馈的漏挂处
    'src/components/sheets/ParallelSetSheet.tsx',   // 政治 / 经济基础 / 信仰 / 司法（并列结构）
    'src/components/tavern/TavernCard.tsx',         // 酒馆 · 角色卡片
    'src/components/sheets/useTableSheetModel.ts',  // 所有表格页签
    'src/components/editor/useNovelEditorModel.ts', // 正文写作台
    'src/components/tavern/TavernWorld.tsx',        // 酒馆 · 世界观设定
    'src/components/tavern/TavernScript.tsx',       // 酒馆 · 剧本 / 故事
    'src/components/tavern/TavernControl.tsx',      // 酒馆 · 控制面板
    'src/components/settings/AIPromptSettings.tsx',   // 模型设置 · 提示词（逐条存）
    'src/components/settings/AIWriterBudgetPanel.tsx',// 模型设置 · 额度
    'src/components/settings/NetworkProxyPanel.tsx',  // 模型设置 · 网络代理
  ]
  /**
   * ⑦ 的**豁免表**：疑似扫描里不必再喊的，写清「为什么不用挂」。
   * 🔴 这里的每一条都是一次显式决定 —— 加进来就要能说出理由，别当噪音过滤器用。
   */
  const HOTKEY_EXEMPT: Record<string, string> = {
    'src/components/sheets/TableSheet.tsx': '表格页签的外壳 —— 保存逻辑在 useTableSheetModel（它已挂）',
    'src/components/tavern/TavernCardMemoryPanel.tsx': '嵌在 TavernCard 里 —— 父级已挂；再挂一次会「存卡 + 存记忆」双写竞态',
    'src/components/tavern/useTavernCardModel.ts': 'model 层 —— 快捷键挂在组件 TavernCard 上',
    'src/components/tavern/useTavernControlModel.ts': 'model 层 —— 快捷键挂在组件 TavernControl 上',
  }
  {
    const byRel = new Map<string, string>()
    for (const f of files) byRel.set(rel(f), f)
    const missing: string[] = []
    for (const r of HOTKEY_PANELS) {
      const f = byRel.get(r)
      if (!f) { missing.push(`${r}（文件不存在 —— 改名/删除后请同步本表）`); continue }
      if (!clean.get(f)!.includes('useSaveHotkey')) missing.push(r)
    }
    ok('⑦ 保存类面板全部挂了 Ctrl/Cmd+S（useSaveHotkey）', missing.length === 0, missing.join(' ｜ '))
    // 软提示（不失败）：新出现的「有 dirty + 有保存动作、却没挂快捷键」的文件。
    // 为什么要提示：漏挂的表现是「按了没反应」，不会报错、不会崩溃 —— 只能靠闸提前喊一声。
    const suspect: string[] = []
    for (const f of files) {
      const r = rel(f)
      if (r.startsWith('src/components/') === false) continue
      const t = clean.get(f)!
      if (!/dirty/i.test(t)) continue
      if (!/\bsave\w*\(/.test(t)) continue
      if (t.includes('useSaveHotkey')) continue
      if (HOTKEY_PANELS.includes(r) || HOTKEY_EXEMPT[r]) continue
      suspect.push(r)
    }
    if (suspect.length) note(`⑦ 疑似新增的保存面板（确认要不要挂 Ctrl+S）：${suspect.join('；')}`)
  }

  /**
   * ⑧ 源码不得含**字面控制字符**（NUL 等）。
   *
   * 🔴 为什么值得单列一条闸：文件里只要有一个 NUL，**grep / ripgrep 就把整个文件判成 binary**，
   *    只输出「Binary file xxx matches」而不给行号 —— 于是全仓一切靠 grep 做的检查
   *    （本闸自己的排障、`docs/` 死代码回查、结构审计、AI 的改动前核实）在这一个文件上**静默失明**：
   *    命令有输出、看着像命中了，实际拿不到任何位置信息。
   *    2026-10-04 实证：`src/lib/settings/fieldAlias.ts` 里 `cols.join('<NUL>')` 就是这么写的 —— 运行时值没错
   *    （NUL 当分隔符甚至比空格更严谨），但**源码脏**。发现它的过程正是「grep 只报文件名、要不到行号」。
   *    已改为等价的转义写法 `'\u0000'`。制表符与换行属正常源码字符，不在禁列。
   */
  {
    const bad: string[] = []
    for (const f of files) {
      const hits = (text.get(f)!.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g) ?? []).length
      if (hits) bad.push(`${rel(f)}（${hits} 处）`)
    }
    ok('⑧ 源码不含字面控制字符（NUL 会让 grep 把文件判为 binary、全仓扫描失明）', bad.length === 0, bad.join(' ｜ '))
  }

  /**
   * ⑨ 色值单一真源（2.8.0 · 台账 #045/#046 · 2026-10-04）
   *
   * 🔴 为什么要有它：调色板散在各处时，改一个语义色要翻 N 个文件，漏一处就出现「同一含义两处不同色」
   *    —— `lib/relationColors.ts` 的头注释记着一次真实事故：两张关系图**各自**维护内置色板，
   *    同一「敌对」在人物图与势力图里颜色不同。现在全部收口到 `src/lib/settings/palette.ts`，本闸防它再散开。
   *
   * ⚠️ 判定用 `stripComments`（**保留字符串**）而不是 `stripCommentsAndStrings`：
   *    色值恰恰住在字符串里，连字符串一起剥就等于把要查的东西擦干净 —— 闸会永远全绿、最舒服也最没用。
   *
   * 允许出现裸色值的**且仅限**下面几处 —— 它们不是在「用色」，而是在「描述一套主题 / 文档」：
   *   ① `src/lib/settings/palette.ts`                —— 真源本体；
   *   ② `src/components/settings/CustomThemeDialog.tsx` —— 自定义主题预设（作者要自定义的就是色值本身）；
   *   ③ `src/lib/settings/theme.ts`                  —— 内置主题注册表 + 换肤预览色块；
   *   ④ `src/lib/tavern/exportDoc.ts`       —— 导出文档自带的内联 CSS（必须自洽，不随 App 主题）。
   * 其余任何 `.ts` / `.tsx` 里出现 `#rgb` / `#rrggbb` 一律失败 —— 请从 `lib/palette.ts` 取。
   */
  {
    const HEX_ALLOW = new Set([
      'src/lib/settings/palette.ts',
      'src/components/settings/CustomThemeDialog.tsx',
      'src/lib/settings/theme.ts',
      'src/lib/tavern/exportDoc.ts',
    ])
    // 3 / 4 / 6 / 8 位十六进制；后瞻避免把 `#A1B2C3D4` 这类长串切碎
    const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g
    const bad: string[] = []
    for (const f of files) {
      const r = rel(f).replace(/\\/g, '/')
      if (HEX_ALLOW.has(r)) continue
      const src = stripComments(text.get(f)!)
      // `#013` / `#017` 这类是台账编号（恰好全是 hex 字符），不是颜色
      const hits = (src.match(HEX) ?? []).filter(h => !/^#0\d\d$/.test(h))
      if (hits.length) bad.push(`${r}（${hits.length} 处：${[...new Set(hits)].slice(0, 5).join(' ')}）`)
    }
    ok('⑨ 裸色值只许出现在 lib/palette.ts 与三处「主题 / 文档定义」（调色板单一真源）', bad.length === 0, bad.join(' ｜ '))
  }

  /**
   * ⑩ 系统提示词注入不可绕过（2026-10-06）
   *
   * 🔴 来由：作者在「模型配置」里填了自定义系统提示词，界面对他的承诺是
   *    「对所有调用此模型的功能生效」—— 可盘点发现**酒馆全目录 + 正文续写字数校准 +
   *    全局对话引导共 18 处根本没接**。根因不是谁偷懒，而是这件事原本靠**每个调用点自觉**
   *    多写一行 `composeSystemPrompt(...)`：抄写型代码的必然结局就是新增功能时漏一处，
   *    而且漏了不报错、不崩溃（表现只是「填了没感觉」）。
   *
   * 修法是把注入下沉到 `chat()` 的兜底（`core.injectUserSystemPrompt`）——
   * 从此**新增 AI 功能只要走 chat() 就自动接入**。本条闸负责让这个支点不被拆掉：
   *   (a) 兜底注入那行代码必须还在（误删 = 承诺静默作废，且没有任何测试会红）；
   *   (b) 不许有模块绕开 `chat()` 自己发对话请求 —— 绕开 chat() 就必然绕开注入。
   *
   * ⚠️ 判定用 `stripComments`（**保留字符串**）：端点写在模板串里，连字符串一起剥就查不到了。
   *    已知的合法例外：`semantic/embed.ts` 打的是 `/api/embed` / `/embeddings`（向量化不是生成，
   *    没有「系统提示词」这个概念），它天然不命中本规则，故例外表为空。
   */
  {
    const chatFile = files.find(f => rel(f).replace(/\\/g, '/') === 'src/lib/aiCore/chat.ts')
    ok('⑩-a chat() 仍调用兜底注入 injectUserSystemPrompt（拆掉它＝所有功能的注入一并失效）',
      !!chatFile && clean.get(chatFile)!.includes('injectUserSystemPrompt('),
      chatFile ? '（aiCore/chat.ts 里找不到该调用）' : '（找不到 src/lib/aiCore/chat.ts）')

    const LLM_EDGE = /\/api\/chat|\/chat\/completions/
    const EDGE_OK: Record<string, string> = {
      'src/lib/aiCore/chat.ts': '全项目唯一的对话出口 —— 兜底注入就在这里',
    }
    const bypass: string[] = []
    for (const f of files) {
      const r = rel(f).replace(/\\/g, '/')
      if (!r.startsWith('src/lib/')) continue
      if (EDGE_OK[r]) continue
      // ⚠️ 只认「当真在拼请求地址」的写法：**同一行既有端点路径、又有模板串插值 `${`**。
      //    这样 `base.endsWith('/chat/completions')` 这类纯字符串处理不会误报
      //    （transport 的 baseUrl 归一就是干这个的）—— 闸的假阳性一多，就没人信它了。
      const hits = stripComments(text.get(f)!).split('\n')
        .filter(line => LLM_EDGE.test(line) && line.includes('${')).length
      if (hits) bypass.push(`${r}（${hits} 处）`)
    }
    ok('⑩-b 没有模块绕开 chat() 自己发对话请求（绕过即等于绕开注入；确需例外请登记理由）',
      bypass.length === 0, bypass.join(' ｜ '))
  }
}

// ---------- ⑪ 导出/备份路径的失败必须可见 ＋ 喂给模型的消息过滤必须成对（2026-10-12 全量审计） ----------
//
// 起因（a/b）：全量审计 P2 —— `collectSidecarForExport` 的 catch 是**静默空 catch**：导出/备份外置时
//   某个 store 读不出来，会产出一份「元数据齐全、载荷全缺」的包，恢复时才暴露（调用点注释自己
//   把这称为「最危险的失败形态」，代码却允许它无声发生）。同族：`createAutoBackup` 读项目失败
//   静默给 `undefined` —— 万一那正是示范项目，就白写一份全量备份（还占掉一个淘汰名额）。
//   红线「写/导出失败必须可见」在此有明确形态 ⇒ 静态钉住。
//
// 起因（c）：`m.role !== 'system' && !m.hidden` 是「别让 AI 看见」的**唯一出口**（防剧透）。
//   历史教训是「某一条链少写一个条件 → 隐藏消息原样进上下文」，且**任何测试都不报错**。
//   ⚠️ 只闸 `src/lib/tavern/**`：UI 的 `messageCount` 统计**本就该含隐藏消息**（它数的是列表里
//   看得见的条数，不是送进模型那份），闸到 components 会假阳性 —— 闸一假就没人信（同 ⑩-b 的取舍）。
{
  const SRC = findSrc()
  if (!SRC) {
    ok('⑪ 能找到 src 目录（结构闸前置）', false)
  } else {
    // ---- ⑪-a 导出/外置读失败必须留痕 ----
    const sidecarSrc = fs.readFileSync(path.join(SRC, 'lib', 'storage', 'sidecar.ts'), 'utf8')
    const collectBody = /export async function collectSidecarForExport[\s\S]*?\n\}/.exec(sidecarSrc)?.[0] ?? ''
    ok('⑪-a collectSidecarForExport 的 catch 必须留痕（不许静默吞掉外置 store 读失败）',
      collectBody.includes('console.warn'),
      collectBody ? '（catch 里没有 console.warn）' : '（没抓到函数体，函数被改名了？请同步本闸）')

    // ---- ⑪-b 备份判定读项目失败必须留痕 ----
    const backupsSrc = fs.readFileSync(path.join(SRC, 'lib', 'db', 'backups.ts'), 'utf8')
    const autoBackupBody = /export async function createAutoBackup[\s\S]*?\n\}/.exec(backupsSrc)?.[0] ?? ''
    ok('⑪-b createAutoBackup 读项目失败必须留痕（静默会为示范项目白写一份全量备份）',
      /getProject\(projectId\)\.catch\([\s\S]{0,260}?console\.warn/.test(autoBackupBody),
      autoBackupBody ? '（catch 里没有 console.warn）' : '（没抓到函数体，函数被改名了？请同步本闸）')

    // ---- ⑪-c 酒馆 lib 侧的消息过滤必须成对 ----
    const tavernDir = path.join(SRC, 'lib', 'tavern')
    const offenders: string[] = []
    let checked = 0
    for (const f of fs.readdirSync(tavernDir)) {
      if (!f.endsWith('.ts')) continue
      fs.readFileSync(path.join(tavernDir, f), 'utf8').split('\n').forEach((line, i) => {
        if (!line.includes('filter(')) return
        if (!line.includes("role !== 'system'")) return
        checked++
        if (!line.includes('hidden')) offenders.push(`${f}:${i + 1}`)
      })
    }
    ok('⑪-c 酒馆 lib 侧「喂给模型的消息」过滤条件必须成对（role !== system 与 !hidden 同现）',
      offenders.length === 0 && checked >= 5,
      offenders.length
        ? '漏 !hidden 的：' + offenders.join('、')
        : `命中 ${checked} 处（少于此数 ⇒ 过滤出口被搬走了，请同步本闸，别静默放行）`)
  }
}

// ---------- ⑫ 全书叙事序平铺必须走 chapterSeq 真源（2026-10-17 第四轮审计 §六 · 收敛漂移） ----------
//
// 起因：全仓一度有 **4 份手写「按叙事序拉平章节」**（`chapterSeq` 内部、`novelEditorHelpers.orderedChapters`、
//   `ExportFormatDialog.flattenAll`、`aiContext` 三处 `[...flattenChapters(), ...orphans]`），
//   孤儿章口径分歧成三种：**丢弃 / 保留不排序 / 保留且排序** —— 同一本书在导出、AI 上下文、
//   编辑器伴写、酒馆锚点里顺序各不相同。其中有手写版**连「卷要先按 order 排」都没做**
//   （`useNovelEditorModel` 的黄金三章、`foreshadowEngine`、`exporter` 的投稿稿），
//   只要 volumes 传入顺序不是卷序，全书顺序就悄悄错。
//
// 修法：真源收敛为 `src/lib/outline/chapterSeq.ts` 的 `flattenAll`（含孤儿、垫底、排序）
//   与 `orphanChapters`（分组渲染的兜底组）。本闸负责让漂移不再回来。
//
// ⚠️ 判定用 `stripCommentsAndStrings`：注释里大量在讲「orphan」「flatMap」，
//    连注释一起判会假阳性一片（闸一假就没人信，同 ⑩-b 的取舍）。
{
  const SRC2 = findSrc()
  if (!SRC2) {
    ok('⑫ 能找到 src 目录（结构闸前置）', false)
  } else {
    const rel2 = (f: string) => path.relative(path.dirname(SRC2), f).replace(/\\/g, '/')
    const TRUTH = 'src/lib/outline/chapterSeq.ts'
    const truthFile = path.join(SRC2, 'lib', 'outline', 'chapterSeq.ts')

    // ⑫-a 真源还在（改名/搬走必须同步本闸，否则 ⑫-b/c 会集体静默失效）
    const truthSrc = fs.existsSync(truthFile) ? fs.readFileSync(truthFile, 'utf8') : ''
    ok('⑫-a 叙事序真源 `src/lib/outline/chapterSeq.ts` 存在且导出 flattenAll / orphanChapters',
      !!truthSrc && /export function flattenAll\b/.test(truthSrc) && /export function orphanChapters\b/.test(truthSrc),
      truthSrc ? '（真源里找不到这两个导出 —— 改名后请同步本闸）' : '（真源文件不存在）')

    // 正则自检：闸最怕「写错了还在全绿」。先证明这两条正则确实抓得住真写过的不良写法。
    const HAND_FLAT = /flatMap\([^;]{0,240}volumeId\s*===/
    // ⚠️ 必须带 `filter(`：光判「否定 + 集合包含 + volumeId」会误伤两类**合规**写法 ——
    //    ① `{!volumes.some(v => v.id === t.volumeId) && <span>原卷已删</span>}`（单条展示条件，
    //       `EditorModals.tsx` 恢复快照的提示）；
    //    ② `!expandedRef.current.has(ch.volumeId)`（UI 折叠态集合，`useNovelEditorModel.ts`）。
    //    闸的假阳性一多就没人信（同 ⑩-b 取舍）⇒ 只在「filter 出孤儿章集合」这个形态上拦。
    // 还要卡准**比较方向**：孤儿判定是「卷集合里没有『章的 volumeId』」——
    //   `v.id === c.volumeId` / `ids.has(c.volumeId)`。反方向（`c.volumeId === v.id`，即
    //   「这个卷下有没有章」，`bookVersion` 的空卷判定）语义相反，必须放过。
    const HAND_ORPHAN = /filter\([^;]{0,90}!\s*[\w.]+\.(?:some\([^()]{0,50}\.id\s*===\s*\w+\.volumeId\)|has\(\s*\w+\.volumeId\s*\))/
    {
      const t = (src: string) => stripCommentsAndStrings(src).replace(/\s+/g, ' ')
      ok('⑫-b 自检：手写平铺能被抓到',
        HAND_FLAT.test(t('const flat = volumes.flatMap(v => chs.filter(c => c.volumeId === v.id))')))
      ok('⑫-c 自检：手写孤儿判定能被抓到（filter 形态）',
        HAND_ORPHAN.test(t('const o = chs.filter(c => !vols.some(v => v.id === c.volumeId))'))
        && HAND_ORPHAN.test(t('const o = chs.filter(c => !ids.has(c.volumeId))')))
      ok('⑫-c 自检：非孤儿语义的否定判定不被误伤（展示条件 / 折叠态集合 / 空卷判定）',
        !HAND_ORPHAN.test(t('{!volumes.some(v => v.id === t.volumeId) && <span>原卷已删</span>}'))
        && !HAND_ORPHAN.test(t('if (ch && !expandedRef.current.has(ch.volumeId)) {'))
        // 反向判定（卷下有没有章）—— 与孤儿判定方向相反
        && !HAND_ORPHAN.test(t('const emptyVols = volumes.filter(v => !v.isFree && !chapters.some(c => c.volumeId === v.id))')))
      ok('⑫-b 自检：真源写法不会被误伤',
        !HAND_FLAT.test(t('return flattenAll(vols, chs)')))
    }

    const handFlat: string[] = []
    const handOrphan: string[] = []
    for (const f of walk(SRC2).map(x => path.resolve(x))) {
      const r = rel2(f)
      if (r === TRUTH) continue
      const t = stripCommentsAndStrings(fs.readFileSync(f, 'utf8')).replace(/\s+/g, ' ')
      if (HAND_FLAT.test(t)) handFlat.push(r)
      if (HAND_ORPHAN.test(t)) handOrphan.push(r)
    }
    ok('⑫-b 禁止手写「全书平铺」（flatMap + volumeId）—— 一律走 chapterSeq.flattenAll',
      handFlat.length === 0, handFlat.join(' ｜ '))
    ok('⑫-c 禁止各写一份「孤儿章判定」—— 一律走 chapterSeq.orphanChapters',
      handOrphan.length === 0, handOrphan.join(' ｜ '))

    // ⑫-d 反向钉住：真源确实被用起来了（用的人少于 5 处 ⇒ 迁移被回滚了，得有人看一眼）
    const users = walk(SRC2).map(x => path.resolve(x))
      .filter(f => rel2(f) !== TRUTH)
      .filter(f => stripCommentsAndStrings(fs.readFileSync(f, 'utf8')).includes('flattenAll('))
      .map(f => rel2(f))
    ok(`⑫-d flattenAll 有足够调用点（当前 ${users.length} 处）`, users.length >= 5,
      users.length ? `只有 ${users.join('、')}` : '一个调用点都没有 —— 迁移被回滚了？')
    if (users.length) note(`⑫-d 调用 flattenAll 的位置：${users.join('、')}`)
  }
}

console.log(`\nstructureGates: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
