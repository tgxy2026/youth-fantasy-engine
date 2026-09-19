/**
 * 本场状态的「主角色」= **AI 扮演的第一个角色**（排除用户扮演的那个）。
 * 用户把「我演」放在位置 1 时 charIds[0] 就是用户卡 —— 此前 #4 把主角色死写成 charIds[0]，
 * 导致本场状态（好感/信任/精神…）被算进并回写**用户卡**而非 AI 角色卡（反馈 #16）。
 * 无 userCharId（纯 AI 多角色、用户不扮演）时回退 charIds[0]，保持旧行为。
 *
 * 【为什么单独成文件（2026-09-19 D4-5）】它被「生成链路」与「收尾」两个子 hook 同时用到，
 *   而原来住在 `components/useTavernFreeModel.tsx` 里 —— 子 hook 反过来 import 主 hook 会成环
 *   （闸 `tests/importCycles` 会拦）。它是纯函数、只吃参数、不碰 store，所以下沉到 lib 最干净：
 *   两个子 hook 都直接 import 它，主 hook 再 `export { primaryAiCharId }` 保持对外契约不变。
 */
export function primaryAiCharId(s: { charIds: string[]; userCharId?: string | null }): string {
  const user = s.userCharId
  if (user) {
    const ai = s.charIds.filter(id => id !== user)
    if (ai.length > 0) return ai[0]
  }
  return s.charIds[0] ?? ''
}
