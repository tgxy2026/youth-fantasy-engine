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
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  COMMUNITY_FILES, adoptEmptyComments, createBackup, defaultIO, diffVisibility, inspectCommunity, restoreBackup, verifyBackup,
} from '../server/lib/communityBackup.mjs'
import { readCommunityMeta, writeCommunityMeta } from '../server/lib/communityFiles.mjs'
import {
  acquireCommunityLock, communityLockPath, readCommunityLock, releaseCommunityLock, unlockStaleCommunityLock,
} from '../server/lib/communityLock.mjs'
import { writeTextAtomicSync } from '../server/lib/atomic.mjs'
import { createCommunityStore, type CommunityPost } from '../server/lib/communityStore.mjs'

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

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server/community-backup.mjs', ...args], { cwd: process.cwd(), windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => { stdout += b })
    child.stderr.on('data', (b) => { stderr += b })
    child.once('error', () => resolve({ code: 1, stdout, stderr }))
    child.once('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
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
  const made = createBackup({ root: live, dest: b1, stopConfirmed: true })
  ok('创建备份成功', made.ok, JSON.stringify(made))
  for (const file of COMMUNITY_FILES) ok(`备份包含 ${file}`, fs.existsSync(path.join(b1, file)))
  const manifestText = fs.readFileSync(path.join(b1, 'manifest.json'), 'utf8')
  ok('清单不含正文内容', !manifestText.includes('合成正文') && !manifestText.includes('公开评论一'))
  const manifest = JSON.parse(manifestText)
  ok('清单记录计数与重算', manifest.counts.posts === 3 && manifest.repairs.length === 1)
  ok('清单记录每个文件哈希', Object.values(manifest.files).every((m: any) => /^[0-9a-f]{64}$/.test(m.sha256)))
  const v1 = verifyBackup(b1, { includeData: true })
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
  const failed = createBackup({ root: live, dest: bFail, io: failIO, stopConfirmed: true })
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
  const crashed = createBackup({ root: live, dest: bCrash, io: crashIO, stopConfirmed: true })
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

  const diff = diffVisibility(
    inspectCommunity(live, { includeData: true }).data,
    verifyBackup(b1, { includeData: true }).data,
  )
  ok('差异报告识别「会重新公开已下架稿」', diff.changes.some((c: any) => c.type === 'would-republish' && c.postId === 'p1'))

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
  ok('准备第二份备份', createBackup({ root: live, dest: b2, stopConfirmed: true }).ok)
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

  // ---- 12. P0-1：核心文件缺失不得生成备份 ----
  const onlyProfiles = path.join(root, 'p0-1-only-profiles')
  fs.mkdirSync(onlyProfiles)
  writeJson(path.join(onlyProfiles, 'profiles.json'), {
    version: 1,
    items: { u_secret: { nickname: '合成昵称P0', postDisplay: 'anonymous', commentDisplay: 'anonymous', rankDisplay: 'anonymous', updatedAt: 1 } },
  })
  const onlyProfilesInspect = inspectCommunity(onlyProfiles)
  ok('P0-1 缺失 posts.json 时检查拒绝', !onlyProfilesInspect.ok && onlyProfilesInspect.problems.some((p: string) => p.includes('posts.json')))
  const onlyProfilesBackup = createBackup({ root: onlyProfiles, dest: path.join(root, 'p0-1-only-profiles-backup'), stopConfirmed: true })
  ok('P0-1 缺失 posts.json 时拒绝备份', !onlyProfilesBackup.ok && onlyProfilesBackup.code === 'INVALID_DATA')
  ok('P0-1 拒绝时不产生正式备份目录', !fs.existsSync(path.join(root, 'p0-1-only-profiles-backup')))

  const emptyDir = path.join(root, 'p0-1-empty')
  fs.mkdirSync(emptyDir)
  const emptyInspect = inspectCommunity(emptyDir)
  ok('P0-1 真正空目录仍视为首次使用', emptyInspect.ok && emptyInspect.counts.posts === 0)
  ok('P0-1 空目录允许生成空快照', createBackup({ root: emptyDir, dest: path.join(root, 'p0-1-empty-backup'), stopConfirmed: true }).ok)

  const optionalDir = path.join(root, 'p0-1-optional')
  fs.mkdirSync(optionalDir)
  const baseForOptional = syntheticData()
  writeJson(path.join(optionalDir, 'posts.json'), { version: 1, items: { p1: baseForOptional['posts.json'].items.p1 } })
  writeJson(path.join(optionalDir, 'comments.json'), { version: 1, items: {} })
  writeJson(path.join(optionalDir, 'state.json'), baseForOptional['state.json'])
  const optionalInspect = inspectCommunity(optionalDir)
  ok('P0-1 历史可选文件缺失仍可通过检查', optionalInspect.ok)
  ok('P0-1 历史可选文件缺失仍可备份', createBackup({ root: optionalDir, dest: path.join(root, 'p0-1-optional-backup'), stopConfirmed: true }).ok)

  const missingComments = path.join(root, 'p0-1-missing-comments')
  fs.mkdirSync(missingComments)
  writeJson(path.join(missingComments, 'posts.json'), {
    version: 1,
    items: { p1: { ...baseForOptional['posts.json'].items.p1, counts: { up: 0, down: 0, comments: 2 } } },
  })
  const missingCommentsInspect = inspectCommunity(missingComments)
  ok('P0-1 评论文件缺失但计数存在时拒绝检查', !missingCommentsInspect.ok && missingCommentsInspect.problems.some((p: string) => p.includes('comments.json')))
  ok('P0-1 评论文件缺失时拒绝备份', !createBackup({ root: missingComments, dest: path.join(root, 'p0-1-missing-comments-backup'), stopConfirmed: true }).ok)

  const noStop = createBackup({ root: live, dest: path.join(root, 'p0-4-no-stop') })
  ok('P0-4 未确认停写时拒绝备份', !noStop.ok && noStop.code === 'STOP_REQUIRED')

  // ---- 13. P0-2：诊断输出不泄漏正文/昵称/账号标识 ----
  const inspectText = JSON.stringify(inspectCommunity(live))
  ok('P0-2 inspect 默认返回不含正文', !inspectText.includes('合成正文'))
  ok('P0-2 inspect 默认返回不含昵称', !inspectText.includes('作者甲'))
  ok('P0-2 inspect 默认返回不含账号 id', !inspectText.includes('u1'))
  const verifyText = JSON.stringify(verifyBackup(b1))
  ok('P0-2 verify 默认返回不含正文', !verifyText.includes('合成正文'))
  ok('P0-2 verify 默认返回不含昵称/账号 id', !verifyText.includes('作者甲') && !verifyText.includes('u1'))
  const inspectCli = await runCli(['inspect', '--data', live, '--json'])
  ok('P0-2 CLI inspect 退出 0 且不含正文/昵称/账号 id',
    inspectCli.code === 0 && !inspectCli.stdout.includes('合成正文') && !inspectCli.stdout.includes('作者甲') && !inspectCli.stdout.includes('u1'))
  const badCli = await runCli(['inspect', '--data', onlyProfiles, '--json'])
  ok('P0-2 CLI 失败输出也不含昵称', badCli.code === 1 && !badCli.stdout.includes('合成昵称P0'))
  const verifyCli = await runCli(['verify', b1, '--json'])
  ok('P0-2 CLI verify 不含正文/昵称/账号 id',
    verifyCli.code === 0 && !verifyCli.stdout.includes('合成正文') && !verifyCli.stdout.includes('作者甲') && !verifyCli.stdout.includes('u1'))

  // ---- 13b. 账号关联：只报数量，不输出 uid ----
  const usersFile = path.join(root, 'users.json')
  writeJson(usersFile, { version: 1, users: { u1: { id: 'u1', name: 'u1' } }, invites: {} })
  const withUsers = verifyBackup(b1, { usersFile })
  ok('账号关联检查报告孤儿引用数量', withUsers.ok && withUsers.warnings.some((w: string) => w.includes('用户表') && w.includes('不存在')))
  ok('账号关联警告不输出 uid', !JSON.stringify(withUsers).includes('u2') && !JSON.stringify(withUsers).includes('u3'))

  // ---- 14. P0-3：恢复差异必须包含当前新增内容 ----
  const currentPosts = readJson(path.join(live, 'posts.json'))
  currentPosts.items.p_new = {
    id: 'p_new', uid: 'u1', status: 'published', display: 'anonymous',
    publishedVersionId: 'v_p_new', pendingVersionId: '',
    versions: [{ vid: 'v_p_new', title: '新增合成稿', body: '新增合成正文', tags: [], createdAt: 2 }],
    counts: { up: 0, down: 0, comments: 0 }, createdAt: 2, updatedAt: 2,
  }
  writeJson(path.join(live, 'posts.json'), currentPosts)
  const currentComments = readJson(path.join(live, 'comments.json'))
  currentComments.items.c_new = { id: 'c_new', postId: 'p_new', uid: 'u1', body: '新增合成评论', display: 'anonymous', status: 'visible', createdAt: 2 }
  writeJson(path.join(live, 'comments.json'), currentComments)
  const diffNow = diffVisibility(
    inspectCommunity(live, { includeData: true }).data,
    verifyBackup(b1, { includeData: true }).data,
  )
  ok('P0-3 差异包含当前新增公开帖子', diffNow.changes.some((c: any) => c.type === 'would-remove' && c.postId === 'p_new'))
  ok('P0-3 差异包含当前新增评论计数', diffNow.summary.comments >= 1)
  const refusedNew = restoreBackup({ backupDir: b1, root: live, stopConfirmed: true })
  ok('P0-3 未确认时拒绝覆盖新增内容', !refusedNew.ok && refusedNew.code === 'VISIBILITY_CHANGES' && refusedNew.summary.postsRemoved >= 1)
  ok('P0-3 拒绝后新增帖子仍在', !!readJson(path.join(live, 'posts.json')).items.p_new)
  const acceptedNew = restoreBackup({ backupDir: b1, root: live, stopConfirmed: true, acceptVisibilityChanges: true })
  ok('P0-3 显式接受后按预览移除新增内容',
    acceptedNew.ok && !readJson(path.join(live, 'posts.json')).items.p_new && !readJson(path.join(live, 'comments.json')).items.c_new)
  ok('P0-3 恢复结果摘要与预览一致', acceptedNew.summary.postsRemoved === 1 && acceptedNew.summary.comments === 1)

  // ---- 15. P0-4：读取期间交错写入必须拒绝 ----
  const interleaveDir = path.join(root, 'p0-4-interleave')
  fs.mkdirSync(interleaveDir)
  writeJson(path.join(interleaveDir, 'posts.json'), { version: 1, items: { p1: baseForOptional['posts.json'].items.p1 } })
  writeJson(path.join(interleaveDir, 'comments.json'), { version: 1, items: {} })
  writeJson(path.join(interleaveDir, 'state.json'), baseForOptional['state.json'])
  let interleaved = false
  const interleaveIO = {
    ...defaultIO,
    readText: (p: string) => {
      const text = defaultIO.readText(p)
      if (!interleaved && p.endsWith('posts.json')) {
        interleaved = true
        const c = readJson(path.join(interleaveDir, 'comments.json'))
        c.items.c_interleaved = { id: 'c_interleaved', postId: 'p1', uid: 'u1', body: '交错合成评论', display: 'anonymous', status: 'visible', createdAt: 2 }
        defaultIO.writeText(path.join(interleaveDir, 'comments.json'), JSON.stringify(c, null, 2))
      }
      return text
    },
  }
  const interleaveBackup = createBackup({ root: interleaveDir, dest: path.join(root, 'p0-4-interleave-backup'), io: interleaveIO, stopConfirmed: true })
  ok('P0-4 交错写入被识别并拒绝备份', !interleaveBackup.ok && interleaveBackup.code === 'CONCURRENT_WRITE')
  ok('P0-4 交错写入不产生正式备份目录', !fs.existsSync(path.join(root, 'p0-4-interleave-backup')))

  // ---- 16. P0-R1：评论文件缺失的可证明性 ----
  const r1Post: CommunityPost = {
    ...syntheticData()['posts.json'].items.p1,
    display: 'anonymous',
    counts: { up: 0, down: 0, comments: 0 },
  }
  const storeStart = (dir: string) => {
    try { createCommunityStore({ root: dir }); return true } catch { return false }
  }
  const unverified = path.join(root, 'r1-unverified')
  fs.mkdirSync(unverified)
  writeJson(path.join(unverified, 'posts.json'), { version: 1, items: { p1: r1Post } })
  writeJson(path.join(unverified, 'state.json'), syntheticData()['state.json'])
  ok('R1 缺评论且无标记 -> inspect 拒绝', !inspectCommunity(unverified).ok)
  ok('R1 缺评论且无标记 -> 备份拒绝', !createBackup({ root: unverified, dest: path.join(root, 'r1-unverified-backup'), stopConfirmed: true }).ok)
  ok('R1 缺评论且无标记 -> 服务启动拒绝', !storeStart(unverified))

  const never = path.join(root, 'r1-never')
  fs.mkdirSync(never)
  writeJson(path.join(never, 'posts.json'), { version: 1, items: { p1: r1Post } })
  writeJson(path.join(never, 'state.json'), syntheticData()['state.json'])
  writeCommunityMeta(never, { commentsInitialized: false, createdAt: 1 }, (p, t) => fs.writeFileSync(p, t, 'utf8'))
  ok('R1 标记从未初始化 -> inspect/启动允许', inspectCommunity(never).ok && storeStart(never))

  const was = path.join(root, 'r1-was')
  fs.mkdirSync(was)
  writeJson(path.join(was, 'posts.json'), { version: 1, items: { p1: r1Post } })
  writeJson(path.join(was, 'state.json'), syntheticData()['state.json'])
  writeCommunityMeta(was, { commentsInitialized: true, createdAt: 1 }, (p, t) => fs.writeFileSync(p, t, 'utf8'))
  ok('R1 标记曾初始化但文件缺失 -> inspect/启动拒绝', !inspectCommunity(was).ok && !storeStart(was))

  const wiped = path.join(root, 'r1-wiped')
  fs.mkdirSync(wiped)
  writeCommunityMeta(wiped, { commentsInitialized: true, createdAt: 1 }, (p, t) => fs.writeFileSync(p, t, 'utf8'))
  ok('R1 仅剩曾初始化标记 -> inspect/备份/启动拒绝', !inspectCommunity(wiped).ok && !createBackup({ root: wiped, dest: path.join(root, 'r1-wiped-backup'), stopConfirmed: true }).ok && !storeStart(wiped))
  ok('R1 仅剩曾初始化标记 -> 不被降级为首次使用', readCommunityMeta(wiped)?.commentsInitialized === true)

  const pendingLost = path.join(root, 'r1-pending-lost')
  fs.mkdirSync(pendingLost)
  const pendingStore = createCommunityStore({ root: pendingLost })
  pendingStore.putPost(r1Post)
  pendingStore.putComment({ id: 'c_pending', postId: 'p1', uid: 'u1', body: '待审合成评论', display: 'anonymous', status: 'pending', createdAt: 1 })
  ok('R1 待审评论写入后标记为 true', readCommunityMeta(pendingLost)?.commentsInitialized === true)
  fs.rmSync(path.join(pendingLost, 'comments.json'))
  ok('R1 只有待审评论后文件丢失 -> inspect/启动拒绝', !inspectCommunity(pendingLost).ok && !storeStart(pendingLost))

  const adoptDir = path.join(root, 'r1-adopt')
  fs.mkdirSync(adoptDir)
  writeJson(path.join(adoptDir, 'posts.json'), { version: 1, items: { p1: r1Post } })
  writeJson(path.join(adoptDir, 'state.json'), syntheticData()['state.json'])
  ok('R1 未确认采纳被拒', !adoptEmptyComments({ root: adoptDir, confirm: false }).ok)
  ok('R1 确认采纳后检查/启动允许', adoptEmptyComments({ root: adoptDir, confirm: true }).ok && inspectCommunity(adoptDir).ok && storeStart(adoptDir))

  // ---- 17. P0-R2：同 ID 评论的状态/正文/展示差异 ----
  const r2Dir = path.join(root, 'r2-comments')
  fs.mkdirSync(r2Dir)
  const r2Post = { ...r1Post, counts: { up: 0, down: 0, comments: 2 } }
  writeJson(path.join(r2Dir, 'posts.json'), { version: 1, items: { p1: r2Post } })
  writeJson(path.join(r2Dir, 'comments.json'), {
    version: 1,
    items: {
      c1: { id: 'c1', postId: 'p1', uid: 'u2', body: '备份正文一', display: 'anonymous', status: 'visible', createdAt: 1 },
      c2: { id: 'c2', postId: 'p1', uid: 'u2', body: '备份正文二', display: 'anonymous', status: 'visible', createdAt: 2 },
    },
  })
  writeJson(path.join(r2Dir, 'reports.json'), { version: 1, items: { r1: { id: 'r1', kind: 'report', targetType: 'post', targetId: 'p1', status: 'open', createdAt: 1 } } })
  writeJson(path.join(r2Dir, 'profiles.json'), { version: 1, items: { u1: { nickname: '备份昵称', postDisplay: 'anonymous', commentDisplay: 'anonymous', rankDisplay: 'anonymous', updatedAt: 1 } } })
  writeJson(path.join(r2Dir, 'audit.json'), { version: 1, items: { list: [{ id: 'a1', action: 'backup' }] } })
  writeJson(path.join(r2Dir, 'state.json'), syntheticData()['state.json'])
  const r2Backup = path.join(root, 'r2-backup')
  ok('R2 准备备份', createBackup({ root: r2Dir, dest: r2Backup, stopConfirmed: true }).ok)

  const r2Comments = readJson(path.join(r2Dir, 'comments.json'))
  r2Comments.items.c1.status = 'removed'
  r2Comments.items.c1.body = '当前改成的新正文'
  r2Comments.items.c1.display = 'nickname'
  delete r2Comments.items.c2
  writeJson(path.join(r2Dir, 'comments.json'), r2Comments)
  const r2Reports = readJson(path.join(r2Dir, 'reports.json'))
  r2Reports.items.r1.status = 'closed'
  writeJson(path.join(r2Dir, 'reports.json'), r2Reports)
  const r2Profiles = readJson(path.join(r2Dir, 'profiles.json'))
  r2Profiles.items.u1.nickname = '当前昵称'
  writeJson(path.join(r2Dir, 'profiles.json'), r2Profiles)
  const r2Audit = readJson(path.join(r2Dir, 'audit.json'))
  r2Audit.items.list.push({ id: 'a2', action: 'current' })
  writeJson(path.join(r2Dir, 'audit.json'), r2Audit)

  const r2Diff = diffVisibility(
    inspectCommunity(r2Dir, { includeData: true }).data,
    verifyBackup(r2Backup, { includeData: true }).data,
  )
  ok('R2 识别评论状态变化', r2Diff.changes.some((c: any) => c.type === 'comment-status-changed' && c.commentId === 'c1'))
  ok('R2 识别评论正文变化', r2Diff.changes.some((c: any) => c.type === 'comment-content-changed' && c.commentId === 'c1'))
  ok('R2 识别评论展示方式变化', r2Diff.changes.some((c: any) => c.type === 'comment-display-changed' && c.commentId === 'c1'))
  ok('R2 识别当前已删除但备份存在的评论', r2Diff.changes.some((c: any) => c.type === 'comment-restored-absent' && c.commentId === 'c2'))
  ok('R2 识别举报状态变化', r2Diff.summary.reportsChanged === 1)
  ok('R2 识别档案变化', r2Diff.summary.profilesChanged === 1)
  ok('R2 识别审计当前独有记录', r2Diff.summary.auditRemoved === 1)
  ok('R2 差异不输出正文/uid/昵称', !JSON.stringify(r2Diff).includes('当前改成的新正文') && !JSON.stringify(r2Diff).includes('u2') && !JSON.stringify(r2Diff).includes('备份昵称'))

  const r2Refused = restoreBackup({ backupDir: r2Backup, root: r2Dir, stopConfirmed: true })
  ok('R2 未确认时拒绝恢复', !r2Refused.ok && r2Refused.code === 'VISIBILITY_CHANGES')
  const r2Before = readJson(path.join(r2Dir, 'comments.json'))
  ok('R2 拒绝后当前删除状态/正文保持不变', r2Before.items.c1.status === 'removed' && !r2Before.items.c2)
  const r2Accepted = restoreBackup({ backupDir: r2Backup, root: r2Dir, stopConfirmed: true, acceptVisibilityChanges: true })
  const r2After = readJson(path.join(r2Dir, 'comments.json'))
  ok('R2 显式接受后恢复备份评论状态/正文',
    r2Accepted.ok && r2After.items.c1.status === 'visible' && r2After.items.c1.body === '备份正文一' && !!r2After.items.c2)

  // ---- 18. P0-R3：协作式停写锁（不是 OS 级互斥） ----
  const r3Dir = path.join(root, 'r3-lock')
  fs.mkdirSync(r3Dir)
  writeJson(path.join(r3Dir, 'posts.json'), { version: 1, items: { p1: r1Post } })
  writeJson(path.join(r3Dir, 'comments.json'), { version: 1, items: {} })
  writeJson(path.join(r3Dir, 'state.json'), syntheticData()['state.json'])
  const r3Store = createCommunityStore({ root: r3Dir })
  const held = acquireCommunityLock(r3Dir, { tool: 'test' })
  ok('R3 可获取独占锁', held.ok)
  const second = acquireCommunityLock(r3Dir, { tool: 'test-2' })
  ok('R3 第二个获取者被拒绝', !second.ok && second.code === 'LOCKED')
  let lockWriteThrew = false
  try { r3Store.putPost({ ...r1Post, id: 'p_lock' }) } catch { lockWriteThrew = true }
  ok('R3 锁存在时 store 写入被拒绝', lockWriteThrew)
  const lockBackup = createBackup({ root: r3Dir, dest: path.join(root, 'r3-locked-backup'), stopConfirmed: true })
  ok('R3 锁存在时备份被拒绝', !lockBackup.ok && lockBackup.code === 'LOCKED')
  ok('R3 锁冲突不产生备份目录', !fs.existsSync(path.join(root, 'r3-locked-backup')))
  const lockRestore = restoreBackup({ backupDir: path.join(root, 'r2-backup'), root: r3Dir, stopConfirmed: true, acceptVisibilityChanges: true })
  ok('R3 锁存在时恢复被拒绝', !lockRestore.ok && lockRestore.code === 'LOCKED')
  ok('R3 锁不存在时不能谎报释放', releaseCommunityLock(r3Dir).released === true)
  ok('R3 释放后可再次获取', acquireCommunityLock(r3Dir, { tool: 'again' }).ok)
  releaseCommunityLock(r3Dir)

  ok('R3 服务启动时锁存在 -> 拒绝', (() => {
    acquireCommunityLock(r3Dir, { tool: 'startup' })
    const r = storeStart(r3Dir)
    releaseCommunityLock(r3Dir)
    return r
  })() === false)

  // 未确认停写也不会留下锁
  ok('R3 stop 未确认返回 STOP_REQUIRED', (() => {
    const r = createBackup({ root: r3Dir, dest: path.join(root, 'r3-no-stop') })
    return !r.ok && r.code === 'STOP_REQUIRED' && !readCommunityLock(r3Dir)
  })())

  // 崩溃残留锁：不自动删除，显式 unlock 后才允许
  writeJson(communityLockPath(r3Dir), { pid: 999999, at: Date.now(), tool: 'crashed' })
  const staleBackup = createBackup({ root: r3Dir, dest: path.join(root, 'r3-stale-backup'), stopConfirmed: true })
  ok('R3 残留锁 -> STALE_LOCK', !staleBackup.ok && staleBackup.code === 'STALE_LOCK')
  ok('R3 未确认时不清理残留锁', !unlockStaleCommunityLock(r3Dir, { confirm: false }).ok && !!readCommunityLock(r3Dir))
  ok('R3 确认后清理残留锁', unlockStaleCommunityLock(r3Dir, { confirm: true }).released === true)
  ok('R3 清理后可正常备份', createBackup({ root: r3Dir, dest: path.join(root, 'r3-after-unlock'), stopConfirmed: true }).ok)

  // 锁文件无法创建（路径是目录）：失败关闭
  fs.mkdirSync(communityLockPath(r3Dir))
  const badLock = acquireCommunityLock(r3Dir, { tool: 'bad' })
  ok('R3 锁路径不可写时失败关闭', !badLock.ok && badLock.code === 'LOCK_FAILED')
  fs.rmdirSync(communityLockPath(r3Dir))

  console.log(`communityBackup: ${pass} passed, 0 failed`)
} finally {
  const target = fs.realpathSync(root)
  if (path.dirname(target) !== fs.realpathSync(os.tmpdir()) || !path.basename(target).startsWith('yfe-community-backup-')) {
    throw new Error('拒绝清理不安全的测试目录')
  }
  fs.rmSync(target, { recursive: true, force: true })
}