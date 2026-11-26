/**
 * 首页「作品简介」的**批量读取**（3.7.5 · 方案 B）
 *
 * 取值判据本身是纯函数（`projectIntro.ts`，可单测）；这里只负责「一次把每本书的
 * 《作品信息》表读出来、算好文案」。分开的理由：
 *   ① 纯判据不该为了测试去背一个 IndexedDB 依赖；
 *   ② `ProjectHub.tsx` 已顶到 1200 行硬闸（结构护栏 ①），把这段搬走才不会破闸。
 *
 * 🔴 单本读失败只影响那一本的简介（回退项目记录上的旧 `intro`），
 *    不能让整页读不出来 —— 首页是打开软件的第一屏。
 * 🔴 读的是**指定 pid** 的版本：首页列的是全部作品，不是"当前打开的那本"。
 */
import { getFormDataFor } from '@/lib/db'
import { INTRO_TAB_ID, resolveProjectIntro } from '@/lib/app/projectIntro'

/** 返回 `{ 项目 id: 简介文案 }`；作者没填的地方对应空串（由界面决定兜底提示） */
export async function loadProjectIntroTexts(
  projects: { id: string; intro?: string }[],
): Promise<Record<string, string>> {
  const forms = await Promise.all(
    projects.map(p => getFormDataFor(p.id, INTRO_TAB_ID).catch(() => ({} as Record<string, string>))),
  )
  const out: Record<string, string> = {}
  projects.forEach((p, i) => { out[p.id] = resolveProjectIntro(forms[i], p.intro) })
  return out
}
