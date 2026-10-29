/**
 * 图片失败占位的隔离夹具（UX13）。
 *
 * 真实 `<img>` + 真实网络失败：探针把 `/tests/browser/probe-image.png` 前 N 次打成 404，
 * 之后放真图 —— 这样「占位可见」与「重试真的重新请求」都能在浏览器里直接观察。
 */
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { initializeAppearance } from '../../src/lib/settings/appearance'
import SafeImage from '../../src/components/common/SafeImage'

initializeAppearance()

function Fixture() {
  const src = '/tests/browser/probe-image.png'
  return <div className="p-4 flex gap-4">
    <div id="retryable" className="w-40 h-40 relative border border-ink-600">
      <SafeImage src={src} alt="可重试的图" className="absolute inset-0 w-full h-full object-contain" />
    </div>
    <div id="plain" className="w-40 h-40 relative border border-ink-600">
      <SafeImage src={`${src}?plain=1`} alt="不给重试的图" retry={false} className="absolute inset-0 w-full h-full object-contain" />
    </div>
  </div>
}

createRoot(document.getElementById('fixture-root')!).render(<Fixture />)
