/**
 * ��机复现脚本（手动运行，不进全量回归）：社区反馈「创意写作只写 1 章，AI 却把第 2 章细纲的内容也写了」。
 *
 * 跑法：node tests/build-test.mjs live-creative-scope
 *   - 走**线上模型**：默认从**应用自己的模型配置**读（`%APPDATA%/youth-fantasy-engine/youth-fantasy-engine-data.json`，
 *     取 baseUrl 含 `api.deepseek.com` 的那条 = DeepSeek 官方）；密钥不落 Git、不进对话。
 *     · `REPRO_PROVIDER` 换 baseUrl 关键字（如 `openai.com`）· `REPRO_MODEL` 过滤模型名 · `REPRO_ROUNDS` 轮数
 *     · 也可放 `.workbuddy/tmp/live-providers.json`（AIProvider[]）覆盖，优先级最高
 *   - 造场景：一卷 5 章细纲，**只让 AI 写第 1 章**（chapters: 1）
 *   - 判据：第 2 章细纲里的**专属标记词**（黑石巷 / 血魔教分坛 / 那封师兄的信）有没有出现在第 1 章正文里
 *
 * ⚠️ 判据设计要点：标记词必须是**只在第 2 章细纲出现**的专名，
 *    否则「世界观里本来就提到血魔教」会造成误报。
 */
import fs from 'node:fs'
import path from 'node:path'
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { runCreativeWriting } from '../src/lib/ai/aiWorkflow'
import { resolveSlot } from '../src/lib/flow/fieldMap'
import { saveProviders, saveActiveId, type AIProvider } from '../src/lib/ai'

const APP_DATA = path.join(process.env.APPDATA || '', 'youth-fantasy-engine', 'youth-fantasy-engine-data.json')
const OVERRIDE_FILE = path.join(process.cwd(), '.workbuddy/tmp/live-providers.json')
const ROUNDS = Number(process.env.REPRO_ROUNDS || 3)

/**
 * 取「线上模型」配置：
 *   ① 有 `.workbuddy/tmp/live-providers.json` 就用它（AIProvider[]，覆盖用）；
 *   ② 否则读应用数据文件里 `stores.meta.aiProviders`，按 `REPRO_PROVIDER`（默认 `api.deepseek.com`）过滤 baseUrl。
 * 🔴 密钥只在本机读取、只随请求发出，不写进任何产出文件、不进 Git。
 */
function loadOnlineProviders(): AIProvider[] {
  if (fs.existsSync(OVERRIDE_FILE)) {
    return JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8')) as AIProvider[]
  }
  if (!fs.existsSync(APP_DATA)) {
    throw new Error(`读不到应用数据文件：${APP_DATA}\n（先在应用「模型设置 → 模型配置」里配好线上模型）`)
  }
  const meta = ((JSON.parse(fs.readFileSync(APP_DATA, 'utf8')).stores || {}).meta || {}) as Record<string, unknown>
  const unwrap = (k: string) => {
    const v = meta[k]
    return v && typeof v === 'object' && 'value' in v ? (v as { value: unknown }).value : v
  }
  const all = (unwrap('aiProviders') || []) as AIProvider[]
  const key = process.env.REPRO_PROVIDER || 'api.deepseek.com'
  const use = all.filter(p => (p.baseUrl || '').includes(key))
  if (!use.length) {
    throw new Error(`应用配置里没有 baseUrl 含「${key}」的模型 —— 可用 REPRO_PROVIDER 指定其它关键字`)
  }
  return use
}

/** 第 2 章细纲的专属标记（只出现在第 2 章，绝不出现在第 1 章或世界观里） */
const CH2_MARKERS = ['黑石巷', '血魔教分坛', '师兄的信', '密室铜镜']
/** 第 1 章细纲的标记（对照组：应当在正文里出现） */
const CH1_MARKERS = ['青槐树', '药铺', '瘸腿老乞儿']

function slot(field: string): string {
  return resolveSlot('chapter-outline', field) ?? field
}

/** 造一个「一卷 5 章细纲」的项目 */
async function seedProject(): Promise<void> {
  const p = await db.createProject('复现用项目 · 越界测试', '东方修真', '测试', '', 'full')
  db.setCurrentProject(p.id)
  await db.saveVolume({ id: 'vol1', projectId: p.id, title: '第一卷 风起云州', order: 0 } as never)

  // 卷大纲卡（hasOutline 判据只看「有卡」，内容会被 buildChapterVolumeIndex 读）
  await db.saveCardRecord({
    id: 'v1', projectId: p.id, tabId: 'volume-outline', name: '第一卷 风起云州', order: 0,
    data: {
      [resolveSlot('volume-outline', '本卷章号范围') ?? '本卷章号范围']: '第1章 ~ 第5章',
      [resolveSlot('volume-outline', '本卷章数预估') ?? '本卷章数预估']: '5',
    } as Record<string, string>,
  })

  // 5 章细纲：每章的「事件 / 场景1 / 章末钩子」都不同，第 2 章塞满专属标记
  const plans: { no: number; ev: string; sc: string; hook: string }[] = [
    { no: 1, ev: '陈渊去云州集市采买补气丹', sc: '在青槐树下撞见瘸腿老乞儿，对方塞给他一枚残破铜片', hook: '铜片背面浮出一行血字' },
    { no: 2, ev: '潜入血魔教分坛窃取密室铜镜', sc: '夜探黑石巷深处，发现师兄的那封信已被调包', hook: '信上署名竟是自己' },
    { no: 3, ev: '外门大比夺魁', sc: '一招惊全场', hook: '执事神色有异' },
    { no: 4, ev: '藏经阁得残简', sc: '夜入藏经阁', hook: '残简与铜片同源' },
    { no: 5, ev: '南荒道夜袭', sc: '截杀血魔教暗桩', hook: '血光冲天' },
  ]
  for (const pl of plans) {
    await db.saveCardRecord({
      id: `c${pl.no}`, projectId: p.id, tabId: 'chapter-outline', name: `第${pl.no}章`, order: pl.no - 1,
      data: {
        [slot('本章功能')]: '推进主线',
        [slot('本章一句话事件')]: pl.ev,
        [slot('场景1')]: pl.sc,
        [slot('场景2')]: '',
        [slot('场景3')]: '',
        [slot('章末钩子')]: pl.hook,
      } as Record<string, string>,
    })
  }
}

async function runOnce(p: AIProvider, round: number): Promise<void> {
  const tag = `${p.model} #${round}`
  __resetMockStores()
  await seedProject()
  await saveProviders([{ ...p, id: 'live-online', name: p.name || 'live-online' }])
  await saveActiveId('live-online')

  const t0 = Date.now()
  const res = await runCreativeWriting(
    { seed: '一个被测出废脉的少年，靠吞噬他人修为续命', intent: '' },
    {
      target: 'draft', chapters: 1, volumes: 1, chaptersPerVolume: 5,
      targetWords: 2500,
      onRunLog: (l: string) => console.log(`   [${tag}] ${l}`),
      onChapterSaved: ch => console.log(`   [${tag}] 已落库：第${ch.no}章「${ch.title}」`),
    },
  )
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  // 🔴 onChapterSaved 只带 {id,title,no}，正文得**从库里读**（第一版脚本读错字段，误判成「0 字」）
  const all = await db.getAllChapters()
  const last = all.sort((a, b) => a.order - b.order).slice(-1)[0]
  const title = last?.title ?? ''
  const body = last?.content ?? ''
  const chars = body.length
  const hit2 = CH2_MARKERS.filter(m => body.includes(m))
  const hit1 = CH1_MARKERS.filter(m => body.includes(m))
  const verdict = hit2.length ? '🔴 复现：第 2 章内容混进第 1 章' : '✅ 本轮正常'

  console.log(`\n=== ${tag} ===`)
  console.log(`用时 ${secs}s | 生成 ${res?.chapters?.length ?? 0} 章 | 标题「${title}」| 正文 ${chars} 字（目标 2500）`)
  console.log(`第 1 章标记命中: ${hit1.length ? hit1.join('、') : '（无）'}`)
  console.log(`第 2 章标记命中: ${hit2.length ? '🔴 ' + hit2.join('、') : '（无）'}`)
  console.log(`判定: ${verdict}`)
  const tail = body.slice(-160).replace(/\n/g, ' ')
  console.log(`结尾 160 字: …${tail}`)
  fs.writeFileSync(path.join(process.cwd(), `.workbuddy/tmp/repro-out-${round}.txt`), `标题：${title}\n\n${body}`)
}

async function main() {
  const list = loadOnlineProviders()
  const only = process.env.REPRO_MODEL
  const use = only ? list.filter(p => p.model.includes(only)) : list
  console.log(`线上模型：${use.map(p => `${p.name || '?'}/${p.model}`).join(' / ')}｜每模型 ${ROUNDS} 轮`)
  for (const p of use) {
    for (let r = 1; r <= ROUNDS; r++) {
      try { await runOnce(p, r) } catch (e) { console.log(`\n=== ${p.model} #${r} ===\n❌ 失败: ${(e as Error)?.message ?? e}`) }
    }
  }
}
main().catch(e => { console.error('未捕获异常:', e); process.exit(1) })
