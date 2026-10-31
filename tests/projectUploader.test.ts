// 3.3.2 · P2-7 上传编排 · 单测
//
// 盯五件事：
//   ① 顺序：对象全部就位才提交（否则云端会出现指向空气的版本）；
//   ② 重试只对「可能自己会好」的错误（网络/5xx），4xx 立即返回；
//   ③ 四种结局各自翻译对（published / replayed / conflict / quota / error）；
//   ④ 图片无法解码时**一个字节都不传**；
//   ⑤ 进度回调次数 = 对象数 + 资源数。
import type { BuiltSnapshot } from '@/lib/sync/projectSnapshot'
import { uploadSnapshot, type UploadTransport } from '@/lib/sync/projectUploader'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function makeBuilt(over: Partial<BuiltSnapshot> = {}): BuiltSnapshot {
  return {
    manifest: {
      protocol: 1, createdAt: 1, project: { name: 'x', genre: 'y' }, counts: {},
      objects: [], assets: [], tombstones: [],
    },
    objects: [
      { kind: 'chapters', hash: 'a'.repeat(64), bytes: 10, payload: '[{"id":"c1"}]' },
      { kind: 'volumes', hash: 'b'.repeat(64), bytes: 5, payload: '[]' },
    ],
    assets: [{ hash: 'c'.repeat(64), bytes: 3, mime: 'image/png', dataUrl: PNG }],
    ...over,
  }
}

interface Call { op: string; hash?: string }

function makeTransport(handler: {
  put?: (hash: string) => { ok: boolean; code?: string } | Promise<{ ok: boolean; code?: string }>
  commit?: () => unknown
}) {
  const calls: Call[] = []
  const t: UploadTransport = {
    async putObject(_pid, hash) {
      calls.push({ op: 'put', hash })
      return handler.put ? await handler.put(hash) : { ok: true }
    },
    async commit() {
      calls.push({ op: 'commit' })
      const r = handler.commit ? handler.commit() : { ok: true, status: 200, revision: 1, snapshotId: 's1' }
      return r as never
    },
  }
  return { t, calls }
}

async function main() {
  // ① 成功路径与顺序
  {
    const { t, calls } = makeTransport({})
    const progress: number[] = []
    const r = await uploadSnapshot({
      cloudProjectId: 'p', built: makeBuilt(), baseRevision: 0, opId: 'op', transport: t,
      sleep: async () => {}, onProgress: (d) => progress.push(d),
    })
    ok('成功返回 published 与 revision', r.ok && r.status === 'published' && r.revision === 1, JSON.stringify(r))
    ok('资源先传、对象后传、提交最后', calls.map((c) => c.op + (c.hash ? ':' + c.hash.slice(0, 1) : '')).join(',') === 'put:c,put:a,put:b,commit', JSON.stringify(calls))
    ok('进度回调次数 = 对象+资源', progress.length === 3, String(progress.length))
  }

  // ② 服务端幂等重放
  {
    const { t } = makeTransport({ commit: () => ({ ok: true, status: 200, revision: 7, snapshotId: 's7', replayed: true }) })
    const r = await uploadSnapshot({ cloudProjectId: 'p', built: makeBuilt(), baseRevision: 6, opId: 'op', transport: t, sleep: async () => {} })
    ok('服务端重放 → status=replayed', r.ok && r.status === 'replayed' && r.revision === 7, JSON.stringify(r))
  }

  // ③ 网络异常重试后成功
  {
    let n = 0
    const { t } = makeTransport({
      put: (hash) => {
        if (hash.startsWith('a') && n++ === 0) throw new Error('boom')
        return { ok: true }
      },
    })
    const r = await uploadSnapshot({
      cloudProjectId: 'p', built: makeBuilt(), baseRevision: 0, opId: 'op', transport: t,
      retries: 1, sleep: async () => {},
    })
    ok('网络异常重试一次后成功', r.ok && r.status === 'published', JSON.stringify(r))
  }

  // ④ 重试耗尽
  {
    const { t } = makeTransport({ put: () => ({ ok: false, code: 'NETWORK' }) })
    const r = await uploadSnapshot({
      cloudProjectId: 'p', built: makeBuilt(), baseRevision: 0, opId: 'op', transport: t,
      retries: 2, sleep: async () => {},
    })
    ok('重试耗尽返回 error 且可重试', !r.ok && r.status === 'error' && r.retryable === true, JSON.stringify(r))
  }

  // ⑤ 4xx 不重试：哈希不符
  {
    let putCount = 0
    const { t, calls } = makeTransport({
      put: () => { putCount++; return { ok: false, code: 'HASH_MISMATCH' } },
    })
    const r = await uploadSnapshot({
      cloudProjectId: 'p', built: makeBuilt(), baseRevision: 0, opId: 'op', transport: t,
      retries: 3, sleep: async () => {},
    })
    ok('哈希不符不重试且不提交', !r.ok && r.status === 'error' && r.retryable === false
      && putCount === 1 && !calls.some((c) => c.op === 'commit'), JSON.stringify({ r, putCount }))
  }

  // ⑥ 冲突
  {
    let commitCount = 0
    const { t } = makeTransport({ commit: () => { commitCount++; return { ok: false, status: 409, code: 'BASELINE_MISMATCH', revision: 9 } } })
    const r = await uploadSnapshot({
      cloudProjectId: 'p', built: makeBuilt(), baseRevision: 1, opId: 'op', transport: t,
      retries: 3, sleep: async () => {},
    })
    ok('409 只提交一次并返回 conflict', !r.ok && r.status === 'conflict' && r.revision === 9 && commitCount === 1, JSON.stringify({ r, commitCount }))
  }

  // ⑦ 配额
  {
    const { t } = makeTransport({ commit: () => ({ ok: false, status: 413, code: 'QUOTA_EXCEEDED', usedBytes: 1, quotaBytes: 2 }) })
    const r = await uploadSnapshot({ cloudProjectId: 'p', built: makeBuilt(), baseRevision: 0, opId: 'op', transport: t, sleep: async () => {} })
    ok('413 → quota 结局', !r.ok && r.status === 'quota' && r.quotaBytes === 2, JSON.stringify(r))
  }

  // ⑧ 图片解码失败：一个字节都不传
  {
    const { t, calls } = makeTransport({})
    const built = makeBuilt({ assets: [{ hash: 'd'.repeat(64), bytes: 3, mime: 'image/png', dataUrl: 'not-a-data-url' }] })
    const r = await uploadSnapshot({ cloudProjectId: 'p', built, baseRevision: 0, opId: 'op', transport: t, sleep: async () => {} })
    ok('图片无法解码时不上传任何东西', !r.ok && r.status === 'error' && r.code === 'ASSET_DECODE_FAILED' && calls.length === 0, JSON.stringify({ r, calls }))
  }

  // ⑥ 同一哈希在一次推送里只传一次（实机验证发现：11 个分片里 5 个是空数组，被 PUT 了 5 次）
  {
    const dup = makeBuilt({
      objects: [
        { kind: 'chapters', hash: 'e'.repeat(64), bytes: 2, payload: '[1]' },
        { kind: 'volumes', hash: 'e'.repeat(64), bytes: 2, payload: '[1]' },
        { kind: 'tableRows', hash: 'e'.repeat(64), bytes: 2, payload: '[1]' },
      ],
      assets: [],
    })
    const { t, calls } = makeTransport({})
    const progress: number[] = []
    const r = await uploadSnapshot({
      cloudProjectId: 'c1', built: dup, baseRevision: 0, opId: 'op1', transport: t,
      onProgress: (d) => progress.push(d),
    })
    const puts = calls.filter((c) => c.op === 'put')
    ok('同一哈希只传一次（不重复 PUT）', r.ok && puts.length === 1, JSON.stringify(calls))
    // 跳过的也要推进进度，否则界面停在 1/3 不动
    ok('跳过的对象也推进进度（3/3）', progress[progress.length - 1] === 3, JSON.stringify(progress))
  }

  // ⑦ 云端已有的对象不再重传（否则每次自动同步都重传整本书）
  {
    const built = makeBuilt()
    const { t, calls } = makeTransport({})
    const r = await uploadSnapshot({
      cloudProjectId: 'c1', built, baseRevision: 3, opId: 'op1', transport: t,
      // 两个分片都已在云端；只剩图片要传
      knownHashes: new Set([built.objects[0].hash, built.objects[1].hash]),
    })
    const puts = calls.filter((c) => c.op === 'put').map((c) => c.hash)
    ok('基线已有的对象被跳过', r.ok && puts.length === 1 && puts[0] === built.assets[0].hash, JSON.stringify(puts))
    ok('跳过之后仍然提交', calls.some((c) => c.op === 'commit'))
  }

  // ⑧ 以为有、其实没有 ⇒ 服务端 OBJECT_MISSING ⇒ 自动补传一轮（不跳任何对象）
  {
    const built = makeBuilt()
    let commitCount = 0
    const puts: string[] = []
    const t: UploadTransport = {
      async putObject(_pid, hash) { puts.push(hash); return { ok: true } },
      async commit() {
        commitCount++
        // 第一轮：因为跳过了对象，服务端说缺
        if (commitCount === 1) return { ok: false, status: 400, code: 'OBJECT_MISSING' } as never
        return { ok: true, status: 200, revision: 4, snapshotId: 's4' } as never
      },
    }
    const r = await uploadSnapshot({
      cloudProjectId: 'c1', built, baseRevision: 3, opId: 'op1', transport: t,
      knownHashes: new Set([built.objects[0].hash, built.objects[1].hash]),
    })
    ok('缺对象时自动补传并成功', r.ok && r.status === 'published' && r.revision === 4, JSON.stringify(r))
    // 第一轮跳过 2 个（只传图片），第二轮 3 个全传
    ok('第二轮一个都不跳（补传全量）', puts.length === 1 + 3, JSON.stringify(puts))
    ok('补传只做一次（不会无限循环）', commitCount === 2, String(commitCount))
  }

  console.log(`\n▶ projectUploader: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
