/**
 * The official rc.2 / alpha.3 Plugins page injects its controller face into the
 * winning `main` registration. This is a guarded adapter to that UI face, not
 * an installation API: the user still submits the official install dialog.
 */
export interface DesktopPluginPanel {
  available(): boolean
  open(spec: string): Promise<DesktopPluginPanelResult>
}

export type DesktopPluginPanelResult =
  | { ok: true; kind: 'prefilled' | 'resumed' }
  | { ok: false; reason: string }

export interface DesktopPluginPanelContext {
  /** Cordis permits optional service reads through get(), without hard injection. */
  get?: (name: string) => unknown
  layout?: { selectPanel(panelId: string): void }
  slots: { entriesOfSlot?: (slot: string) => readonly unknown[] }
}

interface ManagerSnapshot {
  status: string
  install: { phase: string; open: boolean; spec: string; requestId?: unknown; enabling?: boolean }
}

interface ManagerStore {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

interface ManagerFace {
  ensure(): void
  openInstall(): void
  editInstallSpec(spec: string): void
  hooks: { pluginManager: ManagerStore }
}

interface PanelLayout { selectPanel(panelId: string): void }
interface PanelTarget { entry: object; face: ManagerFace; layout: PanelLayout }

const ACTIVE_PHASES = new Set(['checking', 'starting', 'running', 'installing', 'cancelling', 'applying', 'unconfirmed', 'indeterminate'])
const EDITABLE_PHASES = new Set(['idle', 'unknown', 'done', 'failed'])
const UNAVAILABLE = '暂时无法打开 DSH 添加插件面板，请重试。'
const CHANGED = 'DSH 插件面板刚刚重新加载，请重试。'
const LOAD_FAILED = 'DSH 插件列表暂时未能加载，请稍后重试。'
const BUSY = '原生添加插件面板仍在处理另一项任务，请先在插件页确认其状态。'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function getLayout(ctx: DesktopPluginPanelContext): PanelLayout | undefined {
  // `layout` is optional for old hosts, so it is deliberately absent from the
  // market's required inject list. Reading ctx.layout directly throws on a real
  // Cordis plugin context even when another plugin provides that service.
  const value: unknown = typeof ctx.get === 'function' ? ctx.get('layout') : ctx.layout
  return typeof object(value)?.selectPanel === 'function' ? value as PanelLayout : undefined
}

function findTarget(ctx: DesktopPluginPanelContext): PanelTarget | undefined {
  const layout = getLayout(ctx)
  if (!layout || typeof ctx.slots.entriesOfSlot !== 'function') return undefined
  const entry = ctx.slots.entriesOfSlot('main').find(value => object(object(value)?.options)?.key === 'plugins')
  const stored = object(entry)
  if (typeof stored?.inject !== 'function') return undefined
  const value: unknown = stored.inject()
  const face = object(value), hooks = object(face?.hooks), store = object(hooks?.pluginManager)
  if (typeof face?.ensure !== 'function' || typeof face.openInstall !== 'function' || typeof face.editInstallSpec !== 'function'
    || typeof store?.getSnapshot !== 'function' || typeof store.subscribe !== 'function') return undefined
  return { entry: stored, face: value as ManagerFace, layout }
}

function snapshot(face: ManagerFace): ManagerSnapshot | undefined {
  const state = object(face.hooks.pluginManager.getSnapshot()), install = object(state?.install)
  if (typeof state?.status !== 'string' || typeof install?.phase !== 'string'
    || typeof install.open !== 'boolean' || typeof install.spec !== 'string') return undefined
  return { status: state.status, install: install as ManagerSnapshot['install'] }
}

/** Wait for the Host-owned inventory read without polling or installing anything. */
function waitUntilLoaded(store: ManagerStore, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let dispose: (() => void) | undefined
    let finished = false
    const timer = setTimeout(() => finish(false), timeoutMs)
    const finish = (ready: boolean): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try { dispose?.() } catch { /* Disposal must not leave the UI action pending. */ }
      resolve(ready)
    }
    const check = (): void => {
      try {
        const status = object(store.getSnapshot())?.status
        if (status === 'ready') finish(true)
        else if (status !== 'idle' && status !== 'loading') finish(false)
      } catch { finish(false) }
    }
    try {
      dispose = store.subscribe(check)
      if (finished) dispose()
      else check()
    } catch { finish(false) }
  })
}

/**
 * Preserve active work. In these official versions `openInstall` resets a
 * request without an id, so a visible `checking` dialog must be left as-is.
 */
function resume(face: ManagerFace, state: ManagerSnapshot, requestedSpec: string): DesktopPluginPanelResult | undefined {
  const install = state.install
  if (install.phase === 'idle' && install.open && install.spec.trim() !== '' && install.spec.trim() !== requestedSpec) {
    return { ok: true, kind: 'resumed' }
  }
  if (!ACTIVE_PHASES.has(install.phase) && !install.enabling && EDITABLE_PHASES.has(install.phase)) return undefined
  if (install.open) return { ok: true, kind: 'resumed' }
  if (typeof install.requestId === 'string' && install.requestId !== '' && install.phase !== 'checking') {
    face.openInstall()
    return snapshot(face)?.install.open ? { ok: true, kind: 'resumed' } : { ok: false, reason: BUSY }
  }
  return { ok: false, reason: BUSY }
}

export function createDesktopPluginPanel(ctx: DesktopPluginPanelContext, options: { readyTimeoutMs?: number } = {}): DesktopPluginPanel {
  let pending: { spec: string; promise: Promise<DesktopPluginPanelResult> } | undefined
  const navigate = (result: DesktopPluginPanelResult, layout: PanelLayout): DesktopPluginPanelResult => {
    if (result.ok) layout.selectPanel('plugins')
    return result
  }
  const open = async (spec: string): Promise<DesktopPluginPanelResult> => {
    try {
      const target = findTarget(ctx)
      if (!target) return { ok: false, reason: UNAVAILABLE }
      let state = snapshot(target.face)
      if (!state) return { ok: false, reason: UNAVAILABLE }
      const active = resume(target.face, state, spec)
      if (active) return navigate(active, target.layout)
      target.face.ensure()
      if (!await waitUntilLoaded(target.face.hooks.pluginManager, options.readyTimeoutMs ?? 8_000)) {
        return { ok: false, reason: LOAD_FAILED }
      }
      // HMR may replace the controller while its inventory read is pending.
      const current = findTarget(ctx)
      if (!current || current.entry !== target.entry || current.face !== target.face) return { ok: false, reason: CHANGED }
      state = snapshot(current.face)
      if (!state || state.status !== 'ready') return { ok: false, reason: LOAD_FAILED }
      const becameActive = resume(current.face, state, spec)
      if (becameActive) return navigate(becameActive, current.layout)
      if (state.install.phase !== 'idle' || !state.install.open) current.face.openInstall()
      const opened = snapshot(current.face)
      if (!opened?.install.open) return { ok: false, reason: UNAVAILABLE }
      // Never overwrite a run that the official face reports after opening.
      if (!EDITABLE_PHASES.has(opened.install.phase) || opened.install.enabling) return navigate({ ok: true, kind: 'resumed' }, current.layout)
      current.face.editInstallSpec(spec)
      const filled = snapshot(current.face)
      return filled?.install.open && filled.install.spec === spec
        ? navigate({ ok: true, kind: 'prefilled' }, current.layout)
        : { ok: false, reason: UNAVAILABLE }
    } catch {
      return { ok: false, reason: UNAVAILABLE }
    }
  }
  return {
    available() {
      try {
        const target = findTarget(ctx)
        return target !== undefined && snapshot(target.face) !== undefined
      } catch { return false }
    },
    open(input) {
      const spec = input.trim()
      if (!spec) return Promise.resolve({ ok: false, reason: '此皮肤缺少可用的安装地址。' })
      if (pending) return pending.spec === spec ? pending.promise
        : Promise.resolve({ ok: false, reason: '正在打开原生添加插件面板，请稍后重试。' })
      const promise = open(spec).finally(() => { if (pending?.promise === promise) pending = undefined })
      pending = { spec, promise }
      return promise
    },
  }
}
