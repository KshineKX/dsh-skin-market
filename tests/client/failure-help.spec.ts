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
    expect(notice.what).toBe('「液态玻璃」的安装包缺少必要文件。')
    expect(notice.why).toBe('请等待作者修复后再安装。')
    expect(`${notice.what}${notice.why}`).not.toMatch(/cordis|patch|package\.json|profile|files/)
    expect(notice.links).toEqual([{ href: `https://github.com/a/b/tree/${'a'.repeat(40)}`, label: '打开皮肤仓库' }])
  })

  it('explains the host compatibility failure after a user accepted the market warning', () => {
    const notice = interceptNotice(failed('compatibility', '插件依赖不兼容', { kind: 'update' }), '测试皮肤', skin)
    expect(notice.title).toBe('更新未完成')
    expect(notice.what).toBe('「测试皮肤」未通过当前 DSH 的兼容检查。')
    expect(notice.why).toBe('请换用与当前 DSH 兼容的版本。')
    expect(notice.what).not.toContain('没有改动')
  })

  it('explains a market store mismatch with the troubleshooting README', () => {
    const notice = marketUpdateNotice({
      failure: { kind: 'unexpected-store', message: '当前 profile 的 node_modules 由另一代 pnpm store 链接' },
    })
    expect(notice.title).toBe('皮肤市场更新失败')
    expect(notice.links).toEqual([{ href: MARKET_INSTALL_TROUBLESHOOT_URL, label: '查看安装排查' }])
  })

  it('summarizes a native package failure without showing multiline progress or raw error codes', () => {
    const message = [
      'Progress: resolved 1, reused 0, downloaded 0, added 0',
      'Packages: +1',
      'Progress: resolved 20, reused 19, downloaded 0, added 0',
      '\u001b[31mERR_PNPM_FETCH_404\u001b[0m GET https://registry.npmjs.org/example: Not Found',
      'This error happened while installing a direct dependency.',
    ].join('\n')
    const notice = interceptNotice({ ...failed('command', message), failure: undefined }, '测试皮肤', skin)
    expect(notice.what).toBe('「测试皮肤」：安装源未找到所需安装包。')
    expect(notice.why).toBe('请等待发布者修复后再试。')
    expect(`${notice.what}${notice.why}`).not.toMatch(/ERR_PNPM|Progress:|registry|\u001b/)
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
    expect(notice.what).toBe('「测试皮肤」：插件缺少运行所需的文件或依赖。')
    expect(notice.why).toBe('请等待作者修复后再试。')
    expect(`${notice.what}${notice.why}`).not.toMatch(/diagnostic log|operationId|\[info\]|\[error\]|Cannot find|example/)
  })

  it.each(['install', 'update'] as const)('summarizes the terminal release-age blocker without earlier network warnings during %s', kind => {
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
    expect(notice.what).toBe('「测试皮肤」：所需版本仍处于新包保护期。')
    expect(notice.why).toBe('请等待保护期结束后重试。')
    expect(`${notice.what}${notice.why}`).not.toMatch(/ERR_PNPM|minimumReleaseAge|ECONNRESET|Progress:/)
    expect(marketUpdateNotice({ message }).why).toBe(notice.why)
  })

  it('keeps long or unknown diagnostics in logs and shows one short next step', () => {
    const long = `Error: ${'x'.repeat(1_000)}\n${'at installer\n'.repeat(20)}`
    expect(interceptNotice(failed('command', long), '测试皮肤').why).toBe('请复制日志反馈。')
    const override = '启停设置已保存，但被其他配置覆盖，尚未生效'
    expect(interceptNotice(failed('command', override), '测试皮肤').why).toBe('请复制日志反馈。')
    const exportWithoutError = '# dsh-skin-market diagnostic log\nversion: 0.1.60\noperationId: test\n[info] operation: install example'
    expect(interceptNotice(failed('command', exportWithoutError), '测试皮肤').why).toBe('请复制日志反馈。')
  })

  it('gives an overridden enablement one concise action instead of repeated restart advice', () => {
    const notice = interceptNotice(failed('command', '目标组件被更高优先级配置停用；重复重启无效。', { kind: 'activate', application: 'overridden' }), '龙之继承者', skin)
    expect(notice.what).toBe('「龙之继承者」被其他设置禁用。')
    expect(notice.why).toBe('请解除禁用后重新使用。')
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
    expect(marketUpdateNotice({ message: '更新后的构件仍需核对' }).what).toBe('未能完成本次操作。')
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
      expect(notice.what).toBe('dsh-skin-market@0.1.61 仍处于新包保护期。')
      expect(notice.why).toContain('确认后只允许此版本')
      expect(notice.why).not.toMatch(/等待|24 小时|重启/)
      expect(notice.links).toEqual([])
    }
  })

  it('keeps an artifact approval concise without exposing verification details or changing the failure', () => {
    const raw = 'RAW_DIAGNOSTIC_MARKER npm integrity mismatch /Users/example/private-profile/pnpm-lock.yaml'
    const operation = failed('integrity', raw, { failure: {
      kind: 'integrity', message: raw, action: 'approve-artifact',
      artifactRisk: { context: 'opaque-artifact-context', packageName: skin.package, version: '1.0.0', warnings: [raw] },
    } })
    const notice = interceptNotice(operation, '测试皮肤', skin)
    expect(notice.what).toBe('「测试皮肤」的安装包未通过市场核验，使用后可能导致页面异常。')
    expect(notice.why).toBe('')
    expect(notice.links).toEqual([])
    expect(notice).not.toHaveProperty('warnings')
    expect(JSON.stringify(notice)).not.toMatch(/RAW_DIAGNOSTIC_MARKER|private-profile|integrity mismatch|opaque-artifact-context/)
    expect(operation.failure?.message).toBe(raw)
    expect(operation.failure?.artifactRisk?.warnings).toEqual([raw])
    expect(operation.failure?.action).toBe('approve-artifact')
  })

  it('keeps a scoped package and prerelease exact in release-age approval text', () => {
    const failure: NonNullable<Operation['failure']> = {
      kind: 'release-age', message: 'RAW_DIAGNOSTIC_MARKER', action: 'approve-release-age',
      releaseAgeTarget: { packageName: '@example/dependency', version: '2.3.4-rc.1' },
    }
    const notice = interceptNotice(failed('release-age', failure.message, { failure }), '测试皮肤', skin)
    expect(notice.what).toBe('@example/dependency@2.3.4-rc.1 仍处于新包保护期。')
    expect(notice.why).toBe('确认后只允许此版本，并继续本次操作。')
    expect(notice.links).toEqual([])
    expect(`${notice.what}${notice.why}`).not.toContain('RAW_DIAGNOSTIC_MARKER')
  })

  it.each([
    ['conflict', '发现插件安装冲突：RAW_DIAGNOSTIC_MARKER', '与已安装插件冲突', '停用或卸载冲突项'],
    ['command', '市场目录元数据与包实际声明不一致：RAW_DIAGNOSTIC_MARKER', '安装信息与安装包不一致', '等待市场更新'],
    ['disk-full', 'ENOSPC RAW_DIAGNOSTIC_MARKER', '磁盘空间不足', '释放空间'],
    ['permission', 'EACCES RAW_DIAGNOSTIC_MARKER', '应用无权写入安装目录', '检查目录权限'],
    ['command', '官方管理操作后构件与原有版本不一致 RAW_DIAGNOSTIC_MARKER', '插件状态尚未确认', '核对实际状态'],
  ] as const)('keeps the concrete %s problem and one next step without raw details', (kind, message, problem, next) => {
    const notice = interceptNotice(failed(kind, message), '测试皮肤', skin)
    expect(notice.what).toContain(problem)
    expect(notice.why).toContain(next)
    expect(`${notice.what}${notice.why}`).not.toContain('RAW_DIAGNOSTIC_MARKER')
    expect(notice.links.length).toBeLessThanOrEqual(1)
  })

  it('does not mistake an earlier recovered warning for the terminal error or override a structured Host category', () => {
    const message = '[WARN] minimumReleaseAge recovered\nERR_PNPM_FETCH_404 RAW_DIAGNOSTIC_MARKER'
    const inferred = interceptNotice(failed('command', message), '测试皮肤', skin)
    expect(inferred.what).toContain('安装源未找到所需安装包')
    const structured = interceptNotice(failed('network', message), '测试皮肤', skin)
    expect(structured.what).toContain('暂时无法连接安装源')
    expect(`${inferred.what}${structured.what}`).not.toContain('RAW_DIAGNOSTIC_MARKER')
    const exported = interceptNotice(failed('command', '[WARN] minimumReleaseAge recovered\n2026-10-15 [error] operation: Error: Cannot find package RAW_DIAGNOSTIC_MARKER'), '测试皮肤', skin)
    expect(exported.what).toContain('插件缺少运行所需的文件或依赖')
  })

  it.each([
    'release-age', 'network', 'fetch-timeout', 'build-approval', 'fetch-404', 'adding-to-root',
    'not-a-workspace', 'unexpected-store', 'compatibility', 'conflict', 'command', 'lockfile-outdated',
    'lockfile-broken', 'script-timeout', 'pnpm-missing', 'no-matching-version', 'disk-full', 'permission', 'integrity',
  ] as const)('limits %s notices to one help link and short controlled text', kind => {
    const message = 'Error: RAW_DIAGNOSTIC_MARKER /Users/example/private-profile/file'
    const operation = failed(kind, message)
    const notices = [interceptNotice(operation, '测试皮肤', skin), marketUpdateNotice(operation)]
    for (const notice of notices) {
      expect(notice.links.length).toBeLessThanOrEqual(1)
      expect(`${notice.what}${notice.why}`.length).toBeLessThan(160)
      expect(`${notice.what}${notice.why}`).not.toMatch(/RAW_DIAGNOSTIC_MARKER|private-profile|Error:/)
      expect(notice).not.toHaveProperty('warnings')
    }
  })

})
