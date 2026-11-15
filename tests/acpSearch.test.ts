// ============ 3.5.6 · ACP 模式下的受控检索通路 ============
//
// 覆盖：不申请 API 租约的引擎检索（同一套构造 / 取消 / 上限 / 错误文案）、
// 市场雷达在零 API 配置下用「引擎检索 + Agent 归纳」，起草与补全改走直连检索。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  webSearch, webSearchWithoutLease, type SearchSettings, type SearchRequest, type TransportResult,
} from '../src/lib/ai/webSearch'
import { runMarketRadar } from '../src/lib/ai/marketRadar'

let pass = 0
let fail = 0
const ok = (name: string, condition: boolean, extra = '') => {
  if (condition) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra ? ':: ' + extra : '') }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const base = (over: Partial<SearchSettings> = {}): SearchSettings => ({
  mode: 'api', engine: 'bocha', endpoint: '', apiKey: 'test-key', topK: 5, ...over,
})

const body = JSON.stringify({
  results: [
    { title: '2026 仙侠选题观察', url: 'https://example.com/a', content: '短剧化趋势明显。' },
    { title: '平台榜单变化', url: 'https://example.com/b', content: '新书榜偏向快节奏开篇。' },
  ],
})

function stub(result: TransportResult | (() => Promise<TransportResult>)) {
  const calls: { req: SearchRequest; signal?: AbortSignal }[] = []
  const transport = async (req: SearchRequest, signal?: AbortSignal): Promise<TransportResult> => {
    calls.push({ req, signal })
    return typeof result === 'function' ? result() : result
  }
  return { calls, transport }
}

// ---------- 直连检索与租约版行为一致 ----------
const s1 = stub({ ok: true, status: 200, text: body })
const direct = await webSearchWithoutLease('仙侠 选题', base(), undefined, { transport: s1.transport })
ok('直连通路能取回结果', direct.used === true && direct.results.length === 2)
ok('检索词原样带上（POST 走 JSON 体，中文不丢）', direct.query === '仙侠 选题' && String(s1.calls[0].req.body ?? '').includes('仙侠 选题'))

const s2 = stub({ ok: true, status: 200, text: body })
const leased = await webSearch('仙侠 选题', base(), undefined, { transport: s2.transport })
ok('租约版与直连版结果同形', leased.used === true && leased.results.length === direct.results.length)

const off = await webSearchWithoutLease('仙侠', base({ mode: 'off' }), undefined, { transport: stub({ ok: true, status: 200, text: body }).transport })
ok('开关未开到「搜索接口」时仍然拒绝（默认关闭铁律不变）', off.used === false && /不是「搜索接口」/.test(off.error ?? ''))

const ac = new AbortController()
ac.abort()
const aborted = await webSearchWithoutLease('仙侠', base(), ac.signal, { transport: stub({ ok: true, status: 200, text: body }).transport })
ok('取消如实上报', aborted.used === false && aborted.error === '检索已取消')

const failing = await webSearchWithoutLease('仙侠', base(), undefined, { transport: stub({ ok: false, error: '连接被拒' }).transport })
ok('失败带原因、不静默', failing.used === false && /连接被拒/.test(failing.error ?? ''))

const empty = await webSearchWithoutLease('仙侠', base(), undefined, { transport: stub({ ok: true, status: 200, text: '{"nothing":1}' }).transport })
ok('接口无可用结果时明确说明', empty.used === false && /没有返回可识别的结果/.test(empty.error ?? ''))

// ---------- 市场雷达：引擎检索 + Agent 归纳 ----------
const prompts: string[] = []
const radar = await runMarketRadar(
  { genre: '仙侠', platform: '番茄', tags: ['快节奏'], keywords: ['系统流'] },
  {
    settings: base(),
    transport: stub({ ok: true, status: 200, text: body }).transport,
    acpText: async prompt => {
      prompts.push(prompt)
      return JSON.stringify({ trend: '短剧化', platformFit: '免费平台更合适', opportunities: ['开篇三章给冲突'], risks: ['同质化'] })
    },
  },
)
ok('市场雷达在只有 ACP 时也能跑成', radar.ok === true && !!radar.report)
ok('报告带来源（标题+网址）', (radar.report?.sources.length ?? 0) === 2 && !!radar.report?.sources[0].url)
ok('口径红线：报告恒带声明', !!radar.report?.disclaimer)
ok('归纳提示词带检索资料', prompts[0].includes('短剧化趋势明显') && /【输出格式】/.test(prompts[0]))

const noSources = await runMarketRadar(
  { genre: '仙侠', platform: '', tags: [], keywords: [] },
  { settings: base(), transport: stub({ ok: false, error: '断网' }).transport, acpText: async () => '{}' },
)
ok('一条都没查成时如实失败（不编造趋势）', noSources.ok === false && /断网|没查到/.test(noSources.error ?? ''))

// ---------- 接线（静态契约） ----------
const webSrc = read('src/lib/ai/webSearch.ts')
ok('API 模式仍走模式租约', /return runSearch\(query, settings, signal, deps, true\)/.test(webSrc))
ok('直连通路显式不申请租约', /return runSearch\(query, settings, signal, deps, false\)/.test(webSrc))
ok('两条通路共用同一构造函数与传输层', (webSrc.match(/buildSearchRequest\(settings, q, settings\.topK\)/g) ?? []).length === 1)

const radarSrc = read('src/lib/ai/marketRadar.ts')
ok('雷达在 ACP 下改走直连检索', /opts\.acpText \? webSearchWithoutLease : webSearch/.test(radarSrc))

const dialog = read('src/components/dialogs/MarketRadarDialog.tsx')
ok('雷达弹窗注入闸门与任务标识 market-radar', dialog.includes('acpGatedText') && dialog.includes("task: 'market-radar'"))
ok('雷达弹窗按写作就绪判断', /writingReady\s*=\s*aiReady \|\| !!acpWriting\?\.ready/.test(dialog))
ok('闸门文案写明检索词与公开结果', /检索词「/.test(dialog) && /公开结果/.test(dialog))

ok('模板补全在 ACP 下用直连检索', read('src/components/ai/AITemplateFill.tsx').includes('searchFn: webSearchWithoutLease'))
ok('角色卡起草在 ACP 下用直连检索', read('src/components/tavern/TavernCardDraftDialog.tsx').includes('searchFn: webSearchWithoutLease'))

const bridge = read('src/lib/agentHost/acpBridge.ts')
const main = read('electron/main.cjs')
ok('任务标识登记与放行：market-radar', bridge.includes("'market-radar'") && main.includes("'market-radar'"))

console.log(`\n—— acpSearch 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
