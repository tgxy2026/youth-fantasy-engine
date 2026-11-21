/**
 * 诊断包（diagnostics pack）· 单测（3.6.2 · W2）
 *
 * 本文件的**首要价值是隐私负向断言**，不是"字段齐不齐"。
 * 诊断包会被保存成文件、当附件发出去、贴进 issue —— 一旦混进正文 / 密钥 / 路径，
 * 就是一次真实外泄。所以每条红线都配断言，将来有人加字段时会被拦下。
 *
 * 覆盖两类：
 *   A. `buildDiagnosticsPack` 纯函数（白名单、计数兜底、截断、两视图同源）；
 *   B. `collectDiagnosticsPack` 真实采集（走内存桩存储；含写锁场景）。
 */
import * as db from '../src/lib/db'
import type { Chapter } from '../src/lib/types'
import {
  PACK_SCHEMA,
  buildDiagnosticsPack,
  diagnosticsFileName,
  renderDiagnosticsJson,
  renderDiagnosticsText,
  type DiagnosticsInputs,
} from '../src/lib/app/diagnosticsPack'
import { collectDiagnosticsPack } from '../src/lib/app/diagnostics'
import { __setDesktopCustomPath, __setDesktopWriteLock } from './mock-desktop'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 一份干净的最小输入（各用例只改关心的那一项） */
function baseInputs(): DiagnosticsInputs {
  return {
    version: 'v3.6.2',
    buildTime: '2026-11-21T08:00:00+08:00',
    buildId: '',
    form: 'desktop',
    dev: false,
    runtime: {
      os: 'Win32', language: 'zh-CN', renderer: 'Chrome 130',
      window: { width: 1440, height: 900 }, screen: { width: 2560, height: 1440 },
      dpr: 1.25, uiZoom: 1,
    },
    storage: {
      kind: '本机 JSON 整库', pathKind: 'default',
      dataSizeBytes: null, dataModifiedAt: null, writeLocked: false,
    },
    project: { count: 2, current: { volumes: 3, chapters: 42, words: 123456 }, semanticSources: 0 },
    health: { ok: true, bySeverity: { error: 1, warn: 2, info: 0 }, byCategory: { 悬空引用: 1, 必填空: 2 } },
    ai: { models: 2, local: 1, cloud: 1, protocols: { 'OpenAI 兼容': 1, Ollama: 1 } },
    errors: [],
    now: new Date(2026, 10, 21, 8, 30, 0),
  }
}

// ---------- A1 结构 ----------
{
  const pack = buildDiagnosticsPack(baseInputs())
  ok('A1a schema 存在且为数字', typeof pack.schema === 'number' && pack.schema === PACK_SCHEMA, String(pack.schema))
  ok('A1b 生成时间是本地 ISO（带偏移）', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(pack.generatedAt),
    pack.generatedAt)
  ok('A1c 显式列出被排除的类别（给用户看，建立信任）', pack.redaction.length >= 5
    && pack.redaction.some(s => s.includes('正文')) && pack.redaction.some(s => s.includes('路径')),
    String(pack.redaction.length))
  ok('A1d 形态与规模都在', pack.app.form === 'desktop' && pack.project.current?.chapters === 42)
}

// ---------- A2 🔴 白名单：输入里多塞的字段不会进包 ----------
{
  const dirty = baseInputs() as unknown as Record<string, unknown>
  // 模拟"有人顺手把整个 provider 对象传进来"：这些键**没有**出现在白名單接口里
  dirty.apiKey = 'sk-should-never-appear-1234567890'
  dirty.baseUrl = 'https://private.example.com/v1'
  dirty.modelName = '作者自定义的模型名'
  dirty.chapterContent = 'SECRET_BODY_不该出现的正文'
  const json = renderDiagnosticsJson(buildDiagnosticsPack(dirty as unknown as DiagnosticsInputs))
  ok('🔴 A2a 额外塞进来的 apiKey 不进包', !json.includes('sk-should-never-appear-1234567890'))
  ok('🔴 A2b 额外塞进来的 baseUrl 不进包', !json.includes('private.example.com'))
  ok('🔴 A2c 额外塞进来的模型名不进包', !json.includes('作者自定义的模型名'))
  ok('🔴 A2d 额外塞进来的正文不进包', !json.includes('SECRET_BODY'))
}

// ---------- A3 计数兜底与截断 ----------
{
  const bad = baseInputs()
  bad.project.count = -3
  bad.health.bySeverity = { error: Number.NaN, warn: -1, info: 2.7 }
  bad.errors = Array.from({ length: 15 }, (_, i) => ({
    at: Date.now(), kind: 'window', message: 'x'.repeat(500) + i, source: 'App.tsx:1',
  }))
  const pack = buildDiagnosticsPack(bad)
  ok('A3a 负数计数归 0（不把脏值写进包）', pack.project.count === 0, String(pack.project.count))
  ok('A3b NaN / 负数 / 小数一律归 0 或取整',
    pack.health.bySeverity.error === 0 && pack.health.bySeverity.warn === 0 && pack.health.bySeverity.info === 2,
    JSON.stringify(pack.health.bySeverity))
  ok('A3c 错误最多 10 条（与 errorLog 环形上限一致）', pack.errors.length === 10, String(pack.errors.length))
  ok('A3d 单条消息最多 200 字（绕过去也不会变长）', pack.errors.every(e => e.message.length <= 201),
    String(pack.errors[0]?.message.length))
}

// ---------- A4 详细错误帧：只在给了的时候出现 ----------
{
  const withFrames = baseInputs()
  withFrames.errors = [{ at: Date.now(), kind: 'render', message: 'boom', source: 'X.tsx:9', frames: ['at a (X.tsx:9)', 'at b (Y.tsx:2)', 'at c (Z.tsx:1)', 'at d (W.tsx:1)'] }]
  const pack = buildDiagnosticsPack(withFrames)
  ok('A4a 给了 frames 就带上（最多 3 帧）', pack.errors[0].frames?.length === 3, String(pack.errors[0].frames?.length))

  const withoutFrames = baseInputs()
  withoutFrames.errors = [{ at: Date.now(), kind: 'render', message: 'boom', source: 'X.tsx:9' }]
  const pack2 = buildDiagnosticsPack(withoutFrames)
  ok('A4b 默认不带 frames（详细错误关着时没有这个键）', pack2.errors[0].frames === undefined)
}

// ---------- A5 两视图同源 ----------
{
  const input = baseInputs()
  const a = buildDiagnosticsPack(input)
  const b = buildDiagnosticsPack(input)
  ok('A5a 同一输入两次组包完全一致（含时间，因为时间由入参注入）',
    renderDiagnosticsJson(a) === renderDiagnosticsJson(b))
  const text = renderDiagnosticsText(a)
  ok('A5b 文本里的版本与包一致', text.includes(`版本：${a.app.version}`))
  ok('A5c 文本里的项目规模与包一致',
    text.includes(`${a.project.current!.chapters} 章`), (text.match(/^当前项目：.*$/m) || [])[0])
  ok('A5d 文本里的体检结果与包一致', text.includes('发现 3 项（错误 1 / 提示 2'))
  ok('A5e 文本里不带路径分隔符以外的秘密（两份视图都不含 apiKey 字样）',
    !/apiKey/i.test(text) && !/apiKey/i.test(renderDiagnosticsJson(a)))
}

// ---------- A6 文件名的安全性 ----------
{
  const pack = buildDiagnosticsPack(baseInputs())
  const name = diagnosticsFileName(pack)
  ok('A6a 文件名以 .json 结尾且含日期', /^yfe-diagnostics-\d{8}-\d{4}\.json$/.test(name), name)
  ok('A6b 文件名不含路径分隔符（不会被当成目录）', !/[\\/]/.test(name), name)
}

// ---------- B 真实采集 ----------
async function collectChecks() {
  const SECRET_PROJECT = '不该出现的书名探针'
  const SECRET_BODY = 'SECRET_BODY_正文标记串_不该出现'
  const p = await db.createProject(SECRET_PROJECT, '', '')
  db.setCurrentProject(p.id)
  await db.saveChapter({
    id: 'ch-diag-1', projectId: p.id, volumeId: '', order: 1, title: '第一章',
    content: `${SECRET_BODY} 这一章有正文内容，诊断包里一个字都不该有。`,
    summary: '', status: '草稿', wordCount: 30, createdAt: Date.now(), updatedAt: Date.now(),
  } as Chapter)

  const before = JSON.stringify(await db.getAllChapters())
  const pack = await collectDiagnosticsPack({ uiZoom: 1.25 })
  const json = renderDiagnosticsJson(pack)
  const text = renderDiagnosticsText(pack)

  ok('B1 采集到项目数与章数', pack.project.count >= 1 && (pack.project.current?.chapters ?? 0) >= 1,
    `${pack.project.count} / ${pack.project.current?.chapters}`)

  // 🔴 七条负向断言的核心
  ok('🔴 B2 不含正文标记串', !json.includes(SECRET_BODY) && !text.includes(SECRET_BODY))
  ok('🔴 B3 不含项目名（书名是作者隐私）', !json.includes(SECRET_PROJECT) && !text.includes(SECRET_PROJECT))
  ok('🔴 B4 不含 Windows 绝对路径', !/[A-Za-z]:\\/.test(json) && !/[A-Za-z]:\\/.test(text))
  ok('🔴 B5 不含 /home/ 与 /Users/ 形态路径', !/\/home\/|\/Users\//i.test(json) && !/\/home\/|\/Users\//i.test(text))
  ok('🔴 B6 不含密钥式长串', !/[A-Za-z0-9_-]{32,}/.test(json) && !/[A-Za-z0-9_-]{32,}/.test(text),
    (json.match(/[A-Za-z0-9_-]{32,}/) || [])[0])
  ok('🔴 B7 不含 http(s) 地址（baseUrl 可能内嵌令牌）', !/https?:\/\//i.test(json) && !/https?:\/\//i.test(text))
  ok('🔴 B8 不含本机用户名', !json.includes('18223') && !text.includes('18223'))

  // 🔴 只读：采集不写存储
  const after = JSON.stringify(await db.getAllChapters())
  ok('🔴 B9 生成诊断包不修改任何存储数据（前后逐字节一致）', before === after)

  ok('B10 体检跑完且有计数', pack.health.ok === true, pack.health.reason)
  ok('B11 文本视图里有「数据体检」一行', /^数据体检：/m.test(text), (text.match(/^数据体检：.*$/m) || [])[0])
  ok('B12 UI 缩放被采到', pack.runtime.uiZoom === 1.25, String(pack.runtime.uiZoom))

  // 两视图/两次采集不能各说各话（验收 W2 第 3 条：同一时刻各取一次，storage 与 ai 段完全一致）
  const twice1 = await collectDiagnosticsPack()
  const twice2 = await collectDiagnosticsPack()
  ok('🔴 B20 两次采集的 storage / ai 段逐字一致（两视图不会各说各话）',
    JSON.stringify(twice1.storage) === JSON.stringify(twice2.storage)
    && JSON.stringify(twice1.ai) === JSON.stringify(twice2.ai),
    'storage/ai 段在两次采集间发生变化')

  // 自定义位置 → pathKind 跟着变（与红条同口径）
  __setDesktopCustomPath(true)
  const custom = await collectDiagnosticsPack()
  __setDesktopCustomPath(false)
  ok('B13 自定义位置被识别为 custom（但不写路径进包）',
    custom.storage.pathKind === 'custom' && !/C:\\/.test(renderDiagnosticsJson(custom)),
    custom.storage.pathKind)

  // 写锁：体检必须明确"不可用"，不能说"未发现问题"
  __setDesktopWriteLock(true)
  const locked = await collectDiagnosticsPack()
  __setDesktopWriteLock(false)
  ok('🔴 B14 写锁时 health.ok=false（扫空库得出的"没问题"是假象）', locked.health.ok === false)
  ok('🔴 B15 写锁时 reason 可读且说明不可用', /不可用/.test(locked.health.reason), locked.health.reason)
  ok('B16 写锁时包仍能生成（最需要它的时刻不能失败）', locked.schema === PACK_SCHEMA && locked.project.count >= 0)
  ok('B17 写锁时 storage.writeLocked 为真', locked.storage.writeLocked === true)
  ok('B18 写锁时文本视图写明「不可用」',
    /^数据体检：不可用（/m.test(renderDiagnosticsText(locked)),
    (renderDiagnosticsText(locked).match(/^数据体检：.*$/m) || [])[0])

  // 无项目时的措辞
  db.setCurrentProject('')
  const noProject = await collectDiagnosticsPack()
  ok('B19 未打开项目时 reason=未打开项目（与"体检炸了"区分开）', noProject.health.reason === '未打开项目',
    noProject.health.reason)
}

await collectChecks()

console.log(`\ndiagnosticsPack: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
