// ============ 2.9.2 · ① 模型名筛选（lib/modelFilter.ts） ============
//
// 覆盖：空关键词原样返回（**且引用不变**）/ 忽略大小写 / 子串命中（非前缀）/
//      空格分隔多词按「全部命中」（AND，不是 OR）/ 命中为空 / 不改动入参。
//
// 🔴 为什么要给这么小的函数写测试：它服务的是「中转站几百个模型」的场景 ——
//    筛选错一位，作者就得在几百项里翻半天，而 bug 本身不会报错、只是"找不到"。
import { filterModels } from '../src/lib/modelFilter'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ modelFilter')

const LIST = [
  'qwen3-32b-instruct',
  'Qwen3.5-35B-A3B',
  'deepseek-ai/DeepSeek-V3.2',
  'gemma-4-31b-mm:latest',
  'agents-a1-4b-work:latest',
  'qwen3.5-27b',
]

// ---------- ① 空关键词：原样返回，且**引用不变** ----------
// 引用不变是有意的：列表每次渲染都会调它，返回同一引用 React 才能跳过重渲染。
{
  ok('空关键词 ⇒ 原样返回', filterModels(LIST, '') === LIST)
  ok('纯空白也算空关键词', filterModels(LIST, '   ') === LIST)
}

// ---------- ② 忽略大小写 ----------
{
  const out = filterModels(LIST, 'QWEN')
  ok('忽略大小写：QWEN ⇒ 命中 3 个 qwen 系', out.length === 3, String(out.length))
  ok('大小写写法不同、结果一致', filterModels(LIST, 'qwen').join(',') === out.join(','))
}

// ---------- ③ 子串命中（不是前缀匹配） ----------
{
  ok('子串命中：32b ⇒ 命中 qwen3-32b-instruct',
    filterModels(LIST, '32b').includes('qwen3-32b-instruct'))
  ok('子串命中：v3.2 ⇒ 只命中 deepseek（忽略大小写）',
    filterModels(LIST, 'v3.2').length === 1,
    JSON.stringify(filterModels(LIST, 'v3.2')))
}

// ---------- ④ 多词 = 全部命中（AND） ----------
{
  const out = filterModels(LIST, 'qwen 32b')
  ok('多词全部命中：qwen 32b ⇒ 只剩 qwen3-32b-instruct',
    out.length === 1 && out[0] === 'qwen3-32b-instruct', JSON.stringify(out))
  ok('多词里有一段不命中 ⇒ 排除（不是 OR）',
    filterModels(LIST, 'qwen 不存在的词').length === 0)
  ok('多词的顺序无关', filterModels(LIST, '32b qwen').join(',') === out.join(','))
}

// ---------- ⑤ 命中为空 ----------
{
  ok('无匹配 ⇒ 空数组', filterModels(LIST, 'zzz-not-exist').length === 0)
}

// ---------- ⑥ 纯函数：不改动入参 ----------
{
  const before = LIST.join(',')
  filterModels(LIST, 'qwen')
  ok('不改动入参（纯函数）', LIST.join(',') === before)
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
