// ============ 自由章节 / 托管卷（2.6.4）============
//
// 锁五件事：
//   ① 判定只认 `isFree` 字段、**不认标题** —— 作者可以给托管卷随便改名，改名后仍要认得出；
//   ② 计数只数真卷 —— 否则建卷默认名会从「第3卷」变成「第4卷」、卷数凭空多一个；
//   ③ 自由卷**不可删除** —— `db.deleteVolume` 会级联把卷内章节推进回收站（＝丢正文），
//      这条靠点界面测不出来（要真去点删除按钮），所以改成**源码接线断言**（第 5 组）；
//   ④ 建卷 order 也只数真卷（第 6 组，同上，防止有人改回 `volumes.length`）；
//   ⑤ 默认标题常量存在且非空 —— 首次 lazy 创建时用它当显示名。
import { isFreeVolume, realVolumes, nextVolumeNo, nextVolumeOrder, findFreeVolume, pushFreeVolumeLast, FREE_VOLUME_TITLE, FREE_VOLUME_ORDER } from '../src/lib/freeVolume'
import type { Volume } from '../src/lib/types'
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'p1'
const vol = (id: string, order: number, extra: Partial<Volume> = {}): Volume => ({
  id, projectId: PID, order, title: `卷${id}`, description: '', createdAt: 0, ...extra,
})
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

// ---------- 1. 判定只认 isFree，不认标题 ----------
{
  ok('未设 isFree 的卷不是自由卷', !isFreeVolume(vol('v1', 0)))
  ok('isFree:false 不是自由卷', !isFreeVolume({ ...vol('v1', 0), isFree: false }))
  ok('isFree:true 是自由卷', isFreeVolume({ ...vol('v1', 0), isFree: true }))
  ok('null / undefined 安全返回 false', !isFreeVolume(null) && !isFreeVolume(undefined))
  // 作者把托管卷改名成任何名字，判定都不该失效
  const renamed: Volume = { ...vol('v1', 0), isFree: true, title: '我的散稿' }
  ok('改过名的自由卷仍被认出（不认标题）', isFreeVolume(renamed))
  // 反向：标题恰好同名但没打标记 —— 不能误判成自由卷
  const sameTitle: Volume = { ...vol('v1', 0), title: FREE_VOLUME_TITLE }
  ok('标题同名但无标记 ≠ 自由卷', !isFreeVolume(sameTitle))
  ok('默认标题常量非空', FREE_VOLUME_TITLE.trim().length > 0)
}

// ---------- 2. realVolumes 过滤且保序 ----------
{
  const vols = [vol('v1', 0), { ...vol('vf', 1), isFree: true }, vol('v2', 2)]
  const real = realVolumes(vols)
  ok('过滤掉自由卷', real.length === 2 && real.every(v => !isFreeVolume(v)))
  ok('保留原有顺序', real.map(v => v.id).join(',') === 'v1,v2', real.map(v => v.id).join(','))
  ok('全是真卷时原样返回', realVolumes([vol('v1', 0)]).length === 1)
  ok('空列表不炸', realVolumes([]).length === 0)
}

// ---------- 3. nextVolumeNo 只数真卷 ----------
{
  ok('没有卷 → 第 1 卷', nextVolumeNo([]) === 1)
  ok('一卷 → 第 2 卷', nextVolumeNo([vol('v1', 0)]) === 2)
  // 关键回归：多了托管卷，建卷默认名不能跟着 +1
  const withFree = [vol('v1', 0), vol('v2', 1), { ...vol('vf', 2), isFree: true }]
  ok('托管卷不占号（否则「第3卷」会变「第4卷」）', nextVolumeNo(withFree) === 3, String(nextVolumeNo(withFree)))
}

// ---------- 4. findFreeVolume ----------
{
  ok('没有自由卷时返回 undefined（不预建是正常的）', findFreeVolume([vol('v1', 0)]) === undefined)
  const vols = [vol('v1', 0), { ...vol('vf', 1), isFree: true }]
  ok('找到自由卷', findFreeVolume(vols)?.id === 'vf')
}

// ---------- 5. 接线断言：自由卷不可删除（先拦后删） ----------
{
  const src = read('src/components/useNovelEditorModel.ts')
  const rmAt = src.indexOf('const removeVolume = async')
  const guardAt = src.indexOf('isFreeVolume(vol)', rmAt)
  const delAt = src.indexOf('db.deleteVolume', rmAt)
  ok('removeVolume 里存在自由卷拦截', rmAt > 0 && guardAt > rmAt, `rm=${rmAt} guard=${guardAt}`)
  ok('拦截必须写在 deleteVolume 之前', guardAt > 0 && delAt > guardAt, `guard=${guardAt} del=${delAt}`)
}

// ---------- 6. 接线断言：建卷 order 只数真卷 ----------
{
  const src = read('src/components/useNovelEditorModel.ts')
  const line = src.split('\n').find(l => l.includes('const vol: Volume') && l.includes('order:')) ?? ''
  ok('建卷 order 走 nextVolumeOrder(volumes)', line.includes('nextVolumeOrder(volumes)'), line.trim().slice(0, 120))
}

// ---------- 7. order 哨兵值：自由卷恒排最后 ----------
{
  const withFree = [vol('v1', 0), vol('v2', 1), { ...vol('vf', FREE_VOLUME_ORDER), isFree: true }]
  const sorted = [...withFree].sort((a, b) => a.order - b.order)
  ok('自由卷排全书最后', sorted[sorted.length - 1].id === 'vf', sorted.map(v => v.id).join(','))
  ok('nextVolumeOrder 不被哨兵值污染（仍得 2）', nextVolumeOrder(withFree) === 2, String(nextVolumeOrder(withFree)))
  // 反面：老口径「全部卷最大 order + 1」会取到哨兵值，新卷直接排到 100 万位
  const naive = withFree.reduce((m, v) => Math.max(m, v.order ?? 0), -1) + 1
  ok('老口径（全卷最大+1）确实会踩坑 —— 哨兵必须排除', naive > 1_000_000, String(naive))
}

// ---------- 8. pushFreeVolumeLast：幂等 + 校正 ----------
{
  const noFree = [vol('v1', 0)]
  ok('没有自由卷时原样返回（同一引用，不产生写盘）', pushFreeVolumeLast(noFree) === noFree)
  const good = [vol('v1', 0), { ...vol('vf', FREE_VOLUME_ORDER), isFree: true }]
  ok('已在末位时原样返回（同一引用）', pushFreeVolumeLast(good) === good)
  const bad = [vol('v1', 0), { ...vol('vf', 1), isFree: true }]
  const fixed = pushFreeVolumeLast(bad)
  ok('order 被冲掉时校正回哨兵值', fixed.find(v => v.id === 'vf')?.order === FREE_VOLUME_ORDER)
  ok('真卷 order 不受影响', fixed.find(v => v.id === 'v1')?.order === 0)
}

// ---------- 9. 接线断言：全项目建卷点 / 删卷点 ----------
{
  // 删卷入口有两处：编辑器章节树 + 章节总表侧栏。侧栏那处最容易漏 —— 它删的是「卷台账 tab」，
  // 看起来跟正文编辑器不是一个东西，实际反解出来的就是同一个卷 id。
  const side = read('src/components/Sidebar.tsx')
  const rmAt = side.indexOf('const removeVolume = async')
  const gAt = side.indexOf('isFreeVolume(', rmAt)
  const dAt = side.indexOf('db.deleteVolume', rmAt)
  ok('侧栏删卷也有自由卷拦截', rmAt > 0 && gAt > rmAt, `rm=${rmAt} g=${gAt}`)
  ok('侧栏拦截写在 deleteVolume 之前', gAt > 0 && dAt > gAt, `g=${gAt} d=${dAt}`)
  ok('侧栏建卷 order 走 nextVolumeOrder', side.includes('order: nextVolumeOrder(vols)'))
  ok('侧栏建卷序号走 nextVolumeNo', side.includes('const n = nextVolumeNo(vols)'))

  const persist = read('src/lib/bookbreak/persist.ts')
  ok('拆书建卷走 nextVolumeOrder', persist.includes('let volOrder = nextVolumeOrder(volumes)'))
  ok('拆书建卷不再拿 volumes.length 当基准', !/let volOrder = volumes\.length/.test(persist))

  const wf = read('src/lib/aiWorkflow.ts')
  ok('创意写作建卷走 nextVolumeOrder', wf.includes('let volOrder = nextVolumeOrder(existingVols)'))
  ok('创意写作不再拿 existingVols.length 当基准', !/order: existingVols\.length/.test(wf))

  const chs = read('src/lib/db/chapters.ts')
  const line = chs.split('\n').find(l => l.includes('order: realMax + 1')) ?? ''
  ok('回收站恢复兜底卷只数真卷', line.includes('order: realMax + 1') && chs.includes('v.isFree !== true'), line.trim().slice(0, 120))
}

// ---------- 10. 接线断言：卷拖拽重排排除自由卷 ----------
{
  const src = read('src/components/useNovelEditorModel.ts')
  const at = src.indexOf("dragKind === 'vol'")
  const seg = src.slice(at, at + 700)
  // reorderVolumes 会把传入的卷重编成 0..n-1 —— 自由卷一并传进去，哨兵值就被冲掉了
  ok('卷重排只对真卷调用 reorderVolumes', seg.includes('reorderVolumes(realVolumes(volumes)'), seg.slice(0, 160))
  ok('自由卷在重排后原样拼回清单', /volumes\.filter\(v => isFreeVolume\(v\)\)/.test(seg), seg.slice(0, 160))
}

console.log(`\nfreeVolume: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
