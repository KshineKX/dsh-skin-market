import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { SkinLifecycle } from '../src/lifecycle.ts'
import { officialDesktopRunner, type OfficialPluginManagerLike } from '../src/official-desktop.ts'
import { atomicWriteJson, atomicWriteText, packageDir, profilePatchFile, readDependencies, readMarketState, readProfileBundles, writeMarketState } from '../src/profile.ts'
import type { DshRuntime, LoaderEntry, Operation, SkinEntry } from '../src/types.ts'

const directories: string[] = []
const lifecycles: SkinLifecycle[] = []
const runtime: DshRuntime = { version: '0.2.1-alpha.1', source: 'injected', capabilities: [] }
afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map(lifecycle => lifecycle.dispose()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function skin(id: string, version = '1.0.0'): SkinEntry {
  const packageName = `dsh-test-${id}`
  const commit = 'a'.repeat(40)
  const repository = `https://github.com/fixture/${id}`
  const integrity = `sha512-${createHash('sha512').update(`${packageName}@${version}`).digest('base64')}`
  return {
    id, package: packageName, rowId: id, repo: repository, name: { zh: id, en: id },
    author: 'fixture', description: 'Materialized native bundle fixture', category: 'theme', tags: [],
    modes: ['light', 'dark'], screenshots: [], license: { code: 'MIT', commercialUse: true },
    featuredRank: 0, starsSnapshot: 0,
    releaseUpdatedAt: '2026-10-14', metadataUpdatedAt: '2026-10-14', starsUpdatedAt: '2026-10-14', updatedAt: '2026-10-14',
    install: {
      version, commit, target: `github:fixture/${id}#${commit}`,
      npm: { name: packageName, version, integrity, repository, gitHead: commit },
      desktop: { mode: 'managed', registry: 'npm', packageName, packageVersion: version, integrity },
    },
    compatibility: { dsh: '*', platform: ['web'] },
    review: { compatibility: 'verified', preview: 'verified', installation: 'verified' },
  }
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('lifecycle condition did not settle')
}

async function finished(operation: Operation): Promise<Operation> {
  await until(() => ['done', 'failed', 'cancelled'].includes(operation.phase))
  return operation
}

/** The fake Host owns package files and selection, just as the real manager does. */
function fixture(catalog: SkinEntry[], options: { lifecycleWaitMs?: number; hostVersion?: string; saveRange?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-native-lifecycle-'))
  directories.push(directory)
  const originalPatch = `# Preserve user formatting and overrides exactly.\n- id: ${catalog[0]!.rowId}\n  disabled: true\n- id: unrelated-user-row\n  disabled: true\n`
  atomicWriteText(profilePatchFile(directory), originalPatch)
  atomicWriteJson(join(directory, 'package.json'), { private: true, dependencies: {}, dsh: { profile: { bundles: [] } } })
  const entries = new Map<string, LoaderEntry>()
  const manifest = () => JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
    private: boolean; dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } }
  }
  const lockVersions = new Map<string, { version: string; spec: string; integrity: string }>()
  const writeLock = () => atomicWriteText(join(directory, 'pnpm-lock.yaml'), stringify({
    lockfileVersion: '9.0',
    importers: { '.': { dependencies: Object.fromEntries([...lockVersions].map(([name, source]) => [name, { specifier: source.spec, version: source.version }])) } },
    packages: Object.fromEntries([...lockVersions].map(([name, source]) => [`${name}@${source.version}`, { resolution: { integrity: source.integrity } }])),
  }))
  const select = (name: string, enabled: boolean) => {
    const value = manifest()
    value.dsh.profile.bundles = enabled ? [...new Set([...value.dsh.profile.bundles, name])] : value.dsh.profile.bundles.filter(bundle => bundle !== name)
    atomicWriteJson(join(directory, 'package.json'), value)
    const entry = entries.get(name)
    if (entry !== undefined) {
      entry.options.disabled = enabled ? null : true
      entry.fiber = enabled ? {} : undefined
    }
  }
  const materialize = (item: SkinEntry) => {
    const value = manifest()
    const spec = options.saveRange ? `^${item.install.version}` : item.install.version
    value.dependencies[item.package] = spec
    atomicWriteJson(join(directory, 'package.json'), value)
    const directoryForPackage = packageDir(directory, item.package)
    mkdirSync(join(directoryForPackage, 'lib'), { recursive: true })
    mkdirSync(join(directoryForPackage, 'client'), { recursive: true })
    atomicWriteJson(join(directoryForPackage, 'package.json'), {
      name: item.package, version: item.install.version, repository: item.repo, gitHead: item.install.commit,
      main: 'lib/index.js', exports: { '.': './lib/index.js', './client': './client/client.js' },
      dsh: { client: { platform: 'web' }, bundle: { patch: 'cordis.patch.yml' } },
    })
    atomicWriteText(join(directoryForPackage, 'lib/index.js'), `export const version = '${item.install.version}'\n`)
    atomicWriteText(join(directoryForPackage, 'client/client.js'), `export const version = '${item.install.version}'\n`)
    atomicWriteText(join(directoryForPackage, 'cordis.patch.yml'), `- insert:\n    - id: ${item.rowId}\n      name: ${JSON.stringify(item.package)}\n`)
    lockVersions.set(item.package, { version: item.install.version, spec, integrity: item.install.npm!.integrity })
    writeLock()
    const enabled = readProfileBundles(directory).includes(item.package)
    entries.set(item.package, { options: { id: item.rowId, name: item.package, disabled: !enabled }, fiber: enabled ? {} : undefined, update: vi.fn(async () => undefined) })
  }
  const applyInstall = (spec: string) => {
    const item = catalog.find(candidate => spec === `${candidate.package}@${candidate.install.version}`)
    if (item === undefined) throw new Error(`unreviewed fake Host install: ${spec}`)
    const existing = readDependencies(directory)[item.package] !== undefined
    materialize(item)
    return { application: existing ? 'restart-required' : 'applied', changed: true, stage: 'apply', target: item.package, bundle: item.package, version: item.install.version }
  }
  const applyEnable = (name: string, enabled: boolean) => {
    select(name, enabled)
    return { application: 'applied', changed: true, stage: 'enable', target: name, enabled }
  }
  const applyRemove = (name: string) => {
    select(name, false)
    const value = manifest()
    delete value.dependencies[name]
    atomicWriteJson(join(directory, 'package.json'), value)
    lockVersions.delete(name)
    writeLock()
    entries.delete(name)
    rmSync(packageDir(directory, name), { recursive: true, force: true })
    return { application: 'applied', changed: true, stage: 'remove', target: name }
  }
  const manager = {
    installBundle: vi.fn(async (spec: string, _options?: Record<string, unknown>): Promise<unknown> => applyInstall(spec)),
    removeBundle: vi.fn(async (name: string): Promise<unknown> => applyRemove(name)),
    setBundleEnabled: vi.fn(async (name: string, enabled: boolean): Promise<unknown> => applyEnable(name, enabled)),
    setPluginEnabled: vi.fn(async (name: string, enabled: boolean): Promise<unknown> => applyEnable(name, enabled)),
    cancelInstall: vi.fn(async (_requestId: string): Promise<unknown> => ({ status: 'not-running' })),
    waitForInstall: vi.fn(async (_requestId: string): Promise<unknown> => null),
    listPlugins: vi.fn(async () => []), listBundles: vi.fn(async () => []),
  } satisfies OfficialPluginManagerLike
  const injectedRuntime = { ...runtime, version: options.hostVersion ?? runtime.version }
  const runner = officialDesktopRunner(() => manager, injectedRuntime)
  const lifecycle = new SkinLifecycle({ loader: { entries: () => entries.values() } }, {
    profile: 'desktop', profileDir: directory, runner, hostKind: 'desktop', runtime: injectedRuntime,
    lifecycleWaitMs: options.lifecycleWaitMs ?? 10,
  }, catalog)
  lifecycles.push(lifecycle)
  return { directory, originalPatch, entries, manager, lifecycle, runner, materialize, select, applyInstall, applyEnable, applyRemove }
}

describe('official plugin manager lifecycle', () => {
  it('delegates install, enable and removal without rewriting user cordis patches or directly updating loaders', async () => {
    const item = skin('native-a')
    const host = fixture([item], { saveRange: true })
    expect(await finished(host.lifecycle.begin('install', item.id))).toMatchObject({ phase: 'done', application: 'applied' })
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
    expect(host.manager.installBundle).toHaveBeenCalledWith(`${item.package}@1.0.0`, expect.objectContaining({ enabled: false, requestId: expect.any(String) }))
    expect(host.manager.installBundle.mock.calls[0]![1]).not.toHaveProperty('saveExact')
    expect(readDependencies(host.directory)[item.package]).toBe('^1.0.0')
    expect(readMarketState(host.directory)).toMatchObject({ activeSkinId: null, disabledSkinIds: [item.id] })
    const nativeLoader = host.entries.get(item.package)!
    expect(await finished(host.lifecycle.begin('activate', item.id))).toMatchObject({ phase: 'done', application: 'applied' })
    expect(readProfileBundles(host.directory)).toEqual([item.package])
    expect(nativeLoader.update).not.toHaveBeenCalled()
    expect(await finished(host.lifecycle.begin('uninstall', item.id))).toMatchObject({ phase: 'done', application: 'applied' })
    expect(host.manager.removeBundle).toHaveBeenCalledExactlyOnceWith(item.package)
    expect(readDependencies(host.directory)).toEqual({})
    expect(readMarketState(host.directory)).toMatchObject({ activeSkinId: null, pinnedSkinIds: [] })
    expect(readFileSync(profilePatchFile(host.directory), 'utf8')).toBe(host.originalPatch)
    expect(nativeLoader.update).not.toHaveBeenCalled()
  })

  it('keeps primary selection independent from pinned skins and enables their union', async () => {
    const a = skin('native-a'), b = skin('native-b')
    const host = fixture([a, b])
    host.materialize(a); host.materialize(b)
    await finished(host.lifecycle.begin('activate', a.id))
    await finished(host.lifecycle.begin('pin', a.id))
    await finished(host.lifecycle.begin('activate', b.id))
    expect(readMarketState(host.directory)).toMatchObject({ activeSkinId: b.id, pinnedSkinIds: [a.id] })
    expect(readProfileBundles(host.directory).sort()).toEqual([a.package, b.package].sort())
    expect(host.lifecycle.states().find(state => state.skinId === a.id)).toMatchObject({ primary: false, pinned: true, activation: 'active' })
    await finished(host.lifecycle.begin('unpin', a.id))
    expect(readProfileBundles(host.directory)).toEqual([b.package])
    await finished(host.lifecycle.begin('pin', b.id))
    await finished(host.lifecycle.begin('unpin', b.id))
    expect(readMarketState(host.directory)).toMatchObject({ activeSkinId: b.id, pinnedSkinIds: [] })
    expect(readProfileBundles(host.directory)).toEqual([b.package])
  })

  it('preserves a native update restart requirement through later successful toggles until removal', async () => {
    const next = skin('native-a', '1.1.0')
    const host = fixture([next])
    host.materialize(skin(next.id, '1.0.0'))
    host.select(next.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: next.id, disabledSkinIds: [], pinnedSkinIds: [next.id] })
    const update = await finished(host.lifecycle.begin('update', next.id))
    expect(update).toMatchObject({ phase: 'done', application: 'restart-required', restartRequired: true })
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(readMarketState(host.directory)).toMatchObject({ activeSkinId: next.id, pinnedSkinIds: [next.id], pendingRestart: { pid: process.pid, skinIds: [next.id] } })
    await finished(host.lifecycle.begin('deactivate', next.id))
    await finished(host.lifecycle.begin('activate', next.id))
    await finished(host.lifecycle.begin('pin', next.id))
    await finished(host.lifecycle.begin('unpin', next.id))
    expect(readMarketState(host.directory).pendingRestart).toEqual({ pid: process.pid, skinIds: [next.id] })
    expect(host.lifecycle.states().find(state => state.skinId === next.id)).toMatchObject({ activation: 'restart-required', installedVersion: '1.1.0', primary: true })
    await finished(host.lifecycle.begin('uninstall', next.id))
    expect(readMarketState(host.directory).pendingRestart).toBeUndefined()
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
  })

  it('preserves an old Host applied install result while requiring a fresh generation before Use or Pin', async () => {
    const item = skin('native-a')
    const host = fixture([item], { hostVersion: '0.2.0-rc.2' })
    const operation = await finished(host.lifecycle.begin('install', item.id))
    expect(operation).toMatchObject({ phase: 'done', application: 'applied', restartRequired: true })
    expect(operation.message).toContain('完全退出并重开')
    expect(readMarketState(host.directory)).toMatchObject({ activeSkinId: null, pendingRestart: { pid: process.pid, skinIds: [item.id] } })
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(readProfileBundles(host.directory)).toEqual([])
    expect(() => host.lifecycle.begin('activate', item.id)).toThrow('需要先完全退出并重开')
    expect(() => host.lifecycle.begin('pin', item.id)).toThrow('需要先完全退出并重开')
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()

    await host.lifecycle.dispose()
    const persisted = readMarketState(host.directory)
    persisted.pendingRestart!.pid = process.pid + 1
    writeMarketState(host.directory, persisted)
    const freshRuntime: DshRuntime = { ...runtime, version: '0.2.0-rc.2' }
    const fresh = new SkinLifecycle({ loader: { entries: () => host.entries.values() } }, {
      profile: 'desktop', profileDir: host.directory, hostKind: 'desktop', runtime: freshRuntime,
      runner: officialDesktopRunner(() => host.manager, freshRuntime), lifecycleWaitMs: 10,
    }, [item])
    lifecycles.push(fresh)
    fresh.start()
    await until(() => readMarketState(host.directory).pendingRestart === undefined)
    expect(await finished(fresh.begin('activate', item.id))).toMatchObject({ phase: 'done', application: 'applied' })
    expect(readMarketState(host.directory).activeSkinId).toBe(item.id)
    expect(readProfileBundles(host.directory)).toEqual([item.package])
    expect(host.manager.setBundleEnabled).toHaveBeenCalledExactlyOnceWith(item.package, true)
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
  })

  it('persists the old Host restart guard after repairing an already recorded package', async () => {
    const item = skin('native-a')
    const host = fixture([item], { hostVersion: '0.2.0-rc.2' })
    host.materialize(item)
    rmSync(packageDir(host.directory, item.package), { recursive: true, force: true })
    host.manager.installBundle.mockImplementationOnce(async spec => ({ ...host.applyInstall(spec), application: 'applied' }))
    const operation = await finished(host.lifecycle.begin('install', item.id))
    expect(operation).toMatchObject({ phase: 'done', application: 'applied', restartRequired: true })
    expect(operation.message).toContain('构件已修复')
    expect(readMarketState(host.directory).pendingRestart).toEqual({ pid: process.pid, skinIds: [item.id] })
    expect(() => host.lifecycle.begin('activate', item.id)).toThrow('需要先完全退出并重开')
    expect(() => host.lifecycle.begin('pin', item.id)).toThrow('需要先完全退出并重开')
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(readFileSync(profilePatchFile(host.directory), 'utf8')).toBe(host.originalPatch)
  })

  it.each(['applied', 'failed'] as const)('holds further writes while a delayed native enable is pending, then accepts its late %s result once', async application => {
    const a = skin('native-a'), b = skin('native-b')
    const host = fixture([a, b])
    host.materialize(a); host.materialize(b)
    const result = deferred()
    host.manager.setBundleEnabled.mockImplementationOnce(() => result.promise)
    const operation = host.lifecycle.begin('activate', a.id)
    await until(() => operation.phase === 'waiting')
    expect(host.lifecycle.waitingReason).toContain('插件仍在完成启停')
    expect(() => host.lifecycle.begin('pin', b.id)).toThrow('暂时不能继续修改')
    if (application === 'applied') result.resolve(host.applyEnable(a.package, true))
    else result.resolve({ application: 'failed', stage: 'reload', target: a.package, error: { code: 'reload-failed', message: 'native enable rejected' } })
    expect(await finished(operation)).toMatchObject({ phase: application === 'applied' ? 'done' : 'failed', application })
    expect(host.lifecycle.waitingReason).toBeUndefined()
    expect(host.manager.setBundleEnabled.mock.calls.filter(([name, enabled]) => name === a.package && enabled)).toHaveLength(1)
    expect(await finished(host.lifecycle.begin('pin', b.id))).toMatchObject({ phase: 'done' })
    expect(host.manager.installBundle).not.toHaveBeenCalled()
  })

  it('joins a delayed native removal and releases the profile after its confirmed result', async () => {
    const a = skin('native-a'), b = skin('native-b')
    const host = fixture([a, b])
    host.materialize(a); host.materialize(b)
    const result = deferred()
    host.manager.removeBundle.mockImplementationOnce(() => result.promise)
    const operation = host.lifecycle.begin('uninstall', a.id)
    await until(() => operation.phase === 'waiting')
    expect(() => host.lifecycle.begin('activate', b.id)).toThrow('暂时不能继续修改')
    result.resolve(host.applyRemove(a.package))
    expect(await finished(operation)).toMatchObject({ phase: 'done', application: 'applied' })
    expect(host.lifecycle.waitingReason).toBeUndefined()
    expect(host.manager.removeBundle).toHaveBeenCalledTimes(1)
    expect(await finished(host.lifecycle.begin('activate', b.id))).toMatchObject({ phase: 'done' })
    expect(readFileSync(profilePatchFile(host.directory), 'utf8')).toBe(host.originalPatch)
  })

  it('retains native failure authority when rollback reconciliation reports applied', async () => {
    const item = skin('native-a')
    const host = fixture([item])
    host.materialize(item)
    host.select(item.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: item.id, disabledSkinIds: [] })
    host.manager.setBundleEnabled.mockImplementationOnce(async () => {
      host.select(item.package, false)
      return { application: 'failed', stage: 'reload', target: item.package, error: { code: 'reload-failed', message: 'native transaction failed' } }
    })
    const operation = await finished(host.lifecycle.begin('deactivate', item.id))
    expect(operation).toMatchObject({ phase: 'failed', application: 'failed' })
    expect(operation.message).toContain('native transaction failed')
    expect(readMarketState(host.directory).activeSkinId).toBe(item.id)
    expect(readProfileBundles(host.directory)).toEqual([item.package])
    expect(host.manager.setBundleEnabled.mock.calls).toEqual([[item.package, false], [item.package, true]])
  })

  it('keeps an unrecovered install result in waiting and never repeats it or offers a retry', async () => {
    const item = skin('native-a')
    const host = fixture([item])
    host.manager.installBundle.mockRejectedValueOnce(new Error('transport disconnected'))
    const operation = host.lifecycle.begin('install', item.id)
    await until(() => operation.phase === 'waiting' && host.manager.waitForInstall.mock.calls.length === 1)
    expect(operation).toMatchObject({ phase: 'waiting', cancelable: false })
    expect(operation.failure?.action).toBeUndefined()
    expect(host.lifecycle.waitingReason).toContain('重新打开宿主')
    expect(() => host.lifecycle.begin('install', item.id)).toThrow('重新打开宿主')
    expect(() => host.lifecycle.retry(operation.id, 'retry')).toThrow('not retryable')
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
    expect(host.manager.waitForInstall.mock.calls[0]![0]).toBe(host.manager.installBundle.mock.calls[0]![1]!.requestId)
    expect(readFileSync(profilePatchFile(host.directory), 'utf8')).toBe(host.originalPatch)
  })

  it('holds an already queued native install when the preceding manager result becomes unknown', async () => {
    const a = skin('native-a'), b = skin('native-b')
    const host = fixture([a, b])
    const pending = deferred()
    host.manager.installBundle.mockImplementationOnce(() => pending.promise)
    const first = host.lifecycle.begin('install', a.id)
    await until(() => host.manager.installBundle.mock.calls.length === 1)
    const queued = host.lifecycle.begin('install', b.id)
    expect(queued.phase).toBe('queued')
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
    pending.reject(new Error('first install result lost'))
    await until(() => first.phase === 'waiting' && queued.phase === 'waiting')
    expect(first).toMatchObject({ phase: 'waiting', cancelable: false })
    expect(queued).toMatchObject({ phase: 'waiting', cancelable: false })
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(host.manager.waitForInstall).toHaveBeenCalledTimes(1)
    expect(readDependencies(host.directory)).toEqual({})
    expect(readFileSync(profilePatchFile(host.directory), 'utf8')).toBe(host.originalPatch)
  })

  it.each([
    { range: '>=00.1.6-alpha.2', kind: 'activate' as const },
    { range: '>=0.1.6-alpha.01', kind: 'activate' as const },
    { range: '>=00.1.6-alpha.2', kind: 'install' as const },
    { range: '>=0.1.6-alpha.01', kind: 'install' as const },
  ])('rejects the malformed old-host peer $range during $kind before native enable', async ({ range, kind }) => {
    const item = skin('native-a')
    const host = fixture([item], { hostVersion: '0.1.6-alpha.2' })
    const declarePeer = () => {
      const manifestPath = join(packageDir(host.directory, item.package), 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      atomicWriteJson(manifestPath, { ...manifest, peerDependencies: { '@deepseek-ai/dsh': range } })
    }
    if (kind === 'activate') {
      host.materialize(item)
      declarePeer()
    } else {
      host.manager.installBundle.mockImplementationOnce(async spec => {
        const applied = host.applyInstall(spec)
        declarePeer()
        return applied
      })
    }
    const operation = await finished(host.lifecycle.begin(kind, item.id))
    expect(operation).toMatchObject({ phase: 'failed', cancelable: false })
    expect(operation.message).toContain('@deepseek-ai/dsh')
    expect(host.manager.setBundleEnabled.mock.calls.filter(([, enabled]) => enabled)).toEqual([])
    expect(host.manager.installBundle).toHaveBeenCalledTimes(kind === 'install' ? 1 : 0)
    expect(readMarketState(host.directory).activeSkinId).toBeNull()
    expect(readProfileBundles(host.directory)).toEqual([])
    expect(readFileSync(profilePatchFile(host.directory), 'utf8')).toBe(host.originalPatch)
  })

  it('uses a recovered install result without starting another native install', async () => {
    const item = skin('native-a')
    const host = fixture([item])
    host.manager.installBundle.mockRejectedValueOnce(new Error('transport disconnected'))
    host.manager.waitForInstall.mockImplementationOnce(async () => host.applyInstall(`${item.package}@1.0.0`))
    expect(await finished(host.lifecycle.begin('install', item.id))).toMatchObject({ phase: 'done', application: 'applied' })
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
    expect(host.manager.waitForInstall).toHaveBeenCalledTimes(1)
    expect(host.lifecycle.waitingReason).toBeUndefined()
  })

  it.each(['applied', 'failed', 'cancelled'] as const)('respects the final native %s result after cancellation was requested', async application => {
    const item = skin('native-a')
    const host = fixture([item])
    const result = deferred()
    host.manager.installBundle.mockImplementationOnce(() => result.promise)
    const operation = host.lifecycle.begin('install', item.id)
    await until(() => host.manager.installBundle.mock.calls.length === 1)
    expect(operation.cancelable).toBe(true)
    host.lifecycle.cancel(operation.id)
    expect(host.manager.cancelInstall).toHaveBeenCalledTimes(1)
    if (application === 'applied') result.resolve(host.applyInstall(`${item.package}@1.0.0`))
    else result.resolve({ application, stage: 'install', target: item.package, ...(application === 'failed' ? { error: { code: 'install-failed', message: 'native install failed after cancellation request' } } : {}) })
    expect(await finished(operation)).toMatchObject({ phase: application === 'applied' ? 'done' : application, application, cancelable: false })
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
    expect(host.lifecycle.waitingReason).toBeUndefined()
  })

  it('retries build approval only with exact pending names returned by the native manager', async () => {
    const item = skin('native-a')
    const host = fixture([item])
    host.manager.installBundle.mockResolvedValueOnce({ application: 'failed', stage: 'install', target: item.package, pendingBuilds: ['@fixture/native-helper', 'native-helper'], error: { code: 'build-approval-required', message: 'exact packages require approval' } })
    const failed = await finished(host.lifecycle.begin('install', item.id))
    expect(failed).toMatchObject({ phase: 'failed', application: 'failed', failure: { kind: 'build-approval', action: 'approve-build' } })
    expect(await finished(host.lifecycle.retry(failed.id, 'approve-build'))).toMatchObject({ phase: 'done', application: 'applied' })
    expect(host.manager.installBundle.mock.calls[1]![1]).toMatchObject({ approvedBuilds: ['@fixture/native-helper', 'native-helper'] })
    expect(host.manager.installBundle.mock.calls[0]![1]).not.toHaveProperty('approvedBuilds')
  })

  it('leaves installation usable and noncancelable when the Host omits only cancellation', async () => {
    const item = skin('native-a')
    const host = fixture([item])
    Reflect.deleteProperty(host.manager, 'cancelInstall')
    const result = deferred()
    host.manager.installBundle.mockImplementationOnce(() => result.promise)
    const operation = host.lifecycle.begin('install', item.id)
    await until(() => host.manager.installBundle.mock.calls.length === 1)
    expect(operation.cancelable).toBe(false)
    expect(() => host.lifecycle.cancel(operation.id)).toThrow('无法安全取消')
    result.resolve(host.applyInstall(`${item.package}@1.0.0`))
    expect(await finished(operation)).toMatchObject({ phase: 'done', application: 'applied' })
  })
})

describe('loader lifecycle settlement', () => {
  it.each(['applied', 'rejected'] as const)('keeps a timed-out loader promise joined until its late %s settlement and then releases writes', async outcome => {
    const item = skin('loader-a')
    const host = fixture([item])
    host.materialize(item)
    // A local loader plugin has no browser asset that would force a restart.
    const manifestPath = join(packageDir(host.directory, item.package), 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { client?: unknown } }
    delete manifest.dsh.client
    atomicWriteJson(manifestPath, manifest)
    const entry = host.entries.get(item.package)!
    const pending = deferred<void>()
    const update = vi.fn(async (options: { disabled: boolean | null }) => {
      entry.options.disabled = options.disabled
      entry.fiber = options.disabled === true ? undefined : {}
    })
    update.mockImplementationOnce(async options => {
      await pending.promise
      entry.options.disabled = options.disabled
      entry.fiber = options.disabled === true ? undefined : {}
    })
    entry.update = update
    const lifecycle = new SkinLifecycle({ loader: { entries: () => [entry] } }, {
      profile: 'web', profileDir: host.directory, hostKind: 'dsh', runtime,
      lifecycleWaitMs: 10, runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    }, [item])
    lifecycles.push(lifecycle)
    const operation = lifecycle.begin('activate', item.id)
    await until(() => operation.phase === 'waiting')
    expect(() => lifecycle.begin('pin', item.id)).toThrow('暂时不能继续修改')
    expect(update).toHaveBeenCalledTimes(1)
    if (outcome === 'applied') pending.resolve()
    else pending.reject(new Error('loader startup rejected'))
    expect(await finished(operation)).toMatchObject({ phase: outcome === 'applied' ? 'done' : 'failed' })
    expect(lifecycle.waitingReason).toBeUndefined()
    if (outcome === 'rejected') {
      expect(readMarketState(host.directory).activeSkinId).toBeNull()
      expect(readProfileBundles(host.directory)).toEqual([])
    }
    expect(update).toHaveBeenCalledTimes(1)
    expect(await finished(lifecycle.begin('activate', item.id))).toMatchObject({ phase: 'done' })
    expect(update).toHaveBeenCalledTimes(outcome === 'applied' ? 1 : 2)
  })
})
