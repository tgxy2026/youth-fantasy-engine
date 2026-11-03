// ============ 3.3.1 · P9：网页版统一禁用本机模型（主人 2026-10-30 定案 B 分支） ============
//
// 这批用例守的是「禁用要真的禁住」，不是把按钮藏起来：
//   · 判据只看**配置**（地址/本地标记），不看品牌 —— Ollama 填了公网地址也不算本机；
//   · 桌面 / 便携**完全不受影响**（原文案、原行为逐字不变）；
//   · 取模型的唯一出口（session.resolveActive）与用途路由都过滤，旧配置自动失效；
//   · 界面必须说明原因、禁用无用按钮、并把用途/嵌入下拉里的本机项拿掉。
import fs from 'node:fs'
import path from 'node:path'
import {
  WEB_BLOCKS_LOCAL_MODEL, blocksLocalModel, usableProviders, blockedProviders,
} from '../src/lib/aiCore/localModelAccess'
import { HELP_ARTICLES, CONTENT_VERSION } from '../src/lib/help'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

/** 只描述判据关心的三个字段（与 AIProvider 的结构兼容即可） */
interface ProbeProvider { type: 'ollama' | 'openai'; baseUrl: string; local?: boolean }
function ollama(baseUrl: string, local?: boolean): ProbeProvider { return { type: 'ollama', baseUrl, local } }
function openai(baseUrl: string, local?: boolean): ProbeProvider { return { type: 'openai', baseUrl, local } }

// ---------- ① 判据：网页版 + 本机/局域网 ⇒ 禁用 ----------
{
  ok('定案是「禁用」（不是仅提示）', WEB_BLOCKS_LOCAL_MODEL === true)
  ok('Ollama 留空地址 = 默认本机 ⇒ 网页版禁用', blocksLocalModel(true, ollama('')))
  ok('127.0.0.1 禁用', blocksLocalModel(true, ollama('http://127.0.0.1:11434')))
  ok('localhost 禁用', blocksLocalModel(true, openai('http://localhost:1234/v1', true)))
  ok('192.168.x 禁用', blocksLocalModel(true, openai('http://192.168.1.9:8080/v1')))
  ok('10.x 禁用', blocksLocalModel(true, openai('http://10.0.0.5:8000/v1')))
  ok('172.16~31 禁用', blocksLocalModel(true, openai('http://172.20.3.4:8000/v1')))
  ok('169.254 链路本地禁用', blocksLocalModel(true, openai('http://169.254.1.1:80/v1')))
  ok('IPv6 回环禁用', blocksLocalModel(true, ollama('http://[::1]:11434')))
  ok('局域网主机名（无点 / .local）禁用', blocksLocalModel(true, ollama('http://nas.local:11434')))

  // 公网不是本机 —— 品牌不等于位置
  ok('🔴 公网地址的 Ollama 不禁用（品牌不等于网络位置）',
    !blocksLocalModel(true, ollama('https://ollama.example.com')))
  ok('公网 OpenAI 兼容地址不禁用', !blocksLocalModel(true, openai('https://api.deepseek.com/v1')))
  ok('🔴 显式 local 标记优先（即使写的是域名）', blocksLocalModel(true, openai('https://my-box.example.com/v1', true)))
}

// ---------- ② 桌面 / 便携完全不受影响 ----------
{
  ok('🔴 非网页形态下本机模型照旧可用', !blocksLocalModel(false, ollama('http://127.0.0.1:11434')))
  ok('非网页形态下留空 Ollama 也可用', !blocksLocalModel(false, ollama('')))
  ok('非网页形态下显式 local 标记也不拦', !blocksLocalModel(false, openai('http://192.168.1.9/v1', true)))
}

// ---------- ③ 分区：能用的 / 被禁的 ----------
{
  const list = [
    { id: 'a', type: 'ollama' as ProbeProvider['type'], baseUrl: 'http://127.0.0.1:11434' },
    { id: 'b', type: 'openai' as ProbeProvider['type'], baseUrl: 'https://api.deepseek.com/v1' },
    { id: 'c', type: 'openai' as ProbeProvider['type'], baseUrl: 'http://192.168.1.9/v1' },
  ]
  // 注意：usableProviders 用的是运行时的 WEB（node 测试里为 false）⇒ 这里只验形状与顺序不丢
  const usable = usableProviders(list)
  ok('usableProviders 保持原顺序、不重排', usable.map(p => p.id).join(',') === 'a,b,c', usable.map(p => p.id).join(','))
  ok('blockedProviders 在非网页形态下为空', blockedProviders(list).length === 0)
}

// ---------- ④ 取模型唯一出口必须过滤（旧配置自动失效） ----------
{
  const session = read('src/lib/aiCore/session.ts')
  ok('🔴 session.resolveActive 过滤被禁配置（所有取当前模型的路都经它）',
    /isLocalModelBlocked/.test(session) && /list\.filter\(p => !isLocalModelBlocked\(p\)\)/.test(session))
  ok('🔴 全是本机模型时报「网页版不支持」而不是「还没配」',
    /list\.every\(isLocalModelBlocked\)\) throw new Error\(WEB_LOCAL_MODEL_NOTICE\)/.test(session))

  const routing = read('src/lib/ai/aiRouting.ts')
  ok('🔴 用途路由不会选中被禁配置', /hit && !isLocalModelBlocked\(hit\)/.test(routing))
  ok('用途路由取不到时同样区分两种原因', /every\(isLocalModelBlocked\)\) throw new Error\(WEB_LOCAL_MODEL_NOTICE\)/.test(routing))
}

// ---------- ⑤ 界面：说明原因 + 禁用无效操作 + 下拉过滤 ----------
{
  const panel = read('src/components/settings/AIConfigPanel.tsx')
  ok('列表行标注「网页版不支持」', /WEB_LOCAL_MODEL_BADGE/.test(panel) && /isLocalModelBlocked\(p\)/.test(panel))
  ok('🔴 「设为当前」与「测试」被禁用（不是点了没反应）',
    /disabled=\{isLocalModelBlocked\(p\)\}/.test(panel) && /disabled=\{testingId !== null \|\| isLocalModelBlocked\(p\)\}/.test(panel))
  ok('🔴 「添加本地模型」入口被禁用并写明原因',
    /disabled=\{LOCAL_MODEL_DISABLED\}/.test(panel) && /data-local-model-blocked/.test(panel))
  ok('🔴 用途下拉与语义检索只列可用配置（选了也用不上就不给选）',
    /const usable = usableProviders\(providers\)/.test(panel)
    && /usable\.map\(p => \(/.test(panel)
    && /<EmbeddingIndexPanel providers=\{usable\} \/>/.test(panel))
  ok('有被禁配置时列表上方给出统一说明', /data-local-model-notice/.test(panel))
}

// ---------- ⑥ 文案：网页版说联网，桌面照旧逐字不变 ----------
{
  const scope = read('src/lib/ai/aiScope.ts')
  ok('🔴 未配置提示按形态分文案', /AI_DISABLED_HINT = WEB/.test(scope))
  ok('🔴 桌面/便携文案逐字保留（不因网页版改动被改口径）',
    scope.includes('需先接入 AI 模型：到「模型设置 → 模型配置」添加本地 Ollama 或联网模型即可启用。'))
  ok('网页版提示改为「添加联网模型」并说明不支持本机',
    /网页版请到「模型设置 → 模型配置」添加联网模型（网页版不支持连接本机模型）/.test(scope))
}

// ---------- ⑦ 手册必须能回答这个新问题 ----------
{
  const article = HELP_ARTICLES.find(a => a.id === 'faq-web-local-model')
  ok('🔴 手册有「网页版能不能用本机模型」这篇', !!article, article ? '' : '缺失')
  ok('文章覆盖结论 / 旧配置 / 替代方案三段', (article?.sections.length ?? 0) >= 3)
  ok('文章写明「配置不会被删除」', article?.sections.some(s => s.body.join('').includes('不会被删除')) ?? false)
  ok('手册内容版本已升（旧缓存索引作废）', CONTENT_VERSION >= 2, String(CONTENT_VERSION))
}

console.log(`\n—— webLocalModelGate 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
