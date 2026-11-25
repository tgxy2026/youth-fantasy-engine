// ============ 3.7.1 · W3/W4 人物小传 AI 解析、章后整理接入与示范数据 ============
import * as db from '../src/lib/db'
import { memoryOps, __resetMockStores } from './mock-memory'
import { parseExtractedBioNodesDetailed } from '../src/lib/aiTasks/charBiographyAI'
import { parseChapterChanges } from '../src/lib/aiTasks/postProcess'
import { applyPostProcess, matchBiographies } from '../src/lib/outline/chapterPostProcess'
import { readBiography, saveBiographyProse } from '../src/lib/settings/charBiography'
import { DEMO_CHAR_BIOGRAPHIES } from '../src/data/seedCharBiographies'
import { seedDemoBiographies } from '../src/lib/settings/charBiographySeed'
import type { CardRecord } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'p-bio-ai'
const card = (id: string, tabId: string, name: string, aliases = ''): CardRecord => ({
  id, projectId: PID, tabId, name, order: 0, data: aliases ? { 别称: aliases } : {},
})

async function seed() {
  __resetMockStores()
  db.setStoreOps(memoryOps)
  db.setCurrentProject(PID)
  await memoryOps.put('volumes', { id: 'v1', projectId: PID, order: 0, title: '卷一', createdAt: 1 })
  await memoryOps.put('chapters', {
    id: 'ch-5', projectId: PID, volumeId: 'v1', order: 4, title: '第5章 外门大比',
    summary: '', status: 'draft', content: '陈渊徒手接下柳风剑气夺魁。', wordCount: 15, createdAt: 1, updatedAt: 1,
  })
}

async function main() {
  // ---------- ① parseExtractedBioNodesDetailed ----------
  {
    const okRes = parseExtractedBioNodesDetailed(JSON.stringify([
      { chapterNo: 5, title: '外门大比夺魁', summary: '以杂役身份战胜柳风', tag: '高光时刻', evidence: '陈渊徒手接下柳风剑气' },
      { chapterNo: 5, title: '缺证据节点', summary: '无原文依据应丢弃', tag: '其他' },
      { chapterNo: 6, title: '自定义标签节点', tag: '宗门暗线', evidence: '原句在' },
      { chapterNo: 7, title: '空标签节点', tag: '   ', evidence: '另有原句' },
    ]), '陈渊')
    ok('节点解析：有标题与依据保留，缺依据丢弃', okRes.outcome !== 'invalid' && okRes.data.length === 3, JSON.stringify(okRes))
    ok('缺省角色名回填、保留自定义标签且空标签归入「其他」',
      okRes.data[0].name === '陈渊' && okRes.data[1].tag === '宗门暗线' && okRes.data[2].tag === '其他')

    const bad = parseExtractedBioNodesDetailed('不是 JSON')
    ok('非法 JSON 返回 invalid', bad.outcome === 'invalid' && bad.data.length === 0)
  }

  // ---------- ② 章后整理：解析小传节点 + 比对 + 落库 ----------
  {
    const changes = parseChapterChanges(JSON.stringify([
      { kind: '小传节点', name: '阿渊', title: '外门大比夺魁', summary: '击败外门第一人', tag: '高光时刻', evidence: '陈渊徒手接下柳风剑气' },
      { kind: '小传节点', name: '路人甲', title: '路过', summary: '无卡人物', tag: '其他', evidence: '路人甲走过' },
      { kind: '小传节点', name: '阿渊', title: '无依据应过滤', summary: 'x' },
    ]))
    ok('parseChapterChanges 解析 kind=小传节点 并过滤缺依据条目', (changes.biographies?.length ?? 0) === 2)

    const cards = [
      { tabId: 'char-main', list: [card('c-chen', 'char-main', '陈渊', '阿渊、渊哥')] },
      { tabId: 'char-secondary', list: [card('c-liu', 'char-secondary', '柳风')] },
      { tabId: 'char-npc', list: [card('c-tie', 'char-npc', '王铁柱')] },
    ]
    const matched = matchBiographies([
      ...(changes.biographies ?? []),
      { name: '王铁柱', chapterNo: 5, title: 'NPC 不收录', summary: 'npc', tag: '其他', evidence: '铁柱鼓掌' },
    ], cards, 5, 'ch-5', {})

    const chenItem = matched.find(i => i.label.startsWith('陈渊'))
    const missItem = matched.find(i => i.label.startsWith('路人甲'))
    const npcItem = matched.find(i => i.label.startsWith('王铁柱'))
    ok('别名命中主要角色 → changed', chenItem?.status === 'changed' && chenItem.matchedId === 'c-chen', JSON.stringify(chenItem))
    ok('未登记或 NPC 一律 unregistered（只提示不建卡）', missItem?.status === 'unregistered' && npcItem?.status === 'unregistered')

    // 落库：已有小传正文不能被覆盖
    await seed()
    await saveBiographyProse('c-chen', '作者手写的小传正文')
    const r = await applyPostProcess({ chapterId: 'ch-5', content: 'x', chapterTitle: '第5章' }, [chenItem!], 5)
    ok('章后整理落库 biography 成功', r.created === 1 && r.failed.length === 0, JSON.stringify(r))
    const loaded = await readBiography('c-chen')
    ok('落库后只追加节点，已有手写正文原样保留',
      loaded?.prose === '作者手写的小传正文' && loaded.nodes.length === 1 && loaded.nodes[0].source === 'post-process')

    // 重跑整理：已有节点判 registered
    const again = matchBiographies(changes.biographies ?? [], cards, 5, 'ch-5', loaded ? { 'c-chen': loaded } : {})
    ok('同章同节点重跑整理标为 registered', again.find(i => i.matchedId === 'c-chen')?.status === 'registered')
  }

  // ---------- ③ 示范项目纯数据播种 ----------
  {
    await seed()
    const cardIds: Record<string, string> = {
      陈渊: 'id-chen', 洛清欢: 'id-luo', 萧景行: 'id-xiao', 青玄子: 'id-qing',
      柳风: 'id-liu', 顾长风: 'id-gu', 周崇: 'id-zhou', 枯血: 'id-ku',
      血魔尊者: 'id-xue', 洛崇: 'id-luochong', 血鸦: 'id-xueya',
    }
    await seedDemoBiographies(
      cardIds,
      Array.from({ length: 21 }, (_, i) => `ch-${i + 1}`),
    )
    const chenBio = await readBiography('id-chen')
    const kuBio = await readBiography('id-ku')
    const xueyaBio = await readBiography('id-xueya')
    ok('示范项目播种陈渊小传与双阶段节点', !!chenBio && chenBio.prose.includes('混沌神体') && chenBio.nodes.length >= 6)
    ok('示范项目覆盖全部 11 位主要/次要角色且补齐周崇/枯血/血魔尊者/洛崇/血鸦',
      DEMO_CHAR_BIOGRAPHIES.length === 11 && !!kuBio && kuBio.nodes.length >= 3 && !!xueyaBio && xueyaBio.nodes.length >= 3)
  }

  console.log(`\ncharBiographyAI: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
