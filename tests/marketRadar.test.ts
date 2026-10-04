// ============ 市场雷达（2.8.0 · 台账 #018）============
//
// 本用例盯四件事（对齐方案 §6.7）：
//   ① `buildRadarQueries` 纯函数：去重、条数上限、空输入不崩；
//   ② 🔴 **未配置联网（off 档）⇒ 一个请求都不发**（注入假 transport 断言零调用）；
//   ③ 检索失败 / 无结果 ⇒ `{ok:false}` 带中文原因、**永不抛**；
//   ④ 🔴 报告 `disclaimer` **恒非空**（口径红线：不得呈现为确定结论）。
import * as db from '../src/lib/db'
import {
  buildRadarQueries, runMarketRadar, RADAR_DISCLAIMER, RADAR_MAX_QUERIES,
  type RadarInput,
} from '../src/lib/marketRadar'
import { DEFAULT_SEARCH_SETTINGS, type SearchSettings, type SearchTransport } from '../src/lib/webSearch'
import type { AIProvider } from '../src/lib/ai'
import { __resetMockStores } from './mock-memory'

type ChatLike = typeof import('../src/lib/ai').chat

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const API_SETTINGS: SearchSettings = {
  ...DEFAULT_SEARCH_SETTINGS, mode: 'api', engine: 'custom',
  endpoint: 'https://x.example/search?q={query}', topK: 5,
}

/** 每次都回的桩发送器；记录调用次数（用于断言「零请求」） */
const hitTransport = (calls: { n: number }): SearchTransport => async () => {
  calls.n++
  return {
    ok: true, status: 200,
    text: JSON.stringify({ data: { list: [{ title: `T${calls.n}`, url: `https://a.example/${calls.n}`, snippet: 'S' }] } }),
  }
}

async function seedModel() {
  const p: AIProvider = {
    id: 'a', name: 'a', type: 'ollama', baseUrl: 'http://localhost:11434',
    apiKey: '', model: 'm', local: true, contextWindow: 32768,
  }
  await db.setMeta('aiProviders', [p])
  await db.setMeta('aiActiveProviderId', 'a')
  await db.setMeta('aiConfigMigratedToGlobal', true)
}

const INPUT: RadarInput = { genre: '东方仙侠', tags: ['升级流', '群像'], platform: '起点', keywords: ['凡人流'] }

async function main() {
  // ---------- ① buildRadarQueries（纯函数）----------
  {
    const q = buildRadarQueries(INPUT, { year: 2026 })
    ok('组合出检索词', q.length > 0, String(q.length))
    ok('含「题材 平台 热门 年」', q.includes('东方仙侠 起点 热门 2026'), JSON.stringify(q))
    ok('去重（同一词不重复出现）', new Set(q).size === q.length)
    ok('条数不超过上限', q.length <= RADAR_MAX_QUERIES, `${q.length} vs ${RADAR_MAX_QUERIES}`)
    ok('空输入 ⇒ 空数组且不崩', buildRadarQueries({ genre: '', tags: [], platform: '', keywords: [] }).length === 0)
    ok('字段全缺 ⇒ 也不崩', buildRadarQueries({} as RadarInput).length === 0)
    ok('只有关键词时也能出词', buildRadarQueries({ genre: '', tags: [], platform: '', keywords: ['星际'] }).length === 1)
    ok('只有平台时也有兜底词', buildRadarQueries({ genre: '', tags: [], platform: '番茄', keywords: [] }).length === 1)
  }

  // ---------- ② 免责声明常量 ----------
  ok('🔴 免责声明非空且含「仅供参考」', RADAR_DISCLAIMER.trim().length > 0 && RADAR_DISCLAIMER.includes('仅供参考'))

  // ---------- ③ 🔴 off 档：一个请求都不发 ----------
  {
    __resetMockStores()
    await seedModel()
    const calls = { n: 0 }
    const res = await runMarketRadar(INPUT, {
      settings: { ...DEFAULT_SEARCH_SETTINGS, mode: 'off' },
      transport: hitTransport(calls),
    })
    ok('🔴 未配联网（off）⇒ ok:false', !res.ok)
    ok('🔴 off 档不发任何检索请求（零调用）', calls.n === 0, String(calls.n))
    ok('off 的提示指向「联网检索」设置', (res.error ?? '').includes('联网检索'), res.error)
  }

  // ---------- ④ api 档但配置不全（博查缺密钥）⇒ 不发请求 ----------
  {
    __resetMockStores()
    await seedModel()
    const calls = { n: 0 }
    const res = await runMarketRadar(INPUT, {
      settings: { ...DEFAULT_SEARCH_SETTINGS, mode: 'api', engine: 'bocha', apiKey: '' },
      transport: hitTransport(calls),
    })
    ok('api·博查缺密钥 ⇒ ok:false', !res.ok)
    ok('配置不全时不发请求', calls.n === 0, String(calls.n))
  }

  // ---------- ⑤ 检索全失败 ⇒ ok:false、不抛 ----------
  {
    __resetMockStores()
    await seedModel()
    const failTransport: SearchTransport = async () => ({ ok: false, error: '网络不通' })
    const res = await runMarketRadar(INPUT, { settings: API_SETTINGS, transport: failTransport })
    ok('🔴 检索全失败 ⇒ ok:false 且不抛', !res.ok)
    ok('带回中文原因', (res.error ?? '').includes('检索失败'), res.error)
  }

  // ---------- ⑥ 检索成功但无结果 ⇒ ok:false ----------
  {
    __resetMockStores()
    await seedModel()
    const emptyTransport: SearchTransport = async () => ({ ok: true, status: 200, text: '{"data":{"list":[]}}' })
    const res = await runMarketRadar(INPUT, { settings: API_SETTINGS, transport: emptyTransport })
    ok('检索成功但无结果 ⇒ ok:false', !res.ok, JSON.stringify(res).slice(0, 140))
  }

  // ---------- ⑦ 成功路径（注入 chatFn）⇒ 报告结构完整 ----------
  {
    __resetMockStores()
    await seedModel()
    const calls = { n: 0 }
    const chatFn = (async () => JSON.stringify({
      trend: [{ topic: '凡人流', heat: 'rising', note: '资料显示热度上升' }],
      platformFit: [{ platform: '起点', note: '适合长线连载' }],
      opportunities: ['开篇节奏快'], risks: ['同质化严重'],
    })) as unknown as ChatLike
    const res = await runMarketRadar(INPUT, { settings: API_SETTINGS, transport: hitTransport(calls), chatFn })
    ok('🔴 成功路径 ⇒ ok:true', res.ok, res.error)
    const rep = res.report
    ok('报告含检索词（可追溯基于什么查的）', !!rep && rep.queries.length > 0, String(rep?.queries?.length))
    ok('报告含来源链接', !!rep && rep.sources.length > 0, String(rep?.sources?.length))
    ok('报告解析出趋势', !!rep && rep.trend.length === 1 && rep.trend[0].topic === '凡人流', JSON.stringify(rep?.trend))
    ok('trend.heat 合法值原样保留', !!rep && rep.trend[0].heat === 'rising')
    ok('报告解析出平台适配', !!rep && rep.platformFit.length === 1 && rep.platformFit[0].platform === '起点')
    ok('报告含机会与风险各一条', !!rep && rep.opportunities.length === 1 && rep.risks.length === 1)
    ok('🔴 成功报告恒带 disclaimer（口径红线）',
      !!rep && rep.disclaimer === RADAR_DISCLAIMER && rep.disclaimer.length > 0)
    ok('确实发出了检索请求', calls.n > 0, String(calls.n))
  }

  // ---------- ⑧ 非法 heat 归一为 stable ----------
  {
    __resetMockStores()
    await seedModel()
    const chatFn = (async () => JSON.stringify({ trend: [{ topic: 'X', heat: '爆炸', note: '' }] })) as unknown as ChatLike
    const res = await runMarketRadar(INPUT, { settings: API_SETTINGS, transport: hitTransport({ n: 0 }), chatFn })
    ok('非法 heat ⇒ 归一为 stable', res.ok && res.report?.trend[0]?.heat === 'stable', JSON.stringify(res.report?.trend))
  }

  // ---------- ⑨ 空输入 ⇒ 提示先填方向 ----------
  {
    __resetMockStores()
    await seedModel()
    const res = await runMarketRadar({ genre: '', tags: [], platform: '', keywords: [] }, {
      settings: API_SETTINGS, transport: hitTransport({ n: 0 }),
    })
    ok('空输入 ⇒ ok:false 且提示填题材 / 关键词', !res.ok && (res.error ?? '').includes('题材'), res.error)
  }

  console.log('')
  console.log(`共 ${pass + fail} 条：PASS ${pass} · FAIL ${fail}`)
  if (fail > 0) process.exit(1)
}

void main()
