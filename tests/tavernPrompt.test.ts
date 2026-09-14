// ============ 酒馆模式 · 提示词组装 / 预算裁剪 / 参数继承（纯函数）============
//
// 这一层没有 UI、没有 IO，是全模块最该被测试锁住的部分。
// 尤其两条**踩过坑**的性质：
//   1) 五层顺序 —— 协议必须钉开头、格式提醒必须钉末尾（注意力首尾权重最高）
//   2) 参数改名 —— 内部 repeatPenalty 到 Ollama 那边叫 repeat_penalty（少个 ition）
import { buildSystemPrompt, buildOpeningMessage, buildMultiCharRule, toChatMessages } from '../src/lib/tavern/prompt'
import { trimHistory, historyBudget, budgetState, FIXED_OVERHEAD_CHARS } from '../src/lib/tavern/budget'
import { resolveParams, toOllamaOptions } from '../src/lib/tavern/params'
import type { TavernMessage } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function main() {
  // ---------- 1) 五层顺序 ----------
  {
    const sys = buildSystemPrompt({
      tone: 'narrative', setting: '沧澜山门规', memory: '她记得你救过她', self: '你是李默',
    })
    ok('①协议钉在开头', sys.startsWith('【扮演协议】'))
    ok('②③④层按序出现',
      sys.indexOf('【世界与角色设定】') < sys.indexOf('【长期记忆】') &&
      sys.indexOf('【长期记忆】') < sys.indexOf('【你在戏里的身份与知识边界】'))
    ok('⑤格式提醒钉在末尾（紧贴生成点）', sys.trimEnd().endsWith('写完一个回合就停。'))
    ok('篇幅硬约束写死在格式层（软要求等于没写）', sys.includes('60–160 字'))
    ok('协议里含「只写你自己」（禁止代笔的正面表述）', sys.includes('只写你自己'))
    ok('协议里含元指令通道与冲突仲裁', sys.includes('元指令通道') && sys.includes('冲突仲裁'))
  }

  // ---------- 2) 空层跳过 + 档位 ----------
  {
    const bare = buildSystemPrompt({ tone: 'chat' })
    ok('空层不留空标题', !bare.includes('【世界与角色设定】') && !bare.includes('【长期记忆】'))
    ok('聊天档位用聊天向格式', bare.includes('最多分 2 条发') && !bare.includes('60–160 字'))
    ok('叙事档位用叙事向格式', buildSystemPrompt({ tone: 'narrative' }).includes('60–160 字'))
  }

  // ---------- 3) 未带入资料如实声明 ----------
  {
    const d = buildSystemPrompt({ tone: 'narrative', dropped: ['分卷大纲', '伏笔追踪'] })
    ok('未带入的资料如实声明', d.includes('【未带入的资料】') && d.includes('分卷大纲'))
    ok('声明不挤掉末尾的最后提醒', d.indexOf('【未带入的资料】') < d.indexOf('【最后提醒】'))
  }

  // ---------- 4) 开场消息 ----------
  {
    const om = buildOpeningMessage(
      { place: '沧澜山门', time: '清晨', present: ['李默', '苏念'], description: '风很冷。' },
      '你先开口。',
    )
    ok('开场含场景三要素', om.includes('地点：沧澜山门') && om.includes('时间：清晨') && om.includes('在场：李默、苏念'))
    ok('开场含自由描述与第一句话', om.includes('风很冷。') && om.includes('你先开口。'))
    ok('空表单不产生空行噪音', buildOpeningMessage({ place: '', time: '', present: [], description: '' }, '喂') === '喂')
  }

  // ---------- 5) 多角色发言规则 ----------
  {
    const r = buildMultiCharRule(['苏念', '陆青梧'])
    ok('含「不说话的角色不要替它发言」', r.includes('不要替它发言'))
    ok('含「点名必须接话」', r.includes('必须接话'))
    ok('列出全部参演角色名', r.includes('苏念') && r.includes('陆青梧'))
  }

  // ---------- 6) 消息转换 ----------
  {
    const msgs: TavernMessage[] = [
      { id: '1', role: 'user', content: '你好', at: 1 },
      { id: '2', role: 'assistant', content: '嗯。', at: 2, speakerId: 'c1' },
      { id: '3', role: 'system', content: '（系统）', at: 3 },
    ]
    ok('跳过 system 消息（协议已单独成 system）', toChatMessages(msgs).length === 2)
    ok('不传 withSpeaker 时内容原样', toChatMessages(msgs)[1].content === '嗯。')
    const tagged = toChatMessages(msgs, { withSpeaker: () => '【苏念】' })
    ok('多角色同场时给 assistant 标注说话人', tagged[1].content.startsWith('【苏念】'))
    ok('用户消息不加说话人标记', tagged[0].content === '你好')
  }

  // ---------- 7) 历史裁剪 ----------
  {
    const mk = (n: number, len: number): TavernMessage => ({ id: String(n), role: 'user', content: 'x'.repeat(len), at: n })
    const hist = [mk(1, 100), mk(2, 100), mk(3, 100), mk(4, 100)]

    const t = trimHistory(hist, 250)
    ok('额度不足时裁掉最早的轮次', t.dropped === 2 && t.kept.length === 2, `dropped=${t.dropped} kept=${t.kept.length}`)
    ok('首轮开场永不裁剪', t.kept[0].id === '1')
    ok('保留的是较新的轮次', t.kept[1].id === '4')
    ok('额度充足时不裁', trimHistory(hist, 10000).dropped === 0)
    ok('空历史不报错', trimHistory([], 100).kept.length === 0 && trimHistory([], 100).dropped === 0)
    ok('单条历史不被裁掉', trimHistory([mk(1, 10)], 1).kept.length === 1)
    const zero = trimHistory(hist, 0)
    ok('预算为 0 时只留开场（不返回空）', zero.kept.length === 1 && zero.kept[0].id === '1' && zero.dropped === 3)
  }

  // ---------- 8) 预算计算 ----------
  {
    ok('historyBudget 扣掉固定开销', historyBudget(8000, '', '') === 8000 - FIXED_OVERHEAD_CHARS)
    ok('historyBudget 再扣设定与记忆', historyBudget(8000, 'a'.repeat(100), 'b'.repeat(50)) === 8000 - FIXED_OVERHEAD_CHARS - 150)
    ok('额度不足时下限为 0（不出现负数）', historyBudget(100, 'x'.repeat(500), '') === 0)
    ok('budgetState 算百分比', budgetState(4000, 8000).pct === 50)
    ok('budgetState 封顶 100%', budgetState(99999, 8000).pct === 100)
    ok('total 为 0 时不除零', budgetState(10, 0).pct === 0)
  }

  // ---------- 9) 参数继承 ----------
  {
    ok('剧情默认温度 0.85', resolveParams('plot').temperature === 0.85)
    ok('自由默认温度更松（0.9）', resolveParams('free').temperature === 0.9)
    ok('高层覆盖低层', resolveParams('plot', { temperature: 1.2 }).temperature === 1.2)
    const layered = resolveParams('plot', { temperature: 1.0, topP: 0.5 }, { temperature: 1.2 })
    ok('逐层覆盖：会话参数压过角色参数', layered.temperature === 1.2 && layered.topP === 0.5)
    ok('忽略 undefined 层', resolveParams('plot', undefined, { topK: 7 }).topK === 7)
    ok('非法值（NaN/Infinity）不会污染默认值',
      resolveParams('plot', { temperature: NaN, topP: Infinity }).temperature === 0.85)
  }

  // ---------- 10) Ollama 字段映射（踩过坑的地方）----------
  {
    const o = toOllamaOptions(resolveParams('plot'))
    ok('「重复惩罚」映射为 repeat_penalty（不是 repetition_penalty）',
      'repeat_penalty' in o && !('repetition_penalty' in o), Object.keys(o).join(','))
    ok('存在惩罚映射为 presence_penalty', 'presence_penalty' in o)
    ok('top_p / top_k 命名正确（下划线而非驼峰）', 'top_p' in o && 'top_k' in o && !('topP' in o))
    ok('显式带 num_ctx（否则按全局 128K 加载会爆显存）', o.num_ctx === 32768)
  }

  console.log(`\ntavernPrompt: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main()
