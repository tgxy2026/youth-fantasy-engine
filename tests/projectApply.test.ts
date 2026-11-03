// 3.3.2 · P2-3 拉取与应用计划 · 单测
//
// 盯五件事：
//   ① 本地有未同步改动时**一条 op 都不给**（这是丢稿的最后一道闸）；
//   ② 内容没下齐不能切换（半套内容 = 一堆加载失败的图）；
//   ③ 未知 kind 拒绝整次应用（宁可这台设备不更新，也不静默丢数据）；
//   ④ 墓碑真的变成 delete 指令，整项目墓碑不在这里处理；
//   ⑤ 主键口径与快照生成一致（formData=tabId / settings=key）。
import type { SnapshotManifest } from '@/lib/sync/projectSnapshot'
import { planApply, primaryKeyOf, KNOWN_KINDS } from '@/lib/sync/projectApply'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const H = (c: string) => c.repeat(64)

function manifest(over: Partial<SnapshotManifest> = {}): SnapshotManifest & { revision: number; snapshotId: string } {
  return {
    protocol: 1, createdAt: 1, project: { name: 'x', genre: 'y' }, counts: {},
    objects: [
      { kind: 'chapters', hash: H('a'), bytes: 10, records: 2 },
      { kind: 'settings', hash: H('b'), bytes: 5, records: 1 },
    ],
    assets: [], tombstones: [],
    revision: 3, snapshotId: 'snap-3',
    ...over,
  }
}

const loaded = {
  [H('a')]: [{ id: 'c1', projectId: 'p', title: '一' }, { id: 'c2', projectId: 'p', title: '二' }],
  [H('b')]: [{ key: 'goalDaily', value: 3000 }],
}

function main() {
  // ① 正常
  {
    const plan = planApply({ manifest: manifest(), loaded, localDirty: false })
    ok('正常生成 put 计划', plan.ok && plan.code === 'OK' && plan.ops.every((o) => o.type === 'put'), JSON.stringify(plan.ops))
    ok('summary 统计正确', plan.summary.put === 3 && plan.summary.kinds.length === 2, JSON.stringify(plan.summary))
    ok('带上快照身份', plan.snapshotId === 'snap-3' && plan.revision === 3)
  }

  // ② 本地脏
  {
    const plan = planApply({ manifest: manifest(), loaded, localDirty: true })
    ok('本地有改动时拒绝并给出人话', !plan.ok && plan.code === 'LOCAL_DIRTY' && plan.reason.includes('未同步') && plan.ops.length === 0, plan.reason)
  }

  // ③ 内容没下齐
  {
    const plan = planApply({ manifest: manifest(), loaded: { [H('a')]: loaded[H('a')] }, localDirty: false })
    ok('缺对象时拒绝整次应用', !plan.ok && plan.code === 'MISSING_OBJECT' && plan.ops.length === 0, plan.reason)
  }

  // ④ 未知 kind
  {
    const plan = planApply({
      manifest: manifest({ objects: [{ kind: 'mindMaps', hash: H('c'), bytes: 1, records: 0 }] }),
      loaded: { [H('c')]: [] }, localDirty: false,
    })
    ok('未知 kind 拒绝整次应用', !plan.ok && plan.code === 'UNKNOWN_KIND' && plan.reason.includes('mindMaps'), plan.reason)
  }

  // ⑤ 墓碑 → delete，整项目墓碑忽略
  {
    const plan = planApply({
      manifest: manifest({ tombstones: [
        { kind: 'chapters', id: 'ch_9', deletedAt: 1 },
        { kind: 'chapters', id: 'ch_8', deletedAt: 2 },
        { kind: 'tableRows', id: 'row_7', deletedAt: 3 },
        { kind: 'project', id: 'p', deletedAt: 4 },
      ] }),
      loaded, localDirty: false,
    })
    const dels = plan.ops.filter((o) => o.type === 'delete') as { type: 'delete'; kind: string; ids: string[] }[]
    ok('墓碑按 kind 聚合成 delete', dels.length === 2
      && dels.find((d) => d.kind === 'chapters')!.ids.length === 2
      && dels.find((d) => d.kind === 'tableRows')!.ids.length === 1, JSON.stringify(dels))
    ok('整项目墓碑不在这里处理', !dels.some((d) => d.kind === 'project'), JSON.stringify(dels))
    ok('删除计数正确', plan.summary.deleted === 3, String(plan.summary.deleted))
  }

  // ⑥ 清单非法
  {
    const plan = planApply({ manifest: { protocol: 1 } as never, loaded, localDirty: false })
    ok('清单缺 objects 时判协议错误', !plan.ok && plan.code === 'PROTOCOL', plan.reason)
  }

  // ⑦ 主键口径
  {
    ok('formData 用 tabId 作主键', primaryKeyOf('formData', { tabId: 'races' }) === 'races')
    ok('settings 用 key 作主键', primaryKeyOf('settings', { key: 'goalDaily' }) === 'goalDaily')
    ok('其余用 id 作主键', primaryKeyOf('chapters', { id: 'c1' }) === 'c1')
  }

  // ⑧ KNOWN_KINDS 必须覆盖快照产出的十类
  ok('KNOWN_KINDS 十类齐全', KNOWN_KINDS.length === 10 && KNOWN_KINDS.includes('tavernReports'), KNOWN_KINDS.join(','))

  console.log(`\n▶ projectApply: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
