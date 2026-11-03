// 自由模式 · #12 描写重复「对照实验」（**手动运行**，不进全量回归）
//
// 目的：验证诊断报告 docs/酒馆模式-12-描写重复诊断报告-2026-09-16.md 的调优建议是否真的有效 ——
//   A 基线              ：出厂参数（repeat_penalty 1.05，无 repeat_last_n）
//   B 只拧大重复惩罚     ：repeat_penalty 1.05 → 1.4      （用来**证伪**「惩罚强度不够」这个假设）
//   C 换旋钮            ：repeat_last_n 64 → 512 + frequency_penalty 0.2
//   D 只改提示词        ：协议加「不许复读自己」约束（P1）
//   E 完整方案          ：C 的参数 + D 的提示词
//
// 为什么这样设计（对照实验的三条纪律）：
//   ① 固定 seed —— 不同组的随机流起点相同，差异才归因于被改动的那一项；
//   ② 同一段用户台词脚本 —— 各组喂进去的输入逐字相同，唯一的变量是参数或 system；
//   ③ 跑**多轮**（默认 5 轮）而不是单轮 —— 症状本身是「跨轮复读」，
//      单轮生成量不出「这一轮又在写手」，必须让模型连续说几轮才看得见。
//
// 主指标：手部动作行 ÷ 动作行总数（越低越好）
// 副指标：与上一轮动作文本的 3-gram 重合（越高越像在复读）
//
// 用法：
//   node tests/build-test.mjs live-repeat                  # 全量（A~E × 4 次 × 5 轮）
//   LR_GROUPS=A,D LR_RUNS=2 node tests/build-test.mjs live-repeat
//   LR_GROUPS=V LR_RUNS=4 node tests/build-test.mjs live-repeat     # 只验落地后的实机参数链路
//   LR_CHECK=1 node tests/build-test.mjs live-repeat       # 只检查锚点与环境，不调模型
//   LR_ANALYZE=<上次的原始 json> node tests/build-test.mjs live-repeat
//                                                          # 离线换指标重算，不调模型
import fs from 'fs'
import * as store from '../src/lib/tavern/store'
import { __resetMockStores } from './mock-memory'
import { buildFreeSystem, buildFreeMessages } from '../src/lib/tavern/engine'
import { uid } from '../src/lib/app/id'
import type { FreeCharacter, FreeSession, TavernMessage } from '../src/lib/tavern/types'

const MODEL = process.env.LR_MODEL ?? 'orcarouter/Qwen3.8-27B-Uncensored:q6_K'
const URL = 'http://127.0.0.1:11434/api/chat'
const RUNS = Number(process.env.LR_RUNS ?? 4)
const ONLY = (process.env.LR_GROUPS ?? '').trim()
const CHECK_ONLY = process.env.LR_CHECK === '1'
// 离线二次挖掘：不调模型，只把上一次跑出来的原始 JSON 换个指标重算。
// 存在的意义是 GPU 时间太贵 —— 跑一轮 8 分半，指标口径想改就离线改，别重跑。
const ANALYZE_FILE = (process.env.LR_ANALYZE ?? '').trim()

// ---------- 用户台词脚本（各组逐字相同，这是「控制变量」的一部分） ----------
const USER_TURNS = [
  '（我把伞立在门口，抖了抖上面的水。）今天还是老样子。',
  '（我把手插进兜里，没接话。）',
  '（我接过来，握了一下，杯子还是热的。）',
  '（我把杯子搁在柜台上，没喝。）……今天不太想说话。',
  '（我看着货架最上面那排，没动。）',
]

// ---------- 角色卡（忠实复刻真实卡的两个「放大器」特征：手部锚点 + 学动作密度） ----------
const CHAR_EXAMPLES = [
  '〖对方〗这么晚还不下班？',
  '（把找零推过去，没抬头）',
  '灯还亮着。',
  '',
  '〖对方〗你一个人看店不怕吗？',
  '（停了一下，把烟按灭）',
  '惯了。',
].join('\n')

// ---------- 五组变量 ----------
const BASE_OPTS = { temperature: 0.95, top_p: 0.92, top_k: 60, repeat_penalty: 1.05, presence_penalty: 0.55, num_ctx: 32768 }
type PromptVariant = 'base' | 'b7o5' | 'tail'
const GROUPS: Record<string, { label: string; opts: Record<string, number>; prompt: PromptVariant }> = {
  A: { label: '旧出厂（改动前：窗 64 / 无词频）', opts: { ...BASE_OPTS }, prompt: 'base' },
  // V 不进 GROUPS 表：它的 options 由**真实设置链路**现算（见 main 里的特判），
  // 目的是验证「落地之后实机到底发出去什么参数」，而不是我在脚本里手写的值。
  B: { label: '拧大重复惩罚 1.05→1.4', opts: { ...BASE_OPTS, repeat_penalty: 1.4 }, prompt: 'base' },
  C: { label: '换旋钮（last_n 512 + freq 0.2）', opts: { ...BASE_OPTS, repeat_last_n: 512, frequency_penalty: 0.2 }, prompt: 'base' },
  D: { label: '只改提示词（B7+O5）', opts: { ...BASE_OPTS }, prompt: 'b7o5' },
  E: { label: '完整方案（C 参数 + B7+O5）', opts: { ...BASE_OPTS, repeat_last_n: 512, frequency_penalty: 0.2 }, prompt: 'b7o5' },
  // —— 第二轮：拆旋钮 + 提示词换落点 ——
  C1: { label: '只开窗（repeat_last_n 512）', opts: { ...BASE_OPTS, repeat_last_n: 512 }, prompt: 'base' },
  C2: { label: '只加词频惩罚（freq 0.1）', opts: { ...BASE_OPTS, frequency_penalty: 0.1 }, prompt: 'base' },
  F: { label: '轻量组合（last_n 512 + freq 0.1）', opts: { ...BASE_OPTS, repeat_last_n: 512, frequency_penalty: 0.1 }, prompt: 'base' },
  G: { label: '降新话题倾向（presence 0.55→0.3）', opts: { ...BASE_OPTS, presence_penalty: 0.3 }, prompt: 'base' },
  H: { label: '关新话题倾向（presence 0）', opts: { ...BASE_OPTS, presence_penalty: 0 }, prompt: 'base' },
  T: { label: '提示词钉在「最后提醒」', opts: { ...BASE_OPTS }, prompt: 'tail' },
  TF: { label: '轻量组合 + 提示词钉末尾', opts: { ...BASE_OPTS, repeat_last_n: 512, frequency_penalty: 0.1 }, prompt: 'tail' },
}

// ---------- 反重复改法 A：改 B7 那条指令 + 新增 O5（埋在协议中段） ----------
const B7_OLD = '少用形容词，用动作、停顿、身体反应代替情绪标签。'
const B7_NEW = [
  '少用形容词。交代情绪的路子不止一种 —— 一句停顿、句子突然变短、答非所问、',
  '话说一半改口、动作做一半停住、直接说反话，都算。',
  '★ 不必每轮都靠肢体动作，更别每轮都写手：手部动作（攥、捏、抠、指节、掌心）连着几轮出现最腻 ——',
  '  上一轮写过了，这一轮就换一处，或者这一轮干脆不写身体，用停顿和语气交代。',
].join('\n')
const O5_ANCHOR = '▍四、记忆与状态'
const O5_NEW = [
  'O5 不许复读自己：同一个身体反应、同一类小动作（手、眼神、呼吸、喉结、嘴角），',
  '不许在连续三个回合里重复出现。上一轮用过的手法，这一轮换一种；实在没有就少写一个动作，别硬凑。',
  '',
  O5_ANCHOR,
].join('\n')

// ---------- 反重复改法 B：钉在协议末尾的「最后提醒」（近因位置，salience 最高） ----------
const TAIL_ANCHOR = '结尾留一个能接的话头。'
const TAIL_NEW = [
  '结尾留一个能接的话头。',
  '⚠️ 不许复读自己：上几轮写过的身体反应，这一轮换一处。',
  '手部动作（攥 / 捏 / 抠 / 指节 / 掌心 / 指尖）在最近三个回合里出现过，这一轮就别再写手 ——',
  '改用停顿、语气、答非所问；非要写身体，就换一个部位。',
].join('\n')

function applyPrompt(system: string, variant: PromptVariant): { text: string; hits: string[] } {
  const hits: string[] = []
  let out = system
  if (variant === 'base') return { text: out, hits: ['（未改提示词）'] }
  if (variant === 'b7o5') {
    if (out.includes(B7_OLD)) { out = out.replace(B7_OLD, B7_NEW); hits.push('B7 已替换') } else hits.push('⚠️ B7 锚点未命中')
    if (out.includes(O5_ANCHOR)) { out = out.replace(O5_ANCHOR, O5_NEW); hits.push('O5 已插入') } else hits.push('⚠️ O5 锚点未命中')
  }
  if (variant === 'tail') {
    if (out.includes(TAIL_ANCHOR)) { out = out.replace(TAIL_ANCHOR, TAIL_NEW); hits.push('最后提醒 已追加反重复') } else hits.push('⚠️ 最后提醒 锚点未命中')
  }
  return { text: out, hits }
}

// ---------- 指标 ----------
// ⚠️ 手部只认「专项词」，不含光杆「手」——「顺手拿」「手酸了」这类惯用语会把噪声顶上来
//（第一版用了裸 '手'，实测把「顺手拿下一罐」也算成手部动作，误差不小）。
const HAND_WORDS = ['指节', '指尖', '手指', '拇指', '指甲', '手掌', '掌心', '手腕', '手背', '手臂', '手肘', '拳头', '攥', '捏', '抠', '握', '摩挲']
// 身体反应落点分类（诊断报告用的就是这套，这里保持一致，便于横向对照）
const BODY_CATS: [string, RegExp][] = [
  ['手部', /指节|指尖|手指|拇指|指甲|手掌|掌心|手腕|手背|手臂|手肘|拳头|攥|捏|抠|握|摩挲/],
  ['呼吸', /呼吸|喘|屏住|深吸|吐气|叹了口气|喉|咽|鼻息/],
  ['眼部', /眼|视线|目光|眸|眨眼|眯|瞥|凝视|垂眼|别开/],
  ['面部', /脸|颊|唇角|嘴角|抿|咬唇|耳根|神色|表情|挑眉|皱眉|蹙/],
  ['姿态', /站|坐|转身|低头|抬头|肩|背|身体|退|靠|蹲|倚|歪头|侧身|倾|停了一下|停了一瞬/],
]
function actionLines(reply: string): string[] {
  return reply.split(/\r?\n/).map(l => l.trim()).filter(l => /^（|^\(/.test(l))
}
function handWordsIn(text: string): string[] {
  return HAND_WORDS.filter(w => text.includes(w))
}
function catsOf(text: string): string[] {
  return BODY_CATS.filter(([, re]) => re.test(text)).map(([n]) => n)
}
function grams(s: string, n = 3): Set<string> {
  const t = s.replace(/[（）()\s]/g, '')
  const out = new Set<string>()
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n))
  return out
}
function overlap(a: Set<string>, b: Set<string>): number {
  let c = 0
  for (const g of a) if (b.has(g)) c++
  return c
}

/** 两段文本的「最长公共子串」（先剥标点）—— 3-gram 数只能看出「像」，这个能捞出整句照搬 */
function longestShared(a: string, b: string): string {
  const A = a.replace(/[（）()\s，。、！？…—]/g, ''), B = b.replace(/[（）()\s，。、！？…—]/g, '')
  let best = ''
  for (let i = 0; i < A.length; i++) {
    for (let j = i + best.length + 1; j <= A.length; j++) {
      const s = A.slice(i, j)
      if (B.includes(s)) best = s
      else break
    }
  }
  return best
}

/** 离线二次挖掘：读 live-repeat 的原始 JSON，换指标重算（不调模型、不占 GPU） */
function analyzeOffline(file: string) {
  const all = JSON.parse(fs.readFileSync(file, 'utf8')) as { group: string; run: number; turns: TurnRec[] }[]
  const groups = [...new Set(all.map(x => x.group))]
  console.log(`\n▶ 离线挖掘：${file}（${all.length} 次运行 / ${groups.length} 组）\n`)
  console.log('组  轮数  动作/轮  对白/轮  括号行占比  手部名词行/轮  指节次数  最长跨轮复读  复读≥6字轮次')
  const rows: { g: string; hits: string[] }[] = []
  for (const g of groups) {
    const runs = all.filter(x => x.group === g)
    let turns = 0, act = 0, talk = 0, handLines = 0, jie = 0, sharedSum = 0, sharedN = 0, bigRepeat = 0
    const hits: string[] = []
    for (const r of runs) {
      const prevs: string[] = []
      for (const t of r.turns) {
        turns++
        const a = actionLines(t.reply)
        const k = t.reply.split(/\r?\n/).map(l => l.trim())
          .filter(l => l && !/^（|^\(/.test(l) && !/^〔/.test(l))
        act += a.length; talk += k.length
        handLines += a.filter(l => HAND_WORDS.some(w => l.includes(w))).length
        jie += (t.reply.match(/指节/g) ?? []).length
        let best = ''
        for (const p of prevs) { const s = longestShared(t.reply, p); if (s.length > best.length) best = s }
        sharedSum += best.length; sharedN++
        if (best.length >= 6) { bigRepeat++; if (hits.length < 8) hits.push(`run${r.run} 第${t.turn}轮：「${best}」`) }
        prevs.push(t.reply)
      }
    }
    rows.push({ g, hits })
    console.log(
      `${g.padEnd(3)} ${String(turns).padStart(4)} ${(act / turns).toFixed(2).padStart(8)} ${(talk / turns).toFixed(2).padStart(8)} ` +
      `${(act / Math.max(1, act + talk) * 100).toFixed(0).padStart(10)}% ${(handLines / turns).toFixed(2).padStart(13)} ` +
      `${String(jie).padStart(9)} ${(sharedN ? sharedSum / sharedN : 0).toFixed(1).padStart(13)} ${String(bigRepeat).padStart(13)}`,
    )
  }
  console.log('\n▶ 跨轮照搬现场（公共子串 ≥ 6 字，每组最多列 8 处）')
  for (const r of rows) {
    console.log(`\n【组 ${r.g}】${r.hits.length ? '' : '（无）'}`)
    r.hits.forEach(h => console.log(`   ${h}`))
  }
}

type TurnRec = {
  run: number; turn: number; reply: string
  action: number; talk: number; hand: number; over: number; sameBeat: boolean
  /** 本轮回合里各类身体反应落点各出现在几行动作上 */
  cats: Record<string, number>
}

async function callOllama(system: string, msgs: { role: string; content: string }[], opts: Record<string, number>, seed: number): Promise<string> {
  const body = {
    model: MODEL,
    messages: [{ role: 'system', content: system }, ...msgs],
    stream: false,
    keep_alive: '10m',
    // 🔴 必须关思考：这个模型是思考型的，不关就整段产出进 message.thinking、
    //    content 为空（实测 num_predict 被思考吃光，正文一个字都拿不到）。
    //    app 侧出厂设置 disableThink: true（settings.ts:361），所以这也是最贴近真实配置的跑法。
    think: false,
    options: { ...opts, seed, num_predict: 240 },
  }
  const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = (await res.json()) as { message?: { content?: string } }
  return (j.message?.content ?? '').trim()
}

async function mkChar(): Promise<FreeCharacter> {
  return store.createFreeChar({
    ...store.emptyFreeCharacter(),
    name: '苏念',
    world: '现代都市，老城区一间凌晨还亮着灯的便利店。她是店员，你是常来的顾客。',
    profile: {
      externals: '短发，总穿同一件洗旧的灰色围裙，左手腕有道旧疤',
      core: '外冷内热。嘴上不留情，但会记得你爱吃什么。',
      speech: '句子短，习惯用反问，从不说软话',
      relations: '独居，父母在老家',
      cannot: '说不出关心的话，只能换成别的方式表达',
      // 🔴 忠实复刻真实卡：把「紧张」唯一绑到手部（P3 说的放大器）
      knowledge: '不知道顾客的职业与过去；紧张时抠手指甲边缘',
    },
    conduct: {
      perspective: '认知视角第一人称，但落笔描写一律第三人称',
      bottomLine: '不越界打听私事；被追问会转移话题，不会发火',
      paceLock: '关系推进要慢',
      rating: '日常向',
    },
    examples: CHAR_EXAMPLES,
  })
}

async function main() {
  if (ANALYZE_FILE) { analyzeOffline(ANALYZE_FILE); return }
  __resetMockStores()
  const ai = await mkChar()
  const userChar = await store.createFreeChar({ ...store.emptyFreeCharacter(), name: '楚楠', world: '十九岁，金融大一。' })
  const session: FreeSession = await store.createFreeSession([ai.id, userChar.id], 'repeat-exp', { providerId: '' }, {}, userChar.id)

  // 无历史时先建一次 system（每轮内容其实一样，省得反复算）
  const built = await buildFreeSystem(session, [ai, userChar])
  const variants: PromptVariant[] = ['b7o5', 'tail']
  const applied: Record<string, { text: string; hits: string[] }> = {}
  console.log('=== 环境自检 ===')
  console.log('模型：', MODEL)
  console.log('system 长度：', built.system.length, '｜ 含协议：', built.system.includes('角色扮演通用协议'), '｜ 含角色卡：', built.system.includes('外冷内热'))
  let bad = false
  for (const v of variants) {
    applied[v] = applyPrompt(built.system, v)
    console.log(`改法 ${v}：`, applied[v].hits.join(' / '), '→', applied[v].text.length, '字（+' + (applied[v].text.length - built.system.length) + '）')
    if (applied[v].hits.some(h => h.startsWith('⚠️'))) bad = true
  }
  if (bad) { console.log('❌ 锚点未命中，实验终止'); process.exitCode = 1; return }
  if (CHECK_ONLY) { console.log('\n（LR_CHECK=1，只自检不跑模型）'); return }

  // 特殊组 V：options 走**真实链路**（getTavernSettings → resolveParamsOf → toOllamaOptions）。
  // 这是「落地是否真的生效」的端到端验证 —— 脚本里手写的参数值再对，也不等于实机发的是那个值。
  const sel = ONLY ? ONLY.split(',').map(s => s.trim()) : []
  const dynamic: Record<string, { label: string; opts: Record<string, number>; prompt: PromptVariant }> = {}
  const groups = ONLY
    ? [...Object.keys(GROUPS).filter(g => sel.includes(g)), ...(sel.includes('V') ? ['V'] : [])]
    : Object.keys(GROUPS)
  if (sel.includes('V')) {
    const { getTavernSettings, resolveParamsOf } = await import('../src/lib/tavern/settings')
    const { toOllamaOptions } = await import('../src/lib/tavern/params')
    const st = await getTavernSettings()
    dynamic.V = {
      label: '实机默认（settings→resolve→toOllamaOptions，协议 v1.10）',
      opts: toOllamaOptions(resolveParamsOf('free', st)),
      prompt: 'base',
    }
    console.log('=== 实机链路算出来的 options（这才是真正发出去的东西）===')
    console.log(JSON.stringify(dynamic.V.opts))
  }
  const ALLG = { ...GROUPS, ...dynamic }
  const seeds = Array.from({ length: RUNS }, (_, i) => 101 + i * 37)
  const outFile = `C:/Users/18223/AppData/Local/Temp/live-repeat-${Date.now()}.json`
  const all: { group: string; run: number; seed: number; turns: TurnRec[] }[] = []

  const t0 = Date.now()
  for (const g of groups) {
    const cfg = ALLG[g]
    const system = cfg.prompt === 'base' ? built.system : applied[cfg.prompt].text
    console.log(`\n${'='.repeat(72)}\n▶ 组 ${g}：${cfg.label}\n   options: ${JSON.stringify(cfg.opts)}\n   prompt : ${cfg.prompt}\n${'='.repeat(72)}`)
    for (let r = 0; r < RUNS; r++) {
      const seed = seeds[r]
      const msgs: TavernMessage[] = []
      const recs: TurnRec[] = []
      let prevActionText = ''
      let prevHand: string[] = []
      for (let t = 0; t < USER_TURNS.length; t++) {
        msgs.push({ id: uid(), role: 'user', content: USER_TURNS[t], at: Date.now() })
        const { messages } = buildFreeMessages(msgs, session, [ai, userChar], 16000)
        let reply = ''
        try {
          reply = await callOllama(system, messages, cfg.opts, seed)
        } catch (e) {
          console.log(`  [run ${r} turn ${t}] ❌ ${e instanceof Error ? e.message : String(e)}`)
          break
        }
        const acts = actionLines(reply)
        const talkLines = reply.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^（|^\(/.test(l) && !/^〔/.test(l))
        const handLines = acts.filter(l => HAND_WORDS.some(w => l.includes(w)))
        const actText = acts.join('')
        const handNow = handWordsIn(actText)
        const over = prevActionText ? overlap(grams(actText), grams(prevActionText)) : 0
        const sameBeat = prevHand.length > 0 && handNow.some(w => prevHand.includes(w))
        const catCount: Record<string, number> = {}
        for (const l of acts) for (const c of catsOf(l)) catCount[c] = (catCount[c] ?? 0) + 1
        recs.push({ run: r, turn: t + 1, reply, action: acts.length, talk: talkLines.length, hand: handLines.length, over, sameBeat, cats: catCount })
        prevActionText = actText
        prevHand = handNow
        msgs.push({ id: uid(), role: 'assistant', content: reply, speakerId: ai.id, at: Date.now() } as TavernMessage)
        const mark = handLines.length ? '👋' : '  '
        process.stdout.write(`${mark}[${g} r${r} t${t + 1}] 动作${acts.length}/手${handLines.length} 重合${over} ${handNow.join(',') || '-'}\n`)
      }
      all.push({ group: g, run: r, seed, turns: recs })
      // 每组第 1 次跑完打印全文，供人工看语感（尤其 B 组要查句子是否变生硬）
      if (r === 0) {
        console.log(`\n  ── 组 ${g} 第 1 次的完整输出 ──`)
        recs.forEach(x => { console.log(`  【第${x.turn}轮】` + x.reply.replace(/\n/g, '\n      ')) })
      }
    }
  }

  fs.writeFileSync(outFile, JSON.stringify(all, null, 1))
  console.log(`\n原始输出已存：${outFile}`)
  console.log(`总耗时 ${Math.round((Date.now() - t0) / 1000)} 秒`)

  // ---------- 汇总 ----------
  console.log(`\n${'='.repeat(72)}\n▶ 汇总（手部率 = 手部动作行 ÷ 动作行总数）\n${'='.repeat(72)}`)
  console.log('组  说明                              轮  动作/轮  对白/轮  手部行  手部率  手部轮次率  同拍复现率  3gram重合')
  for (const g of groups) {
    const recs = all.filter(x => x.group === g).flatMap(x => x.turns)
    if (!recs.length) continue
    const act = recs.reduce((s, x) => s + x.action, 0)
    const hand = recs.reduce((s, x) => s + x.hand, 0)
    const handTurns = recs.filter(x => x.hand > 0).length / recs.length
    const pairs = recs.slice(1)
    const sameBeat = pairs.filter(x => x.sameBeat).length / Math.max(1, pairs.length)
    const over = pairs.reduce((s, x) => s + x.over, 0) / Math.max(1, pairs.length)
    const talk = recs.reduce((s, x) => s + x.talk, 0)
    console.log(
      `${g.padEnd(3, ' ')} ${ALLG[g].label.padEnd(34, ' ')} ${String(recs.length).padStart(3)} ` +
      `${(act / recs.length).toFixed(2).padStart(7)} ${(talk / recs.length).toFixed(2).padStart(8)} ` +
      `${String(hand).padStart(6)} ${(act ? (hand / act * 100).toFixed(1) : '0.0').padStart(6)}% ` +
      `${(handTurns * 100).toFixed(1).padStart(9)}% ${(sameBeat * 100).toFixed(1).padStart(9)}% ${over.toFixed(1).padStart(10)}`,
    )
  }

  // ---------- 身体反应落点分布（诊断报告同一套分类，便于横向对照） ----------
  console.log(`\n▶ 身体反应落点分布（各类命中行数 ÷ 该组动作行总数）`)
  const catNames = BODY_CATS.map(([n]) => n)
  console.log('组  ' + catNames.map(n => n.padStart(7)).join('') + '    未归类')
  for (const g of groups) {
    const recs = all.filter(x => x.group === g).flatMap(x => x.turns)
    if (!recs.length) continue
    const act = recs.reduce((s, x) => s + x.action, 0)
    const tot: Record<string, number> = {}
    for (const r of recs) for (const [k, v] of Object.entries(r.cats)) tot[k] = (tot[k] ?? 0) + v
    const anyCat = recs.reduce((s, r) => s + Object.values(r.cats).length, 0)
    const uncat = Math.max(0, act - anyCat)
    console.log(
      `${g}  ` + catNames.map(n => (`${act ? Math.round((tot[n] ?? 0) / act * 100) : 0}%`).padStart(7)).join('') +
      `    ${act ? Math.round(uncat / act * 100) : 0}%`,
    )
  }
}

main().catch(e => {
  console.log('\n❌ 实验失败：', e?.message ?? e)
  if (e?.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
