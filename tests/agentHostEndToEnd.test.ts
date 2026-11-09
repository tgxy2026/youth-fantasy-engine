// Agent 写入闭环 · 隔离端到端测试（3.4.3）
//
// 链路：可写桥（stdio 工具实现）→ 宿主 HTTP（鉴权 / 账本）→ 页面执行器 → 内存 store → 落盘确认。
// 使用合成项目与内存存储，不读取任何真实作品、不连真实账号。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import type { Chapter, Volume } from '@/lib/types'
import * as db from '@/lib/db'
import { AGENT_ACTIONS } from '@/lib/agentHost/contract'
import { createAgentExecutor, defaultExecutorDeps } from '@/lib/agentHost/executor'
import { ACTIONS, createAgentHost } from '../scripts/agent-host/core.mjs'
import { invoke } from '../scripts/mcp/yfe-agent.mjs'
import { __resetMockStores, memoryOps } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
function jsonOf(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text) as Record<string, unknown> } catch { return null }
}

/** 真正走 stdio / JSON-RPC，返回 MCP 工具结果的信封（text + isError）。 */
function mcpStdioCall(hostFile: string, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const child = spawn(process.execPath, ['scripts/mcp/yfe-agent.mjs', '--host-file', hostFile], { stdio: ['pipe', 'pipe', 'pipe'] })
  const output = readline.createInterface({ input: child.stdout })
  return new Promise<{ isError?: boolean; text: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP stdio 测试超时')), 10_000)
    output.on('line', line => {
      let msg: { id?: number; result?: { isError?: boolean; content?: { text?: string }[] } }
      try { msg = JSON.parse(line) } catch { return }
      if (msg.id !== 3) return
      clearTimeout(timer)
      resolve({ isError: msg.result?.isError, text: msg.result?.content?.[0]?.text ?? '' })
    })
    child.once('error', reject)
    for (const msg of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic-test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } },
    ]) child.stdin.write(JSON.stringify(msg) + '\n')
  }).finally(() => { output.close(); child.stdin.end() })
}

const projectId = 'p-e2e'
const volumeId = 'v-e2e'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-agent-e2e-'))
const configFile = path.join(tmp, 'agent-host.json')

async function seed() {
  __resetMockStores()
  const now = Date.now()
  await memoryOps.put('projects', {
    id: projectId, name: '闭环测试书', genre: '', intro: '', projectType: 'full', createdAt: now, updatedAt: now,
  })
  const vol: Volume = { id: volumeId, projectId, order: 0, title: '第一卷', description: '', createdAt: now }
  await memoryOps.put('volumes', vol)
  db.setCurrentProject(projectId)
}

async function main() {
  await seed()
  ok('页面与宿主授权动作列表一致', JSON.stringify([...ACTIONS].sort()) === JSON.stringify([...AGENT_ACTIONS].sort()))
  const executor = createAgentExecutor(defaultExecutorDeps())
  const host = createAgentHost({
    configFile,
    callPage: async payload => {
      const p = payload as { call: Parameters<typeof executor.call>[0]; scope: Parameters<typeof executor.call>[1] }
      return executor.call(p.call, p.scope)
    },
    clientCount: () => 1,
  })
  await host.start()
  host.setConfig({ enabled: true, scope: { projects: [{ projectId, actions: [...AGENT_ACTIONS] }] } })

  // ① 桥 → 宿主 → 页面：创建章节
  const first = await invoke('yfe_create_chapter', {
    projectId, title: '闭环第一章', content: '这是通过 MCP 工具写入的正文。必竟', requestId: 'req-e2e-0001',
  }, configFile) as { ok: boolean; value?: { chapterId?: string; wordCount?: number } }
  ok('端到端创建章节成功', first.ok === true && typeof first.value?.chapterId === 'string', JSON.stringify(first))
  const chapters = await memoryOps.getAll<Chapter>('chapters')
  ok('章节进入引擎内存 store', chapters.length === 1 && chapters[0].content.includes('MCP 工具'), JSON.stringify(chapters.map(c => c.title)))
  const chapterId = chapters[0].id

  // ② 幂等：相同 requestId 重放不重复创建
  const replay = await invoke('yfe_create_chapter', {
    projectId, title: '闭环第一章', content: '这是通过 MCP 工具写入的正文。必竟', requestId: 'req-e2e-0001',
  }, configFile) as { ok?: boolean; value?: { chapterId?: string }; replayed?: boolean }
  ok('相同 requestId 重放保留原结果及 replayed', replay.ok === true && replay.replayed === true && replay.value?.chapterId === chapterId, JSON.stringify(replay))
  ok('重放没有重复建章', (await memoryOps.getAll<Chapter>('chapters')).length === 1)

  // ③ 一次查询：项目 + 栏目可写能力 + 版本
  const info = await invoke('yfe_get_project', { projectId }, configFile) as { ok: boolean; value?: { chapters?: number; settings?: { writable?: boolean }[] } }
  ok('桥可一次查询项目与可写能力', info.ok === true && info.value?.chapters === 1
    && info.value?.settings?.every(tab => tab.writable === true) === true, JSON.stringify(info))

  // ④ 新 requestId → 追加正文（先读版本）
  const read = await invoke('yfe_read_chapter', { projectId, chapterId }, configFile) as { ok: boolean; value?: { updatedAt?: number } }
  ok('桥可读章节版本', read.ok === true && typeof read.value?.updatedAt === 'number', JSON.stringify(read))
  await db.setSettingFor(projectId, 'customSensitiveWords', ['MCP 工具'])
  const wordCheck = await invoke('yfe_check_chapter_words', { projectId, chapterId }, configFile) as { ok: boolean; value?: { hits: { word: string }[] } }
  ok('词语检查经桥和宿主复用项目词库', wordCheck.ok && wordCheck.value?.hits.some(hit => hit.word === 'MCP 工具') === true, JSON.stringify(wordCheck))
  const typoCheck = await invoke('yfe_check_chapter_typos', { projectId, chapterId }, configFile) as { ok: boolean; value?: { hits: { word: string; suggest: string }[] } }
  ok('错字检查经桥和宿主复用引擎词典', typoCheck.ok && typoCheck.value?.hits.some(hit => hit.word === '必竟' && hit.suggest === '毕竟') === true, JSON.stringify(typoCheck))
  const append = await invoke('yfe_append_chapter', {
    projectId, chapterId, content: '第二段。', expectedUpdatedAt: read.value?.updatedAt, requestId: 'req-e2e-0002',
  }, configFile) as { ok: boolean; value?: { wordCount?: number } }
  ok('端到端追加正文成功', append.ok === true, JSON.stringify(append))
  const after = await memoryOps.get<Chapter>('chapters', chapterId)
  ok('追加内容真实写入', !!after && after.content.endsWith('第二段。'), after?.content)

  // ④ 冲突：用旧版本覆盖 → CONFLICT，正文不变
  const conflict = await invoke('yfe_replace_chapter', {
    projectId, chapterId, content: '不应写入', expectedUpdatedAt: read.value?.updatedAt, requestId: 'req-e2e-0003',
  }, configFile) as { ok: boolean; code?: string }
  ok('端到端版本冲突被拒绝', conflict.ok === false && conflict.code === 'CONFLICT', JSON.stringify(conflict))
  ok('冲突未改动正文', (await memoryOps.get<Chapter>('chapters', chapterId))?.content === after?.content)

  const createdCard = await invoke('yfe_create_setting_card', {
    projectId, tabId: 'char-main', name: '闭环角色', fields: { 姓名: '闭环角色', 核心性格: '诚实' }, requestId: 'req-e2e-card1',
  }, configFile) as { ok: boolean; value?: { cardId: string } }
  const listedCards = await invoke('yfe_list_setting_cards', { projectId, tabId: 'char-main' }, configFile) as { ok: boolean; value?: { cards: { id: string }[] } }
  const readCard = await invoke('yfe_read_setting_card', { projectId, cardId: createdCard.value?.cardId }, configFile) as { ok: boolean; value?: { fields: Record<string, string> } }
  ok('桥可创建并列出设定卡', createdCard.ok && listedCards.ok && listedCards.value?.cards.some(c => c.id === createdCard.value?.cardId) === true)
  ok('桥可读取已创建设定的字段', readCard.ok && Object.values(readCard.value?.fields ?? {}).includes('诚实'))
  await memoryOps.put('formData', { tabId: `${projectId}::worldbase`, data: { '世界::背景': '合成世界' } })
  await memoryOps.put('tableRows', { id: 'row-e2e', projectId, tabId: 'relations', data: { 人物A: '甲', 人物B: '乙', 内部字段: '不公开' }, order: 0 })
  await memoryOps.put('tableRows', { id: 'row-other', projectId: 'other-project', tabId: 'relations', data: { 人物A: '其他书' }, order: 1 })
  const dataTabs = await invoke('yfe_list_data_tabs', { projectId }, configFile) as { ok: boolean; value?: { tabs: { tabId: string }[] } }
  const form = await invoke('yfe_read_form', { projectId, tabId: 'worldbase' }, configFile) as { ok: boolean; value?: { fields: Record<string, string> } }
  const table = await invoke('yfe_list_table_rows', { projectId, tabId: 'relations' }, configFile) as { ok: boolean; value?: { total: number; rows: { fields: Record<string, string> }[] } }
  ok('桥可发现表单和表格栏目', dataTabs.ok && dataTabs.value?.tabs.some(t => t.tabId === 'worldbase') === true && dataTabs.value?.tabs.some(t => t.tabId === 'relations') === true)
  ok('桥读取当前项目表单', form.ok && form.value?.fields['世界::背景'] === '合成世界')
  ok('桥读取表格时隔离其他项目和未公开列', table.ok && table.value?.total === 1 && table.value.rows[0]?.fields['人物A'] === '甲' && !('内部字段' in table.value.rows[0].fields))
  const task = await invoke('yfe_start_agent_task', { projectId, title: '合成进度', note: '私有任务备注哨兵', requestId: 'req-e2e-task1' }, configFile) as { ok: boolean; value?: { taskId: string } }
  const taskList = await invoke('yfe_list_agent_tasks', { projectId }, configFile) as { ok: boolean; value?: { tasks: { id: string }[] } }
  const taskRead = await invoke('yfe_get_agent_task', { projectId, taskId: task.value?.taskId }, configFile) as { ok: boolean }
  ok('任务台账经桥创建并只读查询', task.ok && taskList.ok && taskRead.ok && taskList.value?.tasks.some(item => item.id === task.value?.taskId) === true, JSON.stringify({ task, taskList, taskRead }))
  const ledger = fs.readFileSync(path.join(tmp, 'agent-host-requests.json'), 'utf8')
  ok('只读正文和设定内容不进入请求账本', !ledger.includes('这是通过 MCP 工具写入的正文') && !ledger.includes('诚实'))
  ok('任务只读结果不写入请求账本', !ledger.includes('私有任务备注哨兵'))

  // 真正通过 stdio / JSON-RPC 调用，确认工具业务失败会按 MCP 错误标记返回。
  const protoFail = await mcpStdioCall(configFile, 'yfe_read_chapter', { projectId, chapterId: 'not-found' })
  ok('真实 MCP stdio 对业务失败设置 isError 并保留 JSON 错误码', protoFail.isError === true && jsonOf(protoFail.text)?.code === 'NOT_FOUND', protoFail.text)

  // ⑤ 状态查询
  const status = await invoke('yfe_request_status', { requestId: 'req-e2e-0001' }, configFile) as { request?: { state?: string } }
  ok('账本记录成功状态', status.request?.state === 'success', JSON.stringify(status))

  // 新领域同时验证桥、HTTP 宿主和页面执行器，不能只验证执行器的内存测试。
  const map = await invoke('yfe_create_map', { projectId, name: '闭环地图', kilometersPerCell: '1', requestId: 'req-e2e-map1' }, configFile) as { ok: boolean; value?: { mapId: string } }
  const maps = await invoke('yfe_list_maps', { projectId }, configFile) as { ok: boolean; value?: { maps: { id: string }[] } }
  ok('桥接创建地图并回读', map.ok && maps.ok && maps.value?.maps.some(item => item.id === map.value?.mapId) === true)
  const canvas = await invoke('yfe_read_plot_canvas', { projectId }, configFile) as { ok: boolean; value?: { fingerprint: string } }
  const plot = await invoke('yfe_create_plot_card', { projectId, expectedFingerprint: canvas.value?.fingerprint, text: '闭环情节', x: 1, y: 2, requestId: 'req-e2e-plot1' }, configFile) as { ok: boolean; value?: { cardId: string } }
  const afterCanvas = await invoke('yfe_read_plot_canvas', { projectId }, configFile) as { ok: boolean; value?: { cards: { id: string }[] } }
  ok('桥接创建画布卡片并回读', canvas.ok && plot.ok && afterCanvas.value?.cards.some(item => item.id === plot.value?.cardId) === true)

  // 宿主级失败必须保留结构化 code，不能退化成无码纯文本（OBS-2）。
  const incompleteFile = path.join(tmp, 'agent-host-incomplete.json')
  fs.writeFileSync(incompleteFile, JSON.stringify({ port: 0 }))
  const incomplete = await mcpStdioCall(incompleteFile, 'yfe_host_info', {})
  ok('宿主配置不完整经 stdio 返回 HOST_CONFIG_INCOMPLETE', incomplete.isError === true && jsonOf(incomplete.text)?.code === 'HOST_CONFIG_INCOMPLETE', incomplete.text)
  const missing = await mcpStdioCall(path.join(tmp, 'agent-host-missing.json'), 'yfe_list_projects', {})
  ok('宿主配置缺失经 stdio 返回 HOST_CONFIG_MISSING', missing.isError === true && jsonOf(missing.text)?.code === 'HOST_CONFIG_MISSING', missing.text)
  const unknown = await mcpStdioCall(configFile, 'yfe_no_such_tool', {})
  ok('未知工具经 stdio 返回结构化 UNKNOWN_TOOL', unknown.isError === true && jsonOf(unknown.text)?.code === 'UNKNOWN_TOOL', unknown.text)

  host.setConfig({ enabled: false })
  let disabledCode = ''
  try { await invoke('yfe_list_projects', {}, configFile) } catch (error) {
    disabledCode = (error as { failure?: { code?: string } }).failure?.code ?? ''
  }
  ok('关闭连接后桥调用抛宿主级 HOST_DISABLED', disabledCode === 'HOST_DISABLED', disabledCode)
  const disabledStdio = await mcpStdioCall(configFile, 'yfe_list_projects', {})
  ok('关闭连接后 stdio 返回结构化 HOST_DISABLED', disabledStdio.isError === true && jsonOf(disabledStdio.text)?.code === 'HOST_DISABLED', disabledStdio.text)
  host.setConfig({ enabled: true })
  const recovered = await invoke('yfe_list_projects', {}, configFile) as { ok: boolean }
  ok('重新开启后桥调用恢复', recovered.ok === true)

  await host.stop()

  console.log(`\nAGENT_E2E_RESULTS {"planned":${pass + fail},"passed":${pass},"failed":${fail}}`)
  if (fail > 0) process.exitCode = 1
}

void main().finally(() => {
  try {
    const resolved = fs.realpathSync(tmp)
    if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('yfe-agent-e2e-')) {
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  } catch { /* 清理失败不影响测试结果 */ }
})
