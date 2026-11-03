// ============ 3.3.3 · B4 灵感重复提示与转目标条目 ============
//
// 钉住：
//   ① 重复提示只提示、不拦不改：逐字相同与近似都列出，短文本（"雪"）不凭相似度报重复；
//   ② 同组每行都指向彼此（两边都能看到提示）；
//   ③ 转目标只建**一行**，编号按目标表补最小空号；
//   ④ 目标行备注带 `来源：IDEA00xx`；同一来源重复转同一目标 ⇒ 复用已建行，不再建；
//   ⑤ 目标表缺承接列 / 素材为空 ⇒ 整批拒绝并给原因，不建半行；
//   ⑥ 来源行：状态=已用、备注追加去向；重复追加同一去向不叠加；
//   ⑦ 目标表的重要列留空只提示，不阻断。
import {
  IDEA_TARGETS, findIdeaDuplicates, ideaSimilarity, ideaSourceRef, ideaTargetOf, ideaTargetOrder,
  normalizeIdeaText, planIdeaConversion, planIdeaSourcePatch,
} from '../src/lib/forms/ideasConvert'
import type { TableRow } from '../src/lib/types'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const row = (id: string, data: Record<string, string>, order = 0): TableRow => ({
  id, projectId: 'p', tabId: 'foreshadow', order, data,
})

function main() {
  // ① 归一与相似度
  ok('空白/标点不造成"不同"', normalizeIdeaText(' 他，捡到 一枚铜钱。 ') === '他捡到一枚铜钱')
  ok('逐字相同相似度为 1', ideaSimilarity('会说话的铜钱', '会说话的铜钱') === 1)
  ok('差几个字仍算近似', ideaSimilarity('他在雨里捡到一枚会说话的铜钱', '他在雨夜里捡到一枚会说话的铜钱') >= 0.8)
  ok('不相干的素材不近似', ideaSimilarity('飞船引擎过载', '宗门大比的规则') < 0.8)
  ok('短词不按相似度判重', ideaSimilarity('雪', '雨') === 0)

  // ② 重复提示：两边都列，编号优先
  const dup = findIdeaDuplicates([
    { id: 'a', code: 'IDEA0001', text: '他在雨里捡到一枚会说话的铜钱' },
    { id: 'b', code: 'IDEA0002', text: '他在雨夜里捡到一枚会说话的铜钱。' },
    { id: 'c', code: 'IDEA0003', text: '宗门大比的规则要改' },
    { id: 'd', code: '', text: '' },
  ])
  ok('近似两条都提示', dup.get('a')?.peers[0] === 'IDEA0002' && dup.get('b')?.peers[0] === 'IDEA0001')
  ok('不重复的不提示', !dup.has('c'))
  ok('空素材不参与', !dup.has('d'))
  ok('逐字相同标记 exact', findIdeaDuplicates([
    { id: 'x', code: 'IDEA0001', text: '同一个点子' },
    { id: 'y', code: 'IDEA0002', text: '同一个点子' },
  ]).get('x')?.exact === true)
  ok('无编号时按行号提示', findIdeaDuplicates([
    { id: 'x', code: '', text: '同一个点子' },
    { id: 'y', code: 'IDEA0002', text: '同一个点子' },
  ]).get('y')?.peers[0] === '第 1 行')

  // ③ 目标表定义
  ok('三个目标表都在', IDEA_TARGETS.map(t => t.tabId).join(',') === 'foreshadow,subplots,hookpoints')
  ok('未知目标返回空', ideaTargetOf('ideas') === undefined)

  // ④ 规划一次转换
  const target = ideaTargetOf('foreshadow')!
  const existing = [row('r1', { 编号: 'F0001', 伏笔内容: '旧伏笔', 备注: '' }, 3)]
  const plan = planIdeaConversion({
    source: { id: 'a', code: 'IDEA0003', text: '主角袖口的血纹会随谎言加深' },
    target,
    targetRows: existing,
    columns: ['编号', '伏笔内容', '重要度', '埋设位置', '计划回收位置', '回收前置条件', '状态', '备注'],
  })
  ok('规划成功', plan.ok, plan.reason)
  ok('编号补最小空号（避开 F0001）', plan.fields['编号'] === 'F0002', plan.fields['编号'])
  ok('正文写入承接列', plan.fields['伏笔内容'] === '主角袖口的血纹会随谎言加深')
  ok('默认状态与重要度', plan.fields['状态'] === '未回收' && plan.fields['重要度'] === '小伏笔')
  ok('备注带来源引用', plan.fields['备注'] === ideaSourceRef('IDEA0003') && plan.fields['备注'] === '来源：IDEA0003')
  ok('预览覆盖实际写入的列', plan.preview.length === Object.keys(plan.fields).length)
  ok('重要列留空只提示', plan.emptyImportant.includes('埋设位置') && plan.emptyImportant.includes('回收前置条件'))
  ok('无复用', !plan.reused)

  // ⑤ 重复点击：目标表里已有同一来源 ⇒ 复用
  const again = planIdeaConversion({
    source: { id: 'a', code: 'IDEA0003', text: '主角袖口的血纹会随谎言加深' },
    target,
    targetRows: [...existing, row('r2', { 编号: 'F0002', 伏笔内容: 'x', 备注: '来源：IDEA0003' }, 4)],
    columns: ['编号', '伏笔内容', '状态', '备注'],
  })
  ok('重复点击复用已有条目', again.ok && again.reused?.id === 'r2' && again.reused?.code === 'F0002', JSON.stringify(again.reused))
  ok('复用时不再规划写入', Object.keys(again.fields).length === 0)

  // ⑥ 拒绝路径
  const noCol = planIdeaConversion({
    source: { id: 'a', code: 'IDEA0003', text: 'x' }, target,
    targetRows: [], columns: ['编号', '备注'],
  })
  ok('目标表缺承接列 ⇒ 拒绝', !noCol.ok && noCol.reason.includes('伏笔内容'))
  const empty = planIdeaConversion({
    source: { id: 'a', code: 'IDEA0003', text: '   ' }, target,
    targetRows: [], columns: ['编号', '伏笔内容', '备注'],
  })
  ok('空素材 ⇒ 拒绝', !empty.ok)

  // ⑦ 其它目标表
  const sub = planIdeaConversion({
    source: { id: 'b', code: 'IDEA0007', text: '师父其实是主角的杀父仇人' },
    target: ideaTargetOf('subplots')!, targetRows: [],
    columns: ['编号', '支线名称', '类别', '支线目标', '起点', '与主线汇合点', '状态', '备注'],
  })
  ok('支线：正文进「支线目标」', sub.ok && sub.fields['支线目标'] === '师父其实是主角的杀父仇人')
  ok('支线：编号 LINE0001', sub.fields['编号'] === 'LINE0001')
  ok('支线：重要列留空提示', sub.emptyImportant.includes('支线名称') && sub.emptyImportant.includes('起点'))
  const hook = planIdeaConversion({
    source: { id: 'c', code: 'IDEA0008', text: '当众撕碎婚书' },
    target: ideaTargetOf('hookpoints')!, targetRows: [],
    columns: ['章节号', '爽点类型', '爽点内容', '章末钩子', '状态', '备注'],
  })
  ok('爽点：正文进「爽点内容」', hook.ok && hook.fields['爽点内容'] === '当众撕碎婚书')

  // ⑧ 来源行归属
  const patch = planIdeaSourcePatch({ 状态: '未用', 备注: '已有备注' }, ['状态', '备注'], { label: '伏笔追踪', code: 'F0002' })
  ok('来源状态改已用', patch['状态'] === '已用')
  ok('来源备注追加去向', patch['备注'] === '已有备注\n→ 已转 F0002（伏笔追踪）')
  const same = planIdeaSourcePatch({ 状态: '已用', 备注: patch['备注'] }, ['状态', '备注'], { label: '伏笔追踪', code: 'F0002' })
  ok('重复追加同一去向不叠加', same['备注'] === patch['备注'])
  const noNote = planIdeaSourcePatch({ 状态: '未用' }, ['状态'], { label: '伏笔追踪', code: '' })
  ok('目标表没有备注列就不写', !('备注' in noNote) && noNote['状态'] === '已用')

  // ⑨ 末尾顺序
  ok('新行接在末尾', ideaTargetOrder([row('r1', {}, 3), row('r2', {}, 7)]) === 8)
  ok('空表从 1 起', ideaTargetOrder([]) === 1)

  ok('来源标记对空编号也稳定', ideaSourceRef('') === '来源：（未编号灵感）')

  console.log(`\nideasConvert: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()