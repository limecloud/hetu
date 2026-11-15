import { check, ServiceError } from './config.mjs';
import { membershipAuthorization } from './auth.mjs';
import { readLimited } from './models.mjs';

// 商业事实由Cloud维护；河图只读本人会员，支付与订阅变更使用其正式托管页面。
export async function membership(request, c, session) {
  check(new URL(request.url).search === '', 'invalid_input');
  const token = await membershipAuthorization(c, session);
  let response;
  try {
    response = await fetch(`${c.api_origin}/api/v1/business/commerce/applications/${c.application_id}/environments/${c.environment}/self/membership`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(20000),
    });
  } catch { throw new ServiceError('upstream_unavailable', 503); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ServiceError(response.status === 401 ? 'membership_connection_required' : response.status === 403 ? 'permission_denied' : response.status === 409 ? 'membership_unavailable' : 'upstream_unavailable', [401,403,409].includes(response.status) ? response.status : 503);
  }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(await readLimited(response, 128 * 1024))).data; }
  catch { throw new ServiceError('invalid_upstream', 502); }
  const integer = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v);
  check(value?.application_id === c.application_id && value.environment === c.environment && typeof value.name?.source === 'string' && value.name.source.length <= 16000 && typeof value.status === 'string' && value.status.length <= 64 && typeof value.paid === 'boolean', 'invalid_upstream', 502);
  check(['period_granted','period_remaining','period_consumed','period_reserved','pack_remaining'].every(k => integer(value[k])) && BigInt(value.period_remaining)+BigInt(value.period_consumed)+BigInt(value.period_reserved) <= BigInt(value.period_granted), 'invalid_upstream', 502);
  check(typeof value.period_end === 'string' && Number.isFinite(Date.parse(value.period_end)) && (value.payment_mode === undefined || ['test','free','live'].includes(value.payment_mode)), 'invalid_upstream', 502);
  const lang = request.headers.get('accept-language')?.split(',')[0].trim().split(';')[0];
  const translated = value.name.translations?.[lang];
  const name = typeof translated === 'string' && translated.length <= 16000 ? translated : value.name.source;
  return { name, status:value.status, paid:value.paid, period_end:value.period_end, period_remaining:value.period_remaining, period_consumed:value.period_consumed, period_reserved:value.period_reserved, pack_remaining:value.pack_remaining, payment_mode:value.payment_mode || null, subscription_url:c.subscription_url };
}
