import { createElement as h } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { SkinMarketSection } from './SkinMarketSection.tsx'
import { createDesktopPluginPanel } from './desktop-plugin-panel.ts'

const namespace = 'dsh-skin-market'
const dictionaries = {
  zh: { nav: '皮肤市场', title: '皮肤市场', subtitle: '发现并管理 DSH 外观', search: '搜索皮肤', catalog: '皮肤列表' },
  en: { nav: 'Skin Market', title: 'Skin Market', subtitle: 'Discover and manage DSH skins', search: 'Search skins', catalog: 'Skin catalog' },
}

interface ClientContext {
  get?: (name: string) => unknown
  effect(callback: () => unknown, label?: string): void
  locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown; bind(namespace: string): (key: string) => string }
  loader: ClientLoader
  slots: { inject(slot: string, callback: () => unknown): void; register(meta: Record<string, unknown>, component: () => unknown): unknown; entriesOfSlot?: (slot: string) => readonly unknown[] }
  layout?: { selectPanel(panelId: string): void }
}

interface ClientLoaderEntry {
  options: { name: string }
  update(options: { disabled: boolean | null }, create?: boolean, force?: boolean): Promise<void>
}

interface ClientLoader { entries(): Iterable<ClientLoaderEntry> }

export interface ClientSkinRuntime {
  setActive(packageName: string, active: boolean): Promise<boolean>
}

export async function switchClientSkin(runtime: ClientSkinRuntime, packageNames: string[], target: string, preserved: Iterable<string> = []): Promise<boolean> {
  const keep = new Set([...preserved, target])
  for (const packageName of packageNames) {
    if (!keep.has(packageName)) await runtime.setActive(packageName, false)
  }
  return runtime.setActive(target, true)
}

export function createClientSkinRuntime(loader: ClientLoader): ClientSkinRuntime {
  return {
    async setActive(packageName, active) {
      const entry = [...loader.entries()].find(item => item.options.name === packageName)
      if (entry === undefined) return false
      await entry.update({ disabled: active ? null : true }, false, true)
      return true
    },
  }
}

export const name = 'dsh-skin-market'
export const inject = ['slots', 'locale', 'loader']
export const REQUIRED_PRIMITIVES = ['Button', 'Input', 'Modal', 'Pill'] as const

export function missingPrimitives(module: Record<string, unknown>): string[] {
  return REQUIRED_PRIMITIVES.filter(key => module[key] === undefined)
}

export function apply(ctx: ClientContext): void {
  const missing = missingPrimitives(primitives as unknown as Record<string, unknown>)
  if (missing.length > 0) {
    console.warn(`[dsh-skin-market] missing DSH primitives: ${missing.join(', ')}`)
    return
  }
  ctx.effect(() => ctx.locale.register(namespace, dictionaries), 'dsh-skin-market: locale')
  const t = ctx.locale.bind(namespace)
  const clientRuntime = createClientSkinRuntime(ctx.loader)
  const desktopPluginPanel = createDesktopPluginPanel(ctx)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'skin-market', order: 45, label: () => t('nav'), locale: namespace, inject: () => ({ t }),
  }, () => h(SkinMarketSection, { t, clientRuntime, desktopPluginPanel, layout: 'fill' })))
  // The injection stays dormant on older hosts and registers when the new
  // Plugins page owns this slot. Both entry points use the same market UI.
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: namespace, locale: namespace, inject: () => ({ t }),
  }, () => h(SkinMarketSection, { t, clientRuntime, desktopPluginPanel, layout: 'embedded' })))
}

export { SkinMarketSection } from './SkinMarketSection.tsx'
