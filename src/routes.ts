import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { CatalogStore, catalogWithStars } from './catalog.ts'
import { directLoopbackRequest, readMarketUpdateRetryAction, readOperationRetry, readRestartTarget, readSelectionPlan, readSkinMutation, refuseUnadmitted, sameOrigin, sendJson, sendText, type HostConnectionLike } from './http.ts'
import { SkinLifecycle, type LifecycleHost } from './lifecycle.ts'
import { installedClientPlugins, resolveProfileDir } from './profile.ts'
import type { PluginRunner } from './commands.ts'
import type { DshRuntime, MarketHostKind, Operation, OperationKind } from './types.ts'
import type { RestartScheduler } from './restart.ts'
import { createMarketUpdater, packageVersion, type MarketUpdater } from './self-update.ts'
import { exportLogs } from './log.ts'
import { getInstallEnvironment } from './install-environment.ts'

export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>
  }): () => void
}

export interface AgentLike {
  status: 'idle' | 'running'
  whenIdle(): Promise<void>
}

export interface AgentRegistryLike { list(): AgentLike[] }

export interface SkinMarketHost extends LifecycleHost {
  webServer: WebServerService
  agents?: AgentRegistryLike
}

export interface RouteOptions { profile: string; profileDir?: string; runner: PluginRunner; hostKind?: MarketHostKind; runtime?: DshRuntime; restart?: RestartScheduler; agents?: AgentRegistryLike; catalogStore?: CatalogStore; marketUpdater?: MarketUpdater; connection?: () => HostConnectionLike | undefined; configurationOverride?: import('./configuration-override.ts').ConfigurationOverrideOptions }

export function canRestartSkin(state: ReturnType<SkinLifecycle['states']>[number] | undefined): boolean {
  return state?.installation === 'installed'
    && (state.activation === 'active' || state.activation === 'restart-required')
}

export function runningAgentCount(host: Pick<SkinMarketHost, 'agents'>): number {
  return host.agents?.list().filter(agent => agent.status === 'running').length ?? 0
}

export function restartBlockingOperations(operations: readonly Operation[]): Operation[] {
  return operations.filter(operation =>
    operation.phase !== 'done'
    && operation.phase !== 'failed'
    && operation.phase !== 'cancelled'
  )
}

export function assertRestartClearOfSkinOperations(
  operations: readonly Operation[],
  marketUpdate?: { phase: string } | null,
): void {
  const blocking = restartBlockingOperations(operations)
  if (blocking.length > 0) {
    throw new Error(`还有 ${blocking.length} 个皮肤操作未完成，现在不能重启。请等待完成或先取消，避免中断安装或启停`)
  }
  if (marketUpdate !== undefined && marketUpdate !== null
    && marketUpdate.phase !== 'done' && marketUpdate.phase !== 'failed' && marketUpdate.phase !== 'cancelled') {
    throw new Error('皮肤市场正在更新，现在不能重启。请等待完成或先取消')
  }
}

export async function waitForRestartSafety(host: Pick<SkinMarketHost, 'agents'>): Promise<void> {
  const agents = host.agents?.list() ?? []
  const running = agents.filter(agent => agent.status === 'running').length
  if (running > 0) throw new Error(`检测到 ${running} 个 Agent 正在运行，请等待任务完全结束后再重启`)

  // An Agent can still be finishing maintenance while its public status is
  // idle. whenIdle() includes that maintenance and the turn checkpoint.
  await Promise.all(agents.map(agent => agent.whenIdle()))
  const startedDuringCheck = runningAgentCount(host)
  if (startedDuringCheck > 0) throw new Error(`检测到 ${startedDuringCheck} 个 Agent 刚刚开始运行，请稍后再重启`)
}

function method(request: IncomingMessage, response: ServerResponse, expected: string): boolean {
  if (request.method === expected) return true
  response.writeHead(405, { allow: expected })
  response.end()
  return false
}

export function mountRoutes(host: SkinMarketHost, options: RouteOptions): () => void {
  // Resolve once at the route boundary so every lifecycle/catalog operation
  // uses the same profile. In particular, an official Desktop route with no
  // profileContext.dir resolves the Desktop profile and never silently uses
  // the Web profile.
  const profileDir = options.profileDir ?? resolveProfileDir(options.profile)
  const catalogStore = options.catalogStore ?? new CatalogStore(profileDir)
  const initialCatalog = catalogStore.snapshot().catalog
  const hostKind = options.hostKind ?? options.runner.hostKind ?? 'dsh'
  // Keep the optional Agent registry on a prototype wrapper so Cordis host
  // methods and lifecycle services retain their original receiver. Official
  // Desktop simply leaves this undefined; Web keeps the existing restart
  // safety checks when the service is available.
  // An explicit `agents: undefined` is meaningful for official Desktop: its
  // host exposes a throwing lazy-injection getter when the Agent service is
  // absent. Shadow that getter while preserving the original host object when
  // callers omit the option entirely.
  let routeHost = host
  if (Object.prototype.hasOwnProperty.call(options, 'agents')) {
    routeHost = Object.create(host) as SkinMarketHost
    Object.defineProperty(routeHost, 'agents', {
      configurable: true,
      enumerable: true,
      value: options.agents,
      writable: true,
    })
  }
  const lifecycle = new SkinLifecycle(routeHost, { ...options, profileDir, hostKind }, initialCatalog.skins)
  lifecycle.start()
  let lifecycleCatalogGeneratedAt = initialCatalog.generatedAt
  const instanceId = randomUUID()
  const marketUpdater = options.marketUpdater ?? createMarketUpdater(options.profile, options.runner, { profileDir })
  const updaterBusy = (): string | undefined => {
    const operation = marketUpdater.currentOperation()
    if (operation === null || ['done', 'failed', 'cancelled'].includes(operation.phase)) return undefined
    return operation.phase === 'waiting' ? '宿主尚未确认市场更新结果，请重新打开宿主后核对，暂时不能修改插件' : '皮肤市场正在更新，完成前暂时不能修改插件'
  }
  const skinWritesBusy = (): string | undefined => lifecycle.waitingReason ?? (lifecycle.currentOperations().length > 0 ? '还有皮肤操作未完成，请结束后再更新皮肤市场' : undefined)
  const connection = (): HostConnectionLike | undefined => options.connection?.()
  const matchesOrigin = (request: IncomingMessage): boolean => {
    try {
      const hosts = connection()?.trustedHosts
      return sameOrigin(request, Array.isArray(hosts) ? hosts.filter((value): value is string => typeof value === 'string') : [])
    } catch { return false }
  }
  const register = (route: Parameters<WebServerService['register']>[0]): (() => void) => host.webServer.register({
    ...route,
    handler: (request, response) => {
      try { if (refuseUnadmitted(request, response, connection())) return } catch {
        return sendJson(response, 403, { error: '请求未通过宿主验证' })
      }
      return route.handler(request, response)
    },
  })

  const catalogPayload = async (force: boolean) => {
    const snapshot = await catalogStore.refresh(force)
    if (snapshot.catalog.generatedAt !== lifecycleCatalogGeneratedAt) {
      await lifecycle.replaceCatalog(snapshot.catalog.skins)
      lifecycleCatalogGeneratedAt = snapshot.catalog.generatedAt
    }
    return {
      schemaVersion: snapshot.catalog.schemaVersion,
      generatedAt: snapshot.catalog.generatedAt,
      skins: await catalogWithStars(profileDir, snapshot.catalog),
      catalogSource: snapshot.source,
      catalogLastCheckedAt: snapshot.lastCheckedAt,
      ...(snapshot.error ? { catalogError: snapshot.error } : {}),
    }
  }

  const mutation = (kind: OperationKind) => async (request: IncomingMessage, response: ServerResponse) => {
    if (!method(request, response, 'POST')) return
    if (!matchesOrigin(request)) return sendJson(response, 403, { error: 'same-origin request required' })
    try {
      const { skinId, acknowledgeCompatibility, compatibilityContext, artifactContext, configurationContext, sourceContext } = await readSkinMutation(request)
      if (sourceContext !== undefined && kind !== 'migrate') throw new Error('invalid source context')
      if (updaterBusy() !== undefined) return sendJson(response, 409, { error: updaterBusy() })
      if (configurationContext !== undefined && !['activate', 'deactivate', 'pin', 'unpin'].includes(kind)) throw new Error('invalid configuration context')
      const operation = sourceContext !== undefined
        ? lifecycle.begin(kind, skinId, undefined, acknowledgeCompatibility, compatibilityContext, undefined, artifactContext, undefined, undefined, sourceContext)
        : configurationContext !== undefined
        ? lifecycle.begin(kind, skinId, undefined, acknowledgeCompatibility, compatibilityContext, undefined, artifactContext, undefined, configurationContext)
        : artifactContext === undefined
          ? lifecycle.begin(kind, skinId, undefined, acknowledgeCompatibility, compatibilityContext)
          : lifecycle.begin(kind, skinId, undefined, acknowledgeCompatibility, compatibilityContext, undefined, artifactContext)
      sendJson(response, 202, { operationId: operation.id })
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const disposers = [
    register({ kind: 'exact', path: '/dsh-skin-market/selection-plan', handler: async (request, response) => {
      if (!method(request, response, 'POST')) return
      if (!matchesOrigin(request)) return sendJson(response, 403, { error: 'same-origin request required' })
      try {
        const { skinId, kind } = await readSelectionPlan(request)
        if (updaterBusy() !== undefined) return sendJson(response, 409, { error: updaterBusy() })
        sendJson(response, 200, await lifecycle.selectionPlan(kind, skinId))
      } catch (error) {
        sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) })
      }
    } }),
    register({ kind: 'exact', path: '/dsh-skin-market/catalog', handler: async (request, response) => {
      if (!method(request, response, 'GET')) return
      try {
        sendJson(response, 200, await catalogPayload(false))
      } catch (error) {
        sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    } }),
    register({ kind: 'exact', path: '/dsh-skin-market/logs', handler: (request, response) => {
      if (!method(request, response, 'GET')) return
      const url = new URL(request.url ?? '/', 'http://localhost')
      const operationId = url.searchParams.get('operationId') ?? undefined
      if (operationId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
        return sendText(response, 400, 'invalid operationId')
      }
      sendText(response, 200, exportLogs({
        marketVersion: packageVersion(),
        profile: options.profile,
        hostKind,
        dshVersion: options.runtime?.version ?? 'unknown',
      }, operationId))
    } }),
    register({ kind: 'exact', path: '/dsh-skin-market/state', handler: async (request, response) => {
      if (!method(request, response, 'GET')) return
      try {
        sendJson(response, 200, {
          hostKind,
          installEnvironment: getInstallEnvironment(options.profile, profileDir),
          selectionPlanAvailable: options.runner.management !== undefined,
          management: options.runner.management === undefined ? undefined : { official: true, installRequiresRestart: options.runner.management.installRequiresRestart, capabilities: options.runner.management.capabilities() },
          profileBusy: lifecycle.waitingReason ?? updaterBusy(),
          runtime: options.runtime,
          skins: await lifecycle.runtimeStates(),
          installedClientPlugins: installedClientPlugins(profileDir, lifecycle.catalog),
          operation: lifecycle.currentOperation(),
          operations: lifecycle.currentOperations(),
          marketUpdateOperation: marketUpdater.currentOperation(),
          instanceId,
          restartAvailable: options.restart?.available === true,
          marketUpdateRestartRequired: marketUpdater.restartRequired,
          restartNoticeId: lifecycle.restartNoticeId,
          marketUpdateNoticeId: marketUpdater.restartNoticeId,
          runningAgentCount: runningAgentCount(routeHost),
        })
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    } }),
    register({ kind: 'exact', path: '/dsh-skin-market/market-update', handler: async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST' })
        response.end()
        return
      }
      if (request.method === 'POST' && !matchesOrigin(request)) return sendJson(response, 403, { error: 'same-origin request required' })
      try {
        if (request.method === 'POST') {
          if (skinWritesBusy() !== undefined) return sendJson(response, 409, { error: skinWritesBusy() })
          const capability = options.runner.management?.capabilities().update
          if (capability?.available === false) return sendJson(response, 501, { error: capability.reason })
          const operation = marketUpdater.startUpdate()
          return sendJson(response, 202, { operationId: operation.id })
        }
        sendJson(response, 200, { ...(await marketUpdater.status()), operation: marketUpdater.currentOperation() })
      } catch (error) {
        sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    } }),
    register({ kind: 'prefix', path: '/dsh-skin-market/market-update/operations', handler: async (request, response) => {
      const parts = new URL(request.url ?? '/', 'http://localhost').pathname.split('/').filter(Boolean)
      const cancelling = parts.at(-1) === 'cancel'
      const retrying = parts.at(-1) === 'retry'
      const id = cancelling || retrying ? parts.at(-2) ?? '' : parts.at(-1) ?? ''
      if (cancelling || retrying) {
        if (!method(request, response, 'POST')) return
        if (!matchesOrigin(request)) return sendJson(response, 403, { error: 'same-origin request required' })
        try {
          if (retrying && skinWritesBusy() !== undefined) return sendJson(response, 409, { error: skinWritesBusy() })
          if (cancelling) return sendJson(response, 202, marketUpdater.cancel(id))
          const action = await readMarketUpdateRetryAction(request)
          if (skinWritesBusy() !== undefined) return sendJson(response, 409, { error: skinWritesBusy() })
          return sendJson(response, 202, { operationId: marketUpdater.retry(id, action).id })
        } catch (error) { return sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }) }
      }
      if (!method(request, response, 'GET')) return
      const operation = marketUpdater.operation(id)
      if (operation === null) return sendJson(response, 404, { error: '更新任务不存在' })
      sendJson(response, 200, operation)
    } }),
    // Prefix routes must not end in `/`: DSH matches descendants by appending
    // its own slash (`pathname.startsWith(`${prefix}/`)`). A trailing slash
    // here would therefore only match a double-slash URL and let normal
    // operation polling fall through to index.html.
    register({ kind: 'prefix', path: '/dsh-skin-market/operations', handler: async (request, response) => {
      const parts = new URL(request.url ?? '/', 'http://localhost').pathname.split('/').filter(Boolean)
      const cancelling = parts.at(-1) === 'cancel'
      const retrying = parts.at(-1) === 'retry'
      const id = cancelling || retrying ? parts.at(-2) ?? '' : parts.at(-1) ?? ''
      if (cancelling || retrying) {
        if (!method(request, response, 'POST')) return
        if (!matchesOrigin(request)) return sendJson(response, 403, { error: 'same-origin request required' })
        try {
          if (cancelling) return sendJson(response, 202, lifecycle.cancel(id))
          if (updaterBusy() !== undefined) return sendJson(response, 409, { error: updaterBusy() })
          const { action, acknowledgeCompatibility, compatibilityContext, artifactContext, configurationContext } = await readOperationRetry(request)
          if (updaterBusy() !== undefined) return sendJson(response, 409, { error: updaterBusy() })
          const retried = configurationContext !== undefined
            ? lifecycle.retry(id, action, acknowledgeCompatibility, compatibilityContext, artifactContext, configurationContext)
            : artifactContext !== undefined
              ? lifecycle.retry(id, action, acknowledgeCompatibility, compatibilityContext, artifactContext)
              : lifecycle.retry(id, action, acknowledgeCompatibility, compatibilityContext)
          return sendJson(response, 202, { operationId: retried.id })
        } catch (error) {
          return sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (!method(request, response, 'GET')) return
      const operation = lifecycle.operations.get(id)
      if (operation === undefined) return sendJson(response, 404, { error: 'operation not found' })
      sendJson(response, 200, operation)
    } }),
    register({ kind: 'exact', path: '/dsh-skin-market/install', handler: mutation('install') }),
    register({ kind: 'exact', path: '/dsh-skin-market/activate', handler: mutation('activate') }),
    register({ kind: 'exact', path: '/dsh-skin-market/deactivate', handler: mutation('deactivate') }),
    register({ kind: 'exact', path: '/dsh-skin-market/pin', handler: mutation('pin') }),
    register({ kind: 'exact', path: '/dsh-skin-market/unpin', handler: mutation('unpin') }),
    register({ kind: 'exact', path: '/dsh-skin-market/update', handler: mutation('update') }),
    register({ kind: 'exact', path: '/dsh-skin-market/migrate', handler: mutation('migrate') }),
    register({ kind: 'exact', path: '/dsh-skin-market/uninstall', handler: mutation('uninstall') }),
    register({ kind: 'exact', path: '/dsh-skin-market/restart', handler: async (request, response) => {
      if (!method(request, response, 'POST')) return
      if (!matchesOrigin(request)) return sendJson(response, 403, { error: 'same-origin request required' })
      if (options.restart?.available !== true) return sendJson(response, 501, { error: 'restart is unavailable in this DSH host' })
      if (!directLoopbackRequest(request)) return sendJson(response, 403, { error: '只能从本机直接请求重启，不能通过代理或转发请求' })
      try {
        const target = await readRestartTarget(request)
        if (target.kind === 'market-update') {
          if (!marketUpdater.restartRequired) return sendJson(response, 409, { error: '皮肤市场没有待应用的更新' })
        } else {
          const skinState = lifecycle.states().find(item => item.skinId === target.skinId)
          // Browser and Host loaders are separate. The browser can correctly
          // require a restart while the Host half is already live, so accept
          // either active representation for the selected installed skin.
          if (!canRestartSkin(skinState)) return sendJson(response, 409, { error: '请先选择并使用此皮肤，再重新启动 DeepSeek Harness' })
        }
        assertRestartClearOfSkinOperations(lifecycle.currentOperations(), marketUpdater.currentOperation())
        await waitForRestartSafety(routeHost)
        assertRestartClearOfSkinOperations(lifecycle.currentOperations(), marketUpdater.currentOperation())
        sendJson(response, 202, { restarting: true, instanceId })
        options.restart.schedule()
      } catch (error) {
        sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) })
      }
    } }),
  ]
  return () => {
    // Newer lifecycle implementations may make disposal asynchronous so an
    // in-flight official Desktop manager request can be cancelled and joined
    // before its routes disappear. Keep the synchronous path synchronous for
    // existing hosts and tests.
    const finish = (): void => {
      for (const dispose of disposers.reverse()) dispose()
    }
    const disposed = Promise.all([
      Promise.resolve(lifecycle.dispose()),
      marketUpdater.dispose?.() ?? Promise.resolve(),
    ])
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([disposed, new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000) })])
      .finally(() => { if (timer !== undefined) clearTimeout(timer); finish() })
  }
}
