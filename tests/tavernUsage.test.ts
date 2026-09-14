// ============ 酒馆模式 · 用量明细 + 额度分配（2026-09-14 老大问「额度到底怎么分的」）============
//
// 老大要确认的那件事：**背景设定没填内容时，那 1800 的额度有没有被白白留着？**
// 所以这一组断言把「空 / 满」两种情况的额度分配**锁进回归** —— 答案以后不能悄悄变，
// 改了组装方式而额度分配跟着变，这里会红。
//
// 另一半是 `summarizeUsage` 的纯函数契约：明细**求和必须等于 system 总长** ——
// 账本身对不上，比没有明细更让人困惑。
import {
  summarizeUsage, historyBudget, FIXED_OVERHEAD_CHARS,
} from '../src/lib/tavern/budget'
import { buildSystemPrompt } from '../src/lib/tavern/prompt'
import * as db from '../src/lib/db'
import { createDemoProject } from '../src/lib/seedData'
import { flattenChapters } from '../src/lib/chapterSeq'
import { getTavernSettings } from '../src/lib/tavern/settings'
import { TAVERN_DEFAULTS } from '../src/lib/tavern/types'
import { buildPlotSystem } from '../src/lib/tavern/engine'
import { saveWorldSetting, worldToText, WORLD_MAX_CHARS, EMPTY_WORLD_SETTING, type WorldSetting } from '../src/lib/tavern/world'
import { __resetMockStores } from './mock-memory'
import type { TavernSession } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const EMPTY_WORLD: WorldSetting = { ...EMPTY_WORLD_SETTING }
const FULL_WORLD: WorldSetting = { ...EMPTY_WORLD_SETTING, brief: '世'.repeat(WORLD_MAX_CHARS) }

async function main() {
  // ---------- 1) summarizeUsage 纯函数 ----------
  {
    const s = summarizeUsage({
      total: 16000,
      systemChars: 10000,
      parts: [
        { key: 'setting', label: '项目资料', chars: 6000 },
        { key: 'world', label: '背景设定', chars: 1800 },
        { key: 'memory', label: '本场记忆', chars: 1200 },
      ],
    })
    ok('明细求和恰等于 system 总长（差额自动兜底成「其他固定部分」）',
      s.parts.reduce((n, p) => n + p.chars, 0) === 10000,
      String(s.parts.reduce((n, p) => n + p.chars, 0)))
    ok('兜底那一行的名字说明白了它是差额',
      s.parts.some(p => p.key === 'other' && p.chars === 1000 && !!p.note),
      JSON.stringify(s.parts.map(p => [p.key, p.chars])))
    ok('历史额度 = 总额 − 余量 − system（与 historyBudget 同一口径）',
      s.historyChars === historyBudget(16000, 'x'.repeat(10000), '', FIXED_OVERHEAD_CHARS),
      String(s.historyChars))
    ok('历史额度 5600（16000 − 400 − 10000）', s.historyChars === 5600, String(s.historyChars))
    ok('给出历史占比（5600/16000 = 35%）', s.historyPct === 35, String(s.historyPct))

    const noWorld = summarizeUsage({
      total: 16000,
      systemChars: 8200,
      parts: [
        { key: 'setting', label: '项目资料', chars: 6000 },
        { key: 'world', label: '背景设定', chars: 0 },
        { key: 'memory', label: '本场记忆', chars: 1200 },
      ],
    })
    ok('🔴 某一层是 0 字就不出现在明细里（背景设定没填 = 不占一行）',
      !noWorld.parts.some(p => p.key === 'world'), JSON.stringify(noWorld.parts.map(p => p.key)))
    ok('🔴 背景设定为 0 时，系统总长少 1800 → 历史额度**多** 1800',
      noWorld.historyChars - s.historyChars === 1800,
      `${noWorld.historyChars} vs ${s.historyChars}`)

    const over = summarizeUsage({
      total: 16000, systemChars: 500,
      parts: [{ key: 'setting', label: '项目资料', chars: 900 }],
    })
    ok('已知层超过 system 总长时不崩、也不补负数行（调用方量错是调用方的事）',
      over.parts.every(p => p.chars > 0) && !over.parts.some(p => p.key === 'other'),
      JSON.stringify(over.parts))

    const w = summarizeUsage({ total: 16000, systemChars: 100, parts: [], warnings: ['档位有坑'] })
    ok('warnings 原样透传', w.warnings.length === 1 && w.warnings[0] === '档位有坑')
    ok('总量为 0 时不产生 NaN', summarizeUsage({ total: 0, systemChars: 0, parts: [] }).historyPct === 0)
  }

  // ---------- 2) 真实组装：额度分配（把「空不预留」锁进回归） ----------
  {
    __resetMockStores()
    const pid = await createDemoProject()
    db.setCurrentProject(pid)

    const [vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
    const anchor = flattenChapters(vols, chs)[0]
    const base = await getTavernSettings()
    const total = TAVERN_DEFAULTS.plot.contextBudget

    const session: TavernSession = {
      id: 's1', title: '用量实测', mode: 'immersive',
      anchorChapterId: anchor.id, anchorChapterLabel: anchor.title || '第一章',
      cast: [
        { cardId: 'c1', role: 'user', tabId: 'char-main', name: '洛汐' },
        { cardId: 'c2', role: 'ai', tabId: 'char-main', name: '苏念' },
      ],
      scene: { place: '旧书店', time: '雨夜', present: ['洛汐', '苏念'], description: '' },
      messages: [
        { id: 'm1', role: 'assistant', content: '【雨点砸在遮阳棚上】\n你来了。', at: 0 },
        { id: 'm2', role: 'user', content: '（把伞收起）\n我来还书。', at: 0 },
      ],
      model: { providerId: '' }, params: {}, memory: '长期摘要：她最近话少了。',
      createdAt: 0, updatedAt: 0,
    }

    await saveWorldSetting(EMPTY_WORLD)
    const empty = await buildPlotSystem(session, { ...base, plot: { ...base.plot, contextSource: 'both' } })
    await saveWorldSetting(FULL_WORLD)
    const full = await buildPlotSystem(session, { ...base, plot: { ...base.plot, contextSource: 'both' } })

    const hEmpty = historyBudget(total, empty.system, '', FIXED_OVERHEAD_CHARS)
    const hFull = historyBudget(total, full.system, '', FIXED_OVERHEAD_CHARS)

    ok('背景设定为空时，system 里一个字符都不占（worldToText 返回空串）',
      worldToText(EMPTY_WORLD) === '')
    ok('🔴 空 → 满：system 只增加「1800 + 层头」这一点，其余分毫不差',
      full.system.length - empty.system.length > WORLD_MAX_CHARS
      && full.system.length - empty.system.length < WORLD_MAX_CHARS + 60,
      `+${full.system.length - empty.system.length}`)
    ok('🔴 省下来的额度**确实给了对话历史**（差值 = 背景设定那点长度）',
      hEmpty - hFull === full.system.length - empty.system.length,
      `${hEmpty} → ${hFull}`)
    ok('空的时候历史额度明显更宽裕', hEmpty > hFull, `${hEmpty} vs ${hFull}`)

    // digest 档：设定层被压成骨架，世界交给背景设定 —— 这是老大要留意的那个组合
    await saveWorldSetting(EMPTY_WORLD)
    const dEmpty = await buildPlotSystem(session, { ...base, plot: { ...base.plot, contextSource: 'digest' } })
    await saveWorldSetting(FULL_WORLD)
    const dFull = await buildPlotSystem(session, { ...base, plot: { ...base.plot, contextSource: 'digest' } })

    ok('digest 档确实把设定层压成骨架（比 both 小一个数量级）',
      dEmpty.settingChars < empty.settingChars / 5,
      `${dEmpty.settingChars} vs ${empty.settingChars}`)
    ok('digest 下背景设定是唯一的「世界来源」：满额时才有那 1800',
      dFull.system.length - dEmpty.system.length > WORLD_MAX_CHARS - 5)
    ok('🔴 提醒：digest 档 + 背景设定为空 = 作者侧资料几乎全空（这一步没改行为，只锁住现状）',
      dEmpty.settingChars < 500 && worldToText(EMPTY_WORLD) === '',
      `设定层 ${dEmpty.settingChars} 字、背景设定 0 字`)

    // raw 档：明确不要背景设定 → 空/满都不变
    await saveWorldSetting(FULL_WORLD)
    const rawFull = await buildPlotSystem(session, { ...base, plot: { ...base.plot, contextSource: 'raw' } })
    await saveWorldSetting(EMPTY_WORLD)
    const rawEmpty = await buildPlotSystem(session, { ...base, plot: { ...base.plot, contextSource: 'raw' } })
    ok('raw 档彻底忽略背景设定（空/满 system 等长）',
      rawFull.system.length === rawEmpty.system.length, `${rawFull.system.length} vs ${rawEmpty.system.length}`)

    // 明细账对得上：用真实数据走一遍
    const sum = summarizeUsage({
      total,
      systemChars: empty.system.length,
      parts: [
        { key: 'setting', label: '项目资料', chars: empty.settingChars },
        { key: 'world', label: '背景设定', chars: 0 },
      ],
    })
    ok('真实数据的明细求和 = system 总长',
      sum.parts.reduce((n, p) => n + p.chars, 0) === empty.system.length,
      `${sum.parts.reduce((n, p) => n + p.chars, 0)} vs ${empty.system.length}`)
    ok('明细算出的历史额度 = 引擎口径的历史额度', sum.historyChars === hEmpty, `${sum.historyChars} vs ${hEmpty}`)

    // prompt 层：空 world 不会留一个空标题（这是「不占额度」的前提）
    const pNone = buildSystemPrompt({ tone: 'narrative' })
    const pEmpty = buildSystemPrompt({ tone: 'narrative', world: '' })
    const pOne = buildSystemPrompt({ tone: 'narrative', world: '甲' })
    ok('🔴 传空 world 与完全不传 world **一字不差**（空层不留空标题）',
      pEmpty.length === pNone.length, `${pEmpty.length} vs ${pNone.length}`)
    ok('非空 world 才加层头（层头 11 字 + 正文 1 字）',
      pOne.length - pNone.length === 12, `+${pOne.length - pNone.length}`)
  }

  console.log(`\ntavernUsage: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main()
