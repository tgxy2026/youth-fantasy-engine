// ============ 界面 UX 护栏（2026-09-20 六维审计 F1 + 文案一致性） ============
//
// 这两类问题都**不是**功能 bug：
//   · F1 的「缺就绪守卫」—— 点了确实有 catch → toast 兜底，只是"点了才知道不行"；
//   · 文案类 —— 只是措辞／与实现略有出入。
// 但都属于"用户能直接感到别扭"的一类，且**极容易在后续改动里悄悄回退**
// （回退后不会有任何报错，界面照常工作）。静态断言成本极低，所以钉住。
import fs from 'node:fs'
import path from 'node:path'
import { readSchemaModule } from './sourceScan'

const ROOT = process.cwd()
const read = (rel: string) => {
  const p = path.join(ROOT, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— uiUxGuards 用例开始 ——')

// ---------- ① AI 入口的就绪守卫（F1，只给「判据一致」的三处加） ----------
//
// 🔴 加守卫的前提是**判据与真实调用链一致**，否则会误禁（比不加更糟：用户以为功能坏了）。
//    这三处都只走 `requireActiveProvider()`（全局活动模型），与 `useAIReady` 的判据相同：
//      · AIOrganize      → aiTasks/organize.ts
//      · AITemplateFill  → ai.ts aiCompleteTemplate
//      · BookBreakPanel  → aiTasks/extract.ts + formSummary.ts
{
  const cases: [string, string][] = [
    ['src/components/ai/AIOrganize.tsx', '开始整理'],
    ['src/components/ai/AITemplateFill.tsx', '生成补全'],
    ['src/components/bookbreak/BookBreakPanel.tsx', '开始抽取'],
  ]
  for (const [file, label] of cases) {
    const s = read(file)
    ok(`🔴 ${label}：未配置模型时预先禁用（useAIReady）`,
      /const \{ ready: aiReady \} = useAIReady\(\)/.test(s), file)
    ok(`  · ${label}：禁用条件里带 !aiReady`,
      /disabled=\{[^}]*!aiReady[^}]*\}/.test(s), file)
    ok(`  · ${label}：禁用时给出统一提示（AI_DISABLED_HINT）`,
      /AI_DISABLED_HINT/.test(s), file)
  }
}

// ---------- ② 不该加全局守卫的两处 —— 防"顺手补上"造成误禁 ----------
//
// 🔴 这两处的模型来源**不是全局活动模型**，用 useAIReady 守卫会把「配置有效」的场景禁掉：
//    · InterviewChat：实际发请求的是调用方给的 `callChat`（酒馆用会话指定的模型）；
//    · TavernFree：酒馆可指定自己的面板默认模型（defaultProviderId）而全局活动模型为空。
//
// ⚠️ 但「不许用全局判据」不等于「干脆别加守卫」—— 那会退回 F1 原意（点了才知道不行）。
//    所以这里同时要求：酒馆这条链**必须有一个同源的替身判据**（`useTavernReady`），
//    并有自己的单测（tests/tavernReady.test.ts，含负面对照）证明它读的是酒馆那条链。
{
  ok('🔴 InterviewChat 不加全局就绪守卫（模型由调用方 callChat 决定，加会误禁酒馆场景）',
    !/useAIReady/.test(read('src/components/creative/InterviewChat.tsx')))
  ok('🔴 TavernFree 不加全局就绪守卫（酒馆可指定自身 provider，加会误禁）',
    !/useAIReady/.test(read('src/components/tavern/TavernFree.tsx')))
  // ⚠️ 只查 `useTavernReady.ts` 里**有没有 import** 全局 hook（而不是全文出现该词）——
  //    它的文件头注释**必须**能解释"为什么不要用那个"，写成全文禁词会把说明本身判违规。
  const readyHook = read('src/components/tavern/useTavernReady.ts')
  ok('🔴 酒馆就绪守卫走的是**自己的** provider 链（useTavernReady），而非删掉守卫了事',
    /useTavernReady/.test(read('src/components/tavern/useTavernFreeModel.tsx'))
    && /export function useTavernReady/.test(readyHook)
    && !/from '[^']*useAIReady'/.test(readyHook))
  ok('🔴 就绪判据与真实发请求同源（都经 resolveTavernProvider 的三层兜底链）',
    /resolveTavernProvider/.test(read('src/lib/tavern/provider.ts'))
    && /export async function checkTavernReady/.test(read('src/lib/tavern/provider.ts')))
}

// ---------- ③ 文案一致性 ----------
{
  ok('🔴 界面不再出现已下线的「便携版」字样',
    !/便携版/.test(read('src/components/settings/SearchSettingsPanel.tsx')))

  // ⚠️ 3.0 目录整理（G3）：这几张表已按领域进子目录，路径要带上新目录名。
  const saveTitles = ['world/CharacterSheet', 'sheets/FormSheet', 'outline/OutlineSheet', 'sheets/TableSheet']
    .map(f => read(`src/components/${f}.tsx`))
  ok('🔴 保存按钮空态提示统一为「无未保存的改动」（原先两种口径混用）',
    saveTitles.every(s => !/无未保存修改/.test(s)) && saveTitles.every(s => /无未保存的改动/.test(s)))

  ok('🔴 「本章写作简报」口径统一（PlotCanvas 不再叫「灵感简报」）',
    !/灵感简报/.test(read('src/components/outline/PlotCanvas.tsx')))

  ok('🔴 用户可见处不再出现「占位 / 待替换」这类开发期字样',
    // 🔴 读**整个 schema 模块**（门面 + 段文件）：只读门面时这条「不含」断言恒真 = 什么都没测
    !/占位|待替换/.test(readSchemaModule())
    && !/占位内容/.test(read('src/components/app/AboutPage.tsx'))
    && !/待作者替换/.test(read('src/components/app/AboutPage.tsx'))
    && !/示例占位（/.test(read('src/components/app/AboutPage.tsx')))

  // 2.8.0：致谢名单换成真实打赏者 —— 防「示例小说角色名被抄回去」+ 钉住排序说明。
  // 🔴 不断言具体人名：名单会随打赏增长，钉死名字会让「加一位打赏者」变成改测试。
  ok('🔴 致谢名单为真实名单（不再出现示例小说角色名），说明写「按打赏时间排序」',
    !/萧炎|韩立|徐凤年|斗破苍穹|凡人修仙传/.test(read('src/components/app/AboutPage.tsx'))
    && /致谢名单按照打赏时间排序/.test(read('src/components/app/AboutPage.tsx')))

  ok('🔴 ProjectHub 的必选说明与 FEATURE_TIER 一致（拆书 / 创意写作可取消）',
    /拆书与创意写作默认不勾选/.test(read('src/components/app/ProjectHub.tsx')))

  // 2.8.0：「关于打赏」由 default 升 locked —— 两处必选说明都要跟上（防「改了档位忘改文案」）
  ok('🔴 ProjectHub 的两处必选说明都覆盖「关于打赏」',
    /以及运营维护里的「关于打赏」为必选/.test(read('src/components/app/ProjectHub.tsx'))
    && /以及运营维护下的关于打赏）与依赖/.test(read('src/components/app/ProjectHub.tsx')))

  // 接线闸：迁移若不挂在启动期，老项目永远补不上（静默失效，界面上一辈子看不到那个页签）
  ok('🔴 「必选模块同步」确实挂在 App 启动期（否则老项目永远补不上）',
    /await db\.migrateLockedFeatures\(LOCKED_IDS\)/.test(read('src/App.tsx')))
}

// ---------- 2026-09-20 晚间：列宽拖拽崩溃（老大报障）+ 卡片文案参数化 ----------
{
  // 报障原文：TypeError: Cannot read properties of null (reading 'col') @ 打开表格页签调列宽。
  // 根因：setColWidths 的 updater 是**延迟执行**的（React 在渲染阶段才调用），
  // 到那时 mouseup 早已把 dragRef.current 置空，而 updater 里还写 [dragRef.current!.col]。
  // ⚠️ `!` 只是 TS 断言、编译后没有运行时保护 ——「上一步 if 判过非空」救不了下一步。
  const tsModel = read('src/components/sheets/useTableSheetModel.ts')
  // ⚠️ 判据要精确到 **updater 那一行**：文件注释里刻意保留了反例写法（`[dragRef.current!.col]`）
  // 来解释历史 bug，宽泛正则会把注释本身也算成违规（第一版就这么假 FAIL 了一次）。
  ok('🔴 列宽 updater 用的是同步捕获的局部量（而非延迟读取的 dragRef.current）',
    /setColWidths\(prev => \(\{ \.\.\.prev, \[d\.col\]: w \}\)\)/.test(tsModel)
    && !/setColWidths\(prev => \(\{ \.\.\.prev, \[dragRef\.current!?\.col\]/.test(tsModel))
  ok('🔴 拖拽上下文在回调开头就同步捕获（范式同 useSvgPanZoom / PlotCanvas）',
    /const d = dragRef\.current[\s\S]{0,40}if \(!d\) return/.test(tsModel))

  // 起因：CharacterSheet 从 1.x 起只服务角色卡、文案里写死了「角色」；
  // 2.3.0 新增「其他设定」（世界构建组，卡片型）后同一组件也服务非角色卡片表，
  // 于是「新建角色 / 请输入角色姓名」全成了错话（老大实测：功能没问题，文案全是新建角色）。
  const cs = read('src/components/world/CharacterSheet.tsx')
  ok('🔴 CharacterSheet 的卡片文案按页签参数化（照 OutlineSheet 的 noun 范式）',
    /const isCharTab = tab\.group === '角色管理'/.test(cs) && /const noun = isCharTab/.test(cs))
  // ⚠️ 同样要精确：注释里举例提到过「新建角色」（用的是中文引号），那不算违规
  ok('🔴 新建按钮 / 改名弹窗不再写死「新建角色」',
    !/<Plus size=\{14\} \/> 新建角色/.test(cs) && !/'新建角色'/.test(cs) && !/'修改角色姓名'/.test(cs))
  ok('🔴 改名弹窗不再写死「请输入角色姓名」', !/请输入角色姓名/.test(cs))
  ok('🔴 删除确认不再写死「删除角色卡」', !/title: '删除角色卡'/.test(cs))
  ok('🔴 「隐藏已退场」只对角色卡渲染（非角色卡片表没有「人物状态」字段，开关点了也没用）',
    /\{isCharTab && \(/.test(cs))
}

// ---------- ⑨ 首启向导的模型配置与「模型设置 → 模型配置」同源（2026-10-11 主人反馈） ----------
//
// 起因：向导里曾各自维护一份「常用平台」短名单（QUICK_CLOUD / QUICK_LOCAL），
//   只摆 DeepSeek / 硅基流动 / 通义 / 智谱 / Kimi 五家 + 本地两家，其余十几个平台
//   （豆包 / MiniMax / 混元 / Groq / OpenRouter…）在首启里根本看不到；
//   且只有本地 Ollama 有「获取模型」按钮，云端平台没有「获取模型列表」入口。
// 这两点都属「与项目内模型配置不同步」，且很容易在后续改动里悄悄回退（回退后不报错）。
{
  const wa = read('src/components/app/WelcomeAISetup.tsx')
  ok('🔴 向导不再自建平台短名单（QUICK_CLOUD / QUICK_LOCAL 一律不得再出现）',
    !/QUICK_CLOUD|QUICK_LOCAL/.test(wa))
  ok('🔴 向导的平台预设直接取自共享常量 LOCAL_PRESETS / ONLINE_PRESETS（同源，改一处即可）',
    /const cloudPresets:\s*PlatformPreset\[\]\s*=\s*ONLINE_PRESETS/.test(wa)
    && /const localPresets:\s*PlatformPreset\[\]\s*=\s*LOCAL_PRESETS/.test(wa))
  ok('🔴 向导接了云端端点拉取模型清单（listOpenAIModels），不只是本地 Ollama',
    /listOpenAIModels/.test(wa))
  ok('🔴 「获取模型列表」按钮对所有平台可见（不再用 isOllama 包住按钮）',
    /获取模型列表/.test(wa) && !/\{isOllama && \(\s*<Button[\s\S]{0,120}获取本地模型/.test(wa))
}

// ---------- ⑩ 「同排同 size」按钮红线（2026-10-12 主人反馈「并排按钮一高一矮」） ----------
//
// 起因：主人连着抓到三处**同排按钮高度不等**：
//   · AIPromptSettings：保存(sm=32px) / 还原出厂(xs=24px) —— 差 9px（源头，主人点名）；
//   · InspirationBox：清空勾选(xs) / 融合为情节卡(sm) 同一条 flex 行 —— 差 8px；
//   · FieldAliasDialog：全部恢复默认+取消(bare=无尺寸类，高度随内容≈20px) / 保存(sm=32px) —— 差 12px。
// 这三处都**不会报错**、功能照常，纯视觉问题，极容易在后续改动里再退化 ⇒ 静态钉住。
//
// 判据（与 Button.tsx 的 SIZE 基线一致）：
//   · SIZE 含 xs=h-6 / sm=h-8 / md=h-9 / lg=h-10；**bare / toggle-text 不带任何 size 类**；
//   · 同一条 `flex ... gap-*` 行里的 <Button>，要么都显式给 size，要么都给同一个 size。
// ⚠️ 只钉**已收敛的这三个文件**，不做全仓扫描 —— 全仓会命中大量"分组 footer"误报
//    （footerAlign="between" 左右两组本来就该各自成组），误报比不钉更糟。
{
  // ⚠️ 口径要点：只在**同一条 flex 行**内比较。全文件比较会把「展开全文(xs) 与 保存(sm)
  //    各自独占一行」「列表删除键(icon-danger 无 size) 与文字行」这类**不在同一行**的判成误报。
  //    实现：把文件按 `flex ... gap-` 开头的行切段，逐段收集该段内的 <Button> 标签并比 size。
  const targets: [string, string][] = [
    ['src/components/settings/AIPromptSettings.tsx', 'AI 提示词 保存/还原出厂'],
    ['src/components/creative/InspirationBox.tsx', '灵感盒 清空勾选/融合为情节卡'],
    ['src/components/sheets/FieldAliasDialog.tsx', '字段别名 恢复默认/取消/保存'],
  ]

  /**
   * 取一段 JSX 里所有 <Button ...> 开标签（含多行属性），返回 [标签文本, size|'']。
   *
   * 🔴 不能用 `<Button\b([^>]*)>` 这种朴素正则 —— 属性里 `onClick={() => x}` / `disabled={a > b}`
   *    都含 `>`，会在箭头函数处**提前截断**，导致后面的 `size="sm"` 扫不到 ⇒ 误报。
   *    实测踩到：FieldAliasDialog 第 171 行的 bare 按钮其 size 在下一行，被截断后判成 BARE。
   *    故手写扫描：逐字符前进，跳过引号内与 `{}` 内的内容，遇到**括号深度为 0 时的 `>`** 才收尾。
   */
  const sizesIn = (seg: string): [string, string][] => {
    const out: [string, string][] = []
    let i = 0
    while (true) {
      const start = seg.indexOf('<Button', i)
      if (start < 0) break
      let j = start + '<Button'.length
      let depth = 0
      let quote = ''
      let end = -1
      for (; j < seg.length; j++) {
        const c = seg[j]
        if (quote) { if (c === quote) quote = ''; continue }
        if (c === '"' || c === "'") { quote = c; continue }
        if (c === '{' || c === '(') { depth++; continue }
        if (c === '}' || c === ')') { depth--; continue }
        if (c === '>' && depth <= 0) { end = j; break }
        if (c === '<') break // 不是开标签（如 <ButtonXxx），防御
      }
      if (end < 0) break
      const attrs = seg.slice(start + '<Button'.length, end)
      const sz = /size="(xs|sm|md|lg)"/.exec(attrs)?.[1] ?? ''
      out.push([attrs.replace(/\s+/g, ' ').trim().slice(0, 80), sz])
      i = end + 1
    }
    return out
  }

  for (const [file, label] of targets) {
    const lines = read(file).split('\n')
    const bad: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i]
      // 只认「同一条 flex 行」的容器起点
      if (!/className="[^"]*\bflex\b[^"]*\bgap-[^"]*"/.test(head)) continue
      const indent = head.match(/^\s*/)?.[0].length ?? 0
      // 🔴 口径：取「容器起点 → 缩进回落到 <= 容器缩进」的整段文本（**不按行缩进筛**）。
      //    为什么不能按缩进筛：多行属性标签里 `size="sm"` 往往缩进更深（如 14 格），
      //    按「= indent+2」筛会把 size 行丢掉 ⇒ 误判成 bare（实测踩到 FieldAliasDialog 行 171）。
      //    为什么能收敛误报：该段内只认 <Button 开标签，`sizesIn` 已能正确跳过 `=>` 等 `>`。
      const seg: string[] = []
      for (let j = i + 1; j < lines.length && j < i + 31; j++) {
        const ln = lines[j]
        if (ln.trim() && (ln.match(/^\s*/)?.[0].length ?? 0) <= indent) break
        seg.push(ln)
      }
      const btns = sizesIn(seg.join('\n'))
      if (btns.length < 2) continue
      const set = new Set(btns.map(b => b[1] || 'BARE'))
      // 允许：全部同 size；或全部 BARE。不允许：出现两种及以上不同值，
      // 尤其不许「BARE + 具体 size」混排（BARE 无尺寸类，高度随内容，必然不等高）。
      if (set.size > 1) {
        bad.push(`行${i + 1} {${[...set].join('+')}} :: ${btns.map(b => `${b[1] || 'bare'}`).join(',')}`)
      }
    }
    ok(`🔴 ${label}：同排按钮 size 必须一致（不许 BARE 与 xs/sm/md 混排）`,
      bad.length === 0, bad.join(' ｜ '))
  }

  // 反向对照：确认守卫真能抓到坏形态（同一 flex 行里 bare + sm 混排，必须判失败）
  const badSeg = `<div className="mt-2 flex items-center gap-2">
    <Button variant="bare" onClick={a}>取消</Button>
    <Button variant="primary" size="sm" onClick={b}>保存</Button>
  </div>`
  const badSet = new Set(sizesIn(badSeg).map(b => b[1] || 'BARE'))
  ok('  · 守卫自检：同一 flex 行内 bare + sm 混排确实被判失败（防守卫写成永真）',
    badSet.size > 1)
}

// ---------- ⑪ AIConfigPanel 列表态必须两栏铺满（2026-10-12 主人反馈「右侧全空白」） ----------
//
// 起因：列表态套了 `BODY = max-w-3xl`，宽屏（section 实测 1289px）下右侧留 440px 死区。
// 修法：列表态用 LIST_GRID 两栏且**不套 BODY**；编辑态（逐项纵向表单）才收窄。
// 这两条都很容易被"顺手统一宽度"改回去 ⇒ 钉住。
{
  const s = read('src/components/settings/AIConfigPanel.tsx')
  ok('🔴 列表态两栏栅格存在（LIST_GRID：grid + xl:grid-cols-[minmax(0,1fr)_20rem]）',
    /xl:grid-cols-\[minmax\(0,1fr\)_20rem\]/.test(s))
  ok('🔴 列表态不套 BODY（否则两栏被一起卡在左半边，右侧仍是死区）',
    /className=\{editing === null \? '' : BODY\}/.test(s))
  ok('  · 编辑态仍保留 BODY 收窄（逐项纵向表单需要易读行宽）',
    /BODY = 'max-w-3xl'/.test(s))
}

// ---------- ⑫ 定宽图标键不许塞文字（2026-10-12 主人反馈「去写作被压成竖排」） ----------
//
// 起因：Dashboard 的「去写作 / 去登记今日字数」用了 `variant="icon-amber"`——
//   它是**定宽图标键**（ICON_SIZE.sm = w-8 = 32px），文字塞进去宽度不够 ⇒ 一字一行竖着排。
// 判据：icon-amber / icon-danger / icon-muted 三个变体同一行标签里**不许出现中文文字**。
{
  const files = ['src/components/app/Dashboard.tsx', 'src/components/common/CalendarPicker.tsx']
  for (const f of files) {
    const s = read(f)
    const re = /<Button\b[^>]*variant="icon-(?:amber|danger|muted)"[\s\S]{0,300}?<\/Button>/g
    const offenders: string[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) {
      // 标签体内出现中文（排除注释行）
      const inner = m[0].replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      if (/[\u4e00-\u9fa5]/.test(inner)) offenders.push(inner.replace(/\s+/g, ' ').slice(0, 90))
    }
    ok(`🔴 ${f.split('/').pop()}：定宽图标键内不塞中文（会挤成竖排）`,
      offenders.length === 0, offenders.join(' ｜ '))
  }
  const s = read('src/components/app/Dashboard.tsx')
  ok('  · Dashboard 的文字型导航键走 bare + 显式 h-8',
    /variant="bare"[\s\S]{0,200}去写作/.test(s) || /去写作[\s\S]{0,200}h-8/.test(s))
}

// ---------- ⑬ 浮层定位必须折算界面缩放（2026-10-13 主人反馈「AI 伴写弹窗跑到鼠标右侧/到屏幕外」） ----------
//
// 起因：`<html style="zoom:X">` 会把内联 left/top/width **再乘一次 zoom**。
//   HelpPopover 用 getBoundingClientRect() 量到的已是【视觉像素】（zoom 1.08 时放大 8%），
//   直接写 style.left 被再乘 1.08 ⇒ 弹窗整体右移 ~8%，宽屏（自动 zoom 108%）下右缘超出触发键
//   107px、跑出屏幕/盖住正文。修法：量到的坐标一律除以 --ui-zoom 再算。
// 判据：HelpPopover 必须调用 currentUiZoom() 做折算；且 theme.ts 导出该函数。
{
  const hp = read('src/components/common/HelpPopover.tsx')
  ok('🔴 HelpPopover 必须按界面缩放折算定位（currentUiZoom）',
    /currentUiZoom\(\)/.test(hp))
  ok('🔴 视口边界 + rect 坐标都要除以缩放系数（window.innerWidth / z、b.right / z）',
    /window\.innerWidth\s*\/\s*z/.test(hp) && /b\.right\s*\/\s*z/.test(hp))
  const th = read('src/lib/settings/theme.ts')
  ok('🔴 theme.ts 导出 currentUiZoom（浮层定位的定点折算入口）',
    /export function currentUiZoom\(/.test(th))
  // 反向对照：确认守卫能抓到"不做折算"的坏形态（直接写 rect 值）
  const bad = 'const left = b.right - w; setPos({ left, top, w })'
  ok('  · 守卫自检：直接写 rect 值（未折算）确实被判定为坏形态',
    !/window\.innerWidth\s*\/\s*z/.test(bad) && /b\.right\s*-\s*w/.test(bad))
}

console.log(`\n—— uiUxGuards 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
