// 3.5.0 · 服务端限流器的最小类型声明（真源是 ratelimit.mjs）

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfter?: number }
export function resetLimit(key: string): void