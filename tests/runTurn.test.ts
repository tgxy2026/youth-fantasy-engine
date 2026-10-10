// ============ 跑团互动 · 一轮（3.0 · W4-3e）============
//
// 「一轮」是跑团的主链路 ⇒ 断言锁四件事：
//   ① **系统先掷检定**（不由模型自报成败）：行动流水里带上难度 / 掷值 / 结果档；
//   ② **正文与裁决分离**：正文进消息历史，`〖裁决〗` 后的 JSON 只被程序消费；
//   ③ 裁决**真的落库**：线索入板 / 秘密揭示 / 结局写回，一条链走完；
//   ④ 取消不抛异常。
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { runKpTurn } from '../src/lib/run/turn'
import { judgeOutcome } from '../src/lib/run/kp'
import { newRun } from '../src/lib/run/store'
import type { RunSession, RunSecret, RunEnding } from '../src/lib/run/runTypes'
import type { AIProvider } from '../src/lib/ai'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const MODEL = { providerId: 'fake' }
const FAKE_PROVIDER = { id: 'fake', model: 'fake-model', contextWindow: 32768 } as unknown as AIProvider
const fakeResolve = async () => ({ provider: FAKE_PROVIDER, fellBack: false })

/** 造一个「假 AI 通道」，并把收到的 system 记下来 */
function makeChat(reply: string) {
  const seen = { system: '', messages: [] as { role: string; content: string }[] }
  const chatFn = async (_cfg: AIProvider, msgs: { role: string; content: string }[]) => {
    seen.system = msgs[0].content
    seen.messages = msgs.slice(1)
    return reply
  }
  return { seen, chatFn: chatFn as never }
}

const MARK = '〖裁决〗'

async function main() {
  __resetMockStores()

  // ---------- 1) 正常一轮：检定 + 正文分离 + 裁决落库 ----------
  {
    const s0: RunSession = newRun('雾港开局', MODEL)
    const { seen, chatFn } = makeChat(
      '你用力一撬，锁芯应声而开。抽屉里躺着一张潮湿的船票。\n' + MARK + '\n'
      + '{"difficulty":50,"consequence":"锁被你撬开","clue":{"text":"抽屉里的船票","source":"取证"}}',
    )

    const r = await runKpTurn(s0, '我搜查抽屉', {}, { chatFn, resolveProvider: fakeResolve, difficulty: 50 })

    ok('正文被切出（不含哨兵与 JSON）', r.reply === '你用力一撬，锁芯应声而开。抽屉里躺着一张潮湿的船票。', r.reply)
    ok('裁决被解析', !!r.verdict && r.verdict.consequence === '锁被你撬开', JSON.stringify(r.verdict))
    ok('检定按注入难度 50 掷', r.check.difficulty === 50 && r.check.roll >= 1 && r.check.roll <= 100, String(r.check.roll))
    ok('结果档与 judgeOutcome 一致', r.check.outcome === judgeOutcome(r.check.roll, 50), r.check.outcome)
    ok('行动归类为取证', r.check.kind === '取证', r.check.kind)

    ok('🔴 系统提示词含 KP 主持层', /守秘人（KP）/.test(seen.system), seen.system.slice(0, 60))
    ok('🔴 系统提示词含本轮检定结果', new RegExp(`掷值 ${r.check.roll}`).test(seen.system))
    ok('系统提示词含输出契约哨兵', seen.system.includes(MARK))
    ok('用户消息作为最后一条送出', seen.messages[seen.messages.length - 1].content === '我搜查抽屉')

    ok('行动流水 +1', r.session.actions.length === 1)
    const a = r.session.actions[0]
    ok('流水记下难度/掷值/结果档', a.difficulty === 50 && typeof a.roll === 'number' && !!a.outcome)
    ok('流水回填后果', a.consequence === '锁被你撬开')
    ok('消息追加 用户 + 正文', r.session.messages.length === 2
      && r.session.messages[0].role === 'user' && r.session.messages[0].content === '我搜查抽屉'
      && r.session.messages[1].role === 'assistant' && r.session.messages[1].content === r.reply)
    ok('🔴 裁决 JSON 不进消息历史', !r.session.messages.some(m => m.content.includes(MARK)))
    ok('线索真的入板', r.session.clues.length === 1 && r.session.clues[0].text === '抽屉里的船票')
    ok('线索来源被记下', r.session.clues[0].source === '取证')
  }

  // ---------- 2) 无哨兵：整段当正文、裁决为空 ----------
  {
    const s0 = newRun('无裁决局', MODEL)
    const { chatFn } = makeChat('雾气里什么都看不清。')
    const r = await runKpTurn(s0, '我观察四周', {}, { chatFn, resolveProvider: fakeResolve })
    ok('无哨兵 → verdict 为 null', r.verdict === null)
    ok('整段当正文', r.reply === '雾气里什么都看不清。')
    ok('行动仍写入（后果留空）', r.session.actions.length === 1 && r.session.actions[0].consequence === undefined)
    ok('线索未变', r.session.clues.length === 0)
  }

  // ---------- 3) 裁决驱动：秘密揭示 + 结局写回 ----------
  {
    const secret: RunSecret = { id: 's1', text: '守钟人早换了人', unlocked: false }
    const ending: RunEnding = { id: 'e1', name: '真结局', condition: { secretIds: ['s1'] }, reached: false }
    const s0: RunSession = { ...newRun('揭密局', MODEL), secrets: [secret], endings: [ending] }
    const { chatFn } = makeChat('你忽然明白了那个细节意味着什么。\n' + MARK
      + '\n{"consequence":"真相浮出一角","revealsSecretId":"s1"}')

    const r = await runKpTurn(s0, '我取证那盏灯', {}, { chatFn, resolveProvider: fakeResolve })
    ok('秘密被揭示', r.session.secrets[0].unlocked === true)
    ok('🔴 结局随之写回 reached', r.session.endings[0].reached === true)
  }

  // ---------- 4) 派生解锁：新线索触发秘密（不靠 revealsSecretId） ----------
  {
    const secret: RunSecret = { id: 's1', text: '抽屉的秘密', unlocked: false, revealOn: { clueIds: ['k1'] } }
    const s0: RunSession = {
      ...newRun('派生局', MODEL),
      secrets: [secret],
      clues: [{ id: 'k1', text: '抽屉的锁被换过', source: '取证', acquired: false, at: 1 }],
    }
    const { chatFn } = makeChat('锁的划痕是新的。\n' + MARK + '\n{"consequence":"你注意到锁换了","clue":{"text":"抽屉的锁被换过","source":"取证"}}')
    const r = await runKpTurn(s0, '我取证抽屉的锁', {}, { chatFn, resolveProvider: fakeResolve })
    ok('线索由「已埋」翻成已获', r.session.clues[0].acquired === true)
    ok('🔴 派生解锁：线索到手即揭示秘密', r.session.secrets[0].unlocked === true)
  }

  // ---------- 5) 取消不抛 ----------
  {
    const s0 = newRun('取消局', MODEL)
    const cancelFn = (async () => { const e = new Error('cancelled'); e.name = 'AICancelled'; throw e }) as never
    const r = await runKpTurn(s0, '我观察四周', {}, { chatFn: cancelFn, resolveProvider: fakeResolve })
    ok('取消不抛异常', r.cancelled === true)
    ok('取消时正文为空', r.reply === '')
    ok('取消时消息不追加', r.session.messages.length === 0)
    ok('取消时仍记一条行动（已掷的检定不丢）', r.session.actions.length === 1)
  }

  // ---------- 6) 引用世界版本注入（D4=A） ----------
  {
    // 无引用 → 不出现世界层
    {
      const { seen, chatFn } = makeChat('潮水退了。\n' + MARK + '\n{"consequence":"你看出潮汐的规律"}')
      await runKpTurn(newRun('无引用局', MODEL), '我观察潮水', {}, { chatFn, resolveProvider: fakeResolve })
      ok('无引用 → 不出现「引用的世界版本」层', !/引用的世界版本/.test(seen.system))
    }
    // 有引用 → 世界正文与该层标题都进 system
    {
      await db.saveWorld({
        id: 'w9', name: '雾港', origin: { projectId: 'p1', projectName: '书', at: 1 },
        tables: [], activeSubs: {}, fingerprint: 'fp',
        versions: [{
          v: 1, at: 1, fingerprint: 'f1', activeSubs: {},
          tables: [{ tabId: 'worldbase', kind: 'form', rows: [{ id: 'worldbase', data: { '世界设定::潮汐': '每月一次' }, order: 0 }] }],
        }],
        createdAt: 1, updatedAt: 1,
      })
      const { seen, chatFn } = makeChat('潮水退了。\n' + MARK + '\n{"consequence":"你看出潮汐的规律"}')
      const s0: RunSession = { ...newRun('引用局', MODEL), worldRef: { worldId: 'w9', version: 1, worldName: '雾港' } }
      await runKpTurn(s0, '我观察潮水', {}, { chatFn, resolveProvider: fakeResolve })
      ok('🔴 冻结世界版本被渲染进 system', /世界设定::潮汐=每月一次/.test(seen.system), seen.system.slice(0, 120))
      ok('世界层带版本标题', /引用的世界版本（雾港 v1）/.test(seen.system))
    }
  }

  console.log(`\nrunTurn: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
