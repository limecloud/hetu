export class ServiceError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function check(condition, code, status = 400) { if (!condition) throw new ServiceError(code, status); }
export function config(env) {
  try {
    const c = JSON.parse(env.HETU_CLOUD_CONFIG);
    for (const name of ['site_origin', 'issuer', 'api_origin', 'console_url', 'open_url']) {
      const url = new URL(c[name]);
      check(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'service_unconfigured', 503);
      if (name.endsWith('origin')) check(url.origin === c[name], 'service_unconfigured', 503);
    }
    for (const name of ['client_id', 'application_id', 'audience']) check(typeof c[name] === 'string' && c[name].length > 0, 'service_unconfigured', 503);
    check(/^[A-Za-z0-9_-]{1,40}$/.test(c.application_id) && ['sandbox', 'production'].includes(c.environment), 'service_unconfigured', 503);
    check(Array.isArray(c.media_origins) && c.media_origins.every(v => new URL(v).origin === v && v.startsWith('https://')), 'service_unconfigured', 503);
    check(typeof c.membership_audience === 'string' && c.membership_audience.length > 0 && c.membership_audience !== c.audience, 'service_unconfigured', 503);
    const subscription = new URL(c.subscription_url);
    check(subscription.origin === new URL(c.console_url).origin && !subscription.username && !subscription.password && !subscription.hash && subscription.pathname === '/billing/subscriptions' && subscription.searchParams.get('application') === c.application_id && subscription.searchParams.get('environment') === c.environment && [...subscription.searchParams.keys()].sort().join(',') === 'application,environment', 'service_unconfigured', 503);
    check(env.HETU_CLOUD_CLIENT_SECRET && atob(env.HETU_CLOUD_ENCRYPTION_KEY).length === 32 && env.HETU_CLOUD_DB, 'service_unconfigured', 503);
    return c;
  } catch { throw new ServiceError('service_unconfigured', 503); }
}
export const scopes = ['openid', 'profile', 'models.read', 'models.generate', 'models.images.read', 'models.images.generate'];
export const membershipScopes = ['openid', 'profile', 'commerce.membership.read'];
export const cookieName = '__Host-hetu_session';
export function cookies(request) {
  return Object.fromEntries((request.headers.get('cookie') || '').split(';').map(p => p.trim().split('=')).filter(p => p.length === 2));
}
export function cookie(name, value, age) { return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`; }
export function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', ...headers } });
}
export async function body(request, max = 65536) {
  check(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'invalid_content_type', 415);
  check(Number(request.headers.get('content-length') || 0) <= max, 'input_too_large', 413);
  const reader = request.body?.getReader();
  check(reader, 'invalid_input');
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new ServiceError('input_too_large', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ServiceError('invalid_json'); }
}
