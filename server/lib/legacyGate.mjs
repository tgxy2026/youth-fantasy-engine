// ============ 3.3.2 · 旧路径门禁（数据世代）============
//
// 【它挡什么】3.3.1 及之前的客户端只会走两条写路径：
//   · `PUT/POST /api/data` —— 整库覆盖（一次写全部作品）
//   · `PUT/DELETE /api/blob` —— 单据 store（备份载荷 / 向量 / 知识库）
// 这两条都没有「项目级」概念。一旦某账号的作品迁到 v2 项目级协议，旧客户端再走整库覆盖
// 就会把新结构整片抹掉 —— 而且是**静默**抹掉：它自己以为保存成功。
//
// 【为什么不直接关掉接口】旧客户端还在用（3.3.1 的网页版、便携版）。直接 404 会让它们
// 连「导出走人」都做不到。所以门禁只关**写**，读与导出照常 —— 用户升级前仍能把自己
// 的东西带走，这是数据安全与可迁移性之间必须保住的那一边。
//
// 【门禁凭什么开】按账号、按运维动作开启（迁移完成后）。不是「代码发布即全局禁止」：
//   一次全局开启会让所有还没迁移的账号立刻写不进去，那是事故不是保护。
//   另有 `YFE_LEGACY_WRITE=block` 作为事故时的**全局急停**（迁移中途发现异常，先把所有旧写停掉）。
//
// 🔴 门禁状态与 v2 数据放同一棵树（`<DATA_DIR>/v2/accounts/<acc>/legacy-gate.json`）：
//    迁移、备份、恢复都按账号目录走，门禁跟着账号走才不会出现「数据搬了、门禁没搬」。
import fs from 'node:fs'
import path from 'node:path'

export const LEGACY_GATE_FILE = 'legacy-gate.json'

const accountRoot = (v2Root, accountId) => path.join(v2Root, 'accounts', accountId)
const gateFile = (v2Root, accountId) => path.join(accountRoot(v2Root, accountId), LEGACY_GATE_FILE)

/** 全局急停：`YFE_LEGACY_WRITE=block` 时所有账号一律禁写 */
export function globalLegacyBlock() {
  return String(process.env.YFE_LEGACY_WRITE || '').toLowerCase() === 'block'
}

/**
 * 读门禁状态。
 * @returns {{ blocked: boolean, reason: string, at: number, source: 'account'|'global'|'none' }}
 */
export function readLegacyGate(v2Root, accountId, now = Date.now()) {
  if (globalLegacyBlock()) {
    return { blocked: true, reason: '服务器正在迁移云端数据，旧版写入已暂停', at: now, source: 'global' }
  }
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(gateFile(v2Root, accountId), 'utf8')) } catch { /* 没有就是没开 */ }
  if (!raw || raw.blocked !== true) return { blocked: false, reason: '', at: 0, source: 'none' }
  return { blocked: true, reason: String(raw.reason || '你的云端数据已升级，旧版写入已停用'), at: Number(raw.at) || 0, source: 'account' }
}

export function isLegacyWriteBlocked(v2Root, accountId) {
  return readLegacyGate(v2Root, accountId).blocked
}

/**
 * 开启门禁（迁移完成后调用）。
 * @param {string} note 这条会原样显示给旧客户端用户，用**人话**写，别写内部术语
 */
export function blockLegacyWrites(v2Root, accountId, { note = '', now = Date.now() } = {}) {
  const dir = accountRoot(v2Root, accountId)
  fs.mkdirSync(dir, { recursive: true })
  const file = gateFile(v2Root, accountId)
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify({
    blocked: true, at: now,
    reason: note || '你的云端数据已升级到项目级同步，旧版写入已停用。请更新到新版客户端后继续编辑；旧数据仍可导出。',
  }))
  fs.renameSync(tmp, file)
}

/** 解除门禁（回滚用）。保留审计痕迹：不删文件，改成 blocked:false + 时间 */
export function unblockLegacyWrites(v2Root, accountId, { note = '', now = Date.now() } = {}) {
  const dir = accountRoot(v2Root, accountId)
  fs.mkdirSync(dir, { recursive: true })
  const file = gateFile(v2Root, accountId)
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify({ blocked: false, at: now, note }))
  fs.renameSync(tmp, file)
}

/** 门禁违规时统一的响应体（前端/旧客户端按 code 分流文案） */
export function legacyBlockedPayload(gate) {
  return {
    ok: false,
    code: 'LEGACY_WRITE_BLOCKED',
    error: gate.reason,
    // 明确告诉调用方「还能做什么」，否则用户只会看到一句"保存失败"
    hint: '你仍可读取与导出数据；升级到新版客户端后可继续正常保存。',
    at: gate.at || undefined,
  }
}
