// ============ 酒馆四个弹窗的编排判定（3.6.1 · B7）============
//
// 四个文件里「解析 / 过滤 / 导出排版」本体都在 lib（有测试），组件层留下的是会误导作者的映射：
//   ① 剧本导入主按钮的五种原因（顺序错了会给错理由：明明有重名冲突却说"先选故事"）；
//   ② 角色卡数值备注空串必须删键、数字项未填要显示初始值；
//   ③ 「从小说角色导入」的分组标签未知值不能显示成空白；
//   ④ 导出条数在关掉「含已隐藏」时必须减去隐藏条数。
import {
  decideScriptImportGate, scriptImportResultText, type ScriptImportGateInput,
} from '../src/lib/tavern/scriptImportGate'
import { applyVarNote, cardStoryHint, varInputDefaultValue } from '../src/lib/tavern/cardBasicsLogic'
import { novelImportFooterText, novelTabLabel } from '../src/lib/tavern/novelImportLogic'
import { exportedCountOf } from '../src/lib/tavern/exportOptions'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const gate = (over: Partial<ScriptImportGateInput> = {}) => decideScriptImportGate({
  mode: 'create', parsedOk: true, busy: false, targetStoryId: 's1',
  conflictCount: 0, nothingToAppend: false, targetLabel: '样本故事', ...over,
})

function main() {
  // ① 剧本导入
  {
    ok('解析没过时提示先粘文本', gate({ parsedOk: false }).title === '先粘贴符合模板的文本')
    ok('新建模式可点', gate().canGo === true && gate().title.includes('建成一个新故事'))
    ok('忙的时候也能算出标题（只是不可点）', gate({ busy: true }).canGo === false && gate({ busy: true }).title.includes('建成一个新故事'))
    ok('追加没选目标时提示先选', gate({ mode: 'append', targetStoryId: '' }).title === '先选一个目标故事')
    const conflict = gate({ mode: 'append', conflictCount: 2 })
    ok('有重名冲突时提示先改名（优先于"没有内容"）', conflict.canGo === false && conflict.title.includes('改名'), conflict.title)
    ok('冲突与空内容同时存在时先说冲突', gate({ mode: 'append', conflictCount: 1, nothingToAppend: true }).title.includes('改名'))
    const empty = gate({ mode: 'append', nothingToAppend: true })
    ok('只有世界设定时提示没有可追加内容', empty.canGo === false && empty.title.includes('没有可追加的内容'), empty.title)
    const ready = gate({ mode: 'append' })
    ok('条件齐备时可追加并点名目标故事', ready.canGo === true && ready.title.includes('「样本故事」'), ready.title)
    ok('新建回执含词条与剧本条数', scriptImportResultText({ mode: 'create', storyLabel: '样本', entryCount: 3, scriptCount: 2, ignoredSettingChars: 0 })
      === '已导入「样本」：词条 3 条 · 剧本 2 份')
    ok('追加回执带"世界设定已忽略"', scriptImportResultText({ mode: 'append', storyLabel: '样本', entryCount: 1, scriptCount: 0, ignoredSettingChars: 42 })
      .includes('世界设定已忽略'))
    ok('没有设定可忽略时不带那句', !scriptImportResultText({ mode: 'append', storyLabel: '样本', entryCount: 1, scriptCount: 0, ignoredSettingChars: 0 })
      .includes('世界设定已忽略'))
  }

  // ② 角色卡基本区块
  {
    const notes = applyVarNote({}, 'favor', '  从陌生到熟悉  ')
    ok('备注写入时 trim', notes.favor === '从陌生到熟悉', JSON.stringify(notes))
    ok('空串删键（不留空备注）', JSON.stringify(applyVarNote({ favor: '旧备注' }, 'favor', '   ')) === '{}')
    ok('删键不影响其它项', applyVarNote({ favor: 'x', trust: 'y' }, 'favor', '').trust === 'y')
    ok('不改原对象（返回新对象）', (() => { const src = { favor: 'x' }; applyVarNote(src, 'favor', ''); return src.favor === 'x' })())
    ok('数字项未填时显示初始值', varInputDefaultValue({ kind: 'num', init: 50 }, undefined) === '50')
    ok('数字项填 0 时显示 0（不被当成未填）', varInputDefaultValue({ kind: 'num', init: 50 }, 0) === '0')
    ok('文本项未填时留空（不显示 0）', varInputDefaultValue({ kind: 'text', init: '' }, undefined) === '')
    ok('文本项有值原样显示', varInputDefaultValue({ kind: 'text', init: '' }, '书房') === '书房')
    ok('有归属故事时为 bound', cardStoryHint('s1') === 'bound')
    ok('无归属故事时为 free（界面要说明代价）', cardStoryHint('') === 'free')
  }

  // ③ 从小说角色导入
  {
    ok('认得的分组给中文名', novelTabLabel('char-main') === '主要' && novelTabLabel('char-npc') === 'NPC')
    ok('未知分组原样显示（不显示空白）', novelTabLabel('char-unknown') === 'char-unknown')
    ok('没有过滤时不废话"命中 N 个"', novelImportFooterText({ converting: false, total: 5, matched: 5 }) === '共 5 个角色')
    ok('过滤生效时补一句命中数', novelImportFooterText({ converting: false, total: 5, matched: 2 }) === '共 5 个角色 · 命中 2 个')
    ok('转换中优先说进度', novelImportFooterText({ converting: true, total: 5, matched: 0 }).includes('正在转换'))
  }

  // ④ 导出条数
  {
    ok('含已隐藏时条数不变', exportedCountOf({ messageCount: 42, hiddenCount: 12, includeHidden: true }) === 42)
    ok('关掉含已隐藏时减去隐藏条数', exportedCountOf({ messageCount: 42, hiddenCount: 12, includeHidden: false }) === 30)
    ok('隐藏数大于总数时不出现负数', exportedCountOf({ messageCount: 3, hiddenCount: 9, includeHidden: false }) === 0)
    ok('报告类文档（没有消息条数）返回 undefined', exportedCountOf({ messageCount: undefined, hiddenCount: 0, includeHidden: true }) === undefined)
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} tavernDialogs ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main()
