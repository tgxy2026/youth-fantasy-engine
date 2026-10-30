// 3.3.2 · P4-1 绑定与冲突决策 · 单测
//
// 盯四件事：
//   ① 三种"看着能自动处理、实际绝不能自动"的情况必须停下（两边都改 / 云端回滚 / 云端消失）；
//   ② 「保留本机」必须把基线换成云端的 revision，否则点了也还是 409；
//   ③ 「两份都留」必须先另存再拉，顺序反了本地就没了；
//   ④ 未开启自动同步时不能显示"未同步"吓人。
import {
  decideSync, planConflict, bindingToState, createMemoryBindingStore, bindingForAccount, nextBindingAfterCommit, resolveDisplayState,
  type SyncBinding, type RemoteState,
} from '@/lib/sync/projectBinding'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const T0 = 1_700_000_000_000
const bind = (over: Partial<SyncBinding> = {}): SyncBinding => ({
  cloudProjectId: 'c1', baseRevision: 3, lastSyncedAt: T0, enabled: true, ...over,
})
const remote = (over: Partial<RemoteState> = {}): RemoteState => ({ exists: true, revision: 3, ...over })

async function main() {
  // ---------- 1. 未绑定 ----------
  {
    const d = decideSync({ binding: null, remote: remote(), localDirty: false })
    ok('未绑定→要求先选方向', d.action === 'bind-required', d.action)
  }

  // ---------- 2. 云端消失 / 回收站 ----------
  {
    const gone = decideSync({ binding: bind(), remote: remote({ exists: false }), localDirty: false })
    ok('云端没了→remote-gone（不悄悄重建）', gone.action === 'remote-gone', gone.action)
    ok('云端没了的说明提到本机内容完好', /完好/.test(gone.reason), gone.reason)
    const del = decideSync({ binding: bind(), remote: remote({ deleted: true }), localDirty: true })
    ok('云端进回收站→remote-deleted（不重新上传）', del.action === 'remote-deleted', del.action)
  }

  // ---------- 3. 版本相同 ----------
  {
    ok('版本相同+干净→up-to-date',
      decideSync({ binding: bind(), remote: remote(), localDirty: false }).action === 'up-to-date')
    ok('版本相同+有改动→push',
      decideSync({ binding: bind(), remote: remote(), localDirty: true }).action === 'push')
  }

  // ---------- 4. 云端前进 ----------
  {
    const clean = decideSync({ binding: bind({ baseRevision: 3 }), remote: remote({ revision: 7 }), localDirty: false })
    ok('云端前进+干净→pull', clean.action === 'pull', clean.action)
    ok('pull 带上起止版本', clean.action === 'pull' && clean.fromRevision === 3 && clean.toRevision === 7, JSON.stringify(clean))

    const dirty = decideSync({ binding: bind({ baseRevision: 3 }), remote: remote({ revision: 7 }), localDirty: true })
    ok('云端前进+本地也改→conflict（绝不自动选边）', dirty.action === 'conflict', dirty.action)
    ok('冲突说明写了双方版本号', /第 3 版/.test(dirty.reason) && /第 7 版/.test(dirty.reason), dirty.reason)
  }

  // ---------- 5. 云端回滚 ----------
  {
    const d = decideSync({ binding: bind({ baseRevision: 9 }), remote: remote({ revision: 2 }), localDirty: false })
    ok('云端比本地记的还旧→remote-regressed（暂停，不覆盖）', d.action === 'remote-regressed', d.action)
    ok('回滚说明提到可能换了账号', /换过账号|回滚/.test(d.reason), d.reason)
  }

  // ---------- 6. 冲突三种解法 ----------
  {
    const keepLocal = planConflict('keep-local', 7)
    // 🔴 关键：基线必须换成云端 revision，否则重推还是 409、界面上"点了没反应"
    ok('保留本机→以云端版本为基线重推', keepLocal.type === 'push' && keepLocal.baseRevision === 7, JSON.stringify(keepLocal))
    ok('保留本机说明提到云端旧版留历史', /历史/.test(keepLocal.note), keepLocal.note)

    const keepRemote = planConflict('keep-remote', 7)
    ok('保留云端→拉取覆盖', keepRemote.type === 'pull' && keepRemote.revision === 7, JSON.stringify(keepRemote))
    ok('保留云端说明写了"先留自动备份"', /备份/.test(keepRemote.note), keepRemote.note)

    const both = planConflict('keep-both', 7)
    // 🔴 关键：先 fork 再 pull，顺序反了本地就没了
    ok('两份都留→先另存再拉取', both.type === 'fork-local-then-pull' && both.revision === 7, JSON.stringify(both))
  }

  // ---------- 7. 异常输入 ----------
  ok('云端版本号异常→不做动作', planConflict('keep-local', 0).type === 'none')
  ok('云端版本号非法→不做动作', planConflict('keep-local', Number.NaN).type === 'none')

  // ---------- 8. 界面状态 ----------
  {
    ok('未绑定的状态是 idle', bindingToState(null, 'bind-required') === 'idle')
    ok('未开启自动同步→idle（不显示"未同步"）', bindingToState(bind({ enabled: false }), 'conflict') === 'idle')
    ok('冲突→conflict', bindingToState(bind(), 'conflict') === 'conflict')
    ok('云端回滚→blocked', bindingToState(bind(), 'remote-regressed') === 'blocked')
    ok('该拉→queued', bindingToState(bind(), 'pull') === 'queued')
    ok('已最新→synced', bindingToState(bind(), 'up-to-date') === 'synced')
  }

  // ---------- 9. 绑定存取 ----------
  {
    const store = createMemoryBindingStore()
    ok('没记录时返回 null', (await store.get('p1')) === null)
    await store.set('p1', bind({ cloudProjectId: 'cx' }))
    const got = await store.get('p1')
    ok('写入后能读回', got?.cloudProjectId === 'cx', JSON.stringify(got))
    await store.clear('p1')
    ok('解除绑定后读不到', (await store.get('p1')) === null)
  }

  // ---------- 10. 绑定记录里不该有凭据 ----------
  {
    const keys = Object.keys(bind())
    ok('绑定含四个必填字段（id/版本/时间/开关）',
      ['cloudProjectId', 'baseRevision', 'lastSyncedAt', 'enabled'].every((k) => keys.includes(k)),
      keys.join(','))
    // 🔴 凭据一旦落进项目设置就会随导出/备份扩散
    ok('绑定记录里没有 token / 密码 / Cookie 之类字段',
      !keys.some((k) => /token|pwd|secret|cookie|auth/i.test(k)), keys.join(','))
  }

  // ---------- 11. 换账号后绑定作废（否则拿别人的云端 id 一路 403）----------
  {
    const b = bind({ accountId: 'u1' })
    ok('同账号→绑定有效', bindingForAccount(b, 'u1')?.cloudProjectId === 'c1')
    ok('换账号→绑定作废（需重新绑定）', bindingForAccount(b, 'u2') === null)
    ok('老数据无账号 + 当前无账号→放行', bindingForAccount(bind(), undefined) !== null)
    ok('老数据无账号 + 当前有账号→作废（宁可重绑一次）', bindingForAccount(bind(), 'u2') === null)
    ok('没有绑定→null', bindingForAccount(null, 'u1') === null)
  }

  // ---------- 12. 提交成功后回写绑定（实机验证抓到的阻断问题）----------
  {
    const before = bind({ baseRevision: 0, lastSyncedAt: 0, accountId: 'u1' })
    const after = nextBindingAfterCommit(before, 'c1', 1, T0 + 5000)
    ok('提交成功 ⇒ 基线推进到云端 revision', after?.baseRevision === 1, String(after?.baseRevision))
    ok('提交成功 ⇒ 上次同步时间更新', after?.lastSyncedAt === T0 + 5000, String(after?.lastSyncedAt))
    ok('回写保留开关与账号', after?.enabled === true && after?.accountId === 'u1', JSON.stringify(after))
    // 🔴 不回写的后果：下一轮 tick 会拿 baseRevision=0 比对 remote=1 + 本地有改动 ⇒ 假冲突
    const decisionIfNotWritten = decideSync({
      binding: before, remote: { exists: true, revision: 1 }, localDirty: true,
    })
    ok('不回写会判成假冲突（这条钉住"为什么必须回写"）', decisionIfNotWritten.action === 'conflict', decisionIfNotWritten.action)
    ok('回写后同一条件下判成 push（不再冲突）', (() => {
      const d = decideSync({ binding: after!, remote: { exists: true, revision: 1 }, localDirty: true })
      return d.action === 'push'
    })())

    ok('绑定指向别的云端项目时不回写', nextBindingAfterCommit(before, 'other', 1, T0) === null)
    ok('revision 为 0 时不回写（服务端没给出有效版本）', nextBindingAfterCommit(before, 'c1', 0, T0) === null)
    ok('revision 非数时不回写', nextBindingAfterCommit(before, 'c1', Number.NaN, T0) === null)
    ok('没有绑定时不回写', nextBindingAfterCommit(null, 'c1', 1, T0) === null)
  }

  // ---------- 13. 界面展示状态（实机验证抓到的「刚同步完却写未同步」）----------
  {
    const d = (over: Partial<Parameters<typeof resolveDisplayState>[0]>) => resolveDisplayState({
      hasBinding: true, queueState: 'idle', cloudRevision: 1, baseRevision: 1, ...over,
    })
    // 🔴 这条是核心：队列跑空（idle）+ 基线一致 ⇒ 必须显示"已同步"
    ok('队列 idle 但基线一致 ⇒ 已同步（不再写"未同步"）', d({}) === 'synced', d({}))
    ok('未绑定时照实显示队列状态', d({ hasBinding: false, cloudRevision: null, baseRevision: 0 }) === 'idle')
    ok('云端版本更高 ⇒ 排队中（有东西要拉/推）', d({ cloudRevision: 2, baseRevision: 1 }) === 'queued')
    ok('云端版本更低 ⇒ 已暂停（回滚/换账号，不能显示已同步）', d({ cloudRevision: 0, baseRevision: 3 }) === 'blocked')
    ok('同步中优先展示', d({ queueState: 'syncing' }) === 'syncing')
    ok('冲突优先展示', d({ queueState: 'conflict' }) === 'conflict')
    ok('离线优先展示', d({ queueState: 'offline' }) === 'offline')
    ok('云端版本未知 ⇒ 沿用队列状态（不猜）', d({ cloudRevision: null }) === 'idle')
  }

  console.log(`\n▶ projectBinding: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
