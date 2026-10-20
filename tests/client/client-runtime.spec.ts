import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({}))
vi.mock('../../src/client/SkinMarketSection.tsx', () => ({ SkinMarketSection: () => null }))

import { createClientSkinRuntime, probeClientSkinSelection, type ClientSkinActivity } from '../../src/client/index.ts'

describe('browser selection verification', () => {
  it('checks the target, preserved plugins, companions and the skin being stopped', () => {
    const phases: Record<string, ClientSkinActivity> = { target: 'active', pinned: 'active', companion: 'active', previous: 'disabled' }
    const probeActive = vi.fn((name: string) => phases[name] ?? 'missing')
    const expected = [
      { package: 'target', active: true }, { package: 'pinned', active: true },
      { package: 'companion', active: true }, { package: 'previous', active: false },
    ]
    const runtime = { setActive: vi.fn(), probeActive, probeSyncing: () => false }
    expect(probeClientSkinSelection(runtime, expected)).toEqual({ status: 'applied' })
    expect(probeActive.mock.calls.map(([name]) => name)).toEqual(['target', 'pinned', 'companion', 'previous'])
    phases.previous = 'active'
    expect(probeClientSkinSelection(runtime, expected)).toEqual({ status: 'restart-required', package: 'previous', activity: 'active' })
    phases.previous = 'missing'
    phases.companion = 'loading'
    expect(probeClientSkinSelection(runtime, expected)).toEqual({ status: 'switching', package: 'companion', activity: 'loading' })
    phases.companion = 'active'
    phases.pinned = 'failed'
    expect(probeClientSkinSelection(runtime, expected)).toEqual({ status: 'unavailable', package: 'pinned', activity: 'failed' })
    expect(runtime.setActive).not.toHaveBeenCalled()
  })

  it.each(['missing', 'disabled'] as const)('confirms a stopped plugin when it is %s', activity => {
    expect(probeClientSkinSelection({ setActive: vi.fn(), probeActive: () => activity, probeSyncing: () => false }, [{ package: 'old', active: false }])).toEqual({ status: 'applied' })
  })

  it('does not confuse an accepted loader update with a running client module', async () => {
    const runtime = createClientSkinRuntime({ entries: () => [{ options: { name: 'target' }, fiber: { state: 1 }, update: vi.fn(async () => undefined) }] })
    await expect(runtime.setActive('target', true)).resolves.toBe(true)
    expect(probeClientSkinSelection(runtime, [{ package: 'target', active: true }])).toEqual({ status: 'switching', package: 'target', activity: 'loading' })
  })

  it('contains missing, throwing and contradictory probes without reporting success', () => {
    expect(probeClientSkinSelection({ setActive: vi.fn() }, [{ package: 'skin', active: true }])).toEqual({ status: 'unavailable', package: 'skin', activity: 'unknown' })
    expect(probeClientSkinSelection({ setActive: vi.fn(), probeActive: () => { throw new Error('unavailable') } }, [{ package: 'skin', active: true }])).toEqual({ status: 'unavailable', package: 'skin', activity: 'unknown' })
    expect(probeClientSkinSelection({ setActive: vi.fn(), probeActive: () => 'active' }, [{ package: 'skin', active: true }, { package: 'skin', active: false }])).toEqual({ status: 'unavailable', package: 'skin', activity: 'unknown' })
  })

  it('waits for the module graph after an old entry leaves the roster', () => {
    let syncing: boolean | undefined = true
    const runtime = { setActive: vi.fn(), probeActive: () => 'missing' as const, probeSyncing: () => syncing }
    const expected = [{ package: 'old', active: false }]
    expect(probeClientSkinSelection(runtime, expected)).toEqual({ status: 'switching', activity: 'loading' })
    syncing = undefined
    expect(probeClientSkinSelection(runtime, expected)).toEqual({ status: 'unavailable', package: 'old', activity: 'unknown' })
    syncing = false
    expect(probeClientSkinSelection(runtime, expected)).toEqual({ status: 'applied' })
  })
})

describe('read-only browser skin activity probe', () => {
  it('reads a real Cordis active fiber by browser package identity without updating its loader entry', async () => {
    const root = new Context()
    const fiber = root.plugin({ apply() {} })
    await fiber.await()
    const update = vi.fn(async () => undefined)
    const entry = { options: { name: 'dsh-ui-skin-orca' }, fiber, update }
    const runtime = createClientSkinRuntime({ entries: () => [entry] })
    try {
      expect(runtime.probeActive!('dsh-ui-skin-orca')).toBe('active')
      expect(runtime.probeActive!('ui-skin-orca-link')).toBe('missing')
      expect(update).not.toHaveBeenCalled()
    } finally { await fiber.dispose() }
    expect(runtime.probeActive!('dsh-ui-skin-orca')).toBe('unknown')
  })

  it.each([
    [0, 'pending'], [1, 'loading'], [2, 'active'], [3, 'failed'],
    [4, 'unknown'], [5, 'loading'], [42, 'unknown'], [undefined, 'unknown'],
  ] as const)('reports the pinned fiber state %s conservatively as %s', (state, expected) => {
    const update = vi.fn(async () => undefined)
    const runtime = createClientSkinRuntime({ entries: () => [{ options: { name: 'skin' }, fiber: { state }, update }] })
    expect(runtime.probeActive!('skin')).toBe(expected)
    expect(update).not.toHaveBeenCalled()
  })

  it.each(['entry', 'options'] as const)('confirms explicit %s disablement after the old fiber has disposed', source => {
    const update = vi.fn(async () => undefined)
    const runtime = createClientSkinRuntime({ entries: () => [{ options: { name: 'skin', disabled: source === 'options' }, disabled: source === 'entry', fiber: { state: 4 }, update }] })
    expect(runtime.probeActive!('skin')).toBe('disabled')
    expect(update).not.toHaveBeenCalled()
  })

  it.each([1, 2, 5])('does not call a disabled entry stopped while its old fiber is still live (%s)', state => {
    const runtime = createClientSkinRuntime({ entries: () => [{ options: { name: 'skin', disabled: true }, fiber: { state }, update: vi.fn() }] })
    expect(runtime.probeActive!('skin')).toBe('loading')
  })

  it.each([[0, 'pending'], [3, 'failed'], [42, 'unknown']] as const)('preserves an unresolved disabled fiber state (%s)', (state, expected) => {
    const runtime = createClientSkinRuntime({ entries: () => [{ options: { name: 'skin', disabled: true }, fiber: { state }, update: vi.fn() }] })
    expect(runtime.probeActive!('skin')).toBe(expected)
  })

  it('reads and observes the module graph settling independently of fiber status', () => {
    let syncing = true
    let changed!: () => void
    const dispose = vi.fn()
    const get = vi.fn((name: string) => name === 'modules' ? { entries: { state: {
      getSnapshot: () => ({ syncing }), subscribe: (listener: () => void) => { changed = listener; return dispose },
    } } } : undefined)
    const runtime = createClientSkinRuntime({ entries: () => [] }, { get })
    const listener = vi.fn()
    const unsubscribe = runtime.observe!(listener)
    expect(runtime.probeSyncing!()).toBe(true)
    syncing = false
    changed()
    expect(runtime.probeSyncing!()).toBe(false)
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    changed()
    expect(listener).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect(createClientSkinRuntime({ entries: () => [] }).probeSyncing!()).toBeUndefined()
  })

  it('reports absent and ambiguous entries separately, and contains host lookup failures', () => {
    const entry = { options: { name: 'skin' }, update: vi.fn(async () => undefined) }
    expect(createClientSkinRuntime({ entries: () => [] }).probeActive!('skin')).toBe('missing')
    expect(createClientSkinRuntime({ entries: () => [entry, entry] }).probeActive!('skin')).toBe('unknown')
    expect(createClientSkinRuntime({ entries: () => { throw new Error('loader unavailable') } }).probeActive!('skin')).toBe('unknown')
    expect(entry.update).not.toHaveBeenCalled()
  })

  it('notifies on fiber status changes and releases the view subscription once', () => {
    let statusChanged: (() => void) | undefined
    const dispose = vi.fn()
    const on = vi.fn((_event: 'internal/status', listener: () => void) => { statusChanged = listener; return dispose })
    const listener = vi.fn()
    const runtime = createClientSkinRuntime({ entries: () => [] }, { on })
    const unsubscribe = runtime.observe!(listener)
    expect(on).toHaveBeenCalledWith('internal/status', expect.any(Function))
    statusChanged!()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    unsubscribe()
    statusChanged!()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('lets the real Cordis plugin lifecycle clean up its status listener', async () => {
    const root = new Context()
    const listener = vi.fn()
    const market = root.plugin({ apply(ctx: Context) { createClientSkinRuntime({ entries: () => [] }, ctx).observe!(listener) } })
    await market.await()
    const skin = root.plugin({ apply() {} })
    await skin.await()
    expect(listener).toHaveBeenCalled()
    await market.dispose()
    const callsAfterDisposal = listener.mock.calls.length
    await skin.restart()
    expect(listener).toHaveBeenCalledTimes(callsAfterDisposal)
    await skin.dispose()
  })
})
