// ============ 酒馆模式 · 单向桥：小说角色 → 角色卡（方案 §7.6）============
//
// 三条必须成立的规矩：
//   ① **不许编造** —— 小说卡里没依据的信息一律留【待补】，绝不推测补全
//      （一张看起来完整、实则混了一半假信息的卡，比空着危险得多）
//   ② **丢掉剧透** —— 结局、后续发展、作者规划不能进角色卡（她不该知道自己后面会怎样）
//   ③ **结果只是草稿** —— 名字用原文的，且必须由作者在表单里审完再保存
import {
  buildImportSystem, renderNovelChar, parseCardDraft, draftGaps, convertNovelChar, MISSING_TAG,
} from '../src/lib/tavern/import'
import { emptyFreeCharacter } from '../src/lib/tavern/types'
import { saveProviders, saveActiveId, type ChatMessage } from '../src/lib/ai'
import { __resetMockStores } from './mock-memory'
import type { ChatFn } from '../src/lib/tavern/engine'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function makeFakeChat(reply: string) {
  const calls: { messages: ChatMessage[]; opts: Record<string, unknown> }[] = []
  const chatFn: ChatFn = async (_cfg, messages, opts) => {
    calls.push({ messages, opts: (opts ?? {}) as Record<string, unknown> })
    return reply
  }
  return { chatFn, calls }
}

const NOVEL_REPLY = [
  '【第 1 章 · 世界】',
  '现代都市。她是老城区便利店的夜班店员，你是常来的顾客。',
  '',
  '【2.1 外在】',
  '短发，灰色围裙，左手腕有道旧疤。',
  '【2.2 内核】',
  '外冷内热，嘴上不留情。',
  '【2.3 语言特征】',
  '句子短，习惯用反问，不说软话。',
  '【2.4 关系】',
  '独居，父母在老家。',
  '【2.5 做不到的事】',
  '说不出关心的话。',
  '【2.6 知识边界】',
  MISSING_TAG + '（原著未交代她是否知道顾客的职业）',
  '',
  '【第 3 章 · 行为规范】',
  '视角与人称：第一人称，只描写她自己的动作与感官。',
  '底线清单：不越界打听私事。',
  '进度锁：推进要慢。',
  '尺度：日常向。',
  '',
  '【第 4 章 · 示例对话】',
  '〖对方〗这么晚还不下班？',
  '她把找零推过去，没抬头：',
  '「灯还亮着。」',
].join('\n')

async function main() {
  __resetMockStores()
  await saveProviders([{ id: 'imp-stub', name: '桩', type: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'stub' }])
  await saveActiveId('imp-stub')

  // ---------- 1) 提示词必须写死的三条 ----------
  {
    const sys = buildImportSystem()
    ok('写死「不许编造」且给出【待补】标记', sys.includes('不许编造') && sys.includes(MISSING_TAG))
    ok('写死「丢掉剧透」（她不该知道自己后面会怎样）', sys.includes('剧透') && sys.includes('结局'))
    ok('写死示例对话的格式要求：对方用输入侧符号 〖对方〗、自己不加前缀',
      sys.includes('用〖对方〗起头') && sys.includes('不加引号、不加括号、不写名字'))
    ok('写死输出标记：除对白外一律全角括号（ ）（v1.7 起【】已废止）',
      sys.includes('全角括号（ ）') && !sys.includes('方头括号'))
    ok('四章标题用输入侧符号 〖〗（不与输出标记撞车）',
      sys.includes('〖第 1 章 · 世界〗') && !sys.includes('【第 1 章 · 世界】'))
    ok('说明「改写而非照抄」的理由（设定 → 行为倾向；代词已中性化为 Ta）',
      sys.includes('该怎么演Ta') && sys.includes('改写'))
    ok('四章标题齐全', ['第 1 章 · 世界', '2.1 外在', '2.6 知识边界', '第 3 章 · 行为规范', '第 4 章 · 示例对话']
      .every(t => sys.includes(t)))
  }

  // ---------- 2) 小说卡渲染 ----------
  {
    const data = {
      '一、基础信息::姓名': '苏念',
      '一、基础信息::别称': '',
      '二、性格与动机::核心性格': '外冷内热',
      '二、性格与动机::核心动机': '   ',
      '三、能力与剧情::结局归宿': '卷六兵解',
    }
    const text = renderNovelChar('苏念', data)
    ok('键去掉「模块::」前缀', text.includes('姓名：苏念') && !text.includes('一、基础信息::'))
    ok('空值行被跳过', !text.includes('别称') && !text.includes('核心动机'))
    ok('开头带角色名', text.startsWith('【角色名】苏念'))
  }

  // ---------- 3) 四章草稿解析 ----------
  {
    const d = parseCardDraft(NOVEL_REPLY)
    ok('第 1 章解析出来', d.world.includes('便利店'))
    ok('2.1 外在解析出来', d.profile.externals.includes('围裙'))
    ok('2.3 语言特征解析出来（最影响像不像）', d.profile.speech.includes('反问'))
    ok('2.6 知识边界解析出来（含待补标记）', d.profile.knowledge.includes(MISSING_TAG))
    ok('第 3 章四项解析出来', d.conduct.perspective.includes('第一人称') && d.conduct.rating.includes('日常向'))
    ok('第 4 章示例解析出来（多行保留）', d.examples.includes('灯还亮着') && d.examples.includes('〖对方〗'))

    // 宽松标题 + 标题内容同行
    const loose = [
      '1. 世界', '校园。',
      '【2.2 内核】爱笑，藏不住事',
      '## 2.5 做不到的事', '撒谎会被一眼看穿',
      '示例对话', '〖对方〗早啊\n「嗯。」',
    ].join('\n')
    const d2 = parseCardDraft(loose)
    ok('标题带序号 / 加粗 / 无书名号都认', d2.world === '校园。' && d2.profile.cannot.includes('撒谎'))
    ok('标题与内容同行也能拆出来', d2.profile.core.includes('爱笑'), d2.profile.core)
    ok('示例对话的简称也认', d2.examples.includes('早啊'))

    const empty = parseCardDraft('')
    ok('空输入返回空草稿而不炸', empty.world === '' && empty.examples === '')
    ok('空草稿结构完整（不漏字段）', JSON.stringify(Object.keys(empty.profile).sort()) === JSON.stringify(Object.keys(emptyFreeCharacter().profile).sort()))
  }

  // ---------- 4) 欠着信息的地方要报出来 ----------
  {
    const gaps = draftGaps(parseCardDraft(NOVEL_REPLY))
    ok('检出含【待补】的章节', gaps.some(g => g.includes('第 1 章') || g.includes('2.6') || g.includes('内核')), gaps.join('、'))
    ok('缺示例对话时明确提醒「通常是模型编的」', draftGaps(parseCardDraft('【第 1 章 · 世界】\n某地。')).some(g => g.includes('通常是模型编的')))
    ok('四章齐全且无待补时无提醒', draftGaps(parseCardDraft(NOVEL_REPLY.replace(MISSING_TAG, '她不知道顾客的职业'))).length === 0,
      draftGaps(parseCardDraft(NOVEL_REPLY.replace(MISSING_TAG, '某某'))).join('、'))
  }

  // ---------- 5) 跑一次转换（注入假模型） ----------
  {
    const { chatFn, calls } = makeFakeChat(NOVEL_REPLY)
    const data = { '一、基础信息::姓名': '苏念（被模型改成了别的名字也不该采纳）', '二、性格与动机::核心性格': '外冷内热', '三、能力与剧情::结局归宿': '卷六兵解' }
    const { draft, gaps } = await convertNovelChar({
      name: '苏念',
      data,
      source: { projectId: 'proj-1', cardId: 'card-9' },
      chatFn,
    })

    ok('🔴 名字用原文，不采纳模型改的名字', draft.name === '苏念', draft.name)
    ok('溯源信息写入 importedFrom', draft.importedFrom?.projectId === 'proj-1' && draft.importedFrom?.cardId === 'card-9')
    ok('溯源带时间戳', typeof draft.importedFrom?.at === 'number')
    ok('草稿内容被解析出来', draft.profile.speech.includes('反问'))
    ok('欠信息处一并回报', gaps.length > 0, gaps.join('、'))

    const call = calls[0]
    ok('小说卡原文交给模型', String(call.messages[1].content).includes('外冷内热'))
    ok('关思考（转换是整理活儿）', call.opts.think === false)
    ok('未误传 json（输出是段落标记）', call.opts.json === undefined)
    ok('提示词在 system 位', String(call.messages[0].content).includes(MISSING_TAG))
  }

  console.log(`\ntavernImport: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
