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

function isDiagnosticDump(text: string): boolean {
  return text.startsWith('# dsh-skin-market')
    || text.includes('[info] operation:')
    || text.includes('[error] operation:')
    || text.split('\n').length > 3
}

function displayMessage(raw: string): string {
  const value = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim()
  if (value === '') return ''
  const lines = value.split(/\r?\n| ↵ /).map(line => line.trim()).filter(Boolean)
  const errors = lines.filter(line => /\bERR_[A-Z0-9_]+\b|\b(?:Error|TypeError|RangeError|SyntaxError):|\b(?:ENOENT|EACCES|EPERM|ENOTFOUND|ECONNRESET|ETIMEDOUT)\b|\[error\]|cannot find|not found|failed|denied|错误|失败|未生效|不兼容/i.test(line))
  const terminalCode = lines.findLastIndex(line => /\bERR_[A-Z0-9_]+\b/.test(line))
  const terminalError = lines.findLastIndex(line => /\b(?:Error|TypeError|RangeError|SyntaxError):/.test(line))
  const terminalIndex = terminalCode >= 0 ? terminalCode : terminalError
  const terminalLines: string[] = []
  if (terminalIndex >= 0) {
    terminalLines.push(lines[terminalIndex]!)
    // A terminal pnpm error may put the affected dependency and publication
    // date on the following lines. Those explain why earlier warnings lost.
    for (const line of lines.slice(terminalIndex + 1)) {
      if (/^(?:at\s|Progress:|Packages:)|\[(?:info|warn|error)\]/i.test(line)) break
      terminalLines.push(line)
      if (terminalLines.length === 3) break
    }
  }
  // Native package failures often carry several progress lines before the
  // useful error. Keep a short reason, rather than hiding the whole result.
  const selected = terminalLines.length > 0 ? terminalLines : errors.length > 0 ? errors.slice(0, 2)
    : isDiagnosticDump(value) && (value.startsWith('# dsh-skin-market') || value.includes('[info] operation:')) ? []
      : lines.slice(0, 2)
  return selected
    .map(line => line.replace(/^.*?\[(?:error|warn)\]\s+[^:]+:\s*/, ''))
    .join('\n').slice(0, 480)
}

function isPackagingFailure(message: string): boolean {
  return /bundle patch is missing:/i.test(message) || message.includes('目录元数据与包实际声明不一致')
}

function isEnvironmentFailure(kind: FailureHelpSubject['failureKind']): boolean {
  return kind === 'unexpected-store' || kind === 'fetch-404' || kind === 'adding-to-root' || kind === 'not-a-workspace'
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
  return [skinLink, troubleshootLink].filter((link): link is FailureHelpLink => link !== null)
}

export function interceptNotice(operation: Operation, skinName: string, skin?: FailureHelpSubject['skin']): InterceptNotice {
  const raw = (operation.failure?.message ?? operation.message ?? '').trim()
  const message = displayMessage(raw)
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
      what: '本机 Desktop 的新包保护拦住了本次操作。',
      why: '允许后，皮肤市场只放行下方这个精确版本，并继续本次操作。',
      links,
    }
  }
  if (operation.application === 'overridden') {
    const enabling = operation.kind === 'activate' || operation.kind === 'pin' || /配置停用|配置禁用|强制禁用/.test(raw)
    return {
      title: `${kind}未完成`,
      what: enabling ? `「${skinName}」被其他设置禁用。` : `「${skinName}」的启停设置被其他配置覆盖。`,
      why: enabling ? '请解除该皮肤的禁用设置后，再点“使用”。' : '请移除该皮肤的强制设置后重试。',
      links: [{ href: MARKET_CONFIG_OVERRIDE_URL, label: '查看处理方法' }],
    }
  }
  const missingPatch = /bundle patch is missing:\s*(\S+)/.exec(raw)
  if (missingPatch !== null) {
    return {
      title: '已拦截安装',
      what: `市场已经下载「${skinName}」，但安装包里缺少 DSH 用来注册插件的 ${missingPatch[1]}，所以没有改动你的 profile。`,
      why: '这个皮肤的 package.json 声明了 dsh.bundle.patch，但打包进安装源时没有带上该文件。常见原因是 files 白名单漏了 cordis.patch.yml。这是皮肤仓库的打包问题，不是本机环境损坏；需要作者补上文件后重新发布，才能一键安装。',
      links,
    }
  }
  if (operation.failure?.kind === 'conflict' || message.includes('发现插件安装冲突')) {
    return {
      title: '已拦截安装',
      what: `「${skinName}」没有装上，因为当前 profile 里已有其他皮肤占用了相同的插件入口。`,
      why: message || '请先在皮肤市场停用或卸载冲突的皮肤，然后再试。',
      links,
    }
  }
  if (operation.failure?.kind === 'compatibility') {
    return {
      title: `${kind}未完成`,
      what: `DSH 宿主未通过「${skinName}」的插件兼容检查。`,
      why: `${message || '插件自身声明的依赖范围与当前 DSH 版本不匹配。'} 市场的风险确认允许尝试操作，宿主仍会检查插件自身的依赖要求。`,
      links,
    }
  }
  if (message.includes('目录元数据与包实际声明不一致')) {
    return {
      title: '已拦截安装',
      what: `市场已经检查「${skinName}」的安装包，发现它和目录记录的插件入口不一致，所以没有写入 profile。`,
      why: message,
      links,
    }
  }
  return {
    title: `${kind}未完成`,
    what: `「${skinName}」${kind}未完成。`,
    why: message || '未能获取具体原因，请复制日志反馈。',
    links,
  }
}

export function marketUpdateNotice(operation: { failure?: Operation['failure']; message?: string }): InterceptNotice {
  const raw = (operation.failure?.message ?? operation.message ?? '').trim()
  const message = displayMessage(raw)
  if (operation.failure?.kind === 'release-age' && operation.failure.action === 'approve-release-age' && operation.failure.releaseAgeTarget !== undefined) {
    return {
      title: '更新需要允许新版本',
      what: '本机 Desktop 的新包保护拦住了市场更新。',
      why: '允许后，皮肤市场只放行下方这个精确版本，并继续本次更新。',
      links: failureHelpLinks({ source: 'market-update', failureKind: 'release-age' }),
    }
  }
  return {
    title: '皮肤市场更新失败',
    what: '',
    why: message || '未能获取具体原因，请复制日志反馈。',
    links: failureHelpLinks({ source: 'market-update', failureKind: operation.failure?.kind, message: raw }),
  }
}
