// ============ 3.3.1 · P2：页签聚焦引导（几何 + 状态 + 内容守卫） ============
//
// 钉死三件事：
//   ① 高亮框与卡片的位置算得对（纯算术，可回归；含小窗口与「目标占大半屏」两种降级）；
//   ② 观看状态：完成 / 跳过 / 中断三态不同待遇，写入不会用旧集合覆盖别人刚写的记录；
//   ③ 锚点必须真的存在于对应页面源码里 —— 写错锚点的后果是「引导静默降级成居中说明」，
//      不报错、没人发现，所以这里按文件逐个核。
import fs from 'node:fs'
import path from 'node:path'
import { computeGuideLayout, guideMasks } from '../src/lib/help/guideLayout'
import { PAGE_GUIDES, getPageGuide, guideRecordKey } from '../src/lib/help/guides'
import { ALL_TAB_IDS } from '../src/lib/help/registry'
import { getHelpArticle } from '../src/lib/help/registry'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ---------- ① 几何 ----------
{
  const viewport = { width: 1200, height: 800 }
  const card = { width: 352, height: 210 }

  const below = computeGuideLayout({ target: { top: 100, left: 400, width: 200, height: 40 }, viewport, card })
  ok('下方有空间 ⇒ 卡片在高亮下方', below.placement === 'below' && below.card.top > 140)
  ok('高亮孔正好套住目标（含外扩）', !!below.hole && below.hole.top === 92 && below.hole.height === 56)

  const above = computeGuideLayout({ target: { top: 700, left: 400, width: 200, height: 40 }, viewport, card })
  ok('下方放不下但上方够 ⇒ 卡片在高亮上方', above.placement === 'above' && above.card.top + card.height <= 700)

  const big = computeGuideLayout({ target: { top: 40, left: 0, width: 1200, height: 700 }, viewport, card })
  ok('目标占大半屏 ⇒ 卡片贴底，不硬塞缝里', big.placement === 'bottom' && big.card.top === viewport.height - card.height - 12)

  const tiny = computeGuideLayout({ target: { top: 380, left: 500, width: 200, height: 40 }, viewport: { width: 420, height: 520 }, card })
  ok('小窗口里卡片仍在视口内且不压住高亮孔', (tiny.placement === 'above' || tiny.placement === 'bottom')
    && tiny.card.top >= 12 && tiny.card.top + card.height <= 520
    && (tiny.card.top + card.height <= tiny.hole!.top || tiny.card.top >= tiny.hole!.top + tiny.hole!.height),
    `${tiny.placement}@${tiny.card.top}`)

  const cramped = computeGuideLayout({ target: { top: 150, left: 20, width: 200, height: 100 }, viewport: { width: 420, height: 360 }, card })
  ok('上下真的都放不下 ⇒ 贴底（不遮住高亮孔的中部说明仍可读）', cramped.placement === 'bottom' && cramped.card.top >= 12)

  const none = computeGuideLayout({ target: null, viewport, card })
  ok('没有高亮目标 ⇒ 居中说明且无遮罩孔', none.hole === null && none.placement === 'center')

  const offscreen = computeGuideLayout({ target: { top: -40, left: -30, width: 200, height: 40 }, viewport, card })
  ok('目标部分在视口外 ⇒ 孔夹回视口内', !!offscreen.hole && offscreen.hole.top === 0 && offscreen.hole.left === 0)

  const rightEdge = computeGuideLayout({ target: { top: 100, left: 1100, width: 80, height: 40 }, viewport, card })
  ok('目标靠右 ⇒ 卡片左移不越出视口', rightEdge.card.left + card.width <= viewport.width)

  const masks = guideMasks(below.hole, viewport)
  ok('遮罩切成四块（中间留孔）', masks.length === 4)
  ok('遮罩总覆盖视口除孔以外的区域', masks.every(mask => mask.width >= 0 && mask.height >= 0)
    && masks.reduce((sum, mask) => sum + mask.width * mask.height, 0)
      === viewport.width * viewport.height - below.hole!.width * below.hole!.height,
    masks.map(m => `${m.top},${m.left},${m.width}x${m.height}`).join(' | '))
  ok('无目标时用一整块遮罩', guideMasks(null, viewport).length === 1)
}

// ---------- ② 观看状态（用最小的 localStorage / window 桩） ----------
{
  const store = new Map<string, string>()
  const localStorageStub = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size },
  }
  const globalAny = globalThis as unknown as Record<string, unknown>
  globalAny.localStorage = localStorageStub
  globalAny.window = {
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {},
  }

  const prefs = await import('../src/lib/settings/guidePrefs')

  ok('默认自动引导是开着的', prefs.isGuideAutoEnabled())
  prefs.setGuideAutoEnabled(false)
  ok('关掉自动引导能落盘', !prefs.isGuideAutoEnabled())
  prefs.setGuideAutoEnabled(true)
  ok('也能恢复自动引导', prefs.isGuideAutoEnabled())

  const key = 'demo-guide@1'
  ok('没记录时不像「看过」', !prefs.hasGuideRecord(key))
  prefs.markGuideDone(key)
  ok('完成后记成「看过」', prefs.hasGuideRecord(key) && prefs.isGuideDone(key))
  ok('完成与跳过是两种记录（跳过不等于学会）', !prefs.readGuideStateSnapshot().skipped.has(key))

  const skipped = 'demo-guide-2@1'
  prefs.markGuideSkipped(skipped)
  ok('跳过也记成「看过」但不等于完成', prefs.hasGuideRecord(skipped) && !prefs.isGuideDone(skipped))

  // 合并写入：模拟另一个实例刚写了一条，不能被本次的旧集合覆盖
  prefs.markGuideDone('other@1')
  ok('新记录不会覆盖既有记录', prefs.hasGuideRecord(key) && prefs.hasGuideRecord('other@1') && prefs.hasGuideRecord(skipped))

  prefs.resetGuide(key)
  ok('重置本页只清这一条', !prefs.hasGuideRecord(key) && prefs.hasGuideRecord('other@1'))
  prefs.resetAllGuides()
  ok('重置全部清空所有引导记录', prefs.guideRecordCount() === 0)
  ok('重置引导不动自动开关', prefs.isGuideAutoEnabled())
}

// ---------- ③ 内容与锚点守卫 ----------
{
  const anchorsByFile: Record<string, string> = {
    'src/components/sheets/FormSheet.tsx': 'src/components/sheets/FormSheet.tsx',
    'src/components/editor/NovelEditor.tsx': 'src/components/editor/NovelEditor.tsx',
    'src/components/editor/NovelEditorChapterTree.tsx': 'src/components/editor/NovelEditorChapterTree.tsx',
    'src/components/sheets/TableSheet.tsx': 'src/components/sheets/TableSheet.tsx',
  }
  const sources = Object.fromEntries(Object.keys(anchorsByFile).map(file => [file, read(file)]))
  const allSource = Object.values(sources).join('\n')

  ok('三个样板都在（普通表单页 / 正文 / 空态）',
    ['positioning', 'editor', 'foreshadow'].every(tabId => !!getPageGuide(tabId)))
  ok('每个引导的页签都真实存在', PAGE_GUIDES.every(guide => ALL_TAB_IDS.includes(guide.tabId)),
    PAGE_GUIDES.map(g => g.tabId).join('、'))
  ok('引导 id 唯一', new Set(PAGE_GUIDES.map(g => g.id)).size === PAGE_GUIDES.length)
  ok('记录键带修订号（改版后老记录不算数）', PAGE_GUIDES.every(guide => guideRecordKey(guide) === `${guide.id}@${guide.revision}`))
  ok('关联的手册文章真实存在（没有就干脆不挂）',
    PAGE_GUIDES.every(guide => !guide.articleId || !!getHelpArticle(guide.articleId)),
    PAGE_GUIDES.filter(g => g.articleId && !getHelpArticle(g.articleId)).map(g => g.articleId).join('、'))
  ok('步数在 2～5 之间（简单页可以更短，不凑步数）',
    PAGE_GUIDES.every(guide => guide.steps.length >= 2 && guide.steps.length <= 5),
    PAGE_GUIDES.map(g => `${g.id}:${g.steps.length}`).join(' '))
  ok('每一步都有标题与正文', PAGE_GUIDES.every(guide => guide.steps.every(step => step.title.trim().length > 0 && step.body.trim().length > 0)))
  ok('同一条引导内步骤 id 不重复', PAGE_GUIDES.every(guide => new Set(guide.steps.map(s => s.id)).size === guide.steps.length))

  const missingAnchors = PAGE_GUIDES.flatMap(guide => guide.steps
    .filter(step => step.anchor && !allSource.includes(`data-guide="${step.anchor}"`))
    .map(step => `${guide.id}:${step.anchor}`))
  ok('🔴 每个锚点都在页面源码里真实存在（写错会静默降级）', missingAnchors.length === 0, missingAnchors.join('、'))
}

// ---------- ④ 接入与行为守卫 ----------
{
  const overlay = read('src/components/help/GuideOverlay.tsx')
  const hook = read('src/components/help/usePageGuide.ts')
  const prefs = read('src/lib/settings/guidePrefs.ts')
  const form = read('src/components/sheets/FormSheet.tsx')
  const editor = read('src/components/editor/NovelEditor.tsx')
  const table = read('src/components/sheets/TableSheet.tsx')
  const guidePage = read('src/components/app/GuidePage.tsx')

  ok('🔴 引导层低于模态（保存失败 / 确认框优先）', /const GUIDE_Z = Z\.modal - 100/.test(overlay))
  ok('Escape 跳过且避开输入法组合', /Escape/.test(overlay) && /isComposing/.test(overlay))
  ok('Tab 焦点锁在卡片内', /event\.key !== 'Tab'/.test(overlay) && /focusables\[focusables\.length - 1\]/.test(overlay))
  ok('读屏能感知步骤变化', /aria-live="polite"/.test(overlay))
  ok('结束把焦点还给原触发元素', /restoreFocus/.test(overlay) && /previous\.focus/.test(overlay))
  ok('目标不可见时降级而不是死等', /if \(!target\) \{ setRect\(null\); return \}/.test(overlay))
  ok('卡片可滚且步骤/退出保持可达', /overflowY: 'auto'/.test(overlay))

  ok('只有页面就绪 + 没看过 + 开着自动 ⇒ 才自动弹', /if \(!ready \|\| busy \|\| running\) return/.test(hook)
    && /if \(hasGuideRecord\(key\)\) return/.test(hook) && /if \(!isGuideAutoEnabled\(\)\) return/.test(hook))
  ok('🔴 中断不写持久记录（下次还能重看）', /interrupted\.current\.add\(record\)/.test(hook))
  ok('换页签清空中断记忆', /interrupted\.current\.clear\(\)/.test(hook))
  ok('关掉自动引导时顺手记一次跳过', /setGuideAutoEnabled\(false\)[\s\S]{0,200}markGuideSkipped/.test(hook))

  ok('🔴 网页云端没有稳定账号标识 ⇒ 只存会话内', /WEB_CLOUD \? 'session' : 'persistent'/.test(prefs))
  ok('写入前重新读取再合并（不覆盖别人的记录）', /const current = readSet\(kind\)/.test(prefs))
  ok('同窗口与跨窗口都能同步', /addEventListener\(PREF_EVENT/.test(prefs) && /addEventListener\('storage'/.test(prefs))

  ok('普通表单页接入（hook + 卡片 + 本页指引）', /usePageGuide/.test(form) && /GuideOverlay/.test(form) && /PageGuideButton/.test(form))
  ok('正文页接入', /usePageGuide/.test(editor) && /GuideOverlay/.test(editor) && /PageGuideButton/.test(editor))
  ok('空态表格页接入', /usePageGuide/.test(table) && /GuideOverlay/.test(table) && /PageGuideButton/.test(table))
  ok('使用指南页提供开关与重置', /GuideSettings/.test(guidePage))
}

console.log(`\n—— pageGuide 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
