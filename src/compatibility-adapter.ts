import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { applicableAdapters } from './compatibility.ts'
import type { CompatibilityAssessment } from './compatibility.ts'
import { compatibilityPatchFile, ensurePatchedDependency, packageDir, packageManifest } from './profile.ts'
import type { CompatibilityAdapter, DshRuntime, SkinEntry } from './types.ts'

// Keep the historical exports available to host-side consumers while the
// pure compatibility assessment is shared with the browser client.
export { assessCompatibility } from './compatibility.ts'
export type { CompatibilityAssessment } from './compatibility.ts'
export type CompatibilityDecision = CompatibilityAssessment['decision']

export interface CompatibilityPatchPlan {
  patchFile: string
  patchRelativePath: string
  packageName: string
  packageVersion: string
  originalSource: string
  patchedSource: string
  relativeSourcePath: string
  adapterIds: string[]
  matchedAdapterIds: string[]
  outcomes: Array<{ adapterId: string; status: 'already-correct' | 'patchable' }>
}

interface TextEdit { start: number; end: number; value: string }
interface AdapterTransformResult {
  source: string
  count: number
  status: 'unmatched' | 'already-correct' | 'patchable' | 'unsupported'
  reason?: string
}

function exportedPath(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const key of ['default', 'import', 'require', 'node']) {
    if (typeof record[key] === 'string') return record[key] as string
  }
  return null
}

function clientEntryPath(manifest: Record<string, unknown>): string | null {
  const exports = manifest.exports
  if (typeof exports !== 'object' || exports === null || Array.isArray(exports)) return null
  return exportedPath((exports as Record<string, unknown>)['./client'])
}

/** Mask lexical data while preserving offsets; this is a narrow scanner, not a JS rewriter. */
function codeMask(source: string): string {
  const chars = source.split('')
  const blank = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) if (source[index] !== '\n' && source[index] !== '\r') chars[index] = ' '
  }
  for (let index = 0; index < source.length;) {
    const start = index
    const char = source[index]
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      blank(start, index)
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2
      blank(start, index)
    } else if (char === '"' || char === "'" || char?.charCodeAt(0) === 96) {
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') index += 2
        else if (source[index++] === char) break
      }
      blank(start, index)
    } else if (char === '/' && /(?:^|[=(:,;!?{\[]|\b(?:return|throw|case))\s*$/.test(source.slice(0, index))) {
      index += 1
      let inClass = false
      while (index < source.length) {
        const current = source[index++]
        if (current === '\\') index += 1
        else if (current === '[') inClass = true
        else if (current === ']') inClass = false
        else if (current === '/' && !inClass) break
        else if (current === '\n') break
      }
      while (index < source.length && /[a-z]/i.test(source[index] ?? '')) index += 1
      blank(start, index)
    } else index += 1
  }
  return chars.join('')
}

function findObjectEnd(mask: string, open: number): number | null {
  let depth = 0
  for (let index = open; index < mask.length; index += 1) {
    if (mask[index] === '{') depth += 1
    if (mask[index] === '}' && --depth === 0) return index
  }
  return null
}

interface MetadataProperty { name: string; start: number; end: number; value: string }

function metadataProperties(source: string, mask: string): { properties: MetadataProperty[]; unsupported: boolean } {
  const properties: MetadataProperty[] = []
  let unsupported = false
  let start = 0
  let depth = 0
  const add = (end: number): void => {
    const segment = mask.slice(start, end)
    if (segment.trim() === '') return
    const match = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(segment)
    if (match === null) { unsupported = true; return }
    const name = match[1]!
    const keyStart = start + match[0].indexOf(name)
    const value = source.slice(start + match[0].length, end).trim()
    properties.push({ name, start: keyStart, end: end - (source.slice(start, end).match(/\s*$/)?.[0].length ?? 0), value })
  }
  for (let index = 0; index < mask.length; index += 1) {
    const char = mask[index]
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) { add(index); start = index + 1 }
  }
  add(mask.length)
  return { properties, unsupported: unsupported || depth !== 0 }
}

function literalString(value: string): string | null {
  const match = /^(["'])([A-Za-z0-9._/-]+)\1$/.exec(value)
  return match?.[2] ?? null
}

function settingsNamespaceExpression(source: string, mask: string, value: string | undefined): string | null {
  if (value === undefined) return null
  if (literalString(value)?.startsWith('settings.')) return value
  if (!/^[A-Za-z_][\w]*$/.test(value)) return null
  const assignments = [...mask.matchAll(new RegExp('\\b' + value + '\\s*=(?!=|>)', 'g'))]
  if (assignments.length !== 1) return null
  const declaration = new RegExp('\\b(?:const|let|var)\\s+' + value + '\\s*=').exec(mask)
  if (declaration === null || declaration.index === undefined) return null
  const literal = /^\s*(["']settings\.[A-Za-z0-9._/-]+["'])\s*(?=[,;\n\r]|$)/.exec(source.slice(declaration.index + declaration[0].length))
  const expression = literal?.[1]
  return expression !== undefined && literalString(expression)?.startsWith('settings.') ? expression : null
}

function transformKeyedSlot(source: string, adapter: CompatibilityAdapter): AdapterTransformResult {
  const edits: TextEdit[] = []
  let matched = false
  const mask = codeMask(source)
  const unsupported = (reason: string): AdapterTransformResult => ({ source, count: 0, status: 'unsupported', reason })
  const register = /\.\s*slots\s*\.\s*register\s*\(\s*\{/g
  for (const match of mask.matchAll(register)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf('{')
    const close = findObjectEnd(mask, open)
    if (close === null) return unsupported('注册对象未能完整解析')
    const object = source.slice(open + 1, close)
    const parsed = metadataProperties(object, mask.slice(open + 1, close))
    const fields = (name: string): MetadataProperty[] => parsed.properties.filter(item => item.name === name)
    if (literalString(fields('name')[0]?.value ?? '') !== adapter.slot) continue
    matched = true
    if (parsed.unsupported || ['name', 'id', 'key', 'locale'].some(name => fields(name).length > 1)) return unsupported('注册对象含动态、展开或重复属性')
    const key = fields('key')[0]
    if (key !== undefined) {
      const expression = literalString(key.value) !== null ? key.value : settingsNamespaceExpression(source, mask, key.value)
      const value = literalString(expression ?? '')
      if (value !== null && (adapter.key === 'locale' ? value.startsWith('settings.') : value === adapter.key)) continue
      return unsupported('已有 key 不是可核验的固定值')
    }
    const id = fields('id')[0]
    if (id === undefined || literalString(id.value) === null) return unsupported('注册对象缺少固定的 id')
    const expression = adapter.key === 'locale'
      ? settingsNamespaceExpression(source, mask, fields('locale')[0]?.value)
      : JSON.stringify(adapter.key)
    if (expression === null || expression === '') return unsupported('locale 不是可核验的固定 settings namespace')
    const propertyStart = open + 1 + id.start
    const propertyEnd = open + 1 + id.end
    if (/[\r\n]/.test(source.slice(propertyStart, propertyEnd))) return unsupported('多行 id 不在安全适配范围内')
    edits.push({ start: propertyStart, end: propertyEnd, value: 'key: ' + expression })
  }
  if (edits.length === 0) return { source, count: 0, status: matched ? 'already-correct' : 'unmatched' }
  let result = source
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end)
  return { source: result, count: edits.length, status: 'patchable' }
}

function applyAdapter(source: string, adapter: CompatibilityAdapter): AdapterTransformResult {
  if (adapter.kind === 'keyed-slot-id-to-key') return transformKeyedSlot(source, adapter)
  return { source, count: 0, status: 'unsupported', reason: '未知适配器类型' }
}

export function planCompatibilityPatch(profileDir: string, skin: SkinEntry, runtime: DshRuntime): CompatibilityPatchPlan | null {
  if (runtime.version === null) return null
  const adapters = applicableAdapters(skin, runtime)
  if (adapters.length === 0) return null
  const declared = adapters
  const manifest = packageManifest(profileDir, skin.package)
  if (manifest === null) {
    if (declared.length > 0) throw new Error('无法读取已安装包的清单，不能应用声明的兼容适配')
    return null
  }
  const entry = clientEntryPath(manifest)
  if (entry === null || !entry.startsWith('./')) {
    if (declared.length > 0) throw new Error('已安装包未提供可适配的 ./client 导出')
    return null
  }
  const packageRoot = packageDir(profileDir, skin.package)
  const sourceFile = resolve(packageRoot, entry)
  if (!sourceFile.startsWith(resolve(packageRoot) + sep) || !existsSync(sourceFile)) {
    if (declared.length > 0) throw new Error('已安装包的客户端源码不存在，不能应用声明的兼容适配')
    return null
  }
  const originalSource = readFileSync(sourceFile, 'utf8')
  let patchedSource = originalSource
  const adapterIds: string[] = []
  const matchedAdapterIds: string[] = []
  const outcomes: CompatibilityPatchPlan['outcomes'] = []
  for (const adapter of adapters) {
    const result = applyAdapter(patchedSource, adapter)
    if (result.status === 'unsupported' || result.status === 'unmatched') {
      throw new Error(`兼容适配 ${adapter.id} 无法安全执行：${result.reason ?? '未找到可核验的 slot 注册'}；请使用作者更新后的版本`)
    }
    matchedAdapterIds.push(adapter.id)
    outcomes.push({ adapterId: adapter.id, status: result.status })
    if (result.count > 0) {
      patchedSource = result.source
      adapterIds.push(adapter.id)
    }
  }
  if (patchedSource === originalSource && matchedAdapterIds.length === 0) return null
  const version = typeof manifest.version === 'string' ? manifest.version : skin.install.version
  const patchFile = compatibilityPatchFile(profileDir, skin.package, version)
  const patchRelativePath = relative(profileDir, patchFile).split(sep).join('/')
  return {
    patchFile,
    patchRelativePath,
    packageName: skin.package,
    packageVersion: version,
    originalSource,
    patchedSource,
    relativeSourcePath: relative(packageRoot, sourceFile).split(sep).join('/'),
    adapterIds,
    matchedAdapterIds,
    outcomes,
  }
}

export function unifiedPatch(relativeSourcePath: string, original: string, patched: string): string {
  const oldLines = original.split(/\r?\n/)
  const newLines = patched.split(/\r?\n/)
  if (oldLines.length !== newLines.length) throw new Error(`compatibility adapter changed line count for ${relativeSourcePath}`)
  const changed = oldLines.flatMap((line, index) => line === newLines[index] ? [] : [index])
  if (changed.length === 0) return ''
  const start = Math.max(0, changed[0]! - 3)
  const end = Math.min(oldLines.length - 1, changed.at(-1)! + 3)
  const hunk = [`@@ -${start + 1},${end - start + 1} +${start + 1},${end - start + 1} @@`]
  for (let index = start; index <= end; index += 1) {
    if (oldLines[index] === newLines[index]) hunk.push(` ${oldLines[index]}`)
    else {
      hunk.push(`-${oldLines[index]}`)
      hunk.push(`+${newLines[index]}`)
    }
  }
  return [`diff --git a/${relativeSourcePath} b/${relativeSourcePath}`, `--- a/${relativeSourcePath}`, `+++ b/${relativeSourcePath}`, ...hunk, ''].join('\n')
}

export function persistCompatibilityPatch(profileDir: string, plan: CompatibilityPatchPlan): void {
  const patch = unifiedPatch(plan.relativeSourcePath, plan.originalSource, plan.patchedSource)
  if (patch === '') return
  mkdirSync(dirname(plan.patchFile), { recursive: true })
  if (existsSync(plan.patchFile) && readFileSync(plan.patchFile, 'utf8') !== patch) {
    throw new Error(`compatibility patch already exists with different content for ${plan.packageName}@${plan.packageVersion}`)
  }
  if (!existsSync(plan.patchFile)) writeFileSync(plan.patchFile, patch)
  ensurePatchedDependency(profileDir, plan.packageName, plan.packageVersion, plan.patchRelativePath)
}
