import { describe, expect, it } from 'vitest'
import { createSkinInstallCommandGroups, createSkinInstallPrompt } from '../src/client/submission.ts'
import type { CatalogSkin } from '../src/client/types.ts'

const commit = 'b693d2c224a0a6fb5b621e7cc1284f20d9849c1c'
const primary = `github:Small-tailqwq/dsh-deep-whale#${commit}&path:/maid-atelier`
const companion = `github:Small-tailqwq/dsh-deep-whale#${commit}&path:/skin-manager`
const skin = {
  repo: 'https://github.com/Small-tailqwq/dsh-deep-whale', package: '@dsh-external/dsh-client-ui-skin-maid-atelier', rowId: 'ui-skin-maid-atelier',
  install: { target: primary, version: '0.0.1', commit, companions: [{
    package: '@dsh-external/dsh-client-ui-skin-deep-whale-manager', rowId: 'ui-skin-deep-whale-manager', target: companion, version: '0.1.0', commit,
  }] },
} as CatalogSkin

describe('terminal command groups', () => {
  it('lists only the primary command for all three terminals', () => {
    const groups = createSkinInstallCommandGroups(skin)
    expect(groups.map(group => group.label)).toEqual(['macOS / Linux', 'Windows PowerShell', 'Windows CMD'])
    expect(groups.map(group => group.commands.map(entry => entry.value))).toEqual([
      [`pnpm add "${primary}" --dir "$HOME/.dsh/profiles/web"`],
      [`pnpm add "${primary}" --dir "$env:USERPROFILE\\.dsh\\profiles\\web"`],
      [`pnpm add "${primary}" --dir "%USERPROFILE%\\.dsh\\profiles\\web"`],
    ])
    expect(createSkinInstallPrompt(skin)).toContain(companion)
  })

  it('uses only the requested terminal when it is known', () => {
    const groups = createSkinInstallCommandGroups(skin, { shell: 'cmd' })
    expect(groups).toHaveLength(1)
    expect(groups[0]!.label).toBe('Windows CMD')
    expect(groups[0]!.commands[0]!.value).toBe(`pnpm add "${primary}" --dir "%USERPROFILE%\\.dsh\\profiles\\web"`)
  })

  it('preserves an explicitly selected version in one unlabeled line', () => {
    const groups = createSkinInstallCommandGroups({ ...skin, install: { ...skin.install, target: 'example-skin@1.2.3' } }, {}, 'example-skin@1.2.3')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.label).toBe('')
    expect(groups[0]!.commands.map(entry => entry.value)).toEqual(['dsh plugin --profile web add "example-skin@1.2.3" --save-exact'])
  })

})
