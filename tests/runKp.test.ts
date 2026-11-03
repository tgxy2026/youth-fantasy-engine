// ============ 跑团互动 · KP 主持层（3.0 · W4-3b）============
//
// KP 层的三件事各锁一组断言：
//   ① **检定判定单调且可复现**（掷值越高结果只可能更好；注入 rng 即得固定结果）；
//   ② **行动归类有优先级**（「搜查」含「查看」，必须先判取证，否则误归类）；
//   ③ **结构化解析走 aiParse**（JSON 藏在代码块 / 带杂散标点 / 缺字段都要能兜住）。
import { __resetMockStores } from './mock-memory'
import {
  judgeOutcome, rollCheck, kindOf, difficultyFor, DEFAULT_DIFFICULTY,
  appendAction, setLastConsequence, buildKpLayer, buildKpVerdictSchema, parseKpVerdict,
} from '../src/lib/run/kp'
import { newRun } from '../src/lib/run/store'
import type { RunSession } from '../src/lib/run/runTypes'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const MODEL = { providerId: 'ollama' }

async function main() {
  __resetMockStores()

  // ---------- 1) 四档判定 + 边界 ----------
  {
    ok('margin ≥ 30 → 大成功', judgeOutcome(80, 50) === '大成功', judgeOutcome(80, 50))
    ok('margin = 30 恰好 → 大成功（边界含）', judgeOutcome(80, 50) === '大成功')
    ok('margin = 29 → 成功', judgeOutcome(79, 50) === '成功', judgeOutcome(79, 50))
    ok('margin = 0 恰好 → 成功（边界含）', judgeOutcome(50, 50) === '成功')
    ok('margin = -1 → 擦边', judgeOutcome(49, 50) === '擦边', judgeOutcome(49, 50))
    ok('margin = -15 恰好 → 擦边（边界含）', judgeOutcome(35, 50) === '擦边')
    ok('margin = -16 → 失败', judgeOutcome(34, 50) === '失败', judgeOutcome(34, 50))

    // 单调性：固定难度下，掷值越高结果不该更差
    const order = ['失败', '擦边', '成功', '大成功']
    let mono = true
    for (let r = 1; r < 100; r++) {
      const a = order.indexOf(judgeOutcome(r, 50))
      const b = order.indexOf(judgeOutcome(r + 1, 50))
      if (b < a) mono = false
    }
    ok('🔴 判定单调（掷值越高结果不会更差）', mono)

    // 越界值钳回 1–100
    ok('难度越界（0）被钳成 1', judgeOutcome(1, 0) === '成功', judgeOutcome(1, 0))
    ok('难度越界（1000）被钳成 100', judgeOutcome(100, 1000) === '成功', judgeOutcome(100, 1000))
    ok('NaN 安全（不抛、按 0 处理）', typeof judgeOutcome(NaN, 50) === 'string')
  }

  // ---------- 2) 掷值可注入、范围 1–100 ----------
  {
    ok('rng=0 → roll=1', rollCheck(50, () => 0).roll === 1)
    ok('rng≈1 → roll=100', rollCheck(50, () => 0.9999).roll === 100)
    const fixed = rollCheck(50, () => 0.5)
    ok('固定 rng 结果稳定', fixed.roll === 51 && fixed.outcome === judgeOutcome(51, 50), `${fixed.roll}`)
    let inRange = true
    for (let i = 0; i < 200; i++) {
      const r = rollCheck(50).roll
      if (r < 1 || r > 100) inRange = false
    }
    ok('200 次随机掷值都在 1–100', inRange)
  }

  // ---------- 3) 行动归类（优先级） ----------
  {
    ok('「我观察四周」→ 观察', kindOf('我观察四周') === '观察')
    ok('「问问他昨天在哪」→ 交谈', kindOf('问问他昨天在哪') === '交谈')
    ok('「搜查抽屉」→ 取证', kindOf('搜查抽屉') === '取证')
    ok('🔴 「搜查」含「查」但不得误判为观察', kindOf('搜查这个房间') === '取证', kindOf('搜查这个房间'))
    ok('🔴 「看看」不与取证冲突', kindOf('我看看墙上') === '观察', kindOf('我看看墙上'))
    ok('认不出 → 其他', kindOf('……') === '其他')
    ok('默认难度：观察 < 交谈 < 取证',
      DEFAULT_DIFFICULTY.观察 < DEFAULT_DIFFICULTY.交谈 && DEFAULT_DIFFICULTY.交谈 < DEFAULT_DIFFICULTY.取证)
    ok('difficultyFor 取到默认表', difficultyFor('取证') === DEFAULT_DIFFICULTY.取证)
  }

  // ---------- 4) 行动流水 ----------
  {
    let s: RunSession = newRun('流水局', MODEL)
    s = appendAction(s, '我观察四周')
    ok('写进一条行动', s.actions.length === 1)
    ok('归类为观察', s.actions[0].kind === '观察')
    ok('未给难度 ⇒ 不检定', s.actions[0].roll === undefined && s.actions[0].outcome === undefined)

    s = appendAction(s, '我搜查抽屉', { difficulty: 60, rng: () => 0.9 })
    const a2 = s.actions[1]
    ok('给了难度 ⇒ 带上掷值与结果档', typeof a2.roll === 'number' && !!a2.outcome, `${a2.roll}/${a2.outcome}`)
    ok('难度被记下', a2.difficulty === 60)
    ok('text 去首尾空白', appendAction(s, '  我发问  ').actions[2].text === '我发问')

    const withC = setLastConsequence(s, '你翻出一张潮湿的船票')
    ok('后果回填到最后一条', withC.actions[withC.actions.length - 1].consequence === '你翻出一张潮湿的船票')
    ok('原会话不被改动（纯函数）', s.actions[s.actions.length - 1].consequence === undefined)
    ok('空流水时 setLastConsequence 原样返回', setLastConsequence(newRun('空', MODEL), 'x').actions.length === 0)
  }

  // ---------- 5) 主持人格提示词 ----------
  {
    const base = buildKpLayer()
    ok('含「守秘人」定位', /守秘人/.test(base))
    ok('写明「线索要给，答案不给」', /线索要给，答案不给/.test(base))
    ok('写明检定结果由系统给定', /由系统给定/.test(base))

    const withCast = buildKpLayer({
      companions: [
        { charId: 'c1', name: '阿岚', stance: '欠你一条命', knows: ['码头的事'], canHelp: true },
        { charId: 'c2', name: '老周', stance: '向导', knows: [], canHelp: false },
      ],
    })
    ok('列出同伴名与知晓', /阿岚/.test(withCast) && /码头的事/.test(withCast))
    ok('🔴 知晓为空的同伴写明「什么都不知道」', /老周[^\n]*什么都不知道/.test(withCast), withCast.split('\n').find(l => l.includes('老周')) ?? '')
    ok('能搭把手的同伴标出来', /阿岚[^\n]*搭把手/.test(withCast))

    const withSecret = buildKpLayer({ pendingSecrets: ['钟楼底下埋着上一任守钟人'], clueCount: 2 })
    ok('暗牌写进提示词', /上一任守钟人/.test(withSecret))
    ok('强调不许提前说破', /不许说破/.test(withSecret))
    ok('带进度条数', /已掌握线索 2 条/.test(withSecret))

    const schema = buildKpVerdictSchema()
    ok('输出契约含 consequence 与 clue 字段', /consequence/.test(schema) && /clue/.test(schema))
  }

  // ---------- 6) 结构化解析（走 aiParse） ----------
  {
    const plain = parseKpVerdict('{"difficulty":55,"consequence":"你撬开了锁","clue":{"text":"锁被换过","source":"取证"}}')
    ok('解析正常裁决', !!plain && plain.consequence === '你撬开了锁' && plain.difficulty === 55)
    ok('解析出新线索与来源', !!plain?.clue && plain.clue.text === '锁被换过' && plain.clue.source === '取证')

    const fenced = parseKpVerdict('```json\n{"consequence":"线索断了"}\n```')
    ok('代码块包裹也能解析', !!fenced && fenced.consequence === '线索断了')

    const messy = parseKpVerdict('{ "consequence": "他沉默了", "difficulty": 40, }')
    ok('尾随逗号容错', !!messy && messy.consequence === '他沉默了', JSON.stringify(messy))

    const noDiff = parseKpVerdict('{"consequence":"纯叙事一步"}')
    ok('省略难度 ⇒ 无 difficulty 字段', !!noDiff && noDiff.difficulty === undefined)

    const overflow = parseKpVerdict('{"consequence":"x","difficulty":1000}')
    ok('🔴 越界难度钳回 100', overflow?.difficulty === 100, String(overflow?.difficulty))

    const withSecret = parseKpVerdict('{"consequence":"真相浮出","revealsSecretId":"s1"}')
    ok('解析揭晓的秘密 id', withSecret?.revealsSecretId === 's1')

    const badSource = parseKpVerdict('{"consequence":"x","clue":{"text":"痕迹","source":"瞎写"}}')
    ok('非法 source 不回填（只留 text）', !!badSource?.clue && badSource.clue.source === undefined)

    ok('完全不是 JSON → null', parseKpVerdict('今天天气不错') === null)
    ok('空对象 → null（无有效字段）', parseKpVerdict('{}') === null)
  }

  console.log(`\nrunKp: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
