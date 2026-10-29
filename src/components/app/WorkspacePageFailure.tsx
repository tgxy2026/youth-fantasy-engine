import FailureNotice from '@/components/common/FailureNotice'
import { Button } from '@/components/common/Button'

/** Lazy imports retain a rejected promise. Offer a real document reload rather than claiming
 * that resetting the same component will fetch that resource again. Navigation remains usable.
 */
export default function WorkspacePageFailure({ error, returnToEditor, onReturn }: {
  error: unknown; returnToEditor: boolean; onReturn: () => void
}) {
  return <FailureNotice embedded title="当前页面暂时无法打开" error={error}
    description="项目导航仍可使用。可以切换到其他页面继续；若资源加载失败，请重新加载工作台后再进入。"
    actions={<>
      <Button variant="primary" onClick={onReturn}>{returnToEditor ? '打开正文编辑' : '返回写作面板'}</Button>
      <Button variant="secondary" onClick={() => window.location.reload()}>重新加载工作台</Button>
    </>}>
    重新加载会返回项目入口。已保存内容以实际存储结果为准，未提交的修改可能需要恢复。
  </FailureNotice>
}
