// ============ 社区文件初始化标记（3.5.2 · P0-R1） ============
//
// 【为什么需要】comments.json 缺失时，不能只看 post.counts.comments：
//   该计数只包含公开评论，待审、被拒、已删除记录也在评论文件里。
//   没有持久化标记时，「评论文件从未存在」与「评论文件意外丢失」无法区分。
//
// 【标记】`<community>/.yfe-community-meta.json`
//   { version:1, commentsInitialized:boolean, createdAt, updatedAt }
//   · false = 该社区从未写入过评论（缺失 comments.json 是安全的）
//   · true  = 已写入过评论（再缺失即视为丢失，拒绝启动/备份）
//   标记不进备份文件集合；恢复后 comments.json 存在，会自动补 true。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJSONOr } from './atomic.mjs'

export const COMMUNITY_META_FILE = '.yfe-community-meta.json'

export function communityMetaPath(root) {
  return join(root, COMMUNITY_META_FILE)
}

/** 读取标记；缺失/损坏返回 null（未知，不能当成安全） */
export function readCommunityMeta(root, readText = (p) => readFileSync(p, 'utf8')) {
  const abs = communityMetaPath(root)
  if (!existsSync(abs)) return null
  const r = readJSONOr(abs, readText)
  if (!r.ok || !r.value || typeof r.value !== 'object') return null
  if (r.value.commentsInitialized !== true && r.value.commentsInitialized !== false) return null
  return r.value
}

export function writeCommunityMeta(root, meta, writeText) {
  const payload = {
    version: 1,
    commentsInitialized: meta.commentsInitialized === true,
    createdAt: Number(meta.createdAt) || Date.now(),
    updatedAt: Date.now(),
    ...(meta.adoptedAt ? { adoptedAt: meta.adoptedAt } : {}),
  }
  writeText(communityMetaPath(root), JSON.stringify(payload, null, 2))
}

/**
 * 评论文件缺失的安全判定。
 * @param {{present:string[], postsItems:object, meta:object|null}} input
 * @returns {{ok:true, reason:string}|{ok:false, code:string, message:string}}
 */
export function commentsFileVerdict({ present, postsItems, meta }) {
  const set = new Set(present)
  if (set.has('comments.json')) return { ok: true, reason: 'present' }

  if (!set.has('posts.json')) {
    if (meta && meta.commentsInitialized === true) {
      return {
        ok: false,
        code: 'COMMENTS_FILE_LOST',
        message: 'comments.json 曾初始化但当前社区核心文件缺失，视为评论数据丢失；请停写并从备份恢复，禁止按首次使用补空',
      }
    }
    if (set.size === 0) return { ok: true, reason: 'first-init' }
    return { ok: false, code: 'POSTS_FILE_MISSING', message: '社区核心文件 posts.json 缺失（目录中仍有其他社区数据），拒绝检查/备份' }
  }

  const postCount = Object.keys(postsItems || {}).length
  if (meta && meta.commentsInitialized === true) {
    return {
      ok: false,
      code: 'COMMENTS_FILE_LOST',
      message: 'comments.json 曾初始化但当前缺失，视为评论数据丢失；请停写并从备份恢复，禁止用空表继续写入',
    }
  }
  if (postCount === 0) {
    return { ok: true, reason: 'empty-community' }
  }
  if (meta && meta.commentsInitialized === false) {
    const commentRefs = Object.values(postsItems || {})
      .reduce((n, post) => n + (Number(post?.counts?.comments) || 0), 0)
    if (commentRefs > 0) {
      return {
        ok: false,
        code: 'COMMENTS_METADATA_CONFLICT',
        message: '初始化标记显示从未写入评论，但帖子计数显示存在评论；状态不可证明安全，请停写并核对来源',
      }
    }
    return { ok: true, reason: 'never-initialized' }
  }
  return {
    ok: false,
    code: 'COMMENTS_FILE_UNVERIFIED',
    message: 'comments.json 缺失且无法证明该社区从未写入过评论；请停写、核对历史备份/来源后使用 `node server/community-backup.mjs adopt-empty-comments --data <dir> --confirm-adopt-empty`（仅在确认从未有评论时）',
  }
}