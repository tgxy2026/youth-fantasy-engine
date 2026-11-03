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

// ---------- 3.2.2 · 审计 D2：数组形态必须按真实主键重建索引 ----------
//
// 🔴 现场：便携端写盘保留的是**记录数组**，桌面端归一化时 `{...rows}` 展开数组
//    ⇒ 键变成 "0"/"1"，项目列表（Object.values）看得见、按真实 id 查却查不到，
//    项目永久打不开（审计实测：项目 store 键为 ['0']，按 id 查询失败）。
{
  // ① 数组 → 主键（id 型 store）
  const n1 = normalizePortableData({
    kind: 'portable-data',
    stores: { projects: [{ id: 'p1', name: '甲' }, { id: 'p2', name: '乙' }] },
  })
  ok('D2 ① 数组按 id 重建键', Object.keys(n1.stores.projects).join(',') === 'p1,p2', JSON.stringify(Object.keys(n1.stores.projects)))
  ok('D2 ① 按真实 id 能取到记录', (n1.stores.projects.p2 as { name: string }).name === '乙')
  ok('D2 ① 不再出现数字索引键', !('0' in n1.stores.projects))

  // ② 主键不是 id 的 store（formData.tabId / meta.key / settingsKV.key）
  const n2 = normalizePortableData({
    kind: 'portable-data',
    stores: {
      formData: [{ tabId: 'p1::positioning', data: {} }],
      meta: [{ key: 'lastProject', value: 'p1' }],
      settingsKV: [{ key: 'p1::x', value: 1 }],
    },
  })
  ok('D2 ② formData 取 tabId', 'p1::positioning' in n2.stores.formData)
  ok('D2 ② meta 取 key', 'lastProject' in n2.stores.meta)
  ok('D2 ② settingsKV 取 key', 'p1::x' in n2.stores.settingsKV)

  // ③ 已损坏的旧文件（键全是数字索引）也要救回来
  const n3 = normalizePortableData({
    kind: 'portable-data',
    stores: { projects: { 0: { id: 'p1', name: '甲' }, 1: { id: 'p2', name: '乙' } } },
  })
  ok('D2 ③ 数字索引键按记录真实 id 修复', Object.keys(n3.stores.projects).join(',') === 'p1,p2', JSON.stringify(Object.keys(n3.stores.projects)))

  // ④ 正常对象形态**不能**被误改（负向控制）
  const n4 = normalizePortableData({
    kind: 'portable-data',
    stores: { projects: { p1: { id: 'p1', name: '甲' } } },
  })
  ok('D2 ④ 正常键原样保留', Object.keys(n4.stores.projects).join(',') === 'p1')

  // ⑤ 缺主键的记录不能丢（丢＝静默删数据）
  const n5 = normalizePortableData({
    kind: 'portable-data',
    stores: { chapters: [{ id: 'c1', title: '有主键' }, { title: '没主键' }] },
  })
  ok('D2 ⑤ 缺主键记录仍可见（getAll 口径）', Object.values(n5.stores.chapters).length === 2,
    JSON.stringify(Object.keys(n5.stores.chapters)))
  ok('D2 ⑤ 有主键的仍按 id 可查', 'c1' in n5.stores.chapters)
}

console.log(`\ndescribeDataFileReject: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
