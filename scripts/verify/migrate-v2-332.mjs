// P2-8 · 整库 → 项目级快照迁移 · 自检
// 用法：node scripts/verify/migrate-v2-332.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const migrateEntry = path.join(repo, 'server/migrate-v2.mjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-migrate-'))
const dataDir = path.join(root, 'data')
fs.mkdirSync(dataDir, { recursive: true })
process.env.YFE_DATA = dataDir

const { createUser, findByName } = await import('../../server/lib/users.mjs')
const { readIndex } = await import('../../server/lib/v2Index.mjs')
const { readLegacyGate } = await import('../../server/lib/legacyGate.mjs')
const { readManifest } = await import('../../server/lib/projectStore.mjs')

let passed = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { fails.push({ name, extra }); console.log('FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')) }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const user = createUser({ id: 'u_mig1', name: '迁移用户', passwordHash: 'x' })

// 造一份 3.3.1 形态的整库
const uid = user.id
const userDir = path.join(dataDir, 'users', uid)
fs.mkdirSync(userDir, { recursive: true })
const stores = {
  projects: {
    p1: { id: 'p1', name: '甲书', genre: '东方玄幻', intro: '', createdAt: 1, updatedAt: 2 },
    p2: { id: 'p2', name: '乙书', genre: '都市', intro: '', createdAt: 3, updatedAt: 4 },
  },
  volumes: { v1: { id: 'v1', projectId: 'p1', order: 1, title: '卷一', description: '' } },
  chapters: {
    c1: { id: 'c1', projectId: 'p1', volumeId: 'v1', order: 1, title: '第一章', content: '正文甲' },
    c2: { id: 'c2', projectId: 'p2', volumeId: '', order: 1, title: '第一章', content: '正文乙' },
  },
  tableRows: {
    r1: { id: 'r1', projectId: 'p1', tabId: 'races', order: 1, data: { 名称: '族' }, atlasImage: { dataUrl: PNG, mime: 'image/png', width: 1, height: 1, bytes: 70 } },
  },
  cardRecords: {
    k1: { id: 'k1', projectId: 'p1', tabId: 'characters', name: '角色', order: 1, data: {}, portrait: PNG },
  },
  formData: { 'p1::races': { tabId: 'p1::races', data: { a: '1' } } },
  settingsKV: {
    'p1::goalDaily': { key: 'p1::goalDaily', value: 3000 },
    'customOption::p1::人物状态': { key: 'customOption::p1::人物状态', value: ['存活', '阵亡'] },
    'p2::goalDaily': { key: 'p2::goalDaily', value: 2000 },
  },
  dailyStats: {
    'p1::2026-10-30': { key: 'p1::2026-10-30', projectId: 'p1', date: '2026-10-30', words: 100 },
  },
  // 本地专属：迁移时**不该**被带进任何项目快照
  backups: { b1: { id: 'b1', projectId: 'p1', at: 1 } },
}
const legacyText = JSON.stringify({ app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: 1, stores })
fs.writeFileSync(path.join(userDir, 'data.json'), legacyText)
const legacyHash = crypto.createHash('sha256').update(legacyText).digest('hex')

function run(args) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [migrateEntry, ...args], {
      cwd: repo, env: { ...process.env, YFE_DATA: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    cp.stdout.on('data', (d) => { out += d })
    cp.stderr.on('data', (d) => { out += d })
    cp.on('close', (code) => resolve({ code, out }))
  })
}

try {
  // 1. dry-run 不写任何东西
  const dry = await run(['迁移用户', '--dry-run'])
  ok('dry-run 退出码 0', dry.code === 0, dry.out.slice(-400))
  ok('dry-run 没有创建 v2 数据', !fs.existsSync(path.join(dataDir, 'v2', 'accounts')) || readIndex(path.join(dataDir, 'v2'), uid).projects
    && Object.keys(readIndex(path.join(dataDir, 'v2'), uid).projects).length === 0, dry.out.slice(-300))
  ok('dry-run 打印了两本书的计划', dry.out.includes('甲书') && dry.out.includes('乙书'), dry.out.slice(-400))
  ok('dry-run 没开门禁', readLegacyGate(path.join(dataDir, 'v2'), uid).blocked === false)

  // 2. 真跑
  const real = await run(['迁移用户'])
  ok('迁移退出码 0', real.code === 0, real.out.slice(-600))
  const v2Root = path.join(dataDir, 'v2')
  const idx = readIndex(v2Root, uid)
  ok('索引里两本书都在且都是 revision 1', idx.projects?.p1?.revision === 1 && idx.projects?.p2?.revision === 1, JSON.stringify(idx.projects))
  ok('迁移后旧路径门禁已关', readLegacyGate(v2Root, uid).blocked === true)
  ok('旧库文件一个字节没动', crypto.createHash('sha256').update(fs.readFileSync(path.join(userDir, 'data.json'), 'utf8')).digest('hex') === legacyHash)

  // 3. 快照内容正确
  const storeRoot = path.join(v2Root, 'accounts', uid)
  const m1 = readManifest(storeRoot, 'p1', 1)
  ok('p1 快照含十类对象', m1 && m1.objects.length === 10, m1 && m1.objects.length)
  ok('p1 图片被抽成资源（不是内嵌）', m1 && m1.assets.length >= 1, m1 && m1.assets.length)
  const cardsObj = m1.objects.find((o) => o.kind === 'cardRecords')
  const cardsPayload = JSON.parse(fs.readFileSync(path.join(storeRoot, 'objects', `${cardsObj.hash}.bin`), 'utf8'))
  ok('立绘字段变成 sha256 引用', String(cardsPayload[0]?.portrait || '').startsWith('sha256:'), cardsPayload[0]?.portrait)
  const settingsObj = m1.objects.find((o) => o.kind === 'settings')
  const settingsPayload = JSON.parse(fs.readFileSync(path.join(storeRoot, 'objects', `${settingsObj.hash}.bin`), 'utf8'))
  const keys = settingsPayload.map((s) => s.key).sort()
  ok('项目级设置剥掉了 pid 前缀', keys.includes('goalDaily') && keys.includes('customOption::人物状态'), JSON.stringify(keys))
  const formObj = m1.objects.find((o) => o.kind === 'formData')
  const formPayload = JSON.parse(fs.readFileSync(path.join(storeRoot, 'objects', `${formObj.hash}.bin`), 'utf8'))
  ok('formData 的 tabId 剥掉了 pid 前缀', formPayload[0]?.tabId === 'races', JSON.stringify(formPayload))

  // 4. 本地专属数据没进快照
  const allKinds = m1.objects.map((o) => o.kind)
  ok('backups 未被带入任何项目快照', !allKinds.includes('backups'), allKinds.join(','))

  // 5. 幂等：再跑一次不产生新版本
  const again = await run(['迁移用户'])
  const idx2 = readIndex(v2Root, uid)
  ok('重复迁移不产生新版本', again.code === 0 && idx2.projects.p1.revision === 1 && again.out.includes('已迁移过'), again.out.slice(-300))
} catch (e) {
  fails.push({ name: '未预期异常', extra: e instanceof Error ? e.message : String(e) })
  console.log('FAIL 未预期异常 — ' + (e instanceof Error ? e.message : String(e)))
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* F 盘删除慢，不影响结论 */ }
}

console.log('')
if (fails.length) {
  console.log(`FAILED ${fails.length} / ${passed + fails.length}`)
  console.log(JSON.stringify(fails, null, 2))
  process.exit(1)
}
console.log(`OK ${passed}/${passed}（${new Date().toISOString()}，Node ${process.version}）`)
process.exit(0)
