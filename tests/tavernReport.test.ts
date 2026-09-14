// ============ 酒馆模式 · 推演报告的 findings 规范化（方案 §6.7）============
//
// 报告的价值全在 findings：**每条必须能指回具体条目**。否则作者拿到的是一堆
// 「感觉有点问题」的废话，没法处理。这组断言盯的就是这条规矩：
//   · 指得回去 → 回填真实记录 id，保留「矛盾 / 漏洞」等级
//   · 指不回去 → 降级为「存疑」并留空 id（绝不硬编一个假 id 让作者点了跳空）
import { normalizeFindings } from '../src/lib/tavern/report'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 模拟生产环境的回表查询：只有 char-main/李默 与 relations/李默→苏念 能找到 */
function makeResolver() {
  const calls: string[] = []
  const resolve = async (tabId: string, label: string): Promise<string | null> => {
    calls.push(`${tabId}::${label}`)
    if (tabId === 'char-main' && label === '李默') return 'rec-limo'
    if (tabId === 'relations' && label === '李默→苏念') return 'rec-rel'
    return null
  }
  return { resolve, calls }
}

async function main() {
  // ---------- 1) 定位成功：保留等级 + 回填真实 id ----------
  {
    const { resolve } = makeResolver()
    const out = await normalizeFindings(
      [{ level: '矛盾', targetTabId: 'char-main', targetLabel: '李默', detail: '年龄与出场章冲突', suggestion: '核对第 3 章' }],
      resolve,
    )
    ok('定位成功时保留原等级（矛盾）', out.length === 1 && out[0].level === '矛盾')
    ok('定位成功时回填真实记录 id', out[0].targetRecordId === 'rec-limo', `实际=${out[0].targetRecordId}`)
    ok('描述与建议原样保留', out[0].detail.includes('年龄') && out[0].suggestion === '核对第 3 章')
  }

  // ---------- 2) 指不回去 → 降级为存疑（核心规矩） ----------
  {
    const { resolve } = makeResolver()
    const out = await normalizeFindings(
      [{ level: '漏洞', targetTabId: 'char-main', targetLabel: '查无此人', detail: '来历没交代' }],
      resolve,
    )
    ok('定位失败时降级为「存疑」', out[0].level === '存疑', `实际=${out[0].level}`)
    ok('降级后不编造 id', out[0].targetRecordId === undefined)
  }

  // ---------- 3) 本来就是存疑：保留，但也尽力定位 ----------
  {
    const { resolve } = makeResolver()
    const miss = await normalizeFindings([{ level: '存疑', targetTabId: 'char-main', targetLabel: '无名氏', detail: '语气怪' }], resolve)
    ok('存疑 + 定位失败：仍是存疑且无 id', miss[0].level === '存疑' && miss[0].targetRecordId === undefined)

    const hitOne = await normalizeFindings([{ level: '存疑', targetTabId: 'char-main', targetLabel: '李默', detail: '语气怪' }], resolve)
    ok('存疑 + 定位成功：等级不变但回填 id（便于作者跳过去看）',
      hitOne[0].level === '存疑' && hitOne[0].targetRecordId === 'rec-limo')
  }

  // ---------- 4) 非白名单表：不查库、清空 tabId、降级 ----------
  {
    const { resolve, calls } = makeResolver()
    const out = await normalizeFindings(
      [{ level: '矛盾', targetTabId: 'not-a-real-table', targetLabel: 'x', detail: 'y' }],
      resolve,
    )
    ok('表不在白名单时不查库（省一次库读）', calls.length === 0, `实际调用=${calls.join(',')}`)
    ok('表不在白名单时清空 targetTabId（UI 不会拿它去跳转）', out[0].targetTabId === '')
    ok('表不在白名单时同样降级为存疑', out[0].level === '存疑')
  }

  // ---------- 5) 缺描述的条目丢弃 ----------
  {
    const { resolve } = makeResolver()
    const out = await normalizeFindings(
      [{ level: '矛盾', targetTabId: 'char-main', targetLabel: '李默' }, { level: '存疑', detail: '  ' }],
      resolve,
    )
    ok('没有描述的条目被丢弃（不留空壳条目）', out.length === 0, `实际=${out.length}`)
  }

  // ---------- 6) 等级解析容错 ----------
  {
    const { resolve } = makeResolver()
    // ⚠️ 这几条专测「等级解析」，因此必须给出**可定位**的表与条目：
    // 否则会被「指不回去就降级为存疑」的规矩盖过，测的就不是等级解析了。
    const a = await normalizeFindings(
      [{ level: '严重矛盾', targetTabId: 'char-main', targetLabel: '李默', detail: 'x' }], resolve)
    ok('等级含「矛盾」即识别为矛盾', a[0].level === '矛盾')
    const b = await normalizeFindings(
      [{ level: '逻辑漏洞', targetTabId: 'char-main', targetLabel: '李默', detail: 'x' }], resolve)
    ok('等级含「漏洞」即识别为漏洞', b[0].level === '漏洞')
    const c = await normalizeFindings([{ level: '完全看不懂', detail: 'x' }], resolve)
    ok('等级无法识别时按最保守的「存疑」处理', c[0].level === '存疑')
  }

  // ---------- 7) 中文字段名兜底（模型爱写中文键） ----------
  {
    const { resolve } = makeResolver()
    const out = await normalizeFindings(
      [{ 等级: '漏洞', 表: 'relations', 条目: '李默→苏念', 问题: '关系变化没有交代', 建议: '补一段过渡' }],
      resolve,
    )
    ok('中文键能解析出等级', out[0].level === '漏洞')
    ok('中文键能解析出表与条目并回填 id', out[0].targetRecordId === 'rec-rel' && out[0].targetTabId === 'relations')
    ok('中文键能解析出描述与建议', out[0].detail.includes('过渡') || out[0].suggestion === '补一段过渡')
  }

  // ---------- 8) 空输入 ----------
  {
    const { resolve } = makeResolver()
    ok('空数组返回空结果', (await normalizeFindings([], resolve)).length === 0)
  }

  console.log(`\ntavernReport: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
