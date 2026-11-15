import * as oauth from 'oauth4webapi';
import { check, ServiceError, scopes, membershipScopes, cookie, cookieName, cookies } from './config.mjs';
import { first, run, random, sha, seal, unseal } from './storage.mjs';

const timestamp = () => Math.floor(Date.now() / 1000);
const flowCookie = '__Host-hetu_login';
// Worker 支持 manual；OAuth 响应校验继续拒绝重定向状态，凭据不跟随到其他地址。
const timeoutFetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000), redirect: 'manual' });
async function server(c) {
  const response = await oauth.discoveryRequest(new URL(c.issuer), { [oauth.customFetch]: timeoutFetch });
  const as = await oauth.processDiscoveryResponse(new URL(c.issuer), response);
  for (const field of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'jwks_uri']) {
    const url = new URL(as[field]); check(url.protocol === 'https:' && !url.username && !url.password, 'invalid_identity_metadata', 502);
  }
  return as;
}
export async function login(request, env, c) {
  const url = new URL(request.url), lang = url.searchParams.get('lang') === 'en' ? 'en' : 'zh-CN';
  const membership = url.searchParams.get('resource') === 'membership';
  check(!url.searchParams.has('resource') || membership, 'invalid_input');
  const current = membership ? await authenticate(request, env, c) : null;
  check(!current?.deviceID, 'browser_session_required', 403);
  const requested = membership ? membershipScopes : scopes, audience = membership ? c.membership_audience : c.audience;
  const pairing = url.searchParams.get('connect');
  check(!pairing || /^[a-f0-9]{64}$/.test(pairing), 'invalid_pairing');
  const state = oauth.generateRandomState(), nonce = oauth.generateRandomNonce(), verifier = oauth.generateRandomCodeVerifier();
  const id = random(), as = await server(c);
  await run(env.HETU_CLOUD_DB, 'INSERT INTO auth_flows(id,box,expires) VALUES(?,?,?)', await sha(id), await seal({ state, nonce, verifier, lang, pairing, membership, ...(current ? { sid: current.sid, sub: current.sub, config_sha256: current.config_sha256 } : {}) }, env.HETU_CLOUD_ENCRYPTION_KEY), timestamp() + 600);
  const target = new URL(as.authorization_endpoint);
  const params = {
    client_id: c.client_id, response_type: 'code', redirect_uri: c.site_origin + '/api/hetu/auth/callback',
    scope: requested.join(' '), audience, state, nonce, code_challenge_method: 'S256',
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier), ui_locales: lang,
    authorization_details: JSON.stringify([{ type: 'lime_product', audience, scopes: requested }]),
  };
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return new Response(null, { status: 303, headers: { location: target.href, 'set-cookie': cookie(flowCookie, id, 600), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}
function context(info, c, audience = c.audience) {
  check(info.lime_client_id === c.client_id && info.lime_application_id === c.application_id && info.lime_environment === c.environment && info.lime_authorization_source === 'application_product' && Array.isArray(info.lime_audiences) && info.lime_audiences.length === 1 && info.lime_audiences[0] === audience, 'authorization_context_mismatch', 403);
}
export async function callback(request, env, c) {
  const db = env.HETU_CLOUD_DB, id = cookies(request)[flowCookie];
  check(id, 'login_expired', 401);
  const key = await sha(id), flow = await first(db, 'SELECT * FROM auth_flows WHERE id=? AND expires>? AND claimed=0', key, timestamp());
  check(flow, 'login_expired', 401);
  const saved = await unseal(flow.box, env.HETU_CLOUD_ENCRYPTION_KEY), as = await server(c), client = { client_id: c.client_id };
  const current = saved.membership ? await authenticate(request, env, c, false) : null;
  if (current) check(!current.deviceID && current.sid === saved.sid && current.sub === saved.sub && current.config_sha256 === saved.config_sha256, 'authorization_context_mismatch', 403);
  const params = oauth.validateAuthResponse(as, client, new URL(request.url), saved.state);
  // 换码结果未知时不重发；已认领事务只能重新登录，不重复兑换原 Code。
  const claimed = await run(db, 'UPDATE auth_flows SET claimed=1 WHERE id=? AND claimed=0', key);
  check(claimed.meta.changes === 1, 'login_expired', 401);
  const response = await oauth.authorizationCodeGrantRequest(as, client, oauth.ClientSecretBasic(env.HETU_CLOUD_CLIENT_SECRET), params, c.site_origin + '/api/hetu/auth/callback', saved.verifier, { [oauth.customFetch]: timeoutFetch });
  const tokens = await oauth.processAuthorizationCodeResponse(as, client, response, { expectedNonce: saved.nonce, requireIdToken: true });
  // process 验证标准声明；额外校验 ID Token 的 RS256 签名及在线用户绑定。
  await oauth.validateApplicationLevelSignature(as, response, { [oauth.customFetch]: timeoutFetch });
  const claims = oauth.getValidatedIdTokenClaims(tokens);
  const infoResponse = await oauth.userInfoRequest(as, client, tokens.access_token, { [oauth.customFetch]: timeoutFetch });
  const info = await oauth.processUserInfoResponse(as, client, claims.sub, infoResponse);
  context(info, c, saved.membership ? c.membership_audience : c.audience);
  check(tokens.token_type === 'bearer' && (saved.membership ? membershipScopes : scopes).every(v => tokens.scope?.split(' ').includes(v)), 'insufficient_scope', 403);
  if (current) {
    check(claims.sub === current.sub, 'authorization_context_mismatch', 403);
    const row = await first(db, 'SELECT * FROM sessions WHERE id=? AND expires>?', current.sid, timestamp());
    check(row && row.box === current.box, 'login_required', 401);
    const session = await unseal(row.box, env.HETU_CLOUD_ENCRYPTION_KEY);
    session.membership = { access_token: tokens.access_token, expires: timestamp() + Math.min(3600, tokens.expires_in || 300) };
    const updated = await run(db, 'UPDATE sessions SET box=? WHERE id=? AND box=? AND expires>?', await seal(session, env.HETU_CLOUD_ENCRYPTION_KEY), current.sid, row.box, timestamp());
    check(updated.meta.changes === 1, 'login_required', 401);
    return new Response(null, { status: 303, headers: { location: c.site_origin + (saved.lang === 'en' ? '/en/console/' : '/console/') + '#billing', 'set-cookie': cookie(flowCookie, '', 0), 'cache-control': 'no-store', 'referrer-policy':'no-referrer' } });
  }
  const sid = random(), csrf = random(), expires = timestamp() + Math.min(3600, tokens.expires_in || 300);
  const session = { access_token: tokens.access_token, sub: claims.sub, csrf, owner: await sha(JSON.stringify([c.issuer, claims.sub, c.application_id, c.environment, c.audience])), name: typeof info.name === 'string' ? info.name : '', config_sha256: await sha(JSON.stringify(c)) };
  await run(db, 'INSERT INTO sessions(id,box,expires) VALUES(?,?,?)', await sha(sid), await seal(session, env.HETU_CLOUD_ENCRYPTION_KEY), expires);
  const target = new URL(saved.lang === 'en' ? '/en/console/' : '/console/', c.site_origin);
  if (saved.pairing) target.searchParams.set('connect', saved.pairing);
  const headers = new Headers({ location: target.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  headers.append('set-cookie', cookie(cookieName, sid, expires - timestamp())); headers.append('set-cookie', cookie(flowCookie, '', 0));
  return new Response(null, { status: 303, headers });
}
export async function authenticate(request, env, c, online = true) {
  const bearer = request.headers.get('authorization');
  const deviceID = bearer?.startsWith('Bearer ') ? await sha(bearer.slice(7)) : null;
  let sid;
  if (deviceID) {
    const device = await first(env.HETU_CLOUD_DB, 'SELECT * FROM devices WHERE id=? AND expires>?', deviceID, timestamp());
    check(device, 'login_required', 401); sid = device.session_id;
  } else {
    const value = cookies(request)[cookieName]; check(value, 'login_required', 401); sid = await sha(value);
  }
  const record = await first(env.HETU_CLOUD_DB, 'SELECT * FROM sessions WHERE id=? AND expires>?', sid, timestamp());
  check(record, 'login_required', 401);
  const session = await unseal(record.box, env.HETU_CLOUD_ENCRYPTION_KEY);
  check(session.config_sha256 === await sha(JSON.stringify(c)), 'login_required', 401);
  if (online) {
    const as = await server(c), client = { client_id: c.client_id };
    const response = await oauth.userInfoRequest(as, client, session.access_token, { [oauth.customFetch]: timeoutFetch });
    let info;
    try { info = await oauth.processUserInfoResponse(as, client, session.sub, response); }
    catch { throw new ServiceError('login_required', 401); }
    context(info, c);
  }
  if (request.method !== 'GET' && !deviceID) {
    check(request.headers.get('origin') === c.site_origin && request.headers.get('x-hetu-csrf') === session.csrf, 'csrf_rejected', 403);
  }
  return { ...session, sid, deviceID, expires: record.expires, box: record.box };
}

export async function membershipAuthorization(c, session) {
  check(!session.deviceID, 'browser_session_required', 403);
  check(session.membership?.expires > timestamp() && typeof session.membership.access_token === 'string', 'membership_connection_required', 401);
  const as = await server(c), client = { client_id: c.client_id };
  let info;
  try { info = await oauth.processUserInfoResponse(as, client, session.sub, await oauth.userInfoRequest(as, client, session.membership.access_token, { [oauth.customFetch]: timeoutFetch })); }
  catch { throw new ServiceError('membership_connection_required', 401); }
  context(info, c, c.membership_audience);
  return session.membership.access_token;
}
