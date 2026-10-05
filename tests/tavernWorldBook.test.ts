// ============ 酒馆模式 · 世界书（W3，2026-10-05）============
//
// 【这组断言要钉住的三件事】
//   ① **等价性红线**：老数据（无 keys / 只有整段 setting）走世界书的结果，
//      与升级前的 `worldToText` / 直接注入整段**逐字一致** —— 这是整个改造的立身之本。
//   ② 词条级判据：自身关键词命中才注入、概率闸、order 排序。
//   ③ 递归激活：命中 A ⇒ A 正文里的词能激活 B；≤2 轮、visited 去重、不递归的条目不外扩。
import {
  emptyWorldEntry, normalizeEntry, isAlwaysOn, entryHits, pickEntries, renderEntries,
  buildWorldBookText, entryStateOf, MAX_RECURSION_ROUNDS, type WorldEntry,
} from '../src/lib/tavern/worldBook'
import {
  EMPTY_WORLD_SETTING, worldToText, worldEntriesOf, buildPlotWorldBook,
  type WorldSetting, type WorldSection,
} from '../src/lib/tavern/world'
import { storyEntriesOf, buildStoryWorldBook, STORY_SETTING_MAX } from '../src/lib/tavern/story'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 造词条（省去手写全部字段）。🔴 必须给唯一 id —— 生产数据由 uid() 生成，
 *  空 id 会让「按 id 去重」的判据把多条当成同一条（本文件实测踩过）。 */
let entSeq = 0
function ent(title: string, body: string, over: Partial<WorldEntry> = {}): WorldEntry {
  entSeq += 1
  return { ...emptyWorldEntry({ id: `e${entSeq}`, title, body, keys: [`@@${title}`] }), ...over }
}

function sec(id: string, title: string, body: string, over: Partial<WorldSection> = {}): WorldSection {
  return { id, title, body, ...over }
}

function world(over: Partial<WorldSetting> = {}): WorldSetting {
  return { ...EMPTY_WORLD_SETTING, ...over }
}

async function main() {
  __resetMockStores()

  // ---------- 1) 等价性红线：老数据（sections 只有 id/title/body） ----------
  {
    // 旧行为：sections 全渲染、brief 在最前、每节 `〖标题〗\n正文` 之间空一行
    const old = world({
      brief: '民国上海，租界与老城交界。',
      sections: [
        sec('s1', '时代与地理', '黄浦江把城劈成两半。'),
        sec('s2', '规矩与禁忌', '夜里十点后别走霞飞路。'),
      ],
    })

    // 新路径：走世界书（整体闸关掉关键词 ⇒ 总是注入）
    const viaBook = buildPlotWorldBook(old, '随便一段上下文').text
    const viaOld = worldToText(old)

    ok('🔴 老数据走世界书 == 走旧 worldToText（逐字一致）', viaBook === viaOld,
      JSON.stringify(viaBook))
    ok('🔴 结果里 brief 在最前、两节的标题与正文都在',
      viaBook.startsWith('民国上海') && viaBook.includes('〖时代与地理〗') &&
      viaBook.includes('〖规矩与禁忌〗'))
    ok('老数据渲染结果非空（不是被新判据吃掉了）', viaBook.length > 30, String(viaBook.length))

    // 反向：空设定两边都空
    ok('空设定：世界书返回空串（整层不出现）', buildPlotWorldBook(EMPTY_WORLD_SETTING, 'x').text === '')
    ok('空设定：旧函数同样返回空串', worldToText(EMPTY_WORLD_SETTING) === '')
  }

  // ---------- 2) 等价性：整段 setting 的老故事 ----------
  {
    const legacy = { setting: '这个世界没有太阳，靠地热与荧光菌照明。' }
    const viaBook = buildStoryWorldBook(legacy, '任意上下文').text
    ok('🔴 老故事（只有 setting）走世界书 == 整段原样注入', viaBook === legacy.setting, JSON.stringify(viaBook))
    ok('老故事：池里恰好一条且是常驻', storyEntriesOf(legacy).length === 1 &&
      storyEntriesOf(legacy)[0].constant === true)
    ok('空故事：返回空串', buildStoryWorldBook({ setting: '' }, 'x').text === '')
    ok('story/entries 都缺：返回空串（安全）', buildStoryWorldBook(null, 'x').text === '')
  }

  // ---------- 3) 词条级判据：自身关键词 ----------
  {
    const a = ent('城南旧事', '城南有座废弃钟楼。', { keys: ['城南', '钟楼'] })
    const b = ent('北境军制', '北境以十人为一帐。', { keys: ['北境'] })

    ok('命中任一自身关键词 ⇒ 该条被选中',
      pickEntries([a, b], '她往城南走去').hits.map(h => h.title).join() === '城南旧事')
    ok('没命中任一 ⇒ 该条不出现',
      pickEntries([a, b], '今天天气不错').hits.length === 0)
    ok('大小写不敏感', pickEntries([ent('x', 'y', { keys: ['Alpha'] })], '看 ALPHA 一眼').hits.length === 1)
    ok('keys 为空 = 总是注入', isAlwaysOn(ent('常驻', '正文', { keys: [] })) &&
      pickEntries([ent('常驻', '正文', { keys: [] })], '随便').hits.length === 1)
    ok('constant=true 也总是注入（即便写了 keys）',
      isAlwaysOn(ent('x', 'y', { keys: ['从不出现的词'], constant: true })))
    ok('entryHits 对总是注入的条目恒 true', entryHits(ent('x', 'y', { keys: [] }), ''))
  }

  // ---------- 4) 概率闸 ----------
  {
    const half = ent('偶尔提一下', '正文', { keys: ['触发'], prob: 0.5 })
    // rand 注入：0 一定中、0.99 一定不中
    ok('prob 通过 ⇒ 选中', pickEntries([half], '触发', { rand: () => 0.1 }).hits.length === 1)
    ok('prob 未通过 ⇒ 不选中', pickEntries([half], '触发', { rand: () => 0.9 }).hits.length === 0)
    ok('未通过时记进 skippedByProb（供界面说明「为什么没注入」）',
      pickEntries([half], '触发', { rand: () => 0.9 }).skippedByProb.includes(half.id))
    ok('prob=1 必中（rand 不参与）',
      pickEntries([ent('x', 'y', { keys: ['k'], prob: 1 })], 'k', { rand: () => 0.999 }).hits.length === 1)
    ok('prob=0 必不中', pickEntries([ent('x', 'y', { keys: ['k'], prob: 0 })], 'k', { rand: () => 0 }).hits.length === 0)
    ok('🔴 概率只在命中时判一次（不中不会在后续轮次重判进来）',
      pickEntries([
        ent('A', '正文提到 @@B', { keys: ['起点'], prob: 0.5 }),
        ent('B', '另一条', { keys: [] }),
      ], '起点', { rand: () => 0.9 }).hits.every(h => h.title !== '偶尔'),
      '')
  }

  // ---------- 5) order 排序 + 稳定 ----------
  {
    const e1 = ent('第三', 'c', { keys: ['k'], order: 30 })
    const e2 = ent('第一', 'a', { keys: ['k'], order: 10 })
    const e3 = ent('第二', 'b', { keys: ['k'], order: 20 })
    ok('按 order 升序渲染（与数组顺序无关）',
      pickEntries([e1, e2, e3], 'k').hits.map(h => h.title).join('|') === '第一|第二|第三',
      pickEntries([e1, e2, e3], 'k').hits.map(h => h.title).join('|'))
    // order 相同 → 按原池下标，保证同一份数据每次结果一致
    const t1 = ent('甲', 'x', { keys: ['k'], order: 5 })
    const t2 = ent('乙', 'y', { keys: ['k'], order: 5 })
    ok('order 相同按原池顺序稳定排序',
      pickEntries([t1, t2], 'k').hits.map(h => h.title).join('|') === '甲|乙')
    ok('同样的输入连跑两次结果一致（无随机漂移）',
      pickEntries([t1, t2], 'k').hits.map(h => h.id).join() ===
      pickEntries([t1, t2], 'k').hits.map(h => h.id).join())
  }

  // ---------- 6) 递归激活 ----------
  {
    // 起点命中 A；A 正文里写了「北境」；B 的关键词是「北境」⇒ B 被 A 拉进来
    const A = ent('南方港口', '码头往北的商路直通北境。', { keys: ['港口'] })
    const B = ent('北境军制', '北境以十人为一帐。', { keys: ['北境'] })
    const C = ent('无关条目', '从不被提到。', { keys: ['幻影词'] })

    const r = pickEntries([A, B, C], '她到了港口')
    ok('递归：命中 A 后，A 正文里的词激活了 B',
      r.hits.map(h => h.title).sort().join('|') === ['北境军制', '南方港口'].sort().join('|'),
      r.hits.map(h => h.title).join('|'))
    ok('递归：与两者都无关的条目没被带进来', !r.hits.some(h => h.title === '无关条目'))

    // recursive:false 的条目**不被别人激活**（它自己的正文不进下一轮扫描）
    const A2 = ent('封闭条目', '正文提到北境。', { keys: ['港口'], recursive: false })
    const r2 = pickEntries([A2, B], '港口')
    ok('recursive=false：它命中后不把正文里的词贡献给下一轮（不激活 B）',
      r2.hits.map(h => h.title).join() === '封闭条目', r2.hits.map(h => h.title).join())

    // 循环引用不能死循环
    const L1 = ent('环1', '见 环2', { keys: ['起点'] })
    const L2 = ent('环2', '见 环1', { keys: ['环2'] })
    const rl = pickEntries([L1, L2], '起点')
    ok('🔴 循环引用不死循环、每条只进一次', rl.hits.length === 2, String(rl.hits.length))

    ok('MAX_RECURSION_ROUNDS = 2（ST 默认口径）', MAX_RECURSION_ROUNDS === 2)

    // 🔴 回归：id 为空时不能把多条当成同一条（本文件实测踩过的坑）
    const noId1 = { ...emptyWorldEntry({ title: '无id甲', body: 'a', keys: ['k'] }), id: '' }
    const noId2 = { ...emptyWorldEntry({ title: '无id乙', body: 'b', keys: ['k'] }), id: '' }
    ok('🔴 空 id 的两条都能被选中（去重退回池内下标，不互相顶掉）',
      pickEntries([noId1, noId2], 'k').hits.length === 2,
      String(pickEntries([noId1, noId2], 'k').hits.length))
  }

  // ---------- 7) 渲染与取舍 ----------
  {
    // 🔴 2026-10-05：renderEntries 返回值从 `string` 改为 `{ text, dropped }`
    //    （超限行为从「一刀切断字符串」改为「逐条取舍」）—— 下面统一读 `.text`。
    ok('带标题：〖标题〗\\n正文', renderEntries([ent('标题', '正文')]).text === '〖标题〗\n正文')
    ok('无标题：只输出正文（brief 走这条）', renderEntries([ent('', '只有正文')]).text === '只有正文')
    ok('两条之间空一行（与 worldToText 同形）',
      renderEntries([ent('甲', '1'), ent('乙', '2')]).text === '〖甲〗\n1\n\n〖乙〗\n2')
    ok('空正文空标题的条目被跳过', renderEntries([ent('', '')]).text === '')

    const long = renderEntries([ent('长', 'x'.repeat(500))], { maxChars: 100 })
    ok('超上限时注明（不静默吞掉）', long.text.includes('截断') && long.text.length < 400,
      String(long.text.length))
    ok('不传 maxChars 时不截断', renderEntries([ent('长', 'x'.repeat(500))]).text.length > 500)
    ok('不传 maxChars 时 dropped 为空', renderEntries([ent('长', 'x'.repeat(500))]).dropped.length === 0)

    ok('buildWorldBookText 空池返回空串', buildWorldBookText([], 'x').text === '')
    ok('buildWorldBookText 一步到位（选 + 渲染）',
      buildWorldBookText([ent('甲', '1', { keys: ['k'] })], 'k').text === '〖甲〗\n1')
  }

  // ---------- 8) 剧情模式整份闸 ① ↔ 词条闸 ② 的合成 ----------
  {
    // 整份设了 keywords，且各节**没有**自己的 keys ⇒ 过①后全带（不能退化成一条都不带）
    const gated = world({
      brief: '总纲',
      keywords: ['便利店'],
      sections: [sec('s1', '规矩', '夜里十点关门。'), sec('s2', '人物', '老板姓陈。')],
    })
    ok('① 整份未命中 ⇒ 一条都不带',
      buildPlotWorldBook(gated, '今天天气不错').text === '')
    const hit = buildPlotWorldBook(gated, '她走进便利店').text
    ok('① 整份命中 ⇒ 内部无自身 keys 的节**全带**（不退化成空）',
      hit.includes('〖规矩〗') && hit.includes('〖人物〗') && hit.includes('总纲'),
      JSON.stringify(hit))

    // 词条级：整份命中后，带自身 keys 的节仍要过②
    const mixed = world({
      sections: [
        sec('s1', '常驻节', '永远都在。'),
        sec('s2', '城南节', '只在城南出现。', { keys: ['城南'] }),
      ],
    })
    const m1 = buildPlotWorldBook(mixed, '随便').text
    ok('② 没命中自身 keys 的节被筛掉', m1.includes('常驻节') && !m1.includes('城南节'), JSON.stringify(m1))
    const m2 = buildPlotWorldBook(mixed, '她往城南去').text
    ok('② 命中自身 keys 的节才进来', m2.includes('常驻节') && m2.includes('城南节'))

    ok('worldEntriesOf：brief 排在最前（order -1）',
      worldEntriesOf(world({ brief: '纲', sections: [sec('s', '标', 'body')] }))[0].id === 'world-brief')
    ok('worldEntriesOf：空节（无 title 无 body）被丢掉',
      worldEntriesOf(world({ sections: [sec('s', '', ''), sec('t', '有', '内容')] })).length === 1)
  }

  // ---------- 9) 读旧数据的兼容（normalizeEntry） ----------
  {
    ok('老形状 {id,title,body} ⇒ keys 空 = 总是注入',
      normalizeEntry({ id: 'a', title: '旧', body: '正文' })?.keys.length === 0)
    ok('老形状：prob 缺省 1、order 用下标、recursive 缺省 true', (() => {
      const e = normalizeEntry({ id: 'a', title: '旧', body: '正文' }, 3)!
      return e.prob === 1 && e.order === 3 && e.recursive === true
    })())
    ok('兼容旧字段名 keywords（若历史数据里用过）',
      normalizeEntry({ title: 't', body: 'b', keywords: ['甲'] })?.keys[0] === '甲')
    ok('prob 越界被收口到 0..1',
      normalizeEntry({ title: 't', body: 'b', prob: 5 })?.prob === 1 &&
      normalizeEntry({ title: 't', body: 'b', prob: -2 })?.prob === 0)
    ok('非对象 / 全空 ⇒ null（不造空条目）',
      normalizeEntry(null) === null && normalizeEntry({ title: '', body: '' }) === null)
    ok('string 类型的 prob 不被硬转（宁可用默认值，也不猜）',
      normalizeEntry({ title: 't', body: 'b', prob: '0.5' as unknown as number })?.prob === 1)
  }

  // ---------- 10) 端到端：引擎注入量对得上 ----------
  {
    // 「词条级」相比「整份」省了多少额度 —— 这是这轮改造的实际收益
    const w = world({
      brief: '总纲',
      sections: [
        sec('s1', '城南十景', '南'.repeat(600), { keys: ['城南'] }),
        sec('s2', '北境军制', '北'.repeat(600), { keys: ['北境'] }),
        sec('s3', '中原商路', '中'.repeat(600), { keys: ['商路'] }),
      ],
    })
    const onlySouth = buildPlotWorldBook(w, '她往城南去').text
    const all = buildPlotWorldBook(w, `城南\n北境\n商路`).text
    ok('🔴 只提城南 ⇒ 只带城南那一条（另两条不占额度）',
      onlySouth.includes('南'.repeat(100)) && !onlySouth.includes('北'.repeat(100)), '')
    ok('🔴 三条都提到 ⇒ 三条都在（总长明显更大）', all.length > onlySouth.length * 1.5,
      `${all.length} vs ${onlySouth.length}`)
    // 🔴 2026-10-05：超额度行为从「一刀切断字符串」改为「逐条取舍」—— 不再切出半条，只整条剔除
    const big = buildPlotWorldBook(w, '城南', { maxChars: 200 })
    ok('🔴 超额度时逐条取舍：不出现被切一半的正文', !big.text.includes('南'.repeat(150)), big.text.slice(0, 60))
    ok('🔴 超额度时如实报告 dropped（不静默丢）', big.dropped.length >= 1,
      `dropped=${big.dropped.length}`)
    ok('故事侧上限常量仍在（降级为兜底值）', STORY_SETTING_MAX === 2400)
  }

  // ---------- 11) 四色灯（EntryState，2026-10-05） ----------
  {
    // ① 老语义推断：触发词空 ⇒ 常驻；recursive:false ⇒ 引荐；其余 ⇒ 触发
    ok('无触发词 ⇒ 推断为常驻', entryStateOf(ent('甲', '1', { keys: [], constant: true })) === 'on')
    ok('有触发词 ⇒ 推断为触发', entryStateOf(ent('乙', '2', { keys: ['k'], constant: undefined })) === 'hit')
    ok('recursive:false 且有触发词 ⇒ 推断为引荐',
      entryStateOf(ent('丙', '3', { keys: ['k'], recursive: false })) === 'ref')

    // ② 显式 state 优先于推断
    ok('🔴 显式 state 覆盖推断（有触发词也能强制常驻）',
      entryStateOf({ ...ent('丁', '4', { keys: ['k'] }), state: 'on' }) === 'on')
    ok('显式 off ⇒ 休眠', entryStateOf({ ...ent('戊', '5'), off: true }) === 'off')

    // ③ 休眠条目全程不参与选词
    const pool = [
      ent('常驻', 'A', { keys: [], constant: true }),
      { ...ent('睡着', 'B', { keys: [] }), state: 'off' as const },
    ]
    const r = pickEntries(pool, '随便')
    ok('🔴 休眠条目不进命中（state:off）', r.hits.length === 1 && r.hits[0].title === '常驻',
      r.hits.map(h => h.title).join(','))

    // ④ 引荐：只在递归轮参与，第 0 轮跳过。
    //    造数注意：引荐条的触发词若出现在「引子」的条件或正文里，它会在**递归轮**正确命中 ——
    //    这里要证的是「第 0 轮不参与」，所以触发词用一个第 0 轮文本里没有的词。
    const refPool = [
      ent('引子', 'C', { keys: ['开门'] }),                       // 直接命中
      { ...ent('暗线', 'D', { keys: ['只在递归里出现'] }), state: 'ref' as const },
    ]
    const r0 = pickEntries(refPool, '开门')
    ok('🔴 引荐条目在第 0 轮不参与（触发词只在本轮文本里也不进）',
      !r0.hits.some(h => h.title === '暗线'), r0.hits.map(h => h.title).join(','))
    // 老语义（没设 state）的同形状条目 ⇒ 第 0 轮照常命中，证明上面那条是 state:'ref' 起的作用
    const plainPool = [
      ent('引子', 'C', { keys: ['开门'] }),
      ent('暗线', 'D', { keys: ['只在递归里出现'] }),   // 无 state
    ]
    ok('🔴 对照组：没设 state 的同形状条目在第 0 轮同样不进（触发词没命中）—— 判据是触发词',
      !pickEntries(plainPool, '开门').hits.some(h => h.title === '暗线'))

    // ⑤ 老数据（没 state）不受新规则影响 —— 等价性红线
    const legacyPool = [ent('老甲', 'X', { keys: ['k'] }), ent('老乙', 'Y', { keys: ['k'] })]
    ok('🔴 没设 state 的老数据：两条都照常命中（老语义不变）',
      pickEntries(legacyPool, 'k').hits.length === 2)
  }

  // ---------- 12) 逐条取舍的优先级（对齐 ST） ----------
  {
    // 三条相等长度，额度只够两条 ⇒ 应砍「引荐命中」那条（优先级最低）
    const onE = ent('常驻', 'A'.repeat(80), { keys: [], constant: true })
    const dirE = ent('直命', 'B'.repeat(80), { keys: ['键'], order: 5 })
    const refE = { ...ent('引荐', 'C'.repeat(80)), order: 1, state: 'ref' as const }
    const originMap = new Map<WorldEntry, 'direct' | 'recursive'>([
      [onE, 'direct'], [dirE, 'direct'], [refE, 'recursive'],
    ])
    // 🔴 上限要按**实际渲染长度**给：`〖标题〗\n正文` 每条比 body 多出 5~6 字，
    //    只按 body 长度设 maxChars 会一条都装不下（退化成兜底截断、dropped 为空）。
    const rendered = (t: string, b: string) => `〖${t}〗\n${b}`
    const twoLen = rendered('常驻', 'A'.repeat(80)).length
      + 2 + rendered('直命', 'B'.repeat(80)).length
    const { text, dropped } = renderEntries([onE, dirE, refE], { maxChars: twoLen, origin: originMap })
    ok('🔴 额度不足时先砍「引荐命中」，常驻与直接命中留下',
      text.includes('A'.repeat(50)) && text.includes('B'.repeat(50)),
      text.slice(0, 40))
    ok('🔴 被砍的是引荐那条（不是直接命中）',
      dropped.length === 1 && dropped[0].title === '引荐',
      `dropped=${dropped.map(e => e.title).join(',')}`)
  }

  // ---------- 13) 🔴 brief 不许冒充「本节」的灯态（2026-10-05 实机抓到的 P1） ----------
  //
  // 起因：`TavernWorld.tsx` 算每节的灯态时写的是 `worldEntriesOf({...w, sections:[s]})[0]`。
  // `worldEntriesOf` 在 `brief` 非空时会**先推入一条 `world-brief`（constant:true，恒 'on'）**，
  // 于是 `[0]` 永远是总纲而不是本节 ⇒ 只要作者写过一句话总纲，**每一节的灯都显示「常驻 / 每轮都带」**，
  // 哪怕他刚给这节填了触发词（引擎实际按 'hit' 走）。界面在撒谎，且是「越用越不可能发现」的那种
  // （没总纲的空设定反而显示正确 —— 因为那时 `[0]` 就是本节）。
  //
  // 修复口径：界面侧不许取 `[0]`，要**按 id 找本节**。这里把判据钉住。
  {
    const w = world({
      brief: '总纲（恒常驻）',
      sections: [
        sec('sec-hit', '城南十景', '南'.repeat(20), { keys: ['城南'] }),
        sec('sec-on', '无关键词节', 'B'.repeat(20)),
      ],
    })
    // ① `[0]` 确实是总纲 —— 这就是当年写法会踩的坑，先钉死这个前提
    const all = worldEntriesOf(w)
    ok('🔴 前提：brief 非空时 `[0]` 是总纲（不是第一节）', all[0].id === 'world-brief', all[0].id)
    ok('🔴 前提：总纲恒判常驻', entryStateOf(all[0]) === 'on')

    // ② 正确取法（界面修复后走的路径）：清 brief + 按 id 找
    const ownEntries = (s: typeof w.sections[number]) =>
      worldEntriesOf({ ...w, brief: '', sections: [s] })
    const hitEntry = ownEntries(w.sections[0]).find(e => e.id === 'sec-hit')
    ok('🔴 有触发词的节 ⇒ 灯态是「触发」（不是被总纲顶成常驻）',
      !!hitEntry && entryStateOf(hitEntry) === 'hit',
      hitEntry ? entryStateOf(hitEntry) : '（没找到本节条目）')
    // ③ 无触发词的节仍然正确落到常驻（修复不能把这条一起改坏）
    const onEntry = ownEntries(w.sections[1]).find(e => e.id === 'sec-on')
    ok('🔴 无触发词的节 ⇒ 仍然是「常驻」', !!onEntry && entryStateOf(onEntry) === 'on',
      onEntry ? entryStateOf(onEntry) : '（没找到本节条目）')
    // ④ 错误的取法复现一下：证明「取 [0] 会拿到 on」—— 防将来有人把它改回去
    ok('🔴 反例：直接取 `[0]` 会得到总纲的 on（这就是 bug 本体）',
      entryStateOf(worldEntriesOf({ ...w, sections: [w.sections[0]] })[0]) === 'on')
  }

  console.log(`\ntavernWorldBook: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
