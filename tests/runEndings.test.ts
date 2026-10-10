// ============ 跑团互动 · 秘密与结局（3.0 · W4-3d）============
//
// D3=A 的可复现性全靠这里：
//   ① **秘密**两条解锁路径（派生 OR 条件 / KP 显式揭示），幂等；
//   ② **结局 Tier** 达成 / 接近 / 未启 + missing 清单；⚠️ 空条件判未启（不是自动达成）；
//   ③ varMin 数值档位参与判定。
import { __resetMockStores } from './mock-memory'
import {
  hasFlag, addFlag, removeFlag,
  secretUnlockable, checkSecretUnlock, unlockSecretById, lockedSecrets, unlockedSecrets,
  evalEnding, evalEndings, reachedEndings, applyEndings,
} from '../src/lib/run/endings'
import { newRun } from '../src/lib/run/store'
import type { RunSession, RunSecret, RunEnding } from '../src/lib/run/runTypes'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const MODEL = { providerId: 'ollama' }
const clue = (id: string, acquired = true) => ({ id, text: `线索${id}`, source: '取证' as const, acquired, at: 1 })
const varsOf = (v: { trust?: number; affection?: number }): RunSession['vars'] =>
  ({ values: v, turnSeq: 0, log: [] })

async function main() {
  __resetMockStores()

  // ---------- 1) 剧情 flag ----------
  {
    let s: RunSession = newRun('flag局', MODEL)
    ok('初始无 flag', !hasFlag(s, '通缉'))
    s = addFlag(s, '通缉')
    ok('加 flag 后 hasFlag 为真', hasFlag(s, '通缉'))
    ok('addFlag 幂等（对象不变）', addFlag(s, '通缉') === s)
    ok('空白 flag 被拒', addFlag(s, '   ') === s)
    s = removeFlag(s, '通缉')
    ok('移除 flag', !hasFlag(s, '通缉'))
    ok('移除不存在 flag 原样返回', removeFlag(s, '不存在') === s)
  }

  // ---------- 2) 秘密：派生解锁 ----------
  {
    let s: RunSession = newRun('秘密局', MODEL)
    const secClue: RunSecret = { id: 's1', text: '守钟人的身份', unlocked: false, revealOn: { clueIds: ['k1', 'k2'] } }
    const secFlag: RunSecret = { id: 's2', text: '船长的交易', unlocked: false, revealOn: { flags: ['见到船长'] } }
    const secNoCond: RunSecret = { id: 's3', text: '无从查证的传闻', unlocked: false }
    s = { ...s, secrets: [secClue, secFlag, secNoCond], clues: [clue('k1'), clue('k2', false)] }

    ok('未声明条件 → 不派生解锁', !secretUnlockable(s, secNoCond))
    ok('🔴 clueIds 命中任一即解锁（k1 已获）', secretUnlockable(s, secClue))
    ok('未获的线索不算（k2 未获）', s.clues.find(c => c.id === 'k2')!.acquired === false)
    ok('flag 未加 → 不解锁', !secretUnlockable(s, secFlag))

    s = addFlag(s, '见到船长')
    ok('加 flag 后可解锁', secretUnlockable(s, secFlag))

    const r = checkSecretUnlock(s)
    ok('结算揭露了两条', r.unlocked.length === 2, String(r.unlocked.length))
    ok('无条件的秘密仍锁着', lockedSecrets(r.session).map(x => x.id).join() === 's3')
    ok('已揭两条', unlockedSecrets(r.session).length === 2)

    const again = checkSecretUnlock(r.session)
    ok('🔴 幂等：再结算不重复揭露', again.unlocked.length === 0)
    ok('幂等时原对象返回', again.session === r.session)
  }

  // ---------- 3) 秘密：显式揭示 ----------
  {
    let s: RunSession = newRun('显式局', MODEL)
    s = { ...s, secrets: [{ id: 's1', text: '真相', unlocked: false }] }
    s = unlockSecretById(s, 's1')
    ok('显式揭示生效', unlockedSecrets(s).length === 1)
    ok('已揭再显式揭示原样返回', unlockSecretById(s, 's1') === s)
    ok('揭示不存在的 id 原样返回', unlockSecretById(s, 'nope') === s)
  }

  // ---------- 4) 结局 Tier + missing ----------
  {
    const s: RunSession = {
      ...newRun('结局局', MODEL),
      clues: [clue('k1'), clue('k2', false)],
      secrets: [{ id: 's1', text: '真相', unlocked: true }, { id: 's2', text: '暗账', unlocked: false }],
      vars: varsOf({ trust: 30 }),
    }

    // 空条件 → 未启（不是达成）
    const e0: RunEnding = { id: 'e0', name: '未定结局', condition: {}, reached: false }
    const r0 = evalEnding(s, e0)
    ok('🔴 空条件判未启（防一开局自动达成）', r0.tier === '未启', r0.tier)
    ok('空条件给出提示文案', r0.missing.length === 1 && /未设定达成条件/.test(r0.missing[0]))

    // 全满足 → 达成
    const e1: RunEnding = { id: 'e1', name: '真结局', condition: { secretIds: ['s1'], clueIds: ['k1'], varMin: { trust: 20 } }, reached: false }
    ok('全条件满足 → 达成', evalEnding(s, e1).tier === '达成', JSON.stringify(evalEnding(s, e1)))
    ok('达成时 missing 为空', evalEnding(s, e1).missing.length === 0)

    // 部分满足 → 接近
    const e2: RunEnding = { id: 'e2', name: '半途', condition: { secretIds: ['s1'], clueIds: ['k2'] }, reached: false }
    const r2 = evalEnding(s, e2)
    ok('部分满足 → 接近', r2.tier === '接近', r2.tier)
    ok('missing 指出还差的那条', r2.missing.length === 1 && /k2|线索k2/.test(r2.missing[0]), JSON.stringify(r2.missing))

    // 一项没中 → 未启
    const e3: RunEnding = { id: 'e3', name: '无缘', condition: { secretIds: ['s2'], clueIds: ['k2'] }, reached: false }
    ok('一项没中 → 未启', evalEnding(s, e3).tier === '未启', evalEnding(s, e3).tier)

    // varMin 不达标 → 该维度不过
    const e4: RunEnding = { id: 'e4', name: '高信任', condition: { varMin: { trust: 80 } }, reached: false }
    const r4 = evalEnding(s, e4)
    ok('varMin 不达标 → 未启', r4.tier === '未启', r4.tier)
    ok('missing 带出当前值', r4.missing.some(m => /当前 30/.test(m)), JSON.stringify(r4.missing))

    // varMin 达标
    const e5: RunEnding = { id: 'e5', name: '低门槛', condition: { varMin: { trust: 30 } }, reached: false }
    ok('varMin 达标（含端点）', evalEnding(s, e5).tier === '达成')

    // 变量缺失 → 不算达标
    const e6: RunEnding = { id: 'e6', name: '缺变量', condition: { varMin: { affection: 10 } }, reached: false }
    ok('变量缺失 → 未达成', evalEnding(s, e6).tier === '未启', evalEnding(s, e6).tier)
  }

  // ---------- 5) 批量 + 写回 ----------
  {
    let s: RunSession = {
      ...newRun('批量局', MODEL),
      clues: [clue('k1')],
      secrets: [{ id: 's1', text: '真相', unlocked: true }],
      endings: [
        { id: 'e1', name: '达成线', condition: { clueIds: ['k1'] }, reached: false },
        { id: 'e2', name: '未启线', condition: { secretIds: ['sX'] }, reached: false },
      ],
    }
    const evals = evalEndings(s)
    ok('evalEndings 逐条给 Tier', evals.length === 2)
    ok('只挑出达成的', reachedEndings(s).map(x => x.ending.id).join() === 'e1')

    s = applyEndings(s)
    ok('applyEndings 写回 reached', s.endings.find(e => e.id === 'e1')!.reached === true)
    ok('未达成的写回 false', s.endings.find(e => e.id === 'e2')!.reached === false)

    const again = applyEndings(s)
    ok('无变化时原样返回（不无谓落库）', again === s)
  }

  console.log(`\nrunEndings: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
