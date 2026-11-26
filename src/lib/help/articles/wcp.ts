// ============ 手册内容 · WCP 网页资料包（3.7.3） ============
//
// 只写作者能在界面上找到的事实：入口位置、点了会发生什么、哪些情况不会自动发生。
// 不承诺「一定写得更好」，也不把网页模型的行为说成本地可控。
import type { HelpArticle } from '@/lib/help/types'

export const WCP_ARTICLES: HelpArticle[] = [
  {
    id: 'wcp-relay',
    revision: 1,
    title: 'WCP 网页资料包：不用 API 也能接力',
    summary: '把设定、角色、细纲与前文打包成一份文档交给 Gemini / Claude 网页版，再把回复双段式粘回来；不配 API Key，也不影响后台模式。',
    aliases: ['WCP', '网页资料包', '网页接力', 'Gemini', 'Claude', 'Context Pack'],
    keywords: ['WCP', '网页版', '资料包', '底包', '增量包', '双段', 'JSON', 'Markdown 清单', '网页模型'],
    group: '模型与 AI',
    tabIds: ['model-settings', 'editor', 'chapter-outline', 'check-tools', 'char-bio'],
    availability: 'all',
    aiRequirement: 'none',
    prerequisites: ['作品里已有一些设定 / 角色 / 章节；没有资料也能导出，但包内内容会很少。'],
    sections: [
      {
        id: 'what-is-wcp',
        heading: '它解决什么问题',
        body: [
          'WCP 是 API / MCP / ACP 之外的**第 4 种离线接力方式**：不需要 API Key，也不占用那三种运行模式的状态。它把项目里的资料整理成一份 Markdown 文档（也可以下载成 .txt），你把它交给 Gemini、Claude 等网页版长上下文模型，再把模型回复粘回引擎。',
          '桌面版、便携版、网页版都能用。后台正在用 API / MCP / ACP 也不影响 WCP；在「模型设置 → WCP 模式」里点开它，不会切换后台的在线模式。',
        ],
      },
      {
        id: 'base-pack',
        heading: '第一次：导出常驻底包',
        body: [
          '打开「模型设置 → 运行模式 → WCP 模式」。在「常驻底包与导出偏好」里勾选要长期提供的模块：作品概览、世界设定、势力与地理、核心角色、人物关系、人物小传、写作规范、名词术语。',
          '点「预览清单」能先看每段实际带了多少字、是完整还是裁剪；点「下载底包」或「复制底包」把内容放进网页模型的 Gem / Project（或一段长期对话的开头）。只有真正下载或复制后，才会记录「已导出」；单纯预览不会。',
          '底包只装长期设定，不装当前章草稿与前文。之后若改了底包涉及的世界观或角色，这里会显示「设定已更新，建议重导」，但不会拦住你继续导增量包。',
        ],
      },
      {
        id: 'delta-pack',
        heading: '日常：导出续写 / 润色增量包',
        body: [
          '打开正文编辑器，工具栏有一枚「WCP 接力」按钮：选「导出续写包」会带本章细纲、前文摘要与末尾正文、本章已写草稿、出场角色当前状态、物品与未回收伏笔，以及你在「本章资料」里固定的资料；选「导出润色包」优先带你选中的片段，没有选中时把整章正文作为待润色文本。',
          '弹窗里可以临时改包形态（增量 / 完整）、摘要格式（JSON / Markdown 清单）、前文章数与摘要数，也可以写一段「作者补充说明」。点「生成资料包」后再下载或复制；每次改设置都会让旧预览失效，避免下载到旧包。',
          '「完整包」会同时带底包与本章增量，适合新开普通对话、或需要全量对照的任务。',
        ],
      },
      {
        id: 'paste-back',
        heading: '把回复粘回来：正文入章与候选入库',
        body: [
          '在同一个「WCP 接力」菜单里点「粘贴网页回复」，或在导出弹窗底部点「粘贴网页回复」。把网页模型整段回复粘进去，弹窗会拆成两部分。',
          '第一部分是正文（或润色稿 / 细纲 / 审校报告 / 小传），可以复制、追加到章末、替换整章、替换选中片段；替换整章会先二次确认。第二部分是变动摘要：JSON 模式会先和库内登记现状比对，列出「可写入 / 仅提示 / 已存在」；只有你勾选的条目才会写入，且只追加不覆盖。没登记的伏笔、关系、物品、小传只提示，不会凭空建。',
          'Markdown 清单模式只把变动整理成可读卡片，不生成可勾选入库的候选 —— 适合先看懂，再人工改资料。',
        ],
      },
      {
        id: 'other-scenes',
        heading: '另外三个场景的入口',
        body: [
          '章节细纲页：「WCP 推演包」带上总纲、卷纲、相邻章细纲与角色 / 伏笔，让网页模型推演本章细纲；回复里的细纲文本可复制后自行填入，不会自动覆盖已有细纲。',
          '检查工具页：「WCP 找茬包」把待检正文（取「AI 一致性深度自查」的输入框）与世界观、角色状态、物品流转、伏笔台账一起打包。这个场景只列事实矛盾与正文原句，**不评分、不排名、不评级**。',
          '角色小传页：选中角色后点「WCP 小传包」，带上角色卡、既有小传、状态演变与出场章节片段；回复的小传正文可填入小传草稿（仍需你点保存），里程碑节点经去重后勾选追加。',
        ],
      },
      {
        id: 'json-fallback',
        heading: 'JSON 不完整怎么办',
        body: [
          '出厂默认是 JSON 摘要。若网页模型返回的 JSON 语法不完整、或结构不符合约定，第一部分正文仍会**完整保留**，照常可复制 / 入章；第二部分顶部会出现提示条和「一键切换为 Markdown 清单模式」按钮。',
          '切换后，全局默认摘要格式会改成 Markdown 清单，后续导出与解析都按新格式；也可以随时在「模型设置 → WCP 模式」或回流弹窗里切回 JSON。',
        ],
      },
      {
        id: 'storage',
        heading: '设置存在哪里',
        body: [
          '默认后缀、默认包形态、摘要格式、前文章数 / 摘要数、单包字符预算这些**全局偏好**跨项目共用。',
          '底包勾选模块、上次导出时间与源数据指纹按**项目**单独保存；切换作品不会把 A 书的「底包已过期」提示带到 B 书。',
        ],
      },
    ],
    related: ['whats-new-373', 'editor-tools', 'char-bio-guide'],
    actions: [
      { label: '打开模型设置', tabId: 'model-settings' },
      { label: '打开正文编辑', tabId: 'editor' },
    ],
    verifiedAgainst: '3.7.3',
    reviewedAt: '2026-11-25',
  },
  {
    id: 'wcp-local-workspace',
    revision: 1,
    title: '本地 Agent 工作区：让 Claude Code / Cursor 直接读你的资料',
    summary: '桌面版把设定、当前章上下文与输出契约按文件同步到本机安全目录；本地 Agent 读工作区写作，把结果写进 outbox/，回引擎一键核对入库。',
    aliases: ['WCP-Local', '本地工作区', '本地 Agent', 'Claude Code', 'Codex', 'Cursor', 'Cline', 'Windsurf', 'outbox'],
    keywords: ['WCP', '本地 Agent', '工作区', 'AGENTS.md', 'manifest', 'outbox', '收件箱', '定时更新', '提醒', 'zip'],
    group: '模型与 AI',
    tabIds: ['model-settings', 'editor', 'chapter-outline', 'check-tools', 'char-bio'],
    availability: 'all',
    aiRequirement: 'none',
    prerequisites: ['桌面版才有本地写盘权限；网页版 / 便携版可下载离线 .zip。', '先在「模型设置 → WCP 模式」的「本地 Agent 工作区」里点一次更新。'],
    sections: [
      {
        id: 'what-is-local',
        heading: '它和网页 WCP 有什么不同',
        body: [
          '网页 WCP 是把整包资料下载后上传给 Gemini / Claude 网页版；本地 Agent 工作区（WCP-Local）则是把同一批资料**按文件**落到本机目录。Claude Code、Codex、Cursor、Windsurf、Cline 这类能读写本地文件的 Agent，可以直接按 `AGENTS.md` 的指引按需读取，不必每次上传。',
          '工作区根目录默认在当前数据文件同级的 `wcp-workspaces/`（例如 `%APPDATA%\\youth-fantasy-engine\\wcp-workspaces\\`）；数据文件迁到 D 盘或同步盘时会自动跟随。也可以在设置里自定义目录并一键恢复默认。',
        ],
      },
      {
        id: 'three-steps',
        heading: '日常三步',
        body: [
          '第一步：在「模型设置 → WCP 模式 → 本地 Agent 工作区」点「立即更新工作区」，或点「同步并复制 Agent 提示词」。提示词里带着工作区的**绝对路径**、`AGENTS.md`、`manifest.json`、`02-context/task.md` 与 `outbox/` 位置。',
          '第二步：把提示词粘贴给本地 Agent，再补上这次的具体剧情要求。它会先读 `AGENTS.md` 与 `manifest.json`，再按需读取 `01-base/` 设定与 `02-context/` 当前章上下文。',
          '第三步：Agent 完成后，把两份同名文件写进 `outbox/`：`<前缀>.wcp.json`（严格按 `03-schemas/wcp-output.schema.json`）与 `<前缀>.md`（正文 + 可读摘要）。回到「WCP 回流」弹窗，收件箱会列出这些产物。',
        ],
      },
      {
        id: 'freshness',
        heading: '资料保鲜：提醒 / 定时 / 手动',
        body: [
          '三种策略随时切换：「打开时提醒」（默认，有新改动只提示、不静默覆盖）、「定时自动」（5 / 10 / 15 / 30 分钟，有改动才在后台原位刷新）、「仅手动」（只在你点按钮时更新）。',
          '每次刷新先在内存里算总指纹：内容没变就零写盘；有变化时只覆写哈希变化的文件，不保留历史副本。打开「同步全书历史章节」后会额外生成 `04-chapters/` 供大上下文 Agent 翻查前文，同样只增量刷新变化的章节。',
          '只有「曾同步过」或你在设置里勾了「本书启用本地 Agent 工作区」的书才会提醒或定时写盘；从未用过的书零打扰。',
        ],
      },
      {
        id: 'outbox-back',
        heading: '收件箱回流与安全边界',
        body: [
          '「WCP 回流」弹窗顶部会出现「本地 Agent 收件箱（outbox/）」卡片：`载入 JSON` 会先校验契约与 `projectId`（跨书立即拦截），再直接比对候选；同名 `.md` 可以预览、复制或载入解析。',
          '导入成功后，默认把对应的 `.wcp.json` 与 `.md` 成对移入 `outbox/imported/` 归档，避免重复导入；这个自动归档可在设置里关闭。',
          '安全边界：只读区（`01-base/`、`02-context/`、`03-schemas/`、`04-chapters/`、`manifest.json`、`AGENTS.md`、`CLAUDE.md`）Agent 不得修改；`outbox/` 是唯一可写区，刷新时永远不会被清理。工作区也不占用 API / MCP / ACP 的运行态。',
        ],
      },
      {
        id: 'web-fallback',
        heading: '网页版 / 便携版怎么办',
        body: [
          '这两个形态没有本地写盘权限。设置页与 WCP 导出弹窗会改为「下载离线工作区 `.zip`」：包内目录结构与桌面版一致（路径纯 ASCII，Windows 解压不乱码），解压后把目录路径告诉本地 Agent 即可。',
          '回流仍用「WCP 回流」的浏览文件 / 拖拽 / 粘贴 `.wcp.json` 或 `.md`，与 3.7.3 完全一致。',
        ],
      },
    ],
    related: ['wcp-relay', 'whats-new-373'],
    actions: [
      { label: '打开模型设置', tabId: 'model-settings' },
      { label: '打开正文编辑', tabId: 'editor' },
    ],
    verifiedAgainst: '3.7.4',
    reviewedAt: '2026-11-26',
  },
]