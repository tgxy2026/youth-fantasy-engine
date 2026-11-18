// ============ 文本指纹 / 字节数：唯一实现（3.6.1 死代码专项） ============
//
// 背景：`stableHash` 曾在 `audit/repetition` 与 `tasks/unitLedger` **各一份、逐字节相同**；
// `utf8Bytes` 也是两份（一份带 TextEncoder 兜底、一份没有）。两份同算法只会"修一处漏一处"，
// 尤其台账里存过散列值 —— 哪天一边改了口径，去重与台账就互相不认。
//
// 这里钉四件事：
//   ① 散列值**跨版本稳定**（历史台账依赖它，格式固定 8 位 hex + 长度 hex）；
//   ② UTF-8 字节按真实编码算（中文 3 字节、emoji 4 字节，不能按 JS 字符数）；
//   ③ 两个原模块仍按原路径导出（公开 API 不变），内部实现只有一份；
//   ④ 源码闸：原模块里不许再出现本地实现（防再次分裂）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { stableHash, utf8Bytes } from '../src/lib/app/textDigest'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8')

function main() {
  // ① 散列：格式与历史真值（换算法会让已存的台账值失配）
  {
    ok('空串 = 偏移基址 + 长度 0', stableHash('') === '811c9dc5-0', stableHash(''))
    ok('单字符真值稳定', stableHash('a') === 'e40c292c-1', stableHash('a'))
    ok('四字符真值稳定', stableHash('abcd') === 'ce3479bd-4', stableHash('abcd'))
    ok('中文真值稳定', stableHash('青春幻想引擎') === 'a53d1d25-6', stableHash('青春幻想引擎'))
    ok('格式恒为「8 位 hex-长度 hex」', /^[0-9a-f]{8}-[0-9a-f]+$/.test(stableHash('随便一段文字')), stableHash('随便一段文字'))
    ok('确定性：同样输入同样输出', stableHash('同一段') === stableHash('同一段'))
    ok('不同输入不同指纹（相邻改一个字）', stableHash('第1章') !== stableHash('第2章'))
  }

  // ② UTF-8 字节
  {
    ok('空串 0 字节', utf8Bytes('') === 0)
    ok('ASCII 1 字节', utf8Bytes('a') === 1)
    ok('中文一字 3 字节', utf8Bytes('中文') === 6)
    ok('emoji 4 字节（按码点，不按代理对）', utf8Bytes('😀') === 4)
    ok('中英混排累加', utf8Bytes('a中') === 4, String(utf8Bytes('a中')))
  }

  // ③ 原路径仍可用（re-export），且实现只有一份
  {
    const repetition = read('src/lib/audit/repetition.ts')
    const ledger = read('src/lib/tasks/unitLedger.ts')
    ok('repetition 从 textDigest 导出', repetition.includes("export { stableHash } from '@/lib/app/textDigest'"))
    ok('unitLedger 从 textDigest 导出 stableHash', ledger.includes("export { stableHash } from '@/lib/app/textDigest'"))
    ok('unitLedger 从 textDigest 导出 utf8Bytes', ledger.includes("export { utf8Bytes } from '@/lib/app/textDigest'"))
    ok('🔴 源码闸：repetition 不再有本地 stableHash 实现', !/function stableHash\(/.test(repetition))
    ok('🔴 源码闸：unitLedger 不再有本地实现', !/function (stableHash|utf8Bytes)\(/.test(ledger))
    ok('🔴 源码闸：textDigest 自身零依赖（任务叶子不会被拖重依赖）',
      !/^import\s/m.test(read('src/lib/app/textDigest.ts')))
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} textDigest ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main()
