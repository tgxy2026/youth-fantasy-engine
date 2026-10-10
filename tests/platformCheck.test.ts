// ============ 分平台投稿预检（C4 · 2.4.2）单测 ============
//
// 三组断言：
//   1. chapterFacts —— 字数 / 段数 / 最长段 / 区间标记；
//   2. scanByPlatform —— 带类别 + 重点关注标记，晋江档与起点档的关注类别不同；
//   3. 🔴 立场断言 —— 产物文案与规则文案里**不得出现**禁词（含注释里也不能出现，
//      否则断言自己会命中自己）。这是「不做反检测 / 不判定过审」红线的机器守护。
import type { Chapter } from '../src/lib/types'
import { readFileSync } from 'node:fs'
import { chapterFacts, scanByPlatform, precheckBook } from '../src/lib/audit/platformCheck'
import { PLATFORM_RULES, platformRuleOf, isFocused } from '../src/lib/app/platformRules'
import { BUILTIN_WORDS } from '../src/lib/editor/sensitiveWords'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ platformCheck')

function mkCh(id: string, title: string, content: string): Chapter {
  return {
    id, projectId: 'p1', volumeId: 'v1', order: 0, title, content,
    summary: '', status: '草稿', wordCount: 0, createdAt: 0, updatedAt: 0,
  } as unknown as Chapter
}


// ---------- 1) chapterFacts ----------
{
  const long = '这是一段很长的文字用来测试段落统计。'.repeat(20)
  const chs = [
    mkCh('c1', '第一章', '　　短章一段。\n　　第二段。'),
    mkCh('c2', '第二章', long),
    mkCh('c3', '空章', ''),
  ]
  // 上界取 200：长章样本约 340 字（countWords 只数 CJK），这样它必落在区间外
  const facts = chapterFacts(chs, [100, 200])
  ok('段数与最长段可算', facts[0].paragraphs === 2, String(facts[0].paragraphs))
  ok('空章不崩（0 段 / 0 字）', facts[2].words === 0 && facts[2].paragraphs === 0 && facts[2].longestParagraph === 0)
  ok('低于下限标 short', facts[0].rangeFlag === 'short', String(facts[0].rangeFlag))
  ok('高于上限标 long', facts[1].rangeFlag === 'long', `${facts[1].words}`)
  ok('空章不误标', facts[2].rangeFlag === 'short' || facts[2].rangeFlag === null, String(facts[2].rangeFlag))
  ok('最长段取最大值', facts[1].longestParagraph > 0 && facts[1].longestParagraph <= facts[1].words)
}

// ---------- 2) scanByPlatform ----------
{
  const text = '他在赌场里赌球，又提到冰毒。'
  const jj = scanByPlatform(text, 'jjwxc')
  const qd = scanByPlatform(text, 'qidian')
  ok('扫出命中并带类别', jj.length >= 3, JSON.stringify(jj.map(h => `${h.category}:${h.word}`)))
  ok('赌博属起点重点关注', qd.find(h => h.word === '赌场')?.focused === true)
  ok('涉毒两档都重点关注', jj.find(h => h.word === '冰毒')?.focused === true && qd.find(h => h.word === '冰毒')?.focused === true)
  ok('重点关注排在前面', jj.every((h, i) => i === 0 || Number(h.focused) <= Number(jj[i - 1].focused)))
  ok('自定义词归「自定义」且重点关注', scanByPlatform('测试专用词A', 'general', ['测试专用词A'])[0]?.focused === true)
  ok('未命中返回空', scanByPlatform('风在吹。雨在下。', 'jjwxc').length === 0)

  // 两档的差别：晋江重点关注「色情低俗」，起点不关注
  const erotic = BUILTIN_WORDS['色情低俗'][0]
  ok('晋江重点关注色情低俗', isFocused(platformRuleOf('jjwxc'), '色情低俗'))
  ok('起点不把色情低俗列入重点关注', !isFocused(platformRuleOf('qidian'), '色情低俗'))
  const hitErotic = scanByPlatform(`含有${erotic}字样`, 'jjwxc')[0]
  ok('同一词在晋江档被标关注', hitErotic?.focused === true, JSON.stringify(hitErotic))
  ok('未收录的平台回落到通用档', platformRuleOf('不存在的平台').id === 'general')
  ok('通用档全部类别都算关注', platformRuleOf('general').focusCategories.length === Object.keys(BUILTIN_WORDS).length)
}

// ---------- 3) 汇总报告 ----------
{
  const chs = [mkCh('c1', '第一章', '　　正常一段。'), mkCh('c2', '第二章', '赌场里赌球。')]
  const rep = precheckBook(chs, 'qidian')
  ok('报告带平台名', rep.platformName === '起点')
  ok('报告带分章事实', rep.facts.length === 2)
  ok('报告带观察句', rep.observations.length >= 2, String(rep.observations.length))
  ok('检出时观察句给总数与重点关注数', rep.observations[0].includes('重点关注'), rep.observations[0])
}

// ---------- 4) 🔴 立场断言 ----------
{
  // 禁词只写在这里 —— 注释里一旦出现这些字面量，下面「读源码全文」的断言会自己红
  const banned = ['命中率', '规避检测', '反检测', '洗稿', '过审率', '合格', '不合格']
  const readAll = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
  const sources = ['src/lib/app/platformRules.ts', 'src/lib/audit/platformCheck.ts', 'src/components/audit/PlatformCheckPanel.tsx']
  for (const s of sources) {
    const src = readAll(s)
    const hit = banned.filter(w => src.includes(w))
    ok(`立场：${s} 不含禁词`, hit.length === 0, hit.join(','))
  }
  const obs = precheckBook([mkCh('c1', '第一章', '赌场里赌球。')], 'jjwxc').observations.join('\n')
  ok('立场：观察文案不含禁词', banned.every(w => !obs.includes(w)), obs)
  ok('立场：平台提示一律声明以官方为准', PLATFORM_RULES.every(r => r.notes.some(n => n.includes('为准')) || r.id === 'general'))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
