import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applicableAdapters, assessCompatibility } from '../src/compatibility.ts'
import { persistCompatibilityPatch, planCompatibilityPatch, unifiedPatch } from '../src/compatibility-adapter.ts'
import { atomicWriteJson, atomicWriteText, pnpmWorkspaceFile } from '../src/profile.ts'
import type { DshRuntime, SkinEntry } from '../src/types.ts'
import { runtimeCapabilities } from '../src/runtime.ts'

const fixtureDirectories: string[] = []
function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'skin-adapter-'))
  fixtureDirectories.push(directory)
  return directory
}
afterEach(() => { for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function skin(): SkinEntry {
  return {
    id: 'generic.skin',
    name: { zh: 'Generic', en: 'Generic' },
    author: 'test',
    description: 'test',
    repo: 'https://github.com/example/generic',
    package: '@example/generic-skin',
    rowId: 'generic-skin',
    category: 'theme',
    tags: ['theme'],
    modes: ['dark'],
    install: { target: 'github:example/generic#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', version: '1.0.0', commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    compatibility: {
      dsh: '^0.1.0-rc.5',
      platform: ['web'],
      adapters: [{ id: 'keyed-settings', kind: 'keyed-slot-id-to-key', when: '>=0.1.0-rc.7 <0.1.6-alpha.2', slot: 'settings.plugin.item', key: 'locale' }],
    },
    screenshots: [],
    license: { code: 'MIT', commercialUse: true },
    featuredRank: 0,
    starsSnapshot: 0,
    releaseUpdatedAt: '2026-01-01T00:00:00.000Z',
    metadataUpdatedAt: '2026-01-01T00:00:00.000Z',
    starsUpdatedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

const runtime: DshRuntime = { version: '0.1.1-rc.1', capabilities: ['slot:keyed:settings.plugin.item'], source: 'injected' }

function clientFixture(source: string, current = skin()): { directory: string; current: SkinEntry; sourceFile: string } {
  const directory = fixture()
  const packageDir = join(directory, 'node_modules', ...current.package.split('/'))
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  atomicWriteJson(join(directory, 'package.json'), { dependencies: { [current.package]: current.install.target } })
  atomicWriteJson(join(packageDir, 'package.json'), {
    name: current.package, version: current.install.version,
    exports: { './client': './lib/client.js' }, dsh: { client: { platform: 'web' } },
  })
  const sourceFile = join(packageDir, 'lib', 'client.js')
  atomicWriteText(sourceFile, source)
  return { directory, current, sourceFile }
}

describe('generic compatibility adapters', () => {
  it('adapts any package that uses id for a keyed settings slot', () => {
    const dir = fixture()
    const current = skin()
    const packageDir = join(dir, 'node_modules', ...current.package.split('/'))
    mkdirSync(join(packageDir, 'lib'), { recursive: true })
    atomicWriteJson(join(dir, 'package.json'), { dependencies: { [current.package]: current.install.target } })
    atomicWriteJson(join(packageDir, 'package.json'), {
      name: current.package,
      version: current.install.version,
      exports: { './client': { default: './lib/client.js' } },
      dsh: { client: { platform: 'web' } },
    })
    const source = `const NS = "settings.generic"\nctx.slots.register({\n  name: "settings.plugin.item",\n  id: "generic",\n  order: 5,\n  locale: NS,\n}, Card)`
    atomicWriteText(join(packageDir, 'lib/client.js'), source)

    expect(assessCompatibility(current, runtime)).toMatchObject({ decision: 'adaptable', adapterIds: ['keyed-settings'] })
    const plan = planCompatibilityPatch(dir, current, runtime)
    expect(plan).not.toBeNull()
    expect(plan?.patchedSource).toContain('key: "settings.generic"')
    expect(plan?.patchedSource).not.toContain('id: "generic"')
    expect(plan?.outcomes).toEqual([{ adapterId: 'keyed-settings', status: 'patchable' }])

    persistCompatibilityPatch(dir, plan!)
    expect(readFileSync(plan!.patchFile, 'utf8')).toContain('-  id: "generic",')
    expect(readFileSync(plan!.patchFile, 'utf8')).toContain('+  key: "settings.generic",')
    expect(readFileSync(pnpmWorkspaceFile(dir), 'utf8')).toContain(`${current.package}@${current.install.version}`)
  })

  it('does not invent a source migration for a package without a declared adapter', () => {
    const dir = fixture()
    const current = { ...skin(), compatibility: { dsh: '^0.1.0-rc.5', platform: ['web'] } }
    const packageDir = join(dir, 'node_modules', ...current.package.split('/'))
    mkdirSync(join(packageDir, 'lib'), { recursive: true })
    atomicWriteJson(join(packageDir, 'package.json'), {
      name: current.package,
      version: current.install.version,
      exports: { './client': { default: './lib/client.js' } },
      dsh: { client: { platform: 'web' } },
    })
    atomicWriteText(join(packageDir, 'lib/client.js'), [
      'const NS = "settings.generic"',
      'ctx.slots.register({',
      '  name: "settings.plugin.item",',
      '  id: "generic",',
      '  locale: NS,',
      '}, Card)',
    ].join('\n'))

    expect(assessCompatibility(current, runtime).decision).toBe('compatible')
    expect(applicableAdapters(current, runtime, true)).toEqual([])
    expect(planCompatibilityPatch(dir, current, runtime)).toBeNull()
    expect(readFileSync(join(packageDir, 'lib/client.js'), 'utf8')).toContain('id: "generic"')
    expect(existsSync(pnpmWorkspaceFile(dir))).toBe(false)
  })

  it('does not expand an exact author range even when an explicit adapter could rewrite the source', () => {
    const current = skin()
    current.compatibility.dsh = '0.1.0-rc.6'
    expect(assessCompatibility(current, runtime)).toMatchObject({
      decision: 'incompatible', adapterIds: [],
    })
    expect(applicableAdapters(current, runtime, true)).toEqual([])
    const source = 'ctx.slots.register({ name: "settings.plugin.item", id: "generic", locale: "settings.generic" }, Card)'
    const { directory, sourceFile } = clientFixture(source, current)
    expect(planCompatibilityPatch(directory, current, runtime)).toBeNull()
    expect(readFileSync(sourceFile, 'utf8')).toBe(source)
  })

  it('creates a patch only for a real source change', () => {
    expect(unifiedPatch('lib/client.js', 'const a = 1\n', 'const a = 1\n')).toBe('')
    expect(() => unifiedPatch('lib/client.js', 'a\n', 'a\nb\n')).toThrow('line count')
  })

  it('blocks an out-of-range plugin when no adapter matches', () => {
    const current = { ...skin(), compatibility: { dsh: '<0.1.0-rc.6', platform: ['web'] } }
    expect(assessCompatibility(current, runtime).decision).toBe('incompatible')
  })

  it.each(['0.1.0-rc.6', '0.1.6-alpha.2', '0.1.7-alpha.1', '0.2.1-alpha.2', '0.3.0'])('does not rewrite the removed or list contract on %s, including stale catalog adapter ranges', version => {
    const current = skin()
    current.compatibility.adapters![0]!.when = '>=0.1.0-rc.6 <1.0.0'
    const { directory, sourceFile } = clientFixture('ctx.slots.register({ name: "settings.plugin.item", id: "generic", locale: "settings.generic" }, Card)', current)
    const host = { version, capabilities: [...runtimeCapabilities(version), 'slot:keyed:settings.plugin.item'], source: 'injected' as const }
    expect(applicableAdapters(current, host, true)).toEqual([])
    expect(planCompatibilityPatch(directory, current, host)).toBeNull()
    expect(readFileSync(sourceFile, 'utf8')).toContain('id: "generic"')
    expect(existsSync(pnpmWorkspaceFile(directory))).toBe(false)
  })

  it('distinguishes an already correct registration without writing a patch', () => {
    const source = 'const NS = "settings.generic"\nctx.slots.register({ name: "settings.plugin.item", key: NS, locale: NS }, Card)'
    const { directory, current, sourceFile } = clientFixture(source)
    const plan = planCompatibilityPatch(directory, current, runtime)!
    expect(plan.outcomes).toEqual([{ adapterId: 'keyed-settings', status: 'already-correct' }])
    expect(plan.adapterIds).toEqual([])
    expect(plan.patchedSource).toBe(source)
    persistCompatibilityPatch(directory, plan)
    expect(readFileSync(sourceFile, 'utf8')).toBe(source)
    expect(existsSync(plan.patchFile)).toBe(false)
    expect(existsSync(pnpmWorkspaceFile(directory))).toBe(false)
  })

  it('handles nested unrelated metadata and preserves non-ASCII source offsets', () => {
    const source = 'const label = "皮肤设置"\nctx.slots.register({ name: "settings.plugin.item", id: "generic", locale: "settings.generic", inject: () => ({ nested: { id: "untouched", value: /[},]/ } }) }, Card)'
    const { directory, current } = clientFixture(source)
    const plan = planCompatibilityPatch(directory, current, runtime)!
    expect(plan.patchedSource).toContain('key: "settings.generic"')
    expect(plan.patchedSource).toContain('id: "untouched"')
    expect(plan.patchedSource).toContain('"皮肤设置"')
  })

  it.each([
    'ctx.slots.register({ name: "settings.plugin.item", id: "generic", locale: getNamespace() }, Card)',
    'let NS = "settings.generic"\nNS = getNamespace()\nctx.slots.register({ name: "settings.plugin.item", id: "generic", locale: NS }, Card)',
    'const NS = "settings.generic"\nNS = getNamespace()\nctx.slots.register({ name: "settings.plugin.item", id: "generic", locale: NS }, Card)',
    'ctx.slots.register({ name: "settings.plugin.item", id: "generic", locale: "settings.generic", ...extra }, Card)',
    'ctx.slots.register({ name: "settings.plugin.item", id: "generic", locale: "settings.generic", [field]: extra }, Card)',
    'ctx.slots.register({ name: "settings.plugin.item", id: "generic", id: "duplicate", locale: "settings.generic" }, Card)',
    'ctx.slots.register({ name: "settings.plugin.item", id: "generic", inject: () => ({ locale: "settings.generic" }) }, Card)',
    'ctx.slots.register({ name: "settings.plugin.item", key: getKey(), locale: "settings.generic" }, Card)',
    'ctx.slots.register({ name: "settings.plugin.item", id: getId(), locale: "settings.generic" }, Card)',
    'ctx.slots.register({ name: "settings.plugin.item", id:\n "generic", locale: "settings.generic" }, Card)',
    '// ctx.slots.register({ name: "settings.plugin.item", id: "generic", locale: "settings.generic" }, Card)',
    'const fake = "ctx.slots.register({ name: \\\"settings.plugin.item\\\", id: \\\"generic\\\", locale: \\\"settings.generic\\\" }, Card)"',
    'const fake = /ctx\.slots\.register\({name:"settings.plugin.item"}/',
    'const NS = getNamespace() // const NS = "settings.generic"\nctx.slots.register({ name: "settings.plugin.item", id: "generic", locale: NS }, Card)',
  ])('refuses an unsafe or unverifiable declared adapter without writing profile or source changes: %s', source => {
    const { directory, current, sourceFile } = clientFixture(source)
    const before = readFileSync(join(directory, 'package.json'), 'utf8')
    expect(() => planCompatibilityPatch(directory, current, runtime)).toThrow('无法安全执行')
    expect(readFileSync(sourceFile, 'utf8')).toBe(source)
    expect(readFileSync(join(directory, 'package.json'), 'utf8')).toBe(before)
    expect(existsSync(pnpmWorkspaceFile(directory))).toBe(false)
  })

  it('leaves undeclared configuration code untouched instead of treating it as an adapter candidate', () => {
    const current = { ...skin(), compatibility: { dsh: '^0.1.0-rc.5', platform: ['web'] } }
    const { directory } = clientFixture('ctx.slots.register({ name: "settings.plugin.item", id: "generic", locale: dynamicLocale }, Card)', current)
    expect(planCompatibilityPatch(directory, current, runtime)).toBeNull()
  })

  it('does not apply a declared adapter when the author compatibility range is unverified', () => {
    const current = skin()
    current.compatibility.dsh = 'unverified'
    const { directory } = clientFixture('ctx.slots.register({ name: "settings.plugin.item", id: "generic", locale: "settings.generic" }, Card)', current)
    expect(assessCompatibility(current, runtime)).toMatchObject({ decision: 'unknown', adapterIds: [] })
    expect(planCompatibilityPatch(directory, current, runtime)).toBeNull()
  })

  it('supports a compiled var namespace only when its literal assignment is unique', () => {
    const { directory, current } = clientFixture('var NS = "settings.generic"; ctx.slots.register({ name: "settings.plugin.item", id: "generic", locale: NS }, Card)')
    expect(planCompatibilityPatch(directory, current, runtime)?.patchedSource).toContain('key: "settings.generic"')
  })
})
