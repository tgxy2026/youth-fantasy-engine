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
import { AGENT_ACTIONS, AGENT_TOOL_NAMES, agentErrorRetryable } from '@/lib/agentHost/contract'
import { createAgentExecutor, defaultExecutorDeps, appendText } from '@/lib/agentHost/executor'
import { __resetMockStores, memoryOps } from './mock-memory'

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

function executor(overrides: { flush?: () => Promise<boolean>; draft?: boolean } = {}) {
  const base = defaultExecutorDeps()
  return createAgentExecutor({
    ...base,
    flush: overrides.flush ?? (async () => true),
    unsavedDraft: () => overrides.draft === true,
  })
}

const fullScope = { projects: [{ projectId, actions: [...AGENT_ACTIONS] }] }

async function callWrite(tool: string, args: Record<string, unknown>, scope = fullScope, requestId = 'req-00000001') {
  return executor().call({ sessionId: 'test-session', requestId, tool, args }, scope)
}

async function main() {
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

  console.log(`\nAGENT_EXECUTOR_RESULTS {"planned":${pass + fail},"passed":${pass},"failed":${fail}}`)
  if (fail > 0) process.exitCode = 1
}

void main()