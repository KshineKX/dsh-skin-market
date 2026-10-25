import { describe, expect, it } from 'vitest'
import { buildHeatMap, computeHeat, dayNumber, linearWeight, starGrowthEvents, weightMass } from '../scripts/heat.mjs'

const today = dayNumber('2026-10-22T00:00:00Z')
const daysAgo = days => today - days

describe('continuous skin-age heat', () => {
  it('uses the skin age as the linear decay horizon', () => {
    expect(linearWeight(daysAgo(0), today, 3)).toBe(1)
    expect(linearWeight(daysAgo(1), today, 3)).toBeCloseTo(2 / 3)
    expect(linearWeight(daysAgo(3), today, 3)).toBe(0)
    expect(weightMass(3)).toBeCloseTo(2)
  })

  it('extracts positive Star growth after the skin was first observed', () => {
    expect(starGrowthEvents([[daysAgo(2), 10], [daysAgo(1), 15], [today, 12]], today, daysAgo(2))).toEqual([
      { day: daysAgo(1), amount: 5 },
    ])
  })

  it('ignores future Star samples and keeps the latest same-day observation', () => {
    expect(starGrowthEvents([
      [daysAgo(1), 10, (daysAgo(1) * 86_400_000) + 100],
      [daysAgo(1), 12, (daysAgo(1) * 86_400_000) + 200],
      [today + 1, 500, (today + 1) * 86_400_000],
    ], today, daysAgo(1))).toEqual([])
  })

  it('puts equal Stars from a young skin above an old skin', () => {
    const young = computeHeat({
      samples: [[today, 30]],
      current: 30,
      activity: { daily: {} },
      today,
      firstSeenDay: daysAgo(2),
    })
    const old = computeHeat({
      samples: [[daysAgo(69), 30]],
      current: 30,
      activity: { daily: {} },
      today,
      firstSeenDay: daysAgo(69),
    })
    expect(young.ageDays).toBe(3)
    expect(old.ageDays).toBe(70)
    expect(young.starsPerDay).toBe(10)
    expect(old.starsPerDay).toBeCloseTo(30 / 70, 4)
    expect(young.score).toBeGreaterThan(old.score)
  })

  it('uses a linear decay over the skin lifetime for Stars and activity', () => {
    const heat = computeHeat({
      samples: [[daysAgo(2), 10], [daysAgo(1), 15], [today, 18]],
      current: 18,
      activity: {
        daily: {
          '2026-10-20': { commits: 2, pulls: 1, issues: 0 },
          '2026-10-21': { commits: 4, pulls: 0, issues: 1 },
          '2026-10-22': { commits: 6, pulls: 1, issues: 0 },
        },
      },
      today,
      firstSeenDay: daysAgo(2),
    })
    expect(heat.ageDays).toBe(3)
    expect(heat.starsPerDay).toBe(6)
    expect(heat.starGrowthPerDay).toBeCloseTo((5 * (2 / 3) + 3) / 2, 4)
    expect(heat.commitsPerDay).toBeCloseTo((2 * (1 / 3) + 4 * (2 / 3) + 6) / 2, 4)
    expect(heat.pullsPerDay).toBeCloseTo((1 * (1 / 3) + 1) / 2, 4)
    expect(heat.issuesPerDay).toBeCloseTo(1 * (2 / 3) / 2, 4)
    expect(heat.asOf).toBe('2026-10-22')
  })

  it('does not count activity before the skin was first observed', () => {
    const heat = computeHeat({
      samples: [[daysAgo(1), 2]],
      current: 2,
      activity: { daily: { '2026-10-19': { commits: 100, pulls: 100, issues: 100 }, '2026-10-22': { commits: 1, pulls: 1, issues: 1 } } },
      today,
      firstSeenDay: daysAgo(1),
    })
    expect(heat.commitsPerDay).toBeCloseTo(2 / 3, 4)
    expect(heat.pullsPerDay).toBeCloseTo(2 / 3, 4)
    expect(heat.issuesPerDay).toBeCloseTo(2 / 3, 4)
  })

  it('ignores malformed and future activity buckets', () => {
    const heat = computeHeat({
      samples: [[today, 0]], current: 0,
      activity: { daily: { 'not-a-date': { commits: 100 }, '2026-10-23': { commits: 100 }, '2026-10-22': { commits: 2 } } },
      today, firstSeenDay: today,
    })
    expect(heat.commitsPerDay).toBe(2)
  })

  it('keys each skin independently while sharing repository activity', () => {
    const skins = [
      { id: 'a.theme', repo: 'https://github.com/Owner/Repo', starsSnapshot: 20 },
      { id: 'b.theme', repo: 'https://github.com/owner/repo/', starsSnapshot: 20 },
      { id: 'quiet.theme', repo: 'https://github.com/elsewhere/quiet', starsSnapshot: 5 },
    ]
    const history = {
      repos: { 'owner/repo': [[daysAgo(2), 10], [today, 20]] },
      skins: { 'a.theme': daysAgo(2), 'b.theme': daysAgo(69) },
    }
    const activity = {
      repos: { 'owner/repo': { daily: { '2026-10-22': { commits: 2, pulls: 1, issues: 0 } } } },
    }
    const heat = buildHeatMap({ skins, history, activity, today })
    expect(Object.keys(heat).sort()).toEqual(['a.theme', 'b.theme'])
    expect(heat['a.theme'].ageDays).toBe(3)
    expect(heat['b.theme'].ageDays).toBe(70)
    expect(heat['a.theme'].score).toBeGreaterThan(heat['b.theme'].score)
  })

  it('omits skins without either history or activity', () => {
    const heat = buildHeatMap({
      skins: [{ id: 'x', repo: 'https://github.com/x/y', starsSnapshot: 1 }],
      history: { repos: {}, skins: {} },
      activity: { repos: {} },
      today,
    })
    expect(heat).toEqual({})
  })
})
