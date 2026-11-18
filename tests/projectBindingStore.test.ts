// ============ 绑定记录（settingsKV · sync.binding）契约（3.6.1 · B1 零覆盖债）============
//
// 这条记录决定「这本稿子绑的是云端哪个项目」，写坏了是两种后果：
//   · 写歪 → 同步到别人的项目 / 反复 FORBIDDEN，用户只看到"同步失败"；
//   · 多写 → 绑定记录**随项目导出与备份走**（刻意的，换机继续写同一本），
//            一旦塞进凭据，就等于把密钥打进作者会丢到云盘的备份里。
// 所以这里钉四件事：
//   ① 键前缀 `pid::sync.binding`（走 settingsKV，跟着项目走）；
//   ② 脏数据 / 坏值 → 当"没绑定"，绝不抛（抛了作者连重新绑定都点不动）；
//   ③ 缺字段的默认值：`enabled` 缺失必须当**关**（不能因为字段缺失就偷偷开始上传）；
//   ④ **凭据类字段一律不许入库**：字段白名单 + 敏感键判据双闸。
import { BINDING_KEY, type SyncBinding } from '../src/lib/sync/projectBinding'
import { createSettingBindingStore } from '../src/lib/sync/projectBindingStore'
import { isSensitiveSettingKey, valueHasSecretField } from '../src/lib/storage/sensitiveMeta'
import { __resetMockStores, memoryOps } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const projectId = 'p-binding'
const binding = (over: Partial<SyncBinding> = {}): SyncBinding => ({
  cloudProjectId: 'prj_abc', baseRevision: 7, lastSyncedAt: 1000, enabled: true, ...over,
})

const rawSetting = () => memoryOps.get<{ key: string; value: unknown }>('settingsKV', `${projectId}::${BINDING_KEY}`)

async function main() {
  const store = createSettingBindingStore()

  // ① 读写往返 + 键前缀
  {
    __resetMockStores()
    ok('没绑定过时读到 null', (await store.get(projectId)) === null)
    await store.set(projectId, binding())
    const raw = await rawSetting()
    ok('落库键是 pid::sync.binding', (await memoryOps.get('settingsKV', `${projectId}::sync.binding`)) !== undefined, String(raw?.key))
    const read = await store.get(projectId)
    ok('读回原样（id 与版本未被改写）', read?.cloudProjectId === 'prj_abc' && read.baseRevision === 7, JSON.stringify(read))
    ok('另一项目读不到这本的绑定', (await store.get('p-other')) === null)
  }

  // ② clear 置 null（不删键，settingsKV 没有删除接口）
  {
    __resetMockStores()
    await store.set(projectId, binding())
    await store.clear(projectId)
    const raw = await rawSetting()
    ok('清理后当"没绑定"处理', (await store.get(projectId)) === null)
    ok('清理是把值置 null 而不是删键（不留前缀垃圾）', raw !== undefined && raw.value === null, JSON.stringify(raw))
  }

  // ③ 脏数据不崩
  {
    const dirty: unknown[] = [null, 'not-an-object', 42, [], { cloudProjectId: '' }, { cloudProjectId: 'prj', baseRevision: 'x' }]
    let crashed = ''
    let allNull = true
    for (const value of dirty) {
      __resetMockStores()
      await memoryOps.put('settingsKV', { key: `${projectId}::${BINDING_KEY}`, value })
      try {
        if (await store.get(projectId) !== null) allNull = false
      } catch (e) { crashed = e instanceof Error ? e.message : String(e) }
    }
    ok('坏数据一律当"没绑定"，不抛错', crashed === '' && allNull, crashed || JSON.stringify({ allNull }))
  }

  // ④ 缺字段默认值：enabled 缺失 ≠ 开启
  {
    __resetMockStores()
    await memoryOps.put('settingsKV', {
      key: `${projectId}::${BINDING_KEY}`,
      value: { cloudProjectId: 'prj_old', baseRevision: 1 },
    })
    const read = await store.get(projectId)
    ok('缺 enabled 时按关闭处理（不能因字段缺失偷偷上传）', read?.enabled === false, JSON.stringify(read))
    ok('缺 lastSyncedAt 时补 0', read?.lastSyncedAt === 0, JSON.stringify(read))
  }

  // ⑤ 凭据不得入库：字段白名单
  {
    __resetMockStores()
    await store.set(projectId, binding({ lastSnapshotId: 'snap_1' }))
    const raw = await rawSetting()
    const allowed = new Set(['cloudProjectId', 'baseRevision', 'lastSyncedAt', 'enabled', 'lastSnapshotId'])
    const keys = Object.keys((raw?.value ?? {}) as Record<string, unknown>)
    const extra = keys.filter(key => !allowed.has(key))
    ok('绑定记录只含白名单字段（新增字段必须同步更新白名单与敏感键判据）', extra.length === 0, extra.join(','))
    const looksLikeCredential = keys.some(key => /token|secret|password|credential|apikey|api_key/i.test(key))
    ok('绑定记录里没有凭据类字段名', !looksLikeCredential, keys.join(','))
    ok('当前值不被判成敏感设置（所以不会被导出剥离）', !isSensitiveSettingKey('sync.binding', raw?.value), JSON.stringify(raw?.value))
    ok('当前值里没有嵌套密钥字段', !valueHasSecretField(raw?.value), JSON.stringify(raw?.value))
  }

  // ⑥ 反向闸：一旦真加了 token，判据必须立刻变红（挡住"加了但没登记"）
  {
    const withToken = { ...binding(), token: 'plain-text-token' }
    ok('值里出现 token 时敏感判据立刻生效', isSensitiveSettingKey('sync.binding', withToken) === true, JSON.stringify(withToken))
    ok('值里出现嵌套密钥时同样生效', valueHasSecretField({ ...binding(), auth: { apiKey: 'sk-x' } }) === true)
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} projectBindingStore ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

await main()
