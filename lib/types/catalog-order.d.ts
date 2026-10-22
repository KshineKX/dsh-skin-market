export interface PreviewableCatalogEntry {
    review?: {
        preview: 'verified' | 'repository-card';
    };
    subpath?: string;
    marketScreenshots?: string[];
    listScreenshot?: string;
    screenshots: string[];
}
export declare function usesMarketScreenshots(entry: PreviewableCatalogEntry): boolean;
/**
 * Returns the URLs that should actually be rendered. Market captures are
 * intentionally kept separate from the source-of-truth repository screenshots.
 */
export declare function getCatalogScreenshotUrls(entry: PreviewableCatalogEntry): string[];
export declare function getCatalogListScreenshot(entry: PreviewableCatalogEntry): string | undefined;
/** Keep entries with real UI imagery ahead of repository-only placeholders. */
export declare function hasCatalogPreview(entry: PreviewableCatalogEntry): boolean;
export type CatalogSort = 'heat' | 'stars' | 'latest';
export declare function compareCatalogOrder<T extends PreviewableCatalogEntry>(a: T, b: T, sortBy: CatalogSort, starsFor: (entry: T) => number, updatedAtFor: (entry: T) => string, heatFor?: (entry: T) => number): number;
