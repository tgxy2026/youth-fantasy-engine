// ============ 3.7.0 · W7 语音转写 ============
//
// 盯四件事（规划 §3 W7.3）：
//   ① 协议：multipart 构造正确、URL 正确、失败各有如实文案；未配置时**不调用**；
//   ② 上限：120 秒 / 10MB 先到先停（常量与行为）；
//   ③ 隐私负向：模块与录音组件不做任何音频持久化（不落盘 / 不进备份 / 不进诊断）；
//   ④ 配置：仅通用三项，归一化后可用性判据稳定。
import fs from 'node:fs'
import {
  normalizeConfig, saveTranscribeConfig, loadTranscribeConfig, transcribeAudio,
  transcribeEndpoint, transcribeReady, VOICE_MAX_BYTES, VOICE_MAX_SECONDS, TRANSCRIBE_CONFIG_KEY,
} from '../src/lib/aiCore/transcribe'
import * as db from '../src/lib/db'
import { memoryOps, __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const cfg = { baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-test', model: 'whisper-1' }
const audio = (bytes = 8) => new Blob([new Uint8Array(bytes)], { type: 'audio/webm' })

async function main() {
  // ---------- ① 协议 / 成功路径 ----------
  {
    const calls: { url: string; init: RequestInit }[] = []
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ text: '  一句转写文本  ' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const r = await transcribeAudio(audio(), cfg, { fetchImpl: fakeFetch })
    ok('成功后返回去空白文本', r.ok && r.text === '一句转写文本', JSON.stringify(r))
    ok('端点拼接正确（去掉尾斜杠）', calls[0]?.url === 'https://api.example.com/v1/audio/transcriptions', calls[0]?.url)
    ok('带 Bearer 鉴权头', new Headers(calls[0]?.init.headers).get('Authorization') === 'Bearer sk-test')
    const form = calls[0]?.init.body as FormData
    ok('multipart 里有 file 与 model', !!form.get('file') && form.get('model') === 'whisper-1')
    ok('文件名按类型选扩展名', (form.get('file') as File).name.endsWith('.webm'), (form.get('file') as File).name)
  }

  // ---------- ② 失败路径各有如实文案 ----------
  {
    const withStatus = (status: number) => (async () => new Response('nope', { status })) as unknown as typeof fetch
    const auth = await transcribeAudio(audio(), cfg, { fetchImpl: withStatus(401) })
    ok('401 → 鉴权失败文案（不回显 Key）', auth.failure === 'auth' && auth.detail!.includes('apiKey') && !auth.detail!.includes('sk-test'), auth.detail)
    const big = await transcribeAudio(audio(), cfg, { fetchImpl: withStatus(413) })
    ok('413 → 音频太大文案', big.failure === 'too-large')
    const http = await transcribeAudio(audio(), cfg, { fetchImpl: withStatus(500) })
    ok('其他状态码如实报状态', http.failure === 'http' && http.detail!.includes('500'), http.detail)
    const net = await transcribeAudio(audio(), cfg, { fetchImpl: (async () => { throw new TypeError('failed to fetch') }) as unknown as typeof fetch })
    ok('网络错误 → 明确说明音频已丢弃', net.failure === 'network' && net.detail!.includes('音频已丢弃'), net.detail)
    const empty = await transcribeAudio(audio(), cfg, {
      fetchImpl: (async () => new Response(JSON.stringify({ text: '   ' }), { status: 200 })) as unknown as typeof fetch,
    })
    ok('空结果不当作成功', !empty.ok && empty.failure === 'empty')
    const none = await transcribeAudio(new Blob([]), cfg, { fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch })
    ok('空录音不发送', none.failure === 'empty')
    const tooBig = new Blob([new Uint8Array(VOICE_MAX_BYTES + 1)], { type: 'audio/webm' })
    const over = await transcribeAudio(tooBig, cfg, { fetchImpl: (async () => { throw new Error('should not call') }) as unknown as typeof fetch })
    ok('超过 10MB 本地就拦下（不发请求）', over.failure === 'too-large')
    ok('录音时长上限常量 = 120 秒', VOICE_MAX_SECONDS === 120 && VOICE_MAX_BYTES === 10 * 1024 * 1024)
  }

  // ---------- ③ 未配置：不调用网络 ----------
  {
    let calls = 0
    const spy = (async () => { calls++; return new Response('{}') }) as unknown as typeof fetch
    const r = await transcribeAudio(audio(), { baseUrl: '', apiKey: '', model: '' }, { fetchImpl: spy })
    ok('未配置 → 明确说先配置，且不发请求', r.failure === 'unconfigured' && calls === 0 && r.detail!.includes('语音转写'), r.detail)
    ok('可用性判据：缺任一项都不算可用', !transcribeReady({ baseUrl: 'http://x', apiKey: '', model: 'm' })
      && !transcribeReady({ baseUrl: 'ftp://x', apiKey: 'k', model: 'm' }) && transcribeReady({ baseUrl: 'http://x', apiKey: 'k', model: 'm' }))
    ok('模型缺省为 whisper-1', normalizeConfig({ baseUrl: 'http://x', apiKey: 'k' }).model === 'whisper-1')
    ok('端点不重复拼斜杠', transcribeEndpoint('https://x/v1///') === 'https://x/v1/audio/transcriptions')
    ok('贴完整端点时不重复拼', transcribeEndpoint('https://x/v1/audio/transcriptions') === 'https://x/v1/audio/transcriptions')
  }

  // ---------- ④ 配置读写（只存三项字符串；无音频） ----------
  {
    __resetMockStores()
    db.setStoreOps(memoryOps)
    db.setCurrentProject('p-w7')
    await saveTranscribeConfig(cfg)
    const back = await loadTranscribeConfig()
    ok('配置往返一致（去尾斜杠以外的值原样）', back.apiKey === 'sk-test' && back.model === 'whisper-1' && back.baseUrl.startsWith('https://api.example.com'))
    const meta = await db.getMeta<Record<string, unknown>>(TRANSCRIBE_CONFIG_KEY, {})
    ok('只保存 baseUrl / apiKey / model 三项', Object.keys(meta).sort().join(',') === 'apiKey,baseUrl,model', Object.keys(meta).join(','))
    ok('没有任何音频字段（隐私负向）', !JSON.stringify(meta).toLowerCase().includes('audio'))
    ok('损坏值读取不炸、按未配置处理', (await (async () => { await db.setMeta(TRANSCRIBE_CONFIG_KEY, 123); return loadTranscribeConfig() })()).baseUrl === '')
  }

  // ---------- ⑤ 隐私：不做音频持久化（源码闸） ----------
  {
    const lib = fs.readFileSync('src/lib/aiCore/transcribe.ts', 'utf8')
    const ui = fs.readFileSync('src/components/creative/VoiceInputButton.tsx', 'utf8')
    ok('转写模块不写 localStorage / IndexedDB', !/localStorage|sessionStorage|indexedDB/i.test(lib))
    ok('录音组件不写存储（音频只在内存）', !/localStorage|sessionStorage|indexedDB|setMeta|setSetting/i.test(ui))
    ok('录音组件显式开停 + 进行中指示', ui.includes('getUserMedia') && ui.includes('结束（') && ui.includes('录音中'))
    ok('界面明示音频去向与会留存口径', ui.includes('不上传直到你点结束') || ui.includes('本应用不留存音频'))
    ok('转写失败音频即弃（提示重试）', lib.includes('音频已丢弃'))
  }

  console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })