// 3.3.2 · B3-1 另存为新书 · 单测
//
// 盯六件事：
//   ① 十类记录都能还原成 ProjectBundle 的形状，**不在这里改前缀/换 id**（那是 importProject 的活）；
//   ② 元数据继承：本机有原项目就借它的简介 / 封面 / 自定义功能；
//   ③ 没有原项目时只用清单里的名称 / 题材 / 形态，并**如实说明**缺了什么；
//   ④ 内容没下齐 / 未知 kind / 空清单 —— 一律拒绝，不许交出半本书；
//   ⑤ 自定义下拉选项不在当前协议里，必须写进 omitted，不能假装完整；
//   ⑥ 纯函数：入参一个字段都不改。
import type { SnapshotManifest } from '@/lib/sync/projectSnapshot'
import type { Project } from '@/lib/types'
import { planAsCopy } from '@/lib/sync/projectAsCopy'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const H = (c: string) => c.repeat(32) + c.repeat(32)
const kinds = [
  'chapters', 'volumes', 'tableRows', 'cardRecords', 'formData',
  'settings', 'dailyStats', 'aiRuns', 'tavernReports', 'snapshots',
] as const

/** 每类一条最小记录；formData 用 tabId、settings 用 key 作主键 */
function rowsOf(kind: string): Record<string, unknown>[] {
  switch (kind) {
    case 'formData': return [{ tabId: 'races', data: { a: '1' } }]
    case 'settings': return [{ key: 'goalDaily', value: 3000 }]
    case 'dailyStats': return [{ key: 'p::2026-10-30', date: '2026-10-30', projectId: 'p', net: 120 }]
    case 'tableRows': return [{ id: 'r1', tabId: 'races', projectId: 'p' }]
    default: return [{ id: 'x1', projectId: 'p', title: 't' }]
  }
}

function manifest(over: Partial<SnapshotManifest> = {}): SnapshotManifest & { revision: number; snapshotId: string } {
  return {
    protocol: 1,
    createdAt: 1,
    project: { name: '吞天神脉', genre: '东方修真', projectType: 'full' },
    counts: {},
    objects: kinds.map((kind, i) => ({ kind, hash: H(String(i)), bytes: 1, records: 1 })),
    assets: [],
    tombstones: [],
    revision: 7,
    snapshotId: 'snap-7',
    ...over,
  }
}

function loadedOf(m: SnapshotManifest): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {}
  for (const o of m.objects) out[o.hash] = rowsOf(o.kind)
  return out
}

const baseProject: Project = {
  id: 'p-local', name: '吞天神脉', genre: '东方修真', intro: '一句话简介',
  cover: 'data:image/webp;base64,AAA', createdAt: 1, updatedAt: 2,
  projectType: 'custom', features: ['chapters', 'characters'],
}

function main() {
  const m = manifest()

  // ① 正常：十类齐全，形状对得上
  {
    const r = planAsCopy({ manifest: m, loaded: loadedOf(m), baseProject, now: 99 })
    ok('十类齐全时成功', r.ok && r.code === 'OK' && !!r.bundle, r.reason)
    ok('记录条数统计正确', r.stats.put === 10 && r.stats.kinds.length === 10, JSON.stringify(r.stats))
    ok('章节原样带出（id 不在本模块改）', (r.bundle!.chapters as unknown as { id: string }[])[0].id === 'x1')
    ok('formData 的 tabId 不在这里加前缀', (r.bundle!.formData as unknown as { tabId: string }[])[0].tabId === 'races')
    ok('settings 的 key 不在这里加前缀', (r.bundle!.settings as unknown as { key: string }[])[0].key === 'goalDaily')
    ok('透传快照身份', r.snapshotId === 'snap-7' && r.revision === 7)
  }

  // ② 元数据继承
  {
    const r = planAsCopy({ manifest: m, loaded: loadedOf(m), baseProject, now: 99 })
    const p = r.bundle!.project
    ok('继承简介与封面', p.intro === '一句话简介' && p.cover!.startsWith('data:image/webp'))
    ok('继承自定义功能', p.projectType === 'custom' && p.features?.length === 2, JSON.stringify(p.features))
    ok('默认名加「云端副本」', p.name === '吞天神脉（云端副本）', p.name)
    ok('时间戳换成本次（导入会再覆盖，但包里不应是旧时间）', p.createdAt === 99 && p.updatedAt === 99)
  }

  // ③ 指定名称优先
  {
    const r = planAsCopy({ manifest: m, loaded: loadedOf(m), baseProject, name: '  另一条线  ' })
    ok('用户指定的名字优先并去空白', r.bundle!.project.name === '另一条线', r.bundle!.project.name)
  }

  // ④ 没有原项目：只能用清单里的元数据
  {
    const r = planAsCopy({ manifest: m, loaded: loadedOf(m), baseProject: null })
    const p = r.bundle!.project
    ok('无原项目时用清单名称/题材', p.name === '吞天神脉（云端副本）' && p.genre === '东方修真', `${p.name}/${p.genre}`)
    ok('无原项目时形态来自清单', p.projectType === 'full')
    ok('无原项目时简介为空而不是乱填', p.intro === '')
    ok('无原项目要如实说明元数据不全', r.omitted.some((s) => s.includes('作品简介')), r.omitted.join('|'))
  }

  // ⑤ 始终说明协议缺口
  {
    const r = planAsCopy({ manifest: m, loaded: loadedOf(m), baseProject })
    ok('自定义下拉选项被如实列为未带', r.omitted.some((s) => s.includes('自定义下拉选项')), r.omitted.join('|'))
  }

  // ⑥ 拒绝条件
  {
    const bad = { protocol: 1 } as never
    const r = planAsCopy({ manifest: bad, loaded: {}, baseProject })
    ok('清单缺 objects 判协议错误', !r.ok && r.code === 'PROTOCOL' && r.bundle === null, r.reason)
  }
  {
    const mm = manifest({ objects: [{ kind: 'chapters', hash: H('a'), bytes: 1, records: 1 }] })
    const r = planAsCopy({ manifest: mm, loaded: {}, baseProject })
    ok('内容没下齐时拒绝', !r.ok && r.code === 'MISSING_OBJECT' && r.reason.includes('没下载完'), r.reason)
  }
  {
    const mm = manifest({ objects: [{ kind: 'mindMaps', hash: H('b'), bytes: 1, records: 1 }] })
    const r = planAsCopy({ manifest: mm, loaded: { [H('b')]: [] }, baseProject })
    ok('未知 kind 拒绝整次另存', !r.ok && r.code === 'UNKNOWN_KIND' && r.reason.includes('mindMaps'), r.reason)
  }
  {
    const mm = manifest({ objects: [{ kind: 'chapters', hash: H('c'), bytes: 2, records: 0 }] })
    const r = planAsCopy({ manifest: mm, loaded: { [H('c')]: [] }, baseProject })
    ok('毫无内容时不建空书', !r.ok && r.code === 'NO_CONTENT', r.reason)
  }

  // ⑦ 纯函数：入参不变
  {
    const snapshot = JSON.stringify(m)
    const loaded = loadedOf(m)
    const loadedSnapshot = JSON.stringify(loaded)
    const baseSnapshot = JSON.stringify(baseProject)
    planAsCopy({ manifest: m, loaded, baseProject })
    ok('不修改清单', JSON.stringify(m) === snapshot)
    ok('不修改下载内容', JSON.stringify(loaded) === loadedSnapshot)
    ok('不修改原项目', JSON.stringify(baseProject) === baseSnapshot)
  }

  // ⑧ 同 kind 多片时合并而不是取最后一片
  {
    const mm = manifest({
      objects: [
        { kind: 'chapters', hash: H('d'), bytes: 1, records: 1 },
        { kind: 'chapters', hash: H('e'), bytes: 1, records: 1 },
      ],
    })
    const r = planAsCopy({
      manifest: mm,
      loaded: { [H('d')]: [{ id: 'c1' }], [H('e')]: [{ id: 'c2' }] },
      baseProject,
    })
    ok('同类多片合并', r.ok && (r.bundle!.chapters as unknown as unknown[]).length === 2, String(r.bundle?.chapters.length))
  }

  console.log(`\n▶ projectAsCopy: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()