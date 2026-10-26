import { DESKTOP, getDesktopState, subscribeDesktop } from '@/lib/app/desktop'
import { WEB_CLOUD, WEB_GUEST } from '@/lib/app/platform'
import { PORTABLE, getPortableState, subscribePortable } from '@/lib/storage/fileBackend'
import { getStorageContextEpoch, subscribeProjectDeletion, subscribeStorageContext } from '@/lib/storage/contextEpoch'
import { createWorkspaceIdentityResolver, digestWorkspaceIdentity, type WorkspaceIdentitySource } from './workspaceIdentity'
import { workspaceViews, type WorkspaceScope } from './workspaceViewState'

const readIdentity = (): WorkspaceIdentitySource => {
  const platform = DESKTOP ? 'desktop' : WEB_CLOUD ? 'web-cloud' : WEB_GUEST ? 'web-guest' : PORTABLE ? 'portable' : 'browser'
  const state = DESKTOP ? getDesktopState() : PORTABLE ? getPortableState() : null
  const account = (window as unknown as { __YFE_USER__?: { id?: string } }).__YFE_USER__?.id
  return { platform, identity: WEB_CLOUD ? account ?? '' : 'local', generation: getStorageContextEpoch(),
    spaceSource: JSON.stringify([location.origin, state?.dataPath ?? 'browser-local', getStorageContextEpoch()]),
    ready: state ? state.connected : true }
}
const identities = createWorkspaceIdentityResolver(readIdentity, digestWorkspaceIdentity, () => workspaceViews.clear())
export const resolveWorkspaceIdentity = () => identities.resolve()
export function currentWorkspaceScope(projectId: string, pageId: string): WorkspaceScope | null {
  const identity = identities.current()
  return identity ? { ...identity, projectId, pageId } : null
}

/** Mount once at the application root. Full-page logout/import reload never keeps an old session view. */
export function observeWorkspaceLifecycle(): () => void {
  const refresh = () => { void identities.resolve() }
  const clear = () => workspaceViews.clear()
  const removeProject = (projectId: string) => {
    const scope = currentWorkspaceScope(projectId, 'all-pages')
    if (scope) workspaceViews.deleteProject(scope)
    else clear()
  }
  refresh()
  const offStorage = subscribeStorageContext(() => { clear(); refresh() })
  const offProject = subscribeProjectDeletion(removeProject)
  const offBackend = DESKTOP ? subscribeDesktop(refresh) : PORTABLE ? subscribePortable(refresh) : () => {}
  window.addEventListener('pagehide', clear)
  window.addEventListener('storage', refresh)
  return () => { offStorage(); offProject(); offBackend(); window.removeEventListener('pagehide', clear); window.removeEventListener('storage', refresh) }
}

let capture: (() => void) | null = null
export function registerWorkspaceCapture(next: () => void): () => void {
  capture = next
  return () => { if (capture === next) capture = null }
}
/** Synchronous capture starts optional hashing; it never delays a clean navigation or claims a save succeeded. */
export function captureWorkspaceView(): void {
  try { capture?.() } catch { /* Failed view capture must not change the existing save/leave decision. */ }
}
