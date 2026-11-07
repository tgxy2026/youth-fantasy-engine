// ============ 手册内容 · 模型相关的常见问题（3.3.1 · P9 起） ============
//
// 从 `faq.ts` 拆出来的：那边已接近「纯字面量 ≤200 行」的结构闸上限（③-b），
// 与其继续往一个文件里塞，不如按主题分文件 —— 一处改模型口径时也只动这一个文件。
import type { HelpArticle } from '@/lib/help/types'

export const FAQ_MODEL_ARTICLES: HelpArticle[] = [
  {
    id: 'faq-web-local-model',
    revision: 1,
    title: '网页版能用本机的 Ollama / LM Studio 吗',
    summary: '不能。网页版（云端账号与游客模式）只接联网模型；本机模型请在桌面版或便携版里用。',
    aliases: ['网页版本地模型', '浏览器连 Ollama', '本机模型用不了', 'localhost 连不上'],
    keywords: ['网页版', '本机模型', '本地模型', 'Ollama', 'LM Studio', '局域网', '不支持', '联网模型'],
    group: '常见问题与任务教程',
    tabIds: ['model-settings'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'why',
        heading: '结论：网页版不支持连接本机模型',
        body: [
          '网页版（含云端账号模式与游客模式）**不连接**任何跑在本机或局域网里的模型服务：Ollama、LM Studio、LocalAI、自建的 OpenAI 兼容服务都算在内。',
          '这不是配置没填对，也不是模型名写错了 —— 浏览器对 127.0.0.1 与局域网地址的访问受安全策略、混合内容与端口限制影响，能不能连通取决于浏览器与网络环境，软件没法向你保证，所以网页版直接不给这条路。',
        ],
      },
      {
        id: 'what-happens',
        heading: '已经配好的本机模型会怎样',
        body: [
          '配置**不会被删除**：模型设置里仍然能看到那条配置，只是带上「网页版不支持」的琥珀色标记，「设为当前」与「测试」是灰的。',
          '「AI 用途路由」与语义检索的模型下拉里也不会列出它 —— 选了也用不上，索性不给选。',
          '所有 AI 功能在没有其它可用模型时，会明确告诉你「网页版不支持本机模型」，而不是让你对着「请求失败」猜原因。',
        ],
      },
      {
        id: 'how-to',
        heading: '网页版该用什么',
        body: [
          '用「模型设置 → 模型配置 → 添加联网模型」：硅基流动、DeepSeek、通义、智谱等平台，填接口地址与 API 密钥即可。',
          '确实要用本机模型（比如数据不想出本机），请打开桌面版或便携版：那边连接 127.0.0.1 是正常能力，模型配置是全局的一份，在桌面版里配好、回到网页版也不会被清掉。',
        ],
      },
    ],
    related: ['faq-model-gray', 'start-without-ai'],
    actions: [{ label: '打开模型设置', tabId: 'model-settings' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-30',
  },
  {
    id: 'faq-multi-protocol',
    revision: 1,
    title: '怎么接入 Anthropic Claude / Google Gemini / OpenAI Responses',
    summary: '3.4.2 起模型配置可直接选这三家官方端点；地址、密钥、模型清单与结构化输出在这里说清。',
    aliases: ['Claude 配置', 'Gemini 配置', 'Responses 配置', 'x-api-key', 'x-goog-api-key', '多协议', '官方端点'],
    keywords: ['Anthropic', 'Claude', 'Gemini', 'Responses', 'x-api-key', 'x-goog-api-key', '结构化输出', '模型清单', 'embedding', 'CORS'],
    group: '常见问题与任务教程',
    tabIds: ['model-settings'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'choose',
        heading: '在模型配置里直接选官方端点',
        body: [
          '打开「模型设置 → 模型配置 → 添加联网模型」，平台预设里会多出 **Anthropic Claude**、**Google Gemini**、**OpenAI Responses** 三条。选中后地址会自动填好，密钥与模型名按下面填写即可。',
          '它们与原本的 OpenAI 兼容预设共用同一份模型配置；已有模型不会因为升级被改动，旧配置仍然按原协议工作。',
        ],
      },
      {
        id: 'anthropic',
        heading: 'Anthropic Claude',
        body: [
          '地址填 `https://api.anthropic.com`，接口是 `/v1/messages`。密钥填在「API 密钥（x-api-key）」；软件会自动带上版本头，不需要你手填。',
          '模型清单可以点「获取可用模型」自动拉取（`/v1/models`），也可以手动填写。已退役的模型不会列出来。',
          '结构化输出：先在「结构化输出能力」里确认该端点支持，之后 JSON schema 任务才会下发 `output_config.format`；默认不确认时只靠提示词约束，不会贸然下发。Anthropic 本版不提供 embedding 接口，语义索引请另选 Gemini / OpenAI / Ollama。',
        ],
      },
      {
        id: 'gemini',
        heading: 'Google Gemini',
        body: [
          '地址填 `https://generativelanguage.googleapis.com`，接口走 `generateContent`；流式走独立的 `streamGenerateContent` 端点。密钥填在「API 密钥（x-goog-api-key）」。',
          '模型清单可以自动拉取（`/v1beta/models`），只列出支持 `generateContent` 的模型。结构化输出确认后下发 `responseMimeType` 与 `responseJsonSchema`。',
          '语义索引可用 Gemini 的 `batchEmbedContents`：在「语义检索」里选同一个 Gemini 模型，嵌入模型名填类似 `gemini-embedding-001` 的名称即可。',
        ],
      },
      {
        id: 'responses',
        heading: 'OpenAI Responses',
        body: [
          '地址填 `https://api.openai.com/v1`，接口是 `/v1/responses`，密钥用 Bearer（与 OpenAI Chat Completions 同一份密钥）。它和「OpenAI」预设是两套格式，不要混选。',
          '结构化输出确认后下发 `text.format`；模型清单仍走 `/models`，语义索引仍走 `/embeddings`。',
        ],
      },
      {
        id: 'web',
        heading: '网页版的限制',
        body: [
          '网页版是**浏览器直连厂商**：能不能用取决于厂商是否允许当前网站来源跨域（CORS），以及浏览器是否放行。本版没有新增服务端代理，因此**未通过 CORS 实测的协议不保证网页可用**。',
          '密钥由你自己提供，在网页形态下浏览器可见；这是既有边界，本版没有改变。桌面版与便携版不受这条 CORS 限制。',
          '本版未接入 Amazon Bedrock 与厂商私有协议；接入前请以厂商当期官方文档为准。',
        ],
      },
    ],
    related: ['faq-web-local-model', 'faq-model-gray'],
    actions: [{ label: '打开模型设置', tabId: 'model-settings' }],
    verifiedAgainst: '3.4.2',
    reviewedAt: '2026-11-07',
  },
]
