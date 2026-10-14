import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CommandResult, PluginRunner } from './commands.ts'
import { PnpmCommandError, classifyPnpmFailure, failureDiagnostic, runPnpmWithRecovery, type PnpmFailure } from './pnpm-recovery.ts'
import { pluginArgsFor } from './pnpm-compat.ts'
import { logEvent } from './log.ts'
import { compareInstalledArtifact, manifestFile, pnpmLockfile, resolveProfileDir, restoreFile, snapshotFile, snapshotInstalledArtifact, validateNpmArtifact, type FileSnapshot, type InstalledArtifactSnapshot } from './profile.ts'
import { compareVersions, parseVersion } from './semver.ts'
import type { OperationFailure } from './types.ts'
import type { OfficialApplication } from './official-desktop.ts'

export const MARKET_NPM_PACKAGE = 'dsh-skin-market'
export const MARKET_NPM_METADATA_URL = `https://registry.npmjs.org/${MARKET_NPM_PACKAGE}`
const PNPM_FETCH_TIMEOUT_MS = 10 * 60 * 1000
const RECOVERY_TIMEOUT_MS = 60_000

export interface MarketUpdateStatus {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
}

export type MarketUpdatePhase = 'queued' | 'checking' | 'downloading' | 'installing' | 'waiting' | 'cancelling' | 'cancelled' | 'done' | 'failed'

export interface MarketUpdateOperation {
  id: string
  phase: MarketUpdatePhase
  message?: string
  status?: MarketUpdateStatus
  cancelable?: boolean
  downloadedBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  failure?: OperationFailure
  application?: OfficialApplication | 'unknown'
  restartRequired?: boolean
  integrityVerified?: boolean
  startedAt: string
  finishedAt?: string
}

interface FetchProgress { size?: number; downloaded: number }

interface MarketRelease {
  version: string
  gitHead: string
  tarball: string
  integrity?: string
}

class MarketProgressTracker {
  private buffer = ''
  private readonly fetches = new Map<string, FetchProgress>()
  private readonly unknownSizes = new Set<string>()
  private samples: Array<{ at: number; bytes: number }> = []

  push(chunk: string, operation: MarketUpdateOperation): void {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    for (const line of lines) this.consume(line, operation)
  }

  private consume(line: string, operation: MarketUpdateOperation): void {
    let event: Record<string, unknown>
    try { event = JSON.parse(line) as Record<string, unknown> } catch { return }
    const packageId = typeof event.packageId === 'string' ? event.packageId : undefined
    if (packageId === undefined) return
    if (event.name === 'pnpm:fetching-progress' && event.status === 'started') {
      const size = typeof event.size === 'number' && Number.isFinite(event.size) ? event.size : undefined
      this.fetches.set(packageId, { size, downloaded: 0 })
      if (size === undefined) this.unknownSizes.add(packageId)
      this.publish(operation)
      return
    }
    if (event.name === 'pnpm:fetching-progress' && event.status === 'in_progress' && typeof event.downloaded === 'number') {
      const current = this.fetches.get(packageId) ?? { downloaded: 0 }
      current.downloaded = Math.max(current.downloaded, event.downloaded)
      this.fetches.set(packageId, current)
      this.publish(operation)
      return
    }
    if (event.name === 'pnpm:progress' && event.status === 'fetched') {
      const current = this.fetches.get(packageId)
      if (current?.size !== undefined) current.downloaded = current.size
      this.publish(operation)
    }
  }

  private publish(operation: MarketUpdateOperation): void {
    if (this.fetches.size === 0) return
    const totalKnown = this.unknownSizes.size === 0
    const total = [...this.fetches.values()].reduce((sum, item) => sum + (item.size ?? 0), 0)
    const downloaded = [...this.fetches.values()].reduce((sum, item) => sum + Math.min(item.downloaded, item.size ?? item.downloaded), 0)
    if (downloaded > 0) operation.downloadedBytes = downloaded
    else delete operation.downloadedBytes
    if (totalKnown) operation.totalBytes = total
    else delete operation.totalBytes
    const now = Date.now()
    this.samples.push({ at: now, bytes: downloaded })
    this.samples = this.samples.filter(sample => now - sample.at <= 5000)
    const first = this.samples[0]
    const last = this.samples.at(-1)
    if (first !== undefined && last !== undefined && last.at > first.at && last.bytes > first.bytes) {
      operation.bytesPerSecond = Math.round((last.bytes - first.bytes) * 1000 / (last.at - first.at))
    }
  }
}

export interface MarketUpdater {
  status(force?: boolean): Promise<MarketUpdateStatus>
  update(): Promise<MarketUpdateStatus>
  startUpdate(): MarketUpdateOperation
  operation(id: string): MarketUpdateOperation | null
  currentOperation(): MarketUpdateOperation | null
  cancel(id: string): MarketUpdateOperation
  retry(id: string): MarketUpdateOperation
  /** Stop a route mount cleanly, joining any host package-manager request. */
  dispose?(): Promise<void>
  readonly restartRequired: boolean
}

export function packageVersion(): string {
  const packageFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const value = JSON.parse(readFileSync(packageFile, 'utf8')) as { version?: unknown }
  if (typeof value.version !== 'string') throw new Error('皮肤市场 package.json 缺少版本号')
  return value.version
}

export { compareVersions } from './semver.ts'

export function createMarketUpdater(
  profile: string,
  runner: PluginRunner,
  options: { currentVersion?: string; fetch?: typeof fetch; cacheMs?: number; profileDir?: string } = {},
): MarketUpdater {
  const fetchLatest = options.fetch ?? fetch
  let installedVersion = options.currentVersion ?? packageVersion()
  const cacheMs = options.cacheMs ?? 5 * 60 * 1000
  let cached: { checkedAt: number; status: MarketUpdateStatus; release: MarketRelease } | null = null
  let latestRelease: MarketRelease | null = null
  let updating = false
  let restartRequired = false
  let activeOperation: string | null = null
  let disposed = false
  const operations = new Map<string, MarketUpdateOperation>()
  const abortControllers = new Map<string, AbortController>()
  const updatePromises = new Map<string, Promise<void>>()
  const profileDir = options.profileDir ?? resolveProfileDir(profile)
  const cancellationAvailable = (): boolean => runner.management === undefined || runner.management.capabilities().cancel.available

  const setOperation = (operation: MarketUpdateOperation, patch: Partial<MarketUpdateOperation>): void => {
    Object.assign(operation, patch)
    operation.cancelable = patch.cancelable !== false && cancellationAvailable() && !['done', 'failed', 'cancelled', 'cancelling', 'waiting'].includes(operation.phase)
    if (operation.phase === 'done' || operation.phase === 'failed' || operation.phase === 'cancelled') {
      operation.finishedAt = new Date().toISOString()
      if (activeOperation === operation.id) activeOperation = null
    }
  }

  const updateTarget = async (operation: MarketUpdateOperation, controller: AbortController): Promise<void> => {
    let baseline: InstalledArtifactSnapshot | undefined
    let metadata: { manifest: FileSnapshot; lockfile: FileSnapshot } | undefined
    let mutationStarted = false
    let lastResult: CommandResult | undefined
    const managerOwned = runner.management !== undefined
    const recover = async (): Promise<string | undefined> => {
      if (!mutationStarted || baseline === undefined) return undefined
      if (managerOwned) {
        return compareInstalledArtifact(profileDir, baseline).ok ? undefined
          : '官方 Desktop 的实际市场构件或锁文件解析与更新前状态不一致，不能确认取消或失败已恢复；请在应用插件管理器核验'
      }
      if (metadata === undefined) return undefined
      const restore = (): void => {
        restoreFile(manifestFile(profileDir), metadata!.manifest)
        restoreFile(pnpmLockfile(profileDir), metadata!.lockfile)
      }
      try {
        restore()
        if (compareInstalledArtifact(profileDir, baseline).ok) return undefined
        setOperation(operation, { phase: 'installing', cancelable: false, message: '正在恢复更新前的皮肤市场' })
        const recovery = await runner(profile, pluginArgsFor(profileDir, ['install', '--prefer-offline', '--reporter=ndjson']), {
          timeoutMs: RECOVERY_TIMEOUT_MS,
          signal: AbortSignal.timeout(RECOVERY_TIMEOUT_MS),
        })
        restore()
        if (recovery.exitCode !== 0 || recovery.timedOut || recovery.aborted || !compareInstalledArtifact(profileDir, baseline).ok) {
          return '原有配置已恢复，但更新前的皮肤市场构件未能验证恢复；请完全退出 DSH 后修复依赖'
        }
        return undefined
      } catch {
        try { restore() } catch { /* report the uncertain recovery without replacing its cause */ }
        return '更新前的配置或皮肤市场构件未能验证恢复；请完全退出 DSH 后修复依赖'
      }
    }
    try {
      setOperation(operation, { phase: 'checking', message: '正在检查皮肤市场版本' })
      const before = await status(true)
      operation.status = before
      if (!before.updateAvailable) {
        setOperation(operation, { phase: 'done', message: '已经是最新版本', status: before })
        return
      }
      baseline = snapshotInstalledArtifact(profileDir, MARKET_NPM_PACKAGE)
      if (!baseline.ok && !managerOwned) throw new Error('更新前的皮肤市场构件无法验证，请先修复安装后再更新')
      if (!managerOwned) metadata = { manifest: snapshotFile(manifestFile(profileDir)), lockfile: snapshotFile(pnpmLockfile(profileDir)) }

      const tracker = new MarketProgressTracker()
      const report = (chunk: string): void => {
        if (operation.phase !== 'downloading' && operation.phase !== 'installing') return
        tracker.push(chunk, operation)
        if (chunk.trim() !== '') operation.message = operation.phase === 'downloading' ? '正在下载皮肤市场更新包' : '正在写入皮肤市场更新'
      }
      const run = async (args: readonly string[]) => {
        await runner.ensurePnpm?.({ signal: controller.signal })
        const effectiveArgs = pluginArgsFor(profileDir, args)
        if (managerOwned) {
          lastResult = await runner(profile, args, { signal: controller.signal, onStdout: report, onStderr: report })
          const managed = lastResult.management
          if (managed?.indeterminate === true || managed?.application === 'failed' || managed?.application === 'cancelled') {
            throw new PnpmCommandError(classifyPnpmFailure(lastResult), lastResult)
          }
          if (managed?.application === 'applied' || managed?.application === 'restart-required' || managed?.application === 'overridden') return
          throw new Error('官方 Desktop 未返回可确认的市场更新结果')
        }
        try {
          await runPnpmWithRecovery(effectiveArgs, {
            profileDir,
            attempt: async (attemptArgs, attemptOptions) => {
              lastResult = await runner(profile, attemptArgs, {
                signal: controller.signal,
                // Keep self-update on the same 10 minute network budget as ordinary
                // skin installs without writing persistent profile configuration.
                env: { pnpm_config_fetch_timeout: String(PNPM_FETCH_TIMEOUT_MS), ...attemptOptions?.env },
                onStdout: report,
                onStderr: report,
              })
              return lastResult
            },
            onRetry: failure => setOperation(operation, { message: recoveryMessage(failure) }),
          })
        } catch (error) {
          if (error instanceof PnpmCommandError) {
            logEvent('error', 'market-update-pnpm', `kind=${error.failure.kind}${error.failure.packageName === undefined ? '' : ` package=${error.failure.packageName}`} ${failureDiagnostic(error.result)}`, operation.id)
          }
          throw error
        }
      }

      // Resolve this version online. `--prefer-offline` would reuse a stale
      // packument that still lacks the latest we just read from npm.
      setOperation(operation, { phase: 'downloading', message: '正在下载皮肤市场更新包' })
      if (latestRelease === null) throw new Error('npm 未返回可验证的市场构件')
      const targetRelease = latestRelease
      mutationStarted = true
      await run(['add', `${MARKET_NPM_PACKAGE}@${latestRelease.version}`, '--reporter=ndjson'])
      const materialized = validateNpmArtifact(profileDir, { name: MARKET_NPM_PACKAGE, ...targetRelease })
      if (!materialized.ok || materialized.version === undefined) {
        throw new Error(`市场更新未通过构件校验，不能确认更新成功：${materialized.reason ?? '未物化预期版本或可加载入口'}`)
      }
      // A managed transaction that completed remains authoritative even when
      // cancellation arrived too late. Web cancellation still restores its
      // frozen pre-operation state before returning a cancelled result.
      if (controller.signal.aborted && !managerOwned) throw new Error('更新已取消')
      installedVersion = materialized.version
      restartRequired = true
      const next = { currentVersion: installedVersion, latestVersion: installedVersion, updateAvailable: false }
      cached = { checkedAt: Date.now(), status: next, release: targetRelease }
      setOperation(operation, {
        phase: 'done',
        ...(lastResult?.management?.application === undefined ? {} : { application: lastResult.management.application }),
        restartRequired: true,
        integrityVerified: materialized.integrityVerified,
        message: lastResult?.management?.application === 'overridden'
          ? '更新包版本已验证，但启用状态被其他配置覆盖；请在设置 → 插件核验，重启后仍可能未启用'
          : '更新完成，重启 DSH 后生效',
        status: next,
      })
    } catch (error) {
      if (lastResult?.management?.application !== undefined) operation.application = lastResult.management.application
      if (managerOwned && lastResult?.management?.indeterminate === true) {
        setOperation(operation, { phase: 'waiting', application: 'unknown', message: '官方 Desktop 的市场更新结果尚未确认；请等待或重新启动应用后核验，期间不会再修改插件' })
        return
      }
      const recoveryError = await recover()
      const cancelled = managerOwned ? lastResult?.management?.application === 'cancelled' : controller.signal.aborted
      if (cancelled && recoveryError === undefined) setOperation(operation, { phase: 'cancelled', message: '更新已取消' })
      else {
        if (error instanceof PnpmCommandError) {
          const failure = error.failure
          const action = failure.kind === 'network' || failure.kind === 'fetch-timeout' ? 'retry' : undefined
          operation.failure = {
            kind: failure.kind,
            message: failure.message,
            ...(failure.packageName === undefined ? {} : { packageName: failure.packageName }),
            ...(action === undefined ? {} : { action }),
          }
        }
        if (!(error instanceof PnpmCommandError)) logEvent('error', 'market-update', error instanceof Error ? error.message : String(error), operation.id)
        if (recoveryError !== undefined) operation.failure = { kind: 'command', message: recoveryError }
        const managedFailure = lastResult?.management?.application === 'failed' && controller.signal.aborted
          ? '官方 Desktop 返回市场更新失败；取消请求没有替代管理器的最终结果，请查看插件管理器诊断'
          : undefined
        const cause = managedFailure ?? (error instanceof Error ? error.message : String(error))
        setOperation(operation, { phase: 'failed', message: recoveryError === undefined ? cause : managerOwned ? `${cause}；${recoveryError}` : recoveryError })
      }
    } finally {
      abortControllers.delete(operation.id)
      updating = operation.phase === 'waiting'
    }
  }

  const status = async (force = false): Promise<MarketUpdateStatus> => {
    if (!force && cached !== null && Date.now() - cached.checkedAt < cacheMs) return cached.status
    const requestOptions = {
      headers: { accept: 'application/json', 'user-agent': `dsh-skin-market/${installedVersion}` },
      signal: AbortSignal.timeout(10_000),
    }
    const response = await fetchLatest(MARKET_NPM_METADATA_URL, requestOptions)
    if (!response.ok) throw new Error(`npm 版本检查失败（HTTP ${response.status}）`)
    const value = await response.json() as {
      'dist-tags'?: unknown
      versions?: unknown
    }
    const tags = value['dist-tags']
    const latestVersion = tags !== null && typeof tags === 'object' ? (tags as Record<string, unknown>).latest : undefined
    if (typeof latestVersion !== 'string' || parseVersion(latestVersion) === null) throw new Error('npm 未返回有效的市场 latest 版本')
    const versions = value.versions
    if (versions === null || typeof versions !== 'object') throw new Error('npm 未返回有效的市场版本列表')
    const releaseValue = (versions as Record<string, unknown>)[latestVersion]
    if (releaseValue === null || typeof releaseValue !== 'object') throw new Error('npm 未返回有效的市场 latest 构件')
    const releaseRecord = releaseValue as Record<string, unknown>
    const gitHead = releaseRecord.gitHead
    const dist = releaseRecord.dist
    const tarball = dist !== null && typeof dist === 'object' ? (dist as Record<string, unknown>).tarball : undefined
    const integrity = dist !== null && typeof dist === 'object' ? (dist as Record<string, unknown>).integrity : undefined
    if (typeof gitHead !== 'string' || !/^[0-9a-f]{40}$/i.test(gitHead) || typeof tarball !== 'string' || !tarball.startsWith('https://registry.npmjs.org/')) {
      throw new Error('npm 市场构件缺少可验证的版本来源或下载地址')
    }
    if ((releaseRecord.name !== undefined && releaseRecord.name !== MARKET_NPM_PACKAGE)
      || releaseRecord.version !== latestVersion || (integrity !== undefined && (typeof integrity !== 'string' || integrity.trim() === ''))) {
      throw new Error('npm 市场构件的包名、版本或完整性元数据不一致')
    }
    const release: MarketRelease = { version: latestVersion, gitHead: gitHead.toLowerCase(), tarball, ...(typeof integrity === 'string' ? { integrity } : {}) }
    const next = { currentVersion: installedVersion, latestVersion: release.version, updateAvailable: compareVersions(release.version, installedVersion) > 0 }
    latestRelease = release
    cached = { checkedAt: Date.now(), status: next, release }
    return next
  }

  const startUpdate = (): MarketUpdateOperation => {
    if (disposed) throw new Error('皮肤市场更新器已停止')
    if (activeOperation !== null) return operations.get(activeOperation)!
    const operation: MarketUpdateOperation = { id: randomUUID(), phase: 'queued', cancelable: cancellationAvailable(), startedAt: new Date().toISOString() }
    operations.set(operation.id, operation)
    activeOperation = operation.id
    updating = true
    const controller = new AbortController()
    abortControllers.set(operation.id, controller)
    const updatePromise = updateTarget(operation, controller)
    updatePromises.set(operation.id, updatePromise)
    void updatePromise.then(
      () => { updatePromises.delete(operation.id) },
      () => { updatePromises.delete(operation.id) },
    )
    const timer = setTimeout(() => { if (activeOperation !== operation.id) operations.delete(operation.id) }, 30 * 60 * 1000)
    timer.unref?.()
    return operation
  }

  return {
    status,
    get restartRequired() { return restartRequired },
    async update() {
      if (updating) throw new Error('皮肤市场正在更新')
      const operation = startUpdate()
      while (operation.phase !== 'done' && operation.phase !== 'failed' && operation.phase !== 'cancelled' && operation.phase !== 'waiting') {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      if (operation.phase !== 'done' || operation.status === undefined) throw new Error(operation.message ?? '皮肤市场更新失败')
      return operation.status
    },
    startUpdate,
    operation(id) { return operations.get(id) ?? null },
    currentOperation() { return activeOperation === null ? null : operations.get(activeOperation) ?? null },
    cancel(id) {
      const operation = operations.get(id)
      if (operation === undefined) throw new Error('更新任务不存在')
      if (operation.cancelable !== true) return operation
      if (!cancellationAvailable()) { operation.cancelable = false; return operation }
      setOperation(operation, { phase: 'cancelling', message: '正在取消皮肤市场更新' })
      abortControllers.get(id)?.abort()
      return operation
    },
    retry(id) {
      const failed = operations.get(id)
      if (failed === undefined || failed.phase !== 'failed' || failed.failure?.action !== 'retry') throw new Error('更新任务不可重试')
      return startUpdate()
    },
    async dispose() {
      disposed = true
      for (const id of abortControllers.keys()) {
        const operation = operations.get(id)
        if (operation?.cancelable === true) {
          setOperation(operation, { phase: 'cancelling', message: '正在停止皮肤市场更新' })
        }
        abortControllers.get(id)?.abort()
      }
      await Promise.all([...updatePromises.values()])
    },
  }
}

function recoveryMessage(failure: PnpmFailure): string {
  if (failure.recovery === 'disable-peer-autoinstall') return '检测到宿主提供但 npm 未发布的 peer，正在关闭 peer 自动安装并重试'
  if (failure.kind === 'release-age') return '检测到新包保护，正在临时放宽本次更新并重试'
  if (failure.kind === 'fetch-timeout') return '下载超时，正在延长 pnpm 下载等待时间并重试'
  if (failure.kind === 'network') return '检测到临时网络错误，正在自动重试'
  return failure.message
}
