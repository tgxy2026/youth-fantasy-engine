// README 两张设计图（封面 + 版本演进脉络）的唯一渲染入口
// 用法：node scripts/verify/render-readme-art.mjs
// 发版后改这里的 stages / 标题 / 页脚，再跑一次即可保持图与 README 文字一致。
//
// 🔴 2026-11-24：表现形式从「表格式长列表」改为**分阶段时间轴**（竖线 + 节点 + 阶段小标题），
//    并把版本号统一成三位 `x.x.x`（原 `1.0` / `2.1` / `3.0` 一律补 `.0`）。
//    原因：五十多行平铺时，读者很难看出「哪一段在铺地基、哪一段在做闭环」，
//    阶段标签把 1.x 骨架期 / 2.x 扩张期 / 3.x 成型期 / 3.6+ 闭环期分出来，
//    密集的小版本仍在原位，不合并、不省略。
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, 'docs/screenshots')
const FONT = '"Microsoft YaHei","Noto Sans CJK SC",sans-serif'

/**
 * 阶段 → 版本 → 一句话。
 * `cls` 只用于视觉加重：'hi' = 形态级扩张，'now' = 当前发布的版本（会被高亮并标「当前」）。
 */
const stages = [
  {
    tag: '1.x',
    title: '骨架期',
    note: '29 个页签一次成型，从「能写」到「能查」',
    rows: [
      ['1.0.0', '创作管理骨架（29 个页签一次成型，能写、能管）'],
      ['1.1.0', '审校与备份体系（能查）'],
      ['1.2.0', '输入体验件（长文本 / 日期 / 人物选择器 / 可拖拽面板）'],
      ['1.3.0', '全文检索'],
      ['1.5.0', 'AI 起点（补全类能力）'],
      ['1.6.0', '改稿助手 + 交互基建'],
      ['1.7.0', '跨表引用（根治同名异写）'],
      ['1.8.0', '地图编辑器 + 情节推演画布'],
      ['1.9.0', '灵感启发 + 检查工具（数据体检）'],
    ],
  },
  {
    tag: '2.x',
    title: '扩张期',
    note: '云同步、酒馆、AI 前台化，能力面迅速铺开',
    rows: [
      ['2.0.0', '云同步体系 + 桌面版发布'],
      ['2.1.0', '酒馆模式整套（角色扮演推演）◀ 最大扩张', 'hi'],
      ['2.2.0', 'AI 前台化（模型设置 / 提示词可编辑 / 拆书 / 创意写作）'],
      ['2.3.0', '长篇分批创作 + 全面结构优化'],
      ['2.4.0', '首启向导 + 长篇性能基线 + 章节快照 + 创作轨迹 / 证据包'],
      ['2.5.0', '结构模板库 + 自定义主题 + 灵感转化 + 全屏'],
      ['2.6.0', '应用内检查更新 + 长任务存活 + 字体配置 + 代理'],
      ['2.7.0', '自由章节 + 伴写多维多选 + 表格批量导入导出'],
      ['2.8.0', '语义检索（向量 RAG）+ 模型路由 + 文风档 + 参考资料'],
      ['2.9.0', '底座换新（Electron 44 / Vite 8 / Tailwind 4）+ 下载更新'],
      ['2.9.3', '把边角磨平（给 3.0 打底）'],
    ],
  },
  {
    tag: '3.0 – 3.5',
    title: '成型期',
    note: '世界引擎、云端作品库、三形态齐备、桌面接入外部 Agent',
    rows: [
      ['3.0.0', '世界引擎 + 跑团互动 + 章后整理 + 一致性审计 + 便携版', 'hi'],
      ['3.0.1', '正文批量导入 + 首启向导模型配置同源 + 全量审计'],
      ['3.0.2', '同步直连私有网盘（WebDAV / S3 兼容）'],
      ['3.0.3', '便携版按平台分包 + 参考资料全项目可用'],
      ['3.0.4', '界面习惯持久化 + 数据保护加固 + 进程沙箱'],
      ['3.1.0', '继续创作 + 下一步 + 章节规划板 + 同步冲突中心'],
      ['3.1.1', '冲突中心分页筛选 + 纯黑白补齐 + 自定义请求头'],
      ['3.1.2', '正文列加宽（317 → 525px）+ 全站视觉体检'],
      ['3.1.3', '四页签图鉴视图 + 自定义字段 + 角色卡跨页签移动'],
      ['3.2.0', 'AI 改稿候选审阅 + 改后复检 + 报告留档 + 证据快照'],
      ['3.2.1', '中文标点配对修复 + 正文细纲对照 + 封存版本差异'],
      ['3.2.2', '创意写作跨项目串任务（数据事故修复）'],
      ['3.3.0', '创作工作台界面优化'],
      ['3.3.1', '内置使用手册 + 页签聚焦引导 + 使用答疑助手'],
      ['3.3.2', '云端作品库 + 逐本自动同步 + 冲突三选 + 回收站 + 老板键', 'hi'],
      ['3.3.3', '创意连写中断续写 + 图鉴字段永久删除 + 拆书只重试失败项'],
      ['3.3.4', '跨端可用（55 页签响应式 + 44px 触控盒 + 打印 / PDF）'],
      ['3.3.5', '作品安全：发送清单 + 防篡改候选 + 恢复三态 + 还原前备份'],
      ['3.4.0', '创作工作流闭环：规划板往返 + 资料绑定 + 时光机事务 + 收藏 / 导出 / 灵感'],
      ['3.4.1', 'AI 提示词精修 + 审计工具防静默失明自检'],
      ['3.4.2', '三家官方协议直连（Anthropic / Gemini / OpenAI Responses）'],
      ['3.5.0', '投稿广场 + 自愿码字排行', 'hi'],
      ['3.5.1', '网页版引导持久化 + 前端体验打磨'],
      ['3.5.2', '评论分页去重 + 社区备份恢复 + 昵称冷却 + 匿名周代号'],
      ['3.5.3', '排行日结口径修正 + 云端项目异常保护'],
      ['3.5.4', '桌面接入外部 Agent（ACP）：三模式互斥 + 七个纯文本入口'],
      ['3.5.5', 'ACP 结构化任务（审校 / 校对 / 续写方向）+ 设定整理 + 伴写'],
      ['3.5.6', 'ACP 覆盖面补齐（几乎所有 AI 入口）+ 后台任务页 + 工单按卷选范围'],
    ],
  },
  {
    tag: '3.6 – 3.7',
    title: '闭环期',
    note: '拆书闭环、投稿连载、模型兼容，正史与观测都记得住',
    rows: [
      ['3.6.0', '拆书分析闭环：成果记录 + 创作参考只发勾选 + 章后整理'],
      ['3.6.1', '搜索替换先选范围 + 颉文姬面板拖拽吸附 + 体验收口'],
      ['3.6.2', '投稿广场合集连载 + 浏览量 + 切章不再重渲染整棵目录'],
      ['3.6.3', '思考型模型不再被采样参数卡死（Kimi / o1 / gpt-5 / r1）'],
      ['3.7.0', '大纲级联记得住 + 物品与状态按章回溯 + 节奏曲线与投稿体检 + 语音灵感'],
      ['3.7.1', '角色小传：上层写传 + 下层节点轴，从状态演变一键提拔 ◀ 当前', 'now'],
    ],
  },
]

const timelineHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;width:570px;background:#17191c;color:#c8ccd2;font-family:${FONT};padding:38px 30px 30px}
h1{margin:0 0 24px;font-size:30px;color:#f4b942;letter-spacing:1px;font-weight:700}
.stage{margin:0 0 20px}
.stage-head{padding-bottom:7px;border-bottom:1px solid #2c2f35;margin-bottom:8px}
.stage-line{display:flex;align-items:center;gap:9px}
.tag{min-width:70px;text-align:center;color:#f4b942;font-size:12px;font-weight:700;letter-spacing:.6px;background:rgba(244,185,66,.13);border-radius:4px;padding:2.5px 8px;white-space:nowrap}
.stage-title{color:#e6e9ee;font-size:13.5px;font-weight:700}
.stage-note{display:block;margin-top:5px;color:#7b828c;font-size:11.5px;line-height:1.45;padding-left:79px}
ul.track{list-style:none;margin:0;padding:0 0 0 4px;position:relative}
ul.track::before{content:"";position:absolute;left:8px;top:7px;bottom:7px;width:1px;background:linear-gradient(180deg,#3a3d44,#2a2d33)}
li{display:grid;grid-template-columns:14px 58px 1fr;gap:8px;padding:4.5px 0;position:relative}
.dot{width:7px;height:7px;border-radius:50%;background:#4a4e56;margin:6px 0 0 2px;position:relative;z-index:1}
.v{color:#f4b942;font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums;padding-top:2px}
.t{font-size:12.5px;line-height:1.5}
li.hi .t{color:#e6e9ee;font-weight:600}
li.now{margin:5px -9px;padding:6px 9px;background:rgba(244,185,66,.11);border:1px solid rgba(244,185,66,.22);border-radius:7px}
li.now .dot{background:#ffd166;box-shadow:0 0 0 3px rgba(244,185,66,.22);transform:scale(1.15)}
li.now .v,li.now .t{color:#ffd166;font-weight:700}
.foot{margin-top:22px;padding-top:15px;border-top:1px solid #33363c;color:#7b828c;font-size:11.5px;line-height:1.7}
</style></head><body>
<h1>版本演进 · 1.0.0 → 3.7.1</h1>
${stages.map(s => `<div class="stage">
<div class="stage-head"><div class="stage-line"><span class="tag">${s.tag}</span><span class="stage-title">${s.title}</span></div><span class="stage-note">${s.note}</span></div>
<ul class="track">${s.rows.map(([v, t, cls]) => `<li class="${cls || ''}"><span class="dot"></span><span class="v">${v}</span><span class="t">${t}</span></li>`).join('')}</ul>
</div>`).join('\n')}
<div class="foot">从 29 个页签起步，到 10 大板块 56 个页签 ——<br>世界观、角色、大纲、正文，串成一条线。<br>3.7.1：给人物单开一页小传 —— 上层写传、下层排节点，从旧状态长出节点。</div>
</body></html>`

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  // ① 封面：直接用 SVG 源渲染，保证和 cover.svg 逐字一致
  const cover = readFileSync(path.join(outDir, 'cover.svg'), 'utf8')
  const p1 = await browser.newPage({ viewport: { width: 1080, height: 600 }, deviceScaleFactor: 1 })
  await p1.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#0c1829}svg{display:block}</style></head><body>${cover}</body></html>`)
  await p1.screenshot({ path: path.join(outDir, 'cover.png') })
  await p1.close()
  console.log('SHOT cover.png')

  // ② 版本脉络
  const p2 = await browser.newPage({ viewport: { width: 570, height: 1400 }, deviceScaleFactor: 2 })
  await p2.setContent(timelineHtml)
  const h = await p2.evaluate(() => document.body.scrollHeight)
  // 高度按实际内容算：版本行还会继续加，不能写死上限，否则图会被截断
  await p2.setViewportSize({ width: 570, height: h + 4 })
  await p2.screenshot({ path: path.join(outDir, 'changelog-timeline.png'), fullPage: true })
  await p2.close()
  const total = stages.reduce((n, s) => n + s.rows.length, 0)
  console.log('SHOT changelog-timeline.png', 'height=' + h, 'stages=' + stages.length, 'versions=' + total)
} finally {
  await browser.close()
}
