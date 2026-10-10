// ============ 跑团互动 · 线索板与同伴（3.0 · W4-3c）============
//
// 两组断言：
//   ① **线索**：去重（归一化）、未获/已获两态、revealClue 只管「已埋未获」那一条；
//   ② **同伴知晓边界**（本项目独门「知情权限」）：双向包含匹配、auditKnowsLeak 能揪出越界。
import { __resetMockStores } from './mock-memory'
import {
  acquireClue, plantClue, acquiredClues, pendingClues, acquiredClueIds, revealClue, dropClue, clueStats,
  addCompanion, dropCompanion, updateCompanion, companionKnows, whoKnows, auditKnowsLeak, helpfulCompanions,
} from '../src/lib/run/clues'
import { newRun } from '../src/lib/run/store'
import type { RunSession, RunCompanion } from '../src/lib/run/runTypes'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const MODEL = { providerId: 'ollama' }
const comp = (charId: string, name: string, knows: string[], canHelp = false): RunCompanion =>
  ({ charId, name, stance: '', knows, canHelp })

async function main() {
  __resetMockStores()

  // ---------- 1) 线索：入板与去重 ----------
  {
    let s: RunSession = newRun('线索局', MODEL)
    const r1 = acquireClue(s, { text: '钟声停了', source: '观察' })
    ok('入板一条', !!r1.clue && !r1.duplicated)
    ok('来源被记下', r1.clue!.source === '观察')
    s = r1.session

    const r2 = acquireClue(s, { text: '  钟声 停了  ', source: '交谈' })
    ok('🔴 归一化去重（空白差异算同一条）', r2.duplicated === true, String(r2.duplicated))
    ok('重复时不新增', r2.session.clues.length === 1)
    ok('重复时返回已存在那条', r2.clue!.id === r1.clue!.id)
    s = r2.session

    const r3 = acquireClue(s, { text: '   ', source: '取证' })
    ok('空文本被忽略（clue=null）', r3.clue === null && r3.session.clues.length === 1)

    const r4 = acquireClue(s, { text: '码头有血', linksSecretId: 'sec1' })
    ok('可关联秘密', r4.clue!.linksSecretId === 'sec1')
    ok('默认来源为其他', r4.clue!.source === '其他')
    s = r4.session

    ok('已获线索 2 条', acquiredClues(s).length === 2)
    ok('acquiredClueIds 与之一致', acquiredClueIds(s).length === 2)
    ok('clueStats 口径', JSON.stringify(clueStats(s)) === JSON.stringify({ acquired: 2, total: 2 }))
  }

  // ---------- 2) 埋点 / 揭露 / 删除 ----------
  {
    let s: RunSession = newRun('埋点局', MODEL)
    s = plantClue(s, { text: '墙上的划痕', source: '观察' })
    ok('埋了一条未获线索', s.clues.length === 1 && s.clues[0].acquired === false)
    ok('未获不计入已获', acquiredClues(s).length === 0 && pendingClues(s).length === 1)

    s = plantClue(s, { text: '墙上的划痕' })
    ok('同一文案不重复埋', s.clues.length === 1, String(s.clues.length))

    const id = s.clues[0].id
    s = revealClue(s, id)
    ok('revealClue 把它置为已获', acquiredClues(s).length === 1)

    // 🔴 回归：重复文本命中「已埋未获」的那条 ⇒ 应当**置为已获**（不是当纯重复丢掉）
    {
      let t: RunSession = newRun('埋点回归', MODEL)
      t = plantClue(t, { text: '地上的水渍', source: '观察' })
      const r = acquireClue(t, { text: '  地上的水渍  ', source: '观察' })
      ok('🔴 命中已埋线索时置为已获', r.duplicated === false && t.clues[0].acquired === false && r.session.clues[0].acquired === true)
      const dup = acquireClue(r.session, { text: '地上的水渍' })
      ok('再拿同一条（已获）才算重复', dup.duplicated === true)
    }

    const again = revealClue(s, id)
    ok('已获再 reveal 原样返回（对象不变）', again === s)

    ok('reveal 不存在的 id 原样返回', revealClue(s, 'nope') === s)

    const dropped = dropClue(s, id)
    ok('删除线索', dropped.clues.length === 0)
  }

  // ---------- 3) 同伴：增删改与去重 ----------
  {
    let s: RunSession = newRun('同伴局', MODEL)
    s = addCompanion(s, { charId: 'c1', name: '阿岚', stance: '欠你一条命', knows: ['码头的事', '  '], canHelp: true })
    ok('添加同伴', s.companions.length === 1)
    ok('知晓里的空白项被清掉', s.companions[0].knows.length === 1 && s.companions[0].knows[0] === '码头的事')

    s = addCompanion(s, { charId: 'c1', name: '阿岚（重复）' })
    ok('同 charId 不重复入列', s.companions.length === 1)

    s = addCompanion(s, { charId: '', name: '无名' })
    ok('空 charId 被拒', s.companions.length === 1)

    s = addCompanion(s, { charId: 'c2', name: '   ' })
    ok('名字空白回落「同伴」', s.companions[1].name === '同伴', s.companions[1].name)

    s = updateCompanion(s, 'c1', { canHelp: false, stance: '反目' })
    ok('updateCompanion 生效', s.companions[0].canHelp === false && s.companions[0].stance === '反目')
    ok('update 不存在的 charId 原样返回', updateCompanion(s, 'cX', { canHelp: true }) === s)

    ok('能搭把手 = 过滤 canHelp', helpfulCompanions(s.companions).length === 0)

    const dropped = dropCompanion(s, 'c1')
    ok('删除同伴', dropped.companions.length === 1 && dropped.companions[0].charId === 'c2')
  }

  // ---------- 4) 知晓边界（知情权限）----------
  {
    const c = comp('c1', '阿岚', ['码头的事'])
    ok('精确知晓 → true', companionKnows(c, '码头的事'))
    ok('🔴 知晓写得宽、话题更短 → 仍算知道（知晓条目 ⊇ 话题）', companionKnows(c, '码头'))
    ok('🔴 知晓写得短、话题更长 → 也算知道（话题 ⊇ 知晓条目）', companionKnows(comp('x', 'X', ['码头']), '码头第三根桩'))
    ok('无关话题 → false', !companionKnows(c, '钟楼的地下室'))
    ok('空白话题 → false', !companionKnows(c, '   '))
    ok('知晓为空的同伴什么都不知道', !companionKnows(comp('y', 'Y', []), '任何事'))

    const cast = [comp('c1', '阿岚', ['码头的事']), comp('c2', '老周', ['钟楼'])]
    ok('whoKnows 只挑知晓者', whoKnows(cast, '码头的事').map(x => x.name).join() === '阿岚')
    ok('无人知晓 → 空', whoKnows(cast, '有人偷偷改了账本').length === 0)
  }

   // ---------- 5) 越界审计 ----------
  {
    const cast = [comp('c1', '阿岚', ['码头的事']), comp('c2', '老周', [])]
    const text = '阿岚提起码头的事，老周也凑过来聊码头的事，两人还说了钟楼。'
    const leaks = auditKnowsLeak(cast, text, ['码头的事', '钟楼', '灯塔'])
    ok('揪出不知晓却参与话题的同伴', leaks.some(l => l.name === '老周' && l.topic === '码头的事'))
    ok('知晓者在自己知道的话题上不算越界', !leaks.some(l => l.name === '阿岚' && l.topic === '码头的事'), JSON.stringify(leaks))
    ok('🔴 文本里没提的话题不算（灯塔没出现）', !leaks.some(l => l.topic === '灯塔'), JSON.stringify(leaks))
    ok('老周对「钟楼」也越界（文本提到、他不知晓）', leaks.some(l => l.name === '老周' && l.topic === '钟楼'))

    ok('空文本 → 无越界', auditKnowsLeak(cast, '', ['码头的事']).length === 0)
    ok('无同伴 → 无越界', auditKnowsLeak([], text, ['码头的事']).length === 0)
  }

  console.log(`\nrunClues: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
