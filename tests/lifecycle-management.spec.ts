import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { SkinLifecycle } from '../src/lifecycle.ts'
import { compatibilityContext } from '../src/compatibility.ts'
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
  const componentEnabled = new Map<string, boolean>()
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
      entry.options.disabled = enabled && componentEnabled.get(name) !== false ? null : true
      entry.fiber = entry.options.disabled === true ? undefined : {}
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
    if (!componentEnabled.has(item.package)) componentEnabled.set(item.package, true)
    const componentLive = enabled && componentEnabled.get(item.package) !== false
    entries.set(item.package, { options: { id: item.rowId, name: item.package, disabled: !componentLive }, fiber: componentLive ? {} : undefined, update: vi.fn(async () => undefined) })
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
  const entryId = (name: string) => `loader:${name}`
  const applyComponentEnable = (id: string, enabled: boolean) => {
    const item = catalog.find(item => entryId(item.package) === id)
    if (item === undefined) throw new Error('unknown fixture entryId')
    componentEnabled.set(item.package, enabled)
    select(item.package, readProfileBundles(directory).includes(item.package))
    return { application: 'applied', changed: true, stage: 'enable', target: id, enabled }
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
    setPluginEnabled: vi.fn(async (id: string, enabled: boolean): Promise<unknown> => applyComponentEnable(id, enabled)),
    cancelInstall: vi.fn(async (_requestId: string): Promise<unknown> => ({ status: 'not-running' })),
    waitForInstall: vi.fn(async (_requestId: string): Promise<unknown> => null),
    listPlugins: vi.fn(async (): Promise<unknown> => catalog.filter(item => entries.has(item.package) && readProfileBundles(directory).includes(item.package)).map(item => ({
      entryId: entryId(item.package), patchId: item.rowId, moduleName: item.package, enabled: componentEnabled.get(item.package) !== false, fiberPhase: entries.get(item.package)?.fiber === undefined ? null : 'active',
    }))),
    listBundles: vi.fn(async (): Promise<unknown> => catalog.filter(item => entries.has(item.package)).map(item => ({
      name: item.package, enabled: readProfileBundles(directory).includes(item.package), installed: true,
      rows: [{ rowId: item.rowId, moduleName: item.package, ...(readProfileBundles(directory).includes(item.package) ? { entryId: entryId(item.package) } : {}) }],
    }))),
  } satisfies OfficialPluginManagerLike
  const injectedRuntime = { ...runtime, version: options.hostVersion ?? runtime.version }
  const runner = officialDesktopRunner(() => manager, injectedRuntime)
  const lifecycle = new SkinLifecycle({ loader: { entries: () => entries.values() } }, {
    profile: 'desktop', profileDir: directory, runner, hostKind: 'desktop', runtime: injectedRuntime,
    lifecycleWaitMs: options.lifecycleWaitMs ?? 10,
  }, catalog)
  lifecycles.push(lifecycle)
  return { directory, originalPatch, entries, componentEnabled, entryId, applyComponentEnable, manager, lifecycle, runner, materialize, select, applyInstall, applyEnable, applyRemove, runtime: injectedRuntime }
}

describe('official plugin manager lifecycle', () => {
  it('repairs the selected bundle main component without enabling other components or touching pinned selections', async () => {
    const target = skin('component-target'), current = skin('component-old'), pinned = skin('component-pinned')
    const host = fixture([target, current, pinned], { hostVersion: '0.2.0-rc.2' })
    for (const item of [target, current, pinned]) host.materialize(item)
    host.select(current.package, true); host.select(pinned.package, true)
    host.componentEnabled.set(target.package, false)
    const inventory = host.manager.listPlugins.getMockImplementation()!
    host.manager.listPlugins.mockImplementation(async () => [...await inventory() as object[], {
      entryId: 'unrelated-feature-entry', patchId: 'extra-feature', moduleName: target.package, enabled: false,
    }])
    const bundles = host.manager.listBundles.getMockImplementation()!
    host.manager.listBundles.mockImplementation(async () => (await bundles() as Array<Record<string, unknown>>).map(bundle => bundle.name !== target.package ? bundle : {
      ...bundle, rows: [...bundle.rows as object[], { rowId: 'extra-feature', moduleName: target.package, entryId: 'unrelated-feature-entry' }],
    }))
    writeMarketState(host.directory, { version: 1, activeSkinId: current.id, disabledSkinIds: [target.id], pinnedSkinIds: [pinned.id] })

    const operation = await finished(host.lifecycle.begin('activate', target.id))
    expect(operation).toMatchObject({ phase: 'done', application: 'applied' })
    expect(operation.restartRequired).not.toBe(true)
    expect(host.manager.setPluginEnabled).toHaveBeenCalledExactlyOnceWith(host.entryId(target.package), true)
    expect(host.componentEnabled.get(target.package)).toBe(true)
    expect(readProfileBundles(host.directory).sort()).toEqual([target.package, pinned.package].sort())
    expect(host.lifecycle.states().find(state => state.skinId === target.id)).toMatchObject({ activation: 'active', primary: true })
    host.manager.setBundleEnabled.mockClear(); host.manager.setPluginEnabled.mockClear()
    await host.lifecycle.replay()
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(host.manager.setPluginEnabled).not.toHaveBeenCalled()
  })

  it('repairs a disabled selected component when no prior restart attempt has failed', async () => {
    const target = skin('component-restart')
    const host = fixture([target], { hostVersion: '0.2.0-rc.2' })
    host.materialize(target)
    host.componentEnabled.set(target.package, false); host.select(target.package, true)
    // A residual fiber must never make an explicitly disabled component live.
    host.entries.get(target.package)!.fiber = {}
    writeMarketState(host.directory, { version: 1, activeSkinId: target.id, disabledSkinIds: [] })
    expect(host.lifecycle.states().find(state => state.skinId === target.id)).toMatchObject({ activation: 'unavailable', error: expect.stringContaining('组件已关闭') })
    await host.lifecycle.replay()
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(host.manager.setPluginEnabled).toHaveBeenCalledExactlyOnceWith(host.entryId(target.package), true)
    expect(readMarketState(host.directory).pendingRestart).toBeUndefined()
    expect(host.lifecycle.states().find(state => state.skinId === target.id)).toMatchObject({ activation: 'active' })
  })

  it.each(['duplicate-plugin', 'duplicate-bundle-row', 'mismatched-entry', 'read-only'] as const)('fails closed for %s instead of guessing a component identity', async ambiguity => {
    const target = skin('component-ambiguous'), current = skin('component-current')
    const host = fixture([target, current])
    host.materialize(target); host.materialize(current); host.select(current.package, true)
    host.componentEnabled.set(target.package, false)
    writeMarketState(host.directory, { version: 1, activeSkinId: current.id, disabledSkinIds: [target.id] })
    if (ambiguity === 'duplicate-plugin' || ambiguity === 'read-only') {
      const inventory = host.manager.listPlugins.getMockImplementation()!
      host.manager.listPlugins.mockImplementation(async () => (await inventory() as Array<Record<string, unknown>>).flatMap(row => row.moduleName !== target.package ? [row] : ambiguity === 'duplicate-plugin' ? [row, { ...row, entryId: 'another-entry' }] : [{ ...row, readOnlyReason: 'unaddressable' }]))
    } else {
      const bundles = host.manager.listBundles.getMockImplementation()!
      host.manager.listBundles.mockImplementation(async () => (await bundles() as Array<Record<string, unknown>>).map(bundle => bundle.name !== target.package ? bundle : {
        ...bundle, rows: ambiguity === 'duplicate-bundle-row' ? [...bundle.rows as object[], ...(bundle.rows as object[])] : (bundle.rows as object[]).map(row => ({ ...row, entryId: 'wrong-entry' })),
      }))
    }
    expect(await finished(host.lifecycle.begin('activate', target.id))).toMatchObject({ phase: 'failed' })
    expect(host.manager.setPluginEnabled).not.toHaveBeenCalled()
    expect(readMarketState(host.directory).activeSkinId).toBe(current.id)
    expect(readProfileBundles(host.directory)).toEqual([current.package])
  })

  it.each(['failed', 'overridden'] as const)('restores the original component toggle as well as selection when enabling is %s', async application => {
    const target = skin('component-failure'), current = skin('component-original')
    const host = fixture([target, current])
    host.materialize(target); host.materialize(current); host.select(current.package, true)
    host.componentEnabled.set(target.package, false)
    writeMarketState(host.directory, { version: 1, activeSkinId: current.id, disabledSkinIds: [target.id] })
    host.manager.setPluginEnabled.mockImplementationOnce(async (entryId, enabled) => ({ ...host.applyComponentEnable(entryId, enabled), application, error: { code: 'reload-failed', message: 'component toggle rejected' } }))
    expect(await finished(host.lifecycle.begin('activate', target.id))).toMatchObject({ phase: 'failed', application })
    expect(host.componentEnabled.get(target.package)).toBe(false)
    expect(host.manager.setPluginEnabled.mock.calls).toEqual([[host.entryId(target.package), true], [host.entryId(target.package), false]])
    expect(readMarketState(host.directory).activeSkinId).toBe(current.id)
    expect(readProfileBundles(host.directory)).toEqual([current.package])
  })

  it('waits on an unknown component result and performs no guessed rollback writes', async () => {
    const target = skin('component-unknown')
    const host = fixture([target])
    host.materialize(target); host.componentEnabled.set(target.package, false)
    host.manager.setPluginEnabled.mockResolvedValueOnce(null)
    const operation = host.lifecycle.begin('activate', target.id)
    await until(() => operation.phase === 'waiting')
    expect(host.manager.setPluginEnabled).toHaveBeenCalledExactlyOnceWith(host.entryId(target.package), true)
    expect(host.lifecycle.waitingReason).toContain('重新打开宿主')
    expect(() => host.lifecycle.begin('pin', target.id)).toThrow('重新打开宿主')
    expect(readMarketState(host.directory).activeSkinId).toBeNull()
  })

  it('leaves an already-correct active selection alone on repeated use', async () => {
    const target = skin('component-already-on')
    const host = fixture([target])
    host.materialize(target); host.select(target.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: target.id, disabledSkinIds: [] })
    const operation = await finished(host.lifecycle.begin('activate', target.id))
    expect(operation.phase).toBe('done')
    expect(operation.restartRequired).not.toBe(true)
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(host.manager.setPluginEnabled).not.toHaveBeenCalled()
    expect(readMarketState(host.directory).pendingRestart).toBeUndefined()
  })

  it('persists an explicit component restart requirement discovered during startup replay', async () => {
    const target = skin('component-startup-restart')
    const host = fixture([target])
    host.materialize(target); host.componentEnabled.set(target.package, false); host.select(target.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: target.id, disabledSkinIds: [] })
    host.manager.setPluginEnabled.mockImplementationOnce(async (entryId, enabled) => ({ ...host.applyComponentEnable(entryId, enabled), application: 'restart-required' }))
    await host.lifecycle.replay()
    expect(readMarketState(host.directory).pendingRestart).toMatchObject({ pid: process.pid, skinIds: [target.id] })
    expect(host.lifecycle.states().find(state => state.skinId === target.id)).toMatchObject({ activation: 'restart-required', error: undefined })
  })

  it('retains a genuine native removal restart requirement even after the package is missing', async () => {
    const target = skin('component-remove-restart')
    const host = fixture([target])
    host.materialize(target)
    host.manager.removeBundle.mockImplementationOnce(async name => ({ ...host.applyRemove(name), application: 'restart-required' }))
    expect(await finished(host.lifecycle.begin('uninstall', target.id))).toMatchObject({ phase: 'done', restartRequired: true })
    expect(readMarketState(host.directory).pendingRestart).toMatchObject({ pid: process.pid, skinIds: [target.id] })
    expect(host.lifecycle.states().find(state => state.skinId === target.id)).toMatchObject({ installation: 'missing', activation: 'restart-required' })
    writeMarketState(host.directory, { ...readMarketState(host.directory), pendingRestart: { pid: process.pid - 1, skinIds: [target.id] } })
    await host.lifecycle.replay()
    expect(readMarketState(host.directory).pendingRestart).toBeUndefined()
    expect(host.lifecycle.states().find(state => state.skinId === target.id)).toMatchObject({ installation: 'missing', activation: 'inactive' })
  })

  it.each(['saved-import', 'unsaved-import', 'initialization'] as const)('only retains a confirmed saved old-host component selection for %s', async outcome => {
    const target = skin('component-old-import'), current = skin('component-old-current')
    const host = fixture([target, current], { hostVersion: '0.2.0-rc.2' })
    host.materialize(current); host.select(current.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: current.id, disabledSkinIds: [target.id] })
    await finished(host.lifecycle.begin('install', target.id))
    host.componentEnabled.set(target.package, false)
    host.manager.setPluginEnabled.mockImplementationOnce(async (entryId, enabled) => {
      if (outcome !== 'unsaved-import') host.applyComponentEnable(entryId, enabled)
      return { application: 'failed', changed: true, stage: 'enable', target: entryId, enabled, error: {
        code: 'operation-error', diagnostic: `dsh: warning: 1 entry did not activate\n${target.rowId} (${target.package}): ${outcome === 'initialization' ? 'Error: plugin initialization failed' : 'failed to import'}`,
      } }
    })
    const operation = await finished(host.lifecycle.begin('activate', target.id))
    if (outcome === 'saved-import') {
      expect(operation).toMatchObject({ phase: 'done', application: 'restart-required', restartRequired: true })
      expect(readMarketState(host.directory).activeSkinId).toBe(target.id)
      expect(readProfileBundles(host.directory)).toEqual([target.package])
      expect(host.componentEnabled.get(target.package)).toBe(true)
    } else {
      expect(operation).toMatchObject({ phase: 'failed', application: 'failed' })
      expect(readMarketState(host.directory).activeSkinId).toBe(current.id)
      expect(readProfileBundles(host.directory)).toEqual([current.package])
      expect(host.componentEnabled.get(target.package)).toBe(false)
    }
  })

  it.each([
    { enabled: true, phase: 'active', activation: 'active', diagnostic: undefined },
    { enabled: false, phase: 'active', activation: 'unavailable', diagnostic: '组件已关闭' },
    { enabled: true, phase: 'failed', activation: 'unavailable', diagnostic: '加载失败' },
    { enabled: true, phase: null, activation: 'unavailable', diagnostic: '尚未运行' },
    { enabled: true, phase: 'loading', activation: 'switching', diagnostic: '正在加载' },
    { enabled: true, phase: 'pending', activation: 'switching', diagnostic: '等待所需服务' },
  ])('uses official enabled=$enabled/fiberPhase=$phase instead of the mere existence of a fiber', async ({ enabled, phase, activation, diagnostic }) => {
    const target = skin('official-runtime')
    const host = fixture([target])
    host.materialize(target); host.select(target.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: target.id, disabledSkinIds: [] })
    host.manager.listPlugins.mockResolvedValueOnce([{ entryId: host.entryId(target.package), patchId: target.rowId, moduleName: target.package, enabled, fiberPhase: phase }])
    const state = (await host.lifecycle.runtimeStates()).find(state => state.skinId === target.id)!
    expect(state.activation).toBe(activation)
    if (diagnostic === undefined) expect(state.error).toBeUndefined()
    else expect(state.error).toContain(diagnostic)
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(host.manager.setPluginEnabled).not.toHaveBeenCalled()
  })

  it('reads an unaddressable component for diagnosis without treating it as writable', async () => {
    const target = skin('official-runtime-readonly')
    const host = fixture([target])
    host.materialize(target); host.select(target.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: target.id, disabledSkinIds: [] })
    host.manager.listPlugins.mockResolvedValueOnce([{ entryId: host.entryId(target.package), moduleName: target.package, readOnlyReason: 'unaddressable', enabled: true, fiberPhase: 'failed' }])
    expect((await host.lifecycle.runtimeStates())[0]).toMatchObject({ activation: 'unavailable', error: expect.stringContaining('加载失败') })
    expect(host.manager.setPluginEnabled).not.toHaveBeenCalled()
  })

  it('diagnoses a failed official inventory read without guessing active or overwriting a genuine restart', async () => {
    const current = skin('official-runtime-error'), pinned = skin('official-runtime-pending')
    const host = fixture([current, pinned])
    host.materialize(current); host.materialize(pinned); host.select(current.package, true); host.select(pinned.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: current.id, pinnedSkinIds: [pinned.id], disabledSkinIds: [], pendingRestart: { pid: process.pid, skinIds: [pinned.id] } })
    const before = readMarketState(host.directory)
    host.manager.listPlugins.mockRejectedValueOnce(new Error('inventory unavailable'))
    const states = await host.lifecycle.runtimeStates()
    expect(states.find(state => state.skinId === current.id)).toMatchObject({ activation: 'unavailable', error: expect.stringContaining('inventory unavailable') })
    expect(states.find(state => state.skinId === pinned.id)).toMatchObject({ activation: 'restart-required', error: undefined })
    expect(readMarketState(host.directory)).toEqual(before)
    expect(host.manager.setPluginEnabled).not.toHaveBeenCalled()
  })

  it.each(['applied', 'restart-required', 'failed-import', 'failed-initialization', 'unknown'] as const)('saves a disabled component after an old-host bundle import failure only when component result is confirmed: %s', async outcome => {
    const target = skin('bundle-import-component'), current = skin('bundle-import-original')
    const host = fixture([target, current], { hostVersion: '0.2.0-rc.2' })
    host.materialize(current); host.select(current.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: current.id, disabledSkinIds: [target.id] })
    await finished(host.lifecycle.begin('install', target.id))
    host.componentEnabled.set(target.package, false)
    const diagnostic = `dsh: warning: 1 entry did not activate\n${target.rowId} (${target.package}): failed to import`
    host.manager.setBundleEnabled.mockImplementation(async (name, enabled) => ({ ...host.applyEnable(name, enabled), ...(name === target.package && enabled ? { application: 'failed', error: { code: 'operation-error', diagnostic } } : {}) }))
    host.manager.setPluginEnabled.mockImplementationOnce(async (entryId, enabled) => {
      if (outcome === 'unknown') return null
      host.applyComponentEnable(entryId, enabled)
      return { application: outcome.startsWith('failed-') ? 'failed' : outcome, changed: true, stage: 'enable', target: entryId, enabled,
        ...(outcome.startsWith('failed-') ? { error: { code: 'operation-error', diagnostic: outcome === 'failed-import' ? diagnostic : diagnostic.replace('failed to import', 'Error: initialization failed') } } : {}),
      }
    })
    const operation = host.lifecycle.begin('activate', target.id)
    if (outcome === 'unknown') {
      await until(() => operation.phase === 'waiting')
      expect(host.manager.setPluginEnabled).toHaveBeenCalledTimes(1)
      expect(host.lifecycle.waitingReason).toContain('重新打开宿主')
      expect(readMarketState(host.directory).activeSkinId).toBe(current.id)
    } else if (outcome === 'failed-initialization') {
      expect(await finished(operation)).toMatchObject({ phase: 'failed' })
      expect(readMarketState(host.directory).activeSkinId).toBe(current.id)
      expect(readProfileBundles(host.directory)).toEqual([current.package])
      expect(host.componentEnabled.get(target.package)).toBe(false)
    } else {
      expect(await finished(operation)).toMatchObject({ phase: 'done', application: 'restart-required', restartRequired: true })
      expect(readMarketState(host.directory).activeSkinId).toBe(target.id)
      expect(readProfileBundles(host.directory)).toEqual([target.package])
      expect(host.componentEnabled.get(target.package)).toBe(true)
      expect(host.manager.setPluginEnabled).toHaveBeenCalledExactlyOnceWith(host.entryId(target.package), true)
    }
  })

  it('keeps one restart notice identity through replay and repeated use, then creates a new identity for a later restart', async () => {
    const target = skin('stable-restart-notice')
    const host = fixture([target])
    host.materialize(target); host.componentEnabled.set(target.package, false); host.select(target.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: target.id, disabledSkinIds: [] })
    host.manager.setPluginEnabled.mockImplementation(async (entryId, enabled) => ({ ...host.applyComponentEnable(entryId, enabled), application: 'restart-required' }))
    await host.lifecycle.replay()
    const firstId = host.lifecycle.restartNoticeId
    expect(firstId).toEqual(expect.any(String))
    await host.lifecycle.replay()
    await finished(host.lifecycle.begin('activate', target.id))
    expect(host.lifecycle.restartNoticeId).toBe(firstId)
    const beforeRestart = readMarketState(host.directory)
    writeMarketState(host.directory, { ...beforeRestart, pendingRestart: { ...beforeRestart.pendingRestart!, pid: process.pid - 1 } })
    await host.lifecycle.replay()
    expect(host.lifecycle.restartNoticeId).toBeUndefined()
    host.componentEnabled.set(target.package, false); host.select(target.package, true)
    await host.lifecycle.replay()
    expect(host.lifecycle.restartNoticeId).toEqual(expect.any(String))
    expect(host.lifecycle.restartNoticeId).not.toBe(firstId)
  })

  it.each(['disabled', 'failed', 'inventory-error'] as const)('keeps a failed restart verification receipt for %s without issuing another startup restart', async outcome => {
    const target = skin('restart-verification')
    const host = fixture([target], { hostVersion: '0.2.0-rc.2' })
    host.materialize(target)
    if (outcome === 'disabled') host.componentEnabled.set(target.package, false)
    host.select(target.package, true)
    const previous = { pid: process.pid - 1, skinIds: [target.id], id: 'previous-restart-generation' }
    writeMarketState(host.directory, { version: 1, activeSkinId: target.id, disabledSkinIds: [], pendingRestart: previous })
    if (outcome === 'failed') host.manager.listPlugins.mockImplementation(async () => [{ entryId: host.entryId(target.package), patchId: target.rowId, moduleName: target.package, enabled: true, fiberPhase: 'failed' }])
    if (outcome === 'inventory-error') host.manager.listPlugins.mockRejectedValue(new Error('inventory unavailable'))
    await host.lifecycle.replay()
    await host.lifecycle.replay()
    const reloaded = new SkinLifecycle({ loader: { entries: () => host.entries.values() } }, { profile: 'desktop', profileDir: host.directory, runner: host.runner, hostKind: 'desktop', runtime: host.runtime }, [target])
    lifecycles.push(reloaded)
    await reloaded.replay()
    expect(readMarketState(host.directory).pendingRestart).toEqual(previous)
    expect(reloaded.restartNoticeId).toBeUndefined()
    expect((await reloaded.runtimeStates())[0]).toMatchObject({ activation: 'unavailable', error: expect.stringContaining('重启后皮肤仍未生效') })
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(host.manager.setPluginEnabled).not.toHaveBeenCalled()
  })

  it('clears a failed-restart receipt when the official component becomes healthy and lets explicit Use create a new generation', async () => {
    const target = skin('restart-verification-retry')
    const host = fixture([target], { hostVersion: '0.2.0-rc.2' })
    host.materialize(target); host.componentEnabled.set(target.package, false); host.select(target.package, true)
    const previous = { pid: process.pid - 1, skinIds: [target.id], id: 'old-generation' }
    writeMarketState(host.directory, { version: 1, activeSkinId: target.id, disabledSkinIds: [], pendingRestart: previous })
    await host.lifecycle.replay()
    expect(host.manager.setPluginEnabled).not.toHaveBeenCalled()
    host.manager.setPluginEnabled.mockImplementationOnce(async (entryId, enabled) => ({ ...host.applyComponentEnable(entryId, enabled), application: 'restart-required' }))
    expect(await finished(host.lifecycle.begin('activate', target.id))).toMatchObject({ phase: 'done', restartRequired: true })
    expect(host.lifecycle.restartNoticeId).toEqual(expect.any(String))
    expect(host.lifecycle.restartNoticeId).not.toBe(previous.id)
    const next = readMarketState(host.directory)
    writeMarketState(host.directory, { ...next, pendingRestart: { ...next.pendingRestart!, pid: process.pid - 1 } })
    host.manager.setPluginEnabled.mockClear()
    await host.lifecycle.replay()
    expect(host.lifecycle.restartNoticeId).toBeUndefined()
    expect(readMarketState(host.directory).pendingRestart).toBeUndefined()
    expect((await host.lifecycle.runtimeStates())[0]).toMatchObject({ activation: 'active', error: undefined })
    expect(host.manager.setPluginEnabled).not.toHaveBeenCalled()
  })

  it('does not reselect a missing bundle after its previous restart failed verification', async () => {
    const target = skin('restart-missing-bundle')
    const host = fixture([target], { hostVersion: '0.2.0-rc.2' })
    host.materialize(target)
    const previous = { pid: process.pid - 1, skinIds: [target.id], id: 'old-bundle-attempt' }
    writeMarketState(host.directory, { version: 1, activeSkinId: target.id, disabledSkinIds: [], pendingRestart: previous })
    await host.lifecycle.replay()
    await host.lifecycle.replay()
    expect(readProfileBundles(host.directory)).toEqual([])
    expect(readMarketState(host.directory).pendingRestart).toEqual(previous)
    expect(host.lifecycle.restartNoticeId).toBeUndefined()
    expect((await host.lifecycle.runtimeStates())[0]).toMatchObject({ activation: 'unavailable' })
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(host.manager.setPluginEnabled).not.toHaveBeenCalled()
  })

  it('serializes a delayed startup verification with explicit Use so an old snapshot cannot overwrite the new selection', async () => {
    const old = skin('restart-racing-old'), target = skin('restart-racing-target')
    const host = fixture([old, target])
    host.materialize(old); host.materialize(target); host.select(old.package, true)
    host.componentEnabled.set(old.package, false); host.select(old.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: old.id, disabledSkinIds: [target.id], pendingRestart: { pid: process.pid - 1, skinIds: [old.id], id: 'old-startup-snapshot' } })
    const inventory = host.manager.listPlugins.getMockImplementation()!
    const gate = deferred<unknown>()
    host.manager.listPlugins.mockImplementationOnce(() => gate.promise)
    const replay = host.lifecycle.replay()
    await until(() => host.manager.listPlugins.mock.calls.length === 1)
    host.manager.setBundleEnabled.mockImplementation(async (name, enabled) => ({ ...host.applyEnable(name, enabled), ...(name === target.package && enabled ? { application: 'restart-required' } : {}) }))
    const operation = host.lifecycle.begin('activate', target.id)
    expect(operation.phase).toBe('queued')
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    gate.resolve(await inventory())
    await replay
    expect(await finished(operation)).toMatchObject({ phase: 'done', restartRequired: true })
    const state = readMarketState(host.directory)
    expect(state.activeSkinId).toBe(target.id)
    expect(state.disabledSkinIds).toEqual([old.id])
    expect(state.pendingRestart).toMatchObject({ pid: process.pid, skinIds: [target.id] })
    expect(state.pendingRestart?.id).not.toBe('old-startup-snapshot')
    expect(readProfileBundles(host.directory)).toEqual([target.package])
    expect(host.manager.setBundleEnabled.mock.calls).toEqual([[old.package, false], [target.package, true]])
  })

  it.each(['install', 'update'] as const)('allows an out-of-range %s only after acknowledgement on DSH 0.2.0-rc.2', async kind => {
    const item = skin(`range-${kind}`)
    item.compatibility.dsh = '0.1.0-rc.6'
    const host = fixture([item], { hostVersion: '0.2.0-rc.2' })
    if (kind === 'update') host.materialize(skin(item.id, '0.9.0'))
    const before = readFileSync(join(host.directory, 'package.json'), 'utf8')
    expect(() => host.lifecycle.begin(kind, item.id)).toThrow('请在兼容性提示中确认后继续')
    expect(host.manager.installBundle).not.toHaveBeenCalled()
    expect(readFileSync(join(host.directory, 'package.json'), 'utf8')).toBe(before)
    const operation = await finished(host.lifecycle.begin(kind, item.id, undefined, true, compatibilityContext(item, host.runtime)))
    expect(operation.phase).toBe('done')
    expect(readDependencies(host.directory)[item.package]).toBe('1.0.0')
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
    const options = host.manager.installBundle.mock.calls[0]![1]!
    expect(options).not.toHaveProperty('force')
    expect(options).not.toHaveProperty('acceptRisk')
    expect(readFileSync(profilePatchFile(host.directory), 'utf8')).toBe(host.originalPatch)
  })

  it.each(['activate', 'pin'] as const)('allows an out-of-range %s only for the acknowledged request', async kind => {
    const item = skin(`range-${kind}`)
    item.compatibility.dsh = '0.1.0-rc.6'
    const host = fixture([item])
    host.materialize(item)
    expect(() => host.lifecycle.begin(kind, item.id)).toThrow('请在兼容性提示中确认后继续')
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    expect((await finished(host.lifecycle.begin(kind, item.id, undefined, true, compatibilityContext(item, host.runtime)))).phase).toBe('done')
    expect(readProfileBundles(host.directory)).toContain(item.package)
    expect(() => host.lifecycle.begin(kind, item.id)).toThrow('请在兼容性提示中确认后继续')
  })

  it('keeps a host compatibility refusal after the user accepted the author-range warning', async () => {
    const item = skin('host-refusal')
    item.compatibility.dsh = '0.1.0-rc.6'
    const host = fixture([item])
    host.manager.installBundle.mockResolvedValue({ application: 'failed', changed: false, error: { code: 'incompatible-version', message: 'host peer version mismatch' } })
    const operation = await finished(host.lifecycle.begin('install', item.id, undefined, true, compatibilityContext(item, host.runtime)))
    expect(operation).toMatchObject({ phase: 'failed', failure: { kind: 'compatibility' } })
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(readDependencies(host.directory)).toEqual({})
  })

  it('requires fresh compatibility acknowledgement when retrying a failed install', async () => {
    const item = skin('range-retry')
    item.compatibility.dsh = '0.1.0-rc.6'
    const host = fixture([item])
    host.manager.installBundle.mockResolvedValueOnce({ application: 'failed', pendingBuilds: ['fixture-build'], error: { code: 'build-approval-required', message: 'approval required' } })
    const first = await finished(host.lifecycle.begin('install', item.id, undefined, true, compatibilityContext(item, host.runtime)))
    expect(first).toMatchObject({ phase: 'failed', failure: { action: 'approve-build' } })
    expect(() => host.lifecycle.retry(first.id, 'approve-build')).toThrow('请在兼容性提示中确认后继续')
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
    const retry = await finished(host.lifecycle.retry(first.id, 'approve-build', true, compatibilityContext(item, host.runtime)))
    expect(retry.phase, retry.message).toBe('done')
    expect(host.manager.installBundle).toHaveBeenCalledTimes(2)
  })

  it('does not misclassify unrelated errors as compatibility failures after acknowledgement', async () => {
    const item = skin('range-other-error')
    item.compatibility.dsh = '0.1.0-rc.6'
    const host = fixture([item])
    host.manager.installBundle.mockResolvedValueOnce({ application: 'failed', error: { code: 'artifact-error', message: 'invalid artifact' } })
    const operation = await finished(host.lifecycle.begin('install', item.id, undefined, true, compatibilityContext(item, host.runtime)))
    expect(operation.phase).toBe('failed')
    expect(operation.message).toContain('invalid artifact')
    expect(operation.failure?.kind).not.toBe('compatibility')
  })

  it.each(['package', 'range', 'runtime'] as const)('rejects a compatibility acknowledgement when the shown %s changes', async change => {
    const item = skin(`stale-${change}`)
    item.compatibility.dsh = '0.1.0-rc.6'
    const host = fixture([item])
    const context = compatibilityContext(item, host.runtime)
    if (change === 'package') await host.lifecycle.replaceCatalog([{ ...item, install: skin(item.id, '1.1.0').install }])
    else if (change === 'range') await host.lifecycle.replaceCatalog([{ ...item, compatibility: { ...item.compatibility, dsh: '*' } }])
    else host.runtime.version = '0.2.1-alpha.2'
    const before = readFileSync(join(host.directory, 'package.json'), 'utf8')
    expect(() => host.lifecycle.begin('install', item.id, undefined, true, context)).toThrow('已变化，请重新确认')
    expect(host.manager.installBundle).not.toHaveBeenCalled()
    expect(readFileSync(join(host.directory, 'package.json'), 'utf8')).toBe(before)
  })

  it('requires the shown compatibility context along with acknowledgement', () => {
    const item = skin('missing-context')
    item.compatibility.dsh = '0.1.0-rc.6'
    const host = fixture([item])
    expect(() => host.lifecycle.begin('install', item.id, undefined, true)).toThrow('已变化，请重新确认')
    expect(host.manager.installBundle).not.toHaveBeenCalled()
  })

  it('rechecks acknowledged activation after waiting for another profile operation', async () => {
    const blocker = skin('context-blocker')
    const item = skin('queued-context')
    item.compatibility.dsh = '0.1.0-rc.6'
    const host = fixture([blocker, item])
    host.materialize(item)
    const pending = deferred()
    host.manager.installBundle.mockImplementationOnce(async () => pending.promise)
    const install = host.lifecycle.begin('install', blocker.id)
    await until(() => host.manager.installBundle.mock.calls.length === 1)
    const activation = host.lifecycle.begin('activate', item.id, undefined, true, compatibilityContext(item, host.runtime))
    const replacement = host.lifecycle.replaceCatalog([blocker, { ...item, compatibility: { ...item.compatibility, dsh: '*' } }])
    pending.resolve(host.applyInstall(`${blocker.package}@${blocker.install.version}`))
    expect((await finished(install)).phase).toBe('done')
    expect(await finished(activation)).toMatchObject({ phase: 'failed', message: expect.stringContaining('已变化，请重新确认') })
    await replacement
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalledWith(item.package, true)
    expect(readProfileBundles(host.directory)).not.toContain(item.package)
  })

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

  it('installs then switches an alpha.3 skin by disabling the old primary before enabling the target, while keeping pinned skins', async () => {
    const next = skin('alpha3-next'), current = skin('alpha3-current'), pinned = skin('alpha3-pinned')
    // Put the target before the current skin to ensure catalog order cannot
    // accidentally make both ordinary skins active during the switch.
    const host = fixture([next, current, pinned], { hostVersion: '0.2.1-alpha.3' })
    host.materialize(current); host.materialize(pinned)
    host.select(current.package, true); host.select(pinned.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: current.id, disabledSkinIds: [next.id], pinnedSkinIds: [pinned.id] })
    expect(host.runner.management?.installRequiresRestart).toBe(false)
    expect(await finished(host.lifecycle.begin('install', next.id))).toMatchObject({ phase: 'done', application: 'applied' })
    host.manager.setBundleEnabled.mockClear()

    const activation = await finished(host.lifecycle.begin('activate', next.id))
    expect(activation).toMatchObject({ phase: 'done', application: 'applied' })
    expect(activation.restartRequired).not.toBe(true)
    expect(host.manager.setBundleEnabled.mock.calls).toEqual([[current.package, false], [next.package, true]])
    expect(readProfileBundles(host.directory).sort()).toEqual([next.package, pinned.package].sort())
    expect(readMarketState(host.directory)).toMatchObject({ activeSkinId: next.id, pinnedSkinIds: [pinned.id], disabledSkinIds: [current.id] })
    expect(readMarketState(host.directory).pendingRestart).toBeUndefined()
    expect(host.lifecycle.states().find(state => state.skinId === pinned.id)).toMatchObject({ activation: 'active', pinned: true, primary: false })
    expect(host.lifecycle.states().find(state => state.skinId === next.id)).toMatchObject({ activation: 'active', primary: true })
  })

  it('allows an alpha.3 activation after install requires restart and carries that requirement through applied toggles', async () => {
    const next = skin('alpha3-next'), current = skin('alpha3-current')
    const host = fixture([next, current], { hostVersion: '0.2.1-alpha.3' })
    host.materialize(current)
    host.select(current.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: current.id, disabledSkinIds: [next.id] })
    host.manager.installBundle.mockImplementationOnce(async spec => ({ ...host.applyInstall(spec), application: 'restart-required', restartReason: 'no-hmr' }))

    expect(await finished(host.lifecycle.begin('install', next.id))).toMatchObject({ phase: 'done', application: 'restart-required', restartRequired: true })
    const activation = await finished(host.lifecycle.begin('activate', next.id))
    expect(activation).toMatchObject({ phase: 'done', application: 'applied', restartRequired: true })
    expect(host.manager.setBundleEnabled.mock.calls).toEqual([[current.package, false], [next.package, true]])
    expect(readProfileBundles(host.directory)).toEqual([next.package])
    expect(readMarketState(host.directory)).toMatchObject({ activeSkinId: next.id, disabledSkinIds: [current.id], pendingRestart: { pid: process.pid, skinIds: [next.id] } })
    expect(host.lifecycle.states().find(state => state.skinId === next.id)).toMatchObject({ activation: 'restart-required', primary: true })
  })

  it('keeps an existing primary skin restart requirement visible after an alpha.3 switch reports applied', async () => {
    const next = skin('alpha3-next'), current = skin('alpha3-current')
    const host = fixture([next, current], { hostVersion: '0.2.1-alpha.3' })
    host.materialize(next); host.materialize(current)
    host.select(current.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: current.id, disabledSkinIds: [next.id], pendingRestart: { pid: process.pid, skinIds: [current.id] } })

    expect(await finished(host.lifecycle.begin('activate', next.id))).toMatchObject({ phase: 'done', application: 'applied', restartRequired: true })
    expect(readProfileBundles(host.directory)).toEqual([next.package])
    expect(readMarketState(host.directory)).toMatchObject({ activeSkinId: next.id, disabledSkinIds: [current.id], pendingRestart: { pid: process.pid, skinIds: [current.id, next.id] } })
    expect(host.lifecycle.states().find(state => state.skinId === next.id)).toMatchObject({ activation: 'restart-required', primary: true })
  })

  it.each(['disable', 'enable'] as const)('finishes the alpha.3 selection and preserves a native %s restart requirement through later applied results', async step => {
    const next = skin('alpha3-next'), current = skin('alpha3-current'), pinned = skin('alpha3-pinned')
    const host = fixture([next, current, pinned], { hostVersion: '0.2.1-alpha.3' })
    host.materialize(next); host.materialize(current); host.materialize(pinned)
    host.select(current.package, true); host.select(pinned.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: current.id, disabledSkinIds: [next.id], pinnedSkinIds: [pinned.id] })
    host.manager.setBundleEnabled.mockImplementation(async (name, enabled) => ({
      ...host.applyEnable(name, enabled),
      application: step === 'disable' && name === current.package && !enabled || step === 'enable' && name === next.package && enabled ? 'restart-required' : 'applied',
    }))

    expect(await finished(host.lifecycle.begin('activate', next.id))).toMatchObject({ phase: 'done', application: 'restart-required', restartRequired: true })
    expect(host.manager.setBundleEnabled.mock.calls).toEqual([[current.package, false], [next.package, true]])
    expect(readProfileBundles(host.directory).sort()).toEqual([next.package, pinned.package].sort())
    expect(readMarketState(host.directory)).toMatchObject({ activeSkinId: next.id, disabledSkinIds: [current.id], pinnedSkinIds: [pinned.id], pendingRestart: { pid: process.pid, skinIds: [next.id] } })
    expect(host.lifecycle.states().find(state => state.skinId === next.id)).toMatchObject({ activation: 'restart-required', primary: true })
  })

  it.each(['failed', 'overridden'] as const)('restores the original alpha.3 selection when the target enable is %s after the old skin was disabled', async application => {
    const next = skin('alpha3-next'), current = skin('alpha3-current'), pinned = skin('alpha3-pinned')
    const host = fixture([next, current, pinned], { hostVersion: '0.2.1-alpha.3' })
    host.materialize(next); host.materialize(current); host.materialize(pinned)
    host.select(current.package, true); host.select(pinned.package, true)
    const previous = { version: 1 as const, activeSkinId: current.id, disabledSkinIds: [next.id], pinnedSkinIds: [pinned.id] }
    writeMarketState(host.directory, previous)
    host.manager.setBundleEnabled.mockImplementationOnce(async (name, enabled) => ({ ...host.applyEnable(name, enabled), application: 'restart-required' }))
    host.manager.setBundleEnabled.mockImplementationOnce(async (name, enabled) => ({
      ...host.applyEnable(name, enabled), application,
      ...(application === 'failed' ? { error: { code: 'reload-failed', message: 'target enable failed' } } : {}),
    }))

    expect(await finished(host.lifecycle.begin('activate', next.id))).toMatchObject({ phase: 'failed', application })
    expect(host.manager.setBundleEnabled.mock.calls.slice(0, 2)).toEqual([[current.package, false], [next.package, true]])
    expect(readProfileBundles(host.directory).sort()).toEqual([current.package, pinned.package].sort())
    expect(readMarketState(host.directory)).toMatchObject(previous)
    expect(readMarketState(host.directory).pendingRestart).toMatchObject({ pid: process.pid, skinIds: [current.id, pinned.id, next.id] })
    expect(host.lifecycle.states().find(state => state.skinId === current.id)).toMatchObject({ activation: 'restart-required', primary: true })
    expect(host.lifecycle.states().find(state => state.skinId === next.id)).toMatchObject({ activation: 'restart-required', primary: false })
  })

  it('keeps a failed alpha.3 switch failed when rollback restores the saved selection but itself requires restart', async () => {
    const next = skin('alpha3-next'), current = skin('alpha3-current'), pinned = skin('alpha3-pinned')
    const host = fixture([next, current, pinned], { hostVersion: '0.2.1-alpha.3' })
    host.materialize(next); host.materialize(current); host.materialize(pinned)
    host.select(current.package, true); host.select(pinned.package, true)
    const previous = { version: 1 as const, activeSkinId: current.id, disabledSkinIds: [next.id], pinnedSkinIds: [pinned.id] }
    writeMarketState(host.directory, previous)
    host.manager.setBundleEnabled.mockImplementation(async (name, enabled) => ({
      ...host.applyEnable(name, enabled),
      ...(name === next.package && enabled
        ? { application: 'failed', error: { code: 'reload-failed', message: 'target enable failed' } }
        : name === current.package && enabled ? { application: 'restart-required', restartReason: 'no-hmr' } : {}),
    }))

    const operation = await finished(host.lifecycle.begin('activate', next.id))
    expect(operation).toMatchObject({ phase: 'failed', application: 'failed', restartRequired: true, message: expect.stringContaining('target enable failed') })
    expect(host.manager.setBundleEnabled.mock.calls).toEqual([[current.package, false], [next.package, true], [next.package, false], [current.package, true]])
    expect(readProfileBundles(host.directory).sort()).toEqual([current.package, pinned.package].sort())
    expect(readMarketState(host.directory)).toMatchObject(previous)
    expect(readMarketState(host.directory).pendingRestart).toMatchObject({ pid: process.pid, skinIds: [current.id, pinned.id, next.id] })
    expect(host.lifecycle.states().find(state => state.skinId === current.id)).toMatchObject({ activation: 'restart-required', primary: true })
    expect(host.lifecycle.states().find(state => state.skinId === pinned.id)).toMatchObject({ activation: 'restart-required', pinned: true })
    expect(host.lifecycle.states().find(state => state.skinId === next.id)).toMatchObject({ activation: 'restart-required', primary: false })
  })

  it.each(['failed', 'overridden'] as const)('disables the rejected target before restoring an earlier catalog skin after alpha.3 enable is %s', async application => {
    const current = skin('alpha3-current'), next = skin('alpha3-next')
    const host = fixture([current, next], { hostVersion: '0.2.1-alpha.3' })
    host.materialize(current); host.materialize(next)
    host.select(current.package, true)
    const previous = { version: 1 as const, activeSkinId: current.id, disabledSkinIds: [next.id] }
    writeMarketState(host.directory, previous)
    host.manager.setBundleEnabled.mockImplementation(async (name, enabled) => {
      if (name === current.package && enabled && readProfileBundles(host.directory).includes(next.package)) {
        throw new Error('restoring the old skin while the rejected target is still enabled would overlap skins')
      }
      const result = host.applyEnable(name, enabled)
      return name === next.package && enabled
        ? { ...result, application, ...(application === 'failed' ? { error: { code: 'reload-failed', message: 'target enable failed' } } : {}) }
        : result
    })

    expect(await finished(host.lifecycle.begin('activate', next.id))).toMatchObject({ phase: 'failed', application })
    expect(host.manager.setBundleEnabled.mock.calls).toEqual([[current.package, false], [next.package, true], [next.package, false], [current.package, true]])
    expect(readProfileBundles(host.directory)).toEqual([current.package])
    expect(readMarketState(host.directory)).toMatchObject(previous)
    expect(host.lifecycle.waitingReason).toBeUndefined()
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
    expect(readMarketState(host.directory).pendingRestart).toMatchObject({ pid: process.pid, skinIds: [next.id] })
    expect(host.lifecycle.states().find(state => state.skinId === next.id)).toMatchObject({ activation: 'restart-required', installedVersion: '1.1.0', primary: true })
    await finished(host.lifecycle.begin('uninstall', next.id))
    expect(readMarketState(host.directory).pendingRestart).toBeUndefined()
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
  })

  it('saves an old Host install-and-use selection before restart and replays it without another user action', async () => {
    const item = skin('native-a'), current = skin('native-current'), pinned = skin('native-pinned')
    const host = fixture([item, current, pinned], { hostVersion: '0.2.0-rc.2' })
    host.materialize(current); host.materialize(pinned)
    host.select(current.package, true); host.select(pinned.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: current.id, disabledSkinIds: [item.id], pinnedSkinIds: [pinned.id] })
    const operation = await finished(host.lifecycle.begin('install', item.id))
    expect(operation).toMatchObject({ phase: 'done', application: 'applied', restartRequired: true })
    expect(operation.message).toContain('手动重启 Desktop App')
    expect(readMarketState(host.directory)).toMatchObject({ activeSkinId: current.id, pendingRestart: { pid: process.pid, skinIds: [item.id] } })
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(await finished(host.lifecycle.begin('activate', item.id))).toMatchObject({ phase: 'done', application: 'applied', restartRequired: true })
    expect(host.manager.setBundleEnabled.mock.calls).toEqual([[current.package, false], [item.package, true]])
    // This is already the official on-disk startup selection, before quitting.
    expect(readProfileBundles(host.directory).sort()).toEqual([item.package, pinned.package].sort())
    expect(readMarketState(host.directory)).toMatchObject({ activeSkinId: item.id, disabledSkinIds: [current.id], pinnedSkinIds: [pinned.id] })
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)

    await host.lifecycle.dispose()
    const persisted = readMarketState(host.directory)
    persisted.pendingRestart!.pid = process.pid + 1
    writeMarketState(host.directory, persisted)
    const freshRuntime: DshRuntime = { ...runtime, version: '0.2.0-rc.2' }
    const fresh = new SkinLifecycle({ loader: { entries: () => host.entries.values() } }, {
      profile: 'desktop', profileDir: host.directory, hostKind: 'desktop', runtime: freshRuntime,
      runner: officialDesktopRunner(() => host.manager, freshRuntime), lifecycleWaitMs: 10,
    }, [item, current, pinned])
    lifecycles.push(fresh)
    host.manager.setBundleEnabled.mockClear()
    await fresh.replay()
    expect(readMarketState(host.directory).pendingRestart).toBeUndefined()
    expect(readMarketState(host.directory).activeSkinId).toBe(item.id)
    expect(readProfileBundles(host.directory).sort()).toEqual([item.package, pinned.package].sort())
    expect(fresh.states().find(state => state.skinId === item.id)).toMatchObject({ activation: 'active', primary: true })
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
  })

  it('keeps an old Host repair restart requirement while saving a pin before restart', async () => {
    const item = skin('native-a')
    const host = fixture([item], { hostVersion: '0.2.0-rc.2' })
    host.materialize(item)
    rmSync(packageDir(host.directory, item.package), { recursive: true, force: true })
    host.manager.installBundle.mockImplementationOnce(async spec => ({ ...host.applyInstall(spec), application: 'applied' }))
    const operation = await finished(host.lifecycle.begin('install', item.id))
    expect(operation).toMatchObject({ phase: 'done', application: 'applied', restartRequired: true })
    expect(operation.message).toContain('构件已修复')
    expect(readMarketState(host.directory).pendingRestart).toMatchObject({ pid: process.pid, skinIds: [item.id] })
    expect(await finished(host.lifecycle.begin('pin', item.id))).toMatchObject({ phase: 'done', application: 'applied', restartRequired: true })
    expect(host.manager.installBundle).toHaveBeenCalledTimes(1)
    expect(host.manager.setBundleEnabled).toHaveBeenCalledExactlyOnceWith(item.package, true)
    expect(readProfileBundles(host.directory)).toEqual([item.package])
    expect(readMarketState(host.directory).pinnedSkinIds).toEqual([item.id])
    expect(readFileSync(profilePatchFile(host.directory), 'utf8')).toBe(host.originalPatch)
  })

  it('retains a fully saved old Host selection when only the newly installed target cannot import yet', async () => {
    const item = skin('native-new'), current = skin('native-current'), pinned = skin('native-pinned')
    const host = fixture([item, current, pinned], { hostVersion: '0.2.0-rc.2' })
    host.materialize(current); host.materialize(pinned)
    host.select(current.package, true); host.select(pinned.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: current.id, disabledSkinIds: [item.id], pinnedSkinIds: [pinned.id] })
    await finished(host.lifecycle.begin('install', item.id))
    const diagnostic = `dsh: warning: 1 entry did not activate\n${item.rowId} (${item.package}): failed to import`
    host.manager.setBundleEnabled.mockImplementation(async (name, enabled) => {
      const result = host.applyEnable(name, enabled)
      if (name !== item.package || !enabled) return result
      host.entries.get(name)!.fiber = undefined
      return { ...result, application: 'failed', error: { code: 'operation-error', diagnostic } }
    })
    const operation = await finished(host.lifecycle.begin('activate', item.id))
    expect(operation).toMatchObject({ phase: 'done', application: 'restart-required', restartRequired: true })
    expect(operation.message).toContain('启停选择已保存，目标当前未加载；请手动重启 Desktop App')
    expect(operation.message).toContain(diagnostic)
    expect(readProfileBundles(host.directory).sort()).toEqual([item.package, pinned.package].sort())
    expect(readMarketState(host.directory)).toMatchObject({ activeSkinId: item.id, pinnedSkinIds: [pinned.id], disabledSkinIds: [current.id] })
    expect(host.lifecycle.states().find(state => state.skinId === item.id)).toMatchObject({ activation: 'restart-required', primary: true })
    // Refresh/replay in the current process must not repeat the failed import.
    host.manager.setBundleEnabled.mockClear()
    await host.lifecycle.replay()
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()

    await host.lifecycle.dispose()
    const state = readMarketState(host.directory)
    state.pendingRestart!.pid = process.pid + 1
    writeMarketState(host.directory, state)
    // A fresh Host starts the already selected target from its on-disk bundle.
    host.materialize(item)
    const fresh = new SkinLifecycle({ loader: { entries: () => host.entries.values() } }, {
      profile: 'desktop', profileDir: host.directory, hostKind: 'desktop', runtime: host.runtime,
      runner: host.runner, lifecycleWaitMs: 10,
    }, [item, current, pinned])
    lifecycles.push(fresh)
    await fresh.replay()
    expect(readMarketState(host.directory).pendingRestart).toBeUndefined()
    expect(readMarketState(host.directory).activeSkinId).toBe(item.id)
    expect(fresh.states().find(state => state.skinId === item.id)).toMatchObject({ activation: 'active', primary: true })
    expect(readProfileBundles(host.directory).sort()).toEqual([item.package, pinned.package].sort())
    expect(host.manager.setBundleEnabled).not.toHaveBeenCalled()
  })

  it.each([
    'initialization failure', 'missing service', 'another row', 'multiple rows',
    'selection not saved', 'old skin still selected', 'unreviewed source', 'missing entry file',
  ])('rolls back an old Host import failure rather than accepting %s as a saved restart transition', async reason => {
    const item = skin('native-new'), current = skin('native-current')
    const host = fixture([item, current], { hostVersion: '0.2.0-rc.2' })
    host.materialize(current); host.select(current.package, true)
    writeMarketState(host.directory, { version: 1, activeSkinId: current.id, disabledSkinIds: [item.id] })
    await finished(host.lifecycle.begin('install', item.id))
    let diagnostic = `dsh: warning: 1 entry did not activate\n${item.rowId} (${item.package}): failed to import`
    if (reason === 'initialization failure') diagnostic = diagnostic.replace('failed to import', 'Error: plugin initialization failed')
    if (reason === 'missing service') diagnostic = diagnostic.replace('failed to import', 'pending (waiting for service: requiredService)')
    if (reason === 'another row') diagnostic = diagnostic.replace(item.rowId, 'unrelated-row')
    if (reason === 'multiple rows') diagnostic = diagnostic.replace('1 entry', '2 entries') + '\nunrelated-row (unrelated-package): failed to import'
    if (reason === 'unreviewed source') {
      const manifest = JSON.parse(readFileSync(join(host.directory, 'package.json'), 'utf8'))
      manifest.dependencies[item.package] = 'github:unreviewed/other#' + 'b'.repeat(40)
      atomicWriteJson(join(host.directory, 'package.json'), manifest)
    }
    if (reason === 'missing entry file') rmSync(join(packageDir(host.directory, item.package), 'lib/index.js'))
    host.manager.setBundleEnabled.mockImplementation(async (name, enabled) => {
      if (reason === 'old skin still selected' && name === current.package && !enabled) return { application: 'applied', changed: false }
      if (reason !== 'selection not saved' || name !== item.package || !enabled) host.applyEnable(name, enabled)
      return name === item.package && enabled
        ? { application: 'failed', changed: true, stage: 'enable', target: name, enabled, error: { code: 'operation-error', diagnostic } }
        : { application: 'applied', changed: true, stage: 'enable', target: name, enabled }
    })
    expect(await finished(host.lifecycle.begin('activate', item.id))).toMatchObject({ phase: 'failed', application: 'failed' })
    expect(readMarketState(host.directory).activeSkinId).toBe(current.id)
    expect(readProfileBundles(host.directory)).toEqual([current.package])
  })

  it.each(['applied', 'failed'] as const)('holds further writes while a delayed native enable is pending, then accepts its late %s result once', async application => {
    const a = skin('native-a'), b = skin('native-b')
    const host = fixture([a, b])
    host.materialize(a); host.materialize(b)
    const result = deferred()
    host.manager.setBundleEnabled.mockImplementation(async (name, enabled) => name === a.package && enabled ? result.promise : host.applyEnable(name, enabled))
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
