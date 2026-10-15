import { describe, expect, it } from 'vitest'
import {
  failureHelpLinks,
  interceptNotice,
  isInterceptFailure,
  MARKET_INSTALL_TROUBLESHOOT_URL,
  MARKET_MANUAL_UPDATE_URL,
  marketUpdateNotice,
  skinRepositoryBrowseUrl,
} from '../../src/client/failure-help.ts'
import type { CatalogSkin, Operation } from '../../src/client/types.ts'

const skin = {
  id: 'test.skin', name: { zh: '测试皮肤', en: 'Test Skin' }, author: 'author', description: 'description',
  repo: 'https://github.com/a/b.git', package: 'skin', rowId: 'skin',
  tags: ['dark'], modes: ['dark'],
  install: { target: 'https://github.com/a/b.git#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', version: '1.0.0', commit: 'a'.repeat(40) },
  compatibility: { dsh: '0.1.0-rc.6', platform: ['web'] },
  screenshots: [], license: { code: 'MIT', commercialUse: true }, githubStars: 0, starsStale: false,
  starsUpdatedAt: '2026-08-16T00:00:00Z', recommendations: [], releaseUpdatedAt: '2026-08-16T00:00:00Z',
  metadataUpdatedAt: '2026-08-16T00:00:00Z', updatedAt: '2026-08-16T00:00:00Z',
} satisfies CatalogSkin

const nested = { ...skin, subpath: 'packages/glass' }

function failed(kind: NonNullable<Operation['failure']>['kind'], message: string, extra: Partial<Operation> = {}): Operation {
  return {
    id: 'op', kind: 'install', skinId: skin.id, phase: 'failed', startedAt: '2026-09-10T00:00:00Z',
    message, failure: { kind, message }, ...extra,
  }
}

describe('failure help', () => {
  it('pins a skin repository to the catalog commit and subpath', () => {
    expect(skinRepositoryBrowseUrl(skin)).toBe(`https://github.com/a/b/tree/${'a'.repeat(40)}`)
    expect(skinRepositoryBrowseUrl(nested)).toBe(`https://github.com/a/b/tree/${'a'.repeat(40)}/packages/glass`)
  })

  it('sends market self-update environment failures to troubleshooting, others to manual update', () => {
    expect(failureHelpLinks({ source: 'market-update', failureKind: 'unexpected-store' })).toEqual([
      { href: MARKET_INSTALL_TROUBLESHOOT_URL, label: '查看安装排查' },
    ])
    expect(failureHelpLinks({ source: 'market-update', failureKind: 'command' })).toEqual([
      { href: MARKET_MANUAL_UPDATE_URL, label: '查看手动更新' },
    ])
  })

  it('does not send local conflicts to GitHub, and pins packaging/compat failures to the skin commit', () => {
    expect(failureHelpLinks({ source: 'skin', failureKind: 'conflict', skin })).toEqual([])
    expect(failureHelpLinks({ source: 'skin', failureKind: 'fetch-404', skin })).toEqual([
      { href: MARKET_INSTALL_TROUBLESHOOT_URL, label: '查看安装排查' },
    ])
    expect(failureHelpLinks({
      source: 'skin',
      message: `${skin.package} bundle patch is missing: ./cordis.patch.yml`,
      skin,
    })).toEqual([{ href: `https://github.com/a/b/tree/${'a'.repeat(40)}`, label: '打开皮肤仓库' }])
    expect(failureHelpLinks({ source: 'skin', failureKind: 'command', skin })).toEqual([
      { href: `https://github.com/a/b/tree/${'a'.repeat(40)}`, label: '打开皮肤仓库' },
      { href: MARKET_INSTALL_TROUBLESHOOT_URL, label: '查看安装排查' },
    ])
  })

  it('keeps retryable failures out of the intercept dialog', () => {
    expect(isInterceptFailure(failed('network', '网络错误', { failure: { kind: 'network', message: '网络错误', action: 'retry' } }))).toBe(false)
    expect(isInterceptFailure(failed('unexpected-store', 'store'))).toBe(true)
  })

  it('attaches the skin commit link to a packaging intercept', () => {
    const notice = interceptNotice(failed('command', `${skin.package} bundle patch is missing: ./cordis.patch.yml`), '液态玻璃', skin)
    expect(notice.title).toBe('已拦截安装')
    expect(notice.links).toEqual([{ href: `https://github.com/a/b/tree/${'a'.repeat(40)}`, label: '打开皮肤仓库' }])
  })

  it('explains the host compatibility failure after a user accepted the market warning', () => {
    const notice = interceptNotice(failed('compatibility', '插件依赖不兼容', { kind: 'update' }), '测试皮肤', skin)
    expect(notice.title).toBe('更新未完成')
    expect(notice.what).toContain('DSH 宿主')
    expect(notice.why).toContain('插件依赖不兼容')
    expect(notice.why).toContain('宿主仍会检查插件自身的依赖要求')
    expect(notice.what).not.toContain('没有改动')
  })

  it('explains a market store mismatch with the troubleshooting README', () => {
    const notice = marketUpdateNotice({
      failure: { kind: 'unexpected-store', message: '当前 profile 的 node_modules 由另一代 pnpm store 链接' },
    })
    expect(notice.title).toBe('皮肤市场更新失败')
    expect(notice.links).toEqual([{ href: MARKET_INSTALL_TROUBLESHOOT_URL, label: '查看安装排查' }])
  })

  it('keeps a native package failure visible after multiline progress output', () => {
    const message = [
      'Progress: resolved 1, reused 0, downloaded 0, added 0',
      'Packages: +1',
      'Progress: resolved 20, reused 19, downloaded 0, added 0',
      '\u001b[31mERR_PNPM_FETCH_404\u001b[0m GET https://registry.npmjs.org/example: Not Found',
      'This error happened while installing a direct dependency.',
    ].join('\n')
    const notice = interceptNotice({ ...failed('command', message), failure: undefined }, '测试皮肤', skin)
    expect(notice.why).toContain('ERR_PNPM_FETCH_404')
    expect(notice.why).not.toContain('Progress:')
    expect(notice.why).not.toContain('\u001b')
    expect(notice.why).not.toContain('操作过程中出现错误')
    expect(notice.what).not.toContain('没有继续修改')
  })

  it('summarizes a diagnostic export without showing its header or unrelated events', () => {
    const message = [
      '# dsh-skin-market diagnostic log',
      'version: 0.1.60',
      'operationId: test',
      '2026-10-15T07:00:00Z [info] operation: install example',
      '2026-10-15T07:00:01Z [error] operation: Error: Cannot find package example',
    ].join('\n')
    const notice = interceptNotice(failed('command', message), '测试皮肤', skin)
    expect(notice.why).toBe('Error: Cannot find package example')
  })

  it.each(['install', 'update'] as const)('prioritizes the terminal release-age error and affected entry over earlier network warnings during %s', kind => {
    const message = [
      'Progress: resolved 20, reused 19, downloaded 0, added 0',
      '[WARN] GET https://registry.npmmirror.com/example error (ECONNRESET). Will retry in 10 seconds.',
      '[WARN] GET https://registry.npmmirror.com/another error (ECONNRESET). Will retry in 1 minute.',
      '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:',
      '',
      'dsh-skin-market@0.1.60',
      'was published at 2026-10-15T07:50:00.000Z, within the minimumReleaseAge cutoff.',
    ].join('\n')
    const notice = interceptNotice({ ...failed('command', message, { kind }), failure: undefined }, '测试皮肤', skin)
    expect(notice.why).toContain('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')
    expect(notice.why).toContain('dsh-skin-market@0.1.60')
    expect(notice.why).toContain('within the minimumReleaseAge cutoff')
    expect(notice.why).not.toContain('ECONNRESET')
    expect(notice.why).not.toContain('Progress:')
    expect(marketUpdateNotice({ message }).why).toBe(notice.why)
  })

  it('bounds long diagnostics and keeps a simple override reason readable', () => {
    const long = `Error: ${'x'.repeat(1_000)}\n${'at installer\n'.repeat(20)}`
    expect(interceptNotice(failed('command', long), '测试皮肤').why.length).toBeLessThanOrEqual(480)
    const override = '启停设置已保存，但被其他配置覆盖，尚未生效'
    expect(interceptNotice(failed('command', override), '测试皮肤').why).toBe(override)
    const exportWithoutError = '# dsh-skin-market diagnostic log\nversion: 0.1.60\noperationId: test\n[info] operation: install example'
    expect(interceptNotice(failed('command', exportWithoutError), '测试皮肤').why).toBe('未能获取具体原因，请复制日志反馈。')
  })

  it('gives an overridden enablement one concise action instead of repeated restart advice', () => {
    const notice = interceptNotice(failed('command', '目标组件被更高优先级配置停用；重复重启无效。', { kind: 'activate', application: 'overridden' }), '龙之继承者', skin)
    expect(notice.what).toBe('「龙之继承者」被其他设置禁用。')
    expect(notice.why).toBe('请解除该皮肤的禁用设置后，再点“使用”。')
    expect(notice.links).toEqual([{ href: 'https://github.com/kingOfSoySauce/dsh-skin-market#configuration-override', label: '查看处理方法' }])
    expect(`${notice.what}${notice.why}`).not.toMatch(/重启|profile|已停止/)
    const disable = interceptNotice(failed('command', '启停被覆盖', { kind: 'deactivate', application: 'overridden' }), '龙之继承者', skin)
    expect(disable.what).not.toContain('被其他设置禁用')
    expect(disable.why).not.toContain('使用')
  })

  it('explains the actual release-age blocker without sending users to the skin author or another update route', () => {
    const notice = interceptNotice(failed('release-age', 'dsh-skin-market@0.1.60 仍处于新包保护期。'), '测试皮肤', skin)
    expect(notice.links).toEqual([{ href: 'https://github.com/kingOfSoySauce/dsh-skin-market#release-wait', label: '查看处理方法' }])
    expect(marketUpdateNotice({ failure: { kind: 'release-age', message: '新包保护期' } }).links).toEqual(notice.links)
    expect(marketUpdateNotice({ message: '更新后的构件仍需核对' }).what).toBe('')
  })
  it('explains a precise release-age exception as a local user approval for either operation', () => {
    const failure = { kind: 'release-age' as const, message: '保护拦截', action: 'approve-release-age' as const, releaseAgeTarget: { packageName: 'dsh-skin-market', version: '0.1.61' } }
    const operation = { ...failed('release-age', '保护拦截'), failure }
    expect(isInterceptFailure(operation)).toBe(true)
    const skinNotice = interceptNotice(operation, '测试皮肤', skin)
    const updateNotice = marketUpdateNotice({ failure })
    expect(skinNotice.title).toBe('安装需要允许新版本')
    expect(updateNotice.title).toBe('更新需要允许新版本')
    for (const notice of [skinNotice, updateNotice]) {
      expect(notice.what).toContain('本机 Desktop')
      expect(notice.why).toContain('只放行下方这个精确版本')
      expect(notice.why).not.toMatch(/等待|24 小时|重启/)
    }
  })

})
