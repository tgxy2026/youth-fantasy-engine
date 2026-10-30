// ============ 3.3.2 · P4-1b 绑定记录的生产存储 ============
//
// 存进项目级设置（`settingsKV`，键 `sync.binding`，前缀由 `setSettingFor` 自动加 `pid::`）。
// 选它而不是独立 IDB 的原因：
//   · 要**跟着项目走** —— 导出/导入后仍指向同一个云端项目，换机继续写同一本；
//   · 内容是纯文本、体积极小，不拖累整库写盘（对比：`-vec`/`-kb` 那种几十 MB 的才必须外置）。
//
// 🔴 这个键**不是**敏感键（`sensitiveMeta` 里没有它）：里面只有 id 与版本号，没有凭据。
//    如果哪天要往里加 token，必须同时把它加进敏感键清单，否则会随导出/备份扩散。
import { getSettingFor, setSettingFor } from '@/lib/db/meta'
import type { BindingStore, SyncBinding } from '@/lib/sync/projectBinding'
import { BINDING_KEY } from '@/lib/sync/projectBinding'

/** 读到的值是否像个绑定记录（防止历史脏数据把界面搞崩） */
function isBinding(v: unknown): v is SyncBinding {
  if (!v || typeof v !== 'object') return false
  const b = v as Partial<SyncBinding>
  return typeof b.cloudProjectId === 'string' && b.cloudProjectId.length > 0
    && typeof b.baseRevision === 'number' && Number.isFinite(b.baseRevision)
}

export function createSettingBindingStore(): BindingStore {
  return {
    async get(projectId) {
      const raw = await getSettingFor<unknown>(projectId, BINDING_KEY, null)
      // 脏数据当"没绑定"处理：比抛异常好，用户至少还能重新绑定
      if (!isBinding(raw)) return null
      // 老记录缺字段时补默认：缺 `enabled` 一律当"关"（不能因为字段缺失就偷偷开始上传）
      return {
        ...raw,
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : false,
        lastSyncedAt: typeof raw.lastSyncedAt === 'number' ? raw.lastSyncedAt : 0,
      }
    },
    async set(projectId, binding) {
      await setSettingFor(projectId, BINDING_KEY, binding)
    },
    async clear(projectId) {
      // 置 null 而不是删键：`settingsKV` 没有删除接口，置 null 语义等价且不会留下前缀垃圾
      await setSettingFor(projectId, BINDING_KEY, null)
    },
  }
}
