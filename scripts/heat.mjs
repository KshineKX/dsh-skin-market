/**
 * Continuous momentum ("热度") scoring for the public catalog.
 *
 * Each skin is normalized by its own observed age. Daily Star growth and
 * repository activity are linearly decayed across that skin's lifetime:
 *
 *   weight(eventAge) = max(0, 1 - eventAge / skinAge)
 *
 * There is no fixed 7-day or 30-day window here. The denominator is the
 * skin's own age, with the first-seen day supplied by the registry history.
 *
 * Everything here is pure: no clock, no filesystem. `today` is a day number
 * (days since the Unix epoch) supplied by the caller.
 */
export const DAY_MS = 86_400_000
export const HEAT_WEIGHTS = {
  stars: 2.4,
  starGrowth: 3,
  commits: 0.6,
  pulls: 0.5,
  issues: 0.3,
}

export function dayNumber(value) {
  const time = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(`invalid date value for a day number: ${String(value)}`)
  return Math.floor(time / DAY_MS)
}

export function repoSlug(repo) {
  return repo.replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').toLowerCase()
}

function nonNegative(value) {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

function finiteNonNegative(value) {
  if (!Number.isFinite(value) || value <= 0) return 0
  return value
}

function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function validSamples(samples, firstSeenDay, today) {
  if (!Array.isArray(samples)) return []
  return samples
    .filter(sample => Array.isArray(sample) && sample.length >= 2 && Number.isInteger(sample[0]) && Number.isInteger(sample[1]) && sample[1] >= 0 && sample[0] >= firstSeenDay && sample[0] <= today)
    .map(([day, stars, observedAt], index) => ({ day, stars, observedAt: Number.isFinite(observedAt) ? observedAt : day * DAY_MS, index }))
    .sort((left, right) => left.day - right.day || left.observedAt - right.observedAt || left.index - right.index)
    .filter((sample, index, sorted) => index === sorted.length - 1 || sample.day !== sorted[index + 1].day)
    .map(({ day, stars }) => [day, stars])
}

export function linearWeight(eventDay, today, skinAgeDays) {
  const age = Math.max(0, today - eventDay)
  return Math.max(0, 1 - age / Math.max(1, skinAgeDays))
}

/** Sum the linear weights over the skin's observed lifetime. */
export function weightMass(skinAgeDays) {
  const days = Math.max(1, Math.ceil(finiteNonNegative(skinAgeDays)))
  let total = 0
  for (let age = 0; age < days; age += 1) total += Math.max(0, 1 - age / days)
  return Math.max(1, total)
}

function weightedPerDay(weightedCount, skinAgeDays) {
  return finiteNonNegative(weightedCount) / weightMass(skinAgeDays)
}

/** Turn Star snapshots into positive growth events after the skin was first seen. */
export function starGrowthEvents(samples, today, firstSeenDay) {
  const valid = validSamples(samples, firstSeenDay, today)
  if (valid.length === 0) return []
  const events = []
  let previous = valid[0]
  for (const sample of valid.slice(1)) {
    const delta = Math.max(0, sample[1] - previous[1])
    if (delta > 0) events.push({ day: sample[0], amount: delta })
    previous = sample
  }
  return events
}

function activityStats(activity, today, firstSeenDay, skinAgeDays) {
  const daily = activity?.daily
  if (daily !== undefined && typeof daily === 'object' && daily !== null) {
    const weighted = { commits: 0, pulls: 0, issues: 0 }
    for (const [date, counts] of Object.entries(daily)) {
      let day
      try {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
        day = dayNumber(`${date}T00:00:00Z`)
        if (new Date(day * DAY_MS).toISOString().slice(0, 10) !== date) continue
      } catch { continue }
      if (day < firstSeenDay || day > today) continue
      const weight = linearWeight(day, today, skinAgeDays)
      weighted.commits += nonNegative(counts?.commits) * weight
      weighted.pulls += nonNegative(counts?.pulls) * weight
      weighted.issues += nonNegative(counts?.issues) * weight
    }
    return {
      commits: weightedPerDay(weighted.commits, skinAgeDays),
      pulls: weightedPerDay(weighted.pulls, skinAgeDays),
      issues: weightedPerDay(weighted.issues, skinAgeDays),
    }
  }
  // Transitional fallback for a catalog built with the former snapshot format.
  // The nightly collector writes daily buckets; this path is only for old data.
  const denominator = Math.max(1, skinAgeDays)
  return {
    commits: nonNegative(activity?.commits30) / denominator,
    pulls: nonNegative(activity?.pulls30) / denominator,
    issues: nonNegative(activity?.issues30) / denominator,
  }
}

/**
 * @returns {{ageDays:number,starsPerDay:number,starGrowthPerDay:number,commitsPerDay:number,pullsPerDay:number,issuesPerDay:number,score:number,asOf:string}}
 */
export function computeHeat({ samples, current, activity, today, firstSeenDay }) {
  const ageDays = Math.max(1, today - firstSeenDay + 1)
  const stars = nonNegative(current)
  const growthEvents = starGrowthEvents(samples, today, firstSeenDay)
  const weightedGrowth = growthEvents.reduce((total, event) => total + finiteNonNegative(event.amount) * linearWeight(event.day, today, ageDays), 0)
  const starGrowthPerDay = weightedPerDay(weightedGrowth, ageDays)
  const activityPerDay = activityStats(activity, today, firstSeenDay, ageDays)
  const starsPerDay = stars / ageDays
  const score = HEAT_WEIGHTS.stars * Math.log1p(starsPerDay)
    + HEAT_WEIGHTS.starGrowth * Math.log1p(starGrowthPerDay)
    + HEAT_WEIGHTS.commits * Math.log1p(activityPerDay.commits)
    + HEAT_WEIGHTS.pulls * Math.log1p(activityPerDay.pulls)
    + HEAT_WEIGHTS.issues * Math.log1p(activityPerDay.issues)
  return {
    ageDays,
    starsPerDay: round(starsPerDay, 4),
    starGrowthPerDay: round(starGrowthPerDay, 4),
    commitsPerDay: round(activityPerDay.commits, 4),
    pullsPerDay: round(activityPerDay.pulls, 4),
    issuesPerDay: round(activityPerDay.issues, 4),
    score: round(score),
    asOf: new Date(today * DAY_MS).toISOString().slice(0, 10),
  }
}

/** Build the envelope map keyed by skin id. */
export function buildHeatMap({ skins, history, activity, today }) {
  const heat = {}
  for (const skin of skins) {
    const slug = repoSlug(String(skin.repo))
    const samples = history?.repos?.[slug] ?? []
    const signal = activity?.repos?.[slug]
    const observedSamples = Array.isArray(samples) ? samples.filter(sample => Array.isArray(sample) && Number.isInteger(sample[0]) && sample[0] <= today).sort((a, b) => a[0] - b[0]) : []
    let activityCreatedDay = today
    try { if (signal?.createdAt !== undefined) activityCreatedDay = Math.min(today, dayNumber(signal.createdAt)) } catch { /* Invalid activity metadata cannot move skin age into the future. */ }
    const fallbackDay = observedSamples[0]?.[0] ?? activityCreatedDay
    const recordedFirstSeen = history?.skins?.[skin.id]
    const firstSeenDay = Number.isInteger(recordedFirstSeen) ? Math.min(today, recordedFirstSeen) : fallbackDay
    if (samples.length === 0 && signal === undefined) continue
    heat[skin.id] = computeHeat({
      samples,
      current: Number(skin.starsSnapshot) || 0,
      activity: signal,
      today,
      firstSeenDay,
    })
  }
  return heat
}
