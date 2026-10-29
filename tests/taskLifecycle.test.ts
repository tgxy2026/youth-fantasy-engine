// ============ 3.3.0 · UX09：任务生命周期与结果呈现的防回归闸 ============
//
// 对应方案 AC26 / AC27 里最容易悄悄退化的两条：
//   ① **关闭界面 ≠ 中止任务**：只有"(退出项目)"和"作者点中止"能 abort；
//      任何面板卸载、抽屉开关、弹窗关闭都不许顺手 abortAllTasks。
//   ② **模型输出里的 HTML 不许被执行**：全库只允许正文高亮叠层用 dangerouslySetInnerHTML，
//      且它的拼接必须逐段 escapeHtml（命中词也要转义）。
// 另加订阅清理的实测：50 次订阅/退订后不残留、不重复通知。
import fs from 'node:fs'
import path from 'node:path'
import { resetTaskCenter, subscribeTasks } from '../src/lib/ai/aiTaskCenter'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
/** 只看**代码**：注释里提到某个 API 名不算使用（本仓注释里到处在讲为什么不用它） */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 递归列出 src 下的 ts/tsx（只看源码，不看测试与构建产物） */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel)
  }
  return out
}

// ---------- ① 订阅：50 次订阅/退订不留尾巴、不重复通知 ----------
{
  const counts = new Array(50).fill(0)
  const offs = counts.map((_, i) => subscribeTasks(() => { counts[i] += 1 }))

  resetTaskCenter() // 一次广播
  ok('🔴 ① 50 个订阅者各收到一次（不漏发）', counts.every(c => c === 1), JSON.stringify(counts.slice(0, 5)))

  offs.forEach(off => off())
  resetTaskCenter() // 退订后再广播
  ok('🔴 ① 全部退订后不再通知（无残留监听）', counts.every(c => c === 1), JSON.stringify(counts.slice(0, 5)))

  // 反复订阅/退订 50 轮后，行为与首次一致（不累积、不重复）
  for (let round = 0; round < 50; round += 1) {
    const off = subscribeTasks(() => { counts[0] += 1 })
    off()
  }
  const before = counts[0]
  resetTaskCenter()
  ok('🔴 ① 反复开关 50 轮后通知次数不累积', counts[0] === before, `${before} → ${counts[0]}`)
}

// ---------- ② 关闭界面 ≠ 中止任务（静态闸） ----------
{
  const files = walk('src')
  const offendersAll = files.filter(f => code(f).includes('abortAllTasks'))
  ok('🔴 ② 只有 App 与任务中心本身能中止全部任务',
    offendersAll.every(f => f === 'src/App.tsx' || f === 'src/lib/ai/aiTaskCenter.ts'),
    JSON.stringify(offendersAll))
  ok('② App 的退出项目路径仍在（不是把中止能力删掉了）', read('src/App.tsx').includes('abortAllTasks()'))

  const components = files.filter(f => f.startsWith('src/components/'))
  const offendersAbort = components.filter(f => /abortTask\(/.test(code(f)))
  // 允许的只有「作者显式点中止」的按钮所在文件；新增文件必须走同一语义
  const allowed = new Set(['src/components/bookbreak/BookBreakPanel.tsx', 'src/components/common/TaskIndicator.tsx'])
  ok('🔴 ② 组件里只有显式「中止」按钮会 abort（面板卸载不许顺手停任务）',
    offendersAbort.every(f => allowed.has(f)), JSON.stringify(offendersAbort.filter(f => !allowed.has(f))))

  // 卸载/关闭路径不许调用 abort*（按常见 close/onClose/unmount 相邻出现判）
  const suspicious = components.filter(f => /return \(\) => \{[^}]*abort/i.test(code(f)))
  ok('🔴 ② 卸载清理里没有 abort 调用', suspicious.length === 0, JSON.stringify(suspicious))
}

// ---------- ③ 模型输出里的 HTML 不许被执行（静态闸） ----------
{
  const files = walk('src')
  const rawHtml = files.filter(f => code(f).includes('dangerouslySetInnerHTML'))
  ok('🔴 ③ 全库只有正文高亮叠层用 dangerouslySetInnerHTML',
    rawHtml.length === 1 && rawHtml[0] === 'src/components/editor/NovelEditor.tsx', JSON.stringify(rawHtml))

  const helper = read('src/components/editor/novelEditorHelpers.ts')
  ok('🔴 ③ 高亮拼接逐段转义（普通文本）', /escapeHtml\(text\.slice\(/.test(helper))
  ok('🔴 ③ 高亮拼接逐段转义（命中词本身也转义）', /escapeHtml\(m\[0\]\)/.test(helper))
  ok('🔴 ③ 超长正文走整体转义分支（不拼裸 HTML）',
    /text\.length > HIGHLIGHT_MAX_LEN\) return \{ html: escapeHtml\(text\)/.test(helper))

  // AI 结果渲染不许走 HTML：mdLite 的口径要留住
  const mdLite = code('src/lib/storage/mdLite.ts')
  ok('🔴 ③ 轻量 Markdown 的代码里确实没有 HTML 注入', !mdLite.includes('dangerouslySetInnerHTML'))
  ok('🔴 ③ 轻量 Markdown 没有返回 html 字段（调用方只能按文本渲染）',
    !/export function .*\):\s*\{[^}]*html/.test(mdLite))
}

console.log(`\n———— taskLifecycle：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exitCode = 1
