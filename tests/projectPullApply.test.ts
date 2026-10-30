// 3.3.2 · B3-2 用云端覆盖本机 · 单测 + 静态契约
//
// 盯五件事：
//   ① 本机有未同步改动时，默认**拒绝**覆盖（必须二次确认）；
//   ② 执行顺序：先下载校验 → 再备份 → 才写库（没有退路不做破坏性操作）；
//   ③ 备份没建成时**一条都不写**；
//   ④ 写入失败如实返回，不静默吞掉；
//   ⑤ 写回实现会带上包里带的快照，且覆盖后清理被替换那一版的旧快照。
import fs from 'node:fs'
import path from 'node:path'
import { canApplyInPlace } from '@/lib/sync/applyGate'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const root = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

function main() {
  // ① 判据
  ok('本机干净 ⇒ 可以直接覆盖', canApplyInPlace({ localDirty: false, allowLocalChanges: false }))
  ok('本机有未同步改动且未确认 ⇒ 拒绝', !canApplyInPlace({ localDirty: true, allowLocalChanges: false }))
  ok('本机有改动但已明确同意 ⇒ 允许', canApplyInPlace({ localDirty: true, allowLocalChanges: true }))
  ok('干净且已同意 ⇒ 允许', canApplyInPlace({ localDirty: false, allowLocalChanges: true }))

  // ② 静态契约：执行顺序与失败语义
  {
    const src = read('src/lib/sync/projectPullApply.ts')
    const iLoad = src.indexOf('await loadCloudCopy(')
    const iBackup = src.indexOf('await createAutoBackup(')
    const iWrite = src.indexOf('await restoreBundleToProject(')
    ok('三步都在（下载 / 备份 / 写库）', iLoad > 0 && iBackup > 0 && iWrite > 0, `${iLoad}/${iBackup}/${iWrite}`)
    ok('先下载再备份再写库', iLoad < iBackup && iBackup < iWrite, `${iLoad}/${iBackup}/${iWrite}`)
    ok('备份没建成时中止并说明没覆盖', /code: 'BACKUP'/.test(src) && /本次没有覆盖/.test(src))
    ok('写入失败如实返回（code WRITE）', /code: 'WRITE'/.test(src) && /原有内容没有被删除/.test(src))
    ok('覆盖成功后清理被替换那一版的旧快照', /bulkDel\('snapshots'/.test(src) && /oldSnapshotIds/.test(src))
    ok('读不到旧快照时不误删', /oldSnapshotIds = \[\]/.test(src))
    ok('本机项目不存在时不写库', /code: 'NO_PROJECT'/.test(src))
    ok('下载不完整时一条都不写', /code: 'DOWNLOAD'/.test(src))
  }

  // ③ 静态契约：写回实现带快照
  {
    const bak = read('src/lib/db/backups.ts')
    ok('写回时会写入包里带的快照', /bundle\.snapshots\?\.length/.test(bak), '缺少 snapshots 写入分支')
    ok('快照 chapterId 必须映射到新章', /chMap\.get\(s\.chapterId\)/.test(bak))
    ok('先写后删（旧实现不许回退成先清空）', /这才删除旧记录/.test(bak) && !/先清空、再写回/.test(bak.replace('旧实现是「先清空、再写回」', '')))
  }

  // ④ 静态契约：界面
  {
    const panel = read('src/components/app/CloudSyncPanel.tsx')
    ok('「用云端覆盖本机」已启用', panel.includes('void applyCloud()') && !panel.includes('用云端覆盖本机（暂未开放）'))
    ok('冲突区与云端新版本区都有入口', (panel.match(/void applyCloud\(\)/g) || []).length >= 2,
      String((panel.match(/void applyCloud\(\)/g) || []).length))
    ok('二次确认写明会丢失本机改动', /这些改动会被丢弃/.test(panel) && /自动备份一份/.test(panel))
    ok('覆盖成功后提示重新载入', /重新载入界面/.test(panel) && /location\.reload/.test(panel))
    ok('覆盖成功会计入同步基线', /baseRevision: r\.revision/.test(panel) && /lastSnapshotId: r\.snapshotId/.test(panel))
    ok('手动动作前有保存屏障', /const ensureSaved/.test(panel) && /runSaveBarrier/.test(panel))
    ok('至少五个手动动作先过屏障', (panel.match(/await ensureSaved\(\)/g) || []).length >= 5,
      String((panel.match(/await ensureSaved\(\)/g) || []).length))
    ok('云端作品列表 / 历史 / 配额入口齐全', /listCloudProjects/.test(panel) && /listCloudRevisions/.test(panel))
    // 只扫这个函数体：别处的注释会提到 importProject（"另存为新书"复用它）
    const expStart = panel.indexOf('const exportCloudVersion')
    const expEnd = panel.indexOf('const applyCloud', expStart)
    const expBody = expStart >= 0 ? panel.slice(expStart, expEnd > expStart ? expEnd : expStart + 1200) : ''
    ok('历史版本导出是只读的（不走 importProject）', expBody.length > 0 && !/importProject/.test(expBody))
  }

  console.log(`\n▶ projectPullApply: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()