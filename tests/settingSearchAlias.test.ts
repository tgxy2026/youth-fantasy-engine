// ============ #011 收尾：设定检索同步显示「字段显示名」（2026-10-04）============
//
// 背景：2.7.3 的字段显示名覆盖了表格 19 + 表单 4 + 卡片 6 + 细纲 2 个页签，**唯独设定检索页没接** ——
// 作者在页签里把「契约/驯化关系」改叫「契约束缚」，切到检索页还印着原字段名，两边对不上。
//
// 主人 2026-10-04 拍板的口径：**检索页同步显示、但只读** ——
// 改名入口仍只在原页签的「字段名」按钮，检索页不开第二个改名点。
//
// 🔴 本文件钉住三件事（本项目惯例：结构假设一旦漂移就是静默失明，必须显式写测试）：
//   ① 检索页确实读了别名并用于展示（含搜索匹配）；
//   ② 检索页**不得**出现改名入口（`<FieldAliasButton`）；
//   ③ 别名缓存带项目 id —— 换项目不许把上一本书的列名端过来（本轮发现并修掉的真 bug）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as db from '../src/lib/db'
import {
  loadAliases, saveAliases, invalidateAliasCache, sanitizeAliases, labelMapOf, aliasKeyOf,
} from '../src/lib/settings/fieldAlias'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, '::', e) } }

function read(rel: string): string {
  try { return readFileSync(path.join(process.cwd(), rel), 'utf8') } catch { return '' }
}

const COLS = ['编号', '名称', '契约/驯化关系', '威胁等级']
/** 卡片页签的字段键形态（`模块名::字段名`）—— 与 `moduleAliasTargets` 同源 */
const CARD_KEYS = ['一、基础信息::姓名', '一、基础信息::人物状态', '二、外貌::发色']

async function main() {
  __resetMockStores()
  const search = read('src/components/settings/SettingSearch.tsx')

  // ---------- ① 检索页确实接了别名（只读展示） ----------
  // 3.2.0 · T3：显示名统一走「采用模板 > 轻量定义 > 别名」的解析层，不再单独读别名
  ok('源码闸：检索页按统一口径读显示名（含轻量定义）', search.includes('loadFieldLabels'))
  ok('🔴 源码闸：卡片字段键与「字段名」按钮**同源**（moduleAliasTargets，别自己再拼一份）',
    search.includes("import { moduleAliasTargets } from './FieldAliasButton'")
    || search.includes("import { moduleAliasTargets } from '@/components/sheets/FieldAliasButton'"))
  ok('源码闸：DocField 带 alias（只读显示名）', /alias\?: string/.test(search))
  ok('🔴 源码闸：展示一律走 `f.alias ?? f.label`（字段名 + 占位符至少两处）',
    (search.match(/f\.alias \?\? f\.label/g) ?? []).length >= 2)
  ok('源码闸：检索匹配也认作者起的名字（否则「看见了却搜不到」）',
    /\(f\.alias \?\? ''\)/.test(search))
  ok('源码闸：别名 / 轻量定义变了都要重建检索索引',
    /\[reloadKey, hiddenTabsKey, aliasRev, defRev(?:, [\w]+)*\]/.test(search) && search.includes('useFieldDefinitionRevision'))
  ok('源码闸：帮助文案写明「只读不改」', search.includes('这里只读不改'))

  // ---------- ② 🔴 只读页签不许出现第二个改名入口 ----------
  // 主人 2026-10-04 明确：检索页同步显示即可，**改名仍回原页签**。
  // 一旦这里渲染了 <FieldAliasButton，同一个字段名就有了两处能改的地方 —— 必然各改各的。
  ok('🔴 源码闸：检索页**不渲染** FieldAliasButton（改名只准回原页签）',
    !/<FieldAliasButton/.test(search))

  // ---------- ③ 存储键口径：别名只影响「给人看的字」 ----------
  ok('🔴 别名 map 的键就是存储键（表格 = 列名）',
    sanitizeAliases(COLS, { '契约/驯化关系': '契约束缚' })['契约/驯化关系'] === '契约束缚')
  ok('卡片键改显示名后取回的是显示名',
    labelMapOf(CARD_KEYS, { '一、基础信息::姓名': '角色名' })['一、基础信息::姓名'] === '角色名')
  ok('卡片键未改名时只显示字段名（剥掉模块前缀）',
    labelMapOf(CARD_KEYS, {})['一、基础信息::姓名'] === '姓名')

  // ---------- ④ 🔴 跨项目不串味（本轮修掉的真 bug） ----------
  // 起因：缓存原先只按 tabId 存，而真实存储键是 `${pid}::fieldAlias::<tabId>`（项目级、随项目导出/同步走）。
  // 换项目后 tabId 不变 ⇒ 命中旧缓存 ⇒ 在 A 书改的列名出现在 B 书。给检索页接别名后这个泄漏会更显眼。
  invalidateAliasCache()
  db.setCurrentProject('projA')
  await saveAliases('races', COLS, { '契约/驯化关系': '契约束缚' })
  ok('项目 A：改过的显示名立刻可读', (await loadAliases('races'))['契约/驯化关系'] === '契约束缚')
  ok('项目 A 的落盘键带项目前缀',
    (await db.getSetting<Record<string, string>>(aliasKeyOf('races'), {}))['契约/驯化关系'] === '契约束缚')

  db.setCurrentProject('projB')
  // 🔴 负面对照：若缓存不比对 pid，这一条会拿到 '契约束缚'（A 书的名字泄漏进 B 书）
  ok('🔴 换项目后**不**沿用上一本的显示名（负面对照：去掉 pid 比对则此处变红）',
    (await loadAliases('races'))['契约/驯化关系'] === undefined)

  db.setCurrentProject('projA')
  ok('切回项目 A 仍读到自己的显示名', (await loadAliases('races'))['契约/驯化关系'] === '契约束缚')
  db.setCurrentProject('')

  // ---------- ⑤ 源码闸：别名缓存必须带项目 id ----------
  const fa = read('src/lib/settings/fieldAlias.ts')
  ok('🔴 源码闸：缓存条目带 pid', /new Map<string, \{ pid: string; map: AliasMap \}>/.test(fa))
  ok('🔴 源码闸：取缓存前比对 pid（`hit.pid === pid`）', fa.includes('hit.pid === pid'))
  ok('源码闸：导出跨表订阅 hook（检索页要同时看多张表）', fa.includes('export function useAliasRevision'))
  // 负面对照：这行若退回「只按 tabId 命中」，上面第 ④ 组必然变红
  ok('源码闸：不再有裸 cache.get(tabId) 直接当返回值', !/return cache\.get\(tabId\)/.test(fa))
  // 🔴 字面 NUL 会让 grep / ripgrep 把整个文件判成 binary（只报文件名、不给行号），全仓扫描在该文件上失明
  ok('🔴 源码闸：fieldAlias.ts 不含字面控制字符（NUL）',
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(fa))

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed')
  if (fail > 0) process.exit(1)
}
main().catch(e => { console.log('FAIL 未捕获异常:', e?.stack ?? e); process.exit(1) })
