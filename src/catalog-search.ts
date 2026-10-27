export interface CatalogSearchEntry {
  name: { zh: string; en: string }
  author: string
  description: string
  tags: string[]
  repo?: string
  package?: string
  rowId?: string
}

export function matchesCatalogSearch(entry: CatalogSearchEntry, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  if (normalizedQuery === '') return true

  const haystack = [
    entry.name.zh,
    entry.name.en,
    entry.description,
    entry.author,
    entry.repo,
    entry.package,
    entry.rowId,
    ...entry.tags,
  ].join(' ').toLowerCase()
  return haystack.includes(normalizedQuery)
}
