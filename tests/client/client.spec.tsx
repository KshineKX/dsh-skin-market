// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const icon = () => React.createElement('span', { 'aria-hidden': true })
  return {
    Button: ({ icon: leading, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }) => React.createElement('button', props, leading, children),
    Input: ({ icon: leading, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { icon?: React.ReactNode }) => React.createElement('label', null, leading, React.createElement('input', props)),
    Pill: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => React.createElement('button', props, children),
    Modal: ({
      open,
      title,
      closeLabel = '关闭',
      onClose,
      description,
      footer,
      children,
    }: {
      open: boolean
      title: string
      closeLabel?: string
      onClose?: () => void
      description?: string
      footer?: React.ReactNode
      children?: React.ReactNode
    }) => open ? React.createElement(
      'div',
      { role: 'dialog', 'aria-label': title },
      React.createElement('h2', null, title),
      React.createElement('button', { type: 'button', 'aria-label': closeLabel, onClick: onClose }),
      description,
      children,
      footer,
    ) : null,
    IconChevronLeftOutline14: icon, IconChevronDownOutline14: icon, IconCopyOutline16: icon, IconDownloadOutline16: icon, IconLinkOutline16: icon, IconLoadingOutline16: icon,
    IconRefreshOutline16: icon, IconSearchOutline16: icon, IconTrashOutline16: icon,
    IconChevronLeftOutlineRegular: icon, IconChevronDownOutlineRegular: icon, IconCopyOutlineRegular: icon, IconDownloadOutlineRegular: icon, IconLoadingOutlineRegular: icon,
    IconRefreshOutlineRegular: icon, IconSearchOutlineRegular: icon, IconTrashOutlineRegular: icon,
    writeClipboard: async (text: string) => {
      if (navigator.clipboard?.writeText === undefined) return false
      await navigator.clipboard.writeText(text)
      return true
    },
  }
})

import { HOME_CATALOG_BATCH_SIZE, captureListScroll, compareInstalledSkinOrder, compareSkinOrder, interceptNotice, isInterceptFailure, resolvePrimitiveIcon, restartDocumentProbeUrl, restartReloadUrl, restoreListScroll, restoreMarketStyleOrder, SkinMarketSection, waitForRestartDocument } from '../../src/client/SkinMarketSection.tsx'
import { MARKET_INSTALL_TROUBLESHOOT_URL, MARKET_MANUAL_UPDATE_URL } from '../../src/client/failure-help.ts'
import { apply as applyClient, createClientSkinRuntime, missingPrimitives, switchClientSkin } from '../../src/client/index.ts'
import { createSkinInstallCommand, createSkinInstallPrompt, createSkinInstallSearchKeyword } from '../../src/client/submission.ts'
import { setGeneratedMediaSources } from '../../src/media-preview.ts'
import { compatibilityContext } from '../../src/compatibility.ts'
import type { CatalogSkin } from '../../src/client/types.ts'

const skin = {
  id: 'test.skin', name: { zh: '测试皮肤', en: 'Test Skin' }, author: 'author', description: 'description', repo: 'https://github.com/a/b', package: 'skin', rowId: 'skin',
  tags: ['dark'], modes: ['dark'], install: { target: 'https://github.com/a/b.git#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', version: '1.0.0', commit: 'a'.repeat(40) }, compatibility: { dsh: '0.1.0-rc.6', platform: ['web'] },
  screenshots: ['https://example.com/preview.png'], license: { code: 'MIT', commercialUse: true }, githubStars: 42, starsStale: false, starsUpdatedAt: '2026-08-16T00:00:00Z', recommendations: [], releaseUpdatedAt: '2026-08-16T00:00:00Z', metadataUpdatedAt: '2026-08-16T00:00:00Z', updatedAt: '2026-08-16T00:00:00Z',
} satisfies CatalogSkin
const dshRuntime = { version: '0.1.0-rc.6', capabilities: [], source: 'injected' as const }
const managedDesktopSkin = {
  ...skin,
  compatibility: { dsh: '>=0.1.0-rc.6', platform: ['web', 'desktop'] },
  install: { ...skin.install, desktop: { mode: 'managed', registry: 'npm', packageName: skin.package, packageVersion: skin.install.version } },
} satisfies CatalogSkin
const officialManagement = {
  official: true,
  capabilities: { install: { available: true }, update: { available: true }, enable: { available: true }, disable: { available: true }, remove: { available: true } },
}

afterEach(() => { cleanup(); setGeneratedMediaSources(undefined); window.localStorage.clear(); window.sessionStorage.clear(); vi.unstubAllGlobals() })

async function openSkinCard(name: RegExp = /测试皮肤 界面预览/) {
  const card = await screen.findByRole('button', { name })
  fireEvent.click(card)
  return card
}

describe('client market', () => {
  it('explains a missing bundle patch as a packaging intercept, not a local profile error', () => {
    const operation = {
      id: 'op', kind: 'install' as const, skinId: skin.id, phase: 'failed' as const, startedAt: '2026-09-08T00:00:00Z',
      message: '@deepseek-ai/dsh-client-ui-liquid-glass bundle patch is missing: ./cordis.patch.yml',
    }
    expect(isInterceptFailure(operation)).toBe(true)
    expect(isInterceptFailure({ ...operation, failure: { kind: 'network', message: '网络错误', action: 'retry' } })).toBe(false)
    const notice = interceptNotice(operation, '液态玻璃', skin)
    expect(notice.title).toBe('已拦截安装')
    expect(notice.what).toContain('缺少 DSH 用来注册插件的 ./cordis.patch.yml')
    expect(notice.why).toContain('files 白名单')
    expect(notice.links).toEqual([{ href: `https://github.com/a/b/tree/${'a'.repeat(40)}`, label: '打开皮肤仓库' }])
  })

  it('asks before migrating the chosen skin and preserves the active-skin restart flow', async () => {
    let migrated = false
    const sourceMigration = { target: 'skin@1.0.0', currentSource: skin.install.target }
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ hostKind: 'dsh', runningAgentCount: 0, runtime: dshRuntime, skins: [{ skinId: skin.id, installation: 'installed', activation: migrated ? 'restart-required' : 'active', pinned: true, installedVersion: '1.0.0', updateAvailable: false, ...(!migrated && { sourceMigration }) }] }) }
      if (url.endsWith('/migrate') && init?.method === 'POST') {
        migrated = true
        return { ok: true, json: async () => ({ operationId: 'migrate-1' }) }
      }
      if (url.endsWith('/operations/migrate-1')) return { ok: true, json: async () => ({ id: 'migrate-1', kind: 'migrate', skinId: skin.id, phase: 'done' }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    fireEvent.click((await screen.findAllByRole('button', { name: '换用 npm' }))[0]!)
    const firstDialog = screen.getByRole('dialog', { name: '换用 npm 安装源' })
    expect(firstDialog.textContent).toContain(sourceMigration.currentSource)
    expect(firstDialog.textContent).toContain(sourceMigration.target)
    expect(migrated).toBe(false)
    fireEvent.click(within(firstDialog).getByRole('button', { name: '取消' }))
    expect(migrated).toBe(false)

    fireEvent.click(screen.getAllByRole('button', { name: '换用 npm' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: '确认换用 npm' }))
    expect(await screen.findByRole('dialog', { name: '需要重启 DSH 应用此皮肤' })).toBeTruthy()
    expect(screen.getAllByText('测试皮肤 已换用 npm，待重启生效').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '换用 npm' })).toBeNull()
    expect(fetchMock.mock.calls.find(([url, init]) => url.endsWith('/migrate') && init?.method === 'POST')?.[1]?.body).toBe(JSON.stringify({ skinId: skin.id }))
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/update') && init?.method === 'POST')).toBe(false)
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/restart') && init?.method === 'POST')).toBe(false)
  })

  it.each(['missing', 'no-source', 'manual', 'desktop'])('hides source migration for %s skins', async mode => {
    const entry = mode === 'manual' ? { ...skin, review: { compatibility: 'verified', preview: 'verified', installation: 'manual-only' } } : skin
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [entry] } : {
      hostKind: mode === 'desktop' ? 'desktop' : 'dsh',
      skins: [{ skinId: skin.id, installation: mode === 'missing' ? 'missing' : 'installed', activation: 'inactive', installedVersion: '1.0.0', updateAvailable: false, ...(mode !== 'no-source' && { sourceMigration: { target: 'skin@1.0.0', currentSource: skin.install.target } }) }],
    } })))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    expect(screen.queryByRole('button', { name: '换用 npm' })).toBeNull()
  })

  it('puts skins without a usable preview after previewed skins before comparing stars', () => {
    const noPreview = {
      ...skin,
      id: 'test.no-preview',
      githubStars: 999,
      review: { compatibility: 'verified' as const, preview: 'repository-card' as const, installation: 'verified' as const },
    }
    const supplemented = {
      ...skin,
      id: 'test.supplemented',
      githubStars: 1,
      review: { compatibility: 'verified' as const, preview: 'repository-card' as const, installation: 'verified' as const },
      marketScreenshots: ['https://example.com/market-preview.png'],
    }

    expect([noPreview, supplemented].sort((a, b) => compareSkinOrder(a, b, 'stars')).map(item => item.id)).toEqual([
      supplemented.id,
      noPreview.id,
    ])
  })

  it('orders installed skins by current use, pinned state, then latest operation', () => {
    const current = { ...skin, id: 'current', name: { zh: '当前', en: 'Current' } }
    const pinned = { ...skin, id: 'pinned', name: { zh: '常驻', en: 'Pinned' } }
    const recent = { ...skin, id: 'recent', name: { zh: '最近', en: 'Recent' } }
    const older = { ...skin, id: 'older', name: { zh: '较早', en: 'Older' } }
    const states = [
      { skinId: current.id, installation: 'installed' as const, activation: 'active' as const, primary: true, pinned: false, installedVersion: '1', updateAvailable: false, lastOperatedAt: '2026-08-01T00:00:00Z' },
      { skinId: pinned.id, installation: 'installed' as const, activation: 'active' as const, primary: false, pinned: true, installedVersion: '1', updateAvailable: false, lastOperatedAt: '2026-08-04T00:00:00Z' },
      { skinId: recent.id, installation: 'installed' as const, activation: 'inactive' as const, primary: false, pinned: false, installedVersion: '1', updateAvailable: false, lastOperatedAt: '2026-08-03T00:00:00Z' },
      { skinId: older.id, installation: 'installed' as const, activation: 'inactive' as const, primary: false, pinned: false, installedVersion: '1', updateAvailable: false, lastOperatedAt: '2026-08-02T00:00:00Z' },
    ]
    expect([older, recent, pinned, current].sort((a, b) => compareInstalledSkinOrder(a, b, states)).map(item => item.id)).toEqual(['current', 'pinned', 'recent', 'older'])
  })

  it('restores the visible list anchor after background reordering', () => {
    const list = document.createElement('div')
    const card = document.createElement('button')
    card.dataset.skinId = 'anchored-skin'
    list.appendChild(card)
    list.scrollTop = 200
    Object.defineProperty(list, 'getBoundingClientRect', { value: () => ({ top: 100 }) })
    Object.defineProperty(card, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 90, bottom: 120 }) })
    const anchor = captureListScroll(list)

    Object.defineProperty(card, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 140, bottom: 170 }) })
    restoreListScroll(list, anchor)

    expect(list.scrollTop).toBe(250)
  })

  it('keeps the selected detail and open modal during a catalog refresh', async () => {
    const second = { ...skin, id: 'test.second', name: { zh: '第二皮肤', en: 'Second Skin' }, package: 'second-skin', rowId: 'second-skin' }
    let catalogRequests = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/catalog')) {
        catalogRequests += 1
        return { ok: true, json: async () => ({ skins: catalogRequests === 1 ? [skin, second] : [skin] }) }
      }
      return { ok: true, json: async () => ({ skins: [], installedClientPlugins: [], runningAgentCount: 0 }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)

    fireEvent.click(screen.getByRole('button', { name: '提交皮肤' }))
    expect(screen.getByRole('dialog', { name: '提交你的皮肤' })).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /第二皮肤 界面预览/ }))
    window.dispatchEvent(new Event('focus'))

    await waitFor(() => expect(catalogRequests).toBe(2))
    expect(screen.getByRole('heading', { name: '第二皮肤' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: '提交你的皮肤' })).toBeTruthy()
  })

  it('hides catalog metadata and the manual refresh control', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin], generatedAt: '2026-08-15T12:00:00Z', catalogSource: 'bundled' }) }
      return { ok: true, json: async () => ({ skins: [], installedClientPlugins: [], runningAgentCount: 0 }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)

    expect(await screen.findByRole('button', { name: /测试皮肤 界面预览/ })).toBeTruthy()
    expect(screen.queryByText(/内置目录|在线目录/)).toBeNull()
    expect(screen.queryByRole('button', { name: '刷新在线目录' })).toBeNull()
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/catalog/refresh'))).toBe(false)
  })

  it('shows a compact self-update action only when GitHub has a newer market version', async () => {
    let restartRequired = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runningAgentCount: 0, marketUpdateRestartRequired: restartRequired }) }
      if (url.endsWith('/market-update') && init?.method === 'POST') {
        restartRequired = true
        return { ok: true, json: async () => ({ currentVersion: '0.1.16', latestVersion: '0.1.16', updateAvailable: false }) }
      }
      if (url.endsWith('/market-update') && restartRequired) return { ok: true, json: async () => ({ currentVersion: '0.1.16', latestVersion: '0.1.16', updateAvailable: false }) }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.15', latestVersion: '0.1.16', updateAvailable: true }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<SkinMarketSection t={key => key} />)

    const update = await screen.findByRole('button', { name: '更新皮肤市场到 0.1.16' })
    expect(update.textContent).toBe('更新')
    fireEvent.click(update)

    expect(await screen.findByRole('dialog', { name: '需要重启 DSH 应用皮肤市场更新' })).toBeTruthy()
    expect(screen.getByText(/皮肤市场新版本 0.1.16 将在重启后生效/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '稍后' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '稍后' }))
    expect(screen.getAllByText('皮肤市场已更新，待重启生效').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '重启' }))
    expect(screen.getByRole('dialog', { name: '需要重启 DSH 应用皮肤市场更新' })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: '关闭提示' })[0])
    expect(screen.queryByText('皮肤市场已更新，待重启生效')).toBeNull()
    await waitFor(() => expect(screen.queryByRole('button', { name: '更新皮肤市场到 0.1.16' })).toBeNull())

    // Remount restores the pending banner without repeatedly interrupting
    // a user who has already acknowledged this same restart reminder.
    view.unmount()
    render(<SkinMarketSection t={key => key} />)
    expect(await screen.findByText('皮肤市场已更新，待重启生效')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '需要重启 DSH 应用皮肤市场更新' })).toBeNull()
  })

  it('keeps updates and skin actions available without guessing protection from publication age', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runtime: dshRuntime }) }
      if (url.endsWith('/market-update') && init?.method === 'POST') return { ok: true, json: async () => ({ currentVersion: '0.1.61', latestVersion: '0.1.61', updateAvailable: false }) }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.60', latestVersion: '0.1.61', updateAvailable: true,
        updateBlockedReason: '旧版服务推断的新包保护', packageOperationsWarning: '旧版服务推断的安装风险', updateAvailableAt: new Date(Date.now() + 60_000).toISOString() }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    const update = await screen.findByRole('button', { name: '更新皮肤市场到 0.1.61' })
    expect(update.textContent).toBe('更新')
    expect(update.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText(/旧版服务推断/)).toBeNull()
    expect((await screen.findByRole('button', { name: '安装并使用' })).hasAttribute('disabled')).toBe(false)
    fireEvent.click(update)
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/market-update') && init?.method === 'POST')).toBe(true))
  })

  it('keeps the real Desktop restart reminder while a market update is available', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [managedDesktopSkin] } : url.endsWith('/state') ? {
      hostKind: 'desktop', restartAvailable: false, skins: [], marketUpdateRestartRequired: true,
    } : url.endsWith('/market-update') ? {
      currentVersion: '0.1.60', latestVersion: '0.1.61', updateAvailable: true,
    } : {} })))
    render(<SkinMarketSection t={key => key} />)
    expect(await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '更新皮肤市场到 0.1.61' }).hasAttribute('disabled')).toBe(false)
  })

  it('requires an explicit exact-version approval before continuing a market update', async () => {
    let approved = false
    const failure = { kind: 'release-age', message: '新包保护', action: 'approve-release-age', releaseAgeTarget: { packageName: 'dsh-skin-market', version: '0.1.61' } }
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runtime: dshRuntime }) }
      if (url.endsWith('/market-update') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'market-age-source' }) }
      if (url.endsWith('/market-update/operations/market-age-source/retry') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ action: 'approve-release-age' })
        approved = true
        return { ok: true, json: async () => ({ operationId: 'market-age-approved' }) }
      }
      if (url.endsWith('/market-update/operations/market-age-source')) return { ok: true, json: async () => ({ id: 'market-age-source', phase: 'failed', startedAt: new Date().toISOString(), failure }) }
      if (url.endsWith('/market-update/operations/market-age-approved')) return { ok: true, json: async () => ({ id: 'market-age-approved', phase: 'done', startedAt: new Date().toISOString(), status: { currentVersion: '0.1.61', latestVersion: '0.1.61', updateAvailable: false } }) }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.60', latestVersion: '0.1.61', updateAvailable: true }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    fireEvent.click(await screen.findByRole('button', { name: '更新皮肤市场到 0.1.61' }))
    const dialog = await screen.findByRole('dialog', { name: '更新需要允许新版本' })
    expect(dialog.textContent).toContain('dsh-skin-market@0.1.61')
    expect(dialog.textContent).toContain('本机 Desktop')
    expect(within(dialog).queryByRole('button', { name: '重试' })).toBeNull()
    expect(approved).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: '允许此版本并继续' }))
    await waitFor(() => expect(approved).toBe(true))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '更新需要允许新版本' })).toBeNull())
    expect(screen.queryByRole('button', { name: '更新皮肤市场到 0.1.61' })).toBeNull()
  })

  it('uses the shared operation banner in the home header while the market updates', async () => {
    let operationRequests = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runningAgentCount: 0, marketUpdateOperation: null }) }
      if (url.endsWith('/market-update') && init?.method === 'POST') return { ok: true, status: 202, json: async () => ({ operationId: 'market-update-1' }) }
      if (url.endsWith('/market-update/operations/market-update-1')) {
        operationRequests += 1
        return { ok: true, json: async () => ({ id: 'market-update-1', phase: 'downloading', cancelable: true, startedAt: new Date().toISOString(), message: '正在下载皮肤市场更新包' }) }
      }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.15', latestVersion: '0.1.16', updateAvailable: true, operation: null }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)

    fireEvent.click(await screen.findByRole('button', { name: '更新皮肤市场到 0.1.16' }))
    expect((await screen.findAllByText('正在下载皮肤市场')).length).toBe(1)
    expect(document.querySelector('[class*="homeHeader"] [role="status"] strong')?.textContent).toBe('正在下载皮肤市场')
    const banner = screen.getByRole('status')
    const message = within(banner).queryByText('正在下载皮肤市场更新包')
    expect(message === null || message.closest('[hidden]') !== null).toBe(true)
    expect(operationRequests).toBeGreaterThan(0)
  })

  it.each(['done', 'failed', 'cancelled'] as const)('refreshes host state and unlocks skin actions after a waiting market update becomes %s', async phase => {
    let terminal = false
    let operationRequests = 0
    let stateRequests = 0
    let resolveTerminal!: (value: unknown) => void
    const terminalResult = new Promise<unknown>(resolve => { resolveTerminal = resolve })
    const operation = { id: 'market-waiting', phase, startedAt: '2026-10-14T00:00:00Z' }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) {
        stateRequests += 1
        return { ok: true, json: async () => ({ skins: [], runtime: dshRuntime, runningAgentCount: 0, marketUpdateOperation: terminal ? operation : null }) }
      }
      if (url.endsWith('/market-update') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: operation.id }) }
      if (url.endsWith('/market-update/operations/market-waiting')) {
        operationRequests += 1
        return { ok: true, json: async () => operationRequests === 1
          ? { ...operation, phase: 'waiting', message: '等待宿主确认市场更新' }
          : terminalResult }
      }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.57', latestVersion: '0.1.58', updateAvailable: true, operation: null }) }
      throw new Error(`Unexpected request: ${url}`)
    }))
    render(<SkinMarketSection t={key => key} />)
    const update = await screen.findByRole('button', { name: '更新皮肤市场到 0.1.58' })
    const install = await screen.findByRole('button', { name: '安装并使用' })
    expect(install.hasAttribute('disabled')).toBe(false)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      await act(async () => { fireEvent.click(update) })
      expect(operationRequests).toBe(1)
      expect(install.hasAttribute('disabled')).toBe(true)
      const beforeTerminal = stateRequests
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(operationRequests).toBe(2)
      await act(async () => {
        terminal = true
        resolveTerminal(operation)
        await terminalResult
      })
      expect(stateRequests).toBeGreaterThan(beforeTerminal)
      expect(install.hasAttribute('disabled')).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('explains a market self-update store mismatch in a dialog with the troubleshooting README', async () => {
    const clipboard = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: { writeText: clipboard } })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runningAgentCount: 0, marketUpdateOperation: null }) }
      if (url.endsWith('/market-update') && init?.method === 'POST') return { ok: true, status: 202, json: async () => ({ operationId: 'market-update-store' }) }
      if (url.endsWith('/logs?operationId=market-update-store')) return { ok: true, text: async () => '# dsh-skin-market diagnostic log\nkind=unexpected-store' }
      if (url.endsWith('/market-update/operations/market-update-store')) {
        return { ok: true, json: async () => ({ id: 'market-update-store', phase: 'failed', startedAt: new Date().toISOString(), message: '当前 profile 的 node_modules 由另一代 pnpm store 链接', failure: { kind: 'unexpected-store', message: '当前 profile 的 node_modules 由另一代 pnpm store 链接' } }) }
      }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.15', latestVersion: '0.1.16', updateAvailable: true, operation: null }) }
      throw new Error(`Unexpected request: ${url}`)
    }))
    render(<SkinMarketSection t={key => key} />)

    fireEvent.click(await screen.findByRole('button', { name: '更新皮肤市场到 0.1.16' }))
    const dialog = await screen.findByRole('dialog', { name: '皮肤市场更新失败' })
    expect(dialog.textContent).toContain('另一代 pnpm store')
    expect(within(dialog).getByRole('link', { name: '查看安装排查' }).getAttribute('href')).toBe(MARKET_INSTALL_TROUBLESHOOT_URL)
    expect(within(dialog).queryByRole('link', { name: '查看手动更新' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: '复制日志' })).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: '复制日志' }))
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(expect.stringContaining('kind=unexpected-store')))
  })

  it('sends a generic market self-update failure to the manual update README', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runningAgentCount: 0 }) }
      if (url.endsWith('/market-update') && init?.method === 'POST') return { ok: true, status: 202, json: async () => ({ operationId: 'market-update-generic' }) }
      if (url.endsWith('/market-update/operations/market-update-generic')) {
        return { ok: true, json: async () => ({ id: 'market-update-generic', phase: 'failed', startedAt: new Date().toISOString(), message: 'plugin command exited 1', failure: { kind: 'command', message: 'plugin command exited 1' } }) }
      }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.15', latestVersion: '0.1.16', updateAvailable: true }) }
      throw new Error(`Unexpected request: ${url}`)
    }))
    render(<SkinMarketSection t={key => key} />)
    fireEvent.click(await screen.findByRole('button', { name: '更新皮肤市场到 0.1.16' }))
    const dialog = await screen.findByRole('dialog', { name: '皮肤市场更新失败' })
    expect(within(dialog).getByRole('link', { name: '查看手动更新' }).getAttribute('href')).toBe(MARKET_MANUAL_UPDATE_URL)
    expect(within(dialog).queryByRole('link', { name: '查看安装排查' })).toBeNull()
  })

  it('turns an empty successful response into a useful Host update error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input') } })))
    render(<SkinMarketSection t={key => key} />)

    expect(await screen.findByText('皮肤市场服务未返回有效数据，请确认 Host 插件已经更新')).toBeTruthy()
    expect(screen.queryByText(/Unexpected end of JSON input/)).toBeNull()
  })

  it('cache-busts the full document exactly once after a DSH restart', () => {
    const result = new URL(restartReloadUrl('http://127.0.0.1:8081/?view=market', 'new-instance'))
    expect(result.searchParams.get('view')).toBe('market')
    expect(result.searchParams.get('dsh-skin-reload')).toBe('new-instance')
    expect(restartDocumentProbeUrl(result.toString())).toBe('http://127.0.0.1:8081/?view=market')
  })

  it('does not navigate until the replacement Host can serve the document', async () => {
    let instanceId = 'old'
    let documentOk = false
    const calls: string[] = []
    const href = 'http://127.0.0.1:3080/?view=market'
    await expect(waitForRestartDocument({
      acceptedInstanceId: 'old',
      href,
      now: () => 0,
      deadlineMs: 10_000,
      pollMs: 1,
      sleep: async () => {
        if (calls.filter(item => item === 'state').length >= 1) instanceId = 'new'
        if (calls.filter(item => item === 'document').length >= 1) documentOk = true
      },
      fetchState: async () => {
        calls.push('state')
        return { instanceId }
      },
      fetchDocument: async url => {
        calls.push('document')
        expect(url).toBe(href)
        return { ok: documentOk }
      },
    })).resolves.toBe(restartReloadUrl(href, 'new'))
    expect(calls).toEqual(['state', 'state', 'document', 'state', 'document'])
  })

  it('keeps waiting when the new instance answers state before the SPA fallback is registered', async () => {
    let now = 0
    await expect(waitForRestartDocument({
      acceptedInstanceId: 'old',
      href: 'http://127.0.0.1:3080/',
      now: () => now,
      deadlineMs: 1_000,
      pollMs: 500,
      sleep: async ms => { now += ms },
      fetchState: async () => ({ instanceId: 'new' }),
      fetchDocument: async () => ({ ok: false }),
    })).rejects.toThrow('重启超时')
  })

  it('restores market style priority after a skin is hot-loaded', () => {
    const market = document.createElement('style')
    market.textContent = '.generated-filter-marker{}'
    const skinStyle = document.createElement('style')
    skinStyle.dataset.plugin = 'skin-package'
    document.head.append(market, skinStyle)

    restoreMarketStyleOrder(document, 'generated-filter-marker')

    expect(document.head.lastElementChild).toBe(market)
    market.remove()
    skinStyle.remove()
  })

  it('hot-disables and re-enables an existing client skin entry', async () => {
    const update = vi.fn(async () => undefined)
    const runtime = createClientSkinRuntime({ entries: () => [{ options: { name: 'skin-package' }, update }] })

    await expect(runtime.setActive('skin-package', false)).resolves.toBe(true)
    expect(update).toHaveBeenLastCalledWith({ disabled: true }, false, true)
    await expect(runtime.setActive('skin-package', true)).resolves.toBe(true)
    expect(update).toHaveBeenLastCalledWith({ disabled: null }, false, true)
    await expect(runtime.setActive('missing-package', false)).resolves.toBe(false)
  })

  it('disables non-preserved client skins before enabling the selected one', async () => {
    const calls: string[] = []
    const runtime = { setActive: vi.fn(async (name: string, active: boolean) => { calls.push(`${name}:${active}`); return true }) }

    await expect(switchClientSkin(runtime, ['old-skin', 'pinned-skin', 'new-skin'], 'new-skin', ['pinned-skin'])).resolves.toBe(true)
    expect(calls).toEqual(['old-skin:false', 'new-skin:true'])
  })

  it('guards missing native primitives', () => {
    expect(missingPrimitives({ Button: true })).toEqual(['Input', 'Modal', 'Pill'])
  })

  it('keeps the legacy market settings entry and mounts the same market UI when the new bundle configuration slot becomes available', () => {
    const pending = new Map<string, () => unknown>()
    const registrations: Array<{ meta: Record<string, unknown>; view: () => unknown }> = []
    const t = (key: string) => key
    applyClient({
      effect: callback => { callback() },
      locale: { register: vi.fn(), bind: () => t },
      loader: { entries: () => [] },
      slots: {
        inject: (slot, callback) => {
          if (slot === 'settings.section') callback()
          else pending.set(slot, callback)
        },
        register: (meta, view) => { registrations.push({ meta, view }) },
      },
    })
    expect(registrations).toHaveLength(1)
    expect(registrations[0]!.meta).toMatchObject({ name: 'settings.section', id: 'skin-market' })
    expect(pending.has('plugins.bundle.config')).toBe(true)

    pending.get('plugins.bundle.config')!()
    expect(registrations).toHaveLength(2)
    expect(registrations[1]!.meta).toMatchObject({ name: 'plugins.bundle.config', key: 'dsh-skin-market' })
    const legacy = registrations[0]!.view() as React.ReactElement
    const modern = registrations[1]!.view() as React.ReactElement
    expect(legacy.type).toBe(SkinMarketSection)
    expect(modern.type).toBe(SkinMarketSection)
    expect(modern.props.t).toBe(legacy.props.t)
    expect(modern.props.clientRuntime).toBe(legacy.props.clientRuntime)
    expect(legacy.props.layout).toBe('fill')
    expect(modern.props.layout).toBe('embedded')
  })

  it('resolves alpha.2 icon exports and keeps the rc.6 fallback', () => {
    const current = () => React.createElement('span', { 'data-icon': 'current' })
    const legacy = () => React.createElement('span', { 'data-icon': 'legacy' })

    expect(resolvePrimitiveIcon({ modern: current, legacy }, 'modern', 'legacy')).toBe(current)
    expect(resolvePrimitiveIcon({ legacy }, 'modern', 'legacy')).toBe(legacy)
    expect(typeof resolvePrimitiveIcon({}, 'modern', 'legacy')).toBe('function')
  })

  it('shows the feed loading hint, then puts the active skin first in Installed', async () => {
    const activeSkin = { ...skin, id: 'test.active', name: { zh: '当前皮肤', en: 'Active Skin' } }
    let resolveCatalog!: (value: unknown) => void
    let resolveState!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise(resolve => {
      if (url.endsWith('/catalog')) resolveCatalog = resolve
      else resolveState = resolve
    })))

    render(<SkinMarketSection t={key => key} />)
    expect(screen.getByText('正在加载皮肤…')).toBeTruthy()
    expect(screen.queryByText('没有匹配的皮肤')).toBeNull()

    await waitFor(() => expect(typeof resolveCatalog).toBe('function'))
    resolveCatalog({ ok: true, json: async () => ({ skins: [skin, activeSkin] }) })
    resolveState({ ok: true, json: async () => ({ skins: [
      { skinId: skin.id, installation: 'installed', activation: 'inactive', installedVersion: '1.0.0', updateAvailable: false },
      { skinId: activeSkin.id, installation: 'installed', activation: 'active', installedVersion: '1.0.0', updateAvailable: true },
    ] }) })

    const activeCard = await screen.findByRole('button', { name: /当前皮肤 已安装卡片/ })
    expect(activeCard.getAttribute('aria-current')).toBe('true')
    expect(activeCard.closest('article')?.textContent).toContain('使用中')
    expect(activeCard.closest('article')?.textContent).not.toContain('可更新')
    expect(screen.queryByText('正在加载皮肤…')).toBeNull()
  })

  it('opens details in a labelled modal surface with an explicit close action', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [] } })))
    render(<SkinMarketSection t={key => key} />)

    await openSkinCard()
    expect(screen.getByRole('dialog', { name: '皮肤详情' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '皮肤详情' })).toBeTruthy()
    const close = screen.getByRole('button', { name: '关闭' })
    expect(close.textContent).toBe('')
    fireEvent.click(close)
    expect(screen.queryByRole('dialog', { name: '皮肤详情' })).toBeNull()
  })

  it('does not mutate the host settings navigation DOM', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [] } })))
    render(
      <div role="dialog" aria-label="设置" data-test-settings-dialog>
        <nav>
          <button type="button" aria-current="true"><svg aria-hidden="true" /></button>
        </nav>
        <SkinMarketSection t={key => key} />
      </div>,
    )

    await screen.findByRole('button', { name: /测试皮肤 界面预览/ })

    const navButton = document.querySelector('[data-test-settings-dialog] nav button')
    expect(navButton?.querySelector('span')).toBeNull()
    expect(navButton?.querySelector('[data-dsh-skin-market-default-icon="hidden"]')).toBeNull()
  })

  it('uses the same installed ordering on home and in the sidebar', async () => {
    const installedSkins = Array.from({ length: 6 }, (_, index) => ({
      ...skin,
      id: `test.installed-${index}`,
      name: { zh: `已装皮肤 ${index}`, en: `Installed Skin ${index}` },
      package: `installed-skin-${index}`,
      rowId: `installed-skin-${index}`,
      githubStars: index,
    }))
    const runtime = installedSkins.map((item, index) => ({
      skinId: item.id,
      installation: 'installed',
      activation: index === 5 || index === 4 ? 'active' : 'inactive',
      primary: index === 5,
      pinned: index === 4,
      installedVersion: '1.0.0',
      updateAvailable: false,
      installedAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
      lastOperatedAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    }))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/catalog') ? { skins: installedSkins } : { skins: runtime },
    })))
    render(<SkinMarketSection t={key => key} />)

    await waitFor(() => {
      const installedSection = screen.getByRole('heading', { name: '已安装' }).closest('section')!
      const cards = [...installedSection.querySelectorAll<HTMLButtonElement>('button[aria-label$="已安装卡片"]')]
      expect(cards.map(card => card.getAttribute('aria-label'))).toEqual([
        '已装皮肤 5 已安装卡片',
        '已装皮肤 4 已安装卡片',
        '已装皮肤 3 已安装卡片',
        '已装皮肤 2 已安装卡片',
      ])
    })

    fireEvent.click(screen.getByRole('button', { name: '查看全部已安装' }))
    expect(await screen.findByRole('button', { name: '已安装', pressed: true })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '已装皮肤 5' })).toBeTruthy()
    const sidebarCards = screen.getByRole('complementary', { name: 'catalog' }).querySelectorAll<HTMLButtonElement>('button[data-skin-id]')
    expect([...sidebarCards].map(card => card.dataset.skinId)).toEqual(installedSkins.map(item => item.id).reverse())
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(screen.getByRole('button', { name: 'Stars' })).toBeTruthy()
  })

  it('shows installed skeletons while runtime state loads and hides the section when empty', async () => {
    let resolveState!: (value: { skins: never[] }) => void
    const state = new Promise<{ skins: never[] }>(resolve => { resolveState = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/catalog') ? { skins: [skin] } : state,
    })))

    render(<SkinMarketSection t={key => key} />)

    expect(await screen.findByRole('status', { name: '正在加载已安装皮肤' })).toBeTruthy()
    resolveState({ skins: [] })
    await waitFor(() => expect(screen.queryByRole('heading', { name: '已安装' })).toBeNull())
  })

  it('keeps installed skeletons when runtime state arrives before catalog skins', async () => {
    let resolveCatalog!: (value: unknown) => void
    let resolveState!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise(resolve => {
      if (url.endsWith('/catalog')) resolveCatalog = resolve
      else if (url.endsWith('/state')) resolveState = resolve
      else resolve({ ok: true, json: async () => ({}) })
    })))

    render(<SkinMarketSection t={key => key} />)
    expect(await screen.findByRole('status', { name: '正在加载已安装皮肤' })).toBeTruthy()

    await waitFor(() => expect(typeof resolveState).toBe('function'))
    resolveState({ ok: true, json: async () => ({ skins: [{
      skinId: skin.id, installation: 'installed', activation: 'inactive', installedVersion: '1.0.0', updateAvailable: false,
    }] }) })

    expect(await screen.findByRole('status', { name: '正在加载已安装皮肤' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /测试皮肤 已安装卡片/ })).toBeNull()

    resolveCatalog({ ok: true, json: async () => ({ skins: [skin] }) })
    expect(await screen.findByRole('button', { name: /测试皮肤 已安装卡片/ })).toBeTruthy()
    expect(screen.queryByRole('status', { name: '正在加载已安装皮肤' })).toBeNull()
  })

  it('paints installed cards from the cached catalog without waiting for catalog revalidation', async () => {
    const catalogCache = { read: vi.fn(async () => [skin]), write: vi.fn(async () => undefined) }
    let resolveState!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/catalog')) return new Promise(() => undefined)
      if (url.endsWith('/state')) return new Promise(resolve => { resolveState = resolve })
      return Promise.resolve({ ok: true, json: async () => ({}) })
    }))

    render(<SkinMarketSection t={key => key} catalogCache={catalogCache} />)
    expect(await screen.findByRole('button', { name: /测试皮肤 界面预览/ })).toBeTruthy()
    expect(screen.getByRole('status', { name: '正在加载已安装皮肤' })).toBeTruthy()

    await waitFor(() => expect(typeof resolveState).toBe('function'))
    resolveState({ ok: true, json: async () => ({ skins: [{
      skinId: skin.id, installation: 'installed', activation: 'active', primary: true, installedVersion: '1.0.0', updateAvailable: false,
    }] }) })

    expect(await screen.findByRole('button', { name: /测试皮肤 已安装卡片/ })).toBeTruthy()
    expect(screen.queryByRole('status', { name: '正在加载已安装皮肤' })).toBeNull()
  })

  it('opens an installed card directly in its selected detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [{
        skinId: skin.id,
        installation: 'installed',
        activation: 'inactive',
        installedVersion: '1.0.0',
        updateAvailable: false,
        installedAt: '2026-08-16T00:00:00Z',
      }] },
    })))
    render(<SkinMarketSection t={key => key} />)

    fireEvent.click(await screen.findByRole('button', { name: /测试皮肤 已安装卡片/ }))
    expect(await screen.findByRole('heading', { name: '测试皮肤' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '已安装', pressed: true })).toBeTruthy()
  })

  it('installs and activates from the discovery card action', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runtime: dshRuntime }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'card-install' }) }
      if (url.endsWith('/operations/card-install')) return { ok: true, json: async () => ({ id: 'card-install', kind: 'install', skinId: skin.id, phase: 'done' }) }
      if (url.endsWith('/activate') && init?.method === 'POST') return await new Promise(() => undefined)
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)

    const install = await screen.findByRole('button', { name: '安装并使用' })
    expect(install.getAttribute('variant')).toBe('outline')
    expect(screen.queryByText('可安装')).toBeNull()
    fireEvent.click(install)

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/install') && init?.method === 'POST')).toBe(true))
    await waitFor(() => expect(screen.getByRole('group', { name: '测试皮肤 操作' }).textContent).toContain('使用中'))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/activate') && init?.method === 'POST')).toBe(true))
  })

  it.each(['desktop', 'dsh'] as const)('keeps install-and-use for a %s host whose completed install does not require restart', async hostKind => {
    let installed = false
    let active = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [managedDesktopSkin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({
        hostKind, restartAvailable: hostKind === 'dsh', runtime: { ...dshRuntime, version: '0.2.1-alpha.1' },
        ...(hostKind === 'desktop' ? { management: { ...officialManagement, installRequiresRestart: false } } : {}),
        skins: installed ? [{ skinId: skin.id, installation: 'installed', activation: active ? 'active' : 'inactive', installedVersion: '1.0.0', updateAvailable: false }] : [],
      }) }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.58', latestVersion: '0.1.58', updateAvailable: false }) }
      if (url.endsWith('/install') && init?.method === 'POST') {
        installed = true
        return { ok: true, json: async () => ({ operationId: 'current-install' }) }
      }
      if (url.endsWith('/operations/current-install')) return { ok: true, json: async () => ({ id: 'current-install', kind: 'install', skinId: skin.id, phase: 'done', restartRequired: false }) }
      if (url.endsWith('/activate') && init?.method === 'POST') {
        active = true
        return { ok: true, json: async () => ({ operationId: 'current-activate' }) }
      }
      if (url.endsWith('/operations/current-activate')) return { ok: true, json: async () => ({ id: 'current-activate', kind: 'activate', skinId: skin.id, phase: 'done', restartRequired: false }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const clientRuntime = { setActive: vi.fn(async () => true) }
    render(<SkinMarketSection t={key => key} clientRuntime={clientRuntime} />)
    fireEvent.click(await screen.findByRole('button', { name: hostKind === 'desktop' ? '安装' : '安装并使用' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/activate') && init?.method === 'POST')).toBe(true))
    expect(await screen.findAllByRole('button', { name: '停用' })).not.toHaveLength(0)
    if (hostKind === 'desktop') expect(clientRuntime.setActive).not.toHaveBeenCalled()
    else expect(clientRuntime.setActive).toHaveBeenCalledWith(skin.package, true)
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/restart') && init?.method === 'POST')).toBe(false)
  })

  it.each([
    ['discovery', false, false, '0.2.1-alpha.3', false], ['detail', false, false, '0.2.1-alpha.3', false],
    ['discovery', true, false, '0.2.1-alpha.3', false], ['detail', true, false, '0.2.1-alpha.3', false],
    ['discovery', false, true, '0.2.1-alpha.3', false], ['detail', false, true, '0.2.1-alpha.3', false],
    ['discovery', true, true, '0.2.0-rc.2', true], ['detail', true, true, '0.2.0-rc.2', true],
    ['discovery', true, true, '0.2.0-rc.2', undefined], ['detail', true, true, '0.2.0-rc.2', undefined],
  ] as const)('finishes official Desktop install-and-use from %s before presenting one restart dialog (install=%s, switch=%s, version=%s, hint=%s)', async (entry, installRestart, switchRestart, version, installHint) => {
    const oldSkin = { ...managedDesktopSkin, id: 'old.skin', package: 'old-skin', name: { zh: '原皮肤', en: 'Old Skin' } }
    let installed = false
    let switched = false
    let finishActivation!: (value: unknown) => void
    const activationResult = new Promise<unknown>(resolve => { finishActivation = resolve })
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [managedDesktopSkin, oldSkin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({
        hostKind: 'desktop', restartAvailable: false, runtime: { ...dshRuntime, version },
        management: { ...officialManagement, ...(installHint !== undefined && { installRequiresRestart: installHint }) },
        skins: [
          { skinId: oldSkin.id, installation: 'installed', activation: switched ? 'inactive' : 'active', primary: !switched, installedVersion: '1.0.0', updateAvailable: false },
          ...(installed ? [{ skinId: skin.id, installation: 'installed', activation: switched ? installRestart || switchRestart ? 'restart-required' : 'active' : installRestart ? 'restart-required' : 'inactive', primary: switched, installedVersion: '1.0.0', updateAvailable: false }] : []),
        ],
      }) }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.58', latestVersion: '0.1.58', updateAvailable: false }) }
      if (url.endsWith('/install') && init?.method === 'POST') {
        installed = true
        return { ok: true, json: async () => ({ operationId: 'alpha3-install' }) }
      }
      if (url.endsWith('/operations/alpha3-install')) return { ok: true, json: async () => ({ id: 'alpha3-install', kind: 'install', skinId: skin.id, phase: 'done', restartRequired: installRestart }) }
      if (url.endsWith('/activate') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'alpha3-switch' }) }
      if (url.endsWith('/operations/alpha3-switch')) return { ok: true, json: async () => activationResult }
      if (url.endsWith('/uninstall') && init?.method === 'POST') {
        installed = false
        return { ok: true, json: async () => ({ operationId: 'alpha3-remove' }) }
      }
      if (url.endsWith('/operations/alpha3-remove')) return { ok: true, json: async () => ({ id: 'alpha3-remove', kind: 'uninstall', skinId: skin.id, phase: 'done', restartRequired: false }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const clientRuntime = { setActive: vi.fn(async () => true) }
    render(<SkinMarketSection t={key => key} clientRuntime={clientRuntime} />)
    if (entry === 'detail') await openSkinCard()
    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/operations/alpha3-switch'))).toBe(true))
    expect(screen.queryByText(/请手动重启 Desktop App/)).toBeNull()
    expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
    switched = true
    await act(async () => {
      finishActivation({ id: 'alpha3-switch', kind: 'activate', skinId: skin.id, phase: 'done', restartRequired: installRestart || switchRestart })
      await activationResult
    })
    if (installRestart || switchRestart) {
      expect(await screen.findAllByText('测试皮肤 已切换，请手动重启 Desktop App 后生效')).toHaveLength(entry === 'detail' ? 2 : 1)
      expect(screen.queryByText('请手动重启 Desktop App 后生效')).toBeNull()
      const restartDialog = await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })
      expect(restartDialog.textContent).toContain('已启用“测试皮肤”')
      fireEvent.click(within(restartDialog).getByRole('button', { name: '稍后' }))
      expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
      fireEvent.click(screen.getAllByRole('button', { name: '查看重启提示' })[0]!)
      expect(screen.getByRole('dialog', { name: '请手动重启 Desktop App' })).toBeTruthy()
      fireEvent.click(within(screen.getByRole('dialog', { name: '请手动重启 Desktop App' })).getByRole('button', { name: '关闭' }))
    } else {
      expect(await screen.findAllByRole('button', { name: '停用' })).not.toHaveLength(0)
      expect(screen.queryByText(/请手动重启 Desktop App/)).toBeNull()
    }
    expect(fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/install') && init?.method === 'POST')).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/activate') && init?.method === 'POST')).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: '需要重启 DSH 应用此皮肤' })).toBeNull()
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/restart') && init?.method === 'POST')).toBe(false)
    expect(clientRuntime.setActive).not.toHaveBeenCalled()
    if (entry === 'detail' && (installRestart || switchRestart)) {
      fireEvent.click(screen.getByRole('button', { name: '卸载' }))
      fireEvent.click(within(await screen.findByRole('dialog', { name: '卸载皮肤' })).getByRole('button', { name: '确认卸载' }))
      await waitFor(() => expect(screen.queryByText('测试皮肤 已切换，请手动重启 Desktop App 后生效')).toBeNull())
    }
  })

  it.each(['catalog', 'activate-post', 'activate-poll', 'activate-refresh'] as const)('keeps a %s exception primary during install-and-use and restores the installation reminder without auto-opening it', async failurePoint => {
    let installed = false
    let activated = false
    let rejectCompletionCatalog: (() => void) | undefined
    let completionCatalogRejected = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) {
        if (installed && failurePoint === 'catalog') throw new Error('catalog temporarily unavailable')
        if (activated && failurePoint === 'activate-refresh') {
          if (completionCatalogRejected) throw new Error('catalog temporarily unavailable')
          return await new Promise((_resolve, reject) => {
            rejectCompletionCatalog = () => { completionCatalogRejected = true; reject(new Error('catalog temporarily unavailable')) }
          })
        }
        return { ok: true, json: async () => ({ skins: [managedDesktopSkin] }) }
      }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({
        hostKind: 'desktop', restartAvailable: false, runtime: { ...dshRuntime, version: '0.2.1-alpha.3' },
        management: { ...officialManagement, installRequiresRestart: false },
        skins: installed ? [{ skinId: skin.id, installation: 'installed', activation: 'restart-required', installedVersion: '1.0.0', updateAvailable: false }] : [],
      }) }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.58', latestVersion: '0.1.58', updateAvailable: false }) }
      if (url.endsWith('/install') && init?.method === 'POST') {
        installed = true
        return { ok: true, json: async () => ({ operationId: 'interrupted-install' }) }
      }
      if (url.endsWith('/operations/interrupted-install')) return { ok: true, json: async () => ({ id: 'interrupted-install', kind: 'install', skinId: skin.id, phase: 'done', restartRequired: true }) }
      if (url.endsWith('/activate') && init?.method === 'POST') {
        if (failurePoint === 'activate-post') throw new Error('activate transport unavailable')
        activated = true
        return { ok: true, json: async () => ({ operationId: 'interrupted-activate' }) }
      }
      if (url.endsWith('/operations/interrupted-activate')) {
        if (failurePoint === 'activate-poll') throw new Error('activate result unavailable')
        return { ok: true, json: async () => ({ id: 'interrupted-activate', kind: 'activate', skinId: skin.id, phase: 'done', restartRequired: true }) }
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    if (failurePoint === 'activate-refresh') {
      await waitFor(() => expect(rejectCompletionCatalog).toBeTypeOf('function'))
      expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
      await act(async () => rejectCompletionCatalog!())
    }
    const failure = await screen.findByRole('dialog', { name: failurePoint === 'catalog' ? '安装未完成' : '启用未完成' })
    expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
    expect(screen.getAllByText(failurePoint === 'catalog' ? '测试皮肤 已安装，但未启用' : '测试皮肤 已安装，自动切换结果待确认').length).toBeGreaterThan(0)
    fireEvent.click(within(failure).getByRole('button', { name: '确认' }))
    fireEvent.click(screen.getAllByRole('button', { name: '查看重启提示' })[0]!)
    const dialog = await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })
    expect(dialog.textContent).toContain(failurePoint === 'catalog' ? '自动切换尚未完成' : '自动切换结果待确认，请在官方插件页核对启用状态')
    if (failurePoint !== 'catalog') expect(dialog.textContent).not.toContain('尚未启用')
    expect(dialog.textContent).not.toContain('已保存')
    expect(dialog.textContent).not.toContain('重启后可使用')
    expect(screen.queryByText('测试皮肤 已切换，请手动重启 Desktop App 后生效')).toBeNull()
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/activate') && init?.method === 'POST')).toBe(failurePoint !== 'catalog')
  })

  it.each(['discovery', 'detail'])('does not activate an installed skin when its %s view unmounts during the completion response', async entry => {
    let resolveOperation!: (value: unknown) => void
    const operationResult = new Promise<unknown>(resolve => { resolveOperation = resolve })
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runtime: dshRuntime }) }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.58', latestVersion: '0.1.58', updateAvailable: false }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'unmounted-install' }) }
      if (url.endsWith('/operations/unmounted-install')) return { ok: true, json: async () => operationResult }
      if (url.endsWith('/activate') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'unexpected-activate' }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<SkinMarketSection t={key => key} />)
    if (entry === 'detail') await openSkinCard()
    fireEvent.click(await screen.findByRole('button', { name: '安装并使用' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/operations/unmounted-install'))).toBe(true))
    const stateRequests = fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length
    view.unmount()
    await act(async () => {
      resolveOperation({ id: 'unmounted-install', kind: 'install', skinId: skin.id, phase: 'done' })
      await operationResult
    })
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/activate') && init?.method === 'POST')).toBe(false)
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/state'))).toHaveLength(stateRequests)
  })

  it('does not change the client loader when the view unmounts during a deactivate completion response', async () => {
    let resolveOperation!: (value: unknown) => void
    const operationResult = new Promise<unknown>(resolve => { resolveOperation = resolve })
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [{ skinId: skin.id, installation: 'installed', activation: 'active', installedVersion: '1.0.0', updateAvailable: false }], runtime: dshRuntime }) }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.58', latestVersion: '0.1.58', updateAvailable: false }) }
      if (url.endsWith('/deactivate') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'unmounted-deactivate' }) }
      if (url.endsWith('/operations/unmounted-deactivate')) return { ok: true, json: async () => operationResult }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const clientRuntime = { setActive: vi.fn(async () => true) }
    const view = render(<SkinMarketSection t={key => key} clientRuntime={clientRuntime} />)
    fireEvent.click((await screen.findAllByRole('button', { name: '停用' }))[0]!)
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/operations/unmounted-deactivate'))).toBe(true))
    const stateRequests = fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length
    view.unmount()
    await act(async () => {
      resolveOperation({ id: 'unmounted-deactivate', kind: 'deactivate', skinId: skin.id, phase: 'done' })
      await operationResult
    })
    expect(clientRuntime.setActive).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/state'))).toHaveLength(stateRequests)
  })

  it('lets a second discovery card start while another install is still downloading', async () => {
    const other = { ...skin, id: 'test.other', name: { zh: '另一款皮肤', en: 'Other Skin' }, package: 'other-skin', rowId: 'other-skin', repo: 'https://github.com/a/c' }
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin, other] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runtime: dshRuntime, operations: [] }) }
      if (url.endsWith('/install') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { skinId: string }
        return { ok: true, json: async () => ({ operationId: `install-${body.skinId}` }) }
      }
      if (url.includes('/operations/install-')) {
        const id = url.split('/').at(-1)!
        const skinId = id.slice('install-'.length)
        return { ok: true, json: async () => ({
          id, kind: 'install', skinId, phase: skinId === other.id ? 'done' : 'downloading', startedAt: new Date().toISOString(),
        }) }
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)

    const first = await screen.findByRole('group', { name: '测试皮肤 操作' })
    const second = await screen.findByRole('group', { name: '另一款皮肤 操作' })
    fireEvent.click(within(first).getByRole('button', { name: '安装并使用' }))
    await waitFor(() => expect(first.textContent).toContain('安装中'))
    const queued = within(second).getByRole('button', { name: '安装' })
    expect(queued.hasAttribute('disabled')).toBe(false)
    expect(within(second).queryByRole('button', { name: '安装并使用' })).toBeNull()
    fireEvent.click(queued)
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/install') && (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(2))
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/activate') && (init as RequestInit | undefined)?.method === 'POST')).toBe(false)
  })

  it.each(['discovery', 'detail'] as const)('keeps the official Desktop %s install as one automatic action and waits for another installation', async entry => {
    const other = { ...managedDesktopSkin, id: 'other.skin', name: { zh: '正在安装的皮肤', en: 'Installing Skin' } }
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [managedDesktopSkin, other] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({
        hostKind: 'desktop', restartAvailable: false, runtime: { ...dshRuntime, version: '0.2.0-rc.2' }, management: { ...officialManagement, installRequiresRestart: true }, skins: [],
        operations: [{ id: 'other-install', skinId: other.id, kind: 'install', phase: 'downloading', startedAt: new Date().toISOString() }],
      }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    if (entry === 'detail') await openSkinCard()
    const region = entry === 'detail' ? screen.getByRole('main', { name: '皮肤详情内容' }) : await screen.findByRole('group', { name: '测试皮肤 操作' })
    const install = within(region).getByRole('button', { name: '安装' })
    expect(install.hasAttribute('disabled')).toBe(true)
    expect(install.getAttribute('title')).toBe('请等待当前安装完成，再安装其他皮肤')
    expect(within(region).queryByRole('button', { name: '仅安装' })).toBeNull()
    expect(within(region).queryByRole('button', { name: '安装并使用' })).toBeNull()
    fireEvent.click(install)
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/install'))).toBe(false)
  })

  it.each(['discovery', 'detail'] as const)('blocks the official Desktop %s install when the host cannot enable its target', async entry => {
    const reason = '当前宿主无法保存插件启用状态'
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [managedDesktopSkin] } : {
      hostKind: 'desktop', restartAvailable: false, runtime: { ...dshRuntime, version: '0.2.0-rc.2' }, skins: [],
      management: { ...officialManagement, capabilities: { ...officialManagement.capabilities, enable: { available: false, reason } } },
    } })))
    render(<SkinMarketSection t={key => key} />)
    if (entry === 'detail') await openSkinCard()
    const region = entry === 'detail' ? screen.getByRole('main', { name: '皮肤详情内容' }) : await screen.findByRole('group', { name: '测试皮肤 操作' })
    const install = within(region).getByRole('button', { name: '安装' })
    expect(install.hasAttribute('disabled')).toBe(true)
    expect(install.getAttribute('title')).toBe(reason)
    expect(screen.getAllByText(reason).length).toBeGreaterThan(0)
    expect(within(region).queryByRole('button', { name: '仅安装' })).toBeNull()
  })

  it.each(['overridden', 'failed'] as const)('keeps the %s activation failure primary after installation and leaves only an honest manual restart banner', async application => {
    let installed = false
    const oldSkin = { ...managedDesktopSkin, id: 'old.skin', package: 'old-skin', name: { zh: '原皮肤', en: 'Old Skin' } }
    const message = application === 'overridden' ? '启停设置已保存，但被其他配置覆盖，尚未生效' : '启用保存失败，已恢复原皮肤'
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [managedDesktopSkin, oldSkin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ hostKind: 'desktop', restartAvailable: false, restartNoticeId: 'installation-and-rollback', runtime: { ...dshRuntime, version: '0.2.0-rc.2' }, management: { ...officialManagement, installRequiresRestart: true }, skins: [
        { skinId: oldSkin.id, installation: 'installed', activation: installed ? 'restart-required' : 'active', primary: true, installedVersion: '1.0.0', updateAvailable: false },
        ...(installed ? [{ skinId: skin.id, installation: 'installed', activation: 'restart-required', primary: false, installedVersion: '1.0.0', updateAvailable: false }] : []),
      ] }) }
      if (url.endsWith('/install') && init?.method === 'POST') { installed = true; return { ok: true, json: async () => ({ operationId: 'installed-before-failure' }) } }
      if (url.endsWith('/operations/installed-before-failure')) return { ok: true, json: async () => ({ id: 'installed-before-failure', skinId: skin.id, kind: 'install', phase: 'done', restartRequired: true }) }
      if (url.endsWith('/activate') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'switch-failed' }) }
      if (url.endsWith('/operations/switch-failed')) return { ok: true, json: async () => ({ id: 'switch-failed', skinId: skin.id, kind: 'activate', phase: 'failed', application, message }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    const failure = await screen.findByRole('dialog', { name: '启用未完成' })
    if (application === 'overridden') {
      expect(failure.textContent).toContain('请解除该皮肤的禁用设置后，再点“使用”。')
      expect(failure.textContent).not.toContain('重启无法')
    } else expect(failure.textContent).toContain(message)
    expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
    expect(await screen.findByText('测试皮肤 已安装，但未启用')).toBeTruthy()
    const stateRequests = fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length).toBeGreaterThan(stateRequests))
    expect(screen.getByRole('dialog', { name: '启用未完成' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
    fireEvent.click(within(failure).getByRole('button', { name: '确认' }))
    fireEvent.click(screen.getByRole('button', { name: '查看重启提示' }))
    const dialog = await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })
    expect(dialog.textContent).toContain('已安装，但尚未启用')
    expect(dialog.textContent).toContain('自动切换尚未完成')
    expect(dialog.textContent).not.toContain('重启后可使用')
    expect(dialog.textContent).not.toContain('已启用“测试皮肤”')
    expect(dialog.textContent).not.toContain('“原皮肤”的设置')
    expect(screen.queryByText('测试皮肤 已切换，请手动重启 Desktop App 后生效')).toBeNull()
  })

  it('asks before installing an incompatible skin and carries consent through this install-and-use action', async () => {
    const incompatible = { ...skin, id: 'test.incompatible', name: { zh: '不兼容皮肤', en: 'Incompatible Skin' }, compatibility: { dsh: '<0.1.0-rc.6', platform: ['web'] } }
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [incompatible] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runtime: { version: '0.1.1-rc.1', capabilities: ['slot:keyed:settings.plugin.item'], source: 'injected' } }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'op-incompatible' }) }
      if (url.endsWith('/operations/op-incompatible')) return { ok: true, json: async () => ({ id: 'op-incompatible', kind: 'install', skinId: incompatible.id, phase: 'done' }) }
      if (url.endsWith('/activate') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'op-activate' }) }
      if (url.endsWith('/operations/op-activate')) return { ok: true, json: async () => ({ id: 'op-activate', kind: 'activate', skinId: incompatible.id, phase: 'done' }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)

    await openSkinCard(/不兼容皮肤 界面预览/)
    expect(screen.getByRole('button', { name: '安装并使用' })).toBeTruthy()
    expect(screen.queryByText(/仍可安装|仍可继续使用/)).toBeNull()
    expect(screen.queryByRole('dialog', { name: '兼容性提示' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '安装并使用' }))
    const dialog = await screen.findByRole('dialog', { name: '兼容性提示' })
    expect(dialog.textContent).toMatch(/不在作者声明的兼容范围/)
    expect(dialog.textContent).toMatch(/可能安装失败、功能异常或页面无法操作/)
    expect(within(dialog).getByRole('link', { name: '页面异常时重置皮肤' }).getAttribute('href')).toContain('#页面异常时重置皮肤')
    expect(screen.queryByRole('button', { name: '确认无任务，立即重启' })).toBeNull()
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '兼容性提示' })).toBeNull()
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '安装并使用' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: '兼容性提示' })).getByRole('button', { name: '仍然安装并使用' }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/activate') && init?.method === 'POST')).toHaveLength(1))
    for (const endpoint of ['install', 'activate']) {
      expect(JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url.endsWith(`/${endpoint}`) && init?.method === 'POST')?.[1]?.body))).toEqual({ skinId: incompatible.id, acknowledgeCompatibility: true, compatibilityContext: compatibilityContext(incompatible, { ...dshRuntime, version: '0.1.1-rc.1' }) })
    }
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '兼容性提示' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '仅安装' }))
    const nextAttempt = await screen.findByRole('dialog', { name: '兼容性提示' })
    expect(within(nextAttempt).getByRole('button', { name: '仍然安装' })).toBeTruthy()
    expect(fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/install') && init?.method === 'POST')).toHaveLength(1)
    fireEvent.click(within(nextAttempt).getByRole('button', { name: '关闭' }))
    expect(fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/install') && init?.method === 'POST')).toHaveLength(1)
  })

  it.each(['discovery', 'detail'])('asks before an incompatible update in the %s view without sending a request on cancel', async entry => {
    const incompatible = { ...skin, compatibility: { dsh: '<0.1.0-rc.6', platform: ['web'] } }
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [incompatible] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ runtime: dshRuntime, skins: [{ skinId: skin.id, installation: 'installed', activation: 'inactive', installedVersion: '0.9.0', updateAvailable: true }] }) }
      if (url.endsWith('/update') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'incompatible-update' }) }
      if (url.endsWith('/operations/incompatible-update')) return { ok: true, json: async () => ({ id: 'incompatible-update', kind: 'update', skinId: skin.id, phase: 'done' }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    if (entry === 'detail') {
      fireEvent.click(await screen.findByRole('button', { name: '测试皮肤 已安装卡片' }))
    }
    fireEvent.click((await screen.findAllByRole('button', { name: '更新' }))[0]!)
    fireEvent.click(within(await screen.findByRole('dialog', { name: '兼容性提示' })).getByRole('button', { name: '取消' }))
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    fireEvent.click(screen.getAllByRole('button', { name: '更新' })[0]!)
    fireEvent.click(within(await screen.findByRole('dialog', { name: '兼容性提示' })).getByRole('button', { name: '仍然更新' }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/update') && init?.method === 'POST')).toHaveLength(1))
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url.endsWith('/update') && init?.method === 'POST')?.[1]?.body))).toEqual({ skinId: skin.id, acknowledgeCompatibility: true, compatibilityContext: compatibilityContext(incompatible, dshRuntime) })
  })

  it('asks for compatibility consent after migration confirmation and sends it only when accepted', async () => {
    const incompatible = { ...skin, compatibility: { dsh: '<0.1.0-rc.6', platform: ['web'] } }
    const sourceMigration = { target: 'skin@1.0.0', currentSource: skin.install.target }
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [incompatible] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ runtime: dshRuntime, skins: [{ skinId: skin.id, installation: 'installed', activation: 'inactive', installedVersion: '1.0.0', updateAvailable: false, sourceMigration }] }) }
      if (url.endsWith('/migrate') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'incompatible-migrate' }) }
      if (url.endsWith('/operations/incompatible-migrate')) return { ok: true, json: async () => ({ id: 'incompatible-migrate', kind: 'migrate', skinId: skin.id, phase: 'done' }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    fireEvent.click((await screen.findAllByRole('button', { name: '换用 npm' }))[0]!)
    fireEvent.click(screen.getByRole('button', { name: '确认换用 npm' }))
    const dialog = await screen.findByRole('dialog', { name: '兼容性提示' })
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: '仍然换用 npm' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/migrate') && init?.method === 'POST')).toBe(true))
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url.endsWith('/migrate') && init?.method === 'POST')?.[1]?.body))).toEqual({ skinId: skin.id, acknowledgeCompatibility: true, compatibilityContext: compatibilityContext(incompatible, dshRuntime) })
  })

  it('warns before installing an incompatible skin on official Desktop and carries its consent through automatic activation', async () => {
    const incompatible = { ...managedDesktopSkin, compatibility: { dsh: '0.1.0-rc.6', platform: ['web', 'desktop'] } }
    let installed = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [incompatible] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ hostKind: 'desktop', restartAvailable: false, runtime: { ...dshRuntime, version: '0.2.0-rc.2' }, management: { ...officialManagement, installRequiresRestart: true }, skins: installed ? [{ skinId: skin.id, installation: 'installed', activation: 'restart-required', installedVersion: '1.0.0', updateAvailable: false }] : [] }) }
      if (url.endsWith('/install') && init?.method === 'POST') { installed = true; return { ok: true, json: async () => ({ operationId: 'incompatible-desktop' }) } }
      if (url.endsWith('/operations/incompatible-desktop')) return { ok: true, json: async () => ({ id: 'incompatible-desktop', kind: 'install', skinId: skin.id, phase: 'done', restartRequired: true }) }
      if (url.endsWith('/activate') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'incompatible-desktop-activate' }) }
      if (url.endsWith('/operations/incompatible-desktop-activate')) return { ok: true, json: async () => ({ id: 'incompatible-desktop-activate', kind: 'activate', skinId: skin.id, phase: 'done', restartRequired: true }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    const dialog = await screen.findByRole('dialog', { name: '兼容性提示' })
    expect(dialog.textContent).toContain('当前 DSH 0.2.0-rc.2')
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: '仍然安装' }))
    expect(await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })).toBeTruthy()
    expect(screen.getByText('测试皮肤 已切换，请手动重启 Desktop App 后生效')).toBeTruthy()
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url.endsWith('/install') && init?.method === 'POST')?.[1]?.body))).toEqual({ skinId: skin.id, acknowledgeCompatibility: true, compatibilityContext: compatibilityContext(incompatible, { ...dshRuntime, version: '0.2.0-rc.2' }) })
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url.endsWith('/activate') && init?.method === 'POST')?.[1]?.body))).toEqual({ skinId: skin.id, acknowledgeCompatibility: true, compatibilityContext: compatibilityContext(incompatible, { ...dshRuntime, version: '0.2.0-rc.2' }) })
  })

  it.each(['unmount', 'profile-busy'])('does not start an incompatible install if %s interrupts its confirmation', async interruption => {
    const incompatible = { ...skin, compatibility: { dsh: '<0.1.0-rc.6', platform: ['web'] } }
    let profileBusy = false
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [incompatible] } : url.endsWith('/state') ? { skins: [], runtime: dshRuntime, ...(profileBusy && { profileBusy: '当前 profile 正在等待宿主确认' }) } : {} }))
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    fireEvent.click(screen.getByRole('button', { name: '安装并使用' }))
    const dialog = await screen.findByRole('dialog', { name: '兼容性提示' })
    if (interruption === 'unmount') {
      view.unmount()
      await act(async () => undefined)
    } else {
      profileBusy = true
      fireEvent.focus(window)
      await waitFor(() => expect(screen.getByRole('button', { name: '安装并使用' }).hasAttribute('disabled')).toBe(true))
      fireEvent.click(within(dialog).getByRole('button', { name: '仍然安装并使用' }))
      expect(await screen.findByRole('alert')).toHaveProperty('textContent', '当前 profile 正在等待宿主确认')
    }
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it.each(['catalog', 'runtime', 'compatible', 'unknown'])('refreshes a pending warning after a %s change and requires another confirmation', async changed => {
    const original = { ...skin, compatibility: { dsh: '<0.1.0-rc.6', platform: ['web'] } }
    const updated = { ...original, install: { ...skin.install, version: '2.0.0', commit: 'b'.repeat(40), target: `https://github.com/a/b.git#${'b'.repeat(40)}` }, compatibility: { ...original.compatibility, dsh: changed === 'compatible' ? '>=0.1.0-rc.6' : '<0.0.9' } }
    let currentSkin = original
    let currentRuntime: typeof dshRuntime | null = dshRuntime
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [currentSkin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], ...(currentRuntime !== null && { runtime: currentRuntime }) }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'refreshed-install' }) }
      if (url.endsWith('/operations/refreshed-install')) return { ok: true, json: async () => ({ id: 'refreshed-install', kind: 'install', skinId: skin.id, phase: 'done' }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    fireEvent.click(screen.getByRole('button', { name: '仅安装' }))
    const warning = await screen.findByRole('dialog', { name: '兼容性提示' })
    expect(warning.textContent).toContain('版本 1.0.0')
    const originalContext = compatibilityContext(original, dshRuntime)

    if (changed === 'runtime') currentRuntime = { ...dshRuntime, version: '0.2.0-rc.2' }
    else if (changed === 'unknown') currentRuntime = null
    else currentSkin = updated
    fireEvent.focus(window)
    await waitFor(() => {
      const detail = screen.getByRole('dialog', { name: '皮肤详情' }).textContent
      if (changed === 'runtime') expect(detail).toContain('当前 DSH 0.2.0-rc.2')
      else if (changed === 'unknown') expect(detail).not.toContain('当前 DSH')
      else expect(detail).toContain('版本 2.0.0')
    })
    fireEvent.click(within(warning).getByRole('button', { name: '仍然安装' }))
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    expect(warning.textContent).toContain('皮肤安装目标或当前 DSH 信息已变化，请重新确认')
    if (changed === 'runtime') expect(warning.textContent).toContain('当前 DSH 0.2.0-rc.2')
    else if (changed === 'unknown') expect(warning.textContent).toContain('无法读取当前 DSH 版本')
    else expect(warning.textContent).toContain('版本 2.0.0')
    fireEvent.click(within(warning).getByRole('button', { name: '仍然安装' }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/install') && init?.method === 'POST')).toHaveLength(1))
    const request = JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url.endsWith('/install') && init?.method === 'POST')?.[1]?.body))
    expect(request).toEqual({ skinId: skin.id, acknowledgeCompatibility: true, compatibilityContext: compatibilityContext(currentSkin, currentRuntime) })
    expect(request.compatibilityContext).not.toBe(originalContext)
  })

  it('asks again before activation if the install completion refresh changes the acknowledged package', async () => {
    const original = { ...skin, compatibility: { dsh: '<0.1.0-rc.6', platform: ['web'] } }
    const updated = { ...original, install: { ...skin.install, version: '2.0.0', commit: 'b'.repeat(40), target: `https://github.com/a/b.git#${'b'.repeat(40)}` }, compatibility: { ...original.compatibility, dsh: '<0.0.9' } }
    let installed = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [installed ? updated : original] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ runtime: dshRuntime, skins: installed ? [{ skinId: skin.id, installation: 'installed', activation: 'inactive', installedVersion: '1.0.0', updateAvailable: true }] : [] }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'changed-before-use-install' }) }
      if (url.endsWith('/operations/changed-before-use-install')) {
        installed = true
        return { ok: true, json: async () => ({ id: 'changed-before-use-install', kind: 'install', skinId: skin.id, phase: 'done' }) }
      }
      if (url.endsWith('/activate') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'changed-before-use-activate' }) }
      if (url.endsWith('/operations/changed-before-use-activate')) return { ok: true, json: async () => ({ id: 'changed-before-use-activate', kind: 'activate', skinId: skin.id, phase: 'done' }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    fireEvent.click(screen.getByRole('button', { name: '安装并使用' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: '兼容性提示' })).getByRole('button', { name: '仍然安装并使用' }))
    const useConfirmation = await screen.findByRole('button', { name: '仍然使用' })
    expect(screen.getByRole('dialog', { name: '兼容性提示' }).textContent).toContain('版本 2.0.0')
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/activate') && init?.method === 'POST')).toBe(false)
    fireEvent.click(useConfirmation)
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/activate') && init?.method === 'POST')).toBe(true))
    const installRequest = JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url.endsWith('/install') && init?.method === 'POST')?.[1]?.body))
    const activateRequest = JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url.endsWith('/activate') && init?.method === 'POST')?.[1]?.body))
    expect(installRequest.compatibilityContext).toBe(compatibilityContext(original, dshRuntime))
    expect(activateRequest.compatibilityContext).toBe(compatibilityContext(updated, dshRuntime))
    expect(activateRequest.compatibilityContext).not.toBe(installRequest.compatibilityContext)
  })

  it('still installs when runtime version is unknown', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [] }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'op-unknown' }) }
      if (url.endsWith('/operations/op-unknown')) return { ok: true, json: async () => ({ id: 'op-unknown', kind: 'install', skinId: skin.id, phase: 'done' }) }
      if (url.endsWith('/activate') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'op-activate' }) }
      if (url.endsWith('/operations/op-activate')) return { ok: true, json: async () => ({ id: 'op-activate', kind: 'activate', skinId: skin.id, phase: 'done' }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    expect(screen.queryByRole('dialog', { name: '兼容性提示' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '安装并使用' }))
    const dialog = await screen.findByRole('dialog', { name: '兼容性提示' })
    expect(dialog.textContent).toMatch(/无法读取当前 DSH 版本/)
    expect(dialog.textContent).toMatch(/仍可继续使用/)
    expect(screen.queryByRole('button', { name: '确认无任务，立即重启' })).toBeNull()
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/install'))).toBe(true))
    expect(screen.queryByRole('dialog', { name: '已拦截安装' })).toBeNull()
  })

  it('opens a concise manual install dialog with prompt and plugin keyword methods', async () => {
    const manual = { ...skin, review: { compatibility: 'verified' as const, preview: 'verified' as const, installation: 'manual-only' as const } }
    const writeText = vi.fn(async () => undefined)
    const open = vi.fn()
    Object.assign(navigator, { clipboard: { writeText } })
    vi.stubGlobal('open', open)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [manual] } : { skins: [] } })))
    render(<SkinMarketSection t={key => key} />)

    fireEvent.click(await screen.findByRole('button', { name: '需手动安装' }))
    const dialog = screen.getByRole('dialog', { name: '安装 测试皮肤' })
    expect(dialog.textContent).toContain('让 Agent 检查并指导安装')
    expect(dialog.textContent).toContain('插件页安装目标')
    expect(dialog.textContent).toContain('也可自行打开「插件 → 添加插件」，输入：')
    expect(dialog.textContent).not.toContain('该皮肤需要 Agent 协助安装')
    expect(screen.queryByRole('button', { name: '复制命令' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '复制提示词' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    expect(screen.getByRole('textbox', { name: '插件页安装目标' })).toHaveProperty('value', createSkinInstallSearchKeyword(manual))
    expect(screen.queryByRole('button', { name: '打开安装页面' })).toBeNull()
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '复制插件页安装目标' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(createSkinInstallSearchKeyword(manual)))
    const copyPrompt = screen.getAllByRole('button', { name: '复制提示词' }).at(-1)!
    fireEvent.click(copyPrompt)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(createSkinInstallPrompt(manual, 'dsh')))
  })

  it('explains the Desktop manual-only reason before offering the plugin keyword', async () => {
    const manual = {
      ...skin,
      install: { ...skin.install, desktop: { mode: 'manual-only' as const, reason: 'npm-package-not-found' } },
      review: { compatibility: 'verified' as const, preview: 'verified' as const, installation: 'manual-only' as const },
    }
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/catalog')
        ? { skins: [manual] }
        : { hostKind: 'desktop', skins: [] },
    }))
    const writeText = vi.fn(async () => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)

    fireEvent.click(await screen.findByRole('button', { name: '需手动安装' }))
    const dialog = screen.getByRole('dialog', { name: '安装 测试皮肤' })
    await waitFor(() => expect(dialog.textContent).toContain('无法自动安装：未找到可供 Desktop 安装的 npm 包'))
    expect(dialog.textContent).toContain('插件页安装目标')
    expect(dialog.textContent).toContain('也可自行打开「插件 → 添加插件」，输入：')
    expect(dialog.textContent).toContain('桌面端由你在插件页操作')
    expect([...dialog.querySelectorAll('code')].map(node => node.textContent)).toEqual([createSkinInstallPrompt(manual, 'desktop')])
    expect(dialog.textContent).not.toContain('dsh plugin --profile web')
    fireEvent.click(within(dialog).getByRole('button', { name: '复制提示词' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(createSkinInstallPrompt(manual, 'desktop')))
    expect(dialog.textContent).not.toContain('手动安装路径')
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/install'))).toBe(false)
  })

  it('keeps installed skins in discovery and exposes Use and Update on both cards', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [{
        skinId: skin.id,
        installation: 'installed',
        activation: 'inactive',
        installedVersion: '1.0.0',
        updateAvailable: true,
        installedAt: '2026-08-16T00:00:00Z',
      }] },
    })))
    render(<SkinMarketSection t={key => key} />)

    expect(await screen.findByRole('button', { name: '测试皮肤 已安装卡片' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '测试皮肤 界面预览' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '使用' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '更新' })).toHaveLength(2)
    await openSkinCard()
    const use = screen.getByRole('button', { name: '使用' })
    const pin = screen.getByRole('button', { name: '常驻使用' })
    expect(use.getAttribute('variant')).toBe('primary')
    expect(pin.getAttribute('variant')).toBe('outline')
    expect(use.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('exposes Stop on active installed cards', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [{
        skinId: skin.id,
        installation: 'installed',
        activation: 'active',
        installedVersion: '1.0.0',
        updateAvailable: false,
      }] },
    })))
    render(<SkinMarketSection t={key => key} />)

    expect(await screen.findAllByRole('button', { name: '停用' })).toHaveLength(2)
  })

  it('explains the conflict risk before pinning an active skin', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [{
        skinId: skin.id,
        installation: 'installed',
        activation: 'active',
        primary: true,
        pinned: false,
        installedVersion: '1.0.0',
        updateAvailable: false,
      }] },
    })))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    const pin = await screen.findByRole('button', { name: '常驻使用' })
    expect(pin.getAttribute('title')).toContain('宠物、音效')
    fireEvent.click(pin)
    const dialog = screen.getByRole('dialog', { name: '常驻使用此皮肤' })
    expect(dialog.textContent).toContain('冲突风险由用户自行承担')
    const help = within(dialog).getByRole('link', { name: '页面异常时重置皮肤' })
    expect(help.getAttribute('href')).toBe('https://github.com/kingOfSoySauce/dsh-skin-market#页面异常时重置皮肤')
    expect(screen.getByRole('button', { name: '确认常驻' })).toBeTruthy()
  })

  it('shows an active cancel action for a pinned skin', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [{
        skinId: skin.id,
        installation: 'installed',
        activation: 'active',
        primary: false,
        pinned: true,
        installedVersion: '1.0.0',
        updateAvailable: true,
      }] },
    })))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    const stop = await screen.findByRole('button', { name: '停用' })
    const unpin = screen.getByRole('button', { name: '取消常驻' })
    const update = screen.getByRole('button', { name: '更新' })
    expect(screen.getAllByText('常驻').length).toBeGreaterThanOrEqual(3)
    expect(unpin.getAttribute('aria-pressed')).toBe('true')
    expect(stop.getAttribute('variant')).toBe('outline')
    expect(unpin.getAttribute('variant')).toBe('outline')
    expect(update.getAttribute('variant')).toBe('outline')
    expect(stop.compareDocumentPosition(unpin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(unpin.compareDocumentPosition(update) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows the cached catalog before background revalidation finishes', async () => {
    const catalogCache = { read: vi.fn(async () => [skin]), write: vi.fn(async () => undefined) }
    vi.stubGlobal('fetch', vi.fn(async () => await new Promise(() => undefined)))

    render(<SkinMarketSection t={key => key} catalogCache={catalogCache} />)

    expect(await screen.findByRole('button', { name: /测试皮肤 界面预览/ })).toBeTruthy()
    expect(screen.getByRole('status', { name: '正在加载已安装皮肤' })).toBeTruthy()
    await openSkinCard()
    expect(screen.queryByText('正在加载皮肤列表…')).toBeNull()
    expect(screen.getByText('正在加载皮肤详情…')).toBeTruthy()
  })

  it('writes a successfully refreshed catalog to the browser cache', async () => {
    const catalogCache = { read: vi.fn(async () => null), write: vi.fn(async () => undefined) }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [] } })))

    render(<SkinMarketSection t={key => key} catalogCache={catalogCache} />)

    await screen.findByRole('button', { name: /测试皮肤 界面预览/ })
    await waitFor(() => expect(catalogCache.write).toHaveBeenCalledWith([skin]))
  })

  it('renders complete discovery rows in 24-item batches as the settings feed scrolls', async () => {
    const skins = Array.from({ length: HOME_CATALOG_BATCH_SIZE * 2 + 5 }, (_, index) => ({
      ...skin,
      id: `test.skin-${index}`,
      package: `skin-${index}`,
      name: { zh: `测试皮肤 ${index}`, en: `Test Skin ${index}` },
      githubStars: HOME_CATALOG_BATCH_SIZE * 2 + 5 - index,
    }))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins } : { skins: [] } })))
    const view = render(<SkinMarketSection t={key => key} />)

    await screen.findByRole('button', { name: /测试皮肤 0 界面预览/ })
    expect(view.container.querySelector('[data-dsh-skin-market]')?.getAttribute('data-layout')).toBe('fill')
    expect(screen.getAllByRole('button', { name: /测试皮肤 \d+ 界面预览/ })).toHaveLength(HOME_CATALOG_BATCH_SIZE)
    const feed = document.querySelector<HTMLElement>('[class*="homeContent"]')
    if (feed === null) throw new Error('home content scroll area not found')
    Object.defineProperties(feed, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 500 } })
    feed.scrollTop = 1300
    fireEvent.scroll(feed)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /测试皮肤 \d+ 界面预览/ })).toHaveLength(HOME_CATALOG_BATCH_SIZE * 2))
    feed.scrollTop = 1500
    fireEvent.scroll(feed)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /测试皮肤 \d+ 界面预览/ })).toHaveLength(skins.length))
  })

  it.each(['element', 'window'] as const)('preloads embedded catalog batches against the %s scroll root and ignores stale observations', async hostKind => {
    const skins = Array.from({ length: HOME_CATALOG_BATCH_SIZE * 2 + 5 }, (_, index) => ({
      ...skin, id: `test.skin-${index}`, package: `skin-${index}`,
      name: { zh: `测试皮肤 ${index}`, en: `Test Skin ${index}` }, githubStars: 50 - index,
    }))
    const observers: TestObserver[] = []
    class TestObserver {
      target?: Element
      observe = vi.fn((target: Element) => { this.target = target })
      disconnect = vi.fn()
      constructor(private callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit) { observers.push(this) }
      emit(isIntersecting: boolean) {
        this.callback([{ isIntersecting, target: this.target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
    }
    vi.stubGlobal('IntersectionObserver', TestObserver)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins } : { skins: [] } })))
    const view = render(<div style={{ overflowY: hostKind === 'element' ? 'auto' : 'visible' }}><SkinMarketSection t={key => key} layout="embedded" /></div>)
    await screen.findByRole('button', { name: /测试皮肤 0 界面预览/ })
    const count = () => screen.getAllByRole('button', { name: /测试皮肤 \d+ 界面预览/ }).length
    const loadObserver = () => observers.filter(observer => String(observer.target?.className).includes('homeLoadMore')).at(-1)!
    expect(count()).toBe(HOME_CATALOG_BATCH_SIZE)
    const first = loadObserver()
    expect(first.options.root).toBe(hostKind === 'element' ? view.container.firstElementChild : null)
    expect(first.options.rootMargin).toBe('560px 0px')
    expect(count() % 3).toBe(0)
    expect(count() % 2).toBe(0)
    act(() => first.emit(false))
    expect(count()).toBe(HOME_CATALOG_BATCH_SIZE)
    act(() => { first.emit(true); first.emit(true) })
    await waitFor(() => expect(count()).toBe(HOME_CATALOG_BATCH_SIZE * 2))
    expect(first.disconnect).toHaveBeenCalledOnce()
    act(() => first.emit(true))
    expect(count()).toBe(HOME_CATALOG_BATCH_SIZE * 2)
    const second = loadObserver()
    fireEvent.click(screen.getByRole('button', { name: /测试皮肤 0 界面预览/ }))
    expect(second.disconnect).toHaveBeenCalledOnce()
    expect(view.container.querySelector('main')?.hidden).toBe(false)
    act(() => second.emit(true))
    const home = view.container.querySelector('main')!
    expect(home.querySelectorAll('[class*="discoveryGrid"] article')).toHaveLength(HOME_CATALOG_BATCH_SIZE * 2)
    fireEvent.click(within(screen.getByRole('dialog', { name: '皮肤详情' })).getByRole('button', { name: '关闭' }))
    const resumed = loadObserver()
    expect(resumed).not.toBe(second)
    act(() => resumed.emit(true))
    await waitFor(() => expect(count()).toBe(skins.length))
    expect(resumed.disconnect).toHaveBeenCalledOnce()
    view.unmount()
  })

  it.each(['element', 'window'] as const)('compacts the embedded header from the %s host scroll position and restores it on return', async hostKind => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [] } })))
    const view = render(<div style={{ overflowY: hostKind === 'element' ? 'auto' : 'visible' }}><SkinMarketSection t={key => key} layout="embedded" /></div>)
    await screen.findByRole('button', { name: /测试皮肤 界面预览/ })
    const host = view.container.firstElementChild as HTMLElement
    const home = host.querySelector('main')!
    const header = home.querySelector('header')!
    const feed = home.querySelector('div[class*="homeContent"]')!
    const viewportTop = hostKind === 'element' ? 82 : 0
    let scrollTop = 0
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => ({ top: 80 } as DOMRect))
    Object.defineProperty(host, 'clientTop', { configurable: true, value: 2 })
    vi.spyOn(home, 'getBoundingClientRect').mockImplementation(() => ({ top: viewportTop + 330 - scrollTop } as DOMRect))
    const scroll = (value: number) => {
      scrollTop = value
      fireEvent.scroll(hostKind === 'element' ? host : window)
    }
    scroll(402)
    expect(header.dataset.compact).toBeUndefined()
    scroll(403)
    expect(header.dataset.compact).toBe('true')
    scroll(380)
    expect(header.dataset.compact).toBe('true')
    scrollTop = 0
    fireEvent.scroll(feed)
    expect(header.dataset.compact).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /测试皮肤 界面预览/ }))
    scroll(0)
    expect(header.dataset.compact).toBe('true')
    fireEvent.click(within(screen.getByRole('dialog', { name: '皮肤详情' })).getByRole('button', { name: '关闭' }))
    expect(header.dataset.compact).toBeUndefined()
    scroll(403)
    expect(header.dataset.compact).toBe('true')
    scroll(346)
    expect(header.dataset.compact).toBeUndefined()
  })

  it('shows all embedded results when viewport observation is unavailable', async () => {
    const skins = Array.from({ length: HOME_CATALOG_BATCH_SIZE + 5 }, (_, index) => ({
      ...skin, id: `test.skin-${index}`, package: `skin-${index}`,
      name: { zh: `测试皮肤 ${index}`, en: `Test Skin ${index}` },
    }))
    vi.stubGlobal('IntersectionObserver', undefined)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins } : { skins: [] } })))
    render(<SkinMarketSection t={key => key} layout="embedded" />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /测试皮肤 \d+ 界面预览/ })).toHaveLength(skins.length))
  })

  it('keeps list and detail visible while refreshing after an operation', async () => {
    let catalogCalls = 0
    let stateCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) {
        catalogCalls += 1
        if (catalogCalls > 1) return await new Promise(() => undefined)
        return { ok: true, json: async () => ({ skins: [skin] }) }
      }
      if (url.endsWith('/state')) {
        stateCalls += 1
        if (stateCalls > 1) return await new Promise(() => undefined)
        return { ok: true, json: async () => ({ skins: [{ skinId: skin.id, installation: 'installed', activation: 'active', installedVersion: '1.0.0', updateAvailable: false }] }) }
      }
      if (url.endsWith('/deactivate') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'deactivate-1' }) }
      if (url.endsWith('/operations/deactivate-1')) return { ok: true, json: async () => ({ id: 'deactivate-1', phase: 'done' }) }
      throw new Error(`Unexpected request: ${url}`)
    }))

    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    fireEvent.click(await screen.findByRole('button', { name: '停用' }))
    await waitFor(() => expect(catalogCalls).toBe(2))

    expect(screen.getByRole('heading', { name: '测试皮肤' })).toBeTruthy()
    expect(screen.queryByText('正在加载皮肤列表…')).toBeNull()
    expect(screen.queryByText('正在加载皮肤详情…')).toBeNull()
  })

  it('uses DSH action priority and icons for inactive and active skins', async () => {
    let active = false
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      return { ok: true, json: async () => ({ skins: [{ skinId: skin.id, installation: 'installed', activation: active ? 'active' : 'inactive', installedVersion: '1.0.0', updateAvailable: true }] }) }
    }))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    const use = await screen.findByRole('button', { name: '使用' })
    const inactiveUpdate = screen.getByRole('button', { name: '更新' })
    expect(use.getAttribute('variant')).toBe('primary')
    expect(inactiveUpdate.getAttribute('variant')).toBe('outline')
    expect(use.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(inactiveUpdate.querySelector('[aria-hidden="true"]')).toBeTruthy()
    active = true
    cleanup()
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    const stop = await screen.findByRole('button', { name: '停用' })
    const activeUpdate = screen.getByRole('button', { name: '更新' })
    const uninstall = screen.getByRole('button', { name: '卸载' })
    expect(stop.getAttribute('variant')).toBe('outline')
    expect(activeUpdate.getAttribute('variant')).toBe('primary')
    expect(uninstall.getAttribute('variant')).toBe('outline')
    expect(stop.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(activeUpdate.querySelector('[aria-hidden="true"]')).toBeTruthy()
    expect(uninstall.querySelector('[aria-hidden="true"]')).toBeTruthy()
    expect(uninstall.textContent).toBe('')
  })

  it('shows a non-blocking first-use warning for other appearance plugins', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [{ skinId: skin.id, installation: 'installed', activation: 'inactive', installedVersion: '1.0.0', updateAvailable: false }] }) }
      if (url.endsWith('/activate') && init?.method === 'POST') return await new Promise(() => undefined)
      throw new Error(`Unexpected request: ${url}`)
    }))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    expect(await screen.findByText('首次启用提示：使用后会自动停用市场内的其他普通皮肤，保留常驻项。市场外安装的皮肤、主题请先在设置 → 插件中停用，避免样式冲突。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '使用' }))
    expect(screen.queryByText(/首次启用提示/)).toBeNull()
    expect(screen.queryByRole('dialog', { name: '启用皮肤前请先关闭其他皮肤' })).toBeNull()
  })

  it('uses the DSH outline capsule for the mobile back action', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [] } })))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    const back = (await screen.findAllByRole('button', { name: '返回发现' }))
      .find((button) => button.className.includes('mobileBack'))!
    expect(back.getAttribute('variant')).toBe('outline')
    expect(back.querySelector('[aria-hidden="true"]')).toBeTruthy()
  })

  it('replaces Use with a restart confirmation when activation needs restart', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { runningAgentCount: 0, skins: [{ skinId: skin.id, installation: 'installed', activation: 'restart-required', installedVersion: '1.0.0', updateAvailable: false }] } })))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    const restart = await screen.findByRole('button', { name: '重启以应用' })
    expect(screen.queryByRole('button', { name: '使用' })).toBeNull()
    fireEvent.click(restart)
    expect(screen.getByRole('dialog', { name: '需要重启 DSH 应用此皮肤' })).toBeTruthy()
    expect(await screen.findByText('Agent 状态检查已通过。但重启仍会关闭所有会话连接；即使回复已经停止显示，也请确认重要内容已保存，且没有即将开始的新任务。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '确认无任务，立即重启' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '稍后' })).toBeTruthy()
  })

  it('shows the official Desktop restart instruction without posting to the market restart route', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => url.endsWith('/catalog')
        ? { skins: [skin] }
        : {
          hostKind: 'desktop',
          restartAvailable: false,
          runningAgentCount: 0,
          skins: [{ skinId: skin.id, installation: 'installed', activation: 'restart-required', installedVersion: '1.0.0', updateAvailable: false }],
        },
    }))
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    fireEvent.click(await screen.findByRole('button', { name: '查看重启提示' }))
    expect(await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重启以应用' })).toBeNull()
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/restart') && init?.method === 'POST')).toBe(false)
  })

  it('shows an unavailable component honestly and lets Use retry its activation without suggesting restart', async () => {
    let activated = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [managedDesktopSkin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({
        instanceId: 'component-session', hostKind: 'desktop', restartAvailable: false, runtime: dshRuntime, management: officialManagement,
        skins: [{ skinId: skin.id, installation: 'installed', activation: activated ? 'active' : 'unavailable', primary: true, installedVersion: '1.0.0', updateAvailable: false,
          ...(!activated && { error: '皮肤组件已关闭，尚未生效。' }) }],
      }) }
      if (url.endsWith('/activate') && init?.method === 'POST') { activated = true; return { ok: true, json: async () => ({ operationId: 'enable-component' }) } }
      if (url.endsWith('/operations/enable-component')) return { ok: true, json: async () => ({ id: 'enable-component', kind: 'activate', skinId: skin.id, phase: 'done', restartRequired: false }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    expect(screen.getAllByText('未生效').length).toBeGreaterThan(0)
    expect(screen.getByText('皮肤组件已关闭，尚未生效。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '停用' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /重启/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新使用' }))
    await waitFor(() => expect(screen.queryByText('皮肤组件已关闭，尚未生效。')).toBeNull())
    expect(screen.getAllByText('正在使用').length).toBeGreaterThan(0)
    expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
  })

  it.each(['active', 'unavailable', 'removed'] as const)('restores a real pending skin once, then clears every restart reminder after it becomes %s', async outcome => {
    let restarted = false
    let routeRevision = 0
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [managedDesktopSkin] } : url.endsWith('/state') ? {
      instanceId: restarted ? 'after-restart' : `before-restart-${routeRevision}`, restartNoticeId: 'stable-pending-group', hostKind: 'desktop', restartAvailable: false, management: officialManagement,
      skins: restarted && outcome === 'removed' ? [] : [{ skinId: skin.id, installation: 'installed', activation: restarted ? outcome : 'restart-required', primary: true, lastOperatedAt: `2026-10-15T01:00:0${routeRevision}Z`, installedVersion: '1.0.0', updateAvailable: false,
        ...(restarted && outcome === 'unavailable' && { error: '皮肤组件已关闭，尚未生效。' }) }],
    } : {} }))
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<SkinMarketSection t={key => key} />)
    fireEvent.click(within(await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })).getByRole('button', { name: '稍后' }))
    routeRevision += 1
    const beforeFocus = fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length).toBeGreaterThan(beforeFocus))
    expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
    view.unmount()
    render(<SkinMarketSection t={key => key} />)
    expect(await screen.findByText('测试皮肤 设置已保存，请手动重启 Desktop App 后生效')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看重启提示' }))
    expect(screen.getByRole('dialog', { name: '请手动重启 Desktop App' })).toBeTruthy()
    restarted = true
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull())
    expect(screen.queryByText(/设置已保存，请手动重启/)).toBeNull()
    expect(screen.queryByRole('button', { name: '查看重启提示' })).toBeNull()
    await openSkinCard()
    expect(screen.queryByText('待重启')).toBeNull()
    expect(screen.queryByRole('button', { name: '重启以应用' })).toBeNull()
    if (outcome === 'unavailable') expect(screen.getByText('皮肤组件已关闭，尚未生效。')).toBeTruthy()
  })

  it('clears every restart reminder when the same Desktop process confirms the skin became active', async () => {
    let active = false
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [managedDesktopSkin] } : url.endsWith('/state') ? {
      instanceId: 'same-desktop-process', restartNoticeId: 'hot-applied-selection', hostKind: 'desktop', restartAvailable: false, management: officialManagement,
      skins: [{ skinId: skin.id, installation: 'installed', activation: active ? 'active' : 'restart-required', primary: true, installedVersion: '1.0.0', updateAvailable: false }],
    } : {} }))
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    expect(await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })).toBeTruthy()

    active = true
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull())
    expect(screen.queryByText(/设置已保存，请手动重启/)).toBeNull()
    expect(screen.queryByRole('button', { name: '查看重启提示' })).toBeNull()
    await openSkinCard()
    expect(screen.getAllByText('正在使用').length).toBeGreaterThan(0)
    expect(screen.queryByText('待重启')).toBeNull()
    expect(screen.queryByRole('button', { name: '重启以应用' })).toBeNull()
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/restart'))).toBe(false)
  })

  it('uses confirmed active Desktop state to clear an activation operation restart hint', async () => {
    let active = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [managedDesktopSkin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ instanceId: 'hot-activation', hostKind: 'desktop', restartAvailable: false, management: officialManagement,
        skins: [{ skinId: skin.id, installation: 'installed', activation: active ? 'active' : 'inactive', primary: active, installedVersion: '1.0.0', updateAvailable: false }] }) }
      if (url.endsWith('/activate') && init?.method === 'POST') { active = true; return { ok: true, json: async () => ({ operationId: 'hinted-restart' }) } }
      if (url.endsWith('/operations/hinted-restart')) return { ok: true, json: async () => ({ id: 'hinted-restart', kind: 'activate', skinId: skin.id, phase: 'done', restartRequired: true }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    fireEvent.click(screen.getByRole('button', { name: '使用' }))
    await waitFor(() => expect(screen.getAllByText('正在使用').length).toBeGreaterThan(0))
    expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
    expect(screen.queryByRole('button', { name: '查看重启提示' })).toBeNull()
    expect(screen.queryByText('待重启')).toBeNull()
  })

  it('opens the restart dialog when an applied operation still leaves an explicit pending restart in refreshed state', async () => {
    let used = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [managedDesktopSkin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ instanceId: 'applied-with-pending', hostKind: 'desktop', restartAvailable: false, management: officialManagement,
        skins: [{ skinId: skin.id, installation: 'installed', activation: used ? 'restart-required' : 'inactive', primary: used, installedVersion: '1.0.0', updateAvailable: false }] }) }
      if (url.endsWith('/activate') && init?.method === 'POST') { used = true; return { ok: true, json: async () => ({ operationId: 'applied-but-pending' }) } }
      if (url.endsWith('/operations/applied-but-pending')) return { ok: true, json: async () => ({ id: 'applied-but-pending', kind: 'activate', skinId: skin.id, phase: 'done', restartRequired: false }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    fireEvent.click(screen.getByRole('button', { name: '使用' }))
    expect(await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })).toBeTruthy()
    expect(screen.getAllByText('待重启').length).toBeGreaterThan(0)
  })

  it('does not present a restart dialog for an unresolved operation even if an earlier pending fact is restored', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [managedDesktopSkin] } : url.endsWith('/state') ? {
      instanceId: 'unknown-result', hostKind: 'desktop', restartAvailable: false,
      skins: [{ skinId: skin.id, installation: 'installed', activation: 'restart-required', installedVersion: '1.0.0', updateAvailable: false }],
      operations: [{ id: 'unknown-use', kind: 'activate', skinId: skin.id, phase: 'waiting', startedAt: '2026-10-15T00:00:00Z', message: '宿主未返回可确认的操作结果' }],
    } : {} })))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    expect(screen.getAllByText('宿主未返回可确认的操作结果').length).toBeGreaterThan(0)
    expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
    expect(screen.queryByRole('button', { name: '查看重启提示' })).toBeNull()
  })

  it('clears the self-update reminder and its open dialog when the restarted Host clears its pending flag', async () => {
    let pending = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [managedDesktopSkin] } : url.endsWith('/state') ? {
      instanceId: pending ? 'old-market' : 'new-market', hostKind: 'desktop', restartAvailable: false, skins: [], marketUpdateRestartRequired: pending,
    } : {} })))
    render(<SkinMarketSection t={key => key} />)
    expect(await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })).toBeTruthy()
    pending = false
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull())
    expect(screen.queryByText(/皮肤市场已更新/)).toBeNull()
    expect(screen.queryByRole('button', { name: '查看重启提示' })).toBeNull()
  })

  it('waits for ongoing installations before manual restart and describes the chosen restart target', async () => {
    let installing = true
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [managedDesktopSkin] } : url.endsWith('/state') ? {
      hostKind: 'desktop', restartAvailable: false, marketUpdateRestartRequired: true,
      skins: [{ skinId: skin.id, installation: 'installed', activation: 'restart-required', installedVersion: '1.0.0', updateAvailable: false }],
      operations: installing ? [{ id: 'other-install', skinId: 'other.skin', kind: 'install', phase: 'downloading', startedAt: new Date().toISOString() }] : [],
    } : {} }))
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    const marketDialog = await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })
    expect(marketDialog.textContent).toContain('还有 1 款皮肤正在安装或更新')
    expect(marketDialog.textContent).toContain('请等待操作完成后再手动重启 Desktop App')
    expect(marketDialog.textContent).not.toContain('完全退出 Desktop App')
    fireEvent.click(within(marketDialog).getByRole('button', { name: '稍后' }))
    installing = false
    const stateRequests = fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length).toBeGreaterThan(stateRequests))
    await openSkinCard()
    const details = screen.getByRole('main', { name: '皮肤详情内容' })
    fireEvent.click(within(details).getAllByRole('button', { name: '查看重启提示' })[0]!)
    const skinDialog = screen.getByRole('dialog', { name: '请手动重启 Desktop App' })
    expect(skinDialog.textContent).toContain('“测试皮肤”的设置将在重启后生效。')
    expect(skinDialog.textContent).not.toContain('皮肤市场已更新')
  })

  it('keeps the official Desktop self-update flow host-managed after the package is written', async () => {
    let updated = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => url.endsWith('/catalog')
        ? { skins: [skin] }
        : url.endsWith('/state')
          ? { hostKind: 'desktop', restartAvailable: false, runningAgentCount: 0, skins: [], marketUpdateRestartRequired: updated }
          : url.endsWith('/market-update') && init?.method === 'POST'
            ? (updated = true, { currentVersion: '0.1.57', latestVersion: '0.1.57', updateAvailable: false })
            : url.endsWith('/market-update')
              ? { currentVersion: '0.1.56', latestVersion: '0.1.57', updateAvailable: true }
              : {},
    }))
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)

    fireEvent.click(await screen.findByRole('button', { name: '更新皮肤市场到 0.1.57' }))
    expect(await screen.findByText('皮肤市场已更新，请手动重启 Desktop App 后生效')).toBeTruthy()
    const restartDialog = await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })
    expect(restartDialog.textContent).toContain('皮肤市场已更新，重启后生效。')
    expect(restartDialog.textContent).toContain('完全退出 Desktop App 并重新打开')
    expect(within(restartDialog).getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByText('请手动重启 Desktop App 后生效')).toBeNull()
    expect(screen.queryByRole('dialog', { name: '需要重启 DSH 应用皮肤市场更新' })).toBeNull()
    expect(fetchMock.mock.calls.some(([url, request]) => url.endsWith('/restart') && request?.method === 'POST')).toBe(false)
  })

  it.each([
    ['activate', '使用', true], ['activate', '使用', false],
    ['deactivate', '停用', true], ['deactivate', '停用', false],
    ['update', '更新', true], ['update', '更新', false],
    ['uninstall', '卸载', true], ['uninstall', '卸载', false],
  ] as const)('opens the manual Desktop restart dialog for %s only when its result requires restart (%s, %s)', async (kind, actionLabel, restartRequired) => {
    let completed = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [managedDesktopSkin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({
        hostKind: 'desktop', restartAvailable: false, runtime: { ...dshRuntime, version: '0.2.1-alpha.3' },
        management: { ...officialManagement, installRequiresRestart: false },
        skins: [{ skinId: skin.id, installation: completed && kind === 'uninstall' ? 'missing' : 'installed', activation: completed && restartRequired ? 'restart-required' : kind === 'activate' ? completed ? 'active' : 'inactive' : completed && (kind === 'deactivate' || kind === 'uninstall') ? 'inactive' : 'active', installedVersion: '1.0.0', updateAvailable: kind === 'update' && !completed }],
      }) }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.58', latestVersion: '0.1.58', updateAvailable: false }) }
      if (url.endsWith(`/${kind}`) && init?.method === 'POST') {
        completed = true
        return { ok: true, json: async () => ({ operationId: 'desktop-result' }) }
      }
      if (url.endsWith('/operations/desktop-result')) return { ok: true, json: async () => ({ id: 'desktop-result', kind, skinId: skin.id, phase: 'done', restartRequired }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    fireEvent.click(screen.getByRole('button', { name: actionLabel }))
    if (kind === 'uninstall') fireEvent.click(within(await screen.findByRole('dialog', { name: '卸载皮肤' })).getByRole('button', { name: '确认卸载' }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length).toBeGreaterThan(1))
    if (restartRequired) {
      const dialog = await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })
      expect(dialog.textContent).toContain('完全退出 Desktop App 并重新打开')
      if (kind === 'uninstall') {
        expect(within(screen.getByRole('main', { name: '皮肤详情内容' })).getByText('测试皮肤 已卸载，请手动重启 Desktop App 后生效')).toBeTruthy()
        expect(dialog.textContent).toContain('“测试皮肤”已卸载，重启后生效。')
      }
      expect(within(dialog).queryByRole('button', { name: /立即重启|确认无任务/ })).toBeNull()
      fireEvent.click(within(dialog).getByRole('button', { name: '稍后' }))
      const stateRequests = fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length
      fireEvent(window, new Event('focus'))
      await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length).toBeGreaterThan(stateRequests))
      expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
      fireEvent.click(screen.getAllByRole('button', { name: '查看重启提示' })[0]!)
      expect(screen.getByRole('dialog', { name: '请手动重启 Desktop App' })).toBeTruthy()
      if (kind === 'uninstall') {
        expect(screen.getByRole('dialog', { name: '请手动重启 Desktop App' }).textContent).toContain('“测试皮肤”已卸载，重启后生效。')
        expect(within(screen.getByRole('main', { name: '皮肤详情内容' })).getByText('测试皮肤 已卸载，请手动重启 Desktop App 后生效')).toBeTruthy()
      }
    } else {
      await act(async () => {})
      expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
      expect(screen.queryByRole('button', { name: '查看重启提示' })).toBeNull()
      if (kind === 'uninstall') expect(within(screen.getByRole('main', { name: '皮肤详情内容' })).getByText('测试皮肤 已卸载')).toBeTruthy()
    }
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/restart') && init?.method === 'POST')).toBe(false)
  })

  it.each([
    ['same-skin', 'missing'], ['same-skin', 'omitted'],
    ['other-skin', 'missing'], ['other-skin', 'omitted'],
  ] as const)('reports hot uninstall of %s with a %s runtime row without leaking earlier install notices', async (targetKind, removedRow) => {
    const blue = { ...managedDesktopSkin, name: { zh: '蓝色幻想', en: 'Blue Fantasy' } }
    const minecraft = { ...managedDesktopSkin, id: 'minecraft.skin', package: 'minecraft-skin', rowId: 'minecraft-skin', name: { zh: 'Minecraft', en: 'Minecraft' } }
    const target = targetKind === 'same-skin' ? blue : minecraft
    let blueInstalled = false
    let removedId: string | undefined
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [blue, minecraft] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({
        hostKind: 'desktop', restartAvailable: false, runtime: { ...dshRuntime, version: '0.2.1-alpha.3' },
        management: { ...officialManagement, installRequiresRestart: false },
        skins: [
          { skinId: minecraft.id, installation: 'installed', activation: 'inactive', installedVersion: '1.0.0', updateAvailable: false },
          ...(blueInstalled ? [{ skinId: blue.id, installation: 'installed', activation: 'restart-required', installedVersion: '1.0.0', updateAvailable: false }] : []),
        ].flatMap(item => item.skinId !== removedId ? [item] : removedRow === 'omitted' ? [] : [{ ...item, installation: 'missing', activation: 'inactive' }]),
      }) }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.60', latestVersion: '0.1.60', updateAvailable: false }) }
      if (url.endsWith('/install') && init?.method === 'POST') {
        blueInstalled = true
        return { ok: true, json: async () => ({ operationId: 'blue-before-remove-install' }) }
      }
      if (url.endsWith('/operations/blue-before-remove-install')) return { ok: true, json: async () => ({ id: 'blue-before-remove-install', kind: 'install', skinId: blue.id, phase: 'done', restartRequired: true }) }
      if (url.endsWith('/activate') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'blue-before-remove-activate' }) }
      if (url.endsWith('/operations/blue-before-remove-activate')) return { ok: true, json: async () => ({ id: 'blue-before-remove-activate', kind: 'activate', skinId: blue.id, phase: 'failed', message: '启用保存失败，已恢复原皮肤' }) }
      if (url.endsWith('/uninstall') && init?.method === 'POST') {
        removedId = JSON.parse(init.body as string).skinId
        return { ok: true, json: async () => ({ operationId: 'hot-remove-result' }) }
      }
      if (url.endsWith('/operations/hot-remove-result')) return { ok: true, json: async () => ({ id: 'hot-remove-result', kind: 'uninstall', skinId: target.id, phase: 'done', restartRequired: false }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    const failure = await screen.findByRole('dialog', { name: '启用未完成' })
    expect(screen.getByText('蓝色幻想 已安装，但未启用')).toBeTruthy()
    fireEvent.click(within(failure).getByRole('button', { name: '确认' }))
    await openSkinCard(new RegExp(`${target.name.zh} 界面预览`))
    let details = screen.getByRole('main', { name: '皮肤详情内容' })
    fireEvent.click(within(details).getByRole('button', { name: '卸载' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: '卸载皮肤' })).getByRole('button', { name: '确认卸载' }))

    expect(await within(details).findByText(`${target.name.zh} 已卸载`)).toBeTruthy()
    expect(removedId).toBe(target.id)
    expect(within(details).queryByText('蓝色幻想 已安装，但未启用')).toBeNull()
    expect(within(details).queryByRole('button', { name: '查看重启提示' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
    const stateRequests = fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length).toBeGreaterThan(stateRequests))
    expect(within(details).getByText(`${target.name.zh} 已卸载`)).toBeTruthy()
    expect(within(details).queryByText('蓝色幻想 已安装，但未启用')).toBeNull()

    fireEvent.click(within(screen.getByRole('dialog', { name: '皮肤详情' })).getByRole('button', { name: '关闭' }))
    if (targetKind === 'other-skin') {
      expect(screen.getByText('蓝色幻想 已安装，但未启用')).toBeTruthy()
      await openSkinCard(/蓝色幻想 界面预览/)
      details = screen.getByRole('main', { name: '皮肤详情内容' })
      expect(within(details).getByText('蓝色幻想 已安装，但未启用')).toBeTruthy()
      expect(within(details).queryByText('Minecraft 已卸载')).toBeNull()
      fireEvent.click(within(details).getByRole('button', { name: '查看重启提示' }))
      expect(screen.getByRole('dialog', { name: '请手动重启 Desktop App' }).textContent).toContain('“蓝色幻想”已安装，但尚未启用。')
    } else {
      expect(screen.queryByText('蓝色幻想 已安装，但未启用')).toBeNull()
      expect(screen.queryByRole('button', { name: '查看重启提示' })).toBeNull()
    }
  })

  it.each(['failed', 'cancelled'] as const)('does not report uninstall success when the removal result is %s', async phase => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [managedDesktopSkin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({
        hostKind: 'desktop', restartAvailable: false, runtime: { ...dshRuntime, version: '0.2.1-alpha.3' }, management: officialManagement,
        skins: [{ skinId: skin.id, installation: 'installed', activation: 'active', installedVersion: '1.0.0', updateAvailable: false }],
      }) }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.60', latestVersion: '0.1.60', updateAvailable: false }) }
      if (url.endsWith('/uninstall') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'unsuccessful-remove' }) }
      if (url.endsWith('/operations/unsuccessful-remove')) return { ok: true, json: async () => ({ id: 'unsuccessful-remove', kind: 'uninstall', skinId: skin.id, phase, message: phase === 'failed' ? '卸载保存失败' : '已取消卸载' }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    const details = screen.getByRole('main', { name: '皮肤详情内容' })
    fireEvent.click(within(details).getByRole('button', { name: '卸载' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: '卸载皮肤' })).getByRole('button', { name: '确认卸载' }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length).toBeGreaterThan(1))
    await act(async () => {})
    expect(within(details).getByRole('button', { name: '卸载' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText(/测试皮肤 已卸载/)).toBeNull()
    expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
    expect(within(details).queryByRole('button', { name: '查看重启提示' })).toBeNull()
  })

  it('restores an uninstalled skin pending restart with its removal title and explanation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [managedDesktopSkin] } : url.endsWith('/state') ? {
      instanceId: 'restored-remove', hostKind: 'desktop', restartAvailable: false, runtime: { ...dshRuntime, version: '0.2.1-alpha.3' }, management: officialManagement,
      skins: [{ skinId: skin.id, installation: 'missing', activation: 'restart-required', installedVersion: '1.0.0', updateAvailable: false }],
    } : {} })))
    const view = render(<SkinMarketSection t={key => key} />)
    expect(await screen.findByText('测试皮肤 已卸载，请手动重启 Desktop App 后生效')).toBeTruthy()
    const initialDialog = await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })
    expect(initialDialog.textContent).toContain('“测试皮肤”已卸载，重启后生效。')
    fireEvent.click(within(initialDialog).getByRole('button', { name: '稍后' }))

    view.unmount()
    render(<SkinMarketSection t={key => key} />)
    expect(await screen.findByText('测试皮肤 已卸载，请手动重启 Desktop App 后生效')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
    await openSkinCard()
    const details = screen.getByRole('main', { name: '皮肤详情内容' })
    expect(within(details).getByText('测试皮肤 已卸载，请手动重启 Desktop App 后生效')).toBeTruthy()
    fireEvent.click(within(details).getByRole('button', { name: '查看重启提示' }))
    expect(screen.getByRole('dialog', { name: '请手动重启 Desktop App' }).textContent).toContain('“测试皮肤”已卸载，重启后生效。')
  })

  it.each(['completed-task', 'restored'] as const)('shows the manual market-update restart dialog once for a %s and restores only its banner after remount', async mode => {
    let updated = mode === 'restored'
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [managedDesktopSkin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ hostKind: 'desktop', restartAvailable: false, skins: [], marketUpdateRestartRequired: updated }) }
      if (url.endsWith('/market-update') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'desktop-market-update' }) }
      if (url.endsWith('/market-update/operations/desktop-market-update')) {
        updated = true
        return { ok: true, json: async () => ({ id: 'desktop-market-update', phase: 'done', startedAt: new Date().toISOString() }) }
      }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: updated ? '0.1.58' : '0.1.57', latestVersion: '0.1.58', updateAvailable: !updated }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<SkinMarketSection t={key => key} />)
    if (mode === 'completed-task') fireEvent.click(await screen.findByRole('button', { name: '更新皮肤市场到 0.1.58' }))
    const dialog = await screen.findByRole('dialog', { name: '请手动重启 Desktop App' })
    expect(dialog.textContent).toContain('皮肤市场已更新，重启后生效。')
    fireEvent.click(within(dialog).getByRole('button', { name: '稍后' }))
    const stateRequests = fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length).toBeGreaterThan(stateRequests))
    expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看重启提示' }))
    expect(screen.getByRole('dialog', { name: '请手动重启 Desktop App' })).toBeTruthy()
    view.unmount()
    render(<SkinMarketSection t={key => key} />)
    expect(await screen.findByText('皮肤市场已更新，请手动重启 Desktop App 后生效')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '请手动重启 Desktop App' })).toBeNull()
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/restart') && init?.method === 'POST')).toBe(false)
  })

  it('asks for restart after updating the active skin', async () => {
    let updated = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/market-update')) return { ok: true, json: async () => ({ currentVersion: '0.1.26', latestVersion: '0.1.26', updateAvailable: false }) }
      if (url.endsWith('/update') && init?.method === 'POST') { updated = true; return { ok: true, json: async () => ({ operationId: 'update-1' }) } }
      if (url.endsWith('/operations/update-1')) return { ok: true, json: async () => ({ id: 'update-1', phase: 'done' }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ runningAgentCount: 0, skins: [{ skinId: skin.id, installation: 'installed', activation: updated ? 'restart-required' : 'active', installedVersion: '1.0.0', updateAvailable: !updated }], runtime: dshRuntime }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    fireEvent.click(await screen.findByRole('button', { name: '更新' }))

    expect(await screen.findByRole('dialog', { name: '需要重启 DSH 应用此皮肤' })).toBeTruthy()
    expect(await screen.findByText('Agent 状态检查已通过。但重启仍会关闭所有会话连接；即使回复已经停止显示，也请确认重要内容已保存，且没有即将开始的新任务。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '稍后' }))
    expect(screen.getAllByText('测试皮肤 已更新，待重启生效').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '重启' }))
    expect(screen.getByRole('dialog', { name: '需要重启 DSH 应用此皮肤' })).toBeTruthy()
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/update') && init?.method === 'POST')).toBe(true)
  })

  it('disables restart when the Host reports a running Agent', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { runningAgentCount: 2, skins: [{ skinId: skin.id, installation: 'installed', activation: 'restart-required', installedVersion: '1.0.0', updateAvailable: false }] } })))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    fireEvent.click(await screen.findByRole('button', { name: '重启以应用' }))
    expect(await screen.findByText('检测到 2 个 Agent 正在运行，现在不能重启。请等待任务完全结束后再试，否则可能中断任务并导致会话历史无法加载。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '有任务运行中' }).hasAttribute('disabled')).toBe(true)
  })

  it('blocks restart while another skin is still installing', async () => {
    const other = { ...skin, id: 'test.other', name: { zh: '另一款皮肤', en: 'Other Skin' }, package: 'other-skin', rowId: 'other-skin', repo: 'https://github.com/a/c' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/catalog')
        ? { skins: [skin, other] }
        : {
          runningAgentCount: 0,
          skins: [{ skinId: skin.id, installation: 'installed', activation: 'restart-required', installedVersion: '1.0.0', updateAvailable: false }],
          operations: [{ id: 'install-other', kind: 'install', skinId: other.id, phase: 'downloading', startedAt: new Date().toISOString() }],
        },
    })))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    fireEvent.click(await screen.findByRole('button', { name: '重启以应用' }))
    expect(await screen.findByText(/还有 1 款皮肤正在安装或更新（另一款皮肤）/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '有皮肤正在安装' }).hasAttribute('disabled')).toBe(true)
  })

  it('allows an explicit one-time restart when the old Host cannot report Agent state', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [{ skinId: skin.id, installation: 'installed', activation: 'restart-required', installedVersion: '1.0.0', updateAvailable: false }] } })))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    fireEvent.click(await screen.findByRole('button', { name: '重启以应用' }))
    const override = await screen.findByRole('button', { name: '我已确认无任务，仍然重启' })
    expect(override.hasAttribute('disabled')).toBe(false)
    expect(screen.getByText('当前 Host 尚未加载安全检查。请确认没有 Agent 正在运行、重要内容已保存；你可以继续完成这一次升级重启。新版本加载后会自动检测 Agent 状态。')).toBeTruthy()
  })

  it.each(['activate', 'pin'] as const)('preserves a real Web-client failure after %s without fabricating a Host activation state', async kind => {
    let activated = false
    let instanceId = 'web-before-restart'
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ instanceId, runningAgentCount: 0, skins: [{ skinId: skin.id, installation: 'installed', activation: activated || kind === 'pin' ? 'active' : 'inactive', primary: activated || kind === 'pin', pinned: activated && kind === 'pin', installedVersion: '1.0.0', updateAvailable: false }], runtime: dshRuntime }) }
      if (url.endsWith(`/${kind}`) && init?.method === 'POST') { activated = true; return { ok: true, json: async () => ({ operationId: 'client-failure' }) } }
      if (url.endsWith('/operations/client-failure')) return { ok: true, json: async () => ({ id: 'client-failure', kind, skinId: skin.id, phase: 'done', restartRequired: false }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const clientRuntime = { setActive: vi.fn(async () => false) }
    render(<SkinMarketSection t={key => key} clientRuntime={clientRuntime} />)
    await openSkinCard()

    fireEvent.click(await screen.findByRole('button', { name: kind === 'pin' ? '常驻使用' : '使用' }))
    if (kind === 'pin') fireEvent.click(screen.getByRole('button', { name: '确认常驻' }))
    const dialog = await screen.findByRole('dialog', { name: '需要重启 DSH 应用此皮肤' })
    expect(dialog.textContent).not.toMatch(/仍可继续使用/)
    expect(dialog.textContent).not.toContain('当前 Host 尚未加载安全检查')
    expect(clientRuntime.setActive).toHaveBeenCalledWith(skin.package, true)
    expect(screen.queryByText('待重启')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: '稍后' }))
    const stateRequests = fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/state')).length).toBeGreaterThan(stateRequests))
    expect(screen.queryByRole('dialog', { name: '需要重启 DSH 应用此皮肤' })).toBeNull()
    expect(screen.getAllByText(/待重启生效/).length).toBeGreaterThan(0)
    instanceId = 'web-after-restart'
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(screen.queryByText(/待重启生效/)).toBeNull())
  })

  it('asks before using an incompatible installed skin and preserves the restart flow after consent', async () => {
    const incompatible = { ...skin, compatibility: { dsh: '<0.1.0-rc.6', platform: ['web'] } }
    let activated = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [incompatible] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ runningAgentCount: 0, skins: [{ skinId: incompatible.id, installation: 'installed', activation: activated ? 'restart-required' : 'inactive', installedVersion: '1.0.0', updateAvailable: false }], runtime: { version: '0.1.1-rc.1', capabilities: ['slot:keyed:settings.plugin.item'], source: 'injected' } }) }
      if (url.endsWith('/activate') && init?.method === 'POST') { activated = true; return { ok: true, json: async () => ({ operationId: 'activate-1' }) } }
      if (url.endsWith('/operations/activate-1')) return { ok: true, json: async () => ({ id: 'activate-1', phase: 'done' }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const clientRuntime = { setActive: vi.fn(async () => false) }
    render(<SkinMarketSection t={key => key} clientRuntime={clientRuntime} />)
    await openSkinCard()

    expect(screen.queryByText(/仍可继续使用/)).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '使用' }))
    const compatibilityDialog = await screen.findByRole('dialog', { name: '兼容性提示' })
    expect(compatibilityDialog.textContent).toMatch(/不在作者声明的兼容范围/)
    expect(within(compatibilityDialog).getByRole('link', { name: '页面异常时重置皮肤' })).toBeTruthy()
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    fireEvent.click(within(compatibilityDialog).getByRole('button', { name: '仍然使用' }))
    const dialog = await screen.findByRole('dialog', { name: '需要重启 DSH 应用此皮肤' })
    expect(dialog.textContent).toMatch(/Agent 状态检查已通过/)
    expect(screen.getByRole('button', { name: '确认无任务，立即重启' })).toBeTruthy()
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url.endsWith('/activate') && init?.method === 'POST')?.[1]?.body))).toEqual({ skinId: incompatible.id, acknowledgeCompatibility: true, compatibilityContext: compatibilityContext(incompatible, { ...dshRuntime, version: '0.1.1-rc.1' }) })
  })

  it('asks separately for an incompatible skin before enabling it as a pinned plugin', async () => {
    const incompatible = { ...skin, compatibility: { dsh: '<0.1.0-rc.6', platform: ['web'] } }
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [incompatible] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ runtime: dshRuntime, skins: [{ skinId: skin.id, installation: 'installed', activation: 'inactive', installedVersion: '1.0.0', updateAvailable: false }] }) }
      if (url.endsWith('/pin') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'incompatible-pin' }) }
      if (url.endsWith('/operations/incompatible-pin')) return { ok: true, json: async () => ({ id: 'incompatible-pin', kind: 'pin', skinId: skin.id, phase: 'done' }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    fireEvent.click(await screen.findByRole('button', { name: '测试皮肤 已安装卡片' }))
    fireEvent.click(screen.getByRole('button', { name: '常驻使用' }))
    fireEvent.click(screen.getByRole('button', { name: '确认常驻' }))
    const dialog = await screen.findByRole('dialog', { name: '兼容性提示' })
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: '仍然常驻使用' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/pin') && init?.method === 'POST')).toBe(true))
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url.endsWith('/pin') && init?.method === 'POST')?.[1]?.body))).toEqual({ skinId: skin.id, acknowledgeCompatibility: true, compatibilityContext: compatibilityContext(incompatible, dshRuntime) })
  })

  it('filters the catalog from the native search input', async () => {
    const descriptionMatch = { ...skin, id: 'description.match', name: { zh: '描述皮肤', en: 'Description Skin' }, description: '终末地风格的深色主题' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin, descriptionMatch] } : { skins: [] } })))
    render(<SkinMarketSection t={key => key} />)
    await screen.findByRole('button', { name: /测试皮肤 界面预览/ })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '终末地' } })
    expect(screen.getByRole('button', { name: /描述皮肤 界面预览/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /测试皮肤 界面预览/ })).toBeNull()
  })

  it('keeps Stars and latest sorting on the discovery feed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [] } })))
    render(<SkinMarketSection t={key => key} />)
    await screen.findByRole('heading', { name: '发现更多' })
    expect(screen.getByRole('button', { name: 'Stars' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stars' }))
    expect(screen.getByRole('button', { name: '最新' })).toBeTruthy()
  })

  it('shows Stars in list rows and marks the selected skin', async () => {
    const secondSkin = { ...skin, id: 'test.second', name: { zh: '第二皮肤', en: 'Second Skin' }, githubStars: 7 }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin, secondSkin] } : { skins: [] } })))
    render(<SkinMarketSection t={key => key} />)

    await openSkinCard()
    const first = screen.getByRole('button', { name: /测试皮肤 界面预览/ })
    const second = screen.getByRole('button', { name: /第二皮肤 界面预览/ })
    expect(first.getAttribute('aria-current')).toBe('true')
    expect(second.getAttribute('aria-current')).toBeNull()
    expect(first.textContent).toContain('42')
    expect(second.textContent).toContain('7')

    fireEvent.click(second)
    expect(first.getAttribute('aria-current')).toBeNull()
    expect(second.getAttribute('aria-current')).toBe('true')
  })

  it('shows an installing status on the matching list row immediately', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runtime: dshRuntime }) }
      if (init?.method === 'POST') return await new Promise(() => undefined)
      throw new Error(`Unexpected request: ${url}`)
    }))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    const automatic = await screen.findByRole('button', { name: '安装并使用' })
    const installOnly = screen.getByRole('button', { name: '仅安装' })
    const otherMethods = screen.getByRole('button', { name: '其他安装方式' })
    expect(automatic.getAttribute('variant')).toBe('primary')
    expect(installOnly.getAttribute('variant')).toBe('outline')
    expect(otherMethods.getAttribute('variant')).toBe('outline')
    fireEvent.click(automatic)
    expect(await screen.findByRole('button', { name: /测试皮肤 界面预览.*安装中/ })).toBeTruthy()
  })

  it('names the skin and compact elapsed time in the operation banner, then shows failures promptly', async () => {
    let operationRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], operation: null, runtime: dshRuntime }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'install-progress' }) }
      if (url.endsWith('/operations/install-progress')) {
        operationRequests += 1
        return { ok: true, json: async () => operationRequests === 1
          ? { id: 'install-progress', kind: 'install', skinId: skin.id, phase: 'downloading', startedAt: new Date().toISOString() }
          : { id: 'install-progress', kind: 'install', skinId: skin.id, phase: 'failed', startedAt: new Date().toISOString(), message: 'GitHub 插件下载超时' } }
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    fireEvent.click(await screen.findByRole('button', { name: '仅安装' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('正在下载“测试皮肤”'))
    expect(within(screen.getByRole('status')).getByTitle(/^已用时 /).textContent).toMatch(/^· \d+ 秒$/)
    const dialog = await screen.findByRole('dialog', { name: '安装未完成' }, { timeout: 2_000 })
    expect(dialog.textContent).toContain('GitHub 插件下载超时')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    window.dispatchEvent(new Event('focus'))
    expect(screen.getByRole('dialog', { name: '安装未完成' }).textContent).toContain('GitHub 插件下载超时')
  })

  it('discloses command diagnostics, expires stale speed on its tick, and lets a running install copy its log', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const clipboard = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: { writeText: clipboard } })
    const operation = {
      id: 'install-live-log', kind: 'install', skinId: skin.id, phase: 'downloading', startedAt: new Date(now - 60_000).toISOString(),
      step: '下载 npm 皮肤包', stepStartedAt: new Date(now - 1000).toISOString(), attempt: 2, pnpmStage: 'downloading',
      lastOutputAt: new Date(now).toISOString(), downloadedBytes: 2048, totalBytes: 4096, bytesPerSecond: 1024,
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], operation, runtime: dshRuntime }) }
      if (url.endsWith('/logs?operationId=install-live-log')) return { ok: true, text: async () => '# dsh-skin-market diagnostic log\nredacted' }
      throw new Error(`Unexpected request: ${url}`)
    }))
    try {
      render(<SkinMarketSection t={key => key} />)
      await waitFor(() => expect(screen.getByRole('status').querySelector('strong')?.textContent).toBe('正在下载“测试皮肤”'))
      const banner = screen.getByRole('status')
      const disclosure = within(banner).getByRole('button', { name: '详情' })
      const details = document.getElementById(disclosure.getAttribute('aria-controls')!)!
      expect(disclosure.getAttribute('aria-expanded')).toBe('false')
      expect(details.hasAttribute('hidden')).toBe(true)
      expect(within(banner).getByText('下载 npm 皮肤包').closest('[hidden]')).toBe(details)
      expect(within(banner).getByText('第 2 次尝试').closest('[hidden]')).toBe(details)
      expect(within(banner).getByText('1.0 KB/s').closest('[hidden]')).toBe(details)
      expect(within(banner).queryByRole('button', { name: '复制日志' })).toBeNull()
      expect(banner.querySelector('strong')?.textContent).toBe('正在下载“测试皮肤”')
      expect(within(banner).getAllByText('2.0 KB / 4.0 KB').some(element => element.closest('[hidden]') === null)).toBe(true)

      fireEvent.click(disclosure)
      expect(disclosure.getAttribute('aria-expanded')).toBe('true')
      expect(details.hasAttribute('hidden')).toBe(false)
      expect(within(details).getByText('下载 npm 皮肤包')).toBeTruthy()
      expect(within(details).getByText('第 2 次尝试')).toBeTruthy()
      expect(within(details).queryByText('下载依赖')).toBeNull()
      expect(within(details).getByText('1.0 KB/s')).toBeTruthy()

      clock.mockReturnValue(now + 5000)
      await waitFor(() => expect(within(details).queryByText(/KB\/s/)).toBeNull(), { timeout: 2000 })
      expect(within(details).queryByText(/未有输出/)).toBeNull()
      clock.mockReturnValue(now + 30_000)
      await waitFor(() => expect(within(details).getByText('已 30 秒未有输出')).toBeTruthy(), { timeout: 2000 })
      expect(banner.textContent).not.toContain('可复制日志查看')
      fireEvent.click(within(banner).getByRole('button', { name: '复制日志' }))
      await waitFor(() => expect(clipboard).toHaveBeenCalledWith(expect.stringContaining('diagnostic log')))
      expect(banner.textContent).not.toContain('redacted')
      fireEvent.click(within(banner).getByRole('button', { name: '收起' }))
      expect(details.hasAttribute('hidden')).toBe(true)
      expect(disclosure.getAttribute('aria-expanded')).toBe('false')
      expect(within(banner).queryByRole('button', { name: '日志已复制' })).toBeNull()
    } finally { clock.mockRestore() }
  })

  it('uses the current command start for silence detection when the operation has already been running', async () => {
    const now = Date.now()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runtime: dshRuntime, operation: {
        id: 'new-step', kind: 'install', skinId: skin.id, phase: 'installing', startedAt: new Date(now - 300_000).toISOString(),
        step: '写入插件', stepStartedAt: new Date(now).toISOString(), attempt: 1, pnpmStage: 'linking', lastOutputAt: new Date(now - 60_000).toISOString(),
      } }) }
      throw new Error(`Unexpected request: ${url}`)
    }))
    render(<SkinMarketSection t={key => key} />)
    await waitFor(() => expect(screen.getByRole('status').querySelector('strong')?.textContent).toBe('正在安装“测试皮肤”'))
    const banner = screen.getByRole('status')
    fireEvent.click(within(banner).getByRole('button', { name: '详情' }))
    expect(within(banner).getByText('写入插件').closest('[hidden]')).toBeNull()
    expect(within(banner).queryByText('链接依赖')).toBeNull()
    expect(within(banner).queryByText(/未有输出/)).toBeNull()
  })

  it.each([20, 44])('keeps a %s-second recovery concise until diagnostics are requested and leaves install controls locked', async elapsedSeconds => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const recoveringSkin = { ...skin, name: { zh: '深海女仆工坊', en: 'Deep Sea Maid Workshop' } }
    const clipboard = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: { writeText: clipboard } })
    const operation = {
      id: 'install-recovery', kind: 'install', skinId: skin.id, phase: 'installing', cancelable: false,
      startedAt: new Date(now - elapsedSeconds * 1000).toISOString(), step: '恢复原有 profile 依赖',
      stepStartedAt: new Date(now - elapsedSeconds * 1000).toISOString(), attempt: 1,
      lastOutputAt: new Date(now - (elapsedSeconds - 5) * 1000).toISOString(), message: '安装未完成，正在恢复原有依赖',
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [recoveringSkin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], operation, runtime: dshRuntime }) }
      if (url.endsWith('/logs?operationId=install-recovery')) return { ok: true, text: async () => '# dsh-skin-market diagnostic log\nredacted' }
      throw new Error(`Unexpected request: ${url}`)
    }))
    try {
      render(<SkinMarketSection t={key => key} />)
      await openSkinCard(/深海女仆工坊 界面预览/)
      const banner = screen.getByRole('status')
      expect(banner.querySelector('strong')?.textContent).toBe('正在恢复原有依赖 · 深海女仆工坊')
      expect(within(banner).getByTitle(`已用时 ${elapsedSeconds} 秒`).textContent).toBe(`· ${elapsedSeconds} 秒`)
      expect(banner.textContent).not.toContain('正在写入插件')
      const disclosure = within(banner).getByRole('button', { name: '详情' })
      const details = document.getElementById(disclosure.getAttribute('aria-controls')!)!
      expect(details.hasAttribute('hidden')).toBe(true)
      expect(within(banner).getByText('恢复原有 profile 依赖').closest('[hidden]')).toBe(details)
      expect(within(banner).getByText('安装未完成，正在恢复原有依赖').closest('[hidden]')).toBe(details)
      if (elapsedSeconds === 44) expect(within(details).getByText('已 39 秒未有输出').closest('[hidden]')).toBe(details)
      else expect(within(details).queryByText(/未有输出/)).toBeNull()
      expect(within(banner).queryByRole('button', { name: '复制日志' })).toBeNull()
      expect(within(banner).queryByRole('button', { name: '取消' })).toBeNull()
      expect(screen.getByRole('button', { name: '安装' }).hasAttribute('disabled')).toBe(true)
      expect(screen.getByRole('button', { name: '其他安装方式' }).hasAttribute('disabled')).toBe(true)

      fireEvent.click(disclosure)
      expect(details.hasAttribute('hidden')).toBe(false)
      expect(disclosure.getAttribute('aria-expanded')).toBe('true')
      fireEvent.click(within(banner).getByRole('button', { name: '复制日志' }))
      await waitFor(() => expect(clipboard).toHaveBeenCalledWith(expect.stringContaining('diagnostic log')))
      expect(banner.textContent).not.toContain('redacted')
      fireEvent.click(within(banner).getByRole('button', { name: '收起' }))
      expect(details.hasAttribute('hidden')).toBe(true)
      expect(within(banner).queryByRole('button', { name: '取消' })).toBeNull()
      expect(screen.getByRole('button', { name: '安装' }).hasAttribute('disabled')).toBe(true)
    } finally { clock.mockRestore() }
  })

  it.each([
    { phase: 'waiting', title: '等待宿主确认“测试皮肤”', message: '宿主未返回可确认的操作结果，请重新打开宿主后核对插件状态' },
    { phase: 'cancelling', title: '正在取消“测试皮肤”', message: '正在取消并清理临时文件' },
  ])('keeps the $phase stage and required explanation visible despite a stale recovery step', async ({ phase, title, message }) => {
    const operation = {
      id: 'stale-recovery-step', kind: 'install', skinId: skin.id, phase, cancelable: false,
      startedAt: new Date().toISOString(), step: '恢复原有 profile 依赖', message,
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], operation, runtime: dshRuntime }) }
      throw new Error(`Unexpected request: ${url}`)
    }))
    render(<SkinMarketSection t={key => key} />)
    await waitFor(() => expect(screen.getByRole('status').querySelector('strong')?.textContent).toBe(title))
    const banner = screen.getByRole('status')
    expect(within(banner).getByText(message).closest('[hidden]')).toBeNull()
    expect(within(banner).getByText('恢复原有 profile 依赖').closest('[hidden]')).not.toBeNull()
    expect(within(banner).queryByRole('button', { name: '取消' })).toBeNull()
  })

  it('explains a blocking failure in a dialog and copies the operation diagnostic log', async () => {
    let operationRequests = 0
    const longMessage = '依赖 @deepseek-ai/dsh-compact 无法从 npm registry 找到；这是一个很长的 pnpm 诊断信息，需要完整展示而不能挤在横幅里。'
    const clipboard = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: { writeText: clipboard } })
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], operation: null, runtime: dshRuntime }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'install-copy' }) }
      if (url.endsWith('/logs?operationId=install-copy')) return { ok: true, text: async () => '# dsh-skin-market diagnostic log\nredacted' }
      if (url.endsWith('/operations/install-copy')) {
        operationRequests += 1
        return { ok: true, json: async () => operationRequests === 1
          ? { id: 'install-copy', kind: 'install', skinId: skin.id, phase: 'downloading', startedAt: new Date().toISOString() }
          : { id: 'install-copy', kind: 'install', skinId: skin.id, phase: 'failed', startedAt: new Date().toISOString(), message: longMessage } }
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    fireEvent.click(await screen.findByRole('button', { name: '仅安装' }))

    const dialog = await screen.findByRole('dialog', { name: '安装未完成' })
    expect(dialog.textContent).toContain('@deepseek-ai/dsh-compact')
    expect(dialog.textContent).not.toContain('diagnostic log')
    expect(dialog.textContent).not.toContain('为什么会这样')
    expect([...dialog.querySelectorAll('p')].some(paragraph => paragraph.textContent?.trim() === '')).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: '重试' })).toBeNull()
    expect(within(dialog).getByRole('link', { name: '打开皮肤仓库' }).getAttribute('href')).toBe(`https://github.com/a/b/tree/${'a'.repeat(40)}`)
    expect(within(dialog).getByRole('link', { name: '查看安装排查' }).getAttribute('href')).toBe(MARKET_INSTALL_TROUBLESHOOT_URL)
    fireEvent.click(within(dialog).getByRole('button', { name: '复制日志' }))
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(expect.stringContaining('diagnostic log')))
    expect(within(dialog).getByRole('button', { name: '日志已复制' })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))
    expect(screen.queryByRole('dialog', { name: '安装未完成' })).toBeNull()
  })

  it('explains a missing bundle patch as a skin packaging intercept', async () => {
    let operationRequests = 0
    const clipboard = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: { writeText: clipboard } })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], operation: null, runtime: dshRuntime }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'install-patch' }) }
      if (url.endsWith('/logs?operationId=install-patch')) return { ok: true, text: async () => '# dsh-skin-market diagnostic log\nbundle patch is missing' }
      if (url.endsWith('/operations/install-patch')) {
        operationRequests += 1
        return { ok: true, json: async () => operationRequests === 1
          ? { id: 'install-patch', kind: 'install', skinId: skin.id, phase: 'downloading', startedAt: new Date().toISOString() }
          : { id: 'install-patch', kind: 'install', skinId: skin.id, phase: 'failed', startedAt: new Date().toISOString(), message: `${skin.package} bundle patch is missing: ./cordis.patch.yml` } }
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    fireEvent.click(await screen.findByRole('button', { name: '仅安装' }))

    const dialog = await screen.findByRole('dialog', { name: '已拦截安装' })
    expect(dialog.textContent).toContain('缺少 DSH 用来注册插件的 ./cordis.patch.yml')
    expect(dialog.textContent).toContain('files 白名单')
    expect(dialog.textContent).toContain('不是本机环境损坏')
    expect(dialog.textContent).not.toContain('diagnostic log')
    expect(dialog.textContent).not.toContain('第 1 次尝试')
    expect(dialog.textContent).not.toContain('链接依赖')
    expect(within(dialog).getByRole('button', { name: '确认' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: '复制日志' })).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: '打开皮肤仓库' }).getAttribute('href')).toBe(`https://github.com/a/b/tree/${'a'.repeat(40)}`)
    expect(within(dialog).queryByRole('link', { name: '查看安装排查' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: '重试' })).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('offers a retry action for a classified install failure', async () => {
    let operationRequests = 0
    let retryRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runtime: dshRuntime }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'install-retry-source' }) }
      if (url.endsWith('/operations/install-retry-source/retry') && init?.method === 'POST') {
        retryRequests += 1
        expect(JSON.parse(String(init.body))).toEqual({ action: 'retry' })
        return { ok: true, json: async () => ({ operationId: 'install-retry-target' }) }
      }
      if (url.endsWith('/operations/install-retry-source')) {
        operationRequests += 1
        return { ok: true, json: async () => operationRequests === 1
          ? { id: 'install-retry-source', kind: 'install', skinId: skin.id, phase: 'downloading', startedAt: new Date().toISOString() }
          : { id: 'install-retry-source', kind: 'install', skinId: skin.id, phase: 'failed', startedAt: new Date().toISOString(), message: '插件下载遇到临时网络错误', failure: { kind: 'network', message: '插件下载遇到临时网络错误', action: 'retry' } } }
      }
      if (url.endsWith('/operations/install-retry-target')) return { ok: true, json: async () => ({ id: 'install-retry-target', kind: 'install', skinId: skin.id, phase: 'failed', startedAt: new Date().toISOString(), message: '仍然失败', failure: { kind: 'network', message: '仍然失败', action: 'retry' } }) }
      throw new Error(`Unexpected request: ${url}`)
    }))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    fireEvent.click(await screen.findByRole('button', { name: '仅安装' }))
    expect((await screen.findAllByRole('button', { name: '重试' }, { timeout: 2_000 })).length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0]!)

    await waitFor(() => expect(retryRequests).toBe(1))
  })

  it('allows only the displayed exact version and reuses this operation compatibility consent after release-age approval while preserving install-and-use', async () => {
    const incompatible = { ...skin, compatibility: { dsh: '<0.1.0-rc.6', platform: ['web'] } }
    let retryRequests = 0
    let activateRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [incompatible] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runtime: dshRuntime }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'install-age-source' }) }
      if (url.endsWith('/operations/install-age-source')) return { ok: true, json: async () => ({ id: 'install-age-source', kind: 'install', skinId: skin.id, phase: 'failed', startedAt: new Date().toISOString(), failure: {
        kind: 'release-age', message: '新包保护拦住市场版本', action: 'approve-release-age', releaseAgeTarget: { packageName: 'dsh-skin-market', version: '0.1.61' },
      } }) }
      if (url.endsWith('/operations/install-age-source/retry') && init?.method === 'POST') {
        retryRequests += 1
        expect(JSON.parse(String(init.body))).toEqual({ action: 'approve-release-age', acknowledgeCompatibility: true, compatibilityContext: compatibilityContext(incompatible, dshRuntime) })
        return { ok: true, json: async () => ({ operationId: 'install-age-approved' }) }
      }
      if (url.endsWith('/operations/install-age-approved')) return { ok: true, json: async () => ({ id: 'install-age-approved', kind: 'install', skinId: skin.id, phase: 'done' }) }
      if (url.endsWith('/activate') && init?.method === 'POST') {
        activateRequests += 1
        return { ok: true, json: async () => ({ operationId: 'activate-age-approved' }) }
      }
      if (url.endsWith('/operations/activate-age-approved')) return { ok: true, json: async () => ({ id: 'activate-age-approved', kind: 'activate', skinId: skin.id, phase: 'done' }) }
      throw new Error(`Unexpected request: ${url}`)
    }))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    fireEvent.click(await screen.findByRole('button', { name: '安装并使用' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: '兼容性提示' })).getByRole('button', { name: '仍然安装并使用' }))
    const dialog = await screen.findByRole('dialog', { name: '安装需要允许新版本' })
    expect(dialog.textContent).toContain('dsh-skin-market@0.1.61')
    expect(dialog.textContent).not.toContain('skin@1.0.0')
    expect(within(dialog).queryByRole('button', { name: '重试' })).toBeNull()
    expect(retryRequests).toBe(0)
    const approval = within(dialog).getByRole('button', { name: '允许此版本并继续' })
    fireEvent.click(approval)
    fireEvent.click(approval)
    await waitFor(() => expect(retryRequests).toBe(1))
    await waitFor(() => expect(activateRequests).toBe(1))
    expect(screen.queryByRole('dialog', { name: '安装需要允许新版本' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: '兼容性提示' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '安装并使用' }))
    expect(await screen.findByRole('dialog', { name: '兼容性提示' })).toBeTruthy()
  })

  it('lets users decline a release-age exception without silently retrying', async () => {
    const failedOperation = { id: 'declined-age', kind: 'install', skinId: skin.id, phase: 'failed', startedAt: new Date().toISOString(), failure: {
      kind: 'release-age', message: '新包保护', action: 'approve-release-age', releaseAgeTarget: { packageName: '@example/dependency', version: '2.3.4' },
    } }
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin] } : url.endsWith('/state') ? { skins: [], runtime: dshRuntime } : url.endsWith('/install') && init?.method === 'POST' ? { operationId: failedOperation.id } : url.endsWith('/operations/declined-age') ? failedOperation : {} }))
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    fireEvent.click(await screen.findByRole('button', { name: '安装并使用' }))
    const dialog = await screen.findByRole('dialog', { name: '安装需要允许新版本' })
    expect(dialog.textContent).toContain('@example/dependency@2.3.4')
    fireEvent.click(within(dialog).getByRole('button', { name: '暂不允许' }))
    expect(screen.queryByRole('dialog', { name: '安装需要允许新版本' })).toBeNull()
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/retry'))).toBe(false)
  })

  it('does not offer approval when the host cannot identify the exact blocked version', async () => {
    const operation = { id: 'unknown-age', kind: 'install', skinId: skin.id, phase: 'failed', startedAt: new Date().toISOString(), failure: {
      kind: 'release-age', message: '新包保护拦截，未能确定具体版本，请复制日志反馈。', action: 'approve-release-age',
    } }
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin] } : url.endsWith('/state') ? { skins: [], runtime: dshRuntime } : url.endsWith('/install') && init?.method === 'POST' ? { operationId: operation.id } : url.endsWith('/operations/unknown-age') ? operation : {} }))
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    fireEvent.click(await screen.findByRole('button', { name: '安装并使用' }))
    const dialog = await screen.findByRole('dialog', { name: '安装未完成' })
    expect(dialog.textContent).toContain('未能确定具体版本')
    expect(within(dialog).queryByRole('button', { name: '允许此版本并继续' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: '重试' })).toBeNull()
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/retry'))).toBe(false)
  })

  it.each([
    { kind: 'update', action: 'approve-release-age', failureKind: 'release-age' },
    { kind: 'install', action: 'approve-build', failureKind: 'build-approval' },
  ] as const)('reuses this operation compatibility consent for a $kind $action retry', async ({ kind, action, failureKind }) => {
    const incompatible = { ...skin, compatibility: { dsh: '<0.1.0-rc.6', platform: ['web'] } }
    let retries = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [incompatible] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: kind === 'update' ? [{ skinId: skin.id, installation: 'installed', activation: 'inactive', installedVersion: '0.9.0', updateAvailable: true }] : [], runtime: dshRuntime }) }
      if (url.endsWith(`/${kind}`) && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'compat-retry-source' }) }
      if (url.endsWith('/operations/compat-retry-source')) return { ok: true, json: async () => ({ id: 'compat-retry-source', kind, skinId: skin.id, phase: 'failed', failure: { kind: failureKind, message: '需要允许', action, releaseAgeTarget: { packageName: 'dsh-skin-market', version: '0.1.61' } } }) }
      if (url.endsWith('/operations/compat-retry-source/retry')) {
        retries += 1
        expect(JSON.parse(String(init?.body))).toEqual({ action, acknowledgeCompatibility: true, compatibilityContext: compatibilityContext(incompatible, dshRuntime) })
        return { ok: true, json: async () => ({ operationId: 'compat-retry-target' }) }
      }
      if (url.endsWith('/operations/compat-retry-target')) return { ok: true, json: async () => ({ id: 'compat-retry-target', kind, skinId: skin.id, phase: 'done' }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    fireEvent.click(screen.getByRole('button', { name: kind === 'update' ? '更新' : '仅安装' }))
    const compatibilityDialog = await screen.findByRole('dialog', { name: '兼容性提示' })
    fireEvent.click(within(compatibilityDialog).getByRole('button', { name: kind === 'update' ? '仍然更新' : '仍然安装' }))
    fireEvent.click(await screen.findByRole('button', { name: action === 'approve-build' ? '批准并重试' : '允许此版本并继续' }))
    await waitFor(() => expect(retries).toBe(1))
    expect(screen.queryByRole('dialog', { name: '兼容性提示' })).toBeNull()
  })

  it('requires fresh compatibility consent when the operation runtime changes before retry and preserves only its install-and-use intent', async () => {
    const incompatible = { ...skin, compatibility: { dsh: '<0.1.0-rc.6', platform: ['web'] } }
    let installed = false
    let currentRuntime = dshRuntime
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [incompatible] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ runtime: currentRuntime, skins: installed ? [{ skinId: skin.id, installation: 'installed', activation: 'inactive', installedVersion: '1.0.0', updateAvailable: false }] : [] }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'incompatible-retry-source' }) }
      if (url.endsWith('/operations/incompatible-retry-source')) return { ok: true, json: async () => ({ id: 'incompatible-retry-source', kind: 'install', skinId: skin.id, phase: 'failed', message: '插件下载遇到临时网络错误', failure: { kind: 'network', message: '插件下载遇到临时网络错误', action: 'retry' } }) }
      if (url.endsWith('/operations/incompatible-retry-source/retry') && init?.method === 'POST') {
        installed = true
        return { ok: true, json: async () => ({ operationId: 'incompatible-retry-target' }) }
      }
      if (url.endsWith('/operations/incompatible-retry-target')) return { ok: true, json: async () => ({ id: 'incompatible-retry-target', kind: 'install', skinId: skin.id, phase: 'done' }) }
      if (url.endsWith('/activate') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'incompatible-retry-activate' }) }
      if (url.endsWith('/operations/incompatible-retry-activate')) return { ok: true, json: async () => ({ id: 'incompatible-retry-activate', kind: 'activate', skinId: skin.id, phase: 'done' }) }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()
    fireEvent.click(screen.getByRole('button', { name: '安装并使用' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: '兼容性提示' })).getByRole('button', { name: '仍然安装并使用' }))
    await screen.findAllByRole('button', { name: '重试' })
    currentRuntime = { ...dshRuntime, version: '0.2.0-rc.2' }
    fireEvent(window, new Event('focus'))
    await screen.findByText(/当前 DSH 0.2.0-rc.2/)
    fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0]!)
    const retryDialog = await screen.findByRole('dialog', { name: '兼容性提示' })
    expect(retryDialog.textContent).toContain('皮肤安装目标或当前 DSH 信息已变化')
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/retry') && init?.method === 'POST')).toBe(false)
    fireEvent.click(within(retryDialog).getByRole('button', { name: '取消' }))
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/retry') && init?.method === 'POST')).toBe(false)
    fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0]!)
    fireEvent.click(within(await screen.findByRole('dialog', { name: '兼容性提示' })).getByRole('button', { name: '仍然安装并使用' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/activate') && init?.method === 'POST')).toBe(true))
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url.endsWith('/retry') && init?.method === 'POST')?.[1]?.body))).toEqual({ action: 'retry', acknowledgeCompatibility: true, compatibilityContext: compatibilityContext(incompatible, currentRuntime) })
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => url.endsWith('/activate') && init?.method === 'POST')?.[1]?.body))).toEqual({ skinId: skin.id, acknowledgeCompatibility: true, compatibilityContext: compatibilityContext(incompatible, currentRuntime) })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '兼容性提示' })).toBeNull())
  })

  it('puts build approval in a confirmation modal instead of the failure banner', async () => {
    let operationRequests = 0
    let retryRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], operation: null, runtime: dshRuntime }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'install-build-approval' }) }
      if (url.endsWith('/operations/install-build-approval/retry') && init?.method === 'POST') {
        retryRequests += 1
        expect(JSON.parse(String(init.body))).toEqual({ action: 'approve-build' })
        return { ok: true, json: async () => ({ operationId: 'install-build-approval-retry' }) }
      }
      if (url.endsWith('/operations/install-build-approval')) {
        operationRequests += 1
        return { ok: true, json: async () => operationRequests === 1
          ? { id: 'install-build-approval', kind: 'install', skinId: skin.id, phase: 'downloading', startedAt: new Date().toISOString() }
          : { id: 'install-build-approval', kind: 'install', skinId: skin.id, phase: 'failed', startedAt: new Date().toISOString(), message: '依赖 node-pty 等 2 个依赖包含被 pnpm 阻止的构建脚本；请批准后重试', failure: { kind: 'build-approval', message: '依赖 node-pty 等 2 个依赖包含被 pnpm 阻止的构建脚本；请批准后重试', packageName: 'node-pty', action: 'approve-build' } } }
      }
      if (url.endsWith('/operations/install-build-approval-retry')) return { ok: true, json: async () => ({ id: 'install-build-approval-retry', kind: 'install', skinId: skin.id, phase: 'failed', startedAt: new Date().toISOString(), message: '仍然失败', failure: { kind: 'build-approval', message: '仍然失败', packageName: 'node-pty', action: 'approve-build' } }) }
      throw new Error(`Unexpected request: ${url}`)
    }))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    fireEvent.click(await screen.findByRole('button', { name: '仅安装' }))

    const dialog = await screen.findByRole('dialog', { name: '需要批准构建脚本' })
    expect(within(dialog).getByText('涉及依赖：')).toBeTruthy()
    expect(within(dialog).getByText('node-pty')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '批准构建并重试' })).toBeNull()
    expect(screen.getByRole('button', { name: '批准并重试' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '稍后' }))
    expect(screen.queryByRole('dialog', { name: '需要批准构建脚本' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看批准说明' }))
    expect(await screen.findByRole('dialog', { name: '需要批准构建脚本' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '批准并重试' }))
    await waitFor(() => expect(retryRequests).toBe(1))
  })

  it('keeps the install-and-use intent after approving a build retry', async () => {
    let sourceRequests = 0
    let retryRequests = 0
    let activateRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], operation: null, runtime: dshRuntime }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'install-intent-source' }) }
      if (url.endsWith('/activate') && init?.method === 'POST') {
        activateRequests += 1
        return { ok: true, json: async () => ({ operationId: 'activate-after-approval' }) }
      }
      if (url.endsWith('/operations/install-intent-source/retry') && init?.method === 'POST') {
        retryRequests += 1
        return { ok: true, json: async () => ({ operationId: 'install-intent-retry' }) }
      }
      if (url.endsWith('/operations/install-intent-source')) {
        sourceRequests += 1
        return { ok: true, json: async () => sourceRequests === 1
          ? { id: 'install-intent-source', kind: 'install', skinId: skin.id, phase: 'downloading', startedAt: new Date().toISOString() }
          : { id: 'install-intent-source', kind: 'install', skinId: skin.id, phase: 'failed', startedAt: new Date().toISOString(), message: '需要批准', failure: { kind: 'build-approval', message: '需要批准', packageName: 'node-pty', action: 'approve-build' } } }
      }
      if (url.endsWith('/operations/install-intent-retry')) return { ok: true, json: async () => ({ id: 'install-intent-retry', kind: 'install', skinId: skin.id, phase: 'done' }) }
      if (url.endsWith('/operations/activate-after-approval')) return { ok: true, json: async () => ({ id: 'activate-after-approval', kind: 'activate', skinId: skin.id, phase: 'done' }) }
      throw new Error(`Unexpected request: ${url}`)
    }))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    fireEvent.click(await screen.findByRole('button', { name: '安装并使用' }))
    fireEvent.click(await screen.findByRole('button', { name: '批准并重试' }))

    await waitFor(() => expect(retryRequests).toBe(1))
    await waitFor(() => expect(activateRequests).toBe(1))
  })

  it('shows available byte progress in one banner and cancels the download', async () => {
    let cancelled = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], operation: null, runtime: dshRuntime }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'install-cancel' }) }
      if (url.endsWith('/operations/install-cancel/cancel') && init?.method === 'POST') {
        cancelled = true
        return { ok: true, json: async () => ({ id: 'install-cancel', phase: 'cancelling' }) }
      }
      if (url.endsWith('/operations/install-cancel')) return { ok: true, json: async () => cancelled
        ? { id: 'install-cancel', kind: 'install', skinId: skin.id, phase: 'cancelled', startedAt: new Date().toISOString() }
        : { id: 'install-cancel', kind: 'install', skinId: skin.id, phase: 'downloading', startedAt: new Date().toISOString(), cancelable: true, downloadedBytes: 1024 ** 2, totalBytes: 2 * 1024 ** 2, bytesPerSecond: 512 * 1024 } }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    fireEvent.click(await screen.findByRole('button', { name: '仅安装' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('1.0 MB / 2.0 MB'))
    const banner = screen.getByRole('status')
    expect(within(banner).getAllByText('1.0 MB / 2.0 MB').some(element => element.closest('[hidden]') === null)).toBe(true)
    expect(within(banner).getByText('512.0 KB/s').closest('[hidden]')).not.toBeNull()
    fireEvent.click(within(banner).getByRole('button', { name: '详情' }))
    expect(within(banner).getByText('512.0 KB/s').closest('[hidden]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(cancelled).toBe(true))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 2_000 })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('activates a verified skin after installation completes', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [skin] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runtime: dshRuntime }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'install-1' }) }
      if (url.endsWith('/operations/install-1')) return { ok: true, json: async () => ({ id: 'install-1', phase: 'done' }) }
      if (url.endsWith('/activate') && init?.method === 'POST') return await new Promise(() => undefined)
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    fireEvent.click(await screen.findByRole('button', { name: '安装并使用' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith('/activate') && init?.method === 'POST')).toBe(true))
  })

  it('warns that compatibility is unverified but still installs', async () => {
    const unverified = { ...skin, review: { compatibility: 'unverified' as const, preview: 'repository-card' as const, installation: 'verified' as const }, compatibility: { dsh: 'unverified', platform: ['web'] } }
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [unverified] }) }
      if (url.endsWith('/state')) return { ok: true, json: async () => ({ skins: [], runtime: dshRuntime }) }
      if (url.endsWith('/install') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'op-unverified' }) }
      if (url.endsWith('/operations/op-unverified')) return { ok: true, json: async () => ({ id: 'op-unverified', kind: 'install', skinId: unverified.id, phase: 'done' }) }
      if (url.endsWith('/activate') && init?.method === 'POST') return { ok: true, json: async () => ({ operationId: 'op-activate' }) }
      if (url.endsWith('/operations/op-activate')) return { ok: true, json: async () => ({ id: 'op-activate', kind: 'activate', skinId: unverified.id, phase: 'done' }) }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    const otherMethods = await screen.findByRole('button', { name: '其他安装方式' })
    const automatic = screen.getByRole('button', { name: '安装并使用' })
    expect(automatic.getAttribute('variant')).toBe('primary')
    expect(otherMethods.getAttribute('variant')).toBe('outline')
    expect(screen.queryByRole('button', { name: '待验证，手动安装' })).toBeNull()
    expect(screen.queryByText(/维护者尚未声明 DSH 兼容范围，仍可一键安装/)).toBeNull()
    expect(screen.queryByRole('dialog', { name: '兼容性提示' })).toBeNull()
    fireEvent.click(automatic)
    const dialog = await screen.findByRole('dialog', { name: '兼容性提示' })
    expect(dialog.textContent).toMatch(/皮肤未声明 DSH 兼容范围/)
    expect(dialog.textContent).toMatch(/仍可继续使用/)
    expect(within(dialog).getByRole('link', { name: '页面异常时重置皮肤' }).getAttribute('href')).toContain('#页面异常时重置皮肤')
    expect(screen.queryByRole('button', { name: '确认无任务，立即重启' })).toBeNull()
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/install'))).toBe(true))
    expect(screen.queryByRole('dialog', { name: '已拦截安装' })).toBeNull()
    expect(screen.getByText('该仓库暂无可识别的皮肤截图，市场使用本地占位卡，不会加载 GitHub 仓库图片。')).toBeTruthy()
    expect(screen.getAllByRole('img', { name: '测试皮肤 暂无界面截图' }).length).toBeGreaterThanOrEqual(2)
    expect(document.querySelector(`img[src="${unverified.screenshots[0]}"]`)).toBeNull()
  })

  it('shows prompt and command as two alternative copy capsules', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [] } })))
    const writeText = vi.fn(async () => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    fireEvent.click(await screen.findByRole('button', { name: '其他安装方式' }))
    const dialog = screen.getByRole('dialog', { name: '安装 测试皮肤' })
    expect(dialog.textContent).toContain('任选一种，不用都执行。')
    expect([...dialog.querySelectorAll('code')].map(node => node.textContent)).toEqual([createSkinInstallPrompt(skin, 'dsh'), createSkinInstallCommand(skin)])
    fireEvent.click(screen.getByRole('button', { name: '复制命令' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(createSkinInstallCommand(skin)))
  })

  it('replaces a failed verified screenshot instead of retaining stale image pixels', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [] } })))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    const preview = await screen.findByAltText('测试皮肤 大图预览')
    fireEvent.error(preview)

    expect(screen.getByRole('img', { name: '测试皮肤 暂无界面截图' })).toBeTruthy()
  })

  it('labels market-only captures when the repository has no usable screenshot', async () => {
    const supplemented = {
      ...skin,
      screenshots: [],
      review: { compatibility: 'verified' as const, preview: 'repository-card' as const, installation: 'verified' as const },
      marketScreenshots: ['https://example.com/market-home.png'],
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [supplemented] } : { skins: [] } })))
    render(<SkinMarketSection t={key => key} />)

    await openSkinCard()
    expect(screen.getByText('当前展示的是市场在隔离 DSH 中实机补录的截图；仓库尚无可识别的界面截图。')).toBeTruthy()
  })

  it('uses the upstream screenshot when it is usable, without rendering market captures', async () => {
    const market = 'https://example.com/market-home.png'
    const upstreamCover = 'https://example.com/upstream-cover.png'
    const supplemented = {
      ...skin,
      listScreenshot: upstreamCover,
      marketScreenshots: [market],
      screenshots: [upstreamCover],
      review: { compatibility: 'verified' as const, preview: 'verified' as const, installation: 'verified' as const },
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [supplemented] } : { skins: [] } })))
    render(<SkinMarketSection t={key => key} />)

    await openSkinCard()
    expect(document.querySelector(`img[src="${upstreamCover}"]`)).toBeTruthy()
    expect(screen.getByAltText('测试皮肤 大图预览').getAttribute('src')).toBe(upstreamCover)
    expect(screen.queryByText('当前展示的是市场在隔离 DSH 中实机补录的截图；仓库尚无可识别的界面截图。')).toBeNull()
  })

  it('uses catalog WebP media by default and keeps the original-image fallback available', async () => {
    const preview = 'https://cdn.example.com/preview.webp'
    const full = 'https://cdn.example.com/full.webp'
    const layered = {
      ...skin,
      media: { list: { preview, full }, screenshots: [{ preview, full }] },
    }
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [layered] } : { skins: [] } }))
    vi.stubGlobal('fetch', fetchMock)

    window.history.replaceState({}, '', '/')
    render(<SkinMarketSection t={key => key} />)
    const cardPreview = await screen.findByRole('img', { name: '测试皮肤 界面预览' })
    await waitFor(() => expect(cardPreview.getAttribute('src')).toBe(preview))
    fireEvent.click(await screen.findByRole('button', { name: /测试皮肤 界面预览/ }))
    const fullImage = await waitFor(() => document.querySelector(`img[src="${full}"]`))
    expect(fullImage).toBeTruthy()
    expect(fullImage?.parentElement?.querySelector(`img[src="${preview}"]`)).toBeNull()

    cleanup()
    window.history.replaceState({}, '', '/?dsh-media=0')
    render(<SkinMarketSection t={key => key} />)
    await screen.findByRole('button', { name: /测试皮肤 界面预览/ })
    expect(document.querySelector(`img[src="${preview}"]`)).toBeNull()
    window.history.replaceState({}, '', '/')
  })

  it('uses the original card screenshot immediately when its source is absent from the manifest', async () => {
    const source = 'https://example.com/aurora-missing.png'
    const layered = {
      ...skin,
      screenshots: [source],
      media: { list: { preview: 'https://cdn.example.com/aurora.webp', full: 'https://cdn.example.com/aurora-full.webp' }, screenshots: [{ preview: 'https://cdn.example.com/aurora.webp', full: 'https://cdn.example.com/aurora-full.webp' }] },
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [layered] }) }
      if (url.endsWith('/manifest.json')) return { ok: true, json: async () => ({}) }
      return { ok: true, json: async () => ({ skins: [], installedClientPlugins: [], runningAgentCount: 0 }) }
    }))
    render(<SkinMarketSection t={key => key} />)

    const image = await screen.findByRole('img', { name: '测试皮肤 界面预览' })
    await waitFor(() => expect(image.getAttribute('src')).toBe(source))
  })

  it('moves a failed card to the next catalog screenshot after WebP and original fallback fail', async () => {
    const first = 'https://example.com/aurora-first.png'
    const second = 'https://example.com/aurora-second.png'
    const firstPreview = 'https://cdn.example.com/aurora-first.webp'
    const secondPreview = 'https://cdn.example.com/aurora-second.webp'
    const layered = {
      ...skin,
      screenshots: [first, second],
      media: {
        list: { preview: firstPreview, full: 'https://cdn.example.com/aurora-first-full.webp' },
        screenshots: [
          { preview: firstPreview, full: 'https://cdn.example.com/aurora-first-full.webp' },
          { preview: secondPreview, full: 'https://cdn.example.com/aurora-second-full.webp' },
        ],
      },
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/catalog')) return { ok: true, json: async () => ({ skins: [layered] }) }
      if (url.endsWith('/manifest.json')) return { ok: true, json: async () => ({ [first]: 'first', [second]: 'second' }) }
      return { ok: true, json: async () => ({ skins: [], installedClientPlugins: [], runningAgentCount: 0 }) }
    }))
    render(<SkinMarketSection t={key => key} />)

    const image = await screen.findByRole('img', { name: '测试皮肤 界面预览' })
    await waitFor(() => expect(image.getAttribute('src')).toBe(firstPreview))
    fireEvent.error(image)
    expect(image.getAttribute('src')).toBe(first)
    fireEvent.error(image)
    expect(image.getAttribute('src')).toBe(secondPreview)
  })

  it('sends verified client-only skins to their manual installation guide', async () => {
    const manual = { ...skin, review: { compatibility: 'verified' as const, preview: 'verified' as const, installation: 'manual-only' as const } }
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [manual] } : { skins: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    render(<SkinMarketSection t={key => key} />)

    await openSkinCard()
    fireEvent.click(await screen.findByTitle('打开手动安装面板'))
    expect(screen.getByRole('dialog', { name: '安装 测试皮肤' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '打开安装页面' })).toBeNull()
    expect(open).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/install'))).toBe(false)
    expect(screen.getByText('该仓库距离市场的一键安装规范还差少量信息；可参考右侧仓库健康建议完善，当前请按维护者说明安装。')).toBeTruthy()
  })

  it('shows constructive repository health checks and suggestions', async () => {
    const healthSkin = { ...skin, health: {
      status: 'improvements' as const,
      checks: { readmeScreenshots: 'pass' as const, compatibility: 'improve' as const, installation: 'pass' as const },
      suggestions: ['建议声明支持的 DSH Web 版本范围。'],
    } }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [healthSkin] } : { skins: [] } })))
    render(<SkinMarketSection t={key => key} />)
    await openSkinCard()

    expect(await screen.findByRole('heading', { name: '仓库健康' })).toBeTruthy()
    expect(screen.getByText('README 截图').nextSibling?.textContent).toBe('符合要求')
    expect(screen.getByText('兼容版本').nextSibling?.textContent).toBe('建议完善')
    expect(screen.getByText('建议声明支持的 DSH Web 版本范围。')).toBeTruthy()
  })

  it('generates and copies an agent PR prompt without submitting to GitHub', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: { writeText } })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/catalog') ? { skins: [skin] } : { skins: [] } })))

    render(<SkinMarketSection t={key => key} />)
    await waitFor(() => expect(screen.getByRole('button', { name: '提交皮肤' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '提交皮肤' }))

    const prompt = screen.getByRole('textbox', { name: 'Agent 投稿提示词' }) as HTMLTextAreaElement
    expect(screen.queryByRole('textbox', { name: '皮肤 GitHub 仓库' })).toBeNull()
    expect(prompt.value).toContain('否则先向我索要公开 GitHub 仓库地址')
    expect(prompt.value).toContain('目标目录仓库：https://github.com/kingOfSoySauce/dsh-skin-market')
    fireEvent.click(screen.getByRole('button', { name: '复制提示词' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(prompt.value))
    expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy()
  })
})
