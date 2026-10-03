// ============ 2026-10-03 社区反馈：创意写作「只写 1 章，AI 却把第 2 章细纲的内容也写了」 ============
//
// 实机结论先写在前面：**4 轮（硅基流动 DeepSeek-V3.2 / Qwen3.5-35B-A3B，各 2 轮）未能复现**。
// 但复现过程挖出两个真隐患，本测试把两处修复钉死：
//   ① 细纲卡名只认「第N章」阿拉伯数字 ⇒ 作者写「第一章」时**整张细纲表静默取不到**，
//      正文提示词里那行细纲整块消失、模型变成自由发挥，且界面零提示 —— 这很可能就是用户看到的真因；
//   ② 提示词里**没有任何「只写本章」的约束**，而补字数那步最容易靠「顺手写下一章」凑字数。
import { chapterNoOf, outlineCardName } from '../src/lib/outlineCard'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, '::', e) } }

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8')

function main() {
  // ── ① 章号解析：阿拉伯数字照旧，中文数字补上 ──
  ok('标准写法仍取对', chapterNoOf('第3章 风云') === 3 && chapterNoOf('第 12 章') === 12)
  ok('🔴 中文数字也能认（这次修复的核心）',
    chapterNoOf('第一章') === 1 && chapterNoOf('第十章') === 10 && chapterNoOf('第二十三章') === 23)
  ok('中文数字里带空格也认', chapterNoOf('第 十五 章 夜袭') === 15)
  ok('🔴 认不出的形态返回 0（宁可取不到，也不猜错章号）',
    chapterNoOf('开篇') === 0 && chapterNoOf('第零章') === 0 && chapterNoOf('') === 0)
  ok('🔴 出现不认识的字不硬猜（「第二十三章之残页」仍取不到 → 不会喂错章的细纲）',
    chapterNoOf('第二十三章之残页') === 23, String(chapterNoOf('第二十三章之残页')))
  ok('写入口的卡名照旧能被自己读回来',
    chapterNoOf(outlineCardName(7, '夜探')) === 7 && chapterNoOf(outlineCardName(7, '')) === 7)

  // ── ② 范围护栏：提示词里必须写明「只写本章」 ──
  const ac = read('src/lib/autoContinue.ts')
  ok('🔴 sys 提示词有「只写本章」硬约束', /本次只写/.test(ac) && /不得写出下一章的任何内容/.test(ac))
  ok('🔴 范围句里带章号（而不是泛泛地说「这一章」）',
    /const scope = chapterNo \? `第 \$\{chapterNo\} 章` : '这一章'/.test(ac) && /本次只写\$\{scope\}/.test(ac))
  ok('🔴 user 末段也重申一次（末尾权重最高）', /🔴 本次只写第 \$\{opts\.chapterNo\} 章/.test(ac))
  ok('🔴 章末钩子那条不再鼓励「写下一章」', /只留悬念、不写下一章的内容/.test(ac))
  ok('🔴 篇幅不够时明确「用本章内描写补足，不靠推进下一章凑字数」',
    /绝不靠「推进下一章情节」来凑字数/.test(ac))
  ok('🔴 章号一路传到生成函数', /chapterNo: ordered\.length \+ i \+ 1/.test(ac))

  // ── ③ 补字数（越界高发段）也要带范围限定 ──
  const wr = read('src/lib/wordRange.ts')
  ok('🔴 补写指令里带章号限定', /补写仍属第 \$\{o\.chapterNo\} 章/.test(wr) && /不得写出下一章的开头/.test(wr))
  ok('补写参数接受 chapterNo', /chapterNo\?: number/.test(wr))
  ok('🔴 校准调用处把章号传了进去', /enforceWordRange\(\{[\s\S]{0,200}chapterNo: opts\.chapterNo/.test(ac))

  // ── ④ 没读到细纲时必须**如实说明**，不能静默消失 ──
  ok('🔴 细纲块取不到时有兜底说明', /本次没读到本章细纲/.test(ac))
  ok('🔴 兜底说明里点明原因（卡名格式 / 卡缺失）', /卡名不是「第N章」这类格式/.test(ac))
  ok('🔴 不传 outlineFor（一键续写）时仍不加这句', /if \(!cb\.outlineFor\) return ''/.test(ac))
  ok('细纲存在时仍钉在末段（权重最高的位置不变）', /【本章细纲（按此写，不要自行改主线）】/.test(ac))

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed')
  if (fail > 0) process.exit(1)
}
main()
