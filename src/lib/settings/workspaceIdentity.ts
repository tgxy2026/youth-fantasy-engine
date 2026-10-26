import { workspaceScopeKey, type ViewIdentity, type ViewPlatform } from './workspaceViewState'

export interface WorkspaceIdentitySource {
  platform: ViewPlatform
  /** Private source identity. Hash it before using it in a view key; never persist or log it. */
  spaceSource: string
  /** Stable account ID, never the display/login name. */
  identity: string
  generation: number
  ready: boolean
}
export type IdentityDigest = (source: string) => Promise<string>

/** A single current context. A delayed digest cannot recreate an identity invalidated meanwhile. */
export function createWorkspaceIdentityResolver(read: () => WorkspaceIdentitySource, digest: IdentityDigest, invalidate: () => void) {
  let signature: string | null = null
  let resolved: ViewIdentity | null = null
  let pending: Promise<ViewIdentity | null> | null = null
  let request = 0
  const source = () => {
    try {
      const value = read()
      if (!value.ready || typeof value.spaceSource !== 'string' || value.spaceSource.length > 16384
        || !Number.isSafeInteger(value.generation) || value.generation < 0
        || !workspaceScopeKey({ ...value, space: 'pending', projectId: 'check', pageId: 'check' })) return null
      return { value, signature: JSON.stringify([value.platform, value.spaceSource, value.identity, value.generation]) }
    } catch { return null }
  }
  return {
    current(): ViewIdentity | null {
      return signature !== null && source()?.signature === signature ? resolved : null
    },
    resolve(): Promise<ViewIdentity | null> {
      const next = source()
      if (!next) {
        if (signature !== null) invalidate()
        request++
        signature = null; resolved = null; pending = null
        return Promise.resolve(null)
      }
      if (next.signature === signature && pending) return pending
      if (signature !== null) invalidate()
      const ticket = ++request
      signature = next.signature; resolved = null
      pending = Promise.resolve().then(() => digest(next.signature)).then(hash => {
        if (ticket !== request || signature !== next.signature || source()?.signature !== next.signature || !/^[a-f0-9]{64}$/.test(hash)) return null
        resolved = Object.freeze({ platform: next.value.platform, space: 'space-' + hash, identity: next.value.identity })
        return resolved
      }).catch(() => null)
      return pending
    },
  }
}

export async function digestWorkspaceIdentity(source: string): Promise<string> {
  // If a non-secure host lacks WebCrypto, optional view restoration safely stays unavailable.
  const result = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('')
}
