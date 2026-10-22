// Record daily GitHub star samples for the public market.
//
// `data/catalog.json` carries a single star snapshot per skin, so the market
// cannot tell a 300-star repository that gained nothing from one that grew
// quickly. This script keeps the daily repository series and each skin's first
// market-observed day in `data/star-history.json`. Retention is storage only;
// scoring uses the skin's own age.
//
// Usage:
//   node scripts/record-stars.mjs              # append today's snapshot
//   node scripts/record-stars.mjs --backfill   # merge git history once
//
// The catalog builder reads the file; clients never see it directly.
import { execFile } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import { DAY_MS, dayNumber, repoSlug } from './heat.mjs'

const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const registryDir = join(root, 'registry/skins')
const historyPath = join(root, 'data/star-history.json')
const HISTORY_DAYS = 730 // storage retention only; scoring uses each skin's age
const backfill = process.argv.includes('--backfill')
const today = dayNumber(new Date())

async function readHistory() {
  try {
    const parsed = JSON.parse(await readFile(historyPath, 'utf8'))
    if (parsed?.schemaVersion !== 1 && parsed?.schemaVersion !== 2 || typeof parsed.repos !== 'object' || parsed.repos === null) throw new Error('unsupported star history')
    return { ...parsed, skins: parsed.skins ?? {} }
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 2, repos: {}, skins: {} }
    throw error
  }
}

async function currentSnapshots() {
  const files = (await readdir(registryDir)).filter(file => file.endsWith('.yml')).sort()
  const snapshots = new Map()
  const skinIds = new Set()
  for (const file of files) {
    const skin = parse(await readFile(join(registryDir, file), 'utf8'))
    const slug = typeof skin.repo === 'string' ? repoSlug(skin.repo) : ''
    if (slug === '' || !Number.isInteger(skin.starsSnapshot)) continue
    skinIds.add(skin.id)
    // A monorepo can publish several skins; the repository-level star count is
    // the same for all of them.
    snapshots.set(slug, skin.starsSnapshot)
  }
  return { snapshots, skinIds }
}

/** @returns {Array<[number, number]>} ascending [day, stars] pairs */
function mergeSamples(target, incoming) {
  const byDay = new Map(target.map(([day, stars]) => [day, stars]))
  for (const [day, stars] of incoming) {
    // Later samples win: the caller feeds changes in chronological order.
    byDay.set(day, stars)
  }
  return [...byDay.entries()]
    .filter(([day]) => day >= today - HISTORY_DAYS && day <= today)
    .sort((left, right) => left[0] - right[0])
}

async function gitBackfill() {
  const files = (await readdir(registryDir)).filter(file => file.endsWith('.yml')).sort()
  const history = new Map()
  const skinDays = new Map()
  for (const file of files) {
    const skin = parse(await readFile(join(registryDir, file), 'utf8'))
    const slug = typeof skin.repo === 'string' ? repoSlug(skin.repo) : ''
    if (slug === '') continue
    let log = ''
    try {
      log = (await run('git', ['-C', root, 'log', '--format=C%atC', '-p', '--', `registry/skins/${file}`], { maxBuffer: 32 * 1024 * 1024 })).stdout
    } catch {
      continue
    }
    // git prints newest first; replay oldest first so later commits win.
    const commits = []
    let stamp
    for (const line of log.split('\n')) {
      const head = /^C(\d+)C$/.exec(line)
      if (head !== null) {
        stamp = Number(head[1])
        continue
      }
      const added = /^\+starsSnapshot:\s*(\d+)/.exec(line)
      if (added !== null && stamp !== undefined) commits.push([stamp, Number(added[1])])
    }
    if (commits.length === 0) continue
    const ordered = commits.reverse()
    history.set(slug, ordered.map(([seconds, stars]) => [dayNumber(seconds * 1000), stars]))
    skinDays.set(skin.id, dayNumber(ordered[0][0] * 1000))
  }
  return { history, skinDays }
}

const history = await readHistory()
const repos = history.repos
const skins = history.skins
const canonical = value => JSON.stringify(Object.keys(value ?? {}).sort().map(key => [key, value[key]]))
const baseline = `${canonical(repos)}|${canonical(skins)}`
const recordedAt = history.generatedAt

if (backfill) {
  const seeded = await gitBackfill()
  for (const [slug, samples] of seeded.history) {
    repos[slug] = mergeSamples(repos[slug] ?? [], samples)
  }
  for (const [skinId, firstSeenDay] of seeded.skinDays) skins[skinId] = firstSeenDay
  console.log(`backfilled ${seeded.history.size} repositories from git history`)
}

const current = await currentSnapshots()
for (const skinId of current.skinIds) {
  // A new registry entry gets a market-observed age on its first daily sample.
  if (!Number.isInteger(skins[skinId])) skins[skinId] = today
}
for (const [slug, stars] of current.snapshots) {
  // Re-running on the same day replaces today's value instead of appending.
  repos[slug] = mergeSamples(repos[slug] ?? [], [[today, stars]])
}

for (const slug of Object.keys(repos)) {
  if (repos[slug].length === 0) delete repos[slug]
}

const repoLines = Object.keys(repos).sort().map(slug => `    ${JSON.stringify(slug)}: ${JSON.stringify(repos[slug])}`)
const skinLines = Object.keys(skins).sort().map(id => `    ${JSON.stringify(id)}: ${skins[id]}`)
const unchanged = baseline === `${canonical(repos)}|${canonical(skins)}`
const generatedAt = unchanged && typeof recordedAt === 'string' ? recordedAt : new Date(today * DAY_MS).toISOString()
const contents = `{\n  "schemaVersion": 2,\n  "generatedAt": ${JSON.stringify(generatedAt)},\n  "retentionDays": ${HISTORY_DAYS},\n  "repos": {\n${repoLines.join(',\n')}\n  },\n  "skins": {\n${skinLines.join(',\n')}\n  }\n}\n`
await writeFile(historyPath, contents)
console.log(`recorded ${current.snapshots.size} repositories (${Object.keys(repos).length} tracked) and ${current.skinIds.size} skin ages in data/star-history.json`)
