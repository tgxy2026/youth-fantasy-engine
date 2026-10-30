// ============ 3.3.2 · P2 项目版本服务 · HTTP 层 ============
//
// 只做三件事：把请求接到 `projectStore`、按账号隔离目录与配额、把内部错误码翻成 HTTP 状态。
// 业务语义（提交/幂等/墓碑/世代）全部在 `projectStore.mjs`，这里**不重复判断**。
//
// 🔴 三条从实测换来的硬约束：
//   1. **上传必须流式**：把 `req` 直接交给 `stageObject`，绝不 `readBody()` 再转交 ——
//      40 MiB 全量缓冲实测 RSS +220 MiB（1.7 GB 机器 5 并发即触顶），流式只有 ~0.5 MiB。
//   2. **先鉴权再读体**：未登录的请求一个字节都不该被写进磁盘（否则等于开放匿名写盘）。
//   3. **`pid` 必须是受限字符集**：它直接参与路径拼接，`../` 之类的输入必须在最外层挡掉。
//
// 🔴 本层不做「账号能访问哪些项目」的推导：项目文件按 `accountId` 分目录，
//    并且提交时 store 里还有一道 `accountId` 比对（双保险，单靠任一层都不够）。
import path from 'node:path'
import fs from 'node:fs'
import { sendJSON, readJSONBody } from './http.mjs'
import {
  accountRoot, readIndex, writeIndex, projectBytes, accountUsedBytes, setProjectMeta,
} from './v2Index.mjs'
import {
  stageObject, commitProjectSnapshot, readManifest, getProjectState, effectiveTombstones,
  deleteProject, objectPath, hasObject, PROTOCOL_VERSION, listRevisions,
} from './projectStore.mjs'

const PID_RE = /^[A-Za-z0-9_-]{6,40}$/
const HASH_RE = /^[0-9a-f]{64}$/


/**
 * 处理 `/api/v2/*`。返回 true 表示已处理；false 表示不是本层的路由。
 *
 * @param {object} ctx
 * @param {import('node:http').IncomingMessage} ctx.req
 * @param {import('node:http').ServerResponse} ctx.res
 * @param {string} ctx.path 已去掉 query 的路径
 * @param {URLSearchParams} ctx.qs
 * @param {{ id: string, name: string, quotaBytes: number }} ctx.user 已鉴权用户
 * @param {string} ctx.v2Root
 */
export async function handleV2({ req, res, path: p, qs, user, v2Root }) {
  if (!p.startsWith('/api/v2/')) return false

  const accountId = user.id
  const storeRoot = accountRoot(v2Root, accountId)
  const seg = p.slice('/api/v2/'.length).split('/').filter(Boolean)

  // ---- GET /api/v2/projects：列出该账号的云端作品 ----
  if (seg.length === 1 && seg[0] === 'projects' && req.method === 'GET') {
    const idx = readIndex(v2Root, accountId)
    const list = Object.entries(idx.projects || {}).map(([pid, v]) => ({
      cloudProjectId: pid, name: v.name || '', revision: v.revision || 0,
      snapshotId: v.snapshotId || '', updatedAt: v.updatedAt || 0, objectBytes: v.objectBytes || 0,
    })).sort((a, b) => b.updatedAt - a.updatedAt)
    return sendJSON(res, 200, {
      ok: true, protocol: PROTOCOL_VERSION, projects: list,
      usedBytes: accountUsedBytes(idx), quotaBytes: user.quotaBytes,
    }), true
  }

  // ---- POST /api/v2/projects：新建云端作品 ----
  if (seg.length === 1 && seg[0] === 'projects' && req.method === 'POST') {
    let body
    try { body = await readJSONBody(req, 8 * 1024) } catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }), true }
    const name = String(body?.name || '').slice(0, 80)
    const cloudProjectId = `prj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    if (!PID_RE.test(cloudProjectId)) return sendJSON(res, 500, { ok: false, error: '内部 id 生成异常' }), true
    const idx = readIndex(v2Root, accountId)
    idx.projects = idx.projects || {}
    idx.projects[cloudProjectId] = { name, revision: 0, snapshotId: '', updatedAt: Date.now(), objectBytes: 0 }
    writeIndex(v2Root, accountId, idx)
    return sendJSON(res, 200, { ok: true, cloudProjectId, revision: 0 }), true
  }

  if (seg.length < 2 || seg[0] !== 'projects') return sendJSON(res, 404, { ok: false, error: '接口不存在' }), true
  const pid = seg[1]
  // 🔴 路径穿越的第一道闸：pid 直接拼进路径
  if (!PID_RE.test(pid)) return sendJSON(res, 400, { ok: false, error: '项目 id 无效' }), true

  const idx = readIndex(v2Root, accountId)
  if (!idx.projects?.[pid]) return sendJSON(res, 404, { ok: false, error: '云端作品不存在' }), true

  // ---- GET /api/v2/projects/:pid —— 状态（含墓碑数量） ----
  if (seg.length === 2 && req.method === 'GET') {
    const st = getProjectState(storeRoot, pid, accountId)
    return sendJSON(res, 200, {
      ok: true, ...st, protocol: PROTOCOL_VERSION,
      tombstoneCount: effectiveTombstones(storeRoot, pid).length,
    }), true
  }

  // ---- GET /api/v2/projects/:pid/manifest?rev= ----
  if (seg.length === 3 && seg[2] === 'manifest' && req.method === 'GET') {
    const st = getProjectState(storeRoot, pid, accountId)
    const rev = Number(qs.get('rev') || st.revision)
    if (!Number.isInteger(rev) || rev < 1) return sendJSON(res, 400, { ok: false, error: 'revision 无效' }), true
    const m = readManifest(storeRoot, pid, rev)
    if (!m) return sendJSON(res, 404, { ok: false, error: '该版本不存在' }), true
    return sendJSON(res, 200, { ok: true, revision: rev, manifest: m, current: st.revision }), true
  }

  // ---- GET /api/v2/projects/:pid/revisions —— 历史版本（P2-5）----
  if (seg.length === 3 && seg[2] === 'revisions' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, revisions: listRevisions(storeRoot, pid) }), true
  }

  // ---- PUT /api/v2/projects/:pid/objects/:hash —— 流式上传对象 ----
  if (seg.length === 4 && seg[2] === 'objects' && (req.method === 'PUT' || req.method === 'POST')) {
    const hash = seg[3]
    if (!HASH_RE.test(hash)) return sendJSON(res, 400, { ok: false, error: '对象哈希无效' }), true
    // 鉴权已经在上层做过；这里直接流式落盘（req 就是可读流）
    const r = await stageObject({ root: storeRoot, pid, hash, stream: req })
    if (!r.ok) {
      const code = r.code === 'TOO_LARGE' ? 413 : 400
      return sendJSON(res, code, { ok: false, code: r.code, error: r.code === 'HASH_MISMATCH' ? '内容与声明的哈希不一致' : '对象无法保存' }), true
    }
    return sendJSON(res, 200, { ok: true, hash: r.hash, bytes: r.bytes, reused: r.reused }), true
  }

  // ---- GET /api/v2/projects/:pid/objects/:hash —— 下载对象（流式） ----
  if (seg.length === 4 && seg[2] === 'objects' && req.method === 'GET') {
    const hash = seg[3]
    if (!HASH_RE.test(hash) || !hasObject(storeRoot, hash)) return sendJSON(res, 404, { ok: false, error: '对象不存在' }), true
    const file = objectPath(storeRoot, hash)
    const st = fs.statSync(file)
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'immutable' })
    fs.createReadStream(file).pipe(res)
    return true
  }

  // ---- POST /api/v2/projects/:pid/commit —— 条件提交 ----
  if (seg.length === 3 && seg[2] === 'commit' && req.method === 'POST') {
    let body
    try { body = await readJSONBody(req, 512 * 1024) } catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }), true }
    const manifest = body?.manifest
    const opId = String(body?.opId || '')
    const baseRevision = Number(body?.baseRevision ?? 0)
    if (!manifest || !opId) return sendJSON(res, 400, { ok: false, error: '缺少 manifest 或 opId' }), true

    // 配额：按「提交后该项目对象字节」估算，超出直接拒（不写半套）
    const incoming = (manifest.objects || []).reduce((n, o) => n + Number(o.bytes || 0), 0)
      + (manifest.assets || []).reduce((n, a) => n + Number(a.bytes || 0), 0)
    const projected = accountUsedBytes(idx) - projectBytes(idx, pid) + incoming
    if (projected > user.quotaBytes) {
      return sendJSON(res, 413, {
        ok: false, code: 'QUOTA_EXCEEDED',
        error: '云端空间不足，本版未提交',
        usedBytes: accountUsedBytes(idx), quotaBytes: user.quotaBytes, projectedBytes: projected,
      }), true
    }

    const r = commitProjectSnapshot({ root: storeRoot, pid, accountId, opId, baseRevision, manifest })
    if (!r.ok) {
      const status = r.code === 'FORBIDDEN' ? 403
        : r.code === 'BASELINE_MISMATCH' || r.code === 'EPOCH_STALE' || r.code === 'PROTOCOL_UNSUPPORTED' ? 409
          : r.code === 'OBJECT_MISSING' ? 400 : 400
      return sendJSON(res, status, {
        ok: false, code: r.code, error: codeText(r.code), revision: r.revision, missing: r.missing,
      }), true
    }

    // 成功后更新索引（配额与列表都读它）
    idx.projects[pid] = {
      name: idx.projects[pid]?.name || manifest.project?.name || '',
      revision: r.revision, snapshotId: r.snapshotId, updatedAt: Date.now(), objectBytes: incoming,
    }
    writeIndex(v2Root, accountId, idx)
    return sendJSON(res, 200, {
      ok: true, revision: r.revision, snapshotId: r.snapshotId, replayed: !!r.replayed,
      usedBytes: accountUsedBytes(idx), quotaBytes: user.quotaBytes,
    }), true
  }

  // ---- GET /api/v2/projects/:pid/ops/:opId —— 回执查询（客户端超时后用） ----
  if (seg.length === 4 && seg[2] === 'ops' && req.method === 'GET') {
    const opId = seg[3]
    const st = readIndex(v2Root, accountId).projects[pid]
    if (!st) return sendJSON(res, 404, { ok: false, error: '云端作品不存在' }), true
    // 幂等表在 projectStore 的 state 里；这里只回「当前 revision」，
    // 具体 opId 命中与否由客户端重放 commit 得到（replayed=true），避免再暴露一份内部表
    return sendJSON(res, 200, { ok: true, opId, revision: st.revision, snapshotId: st.snapshotId }), true
  }

  // ---- DELETE /api/v2/projects/:pid —— 删除（写墓碑，不删目录） ----
  if (seg.length === 2 && req.method === 'DELETE') {
    const opId = String(qs.get('opId') || '')
    if (!opId) return sendJSON(res, 400, { ok: false, error: '缺少 opId' }), true
    const r = deleteProject({ root: storeRoot, pid, accountId, opId })
    if (!r.ok) return sendJSON(res, r.code === 'FORBIDDEN' ? 403 : 400, { ok: false, code: r.code, error: codeText(r.code) }), true
    idx.projects[pid] = { ...idx.projects[pid], revision: r.revision, snapshotId: r.snapshotId, deletedAt: Date.now() }
    writeIndex(v2Root, accountId, idx)
    return sendJSON(res, 200, { ok: true, revision: r.revision }), true
  }

  return sendJSON(res, 405, { ok: false, error: 'Method Not Allowed' }), true
}

function codeText(code) {
  switch (code) {
    case 'BASELINE_MISMATCH': return '云端已有更新的版本，请先拉取再提交'
    case 'EPOCH_STALE': return '服务器数据已迁移或恢复，请重新拉取全部内容'
    case 'OBJECT_MISSING': return '有内容尚未上传完成'
    case 'FORBIDDEN': return '无权访问该云端作品'
    case 'PROTOCOL_UNSUPPORTED': return '客户端协议版本不受支持，请升级软件'
    default: return '提交失败'
  }
}
