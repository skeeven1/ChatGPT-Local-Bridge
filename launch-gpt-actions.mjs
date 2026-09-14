#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {BRIDGE_VERSION} from './bridge/bridge-version.mjs';
import {loadAgentRuntime} from './bridge/agent-runtime/runtime-loader.mjs';
import {saveEndpointState} from './bridge/endpoint-manager.mjs';

const VERSION=BRIDGE_VERSION;
const root=path.dirname(fileURLToPath(import.meta.url));
const plugin=path.join(root,'bridge');
const agentRuntime=await loadAgentRuntime();
console.log(`[Agent Runtime] Agent Runtime loaded ${agentRuntime.context.version}`);
console.log('[Agent Runtime] Version compatible');

const data=process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'ChatGPTLocalBridgeV19'):path.join(os.homedir(),'.chatgpt-local-bridge-v19');
const bin=path.join(data,'bin');
const cf=path.join(bin,'cloudflared.exe');
const capFile=path.join(data,'action.cap');
const endpointStateFile=path.join(data,'bridge-endpoint.json');
const connectionFile=path.join(data,'CURRENT-CONNECTION.txt');
const requestedPort=0;

async function dir(p){await fsp.mkdir(p,{recursive:true})}
async function getCap(){
  await dir(data);
  try{const s=(await fsp.readFile(capFile,'utf8')).trim();if(/^[A-Za-z0-9_-]{40,120}$/.test(s))return s}catch{}
  const s=crypto.randomBytes(32).toString('base64url');
  await fsp.writeFile(capFile,s,{mode:0o600});
  return s;
}
async function ensureCf(){
  await dir(bin);
  if(fs.existsSync(cf))return;
  console.log('Downloading official cloudflared...');
  const r=await fetch('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',{redirect:'follow'});
  if(!r.ok)throw new Error(`cloudflared download HTTP ${r.status}`);
  const b=Buffer.from(await r.arrayBuffer());
  if(b.length<10_000_000)throw new Error('cloudflared download unexpectedly small');
  await fsp.writeFile(cf,b);
}
function waitUrl(c,timeout=90000){
  return new Promise((resolve,reject)=>{
    let buf='';
    const t=setTimeout(()=>reject(new Error('Timed out waiting for Cloudflare URL')),timeout);
    const on=d=>{
      const s=String(d);process.stdout.write(s);buf+=s;
      const m=buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if(m){clearTimeout(t);resolve(m[0])}
    };
    c.stdout.on('data',on);c.stderr.on('data',on);
    c.on('exit',code=>{clearTimeout(t);reject(new Error(`cloudflared exited ${code}`))});
  });
}
function errorDetail(e){
  const parts=[];
  if(e?.message)parts.push(e.message);
  const c=e?.cause;
  if(c?.code)parts.push(`cause=${c.code}`);
  if(c?.errno&&c.errno!==c.code)parts.push(`errno=${c.errno}`);
  if(c?.syscall)parts.push(`syscall=${c.syscall}`);
  if(c?.hostname)parts.push(`host=${c.hostname}`);
  if(c?.message&&c.message!==e?.message)parts.push(`detail=${c.message}`);
  return parts.join(' | ')||String(e);
}
async function fetchText(url,opts={}){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),12000);
  try{
    const r=await fetch(url,{...opts,redirect:'follow',cache:'no-store',signal:ctrl.signal,headers:{'cache-control':'no-cache',...(opts.headers||{})}});
    const text=await r.text();
    return{ok:r.ok,status:r.status,text,headers:r.headers,via:'node-fetch'};
  }finally{clearTimeout(timer)}
}
function runProcess(file,args,timeoutMs=15000){
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='';
    const timer=setTimeout(()=>{try{child.kill()}catch{};reject(new Error(`${file} timed out`))},timeoutMs);
    child.stdout.on('data',d=>stdout+=String(d));
    child.stderr.on('data',d=>stderr+=String(d));
    child.once('error',e=>{clearTimeout(timer);reject(e)});
    child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr})});
  });
}
async function curlText(url,opts={}){
  const marker='__CLB_HTTP_STATUS__:';
  const args=['--silent','--show-error','--location','--connect-timeout','6','--max-time','12','--header','cache-control: no-cache'];
  const method=String(opts.method||'GET').toUpperCase();
  if(method!=='GET')args.push('--request',method);
  for(const [k,v] of Object.entries(opts.headers||{}))args.push('--header',`${k}: ${v}`);
  if(opts.body!==undefined)args.push('--data-binary',String(opts.body));
  args.push('--write-out',`\n${marker}%{http_code}`,url);
  const out=await runProcess('curl.exe',args,15000);
  if(out.code!==0)throw new Error(`curl.exe exit ${out.code}: ${out.stderr.trim()||'request failed'}`);
  const idx=out.stdout.lastIndexOf(`\n${marker}`);
  if(idx<0)throw new Error(`curl.exe response missing HTTP status: ${out.stdout.slice(-300)}`);
  const text=out.stdout.slice(0,idx);
  const status=Number(out.stdout.slice(idx+1+marker.length).trim());
  return{ok:status>=200&&status<300,status,text,headers:null,via:'curl.exe'};
}
async function publicRequest(url,opts={}){
  try{return await fetchText(url,opts)}catch(nodeError){
    try{return await curlText(url,opts)}catch(curlError){
      const host=new URL(url).hostname;
      let dnsInfo='dns=unknown';
      try{const a=await dns.lookup(host,{all:true});dnsInfo=`dns=${a.map(x=>x.address).slice(0,4).join(',')||'empty'}`}catch(de){dnsInfo=`dns-error=${errorDetail(de)}`}
      throw new Error(`node=${errorDetail(nodeError)} || curl=${errorDetail(curlError)} || ${dnsInfo}`);
    }
  }
}
async function publicPreflight(baseUrl,cap,{timeoutMs=30000,intervalMs=2500}={}){
  const started=Date.now();let last='';let attempt=0;
  const schemaUrl=`${baseUrl}/setup/${cap}/openapi.json`;
  const actionUrl=`${baseUrl}/gpt/${cap}/pc`;
  while(Date.now()-started<timeoutMs){
    attempt++;
    try{
      const ready=await publicRequest(`${baseUrl}/readyz`);
      if(!ready.ok){last=`readyz HTTP ${ready.status}: ${ready.text.slice(0,300)}`;throw new Error(last)}
      const a=await publicRequest(schemaUrl);
      if(!a.ok){last=`schema HTTP ${a.status}: ${a.text.slice(0,300)}`;throw new Error(last)}
      let schema;try{schema=JSON.parse(a.text)}catch{last=`schema invalid JSON: ${a.text.slice(0,300)}`;throw new Error(last)}
      if(schema?.info?.version!==VERSION){last=`schema version mismatch: ${schema?.info?.version}`;throw new Error(last)}
      const b=await publicRequest(actionUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'status',requestId:`preflight-${Date.now()}`})});
      if(!b.ok){last=`action HTTP ${b.status}: ${b.text.slice(0,500)}`;throw new Error(last)}
      let result;try{result=JSON.parse(b.text)}catch{last=`action invalid JSON: ${b.text.slice(0,500)}`;throw new Error(last)}
      if(result?.status!=='ok'){last=`action returned ${result?.status}: ${result?.message||b.text.slice(0,300)}`;throw new Error(last)}
      console.log(`Public preflight PASS on attempt ${attempt}: readyz ${ready.status} via ${ready.via}, schema ${a.status} via ${a.via}, pc ${b.status} via ${b.via}`);
      return{ok:true,schemaUrl,actionUrl,bridgePid:result?.data?.bridgePid,attempts:attempt,lastError:null,checkedAt:new Date().toISOString()};
    }catch(e){
      last=errorDetail(e);
      console.log(`Public preflight attempt ${attempt} not ready: ${last}`);
      await new Promise(r=>setTimeout(r,intervalMs));
    }
  }
  return{ok:false,schemaUrl,actionUrl,bridgePid:null,attempts:attempt,lastError:last,checkedAt:new Date().toISOString()};
}
async function writeConnection({url,schemaUrl,instructionsUrl,status,lastError=null,bridgePid=null}){
  const state={version:VERSION,url,schemaUrl,instructionsUrl,preflightStatus:status,lastError,bridgePid,authentication:'NONE',updatedAt:new Date().toISOString()};
  await saveEndpointState(state,endpointStateFile);
  await fsp.writeFile(connectionFile,`ChatGPT Local Bridge V${VERSION}\n\nOpenAPI URL:\n${schemaUrl}\n\nInstructions URL:\n${instructionsUrl}\n\nAuthentication in GPT Actions: NONE\nPublic preflight: ${status}\n${lastError?`Last public probe error:\n${lastError}\n\n`:''}Keep the GPT private (Only me).\nKeep this window open.\n`,'utf8');
}
function startBackgroundPreflight(url,cap,instructionsUrl){
  let running=false,stopped=false,lastSummary='';
  const tick=async()=>{
    if(stopped||running)return;
    running=true;
    try{
      const r=await publicPreflight(url,cap,{timeoutMs:12000,intervalMs:2000});
      const summary=r.ok?'PASS':r.lastError;
      if(summary!==lastSummary){
        if(r.ok)console.log(`\n*** PUBLIC PREFLIGHT RECOVERED: PASS. GPT Actions endpoint is reachable. ***`);
        else console.log(`Background public preflight still pending: ${r.lastError}`);
        lastSummary=summary;
      }
      await writeConnection({url,schemaUrl:r.schemaUrl,instructionsUrl,status:r.ok?'PASS':'PENDING',lastError:r.lastError,bridgePid:r.bridgePid});
      if(r.ok){stopped=true;clearInterval(timer)}
    }catch(e){console.error(`Background preflight diagnostic error: ${errorDetail(e)}`)}finally{running=false}
  };
  const timer=setInterval(tick,15000);timer.unref();
  return()=>{stopped=true;clearInterval(timer)};
}

async function main(){
  if(process.platform!=='win32')throw new Error('Windows only');
  await ensureCf();
  const cap=await getCap();
  const env={...process.env,CHATGPT_LOCAL_BRIDGE_ACTION_PORT:String(requestedPort),CHATGPT_LOCAL_BRIDGE_ACTION_CAP:cap};
  const api=spawn(process.execPath,[path.join(plugin,'actions-http-server.mjs')],{cwd:plugin,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let readyInfo=null;
  const rl=readline.createInterface({input:api.stdout});
  rl.on('line',l=>{console.log(l);try{const j=JSON.parse(l);if(j?.type==='gpt-actions-http'&&Number.isInteger(Number(j.port))&&Number(j.port)>0)readyInfo=j}catch{}});
  api.stderr.on('data',d=>process.stderr.write(String(d)));
  for(let i=0;i<100&&!readyInfo;i++)await new Promise(r=>setTimeout(r,100));
  if(!readyInfo)throw new Error('Action API did not become ready with a bound port');
  const port=Number(readyInfo.port);
  console.log(`Local API selected free port: ${port}`);
  const local=await fetchText(`http://127.0.0.1:${port}/readyz`);
  if(!local.ok)throw new Error(`Local API health failed HTTP ${local.status}: ${local.text.slice(0,500)}`);
  console.log(`Local API health PASS: HTTP ${local.status}`);

  const tunnel=spawn(cf,['tunnel','--url',`http://127.0.0.1:${port}`,'--protocol','auto','--no-autoupdate'],{cwd:bin,stdio:['ignore','pipe','pipe'],windowsHide:true});
  const url=await waitUrl(tunnel);
  const schemaUrl=`${url}/setup/${cap}/openapi.json`;
  const instructionsUrl=`${url}/setup/${cap}/instructions.txt`;

  // Surface the endpoint immediately. The public self-probe may fail on some Windows/network setups
  // even while Cloudflare has registered the tunnel and external clients can reach it.
  await writeConnection({url,schemaUrl,instructionsUrl,status:'PENDING'});
  console.log('\n=== CHATGPT LOCAL BRIDGE PUBLIC ENDPOINT ALLOCATED ===');
  console.log(`Version: ${VERSION}`);
  console.log('OpenAPI URL:');console.log(schemaUrl);
  console.log('\nInstructions URL:');console.log(instructionsUrl);
  console.log('\nRunning bounded public preflight (startup will not be killed by a local hairpin/self-probe failure)...');

  const tunnelExit=new Promise((_,reject)=>tunnel.once('exit',code=>reject(new Error(`cloudflared exited before/during public preflight (${code})`))));
  const preflight=await Promise.race([publicPreflight(url,cap,{timeoutMs:30000}),tunnelExit]);
  await writeConnection({url,schemaUrl,instructionsUrl,status:preflight.ok?'PASS':'PENDING',lastError:preflight.lastError,bridgePid:preflight.bridgePid});

  console.log(`\n=== CHATGPT LOCAL BRIDGE V${VERSION} GPT ACTIONS READY ===`);
  console.log('Bridge ready');
  console.log('Authentication: NONE');
  console.log(`PUBLIC PREFLIGHT: ${preflight.ok?'PASS':'PENDING (local self-probe failed; bridge remains online)'}`);
  if(preflight.ok)console.log(`Public PC status reached bridge PID: ${preflight.bridgePid??'unknown'}`);
  else console.log(`Last public probe error: ${preflight.lastError}`);
  console.log('OpenAPI URL:');console.log(schemaUrl);
  console.log('\nInstructions URL:');console.log(instructionsUrl);
  console.log('\nKEEP THIS WINDOW OPEN.');
  console.log('Every incoming action is logged as [HTTP ...] with route and structured result.');
  console.log('Action-route validation/internal errors are normalized to HTTP 200 so ChatGPT receives the real bridge error instead of a generic aiohttp ClientResponseError.');
  console.log('The random capability is stored locally and embedded only in the private Action schema.');
  if(!preflight.ok)console.log('A background public preflight will keep retrying and update CURRENT-CONNECTION.txt / bridge-endpoint.json if connectivity recovers.');

  const stopBackground=preflight.ok?()=>{}:startBackgroundPreflight(url,cap,instructionsUrl);
  let stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;stopBackground();try{tunnel.kill()}catch{};try{api.kill()}catch{};setTimeout(()=>process.exit(0),250).unref()};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  tunnel.once('exit',code=>{if(!stopping){console.error(`\n*** TUNNEL DOWN: cloudflared exited with code ${code}. The current quick-tunnel URL is no longer valid. ***`);stop()}});
  api.once('exit',code=>{if(!stopping){console.error(`\n*** LOCAL API DOWN: bridge HTTP server exited with code ${code}. ***`);stop()}});
  await new Promise(()=>{});
}
main().catch(e=>{console.error('\nV19 ERROR:',e?.stack??e);process.exit(1)});
