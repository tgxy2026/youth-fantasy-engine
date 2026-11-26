// ============ 3.7.4 · W0/W3 保鲜状态判定与配置归一化 ============
//
// 盯六件事：
//   ① 三档模式 / 间隔 / 根目录 / D2 / D3 的老库脏数据收敛；
//   ② 工作区同步状态（启用 / 时间 / 指纹 / 单文件哈希 / 场景）的默认与清洗；
//   ③ 新鲜度三分判定：未初始化 / 已最新 / 有待同步；
//   ④ 定时刷新到点判定：手动与提醒模式永不自动写盘；
//   ⑤ 同步状态真正落库（按项目隔离）；
//   ⑥ `markWcpWorkspaceSynced` 只在宿主写盘成功后才有意义（写的是完整指纹组）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as db from '../src/lib/db'
import { memoryOps, __resetMockStores } from './mock-memory'
import {
  loadWcpProjectState,
  markWcpWorkspaceSynced,
  normalizeWcpGlobalConfig,
  normalizeWcpProjectState,
} from '../src/lib/wcp/wcpSettings'
import {
  buildWcpWorkspacePlanInput,
  evaluateWcpWorkspaceFreshness,
  isWcpAutoSyncDue,
  syncWcpWorkspace,
} from '../src/lib/wcp/wcpWorkspaceSync'
import type { ElectronWcpWorkspaceAPI } from '../src/lib/wcp/wcpWorkspaceClient'
import { WCP_WORKSPACE_DEFAULT_INTERVAL_MIN, WCP_OUTPUT_SCHEMA_VERSION } from '../src/lib/wcp/wcpTypes'
import { pickWorkspaceFocusChapter, type WcpWorkspaceCollectedData } from '../src/lib/wcp/wcpCollect'
import { planWcpWorkspace, parseWcpWorkspaceJsonFile } from '../src/lib/wcp/wcpWorkspaceBuilder'
import { decideOutboxArchiveAfterBody, resolveWcpImportParse } from '../src/lib/wcp/wcpWorkspaceImportRules'
import type { Chapter, Volume } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function main() {
  // ---------- ① 全局偏好归一化 ----------
  {
    const def = normalizeWcpGlobalConfig(null)
    ok('空配置：工作区根为空串（跟随数据目录）', def.workspaceRoot === '')
    ok('空配置：默认打开提醒', def.workspaceSyncMode === 'remind-on-open')
    ok('空配置：默认 10 分钟', def.workspaceSyncIntervalMin === WCP_WORKSPACE_DEFAULT_INTERVAL_MIN)
    ok('空配置：D2 关闭、D3 开启', def.syncFullChapters === false && def.archiveOutboxAfterImport === true)
  }
  {
    const cfg = normalizeWcpGlobalConfig({
      workspaceRoot: ' D:\\同步盘\\wcp-workspaces ',
      workspaceSyncMode: 'auto-interval',
      workspaceSyncIntervalMin: 7,
      syncFullChapters: true,
      archiveOutboxAfterImport: false,
    })
    ok('合法绝对根目录保留并去空白', cfg.workspaceRoot === 'D:\\同步盘\\wcp-workspaces')
    ok('间隔只取 5/10/15/30 中最接近档（7 → 5）', cfg.workspaceSyncIntervalMin === 5)
    ok('D2 / D3 开关按布尔值保存', cfg.syncFullChapters && !cfg.archiveOutboxAfterImport)
  }
  ok('相对路径根目录被拒绝（落点不可预期）', normalizeWcpGlobalConfig({ workspaceRoot: 'wcp-workspaces' }).workspaceRoot === '')
  ok('POSIX 绝对路径可用', normalizeWcpGlobalConfig({ workspaceRoot: '/home/me/ws' }).workspaceRoot === '/home/me/ws')
  ok('非法模式回退默认', normalizeWcpGlobalConfig({ workspaceSyncMode: 'hourly' }).workspaceSyncMode === 'remind-on-open')
  ok('极大间隔收敛到 30 分钟档', normalizeWcpGlobalConfig({ workspaceSyncIntervalMin: 999 }).workspaceSyncIntervalMin === 30)

  // ---------- ② 单项目状态归一化 ----------
  {
    const def = normalizeWcpProjectState(null)
    ok('空状态：未启用、无指纹', !def.workspaceEnabled && def.lastWorkspaceSyncAt === null && def.lastWorkspaceFingerprint === '')
    ok('空状态：哈希表为空对象', Object.keys(def.lastWorkspaceFileHashes).length === 0)
    ok('空状态：场景为空串', def.lastWorkspaceScene === '')
  }
  {
    const st = normalizeWcpProjectState({
      lastWorkspaceSyncAt: 1_700_000_000_000,
      workspaceEnabled: true,
      lastWorkspaceFingerprint: 'abc123',
      lastWorkspaceFileHashes: {
        '01-base/01-overview.md': 'deadbeef',
        'outbox/x.md': 'deadbeef',
        '../evil.md': 'deadbeef',
        'bad hash': 'zz',
      },
      lastWorkspaceScene: 'chapter-polish',
    })
    ok('同步时间与指纹保留', st.lastWorkspaceSyncAt === 1_700_000_000_000 && st.lastWorkspaceFingerprint === 'abc123')
    ok('哈希表只留 ASCII 相对只读路径（outbox / ../ / 非 hex 全丢弃）',
      Object.keys(st.lastWorkspaceFileHashes).length === 1
      && st.lastWorkspaceFileHashes['01-base/01-overview.md'] === 'deadbeef')
    ok('上次场景被子项目状态记住', st.lastWorkspaceScene === 'chapter-polish')
  }
  {
    const legacy = normalizeWcpProjectState({ lastWorkspaceSyncAt: 123 })
    ok('老库仅有同步时间：自动视为已启用', legacy.workspaceEnabled === true)
    const explicitOff = normalizeWcpProjectState({ lastWorkspaceSyncAt: 123, workspaceEnabled: false })
    ok('显式关闭优先于历史时间', explicitOff.workspaceEnabled === false)
    ok('非法场景回退空串', normalizeWcpProjectState({ lastWorkspaceScene: 'nope' }).lastWorkspaceScene === '')
  }

  // ---------- ③ 新鲜度 ----------
  ok('从未同步 ⇒ never', evaluateWcpWorkspaceFreshness('', 'fp-now', null) === 'never')
  ok('指纹一致 ⇒ fresh', evaluateWcpWorkspaceFreshness('fp', 'fp', 1000) === 'fresh')
  ok('指纹不同 ⇒ stale', evaluateWcpWorkspaceFreshness('fp-old', 'fp-new', 1000) === 'stale')
  ok('有同步时间但指纹丢失 ⇒ stale', evaluateWcpWorkspaceFreshness('', 'fp-now', 1000) === 'stale')

  // ---------- ④ 定时到点 ----------
  ok('手动模式永不自动', isWcpAutoSyncDue('manual', 10, 0, Date.now()) === false)
  ok('打开提醒模式永不自动', isWcpAutoSyncDue('remind-on-open', 10, 0, Date.now()) === false)
  ok('定时模式首次立即检查', isWcpAutoSyncDue('auto-interval', 10, 0, Date.now()) === true)
  ok('定时模式未到点不写盘', isWcpAutoSyncDue('auto-interval', 10, 1000, 1000 + 9 * 60_000) === false)
  ok('定时模式到点触发', isWcpAutoSyncDue('auto-interval', 10, 1000, 1000 + 10 * 60_000) === true)

  // ---------- ⑤ 状态落库（按项目隔离） ----------
  db.setStoreOps(memoryOps)
  __resetMockStores()
  db.setCurrentProject('p-ws-sync')
  const saved = await markWcpWorkspaceSynced(
    'fp-synced',
    { '01-base/01-overview.md': 'deadbeef' },
    'chapter-continue',
    'p-ws-sync',
    1_700_000_000_000,
  )
  ok('同步成功后：状态标记为启用', saved.workspaceEnabled && saved.lastWorkspaceSyncAt === 1_700_000_000_000)
  ok('同步成功后：指纹与哈希落库',
    saved.lastWorkspaceFingerprint === 'fp-synced' && saved.lastWorkspaceFileHashes['01-base/01-overview.md'] === 'deadbeef')
  const reread = await loadWcpProjectState('p-ws-sync')
  ok('重读：状态一致', reread.lastWorkspaceFingerprint === 'fp-synced' && reread.lastWorkspaceScene === 'chapter-continue')
  const other = await loadWcpProjectState('p-ws-other')
  ok('另一本书不受影响（同步状态按项目隔离）', !other.workspaceEnabled && other.lastWorkspaceFingerprint === '')

  // ---------- ⑥ 缺省聚焦章节：updatedAt 降序 + 同时刻取叙事序更靠后者 ----------
  {
    const vol = (id: string, order: number): Volume => ({ id, projectId: 'p-focus', order, title: id, description: '', createdAt: 0 })
    const ch = (id: string, volumeId: string, order: number, updatedAt: number): Chapter => ({
      id, projectId: 'p-focus', volumeId, order, title: id, content: '', summary: '',
      status: '草稿', wordCount: 0, createdAt: 0, updatedAt,
    })
    const vols = [vol('v1', 0), vol('v2', 1)]
    const sameTime = [ch('c1', 'v1', 0, 500), ch('c2', 'v1', 1, 500), ch('c3', 'v2', 0, 500)]
    ok('多卷同时间戳：选叙事序最靠后的章（不是第 1 章）',
      pickWorkspaceFocusChapter(vols, sameTime)?.id === 'c3')
    const newerEarlier = [ch('c1', 'v1', 0, 900), ch('c2', 'v1', 1, 500), ch('c3', 'v2', 0, 500)]
    ok('较新的早期章优先于同时刻的后期章',
      pickWorkspaceFocusChapter(vols, newerEarlier)?.id === 'c1')
    ok('无章节时返回 undefined', pickWorkspaceFocusChapter(vols, []) === undefined)
  }

  // ---------- ⑦ `.wcp.json` 权威解析 / 归档时机判定 ----------
  {
    const valid = {
      schemaVersion: WCP_OUTPUT_SCHEMA_VERSION,
      projectId: 'p-import',
      scene: 'chapter-continue',
      body: '雨停了。',
      changes: { entities: [], statusChanges: [], resourceTransfers: [], foreshadows: [], relations: [], bioNodes: [] },
    }
    const parsed = parseWcpWorkspaceJsonFile(JSON.stringify(valid), 'p-import')
    ok('导入样本可解析', parsed.ok)
    if (parsed.ok) {
      const loaded = { text: parsed.replyText, result: parsed.result }
      const forced = resolveWcpImportParse(parsed.replyText, 'markdown', loaded)
      ok('全局设为 Markdown 时，已解析的 .wcp.json 结果原样复用（不被重解析）',
        forced === loaded.result && forced?.format === 'json' && forced?.body === '雨停了。')
      const edited = resolveWcpImportParse('<<<WCP_CHANGES_START>>>\n### 新登场设定\n- 青锋剑（物品）\n<<<WCP_CHANGES_END>>>', 'markdown', loaded)
      ok('文本框被编辑后回落到当前格式解析', edited !== loaded.result && edited?.format === 'markdown')
      ok('空文本返回 null', resolveWcpImportParse('   ', 'json', loaded) === null)
    }
  }
  ok('归档决策：无来源不归档',
    decideOutboxArchiveAfterBody({ archiveEnabled: true, hasLoadedSource: false, pendingCandidates: false }) === 'none')
  ok('归档决策：自动归档关闭时不归档',
    decideOutboxArchiveAfterBody({ archiveEnabled: false, hasLoadedSource: true, pendingCandidates: false }) === 'none')
  ok('归档决策：还有未写入候选时暂缓归档',
    decideOutboxArchiveAfterBody({ archiveEnabled: true, hasLoadedSource: true, pendingCandidates: true }) === 'defer')
  ok('归档决策：没有待写入候选时立即归档',
    decideOutboxArchiveAfterBody({ archiveEnabled: true, hasLoadedSource: true, pendingCandidates: false }) === 'archive')

  // ---------- ⑧ zip 与桌面共用同一份 activeContext ----------
  {
    const collected: WcpWorkspaceCollectedData = {
      projectId: 'p-plan', projectName: '吞天神脉', baseFingerprint: 'fp-base',
      notes: [], sections: [{ id: 'base-overview', group: 'world', title: '作品概览', content: '少年自边城起。' }],
      activeChapterId: 'ch9', activeChapterNo: 9, activeChapterTitle: '第九章 剑应碑醒', volumeTitle: '第二卷 剑锁中州',
      chapters: [],
    }
    const plan = planWcpWorkspace(buildWcpWorkspacePlanInput({
      projectId: 'p-plan', scene: 'chapter-continue', collected, includeFullChapters: false,
    }))
    const ctx = plan.manifest.activeContext as Record<string, unknown>
    ok('构建输入（含 zip 分支）带全 activeContext 四项坐标',
      ctx.chapterId === 'ch9' && ctx.chapterNo === 9
      && ctx.chapterTitle === '第九章 剑应碑醒' && ctx.volumeTitle === '第二卷 剑锁中州')
    const task = plan.files.find(f => f.path === '02-context/task.md')?.content ?? ''
    ok('task.md 同样带上当前章坐标', task.includes('第 9 章') && task.includes('第九章 剑应碑醒'))
  }

  // ---------- ⑨ 切书并发：取材前 / 写盘前的 projectId 闸 ----------
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-wcp-sync-'))
  const installFakeBridge = (onApply?: () => void) => {
    const state = { applies: 0 }
    const api = {
      defaultRoot: async () => ({ ok: true, root: tempRoot }),
      diagnose: async () => ({ ok: true, writable: true, root: tempRoot }),
      chooseRoot: async () => tempRoot,
      apply: async (payload: { files: unknown[]; deletions: unknown[] }) => {
        state.applies++
        onApply?.()
        return { ok: true, written: payload.files.length, deleted: payload.deletions.length }
      },
      scan: async () => ({ ok: true, entries: [] }),
      read: async () => ({ ok: false, error: '', text: '' }),
      archive: async () => ({ ok: false, error: '', archived: [] }),
      reveal: async () => ({ ok: true }),
    } as unknown as ElectronWcpWorkspaceAPI
    const g = globalThis as unknown as { window?: { electronWcpWorkspace?: ElectronWcpWorkspaceAPI } }
    const prev = g.window
    g.window = { electronWcpWorkspace: api }
    return { state, restore: () => { g.window = prev } }
  }

  {
    const bridge = installFakeBridge()
    try {
      db.setCurrentProject('p-guard-current')
      const r = await syncWcpWorkspace({ pid: 'p-guard-other', reason: 'manual' })
      ok('切书后调用：安全中止且不改任何书的状态',
        !r.ok && r.error.includes('已切换') && r.mode === 'none' && bridge.state.applies === 0)
    } finally { bridge.restore() }
  }
  {
    // 模拟取材完成、写盘期间用户切书：写入发生，但不得把同步状态记到原书
    const bridge = installFakeBridge(() => db.setCurrentProject('p-guard-after'))
    try {
      db.setCurrentProject('p-guard-flip')
      const r = await syncWcpWorkspace({ pid: 'p-guard-flip', reason: 'manual' })
      ok('写盘期间切书：停止记录状态并如实说明',
        !r.ok && r.error.includes('停止记录') && bridge.state.applies === 1)
      const st = await loadWcpProjectState('p-guard-flip')
      ok('写盘期间切书：原书不同步状态', st.lastWorkspaceFingerprint === '' && !st.workspaceEnabled)
    } finally {
      bridge.restore()
      db.setCurrentProject('p-ws-sync')
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true })

  console.log(`\nwcpWorkspaceSync: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exitCode = 1 })
