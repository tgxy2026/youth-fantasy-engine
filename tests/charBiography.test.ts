// ============ 3.7.1 · W1 人物小传数据层与安全门禁 ============
//
// 盯五件事：
//   ① 排序与调序：前传（prequel）按 order 排在正文前，正文按章号升序；前传调序仅改相邻前传，边界不变；
//   ② 去重与转化：同 phase + 同章号 + 归一化标题判重；3.7.0 状态演变零成本转为节点并保留 evidence；
//   ③ 持久化串行读写：正文保存与节点追加互不覆盖；超 BIO_NODE_LIMIT 如实返回 overflow；
//   ④ 读库失败中止保护：读 settingsKV 抛错时写入全部中止（ok:false），绝不拿空基线覆盖旧小传；
//   ⑤ 导出格式：Markdown 包含角色名、定位、正文与前传/正文节点时间轴。
import * as db from '../src/lib/db'
import { memoryOps, __resetMockStores } from './mock-memory'
import {
  appendBioNodes,
  BIO_NODE_LIMIT,
  bioNodeFromStateRecord,
  buildBioNode,
  CHAR_BIOGRAPHY_KEY,
  deleteBioNode,
  emptyBiography,
  formatBiographyMarkdown,
  isDuplicateBioNode,
  readAllBiographies,
  readBiography,
  renameBioNodeTag,
  reorderCharacterPrequelNode,
  reorderPrequelNode,
  saveBiographyProse,
  sortBioNodes,
  updateLastScannedChapter,
  upsertBioNode,
  type BioEventNode,
} from '../src/lib/settings/charBiography'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'p-bio-w1'
const CHAR_ID = 'char-chenyuan'

async function seed() {
  __resetMockStores()
  db.setStoreOps(memoryOps)
  db.setCurrentProject(PID)
}

async function main() {
  // ---------- ① 排序与前传调序（纯函数） ----------
  {
    const s9 = buildBioNode({ id: 's9', phase: 'story', chapterNo: 9, title: '外门大比', now: 10 })
    const s2 = buildBioNode({ id: 's2', phase: 'story', chapterNo: 2, title: '觉醒神体', now: 20 })
    const p1 = buildBioNode({ id: 'p1', phase: 'prequel', order: 1, title: '流落青岚', now: 30 })
    const p0 = buildBioNode({ id: 'p0', phase: 'prequel', order: 0, title: '云州灭门', now: 40 })
    const sorted = sortBioNodes([s9, p1, s2, p0])
    ok('前传按 order 排在正文之前，正文按章号升序', sorted.map(n => n.id).join(',') === 'p0,p1,s2,s9', sorted.map(n => n.id).join(','))

    const movedDown = reorderPrequelNode(sorted, 'p0', 1)
    ok('前传首条下移一位', movedDown.map(n => n.id).join(',') === 'p1,p0,s2,s9', movedDown.map(n => n.id).join(','))
    ok('调序后重编连续 order', movedDown.filter(n => n.phase === 'prequel').map(n => n.order).join(',') === '0,1')

    const topNoop = reorderPrequelNode(sorted, 'p0', -1)
    ok('前传首条上移越界保持原顺序', topNoop.map(n => n.id).join(',') === 'p0,p1,s2,s9')
    const botNoop = reorderPrequelNode(sorted, 'p1', 1)
    ok('前传末条下移越界保持原顺序', botNoop.map(n => n.id).join(',') === 'p0,p1,s2,s9')
    const storyNoop = reorderPrequelNode(sorted, 's2', -1)
    ok('传正文节点 id 不动任何顺序', storyNoop.map(n => n.id).join(',') === 'p0,p1,s2,s9')
  }

  // ---------- ② 判重、状态演变提拔与 Markdown 导出 ----------
  {
    const existing: BioEventNode[] = [
      buildBioNode({ id: 'n1', phase: 'story', chapterNo: 3, title: '雨夜反杀！', summary: '斩杀来犯外门弟子' }),
    ]
    ok('同章同归一化标题（忽略标点空格）判重', isDuplicateBioNode(existing, {
      phase: 'story', chapterNo: 3, title: ' 雨夜 反杀 ', summary: '不同摘要',
    }))
    ok('不同章号同标题不误判重复', !isDuplicateBioNode(existing, {
      phase: 'story', chapterNo: 8, title: '雨夜反杀', summary: '再次反杀',
    }))

    const promoted = bioNodeFromStateRecord({
      id: 'st-1',
      ref: { kind: 'card', tabId: 'char-main', id: CHAR_ID, projectId: PID },
      chapterId: 'ch-12',
      chapterNo: 12,
      state: '重伤突破至通脉境',
      previous: '淬体巅峰',
      trigger: '章后整理',
      evidence: '血气冲破关隘，陈渊踏入通脉。',
      createdAt: 100,
    }, 0, 200)
    ok('有章号状态记录转为 story 节点并保留来源与证据',
      promoted.phase === 'story' && promoted.chapterNo === 12 && promoted.source === 'state-promote'
      && promoted.evidence === '血气冲破关隘，陈渊踏入通脉。' && promoted.summary.includes('淬体巅峰'))

    const prequelPromoted = bioNodeFromStateRecord({
      id: 'st-0',
      ref: { kind: 'card', tabId: 'char-main', id: CHAR_ID, projectId: PID },
      chapterId: '',
      chapterNo: 0,
      state: '幼年流落杂役院',
      createdAt: 100,
    })
    ok('无章号状态记录转为 prequel 节点', prequelPromoted.phase === 'prequel' && prequelPromoted.chapterNo === 0)

    const md = formatBiographyMarkdown('陈渊', '主要角色', {
      ...emptyBiography(CHAR_ID),
      prose: '自幼父母双亡，于青岚宗杂役院蛰伏。',
      nodes: [prequelPromoted, promoted],
    })
    ok('导出 Markdown 含角色名、定位、正文与双阶段节点',
      md.includes('# 陈渊 · 角色小传') && md.includes('定位：主要角色')
      && md.includes('自幼父母双亡') && md.includes('### 开篇前（前传）') && md.includes('### 正文阶段') && md.includes('第12章'))
  }

  // ---------- ③ 持久化读写、去重、增删改与上限 ----------
  {
    await seed()
    const saveRes = await saveBiographyProse(CHAR_ID, '第一段生平正文')
    ok('保存人物小传正文成功', saveRes.ok && saveRes.bio?.prose === '第一段生平正文')

    const n1 = buildBioNode({ id: 'b1', phase: 'prequel', order: 0, title: '幼年变故', summary: '灭门之夜' })
    const n2 = buildBioNode({ id: 'b2', phase: 'story', chapterNo: 5, title: '初露锋芒', summary: '小比获胜' })
    const dupOfN2 = buildBioNode({ id: 'b2-dup', phase: 'story', chapterNo: 5, title: '初露锋芒！', summary: '同章重复' })
    const addRes = await appendBioNodes(CHAR_ID, [n1, n2, dupOfN2], { lastScannedChapterNo: 5 })
    ok('追加节点自动去重且保留已有正文',
      addRes.ok && addRes.appended === 2 && addRes.skippedDup === 1 && addRes.total === 2)

    const loaded = await readBiography(CHAR_ID)
    ok('回读完整小传含正文、节点与扫描水位',
      loaded?.prose === '第一段生平正文' && loaded.nodes.length === 2 && loaded.lastScannedChapterNo === 5)

    // 手动新增前传并调序
    const n3 = buildBioNode({ id: 'b3', phase: 'prequel', order: 1, title: '拜入青岚', summary: '杂役起步' })
    const upRes = await upsertBioNode(CHAR_ID, n3)
    ok('upsert 新增节点成功', upRes.ok && upRes.total === 3)
    const reordered = await reorderCharacterPrequelNode(CHAR_ID, 'b3', -1)
    ok('持久化调序前传成功', reordered.ok)
    const afterReorder = await readBiography(CHAR_ID)
    ok('调序后 b3 排在首位', afterReorder?.nodes.filter(n => n.phase === 'prequel').map(n => n.id).join(',') === 'b3,b1')

    // 更新已有节点
    const editedN2 = { ...n2, title: '初露锋芒（修订）', summary: '大比夺魁' }
    const editRes = await upsertBioNode(CHAR_ID, editedN2)
    ok('upsert 更新既有节点不重复增行', editRes.ok && editRes.total === 3)
    ok('更新后标题与摘要生效', (await readBiography(CHAR_ID))?.nodes.find(n => n.id === 'b2')?.title === '初露锋芒（修订）')

    // 删除节点与更新扫描水位
    const delRes = await deleteBioNode(CHAR_ID, 'b1')
    ok('删除单条节点成功', delRes.ok && delRes.deleted && delRes.total === 2)
    const scanRes = await updateLastScannedChapter(CHAR_ID, 12)
    ok('更新扫描水位成功', scanRes.ok && (await readBiography(CHAR_ID))?.lastScannedChapterNo === 12)

    // 上限超限如实报告 overflow
    const bulk = Array.from({ length: BIO_NODE_LIMIT + 3 }, (_, i) =>
      buildBioNode({ id: `bulk-${i}`, phase: 'story', chapterNo: i + 1, title: `节点${i}`, now: i + 1 }))
    const bulkRes = await appendBioNodes('char-overflow', bulk)
    ok('超出单角色节点上限如实截断并报告 overflow',
      bulkRes.ok && bulkRes.total === BIO_NODE_LIMIT && bulkRes.overflow === 3 && bulkRes.appended === BIO_NODE_LIMIT)

    // 自定义节点类型保留与跨角色批量改名
    const customTagNode = buildBioNode({ id: 'b-custom', phase: 'story', chapterNo: 15, title: '门派暗线触发', tag: '门派暗线' })
    ok('自定义节点类型原样保留而不强制降级为其他', customTagNode.tag === '门派暗线')
    await appendBioNodes(CHAR_ID, [customTagNode])
    await saveBiographyProse('char-other', '配角正文')
    await appendBioNodes('char-other', [buildBioNode({ id: 'o1', phase: 'prequel', title: '配角暗线', tag: '门派暗线' })])
    const renRes = await renameBioNodeTag('门派暗线', '宗门伏线')
    ok('renameBioNodeTag 跨角色批量改名生效',
      renRes.ok && renRes.updated === 2
      && (await readBiography(CHAR_ID))?.nodes.find(n => n.id === 'b-custom')?.tag === '宗门伏线'
      && (await readBiography('char-other'))?.nodes[0]?.tag === '宗门伏线')

    // 损坏数据只读兜底不崩溃
    await db.setSettingFor(PID, CHAR_BIOGRAPHY_KEY, { broken: 'not-an-object', [CHAR_ID]: { prose: 'ok', nodes: [{ bad: true }] } })
    const repaired = await readAllBiographies()
    ok('损坏节点被过滤且非法条目跳过不崩', !('broken' in repaired) && repaired[CHAR_ID]?.nodes.length === 0)
  }

  // ---------- ④ 读库失败中止保护：绝不以空基线覆盖已有小传 ----------
  {
    await seed()
    await saveBiographyProse(CHAR_ID, '珍贵手写小传')
    await appendBioNodes(CHAR_ID, [buildBioNode({ id: 'keep-1', phase: 'story', chapterNo: 1, title: '开篇节点' })])

    let putCalled = 0
    const badOps = {
      ...memoryOps,
      get: async (store: string, id: string) => {
        if (store === 'settingsKV') throw new Error('settingsKV read down')
        return memoryOps.get(store as never, id as never)
      },
      put: async (store: string, val: unknown) => {
        if (store === 'settingsKV') putCalled++
        return memoryOps.put(store as never, val as never)
      },
    }
    db.setStoreOps(badOps as never)
    const rProse = await saveBiographyProse(CHAR_ID, '覆盖企图')
    const rAppend = await appendBioNodes(CHAR_ID, [buildBioNode({ id: 'new-1', phase: 'story', chapterNo: 2, title: '新节点' })])
    const rUpsert = await upsertBioNode(CHAR_ID, buildBioNode({ id: 'new-2', phase: 'story', chapterNo: 3, title: '新节点2' }))
    const rDelete = await deleteBioNode(CHAR_ID, 'keep-1')
    const rRename = await renameBioNodeTag('成长突破', '突破')
    db.setStoreOps(memoryOps)

    ok('读库失败时五个写接口全部中止并返回 ok:false',
      !rProse.ok && !rAppend.ok && !rUpsert.ok && !rDelete.ok && !rRename.ok && putCalled === 0)
    const intact = await readBiography(CHAR_ID)
    ok('读库失败后原有正文与节点完好无损',
      intact?.prose === '珍贵手写小传' && intact.nodes.length === 1 && intact.nodes[0].id === 'keep-1')
  }

  console.log(`\ncharBiography: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
