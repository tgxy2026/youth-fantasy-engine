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

export const BRIDGE_VERSION = '0.1.0'
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

function loadHost(file) {
  let raw
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {
    throw new Error(`找不到 Agent 宿主配置：${file}。请先在青春幻想引擎「模型设置 → Agent 连接」中开启连接（桌面版需要引擎正在运行）。`)
  }
  if (!raw || typeof raw !== 'object' || typeof raw.token !== 'string' || raw.token.length < 32 || !Number.isInteger(raw.port) || raw.port <= 0) {
    throw new Error('Agent 宿主配置不完整（缺少 port / token）。请在引擎中重新开启 Agent 连接。')
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
    throw new Error(`连不上引擎宿主（127.0.0.1:${host.port}）：${error && error.message ? error.message : String(error)}。请确认青春幻想引擎正在运行且已开启 Agent 连接。`)
  }
  let body
  try { body = await res.json() } catch {
    throw new Error(`宿主返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  if (!res.ok && body && body.code === 'UNAUTHORIZED') {
    throw new Error('宿主拒绝了连接 token（可能引擎已重新生成配置）。请在引擎中重新开启 Agent 连接并更新配置。')
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
    throw new Error(`连不上引擎宿主：${error && error.message ? error.message : String(error)}`)
  }
  const body = await res.json()
  if (body && body.request && body.request.state === 'unknown') {
    return { ...body, actionRequired: '上一次写入结果不明：请先在引擎中核对，不要复用同一 requestId 重复写入。' }
  }
  return body
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
    description: '修改设定表中已有条目；先读取条目，逐字段提供读取时旧值。校验选项、引用和项目历法；表格正在编辑或保存时拒绝。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, tabId: { type: 'string' }, rowId: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } }, expectedFields: { type: 'object', additionalProperties: { type: 'string' } }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'tabId', 'rowId', 'fields', 'expectedFields', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'table:write',
  },
  {
    name: 'yfe_create_table_row',
    description: '在当前项目的支持的设定表中创建一行；先查询栏目与字段，自动编号由引擎分配，引用须已存在。表格正在编辑或保存时拒绝。',
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
    description: '修改分卷标题或描述；expectedTitle 必须是读取时的旧标题（版本条件）。自由卷不支持。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, volumeId: { type: 'string' }, expectedTitle: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'volumeId', 'expectedTitle', 'requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    action: 'volume:write',
  },
  {
    name: 'yfe_delete_chapter',
    description: '把章节移入回收站（可恢复），同时清理该章快照与台账；正在编辑器中打开的章、或有未保存草稿时拒绝。',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, chapterId: { type: 'string' }, expectedUpdatedAt: { type: 'integer', minimum: 0 }, requestId: REQUEST_ID_SCHEMA }, required: ['projectId', 'chapterId', 'requestId'], additionalProperties: false },
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
    description: '查看 Agent 连接是否开启、引擎宿主端口与当前授权的项目 / 动作（不含 token，也不返回本机文件路径）。',
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
    description: '列出作品表单与表格的基础栏目及字段；不含项目自定义模板字段。',
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
    name: 'yfe_request_status',
    description: '按 requestId 查询之前那次写入的状态（pending / success / failed / unknown）。unknown = 结果不明，必须在引擎中核对后才能继续。',
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
    return {
      available: true,
      port: host.port,
      enabled: host.enabled === true,
      scope: host.scope ?? { projects: [] },
      note: host.enabled === true ? '' : '引擎中尚未开启 Agent 写入连接（只读工具仍可调用，但写入会被拒绝）。',
    }
  }
  if (name === 'yfe_request_status') {
    const requestId = args?.requestId
    if (!REQUEST_ID_RE.test(String(requestId ?? ''))) throw new Error('参数 requestId 不合法（8~64 位字母 / 数字 / 下划线 / 短横线）')
    return requestStatus(host, requestId)
  }
  const tool = BRIDGE_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`未知工具：${name}`)
  let requestId = typeof args?.requestId === 'string' ? args.requestId : ''
  if (tool.action) {
    if (!REQUEST_ID_RE.test(requestId)) throw new Error('写工具必须提供合法 requestId（8~64 位字母 / 数字 / 下划线 / 短横线）')
  } else {
    requestId = generatedRequestId()
  }
  const cleaned = { ...args }
  if (tool.action) delete cleaned.requestId
  const body = await callHost(host, name, cleaned, requestId)
  if (body && body.ok === false) throw new Error(body.error || body.code || '宿主拒绝了本次调用')
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
      reply(id, { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true })
      return
    }
    try {
      const result = await invoke(name, params?.arguments || {})
      reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], ...(result?.ok === false ? { isError: true } : {}) })
    } catch (error) {
      reply(id, { content: [{ type: 'text', text: (error && error.message) || String(error) }], isError: true })
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
