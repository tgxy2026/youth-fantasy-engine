#!/usr/bin/env node
/**
 * 校验版本清单与真实产物一致（3.6.2 · W1 新增门禁 A）。
 *
 * 【为什么发布前必须跑】清单里写的是"这个包 99,676,570 字节、sha256 是 xxx"。
 * 若清单与产物不一致，**每一个用户下载完都会看到"完整性校验未通过"**，
 * 而且是发版之后才发现。这条检查把问题挡在发版之前，代价是几秒钟的哈希。
 *
 * 用法：
 *   node scripts/verify/version-manifest-check.mjs
 *   node scripts/verify/version-manifest-check.mjs --manifest dist/version.json --release-dir release
 *
 * 判据（任一不符即 FAIL）：
 *   ① 清单能解析（schema / version / assets 必须合法）；
 *   ② 清单里的每个 asset 都能在 release/ 找到同名文件；
 *   ③ 体积与 sha256 与真实文件**逐字节一致**；
 *   ④ 清单 version 与 package.json 一致（防止"改了版本号忘了重新生成清单"）。
 *
 * 💡 `release/` 里没有对应产物时是 FAIL 而不是跳过：这条检查的意义就是"发布前跑"，
 *    源码阶段的缺产物由 `release-check --source-only` 用 INFO 处理，两者分工不同。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * 🔴 这里**不 import src/lib/app/versionManifest.ts**：Node 不能直接加载 .ts，
 *    而那份文件用的是 `@/` 别名（打包器才认）。为一条"发布前核对"引入 esbuild 打包链不划算，
 *    所以脚本侧只做**最小结构检查**（schema/version/assets 存在且类型对）。
 *    真正的严格解析（未知 kind、重复 kind、超长串、minSupported 降级…）由
 *    `tests/versionManifest.test.ts` 钉住 —— 两者职责不重叠，也不存在"两份实现漂移"。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const arg = (name, def = '') => {
  const at = process.argv.indexOf(name)
  if (at < 0) return def
  const v = process.argv[at + 1]
  if (!v || v.startsWith('--')) throw new Error(name + ' 需要值')
  return v
}

const manifestFile = path.resolve(ROOT, arg('--manifest', 'dist/version.json'))
const releaseDir = path.resolve(ROOT, arg('--release-dir', 'release'))

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const problems = []
const notes = []

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** 最小结构检查（见文件顶部说明：严格解析不在这里） */
function parseManifestShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const schema = raw.schema
  if (!Number.isInteger(schema) || schema <= 0) return null
  const version = String(raw.version ?? '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!version) return null
  if (!Array.isArray(raw.assets)) return null
  return {
    schema,
    version: `${version[1]}.${version[2]}.${version[3]}`,
    webBuildId: String(raw.webBuildId ?? ''),
    assets: raw.assets
      .filter((a) => a && typeof a === 'object')
      .map((a) => ({
        kind: String(a.kind ?? ''),
        name: String(a.name ?? ''),
        size: Number(a.size ?? 0),
        sha256: String(a.sha256 ?? '').trim().toLowerCase(),
        url: String(a.url ?? ''),
      })),
  }
}

/** 在 release/ 里按文件名找产物（含「桌面安装版/」子目录） */function locate(name) {
  const candidates = [
    path.join(releaseDir, name),
    path.join(releaseDir, '桌面安装版', name),
  ]
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c
    } catch {
      /* 下一个候选 */
    }
  }
  // 兜底：浅层递归找同名文件（产物目录结构可能变，但不该因为"位置变了"就判清单错）
  const walk = (d, depth) => {
    if (depth > 3) return null
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        const hit = walk(full, depth + 1)
        if (hit) return hit
      } else if (e.name === name) return full
    }
    return null
  }
  return walk(releaseDir, 0)
}

function main() {
  if (!fs.existsSync(manifestFile)) {
    console.error(`FAIL 找不到清单：${path.relative(ROOT, manifestFile)}`)
    console.error('提示：先跑 node scripts/release-version-manifest.mjs 生成。')
    process.exit(1)
  }

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch (e) {
    console.error(`FAIL 清单不是合法 JSON：${e.message}`)
    process.exit(1)
  }

  const m = parseManifestShape(raw)
  if (!m) {
    console.error('FAIL 清单结构不合法（schema 须为正整数、version 须为三段版本号、assets 须为数组）')
    process.exit(1)
  }

  console.log(`清单：${path.relative(ROOT, manifestFile)}`)
  console.log(`  version=${m.version} schema=${m.schema} assets=${m.assets.length} webBuildId=${m.webBuildId || '(空)'}`)

  // ④ 版本一致性
  if (m.version !== pkg.version) {
    problems.push(`清单 version=${m.version} 与 package.json=${pkg.version} 不一致（改号后忘了重新生成清单？）`)
  }

  if (m.assets.length === 0) {
    notes.push('清单没有任何产物（assets 为空的清单合法，但客户端只能引导去下载页）')
  }

  // ② ③ 逐个产物核对
  for (const a of m.assets) {
    const file = locate(a.name)
    if (!file) {
      problems.push(`产物缺失：${a.kind} / ${a.name}（在 release/ 下找不到）`)
      continue
    }
    const size = fs.statSync(file).size
    if (a.size !== size) {
      problems.push(`${a.name} 体积不符：清单 ${a.size} B vs 实际 ${size} B`)
    }
    if (!a.sha256) {
      // 客户端能容忍缺失（标"未校验"），但发布清单缺摘要等于白做完整性校验 ⇒ 这里判失败
      problems.push(`${a.name} 清单未提供 sha256（发布清单必须带摘要；客户端会标"未校验"）`)
      continue
    }
    const actual = sha256(file)
    if (actual !== a.sha256) {
      problems.push(`${a.name} sha256 不符：\n      清单 ${a.sha256}\n      实际 ${actual}`)
    } else {
      console.log(`  OK ${a.kind} ${a.name} ${size} B sha256 一致`)
    }
  }

  // 桌面自动下载必须拿得到 Setup（拿不到时界面只能给下载页，属可接受降级，但要提醒）
  if (!m.assets.some((a) => a.kind === 'win-setup')) {
    notes.push('清单里没有 win-setup：桌面版将无法应用内下载，只能引导到下载页')
  }

  for (const n of notes) console.log(`  INFO ${n}`)

  if (problems.length) {
    console.error(`\nFAIL ${problems.length} 项不一致：`)
    for (const p of problems) console.error('  - ' + p)
    console.error('\n🔴 清单与产物不一致时**不要发版**：用户会全部收到"完整性校验未通过"。')
    process.exit(1)
  }

  console.log('\nVERSION_MANIFEST_CHECK: PASS')
}

main()
