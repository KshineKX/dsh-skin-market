import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { directLoopbackRequest, loopbackAuthority, readMarketUpdateRetryAction, readOperationRetry, readSkinId, readSkinMutation, refuseUnadmitted, sameOrigin, trustedAuthority } from '../src/http.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

function jsonRequest(body: Record<string, unknown>): IncomingMessage {
  const request = Readable.from([JSON.stringify(body)]) as IncomingMessage
  request.headers = { 'content-type': 'application/json' }
  return request
}

describe('HTTP guards', () => {
  it('accepts same-origin requests and Desktop proxy requests', () => {
    expect(sameOrigin({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } } as IncomingMessage)).toBe(true)
    expect(sameOrigin({ headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } } as IncomingMessage)).toBe(false)
    expect(sameOrigin({ headers: { host: '127.0.0.1:3080' } } as IncomingMessage)).toBe(true)
    expect(sameOrigin({ headers: {} } as IncomingMessage)).toBe(true)
    expect(sameOrigin({ headers: { host: 'evil.example' } } as IncomingMessage)).toBe(false)
    expect(sameOrigin({ headers: { origin: 'null', host: '127.0.0.1:3080' } } as IncomingMessage)).toBe(false)
    expect(sameOrigin({ headers: { origin: 'http://evil.example', host: 'evil.example' } } as IncomingMessage)).toBe(false)
  })

  it('recognizes loopback authorities without trusting public hosts', () => {
    expect(loopbackAuthority('127.0.0.1:3080')).toBe(true)
    expect(loopbackAuthority('localhost:3080')).toBe(true)
    expect(loopbackAuthority('[::1]:3080')).toBe(true)
    expect(loopbackAuthority('localhost.evil.example:3080')).toBe(false)
    expect(loopbackAuthority(undefined)).toBe(false)
  })

  it('accepts a non-loopback authority only when the host explicitly declares it', () => {
    expect(trustedAuthority('Harness.Example.test:8443', ['harness.example.test'])).toBe(true)
    expect(trustedAuthority('harness.example.test:8443', ['harness.example.test:8443'])).toBe(true)
    expect(trustedAuthority('harness.example.test:8444', ['harness.example.test:8443'])).toBe(false)
    expect(trustedAuthority('other.example.test:8443', ['harness.example.test'])).toBe(false)
    expect(trustedAuthority('harness.example.test.evil.test:8443', ['harness.example.test'])).toBe(false)
    expect(trustedAuthority('harness.example.test:81', ['harness.example.test:80'])).toBe(false)
    expect(trustedAuthority('harness.example.test:80', ['harness.example.test:80'])).toBe(true)
    for (const value of ['https://harness.example.test', 'harness.example.test/path', 'user@harness.example.test', 'harness.example.test#part', 'harness.example.test\\evil', 'harness.example.test:bad']) {
      expect(trustedAuthority(value, ['harness.example.test'])).toBe(false)
      expect(trustedAuthority('harness.example.test', [value])).toBe(false)
    }
    const request = { headers: { host: 'harness.example.test:8443', origin: 'https://harness.example.test:8443' } } as IncomingMessage
    expect(sameOrigin(request)).toBe(false)
    expect(sameOrigin(request, ['harness.example.test:8443'])).toBe(true)
    expect(sameOrigin({ headers: { ...request.headers, origin: 'https://evil.example.test' } } as IncomingMessage, ['harness.example.test:8443'])).toBe(false)
    expect(sameOrigin({ headers: { ...request.headers, origin: 'ftp://harness.example.test:8443' } } as IncomingMessage, ['harness.example.test:8443'])).toBe(false)
  })

  it('consults host admission and preserves 401 while refusing other failures as 403', () => {
    const request = { headers: {} } as IncomingMessage
    const response = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse
    expect(refuseUnadmitted(request, response)).toBe(false)
    expect(refuseUnadmitted(request, response, { requestRejection: () => undefined })).toBe(false)
    expect(response.writeHead).not.toHaveBeenCalled()
    for (const [rejection, expected] of [[401, 401], [403, 403], [500, 403]] as const) {
      expect(refuseUnadmitted(request, response, { requestRejection: () => rejection })).toBe(true)
      expect(response.writeHead).toHaveBeenLastCalledWith(expected, expect.any(Object))
    }
    expect(refuseUnadmitted(request, response, { requestRejection: () => { throw new Error('admission unavailable') } })).toBe(true)
    expect(response.writeHead).toHaveBeenLastCalledWith(403, expect.any(Object))
  })

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('allows direct local restart traffic from %s', remoteAddress => {
    expect(directLoopbackRequest({ headers: { host: 'localhost:3080' }, socket: { remoteAddress } } as IncomingMessage)).toBe(true)
  })

  it.each([undefined, '10.0.0.1', '::ffff:10.0.0.1'])('does not trust a loopback Host header without a direct local socket (%s)', remoteAddress => {
    expect(directLoopbackRequest({ headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress } } as IncomingMessage)).toBe(false)
  })

  it('refuses header-stripped proxies, trusted public hosts and every forwarding-header family for restart', () => {
    expect(directLoopbackRequest({ headers: {}, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage)).toBe(false)
    expect(directLoopbackRequest({ headers: { host: 'harness.example.test' }, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage)).toBe(false)
    for (const header of ['forwarded', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port']) {
      expect(directLoopbackRequest({ headers: { host: '127.0.0.1:3080', [header]: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage)).toBe(false)
    }
  })

  it('reads a structured skin id and rejects oversized input', async () => {
    const request = Readable.from([JSON.stringify({ skinId: 'small-tailqwq.maid-atelier' })]) as IncomingMessage
    request.headers = { 'content-type': 'application/json' }
    await expect(readSkinId(request)).resolves.toBe('small-tailqwq.maid-atelier')

    const oversized = Readable.from([JSON.stringify({ skinId: 'x'.repeat(9000) })]) as IncomingMessage
    oversized.headers = { 'content-type': 'application/json' }
    await expect(readSkinId(oversized)).rejects.toThrow('too large')
  })

  it.each([undefined, false, true])('reads only an explicit boolean compatibility acknowledgement (%s)', async acknowledgement => {
    const body = acknowledgement === undefined ? { compatibilityContext: 'ignored-version' } : { acknowledgeCompatibility: acknowledgement, compatibilityContext: acknowledgement ? 'shown-version' : 'ignored-version' }
    const context = acknowledgement ? { compatibilityContext: 'shown-version' } : {}
    await expect(readSkinMutation(jsonRequest({ skinId: 'fixture-skin', ...body }))).resolves.toEqual({
      skinId: 'fixture-skin', acknowledgeCompatibility: acknowledgement === true, ...context,
    })
    for (const action of ['retry', 'approve-build', 'approve-release-age', 'approve-artifact'] as const) {
      await expect(readOperationRetry(jsonRequest({ action, ...body }))).resolves.toEqual({
        action, acknowledgeCompatibility: acknowledgement === true, ...context,
      })
    }
  })

  it('rejects host compatibility exemption recovery requests', async () => {
    await expect(readOperationRetry(jsonRequest({ action: 'approve-compatibility' }))).rejects.toThrow('invalid operation retry action')
  })

  it('allows only an explicit supported market retry action and keeps bodyless retries ordinary', async () => {
    for (const action of ['retry', 'approve-release-age'] as const) await expect(readMarketUpdateRetryAction(jsonRequest({ action }))).resolves.toBe(action)
    const empty = Readable.from([]) as IncomingMessage
    empty.headers = {}
    await expect(readMarketUpdateRetryAction(empty)).resolves.toBe('retry')
    for (const body of [{ action: 'approve-build' }, { action: 'approve-artifact' }, { action: null }, { action: 1 }, { action: 'approve-release-age', version: '2.0.0' }]) await expect(readMarketUpdateRetryAction(jsonRequest(body))).rejects.toThrow('invalid market update retry action')
    const untyped = Readable.from([JSON.stringify({ action: 'approve-release-age' })]) as IncomingMessage
    untyped.headers = {}
    await expect(readMarketUpdateRetryAction(untyped)).rejects.toThrow('content-type must be application/json')
    await expect(readMarketUpdateRetryAction(jsonRequest({ action: 'x'.repeat(9000) }))).rejects.toThrow('too large')
  })

  it.each(['true', 'false', 1, 0, null, {}, []])('rejects a non-boolean compatibility acknowledgement (%j)', async acknowledgeCompatibility => {
    await expect(readSkinMutation(jsonRequest({ skinId: 'fixture-skin', acknowledgeCompatibility }))).rejects.toThrow('invalid compatibility acknowledgement')
    await expect(readOperationRetry(jsonRequest({ action: 'retry', acknowledgeCompatibility }))).rejects.toThrow('invalid compatibility acknowledgement')
  })

  it.each([undefined, '', 1, null, {}, [], 'x'.repeat(4097)])('requires bounded compatibility context for acknowledgement (%j)', async compatibilityContext => {
    const body = { acknowledgeCompatibility: true, compatibilityContext }
    await expect(readSkinMutation(jsonRequest({ skinId: 'fixture-skin', ...body }))).rejects.toThrow(/compatibility/)
    await expect(readOperationRetry(jsonRequest({ action: 'retry', ...body }))).rejects.toThrow(/compatibility/)
  })

  it('accepts compatibility context at the maximum length', async () => {
    const body = { acknowledgeCompatibility: true, compatibilityContext: 'x'.repeat(4096) }
    await expect(readSkinMutation(jsonRequest({ skinId: 'fixture-skin', ...body }))).resolves.toEqual({ skinId: 'fixture-skin', ...body })
    await expect(readOperationRetry(jsonRequest({ action: 'retry', ...body }))).resolves.toEqual({ action: 'retry', ...body })
  })

  it('reads a displayed artifact context without converting it to compatibility consent', async () => {
    await expect(readSkinMutation(jsonRequest({ skinId: 'fixture-skin', artifactContext: 'displayed-artifact' }))).resolves.toEqual({
      skinId: 'fixture-skin', artifactContext: 'displayed-artifact', acknowledgeCompatibility: false,
    })
    await expect(readOperationRetry(jsonRequest({ action: 'retry', artifactContext: 'displayed-artifact' }))).resolves.toEqual({
      action: 'retry', artifactContext: 'displayed-artifact', acknowledgeCompatibility: false,
    })
  })

  it.each(['', 1, null, {}, [], 'x'.repeat(4097)])('refuses invalid artifact acceptance context (%j)', async artifactContext => {
    await expect(readSkinMutation(jsonRequest({ skinId: 'fixture-skin', artifactContext }))).rejects.toThrow('invalid artifact context')
    await expect(readOperationRetry(jsonRequest({ action: 'retry', artifactContext }))).rejects.toThrow('invalid artifact context')
  })
})
