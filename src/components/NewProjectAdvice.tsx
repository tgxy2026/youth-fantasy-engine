/**
 * 「建议先新建空项目」提示条 —— 供**一键拆书**与**创意写作**两个重流程页签共用。
 *
 * 为什么要有它：这两个功能都会**往当前项目里写大量数据**（拆书写设定与正文、
 * 创意写作新建卷章并写整套设定）。在已经写了一半的项目里跑，新旧内容会混在一起，
 * 之后很难分清来源，也不好收拾。所以在这里直说，而不是藏在问号里等人去看。
 *
 * ⚠️ 文案纪律：界面文案**不用 markdown 星号**（渲染出来是纯文本，会原样露出「**」），
 *    强调一律用「」。
 */
import { AlertTriangle } from 'lucide-react'

type Kind = 'bookbreak' | 'creative-writing'

const CONTENT: Record<Kind, { title: string; body: string; points: string[] }> = {
  bookbreak: {
    title: '建议先新建一个空项目，再跑一键拆书',
    body:
      '拆书会把抽出来的设定与正文「直接写进当前项目」（角色管理 / 世界构建 / 大纲规划 / 正文编辑）。' +
      '如果这个项目里已经有内容，新旧会混在一起，之后很难分清哪些是拆来的、哪些是你原本写的。',
    points: [
      '· 新建项目时请选「完整项目」—— 功能最全，拆书要用到的设定表都在里面；',
      '· 只是想试试效果：先「创建示范项目」跑一遍，看完再删掉即可。',
    ],
  },
  'creative-writing': {
    title: '建议先新建一个空项目，再用「从一句话创作」',
    body:
      '这个起点会「新建卷与章节、并写入一整套设定」。在已有内容的项目里跑，' +
      '新书的世界观与人物会和你原来的混在一起、互相干扰。',
    points: [
      '· 想接着手上这本书往下写 → 请改用「接着已有内容写」起点，它不新建设定与大纲；',
      '· 新建项目时请选「完整项目」—— 功能最全，设定表与大纲规划都在里面。',
    ],
  },
}

export default function NewProjectAdvice({ kind }: { kind: Kind }) {
  const c = CONTENT[kind]
  return (
    <div className="mb-3 flex gap-2.5 rounded-lg border border-amber/40 bg-amber/10 px-3.5 py-2.5">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber" />
      <div className="min-w-0 text-11 leading-relaxed text-ink-200">
        <div className="text-12 font-medium text-amber">{c.title}</div>
        <p className="mt-1">{c.body}</p>
        {c.points.map(p => (
          <p key={p} className="mt-0.5 text-ink-300">{p}</p>
        ))}
      </div>
    </div>
  )
}
