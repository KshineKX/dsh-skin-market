import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkinLifecycle } from '../src/lifecycle.ts'
import { atomicWriteJson, atomicWriteText, marketStateFile, profilePatchFile, readMarketState, readProfileBundles, writeMarketState } from '../src/profile.ts'
import type { LoaderEntry, Operation, SkinEntry } from '../src/types.ts'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function testSkin(id: string): SkinEntry {
  const commit = 'a'.repeat(40)
  return {
    id, package: id, rowId: id, author: 'fixture', name: { zh: id, en: id }, description: 'Loader lifecycle fixture',
    repo: `https://github.com/example/${id}`, install: { target: `github:example/${id}#${commit}`, version: '1.0.0', commit },
    compatibility: { dsh: '>=0.1.0-rc.6', platform: ['web'] }, category: 'theme', tags: [], modes: ['dark'], screenshots: [],
    license: { code: 'MIT', commercialUse: true }, featuredRank: 0, starsSnapshot: 0,
    releaseUpdatedAt: '2026-10-14T00:00:00Z', metadataUpdatedAt: '2026-10-14T00:00:00Z', starsUpdatedAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z',
  }
}

const fixtures: Array<{ directory: string; lifecycle: SkinLifecycle; pending: ReturnType<typeof deferred> }> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.pending.resolve()
    await fixture.lifecycle.dispose()
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'market-loader-waiting-'))
  const skin = testSkin('waiting-skin')
  const other = testSkin('other-skin')
  atomicWriteJson(join(directory, 'package.json'), { dependencies: { [skin.package]: skin.install.target } })
  atomicWriteText(profilePatchFile(directory), '[]\n')
  writeMarketState(directory, { version: 1, activeSkinId: null, disabledSkinIds: [skin.id, other.id] })
  const packageDir = join(directory, 'node_modules', skin.package)
  mkdirSync(packageDir, { recursive: true })
  // This is a real installed bundle fixture, without a browser boot graph that
  // would force restart instead of exercising the Host Loader update.
  atomicWriteJson(join(packageDir, 'package.json'), { name: skin.package, version: skin.install.version, dsh: { bundle: { patch: './cordis.patch.yml' }, client: {} } })
  atomicWriteText(join(packageDir, 'cordis.patch.yml'), `- insert:\n    - id: ${skin.rowId}\n      name: ${skin.package}\n`)
  const pending = deferred()
  let first = true
  const entry: LoaderEntry = {
    options: { id: skin.rowId, name: skin.package, disabled: true },
    update: vi.fn(async value => {
      if (first) { first = false; await pending.promise }
      entry.options.disabled = value.disabled
      entry.fiber = value.disabled === true ? undefined : {}
    }),
  }
  const runner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))
  const lifecycle = new SkinLifecycle({ loader: { entries: () => [entry] } }, {
    profile: 'web', profileDir: directory, hostKind: 'dsh', runner, lifecycleWaitMs: 10,
  }, [skin, other])
  fixtures.push({ directory, lifecycle, pending })
  const files = () => Object.fromEntries([join(directory, 'package.json'), profilePatchFile(directory), marketStateFile(directory)].map(file => [file, readFileSync(file, 'utf8')]))
  return { directory, skin, other, pending, entry, runner, lifecycle, files }
}

async function phase(operation: Operation, expected: Operation['phase']): Promise<void> {
  await vi.waitFor(() => expect(operation.phase).toBe(expected), { interval: 2, timeout: 500 })
}

describe('Web Loader soft waiting', () => {
  it('keeps a delayed update nonterminal, blocks another skin mutation and permits state reads until it resolves once', async () => {
    const f = fixture()
    const operation = f.lifecycle.begin('activate', f.skin.id)
    await phase(operation, 'waiting')
    expect(operation.finishedAt).toBeUndefined()
    expect(f.lifecycle.waitingReason).toContain('结果尚未确认')
    expect(f.lifecycle.currentOperation()).toBe(operation)
    expect(f.lifecycle.currentOperations()).toContain(operation)
    expect(() => f.lifecycle.begin('deactivate', f.other.id)).toThrow('暂时不能继续修改')
    expect(f.lifecycle.states().find(state => state.skinId === f.skin.id)).toMatchObject({ installation: 'installed' })
    expect(f.entry.update).toHaveBeenCalledTimes(1)
    expect(f.runner).not.toHaveBeenCalled()

    f.pending.resolve()
    await phase(operation, 'done')
    expect(f.lifecycle.waitingReason).toBeUndefined()
    expect(readMarketState(f.directory).activeSkinId).toBe(f.skin.id)
    expect(f.lifecycle.states().find(state => state.skinId === f.skin.id)).toMatchObject({ activation: 'active' })
    const finishedAt = operation.finishedAt
    const files = f.files()
    f.pending.resolve()
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(operation.finishedAt).toBe(finishedAt)
    expect(f.files()).toEqual(files)
    expect(f.entry.update).toHaveBeenCalledTimes(1)
    await phase(f.lifecycle.begin('deactivate', f.skin.id), 'done')
  })

  it('waits for a late rejection before rollback, then reports failure once and unblocks later operations', async () => {
    const f = fixture()
    const before = f.files()
    const operation = f.lifecycle.begin('activate', f.skin.id)
    await phase(operation, 'waiting')
    const pendingFiles = f.files()
    expect(pendingFiles).not.toEqual(before)
    expect(readProfileBundles(f.directory)).toContain(f.skin.package)
    expect(readMarketState(f.directory).activeSkinId).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(f.files()).toEqual(pendingFiles)
    expect(operation.phase).toBe('waiting')
    expect(f.entry.update).toHaveBeenCalledTimes(1)

    f.pending.reject(new Error('late loader failure'))
    await phase(operation, 'failed')
    expect(operation.message).toContain('late loader failure')
    expect(f.lifecycle.waitingReason).toBeUndefined()
    expect(readProfileBundles(f.directory)).not.toContain(f.skin.package)
    expect(readMarketState(f.directory).activeSkinId).toBeNull()
    const settledFiles = f.files()
    const finishedAt = operation.finishedAt
    f.pending.reject(new Error('duplicate rejection'))
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(f.files()).toEqual(settledFiles)
    expect(operation.finishedAt).toBe(finishedAt)
    expect(f.entry.update).toHaveBeenCalledTimes(1)
    await phase(f.lifecycle.begin('deactivate', f.skin.id), 'done')
  })

  it.each(['resolve', 'reject'] as const)('bounds disposal without writing rollback or follow-up state after a late %s', async outcome => {
    const f = fixture()
    const operation = f.lifecycle.begin('activate', f.skin.id)
    await phase(operation, 'waiting')
    const pendingFiles = f.files()
    // Disposal must finish despite an unresolved Loader promise; the fixture's
    // configured 10 ms budget supplies the bounded join, without cancelling
    // the Host's promise or pretending it already settled.
    await f.lifecycle.dispose()
    expect(f.files()).toEqual(pendingFiles)
    expect(() => f.lifecycle.begin('deactivate', f.skin.id)).toThrow('宿主已停止')
    if (outcome === 'resolve') f.pending.resolve()
    else f.pending.reject(new Error('loader rejected after disposal'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.files()).toEqual(pendingFiles)
    expect(f.entry.update).toHaveBeenCalledTimes(1)
    expect(f.runner).not.toHaveBeenCalled()
    expect(operation.phase).not.toBe('done')
  })

  it('does not convert a cancellation attempt during an unresolved Loader update into a terminal operation', async () => {
    const f = fixture()
    const operation = f.lifecycle.begin('activate', f.skin.id)
    await phase(operation, 'waiting')
    expect(operation.cancelable).toBe(false)
    expect(() => f.lifecycle.cancel(operation.id)).toThrow('无法安全取消')
    expect(operation.phase).toBe('waiting')
    expect(operation.finishedAt).toBeUndefined()
    expect(f.lifecycle.waitingReason).toBeDefined()
    f.pending.resolve()
    await phase(operation, 'done')
    expect(f.lifecycle.waitingReason).toBeUndefined()
    expect(f.entry.update).toHaveBeenCalledTimes(1)
  })
})
