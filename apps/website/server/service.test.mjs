import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { handle } from './router.mjs';
import { sha } from './storage.mjs';

const c = { site_origin:'https://hetu.test',issuer:'https://identity.test',api_origin:'https://api.test',console_url:'https://console.test/orders?application=hetu-test',open_url:'https://open.test',client_id:'hetu-client',application_id:'hetu-test',environment:'sandbox',audience:'models.structured.sandbox',membership_audience:'membership.sandbox',subscription_url:'https://console.test/billing/subscriptions?application=hetu-test&environment=sandbox',media_origins:['https://media.test'] };
const encoder=new TextEncoder();
const textSchema={type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false};
const b64=bytes=>Buffer.from(bytes).toString('base64url');
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
let privateKey,jwk,originalFetch;
before(async()=>{
  originalFetch=globalThis.fetch;
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  privateKey=pair.privateKey;jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'test',alg:'RS256',use:'sig'};
});
after(()=>{globalThis.fetch=originalFetch;});
async function fixture() {
  const mediaBytes = new Uint8Array(await readFile(new URL('../public/brand/icon-64.png',import.meta.url)));
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  const db={prepare(sql){return{bind(...args){const statement=sqlite.prepare(sql);return{async first(){return statement.get(...args)||null;},async all(){return{results:statement.all(...args)};},async run(){return{meta:{changes:statement.run(...args).changes}};}};}};}};
  const env={HETU_CLOUD_CONFIG:JSON.stringify(c),HETU_CLOUD_CLIENT_SECRET:'test-secret',HETU_CLOUD_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),HETU_CLOUD_DB:db};
  const state={audience:c.audience,authScopes:'openid profile models.read models.generate models.images.read models.images.generate',nonce:'',subject:'person-1',revoked:false,posts:0,tokenPosts:0,unknown:false,price:'12',operations:new Map(),badContext:false,badNonce:false,badSignature:false,mediaBytes,mediaOrigin:'https://media.test',mediaReads:0,corruptMedia:false};
  const billing=kind=>({unit:kind==='image'?'image':'invocation',policy_version:'p1',credits_per_unit:state.price,state:'settled',quantity:1});
  globalThis.fetch=async (input,options={})=>{
    const url=new URL(input instanceof Request?input.url:input),headers=new Headers(options.headers);
    if(state.redirectPath===url.pathname)return new Response(null,{status:302,headers:{location:'https://untrusted.test/redirected'}});
    if(url.pathname==='/.well-known/openid-configuration')return response({issuer:c.issuer,authorization_endpoint:c.issuer+'/authorize',token_endpoint:c.issuer+'/token',userinfo_endpoint:c.issuer+'/userinfo',jwks_uri:c.issuer+'/jwks',response_types_supported:['code'],id_token_signing_alg_values_supported:['RS256'],code_challenge_methods_supported:['S256']});
    if(url.pathname==='/jwks')return response({keys:[jwk]});
    if(url.pathname==='/token'){
      state.tokenPosts++;
      const now=Math.floor(Date.now()/1000),header=b64(JSON.stringify({alg:'RS256',kid:'test'})),payload=b64(JSON.stringify({iss:c.issuer,sub:state.subject,aud:c.client_id,exp:now+600,iat:now,nonce:state.badNonce?'wrong':state.nonce})),signed=header+'.'+payload;
      const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',privateKey,encoder.encode(signed));
      return response({access_token:'access-'+state.subject+(state.audience===c.membership_audience?'-membership':''),token_type:'Bearer',expires_in:600,scope:state.authScopes,id_token:signed+'.'+(state.badSignature?b64(new Uint8Array(256)):b64(sig))});
    }
    if(url.pathname==='/userinfo'){
      if(state.revoked)return response({error:'invalid_token'},401);
      return response({sub:headers.get('authorization').replace('Bearer access-','').replace(/-membership$/,''),name:'Test author',lime_client_id:state.badContext?'other':c.client_id,lime_application_id:c.application_id,lime_environment:c.environment,lime_audiences:[headers.get('authorization').endsWith('-membership')?c.membership_audience:c.audience],lime_authorization_source:'application_product'});
    }
    if(url.origin==='https://media.test'){
      state.mediaReads++;assert.equal(headers.get('authorization'),'Bearer media-private');
      return new Response(state.corruptMedia?new Uint8Array([0,1]):mediaBytes,{headers:{'content-type':'image/png'}});
    }
    assert.equal(url.origin,c.api_origin);
    if(url.pathname.endsWith('/catalog')){
      const image=url.pathname.includes('/images/');
      return response({data:{items:[{id:image?'image-one':'text-one',kind:image?'image':'structured_text',billing:billing(image?'image':'text'),limits:image?{max_prompt_bytes:16384,size:'1024x1024',quality:'standard',count:1,reference_images:false}:{max_input_bytes:32768,max_instruction_bytes:8192,max_schema_bytes:8192,max_output_bytes:65536,max_output_tokens:8192,schema_profile:'structured-json.v1'}}]}});
    }
    if(url.pathname.includes('/commerce/')) {
      assert.equal(headers.get('authorization'),'Bearer access-person-1-membership');
      return response({data:{application_id:state.wrongMembership?'other':c.application_id,environment:c.environment,name:{source:'Member',translations:{'zh-CN':'会员'}},status:'active',paid:false,period_end:'2026-12-01T00:00:00Z',period_granted:'100',period_remaining:'80',period_consumed:'15',period_reserved:'5',pack_remaining:'20',payment_mode:'test'}});
    }
    if(options.method==='POST'){
      state.posts++;const body=JSON.parse(options.body),key=headers.get('idempotency-key');
      const image=url.pathname.includes('/images/');
      const value={id:'generation-1',model_id:body.model_id,status:'succeeded',output:image?{asset_id:'asset-1',sha256:await sha(mediaBytes),mime_type:'image/png',size:mediaBytes.length,width:64,height:64}:{text:'生成的参考文字'},billing:billing(image?'image':'text')};
      state.operations.set(key,value);if(state.unknown)throw new Error('response lost');
      return response({data:value});
    }
    if(url.pathname.includes('/operations/')){
      const key=decodeURIComponent(url.pathname.split('/').at(-1)),value=state.operations.get(key);
      return value?response({data:value}):response({error:'not_found'},404);
    }
    if(url.pathname.endsWith('/access'))return response({data:{url:state.mediaOrigin+'/private.png',method:'GET',headers:{authorization:'Bearer media-private'},expires_at:new Date(Date.now()+60000).toISOString()}});
    throw new Error('Unexpected upstream '+url.pathname);
  };
  const req=(path,{method='GET',body,cookie,csrf,token}={})=>handle(new Request(c.site_origin+'/api/hetu'+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-hetu-csrf':csrf,origin:c.site_origin}:{}),...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
  async function signIn(){
    state.audience=c.audience;state.authScopes='openid profile models.read models.generate models.images.read models.images.generate';
    const start=await req('/auth/login'),target=new URL(start.headers.get('location'));state.nonce=target.searchParams.get('nonce');
    assert.equal(target.searchParams.get('code_challenge_method'),'S256');
    const callback=await req('/auth/callback?'+new URLSearchParams({state:target.searchParams.get('state'),code:'code',iss:c.issuer}),{cookie:start.headers.get('set-cookie').split(';')[0]});
    if(callback.status!==303 || callback.headers.get('location').includes('connection_error='))return {response:callback};
    const cookie=callback.headers.getSetCookie().find(v=>v.startsWith('__Host-hetu_session=')).split(';')[0];
    const session=await (await req('/session',{cookie})).json();
    return{cookie,csrf:session.csrf};
  }
  async function connect(){
    const auth=await signIn();assert.ok(auth.cookie);
    const pairing=await(await req('/connections',{method:'POST',body:{label:'Hetu test'}})).json();
    const consent=await req('/connections/'+pairing.id,{method:'POST',...auth});assert.equal(consent.status,200);
    const poll=await(await req('/connections/'+pairing.id+'/poll',{method:'POST',body:{secret:pairing.secret}})).json();
    return{...auth,token:poll.token,pairing};
  }
  return{env,sqlite,state,req,signIn,connect};
}
const plan=(extra={})=>({kind:'text',task_sha256:'a'.repeat(64),max_credits:'12',payload:{model_id:'text-one',input:'仅授权的固定输入',output_schema:textSchema,billing_policy_version:'p1'},...extra});

test('未配置时失败关闭，不访问 Cloud',async()=>{
  const result=await handle(new Request(c.site_origin+'/api/hetu/session'),{});
  assert.equal(result.status,503);assert.equal((await result.json()).error.code,'service_unconfigured');
});
test('OIDC、服务器会话和显式客户端连接；浏览器不收到 Cloud Token',async()=>{
  const f=await fixture(),auth=await f.connect();
  const session=await f.req('/session',{token:auth.token});const serialized=await session.text();
  assert.ok(!serialized.includes('access-person')&&!serialized.includes('csrf'));
  const repeated=await(await f.req('/connections/'+auth.pairing.id+'/poll',{method:'POST',body:{secret:auth.pairing.secret}})).json();assert.equal(repeated.token,auth.token);
  assert.equal((await f.req('/connections/'+auth.pairing.id,{method:'POST',cookie:auth.cookie})).status,403);
  assert.equal((await f.req('/connections/'+auth.pairing.id+'/poll',{method:'POST',body:{secret:'wrong'}})).status,401);
  assert.equal((await f.req('/models/text',{token:auth.token})).status,200);
  f.state.revoked=true;assert.equal((await f.req('/models/text',{token:auth.token})).status,401);assert.equal(f.state.posts,0);
  f.sqlite.close();
});
test('拒绝 nonce、签名和业务上下文不匹配',async()=>{
  for(const field of ['badNonce','badSignature','badContext']){
    const f=await fixture();f.state[field]=true;const login=await f.signIn();assert.equal(login.response.status,303);assert.ok(login.response.headers.get('location').includes('connection_error='));assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM sessions').get().n,0);f.sqlite.close();
  }
});
test('身份及模型上游重定向被拒绝，不创建会话或生成请求',async()=>{
  const discovery=await fixture();discovery.state.redirectPath='/.well-known/openid-configuration';
  const start=await discovery.req('/auth/login');
  assert.equal(new URL(start.headers.get('location')).origin,c.site_origin);
  assert.equal(discovery.state.tokenPosts,0);assert.equal(discovery.sqlite.prepare('SELECT count(*) AS n FROM sessions').get().n,0);discovery.sqlite.close();
  const token=await fixture();token.state.redirectPath='/token';
  const login=await token.signIn();assert.ok(login.response.headers.get('location').includes('connection_error='));
  assert.equal(token.sqlite.prepare('SELECT count(*) AS n FROM sessions').get().n,0);token.sqlite.close();
  const model=await fixture(),auth=await model.connect();
  model.state.redirectPath='/api/v1/business/models/applications/'+c.application_id+'/environments/'+c.environment+'/self/catalog';
  assert.equal((await model.req('/models/text',{token:auth.token})).status,503);
  assert.equal(model.state.posts,0);model.sqlite.close();
});
test('预算、政策和输入外发范围检查先于收费请求',async()=>{
  const f=await fixture(),auth=await f.connect();
  assert.equal((await f.req('/operations/budget-01',{method:'POST',token:auth.token,body:plan({max_credits:'11'})})).status,409);
  const input=plan();input.payload.billing_policy_version='old';assert.equal((await f.req('/operations/policy-01',{method:'POST',token:auth.token,body:input})).status,409);
  const ref=plan({kind:'image'});ref.payload={model_id:'image-one',prompt:'封面',billing_policy_version:'p1',reference:{bytes:'private'}};
  assert.equal((await f.req('/operations/upload-01',{method:'POST',token:auth.token,body:ref})).status,400);
  assert.equal(f.state.posts,0);f.sqlite.close();
});
test('提交丢响应后仅沿原键读取；并发重复提交只调用一次',async()=>{
  const f=await fixture(),auth=await f.connect();f.state.unknown=true;
  const send=()=>f.req('/operations/unknown-01',{method:'POST',token:auth.token,body:plan()});
  assert.equal((await send()).status,503);assert.equal((await send()).status,200);assert.equal(f.state.posts,1);
  const got=await(await f.req('/operations/unknown-01',{token:auth.token})).json();assert.equal(got.operation.output.text,'生成的参考文字');
  const changed=plan();changed.payload.input='changed';assert.equal((await f.req('/operations/unknown-01',{method:'POST',token:auth.token,body:changed})).status,409);
  f.state.unknown=false;await Promise.all([1,2,3].map(()=>f.req('/operations/concurrent-01',{method:'POST',token:auth.token,body:plan()})));assert.equal(f.state.posts,2);
  f.sqlite.close();
});
test('接受 Core 按键排序的闭合文字 Schema，并拒绝扩大输出合同',async()=>{
  const f=await fixture(),auth=await f.connect(),input=plan();
  input.payload.output_schema={additionalProperties:false,properties:{text:{type:'string'}},required:['text'],type:'object'};
  assert.equal((await f.req('/operations/core-schema-01',{method:'POST',token:auth.token,body:input})).status,200);
  input.payload.output_schema.additionalProperties=true;
  assert.equal((await f.req('/operations/core-schema-02',{method:'POST',token:auth.token,body:input})).status,400);assert.equal(f.state.posts,1);f.sqlite.close();
});
test('同账号重连可恢复；不同账号不能读取；退出立即撤销旧客户端',async()=>{
  const f=await fixture(),auth=await f.connect();assert.equal((await f.req('/operations/private-01',{method:'POST',token:auth.token,body:plan()})).status,200);
  const second=await f.connect();assert.equal((await f.req('/operations/private-01',{token:second.token})).status,200);
  f.state.subject='person-2';const other=await f.connect();assert.equal((await f.req('/operations/private-01',{token:other.token})).status,404);
  assert.equal((await f.req('/auth/logout',{method:'POST',cookie:auth.cookie,csrf:auth.csrf})).status,200);
  assert.equal((await f.req('/session',{token:auth.token})).status,401);assert.equal(f.state.posts,1);f.sqlite.close();
});
test('河图控制台沿本人记录分页并只读回查，不返回正文或创建新调用',async()=>{
  const f=await fixture(),auth=await f.connect();
  assert.equal((await f.req('/operations/history-01',{method:'POST',token:auth.token,body:plan()})).status,200);
  const owner=f.sqlite.prepare('SELECT owner FROM model_operations').get().owner;
  for(let i=2;i<=23;i++)f.sqlite.prepare('INSERT INTO model_operations SELECT owner,?,device_id,input_sha256,task_sha256,kind,model_id,policy_version,max_credits,remote_key,? FROM model_operations WHERE operation_key=?').run('history-'+String(i).padStart(2,'0'),i,'history-01');
  const listed=await(await f.req('/console/operations',{cookie:auth.cookie})).json();assert.equal(listed.items.length,20);assert.ok(listed.next_cursor);
  const second=await(await f.req('/console/operations?cursor='+listed.next_cursor,{cookie:auth.cookie})).json();assert.equal(second.items.length,3);assert.equal(second.next_cursor,null);
  assert.equal(new Set([...listed.items,...second.items].map(v=>v.operation_key)).size,23);
  assert.equal((await f.req('/console/operations?cursor=history-02&cursor=history-03',{cookie:auth.cookie})).status,400);
  const got=await(await f.req('/console/operations/history-01',{cookie:auth.cookie})).json();assert.equal(got.status,'succeeded');assert.equal(got.output,undefined);assert.ok(!JSON.stringify(got).includes('生成的参考文字'));
  assert.equal((await f.req('/console/operations',{token:auth.token})).status,403);
  assert.equal((await f.req('/operations/browser-01',{method:'POST',cookie:auth.cookie,csrf:auth.csrf,body:plan()})).status,403);
  f.state.subject='person-2';const other=await f.signIn();assert.deepEqual((await(await f.req('/console/operations',{cookie:other.cookie})).json()).items,[]);
  assert.equal((await f.req('/console/operations/history-01',{cookie:other.cookie})).status,404);
  f.state.revoked=true;assert.equal((await f.req('/console/operations',{cookie:auth.cookie})).status,401);assert.equal(f.state.posts,1);assert.ok(owner);f.sqlite.close();
});
test('图片沿原任务取得并验证摘要；拒绝损坏媒体及未批准的下载 Origin',async()=>{
  const f=await fixture(),auth=await f.connect();
  const input=plan({kind:'image',payload:{model_id:'image-one',prompt:'封面提示',billing_policy_version:'p1'}});
  assert.equal((await f.req('/operations/image-01',{method:'POST',token:auth.token,body:input})).status,200);
  const response=await f.req('/operations/image-01/image',{token:auth.token});assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),f.state.mediaBytes);
  f.state.corruptMedia=true;assert.equal((await f.req('/operations/image-01/image',{token:auth.token})).status,502);
  const previous=f.state.mediaReads;f.state.mediaOrigin='https://untrusted.test';assert.equal((await f.req('/operations/image-01/image',{token:auth.token})).status,502);assert.equal(f.state.mediaReads,previous);assert.equal(f.state.posts,1);f.sqlite.close();
});

async function connectMembership(f, auth) {
  const start = await f.req('/auth/login?resource=membership', {cookie:auth.cookie});
  const target = new URL(start.headers.get('location'));
  assert.equal(target.searchParams.get('audience'),c.membership_audience);
  assert.equal(target.searchParams.get('scope'),'openid profile commerce.membership.read');
  assert.ok(!target.searchParams.get('scope').includes('checkout'));
  f.state.nonce=target.searchParams.get('nonce');f.state.audience=c.membership_audience;f.state.authScopes=target.searchParams.get('scope');
  return f.req('/auth/callback?'+new URLSearchParams({state:target.searchParams.get('state'),code:'member-code',iss:c.issuer}),{cookie:auth.cookie+'; '+start.headers.get('set-cookie').split(';')[0]});
}
test('会员使用独立Audience且绑定同一网站会话；Token不下发浏览器或客户端',async()=>{
  const f=await fixture(),auth=await f.connect();
  assert.equal((await f.req('/membership',{cookie:auth.cookie})).status,401);
  assert.equal((await f.req('/membership',{token:auth.token})).status,403);
  const connected=await connectMembership(f,auth);
  assert.equal(connected.headers.get('location'),c.site_origin+'/console/#billing');
  const result=await f.req('/membership',{cookie:auth.cookie});assert.equal(result.status,200);
  const value=await result.json();assert.equal(value.period_remaining,'80');assert.equal(value.pack_remaining,'20');assert.equal(value.subscription_url,c.subscription_url);
  assert.ok(!JSON.stringify(value).includes('access-person'));
  assert.equal((await f.req('/models/text',{token:auth.token})).status,200);assert.equal(f.state.posts,0);
  const other=await f.signIn();assert.equal((await f.req('/membership',{cookie:other.cookie})).status,401);f.sqlite.close();
});
test('会员响应拒绝错误应用，撤销后不能读取或使用旧授权',async()=>{
  const f=await fixture(),auth=await f.connect();await connectMembership(f,auth);
  f.state.wrongMembership=true;assert.equal((await f.req('/membership',{cookie:auth.cookie})).status,502);
  f.state.revoked=true;assert.equal((await f.req('/membership',{cookie:auth.cookie})).status,401);assert.equal(f.state.posts,0);f.sqlite.close();
});
test('订阅入口必须绑定当前应用环境和Console；不允许调用方提供回跳地址',async()=>{
  const f=await fixture();
  for(const subscription_url of ['https://untrusted.test/billing/subscriptions?application=hetu-test&environment=sandbox','https://console.test/billing/subscriptions?application=other&environment=sandbox',c.subscription_url+'&return_to=https://untrusted.test']){
    f.env.HETU_CLOUD_CONFIG=JSON.stringify({...c,subscription_url});
    assert.equal((await f.req('/session')).status,503);
  }
  assert.equal(f.state.posts,0);f.sqlite.close();
});

test('会员回调不能转移至其他用户或会话，退出后也不能重新激活',async()=>{
  for(const scenario of ['session','subject','logout']){
    const f=await fixture(),auth=await f.signIn();
    const start=await f.req('/auth/login?resource=membership',{cookie:auth.cookie}),target=new URL(start.headers.get('location'));
    let cookie=auth.cookie;
    if(scenario==='session')cookie=(await f.signIn()).cookie;
    if(scenario==='logout')assert.equal((await f.req('/auth/logout',{method:'POST',...auth})).status,200);
    const posts=f.state.tokenPosts;
    f.state.nonce=target.searchParams.get('nonce');f.state.audience=c.membership_audience;f.state.authScopes=target.searchParams.get('scope');
    if(scenario==='subject')f.state.subject='person-2';
    const callback=await f.req('/auth/callback?'+new URLSearchParams({state:target.searchParams.get('state'),code:'member-code',iss:c.issuer}),{cookie:cookie+'; '+start.headers.get('set-cookie').split(';')[0]});
    assert.ok(callback.headers.get('location').includes('connection_error='));
    assert.equal((await f.req('/membership',{cookie})).status,401);
    if(scenario!=='subject')assert.equal(f.state.tokenPosts,posts);
    assert.equal(f.state.posts,0);f.sqlite.close();
  }
});
