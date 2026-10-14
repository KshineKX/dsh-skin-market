import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectDshRuntime, hasRuntimeCapability, runtimeCapabilities } from '../src/runtime.ts'

const originalArgv = process.argv
const directories: string[] = []
function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'market-runtime-'))
  directories.push(directory)
  return directory
}
function writeManifest(directory: string, name: string, version: string): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version }))
}
function launch(entry: string): void {
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, '')
  process.argv = [process.execPath, entry]
  vi.stubEnv('DSH_VERSION', '')
}
afterEach(() => {
  process.argv = originalArgv
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('DSH runtime capabilities', () => {
  it('preserves the published rc.6 list and limits the legacy keyed contract to its actual versions', () => {
    expect(runtimeCapabilities('0.1.0-rc.5')).toEqual([])
    expect(runtimeCapabilities('0.1.0-rc.6')).toContain('slot:list:settings.plugin.item')
    expect(runtimeCapabilities('0.1.0-rc.6')).not.toContain('slot:keyed:settings.plugin.item')
    expect(runtimeCapabilities('0.1.0-rc.7')).toContain('slot:keyed:settings.plugin.item')
    expect(runtimeCapabilities('0.1.1-rc.1')).toContain('slot:keyed:settings.plugin.item')
    expect(runtimeCapabilities('0.1.6-alpha.1')).toContain('slot:keyed:settings.plugin.item')
  })

  it.each(['0.1.6-alpha.2', '0.1.7-alpha.1', '0.2.0-rc.2', '0.2.1-alpha.2'])('recognizes new plugin configuration slots in %s without resurrecting the removed slot', version => {
    const capabilities = runtimeCapabilities(version)
    expect(capabilities).toContain('slot:list:settings.section')
    expect(capabilities).toContain('slot:keyed:plugins.bundle.config')
    expect(capabilities).toContain('slot:keyed:plugins.row.config')
    expect(capabilities).not.toContain('slot:keyed:settings.plugin.item')
  })

  it.each([null, 'nonsense', '0.2.1-alpha.3', '0.3.0', '1.0.0'])('makes no slot claims for an unknown or unaudited version %s', version => {
    expect(runtimeCapabilities(version)).toEqual([])
  })

  it('checks capabilities without coupling adapters to package names', () => {
    const capabilities = runtimeCapabilities('0.1.1-rc.1')
    expect(hasRuntimeCapability({ version: '0.1.1-rc.1', capabilities, source: 'injected' }, 'slot:keyed:settings.plugin.item')).toBe(true)
  })
})

describe('DSH runtime identity', () => {
  it('reads a verified CLI package rather than the closest unrelated package', () => {
    const root = fixture()
    writeManifest(root, '@deepseek-ai/dsh', '0.1.0-rc.7')
    writeManifest(join(root, 'lib', 'wrapper'), 'unrelated-wrapper', '99.0.0')
    launch(join(root, 'lib', 'wrapper', 'entry.js'))
    expect(detectDshRuntime()).toMatchObject({ version: '0.1.0-rc.7', source: 'host-package' })
  })

  it('does not mistake an arbitrary application version for DSH', () => {
    const root = fixture()
    writeManifest(root, 'other-app', '0.1.7-alpha.1')
    launch(join(root, 'lib', 'entry.js'))
    expect(detectDshRuntime()).toEqual({ version: null, capabilities: [], source: 'unknown' })
  })

  it('follows a launcher symlink to the verified CLI package', () => {
    const root = fixture()
    const cli = join(root, 'cli')
    writeManifest(cli, '@deepseek-ai/dsh', '0.1.6-alpha.2')
    const entry = join(cli, 'lib', 'bin.js')
    launch(entry)
    const link = join(root, 'dsh')
    symlinkSync(entry, link)
    process.argv = [process.execPath, link]
    expect(detectDshRuntime()).toMatchObject({ version: '0.1.6-alpha.2', source: 'host-package' })
  })

  it('uses the actual embedded DSH package inside a verified Desktop runtime', () => {
    const root = fixture()
    writeManifest(root, '@deepseek-ai/dsh-desktop-runtime', '0.2.1-alpha.2')
    writeManifest(join(root, 'node_modules', '@deepseek-ai', 'dsh'), '@deepseek-ai/dsh', '0.2.1-alpha.2')
    const host = join(root, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
    writeManifest(host, '@deepseek-ai/dsh-desktop-host', '99.0.0')
    launch(join(host, 'lib', 'index.js'))
    expect(detectDshRuntime()).toMatchObject({ version: '0.2.1-alpha.2', source: 'host-package' })
  })

  it.each(['missing', 'wrong-package', 'wrong-version'])('rejects a Desktop runtime whose embedded DSH is %s', issue => {
    const root = fixture()
    writeManifest(root, '@deepseek-ai/dsh-desktop-runtime', '0.2.1-alpha.2')
    if (issue !== 'missing') writeManifest(join(root, 'node_modules', '@deepseek-ai', 'dsh'), issue === 'wrong-package' ? 'unrelated-package' : '@deepseek-ai/dsh', issue === 'wrong-version' ? '0.1.0-rc.7' : '0.2.1-alpha.2')
    launch(join(root, 'host', 'index.js'))
    expect(detectDshRuntime()).toEqual({ version: null, capabilities: [], source: 'unknown' })
  })

  it.each(['latest', '0.1.0-rc.', '01.1.0', '0.1.0-rc.07', '0.1.0-rc.6 trailing'])('rejects invalid DSH_VERSION=%s without guessing another version', version => {
    const root = fixture()
    writeManifest(root, '@deepseek-ai/dsh', '0.1.0-rc.7')
    launch(join(root, 'lib', 'bin.js'))
    vi.stubEnv('DSH_VERSION', version)
    expect(detectDshRuntime()).toEqual({ version: null, capabilities: [], source: 'unknown' })
  })

  it('records a valid explicit runtime version as injected', () => {
    vi.stubEnv('DSH_VERSION', ' 0.1.0-rc.6 ')
    expect(detectDshRuntime()).toMatchObject({ version: '0.1.0-rc.6', source: 'injected', capabilities: expect.arrayContaining(['slot:list:settings.plugin.item']) })
  })
})
