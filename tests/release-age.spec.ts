import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { allowReleaseAgeVersion, parseReleaseAgeTarget, readMinimumReleaseAgeMs, ReleaseAgeConfigurationError, repairReleaseAgeExcludes } from '../src/release-age.ts'
import { officialOperationFailure } from '../src/official-failure.ts'
import type { CommandResult } from '../src/commands.ts'

const concurrent = vi.hoisted(() => ({ file: '', value: '' }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args)
      if (concurrent.file !== '' && String(args[0]).endsWith('.tmp')) {
        actual.writeFileSync(concurrent.file, concurrent.value)
        concurrent.file = ''
      }
      return descriptor
    },
  }
})

const directories: string[] = []
function fixture(source?: string): { directory: string; file: string } {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-release-age-'))
  directories.push(directory)
  const file = join(directory, 'pnpm-workspace.yaml')
  if (source !== undefined) writeFileSync(file, source)
  return { directory, file }
}

afterEach(() => {
  concurrent.file = ''
  concurrent.value = ''
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('minimum release-age policy reading', () => {
  it('reads the Desktop workspace value in minutes', () => {
    const { directory } = fixture('minimumReleaseAge: 90 # fresh-release window\n')
    expect(readMinimumReleaseAgeMs(directory)).toBe(90 * 60 * 1000)
  })

  it('falls back to the npmrc spelling', () => {
    const { directory } = fixture()
    writeFileSync(join(directory, '.npmrc'), 'minimum-release-age=45\n')
    expect(readMinimumReleaseAgeMs(directory)).toBe(45 * 60 * 1000)
  })

  it('uses pnpm default when neither Desktop config spelling is present', () => {
    const { directory } = fixture()
    expect(readMinimumReleaseAgeMs(directory)).toBe(24 * 60 * 60 * 1000)
  })

  it('fails closed when a configured value is malformed', () => {
    const { directory } = fixture('minimumReleaseAge: soon\n')
    expect(readMinimumReleaseAgeMs(directory)).toBeNull()
  })
})

describe('precise release-age authorizations', () => {
  it.each([
    ['dsh-skin-market', '0.1.60'],
    ['@example/skin', '0.2.1-alpha.3'],
    ['skin', '1.0.0-alpha.0.hello-4+build.0123'],
  ])('accepts %s@%s', (packageName, version) => {
    expect(parseReleaseAgeTarget(packageName, version)).toEqual({ packageName, version })
  })

  it.each([
    ['skin', '^1.0.0'], ['skin', '1.0'], ['skin', 'v1.0.0'], ['skin', '1.0.0 || 2.0.0'],
    ['skin', '01.0.0'], ['skin', '1.0.0-01'], ['skin', '1.0.0-'], ['skin', '1.0.0 '],
    ['skin', '9007199254740992.0.0'], ['skin*', '1.0.0'], ['@example/*', '1.0.0'],
    ['@example/skin@else', '1.0.0'], ['../skin', '1.0.0'], ['skin\nother', '1.0.0'],
  ])('rejects non-exact target %s@%s', (packageName, version) => {
    expect(parseReleaseAgeTarget(packageName, version)).toBeUndefined()
  })

  it('merges only same-package precise versions and preserves unrelated bytes and comments', () => {
    const { directory, file } = fixture('# workspace\npackages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-skin-market@0.1.59 # original\n  # approved during update\n  - dsh-skin-market@0.1.60 # keep this reason\n  - other-package\n  - other@2.0.0\nsettings:\n  existing: "untouched" # tail\n')
    expect(repairReleaseAgeExcludes(directory)).toEqual(['dsh-skin-market'])
    expect(readFileSync(file, 'utf8')).toBe('# workspace\npackages:\n  - .\nminimumReleaseAgeExclude:\n  - \'dsh-skin-market@0.1.59 || 0.1.60\' # original\n  # approved during update\n   # keep this reason\n  - other-package\n  - other@2.0.0\nsettings:\n  existing: "untouched" # tail\n')
    const repaired = readFileSync(file, 'utf8')
    expect(repairReleaseAgeExcludes(directory)).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(repaired)
  })

  it('reads pnpm folded quoted unions without truncating versions or comments', () => {
    const { directory, file } = fixture('minimumReleaseAgeExclude:\n  - "@example/skin@1.0.0 ||\n    1.1.0" # first\n  # middle\n  - \'@example/skin@1.2.0 ||\n    1.3.0\' # latest\nother: [a, b]\n')
    expect(repairReleaseAgeExcludes(directory)).toEqual(['@example/skin'])
    const source = readFileSync(file, 'utf8')
    expect(parse(source)).toEqual({ minimumReleaseAgeExclude: ['@example/skin@1.0.0 || 1.1.0 || 1.2.0 || 1.3.0'], other: ['a', 'b'] })
    expect(source).toContain('# first\n  # middle\n   # latest\nother: [a, b]\n')
    expect(repairReleaseAgeExcludes(directory)).toEqual([])
  })

  it('supports YAML block-folded unions without losing header comments', () => {
    const { directory, file } = fixture('minimumReleaseAgeExclude:\n  - >- # first reason\n    skin@1.0.0 ||\n    1.1.0\n  - >- # second reason\n    skin@1.2.0\nother: true\n')
    expect(repairReleaseAgeExcludes(directory)).toEqual(['skin'])
    const source = readFileSync(file, 'utf8')
    expect(parse(source)).toEqual({ minimumReleaseAgeExclude: ['skin@1.0.0 || 1.1.0 || 1.2.0'], other: true })
    expect(source).toContain('# first reason\n   # second reason\nother: true\n')
  })

  it('keeps CRLF and merges repeated additions exactly once', () => {
    const { directory, file } = fixture('packages:\r\n  - .\r\nminimumReleaseAgeExclude:\r\n  - skin@1.0.0\r\n  - skin@1.0.0\r\n  - skin@1.1.0\r\nother: yes\r\n')
    expect(repairReleaseAgeExcludes(directory)).toEqual(['skin'])
    expect(readFileSync(file, 'utf8')).toBe("packages:\r\n  - .\r\nminimumReleaseAgeExclude:\r\n  - 'skin@1.0.0 || 1.1.0'\r\nother: yes\r\n")
    writeFileSync(file, readFileSync(file, 'utf8').replace('other: yes', '  - skin@1.2.0\r\nother: yes'))
    expect(repairReleaseAgeExcludes(directory)).toEqual(['skin'])
    expect(parse(readFileSync(file, 'utf8')).minimumReleaseAgeExclude).toEqual(['skin@1.0.0 || 1.1.0 || 1.2.0'])
  })

  it.each([
    'minimumReleaseAgeExclude:\n  - skin@^1.0.0\n  - skin@2.0.0\n',
    'minimumReleaseAgeExclude:\n  - "skin*@1.0.0"\n  - skin@2.0.0\n',
    'minimumReleaseAgeExclude:\n  - "skin@1.0.0 ||"\n  - skin@2.0.0\n',
    'minimumReleaseAgeExclude:\n  - skin@1.0.0\nminimumReleaseAgeExclude:\n  - skin@2.0.0\n',
    'minimumReleaseAgeExclude:\n  - skin@1.0.0\n  - skin@2.0.0\nother: 1\nother: 2\n',
    'minimumReleaseAgeExclude: &rules\n  - skin@1.0.0\n  - skin@2.0.0\nother: *rules\n',
    'other: &else [a]\nminimumReleaseAgeExclude:\n  - skin@1.0.0\n  - skin@2.0.0\n',
    'minimumReleaseAgeExclude:\n  - skin@1.0.0\n  - "skin@2.0.0\n',
    'minimumReleaseAgeExclude: [skin@1.0.0, skin@2.0.0]\n',
    'minimumReleaseAgeExclude:\n  - skin@1.0.0\n  - skin@2.0.0\n---\nother: true\n',
  ])('leaves ambiguous configuration intact: %s', source => {
    const { directory, file } = fixture(source)
    expect(repairReleaseAgeExcludes(directory)).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(source)
    expect(() => allowReleaseAgeVersion(directory, { packageName: 'skin', version: '3.0.0' })).toThrow(ReleaseAgeConfigurationError)
    expect(readFileSync(file, 'utf8')).toBe(source)
  })

  it('never turns precise rules into a bare package exemption', () => {
    const { directory, file } = fixture('minimumReleaseAgeExclude:\n  - skin@1.0.0\n  - skin\n  - other@2.0.0\n  - other@3.0.0\n')
    expect(repairReleaseAgeExcludes(directory)).toEqual(['other'])
    expect(parse(readFileSync(file, 'utf8')).minimumReleaseAgeExclude).toEqual(['skin@1.0.0', 'skin', 'other@2.0.0 || 3.0.0'])
    expect(() => allowReleaseAgeVersion(directory, { packageName: 'skin', version: '4.0.0' })).toThrow(ReleaseAgeConfigurationError)
  })

  it('adds exactly the approved version to the existing union and merges duplicates', () => {
    const { directory, file } = fixture('packages:\n  - .\nminimumReleaseAgeExclude:\n  - skin@1.0.0\n  - skin@1.1.0\n  - other@2.0.0\nother: unchanged\n')
    allowReleaseAgeVersion(directory, { packageName: 'skin', version: '1.2.0' })
    expect(parse(readFileSync(file, 'utf8'))).toEqual({ packages: ['.'], minimumReleaseAgeExclude: ['skin@1.0.0 || 1.1.0 || 1.2.0', 'other@2.0.0'], other: 'unchanged' })
    const source = readFileSync(file, 'utf8')
    allowReleaseAgeVersion(directory, { packageName: 'skin', version: '1.2.0' })
    expect(readFileSync(file, 'utf8')).toBe(source)
  })

  it('appends a new precise package rule without changing later settings', () => {
    const { directory, file } = fixture('minimumReleaseAgeExclude:\n    - other@2.0.0 # keep\n# next setting\nother: [a,b]\n')
    allowReleaseAgeVersion(directory, { packageName: '@example/skin', version: '1.2.0' })
    expect(readFileSync(file, 'utf8')).toBe("minimumReleaseAgeExclude:\n    - other@2.0.0 # keep\n    - '@example/skin@1.2.0'\n# next setting\nother: [a,b]\n")
  })

  it('adds the setting to an existing workspace without overriding its contents', () => {
    const { directory, file } = fixture('packages:\r\n  - .\r\n# preserve this end')
    allowReleaseAgeVersion(directory, { packageName: 'skin', version: '1.2.0' })
    expect(readFileSync(file, 'utf8')).toBe("packages:\r\n  - .\r\n# preserve this end\r\nminimumReleaseAgeExclude:\r\n  - 'skin@1.2.0'\r\n")
  })

  it('fills an existing empty array and preserves its comment', () => {
    const { directory, file } = fixture('minimumReleaseAgeExclude: [] # keep\nother: unchanged\n')
    allowReleaseAgeVersion(directory, { packageName: 'skin', version: '1.2.0' })
    expect(readFileSync(file, 'utf8')).toBe("minimumReleaseAgeExclude: \n  - 'skin@1.2.0' # keep\nother: unchanged\n")
    allowReleaseAgeVersion(directory, { packageName: 'skin', version: '1.3.0' })
    allowReleaseAgeVersion(directory, { packageName: 'other-skin', version: '2.0.0' })
    expect(parse(readFileSync(file, 'utf8')).minimumReleaseAgeExclude).toEqual(['skin@1.2.0 || 1.3.0', 'other-skin@2.0.0'])
  })

  it('leaves an existing bare exemption untouched when it already allows the target', () => {
    const source = 'minimumReleaseAgeExclude:\n  - skin # already permits all versions\n'
    const { directory, file } = fixture(source)
    allowReleaseAgeVersion(directory, { packageName: 'skin', version: '1.2.0' })
    expect(readFileSync(file, 'utf8')).toBe(source)
  })

  it('does not create a workspace at a missing or mistaken profile path', () => {
    const { directory, file } = fixture()
    expect(repairReleaseAgeExcludes(directory)).toEqual([])
    expect(() => allowReleaseAgeVersion(directory, { packageName: 'skin', version: '1.2.0' })).toThrowError(expect.objectContaining({ code: 'unavailable' }))
    expect(fs.existsSync(file)).toBe(false)
  })

  it('refuses symlinked workspaces rather than replacing or following them', () => {
    const { directory, file } = fixture()
    const original = join(directory, 'original.yml')
    const source = 'minimumReleaseAgeExclude:\n  - skin@1.0.0\n  - skin@1.1.0\n'
    writeFileSync(original, source)
    symlinkSync(original, file)
    expect(repairReleaseAgeExcludes(directory)).toEqual([])
    expect(() => allowReleaseAgeVersion(directory, { packageName: 'skin', version: '1.2.0' })).toThrow(ReleaseAgeConfigurationError)
    expect(readFileSync(original, 'utf8')).toBe(source)
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true)
  })

  it.each(['repair', 'allow'])('refuses a concurrent edit during %s and cleans up its temporary file', operation => {
    const { directory, file } = fixture('minimumReleaseAgeExclude:\n  - skin@1.0.0\n  - skin@1.1.0\n')
    concurrent.file = file
    concurrent.value = '# external edit\nminimumReleaseAgeExclude:\n  - skin@1.0.0\n  - skin@1.1.0\nother: keep\n'
    const run = () => operation === 'repair' ? repairReleaseAgeExcludes(directory) : allowReleaseAgeVersion(directory, { packageName: 'skin', version: '1.2.0' })
    expect(run).toThrowError(expect.objectContaining({ code: 'changed' }))
    expect(readFileSync(file, 'utf8')).toBe(concurrent.value)
    expect(fs.readdirSync(directory)).toEqual(['pnpm-workspace.yaml'])
  })

  it('rejects untrusted approval targets without changing the workspace or exposing its contents', () => {
    const source = 'privateSetting: do-not-include-in-error\n'
    const { directory, file } = fixture(source)
    expect(() => allowReleaseAgeVersion(directory, { packageName: 'skin', version: '*' })).toThrowError(expect.objectContaining({ code: 'invalid-target' }))
    expect(readFileSync(file, 'utf8')).toBe(source)
  })
})

describe('official release-age target extraction', () => {
  function failure(diagnostic: string): CommandResult {
    return { exitCode: 1, stdout: '', stderr: '', timedOut: false, management: { application: 'failed', packageResult: { kind: 'network', output: diagnostic } } }
  }

  it('extracts a strict precise package from the terminal policy violation without approving it', () => {
    const result = officialOperationFailure(failure('WARN network reset\nERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION 1 lockfile entries failed verification:\n @example/skin@0.2.1-alpha.3 was published at 2026-10-15T07:47:31.608Z, within the minimumReleaseAge cutoff (2026-10-14T08:04:41.370Z)'))
    expect(result).toMatchObject({ kind: 'release-age', packageName: '@example/skin', releaseAgeTarget: { packageName: '@example/skin', version: '0.2.1-alpha.3' } })
    expect(result?.action).toBeUndefined()
  })

  it('does not offer approval for a range or a generic release-age hint', () => {
    expect(officialOperationFailure(failure('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION\nskin@^1.0.0 was published at 2026-10-15T07:47:31.608Z, within minimumReleaseAge cutoff (2026-10-14T08:04:41.370Z)'))?.releaseAgeTarget).toBeUndefined()
    expect(officialOperationFailure(failure('published within the minimumReleaseAge cutoff'))?.releaseAgeTarget).toBeUndefined()
  })

  it('reads the same exact target when the Host flattens the diagnostic onto one line', () => {
    expect(officialOperationFailure(failure('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION 1 lockfile entries failed verification: skin@1.2.0 was published at 2026-10-15T07:47:31.608Z, within minimumReleaseAge cutoff (2026-10-14T08:04:41.370Z)'))?.releaseAgeTarget).toEqual({ packageName: 'skin', version: '1.2.0' })
  })

  it('does not reinterpret the suffix of an invalid name as a different package', () => {
    expect(officialOperationFailure(failure('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION\nbad*skin@1.2.0 was published at 2026-10-15T07:47:31.608Z, within minimumReleaseAge cutoff (2026-10-14T08:04:41.370Z)'))?.releaseAgeTarget).toBeUndefined()
  })
})
