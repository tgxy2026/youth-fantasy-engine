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
  nextWatermark, acquireSummaryLock, releaseSummaryLock,
} from '../src/lib/tavern/memory'
import { summarizeMemory, buildSummarySystem, renderTranscript, formatDate, buildColdStartSystem, coldStartMemory, draftMemoryFromCard } from '../src/lib/tavern/summarize'
import {
  MEMORY_HARD_LIMIT, MEMORY_LONGTERM_LIMIT, MEMORY_DIARY_DAYS,
  SUMMARY_LOCK_TTL_MS, emptyFreeCharacter,
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
    ok('空记忆序列化后六栏标题齐全（用输入侧 〖〗）',
      MEMORY_SECTIONS.every(s => text.includes(`〖${s.title}〗`)))
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

  // ---------- 3b) 占位清洗（审计 P0-2）----------
  // 提示词给模型留了写占位的话口（「确实没有就写『暂无』」），旧实现只认「（暂无）」一种 ——
  // 于是「暂无」/「-」/「（还没有发生过任何事）」变成**永久记忆内容**：每轮注入白占额度，
  // 状态栏还把「暂无」数成一条。下面把每一种写法都钉住。
  {
    for (const c of ['暂无', '（暂无）', '-', '—', '（还没有发生过任何事）', '尚未发生', '无', '略', '...']) {
      const got = parseMemoryText(`〖四、未爆的雷〗\n${c}\n`, CHAR, null)
      ok(`占位「${c}」被清成空`, got.mines === '', JSON.stringify(got.mines))
    }
    const mixed = parseMemoryText('〖四、未爆的雷〗\nTa把信藏进了抽屉\n（暂无）\n', CHAR, null)
    ok('混在真内容里的占位行也被丢掉', mixed.mines === 'Ta把信藏进了抽屉', JSON.stringify(mixed.mines))
    const real = parseMemoryText('〖四、未爆的雷〗\n她嘴上说「暂无」安排，其实早定了\n', CHAR, null)
    ok('真内容里出现占位词不受影响', real.mines.includes('其实早定了'), JSON.stringify(real.mines))
    ok('日记栏的占位也认（「-」不算一条）', rollDiaries('-') === '' && rollDiaries('—') === '')
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

  // ---------- 6) 水位线 ----------
  // 🚫 2026-09-16：`countUnsummarized` / `shouldSummarize`（条数阈值）已随**自动整理**一并删除
  //    —— 项目改为作者手动触发整理。只剩水位线推进这一条纯逻辑要盯。
  {
    const msgs = [msg('a', 'user'), msg('b', 'assistant'), msg('c', 'user'), msg('d', 'assistant')]
    const wm = nextWatermark({ messages: msgs })
    ok('水位线推进到最后一条', wm?.messageId === 'd')
    ok('空会话不产生水位线', nextWatermark({ messages: [] }) === null)
  }

  // ---------- 7) 防重锁（时间节流已废除，只剩跨实例锁 + TTL） ----------
  {
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
    ok('写明记忆与设定的分界（记忆＝事件与温度，设定＝定义）',
      sys.includes('发生过什么') && sys.includes('定称'))
    ok('要求不复述角色卡里的稳定属性', sys.includes('一律不要复述'))

    const tr = renderTranscript('苏念', [msg('a', 'user', '今天冷'), msg('b', 'assistant', '嗯')])
    ok('对话渲染：用户标〖对方〗、角色标名字', tr.includes('〖对方〗今天冷') && tr.includes('〖苏念〗嗯'))
    ok('对话渲染跳过空内容', !renderTranscript('苏念', [msg('x', 'user', '   ')]).includes('〖对方〗'))
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
      updatedAt: Date.now() - 3600_000,
    }
    const got = await summarizeMemory({
      charId: CHAR, charName: '苏念', prev,
      messages: [msg('a', 'user', '在吗'), msg('b', 'assistant', '在')],
      charContext: '世界：现代都市，老城区的便利店。她是店员。',
      chatFn,
    })
    ok('总结结果六栏都解析出来了', got.longTerm.includes('修东西') && got.facts.includes('苏念') && got.diaries.includes('03-15'))
    ok('总结后刷新了 updatedAt（界面据此显示「更新于」）', got.updatedAt > prev.updatedAt)

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

  // ---------- 冷启动记忆：导入 / 新建的角色卡不该是空记忆（老大 2026-09-14 定） ----------
  {
    // 2026-09-15：项目原生不再预填示范卡，这里自造两张最小卡来验「从卡离线摘录」。
    // 只保断言用得到的字段：world 的地名 → 长期摘要；externals 与 core 的「出身」行 → 关键事实；
    // relations → 关系状态；core 的「不肯说出口的事」行 → 未爆的雷。
    const chu = {
      ...emptyFreeCharacter(),
      name: '楚楠',
      world: '第1章 奉阳市。他十九岁，金融大一，一个人住。',
      profile: {
        ...emptyFreeCharacter().profile,
        externals: '姓名：楚楠。十九岁，金融大一。',
        core: '出身：父母在他七岁那年离婚，之后搬过三次家。\n不肯说出口的事：他怕黑，也怕一个人待着。',
        relations: '苏念：从小认识，高中三年同班。\n洛汐：妹妹，十七岁。',
      },
    }
    const sn = {
      ...emptyFreeCharacter(),
      name: '苏念',
      world: '第1章 奉阳市。她十八岁，法律大一。',
      profile: {
        ...emptyFreeCharacter().profile,
        externals: '姓名：苏念。十八岁。',
        core: '出身：普通家庭，父母都在。\n不肯说出口的事：她喜欢他，一个字都没说过。',
        relations: '楚楠：高中三年同班，大学同校。',
      },
    }

    // ① 确定性兜底：不调模型，直接从卡片摘
    const d1 = draftMemoryFromCard({ ...chu, id: 'c1', createdAt: 0, updatedAt: 0 })
    ok('兜底版：长期摘要带「初版」标注（不冒充 AI 整理）', d1.longTerm.startsWith('（初版'))
    ok('兜底版：长期摘要摘到了第 1 章世界', d1.longTerm.includes('奉阳市'))
    ok('兜底版：关键事实含 2.1 与内核里的既成事实',
      d1.facts.includes('姓名：楚楠') && d1.facts.includes('父母在他七岁那年离婚'))
    ok('兜底版：关系状态把卡片里的既有关系整段带进来',
      d1.relation.includes('苏念') && d1.relation.includes('洛汐'))
    ok('兜底版：日记与纪念日留空（还没发生任何事）', !d1.diaries && !d1.anniversaries)
    ok('兜底版：六栏不是全空', !isMemoryEmpty(d1))

    const d2 = draftMemoryFromCard({ ...sn, id: 'c2', createdAt: 0, updatedAt: 0 })
    ok('兜底版：「未爆的雷」从「不肯说出口的事」摘到', d2.mines.includes('她喜欢他'), d2.mines.slice(0, 30))

    // ② AI 版：注入 chatFn 给一段六栏文本
    const reply = [
      '〖一、长期摘要〗', '他在青宜大学城做影像，租的房子离洛汐宿舍两站公交。',
      '〖二、关键事实〗', '苏念七岁起就在他家；洛汐是女朋友，在一起四个月。',
      '〖三、关系状态〗', '洛汐：怕被丢下。苏念：把他当锚点。',
      '〖四、未爆的雷〗', '洛汐在偷偷准备转专业；苏念生日那晚的事他只讲了一半。',
      '〖五、纪念日与待办〗', '暂无',
      '〖六、最近日记〗', '-',
    ].join('\n')
    const ai = await coldStartMemory({
      charId: 'c1', charName: '楚楠', charContext: '（角色卡四章）', chatFn: async () => reply,
    })
    ok('AI 版：解析出六栏', !isMemoryEmpty(ai) && ai.facts.includes('洛汐'))
    ok('AI 版：伏笔进了「只增」栏（未爆的雷）', ai.mines.includes('转专业'))

    // ③ 模型乱答 → 抛错（调用方据此回落兜底版）
    let threw = false
    try {
      await coldStartMemory({ charId: 'c1', charName: '楚楠', charContext: 'x', chatFn: async () => '好的，我来整理一下。' })
    } catch { threw = true }
    ok('AI 版：模型不按六栏输出时抛错', threw)

    // ④ 冷启动提示词口径
    const sys = buildColdStartSystem('楚楠', 0)
    ok('冷启动提示词写明这是第一次建档', sys.includes('第一次建档'))
    ok('冷启动提示词要求只依据角色背景、不许编造',
      sys.includes('只依据〖角色背景〗') && sys.includes('不要编造'))
    ok('冷启动提示词要求日记留空', sys.includes('最近日记：留空'))
    ok('冷启动写明「还没有事件可记」，关键事实留占位（不抄定义性属性）',
      sys.includes('还没有任何事件可记') && sys.includes('还没有发生过任何事'))
  }

  console.log(`\ntavernMemory: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
