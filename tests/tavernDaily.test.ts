// ============ 酒馆模式 · 日常状态与主动性（方案 §4.7 / §7.4 / §7.5）============
//
// 无服务端 → 只能「时间差推进」：隔得够久就补写她这几天的生活。
// 这组断言盯住三件容易做错的事：
//   ① 阈值判定（不足 8 小时不许推进，否则每开一次就编一天）
//   ② 日志按天累加、**同日不重复**、只留最近若干天
//   ③ 段落解析必须**整行**匹配 —— 用 includes 的话「09-15：心情不错，买了花」这行
//      会被当成段落标题，该行丢失且后续内容串段（这个坑是写实现时自己踩到的）
import {
  emptyDaily, shouldAdvanceDaily, daysSince, buildDailySystem, parseDailyReply, advanceDaily,
  DAILY_LOG_KEEP,
} from '../src/lib/tavern/daily'
import { DAILY_ADVANCE_MS, type DailyState, type FreeCharacter } from '../src/lib/tavern/types'
import { saveProviders, saveActiveId, type ChatMessage } from '../src/lib/ai'
import { __resetMockStores } from './mock-memory'
import * as store from '../src/lib/tavern/store'
import type { ChatFn } from '../src/lib/tavern/engine'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const HOUR = 3_600_000

function makeFakeChat(reply: string) {
  const calls: { messages: ChatMessage[]; opts: Record<string, unknown> }[] = []
  const chatFn: ChatFn = async (_cfg, messages, opts) => {
    calls.push({ messages, opts: (opts ?? {}) as Record<string, unknown> })
    return reply
  }
  return { chatFn, calls }
}

const DAILY_REPLY = [
  '【这几天的生活】',
  '- 09-16：冷柜半夜跳闸，她一个人把货挪到隔壁店，回来时手冻得发红。',
  '- 09-15：把门口那盆快死的绿萝换了土，剪掉一半枯叶。',
  '',
  '【她的心情】有点烦',
  '',
  '【她想说的话】',
  '（她头也没抬，把找零推过来）',
  '「绿萝活过来了。」',
].join('\n')

async function mkChar(): Promise<FreeCharacter> {
  return store.createFreeChar({
    ...store.emptyFreeCharacter(),
    name: '苏念',
    world: '现代都市，老城区一间凌晨还亮着灯的便利店。',
    profile: {
      externals: '短发，灰色围裙', core: '外冷内热，嘴上不留情',
      speech: '句子短，习惯用反问', relations: '独居',
      cannot: '说不出关心的话', knowledge: '不知道顾客的职业与过去',
    },
    conduct: { perspective: '第一人称', bottomLine: '不越界', paceLock: '慢', rating: '日常向' },
    examples: '对方：这么晚还不下班？\n「灯还亮着。」',
  })
}

async function main() {
  __resetMockStores()
  await saveProviders([{ id: 'daily-stub', name: '桩', type: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'stub' }])
  await saveActiveId('daily-stub')

  // ---------- 1) 阈值与时间差 ----------
  {
    const now = new Date('2026-09-16T12:00:00').getTime()
    const fresh: DailyState = { charId: 'c', lastActiveAt: now - HOUR, log: [] }
    ok('刚聊过 1 小时 → 不推进（否则每开一次就编一天）', !shouldAdvanceDaily(fresh, now))
    ok('过了 9 小时 → 推进', shouldAdvanceDaily({ ...fresh, lastActiveAt: now - 9 * HOUR }, now))
    ok('恰好 8 小时 → 推进（≥ 阈值）', shouldAdvanceDaily({ ...fresh, lastActiveAt: now - DAILY_ADVANCE_MS }, now))
    ok('没有状态记录时不动（首次由创建会话时初始化）', !shouldAdvanceDaily(null, now))
    ok('lastActiveAt 为 0 时不动（脏数据别乱算）', !shouldAdvanceDaily({ ...fresh, lastActiveAt: 0 }, now))

    ok('时间差算天数：2 天', daysSince(now - 2 * 24 * HOUR, now) === 2)
    ok('不足一天按 1 天算（不写「过了 0 天」）', daysSince(now - 9 * HOUR, now) === 1)

    ok('emptyDaily 以当前时间为起点', emptyDaily('c', now).lastActiveAt === now)
  }

  // ---------- 2) 段落解析 ----------
  {
    const p = parseDailyReply(DAILY_REPLY)
    ok('解析出两条日志', p.log.length === 2, `实际=${p.log.length}`)
    ok('日志带日期与内容', p.log[0].date === '09-16' && p.log[0].text.includes('冷柜'))
    ok('心情解析出来且不带句号', p.mood === '有点烦', p.mood)
    ok('留言解析出来（含动作行）', p.greeting.includes('绿萝活过来了') && p.greeting.includes('找零'))

    // ⚠️ 关键回归：日志行里出现「心情」二字不能被当成段落标题
    const tricky = ['【这几天的生活】', '- 09-16：心情不错，买了束花。', '【她的心情】平静', '【她想说的话】「嗯。」'].join('\n')
    const t2 = parseDailyReply(tricky)
    ok('日志行里的「心情」二字不误判为段落标题', t2.log.length === 1 && t2.log[0]?.text.includes('买了束花'), JSON.stringify(t2.log))
    ok('误判修复后 mood 仍解析正确', t2.mood === '平静', t2.mood)

    // 宽松标题
    const loose = ['一、这几天的生活', '09-16：修好了卷帘门。', '二、她的心情', '尚且平静', '三、想说的话', '（无）'].join('\n')
    const t3 = parseDailyReply(loose)
    ok('标题加中文序号也认', t3.log.length === 1 && t3.mood === '尚且平静', JSON.stringify({ log: t3.log, mood: t3.mood }))
    ok('「（无）」视为没有留言', t3.greeting === '', `实际=${t3.greeting}`)

    // 缺日期前缀
    const noDate = ['【这几天的生活】', '- 把店里的旧海报全撕了。', '【她的心情】', '烦躁', '【她想说的话】', '「别站门口。」'].join('\n')
    const t4 = parseDailyReply(noDate)
    ok('缺日期前缀也能解析（日期留空由调用方补）', t4.log.length === 1 && t4.log[0]?.date === '' && t4.log[0]?.text.includes('海报'))

    // 超量截断
    const many = ['【这几天的生活】', ...Array.from({ length: 9 }, (_, i) => `- 09-${String(20 - i).padStart(2, '0')}：第 ${i + 1} 天`)].join('\n')
    ok(`日志最多保留 ${DAILY_LOG_KEEP} 条`, parseDailyReply(many).log.length === DAILY_LOG_KEEP)

    ok('心情过长会被截断', parseDailyReply('【她的心情】\n烦躁但又有点说不上来的期待感').mood.length <= 8)
    ok('空输入不炸', parseDailyReply('').log.length === 0)
  }

  // ---------- 3) 提示词必须给当前日期（与总结同一个教训） ----------
  {
    const now = new Date('2026-09-16T12:00:00').getTime()
    const sys = buildDailySystem('苏念', now)
    ok('提示词含今天（否则日志写成占位符）', sys.includes('2026-09-16'), sys.slice(0, 60))
    ok('提示词写明倒序且给出条数上限', sys.includes('倒序') && sys.includes(`最多 ${DAILY_LOG_KEEP} 条`))
    ok('提示词要求贴住「做不到的事」（能力边界）', sys.includes('做不到的事'))
    ok('提示词要求留言温和（不质问）', sys.includes('温和') && sys.includes('不要问'))
    ok('提示词给了「不会主动开口」的出口', sys.includes('（无）'))
  }

  // ---------- 4) 跑一次推进（注入假模型） ----------
  {
    const char = await mkChar()
    const now = Date.now()
    const prev: DailyState = {
      charId: char.id,
      lastActiveAt: now - 2 * 24 * HOUR,
      log: [{ date: '09-13', text: '给货架换了标签。' }],
      mood: '照旧',
    }
    const { chatFn, calls } = makeFakeChat(DAILY_REPLY)
    const res = await advanceDaily({ char, prev, memory: null, chatFn, now })

    ok('新的一天排在最上面（倒序）', res.state.log[0].date === '09-16')
    ok('旧日志接在后面', res.state.log.some(l => l.date === '09-13'))
    ok('日志被合并而非覆盖', res.state.log.length === 3, `实际=${res.state.log.length}`)
    ok('心情更新', res.state.mood === '有点烦')
    ok('lastActiveAt 推进到当前', res.state.lastActiveAt === now)
    ok('留言一并产出（与推进同一次调用，省一次往返）', res.greeting.includes('绿萝'))

    const call = calls[0]
    ok('提示词含当前日期', String(call.messages[0].content).includes(new Date(now).getFullYear() + '-'))
    ok('输入带上了角色卡（她是谁）', String(call.messages[1].content).includes('外冷内热'))
    ok('输入写了过了几天', String(call.messages[1].content).includes('过了 2 天'))
    ok('输入带上之前的日志（避免重复写）', String(call.messages[1].content).includes('换了标签'))
    ok('关思考（不需要思考链）', call.opts.think === false)
    ok('未误传 json（输出是文本三段）', call.opts.json === undefined)
  }

  // ---------- 5) 同日去重与上限 ----------
  {
    const char = await mkChar()
    const now = Date.now()
    const prev: DailyState = {
      charId: char.id,
      lastActiveAt: now - 9 * HOUR,
      log: [{ date: '09-16', text: '今天已经写过一条了。' }],
      mood: '',
    }
    const { chatFn } = makeFakeChat(DAILY_REPLY) // 模型又给了 09-16
    const res = await advanceDaily({ char, prev, memory: null, chatFn, now })
    ok('同一天不重复叠加', res.state.log.filter(l => l.date === '09-16').length === 1, JSON.stringify(res.state.log.map(l => l.date)))
    ok('保留的新内容覆盖旧的同日条目', res.state.log.find(l => l.date === '09-16')?.text.includes('冷柜') ?? false)

    // 上限
    const longPrev: DailyState = {
      charId: char.id, lastActiveAt: now - 9 * HOUR,
      log: Array.from({ length: DAILY_LOG_KEEP }, (_, i) => ({ date: `08-${10 + i}`, text: `旧第 ${i} 天` })),
      mood: '',
    }
    const r2 = await advanceDaily({ char, prev: longPrev, memory: null, chatFn, now })
    ok(`日志总数不超过 ${DAILY_LOG_KEEP} 条`, r2.state.log.length === DAILY_LOG_KEEP, `实际=${r2.state.log.length}`)
  }

  console.log(`\ntavernDaily: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
