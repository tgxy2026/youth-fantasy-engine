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
    'src/lib/seedData.ts': { max: 1600, why: '示范项目种子工厂：工厂码与卷章数据混排，⚠️ 已列 2.3.0 待拆分（纯数据应落 src/data/）' },
    'src/lib/tavern/protocol.ts': { max: 1600, why: '酒馆协议常量 + 旧版协议冻存（LEGACY_PROTOCOLS），属数据/协议表' },
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
    /^src\/lib\/ai(Tasks|Workflow|Parse|Context)?\//.test(r) ||
    /^src\/lib\/(ai|aiParse|aiTasks|aiWorkflow|autoContinue)\.ts$/.test(r) ||
    /^src\/lib\/(flow|bookbreak)\//.test(r) ||
    /^src\/lib\/tavern\/(engine|story|draft|vars)\.ts$/.test(r)
  /**
   * `JSON.parse` 的**具名例外**：`文件 → 理由`。
   * 🔴 例外必须写清「为什么它不是红线要管的那种解析」，否则就是给自己开后门。
   */
  const JSON_PARSE_OK: Record<string, string> = {
    'src/lib/aiParse.ts': '唯一合法出口 —— 本规则要保护的就是它，它自己当然要实现 JSON.parse',
    'src/lib/ai.ts': 'SSE **行解析器**：解析的是传输信封（每行 `data:{…}` 或裸 JSON 增量），不是「模型正文 → 结构化数据」',
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
    'src/lib/syncCore.ts': 0,
    'src/lib/db/core.ts': 0,
    'src/lib/desktopCloudSync.ts': 0,
    'src/lib/syncTransport.ts': 0,
    'src/lib/autoContinue.ts': 0,
    'src/lib/ai.ts': 0,
    'src/components/CloudFileSyncBar.tsx': 0,
    'src/components/Sidebar.tsx': 0,
    'src/lib/materialRef.ts': 0,
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
  //    故已把实现收敛到 `src/lib/useSaveHotkey.ts`；本条闸负责把「谁必须挂」钉死 ——
  //    以后新增带「保存」按钮的面板，要么挂上，要么把文件名加进这张表并说清为什么不用挂。
  const HOTKEY_PANELS = [
    'src/components/FormSheet.tsx',          // 一页一份的表单（作品信息等）
    'src/components/CharacterSheet.tsx',     // 角色卡（主要 / 次要 / NPC）
    'src/components/OutlineSheet.tsx',        // 分卷大纲 / 章节细纲
    'src/components/WorldSetSheet.tsx',      // 世界设定 / 力量体系（母子结构）← 本次反馈的漏挂处
    'src/components/ParallelSetSheet.tsx',   // 政治 / 经济基础 / 信仰 / 司法（并列结构）
    'src/components/TavernCard.tsx',         // 酒馆 · 角色卡片
    'src/components/useTableSheetModel.ts',  // 所有表格页签
    'src/components/useNovelEditorModel.ts', // 正文写作台
    'src/components/TavernWorld.tsx',        // 酒馆 · 世界观设定
    'src/components/TavernScript.tsx',       // 酒馆 · 剧本 / 故事
    'src/components/TavernControl.tsx',      // 酒馆 · 控制面板
    'src/components/AIPromptSettings.tsx',   // 模型设置 · 提示词（逐条存）
    'src/components/AIWriterBudgetPanel.tsx',// 模型设置 · 额度
    'src/components/NetworkProxyPanel.tsx',  // 模型设置 · 网络代理
  ]
  /**
   * ⑦ 的**豁免表**：疑似扫描里不必再喊的，写清「为什么不用挂」。
   * 🔴 这里的每一条都是一次显式决定 —— 加进来就要能说出理由，别当噪音过滤器用。
   */
  const HOTKEY_EXEMPT: Record<string, string> = {
    'src/components/TableSheet.tsx': '表格页签的外壳 —— 保存逻辑在 useTableSheetModel（它已挂）',
    'src/components/TavernCardMemoryPanel.tsx': '嵌在 TavernCard 里 —— 父级已挂；再挂一次会「存卡 + 存记忆」双写竞态',
    'src/components/useTavernCardModel.ts': 'model 层 —— 快捷键挂在组件 TavernCard 上',
    'src/components/useTavernControlModel.ts': 'model 层 —— 快捷键挂在组件 TavernControl 上',
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
}

console.log(`\nstructureGates: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
