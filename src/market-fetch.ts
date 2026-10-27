import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

/** A sanitized description of the network path used by a market request. */
export type MarketNetworkMode = 'direct' | 'standard-proxy' | 'npm-config-proxy'

interface ProxyConfig {
  http: string | null
  https: string | null
  noProxy: string | null
  mode: MarketNetworkMode
}

function valueOf(env: NodeJS.ProcessEnv, ...names: string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value !== undefined && value !== '') return value
  }
  return null
}

function proxyUrl(value: string | null): string | null {
  if (value === null) return null
  return /^[a-z][a-z\d+.-]*:\/\//iu.test(value) ? value : `http://${value}`
}

function proxyConfig(env: NodeJS.ProcessEnv): ProxyConfig {
  const standardHttps = proxyUrl(valueOf(env, 'https_proxy', 'HTTPS_PROXY'))
  const standardHttp = proxyUrl(valueOf(env, 'http_proxy', 'HTTP_PROXY'))
  const npmHttps = proxyUrl(valueOf(env, 'npm_config_https_proxy'))
  const npmHttp = proxyUrl(valueOf(env, 'npm_config_proxy'))
  const https = standardHttps ?? npmHttps
  const http = standardHttp ?? npmHttp
  const noProxy = valueOf(env, 'no_proxy', 'NO_PROXY', 'npm_config_noproxy')
  return {
    http,
    https,
    noProxy,
    mode: standardHttps !== null || standardHttp !== null
      ? 'standard-proxy'
      : npmHttps !== null || npmHttp !== null ? 'npm-config-proxy' : 'direct',
  }
}

const agents = new Map<string, Agent | EnvHttpProxyAgent>()

function dispatcher(config: ProxyConfig): Agent | EnvHttpProxyAgent {
  const key = `${config.http ?? ''}\n${config.https ?? ''}\n${config.noProxy ?? ''}`
  const existing = agents.get(key)
  if (existing !== undefined) return existing
  const created = config.http === null && config.https === null
    ? new Agent()
    : new EnvHttpProxyAgent({
        httpProxy: config.http ?? undefined,
        httpsProxy: config.https ?? undefined,
        noProxy: config.noProxy ?? undefined,
      })
  agents.set(key, created)
  return created
}

/** Return only the proxy category; never expose a proxy URL or credentials. */
export function marketNetworkMode(env: NodeJS.ProcessEnv = process.env): MarketNetworkMode {
  return proxyConfig(env).mode
}

/**
 * Fetch external market metadata through the same proxy vocabulary as npm and
 * pnpm. Node's global fetch does not reliably consume those variables in a
 * long-lived Desktop process, so every market-owned request receives an
 * explicit undici dispatcher.
 */
export const marketFetch: typeof fetch = async (input, init) => {
  const config = proxyConfig(process.env)
  const response = await undiciFetch(input as string, {
    ...init,
    dispatcher: dispatcher(config),
  } as Parameters<typeof undiciFetch>[1])
  return response as unknown as Response
}
