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
]
