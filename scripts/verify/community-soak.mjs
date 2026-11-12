// Synthetic local soak; not a production-equivalent capacity certification.
// Three independent services run together; each owns a copied S2 dataset.
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const durationMs = Number(process.env.YFE_SOAK_MS || 1800000)
if (!Number.isInteger(durationMs) || durationMs < 10000 || durationMs > 3600000) throw new Error('无效测试时长')
const run = await mkdtemp(path.resolve('.workbuddy/tmp/community-soak-'))
const source = path.resolve('.workbuddy/tmp/352-repro/capacity-s2/data/community')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const percentile = (items, p) => {
  if (!items.length) return null
  const sorted = [...items].sort((a, b) => a - b)
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(2))
}

async function scenario(concurrency) {
  const dir = path.join(run, String(concurrency)), data = path.join(dir, 'data')
  await mkdir(data, { recursive: true })
  await cp(source, path.join(data, 'community'), { recursive: true, errorOnExist: true })
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
  const base = `http://127.0.0.1:${port}`, metrics = path.join(dir, 'metrics.json')
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_REGISTER: 'open', YFE_SCHEDULER: 'off', YFE_METRICS_FILE: metrics }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[key]
  const preload = pathToFileURL(path.resolve('.workbuddy/tmp/352-repro/metrics-preload.mjs')).href
  const server = spawn(process.execPath, ['--import', preload, 'server/index.mjs'], { env, windowsHide: true, stdio: 'ignore' })
  const out = { concurrency, durationMs, reads: [], writes: [], failures: [], accepted: [], maxInFlight: 0, start: null }
  let inFlight = 0
  async function call(route, options = {}) {
    const started = performance.now()
    inFlight++; out.maxInFlight = Math.max(out.maxInFlight, inFlight)
    try {
      const response = await fetch(base + route, { ...options, signal: AbortSignal.timeout(30000) })
      const json = await response.json()
      const elapsed = performance.now() - started
      return { status: response.status, json, elapsed, cookie: response.headers.get('set-cookie')?.split(';')[0] }
    } finally { inFlight-- }
  }
  try {
    let ready = false
    for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/api/ping')).ok) { ready = true; break } } catch {} await sleep(100) }
    if (!ready) throw new Error('隔离服务启动失败')
    const register = await call('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `soak-${concurrency}-352`, password: 'Soak352-test!' }) })
    if (register.status !== 200 || !register.cookie) throw new Error(`隔离账号注册失败 ${register.status}`)
    const list = await call('/api/community/posts?limit=20')
    if (list.status !== 200 || !list.json.items?.length) throw new Error('隔离社区列表为空')
    const post = list.json.items[0].id
    const before = await call(`/api/community/posts/${post}/comments?limit=50`)
    if (before.status !== 200 || typeof before.json.total !== 'number') throw new Error('读取初始评论失败')
    out.start = new Date().toISOString()
    const deadline = Date.now() + durationMs
    async function worker(index) {
      let iteration = 0
      while (Date.now() < deadline) {
        const write = index === 0 && iteration % 60 === 0
        const route = write ? `/api/community/posts/${post}/comments` : iteration % 3 === 0 ? '/api/community/posts?limit=20' : iteration % 3 === 1 ? `/api/community/posts/${post}` : `/api/community/posts/${post}/comments?limit=20`
        try {
          const result = await call(route, write ? { method: 'POST', headers: { cookie: register.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ body: `隔离持续测试 ${concurrency}-${iteration}。`, display: 'anonymous', clientToken: `soak-${concurrency}-${iteration}` }) } : {})
          ;(write ? out.writes : out.reads).push(result.elapsed)
          if (result.status !== 200) out.failures.push({ kind: write ? 'write' : 'read', status: result.status })
          else if (write && result.json.comment?.id) out.accepted.push(result.json.comment.id)
          else if (write) out.failures.push({ kind: 'write', status: 'missing-id' })
        } catch (error) { out.failures.push({ kind: write ? 'write' : 'read', status: String(error?.name || 'error') }) }
        iteration++
        await sleep(1500)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)))
    const after = await call(`/api/community/posts/${post}/comments?limit=50`)
    const detail = await call(`/api/community/posts/${post}`)
    const distinct = new Set(out.accepted)
    out.correct = after.status === 200 && detail.status === 200 && distinct.size === out.accepted.length && after.json.total - before.json.total === out.accepted.length && detail.json.post.counts.comments === after.json.total
    out.read = { n: out.reads.length, p95: percentile(out.reads, .95), p99: percentile(out.reads, .99) }
    out.write = { n: out.writes.length, p95: percentile(out.writes, .95), p99: percentile(out.writes, .99) }
    out.errorRate = out.failures.length / Math.max(1, out.reads.length + out.writes.length + out.failures.filter((x) => typeof x.status === 'string').length)
    out.metrics = JSON.parse(await readFile(metrics, 'utf8'))
    out.end = new Date().toISOString()
    delete out.reads; delete out.writes
  } catch (error) { out.error = String(error?.stack || error) }
  finally { server.kill(); await writeFile(path.join(dir, 'result.json'), JSON.stringify(out, null, 2)) }
  console.log(JSON.stringify({ concurrency, read: out.read, write: out.write, errors: out.failures.length, correct: out.correct, error: out.error }))
  return out
}

console.log(`RUN ${run} durationMs=${durationMs}; three services share this workstation`)
const results = await Promise.all([1, 5, 10].map(scenario))
await writeFile(path.join(run, 'summary.json'), JSON.stringify(results, null, 2))
if (results.some((result) => result.error || !result.correct || result.failures.length)) process.exitCode = 1
