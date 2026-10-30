// 3.3.2 · B1 自动同步调度 · 单测
//
// 盯五件事：
//   ① 没绑定 / 关着自动同步 ⇒ 一律不推（默认全自动会让"只在本机写"的用户莫名上传）；
//   ② 绑定属于别的账号 ⇒ 单独报 other-account（报成"未绑定"会让用户以为设置丢了）；
//   ③ 云端 revision 未知 ⇒ 不推（猜基线的代价是盖掉别人的版本）；
//   ④ 真正有改动才推，且带的是绑定里记的基线；
//   ⑤ 云端也前进了 ⇒ 报冲突，不自动选边。
import { decideTick, autoSyncTick, tickMessage, type AutoSyncDeps } from '@/lib/app/syncAuto'
import type { SyncBinding } from '@/lib/sync/projectBinding'
import type { SyncController } from '@/lib/sync/syncController'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const T0 = 1_700_000_000_000
const bind = (over: Partial<SyncBinding> = {}): SyncBinding => ({
  cloudProjectId: 'c1', baseRevision: 3, lastSyncedAt: T0, enabled: true, ...over,
})
const local = (updatedAt: number) => ({ id: 'p1', updatedAt })

function main() {
  // ---------- 1. 各种不推 ----------
  ok('没打开项目 ⇒ 不推', decideTick({ local: null, binding: bind(), remoteRevision: 3, busy: false }).action === 'skip')
  ok('没绑定 ⇒ unbound', (() => {
    const d = decideTick({ local: local(T0 + 1), binding: null, remoteRevision: null, busy: false })
    return d.action === 'skip' && d.reason === 'unbound'
  })())
  ok('关着自动同步 ⇒ disabled（不查云端也不推）', (() => {
    const d = decideTick({ local: local(T0 + 1), binding: bind({ enabled: false }), remoteRevision: 3, busy: false })
    return d.action === 'skip' && d.reason === 'disabled'
  })())
  ok('绑定属于别的账号 ⇒ other-account', (() => {
    const d = decideTick({
      local: local(T0 + 1), binding: bind({ accountId: 'u1' }), accountId: 'u2', remoteRevision: 3, busy: false,
    })
    return d.action === 'skip' && d.reason === 'other-account'
  })())
  ok('正在跑 ⇒ busy', (() => {
    const d = decideTick({ local: local(T0 + 1), binding: bind(), remoteRevision: 3, busy: true })
    return d.action === 'skip' && d.reason === 'busy'
  })())
  ok('本地没改动 ⇒ clean', (() => {
    const d = decideTick({ local: local(T0 - 1), binding: bind({ lastSyncedAt: T0 }), remoteRevision: 3, busy: false })
    return d.action === 'skip' && d.reason === 'clean'
  })())
  // 🔴 云端前进而本机干净：这是"另一台设备写了新东西"。不自动应用，但要如实报出来 ——
  //    否则用户在两台机器上来回切，永远看不到"云端已经更新"。
  ok('云端前进而本机干净 ⇒ remote-ahead', (() => {
    const d = decideTick({ local: local(T0 - 1), binding: bind({ baseRevision: 3 }), remoteRevision: 5, busy: false })
    return d.action === 'remote-ahead' && d.remoteRevision === 5
  })())
  // 云端比本机记的还旧：既不能推也不能拉，报出来让界面显示"已暂停"
  ok('云端比记录旧 ⇒ remote-regressed', (() => {
    const d = decideTick({ local: local(T0 - 1), binding: bind({ baseRevision: 5 }), remoteRevision: 3, busy: false })
    return d.action === 'skip' && d.reason === 'remote-regressed'
  })())
  // 云端前进但本机也脏：仍然是冲突（不能因为是"只拉"就绕过）
  ok('云端前进且本机有改动 ⇒ conflict', (() => {
    const d = decideTick({ local: local(T0 + 1), binding: bind({ baseRevision: 3 }), remoteRevision: 5, busy: false })
    return d.action === 'conflict'
  })())
  // 🔴 这条最关键：宁可这轮不推，也不猜基线
  ok('云端版本未知 ⇒ unknown-remote（不猜基线）', (() => {
    const d = decideTick({ local: local(T0 + 1), binding: bind(), remoteRevision: null, busy: false })
    return d.action === 'skip' && d.reason === 'unknown-remote'
  })())

  // ---------- 2. 该推 ----------
  {
    const d = decideTick({ local: local(T0 + 5000), binding: bind({ baseRevision: 7 }), remoteRevision: 7, busy: false })
    ok('有改动且云端没变 ⇒ push', d.action === 'push', JSON.stringify(d))
    ok('push 带绑定里的基线', d.action === 'push' && d.baseRevision === 7, JSON.stringify(d))
  }

  // ---------- 3. 冲突 ----------
  {
    const d = decideTick({ local: local(T0 + 5000), binding: bind({ baseRevision: 3 }), remoteRevision: 9, busy: false })
    ok('云端也前进 ⇒ conflict（不自动选边）', d.action === 'conflict', JSON.stringify(d))
    ok('冲突带上双方版本', d.action === 'conflict' && d.localBase === 3 && d.remoteRevision === 9, JSON.stringify(d))
  }

  // ---------- 4. 调度器端到端（注入假依赖）----------
  const mkController = (): SyncController & { pushed: unknown[] } => {
    const pushed: unknown[] = []
    return {
      pushed,
      async init() { return 0 },
      async requestPush(input) { pushed.push(input); return { id: 'x', ...input, createdAt: 0, updatedAt: 0, state: 'pending', attempts: 0 } },
      async enqueueOnly(input) { return { id: 'x', ...input, createdAt: 0, updatedAt: 0, state: 'pending', attempts: 0 } },
      async drain() { return [] },
      async stateOf() { return 'idle' },
      subscribe() { return () => {} },
      isRunning() { return false },
    }
  }

  ;(async () => {
    {
      const ctl = mkController()
      const deps: AutoSyncDeps = {
        getCurrentProject: async () => local(T0 + 1000),
        // 🔴 绑定必须带 accountId：老数据没有账号字段时，当前有账号一律视为不匹配
        //    （`bindingForAccount` 的既定语义：宁可重绑一次，也不拿别人的 id 去撞 403）
        getBinding: async () => bind({ baseRevision: 4, accountId: 'u1' }),
        getRemoteRevision: async () => 4,
        controller: ctl,
        getAccountId: () => 'u1',
        now: () => T0,
      }
      const d = await autoSyncTick(deps)
      ok('调度器在有改动时真的推了一次', d.action === 'push' && ctl.pushed.length === 1, JSON.stringify(ctl.pushed))
    }
    {
      const ctl = mkController()
      let remoteCalls = 0
      const deps: AutoSyncDeps = {
        getCurrentProject: async () => local(T0 + 1000),
        getBinding: async () => bind({ enabled: false }),
        getRemoteRevision: async () => { remoteCalls++; return 4 },
        controller: ctl,
        now: () => T0,
      }
      const d = await autoSyncTick(deps)
      ok('关着自动同步时不查云端（省一次网络）', d.action === 'skip' && remoteCalls === 0, String(remoteCalls))
    }
    {
      const ctl = mkController()
      const deps: AutoSyncDeps = {
        getCurrentProject: async () => local(T0 + 1000),
        getBinding: async () => bind({ accountId: 'u1' }),
        getRemoteRevision: async () => 3,
        controller: ctl,
        getAccountId: () => 'u2',
        now: () => T0,
      }
      const d = await autoSyncTick(deps)
      ok('换账号后不推、也不查云端', d.action === 'skip' && d.reason === 'other-account' && ctl.pushed.length === 0, JSON.stringify(d))
    }
    {
      const ctl = mkController()
      const deps: AutoSyncDeps = {
        getCurrentProject: async () => local(T0 + 1000),
        getBinding: async () => bind(),
        getRemoteRevision: async () => null,   // 网络查不到
        controller: ctl,
        now: () => T0,
      }
      const d = await autoSyncTick(deps)
      ok('查不到云端时不推（等下一轮）', d.action === 'skip' && d.reason === 'unknown-remote' && ctl.pushed.length === 0, JSON.stringify(d))
    }

    // ---------- 5. 文案 ----------
    ok('冲突文案是给人看的', /保留哪一份/.test(tickMessage({ action: 'conflict', localBase: 1, remoteRevision: 2 })))
    ok('换账号文案说清楚了原因', /另一个账号/.test(tickMessage({ action: 'skip', reason: 'other-account' })))
    ok('正常跳过不出文案', tickMessage({ action: 'skip', reason: 'clean' }) === '')

    console.log(`\n▶ syncAuto: ${pass} passed, ${fail} failed`)
    if (fail) process.exit(1)
  })()
}

main()
