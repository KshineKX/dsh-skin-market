export function sendJson(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(body);
}
export function sendText(response, status, value) {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(value);
}
/**
 * Whether a Host header names a loopback authority.
 *
 * The Desktop proxy may remove Host before forwarding a request into the
 * in-process DSH server, so an absent header is handled by sameOrigin below.
 * When it is present, keep the DNS-rebinding guard: a public page must not be
 * able to make a matching Origin/Host pair for an arbitrary authority.
 */
export function loopbackAuthority(host) {
    if (host === undefined)
        return false;
    const lower = host.toLowerCase();
    const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0];
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}
/**
 * Accept same-origin browser requests and the official Desktop proxy's
 * header-stripped requests. A missing Origin is allowed because the proxy
 * strips it; a present but invalid/cross-site Origin remains rejected.
 */
function authority(value) {
    if (/[\s/@?#\\]/.test(value))
        return null;
    try {
        const parsed = new URL(`http://${value}`);
        return parsed.hostname === '' || parsed.pathname !== '/' ? null : parsed;
    }
    catch {
        return null;
    }
}
export function trustedAuthority(host, trustedHosts) {
    const parsed = authority(host);
    if (parsed === null)
        return false;
    return trustedHosts.some(value => {
        const trusted = authority(value);
        const explicitPort = value.startsWith('[') ? /\]:\d+$/.test(value) : /:\d+$/.test(value);
        return trusted !== null && (explicitPort ? trusted.host === parsed.host : trusted.hostname === parsed.hostname);
    });
}
export function sameOrigin(request, trustedHosts = []) {
    const host = request.headers.host;
    if (host !== undefined && !loopbackAuthority(host) && !trustedAuthority(host, trustedHosts))
        return false;
    const origin = request.headers.origin;
    if (origin === undefined)
        return true;
    try {
        const parsed = new URL(origin);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === authority(host ?? '')?.host;
    }
    catch {
        return false;
    }
}
/** Consult the same host admission policy as its own API, including browser login. */
export function refuseUnadmitted(request, response, connection) {
    if (typeof connection?.requestRejection !== 'function')
        return false;
    let status;
    try {
        status = connection.requestRejection(request);
    }
    catch {
        status = 403;
    }
    if (status === undefined)
        return false;
    sendJson(response, status === 401 ? 401 : 403, { error: status === 401 ? '请先登录当前 DSH 宿主' : '请求未通过宿主验证' });
    return true;
}
export function directLoopbackRequest(request) {
    const address = request.socket?.remoteAddress;
    return loopbackAuthority(request.headers.host)
        && (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1')
        && !Object.keys(request.headers).some(key => key === 'forwarded' || key === 'x-real-ip' || key.startsWith('x-forwarded-'));
}
async function readJsonBody(request, limit, allowEmpty = false) {
    const isJson = String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
    if (!allowEmpty && !isJson)
        throw new Error('content-type must be application/json');
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > limit)
            throw new Error('request body too large');
        chunks.push(buffer);
    }
    if (allowEmpty && size === 0)
        return {};
    if (!isJson)
        throw new Error('content-type must be application/json');
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body))
        throw new Error('invalid request body');
    return body;
}
function compatibilityAcknowledgement(body) {
    if (body.acknowledgeCompatibility !== undefined && typeof body.acknowledgeCompatibility !== 'boolean')
        throw new Error('invalid compatibility acknowledgement');
    if (body.acknowledgeCompatibility !== true)
        return { acknowledgeCompatibility: false };
    if (typeof body.compatibilityContext !== 'string' || body.compatibilityContext.length === 0 || body.compatibilityContext.length > 4096)
        throw new Error('invalid compatibility context');
    return { acknowledgeCompatibility: true, compatibilityContext: body.compatibilityContext };
}
export async function readSkinMutation(request, limit = 8192) {
    const body = await readJsonBody(request, limit);
    if (typeof body.skinId !== 'string' || body.skinId.length > 128)
        throw new Error('invalid skinId');
    return { skinId: body.skinId, ...compatibilityAcknowledgement(body) };
}
export async function readSkinId(request, limit = 8192) {
    return (await readSkinMutation(request, limit)).skinId;
}
export async function readOperationRetry(request, limit = 8192) {
    const body = await readJsonBody(request, limit);
    if (body.action !== 'retry' && body.action !== 'approve-build' && body.action !== 'approve-release-age')
        throw new Error('invalid operation retry action');
    return { action: body.action, ...compatibilityAcknowledgement(body) };
}
export async function readOperationRetryAction(request, limit = 8192) {
    return (await readOperationRetry(request, limit)).action;
}
export async function readMarketUpdateRetryAction(request, limit = 8192) {
    const body = await readJsonBody(request, limit, true);
    if (Object.keys(body).some(key => key !== 'action') || body.action !== undefined && body.action !== 'retry' && body.action !== 'approve-release-age')
        throw new Error('invalid market update retry action');
    return body.action === 'approve-release-age' ? body.action : 'retry';
}
export async function readRestartTarget(request, limit = 8192) {
    const body = await readJsonBody(request, limit);
    if (body.reason === 'market-update' && body.skinId === undefined)
        return { kind: 'market-update' };
    if (typeof body.skinId === 'string' && body.skinId.length <= 128 && body.reason === undefined)
        return { kind: 'skin', skinId: body.skinId };
    throw new Error('invalid restart target');
}
