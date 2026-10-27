export function matchesCatalogSearch(entry, query) {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery === '')
        return true;
    const haystack = [
        entry.name.zh,
        entry.name.en,
        entry.description,
        entry.author,
        entry.repo,
        entry.package,
        entry.rowId,
        ...entry.tags,
    ].join(' ').toLowerCase();
    return haystack.includes(normalizedQuery);
}
