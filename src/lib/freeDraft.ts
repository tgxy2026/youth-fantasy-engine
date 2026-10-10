/**
 * 「草稿本」——**全局通用**的一段自由文本暂存区（2.4.4 · 社区反馈）。
 *
 * ## 为什么要有它（它和「设定草稿箱」的关系）
 * 世界设定 / 力量体系那两个页签各有一个**跟着本层走**的草稿箱（存在该层的 data 里）；
 * 而这里提供的是**另一个维度的东西**：任何一处「AI 补全」弹窗都能带进来的一段草稿。
 * 作者常常是在别处（聊天记录、随手记的灵感、写到一半的大纲）攒了一大段文字，
 * 想拿它当补全的材料 —— 弹窗里那个小输入框显然装不下，也记不住上次写了什么。
 *
 * ## 形态（刻意做成极薄的一层）
 * ```
 * settingsKV[`${pid}::draft::<scope>`] = 文本
 * ```
 * · 走 `getSetting / setSetting` ⇒ **自动按项目隔离**，随项目走（备份 / 云同步都会带上）；
 * · `scope` 由调用方自己定（页签 / 记录 / 行的维度随意），本文件不解释它的含义；
 * · 只有**字符串进出**，不做任何结构化 —— 它就是一块白纸。
 *
 * 🔴 **不进 AI**：草稿本只躺在库里，**只有作者在弹窗里点「带入」才随本次请求发出去**。
 *    这是它与「设定资料」的本质区别 —— 后者是整理过的、可以给模型看的；前者是没整理的个人笔记。
 *    界面必须把这层口径写清楚（见 AITemplateFill 的草稿本区块）。
 *
 * ⚠️ 别把它当「项目资料」用：模型看不到它、设定检索也不索引它。想让它被 AI 读到，
 *    就整理完填进对应的设定表 / 表单字段。
 */
// 走 db 门面（与 aiContext 等 lib 层同款），不要直接 import ./db/meta —— 门面的存在就是为了
// 让「存储入口」只有一个，绕过去会让将来的 store 替换/迁移漏掉一处。
import { getSetting, setSetting } from '@/lib/db'

/** 存储键前缀（`__` 之外的第二重保险：与 `draft::` 组合后不可能与业务键撞车） */
const PREFIX = 'draft::'

function freeDraftKeyOf(scope: string): string {
  return `${PREFIX}${scope}`
}

/** 读取草稿（没有则空串）。读取失败一律当空 —— 草稿不是关键数据，绝不能因为它阻断界面 */
export async function loadFreeDraft(scope: string): Promise<string> {
  if (!scope) return ''
  try {
    const v = await getSetting<string>(freeDraftKeyOf(scope), '')
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/** 保存草稿。返回**是否真的存上了** —— 调用方（AI 补全弹窗）据此决定亮不亮「已存」。
 *  🔴 2.4.4 六维审计 P1：失败只留痕不抛（草稿不是关键数据），但「没存上却报已存」
 *  比失败本身更糟 —— 作者关弹窗即丢稿且零痕迹。 */
export async function saveFreeDraft(scope: string, text: string): Promise<boolean> {
  if (!scope) return false
  try {
    await setSetting(freeDraftKeyOf(scope), text)
    return true
  } catch (e) {
    console.warn('[freeDraft] 草稿保存失败（本次改动未落库）：', e)
    return false
  }
}

/** 删掉一份草稿（子世界 / 记录被删除时用它清孤儿） */
export async function clearFreeDraft(scope: string): Promise<void> {
  if (!scope) return
  try {
    await setSetting(freeDraftKeyOf(scope), '')
  } catch (e) {
    /* 同上：不构成错误，但留痕（孤儿草稿会一直躺在 settingsKV 里） */
    console.warn('[freeDraft] 草稿清理失败：', e)
  }
}
