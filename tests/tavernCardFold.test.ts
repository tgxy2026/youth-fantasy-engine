// ============ 酒馆 · 分组折叠态持久化（2026-10-11 修复「折叠不能常驻」）============
//
// 【报的问题（作者原话）】酒馆模式组角色卡片里，角色卡挂到某个故事下之后能折叠，
// 但「折叠状态并不能常驻。如果我点击保存并刷新了这个页签之后，原本已经折叠的列表
// 就会被重新展开」。
//
// 【根因】`useTavernCardModel` 的 `openIds` 是**纯内存 state**，而 `load()` 每次都把
//   "还没见过的故事"全部补进展开集合。切走页签 = 组件卸载 = state 归零 ⇒ 切回来时
//   `prev` 是空的，于是**所有故事统统重新展开**，作者收起来的白收了。
//
// 【修法】按 `lib/settings/uiPrefs` 的铁律「存**偏离默认**的那一侧」持久化折叠态：
//   · 角色卡页默认**全展开** ⇒ 存「已收起」(`tavern-card-collapsed`)；
//   · 剧本页默认**全收起** ⇒ 存「已展开」(`tavern-script-open`)。
//   两页方向相反，本用例两个都钉住（抄错方向 = 新故事一上来就是收起的，属于静默劣化）。
//
// 本用例盯三件事：
//   ① 纯换算 `expandedIdsOf` / `collapsedIdsOf` 的边界（顺序、空集、补集往返）；
//   ② 🔴 **回归语义**：模拟「重挂」再算一次展开集 —— 作者收起的必须仍收起，
//      而**新出现的故事**必须自动展开（不能因为"记录里没它"就默认收起）；
//   ③ 接线与方向：两个组件真的用了 uiPrefs，且各存对的那一侧。
import fs from 'node:fs'
import path from 'node:path'
import { expandedIdsOf, collapsedIdsOf } from '../src/lib/settings/uiPrefs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ---------- ① 纯换算的边界 ----------
{
  const all = ['s1', 's2', 's3']

  ok('无收起记录 → 全展开（首次安装的默认：看见全貌）',
    JSON.stringify(expandedIdsOf(all, new Set())) === JSON.stringify(all))

  ok('收起一个 → 它不在展开集里，其余照旧',
    JSON.stringify(expandedIdsOf(all, new Set(['s2']))) === JSON.stringify(['s1', 's3']))

  ok('🔴 全部收起也是合法状态（不能退化成"没记录→全展开"）',
    expandedIdsOf(all, new Set(all)).length === 0)

  ok('传进来的顺序被保留（左栏按故事的显示顺序渲染）',
    JSON.stringify(expandedIdsOf(['z', 'a', 'm'], new Set(['a']))) === JSON.stringify(['z', 'm']))

  ok('已收起里的死 id（故事已删）不影响结果',
    JSON.stringify(expandedIdsOf(all, new Set(['ghost', 's1']))) === JSON.stringify(['s2', 's3']))

  // 补集往返：展开 → 收起 → 再展开，必须回到原样
  const open = expandedIdsOf(all, new Set(['s3']))
  const collapsed = collapsedIdsOf(all, open)
  ok('🔴 补集往返自洽（展开↔收起来回换不丢 id、不串位）',
    JSON.stringify(collapsed) === JSON.stringify(['s3'])
    && JSON.stringify(expandedIdsOf(all, new Set(collapsed))) === JSON.stringify(open))

  ok('collapsedIdsOf：全展开 → 空收起（与"无记录"同义）',
    collapsedIdsOf(all, all).length === 0)

  ok('collapsedIdsOf 忽略不在全集里的展开 id（不凭空造出收起项）',
    JSON.stringify(collapsedIdsOf(all, ['s1', 'ghost'])) === JSON.stringify(['s2', 's3']))
}

// ---------- ② 🔴 回归语义：重挂后（切走页签再回来）折叠态必须常驻 ----------
{
  // 场景：作者有三个故事，手动把「s2」收起来了 → 落盘 collapsed = ['s2']
  const universe1 = ['s1', 's2', 's3']
  const persisted = new Set(collapsedIdsOf(universe1, ['s1', 's3']))
  ok('作者收起 s2 后，落盘的正是 [s2]', JSON.stringify([...persisted]) === JSON.stringify(['s2']))

  // 修复前：重挂时 prev=[] ⇒ load() 把所有故事补进展开 ⇒ 全展开（s2 又冒出来）
  // 修复后：展开 = 全集 − 已收起 ⇒ s2 仍收起
  const afterRemount = expandedIdsOf(['s1', 's2', 's3'], persisted)
  ok('🔴 切走页签再回来，作者收起的 s2 **仍然收起**（本用例的核心断言）',
    !afterRemount.includes('s2') && afterRemount.includes('s1') && afterRemount.includes('s3'),
    `实际展开：${JSON.stringify(afterRemount)}`)

  // 同时新增一个故事 s4：它不在"已收起"里 ⇒ 必须自动展开（不能一上来就藏着）
  const afterNewStory = expandedIdsOf(['s1', 's2', 's3', 's4'], persisted)
  ok('🔴 新出现的故事**自动展开**（否则作者会以为新建的故事没生效）',
    afterNewStory.includes('s4') && !afterNewStory.includes('s2'),
    `实际展开：${JSON.stringify(afterNewStory)}`)

  // 故事被删：残留记录不影响别人，且再算一次时会被剪掉
  const afterDelete = expandedIdsOf(['s1', 's3'], new Set(['s2']))
  ok('删掉 s2 后，残留的收起记录不影响其它故事',
    JSON.stringify(afterDelete) === JSON.stringify(['s1', 's3']))
}

// ---------- ③ 接线与方向（静态扫描）----------
{
  const card = read('src/components/tavern/useTavernCardModel.ts')
  ok('🔴 角色卡左栏的折叠态走了 uiPrefs（不再是自己 new 的 set）',
    /from '@\/lib\/settings\/uiPrefs'/.test(card) && /readSetPref\(CARD_COLLAPSED_KEY\)/.test(card)
    && /writeSetPref\(CARD_COLLAPSED_KEY/.test(card))
  ok('🔴 角色卡存的是「**已收起**」的那一侧（默认全展开 ⇒ 存偏离默认的一侧）',
    /CARD_COLLAPSED_KEY = 'tavern-card-collapsed'/.test(card)
    && /collapsedIdsOf\(/.test(card))
  ok('🔴 load() 不再把"没见过的故事"盲目补进展开集合（原来的 bug 源头）',
    !/const fresh = ss\.map\(s => s\.id\)\.filter\(id => !known\.has\(id\)\)/.test(card)
    && /expandedIdsOf\(universe, collapsedRef\.current\)/.test(card))
  ok('没有绕过 uiPrefs 直写 localStorage（注：注释里提到 localStorage 不算）',
    !/localStorage\.(get|set|remove)Item/.test(card))

  const script = read('src/components/tavern/TavernScript.tsx')
  ok('🔴 剧本页左栏折叠态也持久化了（同类缺陷，一并修）',
    /usePersistedSet\('tavern-script-open'\)/.test(script) && /from '@\/lib\/settings\/uiPrefs'/.test(script))
  ok('剧本页存的是「已展开」的（它默认全收起，方向与角色卡相反）',
    !/tavern-script-collapsed/.test(script))
  ok('剧本页没有残留的裸 openIds useState（改了状态源就别留旧声明）',
    !/const \[openIds, setOpenIds\] = useState<string\[\]>/.test(script))
}

console.log(`\n—— tavernCardFold 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
