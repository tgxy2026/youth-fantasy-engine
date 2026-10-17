// ============ Button「左对齐」死类名闸（3.1.2）============
//
// 需求口径（主人 2026-10-17）：工作面板 → 写作面板的「章节规划板」折叠态必须**左对齐**
//   （与其它页签一致），不能只有它一个居中难看。
//
// 根因（极隐蔽，值得闸）：
//   Button 基类自带 `justify-center`，而 Button.tsx 拼 className 是**纯字符串拼接**
//   （[...].join(' ')，非 tailwind-merge）⇒ 调用方传 justify-* 时输赢取决于**产物 CSS
//   里两个类的生成顺序**。实测 dist 产物：.justify-between 生成在 .justify-center **之前**
//   ⇒ 基类后来居上，调用方的 justify-between 是**死类名**，整行被居中。
//   既成约定（仓内 25+ 处，AIOrganize / FullTextSearch / Sidebar / NovelEditorChapterTree…）：
//   `!justify-start` / `!justify-between` —— Tailwind v4.3.3 对前缀 ! 兼容，
//   编译成 !important（dist 实测：.\!justify-start{justify-content:flex-start!important}）。
//
// 为什么值得闸：这是**样式 bug**——不报错不崩，只是「难看一下」；且类名写在调用方、
//   肉眼 review 完全看不出是死的。新增折叠头 / 全宽 bare 按钮时最容易再踩。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

console.log('—— collapseHeaderAlign：Button 左对齐死类名闸（3.1.2）——')

// ---------- ① 钉住 Button 基类：justify-center 必须在位 ----------
// 它是一切死类名的源头。若有人给 Button 上 tailwind-merge / 改拼接口，
// 本闸先红，逼着重新审计全仓调用方（约定可能随之失效或可简化）。
{
  const btn = read('src/components/common/Button.tsx')
  ok('① Button 基类仍含 justify-center（死类名源头；改拼接口前先过本闸）',
    btn.includes('inline-flex items-center justify-center gap-1.5 select-none whitespace-normal'))
}

// ---------- ② 本次修复的三处：必须带 ! 前缀 ----------
{
  const wf = read('src/components/app/WritingWorkflow.tsx')
  ok('② 章节规划板折叠头：!justify-between（主人报的病灶：整行被居中）',
    wf.includes('className="w-full flex items-center !justify-between text-left"'))

  const jw = read('src/components/jiewenji/JieWenJiEdit.tsx')
  ok('② 颉文姬改稿「续写」折叠头：!justify-between（同病灶：标签＋箭头双孩）',
    jw.includes('className="w-full flex items-center !justify-between px-3 py-2 text-11 text-ink-200 hover:bg-ink-800/60 transition-colors"'))

  const it = read('src/components/creative/InspireTools.tsx')
  ok('② AI 取名结果卡：!justify-between（同病灶：单孩也被居中）',
    it.includes('className="text-left flex items-start !justify-between gap-2 px-3 py-2 bg-ink-800 border border-ink-700 rounded-lg hover:border-amber/40 transition-colors"'))
}

// ---------- ③ 负向控制：全 src 扫描，Button 的 className 里不允许裸 justify-* ----------
// 合法形态只有 `!justify-*`（important，压得过基类）。
// ⚠️ 放行 `justify-center`：与基类**同值**，顺序无关、无害（侧栏图标钮 / 封面预览钮等
//    本意就是居中，显式写出来是文档化行为）。其余值（start/end/between/around/evenly/
//    normal/stretch）与基类冲突 ⇒ 死类名 ⇒ 视觉 bug。
// 兼容三种 className 写法：双引号 / 单引号 / 反引号模板串（模板串里的 ${} 不截断，
// 因为反引号串内不可能出现裸反引号）。
{
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...walk(p))
      else if (e.name.endsWith('.tsx')) out.push(p)
    }
    return out
  }
  // <Button … className=…>：开标签内不允许出现 '<'（下一个元素）⇒ 防止跨标签乱抓；
  // '=>' 不含 '<' 不影响；onClick 等属性值里的引号/花括号都能过。
  const TAG = /<Button\b(?:(?!<)[\s\S]){0,900}?className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g
  const BARE = /(?:^|\s)(justify-(?!center\b)[\w-]+)/
  const bad: string[] = []
  for (const f of walk(path.join(ROOT, 'src'))) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(TAG)) {
      const cls = m[1] ?? m[2] ?? m[3] ?? ''
      const hit = cls.match(BARE)
      if (hit) {
        const line = src.slice(0, m.index).split('\n').length
        bad.push(`${path.relative(ROOT, f)}:${line} → 裸 ${hit[1]}（死类名，改 !${hit[1]}）`)
      }
    }
  }
  ok('③ 全 src 无「裸 justify-* 传给 Button」的死类名（合法形态：!justify-*；justify-center 与基类同值放行）',
    bad.length === 0, bad.slice(0, 5).join(' | '))
}

console.log(`\ncollapseHeaderAlign: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
