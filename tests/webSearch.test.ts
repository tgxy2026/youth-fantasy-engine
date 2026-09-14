// ============ 联网检索 · 请求构造（B）+ 由主进程代发（C）============
//
// 这一批改的是「检索**怎么发出去**」，所以三块各写一组：
//  ① 请求构造是纯函数 —— POST 走 JSON、地址带 {query} 走 GET，中文必须编码（否则接口收到乱码）；
//  ② 发送器可注入 —— 用桩验证「走的是哪条通道」以及**失败有没有如实上报**（不静默是硬要求）；
//  ③ 可用性提前判断 —— 界面靠它提前提示，判错会让作者白跑一趟。
import {
  buildSearchRequest, webSearch, harvestItems, renderSearchResults, searchBlockedReason,
  SEARXNG_ENDPOINT, BOCHA_ENDPOINT, SEARCH_ENGINE_LABEL,
  type SearchSettings, type SearchRequest, type TransportResult,
} from '../src/lib/webSearch'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const base = (over: Partial<SearchSettings> = {}): SearchSettings => ({
  mode: 'api', engine: 'bocha', endpoint: '', apiKey: '', topK: 5, ...over,
})

/** 记录「发送器收到了什么」，并按需返回结果 */
function stub(result: TransportResult | (() => Promise<TransportResult>)) {
  const calls: { req: SearchRequest; signal?: AbortSignal }[] = []
  const transport = async (req: SearchRequest, signal?: AbortSignal): Promise<TransportResult> => {
    calls.push({ req, signal })
    return typeof result === 'function' ? result() : result
  }
  return { calls, transport }
}

const searxngBody = JSON.stringify({
  query: '蒂法',
  results: [
    { title: '蒂法·洛克哈特 - 最终幻想7', url: 'https://example.com/tifa', content: '第七天堂酒吧的经营者，格斗家。' },
    { title: 'Tifa Lockhart | Final Fantasy Wiki', url: 'https://example.com/tifa2', content: 'Childhood friend of Cloud.' },
  ],
})

async function main() {
  // ---------- ① 请求构造 ----------
  {
    const r = buildSearchRequest(base({ apiKey: 'sk-a' }), '蒂法', 3)
    ok('博查默认地址 = 官方接口', r.req?.url === BOCHA_ENDPOINT, r.req?.url)
    ok('不带占位符 → 用 POST', r.req?.method === 'POST', r.req?.method)
    ok('POST 带 JSON 头', r.req?.headers['Content-Type'] === 'application/json')
    ok('带密钥时附 Bearer', r.req?.headers.Authorization === 'Bearer sk-a')
    const body = JSON.parse(r.req?.body ?? '{}')
    ok('POST 体是博查要的 query + count', body.query === '蒂法' && body.count === 3, r.req?.body)
    ok('条数被夹到 1–10', JSON.parse(buildSearchRequest(base(), 'x', 99).req?.body ?? '{}').count === 10)

    const noKey = buildSearchRequest(base(), '蒂法', 3)
    ok('没填密钥就不带 Authorization（别塞个 undefined 进去）', !('Authorization' in (noKey.req?.headers ?? {})))

    const g = buildSearchRequest(base({ engine: 'searxng' }), '蒂法 造型', 5)
    ok('SearXNG 留空地址 → 用本地默认地址', (g.req?.url?.startsWith(SEARXNG_ENDPOINT.split('?')[0]) ?? false), g.req?.url)
    ok('🔴 地址里带 {query} → 用 GET（SearXNG/Jina/Exa 这一路）', g.req?.method === 'GET', g.req?.method)
    ok('🔴 中文检索词被 URL 编码（不编码接口会收到乱码）',
      (g.req?.url ?? '').includes(encodeURIComponent('蒂法 造型')), g.req?.url)
    ok('GET 不带 body', g.req?.body === undefined)
    ok('{count} 占位符也替换', buildSearchRequest(
      base({ engine: 'custom', endpoint: 'https://x.dev/s?q={query}&n={count}' }), 'a', 7,
    ).req?.url?.endsWith('&n=7') ?? false)

    const srNoPh = buildSearchRequest(base({ engine: 'searxng', endpoint: 'https://x.dev/search' }), 'a', 3)
    ok('🔴 SearXNG 给了没有 {query} 的地址 → 明确报错，而不是 POST 过去再报「没结果」',
      !!srNoPh.error && srNoPh.error.includes('{query}'), srNoPh.error)

    ok('检索词为空 → 报错', !!buildSearchRequest(base(), '   ', 3).error)
    ok('自定义接口没填地址 → 报错', !!buildSearchRequest(base({ engine: 'custom' }), 'a', 3).error)
    ok('三个引擎都有显示名', !!SEARCH_ENGINE_LABEL.bocha && !!SEARCH_ENGINE_LABEL.searxng && !!SEARCH_ENGINE_LABEL.custom)
  }

  // ---------- ② 发送器（C：由主进程代发）---------- 
  {
    const s = stub({ ok: true, status: 200, text: searxngBody })
    const out = await webSearch('蒂法', base({ engine: 'searxng' }), undefined, { transport: s.transport })
    ok('走注入的发送器并取回结果', out.used === true && out.results.length === 2, JSON.stringify(out.results.length))
    ok('发送器收到的是 GET 请求', s.calls.length === 1 && s.calls[0].req.method === 'GET')
    ok('结果按 SearXNG 形状解析出标题与摘要',
      out.results[0].title.includes('蒂法') && out.results[0].snippet.includes('第七天堂'), JSON.stringify(out.results[0]))
    ok('网址也取到了', out.results[0].url === 'https://example.com/tifa')

    const bad = stub({ ok: true, status: 401, text: JSON.stringify({ message: '无效的密钥' }) })
    const e1 = await webSearch('x', base(), undefined, { transport: bad.transport })
    ok('🔴 非 2xx 如实上报（带上接口给的原因）', e1.used === false && (e1.error ?? '').includes('无效的密钥'), e1.error)

    const netErr = stub({ ok: false, error: 'Failed to fetch' })
    const e2 = await webSearch('x', base(), undefined, { transport: netErr.transport })
    ok('🔴 网络/跨域失败如实上报，不当成「没结果」', e2.used === false && (e2.error ?? '').includes('检索失败'), e2.error)

    const boom = stub(async () => { throw new Error('socket hang up') })
    const e3 = await webSearch('x', base(), undefined, { transport: boom.transport })
    ok('发送器抛异常也被接住（webSearch 永不抛）', e3.used === false && (e3.error ?? '').includes('socket hang up'), e3.error)

    const empty = stub({ ok: true, status: 200, text: JSON.stringify({ results: [] }) })
    const e4 = await webSearch('x', base(), undefined, { transport: empty.transport })
    ok('接口返回空结果 → 明确说「没有可识别的结果」', e4.used === false && (e4.error ?? '').includes('没有返回可识别'), e4.error)

    const off = stub({ ok: true, status: 200, text: searxngBody })
    const e5 = await webSearch('x', base({ mode: 'off' }), undefined, { transport: off.transport })
    ok('🔴 off 档根本不发请求（0 成本，不只是不显示）', off.calls.length === 0 && e5.used === false, e5.error)

    const noBridge = stub({ ok: true, status: 200, text: searxngBody })
    const out2 = await webSearch('蒂法', base({ engine: 'custom', endpoint: 'https://api.x.dev/s' }), undefined, { transport: noBridge.transport })
    ok('自定义接口（POST 一路）照常走通', out2.used === true && noBridge.calls[0].req.method === 'POST')

    const rendered = renderSearchResults(out)
    ok('渲染给模型的资料带编号与检索词',
      rendered.includes('〖联网检索结果〗') && rendered.includes('1. ') && rendered.includes('蒂法'))
    ok('渲染里明确「参考不是圣旨」', rendered.includes('参考而不是圣旨'))
    ok('没查成时不渲染任何东西', renderSearchResults(e2) === '')
  }

  // ---------- ③ 可用性提前判断 ----------
  {
    ok('off 档永远可用（零配置）', searchBlockedReason(base({ mode: 'off' })) === null)
    ok('博查没填密钥 → 提前提示', (searchBlockedReason(base()) ?? '').includes('密钥'))
    ok('自定义没填地址 → 提前提示', (searchBlockedReason(base({ engine: 'custom' })) ?? '').includes('地址'))
    // 测试跑在 node 里（没有 window）→ 等价于「便携版/浏览器」：没有主进程代发
    ok('🔴 SearXNG 在无主进程代发的环境下 → 提前说明会被跨域拦',
      (searchBlockedReason(base({ engine: 'searxng' })) ?? '').includes('跨域'),
      String(searchBlockedReason(base({ engine: 'searxng' }))))
    ok('检索结果提取对嵌套结构也有效',
      harvestItems({ data: { list: [{ title: 'A', url: 'u', snippet: 's' }] } }, 5).length === 1)
  }

  console.log('')
  console.log(`共 ${pass + fail} 条：PASS ${pass} · FAIL ${fail}`)
  if (fail > 0) process.exit(1)
}

void main()
