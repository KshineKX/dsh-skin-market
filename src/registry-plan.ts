export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'

/** Normalize a registry base without preserving credentials or query data. */
export function normalizeRegistryBase(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = new URL(value.trim())
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== ''
      || parsed.search !== '' || parsed.hash !== '') return null
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`
  } catch { return null }
}

/** Keep the host-provided order while removing invalid and duplicate entries. */
export function normalizeRegistryPlan(values: readonly unknown[] | undefined): string[] | undefined {
  if (values === undefined) return undefined
  const plan = values.map(normalizeRegistryBase).filter((item): item is string => item !== null)
  return [...new Set(plan)]
}

/** Convert the official plugin manager snapshot into a safe ordered plan. */
export function registryPlanFromSnapshot(value: unknown): string[] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const configured = normalizeRegistryBase(record.registry)
  const fallback = Array.isArray(record.fallbackRegistries)
    ? record.fallbackRegistries.map(normalizeRegistryBase).filter((item): item is string => item !== null)
    : []
  const resolved = normalizeRegistryBase(record.resolved)
  // A resolved private override must not fall through to public registries.
  if (resolved !== null && !fallback.includes(resolved) && (configured === null || resolved !== configured)) return [resolved]
  return normalizeRegistryPlan([configured ?? resolved, ...fallback])
}

export type RegistryPlanProvider = () => Promise<readonly string[] | undefined>
