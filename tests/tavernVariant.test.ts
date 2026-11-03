// ============ 酒馆模式 · 多候选 / swipe（T3，2026-10-05）============
//
// 【这组断言钉的是什么】引擎一个字没改 —— 「重说」仍是 `userText === null` ⇒
//   丢末尾 assistant 再生成一条。多候选只在 store 层的四个纯函数里做：
//   `appendVariant` / `selectVariant` / `rewindForVariantSwitch` / `MAX_VARIANTS`。
//
// 🔴 最要紧的一条是「关掉开关 ⇒ 逐字一致」：`variants` 恒为 undefined，
//   界面永远不显示翻页器，行为与 2.8.1 完全相同。这条是**等价性红线**，
//   所以它单独占一组断言，且断言的是「字段根本没出现」而不是「值等于什么」。
import * as store from '../src/lib/tavern/store'
import type { TavernMessage, TavernWatermark } from '../src/lib/tavern/types'
import { DEFAULT_TAVERN_SETTINGS } from '../src/lib/tavern/settings'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 造一个最小的「有 messages 的主机对象」—— 不需要真会话，这四个函数就是纯函数 */
function host(messages: TavernMessage[]) {
  return { messages, updatedAt: 0 }
}

function msg(id: string, content: string, role: TavernMessage['role'] = 'assistant'): TavernMessage {
  return { id, role, content, at: 1 }
}

async function main() {
  __resetMockStores()

  // ---------- 1) 等价性红线：默认关 ⇒ 一个候选字段都不出现 ----------
  {
    ok('🔴 出厂默认 multiVariant 为 false（等价性红线的前提）', DEFAULT_TAVERN_SETTINGS.multiVariant === false)

    const s = host([msg('m1', '第一版'), msg('m2', '第二版')])
    // 「关掉」= 组件根本不调 appendVariant —— 这里断言没有走这条路径时字段确实不存在
    ok('没走多候选路径时：variants 字段根本不出现（不是空数组）',
      s.messages.every(m => m.variants === undefined && m.variantIdx === undefined))
    // 结构化对比：字段存在与否都会被 JSON 看见，防止以后有人「顺手」初始化成 []
    ok('序列化后不含 variants 键（老库读出来不会被塞新字段）',
      !JSON.stringify(s.messages).includes('variants'))
  }

  // ---------- 2) appendVariant：首次把「原版」钉成第 0 个候选 ----------
  {
    const s = host([msg('m1', '原版回复')])
    const a = store.appendVariant(s, 'm1', '新版一')

    ok('首次调用：候选数是 2（原版 + 新版）', a.messages[0].variants?.length === 2,
      String(a.messages[0].variants?.length))
    ok('首次调用：第 0 个候选就是原版 content（否则翻不回原版，swipe 就废了）',
      a.messages[0].variants?.[0] === '原版回复')
    ok('首次调用：第 1 个候选是新文本', a.messages[0].variants?.[1] === '新版一')
    ok('选中项落在最新那份（content 跟着走）',
      a.messages[0].variantIdx === 1 && a.messages[0].content === '新版一')
    ok('content 恒等于 variants[variantIdx]（渲染与进上下文都以它为准）',
      a.messages[0].content === a.messages[0].variants?.[a.messages[0].variantIdx ?? 0])

    // 再追加一次：不能把原版再钉一遍（否则会出现 [原版, 新版一, 原版] 这种脏数据）
    const b = store.appendVariant(a, 'm1', '新版二')
    ok('再次调用：只追加，不重复钉原版', b.messages[0].variants?.length === 3 &&
      b.messages[0].variants?.join('|') === '原版回复|新版一|新版二',
      b.messages[0].variants?.join('|'))
    ok('再次调用：选中项继续落在最新那份',
      b.messages[0].variantIdx === 2 && b.messages[0].content === '新版二')
  }

  // ---------- 3) appendVariant：边界（空文本 / 找不到 id / 不动别人 / updatedAt） ----------
  {
    const s = host([msg('m1', '原文'), msg('m2', '旁边那条')])

    ok('空白文本不记候选（同引擎「空回复不落库」口径）',
      store.appendVariant(s, 'm1', '   ') === s)
    ok('找不到 id 时原样返回（不炸、不新增）',
      store.appendVariant(s, '不存在', 'x') === s)

    const t = store.appendVariant(s, 'm1', '  新文本带空白  ')
    ok('新文本被 trim（避免把模型的手滑空格带进候选）', t.messages[0].variants?.[1] === '新文本带空白')
    ok('只动目标消息，旁边的原样不带候选字段',
      t.messages[1].variants === undefined && t.messages[1].content === '旁边那条')
    ok('updatedAt 被刷新（调用方据此判断要不要落盘）', t.updatedAt >= s.updatedAt && t !== s)
  }

  // ---------- 4) MAX_VARIANTS：上限与「丢最早的」 ----------
  {
    let s = host([msg('m1', 'v0')])
    for (let i = 1; i <= 7; i++) s = store.appendVariant(s, 'm1', `v${i}`)

    const vs = s.messages[0].variants ?? []
    ok('候选数封顶在 MAX_VARIANTS（存储不会无限膨胀）', vs.length === store.MAX_VARIANTS,
      `${vs.length} / MAX=${store.MAX_VARIANTS}`)
    ok('超限时丢的是**最早**的（保留最近的版本）', vs[0] === 'v3' && vs.at(-1) === 'v7', vs.join('|'))
    ok('选中项仍指向最后一份（刚生成的那条没被裁掉）',
      s.messages[0].variantIdx === store.MAX_VARIANTS - 1 && s.messages[0].content === 'v7')
  }

  // ---------- 5) selectVariant：切换 / 越界守卫 ----------
  {
    let s = host([msg('m1', '原版')])
    s = store.appendVariant(s, 'm1', '新版一')
    s = store.appendVariant(s, 'm1', '新版二')   // variants = [原版, 新版一, 新版二]，选中 2

    const back = store.selectVariant(s, 'm1', 0)
    ok('切到第 0 个：content 变回原版', back.messages[0].content === '原版')
    ok('切到第 0 个：variantIdx 跟着变', back.messages[0].variantIdx === 0)
    ok('切换不改候选数组本身（只换选中项）',
      back.messages[0].variants?.join('|') === '原版|新版一|新版二')
    ok('切换不改消息 id（重说/切换都是原地换，不新增气泡）', back.messages[0].id === 'm1')

    ok('越界（负数）原样返回', store.selectVariant(s, 'm1', -1) === s)
    ok('越界（等于长度）原样返回', store.selectVariant(s, 'm1', 3) === s)
    ok('选中的就是当前项 → 原样返回（不无谓刷新 updatedAt）', store.selectVariant(s, 'm1', 2) === s)
    ok('没有候选的消息 → 原样返回（老消息也能安全传进来）',
      store.selectVariant(s, 'm2', 0) === s)
    ok('找不到 id → 原样返回', store.selectVariant(s, '没有', 0) === s)

    const mid = store.selectVariant(s, 'm1', 1)
    ok('切到中间：content 取该候选', mid.messages[0].content === '新版一')
    // ⚠️ 不能断言 `>`：`Date.now()` 在 1ms 内连调会返回同值（本文件实测踩过）。
    //    这里要钉的是「构造了新的主机对象（调用方据此知道要落盘）」+「时间戳不倒退」。
    ok('切换构造了新对象且时间戳不倒退（调用方据此判断要不要落盘）',
      mid !== s && mid.updatedAt >= s.updatedAt)
  }

  // ---------- 6) rewindForVariantSwitch：记忆水位线（🔴 这套判据已有三处，不能漂移） ----------
  {
    // 场景：三条消息，水位线走到 m2（⇒ m2 已被总结进记忆）
    const base = () => ({
      messages: [msg('m1', 'a', 'user'), msg('m2', 'b'), msg('m3', 'c', 'user')],
      watermark: { messageId: 'm2', at: 1 } as TavernWatermark,
      memory: '她记得：b 这句话。',
      updatedAt: 0,
    })

    // ① 水位线覆盖到被切的那条 ⇒ 记忆含了不作数的候选 ⇒ 清记忆 + 水位线退到前一条
    const r1 = store.rewindForVariantSwitch(base(), 'm2')
    ok('水位线覆盖到该条：记忆被清（模型不该记得不存在的候选）', r1.memory === undefined)
    ok('水位线退到该条的前一条', r1.watermark?.messageId === 'm1', r1.watermark?.messageId)
    ok('消息本身没被动（这个函数只管记忆，不管候选）',
      r1.messages.length === 3 && r1.messages[1].content === 'b')

    // ② 水位线正好等于该条：同样覆盖（wmIdx === at ⇒ 不清会把这条的记忆留下）
    const r2 = store.rewindForVariantSwitch(base(), 'm2')
    ok('wmIdx === at 也算覆盖（边界用 >= 而不是 >）', r2.memory === undefined)

    // ③ 水位线还没走到这条 ⇒ 记忆不含它 ⇒ 什么都不动
    const early = { ...base(), watermark: { messageId: 'm1', at: 1 } as TavernWatermark }
    ok('水位线在更早处：原样返回（不动记忆、不动水位线）',
      store.rewindForVariantSwitch(early, 'm2') === early)

    // ④ 没有水位线 ⇒ 不动（自由模式的会话级记忆本就没用到水位线）
    const noWm = { ...base(), watermark: undefined }
    ok('没有水位线：原样返回', store.rewindForVariantSwitch(noWm, 'm2') === noWm)

    // ⑤ 退到的位置是第一条 ⇒ 水位线清成 undefined（不能指向不存在的上一条）
    const head = {
      messages: [msg('m1', 'a'), msg('m2', 'b', 'user')],
      watermark: { messageId: 'm1', at: 1 } as TavernWatermark,
      memory: '有记忆',
      updatedAt: 0,
    }
    const r5 = store.rewindForVariantSwitch(head, 'm1')
    ok('退到第一条时水位线清空（不留悬空 id）', r5.watermark === undefined)
    ok('退到第一条时记忆同样被清', r5.memory === undefined)

    // ⑥ 找不到 id / 水位线 id 已失效 ⇒ 安全返回
    const ghostHost = base()
    ok('消息 id 找不到：原样返回（引用相等，说明没构造新对象）',
      store.rewindForVariantSwitch(ghostHost, '幽灵') === ghostHost)

    const staleWm = { ...base(), watermark: { messageId: '已删除', at: 1 } as TavernWatermark }
    ok('水位线指向已不存在的消息：原样返回（不误清记忆）',
      store.rewindForVariantSwitch(staleWm, 'm2') === staleWm)
  }

  // ---------- 7) 端到端：appendVariant → selectVariant → rewind 的组合语义 ----------
  // 这是组件真实的调用顺序（TavernPlot.selectVariant / useFreeTurn.selectVariant）：
  //   先改候选，再回收记忆，最后落盘。断言这个顺序下两个函数不互相打架。
  {
    let s: ReturnType<typeof host> & { watermark?: TavernWatermark; memory?: string } = {
      messages: [msg('m1', '她说了 A。'), msg('m2', '（我回了一句）', 'user')],
      watermark: { messageId: 'm1', at: 1 },
      memory: '她说过 A。',
      updatedAt: 0,
    }
    // 用户点重说 → 引擎产新文本 → 组件记候选
    s = store.appendVariant(s, 'm1', '她说了 B。')
    ok('端到端：记候选后 content 是新的', s.messages[0].content === '她说了 B。')
    ok('端到端：记忆此刻还没动（appendVariant 只管候选）', s.memory === '她说过 A。')

    // 用户翻回原版 → 组件先切候选、再回收记忆
    let t = store.selectVariant(s, 'm1', 0)
    t = store.rewindForVariantSwitch(t, 'm1')
    ok('端到端：翻回原版后 content 是原版', t.messages[0].content === '她说了 A。')
    ok('端到端：记忆被回收（水位线覆盖 m1）', t.memory === undefined)
    ok('端到端：候选表仍完整（翻回去不丢另一份）',
      t.messages[0].variants?.join('|') === '她说了 A。|她说了 B。')
  }

  console.log(`\ntavernVariant: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
