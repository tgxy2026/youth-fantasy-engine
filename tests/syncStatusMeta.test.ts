/**
 * 同步状态徽标元数据 · 单测（2026-10-06 补）
 *
 * 这个模块看起来只是张常量表（TS 已用 `Record<SyncStatus, …>` 保证「不漏键」），
 * 但有一条**TS 管不了的业务约束**值得钉死：
 *
 *   🔴 「失败类状态必须露出文字」—— #008 的立项目的就是「推送失败不能让用户零感知地白写一晚」。
 *   如果哪天有人把 `error.text` 改成空串（想「安静一点」），界面上就只剩一个色点，
 *   用户看不出发生了什么 —— 而这正是这条功能要防的事故。
 */
import { STATUS_META } from '../src/lib/sync/syncStatusMeta'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** SyncStatus 的全部取值（类型无法运行时枚举，这里硬编码 —— 新增状态时本测试会红，正好提醒补文案） */
const ALL = ['idle', 'syncing', 'ok', 'error', 'auth-failed', 'rate-limited', 'too-large', 'offline'] as const
/** 失败/异常类：这些状态下**必须有可见文字**，否则用户零感知 */
const FAILURE = ['error', 'auth-failed', 'rate-limited', 'too-large', 'offline'] as const

function main() {
  const keys = Object.keys(STATUS_META)

  // ---------- 1) 键集合与类型定义一致 ----------
  {
    const missing = ALL.filter(k => !keys.includes(k))
    const extra = keys.filter(k => !(ALL as readonly string[]).includes(k))
    ok('1a 八种状态都有元数据（新增状态时这里会红，提醒补文案）', missing.length === 0, `缺: ${missing.join(',')}`)
    ok('1b 没有多余键（改了类型忘改表）', extra.length === 0, `多: ${extra.join(',')}`)
  }

  // ---------- 2) 每条都要有可用的 dot 与 title ----------
  {
    // ⚠️ 本项目的主题色（amber / emerald / rose / ink…）不带数字后缀 ⇒ 正则要允许两种形态
    const badDot = keys.filter(k => !/^bg-[a-z]+(-\d{3})?/.test(STATUS_META[k as typeof ALL[number]].dot))
    ok('2a dot 都是合法的 Tailwind 底色类（bg-xxx-NNN）', badDot.length === 0, badDot.join(','))
    const noTitle = keys.filter(k => !STATUS_META[k as typeof ALL[number]].title.trim())
    ok('2b 每条都有非空 title（悬停必须能问出「怎么了」）', noTitle.length === 0, noTitle.join(','))
  }

  // ---------- 3) 🔴 失败类必须露出文字 ----------
  {
    const silent = FAILURE.filter(k => !STATUS_META[k].text.trim())
    ok('3a 🔴 失败/异常类状态都有可见文字（否则用户零感知）', silent.length === 0, silent.join(','))
    ok('3b 失败类的文字都在 6 字以内（徽标位置放不下长句）',
      FAILURE.every(k => STATUS_META[k].text.length <= 6),
      FAILURE.map(k => `${k}=${STATUS_META[k].text}`).join(' '))
    // 负面对照：idle 刻意是空文字（待命状态不占位）—— 证明 3a 不是「一律要求非空」
    ok('3c idle 的 text 为空是刻意的（待命不占位）', STATUS_META.idle.text === '', JSON.stringify(STATUS_META.idle.text))
  }

  // ---------- 4) 失败类的说明要点明「数据没丢」或「会自动恢复」 ----------
  {
    // 这几条是用户最慌的场景：必须让人知道编辑还在、或稍后会自己好
    const reassurance = ['error', 'offline', 'rate-limited', 'too-large'] as const
    const weak = reassurance.filter(k => !/(本机|自动|稍后|不会丢|保留)/.test(STATUS_META[k].title))
    ok('4a 可恢复类失败都说明了「数据在哪 / 会不会自动恢复」', weak.length === 0,
      weak.map(k => `${k}: ${STATUS_META[k].title}`).join(' ｜ '))
  }

  console.log(`\nsyncStatusMeta: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
