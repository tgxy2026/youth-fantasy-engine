// OPT-011（2026-10-19 社区反馈复现）：整库导入拒识的指路文案
//
// 背景：网页版「项目中心」导出的是单本书备份包（有 project、无 kind/stores），
// 用户拿去桌面「数据坞 → 导入数据文件」（只收整库）被拒，旧提示不说去哪导入。
// 复现证明整库主链路本身是通的（verify-opt-011 脚本 8/8），卡住的是入口混淆。
import { describeDataFileReject, isPortableDataFile, normalizePortableData } from '../src/lib/storage/storeOps'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 单本书备份包（项目中心导出的形状）----------
{
  const bundle = {
    app: 'youth-fantasy-engine',
    version: 3,
    exportedAt: 1,
    project: { id: 'p1', name: '云端测试书' },
    volumes: [], chapters: [], tableRows: [], cardRecords: [],
  }
  ok('项目包 ⇒ 不是整库文件', !isPortableDataFile(bundle))
  const guide = describeDataFileReject(bundle)
  ok('项目包 ⇒ 给指路文案', typeof guide === 'string' && guide.length > 10)
  ok('指路文案点名「项目中心 / 导入项目」', !!guide && guide.includes('项目中心') && guide.includes('导入项目'))
  ok('指路文案带书名', !!guide && guide.includes('云端测试书'))
  ok('指路文案说明整体搬迁走数据坞导出', !!guide && guide.includes('导出全部数据'))
}

// ---------- 整库文件 ⇒ 不给指路（走正常导入）----------
{
  const whole = { app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: 1, stores: { projects: {} } }
  ok('整库 ⇒ isPortableDataFile 通过', isPortableDataFile(whole))
  ok('整库 ⇒ 无指路文案（不进拒绝分支）', describeDataFileReject(whole) === null)
}

// ---------- 陌生 JSON ⇒ 通用拒绝（不瞎指路）----------
{
  ok('随机 JSON ⇒ 无指路文案', describeDataFileReject({ hello: 'world' }) === null)
  ok('null/undefined ⇒ 无指路文案', describeDataFileReject(null) === null && describeDataFileReject(undefined) === null)
  // 有 project 但没有 chapters/volumes/tableRows ⇒ 不像备份包，不指路
  ok('只有 project 字段的残片 ⇒ 不指路', describeDataFileReject({ project: { id: 'x' } }) === null)
  // 快照包等其他合法文件同样不误指路
  ok('快照包形状 ⇒ 不误指路', describeDataFileReject({ app: 'youth-fantasy-engine', snapshots: [], version: 3 }) === null)
}

// ---------- 负向控制：指路不能把用户导向"替换整库"的误解 ----------
{
  const bundle = { app: 'youth-fantasy-engine', version: 3, project: { id: 'p1', name: '甲' }, chapters: [] }
  const guide = describeDataFileReject(bundle) ?? ''
  ok('负向控制：文案不说"导入数据文件"（那会误导成整库替换）', !guide.includes('导入数据文件'))
  ok('负向控制：整库 normalize 不受影响（stores 原样）', normalizePortableData({ kind: 'portable-data', stores: { a: { x: 1 } } }).stores.a.x === 1)
}

console.log(`\ndescribeDataFileReject: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
