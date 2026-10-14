import type { IncomingMessage, ServerResponse } from 'node:http'

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

export function sendText(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(value)
}

/**
 * Whether a Host header names a loopback authority.
 *
 * The Desktop proxy may remove Host before forwarding a request into the
 * in-process DSH server, so an absent header is handled by sameOrigin below.
 * When it is present, keep the DNS-rebinding guard: a public page must not be
 * able to make a matching Origin/Host pair for an arbitrary authority.
 */
export function loopbackAuthority(host: string | undefined): boolean {
  if (host === undefined) return false
  const lower = host.toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]!
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/**
 * Accept same-origin browser requests and the official Desktop proxy's
 * header-stripped requests. A missing Origin is allowed because the proxy
 * strips it; a present but invalid/cross-site Origin remains rejected.
 */
function authority(value: string): URL | null {
  if (/[\s/@?#\\]/.test(value)) return null
  try {
    const parsed = new URL(`http://${value}`)
    return parsed.hostname === '' || parsed.pathname !== '/' ? null : parsed
  } catch { return null }
}

export function trustedAuthority(host: string, trustedHosts: readonly string[]): boolean {
  const parsed = authority(host)
  if (parsed === null) return false
  return trustedHosts.some(value => {
    const trusted = authority(value)
    const explicitPort = value.startsWith('[') ? /\]:\d+$/.test(value) : /:\d+$/.test(value)
    return trusted !== null && (explicitPort ? trusted.host === parsed.host : trusted.hostname === parsed.hostname)
  })
}

export function sameOrigin(request: IncomingMessage, trustedHosts: readonly string[] = []): boolean {
  const host = request.headers.host
  if (host !== undefined && !loopbackAuthority(host) && !trustedAuthority(host, trustedHosts)) return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === authority(host ?? '')?.host
  } catch { return false }
}

export interface HostConnectionLike {
  trustedHosts?: unknown
  requestRejection?(request: IncomingMessage): number | undefined
}

/** Consult the same host admission policy as its own API, including browser login. */
export function refuseUnadmitted(request: IncomingMessage, response: ServerResponse, connection?: HostConnectionLike): boolean {
  if (typeof connection?.requestRejection !== 'function') return false
  let status: number | undefined
  try { status = connection.requestRejection(request) } catch { status = 403 }
  if (status === undefined) return false
  sendJson(response, status === 401 ? 401 : 403, { error: status === 401 ? '请先登录当前 DSH 宿主' : '请求未通过宿主验证' })
  return true
}

export function directLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket?.remoteAddress
  return loopbackAuthority(request.headers.host)
    && (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1')
    && !Object.keys(request.headers).some(key => key === 'forwarded' || key === 'x-real-ip' || key.startsWith('x-forwarded-'))
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new Error('content-type must be application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid request body')
  return body as Record<string, unknown>
}

function compatibilityAcknowledgement(body: Record<string, unknown>): { acknowledgeCompatibility: boolean; compatibilityContext?: string } {
  if (body.acknowledgeCompatibility !== undefined && typeof body.acknowledgeCompatibility !== 'boolean') throw new Error('invalid compatibility acknowledgement')
  if (body.acknowledgeCompatibility !== true) return { acknowledgeCompatibility: false }
  if (typeof body.compatibilityContext !== 'string' || body.compatibilityContext.length === 0 || body.compatibilityContext.length > 4096) throw new Error('invalid compatibility context')
  return { acknowledgeCompatibility: true, compatibilityContext: body.compatibilityContext }
}

export async function readSkinMutation(request: IncomingMessage, limit = 8192): Promise<{ skinId: string; acknowledgeCompatibility: boolean; compatibilityContext?: string }> {
  const body = await readJsonBody(request, limit)
  if (typeof body.skinId !== 'string' || body.skinId.length > 128) throw new Error('invalid skinId')
  return { skinId: body.skinId, ...compatibilityAcknowledgement(body) }
}

export async function readSkinId(request: IncomingMessage, limit = 8192): Promise<string> {
  return (await readSkinMutation(request, limit)).skinId
}

export async function readOperationRetry(request: IncomingMessage, limit = 8192): Promise<{ action: 'retry' | 'approve-build'; acknowledgeCompatibility: boolean; compatibilityContext?: string }> {
  const body = await readJsonBody(request, limit)
  if (body.action !== 'retry' && body.action !== 'approve-build') throw new Error('invalid operation retry action')
  return { action: body.action, ...compatibilityAcknowledgement(body) }
}

export async function readOperationRetryAction(request: IncomingMessage, limit = 8192): Promise<'retry' | 'approve-build'> {
  return (await readOperationRetry(request, limit)).action
}

export type RestartTarget = { kind: 'skin'; skinId: string } | { kind: 'market-update' }

export async function readRestartTarget(request: IncomingMessage, limit = 8192): Promise<RestartTarget> {
  const body = await readJsonBody(request, limit)
  if (body.reason === 'market-update' && body.skinId === undefined) return { kind: 'market-update' }
  if (typeof body.skinId === 'string' && body.skinId.length <= 128 && body.reason === undefined) return { kind: 'skin', skinId: body.skinId }
  throw new Error('invalid restart target')
}
