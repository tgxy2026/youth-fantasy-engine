// 3.1.1 · 章节规划板展示判据：状态与正文不一致的提示（🔴 只提示，绝不自动改状态）
import type { Chapter } from '../src/lib/types'
import { chapterStatusMismatch, OUTLINE_STATUS_WORDS } from '../src/lib/app/chapterBoardView'

let failures = 0
function check(name: string, condition: boolean) {
  if (condition) console.log(`PASS ${name}`)
  else { failures++; console.error(`FAIL ${name}`) }
}

type Input = Pick<Chapter, 'status' | 'content' | 'wordCount'>
const mk = (over: Partial<Input> = {}): Input => ({ status: '草稿', content: '', wordCount: 0, ...over })

check('阈值与规划书口径一致（2000 字）', OUTLINE_STATUS_WORDS === 2000)

// ---- ① 已完成状态却正文为空 ----
check('完稿 + 空正文 ⇒ 提示', !!chapterStatusMismatch(mk({ status: '完稿' })))
check('已发布 + 空正文 ⇒ 提示', !!chapterStatusMismatch(mk({ status: '已发布' })))
check('提示文案点明是哪个状态', (chapterStatusMismatch(mk({ status: '已发布' })) ?? '').includes('已发布'))
check('完稿 + 有正文 ⇒ 不提示', chapterStatusMismatch(mk({ status: '完稿', content: '正文', wordCount: 2 })) === null)
check('纯空白正文也算空（完稿 ⇒ 提示）', !!chapterStatusMismatch(mk({ status: '完稿', content: '  \n\t ' })))
check('草稿 + 空正文 ⇒ 不打扰', chapterStatusMismatch(mk({ status: '草稿' })) === null)
check('细纲 + 空正文 ⇒ 不打扰', chapterStatusMismatch(mk({ status: '细纲' })) === null)

// ---- ② 状态停在构思，正文却写了不少 ----
check('构思 + 无正文 ⇒ 不提示', chapterStatusMismatch(mk({ status: '构思', wordCount: 0 })) === null)
check('构思 + 差一点（1999 字）⇒ 不提示', chapterStatusMismatch(mk({ status: '构思', content: 'x', wordCount: OUTLINE_STATUS_WORDS - 1 })) === null)
check('构思 + 刚好到线（2000 字）⇒ 提示', !!chapterStatusMismatch(mk({ status: '构思', content: 'x', wordCount: OUTLINE_STATUS_WORDS })))
check('构思 + 数千字 ⇒ 提示且带上字数', (chapterStatusMismatch(mk({ status: '构思', content: 'x', wordCount: 5200 })) ?? '').includes('5200'))
check('构思 + 正文为空但字数滞后 ⇒ 不误报', chapterStatusMismatch(mk({ status: '构思', content: '', wordCount: 5200 })) === null)

// ---- 文案口径：是事实陈述，不是替作者下结论 ----
for (const bad of ['没写完', '未完成', '应该', '建议修改']) {
  const texts = [
    chapterStatusMismatch(mk({ status: '完稿' })),
    chapterStatusMismatch(mk({ status: '构思', content: 'x', wordCount: 5000 })),
  ]
  check(`提示文案不含判断词「${bad}」`, texts.every(t => !(t ?? '').includes(bad)))
}

if (failures) process.exit(1)
