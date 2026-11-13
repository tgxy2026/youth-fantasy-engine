import fs from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import os from 'node:os'

const DATA_FILE_NAME = 'youth-fantasy-engine-data.json'

// ---------- 参数与数据文件定位 ----------

export function parseArgs(argv) {
  const out = { dataFile: null, portableRoot: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-file') out.dataFile = argv[++i] || null
    else if (argv[i] === '--portable-root') out.portableRoot = argv[++i] || null
  }
  return out
}

/** 桌面版 userData 目录（与 electron/main.cjs 的 app.getPath('userData') 同口径） */
export function desktopUserDataDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, '青春幻想引擎')
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', '青春幻想引擎')
  return path.join(os.homedir(), '.config', '青春幻想引擎')
}

/**
 * 解析数据文件路径。优先级：--data-file > --portable-root > 桌面默认。
 * 桌面自定义路径读 userData/data-location.json（与 main.cjs loadCustomPath 同口径：
 * 配置损坏 / 缺失 → 回落默认位置）。
 */
export function resolveDataFile(args) {
  if (args.dataFile) return path.resolve(args.dataFile)
  if (args.portableRoot) return path.join(path.resolve(args.portableRoot), 'data', DATA_FILE_NAME)
  const userData = desktopUserDataDir()
  try {
    const p = JSON.parse(fs.readFileSync(path.join(userData, 'data-location.json'), 'utf-8')).path
    if (typeof p === 'string' && p) return p
  } catch { /* 未自定义 / 配置损坏 → 默认位置 */ }
  return path.join(userData, DATA_FILE_NAME)
}


const BRIDGE_VERSION = '0.1.0'
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18']
const DEFAULT_PROTOCOL = '2024-11-05'

// ---------- 数据读取（只读） ----------

/** 各 store 主键 —— 与 storage/storeOps.PORTABLE_KEY_FIELDS 同口径（只列本桥要读的） */
const KEY_FIELDS = {
  projects: 'id', volumes: 'id', chapters: 'id', cardRecords: 'id', tableRows: 'id',
  formData: 'tabId', settingsKV: 'key',
}

/**
 * 规整 stores：兼容「记录数组」（便携端写盘原样）与「主键→记录」对象（桌面端）。
 * 对象形态下键全为纯数字 = 被数组展开污染过 → 按记录真实主键重建（同 normalizePortableData）。
 * 无主键记录不读入（本桥按 id 查询，无主键记录本来就查不到；不丢数据，文件原样不动）。
 */
function normalizeStores(raw) {
  const stores = Object.create(null)
  if (!raw || typeof raw !== 'object') return stores
  for (const [name, rows] of Object.entries(raw)) {
    if (!rows || typeof rows !== 'object') continue
    const kf = KEY_FIELDS[name] || 'id'
    const reindex = list => {
      const keyed = Object.create(null)
      for (const rec of list) {
        const v = rec && typeof rec === 'object' ? rec[kf] : null
        if (v != null && v !== '') keyed[String(v)] = rec
      }
      return keyed
    }
    if (Array.isArray(rows)) { stores[name] = reindex(rows); continue }
    const keys = Object.keys(rows)
    const polluted = keys.length > 0 && keys.every(k => /^\d+$/.test(k))
    stores[name] = polluted ? reindex(Object.values(rows)) : rows
  }
  return stores
}

export function createReadonlyTools(DATA_FILE, authorizedProjects = null) {
  let cache = null // { mtimeMs, size, data }

  function loadData() {
    let stat
    try {
      stat = fs.statSync(DATA_FILE)
    } catch {
      throw new Error(`找不到本机数据文件：${DATA_FILE}。本桥仅支持桌面版 / 便携版的本机数据文件；网页版没有本机数据文件，不可用。可用 --data-file 或 --portable-root 显式指定。`)
    }
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.data
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'))
    if (!parsed || parsed.app !== 'youth-fantasy-engine' || parsed.kind !== 'portable-data') {
      throw new Error('数据文件格式不正确（缺少 app/kind 标记），拒绝读取。')
    }
    const stores = normalizeStores(parsed.stores)
    if (authorizedProjects) {
      const allowed = new Set(authorizedProjects)
      for (const [name, projectOf] of Object.entries({
        projects: row => row.id,
        volumes: row => row.projectId,
        chapters: row => row.projectId,
        cardRecords: row => row.projectId,
        tableRows: row => row.projectId,
      })) {
      stores[name] = Object.fromEntries(Object.entries(stores[name] ?? {}).filter(([, row]) => row && allowed.has(projectOf(row))))
      }
      for (const name of ['settingsKV', 'formData']) {
        stores[name] = Object.fromEntries(Object.entries(stores[name] ?? {}).filter(([key]) => allowed.has(key.split('::')[0])))
      }
    }
    const data = { fileVersion: parsed.fileVersion ?? 1, savedAt: parsed.savedAt ?? 0, stores }
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, data }
    return data
  }

  const rowsOf = (data, store) => Object.values(data.stores[store] || {})
  const byId = (data, store, id) => {
    const records = data.stores[store] || {}
    return Object.hasOwn(records, id) ? records[id] : undefined
  }

  function requireString(argsObj, key) {
    const v = argsObj?.[key]
    if (typeof v !== 'string' || !v) throw new Error(`参数 ${key} 必填（非空字符串）`)
    return v
  }

  // ---------- 白名单工具 ----------
  // 🔴 输出全部走显式字段名单：cover / portrait / portrait2 / atlasImage 等大字段不暴露，
  //    记录将来新增的字段也不会默认漏出。meta / settingsKV（除灵感夹）根本不在读取范围。

  const projectFields = p => ({
    id: p.id, name: p.name, genre: p.genre, intro: p.intro,
    projectType: p.projectType ?? 'full', createdAt: p.createdAt, updatedAt: p.updatedAt,
  })

  const TOOLS = [
    {
      name: 'yfe_bridge_info',
      description: '数据桥信息：数据文件位置、格式版本、各 store 记录数。只读；仅支持桌面版/便携版本机数据，网页版不可用。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler() {
        const data = loadData()
        return {
          bridge: 'yfe-readonly-bridge', version: BRIDGE_VERSION, readonly: true,
          dataFile: DATA_FILE, fileVersion: data.fileVersion, savedAt: data.savedAt,
          counts: {
            projects: rowsOf(data, 'projects').length, chapters: rowsOf(data, 'chapters').length,
            cardRecords: rowsOf(data, 'cardRecords').length, tableRows: rowsOf(data, 'tableRows').length,
          },
          writeSupport: false, webSupported: false,
        }
      },
    },
    {
      name: 'yfe_list_projects',
      description: '列出全部小说项目（书名 / 题材 / 简介 / 形态 / 时间）。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler() {
        return rowsOf(loadData(), 'projects').map(projectFields)
      },
    },
    {
      name: 'yfe_get_project',
      description: '单个项目详情 + 卷数 / 章节数 / 总字数统计。',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false },
      handler(a) {
        const data = loadData()
        const pid = requireString(a, 'projectId')
        const p = byId(data, 'projects', pid)
        if (!p) throw new Error(`项目不存在：${pid}`)
        const chapters = rowsOf(data, 'chapters').filter(c => c.projectId === pid)
        return {
          ...projectFields(p),
          stats: {
            volumes: rowsOf(data, 'volumes').filter(v => v.projectId === pid).length,
            chapters: chapters.length,
            totalWords: chapters.reduce((s, c) => s + (typeof c.wordCount === 'number' ? c.wordCount : 0), 0),
          },
        }
      },
    },
    {
      name: 'yfe_list_volumes',
      description: '项目的分卷列表（含自由卷标记）。',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false },
      handler(a) {
        const pid = requireString(a, 'projectId')
        return rowsOf(loadData(), 'volumes').filter(v => v.projectId === pid)
          .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
          .map(v => ({ id: v.id, title: v.title, description: v.description, order: v.order, isFree: v.isFree === true }))
      },
    },
    {
      name: 'yfe_list_chapters',
      description: '项目的章节清单（标题 / 状态 / 字数 / 排序，不含正文）。可按卷过滤。',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' }, volumeId: { type: 'string' } },
        required: ['projectId'], additionalProperties: false,
      },
      handler(a) {
        const pid = requireString(a, 'projectId')
        const vid = typeof a?.volumeId === 'string' && a.volumeId ? a.volumeId : null
        return rowsOf(loadData(), 'chapters')
          .filter(c => c.projectId === pid && (!vid || c.volumeId === vid))
          .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
          .map(c => ({
            id: c.id, title: c.title, volumeId: c.volumeId, order: c.order, status: c.status,
            wordCount: c.wordCount, excludeFromNumbering: c.excludeFromNumbering === true, updatedAt: c.updatedAt,
          }))
      },
    },
    {
      name: 'yfe_read_chapter',
      description: '读取单章完整内容（正文 + 摘要 + 状态）。',
      inputSchema: { type: 'object', properties: { chapterId: { type: 'string' } }, required: ['chapterId'], additionalProperties: false },
      handler(a) {
        const c = byId(loadData(), 'chapters', requireString(a, 'chapterId'))
        if (!c) throw new Error(`章节不存在：${a.chapterId}`)
        return {
          id: c.id, projectId: c.projectId, volumeId: c.volumeId, title: c.title,
          content: c.content, summary: c.summary, status: c.status, wordCount: c.wordCount,
          createdAt: c.createdAt, updatedAt: c.updatedAt,
        }
      },
    },
    {
      name: 'yfe_list_cards',
      description: '项目的设定卡清单（角色 / 世界观等，按页签过滤可选；不含立绘）。',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' }, tabId: { type: 'string' } },
        required: ['projectId'], additionalProperties: false,
      },
      handler(a) {
        const pid = requireString(a, 'projectId')
        const tab = typeof a?.tabId === 'string' && a.tabId ? a.tabId : null
        return rowsOf(loadData(), 'cardRecords')
          .filter(c => c.projectId === pid && (!tab || c.tabId === tab))
          .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
          .map(c => ({ id: c.id, tabId: c.tabId, name: c.name, order: c.order }))
      },
    },
    {
      name: 'yfe_read_card',
      description: '读取单张设定卡的字段值（不含立绘图片）。',
      inputSchema: { type: 'object', properties: { cardId: { type: 'string' } }, required: ['cardId'], additionalProperties: false },
      handler(a) {
        const c = byId(loadData(), 'cardRecords', requireString(a, 'cardId'))
        if (!c) throw new Error(`设定卡不存在：${a.cardId}`)
        return { id: c.id, projectId: c.projectId, tabId: c.tabId, name: c.name, data: c.data, order: c.order }
      },
    },
    {
      name: 'yfe_list_table_rows',
      description: '项目的表格行清单（可按页签过滤；不含图鉴主图）。',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' }, tabId: { type: 'string' } },
        required: ['projectId'], additionalProperties: false,
      },
      handler(a) {
        const pid = requireString(a, 'projectId')
        const tab = typeof a?.tabId === 'string' && a.tabId ? a.tabId : null
        return rowsOf(loadData(), 'tableRows')
          .filter(r => r.projectId === pid && (!tab || r.tabId === tab))
          .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
          .map(r => ({ id: r.id, tabId: r.tabId, order: r.order, updatedAt: r.updatedAt, createdAt: r.createdAt }))
      },
    },
    {
      name: 'yfe_read_table_row',
      description: '读取单行表格的字段值（不含图鉴主图）。',
      inputSchema: { type: 'object', properties: { rowId: { type: 'string' } }, required: ['rowId'], additionalProperties: false },
      handler(a) {
        const r = byId(loadData(), 'tableRows', requireString(a, 'rowId'))
        if (!r) throw new Error(`表格行不存在：${a.rowId}`)
        return { id: r.id, projectId: r.projectId, tabId: r.tabId, data: r.data, order: r.order }
      },
    },
    {
      name: 'yfe_get_form',
      description: '读取项目某页签的表单数据（世界设定 / 力量体系等母级设定）。',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' }, tabId: { type: 'string' } },
        required: ['projectId', 'tabId'], additionalProperties: false,
      },
      handler(a) {
        const pid = requireString(a, 'projectId')
        const tab = requireString(a, 'tabId')
        const rec = byId(loadData(), 'formData', `${pid}::${tab}`)
        if (!rec) throw new Error(`表单不存在：${pid}::${tab}`)
        return { projectId: pid, tabId: tab, data: rec.data }
      },
    },
    {
      name: 'yfe_list_inspirations',
      description: '项目的灵感夹条目（一句话灵感 + 时间 + 可选章节引用）。',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false },
      handler(a) {
        const pid = requireString(a, 'projectId')
        // 🔴 settingsKV 全库只放行这一个键；其余（含密钥 / 偏好 / 台账）一律不读。
        const rec = byId(loadData(), 'settingsKV', `${pid}::inspirationBox`)
        const items = Array.isArray(rec?.value) ? rec.value : []
        return items.map(it => ({ id: it.id, text: it.text, createdAt: it.createdAt, chapterId: it.chapterId }))
      },
    },
  ]

  const toolMap = new Map(TOOLS.map(t => [t.name, t]))
  return {
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    invoke(name, args) {
      const tool = toolMap.get(name)
      if (!tool) throw new Error('未知只读工具')
      return tool.handler(args ?? {})
    },
  }
}

// ---------- MCP stdio（JSON-RPC 2.0， newline-delimited） ----------

export function serveReadonlyBridge({ tools, invoke }) {
  function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n')
  }
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
  const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  async function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      if (msg && msg.id != null) replyError(msg.id, -32600, 'Invalid Request')
      return
    }
    const { id, method, params } = msg
    if (id == null) return // 通知（notifications/initialized 等）无需应答
    if (method === 'initialize') {
      const wanted = params?.protocolVersion
      reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'yfe-readonly-bridge', version: BRIDGE_VERSION },
      })
      return
    }
    if (method === 'ping') { reply(id, {}); return }
    if (method === 'tools/list') {
      reply(id, { tools })
      return
    }
    if (method === 'tools/call') {
      try {
        const result = await invoke(params?.name, params?.arguments || {})
        reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
      } catch (e) {
        reply(id, { content: [{ type: 'text', text: (e && e.message) || String(e) }], isError: true })
      }
      return
    }
    replyError(id, -32601, `Method not found: ${method}`)
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', line => {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch { replyError(null, -32700, 'Parse error'); return }
    void handle(msg).catch(() => {
      if (msg && msg.id != null) replyError(msg.id, -32603, 'Internal error')
    })
  })
  rl.on('close', () => process.exit(0))
}
