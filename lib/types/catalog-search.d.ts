export interface CatalogSearchEntry {
    name: {
        zh: string;
        en: string;
    };
    author: string;
    description: string;
    tags: string[];
    repo?: string;
    package?: string;
    rowId?: string;
}
export declare function matchesCatalogSearch(entry: CatalogSearchEntry, query: string): boolean;
