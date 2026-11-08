// Agent 写入闭环 · 隔离端到端测试（3.4.3）
//
// 链路：可写桥（stdio 工具实现）→ 宿主 HTTP（鉴权 / 账本）→ 页面执行器 → 内存 store → 落盘确认。
// 使用合成项目与内存存储，不读取任何真实作品、不连真实账号。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Chapter, Volume } from '@/lib/types'
import * as db from '@/lib/db'
import { AGENT_ACTIONS } from '@/lib/agentHost/contract'
import { createAgentExecutor, defaultExecutorDeps } from '@/lib/agentHost/executor'
import { createAgentHost } from '../scripts/agent-host/core.mjs'
import { invoke } from '../scripts/mcp/yfe-agent.mjs'
import { __resetMockStores, memoryOps } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
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
    projectId, title: '闭环第一章', content: '这是通过 MCP 工具写入的正文。', requestId: 'req-e2e-0001',
  }, configFile) as { ok: boolean; value?: { chapterId?: string; wordCount?: number } }
  ok('端到端创建章节成功', first.ok === true && typeof first.value?.chapterId === 'string', JSON.stringify(first))
  const chapters = await memoryOps.getAll<Chapter>('chapters')
  ok('章节进入引擎内存 store', chapters.length === 1 && chapters[0].content.includes('MCP 工具'), JSON.stringify(chapters.map(c => c.title)))
  const chapterId = chapters[0].id

  // ② 幂等：相同 requestId 重放不重复创建
  const replay = await invoke('yfe_create_chapter', {
    projectId, title: '闭环第一章', content: '这是通过 MCP 工具写入的正文。', requestId: 'req-e2e-0001',
  }, configFile) as { replayed?: boolean }
  ok('相同 requestId 重放标记 replayed', replay.replayed === true, JSON.stringify(replay))
  ok('重放没有重复建章', (await memoryOps.getAll<Chapter>('chapters')).length === 1)

  // ③ 一次查询：项目 + 栏目可写能力 + 版本
  const info = await invoke('yfe_get_project', { projectId }, configFile) as { ok: boolean; value?: { chapters?: number; settings?: { writable?: boolean }[] } }
  ok('桥可一次查询项目与可写能力', info.ok === true && info.value?.chapters === 1
    && info.value?.settings?.every(tab => tab.writable === true) === true, JSON.stringify(info))

  // ④ 新 requestId → 追加正文（先读版本）
  const read = await invoke('yfe_read_chapter', { projectId, chapterId }, configFile) as { ok: boolean; value?: { updatedAt?: number } }
  ok('桥可读章节版本', read.ok === true && typeof read.value?.updatedAt === 'number', JSON.stringify(read))
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

  // ⑤ 状态查询
  const status = await invoke('yfe_request_status', { requestId: 'req-e2e-0001' }, configFile) as { request?: { state?: string } }
  ok('账本记录成功状态', status.request?.state === 'success', JSON.stringify(status))

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