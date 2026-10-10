/**
 * 「还没接入 AI 模型」的说明卡（2.4.0 · A1 首启闭环）
 *
 * 【它解决什么】
 * 新装的软件里 AI 按钮全是灰的，作者的第一反应往往是「这软件是坏的」或
 * 「是不是我没买什么」。与其让他在 20 多个页签里逐个撞到灰按钮，
 * 不如在「模型设置」这一页把话说全：**哪些会灰、为什么灰、灰了还剩下什么**。
 *
 * 【为什么挂在模型设置页】
 * 这一页就是「配模型」的地方 —— 遇到灰按钮的人若会去某处找答案，来这里。
 *
 * 🔴 只描述「哪些入口会禁用」，绝不写「没 AI 就写不了书」—— 本项目第一原则是
 *    AI 只做辅助（见 `lib/aiScope.ts` 顶部）。清单本身也来自那里，两处不各写一套。
 */
import { Info } from 'lucide-react'
import { useAIReady } from '@/lib/ai/useAIReady'
import { AI_DEPENDENT_GROUPS } from '@/lib/ai/aiScope'

export default function AIDisabledNotice() {
  const { ready } = useAIReady()
  if (ready) return null

  return (
    <section className="rounded-lg border border-ink-700 bg-ink-850/40 p-4">
      <div className="flex items-center gap-1.5">
        <Info size={13} className="text-ink-400" />
        <h2 className="text-12 font-medium text-ink-200">当前还没有可用的 AI 模型</h2>
      </div>
      <p className="mt-1.5 text-11 text-ink-400 leading-relaxed">
        在下方配好一个模型（本地或联网都行），下面这些入口就会自动亮起来 ——
        <span className="text-ink-300">其余功能一律不受影响，正文、设定、大纲、角色卡都照常手动写</span>。
      </p>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
        {AI_DEPENDENT_GROUPS.map(g => (
          <div key={g.title}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="w-1 h-2.5 rounded-full bg-amber/60" />
              <span className="text-11 font-medium text-ink-300">{g.title}</span>
            </div>
            <ul className="space-y-0.5 pl-2.5">
              {g.items.map(it => (
                <li key={it} className="flex gap-1.5 text-11 text-ink-500 leading-relaxed">
                  <span className="shrink-0 text-ink-600">·</span>
                  <span>{it}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
