// ============ 同步冲突面板的判定 / 文案（3.6.1 · B2 从组件抽出）============
//
// 冲突副本是**云端那一版的唯一留档**。面板里判错的后果不是界面难看，而是：
//   · 该恢复的时候按钮不出现（作者以为没救，删了副本）；
//   · 不该恢复的时候按钮出现（点下去必然报错，作者以为同步坏了）；
//   · 删除时不确认（唯一留档没了）。
// 这里逐条钉住判定顺序与文案，组件只负责渲染。
import {
  conflictDeletePrompt, conflictLabel, conflictPreview, conflictRestorePrompt,
  decideConflictRestore, pickConflictSelection,
} from '../src/lib/sync/conflictActions'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const chapterConflict = {
  store: 'chapters', key: 'ch-1',
  local: { id: 'ch-1', projectId: 'p-1', title: '本机版' },
  server: { id: 'ch-1', projectId: 'p-1', title: '云端版' },
}

function main() {
  // ① 可以恢复：章节 + 双方都在 + 属当前项目
  ok('条件齐备时允许原位恢复', decideConflictRestore(chapterConflict, 'p-1').allowed === true)
  ok('允许时不带原因（界面不显示提示）', !('reason' in decideConflictRestore(chapterConflict, 'p-1')))

  // ② 四种"不能恢复"，每种都要说清为什么（顺序与原实现一致）
  const wrongStore = decideConflictRestore({ ...chapterConflict, store: 'tableRows' }, 'p-1')
  ok('非章节类型不支持原位恢复', !wrongStore.allowed && wrongStore.reason.includes('暂不支持安全的原位恢复'), JSON.stringify(wrongStore))
  const noServer = decideConflictRestore({ ...chapterConflict, server: null }, 'p-1')
  ok('云端已删时给出"云端已删除"并建议导出', !noServer.allowed && noServer.reason.includes('云端已删除'), JSON.stringify(noServer))
  const noLocal = decideConflictRestore({ ...chapterConflict, local: null }, 'p-1')
  ok('本机已删时给出"本机已删除"并建议导出', !noLocal.allowed && noLocal.reason.includes('本机已删除'), JSON.stringify(noLocal))
  const otherProject = decideConflictRestore(chapterConflict, 'p-2')
  ok('属其它项目时提示先打开对应项目', !otherProject.allowed && otherProject.reason.includes('其它项目'), JSON.stringify(otherProject))
  ok('当前没有打开项目时同样不给恢复', decideConflictRestore(chapterConflict, null).allowed === false)

  // ③ 坏数据不崩（服务端存了非对象 / 缺 projectId）
  let crashed = ''
  let badResult = ''
  try {
    badResult = JSON.stringify(decideConflictRestore({ store: 'chapters', key: 'k', local: { id: 'x' }, server: 'not-an-object' }, 'p-1'))
  } catch (e) { crashed = e instanceof Error ? e.message : String(e) }
  ok('服务端内容为非对象时不崩', crashed === '', crashed)
  ok('服务端缺 projectId 时按"其它项目"处理（不误报可恢复）', badResult.includes('其它项目'), badResult)

  // ④ 标题与预览
  ok('标题优先取云端那版的 title', conflictLabel(chapterConflict) === '章节 · 云端版', conflictLabel(chapterConflict))
  // 🔴 名字只从**一侧**取（云端在就用云端，否则本机），不跨侧拼接：
  //    云端版存在但没名字时退回主键，而不是拿本机的标题冒充云端内容。
  ok('云端那版在但没名字时退回主键（不拿本机标题冒充）',
    conflictLabel({ store: 'chapters', key: 'k', local: { title: '本机名' }, server: { id: 'x' } }) === '章节 · k',
    conflictLabel({ store: 'chapters', key: 'k', local: { title: '本机名' }, server: { id: 'x' } }))
  ok('云端为空时用本机那版的名字', conflictLabel({ store: 'chapters', key: 'k', local: { title: '本机名' }, server: null }) === '章节 · 本机名')
  ok('两侧都没有名字时退回主键', conflictLabel({ store: 'chapters', key: 'ch-key' }) === '章节 · ch-key')
  ok('主键为空时只剩类型标签（不出现 undefined）', conflictLabel({ store: 'chapters', key: '' }) === '章节 · ', conflictLabel({ store: 'chapters', key: '' }))
  ok('一侧为空时说人话', conflictPreview(null) === '此侧已删除或没有该记录')
  ok('正常内容按 JSON 预览', conflictPreview({ a: 1 }).includes('"a": 1'))
  const long = conflictPreview({ text: 'x'.repeat(30000) })
  ok('超长内容被截断并告知导出文件完整', long.length < 20500 && long.includes('预览已截断'), String(long.length))

  // ⑤ 选中回退
  const list = [{ metaKey: 'a' }, { metaKey: 'b' }]
  ok('选中项仍在筛选结果里时保持', pickConflictSelection(list, 'b') === 'b')
  ok('选中项被筛掉时落到第一条', pickConflictSelection(list, 'zzz') === 'a')
  ok('筛选结果为空时清空选中', pickConflictSelection([], 'b') === null)
  ok('原本没选中时选第一条', pickConflictSelection(list, null) === 'a')

  // ⑥ 二次确认文案（删除不可逆必须说清）
  const del = conflictDeletePrompt(chapterConflict)
  ok('删除副本的确认框标题正确', del.title === '删除冲突副本')
  ok('删除提示写明"永久删除"', del.message.includes('永久删除'), del.message)
  ok('删除提示建议先导出', del.message.includes('建议先导出'), del.message)
  ok('删除按钮标为危险操作', del.confirmText === '删除副本' && del.danger === true)
  const restore = conflictRestorePrompt(chapterConflict)
  ok('恢复确认里说明会自动建备份', restore.message.includes('自动建立一份完整项目备份'), restore.message)
  ok('恢复确认里说明备份失败不覆盖', restore.message.includes('备份失败时不会覆盖'), restore.message)
  ok('恢复确认带上冲突记录名', restore.message.includes('章节 · 云端版'), restore.message)

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} conflictActions ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main()
