import { config, check, ServiceError, json, body, cookie, cookieName } from './config.mjs';
import { login, callback, authenticate } from './auth.mjs';
import { first, run, random, sha, seal, unseal } from './storage.mjs';
import { catalog, submit, recover, image, history, inspectHistory } from './models.mjs';
import { membership } from './membership.mjs';

export async function handle(request, env) {
  let c;
  try {
    c = config(env);
    const url = new URL(request.url), path = url.pathname.replace(/^\/api\/hetu/, '');
    check(url.origin === c.site_origin, 'wrong_origin', 421);
    if (path === '/auth/login' && request.method === 'GET') return await login(request, env, c);
    if (path === '/auth/callback' && request.method === 'GET') return await callback(request, env, c);
    if (path === '/connections' && request.method === 'POST') {
      check(!request.headers.get('cookie') && !request.headers.get('origin'), 'desktop_connection_required', 403);
      const input = await body(request, 512);
      check(typeof input.label === 'string' && input.label.length > 0 && input.label.length <= 80, 'invalid_input');
      const now = Math.floor(Date.now()/1000);
      await run(env.HETU_CLOUD_DB, 'DELETE FROM pairings WHERE expires<=?', now);
      await run(env.HETU_CLOUD_DB, 'DELETE FROM auth_flows WHERE expires<=?', now);
      await run(env.HETU_CLOUD_DB, 'DELETE FROM devices WHERE expires<=?', now);
      await run(env.HETU_CLOUD_DB, 'DELETE FROM sessions WHERE expires<=?', now);
      const capacity = await first(env.HETU_CLOUD_DB, 'SELECT count(*) AS count FROM pairings');
      check(capacity.count < 1000, 'connection_capacity_reached', 429);
      const id = random(), secret = random(), token = random(), expires = Math.floor(Date.now()/1000) + 600;
      await run(env.HETU_CLOUD_DB, 'INSERT INTO pairings(id,secret_hash,token_hash,token_box,label,expires) VALUES(?,?,?,?,?,?)', id, await sha(secret), await sha(token), await seal({ token }, env.HETU_CLOUD_ENCRYPTION_KEY), input.label, expires);
      return json({ id, secret, verification_uri: c.site_origin + '/console/?connect=' + id, verification_code: id.slice(0,8).toUpperCase(), expires_in: 600 });
    }
    const poll = path.match(/^\/connections\/([a-f0-9]{64})\/poll$/);
    if (poll && request.method === 'POST') {
      const input = await body(request, 512), row = await first(env.HETU_CLOUD_DB, 'SELECT * FROM pairings WHERE id=? AND secret_hash=? AND expires>?', poll[1], await sha(String(input.secret)), Math.floor(Date.now()/1000));
      check(row, 'connection_expired', 401);
      if (!row.session_id) return json({ status: 'pending' }, 202);
      const session = await first(env.HETU_CLOUD_DB, 'SELECT expires FROM sessions WHERE id=? AND expires>?', row.session_id, Math.floor(Date.now()/1000));
      check(session, 'login_required', 401);
      const value = await unseal(row.token_box, env.HETU_CLOUD_ENCRYPTION_KEY);
      return json({ status: 'connected', token: value.token, expires_at: session.expires });
    }
    const session = await authenticate(request, env, c, path !== '/auth/logout');
    if (path === '/session' && request.method === 'GET') return json({ name: session.name, account_ref: session.owner, environment: c.environment, expires_at: session.expires, console_url: c.console_url, open_url: c.open_url, ...(!session.deviceID ? { csrf: session.csrf, subscription_url: c.subscription_url } : {}) });
    if (path === '/membership' && request.method === 'GET') return json(await membership(request, c, session));
    if (path === '/auth/logout' && request.method === 'POST') {
      await run(env.HETU_CLOUD_DB, 'DELETE FROM devices WHERE session_id=?', session.sid);
      await run(env.HETU_CLOUD_DB, 'DELETE FROM sessions WHERE id=?', session.sid);
      return json({ status: 'signed_out' }, 200, { 'set-cookie': cookie(cookieName, '', 0) });
    }
    const connection = path.match(/^\/connections\/([a-f0-9]{64})$/);
    if (connection) {
      check(!session.deviceID, 'browser_session_required', 403);
      const row = await first(env.HETU_CLOUD_DB, 'SELECT * FROM pairings WHERE id=? AND expires>?', connection[1], Math.floor(Date.now()/1000));
      check(row && (!row.session_id || row.session_id === session.sid), 'connection_expired', 401);
      if (request.method === 'GET') return json({ label: row.label, verification_code: row.id.slice(0,8).toUpperCase(), connected: !!row.session_id });
      if (request.method === 'POST') {
        await run(env.HETU_CLOUD_DB, 'UPDATE pairings SET session_id=? WHERE id=? AND session_id IS NULL', session.sid, row.id);
        const current = await first(env.HETU_CLOUD_DB, 'SELECT session_id FROM pairings WHERE id=?', row.id);
        check(current.session_id === session.sid, 'connection_expired', 401);
        await run(env.HETU_CLOUD_DB, 'INSERT INTO devices(id,session_id,expires) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING', row.token_hash, session.sid, session.expires);
        return json({ status: 'connected' });
      }
    }
    const models = path.match(/^\/models\/(text|image)$/);
    if (models && request.method === 'GET') return json(await catalog(c, session, models[1]));
    if (path === '/console/operations' && request.method === 'GET') {
      check(!session.deviceID, 'browser_session_required', 403);
      check(url.searchParams.getAll('cursor').length <= 1, 'invalid_cursor');
      return json(await history(env, session, url.searchParams.get('cursor')));
    }
    const inspected = path.match(/^\/console\/operations\/([A-Za-z0-9_-]{8,100})$/);
    if (inspected && request.method === 'GET') {
      check(!session.deviceID, 'browser_session_required', 403);
      return json(await inspectHistory(env, c, session, inspected[1]));
    }
    const operation = path.match(/^\/operations\/([A-Za-z0-9_-]{8,100})(\/image)?$/);
    if (operation) {
      check(session.deviceID, 'desktop_connection_required', 403);
      if (request.method === 'GET') return operation[2] ? await image(env, c, session, operation[1]) : json(await recover(env, c, session, operation[1]));
      if (!operation[2] && request.method === 'POST') return json(await submit(env, c, session, operation[1], await body(request)));
    }
    throw new ServiceError('route_not_found', 404);
  } catch (error) {
    const known = error instanceof ServiceError;
    if (c && request.method === 'GET' && ['/api/hetu/auth/login','/api/hetu/auth/callback'].includes(new URL(request.url).pathname)) {
      return new Response(null, { status: 303, headers: { location: c.site_origin + '/console/?connection_error=' + (known ? error.code : 'login_failed'), 'set-cookie': cookie('__Host-hetu_login','',0), 'cache-control':'no-store', 'referrer-policy':'no-referrer' } });
    }
    // 不将 OAuth 响应、用户输入或远端异常原文放入日志和响应。
    return json({ error: { code: known ? error.code : 'service_unavailable' } }, known ? error.status : 503);
  }
}
