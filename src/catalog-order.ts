export interface PreviewableCatalogEntry {
  review?: { preview: 'verified' | 'repository-card' }
  subpath?: string
  marketScreenshots?: string[]
  listScreenshot?: string
  screenshots: string[]
}

function isRepositoryPreviewUrl(url: string): boolean {
  return url.includes('opengraph.githubassets.com/')
    || url.includes('repository-images.githubusercontent.com/')
    || url.includes('dshfind.com/api/card')
}

function matchingScreenshots(upstreamScreenshots: string[], subpath: string | undefined): string[] {
  if (subpath === undefined || subpath.trim() === '') return []
  const normalizedSubpath = subpath.replace(/^\/+|\/+$/g, '')
  return upstreamScreenshots.filter(url => {
    try {
      const pathname = decodeURIComponent(new URL(url).pathname).replace(/^\/+|\/+$/g, '')
      return pathname === normalizedSubpath
        || pathname.includes(`/${normalizedSubpath}/`)
        || pathname.endsWith(`/${normalizedSubpath}`)
    } catch {
      return false
    }
  })
}

function scopedScreenshots(upstreamScreenshots: string[], subpath: string | undefined): string[] {
  const unique = [...new Set(upstreamScreenshots)]
  const scoped = matchingScreenshots(unique, subpath)
  return scoped.length > 0 ? scoped : unique
}

function hasCrossPackageScreenshots(upstreamScreenshots: string[], subpath: string | undefined): boolean {
  const unique = [...new Set(upstreamScreenshots)]
  if (subpath === undefined || unique.length === 0) return false
  const scoped = matchingScreenshots(unique, subpath)
  return scoped.length > 0 && scoped.length < unique.length
}

export function usesMarketScreenshots(entry: PreviewableCatalogEntry): boolean {
  const market = entry.marketScreenshots ?? []
  const upstream = entry.screenshots
  const scopedUpstream = scopedScreenshots(upstream, entry.subpath)
  const hasUsableUpstream = entry.review?.preview !== 'repository-card'
    && scopedUpstream.some(url => !isRepositoryPreviewUrl(url))
  return market.length > 0 && (hasCrossPackageScreenshots(upstream, entry.subpath) || !hasUsableUpstream)
}

/**
 * Returns the URLs that should actually be rendered. Market captures are
 * intentionally kept separate from the source-of-truth repository screenshots.
 */
export function getCatalogScreenshotUrls(entry: PreviewableCatalogEntry): string[] {
  const market = entry.marketScreenshots ?? []
  const upstream = entry.screenshots
  const contaminated = hasCrossPackageScreenshots(upstream, entry.subpath)
  const scopedUpstream = scopedScreenshots(upstream, entry.subpath)
  const usableUpstream = entry.review?.preview === 'repository-card'
    ? []
    : scopedUpstream.filter(url => !isRepositoryPreviewUrl(url))
  if (contaminated) {
    const scopedDisplay = [...new Set([...market, ...usableUpstream])]
    if (scopedDisplay.length > 0) return scopedDisplay
  }
  if (usableUpstream.length > 0) return [...new Set(usableUpstream)]
  if (market.length > 0) return [...new Set(market)]
  return [...new Set([...market, ...scopedUpstream])]
}

export function getCatalogListScreenshot(entry: PreviewableCatalogEntry): string | undefined {
  return getCatalogScreenshotUrls(entry)[0] ?? entry.listScreenshot
}

/** Keep entries with real UI imagery ahead of repository-only placeholders. */
export function hasCatalogPreview(entry: PreviewableCatalogEntry): boolean {
  const hasMarketScreenshots = (entry.marketScreenshots?.length ?? 0) > 0
  const scopedUpstream = scopedScreenshots(entry.screenshots, entry.subpath)
  const hasUsableUpstream = entry.review?.preview !== 'repository-card'
    && scopedUpstream.some(url => !isRepositoryPreviewUrl(url))
  return hasUsableUpstream || hasMarketScreenshots
}

export type CatalogSort = 'heat' | 'stars' | 'latest'

export function compareCatalogOrder<T extends PreviewableCatalogEntry>(
  a: T,
  b: T,
  sortBy: CatalogSort,
  starsFor: (entry: T) => number,
  updatedAtFor: (entry: T) => string,
  heatFor: (entry: T) => number = () => 0,
): number {
  const aHasPreview = hasCatalogPreview(a)
  const bHasPreview = hasCatalogPreview(b)
  if (aHasPreview !== bHasPreview) return aHasPreview ? -1 : 1
  if (sortBy === 'heat') return heatFor(b) - heatFor(a) || starsFor(b) - starsFor(a)
  return sortBy === 'latest'
    ? Date.parse(updatedAtFor(b)) - Date.parse(updatedAtFor(a))
    : starsFor(b) - starsFor(a)
}
