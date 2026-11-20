#!/usr/bin/env node
/**
 * 生成版本清单 `dist/version.json`（3.6.2 · 交付闭环 W1）。
 *
 * 【为什么必须由脚本生成，不能手填】清单里每个产物都有 `sha256` 与字节数。
 * 手填必然出错（少一位、复制串行、改了包忘了改摘要），而错一份清单的后果是
 * **所有用户下载后都收到"校验失败"**。所以：读真产物 → 算摘要 → 写清单，人只负责核对输出。
 *
 * 用法：
 *   node scripts/release-version-manifest.mjs
 *   node scripts/release-version-manifest.mjs --min-supported 3.5.0
 *   node scripts/release-version-manifest.mjs --release-dir ../tmp-release --out ../tmp-dist/version.json
 *   YFE_DOWNLOAD_BASE=https://youth-fantasy-engine.online/dl node scripts/release-version-manifest.mjs
 *
 * 🔴 硬口径：
 *   ① **三件产物缺一即失败**，并且**不留半份清单**（先全算完再落盘）——
 *      写了一半的 version.json 会被客户端当成"没有安装包"。
 *   ② `webBuildId` 优先取 `dist/BUILD_ID`（deploy.sh 会生成）；没有就用「版本+时刻」。
 *      ⚠️ 千万别试图把 BUILD_ID 反过来喂进构建：`build_id()` 是"目录内容指纹"，
 *      清单本身在 dist 里 ⇒ 会形成"因为清单变了所以指纹变了"的自指循环。
 *   ③ 下载地址默认指向 Gitee Release 附件（与历史发布一致）；可用 `YFE_DOWNLOAD_BASE` 覆盖。
 *      清单只描述"去哪儿拿"，**不承诺镜像可用** —— 拿不到时客户端有兜底路径。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const arg = (name, def = '') => {
  const at = process.argv.indexOf(name)
  if (at < 0) return def
  const v = process.argv[at + 1]
  if (!v || v.startsWith('--')) throw new Error(name + ' 需要值')
  return v
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const releaseDir = path.resolve(ROOT, arg('--release-dir', 'release'))
const outFile = path.resolve(ROOT, arg('--out', 'dist/version.json'))
const minSupported = arg('--min-supported', '')
const downloadBase = (process.env.YFE_DOWNLOAD_BASE || `https://gitee.com/tgxy2026/youth-fantasy-engine/releases/download/v${version}`).replace(/\/+$/, '')

/** 三件产物的固定位置（与 scripts/release-artifacts.cjs 的口径一致） */
const ARTIFACTS = [
  { kind: 'win-setup', file: path.join(releaseDir, '桌面安装版', `青春幻想引擎-Setup-${version}.exe`), required: true },
  { kind: 'portable-win', file: path.join(releaseDir, `青春幻想引擎-便携版-${version}-Windows.zip`), required: true },
  { kind: 'portable-unix', file: path.join(releaseDir, `青春幻想引擎-便携版-${version}-macOS-Linux.zip`), required: true },
]

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** 本地时区的 ISO 串（带偏移），比裸 UTC 更像"发布时刻" */
function localIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const oh = p(Math.floor(Math.abs(off) / 60))
  const om = p(Math.abs(off) % 60)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}:${om}`
}

function main() {
  // ① 先全部校验 + 算完，再落盘（不留半份清单）
  const missing = []
  const assets = []
  for (const a of ARTIFACTS) {
    if (!fs.existsSync(a.file) || !fs.statSync(a.file).isFile()) {
      missing.push(path.relative(ROOT, a.file))
      continue
    }
    const size = fs.statSync(a.file).size
    const sum = sha256(a.file)
    const name = path.basename(a.file)
    assets.push({
      kind: a.kind,
      name,
      size,
      sha256: sum,
      url: `${downloadBase}/${encodeURIComponent(name)}`,
    })
    console.log(`  · ${a.kind}  ${name}  ${size} B  sha256=${sum.slice(0, 12)}…`)
  }
  if (missing.length) {
    console.error('FAIL 缺少产物（清单不生成，避免"半份清单"）：')
    for (const m of missing) console.error('  - ' + m)
    console.error('提示：先跑封装流程产出三件产物，或核对 release/ 下的文件名是否带对了版本号。')
    process.exit(1)
  }

  // ② webBuildId：优先用 deploy.sh 生成的 BUILD_ID（网页版据此判断"要不要刷新"）
  const buildIdFile = path.join(ROOT, 'dist', 'BUILD_ID')
  let webBuildId = ''
  try {
    webBuildId = fs.readFileSync(buildIdFile, 'utf8').trim()
  } catch {
    /* 还没有就退化，下面补 */
  }
  if (!webBuildId) {
    webBuildId = `v${version}+${localIso().replace(/\D/g, '').slice(0, 14)}`
    console.log(`  · dist/BUILD_ID 不存在，webBuildId 用「版本+时刻」：${webBuildId}`)
  }

  const manifest = {
    schema: 1,
    version,
    releasedAt: localIso(),
    channel: 'stable',
    minSupported,
    notesUrl: `https://gitee.com/tgxy2026/youth-fantasy-engine/releases/tag/v${version}`,
    webBuildId,
    assets,
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`\nOK 已写入 ${path.relative(ROOT, outFile)}（${assets.length} 个产物）`)
  console.log('下一步：node scripts/verify/version-manifest-check.mjs 自校验一遍再部署。')
}

main()
