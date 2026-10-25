import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { hashBuildDir } from './build-hash.mjs'

/**
 * 契约 `model.failure` 证据校验（3.2.6）。
 *
 * 🔴 只认**本次真跑出来**的结果：源码指纹与构建哈希都要对得上、三条场景一条不能少、
 *    每条断言都必须为真、并且「超时没有可见提示」这条观测必须显式留痕 ——
 *    少一样就不算过。脚本退出码 0 不等于证据成立（本项目已经踩过太多次「跑过了但没测到」）。
 */
export const MODEL_FAILURE_CASES = ['refusal', 'cancel', 'timeout']
/** 断言下限：故意卡得比实际（17 条）低，留一点调整空间，但绝不允许只剩两三条也算过 */
export const MODEL_FAILURE_MIN_ASSERTS = 12

export async function validateModelFailureEvidence(root, file, { expectedSourceFingerprint, buildDir }) {
  const result = JSON.parse(await fs.readFile(file, 'utf8'))
  if (result.kind !== 'model-failure-evidence') throw new Error('model.failure 证据类型不符')
  if (result.sourceFingerprint !== expectedSourceFingerprint) throw new Error('model.failure 证据与当前源码不符（重新跑）')
  if (!buildDir) throw new Error('model.failure 校验需要构建目录（buildDir）')
  if (result.buildHash !== hashBuildDir(buildDir)) throw new Error('model.failure 证据来自别的构建（重新跑）')
  const asserts = Array.isArray(result.asserts) ? result.asserts : []
  if (asserts.length < MODEL_FAILURE_MIN_ASSERTS) throw new Error(`model.failure 断言只有 ${asserts.length} 条，少于下限 ${MODEL_FAILURE_MIN_ASSERTS}`)
  if (result.passed !== asserts.length || asserts.some(a => a.ok !== true))
    throw new Error('model.failure 有未通过的断言：' + asserts.filter(a => a.ok !== true).map(a => a.name).slice(0, 3).join(' / '))
  const cases = Array.isArray(result.cases) ? result.cases : []
  for (const id of MODEL_FAILURE_CASES) {
    if (!cases.some(c => c && c.id === id && c.ok === true)) throw new Error(`model.failure 缺少场景或场景未通过：${id}`)
  }
  // 「超时没有可见提示」是已知设计取舍，必须显式记录，免得下一轮被当成「已验证有提示」
  if (!(result.observations ?? []).some(o => o && o.id === 'timeout.user-message'))
    throw new Error('model.failure 缺少「超时提示」观测记录')
  const shots = await fs.readdir(path.dirname(path.resolve(file)))
  for (const name of ['01-refusal.png', '02-cancel.png', '03-timeout.png']) {
    if (!shots.includes(name)) throw new Error('model.failure 缺少截图：' + name)
  }
  const digest = createHash('sha256').update(await fs.readFile(file)).digest('hex')
  return { assertions: asserts.length, sha256: digest, result }
}
