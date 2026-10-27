/** A sanitized description of the network path used by a market request. */
export type MarketNetworkMode = 'direct' | 'standard-proxy' | 'npm-config-proxy';
/** Return only the proxy category; never expose a proxy URL or credentials. */
export declare function marketNetworkMode(env?: NodeJS.ProcessEnv): MarketNetworkMode;
/**
 * Fetch external market metadata through the same proxy vocabulary as npm and
 * pnpm. Node's global fetch does not reliably consume those variables in a
 * long-lived Desktop process, so every market-owned request receives an
 * explicit undici dispatcher.
 */
export declare const marketFetch: typeof fetch;
