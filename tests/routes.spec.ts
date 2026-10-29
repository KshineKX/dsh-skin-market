import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertRestartClearOfSkinOperations, canRestartSkin, mountRoutes, runningAgentCount, waitForRestartSafety, type AgentLike, type RouteOptions, type WebServerService } from '../src/routes.ts'
import type { Operation } from '../src/types.ts'
import type { LoaderEntry } from '../src/types.ts'
import type { HostConnectionLike } from '../src/http.ts'
import { SkinLifecycle } from '../src/lifecycle.ts'
import type { MarketUpdater } from '../src/self-update.ts'

const admissionFixtures: Array<{ directory: string; dispose: () => void | Promise<void> }> = []
afterEach(async () => {
  for (const { directory, dispose } of admissionFixtures.splice(0)) {
    await dispose()
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function admissionFixture(options: Pick<RouteOptions, 'connection' | 'hostKind'> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'market-route-admission-'))
  const routes: Array<Parameters<WebServerService['register']>[0]> = []
  const snapshot = { catalog: { schemaVersion: 1, generatedAt: '2026-10-14T00:00:00Z', skins: [] }, source: 'embedded', lastCheckedAt: null }
  const refresh = vi.fn(async () => snapshot)
  const operation = { id: 'market-operation', phase: 'queued' as const, startedAt: '2026-10-14T00:00:00Z' }
  let liveMarketOperation: ReturnType<MarketUpdater['currentOperation']> = null
  const updater = {
    restartRequired: true,
    status: vi.fn(async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false })),
    update: vi.fn(async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false })),
    startUpdate: vi.fn(() => operation),
    operation: vi.fn(() => operation),
    currentOperation: vi.fn(() => liveMarketOperation),
    cancel: vi.fn(() => ({ ...operation, phase: 'cancelled' as const })),
    retry: vi.fn(() => operation),
    dispose: vi.fn(async () => undefined),
  }
  const begin = vi.spyOn(SkinLifecycle.prototype, 'begin').mockImplementation((kind, skinId) => ({
    id: 'skin-operation', kind, skinId, phase: 'queued', startedAt: '2026-10-14T00:00:00Z',
  }))
  const schedule = vi.fn()
  const dispose = mountRoutes({
    webServer: { register(route) { routes.push(route); return () => undefined } },
    agents: { list: () => [] },
    loader: { entries: (): Iterable<LoaderEntry> => [] },
  }, {
    ...options,
    profile: 'test', profileDir: directory,
    runner: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })),
    catalogStore: { snapshot: () => snapshot, refresh } as unknown as RouteOptions['catalogStore'],
    marketUpdater: updater,
    restart: { available: true, schedule },
  })
  admissionFixtures.push({ directory, dispose })
  const request = async (path: string, method: 'GET' | 'POST', headers: IncomingMessage['headers'] = {}, remoteAddress: string | null = '127.0.0.1', requestBody?: Record<string, unknown> | null) => {
    const pathname = path.split('?')[0]!
    const route = routes.find(item => item.path === pathname || item.kind === 'prefix' && pathname.startsWith(`${item.path}/`))
    if (route === undefined) throw new Error(`unregistered route ${path}`)
    const body = requestBody === null ? null : requestBody ?? (path === '/dsh-skin-market/restart' ? { reason: 'market-update' } : path.includes('/market-update/operations/') ? { action: 'retry' } : { skinId: 'fixture-skin', action: 'retry' })
    const incoming = Readable.from(method === 'POST' && body !== null ? [JSON.stringify(body)] : []) as IncomingMessage
    Object.assign(incoming, { method, url: path, headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers }, socket: remoteAddress === null ? {} : { remoteAddress } })
    const response = { writeHead: vi.fn(), end: vi.fn() }
    await route.handler(incoming, response as unknown as ServerResponse)
    return { incoming, response, status: response.writeHead.mock.calls.at(-1)?.[0] as number, body: response.end.mock.calls.at(-1)?.[0] as string }
  }
  return { request, routes, refresh, updater, begin, schedule, setMarketOperation: (value: typeof liveMarketOperation) => { liveMarketOperation = value } }
}

const guardedRequests = [
  ['/dsh-skin-market/catalog', 'GET'],
  ['/dsh-skin-market/logs', 'GET'],
  ['/dsh-skin-market/state', 'GET'],
  ['/dsh-skin-market/selection-plan', 'POST'],
  ['/dsh-skin-market/market-update', 'GET'],
  ['/dsh-skin-market/market-update', 'POST'],
  ['/dsh-skin-market/operations/fixture', 'GET'],
  ['/dsh-skin-market/operations/fixture/cancel', 'POST'],
  ['/dsh-skin-market/operations/fixture/retry', 'POST'],
  ['/dsh-skin-market/market-update/operations/fixture', 'GET'],
  ['/dsh-skin-market/market-update/operations/fixture/cancel', 'POST'],
  ['/dsh-skin-market/market-update/operations/fixture/retry', 'POST'],
  ...['install', 'activate', 'deactivate', 'pin', 'unpin', 'update', 'migrate', 'uninstall', 'restart', 'restart/clear'].map(action => [`/dsh-skin-market/${action}`, 'POST'] as const),
] as const

it('reports the running host environment independently of the browser user agent', async () => {
  const fixture = admissionFixture()
  const result = await fixture.request('/dsh-skin-market/state', 'GET', { 'user-agent': 'Windows browser on a different computer' })
  expect(result.status).toBe(200)
  const environment = JSON.parse(result.body).installEnvironment
  expect(environment.platform).toBe(['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'unknown')
  expect(environment.profile).toBe('test')
  expect(environment.profileDir).toContain('market-route-admission-')
  expect(environment.cliAvailable).toBe(false)
})

describe('host admission for every market route', () => {
  it.each([401, 403, 'throw'] as const)('refuses all exact and prefix read/mutation paths when host admission returns %s', rejection => {
    const gate = vi.fn(() => { if (rejection === 'throw') throw new Error('host admission unavailable'); return rejection })
    const fixture = admissionFixture({ connection: () => ({ requestRejection: gate }) })
    return (async () => {
      expect(fixture.routes.filter(route => !guardedRequests.some(([path]) => path === route.path || route.kind === 'prefix' && path.startsWith(`${route.path}/`))).map(route => route.path)).toEqual([])
      for (const [path, method] of guardedRequests) {
        const result = await fixture.request(path, method)
        expect(result.status, `${method} ${path}`).toBe(rejection === 401 ? 401 : 403)
        expect(JSON.parse(result.body).error).toBe(rejection === 401 ? '请先登录当前 DSH 宿主' : '请求未通过宿主验证')
      }
      expect(gate).toHaveBeenCalledTimes(guardedRequests.length)
      expect(fixture.refresh).not.toHaveBeenCalled()
      expect(fixture.updater.status).not.toHaveBeenCalled()
      expect(fixture.updater.startUpdate).not.toHaveBeenCalled()
      expect(fixture.updater.operation).not.toHaveBeenCalled()
      expect(fixture.updater.cancel).not.toHaveBeenCalled()
      expect(fixture.updater.retry).not.toHaveBeenCalled()
      expect(fixture.begin).not.toHaveBeenCalled()
      expect(fixture.schedule).not.toHaveBeenCalled()
    })()
  })

  it('fails closed when resolving the host admission service throws', async () => {
    const fixture = admissionFixture({ connection: () => { throw new Error('connection service unavailable') } })
    expect((await fixture.request('/dsh-skin-market/catalog', 'GET')).status).toBe(403)
    expect((await fixture.request('/dsh-skin-market/install', 'POST')).status).toBe(403)
    expect(fixture.refresh).not.toHaveBeenCalled()
    expect(fixture.begin).not.toHaveBeenCalled()
  })

  it('looks up admission for every request, including late service appearance and changed login state', async () => {
    let connection: HostConnectionLike | undefined
    let admitted = false
    const gate = vi.fn(() => admitted ? undefined : 401)
    const fixture = admissionFixture({ connection: () => connection })
    expect((await fixture.request('/dsh-skin-market/state', 'GET')).status).toBe(200)
    connection = { requestRejection: gate }
    expect((await fixture.request('/dsh-skin-market/state', 'GET')).status).toBe(401)
    admitted = true
    expect((await fixture.request('/dsh-skin-market/state', 'GET')).status).toBe(200)
    admitted = false
    expect((await fixture.request('/dsh-skin-market/market-update/operations/fixture', 'GET')).status).toBe(401)
    expect(gate).toHaveBeenCalledTimes(3)
  })

  it('accepts Desktop proxy requests with stripped Origin/Host only after host admission', async () => {
    const gate = vi.fn((request: IncomingMessage) => request.headers.cookie === 'admitted-test-session' ? undefined : 401)
    const fixture = admissionFixture({ hostKind: 'desktop', connection: () => ({ requestRejection: gate }) })
    const refused = await fixture.request('/dsh-skin-market/install', 'POST')
    expect(refused.status).toBe(401)
    expect(fixture.begin).not.toHaveBeenCalled()
    const accepted = await fixture.request('/dsh-skin-market/install', 'POST', { cookie: 'admitted-test-session' })
    expect(accepted.status).toBe(202)
    expect(accepted.incoming.headers.host).toBeUndefined()
    expect(accepted.incoming.headers.origin).toBeUndefined()
    expect(gate).toHaveBeenLastCalledWith(accepted.incoming)
    expect(fixture.begin).toHaveBeenCalledExactlyOnceWith('install', 'fixture-skin', undefined, false, undefined)
  })

  it('honors only explicitly declared non-loopback authorities for admitted mutation requests', async () => {
    let trustedHosts: string[] = []
    const fixture = admissionFixture({ connection: () => ({ requestRejection: () => undefined, trustedHosts }) })
    const headers = { host: 'harness.example.test:8443', origin: 'https://harness.example.test:8443' }
    expect((await fixture.request('/dsh-skin-market/install', 'POST', headers)).status).toBe(403)
    trustedHosts = ['harness.example.test:8443']
    expect((await fixture.request('/dsh-skin-market/install', 'POST', headers)).status).toBe(202)
    expect((await fixture.request('/dsh-skin-market/install', 'POST', { host: 'harness.example.test:8444', origin: 'https://harness.example.test:8444' })).status).toBe(403)
    expect((await fixture.request('/dsh-skin-market/install', 'POST', { ...headers, origin: 'https://evil.example.test:8443' })).status).toBe(403)
    expect(fixture.begin).toHaveBeenCalledTimes(1)
  })

  it('schedules restart only for an admitted direct loopback socket', async () => {
    const fixture = admissionFixture({ connection: () => ({ requestRejection: () => undefined, trustedHosts: ['harness.example.test'] }) })
    const base = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
    for (const remoteAddress of [null, '10.0.0.1', '::ffff:10.0.0.1']) {
      expect((await fixture.request('/dsh-skin-market/restart', 'POST', base, remoteAddress)).status).toBe(403)
    }
    expect((await fixture.request('/dsh-skin-market/restart', 'POST')).status).toBe(403)
    expect((await fixture.request('/dsh-skin-market/restart', 'POST', { host: 'harness.example.test', origin: 'https://harness.example.test' })).status).toBe(403)
    for (const header of ['forwarded', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) {
      expect((await fixture.request('/dsh-skin-market/restart', 'POST', { ...base, [header]: '127.0.0.1' })).status).toBe(403)
    }
    expect(fixture.schedule).not.toHaveBeenCalled()
    const accepted = await fixture.request('/dsh-skin-market/restart', 'POST', base)
    expect(accepted.status).toBe(202)
    expect(JSON.parse(accepted.body)).toMatchObject({ restarting: true })
    expect(fixture.schedule).toHaveBeenCalledTimes(1)
  })

  it.each(['checking', 'installing', 'waiting'] as const)('blocks skin writes and retries while market self-update is %s, and keeps cancellation available', async phase => {
    const fixture = admissionFixture()
    const operation = { id: 'existing-skin', kind: 'install' as const, skinId: 'fixture-skin', phase: 'queued' as const, startedAt: '2026-10-14T00:00:00Z' }
    const retry = vi.spyOn(SkinLifecycle.prototype, 'retry').mockImplementation(() => operation)
    const cancel = vi.spyOn(SkinLifecycle.prototype, 'cancel').mockImplementation(() => ({ ...operation, phase: 'cancelled' }))
    fixture.setMarketOperation({ id: 'active-market-update', phase, startedAt: operation.startedAt })
    for (const action of ['install', 'activate', 'deactivate', 'pin', 'unpin', 'update', 'migrate', 'uninstall']) {
      const result = await fixture.request(`/dsh-skin-market/${action}`, 'POST')
      expect(result.status).toBe(409)
      expect(JSON.parse(result.body).error).toContain(phase === 'waiting' ? '宿主尚未确认' : '皮肤市场正在更新')
    }
    expect((await fixture.request('/dsh-skin-market/operations/existing-skin/retry', 'POST')).status).toBe(409)
    expect((await fixture.request('/dsh-skin-market/operations/existing-skin/retry', 'POST', {}, '127.0.0.1', { action: 'approve-release-age' })).status).toBe(409)
    expect(fixture.begin).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
    expect((await fixture.request('/dsh-skin-market/operations/existing-skin/cancel', 'POST')).status).toBe(202)
    expect(cancel).toHaveBeenCalledExactlyOnceWith('existing-skin')

    fixture.setMarketOperation({ id: 'active-market-update', phase: 'done', startedAt: operation.startedAt })
    expect((await fixture.request('/dsh-skin-market/install', 'POST')).status).toBe(202)
    expect((await fixture.request('/dsh-skin-market/operations/existing-skin/retry', 'POST')).status).toBe(202)
    expect(fixture.begin).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledExactlyOnceWith('existing-skin', 'retry', false, undefined)
  })

  it.each(['downloading', 'activating', 'waiting'] as const)('blocks market self-update writes and retries while a skin operation is %s', async phase => {
    const fixture = admissionFixture()
    const currentOperations = vi.spyOn(SkinLifecycle.prototype, 'currentOperations').mockReturnValue([{
      id: 'active-skin', kind: phase === 'activating' ? 'activate' : 'install', skinId: 'fixture-skin', phase, startedAt: '2026-10-14T00:00:00Z',
    }])
    expect((await fixture.request('/dsh-skin-market/market-update', 'POST')).status).toBe(409)
    expect((await fixture.request('/dsh-skin-market/market-update/operations/existing-update/retry', 'POST')).status).toBe(409)
    expect((await fixture.request('/dsh-skin-market/market-update/operations/existing-update/retry', 'POST', {}, '127.0.0.1', { action: 'approve-release-age' })).status).toBe(409)
    expect(fixture.updater.startUpdate).not.toHaveBeenCalled()
    expect(fixture.updater.retry).not.toHaveBeenCalled()
    expect((await fixture.request('/dsh-skin-market/market-update', 'GET')).status).toBe(200)
    expect((await fixture.request('/dsh-skin-market/market-update/operations/existing-update/cancel', 'POST')).status).toBe(202)
    expect(fixture.updater.cancel).toHaveBeenCalledExactlyOnceWith('existing-update')

    currentOperations.mockReturnValue([])
    expect((await fixture.request('/dsh-skin-market/market-update', 'POST')).status).toBe(202)
    expect((await fixture.request('/dsh-skin-market/market-update/operations/existing-update/retry', 'POST')).status).toBe(202)
    expect(fixture.updater.startUpdate).toHaveBeenCalledTimes(1)
    expect(fixture.updater.retry).toHaveBeenCalledExactlyOnceWith('existing-update', 'retry')
  })
})

describe('market routes', () => {
  it.each(['install', 'update'] as const)('forwards explicit and omitted compatibility acknowledgement for %s', async kind => {
    const fixture = admissionFixture()
    for (const acknowledgement of [undefined, false, true]) {
      const body = acknowledgement === undefined ? { compatibilityContext: 'ignored-version' } : { acknowledgeCompatibility: acknowledgement, compatibilityContext: acknowledgement ? 'shown-version' : 'ignored-version' }
      const result = await fixture.request(`/dsh-skin-market/${kind}`, 'POST', {}, '127.0.0.1', { skinId: 'fixture-skin', ...body })
      expect(result.status).toBe(202)
      expect(fixture.begin).toHaveBeenLastCalledWith(kind, 'fixture-skin', undefined, acknowledgement === true, acknowledgement ? 'shown-version' : undefined)
    }
    expect(fixture.begin).toHaveBeenCalledTimes(3)
  })

  it.each(['retry', 'approve-build', 'approve-release-age', 'approve-artifact'] as const)('forwards compatibility acknowledgement with the %s retry action', async action => {
    const fixture = admissionFixture()
    const retry = vi.spyOn(SkinLifecycle.prototype, 'retry').mockImplementation(() => ({
      id: 'retried-operation', kind: 'install', skinId: 'fixture-skin', phase: 'queued', startedAt: '2026-10-14T00:00:00Z',
    }))
    for (const acknowledgement of [undefined, false, true]) {
      const body = acknowledgement === undefined ? { compatibilityContext: 'ignored-version' } : { acknowledgeCompatibility: acknowledgement, compatibilityContext: acknowledgement ? 'shown-version' : 'ignored-version' }
      const result = await fixture.request('/dsh-skin-market/operations/existing-skin/retry', 'POST', {}, '127.0.0.1', { action, ...body })
      expect(result.status).toBe(202)
      expect(JSON.parse(result.body)).toEqual({ operationId: 'retried-operation' })
      expect(retry).toHaveBeenLastCalledWith('existing-skin', action, acknowledgement === true, acknowledgement ? 'shown-version' : undefined)
    }
    expect(retry).toHaveBeenCalledTimes(3)
  })

  it.each(['activate', 'pin'])('forwards the displayed artifact context together with compatibility consent during %s', async kind => {
    const fixture = admissionFixture()
    const result = await fixture.request(`/dsh-skin-market/${kind}`, 'POST', {}, '127.0.0.1', {
      skinId: 'fixture-skin', acknowledgeCompatibility: true, compatibilityContext: 'shown-compatibility', artifactContext: 'shown-artifact',
    })
    expect(result.status).toBe(202)
    expect(fixture.begin).toHaveBeenCalledExactlyOnceWith(kind, 'fixture-skin', undefined, true, 'shown-compatibility', undefined, 'shown-artifact')
  })

  it('forwards confirmed local source context only in the final migration argument', async () => {
    const fixture = admissionFixture()
    const sourceContext = 'a0'.repeat(32)
    const result = await fixture.request('/dsh-skin-market/migrate', 'POST', {}, '127.0.0.1', { skinId: 'fixture-skin', sourceContext })
    expect(result.status).toBe(202)
    expect(fixture.begin).toHaveBeenCalledExactlyOnceWith('migrate', 'fixture-skin', undefined, false, undefined, undefined, undefined, undefined, undefined, sourceContext)
  })

  it('preserves existing migration argument shape when source context is omitted', async () => {
    const fixture = admissionFixture()
    const result = await fixture.request('/dsh-skin-market/migrate', 'POST', {}, '127.0.0.1', { skinId: 'fixture-skin' })
    expect(result.status).toBe(202)
    expect(fixture.begin).toHaveBeenCalledExactlyOnceWith('migrate', 'fixture-skin', undefined, false, undefined)
  })

  it.each(['install', 'activate', 'deactivate', 'pin', 'unpin', 'update', 'uninstall'])('rejects local source context on the %s route', async kind => {
    const fixture = admissionFixture()
    const result = await fixture.request(`/dsh-skin-market/${kind}`, 'POST', {}, '127.0.0.1', { skinId: 'fixture-skin', sourceContext: 'a'.repeat(64) })
    expect(result.status).toBe(409)
    expect(JSON.parse(result.body).error).toBe('invalid source context')
    expect(fixture.begin).not.toHaveBeenCalled()
  })

  it.each(['', 1, null, {}, [], 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(64)}\n`])('rejects malformed local source context before migration (%j)', async sourceContext => {
    const fixture = admissionFixture()
    const result = await fixture.request('/dsh-skin-market/migrate', 'POST', {}, '127.0.0.1', { skinId: 'fixture-skin', sourceContext })
    expect(result.status).toBe(409)
    expect(fixture.begin).not.toHaveBeenCalled()
  })

  it('rejects local source context mixed into selection repair and repair retries', async () => {
    const fixture = admissionFixture()
    const retry = vi.spyOn(SkinLifecycle.prototype, 'retry')
    const contexts = { sourceContext: 'a'.repeat(64), configurationContext: 'b'.repeat(64) }
    const selection = await fixture.request('/dsh-skin-market/activate', 'POST', {}, '127.0.0.1', { skinId: 'fixture-skin', ...contexts })
    expect(selection.status).toBe(409)
    expect(JSON.parse(selection.body).error).toBe('invalid configuration repair request')
    const repaired = await fixture.request('/dsh-skin-market/operations/existing-skin/retry', 'POST', {}, '127.0.0.1', { action: 'repair-configuration', ...contexts })
    expect(repaired.status).toBe(409)
    expect(JSON.parse(repaired.body).error).toBe('invalid configuration repair request')
    const retried = await fixture.request('/dsh-skin-market/operations/existing-skin/retry', 'POST', {}, '127.0.0.1', { action: 'retry', sourceContext: contexts.sourceContext })
    expect(retried.status).toBe(409)
    expect(fixture.begin).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
  })

  it('preserves an explicitly accepted artifact context when retrying an activation', async () => {
    const fixture = admissionFixture()
    const retry = vi.spyOn(SkinLifecycle.prototype, 'retry').mockImplementation(() => ({
      id: 'retried-operation', kind: 'activate', skinId: 'fixture-skin', phase: 'queued', startedAt: '2026-10-16T00:00:00Z',
    }))
    const result = await fixture.request('/dsh-skin-market/operations/existing-skin/retry', 'POST', {}, '127.0.0.1', {
      action: 'retry', acknowledgeCompatibility: true, compatibilityContext: 'shown-compatibility', artifactContext: 'shown-artifact',
    })
    expect(result.status).toBe(202)
    expect(retry).toHaveBeenCalledExactlyOnceWith('existing-skin', 'retry', true, 'shown-compatibility', 'shown-artifact')
  })

  it.each(['', 1, null, {}, [], 'x'.repeat(4097)])('rejects invalid artifact context before starting a lifecycle operation (%j)', async artifactContext => {
    const fixture = admissionFixture()
    const result = await fixture.request('/dsh-skin-market/activate', 'POST', {}, '127.0.0.1', { skinId: 'fixture-skin', artifactContext })
    expect(result.status).toBe(409)
    expect(fixture.begin).not.toHaveBeenCalled()
  })

  it.each(['retry', 'approve-release-age'] as const)('forwards only the explicit %s action for market update retries', async action => {
    const fixture = admissionFixture()
    const result = await fixture.request('/dsh-skin-market/market-update/operations/existing-update/retry', 'POST', {}, '127.0.0.1', { action })
    expect(result.status).toBe(202)
    expect(fixture.updater.retry).toHaveBeenCalledExactlyOnceWith('existing-update', action)
  })

  it('preserves a bodyless market retry as ordinary retry', async () => {
    const fixture = admissionFixture()
    const result = await fixture.request('/dsh-skin-market/market-update/operations/existing-update/retry', 'POST', {}, '127.0.0.1', null)
    expect(result.status).toBe(202)
    expect(fixture.updater.retry).toHaveBeenCalledExactlyOnceWith('existing-update', 'retry')
  })

  it.each([{ action: 'approve-build' }, { action: 'approve-artifact' }, { action: null }, { action: 'approve-release-age', packageName: 'other' }, { releaseAgeTarget: { packageName: 'other', version: '1.0.0' } }])('rejects invalid market retry bodies before any update (%j)', async body => {
    const fixture = admissionFixture()
    const result = await fixture.request('/dsh-skin-market/market-update/operations/existing-update/retry', 'POST', {}, '127.0.0.1', body)
    expect(result.status).toBe(409)
    expect(fixture.updater.retry).not.toHaveBeenCalled()
  })

  it.each(['/dsh-skin-market/operations/existing-skin/retry', '/dsh-skin-market/market-update/operations/existing-update/retry'])('keeps exact-version approval protected by same origin (%s)', async path => {
    const fixture = admissionFixture()
    const result = await fixture.request(path, 'POST', { host: '127.0.0.1:3080', origin: 'https://evil.example' }, '127.0.0.1', { action: 'approve-release-age' })
    expect(result.status).toBe(403)
    expect(fixture.updater.retry).not.toHaveBeenCalled()
  })

  it('requires the same origin for artifact risk acceptance before calling the skin lifecycle', async () => {
    const fixture = admissionFixture()
    const retry = vi.spyOn(SkinLifecycle.prototype, 'retry')
    const result = await fixture.request('/dsh-skin-market/operations/existing-skin/retry', 'POST', { host: '127.0.0.1:3080', origin: 'https://evil.example' }, '127.0.0.1', { action: 'approve-artifact' })
    expect(result.status).toBe(403)
    expect(retry).not.toHaveBeenCalled()
  })

  it.each(['skin', 'market'] as const)('rechecks mutual exclusion after a streamed %s approval body is read', async kind => {
    const fixture = admissionFixture()
    const retrySkin = vi.spyOn(SkinLifecycle.prototype, 'retry')
    const currentSkinOperations = vi.spyOn(SkinLifecycle.prototype, 'currentOperations').mockReturnValue([])
    const routePath = kind === 'skin' ? '/dsh-skin-market/operations' : '/dsh-skin-market/market-update/operations'
    const route = fixture.routes.find(item => item.path === routePath)!
    let finishBody!: () => void
    let readingBody!: () => void
    const bodyGate = new Promise<void>(resolve => { finishBody = resolve })
    const bodyStarted = new Promise<void>(resolve => { readingBody = resolve })
    const incoming = Readable.from((async function* () {
      yield '{"action":'
      readingBody()
      await bodyGate
      yield '"approve-release-age"}'
    })()) as IncomingMessage
    Object.assign(incoming, { method: 'POST', url: `${routePath}/existing/retry`, headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } })
    const response = { writeHead: vi.fn(), end: vi.fn() }
    const pending = route.handler(incoming, response as unknown as ServerResponse)
    await bodyStarted
    if (kind === 'skin') fixture.setMarketOperation({ id: 'now-updating', phase: 'installing', startedAt: '2026-10-15T00:00:00Z' })
    else currentSkinOperations.mockReturnValue([{ id: 'now-installing', skinId: 'fixture-skin', kind: 'install', phase: 'installing', startedAt: '2026-10-15T00:00:00Z' }])
    finishBody()
    await pending
    expect(response.writeHead).toHaveBeenLastCalledWith(409, expect.any(Object))
    expect(retrySkin).not.toHaveBeenCalled()
    expect(fixture.updater.retry).not.toHaveBeenCalled()
  })

  it.each(['true', 'false', 1, 0, null, {}, []])('refuses non-boolean compatibility acknowledgements before beginning or retrying (%j)', async acknowledgeCompatibility => {
    const fixture = admissionFixture()
    const retry = vi.spyOn(SkinLifecycle.prototype, 'retry')
    for (const path of ['/dsh-skin-market/install', '/dsh-skin-market/update', '/dsh-skin-market/operations/existing-skin/retry']) {
      const result = await fixture.request(path, 'POST', {}, '127.0.0.1', { skinId: 'fixture-skin', action: 'retry', acknowledgeCompatibility })
      expect(result.status).toBe(409)
      expect(JSON.parse(result.body).error).toBe('invalid compatibility acknowledgement')
    }
    expect(fixture.begin).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
  })

  it.each([undefined, '', 1, null, {}, [], 'x'.repeat(4097)])('refuses acknowledgements without bounded compatibility context before beginning or retrying (%j)', async compatibilityContext => {
    const fixture = admissionFixture()
    const retry = vi.spyOn(SkinLifecycle.prototype, 'retry')
    for (const path of ['/dsh-skin-market/install', '/dsh-skin-market/update', '/dsh-skin-market/operations/existing-skin/retry']) {
      const result = await fixture.request(path, 'POST', {}, '127.0.0.1', { skinId: 'fixture-skin', action: 'retry', acknowledgeCompatibility: true, compatibilityContext })
      expect(result.status).toBe(409)
      expect(JSON.parse(result.body).error).toMatch(/compatibility/)
    }
    expect(fixture.begin).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
  })

  it('blocks restart while an Agent is running and waits for idle maintenance', async () => {
    const idle = { status: 'idle', whenIdle: async () => undefined } satisfies AgentLike
    const running = { status: 'running', whenIdle: async () => undefined } satisfies AgentLike
    const host = { agents: { list: () => [idle, running] } }

    expect(runningAgentCount(host)).toBe(1)
    await expect(waitForRestartSafety(host)).rejects.toThrow('检测到 1 个 Agent 正在运行')

    let maintenanceFinished = false
    const maintaining = { status: 'idle', whenIdle: async () => { maintenanceFinished = true } } satisfies AgentLike
    await expect(waitForRestartSafety({ agents: { list: () => [maintaining] } })).resolves.toBeUndefined()
    expect(maintenanceFinished).toBe(true)
  })

  it('refuses restart while a skin install or market update is still running', () => {
    const downloading = {
      id: 'op', kind: 'install', skinId: 'skin', phase: 'downloading', startedAt: '2026-01-01T00:00:00Z',
    } satisfies Operation
    expect(() => assertRestartClearOfSkinOperations([downloading])).toThrow('皮肤操作未完成')
    expect(() => assertRestartClearOfSkinOperations([], { phase: 'installing' })).toThrow('皮肤市场正在更新')
    expect(() => assertRestartClearOfSkinOperations([{ ...downloading, kind: 'activate', phase: 'activating' }])).toThrow('皮肤操作未完成')
    expect(() => assertRestartClearOfSkinOperations([{ ...downloading, phase: 'done' }])).not.toThrow()
  })

  it('allows restart when the selected skin is Host-active or restart-required', () => {
    const base = { skinId: 'skin', installation: 'installed', installedVersion: '1.0.0', updateAvailable: false } as const
    expect(canRestartSkin({ ...base, activation: 'active' })).toBe(true)
    expect(canRestartSkin({ ...base, activation: 'restart-required' })).toBe(true)
    expect(canRestartSkin({ ...base, activation: 'inactive' })).toBe(false)
    expect(canRestartSkin({ ...base, installation: 'missing', activation: 'restart-required' })).toBe(false)
  })

  it('registers the operation poller as a valid DSH prefix route', () => {
    const routes: Array<{ kind: 'exact' | 'prefix'; path: string }> = []
    const webServer: WebServerService = {
      register(route) {
        routes.push({ kind: route.kind, path: route.path })
        return () => undefined
      },
    }
    const dispose = mountRoutes({
      webServer,
      agents: { list: () => [] },
      loader: { entries: (): Iterable<LoaderEntry> => [] },
    }, {
      profile: 'test',
      profileDir: '/tmp/dsh-skin-market-route-test-missing-profile',
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    })

    expect(routes).toContainEqual({ kind: 'prefix', path: '/dsh-skin-market/operations' })
    expect(routes).not.toContainEqual({ kind: 'prefix', path: '/dsh-skin-market/operations/' })
    expect(routes).not.toContainEqual({ kind: 'exact', path: '/dsh-skin-market/catalog/refresh' })
    expect(routes).toContainEqual({ kind: 'exact', path: '/dsh-skin-market/market-update' })
    expect(routes).toContainEqual({ kind: 'prefix', path: '/dsh-skin-market/market-update/operations' })
    expect(routes).toContainEqual({ kind: 'exact', path: '/dsh-skin-market/logs' })
    expect(routes).toContainEqual({ kind: 'exact', path: '/dsh-skin-market/pin' })
    expect(routes).toContainEqual({ kind: 'exact', path: '/dsh-skin-market/unpin' })
    expect(routes).toContainEqual({ kind: 'exact', path: '/dsh-skin-market/migrate' })
    dispose()
  })

  it('exposes a pending market update restart in Host state', async () => {
    const handlers = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
    const webServer: WebServerService = {
      register(route) {
        handlers.set(route.path, route.handler)
        return () => undefined
      },
    }
    const marketUpdater = {
      restartRequired: true,
      status: async () => ({ currentVersion: '0.1.29', latestVersion: '0.1.29', updateAvailable: false }),
      update: async () => ({ currentVersion: '0.1.29', latestVersion: '0.1.29', updateAvailable: false }),
      startUpdate: () => { throw new Error('not used') },
      operation: () => null,
      currentOperation: () => null,
      cancel: () => { throw new Error('not used') },
    }
    const dispose = mountRoutes({
      webServer,
      agents: { list: () => [] },
      loader: { entries: (): Iterable<LoaderEntry> => [] },
    }, {
      profile: 'test',
      profileDir: '/tmp/dsh-skin-market-route-test-missing-profile',
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      marketUpdater,
    })

    const response = {
      writeHead: (_status: number, _headers: Record<string, string>) => undefined,
      end: (body: string) => {
        expect(JSON.parse(body)).toMatchObject({ marketUpdateRestartRequired: true })
      },
    } as unknown as ServerResponse
    await handlers.get('/dsh-skin-market/state')?.({ method: 'GET', headers: {} } as IncomingMessage, response)
    dispose()
  })

  it('waits for the market updater before unregistering routes', async () => {
    const disposers: Array<() => void> = []
    const webServer: WebServerService = {
      register() {
        const dispose = () => { disposers.push(dispose) }
        return dispose
      },
    }
    let resolveUpdater!: () => void
    let updaterDisposed = false
    const updater = {
      restartRequired: false,
      status: async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false }),
      update: async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false }),
      startUpdate: () => { throw new Error('not used') },
      operation: () => null,
      currentOperation: () => null,
      cancel: () => { throw new Error('not used') },
      retry: () => { throw new Error('not used') },
      dispose: async () => {
        await new Promise<void>(resolve => { resolveUpdater = resolve })
        updaterDisposed = true
      },
    }
    const disposeRoutes = mountRoutes({
      webServer,
      agents: { list: () => [] },
      loader: { entries: (): Iterable<LoaderEntry> => [] },
    }, {
      profile: 'test',
      profileDir: '/tmp/dsh-skin-market-route-updater-dispose',
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      marketUpdater: updater,
    })

    const disposing = disposeRoutes()
    expect(updaterDisposed).toBe(false)
    expect(disposers).toHaveLength(0)
    resolveUpdater()
    await disposing
    expect(updaterDisposed).toBe(true)
    expect(disposers.length).toBeGreaterThan(0)
  })

  it('returns a JSON diagnostic when Host state assembly throws', async () => {
    const handlers = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
    const webServer: WebServerService = {
      register(route) {
        handlers.set(route.path, route.handler)
        return () => undefined
      },
    }
    const marketUpdater = {
      restartRequired: false,
      status: async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false }),
      update: async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false }),
      startUpdate: () => { throw new Error('not used') },
      operation: () => null,
      currentOperation: () => { throw new Error('state probe failed') },
      cancel: () => { throw new Error('not used') },
      retry: () => { throw new Error('not used') },
    }
    const dispose = mountRoutes({
      webServer,
      agents: { list: () => [] },
      loader: { entries: (): Iterable<LoaderEntry> => [] },
    }, {
      profile: 'test',
      profileDir: '/tmp/dsh-skin-market-route-state-error',
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      marketUpdater,
    })

    let status = 0
    let body = ''
    const response = {
      writeHead: (value: number) => { status = value },
      end: (value: string) => { body = value },
    } as unknown as ServerResponse
    await handlers.get('/dsh-skin-market/state')?.({ method: 'GET', headers: {} } as IncomingMessage, response)
    expect(status).toBe(500)
    expect(JSON.parse(body)).toEqual({ error: 'state probe failed' })
    await dispose()
  })

  it('shadows an unavailable lazy Agent service for official Desktop state', async () => {
    const handlers = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
    const webServer: WebServerService = {
      register(route) {
        handlers.set(route.path, route.handler)
        return () => undefined
      },
    }
    const host = Object.create({
      get agents(): never { throw new Error('cannot get property "agents" without inject') },
    }) as { webServer: WebServerService; loader: { entries(): Iterable<LoaderEntry> } }
    host.webServer = webServer
    host.loader = { entries: (): Iterable<LoaderEntry> => [] }
    const marketUpdater = {
      restartRequired: false,
      status: async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false }),
      update: async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false }),
      startUpdate: () => { throw new Error('not used') },
      operation: () => null,
      currentOperation: () => null,
      cancel: () => { throw new Error('not used') },
      retry: () => { throw new Error('not used') },
    }
    const dispose = mountRoutes(host, {
      profile: 'desktop',
      profileDir: '/tmp/dsh-skin-market-route-desktop-agents',
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      hostKind: 'desktop',
      agents: undefined,
      marketUpdater,
    })

    let status = 0
    let body = ''
    const response = {
      writeHead: (value: number) => { status = value },
      end: (value: string) => { body = value },
    } as unknown as ServerResponse
    await handlers.get('/dsh-skin-market/state')?.({ method: 'GET', headers: {} } as IncomingMessage, response)
    expect(status).toBe(200)
    expect(JSON.parse(body)).toMatchObject({ hostKind: 'desktop', runningAgentCount: 0 })
    await dispose()
  })

  it('exports a bounded diagnostic log as plain text', async () => {
    const handlers = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
    const webServer: WebServerService = {
      register(route) {
        handlers.set(route.path, route.handler)
        return () => undefined
      },
    }
    const dispose = mountRoutes({
      webServer,
      agents: { list: () => [] },
      loader: { entries: (): Iterable<LoaderEntry> => [] },
    }, {
      profile: 'test',
      profileDir: '/tmp/dsh-skin-market-route-test-missing-profile',
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    })

    let contentType = ''
    let body = ''
    const response = {
      writeHead: (_status: number, headers: Record<string, string>) => { contentType = headers['content-type'] ?? '' },
      end: (value: string) => { body = value },
    } as unknown as ServerResponse
    await handlers.get('/dsh-skin-market/logs')?.({ method: 'GET', url: '/dsh-skin-market/logs?operationId=test-operation', headers: {} } as IncomingMessage, response)
    expect(contentType).toContain('text/plain')
    expect(body).toContain('# dsh-skin-market diagnostic log')
    expect(body).toContain('operationId: test-operation')
    dispose()
  })
})
