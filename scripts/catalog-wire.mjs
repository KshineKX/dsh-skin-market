function byId(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item)
}

/**
 * Serialize validated registry entries for both old and new clients.
 * Old clients strictly validate install fields, but allow catalog extensions.
 * Keep npm metadata outside each skin until a new client decodes the catalog.
 */
export function buildCatalogWire(skins, { previous, heat, generatedAt = new Date().toISOString() } = {}) {
  const sortedSkins = [...skins].sort((left, right) => left.featuredRank - right.featuredRank || byId(left, right))
  const npmSources = Object.fromEntries([...skins].sort(byId)
    .filter(skin => skin.install.npm !== undefined)
    .map(skin => [skin.id, { ...skin.install.npm }]))
  // Momentum lives beside skins[], never inside an entry: published clients
  // validate each skin with a closed schema, while unknown envelope fields are
  // ignored by older versions. Same compatibility rule as npmSources.
  const known = new Set(skins.map(skin => skin.id))
  const heatSources = heat === undefined || heat === null
    ? undefined
    : Object.fromEntries(Object.entries(heat).filter(([id]) => known.has(id)).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
  const payload = {
    schemaVersion: 1,
    skins: sortedSkins.map(skin => {
      const { npm: _npm, ...install } = skin.install
      return { ...skin, install }
    }),
    ...(Object.keys(npmSources).length > 0 ? { npmSources } : {}),
    ...(heatSources !== undefined && Object.keys(heatSources).length > 0 ? { heat: heatSources } : {}),
  }
  // Compare the actual prior wire format. Migrating an inline npm catalog must
  // invalidate caches, and adding/removing/changing npm metadata must do so too.
  const previousPayload = previous && {
    schemaVersion: previous.schemaVersion,
    skins: previous.skins,
    ...(previous.npmSources !== undefined ? { npmSources: previous.npmSources } : {}),
    ...(previous.heat !== undefined ? { heat: previous.heat } : {}),
  }
  if (typeof previous?.generatedAt === 'string' && canonicalJson(previousPayload) === canonicalJson(payload)) {
    generatedAt = previous.generatedAt
  }
  return {
    schemaVersion: payload.schemaVersion,
    generatedAt,
    skins: payload.skins,
    ...(payload.npmSources ? { npmSources: payload.npmSources } : {}),
    ...(payload.heat ? { heat: payload.heat } : {}),
  }
}
