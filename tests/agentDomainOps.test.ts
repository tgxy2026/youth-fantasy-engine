// Agent 新领域（地图 / 画布 / 世界包 / 备份）· 隔离单测（3.4.3 · P1）
//
// 覆盖：
//   ① 地图与地点创建、名称唯一、自动编号；
//   ② 格子增量绘制：祖先越界、无关范围重叠、子孙占用拒绝；旧指纹冲突；
//   ③ 页面打开时的租约拒绝；
//   ④ 地图改名级联《地理风物》引用；有引用时拒绝删除地图；
//   ⑤ 情节画布：指纹冲突、卡片增改删、连线、页面租约；
//   ⑥ 世界包引入：预览/确认/目标表清单校验/跨项目读取授权/落盘回读；
//   ⑦ 备份恢复：预览、确认与项目版本前置。
import type { TableRow } from '@/lib/types'
import * as db from '@/lib/db'
import { AGENT_ACTIONS, AGENT_TOOL_NAMES, type AgentToolResult } from '@/lib/agentHost/contract'
import { createAgentExecutor, defaultExecutorDeps } from '@/lib/agentHost/executor'
import { canvasLeaseKey, registerFormEditor, tableLeaseKey } from '@/lib/agentHost/formLease'
import { cellsHash, parseCells } from '@/lib/agentHost/mapOps'
import type { WorldStoredRecord } from '@/lib/world/worldTypes'
import { __resetMockStores, memoryOps } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const projectId = 'p-domain'
const otherProjectId = 'p-other'
const fullScope = { projects: [
  { projectId, actions: [...AGENT_ACTIONS] },
  { projectId: otherProjectId, actions: [...AGENT_ACTIONS] },
] }

async function seed() {
  __resetMockStores()
  const now = Date.now()
  await memoryOps.put('projects', { id: projectId, name: '合成领域书', genre: '', intro: '', projectType: 'full', createdAt: now, updatedAt: now })
  await memoryOps.put('projects', { id: otherProjectId, name: '来源项目', genre: '', intro: '', projectType: 'full', createdAt: now, updatedAt: now })
  await memoryOps.put('volumes', { id: 'v-domain', projectId, order: 0, title: '第一卷', description: '', createdAt: now })
  db.setCurrentProject(projectId)
}

function executor(overrides: { draft?: boolean; blocked?: string; notices?: unknown[]; flush?: () => Promise<boolean>; now?: () => number } = {}) {
  const base = defaultExecutorDeps()
  return createAgentExecutor({
    ...base,
    ...(overrides.now ? { now: overrides.now } : {}),
    flush: overrides.flush ?? (async () => true),
    unsavedDraft: () => overrides.draft === true,
    activeChapterId: () => null,
    storageBlockReason: () => overrides.blocked ?? '',
    notify: notice => { overrides.notices?.push(notice) },
  })
}

let seq = 0
async function call(tool: string, args: Record<string, unknown>, scope = fullScope, ex = executor()) {
  return ex.call({ sessionId: 'domain-test', requestId: `req-domain-${String(++seq).padStart(6, '0')}`, tool, args }, scope)
}

function valueOf<T>(result: AgentToolResult): T {
  if (!result.ok) throw new Error(JSON.stringify(result))
  return result.value as T
}

async function main() {
  // ① + ② 地图 / 地点 / 格子
  {
    await seed()
    const created = await call(AGENT_TOOL_NAMES.createMap, { projectId, name: '北境', kilometersPerCell: '1', description: '测试地图' })
    const map = valueOf<{ mapId: string; code?: string }>(created)
    ok('创建地图并自动编号', created.ok && map.code === 'MAP0001', JSON.stringify(created))
    const dup = await call(AGENT_TOOL_NAMES.createMap, { projectId, name: '北境', kilometersPerCell: '1' })
    ok('地图名称唯一', dup.ok === false && dup.code === 'BAD_REQUEST', JSON.stringify(dup))

    const region = valueOf<{ placeId: string }>(await call(AGENT_TOOL_NAMES.createMapPlace, { projectId, mapId: map.mapId, name: '北境', category: '区域' }))
    const city = valueOf<{ placeId: string }>(await call(AGENT_TOOL_NAMES.createMapPlace, { projectId, mapId: map.mapId, name: '霜城', category: '城市', parent: '北境' }))
    const row = await memoryOps.get<TableRow>('tableRows', region.placeId)
    ok('地点归属地图且自动编号', row?.data['所属地图'] === '北境' && row?.data['编号'] === 'G0001', JSON.stringify(row?.data))

    const regionRow = await memoryOps.get<TableRow>('tableRows', region.placeId)
    const regionHash = cellsHash(parseCells(regionRow?.data['地图格子']))
    const painted = await call(AGENT_TOOL_NAMES.updateMapPlaceCells, {
      projectId, placeId: region.placeId, expectedUpdatedAt: regionRow!.updatedAt, expectedCellsHash: regionHash,
      add: ['0,0', '0,1', '1,0', '1,1'],
    })
    ok('父范围涂格成功', painted.ok === true, JSON.stringify(painted))
    const afterParent = await memoryOps.get<TableRow>('tableRows', region.placeId)
    ok('父范围格子数与指纹可回读', parseCells(afterParent?.data['地图格子']).size === 4 && cellsHash(parseCells(afterParent?.data['地图格子'])) === (painted.ok ? (painted.value as { cellsHash: string }).cellsHash : ''))

    const cityRow = await memoryOps.get<TableRow>('tableRows', city.placeId)
    const cityHash = cellsHash(parseCells(cityRow?.data['地图格子']))
    const outside = await call(AGENT_TOOL_NAMES.updateMapPlaceCells, {
      projectId, placeId: city.placeId, expectedUpdatedAt: cityRow!.updatedAt, expectedCellsHash: cityHash,
      add: ['5,5'],
    })
    ok('子范围超出祖先被拒绝', outside.ok === false && outside.code === 'BAD_REQUEST', JSON.stringify(outside))

    const inside = await call(AGENT_TOOL_NAMES.updateMapPlaceCells, {
      projectId, placeId: city.placeId, expectedUpdatedAt: cityRow!.updatedAt, expectedCellsHash: cityHash,
      add: ['0,0', '0,1'],
    })
    ok('子范围落在祖先内成功', inside.ok === true, JSON.stringify(inside))

    const stale = await call(AGENT_TOOL_NAMES.updateMapPlaceCells, {
      projectId, placeId: city.placeId, expectedUpdatedAt: cityRow!.updatedAt, expectedCellsHash: cityHash,
      add: ['1,1'],
    })
    ok('旧格子指纹/版本被拒绝', stale.ok === false && (stale.code === 'CONFLICT'), JSON.stringify(stale))

    const erase = await call(AGENT_TOOL_NAMES.updateMapPlaceCells, {
      projectId, placeId: region.placeId, expectedUpdatedAt: afterParent!.updatedAt,
      expectedCellsHash: cellsHash(parseCells(afterParent?.data['地图格子'])), remove: ['0,0'],
    })
    ok('擦除被子孙占用的格子被拒绝', erase.ok === false && erase.code === 'DEPENDENCY_BLOCKED', JSON.stringify(erase))

    // ③ 页面租约
    const release = registerFormEditor(projectId, tableLeaseKey('geography'))
    const blocked = await call(AGENT_TOOL_NAMES.createMapPlace, { projectId, mapId: map.mapId, name: '被占用' })
    ok('《地理风物》打开时拒绝创建地点', blocked.ok === false && blocked.code === 'DRAFT_DIRTY', JSON.stringify(blocked))
    release()

    // ④ 改名级联与删除保护
    const mapBefore = await memoryOps.get<TableRow>('tableRows', map.mapId)
    const renamed = await call(AGENT_TOOL_NAMES.updateMap, {
      projectId, mapId: map.mapId, expectedName: '北境', expectedUpdatedAt: mapBefore!.updatedAt, name: '极北',
    })
    ok('地图改名成功并级联引用', renamed.ok === true && (renamed.value as { referencesUpdated: number }).referencesUpdated === 2, JSON.stringify(renamed))
    const cityAfter = await memoryOps.get<TableRow>('tableRows', city.placeId)
    ok('地点所属地图已级联更新', cityAfter?.data['所属地图'] === '极北', JSON.stringify(cityAfter?.data))
    const mapAfter = await memoryOps.get<TableRow>('tableRows', map.mapId)
    const delBlocked = await call(AGENT_TOOL_NAMES.deleteMap, { projectId, mapId: map.mapId, expectedUpdatedAt: mapAfter!.updatedAt, confirm: true })
    ok('仍有地点引用时拒绝删除地图', delBlocked.ok === false && delBlocked.code === 'DEPENDENCY_BLOCKED', JSON.stringify(delBlocked))
  }

  // ⑤ 情节画布
  {
    await seed()
    const empty = valueOf<{ fingerprint: string }>(await call(AGENT_TOOL_NAMES.readPlotCanvas, { projectId }))
    const card = valueOf<{ cardId: string; fingerprint: string }>(await call(AGENT_TOOL_NAMES.createPlotCard, {
      projectId, expectedFingerprint: empty.fingerprint, text: '开场', x: 100, y: 120,
    }))
    ok('创建情节卡并返回新指纹', !!card.cardId && card.fingerprint !== empty.fingerprint, JSON.stringify(card))
    const stale = await call(AGENT_TOOL_NAMES.updatePlotCard, {
      projectId, cardId: card.cardId, expectedFingerprint: empty.fingerprint, text: '不该写入',
    })
    ok('旧画布指纹被拒绝', stale.ok === false && stale.code === 'CONFLICT', JSON.stringify(stale))
    const updated = valueOf<{ fingerprint: string }>(await call(AGENT_TOOL_NAMES.updatePlotCard, {
      projectId, cardId: card.cardId, expectedFingerprint: card.fingerprint, text: '开场（改）',
    }))
    const card2 = valueOf<{ cardId: string; fingerprint: string }>(await call(AGENT_TOOL_NAMES.createPlotCard, {
      projectId, expectedFingerprint: updated.fingerprint, text: '转折', x: 300, y: 300,
    }))
    const linked = valueOf<{ connections: number; fingerprint: string }>(await call(AGENT_TOOL_NAMES.updatePlotConnections, {
      projectId, expectedFingerprint: card2.fingerprint, add: [[card.cardId, card2.cardId]],
    }))
    ok('画布连线成功', linked.connections === 1, JSON.stringify(linked))
    const release = registerFormEditor(projectId, canvasLeaseKey)
    const blocked = await call(AGENT_TOOL_NAMES.deletePlotCard, {
      projectId, cardId: card.cardId, expectedFingerprint: linked.fingerprint,
    })
    ok('画布打开时拒绝删除卡片', blocked.ok === false && blocked.code === 'DRAFT_DIRTY', JSON.stringify(blocked))
    release()
    const removed = valueOf<{ removedConnections: number }>(await call(AGENT_TOOL_NAMES.deletePlotCard, {
      projectId, cardId: card.cardId, expectedFingerprint: linked.fingerprint,
    }))
    ok('删除卡片同时移除连线', removed.removedConnections === 1, JSON.stringify(removed))
  }

  // 损坏画布不得被过滤后再写回，避免静默丢失未知条目。
  {
    await seed()
    const damaged = { selected: [], cards: [{ id: 'kept', text: '保留' }, { text: '缺少 ID 的内容' }], conns: [] }
    await db.setSettingFor(projectId, 'plotCanvas', damaged)
    const read = await call(AGENT_TOOL_NAMES.readPlotCanvas, { projectId })
    const write = await call(AGENT_TOOL_NAMES.createPlotCard, { projectId, expectedFingerprint: '00000000', text: '新卡', x: 1, y: 2 })
    const after = await db.getSettingFor(projectId, 'plotCanvas', null)
    ok('损坏画布拒绝读取和写入并保留原始内容', !read.ok && !write.ok && JSON.stringify(after) === JSON.stringify(damaged), JSON.stringify({ read, write }))
  }

  // ⑥ 世界包引入（预览 + 确认 + 跨项目授权）
  {
    await seed()
    const now = Date.now()
    const worldId = 'w-domain'
    await memoryOps.put('worlds', {
      id: worldId, name: '合成世界', origin: { projectId: otherProjectId, projectName: '来源项目', at: now },
      tables: [{ tabId: 'nations', kind: 'table', rows: [{ id: 'r1', data: { 名称: '北国' }, order: 0 }] }],
      activeSubs: {}, fingerprint: 'fp-domain', versions: [], createdAt: now, updatedAt: now,
    })
    const preview = await call(AGENT_TOOL_NAMES.previewWorldImport, { projectId, worldId })
    const pv = valueOf<{ requiredTabs: string[]; projectUpdatedAt: number; fingerprint: string }>(preview)
    ok('世界包预览返回目标表清单', JSON.stringify(pv.requiredTabs) === '["nations"]', JSON.stringify(pv))
    const noConfirm = await call(AGENT_TOOL_NAMES.importWorldPack, {
      projectId, worldId, expectedTabs: pv.requiredTabs, expectedFingerprint: pv.fingerprint, expectedProjectUpdatedAt: pv.projectUpdatedAt,
    })
    ok('未确认时拒绝引入世界包', noConfirm.ok === false && noConfirm.code === 'BAD_REQUEST', JSON.stringify(noConfirm))
    const wrongTabs = await call(AGENT_TOOL_NAMES.importWorldPack, {
      projectId, worldId, expectedTabs: ['char-main'], expectedFingerprint: pv.fingerprint, expectedProjectUpdatedAt: pv.projectUpdatedAt, confirm: true,
    })
    ok('目标表清单与预览不一致时拒绝', wrongTabs.ok === false && wrongTabs.code === 'CONFLICT', JSON.stringify(wrongTabs))
    const noRead = await call(AGENT_TOOL_NAMES.importWorldPack, {
      projectId, worldId, expectedTabs: pv.requiredTabs, expectedFingerprint: pv.fingerprint, expectedProjectUpdatedAt: pv.projectUpdatedAt, confirm: true,
    }, { projects: [{ projectId, actions: ['world:write'] }] })
    ok('跨项目来源缺少 world:read 时拒绝', noRead.ok === false && noRead.code === 'SCOPE_DENIED', JSON.stringify(noRead))
    const originalWorld = await memoryOps.get<WorldStoredRecord>('worlds', worldId)
    if (!originalWorld) throw new Error('世界包夹具缺失')
    await memoryOps.put('worlds', { ...originalWorld, fingerprint: 'changed-same-tabs' })
    const stale = await call(AGENT_TOOL_NAMES.importWorldPack, {
      projectId, worldId, expectedTabs: pv.requiredTabs, expectedFingerprint: pv.fingerprint, expectedProjectUpdatedAt: pv.projectUpdatedAt, confirm: true,
    })
    ok('世界包同表内容变化后旧预览被拒绝', !stale.ok && stale.code === 'CONFLICT', JSON.stringify(stale))
    await memoryOps.put('worlds', originalWorld)
    const imported = await call(AGENT_TOOL_NAMES.importWorldPack, {
      projectId, worldId, expectedTabs: pv.requiredTabs, expectedFingerprint: pv.fingerprint, expectedProjectUpdatedAt: pv.projectUpdatedAt, confirm: true,
    })
    ok('世界包引入成功并落盘回读', imported.ok === true, JSON.stringify(imported))
    const rows = await memoryOps.getAll<TableRow>('tableRows')
    ok('引入后目标表只有快照内容', rows.filter(row => row.projectId === projectId && row.tabId === 'nations').length === 1
      && rows.some(row => row.projectId === projectId && row.tabId === 'nations' && row.data['名称'] === '北国'))
  }

  // 注入持久化失败：回滚返回后若仍无法确认落盘，不能报告已回滚。
  {
    await seed()
    const now = Date.now()
    await memoryOps.put('worlds', {
      id: 'w-fault', name: '故障世界', origin: { projectId: otherProjectId, projectName: '来源', at: now },
      tables: [{ tabId: 'nations', kind: 'table', rows: [{ id: 'r', data: { 名称: '测试' }, order: 0 }] }],
      activeSubs: {}, fingerprint: 'fp-fault', versions: [], createdAt: now, updatedAt: now,
    })
    const pv = valueOf<{ requiredTabs: string[]; projectUpdatedAt: number; fingerprint: string }>(await call(AGENT_TOOL_NAMES.previewWorldImport, { projectId, worldId: 'w-fault' }))
    let flushes = 0
    const result = await call(AGENT_TOOL_NAMES.importWorldPack, {
      projectId, worldId: 'w-fault', expectedTabs: pv.requiredTabs, expectedFingerprint: pv.fingerprint, expectedProjectUpdatedAt: pv.projectUpdatedAt, confirm: true,
    }, fullScope, executor({ flush: async () => ++flushes === 1 }))
    ok('导入及回滚落盘未确认时报告结果不明', !result.ok && result.code === 'OUTCOME_UNKNOWN', JSON.stringify(result))
  }

  {
    await seed()
    const now = Date.now()
    await memoryOps.put('worlds', {
      id: 'w-owner', name: '项目切换测试', origin: { projectId: otherProjectId, projectName: '来源', at: now },
      tables: [{ tabId: 'nations', kind: 'table', rows: [{ id: 'r', data: { 名称: '测试' }, order: 0 }] }],
      activeSubs: {}, fingerprint: 'fp-owner', versions: [], createdAt: now, updatedAt: now,
    })
    const pv = valueOf<{ requiredTabs: string[]; projectUpdatedAt: number; fingerprint: string }>(await call(AGENT_TOOL_NAMES.previewWorldImport, { projectId, worldId: 'w-owner' }))
    const result = await call(AGENT_TOOL_NAMES.importWorldPack, {
      projectId, worldId: 'w-owner', expectedTabs: pv.requiredTabs, expectedFingerprint: pv.fingerprint, expectedProjectUpdatedAt: pv.projectUpdatedAt, confirm: true,
    }, fullScope, executor({ flush: async () => { db.setCurrentProject(otherProjectId); return true } }))
    const volume = await memoryOps.get<{ id: string }>('volumes', 'v-domain')
    ok('预备份期间切换项目后不导入也不覆盖回滚', !result.ok && !!volume, JSON.stringify(result))
    db.setCurrentProject(projectId)
  }

  // ⑥a-2 引入过程中切换项目：不得把行写进新项目；归属失效后报告结果不明
  {
    await seed()
    const now = Date.now()
    await memoryOps.put('worlds', {
      id: 'w-mid-switch', name: '引入中切换', origin: { projectId: otherProjectId, projectName: '来源', at: now },
      tables: [{ tabId: 'nations', kind: 'table', rows: [
        { id: 'r1', data: { 名称: '第一国' }, order: 0 },
        { id: 'r2', data: { 名称: '第二国' }, order: 1 },
      ] }],
      activeSubs: {}, fingerprint: 'fp-mid-switch', versions: [], createdAt: now, updatedAt: now,
    })
    const pv = valueOf<{ requiredTabs: string[]; projectUpdatedAt: number; fingerprint: string }>(await call(AGENT_TOOL_NAMES.previewWorldImport, { projectId, worldId: 'w-mid-switch' }))
    const base = defaultExecutorDeps()
    let switched = false
    const switching = createAgentExecutor({
      ...base,
      flush: async () => true,
      unsavedDraft: () => false,
      activeChapterId: () => null,
      storageBlockReason: () => '',
      captureOwner: (pid) => {
        const owner = base.captureOwner(pid)
        const store = new Proxy(owner.store, {
          get(target, prop, receiver) {
            if (prop === 'put') {
              return async (storeName: string, record: unknown) => {
                await target.put(storeName, record)
                if (!switched && storeName === 'tableRows') { switched = true; db.setCurrentProject(otherProjectId) }
              }
            }
            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        return { ...owner, store }
      },
    })
    const result = await switching.call({
      sessionId: 'domain-test', requestId: 'req-domain-mid-switch',
      tool: AGENT_TOOL_NAMES.importWorldPack,
      args: {
        projectId, worldId: 'w-mid-switch', expectedTabs: pv.requiredTabs,
        expectedFingerprint: pv.fingerprint, expectedProjectUpdatedAt: pv.projectUpdatedAt, confirm: true,
      },
    }, fullScope)
    const leaked = (await memoryOps.getAll<TableRow>('tableRows')).filter(row => row.projectId === otherProjectId && row.tabId === 'nations')
    ok('引入中切换项目不把行写进新项目', switched && leaked.length === 0, JSON.stringify({ result, leaked }))
    ok('引入中切换项目报告结果不明', !result.ok && result.code === 'OUTCOME_UNKNOWN', JSON.stringify(result))
    db.setCurrentProject(projectId)
  }

  // ⑥b 回收站恢复
  {
    await seed()
    const created = valueOf<{ chapterId: string }>(await call(AGENT_TOOL_NAMES.createChapter, { projectId, title: '待删章', content: '正文' }))
    const chapter = await memoryOps.get<{ updatedAt: number }>('chapters', created.chapterId)
    const deleted = await call(AGENT_TOOL_NAMES.deleteChapter, { projectId, chapterId: created.chapterId, expectedUpdatedAt: chapter!.updatedAt })
    ok('章节删除进入回收站', deleted.ok === true, JSON.stringify(deleted))
    const trash = valueOf<{ total: number; items: { id: string; deletedAt: number }[] }>(await call(AGENT_TOOL_NAMES.listChapterTrash, { projectId }))
    ok('回收站可列出被删章节', trash.total === 1 && trash.items[0]?.id === created.chapterId, JSON.stringify(trash))
    const restored = await call(AGENT_TOOL_NAMES.restoreChapter, { projectId, chapterId: created.chapterId, expectedDeletedAt: trash.items[0]?.deletedAt })
    ok('从回收站恢复章节', restored.ok === true, JSON.stringify(restored))
    const after = await memoryOps.get<{ id: string }>('chapters', created.chapterId)
    const trashAfter = valueOf<{ total: number }>(await call(AGENT_TOOL_NAMES.listChapterTrash, { projectId }))
    ok('恢复后章节回到正文且回收站清空', !!after && trashAfter.total === 0, JSON.stringify(trashAfter))
    const wrongVersion = await call(AGENT_TOOL_NAMES.restoreChapter, { projectId, chapterId: created.chapterId, expectedDeletedAt: 1 })
    ok('回收站条目不存在时失败关闭', wrongVersion.ok === false && wrongVersion.code === 'NOT_FOUND', JSON.stringify(wrongVersion))
  }

  // ⑥c 灵感修改/删除 + Agent 检查报告落库
  {
    await seed()
    const added = valueOf<{ inspirationId: string; text: string }>(await call(AGENT_TOOL_NAMES.addInspiration, { projectId, text: '旧灵感' }))
    const updated = await call(AGENT_TOOL_NAMES.updateInspiration, { projectId, inspirationId: added.inspirationId, text: '新灵感', expectedText: '旧灵感' })
    ok('灵感按旧文本修改成功', updated.ok === true, JSON.stringify(updated))
    const stale = await call(AGENT_TOOL_NAMES.updateInspiration, { projectId, inspirationId: added.inspirationId, text: '再改', expectedText: '旧灵感' })
    ok('灵感旧文本不符时冲突', stale.ok === false && stale.code === 'CONFLICT', JSON.stringify(stale))
    const noConfirm = await call(AGENT_TOOL_NAMES.deleteInspiration, { projectId, inspirationId: added.inspirationId, expectedText: '新灵感' })
    ok('删除灵感必须确认', noConfirm.ok === false && noConfirm.code === 'BAD_REQUEST', JSON.stringify(noConfirm))
    const removed = await call(AGENT_TOOL_NAMES.deleteInspiration, { projectId, inspirationId: added.inspirationId, expectedText: '新灵感', confirm: true })
    ok('灵感删除成功', removed.ok === true, JSON.stringify(removed))
    const list = valueOf<{ id: string }[]>(await call(AGENT_TOOL_NAMES.listInspirations, { projectId }))
    ok('灵感删除后列表为空', list.length === 0, JSON.stringify(list))

    const chapter = valueOf<{ chapterId: string; title: string }>(await call(AGENT_TOOL_NAMES.createChapter, { projectId, title: '审读章', content: '正文' }))
    const bad = await call(AGENT_TOOL_NAMES.saveCheckReport, {
      projectId, checkId: 'agent-audit', findings: [{ level: '致命', title: '非法级别' }],
    })
    ok('检查报告拒绝非法级别', bad.ok === false && bad.code === 'BAD_REQUEST', JSON.stringify(bad))
    const saved = await call(AGENT_TOOL_NAMES.saveCheckReport, {
      projectId, checkId: 'agent-audit', chapterId: chapter.chapterId, summary: '外部 Agent 审读',
      findings: [
        { level: '严重', title: '时间线矛盾', detail: '第二章与第三章日期冲突', where: '第三日清晨' },
        { level: '提示', title: '视角漂移', detail: '建议统一第三人称' },
      ],
    })
    const report = valueOf<{ reportId: string; serious: number; info: number }>(saved)
    ok('Agent 检查报告落库并计数', saved.ok && report.serious === 1 && report.info === 1, JSON.stringify(saved))
    const views = valueOf<{ reports: { id: string; source: string; checkId: string }[] }>(await call(AGENT_TOOL_NAMES.listCheckReports, { projectId }))
    ok('检查报告可在列表回看', views.reports.some(item => item.id === report.reportId && item.source === 'agent' && item.checkId === 'agent-audit'), JSON.stringify(views))
    const detail = valueOf<{ findings: { level: string }[] }>(await call(AGENT_TOOL_NAMES.readCheckReport, { projectId, reportId: report.reportId }))
    ok('检查报告详情返回发现', detail.findings.length === 2 && detail.findings[0]?.level === '严重', JSON.stringify(detail))
    const unconfirmed = await call(AGENT_TOOL_NAMES.saveCheckReport, {
      projectId, checkId: 'flush-fault', findings: [{ level: '提示', title: '需核对', detail: '合成报告' }],
    }, fullScope, executor({ flush: async () => false }))
    ok('报告写入未确认落盘时明确结果不明', !unconfirmed.ok && unconfirmed.code === 'OUTCOME_UNKNOWN', JSON.stringify(unconfirmed))
  }

  // ⑦ 备份恢复预览 / 确认 / 版本前置
  {
    await seed()
    const now = Date.now()
    await memoryOps.put('backups', { id: 'b-domain', projectId, kind: 'manual', label: '合成备份', createdAt: now, bytes: 10 })
    // 备份载荷缺失：预览必须明确拒绝，不能假装可恢复
    const missing = await call(AGENT_TOOL_NAMES.previewBackupRestore, { projectId, backupId: 'b-domain' })
    ok('载荷缺失的备份预览失败关闭', missing.ok === false && missing.code === 'NOT_FOUND', JSON.stringify(missing))
    const noConfirm = await call(AGENT_TOOL_NAMES.restoreProjectBackup, {
      projectId, backupId: 'b-domain', expectedProjectUpdatedAt: 0,
    })
    ok('未确认时拒绝恢复备份', noConfirm.ok === false && noConfirm.code === 'BAD_REQUEST', JSON.stringify(noConfirm))
    const otherBackup = await call(AGENT_TOOL_NAMES.restoreProjectBackup, {
      projectId, backupId: 'not-mine', expectedProjectUpdatedAt: 0, confirm: true,
    })
    ok('不属于该项目的备份被拒绝', otherBackup.ok === false && otherBackup.code === 'NOT_FOUND', JSON.stringify(otherBackup))
    const draftBlocked = await call(AGENT_TOOL_NAMES.restoreProjectBackup, {
      projectId, backupId: 'b-domain', expectedProjectUpdatedAt: 0, confirm: true,
    }, fullScope, executor({ draft: true }))
    ok('有未保存草稿时拒绝恢复', draftBlocked.ok === false && draftBlocked.code === 'DRAFT_DIRTY', JSON.stringify(draftBlocked))
  }

  // ⑦b 真实备份的预览与恢复（引擎会先建安全预备份）
  {
    await seed()
    const now = Date.now()
    await memoryOps.put('chapters', {
      id: 'ch-original', projectId, volumeId: 'v-domain', order: 0, title: '原始章', content: '原始正文',
      summary: '', status: '草稿', wordCount: 4, createdAt: now, updatedAt: now,
    })
    const backup = await db.createAutoBackup(projectId, 'manual', '合成备份 V1')
    if (!backup) {
      ok('创建合成备份失败（跳过恢复用例）', false)
    } else {
      const preview = valueOf<{ projectUpdatedAt: number; current: { chapters: number } }>(await call(AGENT_TOOL_NAMES.previewBackupRestore, { projectId, backupId: backup.id }))
      ok('备份预览返回当前章节数', preview.current.chapters === 1, JSON.stringify(preview))
      await memoryOps.put('chapters', {
        id: 'ch-after', projectId, volumeId: 'v-domain', order: 1, title: '备份后的新章', content: '新内容',
        summary: '', status: '草稿', wordCount: 3, createdAt: now + 1, updatedAt: now + 1,
      })
      const restored = await call(AGENT_TOOL_NAMES.restoreProjectBackup, {
        projectId, backupId: backup.id, expectedProjectUpdatedAt: preview.projectUpdatedAt, confirm: true,
      })
      ok('备份恢复成功并返回预备份', restored.ok === true && !!(restored.ok ? (restored.value as { preBackupId?: string }).preBackupId : ''), JSON.stringify(restored))
      const chapters = await memoryOps.getAll<{ id: string; title: string }>('chapters')
      ok('恢复后回到备份内容', chapters.length === 1 && chapters[0]?.title === '原始章', JSON.stringify(chapters))
      const stale = await call(AGENT_TOOL_NAMES.restoreProjectBackup, {
        projectId, backupId: backup.id, expectedProjectUpdatedAt: preview.projectUpdatedAt, confirm: true,
      })
      ok('恢复后项目版本前置失效时拒绝', stale.ok === false && stale.code === 'CONFLICT', JSON.stringify(stale))
    }
  }

  // ⑦c 备份恢复期间切换存储空间：写入必须仍落在入口捕获的 store，不能漏到新空间
  {
    await seed()
    const now = Date.now()
    await memoryOps.put('chapters', {
      id: 'ch-before-switch', projectId, volumeId: 'v-domain', order: 0, title: '备份里的章', content: '备份正文',
      summary: '', status: '草稿', wordCount: 4, createdAt: now, updatedAt: now,
    })
    const backup = await db.createAutoBackup(projectId, 'manual', '存储切换测试')
    if (!backup) {
      ok('创建存储切换备份失败（跳过）', false)
    } else {
      const pv = valueOf<{ projectUpdatedAt: number }>(await call(AGENT_TOOL_NAMES.previewBackupRestore, { projectId, backupId: backup.id }))
      const altPrefix = 'alt-store::'
      const altStore = {
        getAll: <T>(name: string) => memoryOps.getAll<T>(altPrefix + name),
        get: <T>(name: string, key: string) => memoryOps.get<T>(altPrefix + name, key),
        put: (name: string, value: unknown) => memoryOps.put(altPrefix + name, value),
        del: (name: string, key: string) => memoryOps.del(altPrefix + name, key),
        getAllByIndex: <T>(name: string, index: string, value: unknown) => memoryOps.getAllByIndex<T>(altPrefix + name, index, value),
        bulkPut: (name: string, values: unknown[]) => memoryOps.bulkPut(altPrefix + name, values),
        bulkDel: (name: string, keys: (string | number)[]) => memoryOps.bulkDel(altPrefix + name, keys),
      }
      const base = defaultExecutorDeps()
      let switched = false
      const switching = createAgentExecutor({
        ...base,
        flush: async () => true,
        unsavedDraft: () => false,
        activeChapterId: () => null,
        storageBlockReason: () => '',
        captureOwner: (pid) => {
          const owner = base.captureOwner(pid)
          const store = new Proxy(owner.store, {
            get(target, prop, receiver) {
              if (prop === 'put') {
                return async (storeName: string, record: unknown) => {
                  await target.put(storeName, record)
                  if (!switched && storeName === 'volumes') { switched = true; db.setStoreOps(altStore) }
                }
              }
              const value = Reflect.get(target, prop, receiver)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
          return { ...owner, store }
        },
      })
      const result = await switching.call({
        sessionId: 'domain-test', requestId: 'req-domain-restore-switch',
        tool: AGENT_TOOL_NAMES.restoreProjectBackup,
        args: { projectId, backupId: backup.id, expectedProjectUpdatedAt: pv.projectUpdatedAt, confirm: true },
      }, fullScope)
      const altVolumes = await memoryOps.getAll<{ id: string }>(altPrefix + 'volumes')
      const altChapters = await memoryOps.getAll<{ id: string }>(altPrefix + 'chapters')
      ok('恢复中切换存储不把数据写进新空间', switched && altVolumes.length === 0 && altChapters.length === 0, JSON.stringify({ result, altVolumes, altChapters }))
      ok('恢复中切换存储报告结果不明', !result.ok && result.code === 'OUTCOME_UNKNOWN', JSON.stringify(result))
      const restored = await memoryOps.getAll<{ title: string }>('chapters')
      ok('原存储仍按备份恢复', restored.some(chapter => chapter.title === '备份里的章'), JSON.stringify(restored))
      db.setStoreOps(memoryOps)
    }
  }

  // ⑧ 外部 Agent 任务台账（可跨调用恢复进度 / 协作式取消）
  {
    await seed()
    const limited = { projects: [{ projectId, actions: ['chapter:write' as const] }] }
    const denied = await call(AGENT_TOOL_NAMES.startAgentTask, { projectId, title: '越权任务' }, limited)
    ok('未授权 task:write 时拒绝登记任务', denied.ok === false && denied.code === 'SCOPE_DENIED', JSON.stringify(denied))

    const started = await call(AGENT_TOOL_NAMES.startAgentTask, { projectId, title: '全书审读', kind: 'review', totalSteps: 10, note: '逐章检查' })
    const task = valueOf<{ taskId: string; updatedAt: number; status: string }>(started)
    ok('创建任务并返回 taskId', started.ok && task.status === 'running', JSON.stringify(started))

    const listed = valueOf<{ total: number; tasks: Array<{ id: string }> }>(await call(AGENT_TOOL_NAMES.listAgentTasks, { projectId }))
    ok('任务台账可列出', listed.total === 1 && listed.tasks[0]?.id === task.taskId, JSON.stringify(listed))

    const stale = await call(AGENT_TOOL_NAMES.updateAgentTask, { projectId, taskId: task.taskId, expectedUpdatedAt: task.updatedAt + 1, progress: 50 })
    ok('任务版本前置失效时拒绝更新', stale.ok === false && stale.code === 'CONFLICT', JSON.stringify(stale))

    const updated = await call(AGENT_TOOL_NAMES.updateAgentTask, { projectId, taskId: task.taskId, expectedUpdatedAt: task.updatedAt, progress: 50, currentStep: 5 })
    const afterUpdate = valueOf<{ updatedAt: number; progress: number }>(updated)
    ok('更新进度成功', updated.ok && afterUpdate.progress === 50, JSON.stringify(updated))

    const paused = await call(AGENT_TOOL_NAMES.updateAgentTask, { projectId, taskId: task.taskId, expectedUpdatedAt: afterUpdate.updatedAt, status: 'paused' })
    const pausedTask = valueOf<{ status: string; updatedAt: number }>(paused)
    ok('任务可暂停', paused.ok && pausedTask.status === 'paused', JSON.stringify(paused))

    const cancelled = await call(AGENT_TOOL_NAMES.cancelAgentTask, { projectId, taskId: task.taskId, expectedUpdatedAt: pausedTask.updatedAt })
    const cancelledTask = valueOf<{ cancelRequested: boolean; updatedAt: number }>(cancelled)
    ok('取消请求被登记为协作式标记', cancelled.ok && cancelledTask.cancelRequested === true, JSON.stringify(cancelled))

    const finished = await call(AGENT_TOOL_NAMES.finishAgentTask, { projectId, taskId: task.taskId, expectedUpdatedAt: cancelledTask.updatedAt, status: 'done', summary: '共 10 章完成' })
    const afterFinish = valueOf<{ progress: number; status: string; updatedAt: number }>(finished)
    ok('结束任务后进度归 100', finished.ok && afterFinish.progress === 100 && afterFinish.status === 'done', JSON.stringify(finished))

    const again = await call(AGENT_TOOL_NAMES.updateAgentTask, { projectId, taskId: task.taskId, expectedUpdatedAt: afterFinish.updatedAt, progress: 80 })
    ok('已结束任务不能再更新', again.ok === false && again.code === 'CONFLICT', JSON.stringify(again))

    const read = valueOf<{ summary: string; cancelRequested: boolean }>(await call(AGENT_TOOL_NAMES.getAgentTask, { projectId, taskId: task.taskId }))
    ok('可读取任务总结', read.summary === '共 10 章完成' && read.cancelRequested === true, JSON.stringify(read))
  }

  // 台账损坏、满容量和同一毫秒版本不得覆盖或误报成功。
  {
    await seed()
    const damaged = { version: 1, tasks: [{ id: 'ok' }, { unexpected: true }] }
    await db.setSettingFor(projectId, 'agentTasks', damaged)
    const rejected = await call(AGENT_TOOL_NAMES.startAgentTask, { projectId, title: '不得覆盖' })
    const after = await db.getSettingFor(projectId, 'agentTasks', null)
    ok('损坏任务台账拒绝覆盖并保留原始内容', !rejected.ok && JSON.stringify(after) === JSON.stringify(damaged))
    const tasks = Array.from({ length: 50 }, (_, i) => ({ id: `active-${i}`, title: '任务', kind: 'agent', status: 'running', progress: 0, note: '', summary: '', cancelRequested: false, createdAt: 1, updatedAt: 1 }))
    await db.setSettingFor(projectId, 'agentTasks', { version: 1, tasks })
    const full = await call(AGENT_TOOL_NAMES.startAgentTask, { projectId, title: '超额' })
    const state = await db.getSettingFor<{ tasks: unknown[] }>(projectId, 'agentTasks', { tasks: [] })
    ok('50 个未结束任务时拒绝新增且保留现有记录', !full.ok && state.tasks.length === 50)
    await db.setSettingFor(projectId, 'agentTasks', { version: 1, tasks: [] })
    const fixed = executor({ now: () => 1000 })
    const started = valueOf<{ taskId: string; updatedAt: number }>(await call(AGENT_TOOL_NAMES.startAgentTask, { projectId, title: '同毫秒' }, fullScope, fixed))
    const updated = valueOf<{ updatedAt: number }>(await call(AGENT_TOOL_NAMES.updateAgentTask, { projectId, taskId: started.taskId, expectedUpdatedAt: started.updatedAt, progress: 10 }, fullScope, fixed))
    const stale = await call(AGENT_TOOL_NAMES.updateAgentTask, { projectId, taskId: started.taskId, expectedUpdatedAt: started.updatedAt, progress: 20 }, fullScope, fixed)
    ok('同毫秒更新仍递增版本并拒绝旧版本', updated.updatedAt > started.updatedAt && !stale.ok && stale.code === 'CONFLICT')
    const done = valueOf<{ updatedAt: number }>(await call(AGENT_TOOL_NAMES.finishAgentTask, { projectId, taskId: started.taskId, expectedUpdatedAt: updated.updatedAt, status: 'done' }, fullScope, fixed))
    const repeated = await call(AGENT_TOOL_NAMES.finishAgentTask, { projectId, taskId: started.taskId, expectedUpdatedAt: done.updatedAt, status: 'failed' }, fullScope, fixed)
    ok('已结束任务不能被再次改写结局', !repeated.ok && repeated.code === 'CONFLICT')
  }

  // 两个调用同时读取台账时不得彼此覆盖：检查最终持久内容而非仅检查返回值。
  {
    await seed()
    const ex = executor()
    const [first, second] = await Promise.all([
      call(AGENT_TOOL_NAMES.startAgentTask, { projectId, title: '并发任务一' }, fullScope, ex),
      call(AGENT_TOOL_NAMES.startAgentTask, { projectId, title: '并发任务二' }, fullScope, ex),
    ])
    const persisted = await db.getSettingFor<{ tasks: Array<{ title: string }> }>(projectId, 'agentTasks', { tasks: [] })
    ok('并发创建任务均成功且持久保留', first.ok && second.ok && persisted.tasks.length === 2 && persisted.tasks.some(t => t.title === '并发任务一') && persisted.tasks.some(t => t.title === '并发任务二'), JSON.stringify({ first, second, persisted }))
    const task = valueOf<{ taskId: string; updatedAt: number }>(first)
    const [update, cancel] = await Promise.all([
      call(AGENT_TOOL_NAMES.updateAgentTask, { projectId, taskId: task.taskId, expectedUpdatedAt: task.updatedAt, progress: 30 }, fullScope, ex),
      call(AGENT_TOOL_NAMES.cancelAgentTask, { projectId, taskId: task.taskId, expectedUpdatedAt: task.updatedAt }, fullScope, ex),
    ])
    const current = valueOf<{ progress: number; cancelRequested: boolean }>(await call(AGENT_TOOL_NAMES.getAgentTask, { projectId, taskId: task.taskId }, fullScope, ex))
    ok('并发更新与取消按版本冲突而不覆盖', update.ok && !cancel.ok && cancel.code === 'CONFLICT' && current.progress === 30 && !current.cancelRequested, JSON.stringify({ update, cancel, current }))
  }

  console.log(`RESULT ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
