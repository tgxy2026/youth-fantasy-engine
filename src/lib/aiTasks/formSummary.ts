// ============ AI 任务层 · 全书级设定汇总（表单型页签）============
// 2026-09-19 结构优化 D1：自 aiTasks.ts 拆出（原 #26 的 aiSummarizeFormSettings）。
// 🔴 字段清单从 schema 现查（flow/formMap）—— 模型看到的字段名与落库键同源，避免 schema 漂移。
// 🔴 只收「值确实是对象」的页签，**不在这里摊平**：模型按「页签 → 模块 → 字段」输出，
//    这层拍平会把嵌套对象当空值全丢（2026-09-18 实测 5 张表全丢）。
import { chat, requireActiveProvider, CHAT_TIMEOUT_MS, composeSystemPrompt } from '../ai'
import { parseLooseObject } from '../aiParse'
import { formFieldsPrompt, summaryFormTabs } from '../flow/formMap'
import { longStream } from './stream'

/** 汇总「全书级设定」的系统提示词 */
const formSummarySys = () => `你是长篇小说的「设定资料整理员」。请把给定材料（一本书里已经提取出的设定实体清单 + 开篇样本）汇总成「全书级设定档案」。

铁律：
1. 只输出 JSON，不要解释文字，不要 markdown 代码块围栏。
2. 顶层键只能用下面〖〗里给出的「页签名」，每张表一棵对象。
3. 「只填材料里有依据的字段」。材料里没提到、或你只能靠常识猜的，「一律留空不写」——这是资料整理，不是创作。一张表只填满三五个字段是完全正常的。
4. 「不许新造专名」：人、地、势力、功法、境界的名字只能用材料里出现过的写法。
5. 用"档案体"陈述设定本身，不要写成剧情简介或大纲。
6. 单字段不超过 60 字。
不知道的就留空，比填错好。`

/**
 * 全书级设定汇总 —— 把拆书抽到的实体整理成**表单型页签**（作品信息 / 世界设定 / 力量体系 …）的字段。
 *
 * 【为什么单独一个入口，而不复用逐章抽取】
 * 表单型是**整项目单份**。逐章抽取那套是"一条一个名称、同名判重合并"，套到世界观上会变成
 * 越写越长的追加，还会覆盖作者手改（§3 冲突 3 的结论）。所以它在**流程末尾汇总一次**，
 * 一次性把整本书的信息收敛成一份档案。
 *
 * 【为什么字段清单从 schema 派生】
 * 全部表单页签合计 100+ 个字段。手写进提示词必然随 schema 漂移，而漂移的表现是
 * "模型填得挺好但就是落不进库"。这里现查 schema —— 模型看到的字段名与实际落库键同源。
 *
 * 【为什么重试要收紧】
 * 实测本地 27B 会在长输出里**截断**（JSON 少收尾括号）。同 prompt 重发会断在同一处，
 * 所以第二次点明"上次被截断，请更精炼"（配合 `parseTruncatedJson` 兜底一手）。
 *
 * @returns 顶层键＝页签名或 id；值**原样保留模型给的结构**（可能是 `{字段:内容}`，
 *          也可能是 `{模块:{字段:内容}}`）—— 摊平与字段校验统一由 `flow/formMap.formDraftRows` 做
 */
export async function aiSummarizeFormSettings(
  material: string,
  opts: { signal?: AbortSignal; onToken?: (d: string) => void; onRaw?: (raw: string) => void } = {},
): Promise<Record<string, Record<string, unknown>>> {
  const cfg = await requireActiveProvider()
  const tabIds = summaryFormTabs()
  const fieldList = formFieldsPrompt(tabIds)
  const askOnce = async (tighten = false): Promise<Record<string, Record<string, unknown>>> => {
    const text = await chat(
      cfg,
      [
        { role: 'system', content: composeSystemPrompt(formSummarySys(), cfg) },
        { role: 'user', content: `〖材料〗\n${material.trim() || '（无材料）'}\n\n〖要填的字段〗\n${fieldList}\n\n【必须遵守】只输出 JSON；顶层键用上面〖〗里的页签名（不是字段名）；只写材料里有依据的字段，没把握就不写；不要新造专名；单字段 ≤ 60 字。${tighten ? '\n【注意】上一次输出被截断了（JSON 没有闭合）。这一次请写得更精炼，并务必把 JSON 完整输出到最后一个括号。' : ''}` },
      ],
      { timeoutMs: CHAT_TIMEOUT_MS, signal: opts.signal, onToken: longStream(opts.onToken), json: true },
    )
    opts.onRaw?.(text)
    const obj = parseLooseObject(text) ?? {}
    // 只收「值确实是对象」的页签。
    // 🔴 **这里不做摊平、也不做值过滤**：模型是按提示词的层级输出的 ——「页签 → 模块 → 字段」，
    //    在这一层拍平成两层会把嵌套对象当成空值**全部丢掉**（2026-09-18 实测：5 张表全丢，
    //    界面只显示"没汇总出可用的全书级设定"，而模型产出的内容其实完全正确）。
    //    结构兼容交给 `flow/formMap.formDraftRows`（它知道 schema，也知道该怎么摊）。
    const out: Record<string, Record<string, unknown>> = {}
    for (const [tabName, v] of Object.entries(obj)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const bag = v as Record<string, unknown>
      if (Object.keys(bag).length) out[tabName] = bag
    }
    return out
  }
  const first = await askOnce()
  if (Object.keys(first).length) return first
  return askOnce(true)
}
