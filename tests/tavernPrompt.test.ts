// ============ 酒馆模式 · 提示词组装 / 预算裁剪 / 参数继承（纯函数）============
//
// 这一层没有 UI、没有 IO，是全模块最该被测试锁住的部分。
// 盯住三条**踩过坑 / 有明确依据**的性质：
//   1) 层序 —— 手册实测顺序是「角色卡 → 记忆 → 协议收尾」，协议钉在**末尾**
//   2) 协议全文完整 —— 协议是从手册逐行搬来的内置常量，条款掉了就等于功能瘫了
//   3) 参数改名 —— 内部 repeatPenalty 到 Ollama 那边叫 repeat_penalty（少个 ition）
import {
  buildSystemPrompt, buildOpeningMessage, buildMultiCharRule, toChatMessages, renderCastSetting,
  buildSameNameNote, buildSceneDescriptionRule,
} from '../src/lib/tavern/prompt'
import { PROTOCOL_CORE, PROTOCOL_VERSION } from '../src/lib/tavern/protocol'
import { DEFAULT_COMMON_EXTRA } from '../src/lib/tavern/settings'
import { trimHistory, historyBudget, FIXED_OVERHEAD_CHARS } from '../src/lib/tavern/budget'
import { resolveParams, toOllamaOptions } from '../src/lib/tavern/params'
import { hasCastSetting, EMPTY_CAST_SETTING } from '../src/lib/tavern/types'
import type { TavernMessage, CastSetting } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function main() {
  // ---------- 1) 协议全文完整性（内置常量，条款掉了功能就瘫） ----------
  {
    // 版本号不再写死（每次改协议正文都要同步升版）：只断言「版本号与正文标题一致、且是 v1.x」，
    // 这样以后 bump 不必改测试，而「改了正文忘了升版」仍会被逮住。
    ok('协议版本号与正文标题一致',
      /^v1\.\d+$/.test(PROTOCOL_VERSION) && PROTOCOL_CORE.includes(`协议 · ${PROTOCOL_VERSION}`))
    const rules = ['R1', 'R2', 'R3', 'R4', 'R5', 'B1', 'B5', 'B8', 'B9', 'O1', 'O2', 'O3', 'O4', 'M1', 'M2', 'E1', 'E2', 'E3']
    const missing = rules.filter(r => !PROTOCOL_CORE.includes(`\n${r} `))
    ok('协议含全部条款编号（R/B/O/M/E 五节）', missing.length === 0, `缺=${missing.join(',')}`)
    ok('协议含五段标题', ['元规则', '怎么演得像', '写成什么样', '记忆与状态', '退出与归档'].every(s => PROTOCOL_CORE.includes(s)))
    ok('协议含「最后提醒」收尾段（近因效应，紧贴生成点）', PROTOCOL_CORE.includes('最后提醒'))
    // v1.4：换场纪律 —— 实弹里模型把场景从宿舍楼道一步挪到食堂，只补了句【食堂很吵】
    ok('协议含换场纪律（B2：地点不归你搬 / 要换场先写怎么到的 / 描写不等于移动）',
      PROTOCOL_CORE.includes('地点不归你搬') && PROTOCOL_CORE.includes('先写清「怎么到的」')
      && PROTOCOL_CORE.includes('不是**移动**'))
    ok('换场纪律同时进了「最后提醒」（贴着生成点再压一次）',
      PROTOCOL_CORE.includes('地点与时间立住了就别自己搬'))
    // v1.5：给「动作必须进括号」补一条**一眼能自查的判据**（罗列要求不如给判定标准）
    ok('「最后提醒」里也留了这条判据（贴着生成点再压一次）',
      PROTOCOL_CORE.includes('没有（ ）的行，只能是被说出口的话'))
    ok('协议含防代笔主句（R2 守住彼此的边界）', PROTOCOL_CORE.includes('守住彼此的边界') && PROTOCOL_CORE.includes('不替用户决定'))
    ok('协议含篇幅硬约束（60–160 字 / 最多 2 行 / 最多 2 句）',
      PROTOCOL_CORE.includes('60–160 字') && PROTOCOL_CORE.includes('最多 2 行') && PROTOCOL_CORE.includes('最多 2 句'))
    ok('协议含元指令通道三种写法（// · # · 「」 · [OOC:]）',
      PROTOCOL_CORE.includes('[OOC: ') && PROTOCOL_CORE.includes('导演指令'))
    ok('协议含存档归档格式（E1）', PROTOCOL_CORE.includes('归档 · ') && PROTOCOL_CORE.includes('文风锚'))
    ok('协议明确禁止 markdown 与名字前缀', PROTOCOL_CORE.includes('markdown') && PROTOCOL_CORE.includes('不加“角色名：“') === false && PROTOCOL_CORE.includes('角色名：'))

    // —— v1.6 的输出规范（老大 2026-09-15 的妥协方案：不再分两套括号，非对白一律用（ ））——
    ok('🔴 O1 只留一套括号：除对白之外的一切都用（ ）',
      PROTOCOL_CORE.includes('除对白之外的一切') &&
      PROTOCOL_CORE.includes('**全部用全角圆括号（ ）包住**') &&
      !PROTOCOL_CORE.includes('方头括号【 】'))
    ok('🔴 O1 要求「一件事一个括号、一句一行」（分层）',
      PROTOCOL_CORE.includes('一件事一个括号、一句一行'))
    ok('O1 给了自查判据：不在括号里的行只能是被说出口的话',
      PROTOCOL_CORE.includes('不在括号里的行，只能是被说出口的话'))
    ok('🔴 O1 不再许可〔数值〕记账行（改为整理记忆时算，协议里不该再提）',
      !PROTOCOL_CORE.includes('不计入篇幅') && !PROTOCOL_CORE.includes('系统若另有一行〔数值〕'))
    ok('🔴 O1 明确写出只有（ ）与〔 〕两种括号、【】已废止',
      PROTOCOL_CORE.includes('方头括号【】已废止') && PROTOCOL_CORE.includes('你只使用两种括号'))
    ok('最后提醒也点了【】已不用', PROTOCOL_CORE.includes('方头括号【】已经不用了'))
    ok('对白要求：不加引号、不加括号、不加任何说话人标记、正常标点',
      PROTOCOL_CORE.includes('**不加引号、不加括号、不加任何说话人标记**') &&
      PROTOCOL_CORE.includes('不写"角色名："这类前缀'))
    // v1.3 补的那个洞：只禁「名字：」前缀时，模型会把名字**单独起一行**当说话人标签（实弹踩到）
    ok('对白明确禁止「把说话人的名字单独写成一行」',
      PROTOCOL_CORE.includes('不要把说话人的名字单独写成一行'))
    ok('协议点名 〖对方〗 属输入侧标注、不在输出字母表里',
      PROTOCOL_CORE.includes('〖对方〗') && PROTOCOL_CORE.includes('输入侧的结构标注'))
    ok('状态块从【状态】迁到〔状态〕（【】已让给客观描写，不能撞车）',
      PROTOCOL_CORE.includes('〔状态〕') && !PROTOCOL_CORE.includes('【状态】'))
    ok('代词中性化：不再预设角色性别',
      PROTOCOL_CORE.includes('用 Ta 的眼睛看') && !PROTOCOL_CORE.includes('用他的眼睛看'))
    ok('明说输入侧的〖〗与〈〉是结构标注、不许写进输出',
      PROTOCOL_CORE.includes('输入侧的结构标注'))
    ok('最后提醒同步了新标记（单括号 + 一句一行）',
      PROTOCOL_CORE.includes('除了说出口的话，其余全部用（ ）包住'))

    // —— v1.9（老大反馈 #7：对话内描写改第三人称）——
    // 实弹里模型把「我」「你」写进括号（（我把杯子推到你面前）），读起来对不上人。
    // 规则要同时落在三处：O1（正主）、B1（视角与人称的分工）、最后提醒（贴生成点再压一次）。
    ok('🔴 O1 明文要求「描写一律第三人称」',
      PROTOCOL_CORE.includes('**描写一律第三人称**') &&
      PROTOCOL_CORE.includes('写名字、写「他」「她」「Ta」'))
    ok('🔴 给了正反例（括号里不写「我」「你」）',
      PROTOCOL_CORE.includes('（把杯子推到她面前）✓') &&
      PROTOCOL_CORE.includes('（我把杯子推到你面前）✗'))
    ok('🔴 划清边界：只管括号里的描写，对白照常说「我」「你」',
      PROTOCOL_CORE.includes('这条只管括号里的描写') && PROTOCOL_CORE.includes('对白里该说"我""你"就说'))
    ok('🔴 B1 把「认知视角」与「人称措辞」分开（免得与角色卡的人称设定打架）',
      PROTOCOL_CORE.includes('"视角"与"人称"分开看') && PROTOCOL_CORE.includes('**认知视角**按角色卡办'))
    ok('🔴 「最后提醒」也点了这条（近因效应，格式要求不复述就守不住）',
      PROTOCOL_CORE.includes('描写一律第三人称：括号里写名字、写他 / 她'))
    ok('O4「不要做这些」也补了这条', PROTOCOL_CORE.includes('不把"我""你"写进描写'))
    // #3 的改名（剧情进度→精神 / 当前地点→地点）必须同步到 M2，否则提示词里两个名字并存
    ok('🔴 M2 的字段名跟上了 #3 的改名（精神 / 地点）',
      PROTOCOL_CORE.includes('好感 / 信任 / 精神 / 心情 / 地点') &&
      !PROTOCOL_CORE.includes('剧情进度') && !PROTOCOL_CORE.includes('当前地点'))
  }

  // ---------- 2) 层序：设定 → 记忆 → 身份 → 协议（钉末尾） ----------
  {
    const sys = buildSystemPrompt({
      tone: 'narrative', setting: '沧澜山门规', memory: '她记得你救过她', self: '你是李默',
    })
    ok('协议钉在末尾（而非开头）', sys.trimEnd().endsWith('════ 协议结束 ════'), sys.slice(-30))
    ok('设定在最前', sys.startsWith('〖世界与角色设定〗'))
    ok('层序：设定 → 记忆 → 身份 → 协议',
      sys.indexOf('〖世界与角色设定〗') < sys.indexOf('〖长期记忆〗') &&
      sys.indexOf('〖长期记忆〗') < sys.indexOf('〖你在戏里的身份与知识边界〗') &&
      sys.indexOf('〖你在戏里的身份与知识边界〗') < sys.indexOf('════ 角色扮演通用协议'))
    ok('协议的最后提醒紧贴上下文末尾（中间不再插别的层）',
      sys.lastIndexOf('最后提醒') > sys.indexOf('〖你在戏里的身份与知识边界〗'))
  }

  // ---------- 3) 空层跳过 + 档位 ----------
  {
    const bare = buildSystemPrompt({ tone: 'chat' })
    ok('空层不留空标题', !bare.includes('〖世界与角色设定〗') && !bare.includes('〖长期记忆〗'))
    ok('仅协议时 system 就等于协议全文（叙事向不追加任何内容）', buildSystemPrompt({ tone: 'narrative' }) === PROTOCOL_CORE)
    ok('聊天向追加本场风格提示', bare.includes('〖本场风格〗') && bare.includes('最多连发 2 条'))
    ok('通用补充要求默认含「标点适用范围」（防「消息体无标点」被泛化到全篇）',
      DEFAULT_COMMON_EXTRA.includes('标点照常用') &&
      buildSystemPrompt({ tone: 'narrative', commonExtra: DEFAULT_COMMON_EXTRA }).includes('标点照常用'))
    ok('通用补充要求排在协议之前（不打断协议末尾的「最后提醒」）',
      (() => {
        const sys = buildSystemPrompt({ tone: 'chat', commonExtra: DEFAULT_COMMON_EXTRA })
        return sys.indexOf('标点照常用') >= 0 && sys.indexOf('标点照常用') < sys.indexOf('最后提醒')
      })())
    ok('叙事向不追加风格提示（协议默认即是）', !buildSystemPrompt({ tone: 'narrative' }).includes('〖本场风格〗'))
  }

  // ---------- 3b) 记忆层标题可关（多角色分块时正文自带标题，避免两层重复） ----------
  {
    const withTitle = buildSystemPrompt({ tone: 'narrative', memory: '六栏正文' })
    ok('默认给记忆层加「〖长期记忆〗」标题', withTitle.includes('〖长期记忆〗'))
    const noTitle = buildSystemPrompt({ tone: 'narrative', memory: '〖长期记忆 · 甲〗\n六栏正文', memoryTitle: null })
    ok('memoryTitle=null 时不再套外层标题（不出现两行「长期记忆」）',
      noTitle.startsWith('〖长期记忆 · 甲〗') && !noTitle.includes('〖长期记忆〗'))
  }

  // ---------- 4) 未带入资料如实声明 ----------
  {
    const d = buildSystemPrompt({ tone: 'narrative', dropped: ['分卷大纲', '伏笔追踪'] })
    ok('未带入的资料如实声明', d.includes('〖未带入的资料〗') && d.includes('分卷大纲'))
    ok('声明在协议之前（不打断协议末尾的提醒）', d.indexOf('〖未带入的资料〗') < d.indexOf('════ 角色扮演通用协议'))
  }

  // ---------- 5) 开场消息 ----------
  {
    const om = buildOpeningMessage(
      { place: '沧澜山门', time: '清晨', present: ['李默', '苏念'], description: '风很冷。' },
      '你先开口。',
    )
    ok('开场含场景三要素', om.includes('地点：沧澜山门') && om.includes('时间：清晨') && om.includes('在场：李默、苏念'))
    ok('开场含自由描述与第一句话', om.includes('风很冷。') && om.includes('你先开口。'))
    ok('空表单不产生空行噪音', buildOpeningMessage({ place: '', time: '', present: [], description: '' }, '喂') === '喂')
  }

  // ---------- 6) 多角色发言规则 ----------
  {
    const r = buildMultiCharRule(['苏念', '陆青梧'])
    ok('含「不说话的角色不要替它发言」', r.includes('不要替它发言'))
    ok('含「点名必须接话」', r.includes('必须接话'))
    ok('含「一次只让一个角色说话」', r.includes('一次只让一个角色说话'))
    ok('列出全部参演角色名', r.includes('苏念') && r.includes('陆青梧'))
    ok('默认（有「你演」角色）仍写「用户扮演用户自己的角色」', r.includes('用户扮演'))

    // 剧情模式允许一个「你演」位置都不设（整场交给 AI）—— 那种情况下
    // 这句「用户扮演…」必须消失，否则模型会去等一个并不存在的人开口
    const noUser = buildMultiCharRule(['苏念', '陆青梧'], { hasUser: false })
    ok('没有你演的角色时：不写「用户扮演」', !noUser.includes('用户扮演'))
    ok('没有你演的角色时：改写成「本场没有你演的角色，全部由你推进」', noUser.includes('全部由你推进'))
    ok('没有你演的角色时：角色名与发言约束照旧', noUser.includes('苏念') && noUser.includes('一次只让一个角色说话'))

    // A6（2026-09-14）：静音与健谈度 —— 只在多角色时才进规则
    const withSilent = buildMultiCharRule(['苏念', '陆青梧'], { silentNames: ['洛汐'] })
    ok('静音：声明「这一场不开口」并点名', withSilent.includes('这一场不开口') && withSilent.includes('洛汐'))
    ok('静音：要求不写成已经离开', withSilent.includes('不要写成 Ta 们已经离开'))
    ok('静音名单为空时：整句不出现', !buildMultiCharRule(['苏念']).includes('这一场不开口'))

    const withTalk = buildMultiCharRule(['苏念', '陆青梧'], { talkativity: [{ name: '苏念', value: 90 }, { name: '陆青梧', value: 10 }] })
    ok('健谈度：写成「发言分量」而不是硬性轮流', withTalk.includes('发言分量') && withTalk.includes('不是硬性轮流'))
    ok('健谈度：带档名与影响（与界面共用 TALK_BANDS）', withTalk.includes('话很多') && withTalk.includes('很安静'))
    const talkSeg = withTalk.slice(withTalk.indexOf('发言分量'))
    ok('健谈度：按值降序（话多的排在前面）', talkSeg.indexOf('苏念') < talkSeg.indexOf('陆青梧'))
    ok('健谈度：空数组时整句不出现', !buildMultiCharRule(['苏念'], { talkativity: [] }).includes('发言分量'))
  }

  // ---------- 7) 消息转换 ----------
  {
    const msgs: TavernMessage[] = [
      { id: '1', role: 'user', content: '你好', at: 1 },
      { id: '2', role: 'assistant', content: '嗯。', at: 2, speakerId: 'c1' },
      { id: '3', role: 'system', content: '（系统）', at: 3 },
    ]
    ok('跳过 system 消息（协议已单独成 system）', toChatMessages(msgs).length === 2)
    ok('不传 withSpeaker 时内容原样', toChatMessages(msgs)[1].content === '嗯。')
    // 隐藏的消息不进上下文 —— 这是「别让 AI 看见」的唯一出口（两条线都走它）
    const withHidden = [...msgs, { id: 'h1', role: 'assistant' as const, content: '这条不该被看见', at: 9, hidden: true }]
    ok('隐藏的消息不进上下文',
      toChatMessages(withHidden).length === toChatMessages(msgs).length &&
      !toChatMessages(withHidden).some(m => m.content.includes('不该被看见')))

    const tagged = toChatMessages(msgs, { withSpeaker: () => '〈苏念〉' })
    ok('多角色同场时给 assistant 标注说话人（〈名〉，与输出标记不同符号）', tagged[1].content.startsWith('〈苏念〉'))
    ok('用户消息不加说话人标记', tagged[0].content === '你好')
  }

  // ---------- 8) 历史裁剪 ----------
  {
    const mk = (n: number, len: number): TavernMessage => ({ id: String(n), role: 'user', content: 'x'.repeat(len), at: n })
    const hist = [mk(1, 100), mk(2, 100), mk(3, 100), mk(4, 100)]

    const t = trimHistory(hist, 250)
    ok('额度不足时裁掉最早的轮次', t.dropped === 2 && t.kept.length === 2, `dropped=${t.dropped} kept=${t.kept.length}`)
    ok('首轮开场永不裁剪', t.kept[0].id === '1')
    ok('保留的是较新的轮次', t.kept[1].id === '4')
    ok('额度充足时不裁', trimHistory(hist, 10000).dropped === 0)
    ok('空历史不报错', trimHistory([], 100).kept.length === 0 && trimHistory([], 100).dropped === 0)
    ok('单条历史不被裁掉', trimHistory([mk(1, 10)], 1).kept.length === 1)
    const zero = trimHistory(hist, 0)
    ok('预算为 0 时只留开场（不返回空）', zero.kept.length === 1 && zero.kept[0].id === '1' && zero.dropped === 3)
  }

  // ---------- 9) 预算计算 ----------
  {
    ok('historyBudget 扣掉固定开销', historyBudget(8000, '') === 8000 - FIXED_OVERHEAD_CHARS)
    // 🔴 2026-10-02：签名已删掉「记忆」形参（记忆恒在 system 里，单独传会重复扣额度）——
    //    「设定 + 记忆」的扣减现在只体现为 system 变长。
    ok('historyBudget 再扣 system（设定与记忆都在里面）', historyBudget(8000, 'a'.repeat(100) + 'b'.repeat(50)) === 8000 - FIXED_OVERHEAD_CHARS - 150)
    ok('额度不足时下限为 0（不出现负数）', historyBudget(100, 'x'.repeat(500)) === 0)
    // 2026-09-22 六维审计：`budgetState` / `BudgetState` 属「只为测试而活」的死导出
    // （生产代码零引用，注释说"供 UI 画占用条"但 UI 后来改走 summarizeUsage），
    // 已连同这三条断言一并删除 —— 它死于"没有调用方"，不是死于"测不出问题"。
  }

  // ---------- 10) 参数继承 ----------
  {
    ok('剧情默认温度 0.9（2026-09-15 由 0.85 放宽）', resolveParams('plot').temperature === 0.9)
    ok('自由默认温度更松（0.95）', resolveParams('free').temperature === 0.95)
    ok('高层覆盖低层', resolveParams('plot', { temperature: 1.2 }).temperature === 1.2)
    const layered = resolveParams('plot', { temperature: 1.0, topP: 0.5 }, { temperature: 1.2 })
    ok('逐层覆盖：会话参数压过角色参数', layered.temperature === 1.2 && layered.topP === 0.5)
    ok('忽略 undefined 层', resolveParams('plot', undefined, { topK: 7 }).topK === 7)
    ok('非法值（NaN/Infinity）不会污染默认值',
      resolveParams('plot', { temperature: NaN, topP: Infinity }).temperature === 0.9)
  }

  // ---------- 11) Ollama 字段映射（踩过坑的地方） ----------
  {
    const o = toOllamaOptions(resolveParams('plot'))
    ok('「重复惩罚」映射为 repeat_penalty（不是 repetition_penalty）',
      'repeat_penalty' in o && !('repetition_penalty' in o), Object.keys(o).join(','))
    ok('存在惩罚映射为 presence_penalty', 'presence_penalty' in o)
    ok('top_p / top_k 命名正确（下划线而非驼峰）', 'top_p' in o && 'top_k' in o && !('topP' in o))
    ok('显式带 num_ctx（否则按全局 128K 加载会爆显存）', o.num_ctx === 32768)
    // 2026-09-16：两把「治复读」的旋钮必须**真的下发** —— 不传时 Ollama 用自带默认
    //（repeat_last_n=64 只够半句话、frequency_penalty=0 等于关闭），跨轮复读罚不到。
    ok('词频惩罚映射为 frequency_penalty 且默认已打开（0.1，不是 Ollama 的 0）',
      o.frequency_penalty === 0.1, String(o.frequency_penalty))
    ok('惩罚射程映射为 repeat_last_n 且默认 512（不是 Ollama 的 64）',
      o.repeat_last_n === 512, String(o.repeat_last_n))
  }

  // ---------- 扮演设定（方案 §6.4） ----------
  {
    const cs: CastSetting = {
      voice: '句子短，爱用反问', address: '叫你师弟', unknown: '不知道胎记的事',
      taboo: '', care: '在意被质疑', never: '绝不会主动示弱',
    }
    const ai = renderCastSetting('萧景行', cs, 'ai')
    ok('AI 角色的设定块带角色名与用途说明', ai.includes('〖扮演设定 · 萧景行〗') && ai.includes('你要演成这样的人'))
    ok('只渲染填过的字段（空栏不产生「未填」噪音）', !ai.includes('禁忌与底线'))
    ok('填过的字段按固定顺序出现', ai.indexOf('口吻') < ai.indexOf('在意的事') && ai.indexOf('在意的事') < ai.indexOf('绝不会做的事'))
    const user = renderCastSetting('陈渊', cs, 'user')
    ok('作者角色的块明确「不要代写他的言行」', user.includes('不要代写'))
    ok('同一份设定，AI 块与作者块的首行不同', ai.split('\n')[0] !== user.split('\n')[0])
    ok('全空设定渲染为空串（整层跳过，不占上下文）', renderCastSetting('甲', { ...EMPTY_CAST_SETTING }, 'ai') === '')
    ok('只有空白字符也算空', !hasCastSetting({ ...EMPTY_CAST_SETTING, voice: '   ' }))
    ok('任一栏有内容就算已填', hasCastSetting({ ...EMPTY_CAST_SETTING, never: '不哭' }))

    // 接入 buildSystemPrompt：应出现在身份层之后、协议之前
    const sys = buildSystemPrompt({ tone: 'narrative', setting: '设定文', self: '身份文', cast: ai })
    ok('扮演设定进了 system 且带独立标题', sys.includes('〖扮演设定 · 萧景行〗'))
    ok('排在身份之后', sys.indexOf('身份文') < sys.indexOf('〖扮演设定'))
    ok('排在协议之前（不打断末尾的格式提醒）', sys.indexOf('〖扮演设定') < sys.indexOf(PROTOCOL_CORE))
  }
  // ---------- N) 客观描写档位（自由对话，2026-09-14 新增） ----------
  {
    ok('off 档不产出任何片段（关掉即回到旧行为）', buildSceneDescriptionRule('off') === '')
    const light = buildSceneDescriptionRule('light')
    const std = buildSceneDescriptionRule('standard')
    const rich = buildSceneDescriptionRule('rich')
    ok('每一档都写明「只写客观事实、不写任何人的心理」这条纪律（与 R2 不代写同源）',
      [light, std, rich].every(t => t.includes('不写任何人的心理活动')))
    ok('🔴 每一档都点明与 O1 是同一套括号（v1.6 起不再有【】，也不会误用【】）',
      [light, std, rich].every(t => t.includes('（ ）') && !t.includes('【】')))
    ok('每一档都写明这些话算在协议字数里（60–160 字是硬约束）',
      [light, std, rich].every(t => t.includes('算在协议的字数里')))
    ok('standard 覆盖出场 / 环境 / 情绪三个落点',
      std.includes('出场') && std.includes('环境') && std.includes('情绪明显变化时'))
    ok('light 只在出场与转场时写（不含情绪那条）',
      light.includes('出场') && light.includes('环境') && !light.includes('情绪明显变化时') && light.length < std.length)
    ok('rich 额外要求「每回合都至少带一条环境/身体细节」', rich.includes('每个回合都至少带一条写环境或身体细节的') && rich.length > std.length)
    ok('档位文本都够短（≤10 行，别白占 system）', [light, std, rich].every(t => t.split('\n').length <= 10))
  }

  // ---------- N+1) 同名角色的对照说明 ----------
  {
    const note = buildSameNameNote([{ name: '洛汐', tag: 'A1B2' }, { name: '洛汐', tag: 'C3D4' }])
    ok('逐个列出同名实例与短码', note.includes('洛汐（#A1B2）') && note.includes('洛汐（#C3D4）'))
    ok('讲清「不是同一个人、记忆各存各的」', note.includes('不同的人') && note.includes('长期记忆彼此独立'))
    ok('禁止把一个人的经历安到另一个人身上', note.includes('不要把一个人的经历安到另一个人身上'))
  }

  console.log(`\ntavernPrompt: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main()
