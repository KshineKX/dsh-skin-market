import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { compareVersions, parseVersion, satisfiesVersionRange } from './semver.ts'
import type { DshRuntime } from './types.ts'

export const KEYED_SLOT_CAPABILITY_PREFIX = 'slot:keyed:'
export const LIST_SLOT_CAPABILITY_PREFIX = 'slot:list:'
export const LEGACY_KEYED_SETTINGS_RANGE = '>=0.1.0-rc.7 <0.1.6-alpha.2'
const AUDITED_RUNTIME_RANGE = '>=0.1.0-rc.6 <=0.2.1-alpha.2'
// The rc.1 package introduced these slots. Later releases keep them until a
// host change says otherwise; gaps below this floor stay unaudited.
const MODERN_SLOT_VERSION = '0.2.1-rc.1'
function hasModernSlots(version: string): boolean {
  return compareVersions(version.trim().replace(/\+.*/, ''), MODERN_SLOT_VERSION) >= 0
}

interface RuntimeManifest { name?: unknown; version?: unknown }

function readManifest(file: string): RuntimeManifest | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RuntimeManifest : null
  } catch {
    return null
  }
}

function validVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const version = value.trim()
  // Reject invalid semantic versions instead of turning an arbitrary package
  // version or a mistyped override into a host capability claim.
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) return null
  const parsed = parseVersion(version)
  if (parsed === null || parsed.prerelease.some(part => /^0\d+$/.test(part))) return null
  return version
}

function embeddedDshVersion(directory: string, manifest: RuntimeManifest): string | null {
  if (manifest.name !== '@deepseek-ai/dsh-desktop-runtime' && manifest.name !== '@deepseek-ai/dsh-desktop') return null
  const packageFile = join(directory, ...(manifest.name === '@deepseek-ai/dsh-desktop' ? ['dsh'] : []), 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const embedded = readManifest(packageFile)
  if (embedded?.name !== '@deepseek-ai/dsh') return null
  const version = validVersion(embedded.version)
  return version !== null && version === validVersion(manifest.version) ? version : null
}

function dshPackageVersion(): string | null {
  const entry = process.argv[1]
  if (entry === undefined) return null
  let directory: string
  try { directory = dirname(realpathSync(resolve(entry))) } catch { directory = dirname(resolve(entry)) }
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(directory, 'package.json')
    if (existsSync(candidate)) {
      const manifest = readManifest(candidate)
      if (manifest?.name === '@deepseek-ai/dsh') return validVersion(manifest.version)
      if (manifest !== null) {
        const embedded = embeddedDshVersion(directory, manifest)
        if (embedded !== null) return embedded
        // A recognized Desktop root with an invalid/mismatched embedded DSH
        // must not inherit a version from an unrelated ancestor.
        if (manifest.name === '@deepseek-ai/dsh-desktop-runtime' || manifest.name === '@deepseek-ai/dsh-desktop') return null
      }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

export function runtimeCapabilities(version: string | null): string[] {
  if (version === null || validVersion(version) === null) return []
  const auditedModernSlots = hasModernSlots(version)
  if (!auditedModernSlots && !satisfiesVersionRange(version, AUDITED_RUNTIME_RANGE)) return []
  const capabilities: string[] = [`${LIST_SLOT_CAPABILITY_PREFIX}settings.section`]
  // The published rc.6 package declares a list. The first available rc.7 tag
  // declares a keyed slot, which is removed in 0.1.6-alpha.2.
  if (satisfiesVersionRange(version, '>=0.1.0-rc.6 <0.1.0-rc.7')) {
    capabilities.push(`${LIST_SLOT_CAPABILITY_PREFIX}settings.plugin.item`)
  } else if (satisfiesVersionRange(version, LEGACY_KEYED_SETTINGS_RANGE)) {
    capabilities.push(`${KEYED_SLOT_CAPABILITY_PREFIX}settings.plugin.item`)
  } else if (auditedModernSlots || satisfiesVersionRange(version, '>=0.1.6-alpha.2 <=0.2.1-alpha.2')) {
    capabilities.push(`${LIST_SLOT_CAPABILITY_PREFIX}plugins.item`, `${KEYED_SLOT_CAPABILITY_PREFIX}plugins.bundle.config`, `${KEYED_SLOT_CAPABILITY_PREFIX}plugins.row.config`)
  }
  return capabilities
}

export function detectDshRuntime(): DshRuntime {
  const injected = process.env.DSH_VERSION?.trim()
  if (injected !== undefined && injected !== '') {
    const version = validVersion(injected)
    return { version, capabilities: runtimeCapabilities(version), source: version === null ? 'unknown' : 'injected' }
  }
  const version = dshPackageVersion()
  return { version, capabilities: runtimeCapabilities(version), source: version === null ? 'unknown' : 'host-package' }
}

export function hasRuntimeCapability(runtime: DshRuntime, capability: string): boolean {
  return runtime.capabilities.includes(capability)
}
