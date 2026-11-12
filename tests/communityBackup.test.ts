// ============ 投稿广场 · 备份 / 校验 / 恢复 / 存储故障（3.5.2）============
//
// 守的是 P0-3 的**隔离证据**：
//   ① 备份 8 个文件 + 清单（哈希/大小/统计），清单不含正文；
//   ② 结构损坏、哈希篡改、文件缺失、计数漂移 -> 校验拒绝；
//   ③ 备份写失败 / 模拟进程中断 -> live 不变、不产生正式备份目录；
//   ④ 恢复前校验与当前可见性差异；未显式接受 -> 不覆盖（防静默重新公开）；
//   ⑤ 恢复失败 -> 回滚 live，并保留 pre-restore 副本；
//   ⑥ 存储层写失败后缓存不残留未落盘数据；核心文件丢失不被当作空社区。
//
// ?? 这是本地文件系统 + 合成数据；不是生产备份、断电持久性或真实多设备演练。
//    atomic rename 只证明「单文件不撕裂」，不证明断电后一定落盘（未 fsync）。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  COMMUNITY_FILES, createBackup, defaultIO, diffVisibility, inspectCommunity, restoreBackup, verifyBackup,
} from '../server/lib/communityBackup.mjs'
import { writeTextAtomicSync } from '../server/lib/atomic.mjs'
import { createCommunityStore } from '../server/lib/communityStore.mjs'

let pass = 0
function ok(name: string, cond: boolean, extra = '') {
  assert.ok(cond, `${name}${extra ? ' :: ' + extra : ''}`)
  pass++
  console.log('PASS ' + name)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-community-backup-'))
const live = path.join(root, 'community')
const backupRoot = path.join(root, 'backups')
fs.mkdirSync(live)
fs.mkdirSync(backupRoot)

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}
function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function readLivePosts() {
  return readJson(path.join(live, 'posts.json')).items
}

function syntheticData() {
  const v = (vid: string, title: string, createdAt: number) => ({ vid, title, body: `合成正文 ${title}`, tags: ['短篇'], createdAt })
  return {
    'posts.json': {
      version: 1,
      items: {
        p1: {
          id: 'p1', uid: 'u1', status: 'published', display: 'anonymous',
          publishedVersionId: 'v1', pendingVersionId: '',
          versions: [v('v1', '公开稿', 1)], counts: { up: 1, down: 0, comments: 3 },
          createdAt: 1, updatedAt: 5,
        },
        p2: {
          id: 'p2', uid: 'u1', status: 'pending', display: 'nickname',
          publishedVersionId: '', pendingVersionId: 'v2',
          versions: [v('v2', '待审稿', 2)], counts: { up: 0, down: 0, comments: 0 },
          createdAt: 2, updatedAt: 6,
        },
        p3: {
          id: 'p3', uid: 'u3', status: 'removed', display: 'anonymous',
          publishedVersionId: 'v3', pendingVersionId: '', removedAt: 9,
          versions: [v('v3', '已下架稿', 3)], counts: { up: 0, down: 0, comments: 1 },
          createdAt: 3, updatedAt: 9,
        },
      },
    },
    'comments.json': {
      version: 1,
      items: {
        c1: { id: 'c1', postId: 'p1', uid: 'u2', body: '公开评论一', status: 'visible', createdAt: 10 },
        c2: { id: 'c2', postId: 'p1', uid: 'u2', body: '待审评论', status: 'pending', createdAt: 11 },
        c3: { id: 'c3', postId: 'p1', uid: 'u3', body: '公开评论二', status: 'visible', createdAt: 12 },
        c4: { id: 'c4', postId: 'p1', uid: 'u3', body: '已删除评论', status: 'removed', createdAt: 13 },
        c5: { id: 'c5', postId: 'p3', uid: 'u2', body: '下架稿的评论', status: 'visible', createdAt: 14 },
      },
    },
    'votes.json': {
      version: 1,
      items: { 'p1::u2': { postId: 'p1', uid: 'u2', value: 1, updatedAt: 15 } },
    },
    'reports.json': {
      version: 1,
      items: {
        r1: { id: 'r1', kind: 'report', uid: 'u2', targetType: 'post', targetId: 'p1', status: 'open', createdAt: 16, reason: '测试' },
        r2: { id: 'r2', kind: 'appeal', uid: 'u1', targetType: 'post', targetId: 'p2', status: 'open', createdAt: 17, reason: '申诉' },
        r3: { id: 'r3', kind: 'report', uid: 'u2', targetType: 'post', targetId: 'p_gone', status: 'closed', createdAt: 18, reason: '孤儿' },
      },
    },
    'profiles.json': {
      version: 1,
      items: { u1: { nickname: '作者甲', postDisplay: 'anonymous', commentDisplay: 'anonymous', rankDisplay: 'anonymous', updatedAt: 1 } },
    },
    'rank.json': {
      version: 1,
      items: { 'u1::dev::proj::2026-11-12': { uid: 'u1', deviceId: 'dev', projectId: 'proj', date: '2026-11-12', netDelta: 1200 } },
    },
    'audit.json': {
      version: 1,
      items: { list: [{ id: 'a1', actorRole: 'moderator', action: 'post.approve', targetType: 'post', targetId: 'p1', at: 19 }] },
    },
    'state.json': {
      version: 1,
      items: { global: { squareOpen: true, postsOpen: true, commentsOpen: true, updatedAt: 20 } },
    },
  }
}

function writeLive(data: Record<string, any> = syntheticData()) {
  for (const file of COMMUNITY_FILES) writeJson(path.join(live, file), data[file])
  return data
}

try {
  writeLive()

  // ---- 1. 检查：结构通过，计数漂移被识别为可重算（live 不改） ----
  const inspected = inspectCommunity(live)
  ok('合成快照结构与关联通过', inspected.ok)
  ok('识别计数漂移（p1 评论 3 -> 2）', inspected.repairs.length === 1 && inspected.repairs[0].field === 'comments' && inspected.repairs[0].to === 2)
  ok('检查不改写 live', readLivePosts().p1.counts.comments === 3)
  ok('孤儿举报只作为警告保留', inspected.warnings.some((w: string) => w.includes('p_gone')))
  ok('统计包含 3 篇投稿 / 5 条评论', inspected.counts.posts === 3 && inspected.counts.comments === 5)

  // ---- 2. 备份：哈希、清单、正文不外泄 ----
  const b1 = path.join(backupRoot, 'community-20261112-000001')
  const made = createBackup({ root: live, dest: b1 })
  ok('创建备份成功', made.ok, JSON.stringify(made))
  for (const file of COMMUNITY_FILES) ok(`备份包含 ${file}`, fs.existsSync(path.join(b1, file)))
  const manifestText = fs.readFileSync(path.join(b1, 'manifest.json'), 'utf8')
  ok('清单不含正文内容', !manifestText.includes('合成正文') && !manifestText.includes('公开评论一'))
  const manifest = JSON.parse(manifestText)
  ok('清单记录计数与重算', manifest.counts.posts === 3 && manifest.repairs.length === 1)
  ok('清单记录每个文件哈希', Object.values(manifest.files).every((m: any) => /^[0-9a-f]{64}$/.test(m.sha256)))
  const v1 = verifyBackup(b1)
  ok('备份自校验通过', v1.ok, JSON.stringify(v1.problems || []))
  ok('备份内计数已重算为一致', v1.data['posts.json'].items.p1.counts.comments === 2)
  ok('live 计数仍是修复前值（备份不改 live）', readLivePosts().p1.counts.comments === 3)

  // ---- 3. 校验拒绝：篡改 / 缺文件 / 结构损坏 ----
  const bTamper = path.join(backupRoot, 'community-20261112-000002')
  fs.cpSync(b1, bTamper, { recursive: true })
  const tampered = readJson(path.join(bTamper, 'posts.json'))
  tampered.items.p1.versions[0].body = '被篡改的正文'
  writeJson(path.join(bTamper, 'posts.json'), tampered)
  const vTamper = verifyBackup(bTamper)
  ok('正文被篡改 -> 哈希校验失败', !vTamper.ok && vTamper.problems.some((p: string) => p.includes('哈希不符')))
  fs.rmSync(bTamper, { recursive: true, force: true })

  const bMissing = path.join(backupRoot, 'community-20261112-000003')
  fs.cpSync(b1, bMissing, { recursive: true })
  fs.rmSync(path.join(bMissing, 'comments.json'))
  const vMissing = verifyBackup(bMissing)
  ok('备份缺文件 -> 拒绝', !vMissing.ok && vMissing.problems.some((p: string) => p.includes('缺少文件')))
  fs.rmSync(bMissing, { recursive: true, force: true })

  const bBroken = path.join(backupRoot, 'community-20261112-000004')
  fs.cpSync(b1, bBroken, { recursive: true })
  const broken = readJson(path.join(bBroken, 'comments.json'))
  broken.items = []
  writeJson(path.join(bBroken, 'comments.json'), broken)
  const vBroken = verifyBackup(bBroken)
  ok('结构损坏 -> 拒绝', !vBroken.ok)
  fs.rmSync(bBroken, { recursive: true, force: true })

  // ---- 4. 写失败 / 模拟进程中断：不产生正式备份、live 不变 ----
  const bFail = path.join(backupRoot, 'community-20261112-000005')
  const failIO = {
    ...defaultIO,
    writeText: (p: string, t: string) => {
      if (p.endsWith('posts.json')) throw new Error('ENOSPC: 模拟磁盘写满')
      defaultIO.writeText(p, t)
    },
  }
  const failed = createBackup({ root: live, dest: bFail, io: failIO })
  ok('模拟写盘失败 -> 备份失败', !failed.ok && String(failed.error).includes('ENOSPC'))
  ok('写失败不留下正式备份目录', !fs.existsSync(bFail))
  ok('写失败清理临时目录', fs.readdirSync(backupRoot).every((n) => !n.startsWith('community-20261112-000005.tmp-')))
  ok('写失败不影响 live', readLivePosts().p1.status === 'published')

  const bCrash = path.join(backupRoot, 'community-20261112-000006')
  let writes = 0
  const crashIO = {
    ...defaultIO,
    writeText: (p: string, t: string) => {
      writes++
      if (writes === 3) throw new Error('模拟进程中断')
      defaultIO.writeText(p, t)
    },
  }
  const crashed = createBackup({ root: live, dest: bCrash, io: crashIO })
  ok('模拟进程中断 -> 备份失败且无正式目录', !crashed.ok && !fs.existsSync(bCrash))
  ok('中断后 live 仍完整可读', inspectCommunity(live).ok)

  // ---- 5. 恢复：可见性差异必须显式接受 ----
  const current = readJson(path.join(live, 'posts.json'))
  current.items.p1.status = 'removed'
  current.items.p1.removedAt = Date.now()
  current.items.p1.counts.comments = 3
  writeJson(path.join(live, 'posts.json'), current)
  const commentsNow = readJson(path.join(live, 'comments.json'))
  commentsNow.items.c6 = { id: 'c6', postId: 'p1', uid: 'u2', body: '恢复前新增评论', status: 'visible', createdAt: 30 }
  writeJson(path.join(live, 'comments.json'), commentsNow)

  const diff = diffVisibility(inspectCommunity(live).data, verifyBackup(b1).data)
  ok('差异报告识别「会重新公开已下架稿」', diff.some((c: any) => c.type === 'would-republish' && c.postId === 'p1'))

  const refused = restoreBackup({ backupDir: b1, root: live, stopConfirmed: true })
  ok('未接受可见性变化 -> 拒绝恢复', !refused.ok && refused.code === 'VISIBILITY_CHANGES' && refused.changes.length > 0)
  ok('拒绝恢复时 live 保持原样', readLivePosts().p1.status === 'removed')

  const wrongStop = restoreBackup({ backupDir: b1, root: live })
  ok('未确认停写 -> 拒绝恢复', !wrongStop.ok && wrongStop.code === 'STOP_REQUIRED')

  // ---- 6. 正确恢复：pre-restore 保留当前证据，状态回到备份时点 ----
  const restored = restoreBackup({ backupDir: b1, root: live, stopConfirmed: true, acceptVisibilityChanges: true })
  ok('显式接受后恢复成功', restored.ok, JSON.stringify(restored))
  const postsAfter = readLivePosts()
  ok('恢复后公开稿回到备份时点', postsAfter.p1.status === 'published' && postsAfter.p1.counts.comments === 2)
  ok('恢复后备审稿仍待审', postsAfter.p2.status === 'pending')
  ok('恢复后已下架稿仍不可见', postsAfter.p3.status === 'removed' && postsAfter.p3.removedAt === 9)
  ok('恢复后新增评论不在 live（快照时点）', !readJson(path.join(live, 'comments.json')).items.c6)
  ok('恢复后计数一致', inspectCommunity(live).ok && inspectCommunity(live).repairs.length === 0)
  ok('生成恢复前副本', !!restored.preRestoreDir && fs.existsSync(restored.preRestoreDir))
  const pre = readJson(path.join(restored.preRestoreDir, 'posts.json'))
  ok('恢复前副本保留「当前已下架」证据', pre.items.p1.status === 'removed' && pre.items.p1.removedAt > 0)
  ok('恢复前副本保留恢复前新增评论', !!readJson(path.join(restored.preRestoreDir, 'comments.json')).items.c6)
  ok('不留下恢复临时目录', fs.readdirSync(root).every((n) => !n.startsWith('community.restore-')))

  // ---- 7. 损坏备份恢复：拒绝且不覆盖 ----
  const beforeBad = fs.readFileSync(path.join(live, 'posts.json'), 'utf8')
  const bBad = path.join(backupRoot, 'community-20261112-000007')
  fs.cpSync(b1, bBad, { recursive: true })
  fs.writeFileSync(path.join(bBad, 'posts.json'), '{"version":1,"items":[]}', 'utf8')
  const badRestore = restoreBackup({ backupDir: bBad, root: live, stopConfirmed: true, acceptVisibilityChanges: true })
  ok('损坏备份恢复被拒', !badRestore.ok && badRestore.code === 'BACKUP_INVALID')
  ok('损坏备份不覆盖 live', fs.readFileSync(path.join(live, 'posts.json'), 'utf8') === beforeBad)

  // ---- 8. 恢复切换中断：回滚 live，保留 pre-restore ----
  const b2 = path.join(backupRoot, 'community-20261112-000008')
  ok('准备第二份备份', createBackup({ root: live, dest: b2 }).ok)
  const cur2 = readJson(path.join(live, 'posts.json'))
  cur2.items.p2.status = 'rejected'
  writeJson(path.join(live, 'posts.json'), cur2)
  const beforeInterrupt = fs.readFileSync(path.join(live, 'posts.json'), 'utf8')
  const restoreFailIO = {
    ...defaultIO,
    rename: (a: string, b: string) => {
      if (a.includes('.restore-') && b === live) throw new Error('模拟切换中断')
      defaultIO.rename(a, b)
    },
  }
  const interrupted = restoreBackup({
    backupDir: b2, root: live, stopConfirmed: true, acceptVisibilityChanges: true, io: restoreFailIO,
  })
  ok('恢复切换中断 -> 返回失败', !interrupted.ok && interrupted.code === 'RESTORE_FAILED')
  ok('切换中断后 live 回滚为中断前内容', fs.readFileSync(path.join(live, 'posts.json'), 'utf8') === beforeInterrupt)
  ok('切换中断保留 pre-restore', !!interrupted.preRestoreDir && fs.existsSync(interrupted.preRestoreDir))
  ok('切换中断不留 .restore- 临时目录', fs.readdirSync(root).every((n) => !n.startsWith('community.restore-')))

  // ---- 9. 存储层：写失败不得留下幽灵缓存 ----
  const storeRoot = path.join(root, 'store-write-fail')
  fs.mkdirSync(storeRoot)
  let failWrites = false
  const store = createCommunityStore({
    root: storeRoot,
    writeText: (p: string, t: string) => {
      if (failWrites) throw new Error('ENOSPC')
      writeTextAtomicSync(p, t)
    },
  })
  const post = { id: 'sp1', uid: 'u1', status: 'draft', display: 'anonymous' as const, publishedVersionId: '', pendingVersionId: '', versions: [], counts: { up: 0, down: 0, comments: 0 }, createdAt: 1, updatedAt: 1 }
  store.putPost(post)
  failWrites = true
  let threw = false
  try { store.putPost({ ...post, status: 'pending' }) } catch { threw = true }
  ok('写盘失败时 putPost 抛错', threw)
  ok('写盘失败后读回磁盘旧值（无幽灵缓存）', store.getPost('sp1')?.status === 'draft')
  failWrites = false

  // ---- 10. 核心文件丢失不被当作空社区 ----
  const broken1 = path.join(root, 'broken-no-posts')
  fs.mkdirSync(broken1)
  writeJson(path.join(broken1, 'comments.json'), { version: 1, items: {} })
  let noPostsThrew = false
  try { createCommunityStore({ root: broken1 }) } catch { noPostsThrew = true }
  ok('posts.json 丢失但还有其他社区文件 -> 拒绝启动', noPostsThrew)

  const broken2 = path.join(root, 'broken-no-comments')
  fs.mkdirSync(broken2)
  writeJson(path.join(broken2, 'posts.json'), { version: 1, items: { p1: { id: 'p1', uid: 'u1', status: 'published', versions: [], counts: { up: 0, down: 0, comments: 2 } } } })
  let noCommentsThrew = false
  try { createCommunityStore({ root: broken2 }) } catch { noCommentsThrew = true }
  ok('帖子计数显示有评论但 comments.json 丢失 -> 拒绝启动', noCommentsThrew)

  const fresh = path.join(root, 'fresh')
  fs.mkdirSync(fresh)
  const freshStore = createCommunityStore({ root: fresh })
  ok('真正的空目录仍可首次使用', freshStore.counts().posts === 0 && freshStore.getState().squareOpen === true)

  // ---- 11. 单文件原子写：失败不撕裂目标 ----
  const atomicDir = path.join(root, 'atomic')
  fs.mkdirSync(atomicDir)
  const targetDir = path.join(atomicDir, 'target.json')
  fs.mkdirSync(targetDir)
  let atomicThrew = false
  try { writeTextAtomicSync(targetDir, '{"x":1}') } catch { atomicThrew = true }
  ok('原子写目标不可替换时抛错', atomicThrew)
  ok('原子写失败后目标目录仍在', fs.statSync(targetDir).isDirectory())
  ok('原子写失败后不残留 .tmp（本文件）', fs.readdirSync(atomicDir).every((n) => !n.startsWith('target.json.') || !n.endsWith('.tmp')))

  console.log(`communityBackup: ${pass} passed, 0 failed`)
} finally {
  const target = fs.realpathSync(root)
  if (path.dirname(target) !== fs.realpathSync(os.tmpdir()) || !path.basename(target).startsWith('yfe-community-backup-')) {
    throw new Error('拒绝清理不安全的测试目录')
  }
  fs.rmSync(target, { recursive: true, force: true })
}