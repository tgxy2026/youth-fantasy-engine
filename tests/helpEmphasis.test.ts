// ============ 纯文本强调（`**…**`）============
//
// 起因：2026-11-04 六维审计 §8 抓到帮助文案里的裸星号 —— 帮助中心 / 帮助气泡都是
// `whitespace-pre-wrap` 纯文本渲染，而文案按 markdown 习惯写成 `**Ctrl + Shift + F9**`，
// 作者在界面上看到的是星号本身。
//
// 这条判据的全部风险在「宁可显示星号，也不能吞字」，所以落单 / 空强调一律原样输出；
// 另外必须保证换行、空格、中文标点逐字不变（帮助文案靠 `\n` 排版）。
import fs from 'node:fs'
import path from 'node:path'
import { splitEmphasis } from '../src/lib/text/emphasis'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
const join = (text: string) => splitEmphasis(text).map(p => p.text).join('')
const strongs = (text: string) => splitEmphasis(text).filter(p => p.strong).map(p => p.text)

// ---------- ① 成对强调 ----------
{
  const parts = splitEmphasis('默认候选是 **Ctrl + Shift + F9**，另有 F10 / F11。')
  ok('成对 ** 切出三段', parts.length === 3, JSON.stringify(parts))
  ok('中间段是强调', parts[1].strong === true && parts[1].text === 'Ctrl + Shift + F9')
  ok('两侧不是强调', parts[0].strong === false && parts[2].strong === false)
  ok('拼回去与原文等长（只去掉 4 个星号）', join('默认候选是 **Ctrl + Shift + F9**，另有 F10 / F11。') === '默认候选是 Ctrl + Shift + F9，另有 F10 / F11。')
}

// ---------- ② 一段里多处强调 ----------
{
  const text = '**批量导入**（粘贴表格）、**导出 CSV**，都是「更多」里的。'
  ok('两处强调都识别', JSON.stringify(strongs(text)) === JSON.stringify(['批量导入', '导出 CSV']), JSON.stringify(strongs(text)))
  ok('多段拼回无损', join(text) === '批量导入（粘贴表格）、导出 CSV，都是「更多」里的。')
}

// ---------- ③ 落单 / 空强调：原样输出（核心安全判据）----------
{
  for (const text of ['a ** b', '**开头没结尾', '结尾没开头 **', '**', '****', '**a** 中间 **b', '2 ** 3 = 8 的笔误']) {
    const parts = splitEmphasis(text)
    ok(`落单/空强调原样保留：${JSON.stringify(text)}`, parts.length === 1 && parts[0].strong === false && parts[0].text === text,
      JSON.stringify(parts))
  }
}

// ---------- ④ 不含星号：零成本直通 ----------
{
  const text = '第一行\n第二行 · 带中文标点「」，与空格。'
  const parts = splitEmphasis(text)
  ok('无星号只返回一段', parts.length === 1 && !parts[0].strong)
  ok('换行与空格逐字保留', parts[0].text === text)
  ok('空串不抛', splitEmphasis('').length === 1)
}

// ---------- ⑤ 强调里允许换行与标点 ----------
{
  const text = 'A\n**第一行\n第二行**\nB'
  const parts = splitEmphasis(text)
  ok('强调段内的换行不被吃掉', parts[1].text === '第一行\n第二行', JSON.stringify(parts))
  ok('全文拼回一致', join(text) === 'A\n第一行\n第二行\nB')
}

// ---------- ⑥ 接线：三处纯文本入口必须走同一个渲染器 ----------
{
  const center = read('src/components/help/HelpCenter.tsx')
  ok('帮助中心正文段落走 EmphasisText', center.includes('<EmphasisText text={paragraph} />'))
  ok('帮助中心摘要走 EmphasisText', center.includes('<EmphasisText text={article.summary} />'))
  const pop = read('src/components/common/HelpPopover.tsx')
  ok('帮助气泡的字符串内容走 EmphasisText', pop.includes("typeof children === 'string' ? <EmphasisText text={children} />"))
  ok('帮助气泡的非字符串内容不被误转（保留 ReactNode）', pop.includes(': children}</div>'))

  // 通用对话框 / Toast 保持纯文本：文案里不许再出现裸 **（2026-11-04 修掉的两处）
  const dialog = read('src/components/dialogs/dialogs.tsx')
  ok('确认框仍是纯文本渲染（不引入富文本语义）', dialog.includes('whitespace-pre-line">{message}</div>'))
  ok('云同步删除确认不再有裸星号', !read('src/components/app/CloudSyncPanel.tsx').includes('**不受影响**'))
  ok('变化清单确认不再有裸星号', !read('src/components/audit/ManuscriptCheckPanel.tsx').includes('**不会发送**'))
}

// ---------- ⑦ 帮助文案确实是这个格式（防止渲染器变成没人用的死代码）----------
{
  const articles = fs.readdirSync(path.join(process.cwd(), 'src/lib/help/articles'))
    .filter(f => f.endsWith('.ts'))
  const withStars = articles.filter(f => /\*\*[^*\n]+\*\*/.test(read(`src/lib/help/articles/${f}`)))
  ok('至少有一篇帮助文章的正文/摘要含 **强调**', withStars.length > 0, withStars.join(','))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
