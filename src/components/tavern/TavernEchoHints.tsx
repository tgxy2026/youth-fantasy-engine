/**
 * 酒馆模式 · 元指令速查（**页面上看得见的说明**，不是问号浮层）
 *
 * 【为什么要做成可见的一块】
 * 协议 R4 给了三条「元指令通道」—— 作者可以用它们**出戏**去指挥 AI：
 *   · `「…」`  导演指令：照做，然后继续演（最常用）
 *   · `//` 或 `#` 开头：想和你讨论剧情，用助手身份回，这段不算剧情
 *   · `[OOC: …]`：与上一条等价（英文写法）
 * 这是**输入侧**的约定：只写在协议里作者是看不见的。作者不知道能这么写，
 * 遇到"想让它换个方向 / 换个场景"时就只能删消息重来 —— 功能白做。
 *
 * 所以把它做成一块**直接看得见、能一键复制**的说明，放在「剧情推演」与「自由对话」两处（老大 2026-09-15 把角色卡片那处挪到了自由对话 —— 卡片页放这个不合适）。
 * 两处共用这一个组件，避免各写一份而漂移（本项目反复踩过这种坑）。
 */
import { copyText } from '@/components/dialogs'
import { Button } from '@/components/Button'

type Channel = { sample: string; name: string; note: string }

const CHANNELS: Channel[] = [
  {
    sample: '「让洛清欢先开口，别让老瞎子插话」',
    name: '导演指令',
    note: '照做，然后继续演。想改走向、换场景、点名谁先说话，都用它。',
  },
  {
    sample: '//我想把节奏放缓一点，别推进太快',
    name: '讨论剧情',
    note: '用助手身份简短回你，不演下去；这一段不算剧情里发生过的事。',
  },
  {
    sample: '[OOC: 这一轮不用写环境描写]',
    name: '同上（英文写法）',
    note: '与 // 等价，习惯英文写法的可以用它。',
  },
]

export default function TavernEchoHints({ className = '' }: { className?: string }) {
  return (
    <div className={`rounded-lg border border-ink-700 bg-ink-850/40 px-3 py-2.5 ${className}`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-12 font-semibold text-ink-200">想指挥 Ta？在对话框里这么写就行</span>
        <span className="text-10 text-ink-500">这三种写法是仅有的「出戏」入口，示例可直接复制</span>
      </div>

      <ul className="mt-2 space-y-1.5">
        {CHANNELS.map(c => (
          <li key={c.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {/* 🔴 复制按钮放**最左**（老大 2026-09-16 反馈 #6）：
                原先它靠 `ml-auto` 顶在整行最右端，要复制得把鼠标横跨整行去够它 ——
                实际用起来很别扭。现在按钮在最左，后面紧跟着示例与说明。 */}
            <Button
              variant="secondary" size="xs" className="shrink-0"
              onClick={() => void copyText(c.sample, '已复制这条示例')}
              title="复制这条示例"
            >
              复制
            </Button>
            <code className="rounded bg-ink-900 px-1.5 py-0.5 text-11 text-amber/90">{c.sample}</code>
            <span className="shrink-0 text-11 text-ink-300">{c.name}</span>
            <span className="text-11 text-ink-500">{c.note}</span>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-10 leading-relaxed text-ink-500">
        除这三种写法之外，你打出去的一切都算「你的角色说过或做过的事」，会实实在在地写进剧情。
        「」里的话不限说法 —— 想让它怎么演，就怎么写。
      </p>
    </div>
  )
}
