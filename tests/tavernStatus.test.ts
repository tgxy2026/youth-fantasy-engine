// ============ 状态一览（批次 8；调研稿 C2 第一步：只读可视化）============
//
// 这一层的定位是**视图**：不动数据模型、不写库、不让 AI 输出增量。
// 所以测试重点全在「提取得准不准」：条目数、关系摘要、合计、新鲜度、在场标记。
//
// 🔴 特别要守住的一条：**均衡健谈度不显示**。满场「均衡」时每行都挂一个「均衡」
//    只是噪音，而且会让人以为那是某种状态。默认值就该是"没有这一行"。
import {
  countEntries, firstEntries, memoryCounts, memoryEntryTotal, buildStatusModel, agoText,
} from '../src/lib/tavern/status'
import type { FreeMemory, CastDirection } from '../src/lib/tavern/types'
import { DEFAULT_TALKATIVITY } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const mem = (o: Partial<FreeMemory> & { charId: string }): FreeMemory => ({
  longTerm: '', facts: '', relation: '', mines: '', anniversaries: '', diaries: '',
  updatedAt: 0, ...o,
})

function main() {
  // ---------- 1) 数条目 ----------
  {
    ok('空串 0 条', countEntries('') === 0 && countEntries('   ') === 0)
    ok('纯换行 0 条', countEntries('\n\n\n') === 0)
    ok('两行算两条', countEntries('甲\n乙') === 2)
    ok('结尾换行不额外算一条', countEntries('甲\n乙\n') === 2)
    ok('剥掉 - 列表符号', countEntries('- 甲\n- 乙') === 2)
    ok('剥掉 * 与 • 与 ·', countEntries('* 甲\n• 乙\n· 丙') === 3)
    ok('剥掉 1. / 2、/(3) 这类序号', countEntries('1. 甲\n2、乙\n(3) 丙') === 3)
    ok('同一条里的行内空白不影响', countEntries('  甲  \n  乙  ') === 2)
  }

  // ---------- 2) 关系摘要 ----------
  {
    ok('空 → 空串', firstEntries('') === '')
    ok('两条用分号连接', firstEntries('甲\n乙\n丙', 2) === '甲；乙', firstEntries('甲\n乙\n丙', 2))
    ok('超过 max 截断加省略号', (() => {
      const s = firstEntries('甲'.repeat(50), 1, 10)
      return s.endsWith('…') && s.length === 11
    })())
    ok('长度正好等于 max 不加省略号', firstEntries('甲'.repeat(10), 1, 10) === '甲'.repeat(10))
    ok('摘要也剥列表符号', firstEntries('- 还没说破', 1) === '还没说破')
  }

  // ---------- 3) 六栏计数 ----------
  {
    const m = mem({
      charId: 'c1',
      longTerm: '她最近话少了。',
      facts: '甲\n乙\n丙',
      relation: '还没说破',
      mines: '她不提苏念',
      anniversaries: '第一次见面：3 月 7 日\n答应过的旅行',
      diaries: '周一：去了书店\n周二：加班',
    })
    const c = memoryCounts(m)
    ok('六栏键都在', ['longTerm', 'facts', 'relation', 'mines', 'anniversaries', 'diaries'].every(k => k in c))
    ok('长期摘要成段算 1 条', c.longTerm === 1, String(c.longTerm))
    ok('关键事实 3 条', c.facts === 3, String(c.facts))
    ok('关系状态 1 条', c.relation === 1)
    ok('未爆的雷 1 条', c.mines === 1)
    ok('纪念日 2 条', c.anniversaries === 2, String(c.anniversaries))
    ok('日记 2 条', c.diaries === 2, String(c.diaries))
    ok('总条目数 = 10', memoryEntryTotal(m) === 10, String(memoryEntryTotal(m)))

    ok('null 记忆全是 0', memoryEntryTotal(null) === 0 && memoryCounts(null).facts === 0)
    ok('全空记忆总数 0（界面上据此显示「记忆还是空的」）', memoryEntryTotal(mem({ charId: 'x' })) === 0)
    ok('只有空白字符也算空', memoryEntryTotal(mem({ charId: 'x', facts: '   \n  ' })) === 0)
  }

  // ---------- 4) 相对时间 ----------
  {
    const now = 1_700_000_000_000
    ok('0 → 默认「还没有记忆」', agoText(0, now) === '还没有记忆')
    ok('空文案可定制', agoText(0, now, '未整理') === '未整理')
    ok('30 秒前 → 刚刚', agoText(now - 30_000, now) === '刚刚')
    ok('正好 1 分钟 → 1 分钟前（边界不含"刚刚"）', agoText(now - 60_000, now) === '1 分钟前', agoText(now - 60_000, now))
    ok('59 分钟 → 59 分钟前', agoText(now - 59 * 60_000, now) === '59 分钟前')
    ok('2 小时 → 2 小时前', agoText(now - 2 * 3_600_000, now) === '2 小时前')
    ok('23 小时 → 23 小时前', agoText(now - 23 * 3_600_000, now) === '23 小时前')
    ok('2 天前 → 落到具体日期', (() => {
      const s = agoText(now - 2 * 86_400_000, now)
      return s.includes('/') || s.includes('月') || /\d{4}/.test(s)
    })(), agoText(now - 2 * 86_400_000, now))
    ok('未来时间（时钟偏差）不炸', typeof agoText(now + 10_000, now) === 'string')
  }

  // ---------- 5) 组装状态模型 ----------
  {
    const chars = [
      { id: 'c1', name: '洛汐', avatar: 'data:image/webp;base64,AAA' },
      { id: 'c2', name: '苏念' },
    ]
    const memories: Record<string, FreeMemory | null> = {
      c1: mem({ charId: 'c1', relation: '朋友（她还没说破）', facts: '甲\n乙', mines: '丙', updatedAt: 1000 }),
      c2: mem({ charId: 'c2', relation: '', facts: '', updatedAt: 5000 }),
    }
    const direction: CastDirection = { muted: ['c2'], talkativity: { c1: 85 } }

    const m = buildStatusModel({ chars, direction, userCharId: 'c1', memories })
    ok('行数 = 在场角色数', m.rows.length === 2)
    ok('头像透传（没设就是 undefined，交给 Avatar 回退首字）',
      m.rows[0].avatar === 'data:image/webp;base64,AAA' && m.rows[1].avatar === undefined)
    ok('用户演的角色被标记', m.rows[0].isUser === true && m.rows[1].isUser === undefined)
    ok('静音被标记', m.rows[1].muted === true && m.rows[0].muted === undefined)
    ok('非默认健谈度给档位名', m.rows[0].talkBand === '话很多', String(m.rows[0].talkBand))
    ok('🔴 默认健谈度不给档位名（均衡＝不显示）',
      buildStatusModel({ chars: [{ id: 'c1', name: '洛汐' }], direction: { talkativity: { c1: DEFAULT_TALKATIVITY } }, memories }).rows[0].talkBand === undefined)
    ok('没有 direction 时也不显示档位',
      buildStatusModel({ chars, memories }).rows[0].talkBand === undefined)
    ok('关系摘要取关系栏', m.rows[0].relation === '朋友（她还没说破）', m.rows[0].relation)
    ok('关系原文另存一份（悬停看全）', m.rows[0].relationFull === '朋友（她还没说破）')
    ok('关系为空时摘要也是空（界面据此显示「还没写」）', m.rows[1].relation === '')
    ok('各栏计数正确', m.rows[0].facts === 2 && m.rows[0].mines === 1 && m.rows[0].anniversaries === 0)
    ok('各栏都空的行 empty=true（界面据此说「记忆还是空的」而不是显示空白）', m.rows[1].empty === true)
    ok('有内容的行 empty=false', m.rows[0].empty === false)
    ok('合计 = 各行相加', m.facts === 2 && m.mines === 1 && m.anniversaries === 0)
    ok('新鲜度取最新的一份（不是第一份）', m.memoryUpdatedAt === 5000, String(m.memoryUpdatedAt))

    const none = buildStatusModel({ chars: [], memories: {} })
    ok('没有角色 → 空模型而不是崩', none.rows.length === 0 && none.facts === 0 && none.memoryUpdatedAt === 0)
    ok('不传 memories 也能组装（每行都按空记忆处理）',
      buildStatusModel({ chars }).rows.length === 2 && buildStatusModel({ chars }).rows.every(r => r.empty))
    ok('角色没名字时给占位名',
      buildStatusModel({ chars: [{ id: 'x', name: '' }] }).rows[0].name === '（未命名）')
  }

  console.log(`\ntavernStatus: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main()
