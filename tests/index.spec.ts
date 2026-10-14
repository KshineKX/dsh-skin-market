import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

interface HarnessOptions {
  config?: { profile?: string }
  values?: Record<string, unknown>
  localValues?: Record<string, unknown>
}

function harness(options: HarnessOptions = {}): string[] {
  const labels: string[] = []
  const values = options.values ?? {}
  const localValues = options.localValues ?? values
  const host = {
    get(name: string): unknown { return localValues[name] },
    inject(_names: readonly string[], callback: (value: unknown) => void): void { callback({ ...host, desktopPnpm: localValues.desktopPnpm }) },
    effect(_factory: () => unknown, label: string): void { labels.push(label) },
    webServer: { register: () => () => undefined },
    loader: { entries: () => [] },
  }
  const context = {
    get(name: string): unknown { return values[name] },
    inject(_names: readonly string[], callback: (value: typeof host) => void): void { callback(host) },
  }
  apply(context as never, options.config)
  return labels
}

describe('host branch selection', () => {
  it('uses the official Desktop manager path for explicit desktop config without a profile directory', () => {
    expect(harness({ config: { profile: 'desktop' } })).toEqual(['dsh-skin-market: official Desktop routes'])
  })

  it('uses the official Desktop manager path for a launched desktop profile', () => {
    expect(harness({ values: { profileContext: { name: 'desktop', dir: '/tmp/dsh-desktop-profile' } } })).toEqual(['dsh-skin-market: official Desktop routes'])
  })

  it('reads profileContext from the injected local context when the root context is scoped', () => {
    expect(harness({ values: {}, localValues: { profileContext: { name: 'desktop', dir: '/tmp/dsh-desktop-profile' } } })).toEqual(['dsh-skin-market: official Desktop routes'])
  })

  it('keeps modern Web on its own route when the shared pluginManager service is present', () => {
    expect(harness({ values: { pluginManager: { installBundle: async () => ({}), removeBundle: async () => ({}) }, profileContext: { name: 'web', dir: '/tmp/dsh-web-profile' } } })).toEqual(['dsh-skin-market: routes'])
  })

  it('keeps an explicit third-party desktop configuration on its own desktop services', () => {
    expect(harness({ config: { profile: 'desktop' }, values: { desktopProfiles: { current: { name: 'other', dir: '/tmp/other-profile' } }, desktopPnpm: {} } })).toEqual(['dsh-skin-market: desktop routes'])
  })

  it('does not infer Desktop identity from pluginManager without a named Desktop profile', () => {
    expect(harness({ values: { pluginManager: {} } })).toEqual(['dsh-skin-market: routes'])
  })

  it('retains the legacy desktop adapter for a launched Desktop name when desktopProfiles owns it', () => {
    expect(harness({ values: { profileContext: { name: 'desktop', dir: '/tmp/custom-desktop' }, desktopProfiles: { current: { name: 'custom', dir: '/tmp/custom-desktop' } }, desktopPnpm: {} } })).toEqual(['dsh-skin-market: desktop routes'])
  })

  it('recognizes a desktop launch profile when profileContext is not available', () => {
    const previousArgv = process.argv
    process.argv = [...previousArgv, '--profile', 'desktop']
    try {
      expect(harness()).toEqual(['dsh-skin-market: official Desktop routes'])
    } finally {
      process.argv = previousArgv
    }
  })

  it('keeps an ordinary profile on the CLI route', () => {
    expect(harness({ config: { profile: 'web' } })).toEqual(['dsh-skin-market: routes'])
  })
})
