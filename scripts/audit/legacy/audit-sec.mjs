// 安全 / 运行时资源 / 编码 扫描器（只读）—— 补六维审计之外的「非功能维度」
// 用法：node .workbuddy/tmp/audit-sec.mjs [工作区路径]
//
// 为什么单独一支：六维（代码/结构/内容/提示词/UI/功能）全是**静态源码视角**，
// 没有「安全」「资源管理」「编码兼容」这三类。它们恰好是「平时不出事、出事很难查」的那一类。
//
// ⚠️ 与其它扫描器同纪律：输出是**候选清单**不是违规清单，每条要抽 3~5 个回源码验尸。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = (process.argv[2] || 'G:/AI软件/youth-fantasy-engine开发源码').replace(/\\/g, '/')
const SRC = path.join(ROOT, 'src')
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (/(node_modules|\.git|dist|dist-web|release|\.workbuddy)$/.test(e.name)) continue
      walk(p, out)
    } else out.push(p)
  }
  return out
}
const read = f => fs.readFileSync(f, 'utf8')
const stripComments = s => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const srcFiles = walk(SRC).filter(f => /\.(ts|tsx)$/.test(f))
const electronFiles = fs.existsSync(path.join(ROOT, 'electron'))
  ? walk(path.join(ROOT, 'electron')).filter(f => /\.(cjs|js|ts)$/.test(f)) : []
const testFiles = fs.existsSync(path.join(ROOT, 'tests'))
  // 🔴 必须排除 `.` 开头的文件：那是 build-test.mjs 用 esbuild 打出的**整份源码副本**
  //    （tests/.xxx.test.mjs），内容含全部源码 ⇒ 拿它判「有没有测试」恒为「有」，静默失效
  ? fs.readdirSync(path.join(ROOT, 'tests'))
      .filter(f => /\.(test\.ts|mjs)$/.test(f) && !f.startsWith('.'))
      .map(f => path.join(ROOT, 'tests', f)) : []

const line = (f, s, i) => `${rel(f)}:${i + 1}`
const hits = (files, re, { strip = true } = {}) => {
  const out = []
  for (const f of files) {
    const rows = (strip ? stripComments(read(f)) : read(f)).split(/\r?\n/)
    rows.forEach((l, i) => { if (re.test(l)) out.push([line(f, '', i), l.trim().slice(0, 150)]) })
  }
  return out
}

const out = []
const sec = t => out.push('\n' + '─'.repeat(72) + '\n■ ' + t + '\n' + '─'.repeat(72))
const list = (items, empty = '（无）') => {
  if (!items.length) { out.push('  ' + empty); return }
  for (const it of items) out.push('  - ' + (Array.isArray(it) ? it[0] + '\n      ' + it[1] : it))
}

// ==================== S1 · Electron 安全配置 ====================
sec('S1 · Electron 窗口安全配置（webPreferences）')
{
  const rows = []
  for (const f of electronFiles) {
    const s = read(f)
    const re = /webPreferences\s*:\s*\{([^}]*)\}/g
    let m
    while ((m = re.exec(s))) {
      const body = m[1].replace(/\s+/g, ' ')
      const lineNo = s.slice(0, m.index).split('\n').length
      rows.push({
        at: `${rel(f)}:${lineNo}`, body,
        nodeInteg: /nodeIntegration\s*:\s*true/.test(body),
        ctxIso: /contextIsolation\s*:\s*false/.test(body),
        sandboxOff: /sandbox\s*:\s*false/.test(body),
      })
    }
  }
  list(rows.map(r => `${r.at}\n      ${r.body.slice(0, 110)}`), '（未找到 webPreferences —— 请人工确认）')
  const risky = rows.filter(r => r.nodeInteg || r.ctxIso)
  out.push('')
  out.push(risky.length
    ? `  ⚠️ 需人工确认（nodeIntegration=true 或 contextIsolation=false）：${risky.length} 处`
    : '  ✅ nodeIntegration / contextIsolation 未发现危险取值')
  const sbox = rows.filter(r => r.sandboxOff)
  out.push(sbox.length
    ? `  ⚠️ sandbox:false 共 ${sbox.length} 处 —— 逐个确认「该窗口是否真的必须」并写明理由`
    : '  ✅ 未发现 sandbox:false')
}

// ==================== S2 · 危险 API ====================
sec('S2 · 危险 / 逃逸类 API（src/ 内）')
{
  const pats = [
    [/\beval\s*\(/, 'eval()'],
    [/new\s+Function\s*\(/, 'new Function()'],
    [/document\.write\s*\(/, 'document.write()'],
    [/child_process/, 'child_process'],
    [/shell\.openExternal\s*\(/, 'shell.openExternal()'],
    [/require\s*\(\s*['"](?:fs|path|child_process)['"]\s*\)/, '运行时 require 原生模块'],
    // 🔴 必须排除正则的 `.exec()` —— 项目里满屏 `re.exec(text)`，写成裸 `\bexec\(` 会假报 14 条
    [/(?<![.\w])exec\s*\(/, 'exec()（非正则 .exec）'],
  ]
  const found = []
  for (const [re, name] of pats) for (const h of hits(srcFiles, re)) found.push([`[${name}] ` + h[0], h[1]])
  list(found)
}

// ==================== S3 · HTML 注入面 ====================
sec('S3 · HTML 注入面（dangerouslySetInnerHTML / 裸 innerHTML）')
{
  const found = []
  for (const h of hits(srcFiles, /dangerouslySetInnerHTML|\.innerHTML\s*=/)) found.push(h)
  list(found, '（无）')
  if (found.length) out.push('  → 逐个确认：写入前是否经 escapeHtml / 是否全为自造内容（历史两处均已判为合法）')
}

// ==================== S4 · 敏感信息边界 ====================
sec('S4 · 敏感信息边界（密钥/令牌不得出界）')
{
  // ① 敏感 meta 清单（**真源**）必须存在且含 aiProviders，且云同步排除表基于它
  //
  // 🔴 2026-10-13 修正判据（原判据已失效，会报**假警报**）：
  //    清单真源已下沉到叶子模块 `lib/storage/sensitiveMeta.ts` —— 因为数据文件导出 /
  //    项目包导出 / 云同步三处要共用同一份判据，留在 syncCore 会让另两处反向依赖 sync 层
  //    而成 import 环。原判据写死 `EXCLUDED_META_KEYS = new Set<string>([...])` 的**字面形式**，
  //    下沉后正则匹配不到 ⇒ 报「未找到 EXCLUDED_META_KEYS —— 密钥可能随云同步出界」，
  //    而实际防护完好。改为：认真源清单 + 认「syncCore 引用了真源」这条引用关系。
  const sensitive = path.join(SRC, 'lib/storage/sensitiveMeta.ts')
  const syncCore = path.join(SRC, 'lib/sync/syncCore.ts')
  if (!fs.existsSync(sensitive)) {
    out.push('  ⚠️ 未找到 src/lib/storage/sensitiveMeta.ts —— 敏感 meta 清单真源缺失')
  } else {
    const keys = (stripComments(read(sensitive)).match(/SENSITIVE_META_KEYS[^=]*=\s*\[([\s\S]*?)\]/) || [])[1] || ''
    const flat = keys.replace(/\s+/g, ' ').trim()
    out.push(flat
      ? `  ✅ 敏感 meta 清单存在（真源 sensitiveMeta.ts）：${flat.slice(0, 120)}`
      : '  ⚠️ sensitiveMeta.ts 里没找到 SENSITIVE_META_KEYS 的数组字面量')
    if (!/aiProviders/.test(flat)) out.push('  ⚠️ 清单里没有 aiProviders —— AI 密钥可能出界')
  }
  if (!fs.existsSync(syncCore)) {
    out.push('  ⚠️ 未找到 src/lib/sync/syncCore.ts')
  } else if (!/sensitiveMeta/.test(stripComments(read(syncCore)))) {
    out.push('  ⚠️ syncCore 未引用 sensitiveMeta —— 云同步可能不再排除密钥')
  } else {
    out.push('  ✅ 云同步排除表（EXCLUDED_META_KEYS）基于同一份清单')
  }
  // ①b 三条**导出出口**都必须过滤（2026-10-13 社区反馈：导出数据文件把 apiKey 一起带走）
  const exporters = [
    ['lib/app/desktop.ts', 'stripSensitiveMeta', '桌面版「导出数据文件」'],
    ['lib/storage/fileBackend.ts', 'stripSensitiveMeta', '便携版「导出数据文件」'],
    ['lib/db/projects.ts', 'isSensitiveSettingKey', '项目包导出（备份 / 迁移包）'],
  ]
  const miss = []
  for (const [relPath, marker, label] of exporters) {
    const p = path.join(SRC, relPath)
    if (!fs.existsSync(p) || !new RegExp(marker).test(stripComments(read(p)))) miss.push(label)
  }
  out.push(miss.length === 0
    ? '  ✅ 三条导出出口都做了敏感键过滤（数据文件 ×2 + 项目包）'
    : `  ⚠️ 未过滤敏感键的导出出口：${miss.join('、')}`)
  // ② 源码里不得把密钥写进日志/文件名/导出文本
  const risky = []
  for (const f of srcFiles) {
    const rows = stripComments(read(f)).split(/\r?\n/)
    rows.forEach((l, i) => {
      if (/(apiKey|api_key|token|password|secret)/i.test(l) &&
          /console\.(log|info|warn|error)|JSON\.stringify\(\s*[a-z]*[Pp]rovider|downloadBlob\(|\.txt['"`]/.test(l)) {
        risky.push([`${rel(f)}:${i + 1}`, l.trim().slice(0, 140)])
      }
    })
  }
  list(risky, '  ✅ 未发现「密钥类变量进日志/导出」的可疑写法')
  // ③ 导出/备份路径是否经过排除
  const expFiles = srcFiles.filter(f => /(exporter|tableIO|backup|exportDoc)\.ts$/.test(f))
  out.push(`  · 导出/备份相关文件 ${expFiles.length} 个：${expFiles.map(rel).join(' / ') || '（无）'}`)
}

// ==================== S5 · 运行时资源（effect 清理配对） ====================
sec('S5 · React effect 内的监听器 / 定时器是否都有清理')
{
  const bad = []
  for (const f of srcFiles.filter(f => /\.(tsx|ts)$/.test(f))) {
    const lines = read(f).split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (!/useEffect\(|useLayoutEffect\(/.test(lines[i])) continue
      let depth = 0; const body = []
      for (let j = i; j < Math.min(i + 90, lines.length); j++) {
        const l = lines[j]
        depth += (l.match(/\(/g) || []).length - (l.match(/\)/g) || []).length
        if (j > i) body.push(l)
        if (depth <= 0 && j > i) break
      }
      const b = body.join('\n')
      if (!/addEventListener\(|setInterval\(/.test(b)) continue
      const cleaned = /return\s*\(\s*\)\s*=>|return\s+function|AbortController|\.abort\(\)/.test(b)
      if (!cleaned) bad.push([`${rel(f)}:${i + 1}`, 'effect 内注册监听/定时器，未见 return 清理或 AbortController'])
    }
  }
  list(bad, '  ✅ 全部有清理（或无 effect 内注册）')
}

// ==================== S6 · 编码兼容（导出 BOM） ====================
sec('S6 · 导出文本的编码兼容（Excel / 记事本乱码）')
{
  const exp = srcFiles.filter(f => /(exporter|tableIO|downloadLinks)\.ts$/.test(f))
  const rows = exp.map(f => {
    const s = read(f)
    return `${rel(f)}  BOM=${/\\uFEFF|\uFEFF/.test(s) ? '有' : '无'}`
  })
  list(rows)
  out.push('  → CSV / TXT 导出若带中文且面向 Excel，需要 UTF-8 BOM；纯 JSON 导出不需要')
}

// ==================== S7 · 加密模块的消费者与覆盖 ====================
sec('S7 · 加密 / 安全关键模块：谁在用、有没有测试')
{
  const cryptoFile = path.join(SRC, 'lib/storage/crypto.ts')
  if (!fs.existsSync(cryptoFile)) out.push('  （未找到 lib/storage/crypto.ts）')
  else {
    const names = [...read(cryptoFile).matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(m => m[1])
    const allText = [...srcFiles, ...testFiles].map(f => read(f)).join('\n')
    out.push(`  符号：${names.join(', ')}`)
    const consumers = []
    for (const f of walk(SRC)) {
      const s = read(f)
      if (rel(f) === 'src/lib/storage/crypto.ts') continue
      const hit = names.filter(n => new RegExp('\\b' + n + '\\b').test(s))
      if (hit.length) consumers.push(`${rel(f)}（${hit.join('/')}）`)
    }
    out.push(`  消费者：${consumers.join(' ｜ ') || '⚠️ 无 —— 该模块是死代码或能力缺口'}`)
    const tested = testFiles.filter(f => /crypto/.test(read(f)))
    out.push(`  测试覆盖：${tested.map(rel).join(', ') || '⚠️ 无测试（安全关键模块零覆盖）'}`)
  }
}

console.log(out.join('\n'))
