// ============ 酒馆模式 · 「风格提示」↔ 角色卡「尺度」冲突自检（W4-2 / 方案 §13 F6）============
//
// 这是**非阻断提醒**的唯一判定入口（界面不许自己拼那个字符串，也不许自己解析生效值）。
// 断言锁两个方向：
//   · 该报时必报 —— 风格写死聊天体 + 卡文写"可拥抱/可哭"，正是 §13 那个
//     「十香折纸对士道演得像陌生人」的根因，漏了就白做；
//   · 不该报时别报 —— 叙事向风格 / 卡文留空 / 尺度只写"保持距离"时都不该弹，
//     提醒太滥会被作者直接无视。
import { checkStyleFit, effectiveStyleHint } from '../src/lib/tavern/styleFit'
import { TONE_HINT } from '../src/lib/tavern/prompt'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function main() {
  // ---------- 1) 命中：聊天体风格 + 尺度写了高表达密度 → 报 ----------
  {
    const w = checkStyleFit({
      styleHint: TONE_HINT.chat,                       // 出厂默认那一句（短句为主 / 最多连发 2 条）
      castRatings: ['可依偎、可哭，会攥袖口掰手指。'],
    })
    ok('出厂聊天体 + 高密度尺度 → 提醒', !!w && w.kind === 'chat-vs-rich', JSON.stringify(w))
    ok('提醒里带上风格原文摘要', !!w && w.text.includes('连发'))
    ok('提醒里带上尺度原文摘要', !!w && w.text.includes('依偎'))
    ok('提醒明说「不阻断 / 可改成叙事向」的出路', !!w && /叙事向/.test(w.text))
  }

  // ---------- 2) 反向：风格是叙事向（空）→ 不报 ----------
  ok('叙事向风格（空串）→ 不报',
    checkStyleFit({ styleHint: '', castRatings: ['可拥抱、可靠得很近。'] }) === null)
  ok('风格写「第三人称客观叙事」→ 不报',
    checkStyleFit({ styleHint: '第三人称客观叙事，允许长段描写。', castRatings: ['可拥抱。'] }) === null)

  // ---------- 3) 反向：风格是聊天体但本场没有高密度尺度 → 不报 ----------
  ok('风格聊天体 + 本场无尺度 → 不报',
    checkStyleFit({ styleHint: TONE_HINT.chat, castRatings: [] }) === null)
  ok('尺度全空串视同没填 → 不报',
    checkStyleFit({ styleHint: TONE_HINT.chat, castRatings: ['', '  '] }) === null)
  ok('尺度只写「日常向 / 保持距离」→ 不报',
    checkStyleFit({ styleHint: TONE_HINT.chat, castRatings: ['日常向，保持社交距离。'] }) === null)

  // ---------- 4) 覆盖写法：作者手打的聊天体变体 ----------
  {
    const w = checkStyleFit({ styleHint: '像聊天一样，不要长篇。', castRatings: ['会哭，会攥紧衣角。'] })
    ok('「像聊天 / 不要长篇」也算聊天体', !!w, JSON.stringify(w))
  }
  {
    const w = checkStyleFit({ styleHint: '消息体，最多连发 3 条。', castRatings: ['可牵手。'] })
    ok('「消息体 / 连发 3 条」也算聊天体', !!w, JSON.stringify(w))
  }
  {
    const w = checkStyleFit({ styleHint: '短句为主。', castRatings: ['第 4 章示例对话里有拥抱。'] })
    ok('尺度写「第 4 章示例对话」也算高密度', !!w, JSON.stringify(w))
  }

  // ---------- 5) 防御：空输入 / undefined 不炸 ----------
  ok('风格为 undefined → 不报',
    checkStyleFit({ styleHint: undefined as unknown as string, castRatings: ['可拥抱。'] }) === null)
  ok('castRatings 为 undefined → 不报',
    checkStyleFit({ styleHint: TONE_HINT.chat, castRatings: undefined as unknown as string[] }) === null)
  ok('入参整个为 null → 不炸、返回 null',
    checkStyleFit(null as unknown as { styleHint: string; castRatings: string[] }) === null)

  // ---------- 6) effectiveStyleHint：手填优先、否则回落档位默认 ----------
  ok('手填非空 → 原样返回',
    effectiveStyleHint('作者自己写的风格', 'chat') === '作者自己写的风格')
  ok('手填空串 → 回落 chat 档默认',
    effectiveStyleHint('', 'chat') === TONE_HINT.chat)
  ok('手填空格 → 视同没填、回落档位默认',
    effectiveStyleHint('   ', 'chat') === TONE_HINT.chat)
  ok('手填 undefined → 回落档位默认',
    effectiveStyleHint(undefined, 'chat') === TONE_HINT.chat)
  ok('叙事档默认是空串（⚠️ 与「作者清空」不可区分 —— 界面口径是宁可少报）',
    effectiveStyleHint('', 'narrative') === TONE_HINT.narrative)

  // ---------- 7) 端到端口径：出厂默认 + 出厂尺度风格 → 直接串起来看 ----------
  {
    const eff = effectiveStyleHint(undefined, 'chat')   // 作者没动过控制面板 = 界面拿到的值
    const w = checkStyleFit({ styleHint: eff, castRatings: ['可依偎、可哭。'] })
    ok('未手填时也按出厂聊天体判定（不会因为"空"就漏报）', !!w, JSON.stringify(w))
  }

  console.log(`\nstyleFit: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main()
