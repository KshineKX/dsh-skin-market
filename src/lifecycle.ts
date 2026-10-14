import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { buildApprovalKeyForTarget, effectiveBuildApprovalKey } from './build-approval.ts'
import { assessCompatibility } from './compatibility.ts'
import { persistCompatibilityPatch, planCompatibilityPatch } from './compatibility-adapter.ts'
import type { CommandOptions, CommandResult, PluginInstallRequest, PluginRunner } from './commands.ts'
import { loadCatalog } from './catalog.ts'
import { companionAsSkin, discoverMonorepoTarget, isNpmInstallTarget, preferredInstallTarget, reviewedNpmSourceError, updateInstallTarget } from './install-resolution.ts'
import { sharedLoaderIdentifiers } from './loader-ownership.ts'
import { failureDiagnostic, PnpmCommandError, runPnpmWithRecovery, type PnpmFailure } from './pnpm-recovery.ts'
import { pluginArgsFor } from './pnpm-compat.ts'
import { PnpmProgressTracker } from './pnpm-progress.ts'
import { cleanOrphanedStore } from './store.ts'
import { logEvent } from './log.ts'
import { compareVersions, isVersionRange, satisfiesVersionRange } from './semver.ts'
import {
  companionNeedsInstall,
  ensureBuildAllowed,
  ensureSkinRegistration,
  hasLoaderOverride,
  reviewedInstalledSpecMatches,
  npmSourceMigration,
  cleanupCompatibilityPatchFiles,
  detachCompatibilityPatches,
  pnpmLockfile,
  pnpmWorkspaceFile,
  profilePatchFile,
  readDependencies,
  readMarketState,
  readProfileBundles,
  assertNoLoaderConflicts,
  installedLoaderIdentities,
  InstallConflictError,
  LoaderMetadataError,
  compatibilityPatchFile,
  marketStateFile,
  packageManifest,
  packageLoaderOwnershipAt,
  patchedDependenciesNeedSync,
  removeSkinRegistration,
  restoreFile,
  setManagedLoaderOverride,
  restoreManifest,
  runtimeState,
  snapshotFile,
  snapshotInstalledArtifact,
  compareInstalledArtifact,
  validateInstalledSkin,
  validateDesktopArtifact,
  writeMarketState,
  type FileSnapshot,
  type LoaderIdentity,
  type InstalledArtifactSnapshot,
} from './profile.ts'
import type { DesktopInstallCapability, DshRuntime, InstallConflict, LoaderEntry, MarketHostKind, Operation, OperationFailure, OperationKind, PersistedMarketState, SkinEntry, SkinRuntimeState } from './types.ts'

export interface LifecycleHost {
  loader: { entries(): Iterable<LoaderEntry> }
  on?(event: string, callback: (fiber: { entry?: { options?: { name?: string; id?: string } } }) => void): () => void
}

export interface LifecycleOptions {
  profile: string
  profileDir: string
  runner: PluginRunner
  hostKind?: MarketHostKind
  runtime?: DshRuntime
  /** Shared by all preparation/install attempts; recovery has its own budget. */
  operationTimeoutMs?: number
  recoveryTimeoutMs?: number
  lifecycleWaitMs?: number
}

const OPERATION_TIMEOUT_MS = 15 * 60 * 1000
const RECOVERY_TIMEOUT_MS = 60_000
const DESKTOP_PARALLEL_DOWNLOADS = 2
const CONSTRAINED_PARALLEL_DOWNLOADS = 1
const LOW_MEMORY_BYTES = 3 * 1024 ** 3

function isConstrainedHost(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  memoryBytes: number = totalmem(),
): boolean {
  if (platform === 'android') return true
  if ((env.ANDROID_ROOT ?? '').trim() !== '' || (env.ANDROID_DATA ?? '').trim() !== '') return true
  return memoryBytes > 0 && memoryBytes < LOW_MEMORY_BYTES
}

/** Isolated temp-dir prefetches may overlap; live profile pnpm stays serial. */
export function maxParallelDownloads(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  memoryBytes: number = totalmem(),
): number {
  return isConstrainedHost(platform, env, memoryBytes) ? CONSTRAINED_PARALLEL_DOWNLOADS : DESKTOP_PARALLEL_DOWNLOADS
}

function isTerminalPhase(phase: Operation['phase']): boolean {
  return phase === 'done' || phase === 'failed' || phase === 'cancelled'
}

function removePrefetchDirectory(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true })
  } catch {
    // Windows and some Android filesystems can keep a handle on node_modules
    // until the pnpm child has fully released it. Leave the directory; tmp
    // cleanup is best-effort and must not fail a completed download.
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

class ManagedOperationError extends Error {
  constructor(readonly result: CommandResult, message: string) { super(message) }
}

function recoveryMessage(failure: PnpmFailure): string {
  if (failure.recovery === 'disable-peer-autoinstall') return '检测到宿主提供但 npm 未发布的 peer，正在关闭 peer 自动安装并重试'
  if (failure.kind === 'release-age') return '检测到新包保护，正在临时放宽本次命令并重试'
  if (failure.kind === 'fetch-timeout') return '当前步骤超时，正在剩余安装时间内重试一次'
  if (failure.kind === 'network') return '检测到临时网络错误，正在自动重试'
  return failure.message
}

interface ProfileInstallSnapshot {
  manifest: FileSnapshot
  profilePatch: FileSnapshot
  marketState: FileSnapshot
  workspace: FileSnapshot
  lockfile: FileSnapshot
  compatibility: FileSnapshot
  artifact: InstalledArtifactSnapshot
}

function snapshotInstallFiles(profileDir: string, packageName: string, version: string): ProfileInstallSnapshot {
  return {
    manifest: snapshotFile(join(profileDir, 'package.json')),
    profilePatch: snapshotFile(profilePatchFile(profileDir)),
    marketState: snapshotFile(marketStateFile(profileDir)),
    workspace: snapshotFile(pnpmWorkspaceFile(profileDir)),
    lockfile: snapshotFile(pnpmLockfile(profileDir)),
    compatibility: snapshotFile(compatibilityPatchFile(profileDir, packageName, version)),
    artifact: snapshotInstalledArtifact(profileDir, packageName),
  }
}

function restoreProfileInstallFiles(profileDir: string, packageName: string, version: string, snapshot: ProfileInstallSnapshot): void {
  restoreManifest(profileDir, snapshot.manifest)
  restoreFile(profilePatchFile(profileDir), snapshot.profilePatch)
  restoreFile(marketStateFile(profileDir), snapshot.marketState)
  restoreFile(pnpmWorkspaceFile(profileDir), snapshot.workspace)
  restoreFile(pnpmLockfile(profileDir), snapshot.lockfile)
  restoreFile(compatibilityPatchFile(profileDir, packageName, version), snapshot.compatibility)
}

export function desktopInstallError(capability: DesktopInstallCapability | undefined): string {
  if (capability?.mode === 'manual-only') {
    return `Desktop 当前不支持该皮肤的一键安装（${capability.reason}），请查看仓库安装说明`
  }
  return 'Desktop 当前仅支持已验证 npm 精确版本的一键安装，请查看仓库安装说明'
}

interface PrefetchedPackage {
  target: string
  loaderRows: LoaderIdentity[]
  packageRows: LoaderIdentity[]
  hasBundle: boolean
}

function pinnedSkinIds(state: PersistedMarketState): string[] {
  return [...new Set((state.pinnedSkinIds ?? []).filter(id => typeof id === 'string'))]
}

function enabledSkinIds(state: PersistedMarketState): Set<string> {
  return new Set([...(state.activeSkinId === null ? [] : [state.activeSkinId]), ...pinnedSkinIds(state)])
}

function isWebClientPackage(profileDir: string, packageName: string): boolean {
  const manifest = packageManifest(profileDir, packageName)
  if (manifest === null || typeof manifest.dsh !== 'object' || manifest.dsh === null || Array.isArray(manifest.dsh)) return false
  const client = (manifest.dsh as Record<string, unknown>).client
  if (typeof client !== 'object' || client === null || Array.isArray(client)) return false
  return (client as Record<string, unknown>).platform === 'web'
}

function recordActivity(state: PersistedMarketState, skinId: string, kind: 'installedAt' | 'updatedAt' | 'usedAt', at: string): void {
  state.activity = { ...state.activity, [skinId]: { ...state.activity?.[skinId], [kind]: at } }
}

// Keep this in an .npmrc file instead of passing `--config.fetchTimeout` on
// the CLI. pnpm 11 currently leaves the dotted CLI value as a string, while
// its retry timer requires a number and throws ERR_INVALID_ARG_TYPE.
// The prefetch project only downloads and inspects the plugin; it must not
// resolve host-provided peer packages from the public npm registry.
const PNPM_FETCH_CONFIG = 'fetch-timeout=600000\nauto-install-peers=false\n'

export class SkinLifecycle {
  readonly operations = new Map<string, Operation>()
  private profileChain: Promise<void> = Promise.resolve()
  private profileLockOwner: string | null = null
  private downloadAvailable = maxParallelDownloads()
  private readonly downloadWaiters: Array<() => void> = []
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly pendingBuildKeys = new Map<string, string[]>()
  private readonly deadlines = new Map<string, number>()
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly operationCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly expired = new Set<string>()
  private readonly profileMutations = new Map<string, number>()
  private readonly recoveryErrors = new Map<string, string>()
  private readonly desktopManagedAttempts = new Set<string>()
  private readonly desktopRecoveryBaselines = new Map<string, { snapshot: ProfileInstallSnapshot; mutationsBefore: number }>()
  private readonly executions = new Map<string, Promise<void>>()
  private catalogEntries: SkinEntry[]
  private skinById: Map<string, SkinEntry>
  private disposeEvent?: () => void
  private disposed = false
  private readonly pendingLifecycle = new Set<Promise<unknown>>()
  private unresolvedManager = false

  get waitingReason(): string | undefined {
    if (this.unresolvedManager) return '宿主未返回可确认的操作结果，请重新打开宿主后核对插件状态'
    if (this.pendingLifecycle.size > 0) return '插件仍在完成启停，结果尚未确认；暂时不能继续修改此 profile'
    return undefined
  }

  constructor(private readonly host: LifecycleHost, private readonly options: LifecycleOptions, catalog = loadCatalog().skins) {
    this.catalogEntries = catalog
    this.skinById = new Map(catalog.map(skin => [skin.id, skin]))
  }

  get catalog(): SkinEntry[] { return this.catalogEntries }

  private get hostKind(): MarketHostKind { return this.options.hostKind ?? this.options.runner.hostKind ?? 'dsh' }
  private get management() { return this.options.runner.management }

  private acceptManagement(result: CommandResult, operation?: Operation): void {
    const managed = result.management
    if (managed?.indeterminate === true) {
      this.unresolvedManager = true
      if (operation !== undefined) this.update(operation, 'waiting', this.waitingReason)
      throw new Error(this.waitingReason)
    }
    if (managed?.application !== undefined && operation !== undefined) {
      operation.application = managed.application
      if (managed.application === 'restart-required') operation.restartRequired = true
      if (managed.pendingBuilds !== undefined) this.pendingBuildKeys.set(operation.id, managed.pendingBuilds)
    }
    if (result.exitCode !== 0 || managed?.application === 'overridden') {
      throw new ManagedOperationError(result, managed?.application === 'overridden' ? '启停设置已保存，但被其他配置覆盖，尚未生效' : result.stderr || result.stdout || '官方插件管理操作未完成')
    }
  }

  private async awaitLifecycle<T>(promise: Promise<T>, operation = this.profileLockOwner === null ? undefined : this.operations.get(this.profileLockOwner)): Promise<T> {
    let delayed = false
    const timer = setTimeout(() => {
      delayed = true
      this.pendingLifecycle.add(promise)
      if (operation !== undefined) this.update(operation, 'waiting', this.waitingReason)
    }, this.options.lifecycleWaitMs ?? 10_000)
    timer.unref?.()
    try {
      const result = await promise
      if (this.disposed) throw new Error('皮肤市场宿主已停止')
      return result
    } finally {
      clearTimeout(timer)
      this.pendingLifecycle.delete(promise)
      if (delayed && operation?.phase === 'waiting' && !this.unresolvedManager && !this.disposed) this.update(operation, 'activating', '宿主启停已结束，正在核对结果')
    }
  }

  private recordRestart(state: PersistedMarketState, skinId: string, required: boolean, removed = false): void {
    const ids = new Set(state.pendingRestart?.pid === process.pid ? state.pendingRestart.skinIds : [])
    if (required) ids.add(skinId)
    else if (removed || this.management === undefined) ids.delete(skinId)
    state.pendingRestart = ids.size === 0 ? undefined : { pid: process.pid, skinIds: [...ids] }
  }

  private async registerSkin(skin: SkinEntry, disabled = true): Promise<void> {
    if (this.management === undefined) return ensureSkinRegistration(this.options.profileDir, skin, disabled)
    const manifest = packageManifest(this.options.profileDir, skin.package)
    if (!disabled) this.assertLegacyOfficialPeers(manifest)
    const operation = this.profileLockOwner === null ? undefined : this.operations.get(this.profileLockOwner)
    const bundled = manifest !== null && typeof manifest.dsh === 'object' && manifest.dsh !== null && (manifest.dsh as Record<string, unknown>).bundle !== undefined
    if (bundled) {
      const selected = readProfileBundles(this.options.profileDir).includes(skin.package)
      const installing = operation !== undefined && ['install', 'update', 'migrate'].includes(operation.kind)
      if (selected === !disabled && (operation === undefined || installing && operation.restartRequired === true)) return
      this.acceptManagement(await this.awaitLifecycle(this.management.setBundleEnabled(skin.package, !disabled)), operation)
      return
    }
    if (operation === undefined) return
    const rows = await this.management.listPlugins()
    const matches = Array.isArray(rows) ? rows.filter((row: Record<string, unknown>) => row.patchId === skin.rowId && row.moduleName === skin.package && typeof row.entryId === 'string') : []
    if (matches.length !== 1) throw new Error('此插件没有可由当前官方管理服务启停的组合包或唯一插件行，请使用官方插件页')
    this.acceptManagement(await this.awaitLifecycle(this.management.setPluginEnabled(matches[0].entryId as string, !disabled)), operation)
  }

  private get runtime(): DshRuntime {
    return this.options.runtime ?? { version: null, capabilities: [], source: 'unknown' }
  }

  private assertLegacyOfficialPeers(manifest: Record<string, unknown> | null): void {
    if (this.management === undefined || this.runtime.version === null || compareVersions(this.runtime.version, '0.1.7-rc.1') >= 0) return
    const peers = manifest?.peerDependencies
    if (peers === undefined) return
    if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) throw new Error('插件 peerDependencies 无效，旧版官方宿主无法核验兼容性')
    for (const [name, value] of Object.entries(peers)) {
      if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`插件 ${name} 的兼容范围无效`)
      const range = value.trim()
      if (['workspace:^', 'workspace:~', 'workspace:*', '*', 'x', 'X'].includes(range)) continue
      const canonicalNumbers = range.split(/[\s|]+/).filter(Boolean).every(term => {
        const raw = term.replace(/^[><=^~]+/, '').split('+')[0]!
        const [core, ...suffix] = raw.split('-')
        return !core!.split('.').some(part => /^0\d+$/.test(part)) && !suffix.join('-').split('.').some(part => /^0\d+$/.test(part))
      })
      if (!canonicalNumbers || !isVersionRange(range) || !satisfiesVersionRange(this.runtime.version, range)) throw new Error(`旧版官方宿主不能确认 ${name} ${range} 与 DSH ${this.runtime.version} 兼容，请使用维护者声明兼容的版本`)
    }
  }

  private async applyCompatibility(skin: SkinEntry, operation: Operation): Promise<void> {
    const plan = planCompatibilityPatch(this.options.profileDir, skin, this.runtime)
    if (plan === null || plan.adapterIds.length === 0) return
    if (this.management !== undefined) throw new Error('当前官方 Desktop 的插件事务不能由市场改写兼容补丁，请使用适合当前宿主的插件版本')
    persistCompatibilityPatch(this.options.profileDir, plan)
    await this.syncPnpmMetadata(operation, `正在应用兼容适配：${plan.adapterIds.join('、')}`)
  }

  private async syncPnpmMetadata(operation: Operation, message = '正在同步 pnpm 锁文件'): Promise<void> {
    if (this.management !== undefined) return
    if (!patchedDependenciesNeedSync(this.options.profileDir)) return
    this.update(operation, 'installing', message)
    await this.run(['install', '--no-frozen-lockfile'], operation)
    if (patchedDependenciesNeedSync(this.options.profileDir)) {
      throw new Error('pnpm patchedDependencies 未能与锁文件同步，已停止本次操作以保护 profile')
    }
  }

  private applyPendingBuildApprovals(operation: Operation): void {
    if (this.hostKind === 'desktop') return
    for (const key of this.pendingBuildKeys.get(operation.id) ?? []) ensureBuildAllowed(this.options.profileDir, key)
  }

  private prefetchBuildApprovals(skin: SkinEntry, operation: Operation, target: string): string[] {
    if (isNpmInstallTarget(skin, target)) return []
    const reviewed = buildApprovalKeyForTarget(skin, target) ?? effectiveBuildApprovalKey(skin)
    return [...new Set([
      ...(this.pendingBuildKeys.get(operation.id) ?? []),
      ...(reviewed === undefined ? [] : [reviewed]),
    ])]
  }

  private preparePrefetchDirectory(directory: string, buildKeys: readonly string[]): void {
    writeFileSync(join(directory, 'package.json'), '{"private":true}\n', 'utf8')
    writeFileSync(join(directory, '.npmrc'), PNPM_FETCH_CONFIG, 'utf8')
    if (buildKeys.length === 0) return
    writeFileSync(join(directory, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8')
    for (const key of buildKeys) ensureBuildAllowed(directory, key)
  }

  private async repairMaterializedPackage(skin: SkinEntry, operation: Operation): Promise<void> {
    this.update(operation, 'installing', `正在修复已记录但未物化的皮肤依赖：${skin.package}`)
    await this.run(['install'], operation)
  }

  async replaceCatalog(catalog: SkinEntry[]): Promise<void> {
    this.catalogEntries = catalog
    this.skinById = new Map(catalog.map(skin => [skin.id, skin]))
    await this.replay()
  }

  start(): void {
    if (this.disposed) return
    void this.replay().catch(error => logEvent('error', 'startup-replay', errorMessage(error)))
    this.disposeEvent = this.host.on?.('internal/plugin', fiber => {
      if (this.disposed || this.profileLockOwner !== null || this.waitingReason !== undefined) return
      const name = fiber.entry?.options?.name
      const id = fiber.entry?.options?.id
      const skin = this.catalog.find(item => item.rowId === name || item.rowId === id || item.package === name)
      if (skin === undefined) return
      const state = readMarketState(this.options.profileDir)
      const shouldDisable = !enabledSkinIds(state).has(skin.id)
      void this.setEntryDisabled(skin, shouldDisable).catch(error => logEvent('error', 'loader-replay', errorMessage(error)))
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.disposeEvent?.()
    this.disposeEvent = undefined
    for (const controller of this.abortControllers.values()) controller.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled([...this.executions.values()]),
      new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.lifecycleWaitMs ?? 10_000) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    for (const timer of this.deadlineTimers.values()) clearTimeout(timer)
    for (const timer of this.operationCleanupTimers.values()) clearTimeout(timer)
    this.deadlineTimers.clear()
    this.operationCleanupTimers.clear()
    this.operations.clear()
    this.pendingBuildKeys.clear()
    this.deadlines.clear()
    this.expired.clear()
    this.profileMutations.clear()
    this.recoveryErrors.clear()
    this.desktopManagedAttempts.clear()
    this.desktopRecoveryBaselines.clear()
    this.abortControllers.clear()
    this.executions.clear()
  }

  skin(id: string): SkinEntry {
    const skin = this.skinById.get(id)
    if (skin === undefined) throw new Error('skin is not in the curated registry')
    return skin
  }

  private entriesFor(skin: SkinEntry): LoaderEntry[] {
    return [...this.host.loader.entries()].filter(entry => {
      const name = entry.options.name
      const id = entry.options.id
      return name === skin.rowId || id === skin.rowId || name === skin.package || id === skin.package
    })
  }

  private async setEntryDisabled(skin: SkinEntry, disabled: boolean): Promise<{ found: boolean; live: boolean }> {
    if (this.management !== undefined) {
      const entries = this.entriesFor(skin)
      return { found: entries.length > 0, live: entries.some(entry => entry.fiber !== undefined && entry.options.disabled !== true) }
    }
    return await this.setLoaderDisabled({ id: skin.rowId, name: skin.package }, disabled)
  }

  private async setLoaderDisabled(identity: LoaderIdentity, disabled: boolean): Promise<{ found: boolean; live: boolean }> {
    const entries = [...this.host.loader.entries()].filter(entry =>
      (identity.id !== undefined && entry.options.id === identity.id)
      || (identity.name !== undefined && entry.options.name === identity.name),
    )
    for (const entry of entries) {
      // Do not rewrite an already-correct loader state during startup. The
      // DSH client module registry builds its browser boot graph while loader
      // entries are becoming live; an unnecessary disabled -> enabled cycle
      // can make an active skin disappear from that graph until the next
      // restart.
      const currentlyDisabled = entry.options.disabled === true
      if (currentlyDisabled === disabled) continue
      if (this.disposed) throw new Error('皮肤市场宿主已停止')
      await this.awaitLifecycle(entry.update({ disabled: disabled ? true : null }, false, true))
    }
    return { found: entries.length > 0, live: entries.some(entry => entry.fiber !== undefined) }
  }

  private claimManagedLoaders(
    state: PersistedMarketState,
    skin: SkinEntry,
    incomingRows: readonly LoaderIdentity[],
    beforeRows: readonly LoaderIdentity[],
  ): void {
    for (const identity of incomingRows) {
      if (identity.id === undefined) continue
      if (identity.id === skin.rowId && identity.name === skin.package) continue
      const existing = state.managedLoaders?.[identity.id]
      if (existing !== undefined) {
        if (sharedLoaderIdentifiers(existing, identity).length === 0) continue
        if (!existing.ownerSkinIds.includes(skin.id)) existing.ownerSkinIds.push(skin.id)
        continue
      }
      if (beforeRows.some(row => sharedLoaderIdentifiers(row, identity).length > 0)) continue
      if (hasLoaderOverride(this.options.profileDir, identity)) continue
      state.managedLoaders = {
        ...state.managedLoaders,
        [identity.id]: {
          id: identity.id,
          ...(identity.name === undefined ? {} : { name: identity.name }),
          ...(identity.packageName === undefined ? {} : { packageName: identity.packageName }),
          ownerSkinIds: [skin.id],
        },
      }
    }
  }

  private releaseManagedLoaders(state: PersistedMarketState, skinId: string): void {
    for (const [key, identity] of Object.entries(state.managedLoaders ?? {})) {
      if (!identity.ownerSkinIds.includes(skinId)) continue
      identity.ownerSkinIds = identity.ownerSkinIds.filter(ownerSkinId => ownerSkinId !== skinId)
      if (identity.ownerSkinIds.length > 0) continue
      if (this.management === undefined) setManagedLoaderOverride(this.options.profileDir, identity, false)
      delete state.managedLoaders?.[key]
    }
    if (state.managedLoaders !== undefined && Object.keys(state.managedLoaders).length === 0) delete state.managedLoaders
  }

  private async syncManagedLoaders(state: PersistedMarketState, live: boolean): Promise<void> {
    if (this.management !== undefined) return
    const enabled = enabledSkinIds(state)
    for (const identity of Object.values(state.managedLoaders ?? {})) {
      const disabled = !identity.ownerSkinIds.some(ownerSkinId => enabled.has(ownerSkinId))
      // Disabled bundle skins are removed from dsh.profile.bundles, so their
      // child rows no longer exist at boot. Persisting child disable rows here
      // would create orphan overrides; receipts are needed only for live sync.
      const controlled = setManagedLoaderOverride(this.options.profileDir, identity, false)
      if (live && controlled) await this.setLoaderDisabled(identity, disabled)
    }
  }

  private reconcileDisabledSkinIds(state: PersistedMarketState): void {
    const enabled = enabledSkinIds(state)
    state.disabledSkinIds = this.catalog.filter(skin => !enabled.has(skin.id)).map(skin => skin.id)
  }

  private requiresRestartForTransition(previous: PersistedMarketState, next: PersistedMarketState): boolean {
    if (this.management !== undefined) return false
    const changed = new Set([...enabledSkinIds(previous), ...enabledSkinIds(next)])
    const dependencies = readDependencies(this.options.profileDir)
    return [...changed].some(id => {
      const skin = this.skinById.get(id)
      return skin !== undefined && dependencies[skin.package] !== undefined && isWebClientPackage(this.options.profileDir, skin.package)
    })
  }

  async replay(): Promise<void> {
    if (this.disposed || this.waitingReason !== undefined) return
    const state = readMarketState(this.options.profileDir)
    if (state.pendingRestart !== undefined && state.pendingRestart.pid !== process.pid) {
      delete state.pendingRestart
      writeMarketState(this.options.profileDir, state)
    }
    const dependencies = readDependencies(this.options.profileDir)
    const installed = this.catalog.filter(skin => dependencies[skin.package] !== undefined)
    const rootBundles = new Set(readProfileBundles(this.options.profileDir))
    // An explicitly bundled skin that has not yet been recorded as managed
    // is treated as active. Managed inactive bundles are removed below.
    const installedIds = new Set(installed.map(skin => skin.id))
    const normalizedPinned = pinnedSkinIds(state).filter(id => installedIds.has(id))
    const stateChanged = JSON.stringify(state.pinnedSkinIds ?? []) !== JSON.stringify(normalizedPinned)
    state.pinnedSkinIds = normalizedPinned
    const manuallyActive = state.activeSkinId === null
      ? installed.filter(skin => rootBundles.has(skin.package) && !state.disabledSkinIds.includes(skin.id) && !normalizedPinned.includes(skin.id)).at(-1)
      : undefined
    if (manuallyActive !== undefined) {
      state.activeSkinId = manuallyActive.id
    }
    const previousDisabled = JSON.stringify(state.disabledSkinIds)
    this.reconcileDisabledSkinIds(state)
    if (stateChanged || manuallyActive !== undefined || previousDisabled !== JSON.stringify(state.disabledSkinIds)) {
      writeMarketState(this.options.profileDir, state)
    }
    const enabled = enabledSkinIds(state)
    for (const skin of installed) await this.registerSkin(skin, !enabled.has(skin.id))
    // On startup, preserve the active entry's initial loader state. Toggling
    // it off and back on here races the client-module registry, which builds
    // the browser boot graph while loader entries are becoming live. Only
    // reconcile installed non-active entries; the active entry's profile
    // override was already written above and should be loaded directly.
    for (const skin of installed) {
      await this.setEntryDisabled(skin, !enabled.has(skin.id))
    }
    await this.syncManagedLoaders(state, true)
    const previousCompanions = JSON.stringify(state.managedCompanions)
    await this.syncInstalledCompanions(state, true)
    if (previousCompanions !== JSON.stringify(state.managedCompanions)) writeMarketState(this.options.profileDir, state)
  }

  states(): SkinRuntimeState[] {
    const state = readMarketState(this.options.profileDir)
    return this.catalog.map(skin => {
      const entries = this.entriesFor(skin)
      const runtime = runtimeState(this.options.profileDir, skin, state.activeSkinId, entries.some(entry => entry.fiber !== undefined), entries.length > 0, pinnedSkinIds(state), state.activity?.[skin.id])
      const sourceMigration = this.hostKind === 'desktop' ? undefined : npmSourceMigration(this.options.profileDir, skin)
      const restartPending = state.pendingRestart?.pid === process.pid && state.pendingRestart.skinIds.includes(skin.id)
      return { ...runtime, ...(restartPending ? { activation: 'restart-required' as const } : {}), ...(sourceMigration === undefined ? {} : { sourceMigration }) }
    })
  }

  private liveOperations(): Operation[] {
    return [...this.operations.values()].filter(operation => !isTerminalPhase(operation.phase))
  }

  currentOperations(): Operation[] {
    return this.liveOperations()
  }

  currentOperation(): Operation | null {
    const live = this.liveOperations()
    if (live.length === 0) return null
    const rank = (operation: Operation): number => {
      if (operation.phase === 'installing' || operation.phase === 'validating' || operation.phase === 'activating' || operation.phase === 'cancelling') return 0
      if (operation.phase === 'downloading' || operation.phase === 'resolving') return 1
      return 2
    }
    return [...live].sort((left, right) => rank(left) - rank(right) || Date.parse(left.startedAt) - Date.parse(right.startedAt))[0] ?? null
  }

  begin(kind: OperationKind, skinId: string, approvedBuildKeys?: readonly string[] | string): Operation {
    if (this.disposed) throw new Error('皮肤市场宿主已停止，不能开始新的操作')
    if (this.waitingReason !== undefined) throw new Error(this.waitingReason)
    const action = kind === 'install' ? 'install' : kind === 'update' || kind === 'migrate' ? 'update' : kind === 'activate' || kind === 'pin' ? 'enable' : kind === 'uninstall' ? 'remove' : 'disable'
    const capability = this.management?.capabilities()[action]
    if (capability?.available === false) throw new Error(capability.reason ?? '当前宿主不支持此操作，请使用官方插件页')
    const skin = this.skin(skinId)
    if (this.management?.installRequiresRestart && (kind === 'activate' || kind === 'pin')) {
      const restart = readMarketState(this.options.profileDir).pendingRestart
      if (restart?.pid === process.pid && restart.skinIds.includes(skinId)) throw new Error('此版本官方 Desktop 安装后需要先完全退出并重开应用，再使用或常驻此皮肤；重复安装不能刷新当前宿主的加载缓存')
    }
    if (this.management !== undefined && ['install', 'update', 'migrate', 'activate', 'pin'].includes(kind)) {
      const assessment = assessCompatibility(skin, this.runtime)
      if (assessment.decision === 'incompatible') throw new Error(assessment.reason)
    }
    if (kind === 'install' || kind === 'update' || kind === 'migrate') {
      if (this.hostKind === 'desktop' && skin.install.desktop?.mode !== 'managed') {
        throw new Error(desktopInstallError(skin.install.desktop))
      }
      if (this.hostKind !== 'desktop' && skin.review?.installation === 'manual-only') {
        throw new Error('该皮肤尚未满足市场自动安装所需信息，请查看仓库安装说明')
      }
    }
    if (kind === 'migrate') this.assertNpmMigration(skin)
    if (this.liveOperations().some(operation => operation.skinId === skinId)) {
      throw new Error('another operation is already running for this skin')
    }
    const operation: Operation = {
      id: randomUUID(), kind, skinId, phase: 'queued', startedAt: new Date().toISOString(),
      cancelable: (kind === 'install' || kind === 'update' || kind === 'migrate') && this.management?.capabilities().cancel.available !== false,
    }
    this.operations.set(operation.id, operation)
    this.abortControllers.set(operation.id, new AbortController())
    if (kind === 'install' || kind === 'update' || kind === 'migrate') {
      const timeoutMs = this.options.operationTimeoutMs ?? OPERATION_TIMEOUT_MS
      this.deadlines.set(operation.id, Date.now() + timeoutMs)
      const timer = setTimeout(() => {
        this.expired.add(operation.id)
        operation.cancelable = false
        operation.message = '已达到安装总时限，正在结束当前步骤'
        this.abortControllers.get(operation.id)?.abort()
      }, timeoutMs)
      timer.unref?.()
      this.deadlineTimers.set(operation.id, timer)
    }
    const buildKeys = typeof approvedBuildKeys === 'string' ? [approvedBuildKeys] : approvedBuildKeys
    if (buildKeys !== undefined && buildKeys.length > 0) this.pendingBuildKeys.set(operation.id, [...new Set(buildKeys)])
    logEvent('info', 'operation', `${kind} ${skin.package}`, operation.id)
    const execution = this.execute(operation)
    this.executions.set(operation.id, execution)
    void execution.finally(() => {
      if (this.executions.get(operation.id) === execution) this.executions.delete(operation.id)
    }).catch(() => undefined)
    return operation
  }

  retry(id: string, action: 'retry' | 'approve-build'): Operation {
    const failed = this.operations.get(id)
    if (failed === undefined || failed.phase !== 'failed') throw new Error('operation is not retryable')
    if (failed.failure?.action !== action) throw new Error('该操作不支持此恢复动作')
    const approvedBuildKeys = action === 'approve-build' ? this.pendingBuildKeys.get(id) : undefined
    if (action === 'approve-build' && (approvedBuildKeys === undefined || approvedBuildKeys.length === 0)) throw new Error('未找到需要批准的精确构建项')
    return this.begin(failed.kind, failed.skinId, approvedBuildKeys)
  }

  private update(operation: Operation, phase: Operation['phase'], message?: string): void {
    operation.phase = phase
    operation.message = message
    operation.cancelable = (operation.kind === 'install' || operation.kind === 'update' || operation.kind === 'migrate')
      && (phase === 'queued' || phase === 'resolving' || phase === 'downloading')
      && this.management?.capabilities().cancel.available !== false
    if (phase === 'done' || phase === 'failed' || phase === 'cancelled') operation.finishedAt = new Date().toISOString()
  }

  cancel(id: string): Operation {
    const operation = this.operations.get(id)
    if (operation === undefined) throw new Error('operation not found')
    if (operation.phase === 'done' || operation.phase === 'failed' || operation.phase === 'cancelled') return operation
    if (operation.cancelable !== true) throw new Error('当前阶段无法安全取消，请等待操作完成')
    this.update(operation, 'cancelling', '正在取消并清理临时文件')
    this.abortControllers.get(id)?.abort()
    return operation
  }

  private async withProfileLock<T>(operation: Operation, fn: () => Promise<T>): Promise<T> {
    if (this.profileLockOwner === operation.id) return await fn()
    this.checkDeadline(operation)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const previous = this.profileChain
    this.profileChain = previous.then(() => held, () => held)
    try {
      await previous
      if (this.disposed) throw new Error('皮肤市场宿主已停止')
      if (this.waitingReason !== undefined) throw new Error(this.waitingReason)
      this.checkDeadline(operation)
      if (operation.phase === 'queued' || operation.phase === 'resolving' || operation.phase === 'downloading') {
        operation.message = operation.phase === 'queued' ? '正在等待其他皮肤操作完成' : '下载完成，正在等待写入'
      }
      this.profileLockOwner = operation.id
      return await fn()
    } finally {
      if (this.profileLockOwner === operation.id) this.profileLockOwner = null
      release()
    }
  }

  private async withDownloadSlot<T>(operation: Operation, fn: () => Promise<T>): Promise<T> {
    this.checkDeadline(operation)
    if (this.downloadAvailable === 0) {
      this.update(operation, 'queued', '正在等待下载名额')
      await new Promise<void>((resolve, reject) => {
        const controller = this.abortControllers.get(operation.id)
        const waiter = (): void => {
          controller?.signal.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = (): void => {
          const index = this.downloadWaiters.indexOf(waiter)
          if (index >= 0) this.downloadWaiters.splice(index, 1)
          reject(new Error('操作已取消'))
        }
        this.downloadWaiters.push(waiter)
        controller?.signal.addEventListener('abort', onAbort, { once: true })
        if (controller?.signal.aborted === true) onAbort()
      })
    } else {
      this.downloadAvailable -= 1
    }
    try {
      this.checkDeadline(operation)
      return await fn()
    } finally {
      const next = this.downloadWaiters.shift()
      if (next !== undefined) next()
      else this.downloadAvailable += 1
    }
  }

  private async execute(operation: Operation): Promise<void> {
    try {
      if (operation.kind === 'install') await this.install(operation)
      else if (operation.kind === 'activate') await this.activate(operation)
      else if (operation.kind === 'deactivate') await this.deactivate(operation)
      else if (operation.kind === 'pin') await this.pin(operation)
      else if (operation.kind === 'unpin') await this.unpin(operation)
      else if (operation.kind === 'update' || operation.kind === 'migrate') await this.updateSkin(operation)
      else await this.uninstall(operation)
      this.update(operation, 'done', operation.message)
    } catch (error) {
      if (this.disposed) {
        if (this.abortControllers.get(operation.id)?.signal.aborted && operation.application === undefined && this.management === undefined) this.update(operation, 'cancelled', '宿主已停止，操作已结束')
        return
      }
      if (this.unresolvedManager) {
        this.update(operation, 'waiting', this.waitingReason)
        return
      }
      if (error instanceof ManagedOperationError) {
        const managed = error.result.management
        if (managed?.indeterminate !== true && managed?.application !== undefined) operation.application = managed.application
        if (managed?.pendingBuilds?.length) {
          this.pendingBuildKeys.set(operation.id, managed.pendingBuilds)
          operation.failure = { kind: 'build-approval', message: error.message, buildKeys: managed.pendingBuilds, ...(this.management?.capabilities().buildApprovals.available ? { action: 'approve-build' as const } : {}) }
        } else if (managed?.error?.code === 'incompatible-version') operation.failure = { kind: 'compatibility', message: error.message }
      }
      if (this.expired.has(operation.id)) {
        const message = `安装已达到总时限，已停止继续重试${this.recoveryErrors.has(operation.id) ? `；${this.recoveryErrors.get(operation.id)}` : ''}`
        operation.failure = { kind: 'command', message, ...(this.recoveryErrors.has(operation.id) ? {} : { action: 'retry' as const }) }
        logEvent('error', 'operation-timeout', message, operation.id)
        this.update(operation, 'failed', message)
      } else if ((operation.application === 'cancelled' || operation.application === undefined && this.abortControllers.get(operation.id)?.signal.aborted === true) && !this.recoveryErrors.has(operation.id)) this.update(operation, 'cancelled', '操作已取消')
      else {
        if (error instanceof PnpmCommandError) {
          const failure = error.failure
          const buildKeys = failure.buildKeys ?? (failure.buildKey === undefined ? [] : [failure.buildKey])
          const action = failure.kind === 'network' || failure.kind === 'fetch-timeout'
            ? 'retry'
            : failure.kind === 'build-approval' && buildKeys.length > 0 && this.hostKind !== 'desktop'
              ? 'approve-build'
              : undefined
          const operationFailure: OperationFailure = {
            kind: failure.kind,
            message: failure.message,
            ...(failure.packageName === undefined ? {} : { packageName: failure.packageName }),
            ...(buildKeys.length === 0 ? {} : { buildKeys }),
            ...(action === undefined ? {} : { action }),
          }
          operation.failure = operationFailure
          if (buildKeys.length > 0) this.pendingBuildKeys.set(operation.id, buildKeys)
        }
        if (error instanceof InstallConflictError) {
          operation.failure = { kind: 'conflict', message: error.message, conflicts: error.conflicts }
        }
        if (operation.failure === undefined && (operation.kind === 'install' || operation.kind === 'update' || operation.kind === 'migrate') && assessCompatibility(this.skin(operation.skinId), this.runtime).decision === 'incompatible') {
          operation.failure = { kind: 'compatibility', message: errorMessage(error) }
        }
        logEvent(
          'error',
          error instanceof PnpmCommandError ? 'pnpm' : 'operation',
          error instanceof PnpmCommandError
            ? `kind=${error.failure.kind}${error.failure.packageName === undefined ? '' : ` package=${error.failure.packageName}`} ${failureDiagnostic(error.result)}`
            : errorMessage(error),
          operation.id,
        )
        const recoveryError = this.recoveryErrors.get(operation.id)
        if (recoveryError !== undefined && operation.failure !== undefined) delete operation.failure.action
        this.update(operation, 'failed', `${errorMessage(error)}${recoveryError === undefined ? '' : `；${recoveryError}`}`)
      }
    } finally {
      clearTimeout(this.deadlineTimers.get(operation.id))
      this.deadlineTimers.delete(operation.id)
      this.deadlines.delete(operation.id)
      this.expired.delete(operation.id)
      this.profileMutations.delete(operation.id)
      this.recoveryErrors.delete(operation.id)
      this.desktopManagedAttempts.delete(operation.id)
      this.desktopRecoveryBaselines.delete(operation.id)
      this.abortControllers.delete(operation.id)
      if (this.disposed || operation.phase === 'waiting') return
      const timer = setTimeout(() => {
        this.operationCleanupTimers.delete(operation.id)
        this.operations.delete(operation.id)
        this.pendingBuildKeys.delete(operation.id)
      }, 30 * 60 * 1000)
      timer.unref?.()
      this.operationCleanupTimers.set(operation.id, timer)
    }
  }

  private async run(args: readonly string[], operation?: Operation): Promise<void> {
    if (this.management !== undefined) {
      this.checkDeadline(operation)
      const pending = this.options.runner(this.options.profile, args, {
        signal: operation === undefined ? undefined : this.abortControllers.get(operation.id)?.signal,
        timeoutMs: this.remainingTime(operation),
      })
      this.acceptManagement(await (args[0] === 'remove' ? this.awaitLifecycle(pending, operation) : pending), operation)
      return
    }
    this.checkDeadline(operation)
    const controller = operation === undefined ? undefined : this.abortControllers.get(operation.id)
    if (controller?.signal.aborted === true) throw new Error('操作已取消')
    const ensurePnpm = this.options.runner.ensurePnpm
    if (ensurePnpm !== undefined) await ensurePnpm({ signal: controller?.signal, timeoutMs: this.remainingTime(operation) })
    const effectiveArgs = pluginArgsFor(this.options.profileDir, args)
    let attempt = 0
    try {
      await runPnpmWithRecovery(effectiveArgs, {
        profileDir: this.options.profileDir,
        attempt: async (attemptArgs, attemptOptions) => {
          this.checkDeadline(operation)
          const tracker = operation === undefined ? undefined : new PnpmProgressTracker()
          const commandArgs = tracker === undefined || attemptArgs.some(arg => arg.startsWith('--reporter')) ? attemptArgs : [...attemptArgs, '--reporter=ndjson']
          this.startCommand(operation, attemptArgs, ++attempt)
          const result = await this.options.runner(this.options.profile, commandArgs, {
            signal: controller?.signal,
            timeoutMs: Math.min(10 * 60 * 1000, this.remainingTime(operation) ?? 10 * 60 * 1000),
            env: { pnpm_config_fetch_timeout: String(10 * 60 * 1000), ...attemptOptions?.env },
            onStdout: chunk => tracker?.push(chunk, operation!),
            onStderr: chunk => tracker?.push(chunk, operation!),
          })
          if (operation !== undefined) logEvent('info', 'command-finished', `attempt=${attempt} ${failureDiagnostic(result)}`, operation.id)
          return result
        },
        onRetry: failure => {
          if (operation !== undefined) this.update(operation, operation.phase, recoveryMessage(failure))
        },
      })
    } catch (error) {
      if (controller === undefined || controller.signal.aborted === false) {
        await cleanOrphanedStore(this.options.runner, this.options.profile, operation?.id, { signal: controller?.signal, timeoutMs: Math.min(5000, this.remainingTime(operation) ?? 5000) })
      }
      throw error
    }
  }

  private remainingTime(operation?: Operation): number | undefined {
    const deadline = operation === undefined ? undefined : this.deadlines.get(operation.id)
    return deadline === undefined ? undefined : Math.max(0, deadline - Date.now())
  }

  private checkDeadline(operation?: Operation): void {
    if (operation !== undefined && this.remainingTime(operation) === 0) {
      this.expired.add(operation.id)
      this.abortControllers.get(operation.id)?.abort()
      throw new Error('安装已达到总时限')
    }
    if (operation !== undefined && this.abortControllers.get(operation.id)?.signal.aborted === true) throw new Error('操作已取消')
  }

  private startCommand(operation: Operation | undefined, args: readonly string[], attempt: number, tracksMutation = true): void {
    if (operation === undefined) return
    const directoryIndex = args.indexOf('--dir')
    const temporary = directoryIndex >= 0 && args[directoryIndex + 1] !== this.options.profileDir
    const verb = args.find(arg => arg === 'add' || arg === 'install' || arg === 'remove')
    if (tracksMutation && !temporary && verb !== undefined) this.profileMutations.set(operation.id, (this.profileMutations.get(operation.id) ?? 0) + 1)
    operation.step = temporary ? '下载并检查安装包' : verb === 'remove' ? '移除插件依赖' : verb === 'install' ? '同步 profile 依赖' : '安装到 profile'
    operation.attempt = attempt
    operation.stepStartedAt = new Date().toISOString()
    delete operation.lastOutputAt
    delete operation.pnpmStage
    delete operation.downloadedBytes
    delete operation.totalBytes
    delete operation.bytesPerSecond
    logEvent('info', 'command-started', `${operation.step} attempt=${attempt}`, operation.id)
  }

  /** Restore metadata first, then reconcile dependencies once within a separate budget. */
  private async recoverProfile(skin: SkinEntry, operation: Operation, snapshot: ProfileInstallSnapshot, mutationsBefore: number): Promise<void> {
    if (this.disposed || this.waitingReason !== undefined) return
    if (this.management !== undefined) {
      restoreFile(marketStateFile(this.options.profileDir), snapshot.marketState)
      if (snapshot.artifact.spec !== null && !compareInstalledArtifact(this.options.profileDir, snapshot.artifact).ok) {
        this.recoveryErrors.set(operation.id, '官方管理操作后构件与原有版本不一致，请在官方插件页核对实际状态')
      }
      return
    }
    clearTimeout(this.deadlineTimers.get(operation.id))
    if (this.desktopManagedAttempts.has(operation.id)) {
      // The host owns failed managed installs, including refusal before start.
      // Only undo market work performed after a successful host transaction.
      const baseline = this.desktopRecoveryBaselines.get(operation.id)
      if (baseline === undefined) return
      snapshot = baseline.snapshot
      mutationsBefore = baseline.mutationsBefore
    }
    const restore = (): boolean => {
      try {
        restoreProfileInstallFiles(this.options.profileDir, skin.package, skin.install.version, snapshot)
        return true
      } catch (error) {
        this.recoveryErrors.set(operation.id, '原有配置恢复未完成；请复制日志并修复 profile 后再操作')
        logEvent('error', 'recovery-configuration', errorMessage(error), operation.id)
        return false
      }
    }
    if (!restore()) return
    if ((this.profileMutations.get(operation.id) ?? 0) <= mutationsBefore) return
    this.update(operation, 'installing', '安装未完成，正在恢复原有依赖')
    operation.step = '恢复原有 profile 依赖'
    operation.attempt = 1
    operation.stepStartedAt = new Date().toISOString()
    delete operation.lastOutputAt
    delete operation.pnpmStage
    delete operation.bytesPerSecond
    delete operation.totalBytes
    delete operation.downloadedBytes
    const timeoutMs = this.options.recoveryTimeoutMs ?? RECOVERY_TIMEOUT_MS
    const tracker = new PnpmProgressTracker()
    logEvent('info', 'recovery-started', 'restoring previous dependencies (one attempt)', operation.id)
    try {
      const options: CommandOptions = {
        timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        onStdout: chunk => tracker.push(chunk, operation),
        onStderr: chunk => tracker.push(chunk, operation),
      }
      const result = await this.options.runner(this.options.profile, ['install', '--prefer-offline', '--reporter=ndjson'], options)
      if (snapshot.artifact.spec !== null && !compareInstalledArtifact(this.options.profileDir, snapshot.artifact).ok) throw new Error('恢复后原有包的版本或声明入口未还原')
      logEvent('info', 'recovery-finished', failureDiagnostic(result), operation.id)
      if (result.exitCode !== 0 || result.timedOut || result.aborted) throw new Error('recovery did not complete')
    } catch (error) {
      this.recoveryErrors.set(operation.id, '原有配置已恢复，但依赖恢复未完成；请复制日志后修复 profile 依赖')
      logEvent('error', 'recovery-dependencies', errorMessage(error), operation.id)
    } finally {
      // pnpm may rewrite the lockfile even during a failed recovery.
      restore()
    }
  }

  private async prepareProfile(skin: SkinEntry, operation: Operation, prepare: () => Promise<void>): Promise<void> {
    const snapshot = snapshotInstallFiles(this.options.profileDir, skin.package, skin.install.version)
    const mutationsBefore = this.profileMutations.get(operation.id) ?? 0
    try {
      await prepare()
    } catch (error) {
      await this.recoverProfile(skin, operation, snapshot, mutationsBefore)
      throw error
    }
  }

  private assertNpmMigration(skin: SkinEntry): { target: string; currentSource: string } {
    if (this.hostKind === 'desktop') throw new Error('Desktop 暂不支持换用 npm')
    const migration = npmSourceMigration(this.options.profileDir, skin)
    if (migration === undefined) throw new Error('当前安装与已核验的 npm 来源不对应，无法换用 npm；请刷新目录并先更新 GitHub 版本')
    return migration
  }

  private async installPackage(skin: SkinEntry, operation: Operation, state: PersistedMarketState, target?: string, prefetched?: PrefetchedPackage): Promise<void> {
    if (this.hostKind === 'desktop') {
      this.desktopManagedAttempts.add(operation.id)
      const capability = skin.install.desktop
      if (capability?.mode !== 'managed') throw new Error(desktopInstallError(capability))
      if (capability.packageName !== skin.package || capability.packageVersion !== skin.install.version) {
        throw new Error('Desktop 安装元数据与皮肤固定版本不一致，请等待市场重新抓取')
      }
      const installPlugin = this.options.runner.installPlugin
      if (installPlugin === undefined) throw new Error('当前 Desktop 未提供受支持的插件安装服务')
      this.update(operation, 'installing')
      const controller = this.abortControllers.get(operation.id)
      const tracker = new PnpmProgressTracker()
      const request: PluginInstallRequest = {
        packageName: capability.packageName,
        packageVersion: capability.packageVersion,
        receiptId: randomUUID(),
        pnpmOptions: ['--prefer-offline', '--reporter=ndjson'],
        approvedBuilds: this.pendingBuildKeys.get(operation.id),
      }
      if (this.management !== undefined) {
        operation.cancelable = this.management.capabilities().cancel.available
        const result = await installPlugin(this.options.profile, request, {
          signal: controller?.signal,
          timeoutMs: this.remainingTime(operation),
          onStdout: chunk => tracker.push(chunk, operation),
          onStderr: chunk => tracker.push(chunk, operation),
          onManagementState: progress => {
            if (progress.phase === 'applying') {
              this.update(operation, 'validating', '下载已完成，正在由宿主应用插件')
            } else if (progress.phase === 'installing') operation.cancelable = this.management?.capabilities().cancel.available === true
          },
        })
        this.acceptManagement(result, operation)
        if (result.management?.version !== undefined && result.management.version !== capability.packageVersion) throw new Error('官方宿主安装的版本与已核验目标不一致')
        const artifact = validateDesktopArtifact(this.options.profileDir, skin)
        if (!artifact.ok) throw new Error(artifact.reason ?? '官方宿主安装构件未通过核验')
        this.assertLegacyOfficialPeers(packageManifest(this.options.profileDir, skin.package))
        if (this.management.installRequiresRestart) operation.restartRequired = true
        return
      }
      await runPnpmWithRecovery(request.pnpmOptions ?? [], {
        attempt: (pnpmOptions) => {
          this.checkDeadline(operation)
          this.startCommand(operation, ['add'], (operation.attempt ?? 0) + 1, false)
          return installPlugin(this.options.profile, { ...request, pnpmOptions }, {
          signal: controller?.signal,
          timeoutMs: Math.min(10 * 60 * 1000, this.remainingTime(operation) ?? 10 * 60 * 1000),
          onStdout: chunk => tracker.push(chunk, operation),
          onStderr: chunk => tracker.push(chunk, operation),
          })
        },
        onRetry: failure => this.update(operation, operation.phase, recoveryMessage(failure)),
      })
      this.desktopRecoveryBaselines.set(operation.id, {
        snapshot: snapshotInstallFiles(this.options.profileDir, skin.package, skin.install.version),
        mutationsBefore: this.profileMutations.get(operation.id) ?? 0,
      })
      return
    }

    const beforeRows = installedLoaderIdentities(this.options.profileDir)
    const resolved = prefetched ?? await this.prefetch(skin, operation, target)
    if (operation.kind === 'migrate' && this.assertNpmMigration(skin).target !== resolved.target) {
      throw new Error('npm 换源目标在下载期间发生变化，请刷新后重试')
    }
    assertNoLoaderConflicts(this.options.profileDir, skin, resolved.loaderRows)
    this.assertRuntimeLoaderConflicts(skin, resolved.loaderRows)
    this.update(operation, 'installing')
    const buildApprovalKey = isNpmInstallTarget(skin, resolved.target) ? undefined : buildApprovalKeyForTarget(skin, resolved.target) ?? effectiveBuildApprovalKey(skin)
    if (buildApprovalKey !== undefined) ensureBuildAllowed(this.options.profileDir, buildApprovalKey)
    // A source migration replaces this exact skin release only. Companion
    // upgrades remain part of the separate ordinary Update operation.
    if (operation.kind !== 'migrate') await this.installCompanions(skin, operation, state)
    await this.run(['add', resolved.target, '--prefer-offline', ...(isNpmInstallTarget(skin, resolved.target) ? ['--save-exact'] : [])], operation)
    const liveValidation = validateInstalledSkin(this.options.profileDir, skin)
    if (!liveValidation.ok) throw new Error(liveValidation.reason)
    this.claimManagedLoaders(state, skin, resolved.loaderRows, beforeRows)
  }

  private async installCompanions(skin: SkinEntry, operation: Operation, state: PersistedMarketState): Promise<void> {
    if (this.management !== undefined) return
    const enabled = enabledSkinIds(state)
    for (const companion of skin.install.companions ?? []) {
      const existingSpec = readDependencies(this.options.profileDir)[companion.package]
      const linked = state.managedCompanions?.[companion.package]
      if (existingSpec === undefined || (linked?.installedByMarket === true && companionNeedsInstall(this.options.profileDir, companion))) {
        await this.run(['add', companion.target, '--prefer-offline'], operation)
        // Same identity guard as the main skin: exit 0 + truncated `&path:` can
        // materialize the monorepo root under a different dep key. Refuse before
        // claiming market ownership / registration.
        const companionValidation = validateInstalledSkin(this.options.profileDir, companionAsSkin(skin, companion))
        if (!companionValidation.ok) throw new Error(companionValidation.reason)
        this.claimManagedCompanion(state, companion.package, skin.id, true)
      } else if (linked !== undefined) {
        // An existing ownership receipt grants activation linkage, while its
        // installedByMarket bit continues to govern delete/update rights.
        this.claimManagedCompanion(state, companion.package, skin.id, linked.installedByMarket)
      } else {
        // A package that predates this market install belongs to the user.
        // Do not acquire enable/disable or delete rights over it.
        continue
      }
      await this.registerSkin(
        companionAsSkin(skin, companion),
        !this.companionOwnersEnabled(companion.package, state, enabled),
      )
    }
  }

  private claimManagedCompanion(state: PersistedMarketState, packageName: string, ownerSkinId: string, installedByMarket: boolean): void {
    const current = state.managedCompanions?.[packageName]
    if (current === undefined) {
      state.managedCompanions = {
        ...state.managedCompanions,
        [packageName]: { ownerSkinIds: [ownerSkinId], installedByMarket },
      }
      return
    }
    if (!current.ownerSkinIds.includes(ownerSkinId)) current.ownerSkinIds.push(ownerSkinId)
    if (installedByMarket) current.installedByMarket = true
  }

  private companionOwnersEnabled(packageName: string, state: PersistedMarketState, enabled: Set<string>): boolean {
    return state.managedCompanions?.[packageName]?.ownerSkinIds.some(ownerSkinId => enabled.has(ownerSkinId)) ?? false
  }

  private async syncInstalledCompanions(state: PersistedMarketState, live: boolean): Promise<void> {
    const enabled = enabledSkinIds(state)
    const seen = new Set<string>()
    const dependencies = readDependencies(this.options.profileDir)
    for (const item of this.catalog) {
      for (const companion of item.install.companions ?? []) {
        if (seen.has(companion.package) || dependencies[companion.package] === undefined || state.managedCompanions?.[companion.package] === undefined) continue
        seen.add(companion.package)
        const entry = companionAsSkin(item, companion)
        const disabled = !this.companionOwnersEnabled(companion.package, state, enabled)
        await this.registerSkin( entry, disabled)
        if (live) await this.setEntryDisabled(entry, disabled)
      }
    }
  }

  private companionStillNeeded(packageName: string, exceptSkinId: string, state: PersistedMarketState): boolean {
    return state.managedCompanions?.[packageName]?.ownerSkinIds.some(ownerSkinId => ownerSkinId !== exceptSkinId) ?? false
  }

  private async uninstallUnusedCompanions(skin: SkinEntry, operation: Operation, state: PersistedMarketState): Promise<void> {
    for (const companion of skin.install.companions ?? []) {
      const managed = state.managedCompanions?.[companion.package]
      if (managed === undefined) continue
      if (this.companionStillNeeded(companion.package, skin.id, state)) {
        managed.ownerSkinIds = managed.ownerSkinIds.filter(ownerSkinId => ownerSkinId !== skin.id)
        continue
      }
      if (managed.installedByMarket && readDependencies(this.options.profileDir)[companion.package] !== undefined) {
        await this.run(['remove', companion.package], operation)
        if (this.management === undefined) removeSkinRegistration(this.options.profileDir, companionAsSkin(skin, companion))
      } else if (readDependencies(this.options.profileDir)[companion.package] !== undefined) {
        // Activation-linked but user-owned companions survive the last owner
        // and return to their independent enabled state.
        const entry = companionAsSkin(skin, companion)
        await this.registerSkin( entry, false)
        await this.setEntryDisabled(entry, false)
      }
      delete state.managedCompanions?.[companion.package]
    }
    if (state.managedCompanions !== undefined && Object.keys(state.managedCompanions).length === 0) delete state.managedCompanions
  }

  private assertRuntimeLoaderConflicts(skin: SkinEntry, loaderRows: readonly LoaderIdentity[]): void {
    const incoming = loaderRows.length > 0
      ? loaderRows
      : [{ id: skin.rowId, name: skin.package, packageName: skin.package }]
    const conflicts: InstallConflict[] = []
    for (const entry of this.host.loader.entries()) {
      const id = entry.options.id
      const name = entry.options.name
      const existing = { id, name, packageName: name }
      for (const incomingRow of incoming) {
        const identifiers = sharedLoaderIdentifiers(incomingRow, existing)
        if (identifiers.length === 0) continue
        const currentSkinEntry = incomingRow.packageName === skin.package
          && incomingRow.id === skin.rowId
          && id === skin.rowId
          && (name === undefined || name === skin.rowId || name === skin.package)
        if (incomingRow.packageName === existing.packageName || currentSkinEntry) continue
        conflicts.push({
          kind: 'loader' as const,
          incoming: incomingRow.packageName ?? incomingRow.name ?? skin.package,
          existing: name ?? id ?? 'unknown loader',
          identifiers,
        })
      }
    }
    const unique = conflicts.filter((conflict, index) => conflicts.findIndex(item => JSON.stringify(item) === JSON.stringify(conflict)) === index)
    if (unique.length > 0) throw new InstallConflictError(unique)
  }

  private async prefetch(skin: SkinEntry, operation: Operation, selectedTarget?: string): Promise<PrefetchedPackage> {
    // Resolve and download into an unwatched temporary project first. pnpm's
    // content-addressed store makes the real profile add reuse these files.
    // This prevents a large GitHub download from modifying the live profile
    // early and causing DSH Web to reload before the operation can finish.
    let target = selectedTarget ?? preferredInstallTarget(skin)
    if (isNpmInstallTarget(skin, target)) {
      const sourceError = reviewedNpmSourceError(skin)
      if (sourceError !== null) throw new Error(sourceError)
    }
    let directory = mkdtempSync(join(tmpdir(), 'dsh-skin-market-download-'))
    try {
      this.preparePrefetchDirectory(directory, this.prefetchBuildApprovals(skin, operation, target))
      await this.run(['add', target, '--dir', directory, '--ignore-scripts', '--config.auto-install-peers=false', ...(isNpmInstallTarget(skin, target) ? ['--save-exact'] : [])], operation)
      const redirected = discoverMonorepoTarget(directory, skin, target)
      if (redirected !== null) {
        target = redirected
        removePrefetchDirectory(directory)
        directory = mkdtempSync(join(tmpdir(), 'dsh-skin-market-download-'))
        this.preparePrefetchDirectory(directory, this.prefetchBuildApprovals(skin, operation, target))
        await this.run(['add', target, '--dir', directory, '--ignore-scripts', '--config.auto-install-peers=false'], operation)
      }
      // Exit 0 alone is not success: a truncated `&path:` target installs the
      // repo root under a different dependency key. Refuse before live profile add.
      const validation = validateInstalledSkin(directory, skin)
      if (!validation.ok) throw new Error(validation.reason)
      if (isNpmInstallTarget(skin, target)) {
        if (readDependencies(directory)[skin.package] !== skin.install.npm?.version) {
          throw new Error('下载的 npm 依赖未记录目录固定版本，已停止安装')
        }
        if (validation.version !== skin.install.version) throw new Error('下载的 npm 包版本与目录固定版本不一致')
      }
      const packageDirectory = join(directory, 'node_modules', ...skin.package.split('/'))
      const packageRows = packageLoaderOwnershipAt(packageDirectory, skin.package)
      if (packageRows.hasBundle) {
        const primaryRows = packageRows.rows.filter(row => row.name === skin.package)
        if (primaryRows.length === 0) {
          throw new LoaderMetadataError(`${skin.package} 的 bundle patch 没有 name=${skin.package} 的主 loader；目录 rowId=${skin.rowId}`)
        }
        if (primaryRows.length > 1) {
          throw new LoaderMetadataError(`${skin.package} 的 bundle patch 声明了多个主 loader：${primaryRows.map(row => row.id ?? '(缺少 id)').join('、')}`)
        }
        if (primaryRows[0].id !== skin.rowId) {
          throw new LoaderMetadataError(`${skin.package} 的目录 rowId=${skin.rowId}，实际主 loader id=${primaryRows[0].id ?? '(缺少 id)'}`)
        }
      }
      return {
        target,
        packageRows: packageRows.rows,
        hasBundle: packageRows.hasBundle,
        loaderRows: installedLoaderIdentities(directory),
      }
    } finally {
      removePrefetchDirectory(directory)
    }
  }

  private async install(operation: Operation): Promise<void> {
    const skin = this.skin(operation.skinId)
    this.applyPendingBuildApprovals(operation)
    let prefetched: PrefetchedPackage | undefined
    if (this.hostKind !== 'desktop' && readDependencies(this.options.profileDir)[skin.package] === undefined) {
      prefetched = await this.withDownloadSlot(operation, async () => {
        this.update(operation, 'resolving')
        this.update(operation, 'downloading')
        return await this.prefetch(skin, operation)
      })
    }
    await this.withProfileLock(operation, () => this.installIntoProfile(operation, skin, prefetched))
  }

  private async installIntoProfile(operation: Operation, skin: SkinEntry, prefetched?: PrefetchedPackage): Promise<void> {
    if (this.hostKind !== 'desktop') {
      await this.prepareProfile(skin, operation, () => this.syncPnpmMetadata(operation, '正在修复 profile 的 pnpm 锁文件'))
    }
    const existingSpec = readDependencies(this.options.profileDir)[skin.package]
    if (existingSpec !== undefined) {
      let validation = validateInstalledSkin(this.options.profileDir, skin)
      if (!validation.ok && validation.repairable === true) {
        await this.prepareProfile(skin, operation, async () => {
          if (this.hostKind === 'desktop') await this.installPackage(skin, operation, readMarketState(this.options.profileDir))
          else await this.repairMaterializedPackage(skin, operation)
          validation = validateInstalledSkin(this.options.profileDir, skin)
          if (!validation.ok) throw new Error(validation.reason)
        })
      }
      if (!validation.ok) throw new Error(validation.reason)
      if (!reviewedInstalledSpecMatches(this.options.profileDir, skin, existingSpec)) {
        throw new Error(`installed package ${skin.package} does not match the reviewed source/version; use Update to replace it with ${skin.install.target}`)
      }
      const snapshot = snapshotInstallFiles(this.options.profileDir, skin.package, skin.install.version)
      const mutationsBefore = this.profileMutations.get(operation.id) ?? 0
      const state = readMarketState(this.options.profileDir)
      try {
        await this.installCompanions(skin, operation, state)
        await this.applyCompatibility(skin, operation)
        validation = validateInstalledSkin(this.options.profileDir, skin)
        if (!validation.ok) throw new Error(validation.reason)
        await this.registerSkin( skin, !enabledSkinIds(state).has(skin.id))
        this.reconcileDisabledSkinIds(state)
        this.recordRestart(state, skin.id, operation.restartRequired === true)
        writeMarketState(this.options.profileDir, state)
        operation.message = operation.restartRequired ? '安装构件已修复；此版本官方 Desktop 需要完全退出并重开应用后再使用' : 'skin was already installed; market state reconciled'
        return
      } catch (error) {
        await this.recoverProfile(skin, operation, snapshot, mutationsBefore)
        throw error
      }
    }
    const snapshot = snapshotInstallFiles(this.options.profileDir, skin.package, skin.install.version)
    const mutationsBefore = this.profileMutations.get(operation.id) ?? 0
    const detachedPatchFiles = this.hostKind === 'desktop' ? [] : detachCompatibilityPatches(this.options.profileDir, skin.package)
    if (prefetched === undefined) this.update(operation, 'resolving')
    try {
      if (this.hostKind !== 'desktop') await this.syncPnpmMetadata(operation, '正在清理旧的兼容适配')
      if (prefetched === undefined) this.update(operation, 'downloading')
      const state = readMarketState(this.options.profileDir)
      await this.installPackage(skin, operation, state, undefined, prefetched)
      await this.applyCompatibility(skin, operation)
      this.update(operation, 'validating')
      const validation = validateInstalledSkin(this.options.profileDir, skin)
      if (!validation.ok) throw new Error(validation.reason)
      if (!reviewedInstalledSpecMatches(this.options.profileDir, skin, readDependencies(this.options.profileDir)[skin.package])) {
        throw new Error(`installed package ${skin.package} does not match the reviewed source/version ${skin.install.target}`)
      }
      assertNoLoaderConflicts(this.options.profileDir, skin)
      await this.registerSkin( skin)
      state.activeSkinId = state.activeSkinId === skin.id ? null : state.activeSkinId
      if (!state.disabledSkinIds.includes(skin.id)) state.disabledSkinIds.push(skin.id)
      recordActivity(state, skin.id, 'installedAt', operation.startedAt)
      await this.syncManagedLoaders(state, false)
      this.recordRestart(state, skin.id, operation.restartRequired === true)
      writeMarketState(this.options.profileDir, state)
      cleanupCompatibilityPatchFiles(detachedPatchFiles.filter(file => file !== compatibilityPatchFile(this.options.profileDir, skin.package, skin.install.version)))
      operation.message = operation.restartRequired ? '安装构件已验证；此版本官方 Desktop 需要完全退出并重开应用后再使用' : 'installed; choose Use to activate'
    } catch (error) {
      await this.recoverProfile(skin, operation, snapshot, mutationsBefore)
      throw error
    }
  }

  private selectionSnapshot(): { manifest: FileSnapshot; patch: FileSnapshot } {
    return { manifest: snapshotFile(join(this.options.profileDir, 'package.json')), patch: snapshotFile(profilePatchFile(this.options.profileDir)) }
  }

  private async rollbackSelection(previous: PersistedMarketState, snapshot: { manifest: FileSnapshot; patch: FileSnapshot }): Promise<void> {
    if (this.disposed || this.waitingReason !== undefined) return
    if (this.management === undefined) {
      restoreManifest(this.options.profileDir, snapshot.manifest)
      restoreFile(profilePatchFile(this.options.profileDir), snapshot.patch)
    }
    writeMarketState(this.options.profileDir, previous)
    await this.replay()
  }

  private async activate(operation: Operation): Promise<void> {
    await this.withProfileLock(operation, () => this.activateLocked(operation))
  }

  private async activateLocked(operation: Operation): Promise<void> {
    const skin = this.skin(operation.skinId)
    if (readDependencies(this.options.profileDir)[skin.package] === undefined) throw new Error('install the skin before using it')
    this.update(operation, 'activating')
    const previous = readMarketState(this.options.profileDir)
    const selection = this.selectionSnapshot()
    const next: PersistedMarketState = { ...previous, version: 1, activeSkinId: skin.id, pinnedSkinIds: pinnedSkinIds(previous) }
    recordActivity(next, skin.id, 'usedAt', operation.startedAt)
    this.reconcileDisabledSkinIds(next)
    const requiresRestart = this.requiresRestartForTransition(previous, next)
    const enabled = enabledSkinIds(next)
    try {
      for (const item of this.catalog) {
        const installed = readDependencies(this.options.profileDir)[item.package] !== undefined
        if (installed && enabled.has(item.id)) {
          await this.registerSkin( item, false)
        }
        if (installed && !enabled.has(item.id)) await this.registerSkin( item, true)
      }
      await this.syncInstalledCompanions(next, !requiresRestart)
      let active: { found: boolean; live: boolean } | undefined
      if (!requiresRestart) {
        for (const item of this.catalog) {
          if (!enabled.has(item.id)) await this.setEntryDisabled(item, true)
        }
        for (const item of this.catalog) {
          if (enabled.has(item.id) && readDependencies(this.options.profileDir)[item.package] !== undefined) {
            await this.setEntryDisabled(item, false)
          }
        }
        active = await this.setEntryDisabled(skin, false)
      }
      await this.syncManagedLoaders(next, !requiresRestart)
      this.recordRestart(next, skin.id, requiresRestart || operation.restartRequired === true)
      writeMarketState(this.options.profileDir, next)
      if (requiresRestart || operation.restartRequired === true) {
        operation.message = 'activation saved; restart DSH to load this skin'
      } else {
        operation.message = active?.found && active.live ? 'skin is active' : 'activation saved; restart DSH to load this skin'
      }
    } catch (error) {
      await this.rollbackSelection(previous, selection)
      throw error
    }
  }

  private async deactivate(operation: Operation): Promise<void> {
    await this.withProfileLock(operation, () => this.deactivateLocked(operation))
  }

  private async deactivateLocked(operation: Operation): Promise<void> {
    const skin = this.skin(operation.skinId)
    this.update(operation, 'activating')
    const previous = readMarketState(this.options.profileDir)
    const selection = this.selectionSnapshot()
    const state = { ...previous, pinnedSkinIds: pinnedSkinIds(previous) }
    state.activeSkinId = state.activeSkinId === skin.id ? null : state.activeSkinId
    state.pinnedSkinIds = state.pinnedSkinIds.filter(id => id !== skin.id)
    this.reconcileDisabledSkinIds(state)
    const requiresRestart = this.requiresRestartForTransition(previous, state)
    try {
      await this.registerSkin( skin, true)
      if (!requiresRestart) await this.setEntryDisabled(skin, true)
      await this.syncInstalledCompanions(state, !requiresRestart)
      await this.syncManagedLoaders(state, !requiresRestart)
      this.recordRestart(state, skin.id, requiresRestart || operation.restartRequired === true)
      writeMarketState(this.options.profileDir, state)
      operation.message = requiresRestart || operation.restartRequired === true
        ? 'skin disabled; restart DSH to apply the change'
        : enabledSkinIds(state).size === 0 ? 'DSH default appearance restored; package kept installed' : 'skin disabled; other enabled skins were kept active'
    } catch (error) {
      await this.rollbackSelection(previous, selection)
      throw error
    }
  }

  private async pin(operation: Operation): Promise<void> {
    await this.withProfileLock(operation, () => this.pinLocked(operation))
  }

  private async pinLocked(operation: Operation): Promise<void> {
    const skin = this.skin(operation.skinId)
    const previous = readMarketState(this.options.profileDir)
    const selection = this.selectionSnapshot()
    if (readDependencies(this.options.profileDir)[skin.package] === undefined) throw new Error('install the skin before pinning it')
    this.update(operation, 'activating')
    const next: PersistedMarketState = { ...previous, pinnedSkinIds: [...new Set([...pinnedSkinIds(previous), skin.id])] }
    this.reconcileDisabledSkinIds(next)
    const requiresRestart = this.requiresRestartForTransition(previous, next)
    try {
      await this.registerSkin( skin, false)
      await this.syncInstalledCompanions(next, !requiresRestart)
      await this.syncManagedLoaders(next, !requiresRestart)
      this.recordRestart(next, skin.id, requiresRestart || operation.restartRequired === true)
      writeMarketState(this.options.profileDir, next)
      if (requiresRestart || operation.restartRequired === true) {
        operation.message = 'pin saved; restart DSH to load this skin'
      } else {
        const active = await this.setEntryDisabled(skin, false)
        operation.message = active.found && active.live ? 'skin is pinned and active' : 'pin saved; restart DSH to load this skin'
      }
    } catch (error) {
      await this.rollbackSelection(previous, selection)
      throw error
    }
  }

  private async unpin(operation: Operation): Promise<void> {
    await this.withProfileLock(operation, () => this.unpinLocked(operation))
  }

  private async unpinLocked(operation: Operation): Promise<void> {
    const skin = this.skin(operation.skinId)
    const previous = readMarketState(this.options.profileDir)
    const selection = this.selectionSnapshot()
    if (!pinnedSkinIds(previous).includes(skin.id)) throw new Error('skin is not pinned')
    this.update(operation, 'activating')
    const next: PersistedMarketState = { ...previous, pinnedSkinIds: pinnedSkinIds(previous).filter(id => id !== skin.id) }
    this.reconcileDisabledSkinIds(next)
    const requiresRestart = this.requiresRestartForTransition(previous, next)
    try {
      if (next.activeSkinId !== skin.id) {
        await this.registerSkin( skin, true)
        if (!requiresRestart) await this.setEntryDisabled(skin, true)
      }
      await this.syncInstalledCompanions(next, !requiresRestart)
      await this.syncManagedLoaders(next, !requiresRestart)
      this.recordRestart(next, skin.id, requiresRestart || operation.restartRequired === true)
      writeMarketState(this.options.profileDir, next)
      operation.message = requiresRestart || operation.restartRequired === true
        ? 'skin is no longer pinned; restart DSH to apply the change'
        : next.activeSkinId === skin.id ? 'skin is no longer pinned and remains the current skin' : 'skin is no longer pinned and was disabled'
    } catch (error) {
      await this.rollbackSelection(previous, selection)
      throw error
    }
  }

  private async updateSkin(operation: Operation): Promise<void> {
    const skin = this.skin(operation.skinId)
    const target = this.hostKind === 'desktop' ? undefined : operation.kind === 'migrate'
      ? this.assertNpmMigration(skin).target
      : updateInstallTarget(skin, readDependencies(this.options.profileDir)[skin.package])
    this.applyPendingBuildApprovals(operation)
    let prefetched: PrefetchedPackage | undefined
    if (this.hostKind !== 'desktop') {
      prefetched = await this.withDownloadSlot(operation, async () => {
        this.update(operation, 'resolving')
        this.update(operation, 'downloading')
        return await this.prefetch(skin, operation, target)
      })
      if (operation.kind === 'migrate' && this.assertNpmMigration(skin).target !== prefetched.target) {
        throw new Error('npm 换源目标在下载期间发生变化，请刷新后重试')
      }
    }
    await this.withProfileLock(operation, async () => {
      if (this.hostKind !== 'desktop') {
        await this.prepareProfile(skin, operation, () => this.syncPnpmMetadata(operation, '正在修复 profile 的 pnpm 锁文件'))
      }
      const previousState = readMarketState(this.options.profileDir)
      const wasActive = enabledSkinIds(previousState).has(skin.id)
      const snapshot = snapshotInstallFiles(this.options.profileDir, skin.package, skin.install.version)
      const mutationsBefore = this.profileMutations.get(operation.id) ?? 0
      const detachedPatchFiles = this.hostKind === 'desktop' ? [] : detachCompatibilityPatches(this.options.profileDir, skin.package)
      if (prefetched === undefined) this.update(operation, 'resolving')
      try {
        if (this.hostKind !== 'desktop') await this.syncPnpmMetadata(operation, '正在清理旧的兼容适配')
        if (prefetched === undefined) this.update(operation, 'downloading')
        await this.installPackage(skin, operation, previousState, target, prefetched)
        await this.applyCompatibility(skin, operation)
        this.update(operation, 'validating')
        const validation = validateInstalledSkin(this.options.profileDir, skin)
        if (!validation.ok) throw new Error(validation.reason)
        if (validation.version !== skin.install.version || !reviewedInstalledSpecMatches(this.options.profileDir, skin, readDependencies(this.options.profileDir)[skin.package])) {
          throw new Error(`installed package did not change to the reviewed source/version ${skin.install.target}`)
        }
        if (operation.kind === 'migrate' && readDependencies(this.options.profileDir)[skin.package] !== skin.install.npm?.version) {
          throw new Error('npm 换源后未保存精确版本，已停止并恢复原有安装')
        }
        assertNoLoaderConflicts(this.options.profileDir, skin)
        await this.registerSkin( skin, !wasActive)
        await this.syncInstalledCompanions(previousState, false)
        await this.setEntryDisabled(skin, !wasActive)
        await this.syncManagedLoaders(previousState, false)
        const nextState = previousState
        recordActivity(nextState, skin.id, 'updatedAt', operation.startedAt)
        this.recordRestart(nextState, skin.id, operation.restartRequired === true)
        writeMarketState(this.options.profileDir, nextState)
        cleanupCompatibilityPatchFiles(detachedPatchFiles.filter(file => file !== compatibilityPatchFile(this.options.profileDir, skin.package, skin.install.version)))
        operation.message = operation.kind === 'migrate'
          ? wasActive ? '已换用 npm 并保留启用状态；重启 DSH 后生效' : '已换用 npm 并保留停用状态'
          : operation.restartRequired ? '更新已验证，原启停状态已保留；重启宿主后加载新版本' : wasActive ? 'updated and kept active' : 'updated and kept inactive'
      } catch (error) {
        await this.recoverProfile(skin, operation, snapshot, mutationsBefore)
        throw error
      }
    })
  }

  private async uninstall(operation: Operation): Promise<void> {
    await this.withProfileLock(operation, () => this.uninstallLocked(operation))
  }

  private async uninstallLocked(operation: Operation): Promise<void> {
    const skin = this.skin(operation.skinId)
    if (readDependencies(this.options.profileDir)[skin.package] === undefined) throw new Error('skin is not installed')
    const snapshot = snapshotInstallFiles(this.options.profileDir, skin.package, skin.install.version)
    const mutationsBefore = this.profileMutations.get(operation.id) ?? 0
    const loaderRowsBefore = installedLoaderIdentities(this.options.profileDir)
    let detachedPatchFiles: string[] = []
    try {
      // pnpm rejects removing a dependency while that same dependency remains
      // in patchedDependencies. Detach both workspace and lockfile metadata
      // before the remove command; the snapshot restores them on failure.
      detachedPatchFiles = this.management === undefined ? detachCompatibilityPatches(this.options.profileDir, skin.package) : []
      const state = readMarketState(this.options.profileDir)
      if (this.management === undefined && enabledSkinIds(state).has(skin.id)) await this.deactivate(operation)
      this.update(operation, 'downloading')
      await this.run(['remove', skin.package], operation)
      await this.syncPnpmMetadata(operation, '正在清理兼容适配并同步 pnpm 锁文件')
      // A legacy install may predate managed-loader receipts. After pnpm has
      // removed the package, rows that disappeared from the actual installed
      // graph are safe to disable in this process: they cannot return on the
      // next boot, while a pre-existing/shared loader still appears in the
      // remaining graph and is deliberately left alone.
      const remainingLoaderRows = installedLoaderIdentities(this.options.profileDir)
      const staleLiveRows = loaderRowsBefore.filter(row =>
        !remainingLoaderRows.some(remaining => sharedLoaderIdentifiers(row, remaining).length > 0),
      )
      if (this.management === undefined) for (const row of staleLiveRows) await this.setLoaderDisabled(row, true)
      if (this.management === undefined) removeSkinRegistration(this.options.profileDir, skin)
      const next = readMarketState(this.options.profileDir)
      await this.uninstallUnusedCompanions(skin, operation, next)
      next.disabledSkinIds = next.disabledSkinIds.filter(id => id !== skin.id)
      next.pinnedSkinIds = pinnedSkinIds(next).filter(id => id !== skin.id)
      if (next.activeSkinId === skin.id) next.activeSkinId = null
      if (next.activity !== undefined) delete next.activity[skin.id]
      this.recordRestart(next, skin.id, false, true)
      this.releaseManagedLoaders(next, skin.id)
      await this.syncManagedLoaders(next, false)
      writeMarketState(this.options.profileDir, next)
      cleanupCompatibilityPatchFiles(detachedPatchFiles)
      operation.message = 'skin uninstalled'
    } catch (error) {
      await this.recoverProfile(skin, operation, snapshot, mutationsBefore)
      throw error
    }
  }
}
