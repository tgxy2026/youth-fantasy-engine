// ============ 酒馆模式 · 角色卡细字段的「文本 ⇄ 小格」往返 ============
//
// 这一层是字段化的地基：`FreeCharacter` 存的是**一段标记文本**，
// 界面把它拆成若干小格给作者填。往返做错了就是**静默丢字** ——
// 既可能吞掉作者手打的内容，也可能把 AI 更新设定时写的散文丢掉，而这类丢法在界面上看不出来。
//
// 所以这里钉死三条：
//   ① 认得出的标签 → 各归各位；
//   ② **认不出来的行一律进「其他」**（老数据是散文，AI 也常写散文）；
//   ③ 空值不进输出，别把一堆空标签写进库里。
import {
  PROFILE_SPECS, CONDUCT_SPECS, OTHER_KEY,
  structSpecOf, unpackField, packField, filledCount, normalizeStructMarkup,
} from '../src/lib/tavern/cardFields'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const EXT = PROFILE_SPECS[0]        // 2.1 外在
const CORE = PROFILE_SPECS[1]       // 2.2 内核

console.log('—— 标签识别 ——')
{
  const v = unpackField('性别与年龄：女，27 岁\n外貌：短发\n随身物件：掉漆的打火机', EXT)
  ok('已知的标签进对应的格', v['性别与年龄'] === '女，27 岁' && v['外貌'] === '短发')
  ok('没提到的格是空串', v['穿着'] === '')
}

console.log('—— 认不出来的一律进「其他」（🔴 最重要的一条）——')
{
  // 老数据：整段散文，一个标签都没有
  const prose = '短发，总穿同一件洗旧的灰色围裙，左手腕有道旧疤。'
  const v = unpackField(prose, EXT)
  ok('整段散文落到「其他」，一个字不丢', v[OTHER_KEY] === prose, v[OTHER_KEY])

  // 混合：一半有标签、一半没标签
  const mixed = '外貌：短发\n习惯把手插进围裙口袋。'
  const m = unpackField(mixed, EXT)
  ok('混合文本：有标签的归位', m['外貌'] === '短发')
  ok('混合文本：没标签的进其他', m[OTHER_KEY] === '习惯把手插进围裙口袋。', m[OTHER_KEY])
}

console.log('—— 相同标签出现两次要拼接，不许互相顶掉 ——')
{
  const v = unpackField('外貌：短发\n外貌：还有一道旧疤', EXT)
  ok('重复标签用换行拼接', v['外貌'] === '短发\n还有一道旧疤', v['外貌'])
}

console.log('—— 打包 ——')
{
  const packed = packField({
    '外貌': '短发', '穿着': '', [OTHER_KEY]: '围裙口袋里总有一把糖',
  } as Record<string, string>, EXT)
  ok('空值的格不写进文本', !packed.includes('穿着'), packed)
  ok('有值 + 其他 都保留', packed.includes('外貌：短发') && packed.includes(`${OTHER_KEY}：围裙口袋里总有一把糖`))
  ok('「其他」永远排在最后', packed.indexOf(OTHER_KEY) === packed.lastIndexOf('：', packed.indexOf(OTHER_KEY)) - 1 || packed.trim().endsWith('一把糖'))
}

console.log('—— 往返（round-trip）——')
{
  const original = '外貌：短发\n穿着：灰色围裙\n' + OTHER_KEY + '：左手腕有旧疤'
  const v = unpackField(original, EXT)
  const back = packField(v, EXT)
  ok('文本 → 小格 → 文本，内容无损', unpackField(back, EXT)[OTHER_KEY] === '左手腕有旧疤', back)
  ok('幂等：再打一次包不再变化', packField(unpackField(back, EXT), EXT) === back)
}

console.log('—— 空值边界 ——')
{
  ok('空文本解包不炸，全空', Object.values(unpackField('', EXT)).every(x => x === ''))
  ok('纯空白也一样', Object.values(unpackField('   \n  \n ', EXT)).every(x => x === ''))
  ok('全空 → 打包成空串', packField(unpackField('', EXT), EXT) === '')
}

console.log('—— 模板完整性 ——')
{
  const all = [...PROFILE_SPECS, ...CONDUCT_SPECS]
  ok('第 2 章 6 栏 + 第 3 章 4 栏', PROFILE_SPECS.length === 6 && CONDUCT_SPECS.length === 4)
  ok('每栏都有界面名称', all.every(s => String(s.label ?? '').trim().length > 0))
  ok('每栏至少 2 个小格', all.every(s => s.items.length >= 2))
  ok('每栏都留了「其他」兜底', all.every(s => s.other === true))
  ok('每个 path 都能反查到模板', all.every(s => structSpecOf(s.path) === s))
  ok('小格的 key 不重复', new Set(EXT.items.map(i => i.key)).size === EXT.items.length)
  ok('未知 path 返回 null', structSpecOf('nope.nope') === null)
}

console.log('—— 已填计数 ——')
{
  const v = unpackField('性格：外冷内热\n怕什么：欠债被知道', CORE)
  ok('数出填了几格', filledCount(v, CORE) === 2, String(filledCount(v, CORE)))
  ok('全空是 0 格', filledCount(unpackField('', CORE), CORE) === 0)
}

// ---------- ⑧ 写入侧规范化：半角冒号归位（2026-09-19） ----------
//
// 触发场景：AI 起草 / 小说角色转换 / 设定更新给出的文本里，偶发把模板要求的「：」
// 打成「:」。旧行为＝那一行认不出标签，整行掉进「其他」（内容不丢但**归错位**）。
// 修法：**写入侧**只把「认得出的标签」后面的半角冒号换成全角，散文本一律不动。
{
  ok('半角冒号被归位（外貌）', normalizeStructMarkup('外貌: 短发', EXT) === '外貌：短发',
    normalizeStructMarkup('外貌: 短发', EXT))
  ok('归位后能被解包认出来（不再掉进「其他」）',
    unpackField(normalizeStructMarkup('外貌: 短发', EXT), EXT)['外貌'] === '短发')
  ok('全角本来就对 → 不动', normalizeStructMarkup('外貌：短发', EXT) === '外貌：短发')
  ok('幂等：跑第二遍不再变化',
    normalizeStructMarkup(normalizeStructMarkup('外貌: 短发', EXT), EXT) === '外貌：短发')
  ok('「其他」小项也认半角', unpackField(normalizeStructMarkup('其他: 口袋里总有一把糖', EXT), EXT)[OTHER_KEY] === '口袋里总有一把糖')
  ok('多行混排：只动认得出的那一行', normalizeStructMarkup('外貌: 短发\n他习惯: 把手插进口袋', EXT) === '外貌：短发\n他习惯: 把手插进口袋',
    normalizeStructMarkup('外貌: 短发\n他习惯: 把手插进口袋', EXT))
  ok('🔴 散文本的冒号绝不改（「他说: 我不去」不是标签）', normalizeStructMarkup('他说: 我不去', EXT) === '他说: 我不去')
  ok('🔴 别的栏的小项名不认（性格 属 2.2，不在 2.1）', normalizeStructMarkup('性格: 温和', EXT) === '性格: 温和')
  ok('整行无冒号 → 原样', normalizeStructMarkup('短发，眼下有颗小痣', EXT) === '短发，眼下有颗小痣')
  ok('行首就是冒号 → 原样（不算标签）', normalizeStructMarkup(': 空标签', EXT) === ': 空标签')
  ok('已有全角冒号在前的行 → 原样（不重复加工）', normalizeStructMarkup('外貌：短发: 补充', EXT) === '外貌：短发: 补充')
  ok('空串 / 空白不炸', normalizeStructMarkup('', EXT) === '' && normalizeStructMarkup('   ', EXT) === '   ')
  ok('保留缩进，冒号后的前导空格归零（与 packField 产出对齐）', normalizeStructMarkup('  外貌:  短发', EXT) === '  外貌：短发',
    JSON.stringify(normalizeStructMarkup('  外貌:  短发', EXT)))
}

// ============ 界面长名（label）也要认（2026-10-11 实测事故）============
//
// 🔴 事故现场：界面**显示 label、库里存 key**，作者（与 AI 起草、生成脚本）照着界面上
//    看到的长名写 —— 而解包过去只认 key，于是 `怎么称呼别人：…`、`情绪外露程度：…`
//    认不出，整行落进「其他」。奉阳青春物语 20 张卡里 4 格全中招。
//
// 修法＝双认：key 与 label 都归到内部 key。这里钉死这几条。
console.log('\n—— 🔴 界面长名（label）也要认 ——')
{
  const SPEECH = structSpecOf('profile.speech')!   // 2.3 语言特征
  const KNOW = structSpecOf('profile.knowledge')!  // 2.6 知识边界

  // 该栏里确实存在 label ≠ key 的格（这是本次事故的成因，钉死它们别被谁改回去）
  const mismatched = SPEECH.items.filter(i => i.label !== i.key)
  ok('2.3 存在 label ≠ key 的格（事故成因）', mismatched.length > 0)

  // 照界面长名写 → 必须归到内部 key
  const v = unpackField('怎么称呼别人：叫「喂」，熟了才叫名字\n情绪外露程度：不太外露，气到极点反而笑', SPEECH)
  ok('「怎么称呼别人」归到 key 称呼别人', v['称呼别人'] === '叫「喂」，熟了才叫名字', JSON.stringify(v))
  ok('「情绪外露程度」归到 key 情绪外露', v['情绪外露'] === '不太外露，气到极点反而笑', JSON.stringify(v))
  ok('长名写的那两行不落「其他」', !v[OTHER_KEY].includes('怎么称呼别人') && !v[OTHER_KEY].includes('情绪外露程度'), v[OTHER_KEY])

  // 2.6 的另外两组
  const k = unpackField('哪些事 Ta 不知道：不知道顾客的过去\nTa 的消息来源：只从街坊闲话听说', KNOW)
  ok('「哪些事 Ta 不知道」归到 key 不知道的', k['不知道的'] === '不知道顾客的过去', JSON.stringify(k))
  ok('「Ta 的消息来源」归到 key 知道的范围', k['知道的范围'] === '只从街坊闲话听说', JSON.stringify(k))
  ok('2.6 长名那两行不落「其他」', k[OTHER_KEY] === '', k[OTHER_KEY])

  // 短键（旧数据形态）照旧要认 —— 双认不是替换
  const v2 = unpackField('称呼别人：叫喂\n情绪外露：藏着', SPEECH)
  ok('短键写法照旧认（双认不是替换）', v2['称呼别人'] === '叫喂' && v2['情绪外露'] === '藏着', JSON.stringify(v2))

  // 写入侧规范化：长名 + 半角冒号 → 归一成 key + 全角
  ok('normalize：长名 + 半角 → 归一到 key',
    normalizeStructMarkup('怎么称呼别人: 叫喂', SPEECH) === '称呼别人：叫喂',
    normalizeStructMarkup('怎么称呼别人: 叫喂', SPEECH))
  ok('normalize：长名 + 全角已有冒号 → 也归一到 key',
    normalizeStructMarkup('情绪外露程度：藏着', SPEECH) === '情绪外露：藏着',
    normalizeStructMarkup('情绪外露程度：藏着', SPEECH))
  ok('normalize：认不出的长名行原样（不篡改散文）',
    normalizeStructMarkup('他习惯: 把手插进口袋', SPEECH) === '他习惯: 把手插进口袋')

  // 往返：长名解包 → 打包 → 落成短键形态 → 再解包仍归位
  const packed = packField(unpackField('怎么称呼别人：叫喂', SPEECH), SPEECH)
  ok('往返后落成短键形态（库里只有一种写法）', packed === '称呼别人：叫喂', packed)
  ok('往返后仍能被解包归位', unpackField(packed, SPEECH)['称呼别人'] === '叫喂')
}

console.log(`\n—— 通过 ${pass} / 失败 ${fail} ——`)
if (fail) process.exit(1)
