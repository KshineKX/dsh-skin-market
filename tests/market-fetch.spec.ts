import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())
const agentMock = vi.hoisted(() => vi.fn(function Agent() { return { direct: true } }))
const proxyAgentMock = vi.hoisted(() => vi.fn(function EnvHttpProxyAgent() { return { proxy: true } }))

vi.mock('undici', () => ({ Agent: agentMock, EnvHttpProxyAgent: proxyAgentMock, fetch: fetchMock }))

import { marketFetch } from '../src/market-fetch.ts'

describe('marketFetch', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    agentMock.mockClear()
    proxyAgentMock.mockClear()
    vi.unstubAllEnvs()
  })

  it('retries directly when a loopback proxy refuses the request', async () => {
    vi.stubEnv('https_proxy', 'http://127.0.0.1:50007')
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const response = await marketFetch('https://catalog.example/plugins.json')

    expect(await response.text()).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]?.dispatcher).toEqual({ direct: true })
  })

  it('does not bypass a non-loopback proxy', async () => {
    vi.stubEnv('https_proxy', 'http://proxy.corp.example:8080')
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))

    await expect(marketFetch('https://catalog.example/plugins.json')).rejects.toThrow('fetch failed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})