import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
function valueOf(env, ...names) {
    for (const name of names) {
        const value = env[name]?.trim();
        if (value !== undefined && value !== '')
            return value;
    }
    return null;
}
function proxyUrl(value) {
    if (value === null)
        return null;
    return /^[a-z][a-z\d+.-]*:\/\//iu.test(value) ? value : `http://${value}`;
}
function proxyConfig(env) {
    const standardHttps = proxyUrl(valueOf(env, 'https_proxy', 'HTTPS_PROXY'));
    const standardHttp = proxyUrl(valueOf(env, 'http_proxy', 'HTTP_PROXY'));
    const npmHttps = proxyUrl(valueOf(env, 'npm_config_https_proxy'));
    const npmHttp = proxyUrl(valueOf(env, 'npm_config_proxy'));
    const https = standardHttps ?? npmHttps;
    const http = standardHttp ?? npmHttp;
    const noProxy = valueOf(env, 'no_proxy', 'NO_PROXY', 'npm_config_noproxy');
    return {
        http,
        https,
        noProxy,
        mode: standardHttps !== null || standardHttp !== null
            ? 'standard-proxy'
            : npmHttps !== null || npmHttp !== null ? 'npm-config-proxy' : 'direct',
    };
}
const agents = new Map();
function dispatcher(config) {
    const key = `${config.http ?? ''}\n${config.https ?? ''}\n${config.noProxy ?? ''}`;
    const existing = agents.get(key);
    if (existing !== undefined)
        return existing;
    const created = config.http === null && config.https === null
        ? new Agent()
        : new EnvHttpProxyAgent({
            httpProxy: config.http ?? undefined,
            httpsProxy: config.https ?? undefined,
            noProxy: config.noProxy ?? undefined,
        });
    agents.set(key, created);
    return created;
}
/** Return only the proxy category; never expose a proxy URL or credentials. */
export function marketNetworkMode(env = process.env) {
    return proxyConfig(env).mode;
}
/**
 * Fetch external market metadata through the same proxy vocabulary as npm and
 * pnpm. Node's global fetch does not reliably consume those variables in a
 * long-lived Desktop process, so every market-owned request receives an
 * explicit undici dispatcher.
 */
export const marketFetch = async (input, init) => {
    const config = proxyConfig(process.env);
    try {
        const response = await undiciFetch(input, {
            ...init,
            dispatcher: dispatcher(config),
        });
        return response;
    }
    catch (error) {
        // Desktop may expose a loopback proxy for its own child processes while
        // refusing external market hosts. Going direct is safe only for a proxy
        // on this machine; a remote proxy may be an intentional network boundary.
        const proxy = config.https ?? config.http;
        if (!isLoopbackProxy(proxy) || init?.signal?.aborted === true)
            throw error;
        const response = await undiciFetch(input, {
            ...init,
            dispatcher: dispatcher({ http: null, https: null, noProxy: null, mode: 'direct' }),
        });
        return response;
    }
};
function isLoopbackProxy(proxy) {
    if (proxy === null)
        return false;
    try {
        const host = new URL(proxy).hostname.replace(/^\[|\]$/gu, '');
        return host === '127.0.0.1' || host === 'localhost' || host === '::1';
    }
    catch {
        return false;
    }
}
