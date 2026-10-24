#!/usr/bin/env node
// 3.2.3 · R4：端到端导出→导入的**跨证据聚合**校验。
//
// 为什么单独一个契约：桌面与云端的往返各自跑在各自的真实进程里（Electron / 浏览器 + 本地服务），
// 结果分别落在 desktop-runtime.json 与 web-cloud-runtime.json。把它们当成一个"各配置端到端往返"的
// 单元来报，需要一次跨文件核对 —— 而不是在两处各自说"我这边过了"就算整体过了。
//
// 🔴 这个脚本**不生产证据**，只读同一轮 runRoot 里已由探针产出的两份结果：
//    · 两边都必须有完整的往返检查项且全部为真；
//    · 两边的 sourceFingerprint 必须一致（同一份源码），否则就是拼凑不同轮的证据；
//    · 任一份缺失/过期/检查项不齐 ⇒ 直接失败，不返回一个"看起来还行"的数字。
import fs from 'node:fs/promises'
import path from 'node:path'

/** 桌面端到端：导出 → 改库落盘 → 导入 → 重启回读 */
const DESKTOP_ROUNDTRIP = ['roundtrip-export', 'roundtrip-changed', 'roundtrip-import-readback', 'roundtrip-restart-readback']
/** 云端端到端：浏览器真实下载 → 改库落盘 → 真实选文件导入 → 回读 */
const CLOUD_ROUNDTRIP = ['roundtrip-export', 'roundtrip-changed', 'roundtrip-import-readback']

const argOf = name => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}

async function readResult(file, label) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} 证据缺失或不可读：${file}（${error instanceof Error ? error.message : String(error)}）`)
  }
}

/** 一份结果里必须"有且仅有一次"这些检查项，且全部为真 */
function requireChecks(result, ids, label) {
  const checks = result.checks
  if (!Array.isArray(checks) || result.failed !== 0 || result.error !== null) throw new Error(`${label} 整体未通过`)
  for (const id of ids) {
    const hits = checks.filter(item => item.id === id)
    if (hits.length !== 1) throw new Error(`${label} 的 ${id} 缺失或重复（${hits.length} 次）`)
    if (hits[0].passed !== true) throw new Error(`${label} 的 ${id} 未通过`)
  }
  return ids.length
}

async function main() {
  const runRoot = argOf('--run-root')
  if (!runRoot) throw new Error('--run-root is required')
  const desktop = await readResult(path.join(runRoot, 'desktop-runtime.json'), '桌面')
  const cloud = await readResult(path.join(runRoot, 'web-cloud-runtime.json'), '云端')
  if (!desktop.sourceFingerprint || desktop.sourceFingerprint !== cloud.sourceFingerprint) {
    throw new Error('桌面与云端证据来自不同源码指纹，不能拼成同一轮结论')
  }
  const ok = requireChecks(desktop, DESKTOP_ROUNDTRIP, '桌面')
    + requireChecks(cloud, CLOUD_ROUNDTRIP, '云端')
  console.log(`E2E_ROUNDTRIP ok=${ok} fingerprint=${desktop.sourceFingerprint.slice(0, 8)}`)
}

main().catch(error => {
  console.error('E2E_ROUNDTRIP failed: ' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})
