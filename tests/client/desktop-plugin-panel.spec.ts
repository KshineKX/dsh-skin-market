import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createDesktopPluginPanel, type DesktopPluginPanelContext } from '../../src/client/desktop-plugin-panel.ts'

interface Snapshot {
  status: string
  install: { phase: string; open: boolean; spec: string; requestId?: string; enabling?: boolean }
}

function officialPanel(initial: Partial<Snapshot> = {}) {
  let state: Snapshot = { status: 'ready', install: { phase: 'idle', open: false, spec: '' }, ...initial }
  const listeners = new Set<() => void>()
  const publish = (update: Partial<Snapshot>) => { state = { ...state, ...update }; for (const listener of listeners) listener() }
  const store = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  // Match the official registration shape and its important openInstall rule:
  // opening without a request id starts an empty form, even during checking.
  const face = {
    hooks: { pluginManager: store },
    ensure: vi.fn(),
    openInstall: vi.fn(() => publish({ install: state.install.requestId === undefined
      ? { phase: 'idle', open: true, spec: '' }
      : { ...state.install, open: true } })),
    editInstallSpec: vi.fn((spec: string) => publish({ install: { phase: 'idle', open: true, spec } })),
    runInstall: vi.fn(),
  }
  const entry = { options: { key: 'plugins' }, inject: () => face, component: () => null }
  let winners: unknown[] = [entry]
  const ctx = {
    layout: { selectPanel: vi.fn() },
    slots: {
      entriesOfSlot: vi.fn((_name: string) => winners),
      // The adapter must select the winner, not a shadowed raw registration.
      entries: vi.fn(() => [{ options: { key: 'plugins' }, inject: () => { throw new Error('shadowed entry') } }, entry]),
    },
  }
  return { ctx, face, entry, publish, state: () => state, listeners, setWinners: (value: unknown[]) => { winners = value } }
}

afterEach(() => vi.useRealTimers())

describe('official Desktop add-plugin panel bridge', () => {
  it('uses optional layout lookup in a real Cordis plugin with the market’s injection boundary', async () => {
    const panel = officialPanel()
    const root = new Context()
    // DSH provides layout from a sibling plugin, not the root or market fiber.
    // Providing it on the root would incorrectly let the old direct read pass.
    const host = root.plugin({
      apply(ctx: Context) {
        ctx.provide('layout', panel.ctx.layout)
        ctx.provide('slots', panel.ctx.slots)
        ctx.provide('locale', {})
        ctx.provide('loader', {})
      },
    })
    await host.await()
    let marketContext: Context | undefined
    const market = root.plugin({
      inject: ['slots', 'locale', 'loader'],
      apply(ctx: Context) { marketContext = ctx },
    })
    try {
      await market.await()
      const ctx = marketContext as Context & DesktopPluginPanelContext
      // This is the production failure that the earlier plain-object fixture
      // missed: optional chaining cannot prevent this service getter throwing.
      expect(() => ctx.layout?.selectPanel).toThrow('cannot get property "layout" without inject')
      const bridge = createDesktopPluginPanel(ctx)
      expect(bridge.available()).toBe(true)
      await expect(bridge.open('https://github.com/example/skin.git#abc')).resolves.toEqual({ ok: true, kind: 'prefilled' })
      expect(panel.state().install.spec).toBe('https://github.com/example/skin.git#abc')
      expect(panel.ctx.layout.selectPanel).toHaveBeenCalledWith('plugins')
      expect(panel.face.runInstall).not.toHaveBeenCalled()
    } finally {
      await market.dispose()
      await host.dispose()
    }
  })

  it('leaves the market usable when an old Cordis host has no layout provider', async () => {
    const panel = officialPanel()
    const root = new Context()
    const host = root.plugin({ apply(ctx: Context) { ctx.provide('slots', panel.ctx.slots) } })
    await host.await()
    let marketContext: Context | undefined
    const market = root.plugin({ inject: ['slots'], apply(ctx: Context) { marketContext = ctx } })
    try {
      await market.await()
      const bridge = createDesktopPluginPanel(marketContext as Context & DesktopPluginPanelContext)
      expect(bridge.available()).toBe(false)
      await expect(bridge.open('skin')).resolves.toMatchObject({ ok: false })
      expect(panel.face.openInstall).not.toHaveBeenCalled()
    } finally {
      await market.dispose()
      await host.dispose()
    }
  })

  it('uses the winning main entry to open and prefill the existing official form without submitting it', async () => {
    const panel = officialPanel()
    const bridge = createDesktopPluginPanel(panel.ctx)
    expect(bridge.available()).toBe(true)
    await expect(bridge.open('  https://github.com/example/skin.git#abc  ')).resolves.toEqual({ ok: true, kind: 'prefilled' })
    expect(panel.ctx.layout.selectPanel).toHaveBeenCalledWith('plugins')
    expect(panel.ctx.slots.entriesOfSlot).toHaveBeenCalledWith('main')
    expect(panel.ctx.slots.entries).not.toHaveBeenCalled()
    expect(panel.state().install).toMatchObject({ open: true, phase: 'idle', spec: 'https://github.com/example/skin.git#abc' })
    expect(panel.face.runInstall).not.toHaveBeenCalled()
  })

  it('waits for the official inventory to load, then releases its subscription', async () => {
    const panel = officialPanel({ status: 'idle' })
    panel.face.ensure.mockImplementation(() => panel.publish({ status: 'loading' }))
    const opening = createDesktopPluginPanel(panel.ctx).open('skin@1.2.3')
    expect(panel.face.openInstall).not.toHaveBeenCalled()
    expect(panel.ctx.layout.selectPanel).not.toHaveBeenCalled()
    expect(panel.listeners.size).toBe(1)
    panel.publish({ status: 'ready' })
    await expect(opening).resolves.toEqual({ ok: true, kind: 'prefilled' })
    expect(panel.listeners.size).toBe(0)
    expect(panel.ctx.layout.selectPanel).toHaveBeenCalledWith('plugins')
  })

  it.each(['unavailable', 'error'])('returns a usable fallback when the official inventory is %s', async status => {
    const panel = officialPanel({ status })
    await expect(createDesktopPluginPanel(panel.ctx).open('skin')).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('未能加载') })
    expect(panel.face.openInstall).not.toHaveBeenCalled()
    expect(panel.ctx.layout.selectPanel).not.toHaveBeenCalled()
  })

  it('times out an inventory read without retaining a subscription or opening an empty form', async () => {
    vi.useFakeTimers()
    const panel = officialPanel({ status: 'loading' })
    const opening = createDesktopPluginPanel(panel.ctx, { readyTimeoutMs: 100 }).open('skin')
    await vi.advanceTimersByTimeAsync(100)
    await expect(opening).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('未能加载') })
    expect(panel.listeners.size).toBe(0)
    expect(panel.face.openInstall).not.toHaveBeenCalled()
    expect(panel.ctx.layout.selectPanel).not.toHaveBeenCalled()
  })

  it('retains a visible checking operation without invoking the official form-reset method', async () => {
    const install = { phase: 'checking', open: true, spec: 'existing-skin' }
    const panel = officialPanel({ install })
    await expect(createDesktopPluginPanel(panel.ctx).open('new-skin')).resolves.toEqual({ ok: true, kind: 'resumed' })
    expect(panel.state().install).toBe(install)
    expect(panel.face.openInstall).not.toHaveBeenCalled()
    expect(panel.face.editInstallSpec).not.toHaveBeenCalled()
  })

  it.each(['starting', 'running', 'installing', 'cancelling', 'applying', 'unconfirmed', 'indeterminate'])(
    'reopens the existing %s request and keeps its original input', async phase => {
      const panel = officialPanel({ install: { phase, open: false, spec: 'existing-skin', requestId: 'existing-request' } })
      await expect(createDesktopPluginPanel(panel.ctx).open('new-skin')).resolves.toEqual({ ok: true, kind: 'resumed' })
      expect(panel.state().install).toEqual({ phase, open: true, spec: 'existing-skin', requestId: 'existing-request' })
      expect(panel.face.editInstallSpec).not.toHaveBeenCalled()
      expect(panel.face.runInstall).not.toHaveBeenCalled()
    },
  )

  it.each(['checking', 'running', 'future-active-phase'])('does not reset a hidden %s task without an id', async phase => {
    const install = { phase, open: false, spec: 'existing-skin' }
    const panel = officialPanel({ install })
    await expect(createDesktopPluginPanel(panel.ctx).open('new-skin')).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('另一项任务') })
    expect(panel.state().install).toBe(install)
    expect(panel.face.openInstall).not.toHaveBeenCalled()
    expect(panel.face.editInstallSpec).not.toHaveBeenCalled()
  })

  it('keeps the user’s different visible draft', async () => {
    const install = { phase: 'idle', open: true, spec: 'user-entered-skin@2.0.0' }
    const panel = officialPanel({ install })
    await expect(createDesktopPluginPanel(panel.ctx).open('market-skin')).resolves.toEqual({ ok: true, kind: 'resumed' })
    expect(panel.state().install).toBe(install)
    expect(panel.face.openInstall).not.toHaveBeenCalled()
    expect(panel.face.editInstallSpec).not.toHaveBeenCalled()
  })

  it('fills an already open empty form without resetting its registry selection', async () => {
    const panel = officialPanel({ install: { phase: 'idle', open: true, spec: '' } })
    await expect(createDesktopPluginPanel(panel.ctx).open('market-skin')).resolves.toEqual({ ok: true, kind: 'prefilled' })
    expect(panel.face.openInstall).not.toHaveBeenCalled()
    expect(panel.face.editInstallSpec).toHaveBeenCalledWith('market-skin')
  })

  it.each(['done', 'failed', 'unknown'])('starts a new form after the completed %s outcome', async phase => {
    const panel = officialPanel({ install: { phase, open: true, spec: 'previous-skin', requestId: 'settled-request' } })
    await expect(createDesktopPluginPanel(panel.ctx).open('next-skin')).resolves.toEqual({ ok: true, kind: 'prefilled' })
    expect(panel.state().install).toEqual({ phase: 'idle', open: true, spec: 'next-skin' })
    expect(panel.face.runInstall).not.toHaveBeenCalled()
  })

  it('protects a completed installation that is still enabling', async () => {
    const panel = officialPanel({ install: { phase: 'done', open: true, spec: 'previous-skin', enabling: true } })
    await expect(createDesktopPluginPanel(panel.ctx).open('next-skin')).resolves.toEqual({ ok: true, kind: 'resumed' })
    expect(panel.face.openInstall).not.toHaveBeenCalled()
    expect(panel.face.editInstallSpec).not.toHaveBeenCalled()
  })

  it('protects a request that begins while the initial inventory read is pending', async () => {
    const panel = officialPanel({ status: 'loading' })
    const opening = createDesktopPluginPanel(panel.ctx).open('new-skin')
    panel.publish({ status: 'ready', install: { phase: 'running', open: false, spec: 'other-skin', requestId: 'other-request' } })
    await expect(opening).resolves.toEqual({ ok: true, kind: 'resumed' })
    expect(panel.state().install.spec).toBe('other-skin')
    expect(panel.face.editInstallSpec).not.toHaveBeenCalled()
  })

  it('coalesces simultaneous clicks for the same input and rejects a competing input without overriding it', async () => {
    const panel = officialPanel({ status: 'loading' })
    const bridge = createDesktopPluginPanel(panel.ctx)
    const first = bridge.open('first-skin')
    const doubleClick = bridge.open('first-skin')
    expect(doubleClick).toBe(first)
    await expect(bridge.open('different-skin')).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('正在打开') })
    expect(panel.face.ensure).toHaveBeenCalledTimes(1)
    panel.publish({ status: 'ready' })
    await expect(first).resolves.toEqual({ ok: true, kind: 'prefilled' })
    expect(panel.face.editInstallSpec).toHaveBeenCalledExactlyOnceWith('first-skin')
    expect(panel.ctx.layout.selectPanel).toHaveBeenCalledTimes(1)
    // The guard releases after completion; later clicks may open another form.
    panel.publish({ install: { phase: 'done', open: true, spec: 'first-skin' } })
    await expect(bridge.open('later-skin')).resolves.toEqual({ ok: true, kind: 'prefilled' })
  })

  it('abandons a controller replaced during loading', async () => {
    const panel = officialPanel({ status: 'loading' })
    const opening = createDesktopPluginPanel(panel.ctx).open('skin')
    panel.setWinners([{ ...panel.entry }])
    panel.publish({ status: 'ready' })
    await expect(opening).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('重新加载') })
    expect(panel.face.openInstall).not.toHaveBeenCalled()
    expect(panel.face.editInstallSpec).not.toHaveBeenCalled()
  })

  it.each([
    { slots: {} },
    { layout: { selectPanel: () => undefined }, slots: {} },
    { layout: { selectPanel: () => undefined }, slots: { entriesOfSlot: () => [{ options: { key: 'plugins', inject: () => ({}) } }] } },
    { layout: { selectPanel: () => undefined }, slots: { entriesOfSlot: () => [{ options: { key: 'plugins' }, inject: () => ({}) }] } },
  ] satisfies DesktopPluginPanelContext[])('degrades safely when the expected registration contract is absent', async ctx => {
    const bridge = createDesktopPluginPanel(ctx)
    expect(bridge.available()).toBe(false)
    await expect(bridge.open('skin')).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('请重试') })
  })

  it('rechecks the winner after the capability probe and catches unexpected host failures', async () => {
    const panel = officialPanel()
    const bridge = createDesktopPluginPanel(panel.ctx)
    expect(bridge.available()).toBe(true)
    panel.setWinners([])
    await expect(bridge.open('skin')).resolves.toMatchObject({ ok: false })
    expect(panel.face.openInstall).not.toHaveBeenCalled()
    panel.setWinners([panel.entry])
    panel.ctx.layout.selectPanel.mockImplementation(() => { throw new Error('host unavailable') })
    await expect(bridge.open('skin')).resolves.toMatchObject({ ok: false })
    expect(panel.state().install.spec).toBe('skin')
    expect(panel.face.runInstall).not.toHaveBeenCalled()
  })
})
