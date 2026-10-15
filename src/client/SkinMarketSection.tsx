import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { SquaresFourIcon, UploadSimpleIcon, XIcon } from '@phosphor-icons/react'
import { MarkGithubIcon, StarIcon } from '@primer/octicons-react'
import * as primitiveExports from '@deepseek-ai/dsh-client-ui-primitives'
import {
  Button,
  Input,
  Modal,
  Pill,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SkinMarket.module.css'
import './media-hover.module.css'
import { compareCatalogOrder, getCatalogListScreenshot, getCatalogScreenshotUrls, hasCatalogPreview, usesMarketScreenshots } from '../catalog-order.ts'
import { generatedMediaFor, generatedMediaManifestUrl, generatedMediaUrl, parseGeneratedMediaManifest, previewSourceCandidates, setGeneratedMediaSources } from '../media-preview.ts'
import { useLazyMedia } from '../media-visibility.ts'
import { browserCatalogCache, type CatalogCache } from './catalog-cache.ts'
import { interceptNotice, isInterceptFailure, marketUpdateNotice } from './failure-help.ts'
import { CLI_INSTALL_WARNING, createSkinInstallCommand, createSkinInstallPrompt, createSkinInstallSearchKeyword, createSubmissionPrompt, REGISTRY_REPOSITORY } from './submission.ts'
import { switchClientSkin, type ClientSkinRuntime } from './index.ts'
import { displayTitle, githubRepoLabel } from '../display-title.ts'
import { assessCompatibility, compatibilityContext as skinCompatibilityContext, type CompatibilityAssessment } from '../compatibility.ts'
import { matchesCatalogSearch } from '../catalog-search.ts'
import type { CatalogSkin, DshRuntime, InstalledClientPlugin, MarketHostKind, Operation, RuntimeSkin } from './types.ts'

export { interceptNotice, isInterceptFailure, marketUpdateNotice }
export type { InterceptNotice } from './failure-help.ts'

interface PrimitiveIconProps {
  size?: number
  className?: string
}

type PrimitiveIcon = ComponentType<PrimitiveIconProps>

const missingPrimitiveIcon: PrimitiveIcon = () => null

/**
 * DSH 0.1.7-alpha.1 renamed the size-suffixed icon exports to Regular/Medium.
 * Resolve the new name first while retaining the rc.6 name for existing hosts.
 */
export function resolvePrimitiveIcon(module: Record<string, unknown>, currentName: string, legacyName: string): PrimitiveIcon {
  for (const name of [currentName, legacyName]) {
    const candidate = module[name]
    if (typeof candidate === 'function') return candidate as PrimitiveIcon
  }
  return missingPrimitiveIcon
}

const primitiveModule = primitiveExports as unknown as Record<string, unknown>
const IconChevronLeftOutline = resolvePrimitiveIcon(primitiveModule, 'IconChevronLeftOutlineRegular', 'IconChevronLeftOutline14')
const IconChevronDownOutline = resolvePrimitiveIcon(primitiveModule, 'IconChevronDownOutlineRegular', 'IconChevronDownOutline14')
const IconCopyOutline = resolvePrimitiveIcon(primitiveModule, 'IconCopyOutlineRegular', 'IconCopyOutline16')
const IconDownloadOutline = resolvePrimitiveIcon(primitiveModule, 'IconDownloadOutlineRegular', 'IconDownloadOutline16')
const IconLoadingOutline = resolvePrimitiveIcon(primitiveModule, 'IconLoadingOutlineRegular', 'IconLoadingOutline16')
const IconRefreshOutline = resolvePrimitiveIcon(primitiveModule, 'IconRefreshOutlineRegular', 'IconRefreshOutline16')
const IconSearchOutline = resolvePrimitiveIcon(primitiveModule, 'IconSearchOutlineRegular', 'IconSearchOutline16')
const IconTrashOutline = resolvePrimitiveIcon(primitiveModule, 'IconTrashOutlineRegular', 'IconTrashOutline16')

export interface SkinMarketSectionProps {
  t: (key: string) => string
  layout?: 'fill' | 'embedded'
  clientRuntime?: ClientSkinRuntime
  catalogCache?: CatalogCache
}

type MutationKind = Operation['kind']
type CompatibilityConsent = { decision: 'not-required' | 'cancelled' } | { decision: 'accepted'; context: string }

interface CompatibilityConfirmation {
  skin: CatalogSkin
  assessment: CompatibilityAssessment
  actionLabel: string
  context: string
  changed?: boolean
}

interface SkinOperationOptions {
  compatibilityContext?: string
  installAndUse?: boolean
}

interface CatalogResponse {
  skins: CatalogSkin[]
}

interface ListScrollAnchor { skinId: string | null; offset: number; scrollTop: number }
type RestartTarget = { kind: 'skin'; skinId: string } | { kind: 'market-update' }

interface PendingRestartNotice {
  target: RestartTarget
  startedAt: string
  title: string
  description?: string
  source?: 'client'
  instanceId?: string
}

export function captureListScroll(list: HTMLElement | null): ListScrollAnchor | null {
  if (list === null) return null
  const listTop = list.getBoundingClientRect().top
  const card = [...list.querySelectorAll<HTMLElement>('[data-skin-id]')].find(item => item.getBoundingClientRect().bottom > listTop)
  return { skinId: card?.dataset.skinId ?? null, offset: card === undefined ? 0 : card.getBoundingClientRect().top - listTop, scrollTop: list.scrollTop }
}

export function restoreListScroll(list: HTMLElement | null, anchor: ListScrollAnchor | null): void {
  if (list === null || anchor === null) return
  const card = anchor.skinId === null ? undefined : [...list.querySelectorAll<HTMLElement>('[data-skin-id]')].find(item => item.dataset.skinId === anchor.skinId)
  if (card === undefined) list.scrollTop = anchor.scrollTop
  else list.scrollTop += card.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset
}

interface MarketStateResponse {
  instanceId?: string
  restartNoticeId?: string
  marketUpdateNoticeId?: string
  hostKind?: MarketHostKind
  runtime?: DshRuntime
  restartAvailable?: boolean
  skins: RuntimeSkin[]
  operation?: Operation | null
  operations?: Operation[]
  marketUpdateOperation?: MarketUpdateOperation | null
  installedClientPlugins?: InstalledClientPlugin[]
  runningAgentCount?: number
  marketUpdateRestartRequired?: boolean
  management?: { official: boolean; installRequiresRestart?: boolean; capabilities: Record<'install' | 'update' | 'enable' | 'disable' | 'remove', { available: boolean; reason?: string }> }
  profileBusy?: string
}

interface MarketUpdateStatus {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
}

interface MarketUpdateOperation {
  id: string
  phase: 'queued' | 'checking' | 'downloading' | 'installing' | 'waiting' | 'cancelling' | 'cancelled' | 'done' | 'failed'
  message?: string
  status?: MarketUpdateStatus
  cancelable?: boolean
  downloadedBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  failure?: Operation['failure']
  startedAt: string
  finishedAt?: string
}

const phases: Record<Operation['phase'], string> = {
  queued: '正在排队', resolving: '正在解析版本', downloading: '正在下载', installing: '正在安装', validating: '正在验证', activating: '正在切换', waiting: '等待宿主确认', cancelling: '正在取消', cancelled: '已取消', done: '完成', failed: '操作失败',
}

const DESKTOP_INSTALL_RESTART_GUIDANCE = '安装并切换完成后，请手动重启 Desktop App。'

function pendingRestartTitle(title: string, restartAvailable: boolean): string {
  return `${title}，${restartAvailable ? '待重启生效' : '请手动重启 Desktop App 后生效'}`
}

function skinOperationTitle(operation: Operation, name: string): string {
  if (operation.phase === 'installing') {
    if (operation.step === '恢复原有 profile 依赖') return `正在恢复原有依赖 · ${name}`
    if (operation.kind === 'update') return `正在更新“${name}”`
    if (operation.kind === 'uninstall') return `正在卸载“${name}”`
    if (operation.kind === 'migrate') return `正在换用 npm · ${name}`
  }
  return `${phases[operation.phase]}“${name}”`
}

const PROFILE_PNPM_KINDS = new Set<Operation['kind']>(['install', 'update', 'migrate', 'uninstall'])

function isTerminalOperation(operation: Operation): boolean {
  return operation.phase === 'done' || operation.phase === 'failed' || operation.phase === 'cancelled'
}

function isLiveOperation(operation: Operation): boolean {
  return !isTerminalOperation(operation)
}

function pendingOperationId(skinId: string): string {
  return `pending:${skinId}`
}

function upsertOperation(list: readonly Operation[], operation: Operation): Operation[] {
  const pendingId = pendingOperationId(operation.skinId)
  const index = list.findIndex(item => item.id === operation.id || (item.id === pendingId && isLiveOperation(item)))
  if (index < 0) return [...list, operation]
  const next = [...list]
  next[index] = operation
  return next
}

function liveOperationFor(list: readonly Operation[], skinId: string): Operation | undefined {
  return list.find(operation => operation.skinId === skinId && isLiveOperation(operation))
}

function livePnpmOperations(list: readonly Operation[]): Operation[] {
  return list.filter(operation => isLiveOperation(operation) && PROFILE_PNPM_KINDS.has(operation.kind))
}

function restartBlockedByInstalls(operations: readonly Operation[], skins: readonly CatalogSkin[]): string | null {
  const blocking = livePnpmOperations(operations)
  if (blocking.length === 0) return null
  const names = blocking.map(operation => skins.find(skin => skin.id === operation.skinId)?.name.zh ?? operation.skinId)
  return `还有 ${blocking.length} 款皮肤正在安装或更新（${names.join('、')}）。重启会中断这些操作：下载会丢失，正在写入 profile 时还可能留下损坏的依赖。请等待完成或先取消。`
}

function elapsedLabel(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

function byteLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

interface ProgressMetadata {
  downloadedBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  step?: string
  stepStartedAt?: string
  attempt?: number
  lastOutputAt?: string
  pnpmStage?: Operation['pnpmStage']
}

const pnpmStages: Record<NonNullable<Operation['pnpmStage']>, string> = {
  resolving: '解析依赖', downloading: '下载依赖', linking: '链接依赖', building: '运行构建',
}

function isDiagnosticDump(text: string): boolean {
  return text.startsWith('# dsh-skin-market')
    || text.includes('[info] operation:')
    || text.includes('[error] operation:')
    || text.split('\n').length > 3
}

function operationMeta(operation: ProgressMetadata, now: number): string[] {
  const details: string[] = []
  if (operation.step !== undefined) details.push(operation.step)
  else if (operation.pnpmStage !== undefined) details.push(pnpmStages[operation.pnpmStage])
  if (operation.attempt !== undefined && operation.attempt > 1) details.push(`第 ${operation.attempt} 次尝试`)
  if (operation.downloadedBytes !== undefined && operation.totalBytes !== undefined) {
    details.push(`${byteLabel(operation.downloadedBytes)} / ${byteLabel(operation.totalBytes)}`)
  } else if (operation.downloadedBytes !== undefined) {
    details.push(`已下载 ${byteLabel(operation.downloadedBytes)}`)
  }
  const outputAge = operation.lastOutputAt === undefined ? undefined : now - Date.parse(operation.lastOutputAt)
  if (operation.bytesPerSecond !== undefined && operation.bytesPerSecond > 0 && (outputAge === undefined || outputAge < 5000)) {
    details.push(`${byteLabel(operation.bytesPerSecond)}/s`)
  }
  return details
}

function recoveryActionLabel(action: 'retry' | 'approve-build' | undefined): string | undefined {
  if (action === 'approve-build') return '批准构建并重试'
  if (action === 'retry') return '重试'
  return undefined
}

function desktopManualReasonLabel(reason: string | undefined): string {
  if (reason === undefined) return '未提供可用的 Desktop 安装包'
  return {
    'npm-package-not-found': '未找到可供 Desktop 安装的 npm 包',
    'npm-repository-mismatch': 'npm 包仓库与固定版本不一致',
    'npm-source-unverified': 'npm 来源未核验',
    'npm-version-mismatch': 'npm 包版本与固定版本不一致',
  }[reason] ?? reason
}

const mutationLabels: Record<MutationKind, string> = {
  install: '安装中', activate: '使用中', deactivate: '停用中', pin: '设置常驻中', unpin: '取消常驻中', update: '更新中', migrate: '正在换用 npm', uninstall: '卸载中',
}

const marketOperationTitles: Record<MarketUpdateOperation['phase'], string> = {
  queued: '正在排队更新皮肤市场', checking: '正在检查皮肤市场更新', downloading: '正在下载皮肤市场', installing: '正在写入皮肤市场', waiting: '等待宿主确认市场更新', cancelling: '正在取消皮肤市场更新', cancelled: '皮肤市场更新已取消', done: '皮肤市场更新完成', failed: '皮肤市场更新失败',
}

interface OperationBannerProps {
  title: string
  startedAt: string
  metadata?: string[]
  progress?: ProgressMetadata
  message?: string
  showMessage?: boolean
  downloading?: boolean
  cancelable?: boolean
  terminal?: boolean
  failed?: boolean
  operationId?: string
  copyingLog?: boolean
  copiedLog?: boolean
  className?: string
  onCancel?: () => void
  onCopyLog?: () => void
  onDismiss?: () => void
  action?: ReactNode
}

function OperationBanner({ title, startedAt, metadata = [], progress, message, showMessage = false, downloading = false, cancelable = false, terminal = false, failed = false, operationId, copyingLog = false, copiedLog = false, className, onCancel, onCopyLog, onDismiss, action }: OperationBannerProps) {
  const [now, setNow] = useState(Date.now())
  const [showDetails, setShowDetails] = useState(false)
  const detailsId = useId()
  useEffect(() => {
    if (terminal) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt, terminal])
  const outputStartedAt = progress?.stepStartedAt ?? (progress?.step === undefined ? undefined : startedAt)
  const lastOutputTime = Math.max(...[progress?.lastOutputAt, outputStartedAt]
    .filter((value): value is string => value !== undefined)
    .map(value => Date.parse(value)))
  const silentFor = Number.isFinite(lastOutputTime) ? now - lastOutputTime : 0
  const details = failed ? [] : [...new Set([
    ...metadata,
    ...(progress === undefined ? [] : operationMeta(progress, now)),
    ...(!terminal ? [`已用时 ${elapsedLabel(startedAt, now)}`] : []),
    ...(!terminal && silentFor >= 30_000 ? [`已 ${elapsedLabel(new Date(lastOutputTime).toISOString(), now)}未有输出`] : []),
  ].filter(item => item !== ''))]
  const normalize = (value: string) => value.replace(/\s+/g, '')
  const normalizedMessage = message === undefined ? '' : normalize(message)
  const messageText = !failed
    && message !== undefined
    && !isDiagnosticDump(message)
    && message !== title
    && normalizedMessage !== ''
    && ![title, ...details].some(item => {
      const normalizedItem = normalize(item)
      return normalizedItem === normalizedMessage || normalizedItem.includes(normalizedMessage) || normalizedMessage.includes(normalizedItem)
    })
    ? message
    : undefined
  const canCopyLog = (!terminal || failed) && onCopyLog !== undefined && operationId !== undefined
  const hasDetails = details.length > 0 || (!showMessage && messageText !== undefined) || (canCopyLog && !failed)
  const downloadProgress = downloading && progress?.downloadedBytes !== undefined
    ? progress.totalBytes === undefined ? `已下载 ${byteLabel(progress.downloadedBytes)}` : `${byteLabel(progress.downloadedBytes)} / ${byteLabel(progress.totalBytes)}`
    : undefined
  const copyLogButton = canCopyLog && <Button className={css.operationCopyLog} variant="outline" size="sm" icon={<IconCopyOutline />} disabled={copyingLog} onClick={onCopyLog}>{copiedLog ? '日志已复制' : copyingLog ? '复制中…' : '复制日志'}</Button>
  return <div className={`${css.operation}${className === undefined ? '' : ` ${className}`}`} role="status" aria-live="polite" data-terminal={terminal ? 'true' : undefined} data-failed={failed ? 'true' : undefined}>
    {terminal ? <IconRefreshOutline size={16} /> : <IconLoadingOutline size={16} />}
    <strong title={title}>{title}</strong>
    {downloadProgress !== undefined && <small className={css.operationElapsed}>{downloadProgress}</small>}
    {!terminal && <small className={css.operationElapsed} aria-hidden="true" title={`已用时 ${elapsedLabel(startedAt, now)}`}>· {elapsedLabel(startedAt, now)}</small>}
    <span className={css.operationActions}>
      {cancelable && onCancel !== undefined && <Button className={css.operationCancel} variant="outline" size="sm" onClick={onCancel}>取消</Button>}
      {hasDetails && <Button variant="ghost" size="sm" aria-expanded={showDetails} aria-controls={detailsId} onClick={() => setShowDetails(value => !value)}>{showDetails ? '收起' : '详情'}</Button>}
      {failed && copyLogButton}
      {action}
      {onDismiss !== undefined && <Button className={css.operationDismiss} variant="ghost" size="sm" icon={<XIcon size={14} />} aria-label="关闭提示" title="关闭提示" onClick={onDismiss} />}
    </span>
    {showMessage && messageText !== undefined && <span className={css.operationMessage}>{messageText}</span>}
    {hasDetails && <div id={detailsId} className={css.operationDetails} hidden={!showDetails} aria-live="off">
      <div className={css.operationDiagnostics}>
        {!showMessage && messageText !== undefined && <p>{messageText}</p>}
        <div className={css.operationMeta}>{details.map(item => <small key={item}>{item}</small>)}</div>
      </div>
      {!failed && copyLogButton}
    </div>}
  </div>
}

const RELOAD_PARAM = 'dsh-skin-reload'
const ACTIVATION_WARNING_KEY = 'dsh-skin-market:activation-warning-accepted'
const RESTART_PROMPTS_KEY = 'dsh-skin-market:restart-prompts'

function restartPromptKey(state: MarketStateResponse, target: RestartTarget): string {
  return target.kind === 'skin'
    ? JSON.stringify([target.kind, target.skinId, state.restartNoticeId ?? 'legacy', runtimeFor(state.skins, target.skinId).installedVersion])
    : JSON.stringify([target.kind, '', state.marketUpdateNoticeId ?? 'legacy'])
}
const RESET_HELP_URL = `${REGISTRY_REPOSITORY}#页面异常时重置皮肤`

function ResetHelpLink() {
  return <a href={RESET_HELP_URL} target="_blank" rel="noreferrer">页面异常时重置皮肤</a>
}

function CompatibilityWarningNote({ assessment }: { assessment: CompatibilityAssessment }) {
  return <p className={css.notice} role="note">{assessment.reason}。仍可继续使用；若页面异常，请查看 <ResetHelpLink />。</p>
}
export const CATALOG_BATCH_SIZE = 20
const GALLERY_INTERVAL_MS = 5600
const HOME_COMPACT_ENTER_SCROLL = 72
const HOME_COMPACT_EXIT_SCROLL = 16

export const RESTART_POLL_MS = 500
export const RESTART_WAIT_MS = 90_000

export function restartReloadUrl(href: string, instanceId: string): string {
  const url = new URL(href)
  url.searchParams.set(RELOAD_PARAM, instanceId)
  return url.toString()
}

export function restartDocumentProbeUrl(href: string): string {
  const url = new URL(href)
  url.searchParams.delete(RELOAD_PARAM)
  return url.toString()
}

export interface RestartDocumentPoll {
  instanceId: string
}

/**
 * DSH answers named plugin routes as soon as they register, but `/` 404s
 * until frontend-static claims the fallback seat. Wait for both a new
 * instanceId and a 200 on the current document before cache-busting.
 */
export async function waitForRestartDocument(input: {
  acceptedInstanceId: string
  href: string
  deadlineMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  fetchState: () => Promise<RestartDocumentPoll>
  fetchDocument: (url: string) => Promise<{ ok: boolean }>
}): Promise<string> {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const deadline = now() + (input.deadlineMs ?? RESTART_WAIT_MS)
  const pollMs = input.pollMs ?? RESTART_POLL_MS
  const probe = restartDocumentProbeUrl(input.href)
  while (now() < deadline) {
    await sleep(pollMs)
    try {
      const next = await input.fetchState()
      if (next.instanceId === input.acceptedInstanceId) continue
      if ((await input.fetchDocument(probe)).ok) return restartReloadUrl(input.href, next.instanceId)
    } catch {
      // The old process is releasing its port, or the SPA fallback is not up.
    }
  }
  throw new Error('DeepSeek Harness 重启超时，请手动刷新页面')
}

export function restoreMarketStyleOrder(root: ParentNode = document, marker = css.filterPill): void {
  for (const style of root.querySelectorAll<HTMLStyleElement>('style')) {
    const ownsMarketCss = style.dataset.plugin === 'dsh-skin-market'
      || style.textContent?.includes(`.${marker}`) === true
    if (ownsMarketCss) style.parentNode?.appendChild(style)
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  let body: T & { error?: string }
  try {
    body = await response.json() as T & { error?: string }
  } catch {
    throw new Error(response.ok
      ? '皮肤市场服务未返回有效数据，请确认 Host 插件已经更新'
      : `皮肤市场请求失败（${url}，HTTP ${response.status}）`)
  }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof writeClipboard === 'function' && await writeClipboard(text)) return
  // Keep older DSH primitive hosts usable if they predate writeClipboard.
  if (navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch { /* report the same clear error below */ }
  }
  throw new Error('当前页面没有可用的剪贴板权限')
}

function runtimeFor(states: RuntimeSkin[], id: string): RuntimeSkin {
  return states.find(item => item.skinId === id) ?? {
    skinId: id, installation: 'missing', activation: 'inactive', primary: false, pinned: false, installedVersion: null, installedAt: null, lastOperatedAt: null, updateAvailable: false,
  }
}

function preferredSelectedId(current: string, skins: CatalogSkin[], runtimeStates: RuntimeSkin[], userSelected: boolean): string {
  const active = runtimeStates.find(item => item.primary) ?? runtimeStates.find(item => item.activation === 'active')
  const activeId = active !== undefined && skins.some(skin => skin.id === active.skinId) ? active.skinId : null
  if (!userSelected && activeId !== null) return activeId
  if (current !== '' && skins.some(skin => skin.id === current)) return current
  return skins[0]?.id ?? ''
}

function canPaintInstalledSection(skins: CatalogSkin[], runtimeReady: boolean, runtimeStates: RuntimeSkin[], catalogSettled: boolean): boolean {
  if (!runtimeReady) return false
  if (skins.length > 0 || catalogSettled) return true
  return !runtimeStates.some(item => item.installation !== 'missing')
}

function statusLabel(state: RuntimeSkin): string {
  if (state.installation === 'broken') return '安装异常'
  if (state.pinned && state.activation === 'active') return '常驻'
  if (state.activation === 'active') return '正在使用'
  if (state.activation === 'switching') return '正在加载'
  if (state.activation === 'restart-required') return '需要重启'
  if (state.activation === 'unavailable') return '未生效'
  if (state.installation === 'installed') return '已安装'
  return '未安装'
}

function compactStatusLabel(state: RuntimeSkin): string {
  if (state.pinned && state.activation === 'active') return '常驻'
  if (state.activation === 'active') return '使用中'
  if (state.activation === 'switching') return '正在加载'
  if (state.activation === 'restart-required') return '待重启'
  if (state.activation === 'unavailable') return '未生效'
  if (state.installation === 'broken') return '安装异常'
  if (state.installation === 'installed') return '已安装'
  return '未安装'
}

function StatusLabel({ active = false, children }: { active?: boolean; children: ReactNode }) {
  return <span className={css.statusLabel} data-active={active ? 'true' : undefined}>{children}</span>
}

function installCompatibility(skin: CatalogSkin, hostKind: MarketHostKind, runtime: DshRuntime | null): CompatibilityAssessment | null {
  if (hostKind !== 'dsh') return null
  if (runtime === null) return {
    decision: 'unknown',
    reason: '无法读取当前 DSH 版本，安装结果需自行确认',
    adapterIds: [],
  }
  return assessCompatibility(skin, runtime)
}

function advisoryCompatibility(skin: CatalogSkin, hostKind: MarketHostKind, runtime: DshRuntime | null): CompatibilityAssessment | null {
  const assessment = installCompatibility(skin, hostKind, runtime)
  return assessment?.decision === 'incompatible' || assessment?.decision === 'unknown' ? assessment : null
}

function displayDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '未知' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(date)
}

/**
 * `screenshots` can contain a GitHub repository card for entries that have no
 * usable preview. Market-supplemented screenshots are real previews even if
 * the upstream entry still carries the repository-card marker.
 */
export function hasSkinPreview(skin: Pick<CatalogSkin, 'review' | 'marketScreenshots' | 'listScreenshot' | 'screenshots'>): boolean {
  return hasCatalogPreview(skin)
}

export function compareSkinOrder(a: CatalogSkin, b: CatalogSkin, sortBy: 'stars' | 'latest'): number {
  return compareCatalogOrder(a, b, sortBy, skin => skin.githubStars, skin => skin.releaseUpdatedAt)
}

export function compareInstalledSkinOrder(a: CatalogSkin, b: CatalogSkin, states: RuntimeSkin[]): number {
  const aState = runtimeFor(states, a.id)
  const bState = runtimeFor(states, b.id)
  const priority = (state: RuntimeSkin) => state.primary === true ? 0 : state.pinned === true ? 1 : 2
  const priorityDifference = priority(aState) - priority(bState)
  if (priorityDifference !== 0) return priorityDifference
  const aTime = Date.parse(aState.lastOperatedAt ?? aState.installedAt ?? '')
  const bTime = Date.parse(bState.lastOperatedAt ?? bState.installedAt ?? '')
  const recentDifference = (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0)
  return recentDifference || a.name.zh.localeCompare(b.name.zh, 'zh-CN') || a.id.localeCompare(b.id)
}

interface PreviewMediaProps {
  skin: CatalogSkin
  src?: string
  fallbackSources?: readonly string[]
  alt: string
  kind: 'list' | 'avatar' | 'hero' | 'thumbnail' | 'recommendation'
  loading?: 'eager' | 'lazy'
}

function PreviewMedia({ skin, src, fallbackSources, alt, kind, loading }: PreviewMediaProps) {
  const candidates = previewSourceCandidates(src, fallbackSources)
  const candidateKey = candidates.join('\u0001')
  const [sourceIndex, setSourceIndex] = useState(0)
  const [failed, setFailed] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [fullFailed, setFullFailed] = useState(false)
  const lazyMedia = useLazyMedia(loading)
  useEffect(() => {
    setSourceIndex(0)
    setFailed(false)
    setPreviewFailed(false)
    setFullFailed(false)
  }, [candidateKey])
  const activeIndex = Math.min(sourceIndex, Math.max(0, candidates.length - 1))
  const activeSrc = candidates[activeIndex]
  const tryNextSource = () => {
    if (fallbackSources !== undefined && activeIndex + 1 < candidates.length) {
      setSourceIndex(activeIndex + 1)
      setPreviewFailed(false)
      setFullFailed(false)
    } else setFailed(true)
  }
  const placeholder = !hasCatalogPreview(skin) || activeSrc === undefined || failed
  if (placeholder) return <div className={css.previewPlaceholder} data-preview-kind={kind} role="img" aria-label={`${skin.name.zh} 暂无界面截图`}><MarkGithubIcon aria-hidden="true" /><strong>{skin.author}</strong><small>暂无界面截图</small></div>
  if (!lazyMedia.visible) return <span ref={lazyMedia.ref} className={css.mediaLazyPlaceholder} role="img" aria-label={alt} />
  const media = generatedMediaFor(skin, activeSrc, kind)
  if (media === undefined) return <img src={activeSrc} alt={alt} loading={loading} decoding="async" onLoad={event => { event.currentTarget.dataset.loaded = 'true' }} onError={tryNextSource} />
  const showFull = kind === 'hero'
  if (showFull) {
    if (fullFailed) return <img src={activeSrc} alt={alt} loading={loading} decoding="async" onError={tryNextSource} />
    return <img src={generatedMediaUrl(media.full)} alt={alt} loading={loading === 'lazy' ? 'lazy' : 'eager'} decoding="async" onError={() => setFullFailed(true)} />
  }
  const imageSource = previewFailed ? activeSrc : generatedMediaUrl(media.preview)
  return <img src={imageSource} alt={alt} loading={loading} decoding="async" onLoad={event => { event.currentTarget.dataset.loaded = 'true' }} onError={() => { if (previewFailed) tryNextSource(); else setPreviewFailed(true) }} />
}

function GalleryPreloads({ skin, screenshots }: { skin: CatalogSkin; screenshots: string[] }) {
  return <>{screenshots.map((source, index) => {
    const media = generatedMediaFor(skin, source, 'hero')
    return media === undefined ? null : <link key={`${source}:${index}`} rel="preload" as="image" href={generatedMediaUrl(media.full)} />
  })}</>
}

const healthLabels = {
  readmeScreenshots: 'README 截图',
  compatibility: '兼容版本',
  installation: '市场安装就绪',
  installCommand: '安装命令',
  topic: 'dsh-plugin Topic',
} as const

export function SkinMarketSection({ t, layout = 'fill', clientRuntime, catalogCache = browserCatalogCache }: SkinMarketSectionProps) {
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [skins, setSkins] = useState<CatalogSkin[]>([])
  const [states, setStates] = useState<RuntimeSkin[]>([])
  const [hostKind, setHostKind] = useState<MarketHostKind>('dsh')
  const [runtime, setRuntime] = useState<DshRuntime | null>(null)
  const [management, setManagement] = useState<MarketStateResponse['management']>()
  const officialDesktop = hostKind === 'desktop' && management?.official === true
  const installRequiresRestart = hostKind === 'desktop' && management?.official === true && management.installRequiresRestart === true
  const [profileBusy, setProfileBusy] = useState<string>()
  const marketWriteReason = profileBusy ?? (management?.capabilities.update.available === false ? management.capabilities.update.reason ?? '当前宿主不支持更新' : undefined)
  const [restartAvailable, setRestartAvailable] = useState(true)
  const [installedClientPlugins, setInstalledClientPlugins] = useState<InstalledClientPlugin[]>([])
  const [loading, setLoading] = useState(true)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string>('')
  const [query, setQuery] = useState('')
  const [homeQuery, setHomeQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'installed'>('all')
  const [sortBy, setSortBy] = useState<'stars' | 'latest'>('stars')
  const [visibleCount, setVisibleCount] = useState(CATALOG_BATCH_SIZE)
  const [homeVisibleCount, setHomeVisibleCount] = useState(CATALOG_BATCH_SIZE)
  const [installedSlots, setInstalledSlots] = useState(5)
  const [shotIndex, setShotIndex] = useState(0)
  const [galleryPaused, setGalleryPaused] = useState(false)
  const [carouselEpoch, setCarouselEpoch] = useState(0)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [operations, setOperations] = useState<Operation[]>([])
  const [error, setError] = useState<string | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  const [confirmMigration, setConfirmMigration] = useState<{ skin: CatalogSkin; source: NonNullable<RuntimeSkin['sourceMigration']> } | null>(null)
  const [confirmPin, setConfirmPin] = useState(false)
  const [activationWarningAccepted, setActivationWarningAccepted] = useState(() => {
    try { return window.localStorage.getItem(ACTIVATION_WARNING_KEY) === 'true' } catch { return false }
  })
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [runningAgents, setRunningAgents] = useState<number | null>(null)
  const [restartCheckFinished, setRestartCheckFinished] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserOrigin, setBrowserOrigin] = useState<'discover' | 'installed'>('discover')
  const [showSubmission, setShowSubmission] = useState(false)
  const [submissionCopied, setSubmissionCopied] = useState(false)
  const [showInstallOptions, setShowInstallOptions] = useState(false)
  const [installCopied, setInstallCopied] = useState<string | null>(null)
  const [marketUpdate, setMarketUpdate] = useState<MarketUpdateStatus | null>(null)
  const [marketOperation, setMarketOperation] = useState<MarketUpdateOperation | null>(null)
  const [copyingLogId, setCopyingLogId] = useState<string | null>(null)
  const [copiedLogId, setCopiedLogId] = useState<string | null>(null)
  const [copyLogError, setCopyLogError] = useState<string | null>(null)
  const [dismissedBuildApprovalId, setDismissedBuildApprovalId] = useState<string | null>(null)
  const [marketUpdating, setMarketUpdating] = useState(false)
  const [restartTarget, setRestartTarget] = useState<RestartTarget | null>(null)
  const [pendingRestart, setPendingRestart] = useState<PendingRestartNotice | null>(null)
  const [compatibilityWarning, setCompatibilityWarning] = useState<CompatibilityAssessment | null>(null)
  const [compatibilityConfirmation, setCompatibilityConfirmation] = useState<CompatibilityConfirmation | null>(null)
  const compatibilityConsentResolver = useRef<((context: string | null) => void) | null>(null)
  const compatibilityConfirmationRef = useRef<CompatibilityConfirmation | null>(null)
  const [homeCompact, setHomeCompact] = useState(false)
  const [homeHeaderSticky, setHomeHeaderSticky] = useState(true)
  const skinListRef = useRef<HTMLDivElement | null>(null)
  const homeRef = useRef<HTMLDivElement | null>(null)
  const homeHeaderRef = useRef<HTMLElement | null>(null)
  const homeLoadMoreRef = useRef<HTMLDivElement | null>(null)
  const thumbnailStripRef = useRef<HTMLDivElement | null>(null)
  const detailRef = useRef<HTMLElement | null>(null)
  const pendingScrollAnchor = useRef<ListScrollAnchor | null>(null)
  const thumbnailScrollRequest = useRef(false)
  const marketUpdatePolls = useRef(new Set<string>())
  const restartPrompts = useRef(new Set<string>())
  const latestMarketState = useRef<MarketStateResponse | null>(null)
  const pendingRestartRef = useRef<PendingRestartNotice | null>(null)
  const clientRestartNotices = useRef(new Map<string, PendingRestartNotice>())
  const restartTargetRef = useRef<RestartTarget | null>(null)
  pendingRestartRef.current = pendingRestart
  restartTargetRef.current = restartTarget
  const dismissedMarketOperationIds = useRef(new Set<string>())
  const pendingInstallActivation = useRef(new Map<string, string | undefined>())
  const installRestartNotices = useRef(new Map<string, PendingRestartNotice>())
  const continuingInstallActivation = useRef(new Set<string>())
  const inflightSkinIds = useRef(new Set<string>())
  const skinsRef = useRef<CatalogSkin[]>([])
  const statesRef = useRef<RuntimeSkin[]>([])
  const runtimeRef = useRef<DshRuntime | null>(null)
  const runtimeReadyRef = useRef(false)
  const catalogSettledRef = useRef(false)
  const selectedIdRef = useRef('')
  const userSelectedRef = useRef(false)

  useEffect(() => () => {
    compatibilityConsentResolver.current?.(null)
    compatibilityConsentResolver.current = null
  }, [])

  const buildApprovalOperation = operations.find(operation =>
    operation.phase === 'failed'
    && operation.failure?.action === 'approve-build'
    && operation.id !== dismissedBuildApprovalId
  ) ?? null

  const acceptCatalog = useCallback((incoming: CatalogSkin[], runtimeStates: RuntimeSkin[] = statesRef.current) => {
    pendingScrollAnchor.current = captureListScroll(skinListRef.current)
    const nextSkins = [...incoming]
    const selectedBeforeRefresh = selectedIdRef.current
    if (selectedBeforeRefresh !== '' && !nextSkins.some(skin => skin.id === selectedBeforeRefresh)) {
      const selectedSkin = skinsRef.current.find(skin => skin.id === selectedBeforeRefresh)
      if (selectedSkin !== undefined) nextSkins.push(selectedSkin)
    }
    skinsRef.current = nextSkins
    setSkins(nextSkins)
    setSelectedId(value => {
      const next = preferredSelectedId(value, nextSkins, runtimeStates, userSelectedRef.current)
      selectedIdRef.current = next
      return next
    })
  }, [])

  const presentRestartNotice = useCallback((notice: PendingRestartNotice, state: MarketStateResponse, advisory: CompatibilityAssessment | null = null, autoPrompt = true) => {
    pendingRestartRef.current = notice
    setPendingRestart(notice)
    const key = restartPromptKey(state, notice.target)
    let seen = restartPrompts.current.has(key)
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(RESTART_PROMPTS_KEY) ?? '[]')
      if (Array.isArray(saved)) for (const item of saved) if (typeof item === 'string') restartPrompts.current.add(item)
      seen ||= restartPrompts.current.has(key)
      restartPrompts.current.add(key)
      window.sessionStorage.setItem(RESTART_PROMPTS_KEY, JSON.stringify([...restartPrompts.current].slice(-100)))
    } catch { restartPrompts.current.add(key) }
    if (seen || !autoPrompt) return
    restartTargetRef.current = notice.target
    setRestartTarget(notice.target)
    setCompatibilityWarning(advisory)
    setRunningAgents(typeof state.runningAgentCount === 'number' && Number.isInteger(state.runningAgentCount) ? state.runningAgentCount : null)
    setRestartCheckFinished(true)
    setConfirmRestart(true)
  }, [])

  const applyMarketState = useCallback((state: MarketStateResponse, preferredNotice?: PendingRestartNotice, autoRestartPrompt = true) => {
    latestMarketState.current = state
    statesRef.current = state.skins
    runtimeRef.current = state.runtime ?? null
    runtimeReadyRef.current = true
    setStates(state.skins)
    setHostKind(state.hostKind ?? 'dsh')
    setRuntime(state.runtime ?? null)
    setManagement(state.management)
    setProfileBusy(state.profileBusy)
    setRestartAvailable(state.restartAvailable !== false)
    setOperations(current => {
      const incoming = (state.operations ?? (state.operation == null ? [] : [state.operation])).filter(isLiveOperation)
      const failed = current.filter(operation => operation.phase === 'failed' && !incoming.some(item => item.skinId === operation.skinId))
      const pending = current.filter(operation =>
        operation.id.startsWith('pending:')
        && inflightSkinIds.current.has(operation.skinId)
        && !incoming.some(item => item.skinId === operation.skinId))
      return [...incoming, ...pending, ...failed]
    })
    if ('marketUpdateOperation' in state) {
      const operation = state.marketUpdateOperation !== null && state.marketUpdateOperation !== undefined && !dismissedMarketOperationIds.current.has(state.marketUpdateOperation.id)
        ? state.marketUpdateOperation
        : null
      setMarketOperation(current => current?.phase === 'failed' && operation === null ? current : operation)
      setMarketUpdating(operation?.phase !== undefined
        && !['done', 'failed', 'cancelled'].includes(operation.phase))
    }
    setInstalledClientPlugins(state.installedClientPlugins ?? [])
    setRunningAgents(typeof state.runningAgentCount === 'number' && Number.isInteger(state.runningAgentCount) ? state.runningAgentCount : null)
    for (const [skinId, notice] of clientRestartNotices.current) {
      const skin = runtimeFor(state.skins, skinId)
      if (state.hostKind === 'desktop' || notice.instanceId !== state.instanceId || skin.installation !== 'installed'
        || skin.activation === 'inactive' && skin.primary !== true && skin.pinned !== true) clientRestartNotices.current.delete(skinId)
    }
    const pendingFor = (target: RestartTarget) => target.kind === 'market-update'
      ? state.marketUpdateRestartRequired === true
      : runtimeFor(state.skins, target.skinId).activation === 'restart-required' || clientRestartNotices.current.has(target.skinId)
    // A legacy Host has no pending identity. Rearm its reminder only after
    // the Host actually clears this target's pending state.
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(RESTART_PROMPTS_KEY) ?? '[]')
      if (Array.isArray(saved)) for (const item of saved) if (typeof item === 'string') restartPrompts.current.add(item)
    } catch { /* the in-memory record is enough for this mount */ }
    for (const key of restartPrompts.current) {
      try {
        const [kind, skinId] = JSON.parse(key)
        if (kind === 'skin' && !pendingFor({ kind, skinId }) || kind === 'market-update' && state.marketUpdateRestartRequired === false) restartPrompts.current.delete(key)
      } catch { restartPrompts.current.delete(key) }
    }
    try { window.sessionStorage.setItem(RESTART_PROMPTS_KEY, JSON.stringify([...restartPrompts.current])) } catch { /* storage may be unavailable */ }
    const held = (target: RestartTarget) => target.kind === 'skin'
      && (continuingInstallActivation.current.has(target.skinId) || inflightSkinIds.current.has(target.skinId)
        || (state.operations ?? (state.operation == null ? [] : [state.operation])).some(operation => operation.skinId === target.skinId && isLiveOperation(operation)))
    for (const id of installRestartNotices.current.keys()) {
      if (!held({ kind: 'skin', skinId: id }) && runtimeFor(state.skins, id).activation !== 'restart-required') installRestartNotices.current.delete(id)
    }
    const oldNotice = pendingRestartRef.current
    if (oldNotice !== null && !pendingFor(oldNotice.target) && !held(oldNotice.target)) {
      pendingRestartRef.current = null
      setPendingRestart(null)
    }
    const oldTarget = restartTargetRef.current
    if (oldTarget !== null && !pendingFor(oldTarget) && !held(oldTarget)) {
      restartTargetRef.current = null
      setRestartTarget(null)
      setConfirmRestart(false)
      setCompatibilityWarning(null)
    }
    const preserved = pendingRestartRef.current
    const pendingSkin = state.skins.find(item => item.activation === 'restart-required' && item.skinId === selectedIdRef.current)
      ?? state.skins.find(item => item.activation === 'restart-required')
    const clientNotice = [...clientRestartNotices.current.values()][0]
    const target: RestartTarget | null = preferredNotice !== undefined && pendingFor(preferredNotice.target) ? preferredNotice.target
      : preserved !== null && pendingFor(preserved.target) ? preserved.target
        : state.marketUpdateRestartRequired === true ? { kind: 'market-update' }
          : pendingSkin === undefined ? clientNotice?.target ?? null : { kind: 'skin', skinId: pendingSkin.skinId }
    // Installation and rollback can also mark the previous skin pending.
    // Wait for the entire local transition before presenting any target.
    if (target !== null && !held(target) && continuingInstallActivation.current.size === 0 && inflightSkinIds.current.size === 0) {
      const skinState = target.kind === 'skin' ? runtimeFor(state.skins, target.skinId) : null
      const skin = target.kind === 'skin' ? skinsRef.current.find(item => item.id === target.skinId) : undefined
      const notice = preferredNotice?.target.kind === target.kind && (target.kind === 'market-update' || preferredNotice.target.kind === 'skin' && preferredNotice.target.skinId === target.skinId)
        ? preferredNotice
        : preserved?.target.kind === target.kind && (target.kind === 'market-update' || preserved.target.kind === 'skin' && preserved.target.skinId === target.skinId)
          ? preserved
          : clientNotice?.target.kind === 'skin' && target.kind === 'skin' && clientNotice.target.skinId === target.skinId ? clientNotice
          : { target, title: pendingRestartTitle(target.kind === 'market-update' ? '皮肤市场已更新' : `${skin?.name.zh ?? '皮肤'} 设置已保存`, state.restartAvailable !== false),
            description: target.kind === 'market-update' ? '皮肤市场已更新，重启后生效。' : undefined,
            startedAt: skinState?.lastOperatedAt ?? new Date().toISOString() }
      presentRestartNotice(notice, state, null, autoRestartPrompt)
    }
    if (skinsRef.current.length > 0) {
      setSelectedId(value => {
        const next = preferredSelectedId(value, skinsRef.current, state.skins, userSelectedRef.current)
        selectedIdRef.current = next
        return next
      })
    }
  }, [presentRestartNotice])

  const finishInstalledLoading = useCallback((showLoading: boolean) => {
    if (!showLoading) return
    if (canPaintInstalledSection(skinsRef.current, runtimeReadyRef.current, statesRef.current, catalogSettledRef.current)) {
      setLoading(false)
    }
  }, [])

  const refresh = useCallback(async (showLoading = false, restartNotice?: PendingRestartNotice, autoRestartPrompt = true) => {
    if (showLoading) {
      setLoading(true)
      runtimeReadyRef.current = false
      if (skinsRef.current.length === 0) {
        setCatalogLoading(true)
        catalogSettledRef.current = false
      }
    }
    try {
      const catalogRequest = json<CatalogResponse>('/dsh-skin-market/catalog').then(catalog => {
        acceptCatalog(catalog.skins)
        void catalogCache.write(catalog.skins).catch(() => undefined)
        catalogSettledRef.current = true
        if (showLoading) setCatalogLoading(false)
        finishInstalledLoading(showLoading)
        return catalog
      })
      const stateRequest = json<MarketStateResponse>('/dsh-skin-market/state').then(state => {
        if (restartNotice === undefined) applyMarketState(state, undefined, autoRestartPrompt)
        finishInstalledLoading(showLoading)
        return state
      })
      const [, state] = await Promise.all([catalogRequest, stateRequest])
      if (restartNotice !== undefined) applyMarketState(state, restartNotice, autoRestartPrompt)
      return state
    } finally {
      if (showLoading) {
        catalogSettledRef.current = true
        setLoading(false)
        setCatalogLoading(false)
      }
    }
  }, [acceptCatalog, applyMarketState, catalogCache, finishInstalledLoading])

  const openRestartConfirm = useCallback(async (skinId?: string, kind: RestartTarget['kind'] = 'skin', advisory: CompatibilityAssessment | null = null) => {
    setError(null)
    setRunningAgents(null)
    setRestartCheckFinished(false)
    const target: RestartTarget = kind === 'market-update' ? { kind } : { kind, skinId: skinId ?? selectedIdRef.current }
    restartTargetRef.current = target
    setRestartTarget(target)
    setCompatibilityWarning(advisory)
    setConfirmRestart(true)
    if (hostKind === 'desktop' && !restartAvailable) {
      setRestartCheckFinished(true)
      return
    }
    try {
      const state = await json<MarketStateResponse>('/dsh-skin-market/state', { cache: 'no-store' })
      setRunningAgents(typeof state.runningAgentCount === 'number' && Number.isInteger(state.runningAgentCount) ? state.runningAgentCount : null)
      setRestartCheckFinished(true)
    } catch (reason) {
      setRestartCheckFinished(true)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [hostKind, restartAvailable])

  const waitForMarketUpdate = useCallback(async (operationId: string) => {
    if (marketUpdatePolls.current.has(operationId)) return
    marketUpdatePolls.current.add(operationId)
    try {
      for (;;) {
        if (!mounted.current) return
        const operation = await json<MarketUpdateOperation>(`/dsh-skin-market/market-update/operations/${operationId}`)
        if (!mounted.current) return
        setMarketOperation(operation)
        if (operation.phase === 'waiting') setProfileBusy(operation.message ?? '市场更新结果尚未确认，暂时不能修改插件')
        if (operation.phase === 'done') {
          await json<MarketStateResponse>('/dsh-skin-market/state').then(applyMarketState).catch(() => undefined)
          if (!mounted.current) return
          setMarketUpdating(false)
          if (operation.status !== undefined) setMarketUpdate(operation.status)
          setMarketOperation(null)
          return
        }
        if (operation.phase === 'failed' || operation.phase === 'cancelled') {
          await json<MarketStateResponse>('/dsh-skin-market/state').then(applyMarketState).catch(() => undefined)
          if (!mounted.current) return
          setMarketUpdating(false)
          setError(null)
          return
        }
        await new Promise(resolve => setTimeout(resolve, operation.phase === 'waiting' ? 5000 : 600))
      }
    } catch (reason) {
      setMarketUpdating(false)
      const message = reason instanceof Error ? reason.message : String(reason)
      setMarketOperation(current => current === null
        ? { id: `market-update-failed-${Date.now()}`, phase: 'failed', message, startedAt: new Date().toISOString() }
        : { ...current, phase: 'failed', cancelable: false, message })
      setError(null)
    } finally {
      marketUpdatePolls.current.delete(operationId)
    }
  }, [applyMarketState])

  const checkMarketUpdate = useCallback(async () => {
    try {
      const status = await json<MarketUpdateStatus & { operation?: MarketUpdateOperation | null }>('/dsh-skin-market/market-update')
      if (typeof status.updateAvailable === 'boolean' && typeof status.currentVersion === 'string' && typeof status.latestVersion === 'string') {
        setMarketUpdate(status)
      }
      if (status.operation !== undefined) {
        const operation = status.operation !== null && !dismissedMarketOperationIds.current.has(status.operation.id) ? status.operation : null
        setMarketOperation(current => current?.phase === 'failed' && operation === null ? current : operation)
        setMarketUpdating(operation !== null && !['done', 'failed', 'cancelled'].includes(operation.phase))
        if (operation !== null && !['done', 'failed', 'cancelled'].includes(operation.phase)) void waitForMarketUpdate(operation.id)
      }
    } catch { /* update availability must never disturb catalog browsing */ }
  }, [waitForMarketUpdate])

  const updateMarket = useCallback(async () => {
    if (marketWriteReason !== undefined) { setError(marketWriteReason); return }
    setError(null)
    setMarketUpdating(true)
    try {
      const result = await json<{ operationId?: string; currentVersion?: string; latestVersion?: string; updateAvailable?: boolean }>('/dsh-skin-market/market-update', { method: 'POST' })
      if (typeof result.operationId === 'string') {
        setMarketOperation({ id: result.operationId, phase: 'queued', cancelable: true, startedAt: new Date().toISOString() })
        void waitForMarketUpdate(result.operationId)
      } else if (typeof result.currentVersion === 'string' && typeof result.latestVersion === 'string' && typeof result.updateAvailable === 'boolean') {
        const status = result as MarketUpdateStatus
        setMarketUpdate(status)
        setMarketUpdating(false)
        await json<MarketStateResponse>('/dsh-skin-market/state').then(applyMarketState)
      } else throw new Error('皮肤市场服务未返回有效的更新任务')
    } catch (reason) {
      setMarketUpdating(false)
      const message = reason instanceof Error ? reason.message : String(reason)
      setMarketOperation(current => current === null
        ? { id: `market-update-failed-${Date.now()}`, phase: 'failed', message, startedAt: new Date().toISOString() }
        : { ...current, phase: 'failed', cancelable: false, message })
      setError(null)
    }
  }, [applyMarketState, marketWriteReason, waitForMarketUpdate])

  useEffect(() => {
    let disposed = false
    void (async () => {
      const cached = await catalogCache.read()
      if (disposed) return
      if (cached !== null && cached.length > 0) {
        acceptCatalog(cached)
        setCatalogLoading(false)
      }
      await refresh(true).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
    })()
    return () => { disposed = true }
  }, [acceptCatalog, catalogCache, refresh])
  useEffect(() => {
    const controller = new AbortController()
    setGeneratedMediaSources([])
    void fetch(generatedMediaManifestUrl(), { cache: 'no-store', signal: controller.signal })
      .then(async response => response.ok ? parseGeneratedMediaManifest(await response.json()) : undefined)
      .then(sources => setGeneratedMediaSources(sources))
      .catch(() => setGeneratedMediaSources(undefined))
    return () => controller.abort()
  }, [])
  useEffect(() => { void checkMarketUpdate() }, [checkMarketUpdate])
  useEffect(() => {
    if (marketOperation === null || ['done', 'failed', 'cancelled'].includes(marketOperation.phase)) return
    void waitForMarketUpdate(marketOperation.id)
  }, [marketOperation?.id, marketOperation?.phase, waitForMarketUpdate])
  useEffect(() => {
    const timer = window.setInterval(() => {
      refresh(false).catch(() => undefined)
      void checkMarketUpdate()
    }, 5 * 60 * 1000)
    const refreshOnFocus = () => {
      refresh(false).catch(() => undefined)
      void checkMarketUpdate()
    }
    window.addEventListener('focus', refreshOnFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshOnFocus)
    }
  }, [checkMarketUpdate, refresh])
  useLayoutEffect(() => {
    restoreListScroll(skinListRef.current, pendingScrollAnchor.current)
    pendingScrollAnchor.current = null
  }, [skins])
  useLayoutEffect(() => {
    if (detailRef.current !== null) detailRef.current.scrollTop = 0
  }, [selectedId])
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has(RELOAD_PARAM)) return
    url.searchParams.delete(RELOAD_PARAM)
    window.history.replaceState(window.history.state, '', url)
  }, [])
  useLayoutEffect(() => {
    const home = homeRef.current
    if (home === null || typeof ResizeObserver === 'undefined') return
    const updateSlots = () => {
      const width = home.clientWidth
      setInstalledSlots(width < 560 ? 2 : width < 820 ? 3 : width < 1080 ? 4 : 5)
    }
    updateSlots()
    const observer = new ResizeObserver(updateSlots)
    observer.observe(home)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const home = homeHeaderRef.current?.parentElement
    if (layout !== 'embedded' || browserOpen || home == null) return
    let scrollHost = home.parentElement
    while (scrollHost !== null && scrollHost !== document.body && scrollHost !== document.documentElement) {
      if (/auto|scroll|overlay|hidden/.test(window.getComputedStyle(scrollHost).overflowY)) break
      scrollHost = scrollHost.parentElement
    }
    const viewportScroll = scrollHost === null || scrollHost === document.body || scrollHost === document.documentElement
    const scrollTarget = viewportScroll ? window : scrollHost!
    const updateCompact = () => {
      // Measure the home in normal flow; a pinned header always reports top: 0.
      const viewportTop = viewportScroll ? 0 : scrollHost!.getBoundingClientRect().top + scrollHost!.clientTop
      const scrollOffset = viewportTop - home.getBoundingClientRect().top
      setHomeCompact(current => scrollOffset > (current ? HOME_COMPACT_EXIT_SCROLL : HOME_COMPACT_ENTER_SCROLL))
    }
    updateCompact()
    scrollTarget.addEventListener('scroll', updateCompact, { passive: true })
    window.addEventListener('resize', updateCompact)
    return () => {
      scrollTarget.removeEventListener('scroll', updateCompact)
      window.removeEventListener('resize', updateCompact)
    }
  }, [layout, browserOpen])
  useLayoutEffect(() => {
    const header = homeHeaderRef.current
    if (layout !== 'embedded' || header === null) return
    // Expanded operation details must leave room to browse the page, without
    // introducing a second scroll area inside the sticky header.
    const updateSticky = () => setHomeHeaderSticky(header.getBoundingClientRect().height <= window.innerHeight / 2)
    updateSticky()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateSticky)
    observer?.observe(header)
    window.addEventListener('resize', updateSticky)
    return () => { observer?.disconnect(); window.removeEventListener('resize', updateSticky) }
  }, [layout])
  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.dshSkinMarketWide = 'true'
    style.textContent = '@media (min-width: 960px){[role="dialog"]:has([data-dsh-skin-market]){width:min(1280px,calc(100vw - 48px));height:min(860px,calc(100vh - 48px))}}'
    document.head.appendChild(style)
    return () => style.remove()
  }, [])
  const selected = skins.find(skin => skin.id === selectedId) ?? skins[0]
  const selectedScreenshots = selected === undefined ? [] : getCatalogScreenshotUrls(selected)
  const shotCount = selectedScreenshots.length
  const state = selected === undefined ? null : runtimeFor(states, selected.id)
  const compatibilityUnverified = selected?.review?.compatibility === 'unverified'
  const isManualOnly = (skin: CatalogSkin): boolean => hostKind === 'desktop'
    ? skin.install.desktop?.mode !== 'managed'
    : skin.review?.installation === 'manual-only'
  const manualOnly = selected !== undefined && isManualOnly(selected)
  const desktopManualReason = hostKind === 'desktop' && selected?.install.desktop?.mode === 'manual-only'
    ? selected.install.desktop.reason
    : undefined
  const manualInstallNotice = hostKind === 'desktop'
    ? `无法自动安装：${desktopManualReasonLabel(desktopManualReason)}。`
    : '该皮肤暂不支持市场直接安装。'
  const manualHealthNotice = hostKind === 'desktop'
    ? manualInstallNotice
    : '该仓库距离市场的一键安装规范还差少量信息；可参考右侧仓库健康建议完善，当前请按维护者说明安装。'
  const autoInstallable = !manualOnly
  const manualInstallKeyword = selected === undefined ? '' : createSkinInstallSearchKeyword(selected)
  const installPrompt = selected === undefined ? '' : createSkinInstallPrompt(selected, hostKind)
  const filtered = useMemo(() => skins.filter(skin => {
    if (!matchesCatalogSearch(skin, query)) return false
    if (filter === 'installed') return runtimeFor(states, skin.id).installation !== 'missing'
    return true
  }).sort((a, b) => filter === 'installed' ? compareInstalledSkinOrder(a, b, states) : compareSkinOrder(a, b, sortBy)), [skins, states, filter, query, sortBy])
  const visibleSkins = useMemo(() => {
    const visible = filtered.slice(0, visibleCount)
    const selectedSkin = filtered.find(skin => skin.id === selectedId)
    if (selectedSkin !== undefined && !visible.some(skin => skin.id === selectedSkin.id)) visible.push(selectedSkin)
    return visible
  }, [filtered, selectedId, visibleCount])

  const installedSkins = useMemo(() => skins
    .filter(skin => runtimeFor(states, skin.id).installation !== 'missing')
    .sort((a, b) => compareInstalledSkinOrder(a, b, states)), [skins, states])
  const discoverySkins = useMemo(() => skins
    .filter(skin => matchesCatalogSearch(skin, homeQuery))
    .sort((a, b) => compareSkinOrder(a, b, sortBy)), [homeQuery, skins, sortBy])
  const visibleDiscoverySkins = useMemo(() => discoverySkins.slice(0, homeVisibleCount), [discoverySkins, homeVisibleCount])
  const installedRowSkins = installedSkins.length > installedSlots ? installedSkins.slice(0, Math.max(1, installedSlots - 1)) : installedSkins
  const installedOverflow = installedSkins.length > installedRowSkins.length

  useEffect(() => {
    const sentinel = homeLoadMoreRef.current
    if (layout !== 'embedded' || browserOpen || catalogLoading || sentinel === null) return
    if (typeof IntersectionObserver === 'undefined') {
      setHomeVisibleCount(discoverySkins.length)
      return
    }
    // The viewport intersection includes clipping by the host's scroll area,
    // so embedded loading does not depend on our feed receiving scroll events.
    let requested = false
    const observer = new IntersectionObserver(entries => {
      if (requested || !entries.some(entry => entry.isIntersecting)) return
      requested = true
      setHomeVisibleCount(value => Math.min(discoverySkins.length, value + CATALOG_BATCH_SIZE))
    }, { rootMargin: '560px 0px' })
    observer.observe(sentinel)
    return () => { requested = true; observer.disconnect() }
  }, [layout, browserOpen, catalogLoading, homeVisibleCount, discoverySkins.length])

  useEffect(() => {
    const isNarrow = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 959px)').matches
    const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!browserOpen || (!showDetail && isNarrow) || galleryPaused || lightboxOpen || shotCount < 2 || reduceMotion) return
    const timer = window.setTimeout(() => {
      thumbnailScrollRequest.current = true
      setShotIndex(current => (current + 1) % shotCount)
    }, GALLERY_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [browserOpen, carouselEpoch, galleryPaused, lightboxOpen, selected?.id, shotCount, shotIndex, showDetail])

  useEffect(() => {
    if (!thumbnailScrollRequest.current) return
    thumbnailScrollRequest.current = false
    const selectedThumbnail = thumbnailStripRef.current?.querySelector<HTMLElement>('[data-selected="true"]')
    selectedThumbnail?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [selected?.id, shotIndex])

  useEffect(() => {
    thumbnailScrollRequest.current = false
    if (!browserOpen) return
    const thumbnailStrip = thumbnailStripRef.current
    if (thumbnailStrip !== null) thumbnailStrip.scrollLeft = 0
  }, [browserOpen, selected?.id])

  useEffect(() => {
    setGalleryPaused(false)
    setLightboxOpen(false)
    setCarouselEpoch(current => current + 1)
  }, [selected?.id])

  useEffect(() => {
    if (!lightboxOpen) return
    const handleLightboxKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        setLightboxOpen(false)
        return
      }
      if (shotCount < 2) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        thumbnailScrollRequest.current = true
        setShotIndex(current => event.key === 'ArrowLeft' ? (current - 1 + shotCount) % shotCount : (current + 1) % shotCount)
      }
    }
    window.addEventListener('keydown', handleLightboxKeys, true)
    return () => window.removeEventListener('keydown', handleLightboxKeys, true)
  }, [lightboxOpen, shotCount])

  const setCarouselPausedState = (paused: boolean) => {
    setGalleryPaused(paused)
    setCarouselEpoch(current => current + 1)
  }

  const moveShot = (direction: -1 | 1) => {
    if (shotCount > 1) {
      thumbnailScrollRequest.current = true
      setShotIndex(current => (current + direction + shotCount) % shotCount)
    }
  }

  useEffect(() => { setVisibleCount(CATALOG_BATCH_SIZE) }, [filter, query, sortBy])
  useEffect(() => { setHomeVisibleCount(CATALOG_BATCH_SIZE) }, [homeQuery, sortBy])

  const copyOperationLog = useCallback(async (operationId: string) => {
    setCopyingLogId(operationId)
    setCopyLogError(null)
    setError(null)
    try {
      const response = await fetch(`/dsh-skin-market/logs?operationId=${encodeURIComponent(operationId)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`日志导出失败（HTTP ${response.status}）`)
      const text = await response.text()
      await copyTextToClipboard(text)
      setCopiedLogId(operationId)
      window.setTimeout(() => setCopiedLogId(current => current === operationId ? null : current), 2400)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      const intercepting = operations.some(operation => isInterceptFailure(operation) && operation.id === operationId)
        || (marketOperation !== null && isInterceptFailure(marketOperation) && marketOperation.id === operationId)
      if (intercepting) setCopyLogError(message)
      else setError(message)
    } finally {
      setCopyingLogId(current => current === operationId ? null : current)
    }
  }, [operations, marketOperation])

  const cancelOperation = useCallback(async (operationId: string) => {
    const current = operations.find(operation => operation.id === operationId)
    if (current === undefined || current.id.startsWith('pending:') || current.cancelable !== true) return
    setError(null)
    setOperations(list => list.map(operation => operation.id === operationId ? { ...operation, phase: 'cancelling', cancelable: false } : operation))
    try {
      await json<Operation>(`/dsh-skin-market/operations/${operationId}/cancel`, { method: 'POST' })
    } catch (reason) {
      await refresh().catch(() => undefined)
      const message = reason instanceof Error ? reason.message : String(reason)
      setOperations(list => list.map(operation => operation.id === operationId
        ? { ...operation, phase: 'failed', cancelable: false, message }
        : operation))
      setError(null)
    }
  }, [operations, refresh])

  const cancelMarketUpdate = useCallback(async () => {
    const operation = marketOperation
    if (operation === null || operation.cancelable !== true) return
    setMarketOperation(current => current?.id === operation.id ? { ...current, phase: 'cancelling', cancelable: false, message: '正在取消皮肤市场更新' } : current)
    try {
      const cancelled = await json<MarketUpdateOperation>(`/dsh-skin-market/market-update/operations/${operation.id}/cancel`, { method: 'POST' })
      setMarketOperation(cancelled)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setMarketOperation(current => current?.id === operation.id ? { ...current, phase: 'failed', cancelable: false, message } : current)
      setError(null)
    }
  }, [marketOperation])

  const retryMarketUpdate = useCallback(async () => {
    const operation = marketOperation
    if (operation === null || operation.failure?.action !== 'retry') return
    setMarketUpdating(true)
    try {
      const result = await json<{ operationId: string }>(`/dsh-skin-market/market-update/operations/${operation.id}/retry`, { method: 'POST' })
      setMarketOperation({ id: result.operationId, phase: 'queued', cancelable: true, startedAt: new Date().toISOString() })
      void waitForMarketUpdate(result.operationId)
    } catch (reason) {
      setMarketUpdating(false)
      const message = reason instanceof Error ? reason.message : String(reason)
      setMarketOperation(current => current?.id === operation.id ? { ...current, phase: 'failed', cancelable: false, message } : current)
      setError(null)
    }
  }, [marketOperation, waitForMarketUpdate])

  const actionReason = useCallback((kind: MutationKind): string | null => {
    if (profileBusy !== undefined) return profileBusy
    if (marketUpdating || marketOperation !== null && !['done', 'failed', 'cancelled'].includes(marketOperation.phase)) return '皮肤市场正在更新，完成前暂时不能修改插件'
    const action = kind === 'install' ? 'install' : kind === 'update' || kind === 'migrate' ? 'update' : kind === 'activate' || kind === 'pin' ? 'enable' : kind === 'uninstall' ? 'remove' : 'disable'
    const capability = management?.capabilities[action]
    return capability?.available === false ? capability.reason ?? '当前宿主暂不支持此操作，请使用官方插件页' : null
  }, [management, marketOperation, marketUpdating, profileBusy])
  const currentActionReason = useRef(actionReason)
  currentActionReason.current = actionReason

  const requestCompatibilityConsent = useCallback(async (skin: CatalogSkin, kind: MutationKind, installAndUse = false, changed = false): Promise<CompatibilityConsent> => {
    if (!['install', 'update', 'migrate', 'activate', 'pin'].includes(kind)) return { decision: 'not-required' }
    const target = skinsRef.current.find(item => item.id === skin.id)
    if (target === undefined) return { decision: 'cancelled' }
    const assessment = installCompatibility(target, 'dsh', runtimeRef.current)!
    if (!changed && assessment.decision !== 'incompatible') return { decision: 'not-required' }
    const actionLabel = kind === 'install' ? installAndUse && !officialDesktop ? '安装并使用' : '安装'
      : kind === 'update' ? '更新' : kind === 'migrate' ? '换用 npm' : kind === 'pin' ? '常驻使用' : '使用'
    compatibilityConsentResolver.current?.(null)
    const context = await new Promise<string | null>(resolve => {
      compatibilityConsentResolver.current = resolve
      const confirmation = { skin: target, assessment, actionLabel, context: skinCompatibilityContext(target, runtimeRef.current), changed }
      compatibilityConfirmationRef.current = confirmation
      setCompatibilityConfirmation(confirmation)
    })
    return context === null ? { decision: 'cancelled' } : { decision: 'accepted', context }
  }, [officialDesktop])

  const finishCompatibilityConfirmation = useCallback((accepted: boolean) => {
    const resolve = compatibilityConsentResolver.current
    const confirmation = compatibilityConfirmationRef.current
    if (accepted && confirmation !== null) {
      const target = skinsRef.current.find(item => item.id === confirmation.skin.id)
      if (target !== undefined) {
        const context = skinCompatibilityContext(target, runtimeRef.current)
        if (context !== confirmation.context) {
          const updated = { ...confirmation, skin: target, assessment: installCompatibility(target, 'dsh', runtimeRef.current)!, context, changed: true }
          compatibilityConfirmationRef.current = updated
          setCompatibilityConfirmation(updated)
          return
        }
      } else accepted = false
    }
    compatibilityConsentResolver.current = null
    compatibilityConfirmationRef.current = null
    setCompatibilityConfirmation(null)
    resolve?.(accepted ? confirmation?.context ?? null : null)
  }, [])

  const restoreInstallRestartNotice = useCallback(async (skinId: string, autoPrompt = true, activationUncertain = false) => {
    const notice = installRestartNotices.current.get(skinId)
    const state = latestMarketState.current
    if (notice === undefined || !mounted.current || state === null || runtimeFor(state.skins, skinId).activation !== 'restart-required') return
    const name = skinsRef.current.find(skin => skin.id === skinId)?.name.zh ?? '此皮肤'
    const restored = { ...notice, title: activationUncertain ? `${name} 已安装，自动切换结果待确认` : `${name} 已安装，但未启用`,
      description: activationUncertain
        ? `“${name}”已安装，自动切换结果待确认，请在官方插件页核对启用状态。此次安装仍需手动重启 Desktop App。`
        : `“${name}”已安装，但尚未启用。自动切换尚未完成，请根据操作提示处理后重试。此次安装仍需手动重启 Desktop App。` }
    installRestartNotices.current.set(skinId, restored)
    if (!autoPrompt && restartTargetRef.current?.kind === 'skin' && restartTargetRef.current.skinId === skinId) {
      restartTargetRef.current = null
      setRestartTarget(null)
      setConfirmRestart(false)
      setCompatibilityWarning(null)
    }
    presentRestartNotice(restored, state, null, autoPrompt)
  }, [presentRestartNotice])

  const runForSkin = useCallback(async (skinId: string, kind: MutationKind, existingOperationId?: string, options: SkinOperationOptions = {}) => {
    let target = skinsRef.current.find(skin => skin.id === skinId)
    if (target === undefined) { continuingInstallActivation.current.delete(skinId); return false }
    const stopContinuation = async () => {
      if (!continuingInstallActivation.current.delete(skinId) || !mounted.current) return
      await refresh().catch(() => undefined)
      await restoreInstallRestartNotice(skinId)
    }
    let acceptedContext = options.compatibilityContext
    if (existingOperationId === undefined) {
      const reason = actionReason(kind) ?? (kind === 'install' && options.installAndUse === true && officialDesktop ? actionReason('activate') : null)
      if (reason !== null) { setError(reason); await stopContinuation(); return false }
      while (acceptedContext === undefined || acceptedContext !== skinCompatibilityContext(target, runtimeRef.current)) {
        const consent = await requestCompatibilityConsent(target, kind, options.installAndUse, acceptedContext !== undefined)
        if (consent.decision === 'cancelled' || !mounted.current) { await stopContinuation(); return false }
        acceptedContext = consent.decision === 'accepted' ? consent.context : undefined
        target = skinsRef.current.find(skin => skin.id === skinId)
        if (target === undefined) { await stopContinuation(); return false }
        if (consent.decision === 'not-required') break
      }
      const currentReason = currentActionReason.current(kind) ?? (kind === 'install' && options.installAndUse === true && officialDesktop ? currentActionReason.current('activate') : null)
      if (currentReason !== null) { setError(currentReason); await stopContinuation(); return false }
      if (kind === 'install') {
        installRestartNotices.current.delete(target.id)
        if (options.installAndUse === true) pendingInstallActivation.current.set(target.id, acceptedContext)
        else pendingInstallActivation.current.delete(target.id)
      }
    }
    const targetState = runtimeFor(statesRef.current, target.id)
    setError(null)
    inflightSkinIds.current.add(target.id)
    if (existingOperationId === undefined) {
      setOperations(list => upsertOperation(list, {
        id: pendingOperationId(target.id), kind, skinId: target.id, phase: 'queued', startedAt: new Date().toISOString(),
      }))
    }
    try {
      const operationId = existingOperationId ?? (await json<{ operationId: string }>(`/dsh-skin-market/${kind}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skinId: target.id, ...(acceptedContext !== undefined && { acknowledgeCompatibility: true, compatibilityContext: acceptedContext }) }),
      })).operationId
      for (;;) {
        if (!mounted.current) return false
        const operation = await json<Operation>(`/dsh-skin-market/operations/${operationId}`)
        if (!mounted.current) return false
        if (operation.phase === 'waiting') setProfileBusy(operation.message ?? '插件启停结果尚未确认，暂时不能修改此 profile')
        setOperations(list => {
          const next = upsertOperation(list, operation)
          if (operation.phase === 'done' || operation.phase === 'cancelled') {
            return next.filter(item => item.id !== operation.id && item.id !== pendingOperationId(operation.skinId))
          }
          return next
        })
        if (operation.phase === 'cancelled' || operation.phase === 'failed') {
          inflightSkinIds.current.delete(target.id)
        }
        if (operation.phase === 'done') {
          // Official hosts can save their enabled selection before restart,
          // even when newly installed modules are not live in this process.
          // Finish both steps before showing one restart prompt.
          const continueInstallAndUse = kind === 'install'
            && pendingInstallActivation.current.has(target.id)
            && management?.official === true
          let clientNeedsRestart = false
          if (management?.official === true) {
            // The host applies both halves of an official bundle. Do not
            // separately remount its browser loader from this market.
            restoreMarketStyleOrder()
          } else if (kind === 'deactivate' || kind === 'uninstall') {
            clientRestartNotices.current.delete(target.id)
            await clientRuntime?.setActive(target.package, false)
          } else if (kind === 'unpin' && targetState.primary !== true) {
            clientRestartNotices.current.delete(target.id)
            await clientRuntime?.setActive(target.package, false)
          } else if (kind === 'pin' && clientRuntime !== undefined) {
            clientNeedsRestart = !(await clientRuntime.setActive(target.package, true))
            restoreMarketStyleOrder()
          } else if (kind === 'activate' && clientRuntime !== undefined) {
            const pinnedPackages = states
              .filter(item => item.pinned)
              .map(item => skins.find(skin => skin.id === item.skinId)?.package)
              .filter((packageName): packageName is string => packageName !== undefined)
            clientNeedsRestart = !(await switchClientSkin(clientRuntime, skins.map(skin => skin.package), target.package, pinnedPackages))
            restoreMarketStyleOrder()
          }
          if ((kind === 'activate' || kind === 'pin') && !clientNeedsRestart) clientRestartNotices.current.delete(target.id)
          const advisory = kind === 'activate' && acceptedContext === undefined ? advisoryCompatibility(target, hostKind, runtime) : null
          const installBeforeUse = kind === 'install' && hostKind === 'desktop'
          const restartNotice: PendingRestartNotice = { target: { kind: 'skin', skinId: target.id }, title: installBeforeUse
            ? `${target.name.zh} 已安装，请手动重启 Desktop App 后再使用`
            : pendingRestartTitle(`${target.name.zh} ${kind === 'activate' ? '已切换' : kind === 'update' ? '已更新' : kind === 'migrate' ? '已换用 npm' : '已完成操作'}`, restartAvailable),
            description: installBeforeUse ? `“${target.name.zh}”已安装，重启后可使用。`
              : kind === 'activate' ? `已保存“${target.name.zh}”的启用选择，重启后生效。`
                : `“${target.name.zh}”${kind === 'uninstall' ? '已卸载' : kind === 'deactivate' ? '的停用选择已保存' : kind === 'update' ? '已更新' : '的设置已保存'}，重启后生效。`,
            startedAt: new Date().toISOString() }
          if (kind === 'install' && operation.restartRequired === true) installRestartNotices.current.set(target.id, restartNotice)
          if (continueInstallAndUse) continuingInstallActivation.current.add(target.id)
          else continuingInstallActivation.current.delete(target.id)
          inflightSkinIds.current.delete(target.id)
          const refreshed = await refresh(false, continueInstallAndUse ? undefined : restartNotice)
          if (continueInstallAndUse) return true
          if (clientNeedsRestart && refreshed.hostKind !== 'desktop') {
            const notice: PendingRestartNotice = { ...restartNotice, source: 'client', instanceId: refreshed.instanceId,
              description: `“${target.name.zh}”的客户端组件尚未加载，重启后生效。` }
            clientRestartNotices.current.set(target.id, notice)
            presentRestartNotice(notice, refreshed, advisory)
          }
          const needsRestart = clientNeedsRestart || runtimeFor(refreshed.skins, target.id).activation === 'restart-required'
          if (!needsRestart) {
            if (advisory !== null) setCompatibilityWarning(advisory)
          }
          if (kind === 'activate' || kind === 'uninstall') installRestartNotices.current.delete(target.id)
          // Install-only stops here; official install-and-use returns above
          // so the caller can save the target selection before restart.
          return kind !== 'install' || !needsRestart
        }
        if (operation.phase === 'cancelled') {
          continuingInstallActivation.current.delete(target.id)
          await refresh()
          await restoreInstallRestartNotice(target.id)
          return false
        }
        if (operation.phase === 'failed') {
          continuingInstallActivation.current.delete(target.id)
          await refresh(false, undefined, false).catch(() => undefined)
          setOperations(list => upsertOperation(list, operation))
          setError(null)
          await restoreInstallRestartNotice(target.id, false)
          return false
        }
        await new Promise(resolve => setTimeout(resolve, operation.phase === 'waiting' ? 5000 : 600))
      }
    } catch (reason) {
      continuingInstallActivation.current.delete(target.id)
      inflightSkinIds.current.delete(target.id)
      await refresh(false, undefined, false).catch(() => undefined)
      const message = reason instanceof Error ? reason.message : String(reason)
      setOperations(list => upsertOperation(list, {
        id: `skin-operation-failed-${target.id}`, kind, skinId: target.id, phase: 'failed', startedAt: new Date().toISOString(), message,
      }))
      setError(null)
      await restoreInstallRestartNotice(target.id, false, kind === 'activate')
      return false
    }
  }, [actionReason, clientRuntime, hostKind, management, officialDesktop, presentRestartNotice, refresh, requestCompatibilityConsent, restartAvailable, restoreInstallRestartNotice, runtime, skins, states])

  const activateSkin = useCallback((skinId: string, compatibilityContext?: string) => {
    if (!mounted.current) return
    pendingInstallActivation.current.delete(skinId)
    try { window.localStorage.setItem(ACTIVATION_WARNING_KEY, 'true') } catch { /* storage may be unavailable */ }
    setActivationWarningAccepted(true)
    void runForSkin(skinId, 'activate', undefined, { compatibilityContext })
  }, [runForSkin])

  const retrySkinOperation = useCallback(async (operation: Operation) => {
    const action = operation.failure?.action
    if (action === undefined) return
    try {
      const skin = skinsRef.current.find(item => item.id === operation.skinId)
      if (skin === undefined) return
      const installAndUse = operation.kind === 'install' && pendingInstallActivation.current.has(operation.skinId)
      const consent = await requestCompatibilityConsent(skin, operation.kind, installAndUse)
      if (consent.decision === 'cancelled' || !mounted.current) return
      const reason = currentActionReason.current(operation.kind)
      if (reason !== null) { setError(reason); return }
      const acceptedContext = consent.decision === 'accepted' ? consent.context : undefined
      if (installAndUse) pendingInstallActivation.current.set(operation.skinId, acceptedContext)
      const result = await json<{ operationId: string }>(`/dsh-skin-market/operations/${operation.id}/retry`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...(acceptedContext !== undefined && { acknowledgeCompatibility: true, compatibilityContext: acceptedContext }) }),
      })
      const retried = await runForSkin(operation.skinId, operation.kind, result.operationId, { compatibilityContext: acceptedContext })
      if (retried && operation.kind === 'install' && pendingInstallActivation.current.has(operation.skinId)) activateSkin(operation.skinId, acceptedContext)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setOperations(list => list.map(item => item.id === operation.id ? { ...item, message } : item))
      setError(null)
    }
  }, [activateSkin, requestCompatibilityConsent, runForSkin])

  const approveBuildAndRetry = useCallback(() => {
    if (buildApprovalOperation === null) return
    setDismissedBuildApprovalId(buildApprovalOperation.id)
    void retrySkinOperation(buildApprovalOperation)
  }, [buildApprovalOperation, retrySkinOperation])

  const run = useCallback(async (kind: MutationKind) => selected === undefined ? false : runForSkin(selected.id, kind), [runForSkin, selected])

  const activateSelected = useCallback(() => {
    if (selected === undefined) return
    activateSkin(selected.id)
  }, [activateSkin, selected])

  const installAndActivate = useCallback(async () => {
    if (selected === undefined) return
    if (await runForSkin(selected.id, 'install', undefined, { installAndUse: true }) && mounted.current) activateSkin(selected.id, pendingInstallActivation.current.get(selected.id))
  }, [activateSkin, runForSkin, selected])

  const installAndActivateSkin = useCallback(async (skinId: string) => {
    if (await runForSkin(skinId, 'install', undefined, { installAndUse: true }) && mounted.current) activateSkin(skinId, pendingInstallActivation.current.get(skinId))
  }, [activateSkin, runForSkin])

  const restartNow = useCallback(async () => {
    if (hostKind === 'desktop' && !restartAvailable) {
      setError('请手动重启 Desktop App 后生效')
      return
    }
    const target = restartTarget ?? { kind: 'skin' as const, skinId: selectedIdRef.current }
    if (target.kind === 'skin' && target.skinId === '') return
    setRestarting(true)
    setError(null)
    try {
      const accepted = await json<{ instanceId: string }>('/dsh-skin-market/restart', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(target.kind === 'market-update' ? { reason: 'market-update' } : { skinId: target.skinId }),
      })
      window.location.replace(await waitForRestartDocument({
        acceptedInstanceId: accepted.instanceId,
        href: window.location.href,
        fetchState: () => json<{ instanceId: string }>('/dsh-skin-market/state', { cache: 'no-store' }),
        fetchDocument: async url => {
          const response = await fetch(url, { cache: 'no-store' })
          return { ok: response.ok }
        },
      }))
    } catch (reason) {
      setConfirmRestart(false)
      setCompatibilityWarning(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRestarting(false)
    }
  }, [hostKind, restartAvailable, restartTarget])

  const chooseSkin = (id: string) => { userSelectedRef.current = true; selectedIdRef.current = id; setSelectedId(id); setShotIndex(0); setLightboxOpen(false); setError(null); setInstallCopied(null); setShowInstallOptions(false) }
  const select = (id: string) => { chooseSkin(id); setShowDetail(true) }
  const openBrowser = (id: string, origin: 'discover' | 'installed') => {
    chooseSkin(id)
    setBrowserOrigin(origin)
    setFilter(origin === 'installed' ? 'installed' : 'all')
    setQuery('')
    setShowDetail(origin === 'discover')
    setBrowserOpen(true)
  }
  const openInstalledBrowser = (id?: string) => {
    const target = id ?? installedSkins.find(skin => runtimeFor(states, skin.id).activation === 'active')?.id ?? installedSkins[0]?.id
    if (target !== undefined) openBrowser(target, 'installed')
  }
  const closeBrowser = () => { setLightboxOpen(false); setBrowserOpen(false); setShowDetail(false) }
  const deferInstallAndUse = livePnpmOperations(operations).length > 0
  const restartInstallBlock = restartBlockedByInstalls(operations, skins)
  const manualDesktopRestart = hostKind === 'desktop' && !restartAvailable
  const installAndUseReason = actionReason('install') ?? (officialDesktop ? actionReason('activate') : null)
  const restartNoticeMatchesTarget = pendingRestart !== null && restartTarget !== null
    && pendingRestart.target.kind === restartTarget.kind
    && (restartTarget.kind === 'market-update' || pendingRestart.target.kind === 'skin' && pendingRestart.target.skinId === restartTarget.skinId)
  const restartTargetDescription = restartTarget?.kind === 'market-update'
    ? '皮肤市场已更新，重启后生效。'
    : `“${skins.find(skin => restartTarget?.kind === 'skin' && skin.id === restartTarget.skinId)?.name.zh ?? '此皮肤'}”的设置将在重启后生效。`
  const manualRestartDescription = restartInstallBlock !== null
    ? `${restartInstallBlock}请等待操作完成后再手动重启 Desktop App。`
    : `${restartNoticeMatchesTarget ? pendingRestart.description ?? restartTargetDescription : restartTargetDescription}请先保存当前工作，再完全退出 Desktop App 并重新打开。`
  const openCardInstall = (skin: CatalogSkin) => {
    if (isManualOnly(skin)) {
      chooseSkin(skin.id)
      setInstallCopied(null)
      setShowInstallOptions(true)
      return
    }
    if (officialDesktop && deferInstallAndUse) return
    if (deferInstallAndUse) void runForSkin(skin.id, 'install')
    else void installAndActivateSkin(skin.id)
  }
  const activateCard = (skinId: string) => {
    try { window.localStorage.setItem(ACTIVATION_WARNING_KEY, 'true') } catch { /* storage may be unavailable */ }
    setActivationWarningAccepted(true)
    void runForSkin(skinId, 'activate')
  }
  const recommendations = selected?.recommendations.map(id => skins.find(skin => skin.id === id)).filter((skin): skin is CatalogSkin => skin !== undefined) ?? []
  const submissionPrompt = createSubmissionPrompt()
  const copySubmissionPrompt = async () => {
    await copyTextToClipboard(submissionPrompt)
    setSubmissionCopied(true)
  }
  const copyInstallOption = async (method: 'prompt' | 'command' | 'keyword') => {
    if (selected === undefined) return
    const content = method === 'prompt'
      ? installPrompt
      : method === 'command'
        ? createSkinInstallCommand(selected)
        : createSkinInstallSearchKeyword(selected)
    await copyTextToClipboard(content)
    setInstallCopied(`${selected.id}:${method}`)
  }
  const renderHomeCard = (skin: CatalogSkin, location: 'installed' | 'discover') => {
    const itemState = runtimeFor(states, skin.id)
    const cardMutation = liveOperationFor(operations, skin.id)
    const needsInstall = itemState.installation === 'missing' || itemState.installation === 'broken'
    const canMigrate = hostKind === 'dsh' && itemState.installation === 'installed' && itemState.sourceMigration !== undefined && !isManualOnly(skin)
    const actionCount = cardMutation !== undefined || needsInstall
      ? 1
      : itemState.installation === 'installed'
        ? Number(itemState.activation === 'inactive' || itemState.activation === 'active' || itemState.activation === 'unavailable') + Number(itemState.activation === 'unavailable') + Number(itemState.updateAvailable && !isManualOnly(skin)) + Number(canMigrate)
        : 0
    const stateText = itemState.installation === 'broken'
      ? '安装异常'
      : itemState.activation === 'active'
        ? compactStatusLabel(itemState)
        : itemState.activation === 'restart-required'
          ? '待重启'
          : itemState.activation === 'unavailable'
            ? '未生效'
            : itemState.activation === 'switching'
              ? '正在加载'
          : itemState.installation === 'installed'
            ? '已安装'
            : null
    const open = () => location === 'installed' ? openInstalledBrowser(skin.id) : openBrowser(skin.id, 'discover')
    return <article className={css.homeCard} data-active={itemState.activation === 'active' ? 'true' : undefined} data-actions={actionCount} key={`${location}:${skin.id}`}>
      <button type="button" className={`${css.homeCardOpen} dsh-skin-media-hover`} aria-current={itemState.activation === 'active' ? 'true' : undefined} aria-label={location === 'installed' ? `${skin.name.zh} 已安装卡片` : `${skin.name.zh} 界面预览`} onClick={open}>
        <span className={css.homeCardMedia}><PreviewMedia skin={skin} src={getCatalogListScreenshot(skin)} fallbackSources={getCatalogScreenshotUrls(skin)} alt={`${skin.name.zh} 界面预览`} kind="recommendation" loading="lazy" /></span>
        <span className={css.homeCardCopy}>
          <span className={css.homeCardTitleRow}><strong title={skin.name.zh}>{skin.name.zh}</strong>{location === 'discover' && <span className={css.feedMeta}><StarIcon size={12} aria-hidden="true" /> {skin.githubStars}</span>}</span>
          <span className={css.homeCardDescription} title={skin.description}>{displayTitle(skin.description)}</span>
        </span>
      </button>
      <div className={css.homeCardFooter}>
        <span className={css.homeCardRepo} title={githubRepoLabel(skin.repo)}>{githubRepoLabel(skin.repo)}</span>
        {stateText !== null && <StatusLabel active={itemState.activation === 'active'}>{stateText}</StatusLabel>}
        {actionCount > 0 && <div className={css.cardInlineActions} role="group" aria-label={`${skin.name.zh} 操作`}>
          {cardMutation !== undefined ? <span className={css.cardActionProgress}><IconLoadingOutline />{mutationLabels[cardMutation.kind]}</span> : <>
            {needsInstall && <Button className={css.cardAction} variant="outline" size="sm" disabled={!isManualOnly(skin) && (installAndUseReason !== null || officialDesktop && deferInstallAndUse)} title={isManualOnly(skin) ? '复制安装提示词' : installAndUseReason ?? (officialDesktop && deferInstallAndUse ? '请等待当前安装完成，再安装其他皮肤' : deferInstallAndUse ? '先安装，当前有其他皮肤正在安装，完成后再使用' : installRequiresRestart ? DESKTOP_INSTALL_RESTART_GUIDANCE : '安装并使用当前皮肤')} onClick={() => openCardInstall(skin)}>{isManualOnly(skin) ? '需手动安装' : officialDesktop || deferInstallAndUse ? '安装' : '安装并使用'}</Button>}
            {itemState.installation === 'installed' && itemState.activation === 'inactive' && <Button className={css.cardAction} variant="outline" size="sm" disabled={actionReason('activate') !== null} onClick={() => activateCard(skin.id)}>使用</Button>}
            {itemState.installation === 'installed' && itemState.activation === 'unavailable' && <Button className={css.cardAction} variant="outline" size="sm" disabled={actionReason('activate') !== null} onClick={() => activateCard(skin.id)}>重新使用</Button>}
            {itemState.installation === 'installed' && itemState.activation === 'unavailable' && <Button className={css.cardAction} variant="outline" size="sm" disabled={actionReason('deactivate') !== null} onClick={() => { void runForSkin(skin.id, 'deactivate') }}>停用</Button>}
            {itemState.installation === 'installed' && itemState.activation === 'active' && <Button className={css.cardAction} variant="outline" size="sm" disabled={actionReason('deactivate') !== null} onClick={() => { void runForSkin(skin.id, 'deactivate') }}>停用</Button>}
            {itemState.installation === 'installed' && itemState.updateAvailable && !isManualOnly(skin) && <Button className={css.cardAction} variant="outline" size="sm" disabled={actionReason('update') !== null} onClick={() => { void runForSkin(skin.id, 'update') }}>更新</Button>}
            {canMigrate && <Button className={css.cardAction} variant="outline" size="sm" disabled={actionReason('migrate') !== null} onClick={() => setConfirmMigration({ skin, source: itemState.sourceMigration! })}>换用 npm</Button>}
          </>}
        </div>}
      </div>
    </article>
  }

  const interceptOperation = operations.find(operation => isInterceptFailure(operation)) ?? null
  const interceptSkin = interceptOperation === null ? undefined : skins.find(skin => skin.id === interceptOperation.skinId)
  const marketInterceptOperation = interceptOperation === null && isInterceptFailure(marketOperation) ? marketOperation : null
  const intercept = interceptOperation !== null
    ? interceptNotice(interceptOperation, interceptSkin?.name.zh ?? interceptOperation.skinId, interceptSkin)
    : marketInterceptOperation !== null
      ? marketUpdateNotice(marketInterceptOperation)
      : null
  const interceptLogId = interceptOperation?.id ?? marketInterceptOperation?.id
  const selectedBusy = selected === undefined ? undefined : liveOperationFor(operations, selected.id)
  const selectedInstallAndUsePending = selected !== undefined && continuingInstallActivation.current.has(selected.id)
  const managementNotice = management === undefined ? '' : [...new Set([
    ...(['install', 'update', 'enable', 'disable', 'remove'] as const).map(key => management.capabilities[key]).filter(value => !value.available).map(value => value.reason).filter(Boolean),
  ])].join('；')
  const pnpmBusy = operations.some(operation => isLiveOperation(operation) && PROFILE_PNPM_KINDS.has(operation.kind))
  const dismissIntercept = () => {
    setCopyLogError(null)
    if (interceptOperation !== null) setOperations(list => list.filter(operation => operation.id !== interceptOperation.id))
    if (marketInterceptOperation !== null) {
      dismissedMarketOperationIds.current.add(marketInterceptOperation.id)
      setMarketOperation(null)
    }
  }

  const renderSkinOperationBanner = (className?: string) => {
    const visible = operations.filter(operation =>
      (isLiveOperation(operation) || operation.phase === 'failed')
      && !isInterceptFailure(operation),
    )
    if (visible.length === 0) return null
    const banners = visible.map(operation => {
      const failed = operation.phase === 'failed'
      const terminal = isTerminalOperation(operation)
      return <OperationBanner
        key={operation.id}
        operationId={operation.id}
        copyingLog={copyingLogId === operation.id}
        copiedLog={copiedLogId === operation.id}
        className={className}
        title={skinOperationTitle(operation, skins.find(skin => skin.id === operation.skinId)?.name.zh ?? operation.skinId)}
        startedAt={operation.startedAt}
        progress={failed ? undefined : operation}
        message={failed ? undefined : operation.message}
        showMessage={operation.phase === 'waiting' || operation.phase === 'cancelling'}
        downloading={operation.phase === 'downloading'}
        terminal={terminal}
        failed={failed}
        cancelable={operation.cancelable === true}
        onCancel={() => { void cancelOperation(operation.id) }}
        onCopyLog={() => { void copyOperationLog(operation.id) }}
        action={operation.failure?.action === 'approve-build'
          ? <Button variant="outline" size="sm" onClick={() => setDismissedBuildApprovalId(null)}>查看批准说明</Button>
          : recoveryActionLabel(operation.failure?.action) === undefined
            ? undefined
            : <Button variant="outline" size="sm" onClick={() => { void retrySkinOperation(operation) }}>{recoveryActionLabel(operation.failure?.action)}</Button>}
        onDismiss={terminal ? () => setOperations(list => list.filter(item => item.id !== operation.id)) : undefined}
      />
    })
    return className === css.homeOperation
      ? <div className={css.homeOperations}>{banners}</div>
      : <>{banners}</>
  }

  const renderMarketOperationBanner = (className?: string) => {
    if (marketOperation === null || marketInterceptOperation !== null || (marketOperation.phase === 'done' && pendingRestart !== null)) return null
    const failed = marketOperation.phase === 'failed'
    const terminal = marketOperation.phase === 'done' || failed || marketOperation.phase === 'cancelled'
    return <OperationBanner
    operationId={marketOperation.id}
    copyingLog={copyingLogId === marketOperation.id}
    copiedLog={copiedLogId === marketOperation.id}
    className={className}
    title={marketOperationTitles[marketOperation.phase]}
    startedAt={marketOperation.startedAt}
    progress={failed ? undefined : marketOperation}
    message={failed ? undefined : marketOperation.message}
    showMessage={marketOperation.phase === 'waiting' || marketOperation.phase === 'cancelling'}
    downloading={marketOperation.phase === 'downloading'}
    terminal={terminal}
    failed={failed}
    cancelable={marketOperation.cancelable === true}
    onCancel={() => { void cancelMarketUpdate() }}
    onCopyLog={() => { void copyOperationLog(marketOperation.id) }}
    action={recoveryActionLabel(marketOperation.failure?.action) === undefined ? undefined : <Button variant="outline" size="sm" onClick={() => { void retryMarketUpdate() }}>{recoveryActionLabel(marketOperation.failure?.action)}</Button>}
    onDismiss={terminal ? () => { dismissedMarketOperationIds.current.add(marketOperation.id); setMarketOperation(null) } : undefined}
  />
  }

  const renderPendingRestartBanner = (className?: string) => pendingRestart === null ? null : <OperationBanner
    className={className}
    title={pendingRestart.title}
    startedAt={pendingRestart.startedAt}
    metadata={[]}
    terminal
    action={<Button variant="outline" size="sm" onClick={() => void openRestartConfirm(pendingRestart.target.kind === 'skin' ? pendingRestart.target.skinId : undefined, pendingRestart.target.kind)}>{restartAvailable ? '重启' : '查看重启提示'}</Button>}
    onDismiss={() => setPendingRestart(null)}
  />
  const marketUpdateActive = marketOperation !== null && !['done', 'failed', 'cancelled'].includes(marketOperation.phase)

  return (
    <section className={css.root} data-dsh-skin-market data-layout={layout} data-detail={showDetail ? 'open' : 'closed'} data-browser-open={browserOpen ? 'true' : 'false'}>
      {browserOpen && selected !== undefined && <GalleryPreloads skin={selected} screenshots={selectedScreenshots} />}
      <main className={css.home} hidden={browserOpen && layout === 'fill'}>
        <header className={css.homeHeader} ref={homeHeaderRef} data-sticky={homeHeaderSticky ? 'true' : 'false'} data-compact={homeCompact ? 'true' : undefined}>
          <div className={css.homeTitleRow}>
            <div><h2>{t('title')}</h2><p>{skins.length} 款社区皮肤</p></div>
            <div className={css.homeActions}>
              {marketUpdate?.updateAvailable === true && <Button
                className={`${css.marketUpdateButton} ${css.homeUpdateAction}`}
                variant="outline"
                size="sm"
                icon={marketUpdating ? <IconLoadingOutline /> : <IconDownloadOutline />}
                aria-label={`更新皮肤市场到 ${marketUpdate.latestVersion}`}
                title={`发现新版本 ${marketUpdate.latestVersion}`}
                disabled={marketUpdating || marketUpdateActive || operations.some(isLiveOperation) || marketWriteReason !== undefined}
                data-updating={marketUpdating || marketUpdateActive ? 'true' : undefined}
                onClick={() => { void updateMarket() }}
              ><span className={css.marketUpdateLabel}>{marketUpdating ? '更新中' : '更新'}</span></Button>}
              <Button className={css.homeGithubAction} variant="outline" size="sm" icon={<MarkGithubIcon size={15} aria-hidden="true" />} aria-label="打开 GitHub 仓库" title="打开 GitHub 仓库" onClick={() => window.open(REGISTRY_REPOSITORY, '_blank', 'noopener,noreferrer')}><span className={css.homeGithubLabel}>GitHub</span></Button>
              <Button className={css.homeSubmitAction} variant="outline" size="sm" icon={<UploadSimpleIcon size={15} aria-hidden="true" />} onClick={() => { setShowSubmission(true); setSubmissionCopied(false) }}>提交皮肤</Button>
            </div>
          </div>
          <Input className={css.homeSearch} value={homeQuery} onChange={event => setHomeQuery(event.currentTarget.value)} icon={<IconSearchOutline />} placeholder={t('search')} aria-label={t('search')} />
          <div className={css.homeSearchPlaceholder} aria-hidden="true" />
          {renderSkinOperationBanner(css.homeOperation)}
          {renderMarketOperationBanner(css.homeOperation)}
          {renderPendingRestartBanner(css.homeOperation)}
          {(profileBusy !== undefined || managementNotice !== '') && <p className={css.notice} role="status">{profileBusy ?? managementNotice}</p>}
        </header>

        <div className={css.homeContent} ref={homeRef} onScroll={event => {
          if (layout !== 'fill') return
          const home = event.currentTarget
          setHomeCompact(current => current
            ? home.scrollTop > HOME_COMPACT_EXIT_SCROLL
            : home.scrollTop > HOME_COMPACT_ENTER_SCROLL)
          if (discoverySkins.length > homeVisibleCount && home.scrollHeight - home.scrollTop - home.clientHeight < 560) {
            setHomeVisibleCount(value => Math.min(discoverySkins.length, value + CATALOG_BATCH_SIZE))
          }
        }}>
          {homeQuery.trim() === '' && (loading || installedSkins.length > 0) && <section className={css.homeSection} aria-labelledby="installed-skins-title">
            <div className={css.homeSectionTitle}><h3 id="installed-skins-title">已安装</h3><span>正在使用、常驻优先，其余按最近操作排序</span></div>
            {loading ? <div className={css.installedRow} style={{ '--installed-columns': installedSlots } as CSSProperties} role="status" aria-label="正在加载已安装皮肤"><span className={css.srOnly}>正在加载已安装皮肤…</span>{Array.from({ length: installedSlots }, (_, index) => <article className={css.installedSkeletonCard} key={index} aria-hidden="true"><span /><span><i /><i /></span></article>)}</div> : <div className={css.installedRow} style={{ '--installed-columns': installedSlots } as CSSProperties}>
              {installedRowSkins.map(skin => renderHomeCard(skin, 'installed'))}
              {installedOverflow && <Button variant="ghost" className={`${css.homeCard} ${css.installedMoreCard}`} onClick={() => openInstalledBrowser()}><SquaresFourIcon size={24} aria-hidden="true" /><strong>查看全部已安装</strong></Button>}
            </div>}
          </section>}

          <section className={css.homeSection} aria-labelledby="discover-skins-title">
            <div className={css.homeSectionTitle}>
              <h3 id="discover-skins-title">{homeQuery.trim() === '' ? '发现更多' : '搜索结果'}</h3>
              <Button className={css.sortButton} variant="ghost" size="sm" onClick={() => setSortBy(value => value === 'stars' ? 'latest' : 'stars')}>{sortBy === 'stars' ? 'Stars' : '最新'} <IconChevronDownOutline /></Button>
            </div>
            {catalogLoading && skins.length === 0 ? <div className={css.homeLoading}><IconLoadingOutline /> 正在加载皮肤…</div> : visibleDiscoverySkins.length > 0 ? <div className={css.discoveryGrid}>
              {visibleDiscoverySkins.map(skin => renderHomeCard(skin, 'discover'))}
            </div> : <p className={css.empty}>没有匹配的皮肤</p>}
            {error !== null && !browserOpen && <div className={css.homeError} role="alert">{error}</div>}
            {!catalogLoading && homeVisibleCount < discoverySkins.length && <div className={css.homeLoadMore} ref={homeLoadMoreRef} aria-hidden="true"><span /><span /></div>}
          </section>
        </div>
      </main>

      <Modal open={browserOpen} onClose={closeBrowser} title="皮肤详情" closeLabel="关闭" className={css.browserModal} contentClassName={css.browserContent}>
      <section className={css.browser} data-detail={showDetail ? 'open' : 'closed'} aria-label="皮肤详情">
        <div className={css.browserPanel}>
      <aside className={css.catalog} aria-label={t('catalog')}>
        <div className={css.catalogHeader}>
          <Input value={query} onChange={event => setQuery(event.currentTarget.value)} icon={<IconSearchOutline />} placeholder={t('search')} aria-label={t('search')} />
          <div className={css.filterBar}>
            <div className={css.filters}>
              <Pill className={css.filterPill} active={filter === 'all'} aria-pressed={filter === 'all'} onClick={() => { setFilter('all'); setSortBy('stars') }}>全部</Pill>
              <Pill className={css.filterPill} active={filter === 'installed'} aria-pressed={filter === 'installed'} onClick={() => setFilter('installed')}>已安装</Pill>
            </div>
            <Button className={css.sortButton} variant="ghost" size="sm" onClick={() => setSortBy(value => value === 'stars' ? 'latest' : 'stars')}>
              {sortBy === 'stars' ? 'Stars' : '最新'} <IconChevronDownOutline />
            </Button>
          </div>
        </div>
        <div className={css.skinList} ref={skinListRef} onScroll={event => {
          const list = event.currentTarget
          if (filtered.length > visibleCount && list.scrollHeight - list.scrollTop - list.clientHeight < 320) {
            setVisibleCount(value => Math.min(filtered.length, value + CATALOG_BATCH_SIZE))
          }
        }}>
          {catalogLoading && skins.length === 0 ? <div className={css.listSkeleton} role="status" aria-label="正在加载皮肤列表"><span className={css.srOnly}>正在加载皮肤列表…</span>{Array.from({ length: 8 }, (_, index) => <div className={css.skeletonCard} key={index} aria-hidden="true"><span /><span><i /><i /></span><i /></div>)}</div> : visibleSkins.map(skin => {
            const itemState = runtimeFor(states, skin.id)
            const live = liveOperationFor(operations, skin.id)
            const mutationLabel = live === undefined ? null : mutationLabels[live.kind]
            return <Button key={skin.id} variant="ghost" className={css.skinCard} data-skin-id={skin.id} data-selected={skin.id === selected?.id} aria-current={skin.id === selected?.id ? 'true' : undefined} onClick={() => select(skin.id)}>
              <span className={`${css.skinCardPreview} dsh-skin-media-hover`}><PreviewMedia key={`${skin.id}:${getCatalogListScreenshot(skin) ?? 'missing'}:list`} skin={skin} src={getCatalogListScreenshot(skin)} fallbackSources={getCatalogScreenshotUrls(skin)} alt={`${skin.name.zh} 界面预览`} kind="list" loading="lazy" /></span>
              <span className={css.skinCardBody}>
                <span className={css.cardTitle}>{skin.name.zh}</span>
                <span className={css.cardDescription} title={skin.description}>{displayTitle(skin.description)}</span>
                <span className={css.cardMetaLine}>
                  <span className={css.cardMeta} title={githubRepoLabel(skin.repo)}>{githubRepoLabel(skin.repo)}</span>
                  <span className={css.cardStars} title={`GitHub Stars 快照，更新于 ${displayDate(skin.starsUpdatedAt)}`}><StarIcon size={12} aria-hidden="true" /> {skin.githubStars}</span>
                </span>
              </span>
              <StatusLabel active={mutationLabel === null && itemState.activation === 'active'}>{mutationLabel ?? (itemState.activation === 'active' ? compactStatusLabel(itemState) : itemState.updateAvailable && !isManualOnly(skin) ? '可更新' : compactStatusLabel(itemState))}</StatusLabel>
            </Button>
          })}
          {!catalogLoading && visibleCount < filtered.length && <div className={css.loadMoreHint} aria-hidden="true"><span /><span /></div>}
          {!catalogLoading && filtered.length === 0 && <p className={css.empty}>没有匹配的皮肤</p>}
          {!loading && filter === 'installed' && installedClientPlugins.map(plugin => <div className={`${css.skinCard} ${css.externalPlugin}`} key={plugin.package}>
            <span className={css.skinCardBody}>
              <span className={css.cardTitle}>{plugin.package}</span>
              <span className={css.cardMetaLine}>市场外客户端插件 · {plugin.version ?? '版本未知'} · {plugin.registered ? `已注册 ${plugin.rowIds.join(', ')}` : '尚未发现 loader 注册项'}</span>
            </span>
            <StatusLabel>市场外</StatusLabel>
          </div>)}
          {!loading && browserOpen && selected === undefined && error !== null && <div className={css.error} role="alert">{error}</div>}
        </div>
      </aside>

      <main className={css.detail} ref={detailRef} aria-label="皮肤详情内容">
        {loading ? <div className={css.detailSkeleton} role="status" aria-label="正在加载皮肤详情"><p className={css.srOnly}>正在加载皮肤详情…</p><div><span /><i /></div><span /><span /><span /></div> : selected !== undefined && state !== null ? <>
          <Button className={css.mobileBack} variant="outline" size="sm" icon={<IconChevronLeftOutline />} onClick={() => browserOrigin === 'discover' ? closeBrowser() : setShowDetail(false)}>{browserOrigin === 'discover' ? '返回发现' : '返回列表'}</Button>
          <header className={css.detailHeader}>
            <div className={css.skinAvatar}><PreviewMedia key={`${selected.id}:${getCatalogListScreenshot(selected) ?? 'missing'}:avatar`} skin={selected} src={getCatalogListScreenshot(selected)} alt="" kind="avatar" /></div>
            <div className={css.titleBlock}>
              <h2>{selected.name.zh}</h2>
              <p className={css.description} title={selected.description}>{displayTitle(selected.description)}</p>
              <p className={css.author}>{githubRepoLabel(selected.repo)}</p>
              <p className={css.version}>版本 {selected.install.version}<span aria-hidden="true"> · </span>{compatibilityUnverified ? 'DSH 兼容性待验证' : `兼容 DSH ${selected.compatibility.dsh}`}{runtime?.version !== undefined && runtime.version !== null && <><span aria-hidden="true"> · </span>当前 DSH {runtime.version}</>}<StatusLabel active={state.activation === 'active'}>{statusLabel(state)}</StatusLabel></p>
            </div>
          </header>

          <div className={css.actionRow}>
              {state.installation === 'missing' && <>
                {autoInstallable && (officialDesktop || !deferInstallAndUse) && <Button variant="primary" size="sm" icon={<IconDownloadOutline />} disabled={selectedBusy !== undefined || installAndUseReason !== null || officialDesktop && deferInstallAndUse} title={installAndUseReason ?? (officialDesktop && deferInstallAndUse ? '请等待当前安装完成，再安装其他皮肤' : installRequiresRestart ? DESKTOP_INSTALL_RESTART_GUIDANCE : undefined)} onClick={() => void installAndActivate()}>{officialDesktop ? '安装' : '安装并使用'}</Button>}
                {autoInstallable && !officialDesktop && <Button variant={deferInstallAndUse ? 'primary' : 'outline'} size="sm" icon={deferInstallAndUse ? <IconDownloadOutline /> : undefined} disabled={selectedBusy !== undefined || actionReason('install') !== null} title={deferInstallAndUse ? '先安装，当前有其他皮肤正在安装，完成后再使用' : undefined} onClick={() => void run('install')}>{deferInstallAndUse ? '安装' : '仅安装'}</Button>}
                {autoInstallable && <Button variant="outline" size="sm" disabled={selectedBusy !== undefined} onClick={() => { setInstallCopied(null); setShowInstallOptions(true) }}>其他安装方式</Button>}
                {manualOnly && <Button variant="outline" size="sm" icon={<MarkGithubIcon size={16} />} disabled={selectedBusy !== undefined} title="打开手动安装面板" onClick={() => { setInstallCopied(null); setShowInstallOptions(true) }}>检查并指导安装</Button>}
              </>}
              {state.installation === 'installed' && state.activation === 'inactive' && <Button variant="primary" size="sm" disabled={selectedBusy !== undefined || actionReason('activate') !== null} onClick={activateSelected}>使用</Button>}
              {state.installation === 'installed' && state.activation === 'unavailable' && <Button variant="primary" size="sm" disabled={selectedBusy !== undefined || actionReason('activate') !== null} onClick={activateSelected}>重新使用</Button>}
              {state.installation === 'installed' && state.activation === 'inactive' && <Button className={css.pinAction} variant="outline" size="sm" aria-pressed="false" title="在不替换当前主皮肤的情况下启用并常驻，适合宠物、音效等可叠加插件；多个皮肤可能发生冲突" disabled={selectedBusy !== undefined || actionReason('pin') !== null} onClick={() => setConfirmPin(true)}>常驻使用</Button>}
              {state.activation === 'restart-required' && selectedBusy === undefined && !selectedInstallAndUsePending && (restartAvailable
                ? <Button variant="primary" size="sm" disabled={selectedBusy !== undefined} title={restartInstallBlock ?? undefined} onClick={() => void openRestartConfirm()}>重启以应用</Button>
                : pendingRestart?.target.kind === 'skin' && pendingRestart.target.skinId === selected.id ? null
                : <Button variant="outline" size="sm" onClick={() => void openRestartConfirm()}>查看重启提示</Button>)}
              {(state.activation === 'active' || state.activation === 'unavailable') && <Button variant="outline" size="sm" disabled={selectedBusy !== undefined || actionReason('deactivate') !== null} onClick={() => void run('deactivate')}>停用</Button>}
              {state.activation === 'active' && <Button className={css.pinAction} variant="outline" size="sm" aria-pressed={state.pinned === true} title={state.pinned ? '取消后，如果它不是当前主皮肤，将立即停用；以后切换皮肤时也不会再保留' : '切换其他皮肤时仍保持启用，适合宠物、音效等可叠加插件；多个皮肤可能发生冲突'} disabled={selectedBusy !== undefined || actionReason(state.pinned ? 'unpin' : 'pin') !== null} onClick={() => state.pinned ? void run('unpin') : setConfirmPin(true)}>{state.pinned ? '取消常驻' : '常驻使用'}</Button>}
              {state.activation === 'restart-required' && state.pinned && <Button className={css.pinAction} variant="outline" size="sm" aria-pressed="true" title="取消常驻并撤销待重启的启用状态" disabled={selectedBusy !== undefined || actionReason('unpin') !== null} onClick={() => void run('unpin')}>取消常驻</Button>}
              {state.updateAvailable && !manualOnly && <Button variant={state.activation === 'active' && !state.pinned ? 'primary' : 'outline'} size="sm" icon={<IconRefreshOutline />} disabled={selectedBusy !== undefined || actionReason('update') !== null} onClick={() => void run('update')}>更新</Button>}
              {hostKind === 'dsh' && state.installation === 'installed' && state.sourceMigration !== undefined && !manualOnly && <Button variant="outline" size="sm" disabled={selectedBusy !== undefined} onClick={() => setConfirmMigration({ skin: selected, source: state.sourceMigration! })}>换用 npm</Button>}
              {state.installation !== 'missing' && <Button className={css.iconOnlyButton} variant="outline" size="sm" icon={<IconTrashOutline />} aria-label="卸载" title="卸载" disabled={selectedBusy !== undefined || actionReason('uninstall') !== null} onClick={() => setConfirmUninstall(true)} />}
              <span className={css.actionDivider} aria-hidden="true" />
              <span className={css.repoMeta}>
                <span className={css.stars} title={`GitHub Stars 快照，更新于 ${displayDate(selected.starsUpdatedAt)}`}><StarIcon size={16} aria-hidden="true" /> {selected.githubStars}</span>
                <a className={css.repoLink} href={selected.repo} target="_blank" rel="noreferrer" title={selected.repo}><MarkGithubIcon size={16} aria-hidden="true" /><span>{selected.repo.replace('https://', '')}</span></a>
              </span>
          </div>

          {state.installation === 'installed' && state.activation === 'inactive' && !activationWarningAccepted && <p className={css.notice} role="note">首次启用提示：使用后会自动停用市场内的其他普通皮肤，保留常驻项。市场外安装的皮肤、主题请先在设置 → 插件中停用，避免样式冲突。</p>}
          {(selected.install.companions?.length ?? 0) > 0 && <p className={css.notice} role="note">使用该皮肤时会加载细节定制面板；停用或换到其他皮肤后会从设置页撤掉，不会当成一张独立皮肤。</p>}

          {profileBusy !== undefined && <p className={css.notice} role="status">{profileBusy}</p>}
          {managementNotice !== '' && <p className={css.notice} role="note">{managementNotice}</p>}
          {renderSkinOperationBanner()}
          {renderMarketOperationBanner()}
          {renderPendingRestartBanner()}
          {error !== null && <div className={css.error} role="alert">{error}</div>}
          {state.activation === 'unavailable' && state.error !== undefined && <div className={css.error} role="status">{state.error}</div>}

          <div className={css.galleryGroup} data-paused={galleryPaused ? 'true' : 'false'} onMouseEnter={() => setCarouselPausedState(true)} onMouseLeave={() => setCarouselPausedState(false)} onFocusCapture={() => setCarouselPausedState(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setCarouselPausedState(false) }}>
            <div className={css.hero}>
              <button className={`${css.heroOpen} dsh-skin-media-hover`} aria-label={`全屏查看 ${selected.name.zh} 截图 ${shotIndex + 1}`} onClick={() => setLightboxOpen(true)}>
                <PreviewMedia key={`${selected.id}:${selectedScreenshots[shotIndex] ?? 'missing'}:hero`} skin={selected} src={selectedScreenshots[shotIndex]} alt={`${selected.name.zh} 大图预览`} kind="hero" />
              </button>
              {shotCount > 1 && <><Button className={`${css.heroNav} ${css.heroPrev}`} variant="ghost" icon={<IconChevronLeftOutline size={18} />} aria-label="上一张截图" onClick={() => moveShot(-1)} /><Button className={`${css.heroNav} ${css.heroNext}`} variant="ghost" icon={<IconChevronLeftOutline size={18} />} aria-label="下一张截图" onClick={() => moveShot(1)} /></>}
            </div>
            {selectedScreenshots.length > 1 && <div className={css.thumbnails} ref={thumbnailStripRef} aria-label="截图选择">
              {selectedScreenshots.map((shot, index) => <span className={css.thumbnailFrame} key={shot}><Button className="dsh-skin-media-hover" variant="ghost" data-selected={index === shotIndex} onClick={() => { setShotIndex(index); setCarouselEpoch(current => current + 1) }}><PreviewMedia skin={selected} src={shot} alt={`${selected.name.zh} 截图 ${index + 1}`} kind="thumbnail" loading="lazy" /></Button>{index === shotIndex && <span className={css.thumbnailProgress} key={`${selected.id}:${shotIndex}:${carouselEpoch}`} aria-hidden="true" />}</span>)}
            </div>}
          </div>

          <div className={css.aboutGrid}>
            <article><h3>关于此皮肤</h3><p>{selected.description}</p><div className={css.tags}>{selected.tags.map(tag => <Pill key={tag}>{tag}</Pill>)}</div><dl className={css.metadata}><div><dt>许可证</dt><dd>{selected.license.code}</dd></div><div><dt>代码商业使用</dt><dd>{selected.license.commercialUse ? '许可证允许' : '未获授权'}</dd></div><div><dt>模式</dt><dd>{selected.modes.join(' / ')}</dd></div></dl>{manualOnly && <p className={css.notice}>{manualHealthNotice}</p>}{selected.review?.preview === 'repository-card' && !(selected.marketScreenshots?.length) && <p className={css.notice}>该仓库暂无可识别的皮肤截图，市场使用本地占位卡，不会加载 GitHub 仓库图片。</p>}{usesMarketScreenshots(selected) && <p className={css.notice}>当前展示的是市场在隔离 DSH 中实机补录的截图；仓库尚无可识别的界面截图。</p>}{selected.license.notice && <p className={css.notice}>{selected.license.notice}</p>}</article>
            <aside className={css.changelog}><h3>仓库健康</h3>{selected.health ? <><ol className={css.healthList}>{Object.entries(selected.health.checks).map(([key, value]) => <li key={key}><strong>{healthLabels[key as keyof typeof healthLabels]}</strong><span data-health={value}>{value === 'pass' ? '符合要求' : '建议完善'}</span></li>)}</ol>{selected.health.suggestions.map(suggestion => <p className={css.healthSuggestion} key={suggestion}>{suggestion}</p>)}</> : <p className={css.healthSuggestion}>等待下一次仓库健康扫描。</p>}<h3 className={css.collectionTitle}>收录信息</h3><ol><li><strong>{selected.install.version}</strong><span>版本快照更新于 {displayDate(selected.releaseUpdatedAt)}</span></li><li><strong>Stars</strong><span>{selected.githubStars}，更新于 {displayDate(selected.starsUpdatedAt)}</span></li><li><strong>兼容</strong><span>{compatibilityUnverified ? '等待维护者声明 DSH 兼容范围' : `支持 DSH ${selected.compatibility.dsh}`}</span></li></ol><a href={selected.repo} target="_blank" rel="noreferrer">查看仓库详情</a></aside>
          </div>

          <section className={css.recommendations}><h3>更多推荐</h3><div>{recommendations.map(skin => renderHomeCard(skin, 'discover'))}</div></section>
        </> : <div className={css.loading}>暂无可展示的皮肤详情</div>}
      </main>
        </div>
      </section>
      </Modal>

      {lightboxOpen && selected !== undefined && createPortal(<section className={css.lightbox} role="dialog" aria-modal="true" aria-label={`${selected.name.zh} 全屏截图查看`}>
        <Button className={css.lightboxClose} variant="ghost" icon={<XIcon size={20} />} aria-label="关闭全屏查看" onClick={() => setLightboxOpen(false)} />
        {shotCount > 1 && <Button className={`${css.lightboxNav} ${css.lightboxPrev}`} variant="ghost" icon={<IconChevronLeftOutline size={26} />} aria-label="上一张截图" onClick={() => moveShot(-1)} />}
        <button className={css.lightboxStage} aria-label="退出全屏查看" onClick={() => setLightboxOpen(false)}><PreviewMedia key={`${selected.id}:${selectedScreenshots[shotIndex] ?? 'missing'}:lightbox`} skin={selected} src={selectedScreenshots[shotIndex]} alt={`${selected.name.zh} 全屏截图 ${shotIndex + 1}`} kind="hero" /></button>
        {shotCount > 1 && <Button className={`${css.lightboxNav} ${css.lightboxNext}`} variant="ghost" icon={<IconChevronLeftOutline size={26} />} aria-label="下一张截图" onClick={() => moveShot(1)} />}
        {shotCount > 1 && <div className={css.lightboxThumbnails} aria-label="全屏截图选择">{selectedScreenshots.map((shot, index) => <Button className="dsh-skin-media-hover" variant="ghost" key={shot} data-selected={index === shotIndex} aria-label={`查看截图 ${index + 1}`} onClick={() => setShotIndex(index)}><PreviewMedia skin={selected} src={shot} alt="" kind="thumbnail" loading="lazy" /></Button>)}</div>}
      </section>, document.body)}

      <Modal
        open={buildApprovalOperation !== null}
        onClose={() => setDismissedBuildApprovalId(buildApprovalOperation?.id ?? null)}
        title="需要批准构建脚本"
        closeLabel="关闭"
        description={buildApprovalOperation?.failure?.message ?? ''}
        footer={<><Button variant="outline" size="sm" onClick={() => setDismissedBuildApprovalId(buildApprovalOperation?.id ?? null)}>稍后</Button><Button variant="primary" size="sm" onClick={approveBuildAndRetry}>批准并重试</Button></>}
      >
        <p className={css.notice}>pnpm 默认阻止依赖执行安装构建脚本。确认后只批准这次报错中列出的精确构建项，不会开启全局构建脚本。</p>
        {(buildApprovalOperation?.failure?.buildKeys?.length ?? 0) > 0 ? <p className={css.notice}>待批准构建：<code>{buildApprovalOperation?.failure?.buildKeys?.join('、')}</code></p> : buildApprovalOperation?.failure?.packageName !== undefined && <p className={css.notice}>涉及依赖：<code>{buildApprovalOperation.failure.packageName}</code></p>}
      </Modal>
      <Modal open={confirmUninstall} onClose={() => setConfirmUninstall(false)} title="卸载皮肤" closeLabel="关闭" description={state?.activation === 'active' ? '当前皮肤会先停用并恢复 DSH 默认外观，然后删除安装包。' : '将从当前 DSH profile 删除这个皮肤安装包。'} footer={<><Button variant="outline" size="sm" onClick={() => setConfirmUninstall(false)}>取消</Button><Button variant="primary" size="sm" onClick={() => { setConfirmUninstall(false); void run('uninstall') }}>确认卸载</Button></>} />
      <Modal open={confirmPin} onClose={() => setConfirmPin(false)} title="常驻使用此皮肤" closeLabel="关闭" description="开启后，切换其他皮肤时不会自动停用此皮肤。适合宠物、音效等可叠加插件；多个皮肤可能同时修改样式、页面结构或功能，相关冲突风险由用户自行承担。" footer={<><Button variant="outline" size="sm" onClick={() => setConfirmPin(false)}>取消</Button><Button variant="primary" size="sm" onClick={() => { setConfirmPin(false); void run('pin') }}>确认常驻</Button></>}><p className={css.pinWarning}>如果发生冲突或页面无法操作，请停止 DSH，然后查看 <ResetHelpLink /> 中的修复命令。</p></Modal>
      <Modal
        open={confirmMigration !== null}
        onClose={() => setConfirmMigration(null)}
        title="换用 npm 安装源"
        closeLabel="关闭"
        description={`${confirmMigration?.skin.name.zh ?? '此皮肤'}将换用已验证的同版本 npm 包。保留当前启用和常驻状态，后续更新也使用 npm。正在使用的皮肤完成后需要重启。`}
        footer={<><Button variant="outline" size="sm" onClick={() => setConfirmMigration(null)}>取消</Button><Button variant="primary" size="sm" disabled={confirmMigration !== null && liveOperationFor(operations, confirmMigration.skin.id) !== undefined} onClick={() => {
          if (confirmMigration === null) return
          const { skin } = confirmMigration
          setConfirmMigration(null)
          void runForSkin(skin.id, 'migrate')
        }}>确认换用 npm</Button></>}
      >
        <p className={css.migrationSource}>当前来源：<code>{confirmMigration?.source.currentSource}</code></p>
        <p className={css.migrationSource}>目标来源：<code>{confirmMigration?.source.target}</code></p>
      </Modal>
      <Modal
        open={intercept !== null}
        onClose={dismissIntercept}
        title={intercept?.title ?? '已拦截安装'}
        closeLabel="关闭"
        description={intercept?.what ?? ''}
        footer={<>
          <Button
            variant="outline"
            size="sm"
            icon={<IconCopyOutline />}
            disabled={interceptLogId === undefined || copyingLogId === interceptLogId}
            onClick={() => { if (interceptLogId !== undefined) void copyOperationLog(interceptLogId) }}
          >{copiedLogId === interceptLogId ? '日志已复制' : copyingLogId === interceptLogId ? '复制中…' : '复制日志'}</Button>
          <Button variant="primary" size="sm" onClick={dismissIntercept}>确认</Button>
        </>}
      >
        {intercept !== null && <div className={css.interceptNotice}>
          <p><strong>为什么会这样</strong>{intercept.why}</p>
          {intercept.links.length > 0 && <div className={css.interceptHelp}>
            {intercept.links.map(link => (
              <a key={link.href} className={css.repoLink} href={link.href} target="_blank" rel="noreferrer">
                <MarkGithubIcon size={15} aria-hidden="true" />
                {link.label}
              </a>
            ))}
          </div>}
          {copyLogError !== null && <p className={css.notice} role="alert">{copyLogError}</p>}
        </div>}
      </Modal>
      <Modal
        open={showInstallOptions}
        onClose={() => setShowInstallOptions(false)}
        title={`安装 ${selected?.name.zh ?? '皮肤'}`}
        closeLabel="关闭"
        description={manualOnly ? `${manualInstallNotice}复制提示词，让 Agent 检查冲突并逐步指导；桌面端由你在插件页操作。` : '任选一种，不用都执行。'}
        footer={manualOnly ? undefined : <Button variant="outline" size="sm" onClick={() => setShowInstallOptions(false)}>关闭</Button>}
      >
        <div className={css.installOptions}>
          <div><strong>{manualOnly ? '让 Agent 检查并指导安装' : '提示词'}</strong><span className={css.copyCapsule}><code title={installPrompt}>{installPrompt}</code><Button className={css.copyCapsuleButton} variant="outline" size="sm" icon={<IconCopyOutline />} aria-label={installCopied === `${selected?.id}:prompt` ? '提示词已复制' : '复制提示词'} title="复制提示词" onClick={() => void copyInstallOption('prompt')} /></span></div>
          {manualOnly && selected !== undefined && <div className={css.manualInstallGuide}>
            <strong>插件页安装目标</strong>
            <p>也可自行打开「插件 → 添加插件」，输入：</p>
            <span className={css.copyCapsule}>
              <Input className={css.copyCapsuleInput} readOnly value={manualInstallKeyword} aria-label="插件页安装目标" />
              <Button className={css.copyCapsuleButton} variant="ghost" size="sm" icon={<IconCopyOutline />} aria-label={installCopied === `${selected.id}:keyword` ? '插件页安装目标已复制' : '复制插件页安装目标'} title="复制插件页安装目标" onClick={() => void copyInstallOption('keyword')} />
            </span>
          </div>}
          {!manualOnly && <div><strong>命令</strong><span className={css.copyCapsule}><code title={selected === undefined ? '' : createSkinInstallCommand(selected)}>{selected === undefined ? '' : createSkinInstallCommand(selected)}</code><Button className={css.copyCapsuleButton} variant="outline" size="sm" icon={<IconCopyOutline />} aria-label={installCopied === `${selected?.id}:command` ? '命令已复制' : '复制命令'} title="复制命令" onClick={() => void copyInstallOption('command')} /></span><small>{CLI_INSTALL_WARNING}</small></div>}
        </div>
      </Modal>
      <Modal
        open={compatibilityConfirmation !== null}
        onClose={() => finishCompatibilityConfirmation(false)}
        title="兼容性提示"
        closeLabel="关闭"
        description={`${compatibilityConfirmation?.changed ? '皮肤安装目标或当前 DSH 信息已变化，请重新确认。' : ''}${compatibilityConfirmation?.skin.name.zh ?? '此皮肤'}（版本 ${compatibilityConfirmation?.skin.install.version ?? ''}）：${compatibilityConfirmation?.assessment.reason ?? ''}。继续后可能安装失败、功能异常或页面无法操作。你可以取消，或确认后继续本次${compatibilityConfirmation?.actionLabel ?? '操作'}。`}
        footer={<><Button variant="outline" size="sm" onClick={() => finishCompatibilityConfirmation(false)}>取消</Button><Button variant="primary" size="sm" onClick={() => finishCompatibilityConfirmation(true)}>仍然{compatibilityConfirmation?.actionLabel}</Button></>}
      >
        <p className={css.notice}>若使用后页面异常，请查看 <ResetHelpLink />。</p>
      </Modal>
      <Modal
        open={confirmRestart || compatibilityWarning !== null}
        onClose={() => { if (!restarting) { setConfirmRestart(false); setCompatibilityWarning(null) } }}
        title={confirmRestart ? (manualDesktopRestart ? '请手动重启 Desktop App' : restartTarget?.kind === 'market-update' ? '需要重启 DSH 应用皮肤市场更新' : '需要重启 DSH 应用此皮肤') : '兼容性提示'}
        closeLabel="关闭"
        description={confirmRestart
          ? (manualDesktopRestart
            ? manualRestartDescription
            : restarting ? '正在重新启动 DSH，请稍候…' : restartInstallBlock !== null ? restartInstallBlock : runningAgents === null && !restartCheckFinished ? '正在检查是否有 Agent 运行。状态确认前不能重启。' : runningAgents === null ? '当前 Host 尚未加载安全检查。请确认没有 Agent 正在运行、重要内容已保存；你可以继续完成这一次升级重启。新版本加载后会自动检测 Agent 状态。' : runningAgents > 0 ? `检测到 ${runningAgents} 个 Agent 正在运行，现在不能重启。请等待任务完全结束后再试，否则可能中断任务并导致会话历史无法加载。` : restartTarget?.kind === 'market-update' ? `Agent 状态检查已通过。但重启仍会关闭所有会话连接；即使回复已经停止显示，也请确认重要内容已保存，且没有即将开始的新任务。皮肤市场新版本 ${marketUpdate?.latestVersion ?? ''} 将在重启后生效。` : 'Agent 状态检查已通过。但重启仍会关闭所有会话连接；即使回复已经停止显示，也请确认重要内容已保存，且没有即将开始的新任务。')
          : undefined}
        footer={confirmRestart
          ? <><Button variant="outline" size="sm" disabled={restarting} onClick={() => { setConfirmRestart(false); setCompatibilityWarning(null) }}>稍后</Button>{!manualDesktopRestart && <Button variant="primary" size="sm" disabled={restarting || restartInstallBlock !== null || (runningAgents === null && !restartCheckFinished) || (runningAgents ?? 0) > 0} onClick={() => void restartNow()}>{restarting ? '正在重启…' : restartInstallBlock !== null ? '有皮肤正在安装' : runningAgents === null && !restartCheckFinished ? '正在检查…' : runningAgents === null ? '我已确认无任务，仍然重启' : runningAgents > 0 ? '有任务运行中' : '确认无任务，立即重启'}</Button>}</>
          : <Button variant="primary" size="sm" onClick={() => setCompatibilityWarning(null)}>知道了</Button>}
      >
        {compatibilityWarning !== null && <CompatibilityWarningNote assessment={compatibilityWarning} />}
      </Modal>
      <Modal
        open={showSubmission}
        onClose={() => setShowSubmission(false)}
        title="提交你的皮肤"
        closeLabel="关闭"
        description="复制下面的提示词交给你的 Agent，它会确认皮肤仓库、完成检查并准备市场 PR。"
        footer={<><Button variant="outline" size="sm" onClick={() => setShowSubmission(false)}>关闭</Button><Button variant="primary" size="sm" onClick={() => void copySubmissionPrompt()}>{submissionCopied ? '已复制' : '复制提示词'}</Button></>}
      >
        <div className={css.submission}>
          <textarea aria-label="Agent 投稿提示词" readOnly value={submissionPrompt} rows={16} />
          <small>提示词不会授权 Agent 安装皮肤到你的 DSH，也不会把 Topic 收录等同于安全审核。</small>
        </div>
      </Modal>
    </section>
  )
}
