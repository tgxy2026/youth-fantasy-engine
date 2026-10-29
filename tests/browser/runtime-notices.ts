import '@/index.css'
import { installMobileHint } from '@/lib/app/mobileHint'
import { installWebTabGuard } from '@/lib/app/tabGuard'
import { installAuthNavigation } from '@/lib/app/authNavigation'
installMobileHint(); installWebTabGuard(); installAuthNavigation()
declare global { interface Window { __noticeReady: boolean } }
window.__noticeReady = true
