#!/usr/bin/env node
/**
 * 发版检查（不修改源码和发布产物；临时 schema 探针写入 .workbuddy/tmp）· 3.2.1 T-07
 *
 * 定位：把发版前「靠人肉核对」的那几项变成可复核的机器输出。
 * 🔴 三条纪律：
 *   ① 不删改源码、dist / release；只在 tmp 生成用于精确统计页签的临时探针；
 *   ② **不把外链不可访问判为构建失败** —— 离线、墙、临时故障都会误报，联网检查只在 `--net` 下跑且只记 INFO；
 *   ③ **不伪造绿灯**：取不到值就写 INFO「未取到」，FAIL 必须是明确的不一致或越界。
 *
 * 用法：
 *   node scripts/release-check.mjs           # 常规（不联网）
 *   node scripts/release-check.mjs --net     # 附带外链可达性探测（只记 INFO）
 *   node scripts/release-check.mjs --json    # 机器可读输出
 *   node scripts/release-check.mjs --source-only --dist <目录> # 封装前源码准备检查；不代表正式产物就绪
 *
 * 退出码：存在 FAIL ⇒ 1；否则 0。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { runProcess } from './verify/process.mjs'
import { fileURLToPath } from 'node:url'
import artifactChecks from './release-artifacts.cjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NET = process.argv.includes('--net')
const JSON_OUT = process.argv.includes('--json')
const SOURCE_ONLY = process.argv.includes('--source-only')
const distIndex = process.argv.indexOf('--dist')
if (distIndex >= 0 && (!process.argv[distIndex + 1] || process.argv[distIndex + 1].startsWith('--'))) {
  console.error('--dist 需要提供构建目录'); process.exit(2)
}

/** 阈值（都可复核：改这里要写理由） */
const LIMIT = {
  mainBundleKB: 700,      // Vite 提示线（已知限制，非阻断 ⇒ 只 WARN）
}

const rows = []
const add = (level, item, detail) => rows.push({ level, item, detail })
const KiB = (n) => (n / 1024).toFixed(2) + ' kB'
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const exists = (p) => { try { fs.accessSync(p); return true } catch { return false } }

async function run(cmd, args, timeout = 15000) {
  const result = await runProcess(cmd, args, { cwd: ROOT, timeoutMs: timeout })
  if (!result.ok) add('FAIL', '检查子进程未成功', `${path.basename(cmd)}: exit=${result.exitCode} signal=${result.signal ?? '-'} timeout=${result.timedOut} ${result.error ?? ''}`)
  return result
}

// ==================== 1. 版本一致性 ====================
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')) || '{}')
const version = pkg.version || null
add(version ? 'OK' : 'FAIL', '版本 · package.json', version ?? '未取到')
for (const row of artifactChecks.checkLockVersion(version, JSON.parse(read(path.join(ROOT, 'package-lock.json')) || '{}'))) rows.push(row)

const relDir = path.join(ROOT, 'release')
const artifacts = artifactChecks.checkArtifacts(relDir, version, { sourceOnly: SOURCE_ONLY })
rows.push(...artifacts.rows)
if (SOURCE_ONLY) add('INFO', '检查阶段', '仅检查源码准备；未验收正式安装包/便携包，不能据此宣布可发布')

// ==================== 2. 页签与板块（README 声明 vs 源码真源） ====================
//
// 🔴 为什么不用正则数：三段 part 文件的缩进层级不一致（part1 顶层 2 空格、part3 在嵌套数组里 4 空格、
//    机构四页签是行首 `...INSTITUTION_TABS.map()` 展开），正则数出来必然漂。
//    ⇒ 用 esbuild 把 `src/lib/schema.ts` 打成 CJS 后**真跑一遍**取 `TABS.length`，这才是权威值；
//      打包不可用时才回退正则，并明确标注「非精确」。
const readme = read(path.join(ROOT, 'README.md')) || ''
const mTab = readme.match(/(\d+)\s*个板块，(\d+)\s*个页签/)
const declaredTabs = mTab ? Number(mTab[2]) : null
const declaredGroups = mTab ? Number(mTab[1]) : null

let tabTotal = null
let groupTotal = null
let tabsExact = false
try {
  const esbuild = await import('esbuild')
  const probe = path.join(ROOT, '.workbuddy/tmp/release-tabs-probe.cjs')
  fs.mkdirSync(path.dirname(probe), { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/lib/schema.ts')],
    bundle: true, write: true, format: 'cjs', platform: 'node',
    alias: { '@': path.join(ROOT, 'src') },
    outfile: probe, logLevel: 'error',
  })
  // 口径：README 的功能总览把「正文编辑」也计入页签 ⇒ 总数取 TABS + EDITOR_TAB
  const r = await run(process.execPath, ['-e', `const m=require(${JSON.stringify(probe)});const t=m.TABS||[];const g=new Set(t.map(x=>x.group));let n=t.length;if(m.EDITOR_TAB){g.add(m.EDITOR_TAB.group);n++}process.stdout.write('\\n@@JSON@@'+JSON.stringify({n,g:g.size}))`], 30000)
  const m = r.out.match(/@@JSON@@(\{.*?\})\s*$/)
  if (r.ok && m) { const o = JSON.parse(m[1]); tabTotal = o.n; groupTotal = o.g; tabsExact = true }
} catch (e) {
  add('INFO', '页签 · 精确统计', `esbuild 实跑不可用：${String(e).slice(0, 120)}`)
}
if (tabTotal === null) {
  // 回退：正则粗数（不精确，明确标注）
  const tabsDir = path.join(ROOT, 'src/lib/schemaTabs')
  let n = 0
  if (exists(tabsDir)) for (const f of fs.readdirSync(tabsDir).filter((x) => /^part\d+\.ts$/.test(x))) {
    const src = read(path.join(tabsDir, f)) || ''
    n += (src.match(/^ {2}id:/gm) || []).length + (src.match(/^ {4}id:/gm) || []).length + 4 * (src.match(/^\.\.\.INSTITUTION_TABS\.map/gm) || []).length
  }
  tabTotal = n
  add('INFO', '页签 · 源码统计', `${n}（正则回退，**非精确值**，勿据此判 FAIL）`)
} else {
  add('OK', '页签 · 源码统计', `${tabTotal}（esbuild 实跑 TABS.length，含展开项）`)
}
if (declaredTabs === null) add('INFO', '页签 · README 声明', '未匹配到「N 个板块，M 个页签」句式')
else if (!tabsExact) add('INFO', '页签 · README 声明', `README ${declaredTabs} vs 源码 ${tabTotal}（源值为非精确值，不判 FAIL）`)
else add(declaredTabs === tabTotal ? 'OK' : 'FAIL', '页签 · README 声明', `README ${declaredTabs} vs 源码 ${tabTotal}`)
if (groupTotal !== null && declaredGroups !== null) {
  add(declaredGroups === groupTotal ? 'OK' : 'WARN', '板块 · 数量比对', `README ${declaredGroups} vs 源码 ${groupTotal}（含正文写作）`)
}

// ==================== 3. 产物体积 ====================
const distDir = distIndex >= 0 ? path.resolve(ROOT, process.argv[distIndex + 1]) : path.join(ROOT, 'dist')
add('INFO', '构建目录', path.relative(ROOT, distDir))
if (!exists(distDir)) add('FAIL', '构建产物 · dist', '构建目录不存在，须先生成前端生产构建')
else {
  const indexHtml = path.join(distDir, 'index.html')
  add(exists(indexHtml) && fs.statSync(indexHtml).size > 0 ? 'OK' : 'FAIL', '构建产物 · 入口', 'index.html 必须存在且非空')
  const assets = path.join(distDir, 'assets')
  const js = exists(assets) ? fs.readdirSync(assets).filter((f) => /^index-.*\.js$/.test(f)) : []
  if (js.length === 0) add('FAIL', '构建产物 · 主包', 'dist/assets 下未找到 index-*.js')
  else {
    const p = path.join(assets, js[0])
    const buf = fs.readFileSync(p)
    const gz = zlib.gzipSync(buf).length
    add(buf.length / 1024 > LIMIT.mainBundleKB ? 'WARN' : 'OK', '构建产物 · 主包', `${js[0]}：${KiB(buf.length)}（gzip ${KiB(gz)}，提示线 ${LIMIT.mainBundleKB} kB，已知限制非阻断）`)
  }
  const bid = fs.readdirSync(distDir).filter((f) => /BUILD/i.test(f))
  add(bid.length ? 'OK' : 'INFO', '构建产物 · BUILD_ID', bid.length ? bid.join(', ') : 'dist 下无 BUILD_ID 文件（部署时由 deploy.sh 写入包内）')
}

// ==================== 4. 文档引用（随仓必需工具，新克隆不得静默跳过） ====================
const docRefTool = path.join(ROOT, 'scripts/verify/check-doc-refs.cjs')
if (!exists(docRefTool)) add('FAIL', '文档引用 · check-doc-refs', '仓库内必需工具不存在')
else {
  const r = await run(process.execPath, [docRefTool, '--inuse'], 60000)
  const head = (r.out.match(/可判定引用\s*(\d+)\s*处/) || [])[1]
  const bad = Number((r.out.match(/（真失效）：\s*(\d+)\s*处/) || [])[1] ?? NaN)
  // 解析「真失效」分块的逐条明细，再按已知误报规则筛一遍 ⇒ 门禁才不会每次都红
  const IGNORE = [
    [/:\d+$/, '行号后缀（工具未剥离，文件其实在）'],
    [/X\.Y\.Z/, '版本号占位示例'],
    [/^\.workbuddy\/(tmp|eval-samples)\//, '本机临时 / 待主人提供，不入库'],
    [/\bxxx\b/, '示例占位路径'],
    [/^release\//, '历史版本产物（不是当前源码树的一部分）'],
  ]
  const items = []
  let inBad = false
  let cur = null
  for (const ln of r.out.split('\n')) {
    if (/^=====/.test(ln)) { inBad = /（真失效）/.test(ln); cur = null; continue }
    if (!inBad) continue
    const mh = ln.match(/^\[\d+\]\s+(\S+)\s*$/)
    if (mh) { cur = mh[1]; continue }
    const mi = ln.match(/^\s{2,}(\S+)\s*$/)
    if (mi && cur) items.push({ doc: cur, ref: mi[1] })
  }
  const isIgnored = (it) => {
    if (IGNORE.some(([re]) => re.test(it.ref))) return true
    // 长期记忆记的是**当时**的路径（G3 重构后大量旧路径已搬走），不按现行源码判错
    if (/^\.workbuddy\/memory\//.test(it.doc)) return true
    // 工具按中文/标点截断，把完整文件名截成前缀 ⇒ 同目录有同名前缀即视为可定位
    if (/^docs\//.test(it.ref)) {
      const dir = path.join(ROOT, path.dirname(it.ref))
      const base = path.basename(it.ref)
      return exists(dir) && fs.readdirSync(dir).some((f) => f.startsWith(base))
    }
    return false
  }
  const real = items.filter((it) => !isIgnored(it))
  if (!r.ok || Number.isNaN(bad)) add('FAIL', '文档引用 · check-doc-refs --inuse', `工具执行或汇总解析失败（exit=${r.exitCode}）：${r.out.slice(0, 120)}`)
  else if (real.length === 0) add('OK', '文档引用 · check-doc-refs --inuse', `工具报 ${bad} 处，按已知误报规则（行号后缀 / 占位 / 临时与历史产物）剔净 ⇒ 剩 0 处待处理（共 ${head ?? '?'} 处引用）`)
  else add('WARN', '文档引用 · check-doc-refs --inuse', `${real.length} 处待人工判断（工具报 ${bad}，已剔 ${bad - real.length} 处已知误报）：${real.slice(0, 8).map((x) => `${x.doc} → ${x.ref}`).join('；')}`)
}

// ==================== 5. 外链（默认只列不探；--net 才探测且只记 INFO） ====================
const mdFiles = [path.join(ROOT, 'README.md')]
const docsRoot = path.join(ROOT, 'docs')
if (exists(docsRoot)) for (const f of fs.readdirSync(docsRoot)) if (f.endsWith('.md')) mdFiles.push(path.join(docsRoot, f))
const links = new Set()
for (const f of mdFiles) {
  const src = read(f) || ''
  for (const m of src.matchAll(/https?:\/\/[^\s)）\]"'`<，。；]+/g)) {
    const u = m[0].replace(/[.,;]$/, '')
    if (!/localhost|127\.0\.0\.1/.test(u)) links.add(u)
  }
}
add('INFO', '外链 · 数量', `${links.size} 条（docs 根在用文档 + README）`)
if (NET) {
  const list = [...links]
  const dead = []
  for (const u of list) {
    const code = `fetch(${JSON.stringify(u)},{method:'HEAD'}).then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('ERR'))`
    const r = await run(process.execPath, ['-e', code], 15000)
    if (!/^(200|301|302|403|405)$/.test(r.out.trim())) dead.push(`${u} → ${r.out.trim() || 'timeout'}`)
  }
  add(dead.length ? 'INFO' : 'OK', '外链 · 可达性（--net）', dead.length ? `${dead.length} 条未返回 2xx/403/405（离线或被墙会误报，不计失败）：\n    ${dead.join('\n    ')}` : `${list.length} 条均可达`)
}

// ==================== 6. git 状态 ====================
const st = await run('git', ['status', '--short'])
const br = await run('git', ['branch', '--show-current'])
const head = await run('git', ['log', '-1', '--oneline'])
add('INFO', 'git · 分支 / HEAD', `${br.out.trim()} / ${head.out.trim()}`)
add(st.out.trim() ? 'WARN' : 'OK', 'git · 工作区', st.out.trim() ? `有未提交改动（${st.out.trim().split('\n').length} 项）` : '干净')

// ==================== 汇总 ====================
const count = (lv) => rows.filter((r) => r.level === lv).length
const fail = count('FAIL')
const warn = count('WARN')
const verdict = fail ? 'FAIL' : warn ? 'PASS_WITH_WARNINGS' : 'PASS'

if (JSON_OUT) {
  console.log(JSON.stringify({ stage: SOURCE_ONLY ? 'source' : 'artifacts', artifactsReady: artifacts.ready, version, tabTotal, verdict, fail, warn, rows }, null, 2))
} else {
  console.log(`=== ${SOURCE_ONLY ? '源码准备检查（正式产物另验）' : '发版产物检查'} ===`)
  for (const r of rows) console.log(`[${r.level.padEnd(4)}] ${r.item} :: ${r.detail}`)
  console.log(`\nFAIL ${fail} ／ WARN ${warn} ／ OK ${count('OK')} ／ INFO ${count('INFO')}`)
  console.log(`${SOURCE_ONLY ? 'SOURCE_CHECK' : 'RELEASE_CHECK'}: ${verdict}`)
}
process.exit(fail ? 1 : 0)
