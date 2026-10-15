import { randomUUID } from 'node:crypto'
import { closeSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit, type Scalar, type YAMLSeq } from 'yaml'
import { parseVersion } from './semver.ts'

export interface ReleaseAgeTarget { packageName: string; version: string }

const KEY = 'minimumReleaseAgeExclude'
const PACKAGE_NAME = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/
const NUMBER = '(?:0|[1-9][0-9]*)'
const PRERELEASE = `(?:${NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`
const EXACT_VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${PRERELEASE}(?:\\.${PRERELEASE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`)

/** Input to a precise local exemption must never be a selector, URL or command. */
export function parseReleaseAgeTarget(packageName: string, version: string): ReleaseAgeTarget | undefined {
  if (typeof packageName !== 'string' || typeof version !== 'string' || packageName.length > 214 || !PACKAGE_NAME.test(packageName)
    || !EXACT_VERSION.test(version)) return undefined
  const parsed = parseVersion(version)
  if (parsed === null || parsed.core.some(part => !Number.isSafeInteger(part))) return undefined
  return { packageName, version }
}

export class ReleaseAgeConfigurationError extends Error {
  constructor(public readonly code: 'unavailable' | 'unsafe' | 'changed' | 'write-failed' | 'invalid-target') {
    super({
      unavailable: '未找到可安全修改的 Desktop 包管理配置，请在正确的 Desktop 安装目录中处理。',
      unsafe: 'Desktop 的新包例外配置包含无法安全合并的规则，请手动整理后重试。',
      changed: 'Desktop 的包管理配置刚被其他操作修改，请刷新后重试。',
      'write-failed': '无法保存 Desktop 的精确版本例外，请检查安装目录的写入权限。',
      'invalid-target': '无法确认需要放行的包和精确版本，请重新获取安装错误。',
    }[code])
    this.name = 'ReleaseAgeConfigurationError'
  }
}

interface Rule { node: Scalar<string>; packageName: string; versions: string[] | null }
interface Workspace { file: string; source: string; identity: string; mode: number; rules: Rule[]; sequence?: YAMLSeq }
interface Edit { start: number; end: number; value: string }

function identity(file: string): { value: string; mode: number } {
  const stat = lstatSync(file, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ReleaseAgeConfigurationError('unavailable')
  return { value: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`, mode: Number(stat.mode & 0o777n) }
}

function parseRule(node: unknown): Rule | undefined {
  if (!isScalar(node) || typeof node.value !== 'string' || node.range === undefined || node.range === null) return undefined
  const text = node.value
  const separator = text.indexOf('@', text.startsWith('@') ? 1 : 0)
  if (separator === -1) return PACKAGE_NAME.test(text) ? { node: node as Scalar<string>, packageName: text, versions: null } : undefined
  const packageName = text.slice(0, separator)
  const versions = text.slice(separator + 1).split(/[ \t]*\|\|[ \t]*/)
  if (versions.length === 0 || versions.some(version => parseReleaseAgeTarget(packageName, version) === undefined)) return undefined
  return { node: node as Scalar<string>, packageName, versions }
}

function readWorkspace(profileDir: string): Workspace {
  const file = join(profileDir, 'pnpm-workspace.yaml')
  let source: string
  let initial: ReturnType<typeof identity>
  try {
    initial = identity(file)
    source = readFileSync(file, 'utf8')
    if (identity(file).value !== initial.value) throw new ReleaseAgeConfigurationError('changed')
  } catch (error) {
    if (error instanceof ReleaseAgeConfigurationError) throw error
    throw new ReleaseAgeConfigurationError('unavailable')
  }
  const document = parseDocument(source, { keepSourceTokens: true, uniqueKeys: true })
  if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents) || document.directives?.docEnd === true) throw new ReleaseAgeConfigurationError('unsafe')
  // Aliases, custom tags and merge keys can make apparently local edits change
  // other settings. Refuse them rather than resolving or serializing the file.
  let unsafe = false
  visit(document, (_key, node) => {
    if (isAlias(node) || node !== null && typeof node === 'object' && ('anchor' in node && node.anchor !== undefined || 'tag' in node && node.tag !== undefined)) unsafe = true
    if (isMap(node) && node.items.some(pair => isScalar(pair.key) && pair.key.value === '<<')) unsafe = true
  })
  if (unsafe) throw new ReleaseAgeConfigurationError('unsafe')
  const pair = document.contents.items.find(pair => isScalar(pair.key) && pair.key.value === KEY)
  if (pair === undefined) return { file, source, identity: initial.value, mode: initial.mode, rules: [] }
  const sequence = pair.value
  if (!isSeq(sequence) || sequence.flow === true && sequence.items.length > 0 || sequence.range === undefined || sequence.range === null) throw new ReleaseAgeConfigurationError('unsafe')
  const rules = sequence.items.map(parseRule)
  if (rules.some(rule => rule === undefined)) throw new ReleaseAgeConfigurationError('unsafe')
  return { file, source, identity: initial.value, mode: initial.mode, sequence, rules: rules as Rule[] }
}

function quote(value: string): string { return `'${value}'` }

function scalarReplacement(source: string, node: Scalar<string>, value: string): Edit {
  const range = node.range!
  if (node.srcToken?.type === 'block-scalar') {
    const suffix = node.srcToken.props.slice(1).map(token => 'source' in token ? token.source : '').join('')
    return { start: range[0], end: range[1], value: `${quote(value)}${suffix}` }
  }
  return { start: range[0], end: range[1], value: quote(value) }
}

/** Remove only this list item; retain its preceding and inline comments. */
function removeRule(source: string, node: Scalar<string>): Edit {
  const range = node.range!
  const start = source.lastIndexOf('\n', range[0] - 1) + 1
  const prefix = source.slice(start, range[0])
  const indentation = /^([ \t]*)-[ \t]+$/.exec(prefix)?.[1]
  if (indentation === undefined) throw new ReleaseAgeConfigurationError('unsafe')
  if (node.srcToken?.type === 'block-scalar') {
    const suffix = node.srcToken.props.slice(1).map(token => 'source' in token ? token.source : '').join('')
    return { start, end: range[2], value: suffix.includes('#') ? `${indentation}${suffix}` : '' }
  }
  const suffix = source.slice(range[1], range[2])
  if (!/^[ \t]*(?:#[^\r\n]*)?(?:\r?\n)?$/.test(suffix)) throw new ReleaseAgeConfigurationError('unsafe')
  return { start, end: range[2], value: suffix.includes('#') ? `${indentation}${suffix}` : '' }
}

function patch(source: string, edits: Edit[]): string {
  let previous = source.length
  let result = source
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    if (edit.end > previous || edit.start > edit.end) throw new ReleaseAgeConfigurationError('unsafe')
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end)
    previous = edit.start
  }
  return result
}

function groups(workspace: Workspace): Map<string, Rule[]> {
  const grouped = new Map<string, Rule[]>()
  for (const rule of workspace.rules) grouped.set(rule.packageName, [...grouped.get(rule.packageName) ?? [], rule])
  return grouped
}

function mergeEdits(workspace: Workspace, grouped: Map<string, Rule[]>, approved?: ReleaseAgeTarget): { edits: Edit[]; repaired: string[]; found: boolean } {
  const edits: Edit[] = []
  const repaired: string[] = []
  let found = false
  for (const [packageName, rules] of grouped) {
    const target = approved?.packageName === packageName ? approved : undefined
    if (target !== undefined) found = true
    const bare = rules.find(rule => rule.versions === null)
    // A bare package rule already grants every version. Keep it exactly as the
    // user wrote it; mixed bare/exact duplicates need a human decision.
    if (bare !== undefined) {
      if (target !== undefined && rules.length > 1) throw new ReleaseAgeConfigurationError('unsafe')
      continue
    }
    const versions = [...new Set(rules.flatMap(rule => rule.versions!))]
    if (target !== undefined && !versions.includes(target.version)) versions.push(target.version)
    if (rules.length === 1 && versions.length === rules[0]!.versions!.length && versions.every((version, index) => version === rules[0]!.versions![index])) continue
    edits.push(scalarReplacement(workspace.source, rules[0]!.node, `${packageName}@${versions.join(' || ')}`))
    for (const rule of rules.slice(1)) edits.push(removeRule(workspace.source, rule.node))
    if (rules.length > 1) repaired.push(packageName)
  }
  return { edits, repaired, found }
}

function saveWorkspace(workspace: Workspace, contents: string): void {
  if (contents === workspace.source) return
  const parsed = parseDocument(contents, { uniqueKeys: true })
  if (parsed.errors.length > 0 || parsed.warnings.length > 0) throw new ReleaseAgeConfigurationError('unsafe')
  const temporary = `${workspace.file}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', workspace.mode)
    fchmodSync(descriptor, workspace.mode)
    writeFileSync(descriptor, contents, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    if (identity(workspace.file).value !== workspace.identity || readFileSync(workspace.file, 'utf8') !== workspace.source) throw new ReleaseAgeConfigurationError('changed')
    renameSync(temporary, workspace.file)
  } catch (error) {
    if (error instanceof ReleaseAgeConfigurationError) throw error
    throw new ReleaseAgeConfigurationError('write-failed')
  } finally {
    if (descriptor !== undefined) { try { closeSync(descriptor) } catch {} }
    try { unlinkSync(temporary) } catch {}
  }
}

/** Merge only existing precise authorizations. Unsafe input stays byte-for-byte intact. */
export function repairReleaseAgeExcludes(profileDir: string): string[] {
  let workspace: Workspace
  try { workspace = readWorkspace(profileDir) } catch (error) {
    if (error instanceof ReleaseAgeConfigurationError && (error.code === 'unavailable' || error.code === 'unsafe')) return []
    throw error
  }
  const { edits, repaired } = mergeEdits(workspace, groups(workspace))
  if (repaired.length === 0) return []
  saveWorkspace(workspace, patch(workspace.source, edits))
  return repaired
}

/** Persist an explicit user approval for exactly one package version. */
export function allowReleaseAgeVersion(profileDir: string, target: ReleaseAgeTarget): void {
  const approved = parseReleaseAgeTarget(target?.packageName, target?.version)
  if (approved === undefined) throw new ReleaseAgeConfigurationError('invalid-target')
  // Never manufacture a missing workspace: it may mean the supplied profile
  // path is wrong, and replacing unknown configuration would hide that error.
  const workspace = readWorkspace(profileDir)
  const { edits, found } = mergeEdits(workspace, groups(workspace), approved)
  if (!found) {
    const newline = workspace.source.includes('\r\n') ? '\r\n' : '\n'
    const rule = quote(`${approved.packageName}@${approved.version}`)
    if (workspace.sequence !== undefined) {
      if (workspace.sequence.flow === true) {
        const range = workspace.sequence.range!
        // Empty flow arrays are safe to fill locally. Leave a commented flow
        // collection untouched rather than relocating its comments.
        if (!/^\[[ \t]*\]$/.test(workspace.source.slice(range[0], range[1]))) throw new ReleaseAgeConfigurationError('unsafe')
        // Emit the same block shape that future approvals and pnpm append to.
        // Writing a non-empty flow array here would make our next conservative
        // read reject a format we had just created ourselves.
        edits.push({ start: range[0], end: range[1], value: `${newline}  - ${rule}` })
        saveWorkspace(workspace, patch(workspace.source, edits))
        return
      }
      const first = workspace.rules[0]?.node
      const indent = first === undefined ? '  ' : /^([ \t]*)-/.exec(workspace.source.slice(workspace.source.lastIndexOf('\n', first.range![0] - 1) + 1))?.[1]
      if (indent === undefined) throw new ReleaseAgeConfigurationError('unsafe')
      const end = workspace.sequence.range![1]
      const prefix = end > 0 && workspace.source[end - 1] !== '\n' ? newline : ''
      edits.push({ start: end, end, value: `${prefix}${indent}- ${rule}${newline}` })
    } else {
      const prefix = workspace.source.length > 0 && !workspace.source.endsWith('\n') ? newline : ''
      edits.push({ start: workspace.source.length, end: workspace.source.length, value: `${prefix}${KEY}:${newline}  - ${rule}${newline}` })
    }
  }
  saveWorkspace(workspace, patch(workspace.source, edits))
}
