import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/**
 * 构建目录指纹：按相对路径排序，逐个把「路径 + NUL + 内容」喂进 sha256。
 *
 * 🔴 为什么单独成文件：探针（.cjs）与校验器（.mjs）都要用**同一套算法**。
 *    两边各写一份迟早会分叉，然后出现「证据明明来自这次构建，却判成别的构建」。
 *    实测算法归一处，探针里用动态 `import()` 取。
 */
export function hashBuildDir(dir) {
  const h = createHash('sha256')
  const walk = (d, prefix = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name), rel = prefix ? prefix + '/' + e.name : e.name
      if (e.isDirectory()) walk(full, rel)
      else { h.update(rel); h.update('\0'); h.update(fs.readFileSync(full)) }
    }
  }
  walk(dir)
  return h.digest('hex')
}
