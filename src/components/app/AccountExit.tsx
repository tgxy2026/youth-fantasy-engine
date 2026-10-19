/**
 * 网页版 · 「退出登录」小按钮（2026-10-19 主人要求）。
 *
 * 【它从哪来】服务端原先在页面底部正中注入一个**常驻**胶囊（账号 + 云端空间 + 退出），
 *   进项目后压在正文区下方，既影响观感也挡东西。主人决定：胶囊撤掉，退出并入**左下角数据坞**。
 *
 * 【为什么只做一个小图标键】左下角那条 `WebDataBar` 里本来就有账号名和「已用 / 配额」，
 *   缺的只有"出口"这一件事 —— 所以这里只补一个图标键，不重复显示账号信息。
 *
 * 🔴 只在网页云端版有意义：桌面 / 便携 / 游客版没有 `/logout` 这条路由，
 *    `WEB_CLOUD` 为 false 时直接返回 null，不会凭空多出一个点了没反应的按钮。
 */
import { LogOut } from 'lucide-react'
import { WEB_CLOUD } from '@/lib/app/platform'
import { confirmDialog } from '@/components/dialogs/dialogs'
import { Button } from '@/components/common/Button'

interface WebUser {
  name?: string
  usedBytes?: number
  quotaBytes?: number
}

/**
 * 退出登录（带二次确认）。
 *
 * 🔴 为什么确认：会话保留 30 天，退出去要重新登录。这个键现在挨着「导出 / 导入」，
 *    手滑点到就把人踢下线太粗暴 —— 问一句的成本远低于重新登录。
 */
async function logout(): Promise<void> {
  const user = (window as unknown as { __YFE_USER__?: WebUser }).__YFE_USER__
  const ok = await confirmDialog({
    title: '退出登录',
    message: `退出后需要重新登录才能继续用云端账号${user?.name ? `（当前账号：${user.name}）` : ''}。\n\n已保存的内容都在云端，不会丢；只是当前会话会结束。`,
  })
  if (ok) window.location.href = '/logout'
}

export default function AccountExit() {
  if (!WEB_CLOUD) return null
  return (
    <Button
      variant="icon-muted"
      iconOnly
      size="xs"
      onClick={() => void logout()}
      title="退出登录（当前会话结束，云端数据不会丢）"
      className="shrink-0"
    >
      <LogOut size={12} />
    </Button>
  )
}
