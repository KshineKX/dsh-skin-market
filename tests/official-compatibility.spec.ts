import { describe, expect, it } from 'vitest'
import { officialCompatibilityOverride } from '../src/official-failure.ts'
import type { CommandResult } from '../src/commands.ts'

const target = { name: '@fixture/skin', version: '1.3.0', runtimeVersion: '0.2.0-rc.2', peers: { runtime: '^0.1.0-rc.5' } }
const result = (overrides: Record<string, unknown> = {}): CommandResult => ({
  exitCode: 1, stdout: '', stderr: '', timedOut: false,
  management: { application: 'failed', error: { code: 'incompatible-version', incompatible: [target] }, ...overrides },
})

describe('structured exact compatibility refusal', () => {
  it('uses structured Host data and accepts duplicate reports of the same target', () => {
    expect(officialCompatibilityOverride(result({ packageResult: { incompatible: [{ ...target }] } }))).toEqual({
      packageName: target.name, version: target.version, hostVersion: target.runtimeVersion,
    })
    expect(officialCompatibilityOverride(result({ error: { code: 'incompatible-version' }, packageResult: { incompatible: [target] } }))).toBeDefined()
  })

  it.each([
    { application: 'unknown', indeterminate: true }, { application: 'cancelled' }, { application: 'applied' }, { application: 'failed', reportedApplication: 'future-state' },
    { error: { code: 'operation-error', incompatible: [target] } },
    { error: { code: 'incompatible-version', message: `Plugin ${target.name}@${target.version} is incompatible` } },
    { packageResult: { incompatible: [{ ...target, name: 'another-plugin' }] } },
    ...['name', 'version', 'runtimeVersion'].flatMap(key => [undefined, '', '*', '^1.0.0', 'https://fixture.test/plugin', 1].map(value => ({ error: { code: 'incompatible-version', incompatible: [{ ...target, [key]: value }] } }))),
  ])('refuses missing, ambiguous, nonexact or unconfirmed targets (%j)', overrides => {
    expect(officialCompatibilityOverride(result(overrides))).toBeUndefined()
  })
})
