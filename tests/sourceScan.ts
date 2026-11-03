/**
 * 源码扫描助手 —— 给「断言某段源码长什么样」的测试共用。
 *
 * 🔴 为什么要有它（2026-10-04 真实踩坑）：
 *   `lib/ai.ts` 拆成 `aiCore/*`、`lib/schema.ts` 拆成 `schemaTabs/* + schemaTemplates/* + schemaShared.ts`
 *   之后，测试里写死的 `read('src/lib/ai.ts')` 全部**静默失明**，而且两种失明都很隐蔽：
 *     · 断言「**包含**」的那条 → 当场转红（thinkPolicy 挂 1 条、aiFillSemantics 挂 4 条）；
 *     · 断言「**不包含**」的那条 → **恒真、永远绿**，其实什么都没测（miscSettings / uiUxGuards）。
 *   这正是项目红线说的「文件一搬，扫描器就失明」。
 *   → 凡是要扫这两个模块的测试，一律走这里，**读整个模块目录再拼接**：以后再怎么拆文件都不会失明。
 *
 * ⚠️ 拼接结果只适合做「有没有这段字」的 `includes` / `RegExp` 断言；别拿它跑类型或执行代码。
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** 读文件；不存在返回空串（路径猜错时让断言失败，而不是让整个用例崩） */
function tryRead(rel: string): string {
  try {
    return readFileSync(path.join(process.cwd(), rel), 'utf8')
  } catch {
    return ''
  }
}

/** 读 `dir` 下全部 .ts 并拼接（按文件名排序 ⇒ 拼接结果稳定；目录不存在返回空串） */
function readTsDir(dir: string): string {
  try {
    return readdirSync(path.join(process.cwd(), dir))
      .filter(n => n.endsWith('.ts'))
      .sort()
      .map(n => tryRead(`${dir}/${n}`))
      .join('\n')
  } catch {
    return ''
  }
}

/** 读整个 `src/` 下所有 .ts（递归，按路径排序）—— 用于「全仓盘点」类断言（如统计旧写法残留） */
export function readAllSrc(): string {
  const walk = (dir: string): string[] => {
    try {
      return readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap(d => {
          const rel = `${dir}/${d.name}`
          if (d.isDirectory()) return walk(rel)
          return d.name.endsWith('.ts') ? [tryRead(rel)] : []
        })
    } catch {
      return []
    }
  }
  return walk('src').join('\n')
}

/** ai 模块全量源码 = 门面 `ai.ts` + 实现段 `aiCore/*`（拆分前读门面就能扫全，现在必须拼上 aiCore） */
export function readAiModule(): string {
  return tryRead('src/lib/ai.ts') + '\n' + readTsDir('src/lib/aiCore')
}

/** 设定 schema 全量源码 = 门面 `schema.ts` + `schemaShared.ts` + 段文件 `schemaTabs/*` + 题材包 `schemaTemplates/*` */
export function readSchemaModule(): string {
  return [
    tryRead('src/lib/schema.ts'),
    tryRead('src/lib/schemaShared.ts'),
    readTsDir('src/lib/schemaTabs'),
    readTsDir('src/lib/schemaTemplates'),
  ].join('\n')
}
