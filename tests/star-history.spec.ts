import { describe, expect, it } from 'vitest'
import { dayNumber } from '../scripts/heat.mjs'
import { earliestObservedDay, latestRepositorySnapshots, mergeStarSamples, parseStarHistoryLog } from '../scripts/star-history.mjs'

const today = dayNumber('2026-10-25T00:00:00Z')
const ago = (days: number) => today - days
const at = (day: number, hour: number) => day * 86_400_000 + hour * 3_600_000

describe('star history collection helpers', () => {
  it('merges monorepo backfill entries and picks the latest real observation within a day', () => {
    const prior = [[ago(1), 10, at(ago(1), 8)]]
    const next = [[ago(1), 12, at(ago(1), 19)], [ago(1), 11, at(ago(1), 12)]]
    expect(mergeStarSamples(prior, next, today, 730)).toEqual([[ago(1), 12, at(ago(1), 19)]])
  })

  it('keeps the full repo history across skin files and preserves the oldest skin age', () => {
    const shared = mergeStarSamples([], [[ago(5), 7, at(ago(5), 18)]], today, 730)
    const combined = mergeStarSamples(shared, [[ago(2), 9, at(ago(2), 18)]], today, 730)
    expect(combined.map(([day, stars]) => [day, stars])).toEqual([[ago(5), 7], [ago(2), 9]])
    expect(earliestObservedDay(ago(2), ago(5))).toBe(ago(5))
    expect(earliestObservedDay(ago(5), ago(2))).toBe(ago(5))
  })

  it('parses history by actual commit time and drops future or out-of-retention dates', () => {
    const log = [
      'C' + Math.floor(at(ago(1), 19) / 1000) + 'C', '+starsSnapshot: 12',
      'C' + Math.floor(at(ago(1), 8) / 1000) + 'C', '+starsSnapshot: 10',
      'C' + Math.floor(at(today + 1, 4) / 1000) + 'C', '+starsSnapshot: 999',
    ].join('\n')
    expect(parseStarHistoryLog(log, today, 730)).toEqual([
      [ago(1), 10, at(ago(1), 8)], [ago(1), 12, at(ago(1), 19)],
    ])
  })

  it('chooses one latest real registry snapshot per repository and keeps each skin id', () => {
    const result = latestRepositorySnapshots([
      { file: 'a.yml', skin: { id: 'a', repo: 'https://github.com/x/y', starsSnapshot: 20, starsUpdatedAt: '2026-10-24T10:00:00Z' } },
      { file: 'b.yml', skin: { id: 'b', repo: 'https://github.com/X/Y/', starsSnapshot: 24, starsUpdatedAt: '2026-10-24T20:00:00Z' } },
      { file: 'c.yml', skin: { id: 'c', repo: 'https://github.com/x/y', starsSnapshot: 30, starsUpdatedAt: 'invalid' } },
    ])
    expect(result.skinIds).toEqual(new Set(['a', 'b', 'c']))
    expect(result.snapshots.get('x/y')).toEqual([ago(1), 24, Date.parse('2026-10-24T20:00:00Z')])
  })
})
