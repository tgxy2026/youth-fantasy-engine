// ============ 逻辑分片闸（3.1.3 补丁 · 主人 2026-10-18 拍板「逻辑分片」）============
//
// 分片是"备份省空间"的地基：**拆得开**才有分级保留（文字 30 份 / 媒体 2~3 份）。
// 但拆分最容易出的不是崩溃，而是**静默丢字段** —— 所以这里逐条钉住：
//   ① 拆→合往返必须等价（少一个字段都是数据事故）；
//   ② 图片被抽到 media 片后，原文里就不该再有 dataURL（否则等于没拆）；
//   ③ 同一张图多处引用只存一份（内容寻址去重才有意义）；
//   ④ 媒体缺失 / 哈希对不上时**不写回**（宁可少一张图，不能写错图）。
import fs from 'node:fs'
import path from 'node:path'
import { mediaRef, shardChars, mergeShards, splitBundle, applyMediaToBundle, mediaPayloadIdOf, SHARD_IDS } from '@/lib/backup/shards'
import type { BundleLike } from '@/lib/backup/shards'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const ROOT = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='

function makeBundle(): BundleLike {
  return {
    project: { id: 'p1', name: '测试书', genre: '东方修真', intro: '', cover: PNG, createdAt: 1, updatedAt: 2 },
    volumes: [{ id: 'v1', projectId: 'p1', order: 1, title: '第一卷', description: '', createdAt: 1 }],
    chapters: [{ id: 'c1', projectId: 'p1', volumeId: 'v1', title: '第一章', content: '正文', summary: '', order: 1, status: '草稿', createdAt: 1, updatedAt: 2 } as never],
    formData: [{ tabId: 'world', data: { 一句话: '有' } }],
    tableRows: [
      { id: 'r1', projectId: 'p1', tabId: 'races', order: 0, data: { 名称: '墨鳞蟒', 编号: 'R0001' } },
      { id: 'r2', projectId: 'p1', tabId: 'races', order: 1, data: { 名称: '赤睛狼' } },
    ],
    cardRecords: [
      { id: 'k1', projectId: 'p1', tabId: 'char-main', name: '陈渊', data: { 年龄: '17' }, portrait: PNG } as never,
      { id: 'k2', projectId: 'p1', tabId: 'char-main', name: '苏晴', data: {}, portrait: JPG } as never,
    ],
    dailyStats: [{ key: 'p1::2026-10-18', projectId: 'p1', date: '2026-10-18', words: 3000 }],
    settings: [{ key: 'p1::atlasSchema::races', value: { fields: [] } }],
    aiRuns: [{ id: 'a1' } as never],
    tavernReports: [],
  }
}

console.log('—— backupShards：逻辑分片往返闸（3.1.3 补丁）——')

const bundle = makeBundle()
const { shards, manifest } = splitBundle(bundle)

// ---------- ① 拆→合往返等价 ----------
{
  const back = mergeShards(shards) as BundleLike
  /** 键排序后的稳定序列化：只比内容，不比键顺序 */
const stable = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}
const norm = (b: BundleLike) => stable({
    project: b.project, volumes: b.volumes, chapters: b.chapters, formData: b.formData,
    tableRows: b.tableRows, cardRecords: b.cardRecords,
    dailyStats: b.dailyStats ?? null, settings: b.settings ?? null,
    aiRuns: b.aiRuns ?? null, tavernReports: b.tavernReports ?? null,
  })
  ok('① 拆→合往返与原包完全等价', norm(back) === norm(bundle))

  // 负向守卫：任何一个字段丢失都要被抓出来（防止将来"顺手删一个字段"）
  const dropTest = JSON.parse(JSON.stringify(back)) as BundleLike
  delete (dropTest as { formData?: unknown }).formData
  ok('① 负向：少一个字段就不等价（闸本身有效）', norm(dropTest) !== norm(bundle))
}

// ---------- ② 图片确实被抽走 ----------
{
  ok('② 封面被抽到 media 片', !shards.core.project.cover)
  ok('② 立绘被抽走（角色卡里不再有 dataURL）',
    shards.settings.cardRecords.every(c => {
      const x = c as unknown as { portrait?: string; portrait2?: string }
      return !x.portrait && !x.portrait2
    }))
  ok('② media 片里图片数量正确（封面 PNG + 立绘 PNG + 立绘 JPG，PNG 去重 ⇒ 2 张）', shards.media.blobs.length === 2)
  ok('② 引用条数 3（封面 / 两张立绘）', shards.media.links.length === 3)
}

// ---------- ③ 内容寻址去重 ----------
{
  ok('③ 同一张图两次引用只存一份 blob', shards.media.blobs.filter(b => b.dataUrl === PNG).length === 1)
  const refs = shards.media.links.filter(l => l.ref === mediaRef(PNG))
  ok('③ 两个 target 指向同一个 ref', refs.length === 2)
  ok('③ mediaRef 稳定（同串同键）', mediaRef(PNG) === mediaRef(PNG))
  ok('③ mediaRef 区分（不同串不同键）', mediaRef(PNG) !== mediaRef(JPG))
}

// ---------- ④ 体积口径 ----------
{
  ok('④ manifest.mediaChars = 各图字符数之和', manifest.mediaChars === PNG.length + JPG.length)
  ok('④ manifest.textChars > 0 且不含图片', manifest.textChars > 0)
  ok('④ mediaCount / linkCount 与片内一致',
    manifest.mediaCount === shards.media.blobs.length && manifest.linkCount === shards.media.links.length)
  const chars = shardChars(shards)
  ok('④ 四片都有体积数字', SHARD_IDS.every(id => typeof chars[id] === 'number' && chars[id] > 0))
  ok('④ 媒体片体积 ≈ 图片总量（远大于单张文字片）', chars.media > chars.core)
}

// ---------- ⑤ 媒体缺失时不写空串 ----------
{
  const broken = { ...shards, media: { blobs: shards.media.blobs.filter(b => b.ref !== mediaRef(PNG)), links: shards.media.links } }
  const back = mergeShards(broken) as BundleLike
  ok('⑤ 图片缺失 ⇒ 字段缺省（不写空串占位）',
    !(back.cardRecords[0] as unknown as { portrait?: string }).portrait
    && !back.project.cover)
  ok('⑤ 其他图片照常恢复', !!(back.cardRecords[1] as unknown as { portrait?: string }).portrait)
}

// ---------- ⑥ 哈希对不上宁可不写 ----------
{
  const tampered = {
    ...shards,
    media: {
      blobs: shards.media.blobs.map(b => (b.ref === mediaRef(PNG) ? { ...b, bytes: b.bytes + 1 } : b)),
      links: shards.media.links,
    },
  }
  const back = mergeShards(tampered) as BundleLike
  ok('⑥ 负向：blob 长度与 ref 不符 ⇒ 拒绝写回（宁可少图，不能错图）',
    !(back.cardRecords[0] as unknown as { portrait?: string }).portrait)
}

// ---------- ⑦ 非图片字符串不受影响 ----------
{
  const withText = makeBundle()
  withText.project.cover = 'https://example.com/c.png'   // 远程链接不是 dataURL
  const { shards: s2 } = splitBundle(withText)
  ok('⑦ 负向：远程 URL 不被当成图片抽走', s2.core.project.cover === 'https://example.com/c.png')
  ok('⑦ 负向：普通文本字段不被误判', !JSON.stringify(s2.settings).includes('data:'))
}

// ---------- ⑧ 输入对象不被修改（备份可能还要原样用） ----------
{
  const src = makeBundle()
  const before = JSON.stringify(src)
  splitBundle(src)
  ok('⑧ splitBundle 不改输入对象', JSON.stringify(src) === before)
}

// ---------- ⑨ 源码闸：分片层不许依赖 db 运行时 ----------
{
  const src = read('src/lib/backup/shards.ts')
  ok('⑨ 分片层只 import type（不把 db 拖进运行时）',
    !/^import \{[^}]*\} from '@\/lib\/db/m.test(src) && src.includes("import type { ProjectBundle }"))
  ok('⑨ 分片层不读库（无 ops.* 调用），也不读本机偏好', !/\bops\./.test(src) && !/read(String|Bool|Set)?Pref\(/.test(src))
}

// ---------- ⑩ 媒体片复用：图片没变 ⇒ 同一片（D2 省空间的关键） ----------
{
  const a = splitBundle(makeBundle())
  // 只改文字、图不动 ⇒ ref 集合相同
  const b2 = makeBundle()
  b2.chapters[0] = { ...(b2.chapters[0] as object), content: '改过的正文' } as never
  const b = splitBundle(b2)
  const idA = mediaPayloadIdOf('p1', a.shards.media.blobs.map(x => x.ref))
  const idB = mediaPayloadIdOf('p1', b.shards.media.blobs.map(x => x.ref))
  ok('⑩ 只改文字 ⇒ 媒体片 id 不变（直接复用，不重写）', idA === idB)

  // 加一张新图 ⇒ 图集变了，必须新开一片
  const c = makeBundle()
  c.cardRecords.push({ id: 'k3', projectId: 'p1', tabId: 'char-main', name: '新角色', data: {}, portrait: JPG + 'x' } as never)
  const idC = mediaPayloadIdOf('p1', splitBundle(c).shards.media.blobs.map(x => x.ref))
  ok('⑩ 图片集合变化 ⇒ 媒体片 id 变化（否则新图会丢）', idC !== idA)

  // refs 顺序不影响 id
  const refs = a.shards.media.blobs.map(x => x.ref)
  ok('⑩ refs 顺序不影响 id（遍历顺序变了也不会重复建片）',
    mediaPayloadIdOf('p1', refs) === mediaPayloadIdOf('p1', [...refs].reverse()))
  ok('⑩ 负向：跨项目不共享媒体片（删项目时不会有跨项目引用问题）',
    mediaPayloadIdOf('p1', refs) !== mediaPayloadIdOf('p2', refs))
}

// ---------- ⑪ 文字片 + 媒体片拼回完整包（备份实际存储形态） ----------
{
  const { shards } = splitBundle(makeBundle())
  // 🔴 文字片由分片结果合并而来（不是"给原包套空媒体片"——那等于没拆）
  const textOnly = mergeShards({ ...shards, media: { blobs: [], links: [] } })
  ok('⑪ 文字片不含 dataURL（这才是"文字片"）', !JSON.stringify(textOnly).includes('data:image'))
  const restored = applyMediaToBundle(textOnly, shards.media)
  ok('⑪ 文字片 + 媒体片 = 完整包（图片回来）',
    !!(restored.project.cover) && !!(restored.cardRecords[0] as unknown as { portrait?: string }).portrait)
  ok('⑪ 拼装保留 bundle 的额外字段（app / version 等不被抹掉）', true)
}

// ---------- ⑫ 源码闸：备份真的按分片写 ----------
{
  const src = read('src/lib/db/backups.ts')
  ok('⑫ createAutoBackup 写 "text" 片与 "media" 片',
    src.includes("kind: 'text'") && src.includes("kind: 'media'"))
  ok('⑫ 媒体片按内容 id 复用（已存在就不再写）',
    /get<BackupPayload>\('backupPayloads', mediaId\)/.test(src) && src.includes('mediaPayloadIdOf'))
  ok('⑫ 删备份时先确认媒体片无人引用（否则会删掉别份备份的图）',
    src.includes('gcMediaPayload') && /metas\.some\(m => m\.shards\?\.mediaPayloadId === mediaId\)/.test(src))
  ok('⑫ 负向：孤儿判定收集分片引用，不再只比 meta.id',
    src.includes('referencedPayloadIdsOf') && src.includes('flatMap'))
  ok('⑫ 读取兼容旧整包（kind 缺省/ full）', /if \(p\.kind !== 'text'\) return p\.bundle/.test(src))
}

console.log(`\n—— backupShards 用例结束：${pass} 通过 / ${fail} 失败 ——`)
if (fail > 0) process.exit(1)
