// 资料集搬迁内核：把外置目录（`<数据文件目录>/blobs`）整棵搬到新数据文件旁边。
//
// 【为什么要单独成文件】
//   3.2.2 · 审计 C2：`store:setDataPath` 原先**只写主 JSON**，而 `blobRoot()` 跟着数据文件走
//   ⇒ 换完位置后「备份列表还在、点恢复说载荷缺失」，真正的外置文件躺在旧目录。
//   修法本身不难（复制 + 校验 + 校验不过就不切配置），但埋在 `main.cjs` 里**没法单测** ——
//   要跑它就得起整个 Electron。按 `syncPath.cjs` 的先例抽出来：规则可读、可被单测审读。
//
// 【三条硬约束（改之前先看）】
//   ① **不用 `fs.cpSync`**：本项目实测它会连带杀进程（见 MEMORY 环境坑），一律手工递归。
//   ② **失败绝不抛给调用方当"部分成功"**：一律返回 `{ok:false, error}`，由调用方决定不切配置。
//   ③ **逐份校验字节数**：大小不符 = 截断，宁可中止也不切 —— 半份备份比没有更危险
//      （作者以为搬过来了，真恢复时才发现坏了）。
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

/** 外置目录名（与 main.cjs 的 blobRoot() 必须一致） */
const BLOB_DIR = 'blobs'

/**
 * 把 `oldFile` 旁边的 blobs 目录整棵复制到 `newFile` 旁边。
 *
 * @param {string} oldFile 旧数据文件绝对路径
 * @param {string} newFile 新数据文件绝对路径
 * @returns {Promise<{ok: boolean, copied: number, error: string|null}>}
 *   `copied` = 实际复制的文件数（0 表示本来就没有外置数据）。
 *   `ok:false` 时**调用方不许切配置**，原位置一律保持可用。
 */
async function copyBlobsAlong(oldFile, newFile) {
  const src = path.join(path.dirname(String(oldFile)), BLOB_DIR)
  const dst = path.join(path.dirname(String(newFile)), BLOB_DIR)
  // 同一目录（例如从默认位置"迁移"到默认位置）：什么都不用做
  if (path.resolve(src) === path.resolve(dst)) return { ok: true, copied: 0, error: null }
  // 没有外置数据 = 无需搬（全新库 / 从未做过备份）
  if (!fs.existsSync(src)) return { ok: true, copied: 0, error: null }

  /** [相对路径, 字节数]，搬完逐一比对 */
  const expect = []
  try {
    const walk = async (rel) => {
      const abs = rel ? path.join(src, rel) : src
      const entries = await fsp.readdir(abs, { withFileTypes: true })
      for (const ent of entries) {
        const r = rel ? path.join(rel, ent.name) : ent.name
        if (ent.isDirectory()) { await walk(r); continue }
        if (!ent.isFile()) continue
        const from = path.join(src, r)
        const to = path.join(dst, r)
        await fsp.mkdir(path.dirname(to), { recursive: true })
        await fsp.copyFile(from, to)
        expect.push([r, (await fsp.stat(from)).size])
      }
    }
    await walk('')
  } catch (e) {
    return { ok: false, copied: 0, error: String(e && e.message ? e.message : e) }
  }

  // 校验：每份搬过去的文件大小必须与源一致（大小不符 = 截断，宁可中止也不切配置）
  try {
    for (const [rel, size] of expect) {
      const st = await fsp.stat(path.join(dst, rel))
      if (st.size !== size) {
        return {
          ok: false, copied: 0,
          error: `外置文件校验失败：${rel}（应为 ${size} 字节，实际 ${st.size}）`,
        }
      }
    }
  } catch (e) {
    return { ok: false, copied: 0, error: '外置文件校验失败：' + String(e && e.message ? e.message : e) }
  }

  return { ok: true, copied: expect.length, error: null }
}

module.exports = { copyBlobsAlong, BLOB_DIR }
