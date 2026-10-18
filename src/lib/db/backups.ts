// ============ 存储层 · 自动备份 ============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
// 🔴 备份是**本地专属**数据（不参与云盘同步），见 makeCloudStoreWrapper 的短路逻辑。
import type { Project, FormData } from '@/lib/types'
import { uid } from '@/lib/app/id'
import { ops, touchProject } from '@/lib/db/core'
import { WEB } from '@/lib/app/platform'
import { exportProject, remapSettingValue, type ProjectBundle, getProject } from '@/lib/db/projects'
import { restoreDocsFromBundle } from '@/lib/search/knowledgeBase'
import { isDemoProjectName } from '@/lib/constants'
import { currentSidecarApi } from '@/lib/storage/sidecar'
import { VOL_LEDGER_PREFIX } from '@/lib/db/volumes'
import { splitBundle, mergeShards, applyMediaToBundle, mediaPayloadIdOf, type MediaShard } from '@/lib/backup/shards'

// ============ 自动备份（v1.3 备份策略加固） ============
// 每个项目一份独立「备份夹」（逻辑上按 projectId 归组），删除项目不掉备份；
// 三类：'auto5min'（打开项目时每 5 分钟滚动，最多保留 MAX_AUTO_BACKUPS 份）、
//       'daily'（每天首次打开自动 1 份，最多保留 MAX_DAILY_BACKUPS 份）、
//       'manual'（用户手动「立即备份」，不设上限 —— 主动留档不该被系统删掉）。
// #012：每日备份此前不限量，写一年即 365 份全量快照，便携版（单 JSON 全量写盘）会持续膨胀。
export type BackupKind = 'auto5min' | 'daily' | 'manual' | 'frozen'

/**
 * 备份**元数据**（backups store 从 C2 起只存它）。
 *
 * 🔴 为什么拆（C2 · 2.4.2）：原先元数据与整包 bundle 同条记录 ⇒ 列个备份清单就要把每份备份
 * 全文读出来（UI 还得对每份 `JSON.stringify` 一次算体积）。拆开后列表零成本，
 * 只有「恢复」与「导出单份备份」才去读 `backupPayloads`。
 */
export interface BackupMeta {
  id: string
  projectId: string
  kind: BackupKind
  label: string
  createdAt: number
  /** 载荷字节数（UTF-8 近似，写入时算一次；列表直接读，不再 stringify） */
  bytes: number
  /**
   * 🔴 以下三个字段**只有「定稿版本」（kind='frozen'）会写**，其余 kind 恒为 undefined。
   *    加**可选字段不加迁移**（与 aiAssist / aiRuns 同口径）：旧数据没有即 undefined，读取侧判存在。
   */
  /** 作者给这一版写的备注（「投稿版：改完第 12 章的节奏」这类） */
  note?: string
  /** 冻结时的**作品级指纹**（`lib/bookVersion.ts` 的 `bookFingerprint`）—— 用于判断「这一版还是不是当前稿」 */
  fingerprint?: string
  /** 冻结时的完成检查摘要（章数 / 字数等；存下来即可离线回看，不必重算） */
  stats?: FrozenStats
  /**
   * 3.1.3 逻辑分片的引用（见 `BackupShardRefs`）。
   * ⚠️ 旧备份没有这个字段 ⇒ 读取侧一律按「整包」处理（`getBackupPayload` 里有兜底）。
   */
  shards?: BackupShardRefs
}

/** 冻结版本带出的完成检查摘要（与 `bookVersion.BookStats` 的展示子集对齐，刻意只存展示需要的） */
export interface FrozenStats {
  volumes: number
  chapters: number
  writtenChapters: number
  totalWords: number
}

/** 备份**载荷**（backupPayloads store）。3.1.3 起一份备份 = 文字片 + 媒体片（见下） */
export interface BackupPayload {
  id: string
  projectId: string
  /**
   * 3.1.3 逻辑分片：
   *   'text'  文字片（`bundle` 里**不含任何 dataURL**）
   *   'media' 媒体片（`media.blobs` + `media.links`，按内容去重）
   *   'full'  / 缺省：旧形态整包 —— **只用于兼容读取**，新代码不再写
   */
  kind?: 'full' | 'text' | 'media'
  bundle?: ProjectBundle
  media?: MediaShard
}

/**
 * 备份元数据里的分片引用（3.1.3）。
 *
 * 🔴 为什么媒体片要单独记 id：媒体片是**内容寻址、可复用**的 —— 图片没变时，
 *    连续 10 次备份指向同一个媒体片（这正是省空间的关键）。所以 `mediaPayloadId`
 *    不等于 `id`，删备份时也必须先确认「没有其他备份还在引用它」才能真的删。
 */
export interface BackupShardRefs {
  /** 文字片载荷 id（通常等于 meta.id） */
  textPayloadId: string
  /** 媒体片载荷 id；这份备份没有图片时缺省 */
  mediaPayloadId?: string
  /** 去重后的图片张数 */
  mediaCount?: number
  /** 图片字符数合计 */
  mediaChars?: number
  /** 文字片字符数（列表里显示"文字 / 图片"拆分用） */
  textChars?: number
}

/**
 * v11 之前的老形态：元数据与 bundle 同一条。
 * ⚠️ 只用于**兼容读取**，绝不写入 —— 数据迁移见 `db/migrations.ts` 的 migrateBackupPayloads。
 */
type LegacyBackupRecord = Omit<BackupMeta, 'bytes'> & { bytes?: number; bundle?: ProjectBundle }

/** 兼容别名：界面与旧代码里的 `BackupRecord` 现即元数据（不再含 bundle） */
export type BackupRecord = BackupMeta

/** 5 分钟自动备份滚动保留上限（#012：60 → 30） */
export const MAX_AUTO_BACKUPS = 30
/** 每日自动备份保留上限（#012：原先不限量 → 30，约一个月） */
export const MAX_DAILY_BACKUPS = 30

/**
 * 网页版专用档位（WEB-02 衍生议题：云端备份**计入 200 MB 账号配额**）。
 *
 * 【为什么必须分开】每份备份是**整包全量快照**，重复内容占 99%。按桌面档位算一笔账：
 *   一个 100 万字项目约 3 MB 文本 ⇒ 自动 30 份 + 每日 30 份 ≈ **180 MB**，
 *   而配额总共 200 MB —— 等于用户自己的书只占 3 MB，其余全被备份历史吃掉，
 *   写到第 60 份时就会被「存储空间不足」挡住，而他还一部书都没写完。
 * 网页版收紧为 10 + 7（约 51 MB）：既保住「最近改动能找回」，又不挤占创作空间。
 * 桌面版 / 便携版是**本机存储**、磁盘宽裕，维持 30 + 30 不变（常量即桌面档位）。
 */
const WEB_MAX_AUTO_BACKUPS = 10
const WEB_MAX_DAILY_BACKUPS = 7

/** 当前平台的自动备份保留份数（网页版走收紧档） */
export function maxAutoBackups(): number {
  return WEB ? WEB_MAX_AUTO_BACKUPS : MAX_AUTO_BACKUPS
}
/** 当前平台的每日备份保留份数 */
export function maxDailyBackups(): number {
  return WEB ? WEB_MAX_DAILY_BACKUPS : MAX_DAILY_BACKUPS
}

/** 保留上限查表：手动备份为 0，表示不限制 */
function backupLimit(kind: BackupKind): number {
  if (kind === 'auto5min') return maxAutoBackups()
  if (kind === 'daily') return maxDailyBackups()
  // manual / frozen：作者主动留档，永不自动删
  return 0
}

/** 载荷字节数（与旧 UI 的 `JSON.stringify(bundle).length` 同口径，保持数字可比） */
function payloadBytes(bundle: ProjectBundle): number {
  return JSON.stringify(bundle).length
}

/** 老记录补 bytes（未迁移的库里列表仍要显示体积）；已带 bytes 的原样返回 */
function withBytes(rec: BackupMeta | LegacyBackupRecord): BackupMeta {
  const b = (rec as LegacyBackupRecord).bytes
  const bytes = typeof b === 'number' ? b : ((rec as LegacyBackupRecord).bundle ? payloadBytes((rec as LegacyBackupRecord).bundle!) : 0)
  // 剥掉 legacy 的 bundle —— 元数据出库就只该是元数据，防止调用方误用整包。
  // 🔴 但 frozen 的 note / fingerprint / stats 必须**原样带出** —— 这里若只挑老字段重建，
  //    定稿元信息会在列表里静默丢失（正是「重建对象」这类写法最容易踩的坑）。
  return {
    id: rec.id, projectId: rec.projectId, kind: rec.kind, label: rec.label, createdAt: rec.createdAt, bytes,
    ...(rec.note ? { note: rec.note } : {}),
    ...(rec.fingerprint ? { fingerprint: rec.fingerprint } : {}),
    ...(rec.stats ? { stats: rec.stats } : {}),
  }
}

/**
 * 创建一次全量自动备份。
 *
 * ⚠️ 2026-10-12 全量审计：原注释写「默认上限由调用方保证」与实现不符 —— 上限其实由**本函数末尾**
 *    的滚动淘汰执行（`backupLimit(kind)`，元数据与载荷一起删）；手动备份 limit=0 ⇒ 不淘汰。
 *
 * 🔴 2026-10-03 老大定案：**示范项目不参与任何备份行为**。
 *    拦截放在**这一层**（而不是各个调用点）是因为所有备份路径 —— 每日 / 5 分钟自动 / 手动 ——
 *    都从这里过，将来新增入口也不会漏。示范项目是「创建示范项目」一键生成的演示数据、随时能重建，
 *    为它每 5 分钟存一份全量纯属浪费磁盘（还会把备份列表塞满）。
 *    ⚠️ 复制示范项目出来的副本名字不同 ⇒ 按普通项目对待，会正常备份（这是对的）。
 * @returns 备份元信息；**示范项目返回 null**（什么也没写）。
 */
export async function createAutoBackup(projectId: string, kind: BackupKind, label?: string): Promise<BackupMeta | null> {
  const proj = await getProject(projectId).catch((e) => {
    // 🔴 读失败**不能静默**（2026-10-12 全量审计 P2）：静默按「不是示范项目」继续，万一它
    //    正是示范项目，就会白写一份全量备份（还占掉一个淘汰名额）。口径同 kbInBackupOf。
    console.warn('[db] 判定是否示范项目时读项目失败，本次按普通项目备份：', e)
    return undefined
  })
  if (isDemoProjectName(proj?.name)) return null
  // 🔴 自动备份**不带**章节快照（2.4.0 · A3）：它是每 5 分钟一次的高频全量，
  //    快照随它走会把本地存储迅速撑大。要带走快照的是「手动导出备份」，那条路径走默认值。
  // 🔴 自动备份**也不带**参考资料（2.8.0 · #017）：同一条理由 —— 长文档单篇可达 40 万字，
  //    每 5 分钟重写一遍等于让数据文件持续膨胀。作者勾的「随包走」开关只作用于**手动导出**。
  const bundle = await exportProject(projectId, { includeSnapshots: false, includeKnowledgeBase: false })
  /**
   * 3.1.3 逻辑分片（主人 2026-10-18 拍板）：
   *   文字片（`textBundle`，已剔除所有 dataURL）+ 媒体片（按内容去重）。
   *   🔴 为什么要分：一份备份原本是整包 —— 30 张立绘会被 60 份备份各复制一遍；
   *      分成两片之后，**图片没变就复用同一个媒体片**，60 份备份只占一份图。
   */
  const { shards, manifest } = splitBundle(bundle)
  /**
   * 🔴 文字片必须由**分片结果**合并而来（`shards` 里图片已被剥离），
   *    不能用 `applyMediaToBundle(bundle, 空媒体片)` —— 那只是"不写回图"，
   *    原 bundle 里已经剥掉？没有：它返回的仍是原 bundle，图一张没少（实测踩过）。
   */
  const textBundle: ProjectBundle = {
    // 先铺原 bundle（保住 app / version / exportedAt 这些"包封皮"字段），再用无图分片覆盖数据部分
    ...bundle,
    ...mergeShards({ ...shards, media: { blobs: [], links: [] } }),
  }
  const now = Date.now()
  const id = uid()
  const textBytes = payloadBytes(textBundle)
  // 媒体片 id = 项目 + 「图片 ref 集合」的哈希 ⇒ 内容相同即同一片（跨备份自动复用）
  const mediaId = manifest.mediaCount > 0
    ? mediaPayloadIdOf(projectId, shards.media.blobs.map(b => b.ref))
    : undefined
  const meta: BackupMeta = {
    id,
    projectId,
    kind,
    label: label ?? (kind === 'daily' ? `每日自动备份` : `自动备份`),
    createdAt: now,
    // bytes 仍表示「恢复这份备份所需的总体积」（含图片），不是实际新增占用 —— 界面另有拆分显示
    bytes: textBytes + manifest.mediaChars,
    shards: {
      textPayloadId: id,
      ...(mediaId
        ? { mediaPayloadId: mediaId, mediaCount: manifest.mediaCount, mediaChars: manifest.mediaChars }
        : {}),
      textChars: textBytes,
    },
  }
  // 先写载荷再写元数据：元数据是「列表看得见的东西」，载荷缺失时列表会立刻暴露（而不是留一份空壳）
  await ops.put('backupPayloads', { id, projectId, kind: 'text', bundle: textBundle } satisfies BackupPayload)
  if (mediaId) {
    // 🔴 同一份图片集合已存在就**直接复用、不重写** —— 这是分片省空间的实际落点。
    //    复用判定只看 id（由内容哈希得出），不比对内容：同 id 即同图集。
    const existing = await ops.get<BackupPayload>('backupPayloads', mediaId)
    if (!existing) {
      await ops.put('backupPayloads', { id: mediaId, projectId, kind: 'media', media: shards.media } satisfies BackupPayload)
    }
  }
  await ops.put('backups', meta)
  // 滚动淘汰：超过该类型上限则删除最早的（元数据与载荷一起删，避免留下孤儿载荷）。手动备份（limit=0）不淘汰。
  const limit = backupLimit(kind)
  if (limit > 0) {
    const all = (await ops.getAll<BackupMeta>('backups'))
      .filter(b => b.projectId === projectId && b.kind === kind)
      .sort((a, b) => b.createdAt - a.createdAt)
    for (const drop of all.slice(limit)) await deleteBackup(drop.id)
  }
  return meta
}

/** 列出某项目的全部备份元数据（按时间倒序）—— **不读载荷** */
export async function listBackups(projectId: string): Promise<BackupMeta[]> {
  const all = await ops.getAll<BackupMeta | LegacyBackupRecord>('backups')
  return all
    .filter(b => b.projectId === projectId)
    .map(withBytes)
    .sort((a, b) => b.createdAt - a.createdAt)
}

// ============ 作品版本冻结（3.0 · W3-1 · §10.3 #7）============
//
// 「定稿快照」不新建表 —— 它就是一份 kind='frozen' 的备份：复用 applyBundleToProject（恢复）、
// buildBackupFile（外置导出）、deleteBackup（双表删除）。这正是 §10.3 #7「与既有备份/导出共用
// StoreOps 数据契约」的字面要求；自建一套 300 行的 id 重映射恢复逻辑纯属重复劳动。

/** 冻结一版的输入（纯数据，不含 bundle） */
export interface FrozenVersionInput {
  /** 版本名（作者可改；留空则按时间自动命名） */
  name: string
  /** 备注（可空） */
  note?: string
  /** 冻结时的作品级指纹（`bookVersion.bookFingerprint`） */
  fingerprint: string
  /** 完成检查摘要 */
  stats: FrozenStats
}

/**
 * 冻结一个作品版本（定稿快照）。
 *
 * 🔴 与 `createAutoBackup` 的三点不同：
 *   ① **带章节快照**（自动备份为省体积刻意不带）—— 定稿要能连历史版本一起还原；
 *   ② **不拦截示范项目** —— 自动备份拦截是因为「高频全量。」；冻结是作者主动动作，该允许；
 *   ③ **永不淘汰**（`backupLimit('frozen')` = 0）—— 作者主动留档不该被系统删掉。
 * 参考资料仍按作者的 `kbInBackup` 开关走（`exportProject` 默认值，不越权打包大文件）。
 */
export async function createFrozenVersion(projectId: string, input: FrozenVersionInput): Promise<BackupMeta> {
  const bundle = await exportProject(projectId)
  const now = Date.now()
  const id = uid()
  const name = input.name.trim()
  const note = input.note?.trim()
  const meta: BackupMeta = {
    id,
    projectId,
    kind: 'frozen',
    label: name || `定稿 ${new Date(now).toLocaleString('zh-CN')}`,
    createdAt: now,
    bytes: payloadBytes(bundle),
    fingerprint: input.fingerprint,
    stats: input.stats,
    ...(note ? { note } : {}),
  }
  // 先写载荷再写元数据（同 createAutoBackup：列表能立刻暴露载荷缺失，而不是留一份空壳）
  await ops.put('backupPayloads', { id, projectId, bundle } satisfies BackupPayload)
  await ops.put('backups', meta)
  return meta
}

/** 列出某项目的全部定稿版本（按时间倒序）—— **不读载荷** */
export async function listFrozenVersions(projectId: string): Promise<BackupMeta[]> {
  const all = await ops.getAll<BackupMeta | LegacyBackupRecord>('backups')
  return all
    .filter(b => b.projectId === projectId && b.kind === 'frozen')
    .map(withBytes)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 读取某份备份的载荷（恢复 / 导出单份备份时才调用）。找不到返回 undefined。
 *
 * 3.1.3：这份函数是**唯一的读取入口** —— 文字片 + 媒体片在这里拼回完整 bundle，
 * 于是 `restoreBackup` / `buildBackupFile` / 备份文件解析全都不用改（旧整包也照样能读）。
 */
export async function getBackupPayload(id: string): Promise<ProjectBundle | undefined> {
  const meta = await ops.get<BackupMeta>('backups', id)
  const refs = meta?.shards
  const textId = refs?.textPayloadId ?? id
  const p = await ops.get<BackupPayload>('backupPayloads', textId)
  if (!p) {
    // 兼容：尚未迁移的老库里，bundle 仍躺在 backups 记录里
    const legacy = await ops.get<LegacyBackupRecord>('backups', id)
    return legacy?.bundle
  }
  // 旧形态整包（kind 缺省或 'full'）
  if (p.kind !== 'text') return p.bundle
  if (!p.bundle) return undefined
  if (!refs?.mediaPayloadId) return p.bundle
  const mediaRec = await ops.get<BackupPayload>('backupPayloads', refs.mediaPayloadId)
  // 媒体片丢了：**文字照常恢复**（图片缺省）—— 这比"整份备份都恢复不了"对作者更有用
  if (!mediaRec?.media) return p.bundle
  return applyMediaToBundle(p.bundle, mediaRec.media as MediaShard)
}

/**
 * 媒体片的引用检查：没有别的备份还在用它，才可以删。
 * 低频操作（只在删备份 / 清理孤儿时跑），直接扫一遍元数据即可。
 */
async function gcMediaPayload(mediaId: string): Promise<void> {
  try {
    const metas = await ops.getAll<BackupMeta>('backups')
    if (metas.some(m => m.shards?.mediaPayloadId === mediaId)) return
    await ops.del('backupPayloads', mediaId)
  } catch (e) {
    // 清理失败不致命：只留下一个无人引用的媒体片，下次清理会再扫到
    console.warn('[db] 清理媒体片失败（不影响本次删除）：', e)
  }
}


/**
 * 删除一份备份：**元数据与载荷一起删**（只删一边就是孤儿载荷，白占空间）。
 *
 * 🔴 顺序必须是**先载荷、后元数据**（2026-10-11 反转，原为元数据在前）：
 *    创建时是「先载荷、后元数据」（见 createAutoBackup 的注释：元数据是看得见的东西，
 *    载荷缺失会在列表里立刻暴露）。删除应当与之**对称地反过来** —— 若中途被打断：
 *      · 先删载荷 ⇒ 元数据还在 ⇒ 列表里躺着一条「恢复不了」的备份，**看得见**，作者能处理；
 *      · 先删元数据（旧写法）⇒ 载荷文件留在磁盘上、列表里却**没有任何痕迹**
 *        ⇒ 静默占着空间，且没有任何入口能再找到它（真正的孤儿）。
 *    在载荷还是整库 JSON 里的一行时，这个差别无足轻重；挪成独立文件后就成了磁盘垃圾。
 */
export async function deleteBackup(id: string) {
  const meta = await ops.get<BackupMeta>('backups', id)
  const textId = meta?.shards?.textPayloadId ?? id
  const mediaId = meta?.shards?.mediaPayloadId
  await ops.del('backupPayloads', textId)
  await ops.del('backups', id)
  // 3.1.3：媒体片可能被其他备份共用 ⇒ 删完元数据后再确认一次"确实没人引用了"才删
  if (mediaId) await gcMediaPayload(mediaId)
}

/** 孤儿备份：备份记录存在但其项目已被删除（删除项目时按约定保留备份，导致此类记录积累） */
export async function listOrphanBackups(): Promise<BackupMeta[]> {
  const [all, projs] = await Promise.all([ops.getAll<BackupMeta | LegacyBackupRecord>('backups'), ops.getAll<{ id: string }>('projects')])
  const pids = new Set(projs.map(p => p.id))
  return all.filter(b => !pids.has(b.projectId)).map(withBytes).sort((a, b) => b.createdAt - a.createdAt)
}

/** 删除全部孤儿备份，返回删除条数 */
export async function deleteOrphanBackups(): Promise<number> {
  const orphans = await listOrphanBackups()
  for (const o of orphans) await deleteBackup(o.id)
  return orphans.length
}

/**
 * 孤儿**载荷**判定（纯函数，可单测）：磁盘上有文件、但列表里已没有任何备份引用它。
 *
 * 🔴 为什么会有孤儿：创建备份是「先写载荷、后写元数据」（见 createAutoBackup 的注释）。
 *    若两步之间被打断（断电、U 盘拔插、服务中断），载荷文件留下了而元数据没写进去
 *    ⇒ 列表里**没有任何痕迹**，却实打实占着磁盘，且没有任何入口能再找到它。
 *    删除路径已修正为先删载荷（见 deleteBackup），故孤儿只剩这一条来源。
 *
 * 🔴 3.1.3 起 `referencedIds` **不再只是 meta.id**：分片后一份备份可能引用
 *    `textPayloadId` 与共享的 `mediaPayloadId`（一个媒体片被多份备份共用）。
 *    只拿 meta.id 比对会把媒体片全部误判成孤儿 —— 那等于把别人的图片删了。
 *
 * @param payloadIds     磁盘上实际存在的载荷 id
 * @param referencedIds  所有备份引用到的载荷 id（meta.id + 各片 id）
 */
export function orphanPayloadIdsOf(payloadIds: string[], referencedIds: string[]): string[] {
  const known = new Set((referencedIds ?? []).map(String))
  return (payloadIds ?? []).map(String).filter(id => !known.has(id))
}

/** 一份备份元数据引用到的全部载荷 id（旧整包=自身 id；分片=文字片 + 可选媒体片） */
export function referencedPayloadIdsOf(meta: BackupMeta | LegacyBackupRecord): string[] {
  const shards = (meta as BackupMeta).shards
  return [
    String(meta.id),
    ...(shards?.textPayloadId ? [shards.textPayloadId] : []),
    ...(shards?.mediaPayloadId ? [shards.mediaPayloadId] : []),
  ]
}

/**
 * 列出孤儿载荷 id（磁盘有、列表无）。
 * 🔴 只**列出**不删除：这些文件可能是作者手动放进去的、也可能是迁移中断的残留，
 *    删错了不可逆 —— 交给作者在界面上确认后再清（与「清理孤儿备份」同一条交互口径）。
 */
export async function listOrphanPayloadIds(): Promise<string[]> {
  const api = currentSidecarApi()
  if (!api) return [] // 无外置通道（纯浏览器 dev / 尚未接入）⇒ 不存在孤儿一说
  const [ids, metas] = await Promise.all([
    api.listIds('backupPayloads').catch(() => [] as string[]),
    ops.getAll<BackupMeta | LegacyBackupRecord>('backups').catch(() => [] as BackupMeta[]),
  ])
  return orphanPayloadIdsOf(ids, metas.flatMap(m => referencedPayloadIdsOf(m)))
}

/** 删除全部孤儿载荷，返回删除条数 */
export async function deleteOrphanPayloads(): Promise<number> {
  const ids = await listOrphanPayloadIds()
  for (const id of ids) await ops.del('backupPayloads', id)
  return ids.length
}

/**
 * 将一份项目数据包「覆盖写回」到目标项目（恢复历史版本用）。
 * 保留目标项目 id，但用备份包的内容替换其全部数据（卷/章/表/卡/表单/统计/设置），
 * 并将书名、封面、类型、简介同步为备份当时的快照。
 */
export async function restoreBackup(id: string): Promise<void> {
  const rec = await ops.get<BackupMeta>('backups', id)
  if (!rec) throw new Error('备份不存在')
  const bundle = await getBackupPayload(id)
  // 元数据还在、载荷没了（被外部清理过 / 写到一半断电）：必须明确报错，不能"恢复成功"却什么都没恢复
  if (!bundle) throw new Error('这份备份的数据已经找不到了（元数据仍在，载荷缺失），无法恢复')
  await applyBundleToProject(rec.projectId, bundle)
}

// ============ 备份外置（C2 · 2.4.2）============
//
// 目的：自动备份只活在软件自己的数据文件里（本机、单点）。把某一份备份**导成磁盘上的独立文件**，
// 就能丢进云盘 / 移动硬盘，换机或数据文件损坏时还有一条独立退路。
// ⚠️ 与「迁移包」的分工：迁移包导的是**当前项目**（用于换机搬运）；备份文件导的是**某一份历史备份**。

/** 备份外置文件的格式标记（解析时据此识别，避免把迁移包当备份文件吃进来） */
const BACKUP_FILE_KIND = 'yfe-backup'
export const BACKUP_FILE_VERSION = 1

export interface BackupFile {
  kind: typeof BACKUP_FILE_KIND
  version: number
  exportedAt: number
  meta: Omit<BackupMeta, 'bytes'>
  bundle: ProjectBundle
}

/** 把某份备份打包成外置文件的内容（含元数据 + 载荷）。备份或载荷缺失时返回 null。 */
export async function buildBackupFile(id: string): Promise<{ filename: string; content: string } | null> {
  const rec = await ops.get<BackupMeta>('backups', id)
  const bundle = await getBackupPayload(id)
  if (!rec || !bundle) return null
  const file: BackupFile = {
    kind: BACKUP_FILE_KIND,
    version: BACKUP_FILE_VERSION,
    exportedAt: Date.now(),
    meta: { id: rec.id, projectId: rec.projectId, kind: rec.kind, label: rec.label, createdAt: rec.createdAt },
    bundle,
  }
  const stamp = new Date(rec.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const name = bundle.project?.name ?? '未命名'
  return { filename: `青春幻想引擎-备份-${name}-${stamp}.json`, content: JSON.stringify(file, null, 2) }
}

/** 解析外置备份文件；格式不符（如迁移包）抛出可读错误。 */
export function parseBackupFile(text: string): BackupFile {
  const parsed = JSON.parse(text) as Partial<BackupFile> & { project?: unknown }
  if (parsed?.kind !== BACKUP_FILE_KIND || !parsed.bundle?.project) {
    throw new Error('这不是备份文件（可能选到了迁移包 —— 迁移包请用「导入迁移包」）')
  }
  return parsed as BackupFile
}

/** 把外置备份文件里的数据包覆盖写回**当前项目**（file 恢复入口用；区别于导入迁移包=新建项目） */
export async function restoreBundleToProject(projectId: string, bundle: ProjectBundle): Promise<void> {
  await applyBundleToProject(projectId, bundle)
}

async function applyBundleToProject(targetPid: string, bundle: ProjectBundle): Promise<void> {
  // 1. 收集该项目现有的键 —— ⚠️ 只收集，**先不删**。
  //    🔴 旧实现是「先清空、再写回」：写到一半失败（配额满、断网、用户关窗），
  //    项目就变半空且无从恢复。改成「先写后删」之后，任一步失败最多留下些
  //    可以再清理的多余记录 —— **原数据自始至终完好**。
  const delKeys: Record<string, string[]> = {}
  /**
   * 🔴 只收集**备份确实覆盖到**的存储（2026-10-17 全量审计 P2）：
   *   · `trash`（回收站）导出时**从不带上**（`exportProject` 不含它），旧实现却把它列进 delKeys
   *     ⇒ 恢复一次备份 = 把回收站里所有可恢复章节**永久删除**；
   *   · `tavernReports` / `aiRuns` 是**可选字段**（老备份没有），备份没带时应保留现有记录，
   *     否则用 2.x 备份恢复会连带删掉 3.x 的 AI 账本。
   *   口径与下方「不删快照」完全一致：**恢复备份 = 还原备份里的内容，不是把备份没覆盖的也清掉**。
   */
  const covered = ['volumes', 'chapters', 'tableRows', 'cardRecords'] as const
  for (const name of covered) {
    const all = await ops.getAll<{ id: string; projectId?: string }>(name)
    const keys = all.filter(r => r.projectId === targetPid).map(r => r.id)
    if (keys.length) delKeys[name] = keys
  }
  if (bundle.tavernReports) {
    const all = await ops.getAll<{ id: string; projectId?: string }>('tavernReports')
    const keys = all.filter(r => r.projectId === targetPid).map(r => r.id)
    if (keys.length) delKeys.tavernReports = keys
  }
  if (bundle.aiRuns) {
    const all = await ops.getAll<{ id: string; projectId?: string }>('aiRuns')
    const keys = all.filter(r => r.projectId === targetPid).map(r => r.id)
    if (keys.length) delKeys.aiRuns = keys
  }
  const prefix = `${targetPid}::`
  const forms = await ops.getAll<FormData>('formData')
  const formKeys = forms.filter(f => f.tabId.startsWith(prefix)).map(f => f.tabId)
  // 快照**不参与**恢复流程（见下方「不删快照」的说明）—— 此处刻意不收集 snapKeys
  const statKeys: string[] = []
  const setKeys: string[] = []
  const daily = await ops.getAll<{ key: string }>('dailyStats')
  for (const r of daily) if (r.key.startsWith(prefix)) statKeys.push(r.key)
  const settings = await ops.getAll<{ key: string }>('settingsKV')
  for (const r of settings) {
    if (r.key.startsWith(prefix)) setKeys.push(r.key)
    // 自定义下拉选项 key 形如 customOption::<pid>::…，需用专属前缀清理，否则恢复会残留旧项目选项
    else if (r.key.startsWith(`customOption::${targetPid}::`)) setKeys.push(r.key)
  }
  // 2. 写入备份包数据（内部 id 全部重生成，避免与残留/冲突）
  const volMap = new Map<string, string>()
  for (const v of bundle.volumes) {
    const nid = uid()
    volMap.set(v.id, nid)
    await ops.put('volumes', { ...v, id: nid, projectId: targetPid })
  }
  const chMap = new Map<string, string>()
  for (const c of bundle.chapters) {
    const nid = uid()
    chMap.set(c.id, nid)
    await ops.put('chapters', { ...c, id: nid, projectId: targetPid, volumeId: volMap.get(c.volumeId) ?? c.volumeId })
  }
  for (const f of bundle.formData) {
    await ops.put('formData', { tabId: `${targetPid}::${f.tabId}`, data: f.data })
  }
  for (const r of bundle.tableRows) {
    const m = r.id.match(/^ch-(.+)$/)
    const nid = m && chMap.has(m[1]) ? `ch-${chMap.get(m[1])}` : uid()
    // 卷台账行的 tabId 内嵌卷 id（chapter-vol-<volumeId>），须随新卷 id 重映射，
    // 否则恢复后台账行指向不存在的卷，卷台账数据全部丢失（与 importProject 的写法一致）
    const rawTab = String(r.tabId)
    const tabId = rawTab.startsWith(VOL_LEDGER_PREFIX)
      ? `${VOL_LEDGER_PREFIX}${volMap.get(rawTab.slice(VOL_LEDGER_PREFIX.length)) ?? rawTab.slice(VOL_LEDGER_PREFIX.length)}`
      : r.tabId
    await ops.put('tableRows', { ...r, id: nid, tabId, projectId: targetPid })
  }
  // 🔴 与 importProject 同：cardRecords 换 id 后，settingsKV 里的子项活跃态数组必须跟着重映射，
  //    否则恢复备份后所有多套条目集体退化为「已完结」、AI 一条都读不到（2026-10-02 六维审计 P0）。
  const cardIdMap = new Map<string, string>()
  for (const r of bundle.cardRecords) {
    const nid = uid()
    cardIdMap.set(r.id, nid)
    await ops.put('cardRecords', { ...r, id: nid, projectId: targetPid })
  }
  if (bundle.dailyStats) {
    for (const s of bundle.dailyStats) {
      await ops.put('dailyStats', { ...s, key: `${targetPid}::${s.date}`, projectId: targetPid })
    }
  }
  if (bundle.settings) {
    for (const s of bundle.settings) {
      await ops.put('settingsKV', { key: `${targetPid}::${s.key}`, value: remapSettingValue(s.key, s.value, cardIdMap) })
    }
  }
  if (bundle.customOptions) {
    for (const s of bundle.customOptions) {
      await ops.put('settingsKV', { key: `customOption::${targetPid}::${s.key}`, value: s.value })
    }
  }
  // 酒馆模式报告：随备份一并恢复（换新 id；sessionId 不需重映射，理由同 importProject）
  if (bundle.tavernReports) {
    for (const r of bundle.tavernReports) {
      await ops.put('tavernReports', { ...r, id: uid(), projectId: targetPid })
    }
  }
  // AI 运行账本：随备份一并恢复（换新 id；理由同 importProject）
  if (bundle.aiRuns) {
    for (const r of bundle.aiRuns) {
      await ops.put('aiRuns', { ...r, id: uid(), projectId: targetPid })
    }
  }

  // 3. 写入已全部成功 —— 这才删除旧记录。
  //    ⚠️ 以 key 为标识的存储（formData / settingsKV / dailyStats）新旧键**可能同名**：
  //       同名时上面的 put 已就地覆盖，无需再删；若不过滤掉它们，会把刚写好的新数据一起删掉。
  const newFormKeys = new Set(bundle.formData.map(f => `${targetPid}::${f.tabId}`))
  const newStatKeys = new Set((bundle.dailyStats ?? []).map(s => `${targetPid}::${s.date}`))
  const newSetKeys = new Set<string>([
    ...(bundle.settings ?? []).map(s => `${targetPid}::${s.key}`),
    ...(bundle.customOptions ?? []).map(s => `customOption::${targetPid}::${s.key}`),
  ])
  for (const [name, keys] of Object.entries(delKeys)) await ops.bulkDel(name, keys)
  const staleForms = formKeys.filter(k => !newFormKeys.has(k))
  if (staleForms.length) await ops.bulkDel('formData', staleForms)
  // 🔴🔴 2026-09-22 六维审计 P1：**不删快照**（原来这里是 `if (snapKeys.length) bulkDel('snapshots', snapKeys)`）。
  //    三条事实叠起来就是"恢复一次备份 = 时光机被清空且永不复原"：
  //      ① 本函数上面的写入段只恢复 volumes/chapters/formData/tableRows/cardRecords，**没有任何快照写入**；
  //      ② 自动备份恒定 `includeSnapshots:false`（A3 的决策：自动备份不带快照），故 bundle 里本来就没有快照；
  //      ③ 这行是**无条件全删** —— 对比相邻的 dailyStats / settingsKV 都用 `stale* = 差集`，
  //         只有快照这一行是"全删"，明显不对称。
  //    「恢复备份」的语义是"把备份里的内容还原"，不是"把备份没覆盖的也一并清掉"。
  //    （手动导出包带快照时走 `importProject`，那条路会按新 chapterId 重映射写入，不受此处影响。）
  const staleStats = statKeys.filter(k => !newStatKeys.has(k))
  if (staleStats.length) await ops.bulkDel('dailyStats', staleStats)
  const staleSets = setKeys.filter(k => !newSetKeys.has(k))
  if (staleSets.length) await ops.bulkDel('settingsKV', staleSets)

  // 3.5 参考资料（2.8.0 · #017，可选字段）。
  // 🔴 **只在 bundle 真的带了资料时才动**：没开开关的备份里根本没有这个字段，
  //    若无条件清空，会把作者现有资料清干净 ——「恢复备份」的语义是"把备份里的内容还原"，
  //    不是"把备份没覆盖的也一并清掉"（与上面「不删快照」那条同口径）。
  // ⚠️ 成功/失败都不影响本次恢复的成败判定：它在独立库里，写不进去也只是资料没跟着回来。
  if (bundle.knowledgeBase) {
    await restoreDocsFromBundle(targetPid, bundle.knowledgeBase).catch((e) => {
      // 🔴 2026-10-10 六维审计 P2：原先 `.catch(() => 0)` 无声吞错 —— 与上一段注释
      //    「成功/失败都不影响本次恢复的成败判定」并不矛盾：不影响**成败判定**，
      //    但必须留日志，否则作者只会看到"恢复成功但资料没回来"。
      console.warn('[db] 恢复备份时写回参考资料失败（备份已恢复，仅资料未随包回来）：', e)
      return 0
    })
  }

  // 4. 同步项目元数据（成为该历史版本）
  const old = await ops.get<Project>('projects', targetPid)
  if (old) {
    await ops.put('projects', {
      ...old,
      name: bundle.project.name,
      genre: bundle.project.genre ?? '',
      intro: bundle.project.intro ?? '',
      ...(bundle.project.cover !== undefined ? { cover: bundle.project.cover } : {}),
      updatedAt: Date.now(),
    })
  }
  await touchProject(targetPid)
}
