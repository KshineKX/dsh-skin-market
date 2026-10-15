import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { compareVersions, createMarketUpdater, MARKET_NPM_METADATA_URL, MARKET_NPM_PACKAGE } from '../src/self-update.ts'
import type { CommandOptions, CommandResult, PluginRunner } from '../src/commands.ts'
import { compareInstalledArtifact, snapshotInstalledArtifact } from '../src/profile.ts'

const REVIEWED_INTEGRITY = 'sha512-market-reviewed'

function managedRunner(runner: PluginRunner, cancel = true): void {
  runner.management = { capabilities: () => ({ cancel: { available: cancel } }) } as NonNullable<PluginRunner['management']>
}

function materialize(profileDir: string, version: string): void {
  const directory = join(profileDir, 'node_modules', MARKET_NPM_PACKAGE)
  mkdirSync(directory, { recursive: true })
  const file = join(profileDir, 'package.json')
  const manifest = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { dependencies: { unrelated: '2.0.0' } }
  manifest.dependencies = { ...manifest.dependencies, [MARKET_NPM_PACKAGE]: version }
  writeFileSync(file, JSON.stringify(manifest))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: MARKET_NPM_PACKAGE, version, main: './host.js', exports: { '.': './host.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }))
  writeFileSync(join(directory, 'host.js'), `export const version = '${version}'`)
  writeFileSync(join(directory, 'client.js'), `export const clientVersion = '${version}'`)
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      ${MARKET_NPM_PACKAGE}:\n        specifier: '${version}'\n        version: '${version}'\npackages:\n  '${MARKET_NPM_PACKAGE}@${version}':\n    resolution:\n      integrity: ${REVIEWED_INTEGRITY}\n`)
}

function installedProfile(version: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'market-artifact-'))
  materialize(directory, version)
  return directory
}

function latest(version: string, includeIntegrity = true): typeof fetch {
  return vi.fn(async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: version }, versions: { [version]: { version, gitHead: 'c'.repeat(40), dist: { tarball: `https://registry.npmjs.org/dsh-skin-market/-/dsh-skin-market-${version}.tgz`, ...(includeIntegrity ? { integrity: REVIEWED_INTEGRITY } : {}) } } } }) })) as unknown as typeof fetch
}

describe('market self update', () => {
  it('compares stable and prerelease semantic versions', () => {
    expect(compareVersions('0.1.16', '0.1.15')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0-rc.6')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.7', '1.0.0-rc.6')).toBeGreaterThan(0)
    expect(compareVersions('0.1.15', '0.1.15')).toBe(0)
  })

  it('only installs when npm has a newer immutable package and hides the update afterwards', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-market-self-update-'))
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    materialize(profileDir, '0.1.15')
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    const previousDshHome = process.env.DSH_HOME
    process.env.DSH_HOME = dshHome

    try {
      const commit = 'a'.repeat(40)
      const fetchLatest = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '0.1.16' },
          versions: {
            '0.1.16': {
              version: '0.1.16',
              gitHead: commit,
              dist: { tarball: 'https://registry.npmjs.org/dsh-skin-market/-/dsh-skin-market-0.1.16.tgz' },
            },
          },
        }),
      })) as unknown as typeof fetch
      const runner = vi.fn(async () => { materialize(profileDir, '0.1.16'); return { exitCode: 0, stdout: '', stderr: '', timedOut: false } })
      const updater = createMarketUpdater('web', runner, { currentVersion: '0.1.15', fetch: fetchLatest, cacheMs: 0 })

      expect(updater.restartRequired).toBe(false)
      await expect(updater.status()).resolves.toEqual({ currentVersion: '0.1.15', loadedVersion: '0.1.15', latestVersion: '0.1.16', updateAvailable: true })
      await expect(updater.update()).resolves.toEqual({ currentVersion: '0.1.16', loadedVersion: '0.1.15', latestVersion: '0.1.16', updateAvailable: false })
      expect(updater.restartRequired).toBe(true)
      expect(fetchLatest).toHaveBeenCalledWith(MARKET_NPM_METADATA_URL, expect.objectContaining({ headers: expect.objectContaining({ accept: 'application/json' }) }))
      expect(runner).toHaveBeenCalledTimes(1)
      expect(runner).toHaveBeenCalledWith('web', ['add', '-w', `${MARKET_NPM_PACKAGE}@0.1.16`, '--reporter=ndjson'], expect.objectContaining({
        signal: expect.any(AbortSignal),
        env: { pnpm_config_fetch_timeout: '600000' },
      }))
      await expect(updater.status()).resolves.toEqual({ currentVersion: '0.1.16', loadedVersion: '0.1.15', latestVersion: '0.1.16', updateAvailable: false })
    } finally {
      if (previousDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousDshHome
    }
  })

  it('recovers a verified pending market version after the updater is remounted in the same Host', async () => {
    const profileDir = installedProfile('0.1.15')
    const runner = vi.fn(async () => {
      materialize(profileDir, '0.1.16')
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, management: { application: 'restart-required' as const } }
    }) as unknown as PluginRunner
    managedRunner(runner)
    const updater = createMarketUpdater('desktop', runner, { currentVersion: '0.1.15', profileDir, fetch: latest('0.1.16') })
    await updater.update()
    expect(updater.restartRequired).toBe(true)

    const remounted = createMarketUpdater('desktop', runner, { currentVersion: '0.1.15', profileDir, fetch: latest('0.1.16') })
    expect(remounted.restartRequired).toBe(true)
    expect(remounted.restartNoticeId).toBe(updater.restartNoticeId)
    await expect(remounted.status()).resolves.toMatchObject({ currentVersion: '0.1.16', loadedVersion: '0.1.15', updateAvailable: false })
    expect(runner).toHaveBeenCalledTimes(1)

    // A new Host loading the installed release has no old update pending.
    const restarted = createMarketUpdater('desktop', runner, { currentVersion: '0.1.16', profileDir, fetch: latest('0.1.16') })
    expect(restarted.restartRequired).toBe(false)
    expect(restarted.restartNoticeId).toBeUndefined()
    await expect(restarted.status()).resolves.toMatchObject({ currentVersion: '0.1.16', loadedVersion: '0.1.16', updateAvailable: false })
  })

  it('detects an official plugin-page update without relying on a self-update operation or cached npm status', async () => {
    const profileDir = installedProfile('0.1.15')
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))
    const fetchLatest = latest('0.1.16')
    const updater = createMarketUpdater('desktop', runner, { currentVersion: '0.1.15', profileDir, fetch: fetchLatest })
    await expect(updater.status()).resolves.toMatchObject({ currentVersion: '0.1.15', loadedVersion: '0.1.15', updateAvailable: true })

    materialize(profileDir, '0.1.16')
    expect(updater.currentOperation()).toBeNull()
    expect(updater.restartRequired).toBe(true)
    await expect(updater.status()).resolves.toMatchObject({ currentVersion: '0.1.16', loadedVersion: '0.1.15', updateAvailable: false })
    expect(fetchLatest).toHaveBeenCalledTimes(1)
    expect(runner).not.toHaveBeenCalled()

    // Restoring the already-loaded release also resolves the version mismatch.
    materialize(profileDir, '0.1.15')
    expect(updater.restartRequired).toBe(false)
  })

  it('does not turn an unreadable or inconsistent external market artifact into a restart instruction', async () => {
    const profileDir = installedProfile('0.1.16')
    rmSync(join(profileDir, 'node_modules', MARKET_NPM_PACKAGE, 'client.js'))
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))
    const updater = createMarketUpdater('desktop', runner, { currentVersion: '0.1.15', profileDir, fetch: latest('0.1.16') })
    expect(updater.restartRequired).toBe(false)
    await expect(updater.status()).resolves.toMatchObject({ currentVersion: '0.1.15', loadedVersion: '0.1.15', updateAvailable: true })

    materialize(profileDir, '0.1.16')
    const lockFile = join(profileDir, 'pnpm-lock.yaml')
    writeFileSync(lockFile, readFileSync(lockFile, 'utf8').replace("specifier: '0.1.16'", "specifier: '^0.1.16'"))
    expect(updater.restartRequired).toBe(false)
  })

  it('does not reinstall the same version', async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))
    const updater = createMarketUpdater('web', runner, {
      currentVersion: '0.1.15',
      fetch: vi.fn(async () => ({
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '0.1.15' },
          versions: {
            '0.1.15': {
              version: '0.1.15',
              gitHead: 'b'.repeat(40),
              dist: { tarball: 'https://registry.npmjs.org/dsh-skin-market/-/dsh-skin-market-0.1.15.tgz' },
            },
          },
        }),
      })) as unknown as typeof fetch,
      cacheMs: 0,
    })

    await expect(updater.update()).resolves.toMatchObject({ updateAvailable: false })
    expect(runner).not.toHaveBeenCalled()
  })

  it('aborts and waits for an in-flight self-update when the route is disposed', async () => {
    let resolveRunner!: (result: CommandResult) => void
    const runner = vi.fn(() => new Promise<CommandResult>(resolve => { resolveRunner = resolve })) as unknown as PluginRunner
    managedRunner(runner)
    const updater = createMarketUpdater('desktop', runner, {
      currentVersion: '0.1.15',
      profileDir: installedProfile('0.1.15'),
      fetch: vi.fn(async () => ({
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '0.1.16' },
          versions: {
            '0.1.16': {
              version: '0.1.16',
              gitHead: 'd'.repeat(40),
              dist: { tarball: 'https://registry.npmjs.org/dsh-skin-market/-/dsh-skin-market-0.1.16.tgz' },
            },
          },
        }),
      })) as unknown as typeof fetch,
      cacheMs: 0,
    })

    const operation = updater.startUpdate()
    await vi.waitFor(() => expect(runner).toHaveBeenCalled())
    const disposing = updater.dispose!()
    expect(operation.phase).toBe('cancelling')
    resolveRunner({ exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: true, management: { application: 'cancelled' } } as CommandResult)
    await disposing
    expect(operation.phase).toBe('cancelled')
  })

  it('retries a self-update once when the new package is inside the release-age cutoff', async () => {
    const commit = 'c'.repeat(40)
    const fetchLatest = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        'dist-tags': { latest: '0.1.17' },
        versions: {
          '0.1.17': {
            version: '0.1.17',
            gitHead: commit,
            dist: { tarball: 'https://registry.npmjs.org/dsh-skin-market/-/dsh-skin-market-0.1.17.tgz' },
          },
        },
      }),
    })) as unknown as typeof fetch
    const attempts: Array<readonly string[]> = []
    const profileDir = installedProfile('0.1.16')
    const runner = vi.fn(async (_profile: string, args: readonly string[], _options?: CommandOptions) => {
      attempts.push(args)
      if (attempts.length > 1) materialize(profileDir, '0.1.17')
      return attempts.length === 1
        ? { exitCode: 1, stdout: '', stderr: 'dsh-skin-market@0.1.17 was published within the minimumReleaseAge cutoff', timedOut: false }
        : { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    })
    const updater = createMarketUpdater('web', runner, { currentVersion: '0.1.16', profileDir, fetch: fetchLatest, cacheMs: 0 })

    await expect(updater.update()).resolves.toMatchObject({ currentVersion: '0.1.17', updateAvailable: false })

    expect(attempts[0]).not.toContain('--config.minimumReleaseAge=0')
    expect(attempts[1]).toContain('--config.minimumReleaseAge=0')
  })

  it('does not announce success when exit zero did not materialize the requested version', async () => {
    const profileDir = installedProfile('0.1.15')
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))
    const updater = createMarketUpdater('web', runner, { currentVersion: '0.1.15', profileDir, fetch: latest('0.1.16') })
    await expect(updater.update()).rejects.toThrow('未物化')
    expect(updater.restartRequired).toBe(false)
    expect((await updater.status()).currentVersion).toBe('0.1.15')
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('restores a mid-swap cancelled Web update once and verifies the frozen artifact', async () => {
    const profileDir = installedProfile('0.1.15')
    const baseline = snapshotInstalledArtifact(profileDir, MARKET_NPM_PACKAGE)
    const manifest = readFileSync(join(profileDir, 'package.json'), 'utf8')
    const lock = readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
    let finish!: (value: CommandResult) => void
    const runner = vi.fn(async (_profile: string, args: readonly string[], _options?: CommandOptions) => {
      if (args[0] === 'install') { materialize(profileDir, '0.1.15'); return { exitCode: 0, stdout: '', stderr: '', timedOut: false } }
      materialize(profileDir, '0.1.16')
      rmSync(join(profileDir, 'node_modules', MARKET_NPM_PACKAGE, 'client.js'))
      return new Promise<CommandResult>(resolve => { finish = resolve })
    })
    const updater = createMarketUpdater('web', runner, { currentVersion: '0.1.15', profileDir, fetch: latest('0.1.16') })
    const operation = updater.startUpdate()
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1))
    updater.cancel(operation.id)
    finish({ exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: true })
    await vi.waitFor(() => expect(operation.phase).toBe('cancelled'))
    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls[1][1][0]).toBe('install')
    expect(runner.mock.calls[1][2]).toMatchObject({ timeoutMs: 60_000 })
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(lock)
    expect(compareInstalledArtifact(profileDir, baseline).ok).toBe(true)
    expect(updater.restartRequired).toBe(false)
  })

  it('reports failed recovery when its command exits zero but a declared entry is still missing', async () => {
    const profileDir = installedProfile('0.1.15')
    const runner = vi.fn(async (_profile: string, args: readonly string[]) => {
      if (args[0] === 'add') rmSync(join(profileDir, 'node_modules', MARKET_NPM_PACKAGE, 'client.js'))
      return { exitCode: args[0] === 'add' ? 1 : 0, stdout: '', stderr: 'failed', timedOut: false }
    })
    const updater = createMarketUpdater('web', runner, { currentVersion: '0.1.15', profileDir, fetch: latest('0.1.16') })
    await expect(updater.update()).rejects.toThrow('构件未能验证恢复')
    expect(runner).toHaveBeenCalledTimes(2)
    expect(updater.restartRequired).toBe(false)
  })

  it.each(['applied', 'overridden', 'failed', 'cancelled', 'unknown'] as const)('preserves an authoritative managed %s result after cancellation', async application => {
    const profileDir = installedProfile('0.1.15')
    let finish!: (value: CommandResult) => void
    const runner = vi.fn(() => new Promise<CommandResult>(resolve => { finish = resolve })) as unknown as PluginRunner
    managedRunner(runner)
    const updater = createMarketUpdater('desktop', runner, { currentVersion: '0.1.15', profileDir, fetch: latest('0.1.16') })
    const operation = updater.startUpdate()
    await vi.waitFor(() => expect(runner).toHaveBeenCalled())
    updater.cancel(operation.id)
    const kept = application === 'applied' || application === 'overridden'
    if (kept) materialize(profileDir, '0.1.16')
    finish({ exitCode: kept ? 0 : 1, stdout: '', stderr: '', timedOut: false, aborted: true, management: application === 'unknown' ? { indeterminate: true, application: 'unknown' } : { application } })
    await vi.waitFor(() => expect(operation.phase).toBe(kept ? 'done' : application === 'cancelled' ? 'cancelled' : application === 'unknown' ? 'waiting' : 'failed'))
    expect(runner).toHaveBeenCalledTimes(1)
    if (application === 'unknown') expect(updater.startUpdate()).toBe(operation)
    if (application === 'overridden') expect(operation.message).toContain('覆盖')
    expect(updater.restartRequired).toBe(kept)
  })

  it('does not expose cancellation when the native manager lacks that capability', async () => {
    const profileDir = installedProfile('0.1.15')
    let finish!: (value: CommandResult) => void
    let signal!: AbortSignal
    const runner = vi.fn((_profile: string, _args: readonly string[], options?: CommandOptions) => {
      signal = options!.signal!
      return new Promise<CommandResult>(resolve => { finish = resolve })
    }) as unknown as PluginRunner
    managedRunner(runner, false)
    const updater = createMarketUpdater('desktop', runner, { currentVersion: '0.1.15', profileDir, fetch: latest('0.1.16') })
    const operation = updater.startUpdate()
    expect(operation.cancelable).toBe(false)
    await vi.waitFor(() => expect(runner).toHaveBeenCalled())
    updater.cancel(operation.id)
    expect(operation.phase).toBe('downloading')
    expect(operation.cancelable).toBe(false)
    expect(signal.aborted).toBe(false)
    materialize(profileDir, '0.1.16')
    finish({ exitCode: 0, stdout: '', stderr: '', timedOut: false, management: { application: 'applied' } })
    await vi.waitFor(() => expect(operation.phase).toBe('done'))
    expect(operation.integrityVerified).toBe(true)
  })

  it.each([
    ['missing client', '未物化'], ['missing lock', 'root importer'], ['wrong importer', 'root importer'],
    ['local source', '来源'], ['wrong SRI', 'SRI'], ['wrong gitHead', 'gitHead'], ['wrong tarball', '下载地址'],
  ])('rejects native update success with %s', async (fault, reason) => {
    const profileDir = installedProfile('0.1.15')
    const runner = vi.fn(async () => {
      materialize(profileDir, '0.1.16')
      const lockFile = join(profileDir, 'pnpm-lock.yaml')
      if (fault === 'missing client') rmSync(join(profileDir, 'node_modules', MARKET_NPM_PACKAGE, 'client.js'))
      if (fault === 'missing lock') rmSync(lockFile)
      if (fault === 'wrong importer') writeFileSync(lockFile, readFileSync(lockFile, 'utf8').replace("specifier: '0.1.16'", "specifier: '^0.1.16'"))
      if (fault === 'local source') {
        const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
        manifest.dependencies[MARKET_NPM_PACKAGE] = 'file:/unreviewed-market'
        writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest))
      }
      if (fault === 'wrong SRI') writeFileSync(lockFile, readFileSync(lockFile, 'utf8').replace(REVIEWED_INTEGRITY, 'sha512-other'))
      if (fault === 'wrong gitHead') {
        const file = join(profileDir, 'node_modules', MARKET_NPM_PACKAGE, 'package.json')
        const manifest = JSON.parse(readFileSync(file, 'utf8'))
        manifest.gitHead = 'd'.repeat(40)
        writeFileSync(file, JSON.stringify(manifest))
      }
      if (fault === 'wrong tarball') writeFileSync(lockFile, `${readFileSync(lockFile, 'utf8')}      tarball: https://example.test/unreviewed.tgz\n`)
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, management: { application: 'applied' as const } }
    }) as unknown as PluginRunner
    managedRunner(runner)
    const updater = createMarketUpdater('desktop', runner, { currentVersion: '0.1.15', profileDir, fetch: latest('0.1.16') })
    await expect(updater.update()).rejects.toThrow(reason)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(updater.restartRequired).toBe(false)
    expect((await updater.status()).currentVersion).toBe('0.1.15')
  })

  it.each(['failed', 'cancelled'] as const)('reports changed native artifacts after %s without restoring or reinstalling', async application => {
    const profileDir = installedProfile('0.1.15')
    const runner = vi.fn(async () => {
      rmSync(join(profileDir, 'node_modules', MARKET_NPM_PACKAGE, 'client.js'))
      return { exitCode: 1, stdout: '', stderr: 'native operation ended', timedOut: false, management: { application } }
    }) as unknown as PluginRunner
    managedRunner(runner)
    const updater = createMarketUpdater('desktop', runner, { currentVersion: '0.1.15', profileDir, fetch: latest('0.1.16') })
    const operation = updater.startUpdate()
    await vi.waitFor(() => expect(operation.phase).toBe('failed'))
    expect(operation.application).toBe(application)
    expect(operation.message).toContain('不能确认取消或失败已恢复')
    expect(runner).toHaveBeenCalledTimes(1)
    expect(existsSync(join(profileDir, 'node_modules', MARKET_NPM_PACKAGE, 'client.js'))).toBe(false)
  })

  it('does not claim native cancellation restored an altered lockfile resolution', async () => {
    const profileDir = installedProfile('0.1.15')
    const lockFile = join(profileDir, 'pnpm-lock.yaml')
    const runner = vi.fn(async () => {
      writeFileSync(lockFile, readFileSync(lockFile, 'utf8').replace(REVIEWED_INTEGRITY, 'sha512-unknown'))
      return { exitCode: 1, stdout: '', stderr: '', timedOut: false, management: { application: 'cancelled' as const } }
    }) as unknown as PluginRunner
    managedRunner(runner)
    const updater = createMarketUpdater('desktop', runner, { currentVersion: '0.1.15', profileDir, fetch: latest('0.1.16') })
    const operation = updater.startUpdate()
    await vi.waitFor(() => expect(operation.phase).toBe('failed'))
    expect(operation.application).toBe('cancelled')
    expect(operation.message).toContain('锁文件解析')
    expect(readFileSync(lockFile, 'utf8')).toContain('sha512-unknown')
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('verifies a matching native caret source with metadata SRI=%s', async withIntegrity => {
    const profileDir = installedProfile('0.1.15')
    const runner = vi.fn(async () => {
      materialize(profileDir, '0.1.16')
      const manifestFile = join(profileDir, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
      manifest.dependencies[MARKET_NPM_PACKAGE] = '^0.1.16'
      writeFileSync(manifestFile, JSON.stringify(manifest))
      const lockFile = join(profileDir, 'pnpm-lock.yaml')
      writeFileSync(lockFile, readFileSync(lockFile, 'utf8').replace("specifier: '0.1.16'", "specifier: '^0.1.16'"))
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, management: { application: 'restart-required' as const } }
    }) as unknown as PluginRunner
    managedRunner(runner)
    const updater = createMarketUpdater('desktop', runner, { currentVersion: '0.1.15', profileDir, fetch: latest('0.1.16', withIntegrity) })
    const operation = updater.startUpdate()
    await vi.waitFor(() => expect(operation.phase).toBe('done'))
    expect(operation.integrityVerified).toBe(withIntegrity)
    expect(operation.restartRequired).toBe(true)
  })
})
