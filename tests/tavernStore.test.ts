// ============ 酒馆模式 · 存储封装（P0 验收：索引与分条成对、读写不抛错）============
//
// 这组断言盯的是方案 §11.8 那条风险：**索引与分条不同步 → 幽灵条目**
// （列表里看得见、点开是空的）。所有增删改都必须成对，本测试逐个验证。
import * as db from '../src/lib/db'
import * as store from '../src/lib/tavern/store'
import { __resetMockStores } from './mock-memory'
import { getTavernSettings, saveTavernSettings } from '../src/lib/tavern/settings'
import type { TavernSessionIndexItem, TavernReport } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'tavern-test-proj'

function mkSession(title: string) {
  return {
    title,
    mode: 'immersive' as const,
    anchorChapterId: 'ch1',
    anchorChapterLabel: '第1章 · 起始',
    cast: [{ cardId: 'c1', role: 'user' as const, tabId: 'char-main', name: '李默' }],
    scene: { place: '山门', time: '清晨', present: ['李默'], description: '' },
    model: { providerId: 'p1' },
    params: {},
  }
}

async function main() {
  __resetMockStores()
  db.setCurrentProject(PID)

  // ---------- 1) 会话：索引与分条成对 ----------
  {
    const s1 = await store.createSession(mkSession('第一场'))
    ok('createSession 写入索引', (await store.listSessions()).some(x => x.id === s1.id))
    ok('createSession 写入分条', (await store.getSession(s1.id))?.title === '第一场')
    ok('索引项带上参演角色摘要（列表不必回读会话）',
      (await store.listSessions())[0].castBrief === '李默')
  }

  // ---------- 2) 更新同步索引 ----------
  {
    const s1 = (await store.listSessions())[0]
    const full = (await store.getSession(s1.id))!
    await store.saveSession({ ...full, title: '改名了' })
    ok('改标题后索引同步更新', (await store.listSessions())[0].title === '改名了')
  }

  // ---------- 3) 排序 ----------
  {
    // 同一毫秒内创建的两条记录 updatedAt 会相等，排序退化为「保持插入序」（JS sort 是稳定的）——
    // 这里刻意错开 2ms，让断言测的是「较新的排前面」这个语义本身，而不是毫秒精度。
    await new Promise(r => setTimeout(r, 2))
    const s2 = await store.createSession(mkSession('第二场'))
    const list = await store.listSessions()
    ok('listSessions 按 updatedAt 倒序', list[0].id === s2.id && list.length === 2, `实际=${list.map(x => x.title).join(',')}`)
  }

  // ---------- 4) 删除会话（成对） ----------
  {
    const first = (await store.listSessions()).find(x => x.title === '改名了')!
    await store.deleteSession(first.id)
    ok('deleteSession 移除索引项', (await store.listSessions()).every(x => x.id !== first.id))
    ok('deleteSession 清除分条', (await store.getSession(first.id)) === null)
  }

  // ---------- 5) 幽灵条目自检与清理 ----------
  {
    const idx = await db.getSetting<TavernSessionIndexItem[]>('tavern.sessionIndex', [])
    idx.push({ id: 'ghost-1', title: '幽灵', mode: 'immersive', castBrief: '', anchorTitle: '', updatedAt: Date.now() })
    await db.setSetting('tavern.sessionIndex', idx)

    const audit = await store.auditSessions()
    ok('auditSessions 检出幽灵条目', audit.ghosts.length === 1 && audit.ghosts[0].id === 'ghost-1', `实际=${audit.ghosts.length}`)
    ok('pruneGhostSessions 清理并返回条数', (await store.pruneGhostSessions()) === 1)
    ok('清理后索引里不再有幽灵', (await store.listSessions()).every(x => x.id !== 'ghost-1'))
  }

  // ---------- 6) 扮演设定 ----------
  {
    await store.saveCastSetting('c1', {
      voice: '清冷', address: '直呼其名', unknown: '不知自己是神脉', taboo: '不提师父', care: '在意师妹', never: '绝不滥杀',
    })
    const cs = await store.getCastSetting('c1')
    ok('扮演设定往返一致', cs.voice === '清冷' && cs.never === '绝不滥杀')
    ok('未设置的卡返回空结构而非抛错', (await store.getCastSetting('never-set')).voice === '')
  }

  // ---------- 7) 自由角色卡（全局 meta） ----------
  const fc = await store.createFreeChar({ ...store.emptyFreeCharacter(), name: '苏念' })
  {
    ok('createFreeChar 写入索引与分条',
      (await store.listFreeChars())[0]?.id === fc.id && (await store.getFreeChar(fc.id))?.name === '苏念')
    await store.saveFreeChar({ ...fc, name: '苏念（改）' })
    ok('改名后索引同步', (await store.listFreeChars())[0].name === '苏念（改）')
  }

  // ---------- 8) 记忆 / 日常 / 留言 ----------
  {
    await store.saveMemory({ ...store.emptyMemory(fc.id), relation: '关系不错，她开始主动搭话' })
    ok('记忆往返', (await store.getMemory(fc.id)).relation.includes('主动搭话'))

    await store.saveDaily({
      charId: fc.id, lastActiveAt: 1_700_000_000_000,
      log: [{ date: '2026-09-13', text: '去看了海' }], mood: '平静',
    })
    ok('日常状态往返', (await store.getDaily(fc.id)).mood === '平静')

    ok('未设置过日常时返回空结构', (await store.getDaily('nobody')).log.length === 0)

    await store.setGreeting(fc.id, '好久不见')
    ok('留言存在时 hasGreeting 为真', await store.hasGreeting(fc.id))
    ok('takeGreeting 取出文本', (await store.takeGreeting(fc.id)) === '好久不见')
    ok('takeGreeting 取出后即清除（只投递一次）', (await store.takeGreeting(fc.id)) === null)
  }

  // ---------- 9) 自由会话 ----------
  {
    const fsess = await store.createFreeSession([fc.id], '日常', { providerId: 'p1' }, {})
    ok('自由会话写入索引与分条',
      (await store.listFreeSessions())[0]?.id === fsess.id && (await store.getFreeSession(fsess.id))?.title === '日常')
  }

  // ---------- 10) 报告（新表 tavernReports） ----------
  {
    const rep: TavernReport = {
      id: 'r1', projectId: PID, sessionId: 's-x', sessionTitle: '第一场',
      anchorChapterId: 'ch1', anchorChapterLabel: '第1章 · 起始',
      cast: [], mode: 'immersive', overview: '这场戏基本成立',
      findings: [
        { id: 'f1', level: '矛盾', targetTabId: 'char-main', targetRecordId: 'c9', targetLabel: '李默', detail: '年龄与出场章冲突' },
        { id: 'f2', level: '存疑', targetTabId: '', detail: '语气存疑' },
      ],
      createdAt: Date.now(),
    }
    await db.saveReport(rep)
    const reports = await store.listReports()
    ok('listReports 返回本项目报告', reports.length === 1 && reports[0].id === 'r1')
    ok('报告索引带三档计数', reports[0].counts['矛盾'] === 1 && reports[0].counts['存疑'] === 1 && reports[0].counts['漏洞'] === 0)
    ok('getReport 读回完整 findings', (await store.getReport('r1'))?.findings.length === 2)

    await store.deleteReport('r1')
    ok('deleteReport 生效', (await store.listReports()).length === 0)
  }

  // ---------- 11) 删自由角色：级联清理 ----------
  {
    const mem2 = await store.getMemory(fc.id)
    await store.saveMemory({ ...mem2, facts: '她怕黑' })
    await store.deleteFreeChar(fc.id)
    ok('删角色：索引清掉', (await store.listFreeChars()).length === 0)
    ok('删角色：分条清掉', (await store.getFreeChar(fc.id)) === null)
    ok('删角色：记忆清掉', (await store.getMemory(fc.id)).facts === '')
    ok('删角色：日常清掉', (await store.getDaily(fc.id)).mood === undefined)
    ok('删角色：其会话因无参演角色一并删除（不留空会话）', (await store.listFreeSessions()).length === 0)
  }

  // ---------- 12) 新建会话：默认标题只由「本次最终选中的角色」得出 ----------
  {
    // 曾经的 bug：单角色分支用了「左栏当前选中的角色名」，
    // 于是「先全选、再取消一个」时，会话名挂的是被取消掉的那个角色。
    const A = { id: 'ca', name: '洛汐' }
    const B = { id: 'cb', name: '苏念' }
    const nameOf = (id: string) => [A, B].find(x => x.id === id)?.name

    const only = store.planFreeSessionCast([A.id], B.id, nameOf)
    ok('取消勾选苏念后只剩洛汐 → 标题用洛汐而不是左栏选中的苏念',
      only.charIds.join(',') === A.id && only.title === '和洛汐的对话', only.title)

    const both = store.planFreeSessionCast([A.id, B.id], A.id, nameOf)
    ok('两个角色 → 标题按选择顺序串起来', both.title === '与洛汐、苏念的对话', both.title)

    const none = store.planFreeSessionCast([], B.id, nameOf)
    ok('弹窗一个都没选时回退到左栏当前角色', none.charIds.join(',') === B.id && none.title === '和苏念的对话', none.title)

    const many = store.planFreeSessionCast(['c1', 'c2', 'c3', 'c4'], 'c1', id => id)
    ok('超过 3 个只取前 3（与界面上限一致）', many.charIds.length === 3, String(many.charIds.length))

    const unknown = store.planFreeSessionCast(['zz'], 'zz', () => undefined)
    ok('角色名取不到时不崩（退化为 ?）', unknown.title === '和?的对话', unknown.title)
  }

  // ---------- 数据归属（老大明确要求，用断言钉死，别在重构里被改掉） ----------
  //   随项目：剧情推演会话与扮演设定、推演报告
  //   跨项目：自由对话会话、角色卡、控制面板设置
  {
    __resetMockStores()
    db.setCurrentProject('scope-proj-a')
    const plot = await store.createSession(mkSession('A 项目的推演'))
    await store.saveCastSetting('scope-card-1', { voice: '清冷', address: '', unknown: '', taboo: '', care: '', never: '' })
    const fc = await store.createFreeChar({ ...store.emptyFreeCharacter(), name: '跨项目角色' })
    const free = await store.createFreeSession([fc.id], '跨项目对话', { providerId: '' }, {})
    await db.saveReport({
      id: 'scope-report-1', projectId: 'scope-proj-a', sessionId: plot.id, sessionTitle: 'A 项目的推演',
      anchorChapterId: 'ch1', anchorChapterLabel: '第1章 · 起始', cast: [], mode: 'immersive',
      overview: '概览', findings: [], createdAt: Date.now(),
    })
    const def = await getTavernSettings()
    await saveTavernSettings({ ...def, common: { ...def.common, timeoutSec: 123 } })

    db.setCurrentProject('scope-proj-b')
    ok('剧情推演会话随项目（换项目看不到）', (await store.listSessions()).every(x => x.id !== plot.id))
    ok('剧情扮演设定随项目', (await store.getCastSetting('scope-card-1')).voice === '')
    ok('推演报告随项目', (await db.listProjectReports('scope-proj-b')).length === 0)
    ok('自由对话会话跨项目可见', (await store.listFreeSessions()).some(x => x.id === free.id))
    ok('角色卡跨项目可见', (await store.listFreeChars()).some(x => x.id === fc.id))
    ok('控制面板设置跨项目生效', (await getTavernSettings()).common.timeoutSec === 123)

    db.setCurrentProject('scope-proj-a')
    ok('切回原项目又能看到自己的推演', (await store.listSessions()).some(x => x.id === plot.id))
    ok('推演报告也能重新看到', (await db.listProjectReports('scope-proj-a')).length === 1)
  }

  // ---------- 9) 消息级操作：编辑 / 隐藏 / 删除 / 末条识别（老大全接受的 A1） ----------
  {
    __resetMockStores()
    const ch = await store.createFreeChar({ ...store.emptyFreeCharacter(), name: '操作测试' })
    const s = await store.saveFreeSession({
      ...(await store.createFreeSession([ch.id], '操作测试场', { providerId: '' }, {})),
      messages: [
        { id: 'u1', role: 'user', content: '第一句', at: 1 },
        { id: 'a1', role: 'assistant', content: '第一答', at: 2 },
        { id: 'u2', role: 'user', content: '第二句', at: 3 },
        { id: 'a2', role: 'assistant', content: '第二答', at: 4 },
      ],
    })

    ok('末条 AI 回复的 id 能取到（只有它可重说）', store.lastAssistantId(s.messages) === 'a2')
    ok('没有 AI 回复时返回空串',
      store.lastAssistantId([{ id: 'u', role: 'user', content: 'x', at: 1 }]) === '')

    const edited = store.patchMessage(s, 'u1', { content: '改过的第一句', edited: true })
    ok('编辑：只动目标那条、标上 edited、**原会话对象不被改**',
      edited.messages[0].content === '改过的第一句' && edited.messages[0].edited === true &&
      s.messages[0].content === '第一句' && edited.messages.length === 4)

    const hid = store.toggleMessageHidden(s, 'a1')
    ok('隐藏：翻 hidden 标记', hid.messages[1].hidden === true)
    ok('取消隐藏：再翻一次', !store.toggleMessageHidden(hid, 'a1').messages[1].hidden)

    const dropped = store.dropMessage(s, 'a1')
    ok('删除：只移走那一条，其余保持顺序',
      dropped.messages.length === 3 && dropped.messages.map(m => m.id).join(',') === 'u1,u2,a2')

    const saved = await store.saveFreeSession(hid)
    const back = await store.getFreeSession(saved.id)
    ok('隐藏标记能落库读回（不是只活在内存里）', back?.messages[1].hidden === true)
  }

  console.log(`\ntavernStore: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
