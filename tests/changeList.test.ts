// ============ 3.3.3 · A2 本章变化清单 ============
//
// 钉住：
//   ① 预算：单次最多 10,000 字，超出明确截断（不静默发全书）；
//   ② 证据：每条 quote 必须逐字命中当前正文并定位；对不上就剔除；最多 3 条；
//   ③ 结论只有四种；0 条 ≠「空转」，材料为空 = 证据不足；
//   ④ 报告/「我不认同」本机专属，正文一变报告失效；
//   ⑤ 只由作者点击触发（静态契约：没有自动调用）。
import { __resetMockStores, memoryOps } from './mock-memory'
import {
  CHANGE_CONCLUSION_TEXT, CHANGE_MATERIAL_LIMIT, CHANGE_PROTOCOL_VERSION, buildChangeMaterial,
  concludeChanges, dissentKeyOf, fingerprintText, locateQuote, notRunReport, verifyChangeItems,
  type ChangeItem,
} from '../src/lib/audit/changeList'
import {
  addDissent, isReportCurrent, loadChangeList, loadDissent, removeDissent, saveChangeList,
} from '../src/lib/audit/changeListStore'
import { isLocalOnlyMetaKey } from '../src/lib/storage/sensitiveMeta'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-a2-change'
const CHAPTER = '第1章'
const TEXT = '陈渊在藏经阁找到一卷残简。残简上刻着镇界塔三个字。他这才知道，青岚宗的禁令与镇界塔有关。'

const itemOf = (over: Partial<ChangeItem> = {}): ChangeItem => ({
  id: 'chg-信息-0-12',
  type: '信息',
  before: '',
  after: '陈渊得知残简与镇界塔有关',
  quote: '残简上刻着镇界塔三个字',
  start: 14,
  end: 26,
  ...over,
})

async function main() {
  __resetMockStores()

  // ───────────────── ① 材料预算 ─────────────────
  {
    const short = buildChangeMaterial('短章')
    ok('短章不截断', !short.truncated && short.chars === 2)
    const long = buildChangeMaterial('字'.repeat(CHANGE_MATERIAL_LIMIT + 500))
    ok('超 10,000 字明确截断', long.truncated && long.material.length === CHANGE_MATERIAL_LIMIT)
    ok('截断后回报原章字数', long.totalChars === CHANGE_MATERIAL_LIMIT + 500 && long.chars === CHANGE_MATERIAL_LIMIT)
  }

  // ───────────────── ② 定位与核验 ─────────────────
  {
    const loc = locateQuote(TEXT, '残简上刻着镇界塔三个字')
    ok('逐字定位返回区间', !!loc && TEXT.slice(loc.start, loc.end) === '残简上刻着镇界塔三个字')
    ok('模糊/改写的引文不定位', locateQuote(TEXT, '残简上写着镇界塔三个字') === null)

    const reply = JSON.stringify({
      changes: [
        { type: '信息', before: '', after: '陈渊得知残简与镇界塔有关', quote: '残简上刻着镇界塔三个字' },
        { type: '信息', before: '', after: '编的', quote: '正文里根本没有这句话' },
        { type: '不存在的类型', after: 'x', quote: '陈渊在藏经阁找到一卷残简' },
        { type: '处境', before: '不知情', after: '意识到禁令与镇界塔有关', quote: '青岚宗的禁令与镇界塔有关' },
        { type: '关系', before: '', after: '多出来的一条', quote: '他这才知道' },
      ],
    })
    const items = verifyChangeItems(reply, TEXT)
    ok('引文对不上的整条剔除', !items.some(i => i.after === '编的'))
    ok('未知类型剔除', items.every(i => ['目标', '关系', '信息', '资源/地位', '处境或情绪认知'].includes(i.type)))
    ok('最多 3 条', items.length === 3, String(items.length))
    ok('每条都能在正文逐字命中', items.every(i => TEXT.slice(i.start, i.end) === i.quote))
    ok('类型别名归一（处境 ⇒ 处境或情绪认知）', items[1].type === '处境或情绪认知')

    ok('接受 {变化: [...]} 形状', verifyChangeItems({ 变化: [{ type: '目标', after: '想去找镇界塔', quote: '残简上刻着镇界塔三个字' }] }, TEXT).length === 1)
    ok('坏 JSON / 无对象返回空', verifyChangeItems('模型胡说八道', TEXT).length === 0 && verifyChangeItems('{}', TEXT).length === 0)
    ok('markdown 代码块能剥出来',
      verifyChangeItems('```json\n{"changes":[{"type":"信息","after":"x","quote":"残简上刻着镇界塔三个字"}]}\n```', TEXT).length === 1)
  }

  // ───────────────── ③ 结论口径 ─────────────────
  {
    ok('有线索 ⇒ 发现变化线索', concludeChanges([itemOf()], true) === 'found')
    ok('0 条但有材料 ⇒ 线索较少（不是"空转"）', concludeChanges([], true) === 'few')
    ok('没有材料 ⇒ 证据不足', concludeChanges([], false) === 'insufficient')
    ok('四种结论文案齐全（含未检测）',
      Object.keys(CHANGE_CONCLUSION_TEXT).length === 4 && CHANGE_CONCLUSION_TEXT['not-run'] === '未检测')
    const nr = notRunReport('c1', CHAPTER, TEXT)
    ok('未检测报告请求数 0、条目空', nr.conclusion === 'not-run' && nr.requestCount === 0 && nr.items.length === 0)
    ok('指纹含协议版本', nr.inputFingerprint.startsWith(`${CHANGE_PROTOCOL_VERSION}:`))
  }

  // ───────────────── ④ 本机报告与「我不认同」 ─────────────────
  {
    const report = {
      chapterId: 'c1', chapterTitle: CHAPTER, conclusion: 'found' as const,
      items: [itemOf()], material: buildChangeMaterial(TEXT), requestCount: 1,
      modelTag: 'test/model', protocolVersion: CHANGE_PROTOCOL_VERSION,
      inputFingerprint: fingerprintText(TEXT), at: 1,
    }
    await saveChangeList(PID, report, memoryOps)
    const loaded = await loadChangeList(PID, 'c1', memoryOps)
    ok('报告可读回', !!loaded && loaded.items.length === 1)
    ok('报告键登记为本机专属', isLocalOnlyMetaKey('auditChange::x'))
    ok('当前正文对得上 ⇒ 报告有效', isReportCurrent(report, 'c1', TEXT))
    ok('切章后失效', !isReportCurrent(report, 'c2', TEXT))
    ok('正文改一个字即失效', !isReportCurrent(report, 'c1', `${TEXT}改`))

    const it = loaded!.items[0]
    const after = await addDissent(PID, 'c1', it, memoryOps)
    ok('「我不认同」落本机并带作用域', after.length === 1 && after[0].key === dissentKeyOf('c1', it))
    ok('记录键登记为本机专属', isLocalOnlyMetaKey('auditChangeDissent::x'))
    ok('撤销后清空', (await removeDissent(PID, after[0].key, memoryOps)).length === 0)
    ok('项目级读取不串章之外的内容', (await loadDissent(PID, memoryOps)).length === 0)
  }

  // ───────────────── ⑤ 静态契约：只由作者点击触发 ─────────────────
  {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const panel = fs.readFileSync(path.join(process.cwd(), 'src/components/audit/ManuscriptCheckPanel.tsx'), 'utf8')
    ok('界面有明确入口与"1 次调用"提示',
      /生成本章变化清单/.test(panel) && /1 次调用/.test(panel))
    ok('界面先确认再发（含送审字数/截断说明）',
      /confirmDialog\(/.test(panel) && /不会自动重试/.test(panel))
    ok('没有自动调用（只在 onClick 里调）',
      (panel.match(/aiChapterChangeList\(/g) || []).length === 1
      && panel.indexOf('aiChapterChangeList(') > panel.indexOf('const runChangeList'))
    ok('迟到回包不写新章（isReportCurrent 校验）', /isReportCurrent\(report/.test(panel))

    const aiTasks = fs.readFileSync(path.join(process.cwd(), 'src/lib/ai/aiTasks.ts'), 'utf8')
    ok('提示词已登记进 PROMPT_ORDER', /'chapter-change-list'/.test(aiTasks))
    ok('提示词已进 PROMPT_SETS', /CHANGE_LIST_PROMPTS/.test(aiTasks))
  }

  console.log(`\nCHANGE_LIST ${pass} passed, ${fail} failed`)
  process.exitCode = fail === 0 ? 0 : 1
}

main().catch(e => { console.error(e); process.exitCode = 1 })