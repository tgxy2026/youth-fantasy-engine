// ============ 3.2.3 · R4：保存失败与多标签提示的文案闸 ============
//
// 两处文案对应两个已实测的缺口：
//   ① 游客保存失败：数据只在浏览器里，且整库导出取数走 IndexedDB ⇒ **导出不含未落盘草稿**。
//      只报"保存失败"不够，作者会以为还能导出救一下，或者随手关页面。
//      口径：桌面/便携必须**逐字不变**（不能为了改游客而改另两端）。
//   ② 多标签并发：实测确认后保存的整库会覆盖先保存的、服务端无版本判据；
//      旧文案只说"会互相覆盖"，没说整库、也没给动作。现在必须写清"整库 / 会丢 / 只留一个窗口"。
import fs from 'node:fs'
import path from 'node:path'
import { buildSaveFailureMessage, GUEST_SAVE_FAILURE_HINT } from '../src/lib/app/saveFailureHint'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ---------- ① 桌面/便携：文案逐字不变 ----------
{
  ok('🔴 ① 非游客时与改动前逐字一致（只拼前缀与详情）',
    buildSaveFailureMessage('保存失败：', '磁盘写满', false) === '保存失败：磁盘写满')
  ok('① 非游客时不追加任何提示',
    !buildSaveFailureMessage('自动保存失败：', 'boom', false).includes('游客模式'))
}

// ---------- ② 游客：必须说清"导出拿不到草稿 / 别关页面 / 怎么重试" ----------
{
  const msg = buildSaveFailureMessage('保存失败：', 'quota', true)
  ok('② 前缀与详情仍在', msg.startsWith('保存失败：quota'), msg)
  ok('🔴 ② 点明数据只在浏览器里', msg.includes('只在这个浏览器里'), msg)
  ok('🔴 ② 点明导出不含未保存的草稿（这是实测事实）', msg.includes('不含未保存的草稿'), msg)
  ok('🔴 ② 明确"不要关闭或刷新页面"', msg.includes('不要关闭或刷新页面'), msg)
  ok('② 给出重试动作（Ctrl+S）', msg.includes('Ctrl+S'), msg)
  ok('② 提示文案本身不含 markdown 星号', !GUEST_SAVE_FAILURE_HINT.includes('**'))
}

// ---------- ③ 编辑器两条保存失败路径都要走这个 helper ----------
{
  const src = read('src/components/editor/useNovelEditorModel.ts')
  ok('🔴 ③ 手动保存失败走 saveFailureMessage', /showToast\(saveFailureMessage\('保存失败：', e\)/.test(src))
  ok('🔴 ③ 自动保存失败也走 saveFailureMessage', /showToast\(saveFailureMessage\('自动保存失败：', e\)/.test(src))
  ok('③ 不再残留裸拼字符串（旧写法）', !/showToast\('保存失败：' \+ \(e instanceof Error/.test(src))
}

// ---------- ④ 多标签提示：写清整库 / 会丢 / 只留一个窗口 ----------
{
  const guard = read('src/lib/app/tabGuard.ts')
  ok('🔴 ④ 提示里出现"整库保存"', /整库保存/.test(guard))
  ok('🔴 ④ 条件写拒绝旧版本与游客本机风险准确分开', /WEB_GUEST/.test(guard) && /旧版本会被拒绝/.test(guard) && /本机浏览器资料/.test(guard))
  ok('🔴 ④ 提示里给出动作建议（只留一个窗口）', /只留一个窗口/.test(guard))
  ok('④ 共用可关闭的「知道了」告知控件', /showNativeNotice/.test(guard) && /知道了/.test(read('src/lib/app/nativeNotices.ts')))
  ok('🔴 ④ 不谎称已有保护（不得出现"已锁定/已阻止"之类）', !/已锁定|已阻止|无法再保存/.test(guard))
}

console.log(`\n———— saveFailureHint：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
