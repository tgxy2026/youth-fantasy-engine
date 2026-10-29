/** Only transient column names and bounded search inputs. Never row values or draft snapshots. */
export function normalizeWorkspaceFilters(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > 128 || entries.some(([key, text]) => !key.trim() || key.length > 256
    || /[\u0000-\u001f\u007f]/.test(key) || typeof text !== 'string' || text.length > 200)) return null
  return Object.fromEntries(entries.map(([key, text]) => [key, text as string]))
}
