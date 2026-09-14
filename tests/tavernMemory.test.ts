// ============ 酒馆模式 · 六栏记忆与总结引擎（方案 §4.5 / §4.6）============
//
// 这组断言盯的是方案里反复强调的三条：
//   1) **六栏行为不同** —— 长期摘要会缩、关键事实/未爆的雷只增不改、日记硬性滚动
//      （全部压缩 → 伏笔被抹掉；全部保留 → 无限膨胀。这是实测结论，不是洁癖）
//   2) **「只增」栏被模型整段丢掉 = 失忆**，必须保底（宁可沿用旧值）
//   3) **无服务端** —— 总结只能事件驱动（阈值 + 水位线 + 时间节流 + 锁），绝不轮询
import {
  MEMORY_SECTIONS, emptyMemory, memoryToText, memoryChars, isMemoryEmpty,
  parseMemoryText, rollDiaries, trimMemory,
  countUnsummarized, nextWatermark, shouldSummarize, shouldRunAutoSummary,
  acquireSummaryLock, releaseSummaryLock, throttleOk,
} from '../src/lib/tavern/memory'
import { summarizeMemory, buildSummarySystem, renderTranscript, formatDate } from '../src/lib/tavern/summarize'
import {
  MEMORY_HARD_LIMIT, MEMORY_LONGTERM_LIMIT, MEMORY_DIARY_DAYS,
  SUMMARY_MIN_INTERVAL_MS, SUMMARY_LOCK_TTL_MS,
  type FreeMemory, type TavernMessage,
} from '../src/lib/tavern/types'
import type { ChatFn } from '../src/lib/tavern/engine'
import { saveProviders, saveActiveId } from '../src/lib/ai'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 给锁测试装一个 localStorage 桩（node 默认没有） ----------
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
}
;(globalThis as unknown as { localStorage: unknown }).localStorage = new MemStorage()

const CHAR = 'c1'
const msg = (id: string, role: 'user' | 'assistant', content = '内容'): TavernMessage =>
  ({ id, role, content, at: 1 })

async function main() {
  // 总结会经 resolveTavernProvider 读配置（真实路径），先往内存存储放一个桩模型
  __resetMockStores()
  await saveProviders([{ id: 'stub-p', name: '桩模型', type: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'stub' }])
  await saveActiveId('stub-p')

  // ---------- 1) 序列化 / 解析往返 ----------
  {
    const m = emptyMemory(CHAR)
    ok('空记忆判定为白纸', isMemoryEmpty(m))
    const text = memoryToText(m)
    ok('空记忆序列化后六栏标题齐全', MEMORY_SECTIONS.every(s => text.includes(`【${s.title}】`)))
    ok('空栏显示为（暂无）', text.includes('（暂无）'))

    const full: FreeMemory = {
      ...m,
      longTerm: '她第一次让他进门修水管，顺手多煮了碗面。',
      facts: '她叫苏念，独居；他知道她怕黑。',
      relation: '礼貌但有距离，最近开始会主动发消息。',
      mines: '她没说自己为什么搬来这座城市。',
      anniversaries: '下周三她休假。',
      diaries: '- 03-15：一起修了水管\n- 03-14：第一次搭话',
      updatedAt: 0,
    }
    const round = parseMemoryText(memoryToText(full), CHAR)
    ok('往返后长期摘要一致', round.longTerm === full.longTerm)
    ok('往返后关键事实一致', round.facts === full.facts)
    ok('往返后日记一致', round.diaries === full.diaries)
    ok('字数统计不含栏目标题', memoryChars(full) < memoryToText(full).length)
  }

  // ---------- 2) 标题宽松匹配（模型不一定照抄格式） ----------
  {
    const variants = [
      '【一、长期摘要】\n甲',
      '一、长期摘要\n甲',
      '**一、长期摘要**\n甲',
      '### 长期摘要\n甲',
      '1. 长期摘要：甲',
    ]
    const bad = variants.filter(v => parseMemoryText(v, CHAR).longTerm !== '甲')
    ok('栏目标题宽松匹配（加粗/序号/去前缀都认）', bad.length === 0, `不认的写法=${bad.join(' | ')}`)
  }

  // ---------- 3) 「只增不改」两栏的保底保护 ----------
  {
    const prev: FreeMemory = {
      ...emptyMemory(CHAR),
      facts: '她怕黑；她养了只猫。',
      mines: '她没说过搬家原因。',
      longTerm: '旧摘要',
    }
    // 模型这次把两栏写空了（整段丢失）
    const got = parseMemoryText('【一、长期摘要】\n新摘要\n【二、关键事实】\n（暂无）\n【四、未爆的雷】\n', CHAR, prev)
    ok('关键事实整段丢失时沿用旧值（失忆比重复更糟）', got.facts === prev.facts, `实际=${got.facts}`)
    ok('未爆的雷整段丢失时沿用旧值', got.mines === prev.mines, `实际=${got.mines}`)
    ok('长期摘要允许被改写（它本来就该缩）', got.longTerm === '新摘要')

    // 模型给了新内容 → 用新的，不硬套旧的
    const upd = parseMemoryText('【二、关键事实】\n她怕黑；她养了只猫；她换了工作。', CHAR, prev)
    ok('模型给出新内容时以新为准', upd.facts.includes('换了工作'))
  }

  // ---------- 4) 日记硬性滚动 ----------
  {
    const many = Array.from({ length: 9 }, (_, i) => `- 03-${String(20 - i).padStart(2, '0')}：第 ${i + 1} 条`).join('\n')
    const rolled = rollDiaries(many)
    ok(`日记只保留最近 ${MEMORY_DIARY_DAYS} 条`, rolled.split('\n').length === MEMORY_DIARY_DAYS, `实际=${rolled.split('\n').length}`)
    ok('保留的是最上面（最新）的几条', rolled.startsWith('- 03-20'))
    ok('（暂无）占位不算一条日记', rollDiaries('（暂无）') === '')
  }

  // ---------- 5) 长期摘要上限与总量硬约束 ----------
  {
    const long = '甲'.repeat(MEMORY_LONGTERM_LIMIT + 200)
    const t = trimMemory({ ...emptyMemory(CHAR), longTerm: long })
    ok('长期摘要被截到上限内', t.longTerm.length <= MEMORY_LONGTERM_LIMIT, `实际=${t.longTerm.length}`)

    // 构造超大档案：只增两栏必须原样保留，其余被压缩
    const heavy: FreeMemory = {
      ...emptyMemory(CHAR),
      longTerm: '乙'.repeat(1200),
      facts: '丙'.repeat(400),
      mines: '丁'.repeat(400),
      relation: '戊'.repeat(400),
      anniversaries: '己'.repeat(400),
      diaries: Array.from({ length: 20 }, (_, i) => `- 03-${i}：${'庚'.repeat(60)}`).join('\n'),
    }
    const trimmed = trimMemory(heavy)
    ok('总量被压到硬上限以内', memoryChars(trimmed) <= MEMORY_HARD_LIMIT + 40, `实际=${memoryChars(trimmed)}`)
    ok('压缩时不牺牲「关键事实」（不失忆的底线）', trimmed.facts === heavy.facts)
    ok('压缩时不牺牲「未爆的雷」', trimmed.mines === heavy.mines)
  }

  // ---------- 6) 水位线 / 阈值 ----------
  {
    const msgs = [msg('a', 'user'), msg('b', 'assistant'), msg('c', 'user'), msg('d', 'assistant')]
    ok('没有水位线时全部算未总结', countUnsummarized({ messages: msgs }) === 4)
    ok('水位线之后只数新消息', countUnsummarized({ messages: msgs, watermark: { messageId: 'b', at: 0 } }) === 2)
    ok('水位线在最后一条时无需总结', countUnsummarized({ messages: msgs, watermark: { messageId: 'd', at: 0 } }) === 0)
    ok('水位线消息被删（异常）时保守按全部未总结', countUnsummarized({ messages: msgs, watermark: { messageId: '不存在', at: 0 } }) === 4)
    ok('system 消息不计入', countUnsummarized({ messages: [...msgs, msg('s', 'user')], watermark: { messageId: 'd', at: 0 } }) === 1)

    ok('新消息满 6 条触发总结', shouldSummarize({ messages: Array.from({ length: 6 }, (_, i) => msg(String(i), 'user')) }))
    ok('不足 6 条不触发', !shouldSummarize({ messages: Array.from({ length: 5 }, (_, i) => msg(String(i), 'user')) }))

    const wm = nextWatermark({ messages: msgs })
    ok('水位线推进到最后一条', wm?.messageId === 'd')
    ok('空会话不产生水位线', nextWatermark({ messages: [] }) === null)
  }

  // ---------- 7) 三层防重 ----------
  {
    const six = Array.from({ length: 6 }, (_, i) => msg(String(i), 'user'))

    // ① 时间节流
    const fresh: FreeMemory = { ...emptyMemory(CHAR), updatedAt: Date.now() }
    ok('刚总结过 → 时间节流拦下', !throttleOk(fresh))
    ok('很久没总结 → 放行', throttleOk({ ...fresh, updatedAt: Date.now() - SUMMARY_MIN_INTERVAL_MS - 1 }))
    ok('没有档案（首次）→ 放行', throttleOk(null))

    const r1 = shouldRunAutoSummary({ messages: six }, fresh)
    ok('时间节流时给出可读原因', !r1.run && r1.reason.includes('节流'), r1.reason)
    const r2 = shouldRunAutoSummary({ messages: six }, null)
    ok('条件满足时判定该跑', r2.run)

    // ② 跨实例锁 ③ TTL 兜底
    releaseSummaryLock()
    ok('无锁时可取', acquireSummaryLock())
    ok('已被取走时取不到（挡住两个窗口同时跑）', !acquireSummaryLock())
    releaseSummaryLock()
    ok('释放后可再取', acquireSummaryLock())
    // 模拟「上次跑到一半崩了」：写一个陈旧时间戳
    ;(globalThis as unknown as { localStorage: MemStorage }).localStorage.setItem('yfe-tavern-summary-lock', String(Date.now() - SUMMARY_LOCK_TTL_MS - 1000))
    ok('陈旧锁超过 TTL 可被接管', acquireSummaryLock())
    releaseSummaryLock()
  }

  // ---------- 8) 总结提示词必须给的两样（方案 §4.6 明确点出） ----------
  {
    const sys = buildSummarySystem('苏念', new Date('2026-03-15T10:00:00').getTime())
    ok('提示词含当前日期（否则日记写成占位符）', sys.includes('2026-03-15'), sys.slice(0, 80))
    ok('提示词写死了「未爆的雷」的定义', sys.includes('伏笔') && sys.includes('未说出口') && sys.includes('不要写'))
    ok('提示词讲清了六栏行为不同（会缩/只增/重写/滚动）', sys.includes('会缩') && sys.includes('只增不改') && sys.includes('倒序'))
    ok('提示词要求倒序日记并给出条数上限', sys.includes(`最近 ${MEMORY_DIARY_DAYS} 条`))
    ok('提示词写明「她不知道的事不能进长期摘要」', sys.includes('绝不能进'))

    const tr = renderTranscript('苏念', [msg('a', 'user', '今天冷'), msg('b', 'assistant', '嗯')])
    ok('对话渲染：用户标【对方】、角色标名字', tr.includes('【对方】今天冷') && tr.includes('【苏念】嗯'))
    ok('对话渲染跳过空内容', !renderTranscript('苏念', [msg('x', 'user', '   ')]).includes('【对方】'))
    ok('日期格式化补零', formatDate(new Date('2026-03-05T00:00:00').getTime()) === '2026-03-05')
  }

  // ---------- 9) 跑一次总结（注入假模型） ----------
  {
    const reply = [
      '【一、长期摘要】', '她开始习惯他每周三来修东西。',
      '', '【二、关键事实】', '她叫苏念，独居，怕黑。',
      '', '【三、关系状态】', '从陌生到会主动发消息，心情偏放松。',
      '', '【四、未爆的雷】', '她一直没解释为什么搬来这座城市。',
      '', '【五、纪念日与待办】', '下周三她休假。',
      '', '【六、最近日记】', '- 03-15：一起修了水管', '- 03-14：第一次搭话',
    ].join('\n')

    const calls: { messages: { role: string; content: string }[]; opts: Record<string, unknown> }[] = []
    const chatFn: ChatFn = async (_cfg, messages, opts) => {
      calls.push({ messages: messages as never, opts: (opts ?? {}) as Record<string, unknown> })
      return reply
    }

    const prev: FreeMemory = {
      ...emptyMemory(CHAR),
      facts: '她叫苏念。',
      mines: '搬来原因未知。',
      updatedAt: Date.now() - SUMMARY_MIN_INTERVAL_MS - 1,
    }
    const got = await summarizeMemory({
      charId: CHAR, charName: '苏念', prev,
      messages: [msg('a', 'user', '在吗'), msg('b', 'assistant', '在')],
      charContext: '世界：现代都市，老城区的便利店。她是店员。',
      chatFn,
    })
    ok('总结结果六栏都解析出来了', got.longTerm.includes('修东西') && got.facts.includes('苏念') && got.diaries.includes('03-15'))
    ok('总结后刷新了 updatedAt（供时间节流）', got.updatedAt > prev.updatedAt)

    const call = calls[0]
    ok('总结把旧档案交给模型（改写而非追加）', String(call.messages[1].content).includes('旧档案'))
    ok('提示词含「以角色背景为事实基准」（防止把设定记漂移）',
      String(call.messages[0].content).includes('事实基准'))
    ok('角色背景随输入交给模型（否则它会臆断「她在哪、是谁」）',
      String(call.messages[1].content).includes('便利店'))
    ok('总结只带水位线之后的对话', !String(call.messages[1].content).includes('不该出现'))
    ok('总结用低温（忠实整理，不是创作）', call.opts.temperature === 0.3, `实际=${call.opts.temperature}`)
    ok('总结关思考（整理活儿不需要思考链）', call.opts.think === false)
    ok('总结未误用 json 开关（输出是文本档案）', call.opts.json === undefined)

    // 空对话时不该调模型
    const before = calls.length
    const same = await summarizeMemory({ charId: CHAR, charName: '苏念', prev, messages: [], chatFn })
    ok('没有新对话时直接返回旧档案、不调模型', calls.length === before && same === prev)
  }

  console.log(`\ntavernMemory: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
