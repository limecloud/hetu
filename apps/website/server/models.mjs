import { check, ServiceError } from './config.mjs';
import { first, run, all, random, sha } from './storage.mjs';

const limit = 20 * 1024 * 1024;
const encodedSize = value => new TextEncoder().encode(value).length;
export async function readLimited(response, maximum) {
  const reader = response.body?.getReader(); check(reader, 'invalid_upstream', 502);
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new ServiceError('invalid_upstream', 502); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function base(c) { return `${c.api_origin}/api/v1/business/models/applications/${encodeURIComponent(c.application_id)}/environments/${c.environment}/self`; }
async function upstream(c, session, path, options = {}) {
  let response;
  try {
    response = await fetch(base(c) + path, { method: options.body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(options.body ? 90000 : 20000), headers: { authorization: `Bearer ${session.access_token}`, accept: 'application/json', ...(options.body ? { 'content-type': 'application/json', 'idempotency-key': options.key } : {}) }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  } catch { throw new ServiceError('upstream_unavailable', 503); }
  if (!response.ok) {
    let code;
    try { code = JSON.parse(new TextDecoder().decode(await readLimited(response, 16384))).error?.code; } catch { /* 错误正文不透传给调用方。 */ }
    if (code === 'MODELS_CREDITS_INSUFFICIENT' || code === 'CREDITS_INSUFFICIENT') throw new ServiceError('credits_insufficient', 402);
    throw new ServiceError(response.status === 401 ? 'login_required' : response.status === 403 ? 'permission_denied' : response.status === 404 ? 'operation_unresolved' : response.status === 409 ? 'policy_or_balance_changed' : 'upstream_unavailable', [401,403,409].includes(response.status) ? response.status : 503);
  }
  try {
    const result = JSON.parse(new TextDecoder().decode(await readLimited(response, 128 * 1024)));
    check(result.data && typeof result.data === 'object', 'invalid_upstream', 502);
    return result.data;
  } catch (error) { throw error instanceof ServiceError ? error : new ServiceError('invalid_upstream', 502); }
}
export async function catalog(c, session, kind) {
  check(['text', 'image'].includes(kind), 'invalid_kind');
  const result = await upstream(c, session, kind === 'image' ? '/images/catalog' : '/catalog');
  check(Array.isArray(result.items) && result.items.length <= (kind === 'image' ? 32 : 1), 'catalog_contract_mismatch', 502);
  const ids = new Set();
  for (const item of result.items) {
    check(/^[a-z][a-z0-9_.-]{0,63}$/.test(item.id) && !ids.has(item.id) && item.kind === (kind === 'image' ? 'image' : 'structured_text') && /^(0|[1-9][0-9]{0,19})$/.test(item.billing?.credits_per_unit) && typeof item.billing.policy_version === 'string' && item.limits, 'invalid_upstream', 502);
    ids.add(item.id);
  }
  return { ...result, kind, environment: c.environment };
}
function validatePayload(input, model, kind) {
  const required = kind === 'text' ? ['model_id', 'input', 'output_schema', 'billing_policy_version'] : ['model_id', 'prompt', 'billing_policy_version'];
  const allowed = [...required, ...(kind === 'text' ? ['instructions'] : [])];
  check(input && Object.keys(input).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(input, k)), 'invalid_model_input');
  check(input.billing_policy_version === model.billing.policy_version, 'policy_or_balance_changed', 409);
  if (kind === 'text') {
    check(typeof input.input === 'string' && encodedSize(input.input) > 0 && encodedSize(input.input) <= Math.min(32768, model.limits.max_input_bytes), 'input_too_large');
    check(input.instructions === undefined || typeof input.instructions === 'string' && encodedSize(input.instructions) <= Math.min(8192, model.limits.max_instruction_bytes), 'input_too_large');
    // 首版只交接文字参考，闭合 Schema 保持单一、可核验的输出形态。
    const schema=input.output_schema;
    check(schema && Object.keys(schema).sort().join(',')==='additionalProperties,properties,required,type' && schema.type==='object' && schema.additionalProperties===false && Array.isArray(schema.required) && schema.required.length===1 && schema.required[0]==='text' && schema.properties && Object.keys(schema.properties).join(',')==='text' && schema.properties.text && Object.keys(schema.properties.text).join(',')==='type' && schema.properties.text.type==='string', 'invalid_output_schema');
  } else {
    check(typeof input.prompt === 'string' && encodedSize(input.prompt) > 0 && encodedSize(input.prompt) <= Math.min(16384, model.limits.max_prompt_bytes), 'input_too_large');
  }
}
function operation(value, row) {
  check(value.model_id === row.model_id && typeof value.id === 'string' && ['pending','executing','reconciling','produced','succeeded','failed'].includes(value.status), 'invalid_upstream', 502);
  check(value.billing && /^(0|[1-9][0-9]{0,19})$/.test(value.billing.credits_per_unit) && value.billing.policy_version === row.policy_version && BigInt(value.billing.credits_per_unit) <= BigInt(row.max_credits), 'invalid_upstream', 502);
  if (value.status === 'succeeded') {
    if (row.kind === 'text') check(value.output && typeof value.output.text === 'string' && Object.keys(value.output).length === 1 && encodedSize(value.output.text) <= 65536, 'invalid_upstream', 502);
    else check(/^[a-f0-9]{64}$/.test(value.output?.sha256) && Number.isInteger(value.output.size) && value.output.size > 0 && value.output.size <= limit && ['image/png','image/jpeg','image/webp'].includes(value.output.mime_type), 'invalid_upstream', 502);
  }
  return value;
}
async function lookup(env, session, key) {
  check(/^[a-zA-Z0-9_-]{8,100}$/.test(key), 'invalid_operation_key');
  const row = await first(env.HETU_CLOUD_DB, 'SELECT * FROM model_operations WHERE owner=? AND operation_key=?', session.owner, key);
  check(row, 'operation_not_found', 404);
  return row;
}
function projectResult(row, value) {
  // Cloud 拥有执行结果，website 只保留原键与输入摘要，不复制生成正文。
  return { operation_key: row.operation_key, kind: row.kind, operation: value };
}
export async function recover(env, c, session, key) {
  const row = await lookup(env, session, key);
  // 每次查询仍由 Cloud 重验当前权限；本地缓存不替代在线授权。
  const value = operation(await upstream(c, session, `${row.kind === 'image' ? '/images' : ''}/operations/${encodeURIComponent(row.remote_key)}`), row);
  return projectResult(row, value);
}
// 河图控制台只展示本人原操作的元数据；正文、图片访问及提交仍走本机任务。
export async function history(env, session, cursor) {
  check(!cursor || /^[A-Za-z0-9_-]{8,100}$/.test(cursor), 'invalid_cursor');
  let previous;
  if (cursor) previous = await lookup(env, session, cursor);
  const columns = 'operation_key,kind,model_id,max_credits,created_at';
  const items = previous
    ? await all(env.HETU_CLOUD_DB, `SELECT ${columns} FROM model_operations WHERE owner=? AND (created_at<? OR (created_at=? AND operation_key<?)) ORDER BY created_at DESC,operation_key DESC LIMIT 21`, session.owner, previous.created_at, previous.created_at, cursor)
    : await all(env.HETU_CLOUD_DB, `SELECT ${columns} FROM model_operations WHERE owner=? ORDER BY created_at DESC,operation_key DESC LIMIT 21`, session.owner);
  return { items: items.slice(0,20), next_cursor: items.length > 20 ? items[19].operation_key : null };
}
export async function inspectHistory(env, c, session, key) {
  const { operation } = await recover(env, c, session, key);
  return { operation_key:key, status:operation.status, model_id:operation.model_id, billing:operation.billing };
}
export async function submit(env, c, session, key, input) {
  check(session.deviceID, 'desktop_connection_required', 403);
  check(/^[a-zA-Z0-9_-]{8,100}$/.test(key), 'invalid_operation_key');
  check(input && Object.keys(input).sort().join(',') === 'kind,max_credits,payload,task_sha256' && ['text','image'].includes(input.kind) && /^[a-f0-9]{64}$/.test(input.task_sha256) && /^(0|[1-9][0-9]{0,19})$/.test(input.max_credits), 'invalid_input');
  const digest = await sha(JSON.stringify(input));
  const previous = await first(env.HETU_CLOUD_DB, 'SELECT * FROM model_operations WHERE owner=? AND operation_key=?', session.owner, key);
  if (previous) {
    check(previous.input_sha256 === digest, 'idempotency_conflict', 409);
    return recover(env, c, session, key);
  }
  const models = await catalog(c, session, input.kind), model = models.items.find(v => v.id === input.payload?.model_id);
  check(model, 'model_unavailable', 409);
  validatePayload(input.payload, model, input.kind);
  check(BigInt(model.billing.credits_per_unit) <= BigInt(input.max_credits), 'budget_exceeded', 409);
  const remoteKey = 'hetu-' + random();
  const inserted = await run(env.HETU_CLOUD_DB, 'INSERT INTO model_operations(owner,operation_key,device_id,input_sha256,task_sha256,kind,model_id,policy_version,max_credits,remote_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,operation_key) DO NOTHING', session.owner, key, session.deviceID, digest, input.task_sha256, input.kind, model.id, model.billing.policy_version, input.max_credits, remoteKey, Date.now());
  // 在发请求前原子保存原键。进程崩溃或响应未知后，只允许 GET 恢复。
  if (inserted.meta.changes !== 1) {
    const existing = await lookup(env, session, key);
    check(existing.input_sha256 === digest, 'idempotency_conflict', 409);
    return recover(env, c, session, key);
  }
  const row = await lookup(env, session, key);
  const value = operation(await upstream(c, session, input.kind === 'image' ? '/images/temporary-generations' : '/generations', { body: input.payload, key: remoteKey }), row);
  return projectResult(row, value);
}
export async function image(env, c, session, key) {
  const row = await lookup(env, session, key); check(row.kind === 'image', 'invalid_kind');
  const recovered = await recover(env, c, session, key), value = recovered.operation;
  check(value.status === 'succeeded', 'image_not_ready', 409);
  const access = await upstream(c, session, `/images/generations/${encodeURIComponent(value.id)}/access`);
  const url = new URL(access.url);
  check(c.media_origins.includes(url.origin) && url.protocol === 'https:' && !url.username && !url.password && access.method === 'GET' && Date.parse(access.expires_at) > Date.now(), 'invalid_media_access', 502);
  check(access.headers && Object.entries(access.headers).every(([k,v]) => ['authorization', 'accept'].includes(k.toLowerCase()) && typeof v === 'string' && !/[\r\n]/.test(v)), 'invalid_media_access', 502);
  const response = await fetch(url, { headers: access.headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  check(response.ok && response.headers.get('content-type')?.split(';')[0] === value.output.mime_type, 'invalid_media', 502);
  const bytes = await readLimited(response, limit);
  check(bytes.length === value.output.size && await sha(bytes) === value.output.sha256, 'invalid_media', 502);
  return new Response(bytes, { headers: { 'content-type': value.output.mime_type, 'content-length': String(bytes.length), 'x-content-sha256': value.output.sha256, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
