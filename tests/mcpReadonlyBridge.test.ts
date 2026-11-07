// ============ 只读 MCP 数据桥（3.4.3 · P2）============
//
// 验证口径（规划 §P2 出口）：
//   ① 只读证明：整轮工具会话前后数据文件 sha256 / mtime 不变；源码无任何写 API；
//   ② 桌面（主键→记录对象）/ 便携（记录数组）两种形态都可读，含数字键污染修复；
//   ③ 不泄密：meta（明文 apiKey）/ settingsKV 非灵感键 / 备份 / 快照 / 回收站不出现在任何输出；
//   ④ 网页端明确不可用：文件缺失时如实报错，不伪造空数据；
//   ⑤ 不引入凭证：不读 session 文件，工具清单只有只读工具。
//
// 🔴 用 spawn（异步）而非 spawnSync：本机 spawnSync 恒 EBUSY（见 run-batches.sh 顶部）。
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const SERVER = path.join(process.cwd(), 'scripts', 'mcp', 'yfe-readonly.mjs')

// ---------- fixture：带「毒」的全形态数据 ----------
const SECRET = 'sk-LIVE-KEY-should-never-leak-123'
const SEARCH_SECRET = 'search-key-should-never-leak-456'
const SENTINEL_BACKUP = 'BACKUP-PAYLOAD-SENTINEL'
const SENTINEL_TRASH = 'TRASH-SENTINEL'

function fixtureStores() {
  return {
    projects: [
      { id: 'p1', name: '测试书', genre: '玄幻', intro: '一句话', cover: 'data:image/png;base64,AAAA', createdAt: 1, updatedAt: 2, projectType: 'full' },
      { id: 'p2', name: '第二本', genre: '都市', intro: '', createdAt: 3, updatedAt: 4 },
    ],
    volumes: [
      { id: 'v1', projectId: 'p1', order: 0, title: '第一卷', description: '卷简介', createdAt: 1 },
      { id: 'vFree', projectId: 'p1', order: 99, title: '自由卷', description: '', createdAt: 1, isFree: true },
    ],
    chapters: [
      { id: 'c1', projectId: 'p1', volumeId: 'v1', order: 0, title: '第一章', content: '正文内容甲', summary: '摘要甲', status: '草稿', wordCount: 5, createdAt: 1, updatedAt: 2 },
      { id: 'c2', projectId: 'p1', volumeId: 'v1', order: 1, title: '第二章', content: '正文内容乙', summary: '', status: '完稿', wordCount: 5, createdAt: 1, updatedAt: 2, excludeFromNumbering: true },
      { id: 'c3', projectId: 'p2', volumeId: 'vX', order: 0, title: '别书章节', content: '别书正文', summary: '', status: '构思', wordCount: 4, createdAt: 1, updatedAt: 2 },
    ],
    cardRecords: [
      { id: 'card1', projectId: 'p1', tabId: 'role', name: '主角', data: { '基本信息.姓名': '林一' }, order: 0, portrait: 'data:image/webp;base64,BBBB', portrait2: 'data:image/webp;base64,CCCC' },
    ],
    tableRows: [
      { id: 'row1', projectId: 'p1', tabId: 'items', data: { '名称': '灵剑' }, order: 0, updatedAt: 9, atlasImage: { mime: 'image/webp', data: 'DDDD' } },
    ],
    formData: [
      { tabId: 'p1::world', data: { '世界名称': '苍云大陆' } },
    ],
    settingsKV: [
      { key: 'p1::inspirationBox', value: [{ id: 'i1', text: '灵感一句话', createdAt: 7, chapterId: 'c1' }] },
      { key: 'p1::aiProviders', value: { providers: [{ apiKey: SECRET }] } },
      { key: 'customOption::p1::x', value: { secret: SEARCH_SECRET } },
    ],
    meta: [
      { key: 'aiProviders', value: { providers: [{ apiKey: SECRET }] } },
      { key: 'app.search', value: { apiKey: SEARCH_SECRET } },
    ],
    backups: [{ id: 'b1', payload: SENTINEL_BACKUP }],
    backupPayloads: [{ id: 'bp1', blob: SENTINEL_BACKUP }],
    trash: [{ id: 't1', content: SENTINEL_TRASH }],
    snapshots: [{ id: 's1', content: SENTINEL_TRASH }],
  }
}

const KEY_FIELD: Record<string, string> = { formData: 'tabId', settingsKV: 'key', meta: 'key' }
function keyed(stores: Record<string, unknown[]>) {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, rows] of Object.entries(stores)) {
    const kf = KEY_FIELD[name] || 'id'
    out[name] = Object.fromEntries(rows.map(r => [String((r as Record<string, unknown>)[kf]), r]))
  }
  return out
}
const envelope = (stores: unknown) => ({ app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: 123, stores })

// ---------- stdio JSON-RPC 会话驱动 ----------
interface Session {
  request: (method: string, params?: unknown) => Promise<any>
  raw: () => string
  close: () => Promise<void>
}
function startSession(args: string[]): Session {
  const child = spawn(process.execPath, [SERVER, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let nextId = 1
  const pending = new Map<number, (v: any) => void>()
  const rl = createInterface({ input: child.stdout!, terminal: false })
  rl.on('line', line => {
    stdout += line + '\n'
    if (!line.trim()) return
    const msg = JSON.parse(line)
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id) }
  })
  child.stderr!.resume()
  const exited = new Promise<void>(resolve => child.on('close', () => resolve()))
  return {
    request(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, resolve)
        const timer = setTimeout(() => reject(new Error(`等待应答超时: ${method}`)), 15000)
        pending.set(id, v => { clearTimeout(timer); resolve(v) })
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
    raw: () => stdout,
    async close() { child.stdin!.end(); rl.close(); await exited },
  }
}

const callTool = async (s: Session, name: string, args?: unknown) => {
  const res = await s.request('tools/call', { name, arguments: args ?? {} })
  assert.equal(res.error, undefined, `RPC 层不应报错: ${name}`)
  return res.result
}
const toolJson = (result: any) => JSON.parse(result.content[0].text)

async function hashFile(p: string) {
  const h = crypto.createHash('sha256')
  for await (const chunk of createReadStream(p)) h.update(chunk)
  return h.digest('hex')
}

let pass = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { console.error(`FAIL ${name}${extra ? ' :: ' + extra : ''}`); process.exitCode = 1 }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-mcp-bridge-'))
try {
  // ============ ① 源码层只读证明：无任何写 API ============
  const source = await fs.readFile(SERVER, 'utf-8')
  const WRITE_API = /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|renameSync|rename|unlinkSync|unlink|rmSync|rm|rmdirSync|mkdirSync|mkdir|copyFileSync|copyFile|openSync|truncateSync|truncate|fs\.promises|chmodSync|utimesSync)\s*\(/g
  ok('源码不含任何写/改文件系统 API', !WRITE_API.test(source))

  // ============ ② 桌面形态（主键→记录对象）全量会话 ============
  const desktopFile = path.join(root, 'desktop.json')
  await fs.writeFile(desktopFile, JSON.stringify(envelope(keyed(fixtureStores()))))
  const beforeHash = await hashFile(desktopFile)
  const beforeStat = await fs.stat(desktopFile)

  const s = startSession(['--data-file', desktopFile])
  const init = await s.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  ok('initialize 协商协议版本 + serverInfo', init.result?.protocolVersion === '2025-03-26' && init.result?.serverInfo?.name === 'yfe-readonly-bridge')

  const tools = (await s.request('tools/list')).result.tools as { name: string }[]
  const READ_TOOLS = ['yfe_bridge_info', 'yfe_list_projects', 'yfe_get_project', 'yfe_list_volumes', 'yfe_list_chapters', 'yfe_read_chapter', 'yfe_list_cards', 'yfe_read_card', 'yfe_list_table_rows', 'yfe_read_table_row', 'yfe_get_form', 'yfe_list_inspirations']
  ok('工具清单 = 12 个只读工具，无写工具', tools.length === 12 && tools.every(t => READ_TOOLS.includes(t.name)))

  const info = toolJson(await callTool(s, 'yfe_bridge_info'))
  ok('bridge_info 如实声明 readonly / 无写 / 网页不可用', info.readonly === true && info.writeSupport === false && info.webSupported === false && info.counts.projects === 2)

  const projects = toolJson(await callTool(s, 'yfe_list_projects'))
  ok('项目列表可读且不含封面大字段', projects.length === 2 && projects[0].name === '测试书' && !('cover' in projects[0]))

  const p1 = toolJson(await callTool(s, 'yfe_get_project', { projectId: 'p1' }))
  ok('项目详情统计正确（2 卷 2 章 10 字）', p1.stats.volumes === 2 && p1.stats.chapters === 2 && p1.stats.totalWords === 10)

  const volumes = toolJson(await callTool(s, 'yfe_list_volumes', { projectId: 'p1' }))
  ok('分卷列表含自由卷标记', volumes.length === 2 && volumes.some((v: any) => v.isFree === true))

  const chapters = toolJson(await callTool(s, 'yfe_list_chapters', { projectId: 'p1' }))
  ok('章节清单不含正文', chapters.length === 2 && chapters.every((c: any) => !('content' in c)) && chapters[1].excludeFromNumbering === true)
  const chapter = toolJson(await callTool(s, 'yfe_read_chapter', { chapterId: 'c1' }))
  ok('单章正文完整可读', chapter.content === '正文内容甲' && chapter.summary === '摘要甲')
  const crossBook = toolJson(await callTool(s, 'yfe_list_chapters', { projectId: 'p2' }))
  ok('项目隔离：别书章节不串', crossBook.length === 1 && crossBook[0].id === 'c3')

  const cards = toolJson(await callTool(s, 'yfe_list_cards', { projectId: 'p1', tabId: 'role' }))
  ok('设定卡清单不含立绘', cards.length === 1 && !('portrait' in cards[0]))
  const card = toolJson(await callTool(s, 'yfe_read_card', { cardId: 'card1' }))
  ok('设定卡字段值可读、立绘不暴露', card.data['基本信息.姓名'] === '林一' && !('portrait' in card) && !('portrait2' in card))

  const rows = toolJson(await callTool(s, 'yfe_list_table_rows', { projectId: 'p1' }))
  ok('表格行清单不含图鉴主图', rows.length === 1 && !('atlasImage' in rows[0]))
  const row = toolJson(await callTool(s, 'yfe_read_table_row', { rowId: 'row1' }))
  ok('表格行字段值可读、主图不暴露', row.data['名称'] === '灵剑' && !('atlasImage' in row))

  const form = toolJson(await callTool(s, 'yfe_get_form', { projectId: 'p1', tabId: 'world' }))
  ok('母级设定表单可读', form.data['世界名称'] === '苍云大陆')

  const inspirations = toolJson(await callTool(s, 'yfe_list_inspirations', { projectId: 'p1' }))
  ok('灵感夹可读（含章节引用）', inspirations.length === 1 && inspirations[0].text === '灵感一句话' && inspirations[0].chapterId === 'c1')
  const emptyInsp = toolJson(await callTool(s, 'yfe_list_inspirations', { projectId: 'p2' }))
  ok('无灵感的项目返回空数组（如实，非报错）', Array.isArray(emptyInsp) && emptyInsp.length === 0)

  // 错误如实：未知工具 / 不存在的 id / 缺参数 / 未知方法
  const unknown = await callTool(s, 'yfe_delete_project', { projectId: 'p1' })
  ok('未知/写工具名 → isError，不执行', unknown.isError === true)
  const missing = await callTool(s, 'yfe_read_chapter', { chapterId: 'nope' })
  ok('不存在的章节 → isError 如实报错', missing.isError === true)
  const badArg = await callTool(s, 'yfe_read_chapter', {})
  ok('缺参数 → isError', badArg.isError === true)
  const badMethod = await s.request('resources/list', {})
  ok('未实现的方法 → JSON-RPC -32601', badMethod.error?.code === -32601)
  const ping = await s.request('ping')
  ok('ping 有应答', ping.result != null)

  // 🔴 泄密总扫描：整轮会话的每一个字节都不许带出密钥 / 备份 / 回收站 / 敏感键名
  const whole = s.raw()
  ok('全程输出无明文 apiKey / 检索密钥', !whole.includes(SECRET) && !whole.includes(SEARCH_SECRET))
  ok('全程输出无备份/回收站/快照哨兵', !whole.includes(SENTINEL_BACKUP) && !whole.includes(SENTINEL_TRASH))
  ok('全程输出不出现敏感键名 aiProviders / app.search', !whole.includes('aiProviders') && !whole.includes('app.search'))
  ok('全程输出无封面/立绘/主图 base64 大字段', !whole.includes('AAAA') && !whole.includes('BBBB') && !whole.includes('CCCC') && !whole.includes('DDDD'))

  await s.close()

  // 🔴 只读行为证明：整轮会话后文件逐字节不变、mtime 不变
  ok('会话后数据文件 sha256 不变', (await hashFile(desktopFile)) === beforeHash)
  const afterStat = await fs.stat(desktopFile)
  ok('会话后数据文件 mtime 不变', afterStat.mtimeMs === beforeStat.mtimeMs)

  // ============ ③ 便携形态（记录数组）可读 ============
  const portableFile = path.join(root, 'portable.json')
  await fs.writeFile(portableFile, JSON.stringify(envelope(fixtureStores())))
  const s2 = startSession(['--data-file', portableFile])
  await s2.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  const pProjects = toolJson(await callTool(s2, 'yfe_list_projects'))
  const pChapter = toolJson(await callTool(s2, 'yfe_read_chapter', { chapterId: 'c1' }))
  const pInsp = toolJson(await callTool(s2, 'yfe_list_inspirations', { projectId: 'p1' }))
  const pForm = toolJson(await callTool(s2, 'yfe_get_form', { projectId: 'p1', tabId: 'world' }))
  ok('便携数组形态：项目/正文/灵感/表单全可读', pProjects.length === 2 && pChapter.content === '正文内容甲' && pInsp.length === 1 && pForm.data['世界名称'] === '苍云大陆')
  ok('便携形态输出同样无密钥', !s2.raw().includes(SECRET) && !s2.raw().includes(SEARCH_SECRET))
  await s2.close()

  // ============ ④ 数字键污染形态（数组被展开成 {"0":…}）按真实主键重建 ============
  const polluted = envelope({ projects: { 0: fixtureStores().projects[0], 1: fixtureStores().projects[1] } })
  const pollutedFile = path.join(root, 'polluted.json')
  await fs.writeFile(pollutedFile, JSON.stringify(polluted))
  const s3 = startSession(['--data-file', pollutedFile])
  await s3.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  const fixed = toolJson(await callTool(s3, 'yfe_get_project', { projectId: 'p1' }))
  ok('数字键污染文件按真实主键救回', fixed.id === 'p1' && fixed.name === '测试书')
  await s3.close()

  // ============ ⑤ 文件缺失 → 如实报错（网页端不可用口径），不伪造空数据 ============
  const s4 = startSession(['--data-file', path.join(root, 'missing.json')])
  await s4.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  const noFile = await callTool(s4, 'yfe_list_projects')
  ok('数据文件缺失 → isError 且明说网页版不可用', noFile.isError === true && noFile.content[0].text.includes('网页版') && noFile.content[0].text.includes('不可用'))
  await s4.close()

  // ============ ⑥ 格式不符 → 拒绝读取 ============
  const badFile = path.join(root, 'bad.json')
  await fs.writeFile(badFile, JSON.stringify({ hello: 'world' }))
  const s5 = startSession(['--data-file', badFile])
  await s5.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  const badFormat = await callTool(s5, 'yfe_list_projects')
  ok('缺 app/kind 标记 → 拒绝读取', badFormat.isError === true && badFormat.content[0].text.includes('格式不正确'))
  await s5.close()

  // ============ ⑦ 便携根目录定位（--portable-root → data/ 下约定文件名） ============
  const portableRoot = path.join(root, 'portable-app')
  await fs.mkdir(path.join(portableRoot, 'data'), { recursive: true })
  await fs.writeFile(path.join(portableRoot, 'data', 'youth-fantasy-engine-data.json'), JSON.stringify(envelope(fixtureStores())))
  const s6 = startSession(['--portable-root', portableRoot])
  await s6.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  const rootProjects = toolJson(await callTool(s6, 'yfe_list_projects'))
  ok('--portable-root 按约定定位数据文件', rootProjects.length === 2)
  await s6.close()
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

console.log(`\n${pass} 项通过，${process.exitCode ? '存在失败' : '全部通过'}`)
if (process.exitCode) process.exit(1)