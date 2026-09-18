// ============ 创意写作「体量推荐」的回归用例 ============
//
// 口径是这个模块的全部价值所在，必须被钉住：连写是**一章一次调用**，单章只带「设定 + 最近章节摘要」，
// 所以**章数不撞模型窗口**（这点与拆书同构）；真正受限的是**总耗时**。
// 因此断言不测"最多能写多少章"，只测「推荐章数 / 预计耗时 / 分级 / 字数敏感度」是否算对。
//
// 为什么值得单独守：这个数直接决定作者按哪个按钮 —— 算少了（对本地模型而言）无谓少写，
// 算多了就是"开跑一小时才发现写飘了"。而它错了界面不会报任何错。
import { MAX_CHAPTERS, COMFORT_MINUTES, advisePace } from '../src/lib/writingPace'
import { adviseCapacity } from '../src/lib/modelCapacity'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const LOCAL = adviseCapacity({ type: 'ollama', model: 'qwen3.5-27b' }, { numCtx: 32768, contextBudget: 24000 })
const CLOUD = adviseCapacity({ type: 'openai', local: false, model: 'Qwen/Qwen3.5-35B-A3B' }, { numCtx: 32768, contextBudget: 24000 })

// ---------- ① 本地模型：单章更久 → 推荐更少章 ----------
{
  const a = advisePace(LOCAL, { chapters: 10, targetWords: 2500 })
  ok('本地：单章耗时区间取的是本地档（远高于云端）', a.secPerChapter[1] >= 150, JSON.stringify(a.secPerChapter))
  ok('本地：推荐章数 = 舒适时长 ÷ 单章最慢耗时（保守取慢侧）',
    a.recommendedChapters === Math.floor((COMFORT_MINUTES * 60) / a.secPerChapter[1]), String(a.recommendedChapters))
  ok('本地：推荐值明显少于云端', a.recommendedChapters <= 10, String(a.recommendedChapters))
  ok('本地：预计耗时按**当前填的章数**算（不是推荐值）', a.minutes[1] >= 15, JSON.stringify(a.minutes))
  ok('本地：文案说明了「一次一章、不受窗口限制」', a.note.includes('不受模型窗口限制'), a.note)
  // 🔴 旧口径把连写当成"一章一次调用"，实测是 5~8 次（续写+自检+字数校准+标题+摘要+抽取）——
  //    不写明这一点，作者会以为"写 3 章 = 3 次调用"，等到真跑了一小时才发现预期错了一个数量级
  ok('🔴 文案写明「一章要跑 5~8 次模型调用」（旧口径写成一次，低估 3 倍以上）',
    a.note.includes('5~8 次模型调用'), a.note)
}

// ---------- ② 云端模型：快 → 推荐更多、同样章数更省时 ----------
{
  const local = advisePace(LOCAL, { chapters: 10, targetWords: 2500 })
  const cloud = advisePace(CLOUD, { chapters: 10, targetWords: 2500 })
  ok('云端：单章耗时比本地短', cloud.secPerChapter[1] < local.secPerChapter[1],
    `${cloud.secPerChapter[1]} vs ${local.secPerChapter[1]}`)
  ok('云端：同样 10 章的预计耗时更短', cloud.minutes[1] < local.minutes[1],
    `${cloud.minutes[1]} vs ${local.minutes[1]}`)
  ok('云端：推荐章数不少于本地', cloud.recommendedChapters >= local.recommendedChapters,
    `${cloud.recommendedChapters} vs ${local.recommendedChapters}`)
}

// ---------- ③ 分级：ok / large / long 按"当前值 vs 推荐值"划 ----------
{
  const rec = advisePace(LOCAL, { chapters: 1, targetWords: 2500 }).recommendedChapters
  ok('等于推荐值 → ok', advisePace(LOCAL, { chapters: rec, targetWords: 2500 }).level === 'ok')
  ok('略超推荐值（1.5 倍）→ large',
    advisePace(LOCAL, { chapters: Math.ceil(rec * 1.5), targetWords: 2500 }).level === 'large',
    String(rec))
  ok('远超推荐值（3 倍）→ long',
    advisePace(LOCAL, { chapters: rec * 3, targetWords: 2500 }).level === 'long', String(rec))
  ok('long 的文案会劝"分几轮跑"',
    advisePace(LOCAL, { chapters: rec * 3, targetWords: 2500 }).note.includes('分几轮'),
    advisePace(LOCAL, { chapters: rec * 3, targetWords: 2500 }).note)
  // 口径说明必须每个档位都在 —— 第一版只在 ok 档写，结果最需要它的 large/long 档反而看不到
  ok('🔴 所有档位的文案都带「不受窗口限制」口径',
    [rec, rec * 2, rec * 5].every(n => advisePace(LOCAL, { chapters: n, targetWords: 2500 }).note.includes('不受模型窗口限制')),
    [rec, rec * 2, rec * 5].map(n => advisePace(LOCAL, { chapters: n, targetWords: 2500 }).note).join(' ｜ '))
}

// ---------- ④ 单章字数越大 → 单章越慢、推荐章数越少 ----------
{
  const thin = advisePace(CLOUD, { chapters: 10, targetWords: 1500 })
  const fat = advisePace(CLOUD, { chapters: 10, targetWords: 5000 })
  ok('字数更多 → 单章更慢', fat.secPerChapter[1] > thin.secPerChapter[1],
    `${fat.secPerChapter[1]} vs ${thin.secPerChapter[1]}`)
  ok('字数更多 → 推荐章数更少（或持平）', fat.recommendedChapters <= thin.recommendedChapters,
    `${fat.recommendedChapters} vs ${thin.recommendedChapters}`)
}

// ---------- ⑤ 边界：章数被钳进合法区间，耗时不为 0 ----------
{
  ok('超出上限的章数被钳到 MAX_CHAPTERS',
    advisePace(LOCAL, { chapters: 9999, targetWords: 2500 }).level === 'long', String(MAX_CHAPTERS))
  const zero = advisePace(LOCAL, { chapters: 0, targetWords: 2500 })
  ok('章数 0 / 非法值 → 按 1 章处理（不出现 0 分钟）', zero.minutes[0] >= 1, JSON.stringify(zero.minutes))
  const huge = advisePace(CLOUD, { chapters: MAX_CHAPTERS, targetWords: 8000 })
  ok('极端参数下推荐章数仍 ≥ 1', huge.recommendedChapters >= 1, String(huge.recommendedChapters))
}

// ---------- ⑥ 模型描述被带出来（界面上解释"这个推荐值是按谁算的"） ----------
{
  const a = advisePace(CLOUD, { chapters: 5, targetWords: 2500 })
  ok('带出当前模型的一句话描述', a.model.trim().length > 0, a.model)
}

console.log(`\n—— writingPace 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
