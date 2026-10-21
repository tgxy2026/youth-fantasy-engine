// ============ A1 本章资料区 + A3 变化事件 · 单元测试 ============
//
// 钉住：
//   ① 按有效模板分组展示
//   ② 通过用途突出
//   ③ 资料绑定与跳转
//   ④ 缺用途降级
//   ⑤ 正文引用定位
//   ⑥ 变化事件记录与合并
//   ⑦ 影响证据生成
//   ⑧ 直接依据与相关性复核
//   ⑨ 事件去重与上限
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import {
  groupMaterialsByTemplate,
  promoteByPurpose,
  checkMaterialJump,
  fallbackForMissingPurpose,
  locateBodyQuote,
  createMaterialPanelState,
  switchTab,
  switchChapter,
  normalizeChapterContextBinding,
  findOutlineReferenceSuggestions,
  outlinePurposeForField,
  type ChapterMaterial,
} from '../src/lib/revision/chapterContext'
import {
  createChangeEvent,
  mergeEvents,
  computeDirectImpact,
  reviewRelevance,
  deduplicateEvents,
  checkEventLimit,
  updateDisposition,
  isNewDisposition,
  type ChangeEvent,
  type ChangeEventType,
  type ImpactEvidence,
} from '../src/lib/revision/changeEvents'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

function mkMaterial(over: Partial<ChapterMaterial> = {}): ChapterMaterial {
  return {
    id: over.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
    kind: over.kind ?? 'other',
    name: over.name ?? '测试资料',
    value: over.value ?? '测试值',
    source: over.source ?? 'ch1',
    bound: over.bound ?? true,
    ...over,
  }
}

// ───────────────── ① 按有效模板分组展示 ─────────────────
function case1() {
  const materials: ChapterMaterial[] = [
    mkMaterial({ id: '1', kind: 'character', name: '角色1', purpose: '人物' }),
    mkMaterial({ id: '2', kind: 'event', name: '事件1', purpose: '事件' }),
    mkMaterial({ id: '3', kind: 'scene', name: '场景1', purpose: '场景' }),
    mkMaterial({ id: '4', kind: 'other', name: '其他1' }),
  ]

  const groups = groupMaterialsByTemplate(materials, ['人物', '事件', '场景'])
  ok('①① 分组数量', groups.length === 4)
  ok('①② 角色组', groups.find(g => g.groupName === 'character')?.items.length === 1)
  ok('①③ 其他组', groups.find(g => g.groupName === '其他')?.items.length === 1)
}

// ───────────────── ② 通过用途突出 ─────────────────
function case2() {
  const materials: ChapterMaterial[] = [
    mkMaterial({ id: '1', kind: 'character', name: '角色1' }),
    mkMaterial({ id: '2', kind: 'event', name: '事件1' }),
    mkMaterial({ id: '3', kind: 'scene', name: '场景1' }),
  ]

  const promoted = promoteByPurpose(materials, ['event', 'character', 'scene'])
  ok('②① 排序正确', promoted[0].kind === 'event' && promoted[1].kind === 'character')
}

// ───────────────── ③ 资料绑定与跳转 ─────────────────
function case3() {
  const bound = mkMaterial({ id: '1', bound: true, jumpTarget: 'ch2' })
  const r1 = checkMaterialJump(bound)
  ok('③① 可跳转', r1.canJump && r1.jumpTarget === 'ch2')

  const unbound = mkMaterial({ id: '2', bound: false })
  const r2 = checkMaterialJump(unbound)
  ok('③② 未绑定不可跳转', !r2.canJump && r2.jumpReason?.includes('未绑定'))

  const noTarget = mkMaterial({ id: '3', bound: true, jumpTarget: undefined })
  const r3 = checkMaterialJump(noTarget)
  ok('③③ 无目标不可跳转', !r3.canJump && r3.jumpReason?.includes('无跳转目标'))
}

// ───────────────── ④ 缺用途降级 ─────────────────
function case4() {
  const materials: ChapterMaterial[] = [
    mkMaterial({ id: '1', purpose: '人物' }),
    mkMaterial({ id: '2', purpose: undefined }),
    mkMaterial({ id: '3', purpose: '不在范围' }),
  ]

  const fallbacks = fallbackForMissingPurpose(materials, ['人物', '事件'])
  ok('④① 无用途降级', fallbacks[0].usable && fallbacks[1].fallbackReason.includes('无用途'))
  ok('④② 不在范围', !fallbacks[2].usable && fallbacks[2].fallbackReason.includes('不在范围'))
}

// ───────────────── ⑤ 正文引用定位 ─────────────────
function case5() {
  const body = '这是第一章的正文内容。\n第二段内容在这里。\n第三段。'

  const r1 = locateBodyQuote('正文内容', body)
  ok('⑤① 逐字命中', r1.located && r1.paragraphIndex === 0)

  const r2 = locateBodyQuote('不存在', body)
  ok('⑤② 未命中', !r2.located)

  const r3 = locateBodyQuote('第二段内容', body)
  ok('⑤③ 多段定位', r3.located && r3.paragraphIndex === 1)
}

// ───────────────── ⑥ 资料区状态 ─────────────────
function case6() {
  const state = createMaterialPanelState('ch1')
  ok('⑥① 创建状态', state.currentChapterId === 'ch1' && state.activeTab === 'outline')

  const tabbed = switchTab(state, 'materials')
  ok('⑥② 切换页签', tabbed.activeTab === 'materials')

  const switched = switchChapter(state, 'ch2')
  ok('⑥③ 切章', switched.currentChapterId === 'ch2' && switched.refreshContent)

  const ref = { kind: 'card' as const, projectId: 'p1', tabId: 'char-main', id: 'c1' }
  const binding = normalizeChapterContextBinding({
    schema: 1, outlineId: 'o1', pinnedRefs: [ref, ref, { ...ref, projectId: 'p2' }], updatedAt: 123,
  }, 'p1')
  ok('⑥④ 绑定记录仅保留同项目稳定引用并去重',
    binding.outlineId === 'o1' && binding.pinnedRefs.length === 1 && binding.pinnedRefs[0].id === 'c1')
  ok('⑥⑤ 细纲用途识别依赖字段元数据且不限场景槽数量',
    outlinePurposeForField({ id: '二、场景细纲::场景7', sourceKey: '二、场景细纲::场景7', label: '第七段', defaultLabel: '场景7' }) === '场景')
  ok('⑥⑥ 自定义/未知字段仍可展示且不误标用途',
    outlinePurposeForField({ id: 'cf_custom', sourceKey: 'cf_custom', label: '作者自定义字段' }) === undefined)
  const suggestions = findOutlineReferenceSuggestions([{
    id: '出场人物', sourceKey: '一、本章定位::出场人物', label: '出场人物', value: '陈渊与F0001有关',
  }], [
    { ref: { kind: 'card', projectId: 'p1', tabId: 'char-main', id: 'c1' }, name: '陈渊', source: '主要角色', matchTerms: ['陈渊'] },
    { ref: { kind: 'card', projectId: 'p1', tabId: 'char-secondary', id: 'c2' }, name: '陈渊', source: '次要角色', matchTerms: ['陈渊'] },
    { ref: { kind: 'row', projectId: 'p1', tabId: 'foreshadow', id: 'f1' }, name: '胎记', source: '伏笔追踪', matchTerms: ['胎记', 'F0001'] },
  ])
  const duplicate = suggestions.find(item => item.term === '陈渊')
  const code = suggestions.find(item => item.term === 'F0001')
  ok('⑥⑦ 细纲按登记名称/编号提出精确匹配建议', suggestions.length === 2 && code?.candidates[0]?.name === '胎记')
  ok('⑥⑧ 同名记录保留多候选供作者选择', duplicate?.candidates.length === 2)
}

function case6a() {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8')
  const panel = read('src/components/editor/ChapterContextPanel.tsx')
  const editor = read('src/components/editor/NovelEditor.tsx')
  const app = read('src/App.tsx')
  const outline = read('src/components/outline/OutlineSheet.tsx')
  const dataHook = read('src/components/editor/useChapterContextData.ts')
  ok('⑥⑦ A1 有细纲/关联资料/正文引用三项切换',
    panel.includes("['outline', '细纲']") && panel.includes("['materials', '关联资料']") && panel.includes("['quotes', '正文引用']"))
  ok('⑥⑧ 细纲与固定资料按项目设置持久化',
    dataHook.includes('chapterContext32:') && dataHook.includes('getSettingFor') && dataHook.includes('setSettingFor'))
  ok('⑥⑨ 正文编辑器接入资料抽屉，引用使用稳定记录 ID',
    editor.includes('<ChapterContextPanel') && editor.includes('detail: { tabId: ref.tabId, rowId: ref.id }'))
  ok('⑥⑩ 记录跳转支持章节细纲卡并经过草稿安全切换',
    app.includes('focusRowId={focusRowId}') && outline.includes('switchTo(focusRowId)'))
  ok('⑥⑪ 抽屉视图与资料加载/保存逻辑分离',
    panel.includes('useChapterContextData') && dataHook.includes('normalizeChapterContextBinding'))
  ok('⑥⑫ 抽屉打开时检索列收起并恢复正文宽度',
    editor.includes('!focusMode && showSearch && !showRefs') && editor.includes('!showSearch || showRefs'))
  ok('⑥⑬ 抽屉固定于视口并按缩放折算尺寸',
    panel.includes('className="fixed right-3') && panel.includes("foldZoomLength('3.5rem')") && panel.includes("foldZoomLength('18rem')"))
  ok('⑥⑭ 细纲命中只作为手动固定建议，不改变 AI 输入',
    dataHook.includes('findOutlineReferenceSuggestions') && panel.includes('不会自动加入 AI 请求') && panel.includes('onClick={() => pin(candidate.ref)}'))
}

// ───────────────── ⑦ 变化事件创建 ─────────────────
function case7() {
  const evt = createChangeEvent('body-change', 'ch1', '旧摘要', '新摘要', '正文修改')
  ok('⑦① 创建事件', evt.type === 'body-change' && evt.reason === '正文修改')
  ok('⑦② 事件 ID', evt.id.startsWith('evt-'))
}

// ───────────────── ⑧ 事件合并 ─────────────────
function case8() {
  const events: ChangeEvent[] = [
    createChangeEvent('body-change', 'ch1', 'a', 'b', 'r1'),
    createChangeEvent('body-change', 'ch1', 'a', 'b', 'r2'), // 同 sourceRef + type
    createChangeEvent('outline-change', 'ch1', 'c', 'd', 'r3'), // 不同类型
  ]

  const merged = mergeEvents(events)
  ok('⑧① 合并后数量', merged.length === 2)

  const deduped = deduplicateEvents(events)
  ok('⑧② 去重', deduped.length === 2)
}

// ───────────────── ⑨ 直接依据 ─────────────────
function case9() {
  const evt = createChangeEvent('body-change', 'ch1', '角色1 角色2', '新', 'r')

  const r1 = computeDirectImpact(evt, ['角色1', '角色2'], [], [])
  ok('⑨① 命中', r1.hit && r1.explicitLinks.length === 2)

  const r2 = computeDirectImpact(evt, [], [{ old: '旧名', new: '新名' }], [])
  ok('⑨② 名称变化', r2.nameChanges.length === 1)

  const r3 = computeDirectImpact(evt, [], [], ['伏笔1'])
  ok('⑨③ 伏笔', r3.foreshadowIds.length === 1)

  const r4 = computeDirectImpact(evt, [], [], [])
  ok('⑨④ 无关联', !r4.hit && r4.issues.length > 0)
}

// ───────────────── ⑩ 相关性复核 ─────────────────
function case10() {
  const evt = createChangeEvent('body-change', 'ch1', '角色1 角色2', '角色1 新内容', 'r')

  const r1 = reviewRelevance(evt, '目标细纲', ['角色1', '其他'])
  ok('⑩① 可能冲突', r1.mayConflict && !r1.mayBeIrrelevant)

  const r2 = reviewRelevance(evt, '目标细纲', ['完全无关'])
  ok('⑩② 可能无关', r2.mayBeIrrelevant && !r2.mayConflict)
}

// ───────────────── ⑪ 事件去重与上限 ─────────────────
function case11() {
  const events: ChangeEvent[] = [
    createChangeEvent('body-change', 'ch1', 'a', 'b', 'r1'),
    createChangeEvent('body-change', 'ch1', 'a', 'b', 'r2'),
    createChangeEvent('body-change', 'ch1', 'a', 'b', 'r3'),
  ]

  const deduped = deduplicateEvents(events)
  ok('⑪① 去重', deduped.length === 1)

  // 上限检查
  const limit1 = checkEventLimit(50, 100)
  ok('⑪② 未触顶', !limit1.atLimit)

  const limit2 = checkEventLimit(100, 100)
  ok('⑪③ 触顶', limit2.atLimit && limit2.message.includes('上限'))

  const limit3 = checkEventLimit(50, 500)
  ok('⑪④ 提醒触顶', limit3.atLimit && limit3.message.includes('目标提醒'))
}

// ───────────────── ⑫ 处置状态 ─────────────────
function case12() {
  const evt = createChangeEvent('body-change', 'ch1', 'a', 'b', 'r')
  const evidence: ImpactEvidence = {
    id: 'ev1',
    sourceEventId: evt.id,
    targetOutlineId: 'outline1',
    matchedFieldId: 'field1',
    labelSnapshot: '标签',
    quote: '引文',
    targetSummary: '目标',
    relevance: 'direct',
    disposition: 'pending',
  }

  const updated = updateDisposition(evidence, 'checked')
  ok('⑫① 更新处置', updated.disposition === 'checked')

  ok('⑫② 新处置', isNewDisposition(undefined, 'pending'))
  ok('⑫③ 同处置', !isNewDisposition('pending', 'pending'))
}

// ───────────────── ⑬ 事件类型覆盖 ─────────────────
function case13() {
  const types: ChangeEventType[] = [
    'body-change', 'outline-change', 'setting-change', 'field-rename',
    'field-meaning', 'permission-change', 'record-delete', 'chapter-reorder',
  ]

  for (const type of types) {
    const evt = createChangeEvent(type, 'src', 'before', 'after', 'reason')
    ok(`⑬${types.indexOf(type) + 1} 类型 ${type}`, evt.type === type)
  }
}

// ───────────────── ⑭ 引文长度限制 ─────────────────
async function case14() {
  const longQuote = 'a'.repeat(400)
  const body = 'a'.repeat(400) + 'b'
  const r = locateBodyQuote(longQuote, body)
  ok('⑭① 长引文定位', r.located)

  // 验证 MAX_QUOTE_LENGTH 常量（直接引用）
  const { MAX_QUOTE_LENGTH } = await import('../src/lib/revision/changeEvents')
  ok('⑭② 引文长度限制', MAX_QUOTE_LENGTH === 300)
}

// ───────────────── ⑮ 事件合并（按记录） ─────────────────
function case15() {
  const events: ChangeEvent[] = [
    createChangeEvent('body-change', 'ch1', 'a', 'b', 'r1'),
    createChangeEvent('body-change', 'ch1', 'a', 'b', 'r2'),
    createChangeEvent('body-change', 'ch2', 'a', 'b', 'r3'),
    createChangeEvent('outline-change', 'ch1', 'a', 'b', 'r4'),
  ]

  const merged = mergeEvents(events)
  ok('⑮① 按记录合并', merged.length === 3) // ch1 body-change 合并为 1 条
}

// ───────────────── 主函数 ─────────────────
async function main() {
  case1()
  case2()
  case3()
  case4()
  case5()
  case6()
  case6a()
  case7()
  case8()
  case9()
  case10()
  case11()
  case12()
  case13()
  await case14()
  case15()
  console.log(`\na1a3: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
