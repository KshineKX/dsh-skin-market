import { normalizeGitHubRepository, REGISTRY_REPOSITORY } from './submission.ts'
import type { CatalogSkin, Operation } from './types.ts'

export const MARKET_MANUAL_UPDATE_URL = `${REGISTRY_REPOSITORY}#manual-update`
export const MARKET_INSTALL_TROUBLESHOOT_URL = `${REGISTRY_REPOSITORY}#install-troubleshooting`
export const MARKET_CONFIG_OVERRIDE_URL = `${REGISTRY_REPOSITORY}#configuration-override`
export const MARKET_RELEASE_WAIT_URL = `${REGISTRY_REPOSITORY}#release-wait`

export interface FailureHelpLink {
  href: string
  label: string
}

export interface InterceptNotice {
  title: string
  what: string
  why: string
  links: FailureHelpLink[]
}

export interface FailureHelpSubject {
  source: 'skin' | 'market-update'
  failureKind?: NonNullable<Operation['failure']>['kind']
  message?: string
  skin?: Pick<CatalogSkin, 'repo' | 'subpath' | 'install'> | null
}

const operationKindLabels: Record<Operation['kind'], string> = {
  install: '安装', activate: '启用', deactivate: '停用', pin: '设置常驻', unpin: '取消常驻', update: '更新', migrate: '换用 npm', uninstall: '卸载',
}

/** Translate diagnostic categories; raw package output remains in copied logs. */
function failureExplanation(kind: FailureHelpSubject['failureKind'], message: string): { problem: string; next: string } {
  if (/恢复.{0,12}(?:未完成|失败)|原有版本不一致|未能确认.{0,12}恢复|恢复后.{0,24}未还原/.test(message)) {
    return { problem: '操作后的插件状态尚未确认。', next: '请先在官方插件页核对实际状态。' }
  }
  const plain = message.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  const terminal = [...plain.matchAll(/\bERR_[A-Z0-9_]+\b|\b(?:[A-Za-z]+)?Error(?: \[[^\]\r\n]+\])?:[^\r\n]*/g)].at(-1)
  // A recognized Host category wins; otherwise inspect the final error rather
  // than recovered warnings earlier in a diagnostic log. Neither is displayed.
  const diagnostic = kind === undefined || kind === 'command' ? plain.slice(terminal?.index ?? 0) : ''
  if (kind === 'release-age' || /minimumReleaseAge|ERR_PNPM[^\s]*RELEASE[^\s]*AGE|新包保护/i.test(diagnostic)) {
    return { problem: '所需版本仍处于新包保护期。', next: '请等待保护期结束后重试。' }
  }
  if (kind === 'disk-full' || /\bENOSPC\b/.test(diagnostic)) return { problem: '磁盘空间不足。', next: '请释放空间后重试。' }
  if (kind === 'permission' || /\b(?:EACCES|EPERM)\b/.test(diagnostic)) return { problem: '应用无权写入安装目录。', next: '请检查目录权限后重试。' }
  if (kind === 'network' || /\b(?:ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b/.test(diagnostic)) return { problem: '暂时无法连接安装源。', next: '请检查网络后重试。' }
  if (kind === 'fetch-timeout' || /\bETIMEDOUT\b/.test(diagnostic)) return { problem: '下载或安装超时。', next: '请稍后重试。' }
  if (kind === 'fetch-404' || /ERR_PNPM_FETCH_404/.test(diagnostic)) return { problem: '安装源未找到所需安装包。', next: '请等待发布者修复后再试。' }
  if (kind === 'no-matching-version') return { problem: '安装源没有所需版本。', next: '请稍后重试。' }
  if (kind === 'pnpm-missing') return { problem: 'Desktop 未找到可用的包管理器。', next: '请检查应用设置后重试。' }
  if (kind === 'build-approval') return { problem: '安装需要批准构建脚本。', next: '请在官方插件页核对并批准后重试。' }
  if (kind === 'unexpected-store' || kind === 'lockfile-outdated' || kind === 'lockfile-broken' || /ERR_PNPM_(?:UNEXPECTED_STORE|OUTDATED_LOCKFILE|LOCKFILE_MISSING_DEPENDENCY)/.test(diagnostic)) {
    return { problem: '安装记录与现有依赖不一致。', next: '请按安装排查说明修复后重试。' }
  }
  if (kind === 'adding-to-root' || kind === 'not-a-workspace') return { problem: '安装位置与当前环境不匹配。', next: '请更新皮肤市场后重试。' }
  if (kind === 'script-timeout') return { problem: '安装脚本运行超时。', next: '请在官方插件页检查后重试。' }
  if (kind === 'integrity' || /完整性|integrity mismatch|ERR_PNPM_TARBALL_INTEGRITY/i.test(diagnostic)) return { problem: '安装包无法通过校验。', next: '请重新下载后再试。' }
  if (/未物化|declared executable artifact missing|(?:package manifest|client export) missing|no executable artifact/i.test(diagnostic)) {
    return { problem: '安装包缺少必要文件。', next: '请等待作者修复后再安装。' }
  }
  if (/Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/i.test(diagnostic)) {
    return { problem: '插件缺少运行所需的文件或依赖。', next: '请等待作者修复后再试。' }
  }
  return { problem: '未能完成本次操作。', next: '请复制日志反馈。' }
}

function isPackagingFailure(message: string): boolean {
  return /bundle patch is missing:/i.test(message) || message.includes('目录元数据与包实际声明不一致')
}

function isEnvironmentFailure(kind: FailureHelpSubject['failureKind']): boolean {
  return kind === 'unexpected-store' || kind === 'fetch-404' || kind === 'adding-to-root' || kind === 'not-a-workspace'
    || kind === 'lockfile-outdated' || kind === 'lockfile-broken' || kind === 'disk-full' || kind === 'permission' || kind === 'pnpm-missing'
}

/** Terminal failures that the market stopped on purpose, not retryable network/build prompts. */
export function isInterceptFailure(operation: { phase?: string; failure?: Operation['failure'] } | null | undefined): boolean {
  if (operation == null || operation.phase !== 'failed') return false
  return operation.failure?.action !== 'retry' && operation.failure?.action !== 'approve-build'
}

export function skinRepositoryBrowseUrl(skin: Pick<CatalogSkin, 'repo' | 'subpath' | 'install'>): string | null {
  const repo = normalizeGitHubRepository(skin.repo)
  if (repo === null) return null
  const commit = skin.install.commit
  if (!/^[0-9a-f]{40}$/i.test(commit)) return repo
  const subpath = (skin.subpath ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
  return subpath === '' ? `${repo}/tree/${commit}` : `${repo}/tree/${commit}/${subpath}`
}

export function failureHelpLinks(options: FailureHelpSubject): FailureHelpLink[] {
  const message = options.message ?? ''
  const skinUrl = options.skin == null ? null : skinRepositoryBrowseUrl(options.skin)
  const skinLink: FailureHelpLink | null = skinUrl === null ? null : { href: skinUrl, label: '打开皮肤仓库' }
  const updateLink: FailureHelpLink = { href: MARKET_MANUAL_UPDATE_URL, label: '查看手动更新' }
  const troubleshootLink: FailureHelpLink = { href: MARKET_INSTALL_TROUBLESHOOT_URL, label: '查看安装排查' }

  if (options.failureKind === 'release-age') return [{ href: MARKET_RELEASE_WAIT_URL, label: '查看处理方法' }]
  if (options.source === 'market-update') {
    return isEnvironmentFailure(options.failureKind) ? [troubleshootLink] : [updateLink]
  }
  if (options.failureKind === 'conflict' || message.includes('发现插件安装冲突')) return []
  if (isEnvironmentFailure(options.failureKind)) return [troubleshootLink]
  if (options.failureKind === 'compatibility' || isPackagingFailure(message)) return skinLink === null ? [] : [skinLink]
  return [troubleshootLink]
}

export function interceptNotice(operation: Operation, skinName: string, skin?: FailureHelpSubject['skin']): InterceptNotice {
  const raw = (operation.failure?.message ?? operation.message ?? '').trim()
  const kind = operationKindLabels[operation.kind]
  const links = failureHelpLinks({
    source: 'skin',
    failureKind: operation.failure?.kind,
    message: raw,
    skin,
  })
  if (operation.failure?.kind === 'release-age' && operation.failure.action === 'approve-release-age' && operation.failure.releaseAgeTarget !== undefined) {
    return {
      title: `${kind}需要允许新版本`,
      what: `${operation.failure.releaseAgeTarget.packageName}@${operation.failure.releaseAgeTarget.version} 仍处于新包保护期。`,
      why: '确认后只允许此版本，并继续本次操作。',
      links: [],
    }
  }
  if (operation.failure?.kind === 'integrity' && operation.failure.action === 'approve-artifact' && operation.failure.artifactRisk !== undefined) {
    return {
      title: `${kind}需要确认构件风险`,
      what: `「${skinName}」的安装包未通过市场核验，使用后可能导致页面异常。`,
      why: '',
      links: [],
    }
  }
  if (operation.application === 'overridden') {
    const enabling = operation.kind === 'activate' || operation.kind === 'pin' || /配置停用|配置禁用|强制禁用/.test(raw)
    return {
      title: `${kind}未完成`,
      what: enabling ? `「${skinName}」被其他设置禁用。` : `「${skinName}」的启停设置被其他设置覆盖。`,
      why: enabling ? '请解除禁用后重新使用。' : '请移除强制设置后重试。',
      links: [{ href: MARKET_CONFIG_OVERRIDE_URL, label: '查看处理方法' }],
    }
  }
  const missingPatch = /bundle patch is missing:\s*(\S+)/.exec(raw)
  if (missingPatch !== null) {
    return {
      title: '已拦截安装',
      what: `「${skinName}」的安装包缺少必要文件。`,
      why: '请等待作者修复后再安装。',
      links,
    }
  }
  if (operation.failure?.kind === 'conflict' || raw.includes('发现插件安装冲突')) {
    return {
      title: '已拦截安装',
      what: `「${skinName}」与已安装插件冲突。`,
      why: '请先在插件页停用或卸载冲突项，再重试。',
      links,
    }
  }
  if (operation.failure?.kind === 'compatibility') {
    return {
      title: `${kind}未完成`,
      what: `「${skinName}」未通过当前 DSH 的兼容检查。`,
      why: '请换用与当前 DSH 兼容的版本。',
      links,
    }
  }
  if (raw.includes('目录元数据与包实际声明不一致')) {
    return {
      title: '已拦截安装',
      what: `「${skinName}」的安装信息与安装包不一致。`,
      why: '请等待市场更新后再试。',
      links,
    }
  }
  const explanation = failureExplanation(operation.failure?.kind, raw)
  return {
    title: `${kind}未完成`,
    what: `「${skinName}」：${explanation.problem}`,
    why: explanation.next,
    links,
  }
}

export function marketUpdateNotice(operation: { failure?: Operation['failure']; message?: string }): InterceptNotice {
  const raw = (operation.failure?.message ?? operation.message ?? '').trim()
  if (operation.failure?.kind === 'release-age' && operation.failure.action === 'approve-release-age' && operation.failure.releaseAgeTarget !== undefined) {
    return {
      title: '更新需要允许新版本',
      what: `${operation.failure.releaseAgeTarget.packageName}@${operation.failure.releaseAgeTarget.version} 仍处于新包保护期。`,
      why: '确认后只允许此版本，并继续本次更新。',
      links: [],
    }
  }
  const explanation = failureExplanation(operation.failure?.kind, raw)
  return {
    title: '皮肤市场更新失败',
    what: explanation.problem,
    why: explanation.next,
    links: failureHelpLinks({ source: 'market-update', failureKind: operation.failure?.kind, message: raw }),
  }
}
