// ============ 酒馆模式 · 角色卡单文件导入导出（方案 §7.7）============
//
// 两条必须做的事，都在这组断言里：
//   ① 导入时**重生成新 id** —— 否则从别处导入一份会撞上已有卡的 id，直接覆盖别人的卡
//   ② **必须校验**：结构完整性（四章在不在）、名称非空、大小上限
// 校验的尺度是「提醒而非拒绝」：缺章给 warnings 让界面告诉作者，
// 只有「根本不是这个格式」「名字空着」「大得离谱」才拒绝。
import {
  toCardFile, parseCardFile, cardFileName, describeWarnings,
  CARD_FILE_SUFFIX, CARD_FILE_MAX_CHARS,
  toCardBundle, parseCardBundle, CARD_BUNDLE_SUFFIX,
} from '../src/lib/tavern/cardFile'
import type { FreeCharacter } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const CARD: FreeCharacter = {
  id: 'orig-id-123',
  storyId: 'story-aaa',
  name: '苏念',
  world: '现代都市，老城区一间凌晨还亮着灯的便利店。',
  profile: {
    externals: '短发，灰色围裙', core: '外冷内热', speech: '句子短，习惯用反问',
    relations: '独居', cannot: '说不出关心的话', knowledge: '不知道顾客的职业与过去',
  },
  conduct: { perspective: '第一人称', bottomLine: '不越界打听私事', paceLock: '推进要慢', rating: '日常向' },
  examples: '对方：这么晚还不下班？\n她把找零推过去：\n「灯还亮着。」',
  createdAt: 1,
  updatedAt: 2,
}

function main() {
  // ---------- 1) 导出 → 导入 往返 ----------
  {
    const text = toCardFile(CARD, 1234)
    const r = parseCardFile(text)
    ok('导出的是合法 JSON', (() => { try { JSON.parse(text); return true } catch { return false } })())
    ok('带格式标记（防止随便一个 JSON 被当角色卡）', text.includes('yfe.taverncard'))
    ok('导出记录导出时间', text.includes('"exportedAt": 1234') || text.includes('"exportedAt":1234'))
    ok('回导成功', r.ok === true, r.ok ? '' : (r as { error: string }).error)
    if (r.ok) {
      ok('四章内容一字不差', r.card.world === CARD.world && r.card.examples === CARD.examples)
      ok('人物档案六项都在', r.card.profile.core === CARD.profile.core && r.card.profile.cannot === CARD.profile.cannot)
      ok('行为规范四项都在', r.card.conduct.perspective === CARD.conduct.perspective && r.card.conduct.rating === CARD.conduct.rating)
      ok('🔴 重生成新 id 而不是沿用原 id', r.card.importedFrom?.cardId?.startsWith('import:') === true)
      ok('导出文件里**不含**原 id / 创建时间（避免导入时撞 id）', !text.includes('orig-id-123'))
      ok('四章齐全时无警告', r.warnings.length === 0, r.warnings.join('、'))
      ok('溯源信息带导入时间', typeof r.card.importedFrom?.at === 'number')
    }
  }

  // ---------- 2) 缺章 → 报警告但不拒绝 ----------
  {
    const raw = JSON.parse(toCardFile(CARD)) as { card: Record<string, unknown> }
    delete raw.card.world
    raw.card.conduct = { perspective: '', bottomLine: '', paceLock: '', rating: '' }
    delete raw.card.examples
    const r = parseCardFile(JSON.stringify(raw))
    ok('缺章仍然可导入（旧卡/故意只填两章都该允许）', r.ok === true)
    if (r.ok) {
      ok('缺「第 1 章 · 角色与设定的关系」被如实报出', r.warnings.some(w => w.includes('第 1 章')))
      ok('缺「第 4 章 · 示例对话」被如实报出（最影响效果的一章）', r.warnings.some(w => w.includes('第 4 章')))
      ok('缺「视角与人称」被报出', r.warnings.some(w => w.includes('视角与人称')))
      ok('缺失字段补空串（不塞 undefined 进库）', r.card.world === '' && r.card.conduct.perspective === '')
    }
    ok('警告可转成一句人话', describeWarnings(['缺「第 1 章 · 角色与设定的关系」']).includes('结构有缺'))
    ok('无警告时的措辞', describeWarnings([]).includes('结构完整'))
  }

  // ---------- 3) 拒绝的情形 ----------
  {
    ok('非 JSON → 拒绝', parseCardFile('这不是 json').ok === false)
    ok('非 JSON 的报错可读', (parseCardFile('xxx') as { error: string }).error.includes('JSON'))
    ok('JSON 但不是对象 → 拒绝', parseCardFile('"字符串"').ok === false)
    ok('format 标记不对 → 拒绝', (() => {
      const r = parseCardFile(JSON.stringify({ format: 'sillytavern', card: { name: '甲' } }))
      return r.ok === false && r.error.includes('sillytavern')
    })())
    ok('没有名字 → 拒绝', (() => {
      const r = parseCardFile(JSON.stringify({ format: 'yfe.taverncard', card: { name: '   ' } }))
      return r.ok === false && r.error.includes('名字')
    })())
    ok('超大文件 → 拒绝', (() => {
      const r = parseCardFile('x'.repeat(CARD_FILE_MAX_CHARS + 1))
      return r.ok === false && r.error.includes('过大')
    })())
  }

  // ---------- 4) 容错：手写的裸卡 / 旧版无标记 ----------
  {
    const bare = JSON.stringify({ name: '林夏', world: '校园', profile: { core: '爱笑' }, conduct: {}, examples: '' })
    const r = parseCardFile(bare)
    ok('手写的裸卡（无 format 包裹）也能认', r.ok === true, r.ok ? '' : (r as { error: string }).error)
    if (r.ok) {
      ok('裸卡的名字读出来了', r.card.name === '林夏')
      ok('裸卡没有的字段补空而非报错', r.card.profile.speech === '')
    }
    // 字段类型不对
    const badType = JSON.stringify({ name: '甲', world: 123, profile: null, conduct: 'oops', examples: null })
    const r2 = parseCardFile(badType)
    ok('字段类型不对时补空而不崩', r2.ok === true && r2.ok && r2.card.world === '' && r2.card.profile.core === '')
  }

  // ---------- 5) 文件名 ----------
  {
    ok('文件名带规定后缀', cardFileName('苏念') === `苏念${CARD_FILE_SUFFIX}`)
    ok('路径分隔符被清掉（防写到别的目录去）', !cardFileName('a/b\\c').includes('/') && !cardFileName('a/b\\c').includes('\\'))
    ok('非法字符被替换', cardFileName('坏:名*字?').includes('_'))
    ok('空名字有兜底', cardFileName('   ').startsWith('未命名角色'))
    ok('过长名字被截断', cardFileName('长'.repeat(100)).length < 60)
  }

  // ---------- 6) 批量文件（一个文件装多张卡；同一世界观的一批角色常是一起建的） ----------
  {
    const many: FreeCharacter[] = [
      { ...CARD },
      { ...CARD, id: 'orig-id-456', name: '楚楠', world: '同一座城里，另一间店。' },
    ]
    const bundle = toCardBundle(many, '整批导出测试')
    ok('批量导出带自己的格式标记', bundle.includes('yfe.taverncards'))
    ok('批量导出不含本机 id（与单卡同一条纪律）',
      !bundle.includes('orig-id-123') && !bundle.includes('orig-id-456'))
    ok('note 写进文件（仅供人看）', bundle.includes('整批导出测试'))

    const r = parseCardBundle(bundle)
    ok('批量回导成功', r.ok === true, r.ok ? '' : (r as { error: string }).error)
    if (r.ok) {
      ok('两张都进来了，顺序不变',
        r.items.length === 2 && r.items[0].name === '苏念' && r.items[1].name === '楚楠',
        r.items.map(i => i.name).join('/'))
      ok('四章内容一字不差', r.items[1].card.world === many[1].world && r.items[1].card.examples === CARD.examples)
      ok('每张**各自**重生成 id（不会互相撞）',
        r.items[0].card.importedFrom?.cardId !== r.items[1].card.importedFrom?.cardId)
      ok('整批无失败项', r.failed.length === 0)
      ok('note 只是给人看的，没进卡里', !JSON.stringify(r.items).includes('整批导出测试'))
    }

    // 🔴 坏一张不该连累其余：作者填一次表不容易
    const mixed = JSON.parse(bundle) as { cards: unknown[] }
    mixed.cards.splice(1, 0, { name: '   ' })
    const r2 = parseCardBundle(JSON.stringify(mixed))
    ok('坏的那张进 failed、好的照常导入',
      r2.ok === true && r2.items.length === 2 && r2.failed.length === 1 && r2.failed[0].index === 1,
      r2.ok ? `${r2.items.length} 成功 / ${r2.failed.length} 失败` : r2.error)

    ok('一张都读不出来 → 整体失败（不当成"成功导入 0 张"）',
      parseCardBundle(JSON.stringify({ cards: [{ name: '' }] })).ok === false)
    ok('不是 JSON → 拒绝', parseCardBundle('这不是 json').ok === false)
    ok('缺 cards 数组 → 拒绝且说清楚',
      (parseCardBundle('{"format":"yfe.taverncards"}') as { error: string }).error.includes('cards'))
    ok('单卡文件不会被误当批量文件（两条通道互不串）', parseCardBundle(toCardFile(many[0])).ok === false)
    ok('批量后缀与单卡后缀区分开',
      String(CARD_BUNDLE_SUFFIX) !== String(CARD_FILE_SUFFIX) && CARD_BUNDLE_SUFFIX.endsWith('.json'))
  }

  // ============ 🔴 往返对称：关系状态随卡跨设备（2026-09-22 六维审计）============
  //
  // 审计现场：**导出侧一直带着 `vars`**（`toCardFile` / `toCardBundle` 的 `...rest` 都含它），
  // 而导入侧从不读 ⇒ 「导出 → 导入」往返一次，卡上的关系状态（好感/信任/精神/心情/地点 + 备注）全部归零。
  // 老大 2026-09-22 拍板：**随卡跨设备**。两侧必须对称 —— 这组断言就是钉住这个对称性，
  // 防止以后有人只改一侧又把它改回去。
  {
    const withVars: FreeCharacter = {
      ...CARD,
      vars: {
        values: { affection: 62, trust: 41, mood: '平稳' },
        notes: { affection: '从戒备到肯搭把手' },
      },
    }

    const back = parseCardFile(toCardFile(withVars))
    const bv = back.ok ? back.card.vars : undefined // 先窄化，否则 tsc 不认 ok 分支上的 card
    ok('🔴 单卡往返：vars 被带回来', !!bv)
    ok('🔴 往返后数值逐项一致',
      JSON.stringify(bv?.values) === JSON.stringify(withVars.vars?.values),
      JSON.stringify(bv?.values))
    ok('🔴 往返后备注一致（备注是「为什么现在是这个分」的旁白，同样不能丢）',
      bv?.notes?.affection === '从戒备到肯搭把手')
    ok('文本项（心情）也带回来', bv?.values?.mood === '平稳')

    const manyBack = parseCardBundle(toCardBundle([withVars]))
    ok('🔴 批量通道同样对称（vars 也带回来）',
      manyBack.ok && !!manyBack.items[0]?.card.vars
      && manyBack.items[0].card.vars?.values?.affection === 62)

    // 宽松校验不等于照单全收：非法键、非法类型要丢掉
    const dirty = JSON.parse(toCardFile(withVars)) as { card: Record<string, unknown> }
    dirty.card.vars = {
      values: { affection: 30, evilKey: 99 },
      notes: { affection: 42, mood: '好' },
    }
    const cleaned = parseCardFile(JSON.stringify(dirty))
    const cv = (cleaned.ok ? cleaned.card.vars?.values : {}) as Record<string, unknown>
    const cn = (cleaned.ok ? cleaned.card.vars?.notes : {}) as Record<string, unknown>
    ok('丢弃不在 VAR_KEYS 里的键（evilKey 不收）', cv.affection === 30 && cv.evilKey === undefined)
    ok('notes 里非字符串的值不收（affection: 42 丢掉），合法的一条留下（mood: "好"）',
      cn.affection === undefined && cn.mood === '好')

    // 向后兼容：旧文件根本没有 vars 字段 → 不报错，也不给卡硬塞一个空的 vars
    const legacy = JSON.parse(toCardFile(withVars)) as { card: Record<string, unknown> }
    delete legacy.card.vars
    const legacyBack = parseCardFile(JSON.stringify(legacy))
    ok('向后兼容：旧文件没有 vars → 正常导入且 vars 为 undefined（FORMAT_VERSION 无需升版）',
      legacyBack.ok && legacyBack.card.vars === undefined)
  }

  console.log(`\ntavernCardFile: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main()
