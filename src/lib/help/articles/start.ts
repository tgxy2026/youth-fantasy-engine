// ============ 手册内容 · 快速开始 ============
//
// 事实来源（2026-10-29 人工核对）：`ProjectHub.tsx` 的项目中心说明与按钮、
// `WelcomeWizard.tsx` 首启向导、`NovelEditor` 工具栏与底部状态栏、`AI_DISABLED_HINT` 文案。
// 🔴 只写作者真能看见的操作；不写实现细节，不把「建议」写成「必须」。
import type { HelpArticle } from '@/lib/help/types'

export const START_ARTICLES: HelpArticle[] = [
  {
    id: 'start-first-project',
    revision: 1,
    title: '第一次打开：新建、示范还是导入',
    summary: '三种开局方式怎么选，以及「题材」和「功能清单」为什么创建后改不了。',
    aliases: ['新建项目', '怎么开始', '示范项目', '导入项目', '选题材'],
    keywords: ['新建', '项目', '示范', '导入', '题材', '功能清单', '首启'],
    group: '快速开始',
    tabIds: ['dashboard'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'three-ways',
        heading: '三种开局方式',
        body: [
          '· 新建小说项目：只需要书名就能开工，封面与其他信息随时可补。',
          '· 创建示范项目：一键写入完整范例数据（卷章正文、设定表单、角色卡、伏笔、时间脉络、码字统计），用来快速摸清各功能怎么用；体验完可以直接删除。',
          '· 导入已有项目：选择之前导出的 .json 备份，还原全书内容。',
        ],
      },
      {
        id: 'project-shape',
        heading: '题材与功能清单在建项目时定',
        body: [
          '「作品题材」决定各页签里字段名与说明文案怎么显示；「功能清单」决定这个项目开放哪些页签（完整项目 / 自定义项目）。',
          '这两项在新建时选定，创建后不能更改 —— 选之前想清楚，拿不准就选「完整项目」，用不到的模块不填即可。',
          '备份与恢复、全文检索、设定检索是全局基础设施，始终可用，不在功能清单里。',
        ],
      },
    ],
    related: ['start-first-chapter', 'start-import-project'],
    actions: [{ label: '打开写作面板', tabId: 'dashboard' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'start-first-chapter',
    revision: 1,
    title: '写第一章：建章、写正文、确认保存',
    summary: '从空项目到第一段正文，以及底部那条状态栏每一段在说什么。',
    aliases: ['怎么写字', '新建章节', '自动保存', '保存状态'],
    keywords: ['正文', '章节', '新建', '保存', 'Ctrl+S', '状态栏', '字数'],
    group: '快速开始',
    tabIds: ['editor'],
    availability: 'all',
    aiRequirement: 'none',
    prerequisites: ['项目里至少有一个分卷；没有时左侧目录会给出建卷入口'],
    sections: [
      {
        id: 'create-chapter',
        heading: '先建卷，再建章',
        body: [
          '进「正文编辑」后，左侧是章节目录。空项目会先让你建卷，再在卷下建章；卷和章都能改名、拖动重排。',
          '建好章点进去就能写。上一章 / 下一章用工具栏的 ← → 切换（切章会先保存当前草稿）。',
        ],
      },
      {
        id: 'saving',
        heading: '保存：自动 + 手动两条路',
        body: [
          '正文默认自动保存；想立刻落盘按 Ctrl+S（macOS 用 Cmd+S），有未保存改动时保存按钮会变色提示。',
          '底部状态栏从左到右是：本章实时字数（口径可在写作面板切换）、今日码字量、保存状态、铺满/限宽、字号。',
          '保存状态分三种：「自动保存已开启」表示还没触发写入、「正在写入」表示正在落盘、「已保存」才是真的写完了。如果显示红字「未写入磁盘」，说明这次没写成，按提示重试。',
        ],
      },
    ],
    related: ['start-without-ai', 'faq-save-state'],
    actions: [{ label: '去正文编辑', tabId: 'editor' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'start-without-ai',
    revision: 1,
    title: '不配模型也能用哪些功能',
    summary: '本地功能与 AI 增强的界线；哪些按钮在没配置模型时会变灰。',
    aliases: ['没模型能用吗', '不充值能用', '离线可用'],
    keywords: ['模型', '离线', '本地', '禁用', '灰色', '不联网'],
    group: '快速开始',
    tabIds: ['dashboard', 'model-settings'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'local-first',
        heading: '本地就能用的',
        body: [
          '所有设定表、角色卡、大纲、表格、图鉴的填写与保存都是本地的，不需要模型。',
          '编辑器里的排版与缩进、敏感词检测（本章）、本地错别字词库、版本历史（时光机）、回收站、全文检索、全书搜索替换、引用高亮、小黑屋、导出（TXT / Markdown / EPUB / DOCX / 平台粘贴版）都不依赖模型。',
          '写作面板的统计、伏笔清点、时间脉络、写作进度也全部本地计算。',
        ],
      },
      {
        id: 'needs-model',
        heading: '需要模型的部分',
        body: [
          '颉文姬的校对 / 综合诊断 / 选区改稿 / 审读 / 简报 / 补登，以及一键拆书、创意写作、连续性与文风体检等 AI 增强，都需要先在「模型设置 → 模型配置」里添加可用模型。',
          '未配置模型时这些按钮是禁用的，鼠标停在上面会提示「需先接入 AI 模型：到『模型设置 → 模型配置』添加本地 Ollama 或联网模型即可启用」（网页版这句是「添加联网模型」—— 网页版不支持连接本机模型）。',
          '未接入不影响本页任何手动填写功能 —— 这句话是软件自己的承诺，也是本地优先的边界。',
        ],
      },
    ],
    related: ['start-first-chapter'],
    actions: [{ label: '打开模型设置', tabId: 'model-settings' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'start-import-project',
    revision: 1,
    title: '备份、导入与恢复：三件事别搞混',
    summary: '单本书的备份、整库搬迁、自动备份恢复，各自在哪儿、能不能互换。',
    aliases: ['备份', '导出备份', '恢复', '搬迁', '换电脑'],
    keywords: ['备份', '导入', '恢复', '导出', 'json', '数据坞', '换设备'],
    group: '快速开始',
    tabIds: ['dashboard'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'three-kinds',
        heading: '三种「备份」不是一回事',
        body: [
          '· 单本书备份：在项目中心对某个项目导出 .json；换设备还原用「导入已有项目」。',
          '· 整体搬迁：左下角数据坞的「导出全部数据」，包含所有项目与全局设置。',
          '· 自动备份：打开项目时自动生成（每 5 分钟 / 每日首次打开两类），可在「备份与恢复」里一键恢复历史版本。',
          '把单本备份拿去数据坞「导入数据文件」会被拒绝 —— 这是设计如此，不是文件坏了。',
        ],
      },
      {
        id: 'before-upgrade',
        heading: '升级或换设备之前',
        body: [
          '先导一份单本备份（或整体导出），再动数据。备份文件是纯文本 JSON，可以自己留档，也方便出问题时排查。',
        ],
      },
    ],
    related: ['start-first-project'],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
]
