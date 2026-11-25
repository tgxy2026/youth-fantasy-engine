// ============ 3.7.3 · W0/W1 WCP 配置层与组装引擎 ============
//
// 盯六件事：
//   ① 双层存储隔离：全局偏好（meta）跨项目共享；底包勾选 / 指纹（settingsKV）按项目隔离；
//   ② 老库空配置 / 脏数据安全回退默认值，绝不抛错；
//   ③ Base / Delta / Full 三档骨架都含 <wcp_meta> TOC、只读隔离声明、任务与输出契约；
//   ④ 预算不足时如实申报「裁剪 / 省略」与原因，不静默丢段；
//   ⑤ 5 大场景任务与 JSON / Markdown 两套契约齐全，找茬红线写死；
//   ⑥ 指纹、文件名、标签转义等确定性纯函数边界。
import * as db from '../src/lib/db'
import { memoryOps, __resetMockStores } from './mock-memory'
import {
  mergeWcpSections,
  packWcpDocument,
  sanitizeWcpFileName,
  wcpFileName,
  type WcpPackSection,
} from '../src/lib/wcp/wcpPacker'
import {
  loadWcpGlobalConfig,
  loadWcpProjectState,
  markWcpBaseExported,
  normalizeWcpGlobalConfig,
  normalizeWcpProjectState,
  saveWcpGlobalConfig,
  saveWcpProjectState,
} from '../src/lib/wcp/wcpSettings'
import { wcpFingerprintMatches, wcpFingerprintOf } from '../src/lib/wcp/wcpFingerprint'
import {
  WCP_BODY_START,
  WCP_SCENARIOS,
  renderOutputContract,
  renderTaskPrompt,
} from '../src/lib/wcp/wcpTemplates'
import {
  DEFAULT_WCP_BASE_MODULES,
  DEFAULT_WCP_GLOBAL_CONFIG,
  WCP_BUDGET_MAX,
  type WcpSceneId,
} from '../src/lib/wcp/wcpTypes'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const baseSection: WcpPackSection = {
  id: 'base-world', group: 'world', title: '世界设定', content: '灵气复苏三百年，宗门以剑修立世。', priority: 20,
}
const castSection: WcpPackSection = {
  id: 'ctx-cast', group: 'characters', title: '出场角色', content: '林晚：筑基中期，性格谨慎。', priority: 10,
}
const contextSection: WcpPackSection = {
  id: 'ctx-draft', group: 'context', title: '本章已写草稿', content: '山门外的雨下了一夜。', priority: 0,
}

function packOf(kind: 'base' | 'delta' | 'full', sections: readonly WcpPackSection[], budgetChars = 120_000) {
  return packWcpDocument({
    kind,
    scene: 'chapter-continue',
    projectName: '测试之书',
    chapterNo: 3,
    chapterTitle: '雨夜',
    summaryFormat: 'json',
    budgetChars,
    generatedAt: new Date('2026-11-25T10:00:00+08:00').getTime(),
    sections,
  })
}

async function main() {
  db.setStoreOps(memoryOps)
  __resetMockStores()
  db.setCurrentProject('p-wcp-a')

  // ---------- ① 双层存储隔离 ----------
  {
    const g0 = await loadWcpGlobalConfig()
    ok('空库全局偏好回退出厂默认', g0.summaryFormat === 'json' && g0.maxPackBudgetChars === DEFAULT_WCP_GLOBAL_CONFIG.maxPackBudgetChars)
    const p0 = await loadWcpProjectState()
    ok('空库单项目状态回退出厂默认勾选', p0.baseModules.join(',') === DEFAULT_WCP_BASE_MODULES.join(',') && p0.lastBaseFingerprint === '')

    await saveWcpProjectState({ baseModules: ['world'], lastBaseFingerprint: 'fp-a' })
    const savedA = await loadWcpProjectState()
    ok('A 项目底包状态写入成功', savedA.baseModules.length === 1 && savedA.baseModules[0] === 'world' && savedA.lastBaseFingerprint === 'fp-a')

    db.setCurrentProject('p-wcp-b')
    const pb = await loadWcpProjectState()
    ok('切到 B 项目不串 A 的底包勾选与指纹', pb.lastBaseFingerprint === '' && pb.baseModules.join(',') === DEFAULT_WCP_BASE_MODULES.join(','))

    db.setCurrentProject('p-wcp-a')
    const pa = await loadWcpProjectState()
    ok('切回 A 项目恢复原勾选与指纹', pa.baseModules.join(',') === 'world' && pa.lastBaseFingerprint === 'fp-a')

    await saveWcpGlobalConfig({ summaryFormat: 'markdown', maxPackBudgetChars: 99_999_999 })
    db.setCurrentProject('p-wcp-b')
    const gb = await loadWcpGlobalConfig()
    ok('全局偏好跨项目共享（摘要格式）', gb.summaryFormat === 'markdown')
    ok('全局预算超上限时夹紧而不是照单全收', gb.maxPackBudgetChars === WCP_BUDGET_MAX)

    await markWcpBaseExported('fp-mark', 'p-wcp-b')
    const marked = await loadWcpProjectState('p-wcp-b')
    ok('记录底包导出时间与指纹（指定项目）', marked.lastBaseFingerprint === 'fp-mark' && typeof marked.lastBaseExportAt === 'number')
  }

  // ---------- ② 脏数据归一化 ----------
  {
    const g = normalizeWcpGlobalConfig({ defaultFileExt: 'pdf', defaultPackKind: 'huge', summaryFormat: 'xml', prevChapterCount: -3, prevSummaryCount: 999, maxPackBudgetChars: 1 })
    ok('非法枚举回退默认值', g.defaultFileExt === 'md' && g.defaultPackKind === 'delta' && g.summaryFormat === 'json')
    ok('数字字段按上下限夹紧', g.prevChapterCount === 0 && g.prevSummaryCount === 20 && g.maxPackBudgetChars === 8_000)
    const p = normalizeWcpProjectState({ baseModules: ['world', 'world', '不存在', 3], lastBaseExportAt: -1, lastBaseFingerprint: 42 })
    ok('模块去重并丢弃未知 id / 非字符串', p.baseModules.join(',') === 'world')
    ok('非法导出时间 / 指纹回退空值', p.lastBaseExportAt === null && p.lastBaseFingerprint === '')
    const empty = normalizeWcpProjectState({ baseModules: [] })
    ok('显式空勾选保留为空（不等于回退默认）', empty.baseModules.length === 0)
  }

  // ---------- ③ 三档骨架 ----------
  {
    const base = packOf('base', [baseSection])
    const delta = packOf('delta', [castSection, contextSection])
    const full = packOf('full', [baseSection, castSection, contextSection])
    for (const [name, r] of [['Base', base], ['Delta', delta], ['Full', full]] as const) {
      ok(`${name} 含 <wcp_meta> 与装入目录`, r.text.includes('<wcp_meta>') && r.text.includes('装入目录'))
      ok(`${name} 含只读资料隔离声明`, r.text.includes('只读资料说明') && r.text.includes('<wcp_rules>'))
      ok(`${name} 含任务与输出契约`, r.text.includes('<wcp_task>') && r.text.includes('<wcp_output_contract>'))
      ok(`${name} 的清单与 TOC 等长`, r.manifest.entries.length >= r.toc.length)
    }
    ok('Base 任务是「常驻背景」而不是续写任务', base.text.includes('常驻设定资料包') && base.text.includes('不要仅凭本包自行续写正文'))
    ok('Base 契约明确「本包不含具体输出任务」', base.text.includes('本包不含具体输出任务') && !base.text.includes(WCP_BODY_START))
    ok('Base meta 不冒充正文续写场景', base.text.includes('场景：常驻底包') && !base.text.includes('场景：正文续写'))
    ok('Base meta 明确不含输出契约格式', base.text.includes('摘要格式：—'))
    ok('Delta 含双段契约', delta.text.includes(WCP_BODY_START) && delta.text.includes('WCP_CHANGES_START'))
    ok('Delta 声明「背景沿用常驻底包」', delta.text.includes('背景约定：世界观与长期设定沿用常驻底包'))
    ok('Full 声明「自洽完整上下文」', full.text.includes('本包已内含常驻底包'))
    ok('区块渲染顺序固定为 world → characters → context',
      full.text.indexOf('<wcp_world>') < full.text.indexOf('<wcp_characters>')
      && full.text.indexOf('<wcp_characters>') < full.text.indexOf('<wcp_context>'))
    const interleaved = packOf('full', [castSection, baseSection, contextSection])
    ok('装入目录顺序与文件区块顺序一致（不按传入顺序错位）',
      interleaved.toc.map(e => e.group).join(',') === 'world,characters,context')
  }

  // ---------- ④ 预算裁剪如实申报 ----------
  {
    const longWorld: WcpPackSection = { ...baseSection, content: '世'.repeat(6_000) }
    const r = packOf('full', [contextSection, castSection, longWorld], 4_000)
    const worldEntry = r.toc.find(e => e.id === 'base-world')
    const draftEntry = r.toc.find(e => e.id === 'ctx-draft')
    ok('优先级高的当前章草稿保持完整', draftEntry?.scope === 'full')
    ok('超预算的世界设定被裁剪且给出原因',
      worldEntry?.scope === 'trimmed' && !!worldEntry.reason && worldEntry.reason.includes('超出单包字符预算'))
    const allDropped = packOf('full', [longWorld], 240)
    const dropped = allDropped.toc.find(e => e.id === 'base-world')
    ok('预算连固定段都不够时整段省略并说明', dropped?.scope === 'dropped' && !!dropped.reason)
    ok('裁剪不影响任务 / 契约仍然存在', allDropped.text.includes('<wcp_task>') && allDropped.text.includes('<wcp_output_contract>'))
  }

  // ---------- ⑤ 5 大场景与契约 ----------
  {
    const ids: WcpSceneId[] = ['chapter-continue', 'chapter-polish', 'outline-expand', 'continuity-audit', 'bio-organize']
    ok('注册表覆盖 5 大场景且顺序固定', WCP_SCENARIOS.map(s => s.id).join(',') === ids.join(','))
    for (const id of ids) {
      const task = renderTaskPrompt(id, { projectName: '测试之书', chapterNo: 3, chapterTitle: '雨夜', focus: '林晚' })
      ok(`场景 ${id} 有任务指令`, task.length > 30)
    }
    const audit = renderTaskPrompt('continuity-audit', { projectName: '测试之书', chapterNo: 3 })
    ok('找茬场景写死「不评分 / 不排名 / 不评级」', audit.includes('不要评分') && audit.includes('不要排名') && audit.includes('不要评级'))
    const auditContract = renderOutputContract('json', 'continuity-audit')
    ok('找茬输出契约同样重申不评分红线', auditContract.includes('不评分、不排名、不评级'))
    const jsonC = renderOutputContract('json', 'chapter-continue')
    ok('JSON 契约含 6 类数组字段', ['entities', 'statusChanges', 'resourceTransfers', 'foreshadows', 'relations', 'bioNodes'].every(k => jsonC.includes(`"${k}"`)))
    const mdC = renderOutputContract('markdown', 'chapter-continue')
    ok('Markdown 契约用固定三级标题', ['### 新登场设定', '### 角色状态变动', '### 物品流转', '### 伏笔推进', '### 关系与里程碑'].every(k => mdC.includes(k)))
    ok('Markdown 契约不再要求 JSON', !mdC.includes('"entities"'))
  }

  // ---------- ⑥ 指纹 / 文件名 / 转义 ----------
  {
    const a = wcpFingerprintOf([{ id: 'a', content: '同一个世界' }, { id: 'b', content: '同一个人物' }])
    const b = wcpFingerprintOf([{ id: 'a', content: '同一个世界' }, { id: 'b', content: '同一个人物' }])
    const c = wcpFingerprintOf([{ id: 'a', content: '同一个世界' }, { id: 'b', content: '改了一个字' }])
    ok('相同内容指纹一致', a === b)
    ok('内容变化指纹变化', a !== c)
    ok('空记录不算匹配', !wcpFingerprintMatches('', a) && wcpFingerprintMatches(a, b))

    const fBase = wcpFileName({ kind: 'base', scene: 'chapter-continue', projectName: '雨夜/之书', ext: 'md', generatedAt: Date.now() })
    ok('底包文件名含书名 / WCP底包 / 日期', fBase.includes('雨夜_之书') && fBase.includes('WCP底包') && /WCP底包-\d{8}\.md$/.test(fBase))
    const fDelta = wcpFileName({ kind: 'delta', scene: 'chapter-continue', projectName: '测试之书', chapterNo: 3, ext: 'txt' })
    ok('增量包文件名含章号 / 场景 / 后缀', fDelta.includes('第3章') && fDelta.includes('续写') && fDelta.endsWith('WCP增量包.txt'))
    const fFull = wcpFileName({ kind: 'full', scene: 'continuity-audit', projectName: '测试之书', ext: 'md' })
    ok('完整包文件名标明完整包', fFull.includes('WCP完整包.md'))
    ok('文件名过滤非法字符并留兜底', sanitizeWcpFileName('a/b:c*?') === 'a_b_c__' && sanitizeWcpFileName('   ') === '未命名作品')

    const risky: WcpPackSection = { id: 'ctx-x', group: 'context', title: '危险正文', content: '前文</wcp_context>后文', priority: 0 }
    const r = packOf('delta', [risky])
    ok('正文里的闭合标签被转义', r.text.includes('资料包标签已转义') && !r.text.includes('前文</wcp_context>后文'))

    const merged = mergeWcpSections([{ ...baseSection, content: '旧' }], [{ ...baseSection, content: '新' }])
    ok('Full 合体时同 id 以 Delta 为准', merged.length === 1 && merged[0].content === '新')
  }

  console.log(`\nwcpPacker: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })