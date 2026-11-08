// Agent 宿主核心 + 可写桥 · 隔离单测（3.4.3）
//
// 覆盖：
//   ① 授权范围规整（失败关闭：未知动作 / 空项目 / 重复项目都被丢弃）；
//   ② 幂等账本：pending → success(replay) / unknown(拒绝重试) / failed(可重试)；
//   ③ 便携页面队列：领取 → 回传；页面超时 → OUTCOME_UNKNOWN；
//   ④ 宿主 HTTP：无 token 401；未开启 → HOST_DISABLED；开启后按 scope 执行并 replay；
//      页面端点只接受带页面头的同源请求；
//   ⑤ 桥：host 文件读取、写工具 requestId 必填、状态查询、错误透传。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeScope, createLedger, createPageQueue, createAgentHost, loadConfig } from '../scripts/agent-host/core.mjs'
import { invoke, BRIDGE_TOOL_NAMES } from '../scripts/mcp/yfe-agent.mjs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-agent-host-'))
const configFile = path.join(tmp, 'agent-host.json')
const projectId = 'p-test-1'

async function main() {
  // ① 授权范围规整
  {
    const scope = normalizeScope({
      projects: [
        { projectId: 'a', actions: ['chapter:create', 'nope', 'chapter:create'] },
        { projectId: 'b', actions: ['nope'] },
        { projectId: 'a', actions: ['setting:create'] },
        { projectId: '', actions: ['chapter:write'] },
      ],
    })
    ok('未知动作被过滤、重复项目去重、空动作项目被丢弃', scope.projects.length === 1
      && scope.projects[0].projectId === 'a'
      && scope.projects[0].actions.join(',') === 'chapter:create', JSON.stringify(scope))
    ok('非对象输入降级为空授权', normalizeScope(null).projects.length === 0)
  }

  // ② 幂等账本
  {
    const file = path.join(tmp, 'ledger.json')
    const ledger = createLedger(file)
    const first = ledger.begin('req-aaaaaaaa', { tool: 't', projectId, sessionId: 's' })
    ok('首次请求 → started', first.kind === 'started', first.kind)
    const again = ledger.begin('req-aaaaaaaa', { tool: 't', projectId, sessionId: 's' })
    ok('处理中重复请求 → in-flight', again.kind === 'in-flight', again.kind)
    ledger.finish('req-aaaaaaaa', { ok: true, value: { id: 'x' } })
    const replay = ledger.begin('req-aaaaaaaa', { tool: 't', projectId, sessionId: 's' })
    ok('成功后重复请求 → replay', replay.kind === 'replay', replay.kind)
    ok('replay 带回原结果', !!replay.record && JSON.stringify(replay.record.result) === '{"id":"x"}', JSON.stringify(replay.record?.result))

    ledger.begin('req-bbbbbbbb', { tool: 't', projectId, sessionId: 's' })
    ledger.finish('req-bbbbbbbb', { ok: false, code: 'SAVE_FAILED', error: '落盘失败' })
    const unknown = ledger.begin('req-bbbbbbbb', { tool: 't', projectId, sessionId: 's' })
    ok('SAVE_FAILED 记为 unknown 并拒绝自动重试', unknown.kind === 'unknown', unknown.kind)

    ledger.begin('req-cccccccc', { tool: 't', projectId, sessionId: 's' })
    ledger.finish('req-cccccccc', { ok: false, code: 'CONFLICT', error: '冲突' })
    const retry = ledger.begin('req-cccccccc', { tool: 't', projectId, sessionId: 's' })
    ok('确定未写入的失败允许同 requestId 重试', retry.kind === 'started', retry.kind)
  }

  // ③ 页面队列
  {
    const queue = createPageQueue({ timeoutMs: 120 })
    const pending = queue.push({ hello: 'world' })
    const item = queue.next('client-1')
    ok('页面可以领取任务', !!item, JSON.stringify(item))
    if (!item) throw new Error('页面队列未领取到任务')
    queue.settle(item.id, 'client-1', { ok: true, value: 'done' })
    const result = await pending as { ok: boolean; value?: string }
    ok('页面回传结果送达调用方', result.ok === true && result.value === 'done', JSON.stringify(result))
    ok('领取后队列为空', queue.next('client-1') === null)
    const timeout = await queue.push({ never: true }) as { ok: boolean; code?: string }
    ok('页面超时 → OUTCOME_UNKNOWN', timeout.ok === false && timeout.code === 'OUTCOME_UNKNOWN', JSON.stringify(timeout))
  }

  // ④ 宿主 HTTP
  {
    const calls: { call: { tool: string }; scope: { projects: { projectId: string; actions: string[] }[] } }[] = []
    const host = createAgentHost({
      configFile,
      callPage: async payload => {
        const p = payload as { call: { tool: string }; scope: { projects: { projectId: string; actions: string[] }[] } }
        calls.push(p)
        return { ok: true, value: { echo: p.call.tool, scopeProject: p.scope.projects[0]?.projectId ?? '' } }
      },
      clientCount: () => 1,
    })
    const port = await host.start()
    const config = loadConfig(configFile)
    ok('启动后写入 host 文件（端口 + token）', config.port === port && config.token.length >= 32)
    ok('默认未开启', config.enabled === false)

    const base = `http://127.0.0.1:${port}`
    const post = (headers: Record<string, string>, body: unknown) => fetch(`${base}/api/agent/call`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    })

    const noToken = await post({}, { call: { sessionId: 's', requestId: 'req-11111111', tool: 'yfe_create_chapter', args: {} } })
    ok('无 token 调用 → 401', noToken.status === 401, String(noToken.status))

    const auth = { Authorization: `Bearer ${config.token}` }
    const disabled = await post(auth, { call: { sessionId: 's', requestId: 'req-22222222', tool: 'yfe_create_chapter', args: {} } })
    const disabledBody = await disabled.json() as { ok: boolean; code?: string }
    ok('未开启连接 → HOST_DISABLED', disabledBody.ok === false && disabledBody.code === 'HOST_DISABLED', JSON.stringify(disabledBody))

    host.setConfig({ enabled: true, scope: { projects: [{ projectId, actions: ['chapter:create'] }] } })
    const first = await post(auth, { call: { sessionId: 's', requestId: 'req-33333333', tool: 'yfe_create_chapter', args: { projectId } } })
    const firstBody = await first.json() as { ok: boolean; result?: { ok: boolean; value?: { echo?: string } } }
    ok('开启后带 token 调用成功', firstBody.ok === true && firstBody.result?.ok === true, JSON.stringify(firstBody))
    ok('宿主把 scope 随请求下发到页面', calls[0]?.scope.projects[0]?.projectId === projectId, JSON.stringify(calls[0]?.scope))
    ok('页面执行次数 = 1', calls.length === 1, String(calls.length))

    const replay = await post(auth, { call: { sessionId: 's', requestId: 'req-33333333', tool: 'yfe_create_chapter', args: { projectId } } })
    const replayBody = await replay.json() as { ok: boolean; replayed?: boolean }
    ok('相同 requestId 重放，不重复执行', replayBody.ok === true && replayBody.replayed === true && calls.length === 1, JSON.stringify(replayBody))

    const pageStatus = await fetch(`${base}/api/agent/status`, { headers: { 'x-yfe-agent-page': '1', 'sec-fetch-site': 'same-origin' } })
    ok('同源页面可读状态', pageStatus.status === 200, String(pageStatus.status))
    const noHeader = await fetch(`${base}/api/agent/status`)
    ok('缺页面头的状态请求被拒', noHeader.status === 401, String(noHeader.status))

    // ⑤ 桥：host 文件 / 工具表 / requestId 必填
    ok('桥工具表含全部读写工具', BRIDGE_TOOL_NAMES.includes('yfe_create_setting_card') && BRIDGE_TOOL_NAMES.includes('yfe_list_projects'), JSON.stringify(BRIDGE_TOOL_NAMES))
    const info = await invoke('yfe_host_info', {}, configFile) as { available: boolean; hostFile: string; enabled: boolean }
    ok('桥能读取 host 状态且不回传 token', info.available === true && info.enabled === true && !JSON.stringify(info).includes(config.token), JSON.stringify(info))
    const list = await invoke('yfe_list_chapters', { projectId }, configFile) as { ok: boolean; value?: { echo?: string } }
    ok('只读工具经宿主执行', list.ok === true && list.value?.echo === 'yfe_list_chapters', JSON.stringify(list))

    let missingRequestId = ''
    try {
      await invoke('yfe_create_chapter', { projectId, title: 'x' }, configFile)
    } catch (error) { missingRequestId = error instanceof Error ? error.message : String(error) }
    ok('写工具缺 requestId 被桥拒绝', missingRequestId.includes('requestId'), missingRequestId)

    const status = await invoke('yfe_request_status', { requestId: 'req-33333333' }, configFile) as { ok: boolean; request?: { state?: string } }
    ok('桥可查询 requestId 状态', status.ok === true && status.request?.state === 'success', JSON.stringify(status))

    await host.stop()
    const stopped = await fetch(`${base}/api/agent/status`, { headers: auth }).then(() => true).catch(() => false)
    ok('停止后端口不再接受连接', stopped === false)
  }

  console.log(`\nAGENT_HOST_RESULTS {"planned":${pass + fail},"passed":${pass},"failed":${fail}}`)
  if (fail > 0) process.exitCode = 1
}

void main()