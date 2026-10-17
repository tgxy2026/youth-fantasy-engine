process.env.YFE_AUDIT_FULL ??= '1'
// AI 提示词审查扫描器（只读）—— 补「提示词是否精炼准确、是否与功能目标一致」这一维
// 用法：node .workbuddy/tmp/audit-prompt.mjs [工作区路径]
// 提示词的**语义质量**只能靠 A/B 实弹（见 SKILL「已知答案对照法」），但以下几件事是确定性的：
//   规模 / 重复 / 死提示词 / 输出约束缺失 / 占位未写完 / 作者正文未包裹 / 字段与解析器脱钩。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = (process.argv[2] || 'G:/AI软件/youth-fantasy-engine开发源码').replace(/\\/g, '/')
const SRC = path.join(ROOT, 'src')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/')
const files = walk(SRC)
const raw68 = new Map()
for (const f of files) raw68.set(f, fs.readFileSync(f, 'utf8'))

const CJK_RE = /[\u4e00-\u9fff]/
const out = []
const P = s => out.push(s)

/** 从 `const NAME = ` 后的反引号起，找到配平的收尾反引号（处理 \` 转义与 ${} 内的嵌套） */
function readTemplate(s, open) {
  let i = open + 1, depth = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') { i += 2; continue }
    if (c === '$' && s[i + 1] === '{') { depth++; i += 2; continue }
    if (c === '}' && depth > 0) { depth--; i++; continue }
    if (c === '`' && depth === 0) return { body: s.slice(open + 1, i), end: i }
    i++
  }
  return null
}

/** 粗估 token：中文≈1 字 1 token，英文≈0.75 词/token，标点再折一半。**
 *  ⚠️ 只是量级，给「这段是不是明显过长」用；别拿它跟厂商计数对账（±30%）。 */
function estTokens(s) {
  const cjk = (s.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
  const rest = s.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, ' ')
  const words = (rest.match(/[A-Za-z0-9_]+/g) || []).length
  const punct = (rest.match(/[^\sA-Za-z0-9_]/g) || []).length
  return Math.round(cjk + words * 1.3 + punct * 0.5)
}

// ── P0. 抓提示词资产 ──────────────────────────────────────────────
// 出厂数据不是提示词 —— seedContent/materialData/seedData 里躺着整章正文与素材表。
// 🔴🔴 **必须按「文件名」匹配，绝不能按路径**（2026-09-19 重构踩点）：
//   数据文件已从 `src/lib/` 搬到 `src/data/`，若仍写成 `'lib/seedContent.ts'`，
//   `rel(f)` 会变成 `data/seedContent.ts` ⇒ 匹配失败 ⇒ CH1…CH21 全部重新混进资产、
//   「合计 token」虚报回 10 万（就是下面那条历史坑原样复发，而且**扫描器完全不报错**）。
//   按 basename 匹配 ⇒ 数据文件再搬到哪儿都免疫。
const DATA_FILES = ['seedContent.ts', 'materialData.ts', 'seedData.ts']
const isDataFile = f => DATA_FILES.includes(path.basename(f))
const assets = []
for (const f of files) {
  const s = raw68.get(f)
  const re = /(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=\s*`/g
  for (const mm of s.matchAll(re)) {
    const open = s.indexOf('`', mm.index + mm[0].length - 1)
    if (open < 0) continue
    const t = readTemplate(s, open)
    if (!t) continue
    // ⚠️ 出厂数据文件会全金属命中：CH1…CH21 是《吞天神脉》正文，不是提示词（实测把 22 条假资产排到榜首）。
    if (isDataFile(f)) continue
    if (t.body.length < 60 || !CJK_RE.test(t.body)) continue
    assets.push({
      name: mm[1],
      file: rel(f),
      line: s.slice(0, mm.index).split('\n').length,
      body: t.body,
      chars: t.body.length,
      tokens: estTokens(t.body),
    })
  }
}
assets.sort((a, b) => b.tokens - a.tokens)

// ── P1. 提示词资产清单（规模）──────────────────────────────────────
{
  const total = assets.reduce((n, a) => n + a.tokens, 0)
  P(`\n── P1. 提示词资产 ${assets.length} 处 · 合计粗估 ${total} tokens ──`)
  P('  判据：赋给 const 的含中文模板串 ≥60 字。token 为粗估，只用于比较「谁最肥」。')
  P('  为什么查规模：本地上下文贵且有限（预算上限 32K）；一段几千 token 的 system 会把真正重要的数据挤出去。')
  for (const a of (process.env.YFE_AUDIT_FULL === '1' ? assets : assets.slice(0, 15))) {
    P(`  ▸ ${String(a.tokens).padStart(6)} tok / ${a.chars} 字  ${a.name}  ${a.file}:${a.line}`)
  }
  const big = assets.filter(a => a.tokens > 2000)
  if (big.length) P(`  ⚠️ 超 2000 token 的胖资产 ${big.length} 个 —— 优先热这些：${big.map(a => a.name).slice(0, 6).join('、')}`)
}

// ── P2. 重复句段（跨提示词雷同）───────────────────────────────────
{
  const buckets = new Map()
  for (const a of assets) {
    const id = `${a.file}:${a.line}`
    for (const l of a.body.split(/\r?\n/)) {
      const t = l.trim().replace(/\s+/g, '')
      // ⚠️ `${xxx.trim()||'（无）'}` 这类插值样板会被当成"重复句"（实测占位榜首 ×10）。
      //    剥掉插值后再判定 —— 剩下的才是真正被复制粘贴的规则文字。
      const plain = t.replace(/\$\{[^}]*\}/g, '')
      if (plain.length < 20 || !CJK_RE.test(plain)) continue
      // ⚠️ 按**资产**去重而非按文件：aiTasks.ts 一家就有 20+ 段 sys，按文件去重会把它们全吃掉（实测 0 条假阴）
      if (!buckets.has(t)) buckets.set(t, { assets: new Set(), files: new Set() })
      buckets.get(t).assets.add(id)
      buckets.get(t).files.add(a.file)
    }
  }
  const dup = [...buckets.entries()].sort((a, b) => b[1].assets.size - a[1].assets.size || b[0].length - a[0].length)
    .filter(([, v]) => v.assets.size >= 2)
  P(`\n── P2. 重复提示句段（≥25 字且出现在 ≥2 处资产 · ${dup.length} 条 TOP12）──`)
  P('  判读：同一句规则在多份提示词里各写一遍 → 改一处忘一处，必然漂移。能抽公共片段就抽。')
  for (const [t, v] of (process.env.YFE_AUDIT_FULL === '1' ? dup : dup.slice(0, 12))) P(`  ▸ ×${v.assets.size} 处（${v.files.size} 文件）「${t.slice(0, 60)}」`)
  if (!dup.length) P('  ✅ 无跨文件重复提示句')
}

// ── P3. 死提示词（定义了没用）─────────────────────────────────────
{
  const dead = [], local = []
  for (const a of assets) {
    let ext = 0, self = 0
    for (const f of files) {
      const s = raw68.get(f)
      const hits = [...s.matchAll(new RegExp(`\\b${a.name.replace(/\$/g, '\\$')}\\b`, 'g'))].length
      if (!hits) continue
      if (rel(f) === a.file) self += hits; else ext += hits
    }
    // self 含定义行本身：self=2 ⇒ 定义 + 1 次本地拼装（正常）。只有 self≤1 才是"写了没用"。
    if (ext === 0) (self <= 1 ? dead : local).push({ a, self })
  }
  P(`\n── P3. 无外部引用的提示词 ──`)
  P('  判读：ext=0 且 self=1 ⇒ **写了没用**，可删；ext=0 但 self≥2 ⇒ 在本文件内被拼装，属正常。')
  P(`  ▸ 疑似死提示词 ${dead.length} 个${dead.length ? '（重点）' : ''}`)
  for (const { a, self } of (process.env.YFE_AUDIT_FULL === '1' ? dead : dead.slice(0, 12))) P(`       ${a.name}  ${a.file}:${a.line}  (本文件仅出现 ${self} 次)`)
  P(`  ▸ 仅内部拼装 ${local.length} 个（正常）`)
  for (const { a, self } of (process.env.YFE_AUDIT_FULL === '1' ? local : local.slice(0, 10))) P(`       ${a.name}  ${a.file}:${a.line}  (本文件 ${self} 次)`)
  if (!dead.length) P('  ✅ 无死提示词')
}

// ── P4. 输出约束缺失（要 JSON 却没管住模型的嘴）───────────────────
{
  // 「闭嘴条款」的中文说法很多，漏一种就是一片假报；另外调用点传 `json: true`（response_format 强约束）
  // 比提示词里写十句「只输出 JSON」都管用 —— 那类要降为提醒，不能算缺失。
  const SHUTUP = /只输出|仅输出|不要输出|除此之外|不加任何|不要包含|不要 markdown|markdown 代码块|不要用代码块|严格的 JSON|合法的? JSON|纯 JSON|按上述 JSON|只返回|严格按照/
    // ⚠️ 「不要 JSON、不要代码块」是**明确拒绝** JSON，别当成"要求 JSON"（实测误报源）。
    //    判定要看肯定/否定语气：必须出现肯定的 JSON 索取，且没有否定句。
    const asksJSON = assets.filter(a =>
      /(?:返回|输出|只(?:用|输出)|必须|严格)[^。\n]{0,6}JSON|JSON\s*(?:数组|对象|格式)|JSON\s*[:：]/.test(a.body)
      && !/不要\s*(?:输出\s*)?JSON|不用\s*JSON|JSON\s*都?不要/.test(a.body))
  const mitigated = new Set()
  const weak = asksJSON.filter(a => {
    if (SHUTUP.test(a.body)) return false
    const after = raw68.get(files.find(f => rel(f) === a.file)).split('\n').slice(a.line - 1, a.line + 45).join('\n')
    if (/json:\s*true/.test(after)) { mitigated.add(a); return false }
    return true
  })
  P(`\n── P4. 要求结构化输出但缺少「闭嘴条款」（${weak.length}/${asksJSON.length}，另有 ${mitigated.size} 处靠 json:true 兜住）──`)
  P('  判读：只说「输出 JSON」没说「除此之外别写」→ 小模型先来一段「好的，以下是…」，解析端全丢（表现为"成功但 0 条"）。')
  for (const a of (process.env.YFE_AUDIT_FULL === '1' ? weak : weak.slice(0, 12))) P(`  ▸ ${a.name}  ${a.file}:${a.line}`)
  if (!weak.length) P('  ✅ 结构化类提示词都有输出约束')
}

// ── P5. 提示词里的占位 / 未写完 ───────────────────────────────────
{
  const RE = /TODO|FIXME|待定|暂定|XXX|\(待补|示例如下|此处省略|后面再说/
  const hits = []
  for (const a of assets) {
    a.body.split(/\r?\n/).forEach((l, i) => { if (RE.test(l)) hits.push(`${a.file}:${a.line + i}  ${l.trim().slice(0, 70)}`) })
  }
  P(`\n── P5. 提示词里的占位标记（${hits.length} 处）──`)
  P('  判读：给模型的文字里出现 TODO/待定 = 这段从没人对账过。逐个确认是「有意占位」还是「忘了写」。')
  for (const h of (process.env.YFE_AUDIT_FULL === '1' ? hits : hits.slice(0, 12))) P(`  ▸ ${h}`)
  if (!hits.length) P('  ✅ 无占位')
}

// ── P6. 作者正文进 prompt 未走 promptGuard ────────────────────────
// 红线：作者原文进 prompt 必须走 promptGuard.authorBlock()（随机 nonce 隔离注入）；绝不清洗正文。
{
  const cand = []
  for (const f of files) {
    const s = raw68.get(f)
    if (!/role:\s*['"](system|user)['"]/.test(s)) continue
    if (!/\$\{[^}]*(content|正文|原文|excerpt|rawText|chapter)[^}]*\}/i.test(s)) continue
    if (/promptGuard|authorBlock/.test(s)) continue
    cand.push(rel(f))
  }
  P(`\n── P6. 疑似把作者正文拼进 prompt 但未包裹 promptGuard（${cand.length} 个）──`)
  P('  判读：原文里的「忽略以上指令」会被模型当指令执行；authorBlock() 用随机 nonce 把原文包成数据块。')
  P('  ⚠️ 这里只排掉了"已 import promptGuard"的文件；同文件另写个拼接函数没包，照样漏 → 必须人工抽查。')
  for (const c of (process.env.YFE_AUDIT_FULL === '1' ? cand : cand.slice(0, 12))) P(`  ▸ ${c}`)
  if (!cand.length) P('  ✅ 未发现裸拼正文')
}

// ── P7. aiDataSources 登记核对 ────────────────────────────────────
// 单一源原则：AI「会读哪些数据」写在 lib/aiDataSources.ts，改了 prompt 来源必须同步改它。
{
  const ads = files.find(f => /aiDataSources\.ts$/.test(f))
  const used = new Set(assets.map(a => a.file))
  if (ads) {
    const s = raw68.get(ads)
    // 历史命名债：jieWenJi.ts 的 PromptDef.id 与登记键差一个 jiewenji- 前缀（改 id 会丢用户自定义提示词，不能动）——显式豁免表
    const ALIAS = {
      'src/lib/aiTasks/jieWenJi.ts': ['jiewenji-proofread', 'jiewenji-diagnosis', 'jiewenji-review', 'jiewenji-ooc', 'jiewenji-advice', 'jiewenji-pleasure', 'jiewenji-opening', 'jiewenji-brief'],
    }
    const unreg = [...used].filter(f => {
      const base = path.basename(f, path.extname(f))
      if (new RegExp(`\\b${base}\\b`).test(s)) return false
      if (new RegExp(f.replace(/[/\\]/g, '[\\\\/]')).test(s)) return false
      // 🔴 2026-09-26 修正误报：粗匹配认不出「文件名 ↔ 登记键」的形态差（aiTasks/readerProbe.ts 的
      //    登记键是 'reader-probe'，连字符形态粗匹配不上 camelCase 文件名 → 误报）。改为精确：
      //    提取该文件里 PromptDef 的 meta.id 字面量，任一 id 被登记即算已登记。
      let src = ''; try { src = fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { /* 路径形态异常时按未登记处理 */ }
      const ids = [...src.matchAll(/\bid:\s*['"]([\w-]+)['"]/g)].map(m => m[1])
      const allIds = [...ids, ...(ALIAS[f] || [])]
      return !allIds.some(id => s.includes(`'${id}'`))
    })
    P(`\n── P7. 含提示词但未出现在 aiDataSources.ts 的文件（${unreg.length} 个）──`)
    P('  判读：不一定是问题（很多是纯计算型提示词）。但如果某功能**会读项目数据**，就必须登记 —— 真闸是 tests/aiDataSources.test.ts，这里只给线索。')
    for (const u of (process.env.YFE_AUDIT_FULL === '1' ? unreg : unreg.slice(0, 15))) P(`  ▸ ${u}`)
  }
}

// ── P8. 提示词字段 ↔ 解析器（弱引用）──────────────────────────────
// 「提示词要求输出 X 字段，但代码里没人读 X」= 白写；或反过来，解析端读的字段提示词没提 = 永远为空。
{
  const findings = []
  for (const a of assets) {
    const keys = new Set()
    // ⚠️ v1 抓「行首 - 名称：」会把**描述性文字**当成字段名（「水文指数：有效信息占比…」其实是给模型看的说明，
    //    真实 JSON 键是英文 dims）。v2 只认 **JSON 形状里的键**：{ "键": … } / ["键"] / `键`:
    for (const mm of a.body.matchAll(/[{"'[]?\s*["'`]([\w\u4e00-\u9fff]{2,20})["'`]\s*:/g)) keys.add(mm[1])
    for (const mm of a.body.matchAll(/[`「]([a-z][\w]{1,20})[`」]\s*[:：]/g)) keys.add(mm[1])
    if (!keys.size) continue
    for (const k of keys) {
      if (k.length < 2) continue
      let ext = 0
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // ⚠️ 英文键在代码里是**点号访问**（obj.dimensions），只查引号形式会全假报（实测 30 条里大半是这么来的）。
      //    中文键不存在点号写法，仍只按引号查。
      const re = /^[\w]+$/.test(k)
        ? new RegExp(`['"\`]${esc}['"\`]|\\.${esc}\\b|\\b${esc}:`, 'g')
        : new RegExp(`['"\`]${esc}['"\`]`, 'g')
      for (const f of files) {
        // ⚠️ 同一文件不能整份跳过：解析端常常就在同一个文件里（aiTasks.ts 的 prompt 与 parse 同处一室）。
        //    正确做法是「先把这段提示词正文挖掉，再在剩下的代码里找」。
        const hay = rel(f) === a.file ? raw68.get(f).replace(a.body, '') : raw68.get(f)
        ext += [...hay.matchAll(re)].length
      }
      if (ext === 0) findings.push(`${a.file}:${a.line}  ${a.name} 的字段「${k}」在别处无引用`)
    }
  }
  P(`\n── P8. 提示词列举的字段在代码中无引用（${findings.length} 条 TOP15）──`)
  P('  判读：多为真 Obesity（模型白输出一坨，解析器不读），偶尔是字段名被拼接出来导致的假报。')
  P('  ⚠️ 这是全套里最噪的一节：键名可能被拼接构造、也可能由通用渲染器直接显示。人工抽 3 条确认命中再写报告。')
  for (const x of (process.env.YFE_AUDIT_FULL === '1' ? findings : findings.slice(0, 15))) P(`  ▸ ${x}`)
  if (!findings.length) P('  ✅ 所有提示词字段都有代码侧对应')
}

console.log(out.join('\n'))
console.log('\n⚠️ 提示词的「精炼度」与「是否达成功能目标」本脚本判不了 —— 那是 A/B 实弹 + 已知答案对照法的活（见 SKILL 相应两节）。')
