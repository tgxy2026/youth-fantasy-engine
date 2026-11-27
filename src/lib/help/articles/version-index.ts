// 版本变化篇的聚合出口（2026-11-26 · 3.7.4）
//
// 🔴 为什么要有这个文件：版本变化内容按「一版一文件」拆（`version.ts` 已接近纯字面量
//    200 行闸，再加就超），而**消费方有两处、口径必须一致**：
//      · `registry.ts` → 拼进 HELP_ARTICLES，手册能搜到；
//      · `AboutPage.tsx` → 「近期版本更新说明」弹窗按这个顺序倒序展示。
//    两处各自去拼 `version.ts` + `version-373.ts` + `version-374.ts` 迟早漏一个
//    （3.7.3 当时就是在两处消费方之间差点脱节），所以统一从这里出口，以后加新版只改这一处。
import type { HelpArticle } from '@/lib/help/types'
import { VERSION_ARTICLES } from '@/lib/help/articles/version'
import { VERSION_374_ARTICLES } from '@/lib/help/articles/version-374'
import { VERSION_375_ARTICLES } from '@/lib/help/articles/version-375'

/**
 * 全部版本变化篇（按版本号升序）。
 *
 * `VERSION_ARTICLES` 内部已含 `VERSION_373_ARTICLES`（version.ts 末尾拼接），
 * 这里不再重复列 3.7.3，在其后追加 3.7.4、3.7.5。
 */
export const ALL_VERSION_NOTES: HelpArticle[] = [
  ...VERSION_ARTICLES,
  ...VERSION_374_ARTICLES,
  ...VERSION_375_ARTICLES,
]
