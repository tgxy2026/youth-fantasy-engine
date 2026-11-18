// ============ 审计新硬线：尺寸缓存订阅 / 重复实现（2026-11-19）============
//
// 起因：两次"专项才发现的细节"——① 颉文姬面板把 zoom 缓存进 state 却不订阅变更，
// 改了界面缩放后仍按旧视口摆位；② stableHash 在两个模块各一份、逐字节相同，
// 台账里又存过这个值。这两类问题原来的 11 支扫描器都抓不到，所以沉淀成规则。
//
// 这里钉四件事：
//   ① 规则能抓到**历史缺陷的真实形态**（不是"理论上能抓"）；
//   ② 规则不会误伤**正确写法**（渲染期现读、effect 里读、有订阅的缓存）；
//   ③ 重复实现的判据是"逐字符相同 + 足够长"，不同实现/一句话小工具都不报；
//   ④ 豁免名单（PROVIDERS）登记的文件必须存在（否则名单变谎言）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PROVIDERS, scanStaleCache, scanStaleCacheSource, validateProviders } from '../scripts/audit/stale-cache.mjs'
import { MIN_BODY_CHARS, extractExportedFunctions, findDuplicateImpls, normalizeBody, scanDuplicateImpls } from '../scripts/audit/duplicate-impl.mjs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8')

/** 造一个"够长"的函数体（重复实现的长度门槛是 120 字符） */
const LONG_BODY = '{ const a = [1, 2, 3].map(n => n * 2); const b = a.filter(n => n > 2).join(","); const c = b.repeat(2); const d = c.split(",").length; return c + ":" + String(a.length) + "/" + String(d) }'

function main() {
  // ---------- ① 尺寸缓存订阅 ----------
  {
    // 真实形态：3.6.1 修复前的面板（useState 存 zoom，没有任何订阅）
    const bug = `export function usePanel() {
  const [zoom, setZoom] = useState(currentUiZoom)
  const [viewport, setViewport] = useState(viewportOf)
  return { zoom, viewport }
}`
    ok('🔴 抓到历史缺陷形态：缓存 zoom 但不订阅', scanStaleCacheSource('(fixture)/x.tsx', bug).length === 1)
    ok('命中带可定位的行号与规则名', (() => {
      const hit = scanStaleCacheSource('(fixture)/x.tsx', bug)[0]
      return hit?.rule === 'stale.cache' && hit.line === 2
    })(), JSON.stringify(scanStaleCacheSource('(fixture)/x.tsx', bug)))

    const withZoomEvent = bug.replace('  return { zoom, viewport }',
      "  useEffect(() => { window.addEventListener('yfe:zoom-changed', () => setZoom(currentUiZoom())) }, [])\n  return { zoom, viewport }")
    ok('有 yfe:zoom-changed 订阅 ⇒ 不报', scanStaleCacheSource('(fixture)/x.tsx', withZoomEvent).length === 0)

    const withResize = bug.replace('  return { zoom, viewport }',
      "  useEffect(() => { window.addEventListener('resize', () => setViewport(viewportOf())) }, [])\n  return { zoom, viewport }")
    ok('有 resize 订阅 ⇒ 不报', scanStaleCacheSource('(fixture)/x.tsx', withResize).length === 0)

    const withSharedSubscribe = bug.replace('  return { zoom, viewport }',
      '  useEffect(() => subscribeResize(() => setViewport(viewportOf())), [])\n  return { zoom, viewport }')
    ok('走共享 subscribeResize ⇒ 不报', scanStaleCacheSource('(fixture)/x.tsx', withSharedSubscribe).length === 0)

    ok('useState(() => window.innerWidth) 同样受管',
      scanStaleCacheSource('(fixture)/y.tsx', 'const [w] = useState(() => window.innerWidth)').length === 1)
    ok('🔴 渲染期现读不算缺陷（这是正确写法）',
      scanStaleCacheSource('(fixture)/z.tsx', 'const z = currentUiZoom()\nconst style = { width: foldPx(360, z) }').length === 0)
    ok('事件处理里读也不算缺陷',
      scanStaleCacheSource('(fixture)/z2.tsx', 'const onDown = () => { const z = currentUiZoom(); return z }').length === 0)
    ok('提供者文件豁免（theme.ts 是 zoom 的实现处）',
      scanStaleCacheSource('src/lib/settings/theme.ts', 'const [z] = useState(currentUiZoom)').length === 0)
    ok('注释里的写法不算（剥注释后判）',
      scanStaleCacheSource('(fixture)/w.tsx', '// const [z] = useState(currentUiZoom)\nconst x = 1').length === 0)
    ok('豁免名单里的文件确实存在', validateProviders(process.cwd()).ok, JSON.stringify(PROVIDERS))
  }

  // ---------- ② 重复实现 ----------
  {
    const same = `export function stableHash(text: string) ${LONG_BODY}`
    const dup = findDuplicateImpls([{ file: '(fixture)/a.ts', text: same }, { file: '(fixture)/b.ts', text: same }])
    ok('🔴 抓到历史缺陷形态：两份逐字节相同的实现', dup.length === 1, JSON.stringify(dup))
    ok('命中信息点名两个文件', dup[0]?.message.includes('(fixture)/b.ts'), dup[0]?.message)

    const different = `export function stableHash(text: string) ${LONG_BODY.replace('n * 2', 'n * 3')}`
    ok('实现不同（改了一个字）⇒ 不报',
      findDuplicateImpls([{ file: '(fixture)/a.ts', text: same }, { file: '(fixture)/b.ts', text: different }]).length === 0)

    ok('同一文件里的两份不算（跨文件才报）',
      findDuplicateImpls([{ file: '(fixture)/a.ts', text: same }]).length === 0)

    const trivial = 'export function emptyOf() { return "" }'
    ok('一句话小工具相同不算缺陷（滤掉巧合交集）',
      findDuplicateImpls([{ file: '(fixture)/a.ts', text: trivial }, { file: '(fixture)/b.ts', text: trivial }]).length === 0)

    ok('长度门槛是 120 字符（与实现常量一致）', MIN_BODY_CHARS === 120)
    ok('归一化会忽略排版差异',
      normalizeBody('{ const a = 1;\n  return a }') === normalizeBody('{const a=1;return a}'))

    // 括号/字符串配平：函数体里有对象字面量与带花括号的字符串模板
    const tricky = 'export function build() { const obj = { a: { b: 1 } }; const s = "}"; return obj.a.b + s.length }'
    const fns = extractExportedFunctions(tricky)
    ok('函数体能正确配平（对象字面量 + 字符串里的花括号）', fns.length === 1 && fns[0].body.endsWith('}'), JSON.stringify(fns[0]?.body?.slice(-20)))
  }

  // ---------- ③ 仓库现状：两条规则都应为 0 ----------
  {
    ok('当前仓库真的 0 处「尺寸缓存未订阅」', scanStaleCache(process.cwd()).findings.length === 0,
      JSON.stringify(scanStaleCache(process.cwd()).findings))
    ok('当前仓库真的 0 处「同名同体重复实现」', scanDuplicateImpls(process.cwd()).findings.length === 0,
      JSON.stringify(scanDuplicateImpls(process.cwd()).findings))
    const self = read('scripts/audit/self-check.mjs')
    ok('自检已接两条规则', self.includes('scanStaleCache(root)') && self.includes('scanDuplicateImpls(root)'))
    const runner = read('scripts/audit/run.mjs')
    ok('报告里能看见两条规则的结果', runner.includes('report.static.staleCache') && runner.includes('report.static.duplicateImpls'))
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} auditRules ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main()
