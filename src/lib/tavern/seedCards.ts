/**
 * 酒馆模式 · 示范角色卡（**逻辑层**）
 *
 * 内容（示范卡的正文 + 历史版本示例）在 `seedCardData.ts` —— 2026-09-15 按「数据与逻辑分居」
 * 的既有约定拆出（先例：2026-09-14 审计 P1-6 把 seedData.ts 拆出 seedContent.ts）。
 * 这里只留机制：
 *   · `seedFreeChars()`    —— 幂等播种（按**来源标记**认卡，改名也不会重复播）
 *   · `upgradeSeedCards()` —— 老库升级（示例格式换标记 / 整卡指纹换新版）
 *   · `isSeedCard()` / `findSeedFor()` / `isSeedCardName()` / `resetCardToSeed()` —— 认卡与恢复内置版本
 */
import * as store from './store'
import type { FreeCharacter } from './types'
import { SEED_FREE_CHARACTERS, LEGACY_SEED_EXAMPLES, LEGACY_SEED_CARD_SIGS } from './seedCardData'
import type { SeedFreeChar } from './seedCardData'

export { SEED_FREE_CHARACTERS, LEGACY_SEED_EXAMPLES, LEGACY_SEED_CARD_SIGS }
export type { SeedFreeChar }

/**
 * 幂等播种：按**名字**判断，已存在则跳过（既不重复创建，也不覆盖你改过的卡）。
 * 返回本次新建的数量。
 *
 * 之所以按名字而不是按 id：这些卡是「示范数据」，反复创建示范项目时不应堆副本；
 * 同时保留作者对卡片的编辑（若已存在就完全不碰）。
 */
export async function seedFreeChars(): Promise<number> {
  const idx = await store.listFreeChars()
  const list = (await Promise.all(idx.map(x => store.getFreeChar(x.id)))).filter((c): c is FreeCharacter => !!c)

  // ① 老库补标：名字还认得出的先记下来源 —— 此后作者改名也不会被重复播种
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    if (c.seededFrom) continue
    const seed = SEED_FREE_CHARACTERS.find(x => x.name === String(c.name ?? '').trim())
    if (!seed) continue
    list[i] = { ...c, seededFrom: seed.name }
    await store.saveFreeChar(list[i])
  }

  // ② 按来源标记判断是否已播种（**不再按名字** —— 改名过的卡也算"已经播过"）
  let created = 0
  for (const seed of SEED_FREE_CHARACTERS) {
    if (list.some(c => c.seededFrom === seed.name)) continue
    await store.createFreeChar({ ...seed, seededFrom: seed.name })
    created++
  }
  return created
}

/** 旧版（v1.1）示例里标记对方台词用的符号 */
const LEGACY_USER_MARK = '【用户】'
/** v1.2 版示例里标记对方台词用的符号（v1.3 起改用输入侧符号 〖对方〗） */
const LEGACY_USER_MARK_V12 = '对方：'
/** v1.3 起的输入侧说话人标注（与 summarize.ts 给用户发言打的标注同一套） */
const SPEAKER_MARK = '〖对方〗'
/** 示范卡示例的头部签名：用来确认「这确实是我们的示范卡」，免得误改作者自己写的卡 */
const SEED_HEADER_HINT = '你的输出就该长这个样子'

/** FNV-1a 32 位哈希 —— 只用来给「这一段文本是不是某个已知历史版本」做指纹，与安全无关 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 一张卡的**整卡指纹**（四章十二栏，顺序固定、用 \u0001 分隔）。
 *
 * ⚠️ 字段顺序必须与生成 `LEGACY_SEED_CARD_SIGS` 时完全一致 —— 改顺序等于让所有老指纹失效
 * （失效不会害人，只会让老库升不上来，但那就白留了）。
 * 导出是为了让验收脚本能自己算一遍（`tests/tavernSeedCards.test.ts`）。
 */
export function cardSig(c: {
  world: string
  profile: FreeCharacter['profile']
  conduct: FreeCharacter['conduct']
  examples: string
}): string {
  return fnv1a([
    c.world,
    c.profile.externals, c.profile.core, c.profile.speech,
    c.profile.relations, c.profile.cannot, c.profile.knowledge,
    c.conduct.perspective, c.conduct.bottomLine, c.conduct.paceLock, c.conduct.rating,
    c.examples,
  ].join('\u0001'))
}

/**
 * 这个名字是不是内置示范卡（UI 据此决定要不要显示「恢复内置版本」）
 */
export function isSeedCardName(name: string): boolean {
  return SEED_FREE_CHARACTERS.some(c => c.name === String(name ?? '').trim())
}

/**
 * 找出这张卡对应哪张内置种子 —— **先按来源标记，再退回按当前名字**。
 *
 * 先按标记是为了「作者改过名」这种情况：标记里存着它原本是哪种卡（值＝种子原名），
 * 所以改名之后依然认得出、不会被重复播种，也照样能吃到格式升级。
 * 退回按名字是为了老库（那些卡还没有标记，升级路径会顺手把标记补上）。
 */
export function findSeedFor(card: { name?: string; seededFrom?: string } | null | undefined): SeedFreeChar | undefined {
  if (!card) return undefined
  const byTag = card.seededFrom
    ? SEED_FREE_CHARACTERS.find(c => c.name === card.seededFrom)
    : undefined
  return byTag ?? SEED_FREE_CHARACTERS.find(c => c.name === String(card.name ?? '').trim())
}

/** 这张卡是不是内置示范卡（按来源认，改名后仍成立）—— UI 据此显示「恢复内置版本」 */
export function isSeedCard(card: { name?: string; seededFrom?: string } | null | undefined): boolean {
  return !!findSeedFor(card)
}

/**
 * 把某张卡的四章内容**恢复成内置最新版**（只覆盖 world / profile / conduct / examples）。
 *
 * 【为什么需要它】示范卡是「内置样板」，会随版本更新（2026-09-14 就改过关系设定与示例格式）。
 * 之前的做法是拿旧文本当锚点**逐句比对替换** —— 那要求把每一个历史版本都留在源码里，
 * 改一处就要存一份，越往后越沉；而且作者只要动过一个字，补丁就永久失效。
 * 给用户一个**显式的**「恢复内置版本」按钮更诚实：他自己清楚要拿内置内容覆盖。
 *
 * ★ **不碰记忆与日常状态** —— 那是「这个人经历过的事」，跟卡片模板是两回事。
 * ★ 只对**认得出是内置卡**的卡生效（按来源标记认 —— 改名过的示范卡依然认得出，也不会误伤别人的卡）。
 *
 * @returns 命中的内置卡名；没命中返回 null
 */
export async function resetCardToSeed(id: string): Promise<string | null> {
  const card = await store.getFreeChar(id)
  if (!card) return null
  const seed = findSeedFor(card)
  if (!seed) return null
  await store.saveFreeChar({
    ...card,
    world: seed.world,
    profile: { ...seed.profile },
    conduct: { ...seed.conduct },
    examples: seed.examples,
  })
  return seed.name
}

/**
 * 老库升级 —— 把**已经播种过**的示范卡升到最新内置版本。幂等，可每次启动调用。
 *
 * 四道判据，从「动得最多」到「一个字都不动」：
 *   ① `seededFrom` 缺失时先按名字补标记（此后改名也不漏升级）；
 *   ② **整卡指纹**（`LEGACY_SEED_CARD_SIGS`）全等 → 作者一字未改，**四章整体换新**
 *      （2026-09-15 世界观整卡改版走的就是这条）；
 *   ③ `examples` 与**任一历史版本**全等 → 整段换成新版（v1.1 全文锚点）；
 *   ④ 否则，若头部签名还在（`SEED_HEADER_HINT`）且正文里还留着任一旧标记 → **只换标记**，正文一字不动；
 *   都不命中 → **一个字都不动**：作者自己写的卡不该被程序改写（要覆盖请用界面上的「恢复内置版本」）。
 *
 * 判据 ④ 为什么够用（v1.2 → v1.3 不需要再存一份旧全文）：
 * 这两版的差别**正好只有那个标记**，所以「换标记」的结果与新版种子逐字节相同 ——
 * 再存一份全文只是徒增维护面。（v1.1 → v1.2 不同，那版还改了措辞与代词，故留了全文锚点。）
 *
 * 顺带说明为什么不能「按名字无条件刷新」：这些卡是给人改的模板，
 * 作者很可能已经按自己的口味调过语气与样本，无条件覆盖等于删掉他的劳动。
 *
 * ★ 升级只碰四章（world / profile / conduct / examples），**不碰** name / avatar /
 *   记忆 / 日常状态 —— 后者是「这个人经历过的事」，与卡片模板是两回事。
 *
 * @returns 实际升级的张数（供测试与日志）
 */
export async function upgradeSeedCards(): Promise<number> {

  const idx = await store.listFreeChars()
  let n = 0
  for (const it of idx) {
    const card = await store.getFreeChar(it.id)
    if (!card) continue
    const fresh = findSeedFor(card)
    if (!fresh) continue // 不是内置卡 → 一个字都不动
    // 老库补标（幂等）：名字还认得出时先记住来源，此后改名也不会漏掉升级
    if (!card.seededFrom) {
      card.seededFrom = fresh.name
      await store.saveFreeChar(card)
    }
    const legacy = LEGACY_SEED_EXAMPLES[fresh.name]
    const cur = card.examples
    // ② 整卡升级：四章全文与某个历史版本**全等** → 作者一字未改，整体升到最新版。
    //    必须排在下面两条之前 —— 世界观整卡改版时（2026-09-15「青宜大学城 → 奉阳大学」），
    //    只换示例那一章会让老库停在一张**自相矛盾**的卡上。
    const sigs = LEGACY_SEED_CARD_SIGS[fresh.name]
    if (sigs?.includes(cardSig(card))) {
      await store.saveFreeChar({
        ...card,
        world: fresh.world,
        profile: { ...fresh.profile },
        conduct: { ...fresh.conduct },
        examples: fresh.examples,
      })
      n++
      continue
    }
    // ① 一字未改（与**任一历史版本**全等）→ 整段换成新版。
    //    ⚠️ 这里必须是数组包含判断：只留「上一代」的话，停在更早版本的老库就永远升不上来了。
    if (fresh && legacy?.includes(cur) && fresh.examples !== cur) {
      await store.saveFreeChar({ ...card, examples: fresh.examples })
      n++
      continue
    }
    // ② 作者改过内容、但确实是我们这张示范卡（头部签名还在）且旧标记还留着 → 只换标记
    if (cur.includes(SEED_HEADER_HINT) &&
        (cur.includes(LEGACY_USER_MARK) || cur.includes(LEGACY_USER_MARK_V12))) {
      const next = cur
        .split(LEGACY_USER_MARK).join(SPEAKER_MARK)
        .split(LEGACY_USER_MARK_V12).join(SPEAKER_MARK)
      if (next !== cur) {
        await store.saveFreeChar({ ...card, examples: next })
        n++
      }
    }
  }
  return n
}
