// 同步文件路径闸（CJS · 2026-10-10 从 main.cjs 抽出 · W3-2 · §11.1 L3）
//
// 为什么抽出来：原先它是 main.cjs 里的一段内联箭头函数，主进程不可在单测里加载，
// 于是「真机桌面路径的校验规则」**一直只有源码闸、没有行为覆盖**（syncTransport.test.ts
// 走的是 FSA 句柄，根本不经这里 —— 见 §11.1 L3 的原始描述）。
// 抽成独立模块后：① main.cjs require 它，规则只有一处；② 规则本身可被逐条审读 / 断言。
//
// 🔴 语义：只接受「绝对路径 + .yfe 结尾（或其派生名 .yfe.*）」。
//    云同步的载体恒为 *.yfe（见 syncTransport.ts 的 CLOUD_FILE_NAME 与 `<sha256>.yfe`）；
//    写盘时的中转名 `.yfe.tmp` / `.yfe.bak`、以及解析失败时另存的 `.yfe.corrupt-<时间戳>`
//    都属于「派生名」，必须放行 —— 否则 quarantine() 这条**唯一的兜底**会被自己的闸挡掉。
'use strict'

const path = require('node:path')

/**
 * 校验并返回同步文件路径；非法则抛错。
 *
 * @param {unknown} p 候选路径
 * @returns {string} 原路径（通过校验时）
 */
function assertSyncPath(p) {
  const s = typeof p === 'string' ? p : ''
  // ⚠️ 放行 `.yfe.` 派生名（2026-10-10 六维审计）：syncTransport 的 quarantine() 会把解析不了的
  //    同步文件另存成 `<名字>.yfe.corrupt-<时间戳>` 供人工抢救 —— 严格要求「.yfe 结尾」会把这条
  //    **唯一的兜底**也挡掉（异常被 catch 吞成一条 warn，作者永远拿不到那份残骸）。
  if (!s || !path.isAbsolute(s) || !/\.yfe(\.[\w.-]+)?$/i.test(s)) {
    throw new Error('同步文件路径非法：只接受绝对路径且以 .yfe 结尾（或其派生名 .yfe.*）')
  }
  return s
}

module.exports = { assertSyncPath }
