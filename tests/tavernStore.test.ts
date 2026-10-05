// ============ 酒馆模式 · 存储封装（P0 验收：索引与分条成对、读写不抛错）============
//
// 这组断言盯的是方案 §11.8 那条风险：**索引与分条不同步 → 幽灵条目**
// （列表里看得见、点开是空的）。所有增删改都必须成对，本测试逐个验证。
import * as db from '../src/lib/db'
import * as store from '../src/lib/tavern/store'
import { __resetMockStores } from './mock-memory'
import { getTavernSettings, saveTavernSettings } from '../src/lib/tavern/settings'
import type { TavernSession, TavernSessionIndexItem, TavernReport, TavernMessage } from '../src/lib/tavern/types'
import { MAX_AI_CAST, MAX_CAST_SLOTS } from '../src/lib/tavern/types'

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

    // 🔴 截断口径**不许写死数字** —— 用单一真源 `MAX_AI_CAST`：
    //    写死 3 的话，改了上限这条测试还会绿（尺子失准，正是本轮修掉的那类问题）。
    const many = store.planFreeSessionCast(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'], 'c1', id => id)
    ok('超过 AI 名额上限只取前 N（与界面同源，不再是写死的 3）',
      many.charIds.length === MAX_AI_CAST, `${many.charIds.length} vs MAX_AI_CAST=${MAX_AI_CAST}`)
    ok('🔴 没到上限时一个不少（截断不是"总是截 3"）',
      store.planFreeSessionCast(['c1', 'c2', 'c3', 'c4'], 'c1', id => id).charIds.length === 4)

    const unknown = store.planFreeSessionCast(['zz'], 'zz', () => undefined)
    ok('角色名取不到时不崩（退化为 ?）', unknown.title === '和?的对话', unknown.title)
  }

  // ---------- 同场角色数量上限：单一真源（2026-10-05 由 3 提到 6） ----------
  //
  // 这一节钉「两个常量之间的关系」，**不钉具体数字**（数字会变、关系不该变）：
  // 界面槽位上限、`planFreeSessionCast` 的截断都必须读同一对常量 ——
  // 任何一处再写死一个数字，就是「静默丢角色」的起点（本轮修掉的正是这种）。
  {
    ok('🔴 AI 名额 ≤ 位置总数（否则位置还没用满，AI 就先被截了）',
      MAX_AI_CAST <= MAX_CAST_SLOTS, `${MAX_AI_CAST} vs ${MAX_CAST_SLOTS}`)
    ok('🔴 位置总数至少留得出「AI 全满 + 一个我演」',
      MAX_CAST_SLOTS >= MAX_AI_CAST + 1, `${MAX_CAST_SLOTS} vs ${MAX_AI_CAST}+1`)
    ok('上限已放宽（本轮 3 → 6；再调请同步这条与两处界面文案）', MAX_AI_CAST === 6, String(MAX_AI_CAST))
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

  // ---------- 分支 / 检查点 / 回滚（2026-09-14，路线图第 3 批） ----------
  {
    __resetMockStores()
    db.setCurrentProject(PID)
    const msg = (n: number, role: 'user' | 'assistant'): TavernMessage =>
      ({ id: `m${n}`, role, content: `第 ${n} 条`, at: n })
    const base = await store.createSession({
      ...mkSession('山门夜谈'),
      messages: [msg(1, 'user'), msg(2, 'assistant'), msg(3, 'user'), msg(4, 'assistant'), msg(5, 'user'), msg(6, 'assistant')],
    })

    // ---- 检查点：连记忆一起存 ----
    const s1 = await store.saveSession({
      ...base,
      watermark: { messageId: 'm4', at: 40 },
      memory: '一、长期摘要：到第 4 条为止的事',
    })
    const s2 = store.addCheckpoint(s1, '分手前')
    ok('存检查点：记下消息条数', s2.checkpoints?.length === 1 && s2.checkpoints[0].messageCount === 6,
      String(s2.checkpoints?.[0]?.messageCount))
    ok('存检查点：名字与时间都在', s2.checkpoints?.[0].label === '分手前' && !!s2.checkpoints[0].at)
    ok('🔴 存检查点：**记忆一起存**（只拨水位线救不回记忆）',
      s2.checkpoints?.[0].memory === '一、长期摘要：到第 4 条为止的事')
    ok('存检查点：水位线一起存', s2.checkpoints?.[0].watermark?.messageId === 'm4')

    // 之后又聊了两条、记忆被更新（模拟"聊过头了，想退回去"）
    const s3 = await store.saveSession({
      ...s2,
      messages: [...s2.messages, msg(7, 'user'), msg(8, 'assistant')],
      watermark: { messageId: 'm8', at: 80 },
      memory: '一、长期摘要：到第 8 条为止的事',
    })

    // ---- 回滚：截回消息 + 还原记忆与水位线 + 留一层可撤销 ----
    const cpId = s3.checkpoints![0].id
    const back = store.rollbackToCheckpoint(s3, cpId)!
    ok('🔴 回滚：消息截回检查点那一刻', back.messages.length === 6 && back.messages[5].id === 'm6',
      String(back.messages.length))
    ok('🔴 回滚：记忆一并还原（只截消息不还原记忆，Ta 会记得被删掉的未来）',
      back.memory === '一、长期摘要：到第 4 条为止的事')
    ok('回滚：水位线一并还原', back.watermark?.messageId === 'm4')
    ok('回滚：检查点本身还在（同一个点可以反复回）', back.checkpoints?.length === 1)
    ok('🔴 回滚：写入了撤销快照（所以这一步是可逆的）',
      back.undoSnapshot?.messages.length === 8 && back.undoSnapshot?.memory === '一、长期摘要：到第 8 条为止的事')

    // ---- 撤销回滚 ----
    const undone = store.undoRollback(back)
    ok('🔴 撤销回滚：消息回到回滚前', undone.messages.length === 8 && undone.messages[7].id === 'm8')
    ok('撤销回滚：记忆也回到回滚前', undone.memory === '一、长期摘要：到第 8 条为止的事')
    ok('撤销回滚：快照被清掉（只留一层，不做无限套娃）', undone.undoSnapshot === undefined)
    ok('撤销回滚：没有快照时原样返回（不炸）', store.undoRollback(undone) === undone)

    ok('删检查点', (store.dropCheckpoint(s3, cpId).checkpoints ?? []).length === 0)
    ok('回滚到不存在的检查点 → null（调用方好判断）', store.rollbackToCheckpoint(s3, 'nope') === null)
  }

  // ---------- 分支树视图：父子推断（S1a，2026-10-05） ----------
  //
  // 这一节钉住「**不存 parentId**、父子完全由 ` ·分支N` 后缀反推」这条约定 ——
  // 它与 `branchTitle` 是一对：命名约定改了而这里没跟着改，左栏会**静默**失去分组
  // （不报错、只是看着「就是没有分支」），所以必须两处一起被断言看住。
  {
    const item = (id: string, title: string, updatedAt = 0): TavernSessionIndexItem =>
      ({ id, title, mode: 'immersive', castBrief: '', anchorTitle: '', updatedAt })

    const list = [
      item('a', '山门夜谈'),
      item('b1', '山门夜谈 ·分支2'),
      item('b2', '山门夜谈 ·分支3'),
      item('c', '海边别院'),
    ]

    // ① 平铺：与加这个功能之前**逐行一致**（老行为零漂移，这是开关关掉时的契约）
    const flat = store.groupSessionsByBranch(list, false)
    ok('🔴 平铺模式：顺序与输入逐行一致、全部 depth=0（老行为零漂移）',
      flat.map(r => r.s.id).join(',') === 'a,b1,b2,c' && flat.every(r => r.depth === 0),
      flat.map(r => r.s.id).join(','))

    // ② 树形：根后面紧跟它自己的分支
    const tree = store.groupSessionsByBranch(list, true)
    ok('🔴 树形：根场次后面紧跟它的分支',
      tree.map(r => r.s.id).join(',') === 'a,b1,b2,c', tree.map(r => r.s.id).join(','))
    ok('树形：根 depth=0、分支 depth=1',
      tree.map(r => r.depth).join(',') === '0,1,1,0', tree.map(r => r.depth).join(','))
    ok('树形：行数守恒（不多不少，一个场次一行）', tree.length === list.length)

    // ②b 输入乱序也能归位（分支排在根前面时，树形要把它挪到根后面）
    const shuffled = store.groupSessionsByBranch(
      [item('b1', '山门夜谈 ·分支2'), item('a', '山门夜谈'), item('c', '海边别院')], true)
    ok('🔴 输入乱序也能归位：分支被挪到它的根后面',
      shuffled.map(r => r.s.id).join(',') === 'a,b1,c', shuffled.map(r => r.s.id).join(','))

    // ③ 同级按**数字**排序（·分支2 要在 ·分支10 前面 —— 别用字符串序）
    const manyTree = store.groupSessionsByBranch([
      item('a', '山门夜谈'), item('x10', '山门夜谈 ·分支10'), item('x2', '山门夜谈 ·分支2'),
    ], true)
    ok('🔴 同级按分支号**数字**排序（·分支2 在 ·分支10 前）',
      manyTree.map(r => r.s.id).join(',') === 'a,x2,x10', manyTree.map(r => r.s.id).join(','))

    // ④ 🔴 孤儿分支：父不在列表里（被筛选词滤掉 / 根已删）**仍要显示**，否则「一筛选分支就失踪」
    const orphan = store.groupSessionsByBranch([item('b1', '山门夜谈 ·分支2')], true)
    ok('🔴 孤儿分支仍然返回、并标 missingParent（父不在列表也别丢数据）',
      orphan.length === 1 && orphan[0].s.id === 'b1' && orphan[0].missingParent === true,
      JSON.stringify(orphan.map(r => ({ id: r.s.id, mp: r.missingParent }))))
    ok('正常分支的 missingParent 为 false（只在父缺席时才标）', tree[1].missingParent === false)

    // ⑤ 🔴「分支的分支」仍落在同一个根上 ⇒ 树**不可能出现三级**（branchTitle 先剥后缀再编号）
    const nested = store.branchTitle('山门夜谈 ·分支2', ['山门夜谈', '山门夜谈 ·分支2'])
    ok('🔴 对分支再分支 ⇒ 得到同根的新分支（·分支3），不会出现三级',
      nested === '山门夜谈 ·分支3', nested)

    // ⑥ 与 branchTitle 的**往返**：真产出的标题必须能被认出来（两处共用 BRANCH_SUFFIX 单一真源）
    const t2 = store.branchTitle('海边别院', ['海边别院'])
    ok('🔴 branchTitle 产出的标题能被 isBranchTitle/branchNoOf 认出（正则单一真源）',
      store.isBranchTitle(t2) && store.branchNoOf(t2) === 2, t2)
    ok('非分支标题不被误认', !store.isBranchTitle('海边别院') && store.branchNoOf('海边别院') === 0)
    ok('标题中段的「分支」字样不算分支（只在结尾才算）', !store.isBranchTitle('分支机构的夜谈'))
  }

  // ---------- 分支：水位线重算（这批最容易埋雷的地方） ----------
  {
    __resetMockStores()
    db.setCurrentProject(PID)
    const msg = (n: number, role: 'user' | 'assistant'): TavernMessage =>
      ({ id: `m${n}`, role, content: `第 ${n} 条`, at: n })
    const messages = [msg(1, 'user'), msg(2, 'assistant'), msg(3, 'user'), msg(4, 'assistant'), msg(5, 'user'), msg(6, 'assistant')]
    const s = await store.createSession({ ...mkSession('原推演'), messages })

    // ① 水位线落在分叉点之内 → 原样保留（记忆与它一致，没有"未来"）
    const a = store.branchSession({ ...s, watermark: { messageId: 'm2', at: 20 }, memory: '到第 2 条为止' }, 'm4', ['原推演'])
    ok('分支：截到指定那一条（含）', a?.messages.length === 4 && a?.messages[3].id === 'm4', String(a?.messages.length))
    ok('分支：换新 id、改名，**原会话一个字不动**',
      !!a && a.id !== s.id && a.title === '原推演 ·分支2' && s.messages.length === 6 && s.title === '原推演')
    ok('分支：水位线在分支内 → 原样保留', a?.watermark?.messageId === 'm2')
    ok('分支：记忆原样带过来', a?.memory === '到第 2 条为止')

    // ② 水位线在分叉点**之后** → 退到分支末尾 + 清空记忆
    const b = store.branchSession({ ...s, watermark: { messageId: 'm6', at: 60 }, memory: '到第 6 条为止（含未来）' }, 'm4', ['原推演'])
    ok('🔴 分支：水位线在分叉点之后 → 退到分支末尾', b?.watermark?.messageId === 'm4', String(b?.watermark?.messageId))
    ok('🔴 分支：同时清空本场记忆（只退水位线会让模型引用被截掉的未来）', b?.memory === undefined)

    // ③ 从没整理过 → 什么都不用动
    const c = store.branchSession(s, 'm3', [])
    ok('分支：没有水位线时不动它', c?.watermark === undefined && c?.messages.length === 3)

    // ④ 分支名避重与剥后缀
    ok('分支名避重：·分支2 已被占用就跳到 ·分支3',
      store.branchTitle('原推演', ['原推演 ·分支2']) === '原推演 ·分支3',
      store.branchTitle('原推演', ['原推演 ·分支2']))
    ok('分支名避重：已带后缀的标题先剥掉（不会出现 ·分支2 ·分支2）',
      store.branchTitle('原推演 ·分支2', ['原推演 ·分支2']) === '原推演 ·分支3',
      store.branchTitle('原推演 ·分支2', ['原推演 ·分支2']))

    // ⑤ 边界：找不到那一条 / 检查点只带得过分支点之前的 / 不带撤销快照
    ok('分支：找不到那一条 → null', store.branchSession(s, '不存在') === null)
    const withCps = {
      ...s,
      checkpoints: [
        { id: 'cp1', label: '早', messageCount: 2, at: 1 },
        { id: 'cp2', label: '晚', messageCount: 6, at: 2 },
      ],
    }
    ok('分支：只带得过分支点之前的检查点',
      (store.branchSession(withCps, 'm4', [])?.checkpoints ?? []).map(x => x.id).join(',') === 'cp1')
    ok('分支：不继承撤销快照（那是另一条时间线的东西）',
      store.branchSession({ ...s, undoSnapshot: { messages: [], at: 1 } }, 'm3', [])?.undoSnapshot === undefined)

    // ⑥ 落库往返：checkpoints 能存能读
    __resetMockStores()
    db.setCurrentProject(PID)
    const saved = await store.saveSession(store.addCheckpoint(await store.createSession({ ...mkSession('落库'), messages }), '存一下'))
    const read = await store.getSession(saved.id)
    ok('检查点能落库读回', read?.checkpoints?.length === 1 && read?.checkpoints[0].label === '存一下')
  }

  // ---------- 7) 重说后的记忆回滚（审计 2026-09-17 P1-3） ----------
  // 场景：作者先「整理本场记忆」（水位线推到末尾那条），再对同一条点重说 ——
  // 那条回复被换成新的（新 id），而记忆里还留着它 → 不清就会出现「Ta 记得还没发生的事」。
  {
    const mk = (msgs: TavernMessage[], wm: string, mem?: string) => ({
      ...mkSession('重说'), id: 's-rr', messages: msgs,
      watermark: { messageId: wm, at: 1 }, memory: mem,
      createdAt: 1, updatedAt: 1,
    }) as unknown as TavernSession
    const msgs: TavernMessage[] = [
      { id: 'm1', role: 'user', content: 'a', at: 1 },
      { id: 'm2', role: 'assistant', content: 'b', at: 2 },
      { id: 'm3new', role: 'assistant', content: 'c2', at: 4 }, // 重说后的新回复（新 id）
    ]
    const r = store.rewindAfterReroll(mk(msgs, 'm3', 'Ta 记得 m3 的事'), 'm3')
    ok('重说替换掉水位线所指的回复 → 清本场记忆', r.memory === undefined)
    ok('重说 → 水位线退到当前末尾（新回复）', r.watermark?.messageId === 'm3new')
    const keep = store.rewindAfterReroll(mk(msgs, 'm2', '早前记忆'), 'm3')
    ok('水位线指着更早的消息 → 记忆原样不动（保守）',
      keep.memory === '早前记忆' && keep.watermark?.messageId === 'm2')
    const none = store.rewindAfterReroll(mk(msgs, 'm3', '记忆'), undefined)
    ok('取消 / 空回复（未真替换，droppedId 为空）→ 原样返回', none.memory === '记忆')
  }

  console.log(`\ntavernStore: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
