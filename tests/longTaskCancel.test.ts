// UX13 源码闸：长等待任务必须留「叫停」入口（不许只能干等/切页签）
//
// 现状口径：
//   · 走任务中心的长任务（拆书/摘要/校对/整理/索引/自由轮…）都有 stop；
//   · 这两个宿主曾漏了：批量重生成摘要（原只有「开始」）、三个 AI 审计（伏笔/连续性/文风）。
// 本闸钉住它们的接线，避免以后调布局时把「中止」删掉又退化成只能干等。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8')

let assertions = 0
const ok = (name: string, passed: boolean) => { assert.ok(passed, name); assertions++; console.log('PASS ' + name) }

// ---------- 批量重生成摘要 ----------
const model = read('src/components/editor/useNovelEditorModel.ts')
const editor = read('src/components/editor/NovelEditor.tsx')
ok('🔴 模型暴露 stopRegenAll（接到任务中心 stop）',
  /const stopRegenAll = \(\) => regenT\.stop\(\)/.test(model) && /regenAll, stopRegenAll,/.test(model))
ok('🔴 正文页跑起来时把「开始」换成「中止」（同一位置）',
  /\{regenAll \? \(/.test(editor) && /onClick=\{stopRegenAll\}/.test(editor)
  && /aria-label="中止批量重生成"/.test(editor))
ok('中止键带说明（已更新的保持已更新，不是回滚）',
  /中止批量重生成（已更新的章节保持已更新）/.test(editor))

// ---------- 三个 AI 审计 ----------
const audit = read('src/components/audit/AuditModals.tsx')
ok('🔴 伏笔深度分析可中止', /中止 AI 伏笔分析/.test(audit) && /onClick=\{t\.stop\}/.test(audit))
ok('🔴 连续性深度审计可中止', /中止 AI 连续性审计/.test(audit))
ok('🔴 文风体检可中止', /中止 AI 文风体检/.test(audit))
ok('三个审计的中止键都只在跑的时候出现（aiLoading 守卫）',
  (audit.match(/\{aiLoading && \(/g) ?? []).length >= 3)
ok('中止键与主键同 size=md（同排不混 size）',
  (audit.match(/onClick=\{t\.stop\}[\s\S]{0,120}size="md"/g) ?? []).length >= 3)

console.log(`\nlongTaskCancel: ${assertions} assertions passed`)
