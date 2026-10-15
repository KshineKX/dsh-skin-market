import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CommandResult, PluginRunner } from './commands.ts'
import { PnpmCommandError, failureDiagnostic, runPnpmWithRecovery, type PnpmFailure } from './pnpm-recovery.ts'
import { pluginArgsFor } from './pnpm-compat.ts'
import { logEvent } from './log.ts'
import { officialFailureDiagnostic, officialOperationFailure } from './official-failure.ts'
import { allowReleaseAgeVersion, parseReleaseAgeTarget, repairReleaseAgeExcludes, type ReleaseAgeTarget } from './release-age.ts'
import { compareInstalledArtifact, manifestFile, packageManifest, pnpmLockfile, readDependencies, resolveProfileDir, restoreFile, snapshotFile, snapshotInstalledArtifact, validateNpmArtifact, type FileSnapshot, type InstalledArtifactSnapshot } from './profile.ts'
import { compareVersions, parseVersion } from './semver.ts'
import type { OperationFailure } from './types.ts'
import type { OfficialApplication } from './official-desktop.ts'

export const MARKET_NPM_PACKAGE = 'dsh-skin-market'
export const MARKET_NPM_METADATA_URL = `https://registry.npmjs.org/${MARKET_NPM_PACKAGE}`
const PNPM_FETCH_TIMEOUT_MS = 10 * 60 * 1000
const RECOVERY_TIMEOUT_MS = 60_000

export interface MarketUpdateStatus {
  currentVersion: string
  /** Version of the Host module serving this updater, independent of the installed package. */
  loadedVersion?: string
  latestVersion: string
  updateAvailable: boolean
  updateBlockedReason?: string
  /** Optional legacy status field; release age is handled from actual Desktop failures. */
  updateAvailableAt?: string
  packageOperationsWarning?: string
  /** Optional legacy status field, retained for older clients. */
  packageOperationsAvailableAt?: string
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

interface MarketReleaseApproval {
  failedId: string
  failure: OperationFailure
  release: MarketRelease
  target: ReleaseAgeTarget
}

function sameRelease(left: MarketRelease, right: MarketRelease): boolean {
  return (['version', 'gitHead', 'tarball', 'integrity'] as const).every(key => left[key] === right[key])
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
  retry(id: string, action?: 'retry' | 'approve-release-age'): MarketUpdateOperation
  /** Stop a route mount cleanly, joining any host package-manager request. */
  dispose?(): Promise<void>
  readonly restartRequired: boolean
  readonly restartNoticeId?: string
}

function readPackageVersion(): string {
  const packageFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const value = JSON.parse(readFileSync(packageFile, 'utf8')) as { version?: unknown }
  if (typeof value.version !== 'string') throw new Error('皮肤市场 package.json 缺少版本号')
  return value.version
}

// A package manager may replace this package on disk while this module is
// still serving requests. Capture once so a route remount cannot claim the
// replacement is the code currently running in the Host.
const LOADED_MARKET_VERSION = readPackageVersion()

export function packageVersion(): string { return LOADED_MARKET_VERSION }

export { compareVersions } from './semver.ts'

export function createMarketUpdater(
  profile: string,
  runner: PluginRunner,
  options: { currentVersion?: string; fetch?: typeof fetch; cacheMs?: number; profileDir?: string } = {},
): MarketUpdater {
  const fetchLatest = options.fetch ?? fetch
  const loadedVersion = options.currentVersion ?? packageVersion()
  let installedVersion = loadedVersion
  const cacheMs = options.cacheMs ?? 5 * 60 * 1000
  let cached: { checkedAt: number; status: MarketUpdateStatus; release: MarketRelease } | null = null
  let latestRelease: MarketRelease | null = null
  let updating = false
  let restartRequired = false
  let activeOperation: string | null = null
  let disposed = false
  const checkedReleases = new WeakMap<MarketUpdateStatus, MarketRelease>()
  const operations = new Map<string, MarketUpdateOperation>()
  const abortControllers = new Map<string, AbortController>()
  const updatePromises = new Map<string, Promise<void>>()
  const releaseAgeApprovals = new Map<string, MarketReleaseApproval>()
  const pendingApprovals = new Map<string, MarketReleaseApproval>()
  const profileDir = options.profileDir ?? resolveProfileDir(profile)
  const cancellationAvailable = (): boolean => runner.management === undefined || runner.management.capabilities().cancel.available

  const releaseStatus = (release: MarketRelease): MarketUpdateStatus => {
    const next: MarketUpdateStatus = {
      currentVersion: installedVersion, loadedVersion, latestVersion: release.version,
      updateAvailable: compareVersions(release.version, installedVersion) > 0,
    }
    checkedReleases.set(next, release)
    return next
  }

  const reconcileInstalledVersion = (): void => {
    // Do not inspect a package while its own transaction may be swapping it.
    // The transaction's stricter release validation remains authoritative.
    if (updating) return
    // Read only the public dependency manifest; verify the installed npm artifact.
    const dependency = readDependencies(profileDir)[MARKET_NPM_PACKAGE]
    if (typeof dependency !== 'string' || dependency.trim() === '') return
    const version = packageManifest(profileDir, MARKET_NPM_PACKAGE)?.version
    if (typeof version !== 'string' || parseVersion(version) === null) return
    const source = latestRelease?.version === version
      ? { name: MARKET_NPM_PACKAGE, ...latestRelease }
      : { name: MARKET_NPM_PACKAGE, version }
    if (!validateNpmArtifact(profileDir, source).ok) return
    installedVersion = version
    restartRequired = installedVersion !== loadedVersion
    if (cached !== null) cached.status = releaseStatus(cached.release)
  }

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
    let targetRelease: MarketRelease | undefined
    let managedArtifactMismatch = false
    const approval = pendingApprovals.get(operation.id)
    const managerOwned = runner.management !== undefined
    const recover = async (): Promise<string | undefined> => {
      if (!mutationStarted || baseline === undefined) return undefined
      if (managerOwned) {
        if (compareInstalledArtifact(profileDir, baseline).ok) return undefined
        managedArtifactMismatch = true
        return '官方 Desktop 的实际市场构件或锁文件解析与更新前状态不一致，不能确认取消或失败已恢复；请在应用插件管理器核验'
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
      if (approval !== undefined && (!sameRelease(approval.release, checkedReleases.get(before) ?? { version: '', gitHead: '', tarball: '' }))) {
        throw new Error('待批准的更新版本已变化，请重新更新并核对提示。')
      }
      if (!before.updateAvailable) {
        setOperation(operation, { phase: 'done', message: '已经是最新版本', status: before })
        return
      }
      const checkedRelease = checkedReleases.get(before)
      const currentRelease = latestRelease
      if (checkedRelease === undefined || checkedRelease.version !== before.latestVersion || currentRelease === null
        || !sameRelease(currentRelease, checkedRelease)) {
        const message = '版本检查结果已变化，请重新检查后再更新。'
        operation.failure = { kind: 'command', message }
        setOperation(operation, { phase: 'failed', message, status: before })
        return
      }
      // Freeze the checked source and integrity across concurrent metadata requests.
      targetRelease = Object.freeze({ ...checkedRelease })
      const assertApprovalCurrent = (): void => {
        if (approval === undefined) return
        const failed = operations.get(approval.failedId)
        const target = failed?.failure?.releaseAgeTarget
        if (failed?.phase !== 'failed' || failed.failure !== approval.failure || failed.failure.action !== 'approve-release-age'
          || target?.packageName !== approval.target.packageName || target.version !== approval.target.version
          || latestRelease === null || targetRelease === undefined || !sameRelease(approval.release, targetRelease) || !sameRelease(latestRelease, targetRelease)) {
          throw new Error('待批准的更新或精确版本已变化，请重新更新并核对提示。')
        }
        if (controller.signal.aborted) throw new Error('更新已取消')
      }
      assertApprovalCurrent()
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
          if (controller.signal.aborted) throw new Error('更新已取消')
          assertApprovalCurrent()
          repairReleaseAgeExcludes(profileDir)
          if (approval !== undefined) {
            allowReleaseAgeVersion(profileDir, approval.target)
            releaseAgeApprovals.delete(approval.failedId)
            logEvent('info', 'market-update-release-age-approved', `${approval.target.packageName}@${approval.target.version}`, operation.id)
          }
          assertApprovalCurrent()
          lastResult = await runner(profile, args, { signal: controller.signal, onStdout: report, onStderr: report })
          // A failed pnpm policy check can leave the new package materialized
          // while Desktop restores the old manifest. Repairing the rule named
          // by that settled refusal allows the same exact install to converge.
          if (!controller.signal.aborted && !lastResult.aborted && !lastResult.timedOut
            && lastResult.management?.application === 'failed') {
            const repaired = repairReleaseAgeExcludes(profileDir)
            const failure = officialOperationFailure(lastResult)
            const blocked = failure?.releaseAgeTarget
            const exactBlocked = blocked === undefined ? undefined : parseReleaseAgeTarget(blocked.packageName, blocked.version)
            const knownAgeRepair = failure?.kind === 'release-age' && exactBlocked !== undefined && repaired.includes(exactBlocked.packageName)
            const restored = baseline !== undefined && compareInstalledArtifact(profileDir, baseline).ok
            if (repaired.length > 0 && (restored || knownAgeRepair)) {
              assertApprovalCurrent()
              logEvent('info', 'market-update-release-age-repair', '已合并重复的精确版本规则，正在重试市场更新', operation.id)
              lastResult = await runner(profile, args, { signal: controller.signal, onStdout: report, onStderr: report })
            }
          }
          const managed = lastResult.management
          if (managed?.indeterminate === true || managed?.application === 'failed' || managed?.application === 'cancelled') {
            throw new Error(officialOperationFailure(lastResult)?.message ?? '官方 Desktop 未完成市场更新')
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
      mutationStarted = true
      await run(['add', `${MARKET_NPM_PACKAGE}@${targetRelease.version}`, '--reporter=ndjson'])
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
      const next = releaseStatus(targetRelease)
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
        const officialFailure = managerOwned && lastResult?.management?.application === 'failed' ? officialOperationFailure(lastResult) : undefined
        if (officialFailure !== undefined) {
          const blocked = officialFailure.releaseAgeTarget
          const target = blocked === undefined ? undefined : parseReleaseAgeTarget(blocked.packageName, blocked.version)
          operation.failure = officialFailure.kind === 'release-age' && target !== undefined && targetRelease !== undefined
            && !controller.signal.aborted && !lastResult?.aborted && !lastResult?.timedOut
            ? { ...officialFailure, releaseAgeTarget: target, action: 'approve-release-age' } : officialFailure
          logEvent('error', 'market-update-official', `kind=${officialFailure.kind} ${officialFailureDiagnostic(lastResult!)}`, operation.id)
        } else if (error instanceof PnpmCommandError) {
          const failure = error.failure
          const action = failure.kind === 'network' || failure.kind === 'fetch-timeout' ? 'retry' : undefined
          operation.failure = {
            kind: failure.kind,
            message: failure.message,
            ...(failure.packageName === undefined ? {} : { packageName: failure.packageName }),
            ...(action === undefined ? {} : { action }),
          }
        }
        if (officialFailure === undefined && !(error instanceof PnpmCommandError)) logEvent('error', 'market-update', error instanceof Error ? error.message : String(error), operation.id)
        let recoveryMessage = recoveryError
        if (recoveryError !== undefined) {
          // A settled, exact age refusal can occur after materialization and
          // partial rollback. Explicit approval may finish this same release;
          // it never grants permission to continue an unknown transaction.
          const canFinishKnownAge = managedArtifactMismatch && operation.failure?.kind === 'release-age'
            && operation.failure.action === 'approve-release-age'
          if (canFinishKnownAge) {
            recoveryMessage = '安装文件已部分写入，可允许此精确版本后继续完成更新。'
            operation.failure = { ...operation.failure!, message: `${operation.failure!.message}；${recoveryMessage}` }
          } else {
            operation.failure = officialFailure === undefined ? { kind: 'command', message: recoveryError }
              : { ...officialFailure, message: `${officialFailure.message}；${recoveryError}` }
            delete operation.failure.action
          }
          logEvent('error', 'market-update-recovery', recoveryError, operation.id)
        }
        const blocked = operation.failure?.releaseAgeTarget
        const target = blocked === undefined ? undefined : parseReleaseAgeTarget(blocked.packageName, blocked.version)
        if (operation.failure?.action === 'approve-release-age' && target !== undefined && targetRelease !== undefined) {
          releaseAgeApprovals.set(operation.id, { failedId: operation.id, failure: operation.failure, release: targetRelease, target: Object.freeze({ ...target }) })
        }
        const managedFailure = lastResult?.management?.application === 'failed' && controller.signal.aborted
          ? '官方 Desktop 返回市场更新失败；取消请求没有替代管理器的最终结果，请查看插件管理器诊断'
          : undefined
        const cause = managedFailure ?? (error instanceof Error ? error.message : String(error))
        setOperation(operation, { phase: 'failed', message: recoveryMessage === undefined ? cause : managerOwned ? `${cause}；${recoveryMessage}` : recoveryMessage })
      }
    } finally {
      abortControllers.delete(operation.id)
      pendingApprovals.delete(operation.id)
      updating = operation.phase === 'waiting'
    }
  }

  const status = async (force = false): Promise<MarketUpdateStatus> => {
    reconcileInstalledVersion()
    if (!force && cached !== null && Date.now() - cached.checkedAt < cacheMs) {
      cached.status = releaseStatus(cached.release)
      return cached.status
    }
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
    const next = releaseStatus(release)
    latestRelease = release
    cached = { checkedAt: Date.now(), status: next, release }
    return next
  }

  const startUpdate = (approval?: MarketReleaseApproval): MarketUpdateOperation => {
    if (disposed) throw new Error('皮肤市场更新器已停止')
    if (activeOperation !== null) return operations.get(activeOperation)!
    reconcileInstalledVersion()
    const operation: MarketUpdateOperation = { id: randomUUID(), phase: 'queued', cancelable: cancellationAvailable(), startedAt: new Date().toISOString() }
    operations.set(operation.id, operation)
    activeOperation = operation.id
    updating = true
    const controller = new AbortController()
    abortControllers.set(operation.id, controller)
    if (approval !== undefined) pendingApprovals.set(operation.id, approval)
    const updatePromise = updateTarget(operation, controller)
    updatePromises.set(operation.id, updatePromise)
    void updatePromise.then(
      () => { updatePromises.delete(operation.id) },
      () => { updatePromises.delete(operation.id) },
    )
    const timer = setTimeout(() => {
      if (activeOperation !== operation.id) { operations.delete(operation.id); releaseAgeApprovals.delete(operation.id) }
    }, 30 * 60 * 1000)
    timer.unref?.()
    return operation
  }

  return {
    status,
    get restartRequired() { reconcileInstalledVersion(); return restartRequired },
    get restartNoticeId() { reconcileInstalledVersion(); return restartRequired ? `market-${loadedVersion}-${installedVersion}` : undefined },
    async update() {
      if (updating) throw new Error('皮肤市场正在更新')
      const operation = startUpdate()
      while (operation.phase !== 'done' && operation.phase !== 'failed' && operation.phase !== 'cancelled' && operation.phase !== 'waiting') {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      if (operation.phase !== 'done' || operation.status === undefined) throw new Error(operation.message ?? '皮肤市场更新失败')
      return operation.status
    },
    startUpdate: () => startUpdate(),
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
    retry(id, action = 'retry') {
      const failed = operations.get(id)
      if (failed === undefined || failed.phase !== 'failed' || failed.failure?.action !== action) throw new Error('更新任务不可重试')
      if (action === 'approve-release-age') {
        const approval = releaseAgeApprovals.get(id)
        if (approval === undefined || failed.failure !== approval.failure) throw new Error('更新任务不可重试')
        if (activeOperation !== null) throw new Error('皮肤市场正在更新')
        return startUpdate(approval)
      }
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
