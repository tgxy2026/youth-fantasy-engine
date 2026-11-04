// 3.4.0 · 重绘 README 的两张设计图（封面 + 版本演进脉络）
// 用法：node scripts/verify/render-readme-art-340.mjs
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, 'docs/screenshots')
const FONT = '"Microsoft YaHei","Noto Sans CJK SC",sans-serif'

const rows = [
  ['1.0', '创作管理骨架（29 个页签一次成型，能写、能管）'],
  ['1.1', '审校与备份体系（能查）'],
  ['1.2', '输入体验件（长文本 / 日期 / 人物选择器 / 可拖拽面板）'],
  ['1.3', '全文检索'],
  ['1.5', 'AI 起点（补全类能力）'],
  ['1.6', '改稿助手 + 交互基建'],
  ['1.7', '跨表引用（根治同名异写）'],
  ['1.8', '地图编辑器 + 情节推演画布'],
  ['1.9', '灵感启发 + 检查工具（数据体检）'],
  ['2.0', '云同步体系 + 桌面版发布'],
  ['2.1', '酒馆模式整套（角色扮演推演） ◀ 最大扩张', 'hi'],
  ['2.2', 'AI 前台化（模型设置 / 提示词可编辑 / 拆书 / 创意写作）'],
  ['2.3', '长篇分批创作 + 全面结构优化'],
  ['2.4', '首启向导 + 长篇性能基线 + 章节快照 + 创作轨迹 / 证据包'],
  ['2.5', '结构模板库 + 自定义主题 + 灵感转化 + 全屏'],
  ['2.6', '应用内检查更新 + 长任务存活 + 字体配置 + 代理'],
  ['2.7', '自由章节 + 伴写多维多选 + 表格批量导入导出'],
  ['2.8', '语义检索（向量 RAG）+ 模型路由 + 文风档 + 参考资料'],
  ['2.9', '底座换新（Electron 44 / Vite 8 / Tailwind 4）+ 下载更新'],
  ['2.9.3', '把边角磨平（给 3.0 打底）'],
  ['3.0', '世界引擎 + 跑团互动 + 章后整理 + 一致性审计 + 便携版', 'hi'],
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
  ['3.4.0', '创作工作流闭环：规划板往返 + 资料绑定 + 时光机事务 + 收藏 / 导出 / 灵感 ◀ 当前', 'now'],
]

const timelineHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;width:570px;background:#17191c;color:#c8ccd2;font-family:${FONT};padding:38px 30px 30px}
h1{margin:0 0 26px;font-size:30px;color:#f4b942;letter-spacing:1px;font-weight:700}
table{border-collapse:collapse;width:100%}td{padding:5px 8px;font-size:13px;line-height:1.5;vertical-align:top}
td.v{width:62px;color:#f4b942;font-weight:700;white-space:nowrap}
tr.hi td{background:rgba(255,255,255,.055)}
tr.now td{background:rgba(244,185,66,.13);color:#fff;font-weight:600}
tr.now td.v{color:#ffd166}
.foot{margin-top:26px;padding-top:16px;border-top:1px solid #33363c;color:#7b828c;font-size:12px;line-height:1.7}
</style></head><body>
<h1>版本演进 · 1.0.0 → 3.4.0</h1>
<table>${rows.map(([v, t, cls]) => `<tr class="${cls || ''}"><td class="v">${v}</td><td>${t}</td></tr>`).join('')}</table>
<div class="foot">从 29 个页签起步，到 10 大板块 55 个页签 ——<br>世界观、角色、大纲、正文，串成一条线。<br>3.4.0：进章再回来，还在原来那一屏。</div>
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
  const p2 = await browser.newPage({ viewport: { width: 570, height: 1400 }, deviceScaleFactor: 1 })
  await p2.setContent(timelineHtml)
  const h = await p2.evaluate(() => document.body.scrollHeight)
  await p2.setViewportSize({ width: 570, height: Math.min(h + 4, 1600) })
  await p2.screenshot({ path: path.join(outDir, 'changelog-timeline.png'), fullPage: true })
  await p2.close()
  console.log('SHOT changelog-timeline.png', 'height=' + h)
} finally {
  await browser.close()
}
