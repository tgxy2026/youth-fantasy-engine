import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './Button'

// 网页体验版首次进入的隐私告知：明确「数据 + AI 密钥仅留本地浏览器，仅反馈时出向」。
// 见过后记 localStorage 标记，不再打扰。
const KEY = 'yfe-privacy-ok'

export default function PrivacyNotice() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    try {
      if (!localStorage.getItem(KEY)) setShow(true)
    } catch {
      /* localStorage 不可用时直接不弹，隐私仍由服务端架构保证 */
    }
  }, [])

  const ok = () => {
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      /* ignore */
    }
    setShow(false)
  }

  return (
    <Modal
      open={show}
      onClose={ok}
      variant="plain"
      accent="emerald"
      showCloseButton={false}
      dismissible={false}
      width="md"
      className="bg-ink-900"
      bodyClassName="p-6"
      titleSlot={
        <div className="flex items-center gap-2 text-emerald-400">
          <ShieldCheck size={18} />
          <span className="font-semibold">隐私说明</span>
        </div>
      }
    >
      <ul className="space-y-2 text-sm text-ink-300 leading-relaxed mt-3">
        <li>
          • 你的<strong>项目数据</strong>与<strong>AI 密钥</strong>仅保存在本机浏览器（IndexedDB /
          localStorage），不会上传到我们的服务器。
        </li>
        <li>• 仅当你主动点击「反馈」并提交时，才会向我们发送你填写的文本（及你选择附带的文件）。</li>
        <li>• 我们不会读取你的创作内容；在浏览器中清除站点数据即可彻底删除本地副本。</li>
      </ul>
      <Button variant="success" solid onClick={ok} className="mt-4 w-full rounded-lg px-3 py-2 font-medium">
        我已知晓
      </Button>
    </Modal>
  )
}
