// Agent 写入执行器 · 隔离单测（3.4.3）
//
// 覆盖（对应设计文档 P1 的验收要求）：
//   ① 授权：未授权动作 → SCOPE_DENIED，且不写库；
//   ② 归属：非当前打开项目 → PROJECT_NOT_OPEN；
//   ③ 创建设定：字段短名 / 全路径映射，写入引擎真实 store；
//   ④ 创建章节：无卷 → NO_VOLUME；有卷 → 正确 order / 字数 / 台账；
//   ⑤ 追加：expectedUpdatedAt 不符 → CONFLICT，不写正文；
//   ⑥ 追加成功：写入前留可恢复快照；
//   ⑦ 草稿脏 → DRAFT_DIRTY，不写正文；
//   ⑧ 落盘失败 → SAVE_FAILED（不可重试），内容仍只在内存；
//   ⑨ 未知工具 / 缺参 → BAD_REQUEST / UNKNOWN_TOOL。
import type { Chapter, Volume } from '@/lib/types'
import * as db from '@/lib/db'
import { AGENT_ACTIONS, AGENT_TOOL_NAMES, agentErrorRetryable, type AgentAction } from '@/lib/agentHost/contract'
import { createAgentExecutor, defaultExecutorDeps, appendText } from '@/lib/agentHost/executor'
import { __resetMockStores, memoryOps } from './mock-memory'
import { getTab } from '@/lib/schema'
import { getActivePack, modulesFor } from '@/lib/schemaTemplates/index'
import { acquireAgentForm, cardLeaseKey, registerFormEditor, tableLeaseKey, tryRegisterFormEditor, waitForAgentForm, withFormSave } from '@/lib/agentHost/formLease'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const projectId = 'p-agent'
const volumeId = 'v-agent'

async function seed() {
  __resetMockStores()
  const now = Date.now()
  await memoryOps.put('projects', {
    id: projectId, name: '合成测试书', genre: '', intro: '', projectType: 'full', createdAt: now, updatedAt: now,
  })
  const vol: Volume = { id: volumeId, projectId, order: 0, title: '第一卷', description: '', createdAt: now }
  await memoryOps.put('volumes', vol)
  db.setCurrentProject(projectId)
}

function executor(overrides: { flush?: () => Promise<boolean>; draft?: boolean; blocked?: string; notices?: unknown[]; activeChapterId?: () => string | null } = {}) {
  const base = defaultExecutorDeps()
  return createAgentExecutor({
    ...base,
    flush: overrides.flush ?? (async () => true),
    unsavedDraft: () => overrides.draft === true,
    activeChapterId: overrides.activeChapterId ?? (() => null),
    storageBlockReason: () => overrides.blocked ?? '',
    notify: notice => { overrides.notices?.push(notice) },
  })
}

const fullScope = { projects: [{ projectId, actions: [...AGENT_ACTIONS] }] }

async function callWrite(tool: string, args: Record<string, unknown>, scope = fullScope, requestId = 'req-00000001') {
  return executor().call({ sessionId: 'test-session', requestId, tool, args }, scope)
}

async function main() {
  {
    await seed()
    const module = modulesFor('worldbase', getActivePack())?.[0]
    const field = module?.fields[0]
    if (!module || !field) throw new Error('合成世界设定需要模板字段')
    const path = `${module.name}::${field.name}`
    const created = await callWrite(AGENT_TOOL_NAMES.createWorldSet, { projectId, tabId: 'worldbase', name: '合成子世界', fields: { [path]: '旧设定' } })
    const cardId = created.ok ? (created.value as { cardId: string }).cardId : ''
    ok('创建多套世界设定默认未激活', created.ok && !!cardId && (created.value as { active: boolean }).active === false, JSON.stringify(created))
    const updated = await callWrite(AGENT_TOOL_NAMES.updateSettingCard, { projectId, tabId: 'worldbase', cardId, fields: { [path]: '新设定' }, expectedFields: { [path]: '旧设定' } })
    ok('按旧值修改世界设定字段', updated.ok === true, JSON.stringify(updated))
    const active = await callWrite(AGENT_TOOL_NAMES.setWorldSetActive, { projectId, tabId: 'worldbase', cardId, active: true, expectedActive: false })
    ok('按旧状态激活世界设定', active.ok === true, JSON.stringify(active))
    const stale = await callWrite(AGENT_TOOL_NAMES.setWorldSetActive, { projectId, tabId: 'worldbase', cardId, active: true, expectedActive: false })
    ok('世界设定活跃状态冲突被拒绝', stale.ok === false && stale.code === 'CONFLICT', JSON.stringify(stale))
  }

  {
    await seed()
    const args = { projectId, tabId: 'nations', fields: { 名称: '合成势力' } }
    const close = registerFormEditor(projectId, tableLeaseKey('nations'))
    const blocked = await callWrite(AGENT_TOOL_NAMES.createTableRow, args)
    ok('表格打开时 Agent 创建条目被拒绝', blocked.ok === false && blocked.code === 'DRAFT_DIRTY')
    close()
    const created = await callWrite(AGENT_TOOL_NAMES.createTableRow, args)
    ok('关闭表格后可创建合成势力', created.ok === true, JSON.stringify(created))
    const rows = await memoryOps.getAll<{ projectId: string; tabId: string; data: Record<string, string> }>('tableRows')
    ok('引擎生成编号且条目归属正确', rows.some(row => row.projectId === projectId && row.tabId === 'nations' && row.data['名称'] === '合成势力' && row.data['编号'] === 'N0001'))
    const duplicate = await callWrite(AGENT_TOOL_NAMES.createTableRow, args)
    ok('重复设定表条目被拒绝', duplicate.ok === false && duplicate.code === 'BAD_REQUEST', JSON.stringify(duplicate))
    const row = (await memoryOps.getAll<{ id: string; tabId: string }>('tableRows')).find(item => item.tabId === 'nations')
    const updateArgs = { projectId, tabId: 'nations', rowId: row?.id, fields: { 备注: '新备注' }, expectedFields: { 备注: '' } }
    const updated = await callWrite(AGENT_TOOL_NAMES.updateTableRow, updateArgs)
    ok('可按旧值前置条件修改基础文本字段', updated.ok === true, JSON.stringify(updated))
    const stale = await callWrite(AGENT_TOOL_NAMES.updateTableRow, updateArgs)
    ok('表格旧值不符时拒绝覆盖', stale.ok === false && stale.code === 'CONFLICT', JSON.stringify(stale))
    const invalidRef = await callWrite(AGENT_TOOL_NAMES.updateTableRow, { projectId, tabId: 'nations', rowId: row?.id, fields: { 上级: '不存在的势力' }, expectedFields: { 上级: '' } })
    ok('表格修改拒绝不存在的引用', invalidRef.ok === false && invalidRef.code === 'BAD_REQUEST', JSON.stringify(invalidRef))
    const selected = await callWrite(AGENT_TOOL_NAMES.updateTableRow, { projectId, tabId: 'nations', rowId: row?.id, fields: { 类别: '宗门' }, expectedFields: { 类别: '' } })
    ok('表格修改支持有效下拉选项', selected.ok === true, JSON.stringify(selected))
    const badDate = await callWrite(AGENT_TOOL_NAMES.createTableRow, { projectId, tabId: 'timeline', fields: { 章节标题: '合成章', 发生时间: '1年13月1日' } })
    ok('时间线拒绝超出项目历法的日期', badDate.ok === false && badDate.code === 'BAD_REQUEST', JSON.stringify(badDate))
    const timeline = await callWrite(AGENT_TOOL_NAMES.createTableRow, { projectId, tabId: 'timeline', fields: { 章节标题: '合成章', 发生时间: '1年2月1日' } })
    const savedTimeline = (await memoryOps.getAll<{ tabId: string; data: Record<string, string> }>('tableRows')).find(item => item.tabId === 'timeline')
    ok('时间线创建遵循结束时间自动跟随规则', timeline.ok === true && savedTimeline?.data['结束时间'] === '1年2月1日', JSON.stringify(timeline))
  }

  // 先开发并登记用例，按要求在功能完成后统一执行。
  {
    await seed()
    const tab = getTab('positioning')
    const module = tab?.modules?.[0]
    const field = module?.fields[0]
    if (!module || !field) throw new Error('合成测试需要作品信息字段')
    const path = `${module.name}::${field.name}`
    const args = { projectId, tabId: 'positioning', fields: { [path]: '新值' }, expectedFields: { [path]: '' } }
    const close = registerFormEditor(projectId, 'positioning')
    const busy = await callWrite(AGENT_TOOL_NAMES.updateForm, args)
    ok('表单打开时 Agent 修改被拒绝', busy.ok === false && busy.code === 'DRAFT_DIRTY')
    close()
    const saved = await callWrite(AGENT_TOOL_NAMES.updateForm, args)
    ok('关闭表单后可修改指定字段', saved.ok === true, JSON.stringify(saved))
    const again = await callWrite(AGENT_TOOL_NAMES.updateForm, args)
    ok('表单旧值不匹配时拒绝覆盖', again.ok === false && again.code === 'CONFLICT', JSON.stringify(again))
    const record = await memoryOps.get<{ data: Record<string, string> }>('formData', `${projectId}::positioning`)
    ok('表单冲突保留已保存内容', record?.data[path] === '新值')
  }

  {
    let finishSave!: () => void
    const pending = withFormSave(projectId, 'lease-test', () => new Promise<void>(resolve => { finishSave = resolve }))
    ok('普通保存期间拒绝 Agent 取得表单写入锁', acquireAgentForm(projectId, 'lease-test') === null)
    finishSave()
    await pending
    const release = acquireAgentForm(projectId, 'lease-test')
    ok('保存结束后 Agent 可取得表单写入锁', !!release)
    ok('Agent 写入期间拒绝打开旧值的内联编辑', tryRegisterFormEditor(projectId, 'lease-test') === null)
    let loaded = false
    const waiting = waitForAgentForm(projectId, 'lease-test').then(() => { loaded = true })
    await Promise.resolve()
    ok('Agent 写入中页面加载等待', !loaded)
    release?.()
    await waiting
    ok('Agent 写入完成后页面加载继续', loaded)
  }

  // 创建操作在最后一次异步检查之后切换项目，也不能写入新归属。
  {
    await seed()
    const base = defaultExecutorDeps()
    const guarded = createAgentExecutor({
      ...base,
      createChapter: async (chapter, owner) => {
        db.setCurrentProject('another-project')
        await base.createChapter(chapter, owner)
      },
      flush: async () => true, unsavedDraft: () => false,
      storageBlockReason: () => '', notify: () => {},
    })
    const res = await guarded.call({ sessionId: 'test-session', requestId: 'req-switch01', tool: AGENT_TOOL_NAMES.createChapter, args: { projectId, title: '禁止误写' } }, fullScope)
    ok('创建章节前切换项目时拒绝写入', res.ok === false && (await memoryOps.getAll<Chapter>('chapters')).length === 0, JSON.stringify(res))
    db.setCurrentProject(projectId)
  }

  // ① 未授权
  {
    await seed()
    const res = await callWrite(AGENT_TOOL_NAMES.createSettingCard, {
      projectId, tabId: 'char-main', name: '林昭', fields: { 姓名: '林昭' },
    }, { projects: [] })
    ok('未授权动作被拒绝（SCOPE_DENIED）', res.ok === false && res.code === 'SCOPE_DENIED', JSON.stringify(res))
    const rows = await memoryOps.getAll<{ tabId: string }>('cardRecords')
    ok('未授权时没有写入任何设定卡', rows.length === 0)
  }

  // ② 项目未打开
  {
    await seed()
    db.setCurrentProject('another-project')
    const res = await callWrite(AGENT_TOOL_NAMES.createSettingCard, {
      projectId, tabId: 'char-main', name: '林昭', fields: { 姓名: '林昭' },
    })
    ok('非当前打开项目被拒绝（PROJECT_NOT_OPEN）', res.ok === false && res.code === 'PROJECT_NOT_OPEN', JSON.stringify(res))
    db.setCurrentProject(projectId)
  }

  // ③ 创建设定卡（短名 → 全路径）
  {
    await seed()
    const res = await callWrite(AGENT_TOOL_NAMES.createSettingCard, {
      projectId, tabId: 'char-main', name: '林昭', fields: { 姓名: '林昭', 核心性格: '冷静' },
    })
    ok('创建设定卡成功', res.ok === true, JSON.stringify(res))
    const rows = await memoryOps.getAll<{ id: string; data: Record<string, string>; name: string; order: number }>('cardRecords')
    const saved = rows.find(r => r.name === '林昭')
    ok('设定卡已进入引擎 store', !!saved)
    ok('字段按 schema 全路径落库', !!saved && Object.keys(saved.data).some(k => k.endsWith('::姓名') && saved.data[k] === '林昭'))
    ok('第一张卡 order = 0', saved?.order === 0, String(saved?.order))
    const listed = await callWrite(AGENT_TOOL_NAMES.listSettingCards, { projectId, tabId: 'char-main', limit: 1 })
    const listValue = listed.ok ? listed.value as { total: number; cards: { id: string }[] } : null
    ok('Agent 可以分页列出设定卡', listValue?.total === 1 && listValue.cards[0]?.id === saved?.id, JSON.stringify(listed))
    const read = await callWrite(AGENT_TOOL_NAMES.readSettingCard, { projectId, cardId: saved?.id })
    const readValue = read.ok ? read.value as { fields: Record<string, string> } : null
    ok('Agent 可以读取设定字段', !!readValue && Object.values(readValue.fields).includes('冷静'), JSON.stringify(read))
    const personalityPath = Object.keys(readValue?.fields ?? {}).find(path => path.endsWith('::核心性格'))
    if (!personalityPath || !saved) throw new Error('合成角色缺少测试字段')
    const updateCard = { projectId, tabId: 'char-main', cardId: saved.id, fields: { [personalityPath]: '谨慎' }, expectedFields: { [personalityPath]: '冷静' } }
    const close = registerFormEditor(projectId, cardLeaseKey('char-main'))
    const busy = await callWrite(AGENT_TOOL_NAMES.updateSettingCard, updateCard)
    ok('设定栏目打开时字段修改被拒绝', busy.ok === false && busy.code === 'DRAFT_DIRTY')
    close()
    const changed = await callWrite(AGENT_TOOL_NAMES.updateSettingCard, updateCard)
    ok('按旧值修改设定卡字段', changed.ok === true, JSON.stringify(changed))
    const staleCard = await callWrite(AGENT_TOOL_NAMES.updateSettingCard, updateCard)
    ok('设定卡旧值变化时拒绝覆盖', staleCard.ok === false && staleCard.code === 'CONFLICT', JSON.stringify(staleCard))
    const badLimit = await callWrite(AGENT_TOOL_NAMES.listSettingCards, { projectId, tabId: 'char-main', limit: 101 })
    ok('设定卡分页限制有效', badLimit.ok === false && badLimit.code === 'BAD_REQUEST')
    await memoryOps.put('cardRecords', { id: 'foreign-card', projectId: 'another-project', tabId: 'char-main', name: '隔离', data: { secret: '不要读取' }, order: 0, createdAt: Date.now() })
    const foreign = await callWrite(AGENT_TOOL_NAMES.readSettingCard, { projectId, cardId: 'foreign-card' })
    ok('不可读取不存在或其他项目的卡片', foreign.ok === false && foreign.code === 'NOT_FOUND')
  }

  // ④ 创建章节：无卷 → NO_VOLUME
  {
    await seed()
    await memoryOps.del('volumes', volumeId)
    const res = await callWrite(AGENT_TOOL_NAMES.createChapter, { projectId, title: '第一章', content: '正文' })
    ok('无分卷时拒绝创建章节（NO_VOLUME）', res.ok === false && res.code === 'NO_VOLUME', JSON.stringify(res))
  }

  // ④b 创建章节成功
  {
    await seed()
    const res = await callWrite(AGENT_TOOL_NAMES.createChapter, {
      projectId, title: '雨夜来客', content: '雨落在青石板上。',
    })
    ok('创建章节成功', res.ok === true, JSON.stringify(res))
    const chapters = await memoryOps.getAll<Chapter>('chapters')
    const ch = chapters.find(c => c.title === '雨夜来客')
    ok('章节已落库且归属正确', !!ch && ch.projectId === projectId && ch.volumeId === volumeId)
    ok('章节 order 从 0 开始', ch?.order === 0, String(ch?.order))
    ok('字数按引擎口径计算', ch?.wordCount === (res.ok ? (res.value as { wordCount: number }).wordCount : -1))
    ok('已创建可恢复版本之外的台账派生不阻断', res.ok === true)
  }

  // ⑤ 追加：版本冲突
  {
    await seed()
    await callWrite(AGENT_TOOL_NAMES.createChapter, { projectId, title: '第一章', content: '旧正文' })
    const ch = (await memoryOps.getAll<Chapter>('chapters'))[0]
    const res = await callWrite(AGENT_TOOL_NAMES.appendChapter, {
      projectId, chapterId: ch.id, content: '新增', expectedUpdatedAt: ch.updatedAt - 1,
    }, fullScope, 'req-00000002')
    ok('版本不符时拒绝追加（CONFLICT）', res.ok === false && res.code === 'CONFLICT', JSON.stringify(res))
    const after = await memoryOps.get<Chapter>('chapters', ch.id)
    ok('冲突时正文未被改动', after?.content === '旧正文', after?.content)
    ok('冲突回传当前 updatedAt 供重新读取', res.ok === false && !!(res.current && (res.current as { updatedAt?: number }).updatedAt))
  }

  // ⑥ 追加成功 + 可恢复快照
  {
    await seed()
    await callWrite(AGENT_TOOL_NAMES.createChapter, { projectId, title: '第一章', content: '旧正文' })
    const ch = (await memoryOps.getAll<Chapter>('chapters'))[0]
    const res = await callWrite(AGENT_TOOL_NAMES.appendChapter, {
      projectId, chapterId: ch.id, content: '新的段落。', expectedUpdatedAt: ch.updatedAt,
    }, fullScope, 'req-00000003')
    ok('追加成功', res.ok === true, JSON.stringify(res))
    const after = await memoryOps.get<Chapter>('chapters', ch.id)
    ok('追加内容已写入正文', after?.content === appendText('旧正文', '新的段落。'), after?.content)
    const snaps = await memoryOps.getAll<{ chapterId: string; source?: string }>('snapshots')
    ok('写入前留下可恢复快照', snaps.some(s => s.chapterId === ch.id && s.source === 'ai-rewrite'))
  }

  // ⑦ 草稿脏
  {
    await seed()
    await callWrite(AGENT_TOOL_NAMES.createChapter, { projectId, title: '第一章', content: '正文' })
    const ch = (await memoryOps.getAll<Chapter>('chapters'))[0]
    const exec = executor({ draft: true })
    const res = await exec.call({
      sessionId: 'test-session', requestId: 'req-00000004', tool: AGENT_TOOL_NAMES.replaceChapter,
      args: { projectId, chapterId: ch.id, content: '覆盖稿', expectedUpdatedAt: ch.updatedAt },
    }, fullScope)
    ok('存在未保存草稿时拒绝写入（DRAFT_DIRTY）', res.ok === false && res.code === 'DRAFT_DIRTY', JSON.stringify(res))
    const after = await memoryOps.get<Chapter>('chapters', ch.id)
    ok('草稿保护下正文未被覆盖', after?.content === '正文', after?.content)
  }

  // ⑧ 落盘失败
  {
    await seed()
    const exec = executor({ flush: async () => false })
    const res = await exec.call({
      sessionId: 'test-session', requestId: 'req-00000005', tool: AGENT_TOOL_NAMES.createChapter,
      args: { projectId, title: '未落盘章', content: '内容' },
    }, fullScope)
    ok('落盘失败时如实报 SAVE_FAILED', res.ok === false && res.code === 'SAVE_FAILED', JSON.stringify(res))
    ok('SAVE_FAILED 不允许自动重试（避免重复追加）', agentErrorRetryable('SAVE_FAILED') === false)
    ok('OUTCOME_UNKNOWN 不允许自动重试', agentErrorRetryable('OUTCOME_UNKNOWN') === false)
  }

  // ⑨ 未知工具 / 缺参
  {
    await seed()
    const unknown = await callWrite('yfe_not_a_tool', {})
    ok('未知工具 → UNKNOWN_TOOL', unknown.ok === false && unknown.code === 'UNKNOWN_TOOL', JSON.stringify(unknown))
    const bad = await callWrite(AGENT_TOOL_NAMES.createSettingCard, { projectId, tabId: 'char-main', name: '无名', fields: {} })
    ok('空字段 → BAD_REQUEST', bad.ok === false && bad.code === 'BAD_REQUEST', JSON.stringify(bad))
    const badField = await callWrite(AGENT_TOOL_NAMES.createSettingCard, {
      projectId, tabId: 'char-main', name: '无名', fields: { 并不存在的字段: 'x' },
    })
    ok('未知设定字段 → BAD_REQUEST（不静默丢弃）', badField.ok === false && badField.code === 'BAD_REQUEST', JSON.stringify(badField))
  }

  // ⑩ 撤销授权：先授权建卡，再撤销后同动作被拒
  {
    await seed()
    const first = await callWrite(AGENT_TOOL_NAMES.createSettingCard, {
      projectId, tabId: 'char-main', name: '先建', fields: { 姓名: '先建' },
    })
    ok('授权时创建设定卡成功', first.ok === true, JSON.stringify(first))
    const revoked = await callWrite(AGENT_TOOL_NAMES.createSettingCard, {
      projectId, tabId: 'char-main', name: '撤销后', fields: { 姓名: '撤销后' },
    }, { projects: [] })
    ok('撤销授权后立即拒绝（SCOPE_DENIED）', revoked.ok === false && revoked.code === 'SCOPE_DENIED', JSON.stringify(revoked))
    const rows = await memoryOps.getAll<{ name: string }>('cardRecords')
    ok('撤销后没有新增卡片', rows.filter(r => r.name === '撤销后').length === 0)
  }

  // ⑪ 存储被阻断：冲突 / 锁写时不进入写入
  {
    await seed()
    const exec = executor({ blocked: '存储存在冲突' })
    const res = await exec.call({
      sessionId: 'test-session', requestId: 'req-00000006', tool: AGENT_TOOL_NAMES.createChapter,
      args: { projectId, title: '不该写入', content: '内容' },
    }, fullScope)
    ok('存储冲突时拒绝写入（STORAGE_BLOCKED）', res.ok === false && res.code === 'STORAGE_BLOCKED', JSON.stringify(res))
    ok('STORAGE_BLOCKED 不允许自动重试', agentErrorRetryable('STORAGE_BLOCKED') === false)
    ok('阻断时没有写入章节', (await memoryOps.getAll<Chapter>('chapters')).length === 0)
  }

  // ⑫ 一次查询：项目 + 栏目可写能力 + 版本
  {
    await seed()
    await callWrite(AGENT_TOOL_NAMES.createChapter, { projectId, title: '第一章', content: '正文' })
    const info = await executor().call({
      sessionId: 'test-session', requestId: 'req-00000007', tool: AGENT_TOOL_NAMES.getProject,
      args: { projectId },
    }, { projects: [{ projectId, actions: ['chapter:create'] as AgentAction[] }] })
    ok('getProject 返回卷 / 章节统计与版本', info.ok === true && (info.value as { chapters?: number }).chapters === 1
      && typeof (info.value as { chapterUpdatedAt?: number }).chapterUpdatedAt === 'number', JSON.stringify(info))
    ok('未授权 setting 时栏目 writable=false',
      info.ok === true && (info.value as { settings: { writable: boolean }[] }).settings.every(s => s.writable === false))

    const tabsForbidden = await executor().call({
      sessionId: 'test-session', requestId: 'req-00000008', tool: AGENT_TOOL_NAMES.listSettingTabs,
      args: { projectId },
    }, { projects: [{ projectId, actions: ['chapter:create'] as AgentAction[] }] })
    ok('list_setting_tabs 返回可写能力（未授权）',
      tabsForbidden.ok === true && (tabsForbidden.value as { grantedActions: string[] }).grantedActions.join(',') === 'chapter:create'
      && (tabsForbidden.value as { tabs: { writable: boolean }[] }).tabs.every(t => t.writable === false))

    const tabsAllowed = await executor().call({
      sessionId: 'test-session', requestId: 'req-00000009', tool: AGENT_TOOL_NAMES.listSettingTabs,
      args: { projectId },
    }, { projects: [{ projectId, actions: ['setting:create'] as AgentAction[] }] })
    ok('授权后栏目 writable=true',
      tabsAllowed.ok === true && (tabsAllowed.value as { tabs: { writable: boolean }[] }).tabs.every(t => t.writable === true))
  }

  // ⑬ 写成功后通知界面刷新字段
  {
    await seed()
    const notices: unknown[] = []
    const exec = executor({ notices })
    const res = await exec.call({
      sessionId: 'test-session', requestId: 'req-00000010', tool: AGENT_TOOL_NAMES.createChapter,
      args: { projectId, title: '通知测试', content: '内容' },
    }, fullScope)
    ok('写成功后发出界面刷新通知', res.ok === true && notices.length === 1
      && (notices[0] as { kind?: string }).kind === 'chapter', JSON.stringify(notices))
  }

  // ⑭ 并发写同一章：串行化后后到者冲突，不丢已写入内容
  {
    await seed()
    await callWrite(AGENT_TOOL_NAMES.createChapter, { projectId, title: '并发章', content: '起点' })
    const ch = (await memoryOps.getAll<Chapter>('chapters'))[0]
    const exec = executor()
    const [a, b] = await Promise.all([
      exec.call({
        sessionId: 'test-session', requestId: 'req-00000011', tool: AGENT_TOOL_NAMES.appendChapter,
        args: { projectId, chapterId: ch.id, content: '并发A', expectedUpdatedAt: ch.updatedAt },
      }, fullScope),
      exec.call({
        sessionId: 'test-session', requestId: 'req-00000012', tool: AGENT_TOOL_NAMES.appendChapter,
        args: { projectId, chapterId: ch.id, content: '并发B', expectedUpdatedAt: ch.updatedAt },
      }, fullScope),
    ])
    const okCount = [a, b].filter(r => r.ok).length
    ok('并发追加被串行化：一个成功、一个冲突',
      okCount === 1 && [a, b].some(r => r.ok === false && r.code === 'CONFLICT'), JSON.stringify([a, b]))
    const after = await memoryOps.get<Chapter>('chapters', ch.id)
    ok('串行化没有丢掉先写入的那一段', !!after && after.content.includes('并发A') && !after.content.includes('并发B'), after?.content)
  }

  // ⑮ 分卷修改：版本条件、自由卷拒绝
  {
    await seed()
    const vol = await memoryOps.get<Volume>('volumes', volumeId)
    const changed = await executor().call({
      sessionId: 'test-session', requestId: 'req-00000021', tool: AGENT_TOOL_NAMES.updateVolume,
      args: { projectId, volumeId, expectedTitle: vol?.title ?? '', title: '第二卷', description: '新的描述' },
    }, fullScope)
    ok('修改分卷成功', changed.ok === true, JSON.stringify(changed))
    const saved = await memoryOps.get<Volume>('volumes', volumeId)
    ok('分卷标题与描述已落库', saved?.title === '第二卷' && saved?.description === '新的描述', JSON.stringify(saved))
    const conflict = await executor().call({
      sessionId: 'test-session', requestId: 'req-00000022', tool: AGENT_TOOL_NAMES.updateVolume,
      args: { projectId, volumeId, expectedTitle: vol?.title ?? '', title: '第三卷' },
    }, fullScope)
    ok('旧标题版本条件不符 → CONFLICT', conflict.ok === false && conflict.code === 'CONFLICT', JSON.stringify(conflict))
    await memoryOps.put('volumes', { id: 'free-vol', projectId, order: -999, title: '自由卷', description: '', isFree: true })
    const free = await executor().call({
      sessionId: 'test-session', requestId: 'req-00000023', tool: AGENT_TOOL_NAMES.updateVolume,
      args: { projectId, volumeId: 'free-vol', expectedTitle: '自由卷', title: '改自由卷' },
    }, fullScope)
    ok('自由卷拒绝修改', free.ok === false && free.code === 'BAD_REQUEST', JSON.stringify(free))
  }

  // ⑯ 删除章节：编辑器打开 / 版本冲突 / 成功进回收站
  {
    await seed()
    await callWrite(AGENT_TOOL_NAMES.createChapter, { projectId, title: '待删章', content: '正文' })
    const ch = (await memoryOps.getAll<Chapter>('chapters'))[0]
    await memoryOps.put('snapshots', { id: 'snap-1', projectId, chapterId: ch.id, chapterTitle: ch.title, content: '旧', wordCount: 1, createdAt: Date.now(), source: 'ai-rewrite' })

    const active = await executor({ activeChapterId: () => ch.id }).call({
      sessionId: 'test-session', requestId: 'req-00000024', tool: AGENT_TOOL_NAMES.deleteChapter,
      args: { projectId, chapterId: ch.id },
    }, fullScope)
    ok('正在编辑的章拒绝删除', active.ok === false && active.code === 'DRAFT_DIRTY', JSON.stringify(active))

    const conflict = await executor().call({
      sessionId: 'test-session', requestId: 'req-00000025', tool: AGENT_TOOL_NAMES.deleteChapter,
      args: { projectId, chapterId: ch.id, expectedUpdatedAt: ch.updatedAt - 1 },
    }, fullScope)
    ok('章节版本不符拒绝删除', conflict.ok === false && conflict.code === 'CONFLICT', JSON.stringify(conflict))

    const removed = await executor().call({
      sessionId: 'test-session', requestId: 'req-00000026', tool: AGENT_TOOL_NAMES.deleteChapter,
      args: { projectId, chapterId: ch.id, expectedUpdatedAt: ch.updatedAt },
    }, fullScope)
    ok('删除章节成功', removed.ok === true, JSON.stringify(removed))
    ok('章节已移除且进入回收站', !(await memoryOps.get('chapters', ch.id))
      && (await memoryOps.get<{ kind?: string }>('trash', ch.id))?.kind === 'chapter')
    ok('章节快照已清理', (await memoryOps.getAll('snapshots')).length === 0)
  }

  // ⑰ 灵感夹读 / 写 / 授权
  {
    await seed()
    const added = await executor().call({
      sessionId: 'test-session', requestId: 'req-00000027', tool: AGENT_TOOL_NAMES.addInspiration,
      args: { projectId, text: '一个突然想到的点子' },
    }, fullScope)
    ok('写入灵感成功', added.ok === true, JSON.stringify(added))
    const listed = await executor().call({
      sessionId: 'test-session', requestId: 'req-00000028', tool: AGENT_TOOL_NAMES.listInspirations,
      args: { projectId },
    }, fullScope)
    const items = listed.ok ? (listed.value as { text: string }[]) : []
    ok('读取灵感夹可见新条目', items.some(item => item.text === '一个突然想到的点子'), JSON.stringify(listed))
    const denied = await executor().call({
      sessionId: 'test-session', requestId: 'req-00000029', tool: AGENT_TOOL_NAMES.addInspiration,
      args: { projectId, text: '未授权' },
    }, { projects: [{ projectId, actions: ['chapter:create'] as AgentAction[] }] })
    ok('未授权灵感写入被拒绝', denied.ok === false && denied.code === 'SCOPE_DENIED', JSON.stringify(denied))
  }

  console.log(`\nAGENT_EXECUTOR_RESULTS {"planned":${pass + fail},"passed":${pass},"failed":${fail}}`)
  if (fail > 0) process.exitCode = 1
}

void main()
