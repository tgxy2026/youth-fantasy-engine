// ============ 酒馆模式 · 注入额度体系（2026-10-05）============
//
// 【这组断言要钉住的三件事】
//   ① **两层额度的数值口径**：固定层 = 窗口 × 8%（下限 2400、上限 12000）；
//      动态层 = 窗口 × pct%（默认 15、可调 5~35）。边界与钳制。
//   ② **窗口兜底**：拿不到 / 不可信（< 2000）的窗口一律退 32768 ——
//      「宁可额度小，也不放大到作者没预期的规模」。
//   ③ **与 modelCapacity 的一致性**：本模块刻意零依赖（不 import modelCapacity），
//      所以那条「2000」的下限判据靠这里比对守住（改了一边不改另一边就会红）。
//
// 🔴 还有一条**跨模块口径**：`WORLD_MAX_CHARS` / `STORY_SETTING_MAX` 仍存在，
//    但已降级为「拿不到窗口时的兜底值」—— 有窗口时注入上限走这里算。
import {
  FIXED_QUOTA_RATIO, FIXED_QUOTA_MIN, FIXED_QUOTA_MAX,
  DYNAMIC_QUOTA_RATIO, DYNAMIC_QUOTA_PCT, FALLBACK_WINDOW_TOKENS,
  effectiveWindowTokens, fixedQuotaOf, dynamicQuotaOf, quotaProfileOf, fmtWindow,
} from '../src/lib/tavern/quotas'
import { MIN_SANE_WINDOW, FALLBACK_WINDOW } from '../src/lib/ai/modelCapacity'
import { WORLD_MAX_CHARS } from '../src/lib/tavern/world'
import { STORY_SETTING_MAX } from '../src/lib/tavern/story'
import { DEFAULT_TAVERN_SETTINGS } from '../src/lib/tavern/settings'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function main() {
  __resetMockStores()

  // ---------- 1) 常量口径 ----------
  {
    ok('固定层比例 = 8%', FIXED_QUOTA_RATIO === 0.08)
    ok('固定层下限 = 2400', FIXED_QUOTA_MIN === 2400)
    ok('固定层上限 = 12000', FIXED_QUOTA_MAX === 12000)
    ok('动态层默认比例 = 15%', DYNAMIC_QUOTA_RATIO === 0.15)
    ok('动态层默认档 = 15', DYNAMIC_QUOTA_PCT.default === 15)
    ok('动态层范围 5~35、步长 1',
      DYNAMIC_QUOTA_PCT.min === 5 && DYNAMIC_QUOTA_PCT.max === 35 && DYNAMIC_QUOTA_PCT.step === 1)
    ok('兜底窗口 = 32768', FALLBACK_WINDOW_TOKENS === 32768)
  }

  // ---------- 2) 窗口兜底 ----------
  {
    ok('null ⇒ 兜底', effectiveWindowTokens(null) === FALLBACK_WINDOW_TOKENS)
    ok('undefined ⇒ 兜底', effectiveWindowTokens(undefined) === FALLBACK_WINDOW_TOKENS)
    ok('NaN ⇒ 兜底', effectiveWindowTokens(Number.NaN) === FALLBACK_WINDOW_TOKENS)
    ok('负数 ⇒ 兜底', effectiveWindowTokens(-1) === FALLBACK_WINDOW_TOKENS)
    ok('小于 2000 ⇒ 兜底（多半是把 K 当词元数填了）', effectiveWindowTokens(1000) === FALLBACK_WINDOW_TOKENS)
    ok('正好 2000 ⇒ 采信', effectiveWindowTokens(2000) === 2000)
    ok('32768 ⇒ 原样', effectiveWindowTokens(32768) === 32768)
    ok('小数被向下取整', effectiveWindowTokens(32768.9) === 32768)
    // 🔴 与 modelCapacity 一致性：两处的「可信下限」改一边不改另一边就会红
    ok('🔴 MIN_SANE_WINDOW 与这里的 2000 判据一致（跨模块口径）', MIN_SANE_WINDOW === 2000)
    ok('🔴 FALLBACK_WINDOW 与这里同量级（跨模块口径）', FALLBACK_WINDOW === FALLBACK_WINDOW_TOKENS)
  }

  // ---------- 3) 固定层额度 ----------
  {
    // 小窗口 ⇒ 触下限 2400
    ok('窗口 32768 ⇒ 固定层触下限 2400（32768×8% = 2621 > 2400 不触）',
      fixedQuotaOf(32768) === Math.round(32768 * 0.08), String(fixedQuotaOf(32768)))
    ok('窗口 2000 ⇒ 固定层触下限 2400（2000×8% = 160）', fixedQuotaOf(2000) === 2400)
    ok('窗口 8192 ⇒ 固定层触下限 2400', fixedQuotaOf(8192) === 2400)
    ok('窗口 32768（32K）⇒ 2621', fixedQuotaOf(32768) === 2621)
    ok('窗口 65536（64K）⇒ 5243', fixedQuotaOf(65536) === 5243)
    ok('窗口 131072（128K）⇒ 10486', fixedQuotaOf(131072) === 10486)
    // 上限：窗口 200K ⇒ 16000 > 12000 ⇒ 触上限
    ok('窗口 200000 ⇒ 固定层触上限 12000', fixedQuotaOf(200000) === 12000)
    ok('窗口 1000000（1M）⇒ 仍是上限 12000', fixedQuotaOf(1000000) === 12000)
    // 兜底窗口也算得出来
    ok('不给窗口 ⇒ 按兜底 32768 算', fixedQuotaOf(null) === fixedQuotaOf(32768))
  }

  // ---------- 4) 动态层额度 ----------
  {
    ok('窗口 32768 × 默认 15% ⇒ 4915', dynamicQuotaOf(32768) === 4915, String(dynamicQuotaOf(32768)))
    ok('窗口 32768 × 25%（ST 出厂）⇒ 8192', dynamicQuotaOf(32768, 25) === 8192)
    ok('窗口 32768 × 5%（下限）⇒ 1638', dynamicQuotaOf(32768, 5) === 1638)
    ok('窗口 32768 × 35%（上限）⇒ 11469', dynamicQuotaOf(32768, 35) === 11469)
    // 越界钳制
    ok('pct 超 35 ⇒ 按 35 算', dynamicQuotaOf(32768, 80) === dynamicQuotaOf(32768, 35))
    ok('pct 低于 5 ⇒ 按 5 算', dynamicQuotaOf(32768, 1) === dynamicQuotaOf(32768, 5))
    ok('pct 负数 ⇒ 按 5 算', dynamicQuotaOf(32768, -10) === dynamicQuotaOf(32768, 5))
    ok('pct 非数 ⇒ 用默认 15', dynamicQuotaOf(32768, Number.NaN) === dynamicQuotaOf(32768, 15))
    ok('pct 传 null ⇒ 用默认 15', dynamicQuotaOf(32768, null) === dynamicQuotaOf(32768, 15))
    ok('不给窗口 + 给 pct ⇒ 两者都兜底', dynamicQuotaOf(null, 20) === dynamicQuotaOf(32768, 20))
  }

  // ---------- 5) 固定层 + 动态层 = 总注入上限 ----------
  {
    // 主人拍板的组合：32K 窗口下固定 2621 + 动态 4915 ≈ 7536，占窗口约 23%
    const w = 32768
    const sum = fixedQuotaOf(w) + dynamicQuotaOf(w)
    ok('🔴 两层之和不超过窗口的 25%（留足对话历史）', sum < w * 0.25,
      `${sum} vs ${Math.round(w * 0.25)}`)
    // 超大窗口：固定层有上限 12000，动态层仍按比例 ⇒ 不会被固定层吃光
    ok('🔴 大窗口下固定层有上限（12000），不会无限膨胀', fixedQuotaOf(1000000) === 12000)
  }

  // ---------- 6) quotaProfileOf：一次拿全套 ----------
  {
    const p = quotaProfileOf(32768, 20)
    ok('profile.windowTokens = 32768', p.windowTokens === 32768)
    ok('profile.windowFallback = false（窗口可信）', p.windowFallback === false)
    ok('profile.fixed 与 fixedQuotaOf 一致', p.fixed === fixedQuotaOf(32768))
    ok('profile.dynamic 与 dynamicQuotaOf 一致', p.dynamic === dynamicQuotaOf(32768, 20))
    ok('profile.dynamicPct = 20', p.dynamicPct === 20)

    const fb = quotaProfileOf(null)
    ok('🔴 窗口缺失 ⇒ windowFallback = true（界面据此提示）', fb.windowFallback === true)
    ok('窗口缺失 ⇒ 数值仍可用（兜底 32K）', fb.fixed > 0 && fb.dynamic > 0)
    ok('窗口缺失 ⇒ dynamicPct 用默认 15', fb.dynamicPct === 15)
  }

  // ---------- 7) fmtWindow ----------
  {
    ok('32768 ⇒ 32K', fmtWindow(32768) === '32K')
    ok('131072 ⇒ 128K', fmtWindow(131072) === '128K')
    ok('8192 ⇒ 8K', fmtWindow(8192) === '8K')
    ok('98304 ⇒ 96K', fmtWindow(98304) === '96K')
    ok('1M ⇒ 1024K（大值不缩写，免得看不出量级）', fmtWindow(1048576) === '1024K')
  }

  // ---------- 8) 设置项：dynamicQuotaPct ----------
  {
    ok('🔴 出厂默认 dynamicQuotaPct = 15', DEFAULT_TAVERN_SETTINGS.dynamicQuotaPct === 15)
    ok('它是数字（不是字符串）', typeof DEFAULT_TAVERN_SETTINGS.dynamicQuotaPct === 'number')
  }

  // ---------- 9) 旧常量降级为兜底（口径说明） ----------
  {
    // 这两个常量仍在（老调用点 / 单测引用），但引擎已改走额度体系。
    // 这里只钉住「它们仍是原来的值」，避免有人顺手删掉导致别处炸。
    ok('WORLD_MAX_CHARS 仍为 2400（已降级为兜底）', WORLD_MAX_CHARS === 2400)
    ok('STORY_SETTING_MAX 仍为 2400（已降级为兜底）', STORY_SETTING_MAX === 2400)
    // 兜底窗口下固定额度恰好 ≈ 旧常量量级 —— 这是「升级后不突变」的保证
    ok('🔴 32K 兜底窗口下固定额度 ≈ 旧常量 2400（升级不突变）',
      Math.abs(fixedQuotaOf(32768) - WORLD_MAX_CHARS) < 300,
      `${fixedQuotaOf(32768)} vs ${WORLD_MAX_CHARS}`)
  }

  console.log(`\ntavernQuota: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
