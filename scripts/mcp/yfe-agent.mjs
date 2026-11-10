#!/usr/bin/env node
// ============ 青春幻想引擎 · Agent 可写工具桥（3.4.3）============
//
// 与 `yfe-readonly.mjs` 的区别：本桥**不直接读写数据文件**，所有调用都交给
// 正在运行的引擎宿主（桌面主进程 / 便携本地服务）。宿主再交给页面内存 store 执行。
// 因此：
//   · 不需要（也不允许）由本进程改 JSON；
//   · 每次调用带 requestId，宿主按它做幂等（重试不会重复建卡 / 重复追加）；
//   · 引擎设置里开启「Agent 连接」并授权项目 / 动作后，写入才会被接受。
//
// 用法：
//   node scripts/mcp/yfe-agent.mjs --host-file <agent-host.json>
//   node scripts/mcp/yfe-agent.mjs --data-file <数据文件.json>      # 同目录找 agent-host.json
//   node scripts/mcp/yfe-agent.mjs --portable-root <便携根目录>      # <root>/data/agent-host.json
//   node scripts/mcp/yfe-agent.mjs                                  # 桌面版默认 userData
//
// 说明：host 文件里有**随机 token**（仅桥读取，不会回传给 Agent）；找不到或引擎未启动时，
// 工具调用会如实报错，不会伪造成功。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'

export const BRIDGE_VERSION = '0.1.2'
export const HOST_FILE_NAME = 'agent-host.json'
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18']
// 未识别客户端版本时返回本服务支持的最新版本，由客户端决定是否接受。
const DEFAULT_PROTOCOL = '2025-06-18'
const DATA_FILE_NAME = 'youth-fantasy-engine-data.json'
const CALL_TIMEOUT_MS = 60_000

// ---------- 参数与 host 文件定位 ----------

function parseArgs(argv) {
  const out = { hostFile: null, dataFile: null, portableRoot: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host-file') out.hostFile = argv[++i] || null
    else if (argv[i] === '--data-file') out.dataFile = argv[++i] || null
    else if (argv[i] === '--portable-root') out.portableRoot = argv[++i] || null
  }
  return out
}

function desktopUserDataDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, '青春幻想引擎')
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', '青春幻想引擎')
  return path.join(os.homedir(), '.config', '青春幻想引擎')
}

/** host 文件位置：--host-file 优先；否则按数据位置推导；再否则桌面 userData。 */
export function resolveHostFile(args) {
  if (args.hostFile) return path.resolve(args.hostFile)
  if (args.dataFile) return path.join(path.dirname(path.resolve(args.dataFile)), HOST_FILE_NAME)
  if (args.portableRoot) return path.join(path.resolve(args.portableRoot), 'data', HOST_FILE_NAME)
  return path.join(desktopUserDataDir(), HOST_FILE_NAME)
}

/**
 * 宿主级失败的统一信封：第三方客户端可直接按 code 分支，不必解析文案。
 * 工具级失败（引擎把失败包在 {ok:true,result} 里）仍原样透传，不受影响。
 */
function hostFailure(code, error, extra) {
  const failure = { ok: false, code, error, ...(extra || {}) }
  const err = new Error(error)
  err.failure = failure
  return err
}

function loadHost(file) {
  let raw
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {
    throw hostFailure('HOST_CONFIG_MISSING', `找不到 Agent 宿主配置：${file}。请先在青春幻想引擎「模型设置 → Agent 连接」中开启连接（桌面版需要引擎正在运行）。`)
  }
  if (!raw || typeof raw !== 'object' || typeof raw.token !== 'string' || raw.token.length < 32 || !Number.isInteger(raw.port) || raw.port <= 0) {
    throw hostFailure('HOST_CONFIG_INCOMPLETE', 'Agent 宿主配置不完整（缺少 port / token）。请在引擎中重新开启 Agent 连接。')
  }
  return raw
}

function sessionId() {
  return 'mcp-' + randomBytes(8).toString('hex')
}

function generatedRequestId() {
  return 'auto-' + randomBytes(12).toString('hex')
}

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

async function callHost(host, tool, args, requestId) {
  let res
  try {
    res = await fetch(`http://127.0.0.1:${host.port}/api/agent/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ call: { sessionId: SESSION_ID, requestId, tool, args } }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
  } catch (error) {
    throw hostFailure('HOST_UNREACHABLE', `连不上引擎宿主（127.0.0.1:${host.port}）：${error && error.message ? error.message : String(error)}。请确认青春幻想引擎正在运行且已开启 Agent 连接。`)
  }
  let body
  try { body = await res.json() } catch {
    throw hostFailure('HOST_BAD_RESPONSE', `宿主返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  if (!res.ok && body && body.code === 'UNAUTHORIZED') {
    throw hostFailure('HOST_UNAUTHORIZED', '宿主拒绝了连接 token（可能引擎已重新生成配置）。请在引擎中重新开启 Agent 连接并更新配置。')
  }
  return body
}

async function requestStatus(host, requestId) {
  let res
  try {
    res = await fetch(`http://127.0.0.1:${host.port}/api/agent/request/${encodeURIComponent(requestId)}`, {
      headers: { Authorization: `Bearer ${host.token}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw hostFailure('HOST_UNREACHABLE', `连不上引擎宿主：${error && error.message ? error.message : String(error)}`)
  }
  let body
  try { body = await res.json() } catch {
    throw hostFailure('HOST_BAD_RESPONSE', `宿主返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  if (body && body.request && body.request.state === 'unknown') {
    return { ...body, actionRequired: '上一次写入结果不明：请先在引擎中核对，不要复用同一 requestId 重复写入。' }
  }
  return body
}

/**
 * 查询宿主实时状态（ISSUE-01）。host 文件只是配置快照：引擎切回 API 调用模式后
 * enabled 仍为 true，必须问宿主才能知道当前模式是否允许 Agent 调用。
 * 只返回状态字段，绝不回传 token / 文件路径。
 */
async function hostStatus(host) {
  let res
  try {
    res = await fetch(`http://127.0.0.1:${host.port}/api/agent/status`, {
      headers: { Authorization: `Bearer ${host.token}` },
      signal: AbortSignal.timeout(10_000),
    })
  } catch { return { kind: 'unreachable' } }
  if (res.status === 401) return { kind: 'unauthorized' }
  let body
  try { body = await res.json() } catch { return { kind: 'unreachable' } }
  if (!res.ok || !body || body.ok !== true) return { kind: 'unreachable' }
  return { kind: 'live', body }
}

// ---------- 工具定义 ----------

const REQUEST_ID_SCHEMA = {
  type: 'string',
  description: '本次调用的去重键（8~64 位字母 / 数字 / 下划线 / 短横线）。重试必须复用同一个值，否则可能重复创建或重复追加。',
}

const WRITE_TOOLS = [
  {
    name: 'yfe_set_world_set_active',
    description: '修改多套世界设定的活跃状态；先列出设定并传入预期旧状态。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, tabId: { type: 'string', enum: ['worldbase', 'power', 'politics', 'economy', 'belief', 'justice'] }, cardId: { type: 'string' }, active: { type: 'boolean' }, expectedActive: { type: 'boolean' }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'tabId', 'cardId', 'active', 'expectedActive', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'setting:write',
  },
  {
    name: 'yfe_update_setting_card',
    description: '修改现有设定卡或多套世界设定的指定字段。先读取条目，以完整字段路径传入新值与预期旧值；多套世界设定的 tabId 使用 yfe_list_world_sets 的母栏目 ID。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, tabId: { type: 'string' }, cardId: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } }, expectedFields: { type: 'object', additionalProperties: { type: 'string' } }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'tabId', 'cardId', 'fields', 'expectedFields', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'setting:write',
  },
  {
    name: 'yfe_update_table_row',
    description: '修改设定表中已有条目；先读取条目，逐字段提供读取时旧值。校验选项、引用和项目历法；「编号」等引擎维护字段不可写（返回 READ_ONLY_FIELD）。表格正在编辑或保存时拒绝。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, tabId: { type: 'string' }, rowId: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } }, expectedFields: { type: 'object', additionalProperties: { type: 'string' } }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'tabId', 'rowId', 'fields', 'expectedFields', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'table:write',
  },
  {
    name: 'yfe_create_table_row',
    description: '在当前项目的支持的设定表中创建一行；先查询栏目与字段，自动编号由引擎分配，不要传入「编号」（返回 READ_ONLY_FIELD），引用须已存在。表格正在编辑或保存时拒绝。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, tabId: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'tabId', 'fields', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'table:create',
  },
  {
    name: 'yfe_update_form',
    description: '修改当前项目表单的指定字段。先读取表单，按完整字段路径同时传入新值和读取时的旧值；表单正在编辑或保存时拒绝。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, tabId: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } }, expectedFields: { type: 'object', additionalProperties: { type: 'string' } }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'tabId', 'fields', 'expectedFields', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'form:write',
  },
  {
    name: 'yfe_create_world_set',
    description: '按当前题材模板创建一条多套世界设定，初始为未激活；需要创建设定卡授权。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, tabId: { type: 'string', enum: ['worldbase', 'power', 'politics', 'economy', 'belief', 'justice'] }, name: { type: 'string' }, fields: { type: 'object' }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'tabId', 'name', 'fields', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'setting:create',
  },
  {
    name: 'yfe_update_chapter_info',
    description: '修改已有章节标题和/或概要；先读取章节版本，写入时需要章节写入授权。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, chapterId: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, expectedUpdatedAt: { type: 'integer', minimum: 0 }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'chapterId', 'expectedUpdatedAt', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'chapter:write',
  },
  {
    name: 'yfe_update_volume',
    description: '修改分卷标题或描述；先用 yfe_get_project 读取旧标题和描述，修改描述时必须提供 expectedDescription。自由卷不支持。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, volumeId: { type: 'string' }, expectedTitle: { type: 'string' }, expectedDescription: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'volumeId', 'expectedTitle', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'volume:write',
  },
  {
    name: 'yfe_delete_chapter',
    description: '把章节移入回收站（可恢复），同时清理该章的章节快照与章节台账（requestId 幂等账本不受影响）；正在编辑器中打开的章、或有未保存草稿时拒绝。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, chapterId: { type: 'string' }, expectedUpdatedAt: { type: 'integer', minimum: 0 }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'chapterId', 'expectedUpdatedAt', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    action: 'chapter:delete',
  },
  {
    name: 'yfe_add_inspiration',
    description: '向项目灵感夹追加一条灵感，可选关联章节；需要灵感写入授权。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, text: { type: 'string' }, chapterId: { type: 'string' }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'text', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'inspiration:write',
  },
  {
    name: 'yfe_update_inspiration',
    description: '修改一条灵感；先用 yfe_list_inspirations 读取旧文本并作为 expectedText。需要灵感写入授权。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, inspirationId: { type: 'string' }, text: { type: 'string' }, expectedText: { type: 'string' }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'inspirationId', 'text', 'expectedText', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'inspiration:write',
  },
  {
    name: 'yfe_delete_inspiration',
    description: '删除一条灵感；需 expectedText 与 confirm:true。需要灵感写入授权。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, inspirationId: { type: 'string' }, expectedText: { type: 'string' }, confirm: { const: true }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'inspirationId', 'expectedText', 'confirm', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    action: 'inspiration:write',
  },
  {
    name: 'yfe_save_check_report',
    description: '把外部 Agent 的结构化检查发现写入引擎检查报告，作者可在「创作轨迹 → 检查报告」回看并加入工单。findings.level 只能是「严重 / 中等 / 提示」；没有发现问题时不要落报告。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, checkId: { type: 'string' }, chapterId: { type: 'string' }, chapterNo: { type: 'integer', minimum: 0 }, chapterTitle: { type: 'string' }, summary: { type: 'string' }, findings: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', properties: { level: { type: 'string', enum: ['严重', '中等', '提示'] }, title: { type: 'string' }, detail: { type: 'string' }, where: { type: 'string' } }, required: ['level', 'title'], additionalProperties: false } }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'checkId', 'findings', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'report:write',
  },
  {
    name: 'yfe_start_agent_task',
    description: '登记一个跨多次调用的外部 Agent 任务（如全书审读、逐章改写），任务台账会持久化到项目，断开重连后可用 yfe_list_agent_tasks 找回 taskId。需要「登记外部 Agent 任务进度」授权。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, title: { type: 'string', maxLength: 200 }, kind: { type: 'string', maxLength: 80 }, note: { type: 'string', maxLength: 2000 }, totalSteps: { type: 'integer', minimum: 1, maximum: 10000 }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'title', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'task:write',
  },
  {
    name: 'yfe_update_agent_task',
    description: '更新任务进度 / 当前步骤 / 备注，或置为 paused。先读取 expectedUpdatedAt；已结束的任务不能再更新。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, taskId: { type: 'string' }, expectedUpdatedAt: { type: 'integer', minimum: 0 }, status: { type: 'string', enum: ['running', 'paused'] }, progress: { type: 'integer', minimum: 0, maximum: 100 }, currentStep: { type: 'integer', minimum: 0, maximum: 1000000 }, note: { type: 'string', maxLength: 2000 }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'taskId', 'expectedUpdatedAt', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'task:write',
  },
  {
    name: 'yfe_finish_agent_task',
    description: '结束任务（done / cancelled / failed）并写入简短总结。done 会把进度置为 100。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, taskId: { type: 'string' }, expectedUpdatedAt: { type: 'integer', minimum: 0 }, status: { type: 'string', enum: ['done', 'cancelled', 'failed'] }, summary: { type: 'string', maxLength: 4000 }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'taskId', 'expectedUpdatedAt', 'status', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'task:write',
  },
  {
    name: 'yfe_cancel_agent_task',
    description: '登记协作式取消请求。引擎无法终止外部 Agent 进程：Agent 需在下一步读取任务状态并自行停止，然后调用 yfe_finish_agent_task 置为 cancelled。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, taskId: { type: 'string' }, expectedUpdatedAt: { type: 'integer', minimum: 0 }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'taskId', 'expectedUpdatedAt', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'task:write',
  },
  {
    name: 'yfe_restore_chapter',
    description: '从回收站恢复章节（原卷不在时放入「已恢复章节」卷并重建章节台账）；可用 yfe_list_chapter_trash 取得 id 与 deletedAt。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, chapterId: { type: 'string' }, expectedDeletedAt: { type: 'number' }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'chapterId', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'chapter:restore',
  },
  {
    name: 'yfe_create_map',
    description: '在当前项目创建一张地图（名称唯一、自动编号）。需要「创建地图 / 地点」授权。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, name: { type: 'string' }, kilometersPerCell: { type: 'string', enum: ['1', '10'] }, description: { type: 'string' }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'name', 'kilometersPerCell', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'map:create',
  },
  {
    name: 'yfe_update_map',
    description: '修改地图名称 / 每格公里 / 说明；改名会级联更新《地理风物》的「所属地图」。先读取 expectedName 与 expectedUpdatedAt。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, mapId: { type: 'string' }, expectedName: { type: 'string' }, expectedUpdatedAt: { type: 'integer', minimum: 0 }, name: { type: 'string' }, description: { type: 'string' }, kilometersPerCell: { type: 'string', enum: ['1', '10'] }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'mapId', 'expectedName', 'expectedUpdatedAt', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'map:write',
  },
  {
    name: 'yfe_delete_map',
    description: '删除地图；仍有《地理风物》引用时拒绝并返回引用清单。需要 confirm:true、读取时的 expectedUpdatedAt 与「删除地图」授权。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, mapId: { type: 'string' }, expectedUpdatedAt: { type: 'integer', minimum: 0 }, confirm: { const: true }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'mapId', 'expectedUpdatedAt', 'confirm', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    action: 'map:delete',
  },
  {
    name: 'yfe_create_map_place',
    description: '在指定地图下创建《地理风物》条目（格子初始为空）。父级必须同属该地图。需要「创建地图 / 地点」授权。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, mapId: { type: 'string' }, name: { type: 'string' }, category: { type: 'string' }, parent: { type: 'string' }, description: { type: 'string' }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'mapId', 'name', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'map:create',
  },
  {
    name: 'yfe_update_map_place_cells',
    description: '增量涂 / 擦地图格子。先由 yfe_list_map_places 取得 cellsHash 与 updatedAt；格子格式 "x,y"。会校验祖先范围、无祖先关系的重叠与子孙占用。需要「修改地图 / 绘制格子」授权。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, placeId: { type: 'string' }, expectedUpdatedAt: { type: 'integer', minimum: 0 }, expectedCellsHash: { type: 'string' }, add: { type: 'array', maxItems: 20000, items: { type: 'string' } }, remove: { type: 'array', maxItems: 20000, items: { type: 'string' } }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'placeId', 'expectedUpdatedAt', 'expectedCellsHash', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'map:write',
  },
  {
    name: 'yfe_create_plot_card',
    description: '在情节画布创建一张卡；必须携带 yfe_read_plot_canvas 返回的 expectedFingerprint。需要「修改情节画布」授权。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, expectedFingerprint: { type: 'string' }, text: { type: 'string' }, type: { type: 'string' }, chapter: { type: 'string', description: '章节引用：章节 ID 或唯一的章节标题（yfe_list_chapters 可查）；写入后画布按章节标题显示。' }, basedOn: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'expectedFingerprint', 'text', 'x', 'y', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'canvas:write',
  },
  {
    name: 'yfe_update_plot_card',
    description: '修改情节卡的文字 / 类型 / 章节引用 / 坐标；需 expectedFingerprint 与「修改情节画布」授权。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, cardId: { type: 'string' }, expectedFingerprint: { type: 'string' }, text: { type: 'string' }, type: { type: 'string' }, chapter: { type: 'string', description: '章节引用：章节 ID 或唯一的章节标题；传空字符串清除引用。' }, basedOn: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'cardId', 'expectedFingerprint', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'canvas:write',
  },
  {
    name: 'yfe_delete_plot_card',
    description: '删除情节卡及与之相关的全部连线；需 expectedFingerprint 与「修改情节画布」授权。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, cardId: { type: 'string' }, expectedFingerprint: { type: 'string' }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'cardId', 'expectedFingerprint', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    action: 'canvas:write',
  },
  {
    name: 'yfe_update_plot_connections',
    description: '增加 / 移除情节卡连线；add / remove 为 [from,to] 数组，两端必须是既有卡片。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, expectedFingerprint: { type: 'string' }, add: { type: 'array', maxItems: 2000, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string' } } }, remove: { type: 'array', maxItems: 2000, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string' } } }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'expectedFingerprint', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'canvas:write',
  },
  {
    name: 'yfe_import_world_pack',
    description: '把世界包某一版引入当前项目（快照复制、覆盖对应表）。必须先用 yfe_preview_world_import 并回传 requiredTabs、fingerprint 和 projectUpdatedAt，再传 confirm:true。失败时尝试安全回滚，结果不明时须人工核对。需要「引入世界包」授权；跨项目来源还需来源项目的「读取其它项目的世界包」。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, worldId: { type: 'string' }, version: { type: 'integer', minimum: 0 }, expectedTabs: { type: 'array', items: { type: 'string' } }, expectedFingerprint: { type: 'string', minLength: 1, maxLength: 200 }, expectedProjectUpdatedAt: { type: 'integer', minimum: 0 }, confirm: { const: true }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'worldId', 'expectedTabs', 'expectedFingerprint', 'expectedProjectUpdatedAt', 'confirm', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    action: 'world:write',
  },
  {
    name: 'yfe_restore_project_backup',
    description: '把某份备份恢复到当前项目（覆盖卷 / 章 / 表 / 卡 / 表单）。必须先用 yfe_preview_backup_restore 并回传 projectUpdatedAt，再传 confirm:true。引擎会先创建并校验安全备份；恢复后需要重新打开项目。需要「恢复项目备份」授权。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, backupId: { type: 'string' }, expectedProjectUpdatedAt: { type: 'integer', minimum: 0 }, confirm: { const: true }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'backupId', 'expectedProjectUpdatedAt', 'confirm', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    action: 'backup:restore',
  },
  {
    name: 'yfe_create_volume',
    description: '在当前项目末尾创建分卷，需要单独授予创建分卷权限。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'title', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'volume:create',
  },
  {
    name: 'yfe_create_setting_card',
    description: '在指定项目的设定栏目中新建一张设定卡（角色卡 / 其他设定 / 分卷大纲 / 章节细纲）。字段按栏目 schema 校验；需要「创建设定卡」授权。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 ID（先用 yfe_list_projects 查询）' },
        tabId: { type: 'string', description: '栏目 ID（先用 yfe_list_setting_tabs 查询字段）' },
        name: { type: 'string', description: '卡片名（如角色名）' },
        fields: { type: 'object', description: '字段 → 字符串值。键可用字段名或「模块::字段」全路径。' },
        requestId: REQUEST_ID_SCHEMA,
      },
      required: ['projectId', 'tabId', 'name', 'fields', 'requestId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'setting:create',
  },
  {
    name: 'yfe_create_chapter',
    description: '在项目末尾（或指定卷）新建一章正文。需要「创建章节」授权。目标项目必须已在引擎中打开。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        title: { type: 'string', description: '章节标题（可直接含「第N章」，也可只写标题）' },
        content: { type: 'string', description: '正文内容（可为空，后续再用追加工具写入）' },
        summary: { type: 'string', description: '可选：本章一句话概要' },
        volumeId: { type: 'string', description: '可选：目标卷 ID；不传则挂到最后一个真卷末尾' },
        requestId: REQUEST_ID_SCHEMA,
      },
      required: ['projectId', 'title', 'requestId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'chapter:create',
  },
  {
    name: 'yfe_append_chapter',
    description: '在既有章节正文末尾追加内容（先读章节拿到 updatedAt，再作为 expectedUpdatedAt 传入）。需要「追加 / 覆盖正文」授权。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        chapterId: { type: 'string' },
        content: { type: 'string', description: '要追加的正文' },
        expectedUpdatedAt: { type: 'number', description: '刚从 yfe_read_chapter 读到的 updatedAt（冲突检测）' },
        requestId: REQUEST_ID_SCHEMA,
      },
      required: ['projectId', 'chapterId', 'content', 'expectedUpdatedAt', 'requestId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'chapter:write',
  },
  {
    name: 'yfe_replace_chapter',
    description: '覆盖既有章节正文（写入前保留可恢复快照）。需要「追加 / 覆盖正文」授权。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        chapterId: { type: 'string' },
        content: { type: 'string', description: '新的完整正文' },
        expectedUpdatedAt: { type: 'number', description: '刚从 yfe_read_chapter 读到的 updatedAt（冲突检测）' },
        requestId: REQUEST_ID_SCHEMA,
      },
      required: ['projectId', 'chapterId', 'content', 'expectedUpdatedAt', 'requestId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    action: 'chapter:write',
  },
]

const READ_TOOLS = [
  {
    name: 'yfe_host_info',
    description: '查看宿主是否可达、Agent 连接是否开启、当前运行模式（connectionMode）与授权的项目 / 动作（不含 token，也不返回本机文件路径）。available / enabled 只表示宿主进程与配置开关；当前模式是否允许调用以 connectionMode 与 note 为准。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_projects',
    description: '列出全部项目，并标出哪些项目已授权写入、当前打开的是哪一个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_get_project',
    description: '按项目 ID 一次查询：项目信息、卷、章节统计、设定栏目、卡片数与当前可写能力（含版本 updatedAt）。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_chapters',
    description: '列出项目的章节（标题 / 卷 / 状态 / 字数 / updatedAt），不含正文。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_read_chapter',
    description: '读取单章完整正文与 updatedAt（写正文前必须先读，用它作为 expectedUpdatedAt）。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, chapterId: { type: 'string' } },
      required: ['projectId', 'chapterId'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_check_chapter_words',
    description: '使用引擎内置及项目自定义词库检查已保存章节，返回命中及上下文，仅供人工核对；不调用模型、不修改正文。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, chapterId: { type: 'string' } }, required: ['projectId', 'chapterId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_check_chapter_typos',
    description: '使用引擎内置词典检查已保存章节中的常见错别字，提供上下文和候选写法供人工核对；不调用模型、不修改正文。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, chapterId: { type: 'string' } }, required: ['projectId', 'chapterId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_setting_tabs',
    description: '列出可创建设定的栏目、每个栏目的字段（字段名 / 全路径 / 说明）与当前是否可写。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_setting_cards',
    description: '分页列出当前项目指定设定栏目的卡片摘要；使用 yfe_read_setting_card 读取字段。',
    inputSchema: {
      type: 'object', properties: { projectId: { type: 'string' }, tabId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      required: ['projectId', 'tabId'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_read_setting_card',
    description: '读取当前项目的一张设定卡及字段内容。',
    inputSchema: {
      type: 'object', properties: { projectId: { type: 'string' }, cardId: { type: 'string' } },
      required: ['projectId', 'cardId'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_data_tabs',
    description: '列出作品表单与表格的基础栏目及字段；不含项目自定义模板字段。表格列含 readOnly（引擎维护、不可写入）与 auto（创建时引擎自动分配）标记，如「编号」。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_read_form',
    description: '读取当前项目的作品信息、世界设定、力量体系、总纲等表单；返回已保存数据。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, tabId: { type: 'string' } }, required: ['projectId', 'tabId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_table_rows',
    description: '分页读取当前项目表格的可见基础列，例如人物关系、势力、地理、伏笔与时间线；不含隐藏列和自定义列。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, tabId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['projectId', 'tabId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_tavern_reports',
    description: '分页列出当前项目的酒馆推演报告摘要。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['projectId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_read_tavern_report',
    description: '读取当前项目的一份酒馆推演报告。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, reportId: { type: 'string' } }, required: ['projectId', 'reportId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_chapter_snapshots',
    description: '列出当前项目指定章节的可恢复历史版本摘要。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, chapterId: { type: 'string' } }, required: ['projectId', 'chapterId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_read_chapter_snapshot',
    description: '读取当前项目某个历史版本的正文；不执行恢复。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, snapshotId: { type: 'string' } }, required: ['projectId', 'snapshotId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_world_sets',
    description: '列出当前项目的多套世界、力量、政治、经济、信仰或司法设定及其活跃状态。使用 yfe_read_setting_card 读取某项字段。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, tabId: { type: 'string', enum: ['worldbase', 'power', 'politics', 'economy', 'belief', 'justice'] } }, required: ['projectId', 'tabId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_world_packs',
    description: '列出来源于当前项目的世界引擎世界包、栏目和封存版本摘要。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_read_world_pack_table',
    description: '分页读取当前项目来源的世界包草稿或指定封存版本的某个栏目；不返回图片或内部草稿。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, worldId: { type: 'string' }, tabId: { type: 'string' }, version: { type: 'integer', minimum: 1 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['projectId', 'worldId', 'tabId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_project_backups',
    description: '分页列出当前项目的备份和定稿版本元数据；不读取载荷，也不执行恢复或删除。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['projectId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_maps',
    description: '列出当前项目的地图摘要；不返回底图文件或内部绘图数据。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_map_places',
    description: '分页列出属于指定地图的地点摘要；不返回内部绘图坐标。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, mapId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['projectId', 'mapId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_search_project',
    description: '在当前项目已保存的章节、设定卡、表单和基础表格可见列中搜索文字；返回有限条摘要，不搜索内部草稿或隐藏列。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, query: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['projectId', 'query'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_read_plot_canvas',
    description: '分页读取当前项目已保存的情节推演画布卡片，以及与当页卡片相关的连线。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['projectId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_inspirations',
    description: '列出当前项目已保存的灵感夹条目（文字、时间、可选章节引用）。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_preview_world_import',
    description: '预览把世界包引入当前项目会影响哪些表、当前各有多少内容；不写入。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, worldId: { type: 'string' }, version: { type: 'integer', minimum: 0 } }, required: ['projectId', 'worldId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_preview_backup_restore',
    description: '预览某份备份恢复后的内容摘要与当前项目摘要；不写入。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, backupId: { type: 'string' } }, required: ['projectId', 'backupId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_check_reports',
    description: '列出当前项目的检查报告摘要（引擎自身和外部 Agent 落库的报告）。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['projectId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_read_check_report',
    description: '读取一份检查报告的结构化发现（级别 / 标题 / 原文位置 / 说明）。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, reportId: { type: 'string' } }, required: ['projectId', 'reportId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_chapter_trash',
    description: '分页列出当前项目回收站中的章节（可恢复）；返回删除时间与所属卷。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['projectId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_list_agent_tasks',
    description: '列出当前项目的外部 Agent 任务台账（按更新时间倒序），用于断线重连后恢复进度。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['projectId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_get_agent_task',
    description: '读取单条外部 Agent 任务（含完整总结与取消请求标记）。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, taskId: { type: 'string' } }, required: ['projectId', 'taskId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'yfe_request_status',
    description: '按 requestId 查询之前那次写入的状态（pending / success / failed / unknown），记录在 value（request 为兼容别名）。unknown = 结果不明，必须在引擎中核对后才能继续。',
    inputSchema: {
      type: 'object',
      properties: { requestId: { type: 'string' } },
      required: ['requestId'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
]

export const BRIDGE_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS]

/** 仅用于测试 / 配置生成：桥支持的工具名 */
export const BRIDGE_TOOL_NAMES = BRIDGE_TOOLS.map(t => t.name)

// ---------- MCP stdio ----------

const SESSION_ID = sessionId()
const ARGS = parseArgs(process.argv.slice(2))
const HOST_FILE = resolveHostFile(ARGS)

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function invoke(name, args, hostFile = HOST_FILE) {
  const host = loadHost(hostFile)
  if (name === 'yfe_host_info') {
    const snapshotScope = host.scope ?? { projects: [] }
    const live = await hostStatus(host)
    if (live.kind !== 'live') {
      return {
        ok: true,
        value: {
          available: false,
          port: host.port,
          enabled: host.enabled === true,
          scope: snapshotScope,
          connectionMode: null,
          note: live.kind === 'unauthorized'
            ? '宿主拒绝了连接 token（引擎可能已重新生成配置）。请在引擎中重新开启 Agent 连接并更新配置。'
            : '连不上引擎宿主（引擎可能未运行）。enabled / scope 只是本机配置快照，不代表当前状态；请启动引擎并在「模型设置 → Agent 连接」中开启连接。',
        },
      }
    }
    const enabled = live.body.enabled === true
    const connectionMode = live.body.connectionMode ?? null
    const modeBlocked = !!connectionMode && (connectionMode.phase !== 'stable' || connectionMode.mode !== 'agent')
    let note = ''
    if (!enabled) note = '引擎中尚未开启 Agent 写入连接（调用会被拒绝）。请在引擎「模型设置 → Agent 连接」中开启并授权项目。'
    else if (modeBlocked) note = `当前运行模式不允许 Agent 调用（phase=${connectionMode.phase}，mode=${connectionMode.mode ?? '无'}${connectionMode.reason ? `，${connectionMode.reason}` : ''}）。业务调用会返回 MODE_BLOCKED；请在引擎「模型设置 → API 调用」中切回 Agent 模式并等待切换完成。`
    return {
      ok: true,
      value: {
        available: true,
        port: typeof live.body.port === 'number' ? live.body.port : host.port,
        enabled,
        scope: live.body.scope ?? snapshotScope,
        connectionMode,
        note,
      },
    }
  }
  if (name === 'yfe_request_status') {
    const requestId = args?.requestId
    if (!REQUEST_ID_RE.test(String(requestId ?? ''))) throw hostFailure('INVALID_ARGUMENT', '参数 requestId 不合法（8~64 位字母 / 数字 / 下划线 / 短横线）')
    const body = await requestStatus(host, requestId)
    // 统一成功信封（ISSUE-02）：数据放 value；保留 request 别名兼容旧客户端。
    if (body && body.ok === true) return { ...body, value: body.request ?? null }
    return body
  }
  const tool = BRIDGE_TOOLS.find(t => t.name === name)
  if (!tool) throw hostFailure('UNKNOWN_TOOL', `未知工具：${name}`)
  let requestId = typeof args?.requestId === 'string' ? args.requestId : ''
  if (tool.action) {
    if (!REQUEST_ID_RE.test(requestId)) throw hostFailure('INVALID_ARGUMENT', '写工具必须提供合法 requestId（8~64 位字母 / 数字 / 下划线 / 短横线）')
  } else {
    requestId = generatedRequestId()
  }
  const cleaned = { ...args }
  if (tool.action) delete cleaned.requestId
  const body = await callHost(host, name, cleaned, requestId)
  if (body && body.ok === false) {
    const { ok, ...rest } = body
    throw hostFailure(body.code || 'HOST_ERROR', body.error || body.code || '宿主拒绝了本次调用', rest)
  }
  if (body && body.replayed) {
    return { ...(body.result ?? {}), replayed: true, requestId }
  }
  return body?.result ?? body
}

async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && msg.id != null) replyError(msg.id, -32600, 'Invalid Request')
    return
  }
  const { id, method, params } = msg
  if (id == null) return
  if (method === 'initialize') {
    const wanted = params?.protocolVersion
    reply(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'yfe-agent-bridge', version: BRIDGE_VERSION },
      instructions: '先列出项目并确认当前打开的目标项目。读取反映已保存的数据；写入需要引擎内对应项目与动作的授权。每次新写入使用唯一 requestId；重试同一请求使用原 requestId，结果不明时先查询状态并在引擎中核对。修改章节前先读取最新 updatedAt；不要覆盖未保存草稿。',
    })
    return
  }
  if (method === 'ping') { reply(id, {}); return }
  if (method === 'tools/list') {
    reply(id, { tools: BRIDGE_TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    const tool = BRIDGE_TOOLS.find(t => t.name === name)
    if (!tool) {
      reply(id, { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'UNKNOWN_TOOL', error: `未知工具：${name}` }, null, 2) }], isError: true })
      return
    }
    try {
      const result = await invoke(name, params?.arguments || {})
      reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], ...(result?.ok === false ? { isError: true } : {}) })
    } catch (error) {
      const text = error && error.failure ? JSON.stringify(error.failure, null, 2) : ((error && error.message) || String(error))
      reply(id, { content: [{ type: 'text', text }], isError: true })
    }
    return
  }
  replyError(id, -32601, `Method not found: ${method}`)
}

function start() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', line => {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch { replyError(null, -32700, 'Parse error'); return }
    void handle(msg).catch(error => {
      process.stderr.write(`[yfe-agent] handler error: ${(error && error.stack) || error}\n`)
      if (msg && msg.id != null) replyError(msg.id, -32603, 'Internal error')
    })
  })
  rl.on('close', () => process.exit(0))
  process.stderr.write(`[yfe-agent] bridge ${BRIDGE_VERSION} ready, host file: ${HOST_FILE}\n`)
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) start()

export { callHost, loadHost, invoke }
