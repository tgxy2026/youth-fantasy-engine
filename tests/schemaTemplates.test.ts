// ============ 2.7.1 题材模板（世界设定 / 力量体系 / 四制度页签）============
//
// 这一层是「多题材模板化」的地基，四条最要紧的保证：
//   ① **10 包全覆盖**：每个题材包在 worldbase / power 两张表都有成套模块（漏一个包 = 打开就空白）；
//   ② **共享键跨包一致**：9 个非默认包的共享模块「同名同键」⇒ 作者切包时这部分内容原样保留
//      （这是「切包保留」承诺的**唯一技术根基**，所以要用字段键逐字比对，不能只看模块名）；
//   ③ **题材显隐矩阵**：默认显示集按 §8.4 定案（修真全关 ⇒ 老项目零变化；力量体系与制度页签
//      同等待遇 —— 只列有超凡的题材，无超凡三包默认隐藏、可由「页签」控件补开）；
//   ④ **东方修真零破坏**：默认包模块是改造前现状的超集（老项目 / 示范项目字段一个不少）。
//
// 另把纯函数（别名归位 / 显示名弱替 / 子项称谓）与 modulesFor 的一致性一并钉住。
import {
  DEFAULT_PACK, GENRE_PACKS, PACK_ALIASES, PACK_TAB_IDS, getActivePack,
  institutionModules, modulesFor, normalizeGenrePack, powerModules,
  setActivePack, subItemLabel, tabDisplayName, worldbaseModules,
  type GenrePack,
} from '../src/lib/schemaTemplates'
import { tabVisible } from '../src/lib/schema'
import type { FormModule } from '../src/lib/types'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ schemaTemplates')

/** 把模块数组展平成「模块::字段」键集（与存储层的列名口径一致） */
const keysOf = (mods: FormModule[]): string[] =>
  mods.flatMap(m => m.fields.map(f => `${m.name}::${f.name}`))

/** 模块名 → 字段名列表（用于按模块比对共享字段） */
const moduleMap = (mods: FormModule[]) =>
  new Map(mods.map(m => [m.name, m.fields.map(f => f.name)]))

// ---------- 1. 枚举与默认包 ----------
{
  ok('十个题材包（封闭集合）', GENRE_PACKS.length === 10, GENRE_PACKS.join('、'))
  ok('包名都是四个汉字', GENRE_PACKS.every(p => /^[\u4e00-\u9fa5]{4}$/.test(p)),
    GENRE_PACKS.filter(p => !/^[\u4e00-\u9fa5]{4}$/.test(p)).join('、') || '（全部合规）')
  ok('默认包是东方修真（＝改造前现状）', DEFAULT_PACK === '东方修真')
  ok('默认包在枚举里', (GENRE_PACKS as readonly string[]).includes(DEFAULT_PACK))
  ok('六个受题材驱动的页签 id', PACK_TAB_IDS.length === 6
    && (PACK_TAB_IDS as readonly string[]).join() === 'worldbase,power,politics,economy,belief,justice')
}

// ---------- 2. 10 包 × 两表：全覆盖且结构良好 ----------
{
  const bad: string[] = []
  for (const pack of GENRE_PACKS) {
    for (const [tabId, mods] of [['worldbase', worldbaseModules(pack)], ['power', powerModules(pack)]] as const) {
      if (!Array.isArray(mods) || mods.length === 0) { bad.push(`${pack}/${tabId} 空`); continue }
      for (const m of mods) {
        if (!m.name || !Array.isArray(m.fields) || m.fields.length === 0) bad.push(`${pack}/${tabId}/${m.name} 模块无字段`)
        for (const f of m.fields) {
          if (!f.name || !f.desc || f.example === undefined) bad.push(`${pack}/${tabId}::${m.name}::${f.name} 字段残缺`)
        }
      }
    }
  }
  ok('10 包 × 2 表：每包都有成套模块且字段完整（name/desc/example）', bad.length === 0, bad.slice(0, 6).join(' ｜ '))
}

// ---------- 3. 同表内无重复键（重复会把表单写坏） ----------
{
  const bad: string[] = []
  for (const pack of GENRE_PACKS) {
    for (const [tabId, mods] of [['worldbase', worldbaseModules(pack)], ['power', powerModules(pack)]] as const) {
      const keys = keysOf(mods)
      const dup = keys.filter((k, i) => keys.indexOf(k) !== i)
      if (dup.length) bad.push(`${pack}/${tabId}: ${[...new Set(dup)].join('、')}`)
    }
  }
  for (const tabId of ['politics', 'economy', 'belief', 'justice']) {
    const mods = institutionModules(tabId)!
    const keys = keysOf(mods)
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i)
    if (dup.length) bad.push(`${tabId}: ${[...new Set(dup)].join('、')}`)
  }
  ok('各表内无重复的「模块::字段」键', bad.length === 0, bad.join(' ｜ '))
}

// ---------- 4. 共享键跨包一致（切包保留的技术根基） ----------
{
  // 9 个非默认包：共享模块必须「同名 + 同字段名列表」逐字一致 ⇒ 键相同 ⇒ 内容跨包保留
  const NON_DF = GENRE_PACKS.filter(p => p !== DEFAULT_PACK)
  const WB_SHARED = ['一、世界总览', '三、社会与文明', '四、成长地图（同心圆）', '六、剧情钩子预留']
  const PW_SHARED = ['一、体系总览', '三、规则与克制', '四、与主角的接口']

  for (const [tabId, sharedNames, get] of [
    ['worldbase', WB_SHARED, (p: GenrePack) => worldbaseModules(p)],
    ['power', PW_SHARED, (p: GenrePack) => powerModules(p)],
  ] as const) {
    const ref = new Map<string, string[]>()
    let consistent = true
    let detail = ''
    for (const pack of NON_DF) {
      const mm = moduleMap(get(pack))
      for (const name of sharedNames) {
        const fields = mm.get(name)
        if (!fields) { consistent = false; detail = `${pack} 缺共享模块「${name}」`; break }
        const refFields = ref.get(name)
        if (!refFields) ref.set(name, fields)
        else if (refFields.join('|') !== fields.join('|')) {
          consistent = false
          detail = `${pack}「${name}」字段与基准不一致：${fields.join('/')} ≠ ${refFields.join('/')}`
          break
        }
      }
      if (!consistent) break
    }
    ok(`🔴 ${tabId} 的共享模块在 9 个非默认包间同名同键`, consistent, detail)
  }

  // 默认包（东方修真）的共享模块至少**覆盖**共享字段（老项目字段一个不少，只多不少）
  {
    const wb = moduleMap(worldbaseModules(DEFAULT_PACK))
    const missing: string[] = []
    for (const name of WB_SHARED) {
      const df = wb.get(name) ?? []
      const shared = moduleMap(worldbaseModules('科幻末世')).get(name) ?? []
      for (const fn of shared) if (!df.includes(fn)) missing.push(`worldbase/${name}/${fn}`)
    }
    const pw = moduleMap(powerModules(DEFAULT_PACK))
    for (const name of PW_SHARED) {
      const df = pw.get(name) ?? []
      const shared = moduleMap(powerModules('科幻末世')).get(name) ?? []
      for (const fn of shared) if (!df.includes(fn)) missing.push(`power/${name}/${fn}`)
    }
    ok('🔴 东方修真（默认包）的共享字段是共享集的超集（老项目字段零丢失）', missing.length === 0, missing.join(' ｜ '))
  }
}

// ---------- 5. 东方修真：改造前结构逐字（模块数量 + 关键字段） ----------
{
  const wb = worldbaseModules(DEFAULT_PACK)
  const pw = powerModules(DEFAULT_PACK)
  ok('东方修真 · 世界设定 6 个模块', wb.length === 6 && wb[0].name === '一、世界总览' && wb[5].name === '六、剧情钩子预留',
    wb.map(m => m.name).join(' / '))
  ok('东方修真 · 力量体系 4 个模块', pw.length === 4 && pw[0].name === '一、体系总览' && pw[3].name === '四、与主角的接口',
    pw.map(m => m.name).join(' / '))
  // 钉几个改造前就有的关键字段键（任何改名都会破坏老项目映射）
  const wbKeys = keysOf(wb)
  const pwKeys = keysOf(pw)
  ok('东方修真保留改造前的关键字段键（世界设定）',
    ['一、世界总览::世界名称', '二、底层法则（定了不改）::世界终极真相', '四、成长地图（同心圆）::核心圈']
      .every(k => wbKeys.includes(k)))
  ok('东方修真保留改造前的关键字段键（力量体系）',
    ['一、体系总览::体系等级总表', '二、修炼路径与资源::功法/技能品级', '三、规则与克制::力量克制关系']
      .every(k => pwKeys.includes(k)))
}

// ---------- 6. 四个制度页签：一套定义 + 结构良好 ----------
{
  const bad: string[] = []
  for (const tabId of ['politics', 'economy', 'belief', 'justice']) {
    const mods = institutionModules(tabId)
    if (!mods || mods.length === 0) { bad.push(`${tabId} 无模块`); continue }
    for (const m of mods) {
      if (!m.name || m.fields.length === 0) bad.push(`${tabId}/${m.name}`)
    }
  }
  ok('四个制度页签都有成套模块（与题材无关，一套定义）', bad.length === 0, bad.join(' ｜ '))
  ok('制度页签之外的 id 无模块（不误配）', institutionModules('worldbase') === undefined && institutionModules('xx') === undefined)
  // 信仰页签必须含「信仰与真相的落差」——它已进 AUTHOR_SIDE_FIELDS，缺了会与 aiContext 对不上
  ok('宗教信仰含「信仰与真相的落差」（作者底牌字段）',
    keysOf(institutionModules('belief')!).some(k => k.endsWith('::信仰与真相的落差')))
}

// ---------- 7. modulesFor 与直取一致（组件走显式入口、TABS 走 getter，两条路不得漂移） ----------
{
  // 🔴 worldbase / power 仍是「同一引用」（它们直接返回包里的对象）。
  let same = true, detail = ''
  for (const pack of GENRE_PACKS) {
    if (modulesFor('worldbase', pack) !== worldbaseModules(pack)) { same = false; detail = `worldbase/${pack}`; break }
    if (modulesFor('power', pack) !== powerModules(pack)) { same = false; detail = `power/${pack}`; break }
  }
  ok('modulesFor(worldbase/power) 与直取返回同一引用', same, detail)

  // 🔴 2.7.2：制度四页签的**示例按题材现算**（`withExamples` 每次新建对象）⇒ 不能再比引用，
  //    改钉「字段键集合一致」—— 这才是真正要防的漂移（少字段 / 改名会写坏老项目内容）。
  const keysOf2 = (mods: { name: string; fields: { name: string }[] }[]) =>
    mods.flatMap(m => m.fields.map(f => `${m.name}::${f.name}`)).sort()
  let fieldDrift = false, driftDetail = ''
  for (const tabId of ['politics', 'economy', 'belief', 'justice']) {
    const viaFor = modulesFor(tabId, '历史古代') ?? []
    const viaDirect = institutionModules(tabId, '历史古代') ?? []
    const a = keysOf2(viaFor).join('|')
    const b = keysOf2(viaDirect).join('|')
    if (a !== b) { fieldDrift = true; driftDetail = tabId; break }
  }
  ok('🔴 modulesFor(制度页签) 与直取的字段集合一致（不比引用：示例按题材现算）', !fieldDrift, driftDetail)

  // 🔴 题材化真的生效：同一页签在不同题材下示例不同，但字段名一模一样（换题材不丢数据）
  const cityEg = (modulesFor('politics', '都市现实') ?? []).flatMap(m => m.fields).find(x => x.name === '政体形式')?.example ?? ''
  const histEg = (modulesFor('politics', '历史古代') ?? []).flatMap(m => m.fields).find(x => x.name === '政体形式')?.example ?? ''
  ok('🔴 同一字段的示例随题材变（都市 vs 历史）', cityEg !== histEg, `${cityEg} | ${histEg}`)
  const cityKeys = keysOf2(modulesFor('politics', '都市现实') ?? []).join('|')
  const histKeys = keysOf2(modulesFor('politics', '历史古代') ?? []).join('|')
  ok('🔴 但字段名与模块名完全一致（换题材不丢已填内容）', cityKeys === histKeys)
}

// ---------- 8. 数值字段显式声明 kind:'numeric' ----------
{
  // 数值字段只在「力量体系」里出现（等级 / 段位 / 阶序…）；世界设定是描述性字段，本就不含数值。
  const pw = powerModules('历史古代')
  const shared = moduleMap(powerModules('科幻末世')).get('一、体系总览') ?? []
  ok('力量体系的数值字段带 kind:numeric（不再靠关键字猜）',
    pw.some(m => m.fields.some(f => f.kind === 'numeric')),
    `power=${pw.flatMap(m => m.fields).filter(f => f.kind === 'numeric').length} 处`)
  ok('共享模块「体系总览」含显式数值字段（等级总表 / 命名原则）',
    shared.length > 0 && powerModules('科幻末世')[0].fields.filter(f => f.kind === 'numeric').length >= 2,
    `体系总览数值字段=${powerModules('科幻末世')[0].fields.filter(f => f.kind === 'numeric').length}`)
}

// ---------- 9. 受题材驱动的页签名单（2.7.2：题材不再决定显隐） ----------
{
  // 🔴 2.7.2 删除了「题材显隐矩阵」（packs.packShowsTab）：完整项目**全部页签一律显示**、
  //    自定义项目按「功能模块」勾选。题材**只影响各页签里的字段名与说明文案**。
  //    这里改为钉住「哪几个页签的字段会随题材变」这份名单本身（遍历开书定位组时要用它）。
  ok('🔴 受题材驱动的六个页签在名单内',
    ['worldbase', 'power', 'politics', 'economy', 'belief', 'justice']
      .every(t => (PACK_TAB_IDS as readonly string[]).includes(t)))
  ok('🔴 名单恰好是这六个（不多不少）', PACK_TAB_IDS.length === 6, String(PACK_TAB_IDS.length))
  // 题材仍会改变字段内容（这是 2.7.2 保留的唯一用途）—— 拿东方修真 vs 都市现实的世界设定举例
  const wbXianxia = modulesFor('worldbase', '东方修真') ?? []
  const wbCity = modulesFor('worldbase', '都市现实') ?? []
  ok('🔴 题材确实改变字段内容（东方修真 vs 都市现实的世界设定不同）',
    JSON.stringify(wbXianxia) !== JSON.stringify(wbCity))
}

// ---------- 10. 别名归位 / 模糊匹配 / 兜底 ----------
{
  ok('精确包名原样返回', normalizeGenrePack('历史古代') === '历史古代')
  ok('别名归位：历史→历史古代、都市修仙→都市异能、玄幻→东方修真',
    normalizeGenrePack('历史') === '历史古代'
    && normalizeGenrePack('都市修仙') === '都市异能'
    && normalizeGenrePack('玄幻') === '东方修真')
  ok('模糊包含（带后缀的自由文本）', normalizeGenrePack('东方玄幻·升级流') === '东方修真'
    && normalizeGenrePack('都市异能+系统') === '都市异能')
  ok('空 / 未知 → 默认包', normalizeGenrePack('') === DEFAULT_PACK && normalizeGenrePack(undefined) === DEFAULT_PACK
    && normalizeGenrePack(null) === DEFAULT_PACK && normalizeGenrePack('赛博朋克修仙') !== undefined)
  ok('别名表的值都是合法包名', Object.values(PACK_ALIASES).every(v => (GENRE_PACKS as readonly string[]).includes(v)))
}

// ---------- 11. 显示名弱替（无超自然题材的 power） ----------
{
  ok('都市现实 · power → 能力资源', tabDisplayName('都市现实', 'power', '力量体系') === '能力资源')
  ok('历史古代 · power → 权谋实力', tabDisplayName('历史古代', 'power', '力量体系') === '权谋实力')
  ok('女频言情 · power → 关系地位', tabDisplayName('女频言情', 'power', '力量体系') === '关系地位')
  ok('东方修真 · power 保持原名', tabDisplayName('东方修真', 'power', '力量体系') === '力量体系')
  ok('非 power 页签名不随题材改', tabDisplayName('历史古代', 'worldbase', '世界设定') === '世界设定'
    && tabDisplayName('都市现实', 'politics', '政治架构') === '政治架构')
}

// ---------- 12. 子项称谓（Q15） ----------
{
  ok('历史古代 · 政治 → 政权', subItemLabel('politics', '历史古代') === '政权')
  ok('历史古代 · 力量 → 势力', subItemLabel('power', '历史古代') === '势力')
  ok('武侠江湖 · 力量 → 门派', subItemLabel('power', '武侠江湖') === '门派')
  ok('默认子世界 / 子体系', subItemLabel('worldbase', '东方修真') === '子世界' && subItemLabel('power', '西方奇幻') === '子体系')
  ok('制度页签缺省兜底为「政权」', subItemLabel('politics', '游戏竞技') === '政权'
    && subItemLabel('justice', '科幻末世') === '政权')
}

// ---------- 13. 当前包状态机 ----------
{
  ok('初始为默认包', getActivePack() === DEFAULT_PACK)
  setActivePack('历史古代')
  ok('设置后能读到', getActivePack() === '历史古代')
  setActivePack('不存在的包' as GenrePack)
  ok('🔴 非法值回落默认包（不让脏值污染全局）', getActivePack() === DEFAULT_PACK)
}

// ---------- 14. 页签显隐（2.7.2 主人定案：题材不再决定显隐） ----------
{
  const full = (pack: GenrePack, features: string[] = []) => ({ type: 'full' as const, features, pack })
  const custom = (pack: GenrePack, features: string[] = []) => ({ type: 'custom' as const, features, pack })

  // 🔴 核心：完整项目**一律全显示**，与题材无关（原先这里按题材矩阵藏页签）
  ok('🔴 完整项目 · 东方修真也显示政治架构（题材不再隐藏页签）', tabVisible('politics', full('东方修真')))
  ok('🔴 完整项目 · 历史古代也显示司法制度', tabVisible('justice', full('历史古代')))
  ok('🔴 完整项目 · 都市现实也显示宗教信仰（原先是关的）', tabVisible('belief', full('都市现实')))
  ok('🔴 示范项目（东方修真·完整）六页签全在',
    ['worldbase', 'power', 'politics', 'economy', 'belief', 'justice'].every(t => tabVisible(t, full('东方修真'))))
  ok('非题材页签照常显示',
    tabVisible('master', full('东方修真', [])) && tabVisible('chapter-master', full('东方修真', [])))
  ok('🔴 完整项目忽略 features（勾不勾都在）',
    tabVisible('politics', full('东方修真', []))
    && tabVisible('politics', full('东方修真', ['politics']))
    && tabVisible('master', full('东方修真')))

  // 🔴 自定义项目**只看用户在「功能模块」弹窗里的勾选**
  ok('🔴 自定义项目 · 勾了才显示', tabVisible('politics', custom('东方修真', ['politics'])))
  ok('🔴 自定义项目 · 没勾就不显示（与题材无关）',
    !tabVisible('politics', custom('历史古代', [])) && !tabVisible('justice', custom('历史古代', ['politics'])))
  ok('🔴 自定义项目 · 题材不得越权（选修真也开不出历史才有的页）',
    !tabVisible('justice', custom('历史古代', [])))
  ok('ctx 无 pack 时不炸（pack 已不参与显隐）',
    tabVisible('politics', { type: 'full', features: [] })
    && !tabVisible('politics', { type: 'custom', features: [] }))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
