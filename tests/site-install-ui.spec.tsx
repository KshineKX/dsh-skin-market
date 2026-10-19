// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../site/main.tsx'
import type { CatalogSkin } from '../src/client/types.ts'

const commit = 'a'.repeat(40)
const skin = {
  id: 'test.skin', name: { zh: '测试皮肤', en: 'Test Skin' }, author: 'example', description: '测试皮肤',
  repo: 'https://github.com/example/skins', package: '@example/skin', rowId: 'skin', tags: [], modes: ['dark'],
  install: {
    target: `github:example/skins#${commit}&path:/packages/skin`, version: '1.0.0', commit,
    companions: [{ package: '@example/bridge', rowId: 'bridge', target: '@example/bridge@1.2.3', version: '1.2.3', commit }],
  },
  compatibility: { dsh: '*', platform: ['web'] }, screenshots: [],
  review: { compatibility: 'verified', preview: 'verified', installation: 'manual-only' },
  featuredRank: 0, starsSnapshot: 10, updatedAt: '2026-10-16',
} as CatalogSkin & { featuredRank: number; starsSnapshot: number; updatedAt: string }

const writeText = vi.fn(async (_value: string) => undefined)

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('public install panel', () => {
  it('shows aligned skin and market groups with one package and one common command each', async () => {
    render(<App skins={[{ ...skin, install: { ...skin.install, target: `github:example/skins#${commit}`, desktop: { mode: 'managed', registry: 'npm', packageName: '@example/skin', packageVersion: '1.0.0' } } }]} />)
    fireEvent.click(screen.getByRole('button', { name: '需手动安装' }))

    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('.install-method-grid')?.getAttribute('data-single')).toBe('false')
    expect(within(dialog).queryByRole('combobox')).toBeNull()
    expect(within(dialog).queryByRole('tablist')).toBeNull()
    expect(within(dialog).queryByRole('group', { name: '安装环境' })).toBeNull()
    expect(within(dialog).queryByText(/伴生插件包名|伴生插件命令/)).toBeNull()
    const group = screen.getByRole('region', { name: '安装这个皮肤' })
    expect(within(group).getAllByText('提示词')).toHaveLength(1)
    expect(within(group).getAllByText('桌面版')).toHaveLength(1)
    const desktopInput = within(group).getByRole('textbox', { name: '安装这个皮肤的桌面版插件包名' }) as HTMLInputElement
    expect(desktopInput.value).toBe('@example/skin')
    expect(desktopInput.readOnly).toBe(true)
    expect(within(group).getAllByText('命令')).toHaveLength(1)

    fireEvent.click(within(group).getByRole('button', { name: '复制安装这个皮肤的桌面版插件包名' }))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('@example/skin'))
    expect(within(group).getByRole('button', { name: '已复制安装这个皮肤的桌面版插件包名' })).toBeTruthy()
    fireEvent.click(within(group).getByRole('button', { name: '复制安装这个皮肤的命令' }))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`dsh plugin --profile web add "github:example/skins#${commit}"`))
    expect(writeText.mock.calls.at(-1)![0]).not.toMatch(/[\r\n]/)

    fireEvent.click(within(group).getByRole('button', { name: '复制安装这个皮肤的提示词' }))
    await waitFor(() => expect(writeText.mock.calls.at(-1)![0]).toContain('@example/bridge@1.2.3'))
    const market = screen.getByRole('region', { name: '安装皮肤市场' })
    fireEvent.click(within(market).getByRole('button', { name: '复制安装皮肤市场的桌面版插件包名' }))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('dsh-skin-market'))
    fireEvent.click(within(market).getByRole('button', { name: '复制安装皮肤市场的命令' }))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('dsh plugin --profile web add "dsh-skin-market"'))
  })

  it('uses the prompt for a Git subdirectory rather than offering a shell-specific command as universal', async () => {
    render(<App skins={[skin]} />)
    fireEvent.click(screen.getByRole('button', { name: '需手动安装' }))
    const group = screen.getByRole('region', { name: '安装这个皮肤' })
    expect(within(group).getByText('此皮肤需按实际环境安装，请复制提示词。')).toBeTruthy()
    expect(within(group).queryByRole('button', { name: '复制安装这个皮肤的命令' })).toBeNull()
    fireEvent.click(within(group).getByRole('button', { name: '复制安装这个皮肤的桌面版插件包名' }))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(skin.install.target))
    fireEvent.click(within(group).getByRole('button', { name: '复制安装这个皮肤的提示词' }))
    await waitFor(() => expect(writeText.mock.calls.at(-1)![0]).toContain('@example/bridge@1.2.3'))
  })

  it('keeps the market-only dialog as a single group with the same three fields', async () => {
    render(<App skins={[skin]} />)
    fireEvent.click(screen.getByRole('button', { name: '安装皮肤市场' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('.install-method-grid')?.getAttribute('data-single')).toBe('true')
    expect(within(dialog).queryByRole('region', { name: '安装这个皮肤' })).toBeNull()
    expect(within(dialog).getAllByRole('region')).toHaveLength(1)
    expect(within(dialog).getByText('提示词')).toBeTruthy()
    expect(within(dialog).getByText('桌面版')).toBeTruthy()
    expect(within(dialog).getByText('命令')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '复制安装皮肤市场的命令' }))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('dsh plugin --profile web add "dsh-skin-market"'))
  })
})
