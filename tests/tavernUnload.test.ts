// ============ 酒馆模式 · 收尾后卸载本地模型（2026-09-16，老大反馈 #11）============
//
// 要解决的现象：模型没卸载时，即使作者删了上一场的记忆与日记，模型扮演的角色
// **还是带着上一场的上下文** —— 看起来像「清理没生效」。真因是 Ollama 把模型
// 按 keep_alive 留在显存里，那段上下文还在它的 KV cache 里。
//
// 这一层要守住的性质：
//   ① 只动**本机 Ollama**（云端后端没有「卸载」这回事，也不能去卸别人的服务）；
//   ② 一切失败都**不抛**（它是收尾之后的最后一步，绝不能让「结束本轮对话」显示失败）；
//   ③ 开关默认**关**（D4 拍板）—— 代价是下一场开场要等模型重新加载。
import { unloadOllamaModel, type AIProvider } from '../src/lib/ai'
import { DEFAULT_TAVERN_SETTINGS, getTavernSettings, K_TAVERN_SETTINGS } from '../src/lib/tavern/settings'
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const mk = (patch: Partial<AIProvider> = {}): AIProvider => ({
  id: 'u1', name: '本地', type: 'ollama',
  baseUrl: 'http://localhost:11434', apiKey: '', model: 'qwen3:27b', ...patch,
})

/** 换掉全局 fetch，记下所有请求；返回恢复函数 */
function spyFetch(reply: { ok?: boolean; status?: number; throws?: boolean }) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
    })
    if (reply.throws) throw new Error('网络不通')
    return { ok: reply.ok ?? true, status: reply.status ?? 200, json: async () => ({}) } as unknown as Response
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = orig } }
}

async function main() {
  console.log('=== tavernUnload ===')

  // ---------- 1) 设置项：默认关、老库读得到（mergeDeep 补默认值） ----------
  {
    __resetMockStores()
    ok('🔴 默认关（D4：默认开等于让所有人下次开场都多等一次加载）',
      DEFAULT_TAVERN_SETTINGS.free.unloadAfterRoundEnd === false)
    const st = await getTavernSettings()
    ok('设置读出来后是 false（不是 undefined）', st.free.unloadAfterRoundEnd === false)

    // 老库（这个字段还不存在时的设置）→ 合并默认值，不能读到 undefined
    await db.setMeta(K_TAVERN_SETTINGS, { free: { temperature: 0.9 } })
    ok('🔴 老库没有这个字段 → 补成默认关（不是 undefined，界面开关才画得出来）',
      (await getTavernSettings()).free.unloadAfterRoundEnd === false)

    await db.setMeta(K_TAVERN_SETTINGS, { free: { unloadAfterRoundEnd: true } })
    ok('作者打开后读得到 true（不会被升级逻辑抹掉）',
      (await getTavernSettings()).free.unloadAfterRoundEnd === true)
  }

  // ---------- 2) 只动本机 Ollama ----------
  {
    let s = spyFetch({ ok: true })
    ok('🔴 openai 兼容后端 → 直接跳过（云端没有「卸载」这回事）',
      (await unloadOllamaModel(mk({ type: 'openai' }))) === false)
    ok('而且是**一个请求都没发**（不是发了被拒）', s.calls.length === 0, String(s.calls.length))
    s.restore()

    s = spyFetch({ ok: true })
    ok('🔴 局域网另一台机器上的 Ollama → 也跳过（那是别人的服务，不归我们管）',
      (await unloadOllamaModel(mk({ baseUrl: 'http://10.0.0.5:11434' }))) === false)
    ok('同样没发请求', s.calls.length === 0)
    s.restore()

    s = spyFetch({ ok: true })
    ok('没填模型名 → 跳过（没法指定卸谁）',
      (await unloadOllamaModel(mk({ model: '  ' }))) === false)
    ok('没发请求', s.calls.length === 0)
    s.restore()
  }

  // ---------- 3) 本机 Ollama：请求长什么样 ----------
  {
    const s = spyFetch({ ok: true })
    const r = await unloadOllamaModel(mk())
    ok('本机 Ollama → 发请求并成功', r === true)
    ok('打的是 /api/generate', s.calls[0]?.url === 'http://localhost:11434/api/generate', s.calls[0]?.url)
    ok('🔴 带 keep_alive: 0（这一条才是「立刻卸载」的开关）', s.calls[0]?.body?.keep_alive === 0)
    ok('prompt 是空串（这是卸载请求，不该顺手生成一段文字）', s.calls[0]?.body?.prompt === '')
    ok('写明卸哪个模型', s.calls[0]?.body?.model === 'qwen3:27b')
    s.restore()

    const s2 = spyFetch({ ok: true })
    await unloadOllamaModel(mk({ baseUrl: 'http://127.0.0.1:11434/' }))
    ok('127.0.0.1 同样认（也是本机）', s2.calls[0]?.url === 'http://127.0.0.1:11434/api/generate', s2.calls[0]?.url)
    s2.restore()
  }

  // ---------- 4) 失败一律不抛（收尾的最后一步，不能把「结束」判成失败）----------
  {
    let s = spyFetch({ ok: false, status: 500 })
    ok('服务端 500 → false，不抛', (await unloadOllamaModel(mk())) === false)
    s.restore()

    s = spyFetch({ throws: true })
    ok('🔴 网络异常 → false，不抛（绝不能因为卸载失败让收尾显示失败）',
      (await unloadOllamaModel(mk())) === false)
    s.restore()

    ok('没给 provider → false，不抛', (await unloadOllamaModel(undefined as unknown as AIProvider)) === false)
  }

  console.log(`\ntavernUnload: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
