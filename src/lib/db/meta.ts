// ============ 存储层 · 元数据（meta / 项目设置 / 每日码字统计）============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
import { todayKey } from '@/lib/app/date'
import { ops, currentProjectId } from '@/lib/db/core'

// ============ Meta ============
export async function getMeta<T>(key: string, def: T): Promise<T> {
  const rec = await ops.get<{ key: string; value: T }>('meta', key)
  return rec?.value ?? def
}
export async function setMeta(key: string, value: unknown) {
  await ops.put('meta', { key, value })
}

// ============ 每日码字统计 ============
export interface DailyStat { key: string; projectId: string; date: string; words: number }

/**
 * 累加当日字数增量（可为负，最低 0）
 *
 * 🔴 读-改-写必须**全局串行**（2026-10-17 全量审计 P2）：
 *   原先每次调用各自 get → put，两章几乎同时保存时，后写者会用自己读到的旧值覆盖前者的累加
 *   ⇒ 当日码字量少算（编辑器 2s 自动保存、Ctrl+S、标题防抖落库三路都可能并发）。
 *   这里用一条模块级 promise 链把「读-改-写」排成队；单次失败不堵后续。
 *   ⚠️ 队列只管本进程内；跨窗口并发不在本机制范围内（桌面版单窗口，不涉及）。
 */
let dailyChain: Promise<unknown> = Promise.resolve()
export function addDailyWords(delta: number, projectId = currentProjectId, store = ops): Promise<DailyStat | undefined> {
  if (!projectId || !delta) return Promise.resolve(undefined)
  const run = dailyChain.then(() => addDailyWordsNow(delta, projectId, store))
  // 链上留一个「已消化失败」的版本，避免一次写库失败把后续所有累加都堵死
  dailyChain = run.then(() => undefined, () => undefined)
  return run
}

async function addDailyWordsNow(delta: number, projectId: string, store: typeof ops): Promise<DailyStat | undefined> {
  const date = todayKey()
  const key = `${projectId}::${date}`
  const rec = await store.get<DailyStat>('dailyStats', key)
  const words = Math.max(0, (rec?.words ?? 0) + delta)
  const next = { key, projectId, date, words }
  await store.put('dailyStats', next)
  return next
}
/** 获取当前项目全部每日统计 */
export async function getDailyStats(): Promise<DailyStat[]> {
  const all = await ops.getAll<DailyStat>('dailyStats')
  return all.filter(s => s.projectId === currentProjectId).sort((a, b) => a.date.localeCompare(b.date))
}
/** 直接写入某日统计（种子数据用，不累加） */
export async function putDailyStat(date: string, words: number) {
  await ops.put('dailyStats', { key: `${currentProjectId}::${date}`, projectId: currentProjectId, date, words } as DailyStat)
}

// ============ 项目设置（自定义敏感词 / 取名收藏） ============
export async function getSetting<T>(key: string, def: T): Promise<T> {
  const rec = await ops.get<{ key: string; value: T }>('settingsKV', `${currentProjectId}::${key}`)
  return rec?.value ?? def
}
export async function setSetting(key: string, value: unknown) {
  await ops.put('settingsKV', { key: `${currentProjectId}::${key}`, value })
}

/**
 * 按**指定项目 id**读写项目设置（3.0 · 题材开关）。
 *
 * 🔴 为什么不能拿上面两个顶替：它们拼的是 `currentProjectId`（当前打开的那一本）。
 *    在「项目管理页」编辑**另一本**项目的设置时，那会被写到当前打开的书上 ——
 *    表现是"改了 A 的开关，B 的行为变了"，且极难定位。凡是"要改的不是当前项目"的场合
 *    （项目管理页的编辑卡片 / 批量操作 / 导入后的补写）一律走这两个。
 */
export async function getSettingFor<T>(pid: string, key: string, def: T): Promise<T> {
  const rec = await ops.get<{ key: string; value: T }>('settingsKV', `${pid}::${key}`)
  return rec?.value ?? def
}

export async function setSettingFor(pid: string, key: string, value: unknown) {
  await ops.put('settingsKV', { key: `${pid}::${key}`, value })
}

/**
 * 删除**当前项目**的一条设置（键不存在也算成功 —— 幂等）。
 *
 * 🔴 为什么必须补这个口子（2026-10-13）：此前只有 get / set，没有 del ⇒
 *    「把旧键迁移到新位置」这类动作只能**覆盖成空值**、删不掉。而残留的空壳键
 *    仍会被 `exportProject()` 按 `<项目id>::` 前缀收进 bundle —— 旧版把 AI 配置
 *    存在项目级时，那个键带着 apiKey 明文，于是备份文件 / 迁移包把密钥一起带出门。
 *    要真正堵住，迁移完必须**能删**。
 */
export async function delSetting(key: string): Promise<void> {
  await ops.del('settingsKV', `${currentProjectId}::${key}`)
}

/**
 * 删除**指定项目**的一条设置（3.1.3 · R03）。
 *
 * 🔴 为什么必须补它：原先只有 `delSetting`（删当前项目）。凡是要删的那条**不是当前项目**的
 *    （异步任务执行期间作者已经切了书 —— 见 `creative/interviewStore` 的串行落盘队列），
 *    用 delSetting 就会**删掉当前这本的键**：A 的存档没删掉、B 的同名存档被误删。
 *    这正是验收 R03 里"清理路径也可能删错项目记录"的那一半。
 */
export async function delSettingFor(pid: string, key: string): Promise<void> {
  await ops.del('settingsKV', `${pid}::${key}`)
}
