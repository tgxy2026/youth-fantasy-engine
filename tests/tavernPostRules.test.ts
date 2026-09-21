// ============ 酒馆模式 · 输出后处理规则（B3）============
//
// 这一层的价值在于「确定」：协议写死了格式，但实测总有模型不听话（半角括号、*动作*、
// 行首「角色名：」）。与其重跑一次去赌，不如按规则修一遍 —— 便宜、可解释、可测。
//
// 测试重点：
//   ① 出厂规则的**顺序**（去 markdown 必须先于星号动作，否则 `**动作**` 会被拆坏；括号后换行须在星号动作之后）；
//   ② 不误伤正常输出（协议合规的文本跑完一个字不变）；
//   ③ 出错不能静默：正则写错要记进 errors，其余规则照跑；
//   ④ 格式规则（去空行 / 括号后换行）真实修得了「描写与对白杂糅在一行」「空行」两类问题。
import { DEFAULT_POST_RULES, applyPostRules, normalizePostRules, previewPostRules, type PostRule } from '../src/lib/tavern/postRules'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const run = (text: string, rules: PostRule[] = DEFAULT_POST_RULES) => applyPostRules(text, rules)

function main() {
  // ---------- 1) 出厂规则 ----------
  {
    ok('出厂共六条', DEFAULT_POST_RULES.length === 6, String(DEFAULT_POST_RULES.length))
    ok('默认开五条（说话人标签那条默认关 —— 它是唯一会删字的规则）',
      DEFAULT_POST_RULES.filter(r => r.enabled).length === 5,
      DEFAULT_POST_RULES.filter(r => r.enabled).map(r => r.name).join('、'))
    ok('四条都有名字与正则', DEFAULT_POST_RULES.every(r => r.name && r.pattern))
    const iMd = DEFAULT_POST_RULES.findIndex(r => r.id === 'pr-strip-markdown')
    const iStar = DEFAULT_POST_RULES.findIndex(r => r.id === 'pr-star-action')
    ok('🔴 顺序：去 markdown 排在星号动作之前（顺序反了会把 **动作** 拆坏）', iMd >= 0 && iMd < iStar, `${iMd} vs ${iStar}`)
    ok('id 唯一', new Set(DEFAULT_POST_RULES.map(r => r.id)).size === DEFAULT_POST_RULES.length)
  }

  // ---------- 2) 逐条效果 ----------
  {
    ok('半角括号 → 全角', run('(她点了点头。)').text === '（她点了点头。）', run('(她点了点头。)').text)
    ok('已经全角的括号不动（不重复转换）', run('（她点头。）').text === '（她点头。）')
    ok('**加粗** 去装饰', run('**（他把烟按灭）**').text === '（他把烟按灭）', run('**（他把烟按灭）**').text)
    ok('行内 `代码` 去反引号', run('写了 `三` 个字。').text === '写了 三 个字。', run('写了 `三` 个字。').text)
    ok('markdown 标题井号去掉', run('## 第一场').text === '第一场', run('## 第一场').text)
    ok('*星号动作* → （动作）', run('*他把烟按灭*').text === '（他把烟按灭）', run('*他把烟按灭*').text)
    const withLabel = DEFAULT_POST_RULES.map(r => (r.id === 'pr-speaker-label' ? { ...r, enabled: true } : r))
    ok('（打开后）行首「名字：」被去掉', run('洛汐：你来了。', withLabel).text === '你来了。', run('洛汐：你来了。', withLabel).text)
    ok('英文名标签也认', run('Alice: 你来了。', withLabel).text === '你来了。', run('Alice: 你来了。', withLabel).text)
    ok('🔴 出厂默认下它不跑：会误伤的正常叙述一个字都不动',
      run('他说：你来了。').text === '他说：你来了。' && run('注意：不要碰那台机器。').text === '注意：不要碰那台机器。',
      run('他说：你来了。').text)
  }

  // ---------- 3) 组合与顺序 ----------
  {
    const messy = ['（她点了点头。）', '**(他把烟按灭)**', '*把伞立在门口*', '洛汐：你来了。'].join('\n')
    const all4 = DEFAULT_POST_RULES.map(r => ({ ...r, enabled: true }))
    const r = run(messy, all4)
    ok('一段混着四种问题：四条全开时一次全修好', r.text === ['（她点了点头。）', '（他把烟按灭）', '（把伞立在门口）', '你来了。'].join('\n'), JSON.stringify(r.text))
    ok('原三条格式规则都被记为命中（去 markdown / 星号动作 / 说话人标签）',
      r.applied.some(a => a.name.includes('markdown')) && r.applied.some(a => a.name.includes('星号')) && r.applied.some(a => a.name.includes('说话人')),
      r.applied.map(a => a.name).join('、'))
    ok('新加的「去掉空行 / 括号后换行」在此文本上 0 命中（本就没有空行、也没有「）」后紧跟对白，不该误动）',
      !r.applied.some(a => a.name === '去掉空行') && !r.applied.some(a => a.name === '括号后换行'),
      r.applied.map(a => a.name).join('、'))
    ok('没有残留星号', !r.text.includes('*'), r.text)

    // 顺序反过来的反面教材：先处理单星号动作，`**动作**` 会变成 `*（动作）*`
    const reversed = [DEFAULT_POST_RULES[2], DEFAULT_POST_RULES[1], DEFAULT_POST_RULES[0], DEFAULT_POST_RULES[3]]
    const bad = run('**（他把烟按灭）**', reversed)
    ok('🔴 顺序反了会留下孤立星号（所以顺序是硬约束，不是「随便排也行」）', bad.text.includes('*'), bad.text)
  }

  // ---------- 4) 不误伤 ----------
  {
    const clean = ['（她把找零推过来，没看我。）', '你来了。', '【雨声敲着便利店的玻璃，灯管闪了一下。】'].join('\n')
    const r = run(clean)
    ok('协议合规的文本：一个字都不改', r.text === clean, JSON.stringify(r.text))
    ok('且没有任何规则被记为命中（日志里不该全是没生效的项）', r.applied.length === 0)
    ok('空串安全', run('').text === '' && run('').applied.length === 0)
    ok('每条规则都带 note（面板上要显示给作者看）', DEFAULT_POST_RULES.every(r => (r.note ?? '').length > 0))
    ok('默认关的那条 note 里写明了原因（否则作者不知道它为什么是关的）',
      (DEFAULT_POST_RULES.find(r => r.id === 'pr-speaker-label')?.note ?? '').includes('默认关'))
  }

  // ---------- 5) 开关与出错 ----------
  {
    const off = DEFAULT_POST_RULES.map(r => ({ ...r, enabled: false }))
    ok('全部关掉 → 什么都不做', run('(她点头。) **动作** 洛汐：你来了。', off).text === '(她点头。) **动作** 洛汐：你来了。')

    const onlyParen = DEFAULT_POST_RULES.map(r => ({ ...r, enabled: r.id === 'pr-halfwidth-paren' }))
    ok('只开一条 → 只跑那一条', run('(她点头。)\n洛汐：你来了。', onlyParen).text === '（她点头。）\n洛汐：你来了。')

    const broken: PostRule[] = [
      { id: 'x', name: '写坏的正则', pattern: '([', replacement: '', enabled: true },
      { id: 'y', name: '正常规则', pattern: '啊', replacement: '呀', enabled: true },
    ]
    const rb = run('啊', broken)
    ok('🔴 正则写错 → 记进 errors（不能静默失效）', rb.errors.includes('写坏的正则'), rb.errors.join('、'))
    ok('一条坏了不影响其余规则照跑', rb.text === '呀', rb.text)
    ok('坏的那条不进 applied（它不是命中）', !rb.applied.some(a => a.name === '写坏的正则'))

    ok('previewPostRules 与 applyPostRules 同源', previewPostRules('(她点头。)', DEFAULT_POST_RULES).text === '（她点头。）')
  }

  // ---------- 6) 老数据归一化 ----------
  {
    ok('非数组 → 回落出厂六条', normalizePostRules(undefined).length === 6 && normalizePostRules('x').length === 6)
    ok('缺 name → 给兜底名', normalizePostRules([{ pattern: 'a', replacement: 'b' }])[0].name === '未命名规则')
    ok('缺 flags → 默认 gm', normalizePostRules([{ pattern: 'a', replacement: 'b' }])[0].flags === 'gm')
    ok('缺 enabled → 按开处理（老数据不该被静默关掉）', normalizePostRules([{ pattern: 'a', replacement: 'b' }])[0].enabled === true)
    ok('明确 enabled:false → 保留关闭', normalizePostRules([{ pattern: 'a', replacement: 'b', enabled: false }])[0].enabled === false)
    ok('没有正则的条目直接丢（等于没写）', normalizePostRules([{ name: '空的' }, { pattern: 'a', replacement: '' }]).length === 1)
    ok('归一化后能跑', applyPostRules('a', normalizePostRules([{ pattern: 'a', replacement: 'b' }])).text === 'b')
  }

  // ---------- 7) 格式规则：去空行 / 括号后换行 ----------
  {
    const only = (id: string) => DEFAULT_POST_RULES.filter(r => r.id === id)

    // 7.1 去空行：连续换行压成单个换行，保留段落内单换行
    ok('去空行：双换行压成单换行', run('（他点头）\n\n你来了。', only('pr-no-blank-lines')).text === '（他点头）\n你来了。')
    ok('去空行：三换行也压成单换行', run('a\n\n\nb', only('pr-no-blank-lines')).text === 'a\nb')
    ok('去空行：段落内单换行保留', run('（他点头）\n你来了。', only('pr-no-blank-lines')).text === '（他点头）\n你来了。')
    ok('去空行：不误伤正常文本', run('（他点头。）你来了。', only('pr-no-blank-lines')).text === '（他点头。）你来了。')

    // 7.2 括号后换行：解决「描写与对白杂糅在一行」
    ok('括号后换行：描写后跟对白 → 换行', run('（他冷笑）你以为你能逃？', only('pr-break-after-paren')).text === '（他冷笑）\n你以为你能逃？')
    ok('括号后换行：已换行则不重复插', run('（他冷笑）\n你以为你能逃？', only('pr-break-after-paren')).text === '（他冷笑）\n你以为你能逃？')
    ok('括号后换行：连续括号块不断开', run('（动作1）（动作2）对白', only('pr-break-after-paren')).text === '（动作1）（动作2）\n对白')
    ok('括号后换行：反向（对白后跟括号）不拆（规则只管「括号后」）', run('你来了。（他转身离开）', only('pr-break-after-paren')).text === '你来了。（他转身离开）')

    // 7.3 两套默认规则叠加：同时去空行 + 括号后换行，且互不打架
    const fmt = DEFAULT_POST_RULES.filter(r => r.id === 'pr-no-blank-lines' || r.id === 'pr-break-after-paren')
    ok('叠加：空行与杂糅一并修好', run('（他坐下）\n\n\n"坐吧。"', fmt).text === '（他坐下）\n"坐吧。"', run('（他坐下）\n\n\n"坐吧。"', fmt).text)
    ok('叠加：对白接动作块的杂糅被拆开', run('（他拍了拍肩）别怕。', fmt).text === '（他拍了拍肩）\n别怕。')
  }

  console.log(`\ntavernPostRules: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main()
