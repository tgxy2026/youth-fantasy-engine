// 死代码细化：区分「外部引用」「同文件引用」
//
// ⚠️ v2 修正（2026-09-15）：v1 用 `.filter(l => !/^export\s/.test(l))` 排除定义行，
// 副作用是把**所有以 export 开头的行**都剔出了自用统计 —— 而真实引用大量长在
// 这些行上（`export const Button = forwardRef<HTMLButtonElement, ButtonProps>(...)`、
// `export const THEMES: ThemeDef[] = [...]`），导致系统性误报「同文件 0 引用」。
// v2 改为**只排除该符号自身的那一行定义**。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = (process.argv[2] || 'G:/AI软件/youth-fantasy-engine开发源码').replace(/\\/g, '/')
const SRC = path.join(ROOT, 'src')

/**
 * 剥离注释（`//` 行注释 + 块注释，含 JSX 的 `{/* *\/}`），保留行结构。
 * 🔴 不剥注释会**低估死代码**：某符号若只在注释里被提过一次，就被当成「有外部引用」而漏报。
 * 字符串/模板串保留内容（`data-*` / 类名字符串里的符号名仍算命中）。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  let st = 'code' // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i], c2 = src[i + 1]
    if (st === 'code') {
      if (c === '/' && c2 === '/') { st = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && c2 === '*') { st = 'block'; out += '  '; i += 2; continue }
      if (c === "'") { st = 'sq'; out += c; i++; continue }
      if (c === '"') { st = 'dq'; out += c; i++; continue }
      if (c === '`') { st = 'tpl'; out += c; i++; continue }
      out += c; i++; continue
    }
    if (st === 'line') { if (c === '\n') { st = 'code'; out += c; i++; continue } out += ' '; i++; continue }
    if (st === 'block') { if (c === '*' && c2 === '/') { st = 'code'; out += '  '; i += 2; continue } out += (c === '\n' ? '\n' : ' '); i++; continue }
    if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue }
    if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')) { st = 'code'; out += c; i++; continue }
    out += c; i++; continue
  }
  return out
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}
function walkAny(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'dist-web', 'release', '.workbuddy'].includes(e.name)) continue
    // 🔴 2026-09-19 加固：dot 前缀文件/目录一律不参与「被引用」统计 ——
    //    tests/.xxx.test.mjs 是 build-test.mjs 用 esbuild 打包出的**整份源码副本**（把整段实现抄进来，
    //    于是「只在 bundle 里出现」的符号被误判成有人用）；.workbuddy/** 是工作区临时脚本。
    //    实测：排掉后死导出候选 178 → 240（多出的正是被长期掩盖的真死导出）。
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    // 🔴 2026-10-22 修：**审计脚本自己不能当引用源**。
    //    病灶：本文件的 `KEEP` 表 key 是字符串 `'src/lib/xxx.ts:符号名'`，而 stripComments
    //    **刻意保留字符串内容**（类名 / data-* 里的符号名也算命中）⇒ 凡进了白名单的符号
    //    都会被自己这张表的 key 算成"外部有人用"，于是 A2「白名单保留」**永远显示 0 个**，
    //    白名单看着像在自动消账、实际靠的是这个字符串副作用。
    //    同轮还发现 A 类会被本文件注释里列举的符号名一起污染（15 个真死代码一度全变 0）。
    //    排除范围取整个 `scripts/audit`（六支扫描器都在这儿，谁都不该给谁作证）。
    if (/(^|[\\/])scripts[\\/]audit([\\/]|$)/.test(p)) continue
    if (e.isDirectory()) walkAny(p, out)
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}

const files = walk(SRC)
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/')
// 🔴 2026-09-19 加固：**再导出不算使用**。
//    背景：存储层拆分后 src/lib/db.ts 变成门面（只做再导出的索引文件），它会把整层名字"提"一遍，
//    按原始文本计数会让「死导出候选」被一次性掩盖（拆分当天就实测到了：db.ts 两个真死导出凭空消失）。
const stripReexport = s => {
  // 状态机：整段吞掉 export 清单（多行 `export {\n A,\n B,\n} from './x'` 也要吞），
  // 这类语句只是"把名字提一遍"，不是使用。⚠️ 别用单行正则糊弄 —— 门面恰恰是多行写法。
  const out = []
  let inList = false
  for (const l of s.split(/\r?\n/)) {
    if (inList) { out.push(''); if (/\}/.test(l)) inList = false; continue }
    if (/^\s*export\s+(?:\*|type\s*\{|\{)/.test(l)) {
      out.push('')
      inList = !(/\}/.test(l) || /\bfrom\s+['"]/.test(l) || /^\s*export\s+\*/.test(l))
      continue
    }
    out.push(l)
  }
  return out.join('\n')
}
const all = walkAny(ROOT).map(f => ({ f, t: stripReexport(stripComments(fs.readFileSync(f, 'utf8'))) })) // 去注释 + 去再导出，避免「提过」被当成引用

const reFn = /^export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/gm
const reType = /^export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm

const rows = []
for (const f of files) {
  const t = stripComments(fs.readFileSync(f, 'utf8'))
  const names = []
  let m
  while ((m = reFn.exec(t))) names.push({ n: m[1], kind: 'value' })
  while ((m = reType.exec(t))) names.push({ n: m[1], kind: 'type' })

  const lines = t.split(/\r?\n/)
  for (const { n, kind } of names) {
    const re = new RegExp(`\\b${n}\\b`, 'g')
    // 找出该符号的定义行（只需排除这一行，v1 的错误是排除了所有 export 行）
    const defIdx = lines.findIndex(l =>
      new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|class|let|var|interface|type|enum)\\s+${n}\\b`).test(l))
    let selfUse = 0
    for (let i = 0; i < lines.length; i++) {
      if (i === defIdx) continue
      selfUse += (lines[i].match(re) || []).length
    }
    let extUse = 0
    const extFiles = []
    for (const { f: g, t: gt } of all) {
      if (g === f) continue
      const c = (gt.match(new RegExp(`\\b${n}\\b`, 'g')) || []).length
      if (c > 0) { extUse += c; extFiles.push(rel(g)) }
    }
    rows.push({ file: rel(f), name: n, kind, selfUse, extUse, extFiles })
  }
}

/**
 * 🔴 保留白名单：**已查证判定「该留」的导出**，不计入死代码。键是 `相对路径:符号名`。
 *
 * 为什么必须有这张表（2026-09-20 查证时发现的真问题）：本脚本只能看「有没有人引用」，
 *   看不出「是不是刻意留着的」。项目里有几处**能力缺口** —— 功能实现完整、有测试、
 *   但**没接产品入口**，属红线点名的「保留 export，绝不降级」类别。它们长得跟死代码
 *   一模一样：没有白名单 → 每轮审计都重复提案删掉 → 迟早有人真删，**能力就丢了**。
 *   实测：那轮 A 类报的 5 个里，**4 个是白名单保护项**，只有一个（`getTombs`）是真死。
 *
 * ⚠️ 登记纪律：**必须写清「为什么保留」**。写不出理由的，就不该进这张表 —— 那就该删。
 */
const KEEP = {
  // 📌 2026-09-20：这里原有两条 —— `pruneGhostFreeChars` / `pruneGhostFreeSessions`（当年判定
  //    「自由模式的孤儿索引清理没接 UI」＝能力缺口，保留 export 绝不降级）。**现在不需要白名单了**：
  //    数据体检第 5 类「酒馆列表残留」接上了清理入口，它们由 `pruneGhostsSafely` 正常调用，
  //    已在 B 类（外部 0 引用、本文件内 1 引用）里，不再是「零引用导出」。
  //    ⚠️ 当年那条理由里还写错了一句「剧本模式同类 `pruneGhostSessions` 已接」：实测它也**没接**
  //    （只被 tests/tavernStore.test.ts 调用）—— 整条链两种模式都没有产品入口。已在
  //    docs/2.1.2-审计修复记录-2026-09-17.md 就地更正，别照旧的抄。
  //
  //    📌 另一条经验：白名单是「零引用 + 已查证该留」的账。符号一旦有了消费者就该**从表里撤掉** ——
  //    留着会在它将来真的变成死代码时静默保护它（白名单不该变成免责条款）。
  'src/lib/ai/promptSettings.ts:promptText':
    '预留 API：注释写明「给『函数内一次性提示词』用，有覆写用覆写、不登记进界面」——' +
    '是**待推广的写法**而不是垃圾；删掉会丢失这个设计意图',

  // 📌 2026-10-04 补登记：`outlineCard.ts` 的 `VolumeRange` 早在 2026-10-03（六维审计 D6）
  //    就判了「保留」，但当时**没有真的写进本表**（源码注释自称已登记 = 文档漂移）。
  'src/lib/outline/outlineCard.ts:VolumeRange':
    '「正文切卷」尚未落地的预留类型：零运行时开销的导出 interface，删掉只会让 ' +
    'docs/2.5.2-开发记录.md 的引用悬空。2026-10-03 六维审计 D6 判定保留',

  // 📌 2026-10-22 死代码清算（3.2.1）：只登记**有文档引用**的契约类型。
  //    判据：`.workbuddy/memory` 与源码注释里逐条点名过它 —— 删掉不会减小任何产物，
  //    只会让那些引用悬空（`jobTypes.ts` 第 7 / 20 行的注释明确拿它做对照）。
  //    零引用又零提及的类型**不进本表**（本轮就直接删了：TaskContextSnapshot /
  //    ChangeEventRecord / ContextSnapshot —— 没有任何东西引用它们，留着只是噪音）。
  //
  // 🔴 同一轮清算里另外 10 个「实现完整但没接 UI」的符号（failureReceipt /
  //    linkCheckToCandidate / rollbackMigration / useFieldAliases / loadPendingFieldKeys /
  //    moveFieldToGroup / canSemanticRead / isRecordSlot / atlasHasValue / serializeCustomValue）
  //    **故意不进本表** —— 它们该做的是"接入口"，进了白名单就等于给"该做没做"发免责条款。
  // 📌 2026-10-24（3.2.2 审计复核）：上面"另外 10 个故意不进本表"这句**本轮部分修订**。
  //    逐条回源码核过后，其中 3 个的结论不是"该接"而是"**不该接**"——继续留在候选里
  //    只会变成永久误报（每轮人工重判一次，最后必然被当成噪音无视）。判据与证据见
  //    docs/3.2.2-零引用符号重判-2026-10-23.md。剩下 6 条仍留在候选：它们是真的"该接没接"。
  'src/lib/templates/draftOps.ts:moveFieldToGroup':
    '“模板编辑里把字段换分组”是**尚未实现的新交互**，不是"实现完了没接线"：函数体只是纯数据变换，' +
    '缺的是拖拽/选分组界面本身。与 promptText、VolumeRange 同一类（预留 API）⇒ 不是接线缺口。' +
    '留它回候选清单的唯一后果是每轮都要重判一次',
  'src/lib/templates/semanticSlots.ts:isRecordSlot':
    '“记录级槽位读取时先于扩展槽位”这条规则**已由 tableDigest.preferKeys 实现**（tableRender 传 ' +
    'preferKeys 先保名称列），该谓词因此没有天然调用点；且列投影（TableFieldProjection）里不带槽位信息，' +
    '要接就得把映射链一路传进渲染层 —— 那是链路改造，不是补一行。属"已被替代"而非"该接未接"',
  'src/lib/atlas/schema.ts:atlasHasValue':
    '与详情页现用的 `atlasDisplayValue().length > 0` **不可互换**：前者判"解析后的值是否为空"，' +
    '后者判"显示串是否为空"，在自定义类型/格式化之后两者可以给出不同结论。换成它会改变详情页的' +
    '显示与折叠判定 ⇒ 那不是补接线，是改行为（源码注释已写明这处差异）',

  'src/lib/revision/revisionTypes.ts:TaskRunState':
    '契约类型：jobTypes.ts 的注释（第 7、20 行）明确拿它做「同名但不同层」的对照说明；' +
    '零运行时开销，删了那段注释会指向空气',
  'src/lib/revision/revisionTypes.ts:CommitReceipt':
    '契约类型：jobTypes.ts 注释逐条点名（与提交回执同族）；零运行时开销，删了注释悬空',

  // 📌 2026-10-22：修掉本脚本「审计脚本自己给符号作证」的 bug 后**新暴露**的一条
  //    （之前一直被本文件的字符串 mask 住，属于"修工具才发现的真候选"）。
  'src/lib/sync/syncCore.ts:EXCLUDED_META_KEYS':
    '真源已下沉后的**兼容 re-export**（`lib/storage/sensitiveMeta.ts` 才是真源，' +
    'syncCore 自己用的也是 SENSITIVE_META_KEYS / isSensitiveMetaKey）⇒ 安全上不留缺口。' +
    '保留理由：`electron/main.cjs:448` 与 4 个 src 文件的注释、以及 audit-sec 的 S4 文案' +
    '都逐条点名它，删了会让这些说明指向空气；且它就是"清单已下沉"这件事的唯一代码锚点',
}
const isKept = r => Object.prototype.hasOwnProperty.call(KEEP, `${r.file}:${r.name}`)

const kept = rows.filter(r => r.extUse === 0 && r.selfUse === 0 && isKept(r))
const dead = rows.filter(r => r.extUse === 0 && r.selfUse === 0 && !isKept(r))
const orphanExport = rows.filter(r => r.extUse === 0 && r.selfUse > 0)

const out = []
out.push(`# 死代码细化报告（v2）\n`)
out.push(`## A. 确定死代码（外部 0 引用 且 同文件 0 引用）——${dead.length} 个\n`)
out.push(`| 文件 | 符号 | 类型 |`)
out.push(`|---|---|---|`)
for (const d of dead) out.push(`| ${d.file} | ${d.name} | ${d.kind} |`)

out.push(`\n## A2. 白名单保留（同样 0 引用，但**已查证判定该留**）——${kept.length} 个`)
out.push(`> ⚠️ 这些**不是死代码**，别提案删。每条的理由见脚本里的 \`KEEP\` 表。\n`)
out.push(`| 文件 | 符号 | 保留理由 |`)
out.push(`|---|---|---|`)
for (const d of kept) out.push(`| ${d.file} | ${d.name} | ${KEEP[`${d.file}:${d.name}`]} |`)
if (!kept.length) out.push(`（无）`)

out.push(`\n## B. 多余 export（外部 0 引用，但文件内部在用）——${orphanExport.length} 个`)
out.push(`> 这些不需要删，只是 \`export\` 关键字多余；若为类型则是文件内自用。\n`)
out.push(`| 文件 | 符号 | 类型 | 同文件使用次数 |`)
out.push(`|---|---|---|---|`)
for (const d of orphanExport) out.push(`| ${d.file} | ${d.name} | ${d.kind} | ${d.selfUse} |`)

out.push(`\n## C. 被 tests 引用但产品代码不用（潜在"只为测试而活"的代码）\n`)
// 🔴 2026-09-26 修正误报：原判定漏了「同文件内部引用」——内部在用（selfUse>0）的导出被误报成
//    「仅 tests 引用」（实测：parseFusedIdeas / INSPIRATION_MAX / paragraphAt / READER_QUESTIONS
//    都被本文件派生链调用，export 只为让单测直接喂字符串）。真「只为测试而活」=
//    外部只被 tests 引 **且** 同文件内部零使用。
const testsOnly = rows.filter(r => r.extUse > 0 && r.extFiles.every(p => p.startsWith('tests/')) && r.selfUse === 0)
const internalAndTested = rows.filter(r => r.extUse > 0 && r.extFiles.every(p => p.startsWith('tests/')) && r.selfUse > 0)
out.push(`| 文件 | 符号 | 引用它的测试 |`)
out.push(`|---|---|---|`)
for (const d of testsOnly) out.push(`| ${d.file} | ${d.name} | ${d.extFiles.join(', ')} |`)
if (!testsOnly.length) out.push(`（无）`)
out.push(`\n## C2. 内部在用 + tests 覆盖（健康形态，仅供核对，不是问题）——${internalAndTested.length} 个`)
out.push(`> 导出被本文件内部使用、tests 直接引用做单测 —— 这是「可测性导出」的正常形态，别提案删。`)
out.push(`| 文件 | 符号 | 类型 | 同文件使用次数 | 引用它的测试 |`)
out.push(`|---|---|---|---|---|`)
for (const d of internalAndTested) out.push(`| ${d.file} | ${d.name} | ${d.kind} | ${d.selfUse} | ${d.extFiles.join(', ')} |`)

const text = out.join('\n')
fs.writeFileSync(path.join(ROOT, '.workbuddy/tmp/dead-code-report.md'), text, 'utf8')
console.log(text)
