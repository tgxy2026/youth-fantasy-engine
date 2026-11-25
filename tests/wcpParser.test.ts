// ============ 3.7.3 · W2 WCP 双段解析与候选直连 ============
//
// 盯五件事：
//   ① 标准 JSON：Part 1 精确拆出，6 类候选字段归一化正确；
//   ② 容错：寒暄 / 代码块 / 尾逗号 / 缺失标记 / 尾部 JSON 块都能安全切分；
//   ③ 损坏 JSON：Part 1 **逐字保留**，jsonFailed=true，零异常；
//   ④ Markdown 清单 / 无标记纯正文：安全解析，不误判；
//   ⑤ 候选直连 `chapterPostProcess`：库内匹配状态（changed / new / registered）与落库行为同口径。
import * as db from '../src/lib/db'
import { memoryOps, __resetMockStores } from './mock-memory'
import {
  countWcpCandidates,
  hasWcpCandidates,
  parseWcpReply,
  type WcpParsedChanges,
} from '../src/lib/wcp/wcpParser'
import { applyWcpCandidates, buildWcpCandidates, summarizeWcpCandidates } from '../src/lib/wcp/wcpApply'
import { cardFieldPath } from '../src/lib/settings/settingLedger'
import { saveBiographyProse, readBiography } from '../src/lib/settings/charBiography'
import { readResourceTransfers } from '../src/lib/settings/resourceLedger'
import { readStateRecords } from '../src/lib/settings/stateTrack'
import type { Chapter, Volume } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const S = '<<<WCP_BODY_START>>>'
const E = '<<<WCP_BODY_END>>>'
const CS = '<<<WCP_CHANGES_START>>>'
const CE = '<<<WCP_CHANGES_END>>>'

const STANDARD_JSON = JSON.stringify({
  entities: [{ name: '青锋剑', type: '物品', summary: '一柄青色长剑', evidence: '雨停了' }],
  statusChanges: [{ character: '林晚', before: '炼气三层', after: '筑基一层', quote: '她踏入了筑基' }],
  resourceTransfers: [{ item: '青锋剑', from: '苏明', to: '林晚', action: '转移', quote: '苏明把剑递给她' }],
  foreshadows: [{ code: 'F01', action: '埋设', content: '旧玉佩' }],
  relations: [{ charA: '林晚', charB: '苏明', change: '结为同盟', quote: '两人击掌为誓' }],
  bioNodes: [{ character: '林晚', title: '筑基', summary: '突破筑基', tag: '成长突破', evidence: '她踏入了筑基' }],
})

const EMPTY_CHANGES: WcpParsedChanges = {
  entities: [], statuses: [], resources: [], foreshadows: [], relations: [], biographies: [],
}

async function main() {
  db.setStoreOps(memoryOps)
  __resetMockStores()
  db.setCurrentProject('p-wcp-parse')

  // ---------- ① 标准 JSON ----------
  {
    const r = parseWcpReply(`${S}\n雨停了。\n${E}\n\n${CS}\n${STANDARD_JSON}\n${CE}`, 'json')
    ok('标准 JSON：正文精确拆出', r.body === '雨停了。')
    ok('标准 JSON：6 类候选齐全', r.changes.entities.length === 1 && r.changes.statuses.length === 1
      && r.changes.resources.length === 1 && r.changes.foreshadows.length === 1
      && r.changes.relations.length === 1 && r.changes.biographies.length === 1)
    ok('实体 type / desc / evidence 映射正确',
      r.changes.entities[0].type === '物品' && r.changes.entities[0].desc === '一柄青色长剑' && r.changes.entities[0].evidence === '雨停了')
    ok('状态 before/after 归一化为 state=after', r.changes.statuses[0].state === '筑基一层' && r.changes.statuses[0].evidence === '她踏入了筑基')
    ok('关系引文并入变化说明（可溯源）', r.changes.relations[0].change.includes('两人击掌为誓'))
    ok('小传节点字段齐全', r.changes.biographies[0].name === '林晚' && r.changes.biographies[0].tag === '成长突破')
    ok('标准 JSON 不算失败', !r.jsonFailed && r.format === 'json' && r.hasPart1Marker && r.hasPart2Marker)
    ok('候选计数正确', countWcpCandidates(r.changes) === 6 && hasWcpCandidates(r.changes))
  }

  // ---------- ② 容错：寒暄 + 代码块 + 尾逗号 ----------
  {
    const raw = `好的，以下是结果：\n${S}\n她走进雨里。\n${E}\n${CS}\n\`\`\`json\n{"entities":[{"name":"雨巷","type":"地点","summary":"旧城巷子","evidence":"她走进雨里"},],"statusChanges":[]}\n\`\`\`\n${CE}`
    const r = parseWcpReply(raw, 'json')
    ok('代码块 / 尾逗号 JSON 成功容错', r.format === 'json' && !r.jsonFailed && r.changes.entities.length === 1)
    ok('容错时正文仍精确', r.body === '她走进雨里。')
  }

  // ---------- ③ 损坏 JSON：正文 100% 保留 ----------
  {
    const raw = `${S}\n这段正文一个字都不能丢。\n${E}\n${CS}\n{"entities": [{"name": 坏掉了\n${CE}`
    const r = parseWcpReply(raw, 'json')
    ok('损坏 JSON 不抛异常且正文完整', r.body === '这段正文一个字都不能丢。' && r.jsonFailed)
    ok('损坏 JSON 触发一键切 Markdown 引导', r.jsonAttempted && r.warnings.some(w => w.includes('Markdown')))
  }

  // ---------- ④ Markdown 清单 / 纯正文 ----------
  {
    const md = `${S}\n正文。\n${E}\n${CS}\n### 新登场设定\n- 青锋剑（物品）：一柄长剑｜依据：「雨停了」\n### 角色状态变动\n- 林晚：炼气三层 → 筑基一层｜依据：「她踏入了筑基」\n### 物品流转\n- （无）\n### 伏笔推进\n- [埋设] F01 · 旧玉佩\n### 关系与里程碑\n- 林晚 × 苏明：结为同盟｜依据：「击掌为誓」\n${CE}`
    const r = parseWcpReply(md, 'markdown')
    ok('Markdown 清单解析出 5 个固定分块', r.format === 'markdown' && r.markdownCards.length === 5)
    ok('Markdown 清单不算 JSON 失败', !r.jsonFailed && !r.jsonAttempted)
    ok('Markdown 清单正文保留', r.body === '正文。')

    const plain = parseWcpReply('今天下雨了，她没带伞。', 'json')
    ok('无标记纯正文整段归入 Part 1', plain.body === '今天下雨了，她没带伞。' && plain.format === 'none')
    ok('无标记纯正文不误报 JSON 失败', !plain.jsonFailed)

    const onlyJson = parseWcpReply('{"entities":[{"name":"甲","type":"人物","summary":"乙","evidence":"丙"}]}', 'json')
    ok('无标记且只有变动摘要 JSON：归入 Part 2，不吞进正文',
      onlyJson.body === '' && onlyJson.format === 'json' && onlyJson.changes.entities.length === 1)

    const mismatched = parseWcpReply(`${S}\n正文。\n${E}\n${CS}\n### 新登场设定\n- 甲（人物）：乙\n${CE}`, 'json')
    ok('设 JSON 但模型给清单：亮切换引导且保留正文', mismatched.body === '正文。' && mismatched.jsonFailed && mismatched.markdownCards.length === 1)
  }

  // ---------- ⑤ 退化分隔符 ----------
  {
    const raw = '## 第一部分\n她的剑出鞘。\n\n## 变动摘要\n### 伏笔推进\n- [回收] F01 · 旧玉佩'
    const r = parseWcpReply(raw, 'markdown')
    ok('中文标题退化切分成功', r.body.includes('她的剑出鞘') && !r.body.includes('变动摘要') && r.markdownCards.length === 1)

    const tail = '正文在末尾代码块之前。\n```json\n{"foreshadows":[{"code":"F02","action":"埋设","content":"铜镜"}]}\n```'
    const r2 = parseWcpReply(tail, 'json')
    ok('尾部 JSON 代码块被识别为 Part 2', r2.format === 'json' && r2.changes.foreshadows.length === 1 && r2.body.includes('正文在末尾代码块之前'))

    const badShape = parseWcpReply(`${S}\n正文。\n${E}\n${CS}\n{"foo":1}\n${CE}`, 'json')
    ok('JSON 结构不符约定也算失败（会引导切换）', badShape.jsonFailed && badShape.body === '正文。')
  }

  // ---------- ⑥ 候选直连 chapterPostProcess ----------
  {
    const PID = 'p-wcp-parse'
    const vol: Volume = { id: 'v1', projectId: PID, order: 0, title: '第一卷', description: '', createdAt: 1 }
    await db.saveVolume(vol)
    const chapter: Chapter = {
      id: 'c1', projectId: PID, volumeId: 'v1', order: 0, title: '第一章 雨夜',
      content: '她踏入了筑基。苏明把剑递给她。两人击掌为誓。',
      summary: '', status: '草稿', wordCount: 20, createdAt: 1, updatedAt: 1,
    }
    await db.saveChapter(chapter)
    await db.saveTableRow({ id: 'fs1', projectId: PID, tabId: 'foreshadow', data: { '编号': 'F01', '伏笔内容': '旧玉佩' }, order: 0 })
    await db.saveTableRow({ id: 'rel1', projectId: PID, tabId: 'relations', data: { '人物A': '林晚', '人物B': '苏明', '关系类型': '', '演变轨迹（按卷）': '', '演变触发事件': '' }, order: 0 })
    await db.saveTableRow({ id: 'it1', projectId: PID, tabId: 'items', data: { '名称': '青锋剑' }, order: 0 })

    const statusKey = cardFieldPath('char-main', ['人物状态'])
    const nameKey = cardFieldPath('char-main', ['姓名'])
    ok('角色卡字段路径存在', !!statusKey && !!nameKey)
    await db.saveCardRecord({
      id: 'card1', projectId: PID, tabId: 'char-main', name: '林晚', order: 0,
      data: { ...(nameKey ? { [nameKey]: '林晚' } : {}), ...(statusKey ? { [statusKey]: '炼气三层' } : {}) },
    })
    await saveBiographyProse('card1', '林晚的旧小传。')

    const changes: WcpParsedChanges = {
      ...EMPTY_CHANGES,
      foreshadows: [{ code: 'F01', action: '埋设', content: '旧玉佩' }, { code: 'F99', action: '埋设', content: '没登记过的伏笔' }],
      relations: [{ a: '林晚', b: '苏明', type: '', change: '结为同盟（依据：「两人击掌为誓」）' }],
      statuses: [{ name: '林晚', state: '筑基一层', evidence: '她踏入了筑基' }],
      resources: [{ item: '青锋剑', action: '转移', from: '苏明', to: '林晚', evidence: '苏明把剑递给她' }],
      biographies: [{ name: '林晚', chapterNo: 0, title: '筑基', summary: '突破筑基', tag: '成长突破', evidence: '她踏入了筑基' }],
    }
    const built = await buildWcpCandidates({ chapterId: 'c1', chapterTitle: chapter.title, content: chapter.content, changes })
    const by = (kind: string, needle: string) => built.items.find(i => i.kind === kind && (i.label.includes(needle) || i.detail.includes(needle)))

    ok('已登记伏笔 → changed', by('foreshadow', '旧玉佩')?.status === 'changed')
    ok('未登记伏笔 → new 且提示先去登记', by('foreshadow', '没登记过')?.status === 'new' && !!by('foreshadow', '没登记过')?.detail.includes('请先去登记'))
    ok('已登记关系 → changed', by('relation', '林晚')?.status === 'changed')
    ok('角色状态变化 → changed', by('status', '林晚')?.status === 'changed')
    ok('已登记物品流转 → changed', by('resource', '青锋剑')?.status === 'changed')
    ok('小传节点 → changed', by('biography', '筑基')?.status === 'changed')
    ok('章号按叙事序算出为 1', built.chapterNo === 1)

    const stats = summarizeWcpCandidates(built.items)
    ok('统计口径：未登记只提示、不进入可勾选', stats.hintOnly === 1 && stats.selectable === 5)

    const statusItem = built.items.find(i => i.kind === 'status')
    const bioItem = built.items.find(i => i.kind === 'biography')
    ok('状态与小传条目带落库载荷', !!statusItem?.raw && !!bioItem?.raw)
    const applied = await applyWcpCandidates(
      { chapterId: 'c1', chapterTitle: chapter.title, content: chapter.content },
      [statusItem!, bioItem!],
      built.chapterNo,
    )
    ok('勾选落库成功且无失败项', applied.created === 2 && applied.failed.length === 0, JSON.stringify(applied))

    const cards = await db.getCardRecords('char-main')
    const afterKey = statusKey ?? ''
    ok('角色状态字段已写入新值', cards[0]?.data[afterKey] === '筑基一层')
    ok('状态变化留下可回溯记录', (await readStateRecords()).length >= 1)
    const bio = await readBiography('card1')
    ok('小传节点已追加', !!bio && bio.nodes.some(n => n.title === '筑基'))
    const transfers = await readResourceTransfers()
    ok('未勾选的物品流转没有落库', transfers.length === 0)
  }

  console.log(`\nwcpParser: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })