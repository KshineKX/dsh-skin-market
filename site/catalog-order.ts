import { compareCatalogOrder, hasCatalogPreview, type CatalogSort, type PreviewableCatalogEntry } from '../src/catalog-order.ts'

export interface PublicCatalogEntry extends PreviewableCatalogEntry {
  starsSnapshot: number
  updatedAt: string
  heat?: { score: number }
}

export function shouldRenderPublicPreview(entry: PreviewableCatalogEntry, src: string | undefined, failed = false): boolean {
  return !failed && src !== undefined && hasCatalogPreview(entry)
}

export function comparePublicCatalogOrder(a: PublicCatalogEntry, b: PublicCatalogEntry, sortBy: CatalogSort): number {
  return compareCatalogOrder(a, b, sortBy, entry => entry.starsSnapshot, entry => entry.updatedAt, entry => entry.heat?.score ?? 0)
}
