// ============ 跑团互动 · 存储与存档（3.0 · W4-3a）============
//
// 跑团局是「有始有终的互动」 ⇒ 断言锁四件事：
//   ① **随项目**（D1=A）：切项目读不到（这正是「一局属于某本书」的直接体现）；
//   ② 索引与分条**成对读写**：列表有的、点开就有；删了不留幽灵条目；
//   ③ **存档能截回完整状态**：不只是消息，行动流水 / 线索 / 秘密 / 结局都要回去；
//   ④ 检查点快照**不可变**：打点后继续玩，已存的档一个字节都不动。
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import {
  listRuns, getRun, saveRun, deleteRun, renameRun, newRun,
  addRunCheckpoint, dropRunCheckpoint, rollbackRunToCheckpoint, undoRunRollback,
  type RunSessionWithUndo,
} from '../src/lib/run/store'
import type { RunClue } from '../src/lib/run/runTypes'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const MODEL = { providerId: 'ollama' }

const clue = (id: string, text: string, acquired = true): RunClue =>
  ({ id, text, source: '取证', acquired, at: 1 })

async function main() {
  // ---------- 1) 新建 + 落库（索引与分条成对）----------
  {
    __resetMockStores()
    db.setCurrentProject('p1')
    const s = newRun('雾港开局', MODEL)
    ok('新建给 id 与 schema', !!s.id && s.schema === 1)
    ok('空局面：无线索 / 无同伴 / 无结局', s.clues.length === 0 && s.companions.length === 0 && s.endings.length === 0)
    ok('变量初值已就位', !!s.vars && typeof s.vars === 'object')

    const saved = await saveRun(s)
    ok('保存回填 updatedAt', saved.updatedAt > 0)

    const listed = await listRuns()
    ok('列表能读到（索引写成功）', listed.some(x => x.id === s.id))
    const back = await getRun(s.id)
    ok('分条能点开（不是幽灵条目）', !!back && back.title === '雾港开局')
  }

  // ---------- 2) 索引摘要 ----------
  {
    __resetMockStores()
    db.setCurrentProject('p1')
    const s = newRun('摘要局', MODEL)
    s.worldRef = { worldId: 'w1', version: 2, worldName: '雾港' }
    s.companions = [
      { charId: 'c1', name: '阿岚', stance: '同伴', knows: [], canHelp: true },
      { charId: 'c2', name: '老周', stance: '向导', knows: [], canHelp: false },
    ]
    s.clues = [clue('k1', '钟声停了'), clue('k2', '码头有血'), clue('k3', '未到手', false)]
    s.endings = [{ id: 'e1', name: '真结局', condition: {}, reached: true }]
    await saveRun(s)

    const [it] = await listRuns()
    ok('同伴摘要「A、B」', it.companionBrief === '阿岚、老周', it.companionBrief)
    ok('线索数只算已获（2/3）', it.clueCount === 2, String(it.clueCount))
    ok('世界引用摘要「雾港 v2」', it.worldBrief === '雾港 v2', String(it.worldBrief))
    ok('已达成结局写进索引', it.reachedEnding === '真结局', String(it.reachedEnding))
  }

  // ---------- 3) 覆盖保存不重复入索引 ----------
  {
    __resetMockStores()
    db.setCurrentProject('p1')
    const s = newRun('覆盖局', MODEL)
    await saveRun(s)
    await saveRun({ ...s, title: '覆盖局（改名）' })
    const listed = await listRuns()
    ok('同一 id 只占一条索引', listed.filter(x => x.id === s.id).length === 1)
    ok('标题已更新', (await getRun(s.id))?.title === '覆盖局（改名）')

    await renameRun(s.id, '  重命名后  ')
    ok('renameRun 去首尾空格', (await getRun(s.id))?.title === '重命名后', String((await getRun(s.id))?.title))
    await renameRun(s.id, '   ')
    ok('空白标题不覆盖原值', (await getRun(s.id))?.title === '重命名后')
  }

  // ---------- 4) 删除：索引移除 + 分条置空 ----------
  {
    __resetMockStores()
    db.setCurrentProject('p1')
    const s = newRun('待删局', MODEL)
    await saveRun(s)
    await deleteRun(s.id)
    ok('索引里已没有它', !(await listRuns()).some(x => x.id === s.id))
    ok('分条读回 null（置空）', (await getRun(s.id)) === null)
  }

  // ---------- 5) 随项目（D1=A）----------
  {
    __resetMockStores()
    db.setCurrentProject('p1')
    const s = newRun('p1 的局', MODEL)
    await saveRun(s)
    ok('p1 读得到', !!(await getRun(s.id)))

    db.setCurrentProject('p2')
    ok('🔴 换项目读不到（跑团局随项目走）', (await getRun(s.id)) === null)
    ok('🔴 p2 的列表是空的', (await listRuns()).length === 0)

    db.setCurrentProject('p1')
    ok('切回 p1 又读得到', !!(await getRun(s.id)))
  }

  // ---------- 6) 检查点：截回完整状态 ----------
  {
    __resetMockStores()
    db.setCurrentProject('p1')
    let s: RunSessionWithUndo = newRun('存档局', MODEL)
    s.messages = [{ id: 'm1', role: 'assistant', content: '开场', at: 1 }]
    s.actions = [{ id: 'a1', at: 1, text: '观察四周', kind: '观察' }]
    s.clues = [clue('k1', '钟声停了')]
    s = addRunCheckpoint(s, '序章')

    // 继续玩：加消息 / 行动 / 线索 / 揭秘密 / 达成结局
    s = {
      ...s,
      messages: [...s.messages, { id: 'm2', role: 'assistant', content: '第二幕', at: 2 }],
      actions: [...s.actions, { id: 'a2', at: 2, text: '交谈', kind: '交谈' }],
      clues: [...s.clues, clue('k2', '码头有血')],
      secrets: [{ id: 's1', text: '真相', unlocked: true }],
      endings: [{ id: 'e1', name: '真结局', condition: {}, reached: true }],
    }

    const undone = rollbackRunToCheckpoint(s, s.checkpoints![0].id)
    ok('回滚成功', !!undone)
    ok('消息截回 1 条', !!undone && undone.messages.length === 1)
    ok('🔴 行动流水一并截回', !!undone && undone.actions.length === 1, String(undone?.actions.length))
    ok('🔴 线索回到那一刻', !!undone && undone.clues.length === 1 && undone.clues[0].id === 'k1')
    ok('🔴 秘密 / 结局也回到那一刻', !!undone && undone.secrets.length === 0 && undone.endings.length === 0)
    ok('留下撤销快照', !!undone?.undoSnapshot)

    const redone = undoRunRollback(undone!)
    ok('撤销回滚恢复全部进度', redone.messages.length === 2 && redone.actions.length === 2 && redone.clues.length === 2
      && redone.secrets.length === 1 && redone.endings.length === 1, `msg=${redone.messages.length}`)
    ok('撤销后快照清空', redone.undoSnapshot === undefined)
  }

  // ---------- 7) 检查点快照不可变 ----------
  {
    __resetMockStores()
    db.setCurrentProject('p1')
    let s: RunSessionWithUndo = newRun('不可变', MODEL)
    s.clues = [clue('k1', '原始线索')]
    s.secrets = [{ id: 's1', text: '原始秘密', unlocked: false, revealOn: { clueIds: ['k1'] } }]
    s = addRunCheckpoint(s, '打点')

    // 之后改动线索与秘密（浅拷贝陷阱：若快照共享引用，这里会污染已存的档）
    s.clues[0].text = '被改过'
    s.secrets[0].revealOn!.clueIds!.push('kX')

    const snap = rollbackRunToCheckpoint(s, s.checkpoints![0].id)!
    ok('🔴 快照里的线索文本不受后续改动影响', snap.clues[0].text === '原始线索', snap.clues[0].text)
    ok('🔴 快照里的秘密条件不受后续 push 影响', snap.secrets[0].revealOn!.clueIds!.length === 1, JSON.stringify(snap.secrets[0].revealOn!.clueIds))

    const missing = rollbackRunToCheckpoint(s, 'no-such-cp')
    ok('存档不存在返回 null', missing === null)

    const dropped = dropRunCheckpoint(s, s.checkpoints![0].id)
    ok('dropRunCheckpoint 移除该档', (dropped.checkpoints ?? []).length === 0)
  }

  console.log(`\nrunStore: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
