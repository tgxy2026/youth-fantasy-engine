// ============ 投稿广场 · 缓存文档引擎（JSON 读-改-写 + 失败关闭） ============
//
// 【为什么抽出来】createCommunityStore 原先把「文件访问 + mtime 缓存 + 失败关闭守卫」与
//   业务操作（投稿/评论/投票/举报/档案/排行/审计）混在同一工厂里（3.5.3 规划 §P1-C）。
//   本模块是其中的**文档存取引擎**：load/save/mutate + 启动完整性检查；业务操作只经 load/mutate 取用。
//   I/O 原语（atomic）、初始化标记（communityFiles）、协作锁（communityLock）本就是叶子模块，这里只把它们组装起来。
//
// 🔴 行为与外抽前逐字一致：
//   · 一次写 = 一个文件的一次同步「读-改-写」（Node 单线程下即互斥）；调用方不得在两次写之间 await 后写回旧快照。
//   · 核心文件 posts.json 缺失（目录仍有其他社区文件）→ 拒绝启动 / 运行期拒绝写。
//   · comments.json 缺失靠初始化标记 + commentsFileVerdict 判定，不能当空表写回。
//   · 损坏文件必须炸（当空表写回 = 全站投稿蒸发）。
//   · 写失败或 fn 抛错 → 丢缓存（否则读到从未落盘的「幽灵数据」）。
//   · 评论写入前先把标记持久化为 true（strict），任一步中断宁可启动失败关闭。
//   · 备份/恢复协作锁（isCommunityLocked）期间拒绝写入。
// 🔴 I/O 经 readText/writeText 注入（故障注入测试用）；本模块是叶子，不反向依赖 communityStore（无 import 环）。
// 🔴 所有文件都带 version，不认识的结构直接抛错，不静默重建空表；磁盘格式与外抽前完全相同。

import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJSONOr } from './atomic.mjs'
import { readCommunityMeta, writeCommunityMeta, commentsFileVerdict } from './communityFiles.mjs'
import { isCommunityLocked } from './communityLock.mjs'

function emptyMap() {
  return { version: 1, items: {} }
}

/**
 * @param {{
 *   root:string,
 *   files:Record<string,string>,
 *   readText:(abs:string)=>string,
 *   writeText:(abs:string,text:string)=>void,
 *   defaultState:object,
 * }} opts root 即 `<DATA_DIR>/community`；files 为各 store 的文件名表；defaultState 为 state.json 缺省值。
 *   readText/writeText 由 createCommunityStore 透传（默认原子写 + 同步读，故障注入测试可替换）。
 */
export function createCommunityDocStore({ root, files, readText, writeText, defaultState }) {
  /** 目录中实际存在的社区数据文件（用于区分「首次使用」与「文件意外丢失」） */
  function presentFiles() {
    try { return new Set(readdirSync(root).filter((n) => Object.values(files).includes(n))) }
    catch { return new Set() }
  }

  /**
   * 把初始化标记改为指定状态。
   * strict=true：标记写入失败必须抛出，不能把“评论已写入但标记仍为 false”报告为成功；
   * strict=false：首次使用的 false 标记写失败不阻断已有可读数据（无评论数据时安全）。
   */
  function ensureMeta(commentsInitialized, { strict = false } = {}) {
    try {
      const meta = readCommunityMeta(root, readText)
      if (meta && meta.commentsInitialized === commentsInitialized) return
      writeCommunityMeta(root, {
        commentsInitialized,
        createdAt: meta?.createdAt || Date.now(),
      }, writeText)
    } catch (e) {
      if (!strict) return
      const err = new Error(`评论初始化标记写入失败，拒绝确认本次评论写入：${e instanceof Error ? e.message : String(e)}`)
      err.code = 'COMMENTS_META_WRITE_FAILED'
      err.cause = e
      throw err
    }
  }

  /**
   * 启动期完整性检查：
   *  - posts.json 丢失、但目录里还有其他社区文件 -> 拒绝启动；
   *  - comments.json 缺失时不能只看公开计数：待审/被拒/已删除评论也在文件里。
   *    有初始化标记且为 true -> 视为丢失；标记缺失且帖子非空 -> 状态不可证明，拒绝启动并给出核对路径。
   */
  let commentsObserved = false
  function assertCoreFiles() {
    const present = presentFiles()
    if (!present.has(files.posts) && present.size > 0) {
      throw new Error('社区核心文件 posts.json 缺失（目录中仍有其他社区数据）；请停写并从备份恢复，禁止用空表继续写入')
    }
    if (!present.has(files.posts)) {
      const meta = readCommunityMeta(root, readText)
      if (meta?.commentsInitialized === true) {
        throw new Error('comments.json 曾初始化但当前社区核心文件缺失，视为评论数据丢失；请停写并从备份恢复，禁止按首次使用补空')
      }
      if (present.size === 0 && !meta) ensureMeta(false) // 首次使用：显式记录「从未写入评论」
      return
    }
    if (present.has(files.comments)) {
      commentsObserved = true
      ensureMeta(true, { strict: true })
      return
    }

    const r = readJSONOr(join(root, files.posts), readText)
    if (!r.ok) return // 损坏会由 load() 给出更明确的错误
    const verdict = commentsFileVerdict({
      present: [...present],
      postsItems: r.value?.items || {},
      meta: readCommunityMeta(root, readText),
    })
    if (!verdict.ok) throw new Error(verdict.message)
    ensureMeta(false)
  }

  // mtime 缓存：只对本进程读频繁的小文件生效；写后立即更新，避免读到旧内容
  const cache = new Map()
  function fileOf(key) {
    return join(root, files[key])
  }
  function commentsError(code, message) {
    const e = new Error(message)
    e.code = code
    return e
  }
  function load(key) {
    const abs = fileOf(key)
    let mtime = 0
    try { mtime = statSync(abs).mtimeMs } catch { mtime = 0 }
    const hit = cache.get(key)
    if (hit && hit.mtime === mtime && mtime !== 0) {
      if (key === 'comments') commentsObserved = true
      return hit.value
    }

    const r = readJSONOr(abs, readText)
    if (r.ok) {
      const value = r.value
      if (!value || typeof value !== 'object' || typeof value.items !== 'object' || !value.items) {
        throw new Error(`社区数据文件结构无效：${files[key]}`)
      }
      cache.set(key, { mtime, value })
      if (key === 'comments') commentsObserved = true
      return value
    }
    if (r.missing) {
      // 运行期间 posts.json 被误删：不能当成空社区继续写
      if (key === 'posts' && presentFiles().size > 0) {
        throw new Error('社区核心文件 posts.json 在运行期间缺失；请停写并从备份恢复')
      }
      if (key === 'comments') {
        if (commentsObserved) {
          throw commentsError('COMMUNITY_COMMENTS_LOST', '评论文件在运行期间缺失；本进程已读取过评论，禁止把缺失当成空表或写回覆盖')
        }
        const present = [...presentFiles()]
        const posts = readJSONOr(join(root, files.posts), readText)
        const verdict = commentsFileVerdict({
          present,
          postsItems: posts.ok ? (posts.value?.items || {}) : {},
          meta: readCommunityMeta(root, readText),
        })
        if (!verdict.ok) throw commentsError(verdict.code || 'COMMENTS_FILE_UNVERIFIED', verdict.message)
      }
      const value = key === 'state' ? { ...defaultState, items: {} } : emptyMap()
      cache.set(key, { mtime: 0, value })
      return value
    }
    // 🔴 损坏必须炸：把损坏文件当空表写回 = 全站投稿蒸发
    throw new Error(`社区数据文件损坏（${files[key]}）：${r.error}`)
  }
  function save(key, value) {
    try {
      writeText(fileOf(key), JSON.stringify(value, null, 2))
    } catch (e) {
      if (key === 'comments' && e && typeof e === 'object' && !e.code) e.code = 'COMMUNITY_COMMENTS_WRITE_FAILED'
      throw e
    }
    let mtime = 0
    try { mtime = statSync(fileOf(key)).mtimeMs } catch { mtime = 0 }
    cache.set(key, { mtime, value })
    if (key === 'comments') commentsObserved = true
  }

  /**
   * 🔴 写失败或 fn 抛错时必须丢弃缓存：fn 直接改了缓存对象，若写盘失败后继续命中缓存，
   *    读接口会看到从未落盘的「幽灵数据」。丢缓存后下次从磁盘读回旧内容。
   */
  function mutate(key, fn) {
    if (isCommunityLocked(root)) {
      const e = new Error('社区备份/恢复进行中，写入已暂停；请稍后重试')
      e.code = 'COMMUNITY_BACKUP_LOCKED'
      throw e
    }
    const db = load(key)
    try {
      if (key === 'comments') {
        // 🔴 先把标记持久化为 true，再创建/修改评论文件。
        //    任一步中断后宁可启动失败关闭，也不能留下「评论已写入但标记为 false」的状态。
        ensureMeta(true, { strict: true })
        if (!existsSync(fileOf(key))) {
          writeText(fileOf(key), JSON.stringify(db, null, 2))
        }
        commentsObserved = true
      }
      const result = fn(db)
      save(key, db)
      return result
    } catch (e) {
      cache.delete(key)
      throw e
    }
  }

  return { load, save, mutate, assertCoreFiles, presentFiles, ensureMeta, fileOf }
}