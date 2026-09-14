#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { executeCommand, loadOrCreateConfig, localAppData, appendAudit, initializePersistentServices, VERSION } from './bridge.mjs';
import { loadAgentRuntime } from './agent-runtime/runtime-loader.mjs';
import { createActionRecord, GUI_DISPATCH_ACTIONS } from './agent-runtime/action-model.mjs';

const HOST='127.0.0.1';
const PORT=Number(process.env.CHATGPT_LOCAL_BRIDGE_ACTION_PORT||43124);
const CAP=String(process.env.CHATGPT_LOCAL_BRIDGE_ACTION_CAP||'');
if(!/^[A-Za-z0-9_-]{40,120}$/.test(CAP)){console.error('CHATGPT_LOCAL_BRIDGE_ACTION_CAP missing/invalid');process.exit(2)}
const BASE=`/gpt/${CAP}`;
const MAX_BODY=8*1024*1024;
const imageCache=new Map();
const idem=new Map();
const agentRuntime=await loadAgentRuntime();

const dataDir=localAppData();
const {config,cfgPath}=await loadOrCreateConfig(dataDir);
const state={config,cfgPath,dataDir,appCache:null,appCacheAt:0,auditPath:path.join(dataDir,'audit-actions.jsonl'),uiHelper:null,lastCommand:null};
await initializePersistentServices(state);

function sendJson(res,code,obj,extraHeaders={}){const b=Buffer.from(JSON.stringify(obj));res.writeHead(code,{'content-type':'application/json; charset=utf-8','content-length':b.length,'cache-control':'no-store','x-content-type-options':'nosniff','x-chatgpt-local-bridge-version':VERSION,...extraHeaders});res.end(b)}
function sendText(res,code,text,type='text/plain; charset=utf-8'){const b=Buffer.from(text);res.writeHead(code,{'content-type':type,'content-length':b.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(b)}
async function readJson(req){let chunks=[],n=0;for await(const c of req){n+=c.length;if(n>MAX_BODY)throw Object.assign(new Error('request_too_large'),{statusCode:413});chunks.push(c)}if(!n)return{};try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Object.assign(new Error('invalid_json'),{statusCode:400})}}
function cleanResult(result){if(!result||typeof result!=='object')return result;const clone=structuredClone(result);let b64=clone?.data?.base64;if(typeof b64==='string'&&b64.length>16){let buf;try{buf=Buffer.from(b64,'base64')}catch{};if(buf?.length){const id=crypto.randomBytes(16).toString('hex');imageCache.set(id,{buf,mime:clone.data.mime||'image/png',expires:Date.now()+10*60*1000});clone.data.imageId=id;clone.data.imagePath=`${BASE}/images/${id}`;}delete clone.data.base64;}return clone}
function gc(){const now=Date.now();for(const[k,v]of imageCache)if(v.expires<now)imageCache.delete(k);for(const[k,v]of idem)if(v.expires<now)idem.delete(k)}
setInterval(gc,60000).unref();
function buildActionModel(action,args,result,startedAt,completedAt){
 const executed=result?.status==='ok';
 const explicit=result?.data?.validation;
 const changeObserved=explicit?.changed??(result?.data?.canvasFound===true?true:(GUI_DISPATCH_ACTIONS.has(action)?null:executed));
 const goalReached=explicit?.goalReached??(executed&&!GUI_DISPATCH_ACTIONS.has(action));
 return createActionRecord({
  id:String(args?.requestId||crypto.randomUUID()),goal:String(args?.goal||action),
  preconditions:[{name:'route-and-payload-valid',satisfied:true}],
  observationBefore:args?.observationBefore??null,
  action:{commandSent:true,executed,resultStatus:result?.status??'error'},
  expectedResult:args?.expectedResult??{status:'ok'},
  observationAfter:result?.data?.observationAfter??null,
  validation:{validated:goalReached===true,commandSent:true,actionExecuted:executed,changeObserved,goalReached,reason:goalReached?'goal_reached':executed?'goal_not_independently_observed':'action_failed'},
  recovery:result?.data?.recovery??{attempted:false,strategy:null},
  metrics:{startedAt,completedAt,durationMs:Math.max(0,Date.parse(completedAt)-Date.parse(startedAt))}
 });
}
async function doCommand(action,args,source='gpt-action'){
 const requestId=String(args?.requestId||'').trim();const bodyHash=crypto.createHash('sha256').update(JSON.stringify({action,args})).digest('hex');
 if(requestId&&idem.has(requestId)){const prev=idem.get(requestId);if(prev.hash!==bodyHash)return{status:'error',message:'requestId reuse with different payload rejected'};return prev.result}
 const startedAt=new Date().toISOString();let result;try{result=await executeCommand(state,{...args,action})}catch(e){result={status:'error',message:String(e?.message??e),...(e?.details?{data:{diagnostics:e.details}}:{})}}
 const completedAt=new Date().toISOString();result.actionModel=buildActionModel(action,args,result,startedAt,completedAt);
 state.lastCommand={action,startedAt,completedAt,...result};await appendAudit(state,{source,action,workspace:args?.workspace??'',status:result.status,message:result.message,validation:result.actionModel.validation});
 const out=cleanResult(result);if(requestId)idem.set(requestId,{hash:bodyHash,result:out,expires:Date.now()+5*60*1000});return out
}

const MACROS={
 pcInspect:{status:'pc-status',windows:'list-windows',processes:'list-processes',apps:'list-apps',renderer:'renderer-info'},
 appControl:{launch:'launch-app'},
 screenInspect:{info:'screen-info',capture:'screen-capture',captureRegion:'screen-capture-region',samplePixel:'sample-canvas-pixel',paintCanvas:'find-paint-canvas'},
 paintControl:{draw:'draw-in-paint',status:'paint-job-status',control:'paint-job-control'},
 uiControl:{move:'mouse-move',click:'mouse-click',drag:'mouse-drag',scroll:'mouse-scroll',typeText:'type-text',keyPress:'key-press'},
 watchInspect:{list:'list-watches'},
 watchControl:{teamsSender:'watch-teams-sender',notification:'watch-notification',stop:'stop-watch',testAlarm:'test-alarm'},
 workspaceRead:{listWorkspaces:'list-workspaces',listDir:'list-dir',searchText:'search-text',readFile:'read-file'},
 workspaceWrite:{writeFile:'write-file',mkdir:'mkdir',copyFile:'copy-file',moveFile:'move-file',deleteFile:'delete-file'},
 workspaceRun:{task:'run-task',npmScript:'npm-script'},
 gitInspect:{status:'git-status',diff:'git-diff',log:'git-log'},
 gitControl:{commit:'git-commit'},
 processControl:{stop:'stop-process'},
 imageControl:{create:'image-target-create',info:'image-target-info',delete:'image-target-delete',clipboard:'clipboard-set-target',paintRender:'paint-render-target',paintCorrect:'paint-correct-target',mouseRender:'mouse-render-target',compare:'compare-target-region'}
};
const PATH_TO_MACRO={
 '/pc':'pcInspect','/apps':'appControl','/screen':'screenInspect','/paint':'paintControl','/ui':'uiControl','/watch/read':'watchInspect','/watch':'watchControl',
 '/workspace/read':'workspaceRead','/workspace/write':'workspaceWrite','/workspace/run':'workspaceRun','/git/read':'gitInspect','/git':'gitControl','/process':'processControl','/image':'imageControl'
};
function macroDispatch(macro,body){const table=MACROS[macro]||{};const keys=Object.keys(table);let sub=String(body?.action??'').trim();if(!sub&&keys.length===1)sub=keys[0];const internal=table[sub];if(!internal){const allowed=keys.join(', ');throw Object.assign(new Error(`Unknown ${macro} action '${sub}'. Allowed: ${allowed}`),{statusCode:400,bridgeActionError:true})}const args={...body};delete args.action;return{internal,args,sub}}
function safePathname(pathname){return String(pathname||'').replace(BASE,'/gpt/<cap>')}
function reqId(){return crypto.randomBytes(8).toString('hex')}
function logHttp(id,req,pathname,status,detail=''){const line=`[HTTP ${new Date().toISOString()}] id=${id} ${req.method||''} ${safePathname(pathname)} -> ${status}${detail?` ${detail}`:''}`;console.log(line);appendAudit(state,{source:'http',id,method:req.method||'',path:safePathname(pathname),httpStatus:status,detail:String(detail||'').slice(0,1000)}).catch(()=>{})}

const str=(description,maxLength)=>({type:'string',description,...(maxLength?{maxLength}:{})});
const int=(description,minimum,maximum)=>({type:'integer',description,...(minimum!==undefined?{minimum}:{}),...(maximum!==undefined?{maximum}:{})});
const bool=(description)=>({type:'boolean',description});
const actionBody=(actions,properties,description)=>({required:true,content:{'application/json':{schema:{type:'object',required:['action'],description,properties:{action:{type:'string',enum:actions},...properties},additionalProperties:false}}}});
const resp={responses:{'200':{description:'Structured bridge result'}}};
const op=(operationId,summary,consequential,requestBody)=>({operationId,summary,'x-openai-isConsequential':consequential,...(requestBody?{requestBody}:{}),...resp});

function openApi(publicOrigin){const server=`${publicOrigin}${BASE}`;return{
 openapi:'3.1.0',
 info:{title:'ChatGPT Local Bridge Actions',version:VERSION,description:'Bounded PC capabilities with V19.8 window intelligence, evidence fusion, validation, recovery, and asynchronous Paint jobs. No arbitrary remote shell.'},
 servers:[{url:server}],
 paths:{
  '/pc':{post:op('pcInspect','Inspect PC state, windows, processes, installed apps, or renderer diagnostics.',false,actionBody(['status','windows','processes','apps','renderer'],{query:str('Optional app-name filter for action=apps.',200)},'Choose one read-only PC inspection action.'))},
  '/apps':{post:op('appControl','Launch a normal installed GUI application.',false,actionBody(['launch'],{name:str('Installed application name, e.g. Paint, Discord, Rayman Origins.',240),requestId:str('Optional idempotency key.',120)},'action=launch requires name.'))},
  '/screen':{post:op('screenInspect','Inspect screen geometry, capture the desktop/region, sample a pixel, or locate the Paint canvas.',false,actionBody(['info','capture','captureRegion','samplePixel','paintCanvas'],{x:int('Screen X coordinate.'),y:int('Screen Y coordinate.'),width:int('Region width.',1,10000),height:int('Region height.',1,10000),maxWidth:int('Maximum returned capture width.',160,2000)},'captureRegion requires x,y,width,height; samplePixel requires x,y.'))},
  '/paint':{post:op('paintControl','Create and control drawings in Microsoft Paint. raster-color is the fast cheat-like pixel renderer; vector traces paths; exact pastes only when explicitly requested.',false,actionBody(['draw','status','control'],{svg:str('Self-contained SVG target. For realistic raster modes the SVG may contain fills, gradients and detailed shapes.',420000),width:int('Source render width.',64,2048),height:int('Source render height.',64,2048),mode:{type:'string',enum:['raster-color','raster-gray','vector','exact'],default:'raster-color'},quality:{type:'string',enum:['fast','balanced','quality','ultra'],default:'balanced'},palette:{type:'string',enum:['classic16','classic12','portrait8','gray4']},resolution:int('Optional raster resolution in pixels. Higher is more detailed but slower.',64,420),smoothing:bool('Reduce tiny noisy color islands before drawing.'),minRun:int('Minimum horizontal run length to keep.',1,8),minScore:{type:'number',minimum:0,maximum:1},jobId:str('Paint job id for status/control.',64),command:{type:'string',enum:['pause','resume','stop']},margin:int('Vector canvas margin.',4,120),strokeDurationMs:int('Vector duration per stroke group.',100,12000),requestId:str('Optional idempotency key.',120)},'draw requires svg. Default mode=raster-color and returns a background job id. status reads progress. control requires command pause/resume/stop; physical mouse movement also pauses automatically and F8/F9 work locally.'))},
  '/ui':{post:op('uiControl','Low-level visible GUI control when no high-level action exists: mouse move/click/drag/scroll or keyboard typing/key press.',true,actionBody(['move','click','drag','scroll','typeText','keyPress'],{x:int('Screen X coordinate.'),y:int('Screen Y coordinate.'),durationMs:int('Movement/drag duration milliseconds.',0,30000),button:{type:'string',enum:['left','right','middle']},clicks:int('Click count.',1,3),points:{type:'array',minItems:2,maxItems:2000,items:{type:'object',required:['x','y'],properties:{x:{type:'integer'},y:{type:'integer'}},additionalProperties:false}},delta:int('Scroll delta.',-7200,7200),text:str('Text to type.',4000),key:str('Key name.',16),ctrl:bool('Hold Ctrl.'),shift:bool('Hold Shift.'),alt:bool('Hold Alt.')},'move/click/scroll use x,y; drag uses points; typeText uses text; keyPress uses key and optional modifiers.'))},
  '/watch/read':{post:op('watchInspect','List persistent local notification/Teams watches and their last matches.',false,actionBody(['list'],{},'Read-only watcher inspection.'))},
  '/watch':{post:op('watchControl','Create/stop persistent local notification watches or test the local alarm. Watches keep running locally without ChatGPT.',true,actionBody(['teamsSender','notification','stop','testAlarm'],{sender:str('Teams sender name for teamsSender.',160),textContains:str('Text filter for notification.',160),appContains:str('Optional application filter.',120),label:str('Human-readable watcher label.',160),alarmSeconds:int('Alarm duration seconds.',10,600),id:str('Watch id; required for stop.',160)},'teamsSender requires sender; notification requires textContains; stop requires id; testAlarm requires no extra fields.'))},
  '/workspace/read':{post:op('workspaceRead','Read and search configured local development workspaces.',false,actionBody(['listWorkspaces','listDir','searchText','readFile'],{workspace:str('Configured workspace name.',64),relativePath:str('Path relative to workspace.',1000),query:str('Search query.',500),caseSensitive:bool('Case-sensitive search.')},'listWorkspaces needs no args; other actions require workspace; searchText also requires query; readFile requires relativePath.'))},
  '/workspace/write':{post:op('workspaceWrite','Write, create, copy, move, or delete files inside configured workspaces only.',true,actionBody(['writeFile','mkdir','copyFile','moveFile','deleteFile'],{workspace:str('Configured workspace name.',64),relativePath:str('Path relative to workspace.',1000),text:str('Complete UTF-8 file content.'),expectedSha256:str('Optional optimistic-concurrency SHA256.',64),source:str('Source path relative to workspace.',1000),destination:str('Destination path relative to workspace.',1000),requestId:str('Optional idempotency key.',120)},'writeFile requires workspace,relativePath,text; mkdir/deleteFile require workspace,relativePath; copy/move require workspace,source,destination.'))},
  '/workspace/run':{post:op('workspaceRun','Run bounded project tasks or an npm script already declared in package.json. No arbitrary shell.',true,actionBody(['task','npmScript'],{workspace:str('Configured workspace name.',64),task:{type:'string',enum:['typecheck','test','build','check']},script:str('Existing package.json script name.',200),packageDir:str('Package directory relative to workspace.',1000),timeoutMs:int('Timeout milliseconds.',10000,1200000),requestId:str('Optional idempotency key.',120)},'task requires workspace and task; npmScript requires workspace and script.'))},
  '/git/read':{post:op('gitInspect','Read Git status, diff, or recent log for a configured workspace.',false,actionBody(['status','diff','log'],{workspace:str('Configured workspace name.',64),count:int('Log entry count.',1,50)},'All actions require workspace; log optionally accepts count.'))},
  '/git':{post:op('gitControl','Create a Git commit in a configured workspace after local Windows confirmation.',true,actionBody(['commit'],{workspace:str('Configured workspace name.',64),message:str('Commit message.',500),stageAll:bool('Stage all changes before commit; default true.')},'commit requires workspace and message.'))},
  '/process':{post:op('processControl','Stop a process by PID after local Windows confirmation.',true,actionBody(['stop'],{pid:int('Target PID.',5,2147483647),force:bool('Force termination.')},'stop requires pid.'))},
  '/image':{post:op('imageControl','Advanced image-target pipeline: store image, inspect/delete target, copy to clipboard, render/correct Paint, mouse-render line-art, or compare target with a screen region.',true,actionBody(['create','info','delete','clipboard','paintRender','paintCorrect','mouseRender','compare'],{base64:str('PNG/JPEG image encoded in base64.'),targetId:str('Stored target id.',64),x:int('Region X.'),y:int('Region Y.'),width:int('Width.',1,10000),height:int('Height.',1,10000),renderWidth:int('Rendered width.',1,4096),renderHeight:int('Rendered height.',1,4096),minScore:{type:'number',minimum:0,maximum:1},threshold:int('Line-art threshold.',0,255),sampleStep:int('Line-art sample step.',1,16),maxRuns:int('Maximum mouse render runs.',1,12000)},'create requires base64; most other actions require targetId; paintCorrect/mouseRender/compare also require x,y,width,height.'))}
 }
};}

const server=http.createServer(async(req,res)=>{
 const id=reqId();let url;let isActionRoute=false;
 try{
  url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
  if(url.pathname==='/readyz'){sendJson(res,200,{ok:true,version:VERSION,type:'gpt-actions',runtime:{loaded:agentRuntime.context.coreLoaded,compatible:agentRuntime.compatible,version:agentRuntime.context.version},macroActions:Object.keys(MACROS).length,subActions:Object.values(MACROS).reduce((n,x)=>n+Object.keys(x).length,0)},{'x-bridge-request-id':id});logHttp(id,req,url.pathname,200);return}
  if(url.pathname===`/setup/${CAP}/openapi.json`){const origin=String(req.headers['x-forwarded-proto']||'https')+'://'+String(req.headers['x-forwarded-host']||req.headers.host);sendJson(res,200,openApi(origin),{'x-bridge-request-id':id});logHttp(id,req,url.pathname,200,'openapi');return}
  if(url.pathname===`/setup/${CAP}/instructions.txt`){sendText(res,200,`Use ChatGPT Local Bridge whenever the user asks to act on their Windows PC. Choose macro actions yourself; never ask the user for operation IDs. Prefer high-level actions. For realistic Paint requests, create a detailed self-contained SVG target and call paintControl(action=draw, mode=raster-color, quality=balanced or quality). This starts a cheat-style compressed scanline job that physically draws with the real mouse instead of pasting an image. For monochrome use raster-gray; use vector only for line art and exact only when the user explicitly requests paste/import. A raster draw returns jobId immediately; do not spam status polls. The local overlay shows progress. Physical user mouse movement pauses instantly, F8 toggles pause/resume, F9 stops, and paintControl(action=control) can also pause/resume/stop. Never replace a Paint request with ChatGPT image generation. Use watchControl(action=teamsSender) for persistent Teams alarms. Use uiControl only when no higher-level action exists. If an action returns status=error, report bridgeDiagnostics exactly. No arbitrary shell exists.`);logHttp(id,req,url.pathname,200,'instructions');return}
  if(!url.pathname.startsWith(BASE+'/')){sendJson(res,404,{error:'not_found',bridgeDiagnostics:{requestId:id,version:VERSION,path:safePathname(url.pathname)}},{'x-bridge-request-id':id});logHttp(id,req,url.pathname,404,'outside capability');return}
  const imgMatch=url.pathname.match(new RegExp('^'+BASE.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')+'/images/([a-f0-9]{32})$'));
  if(imgMatch&&req.method==='GET'){const x=imageCache.get(imgMatch[1]);if(!x||x.expires<Date.now()){sendJson(res,404,{error:'image_expired',bridgeDiagnostics:{requestId:id,version:VERSION}},{'x-bridge-request-id':id});logHttp(id,req,url.pathname,404,'image expired');return}res.writeHead(200,{'content-type':x.mime,'content-length':x.buf.length,'cache-control':'no-store','x-content-type-options':'nosniff','x-chatgpt-local-bridge-version':VERSION,'x-bridge-request-id':id});res.end(x.buf);logHttp(id,req,url.pathname,200,'image');return}
  isActionRoute=true;
  if(req.method!=='POST'){const out={status:'error',message:'method_not_allowed',bridgeDiagnostics:{requestId:id,version:VERSION,httpStatusNormalizedTo200:true,receivedMethod:req.method,path:safePathname(url.pathname)}};sendJson(res,200,out,{'x-bridge-request-id':id});logHttp(id,req,url.pathname,200,'normalized method error');return}
  const sub=url.pathname.slice(BASE.length);const macro=PATH_TO_MACRO[sub];
  if(!macro){const out={status:'error',message:`unknown_action_path: ${sub}`,bridgeDiagnostics:{requestId:id,version:VERSION,httpStatusNormalizedTo200:true,path:safePathname(url.pathname),knownPaths:Object.keys(PATH_TO_MACRO)}};sendJson(res,200,out,{'x-bridge-request-id':id});logHttp(id,req,url.pathname,200,'normalized unknown path');return}
  let body;
  try{body=await readJson(req)}catch(e){const out={status:'error',message:String(e?.message??e),bridgeDiagnostics:{requestId:id,version:VERSION,httpStatusNormalizedTo200:true,path:safePathname(url.pathname),originalStatus:e?.statusCode||400}};sendJson(res,200,out,{'x-bridge-request-id':id});logHttp(id,req,url.pathname,200,`normalized body error ${e?.statusCode||400}`);return}
  let dispatched;
  try{dispatched=macroDispatch(macro,body)}catch(e){const out={status:'error',message:String(e?.message??e),bridgeDiagnostics:{requestId:id,version:VERSION,httpStatusNormalizedTo200:true,path:safePathname(url.pathname),macro,receivedAction:String(body?.action??''),originalStatus:e?.statusCode||400}};sendJson(res,200,out,{'x-bridge-request-id':id});logHttp(id,req,url.pathname,200,`normalized dispatch error ${e?.statusCode||400}`);return}
  const {internal,args,sub:subAction}=dispatched;
  const result=await doCommand(internal,args,`gpt-macro:${macro}`);
  if(result?.data?.imagePath){const proto=String(req.headers['x-forwarded-proto']||'https');const host=String(req.headers['x-forwarded-host']||req.headers.host);result.data.imageUrl=`${proto}://${host}${result.data.imagePath}`;delete result.data.imagePath}
  if(result&&typeof result==='object')result.bridgeDiagnostics={...(result.bridgeDiagnostics||{}),requestId:id,version:VERSION,macro,action:subAction,internalAction:internal,path:safePathname(url.pathname)};
  sendJson(res,200,result,{'x-bridge-request-id':id});logHttp(id,req,url.pathname,200,`${macro}.${subAction} status=${result?.status||'unknown'}`)
 }catch(e){
  const pathname=url?.pathname||req.url||'';
  if(isActionRoute){const out={status:'error',message:String(e?.message??e),bridgeDiagnostics:{requestId:id,version:VERSION,httpStatusNormalizedTo200:true,path:safePathname(pathname),stack:String(e?.stack||'').slice(0,4000)}};sendJson(res,200,out,{'x-bridge-request-id':id});logHttp(id,req,pathname,200,'normalized internal 500');return}
  sendJson(res,e?.statusCode||500,{status:'error',message:String(e?.message??e),bridgeDiagnostics:{requestId:id,version:VERSION,path:safePathname(pathname)}},{'x-bridge-request-id':id});logHttp(id,req,pathname,e?.statusCode||500,String(e?.message??e).slice(0,300))
 }
});
server.on('error',err=>{
 console.error(JSON.stringify({ok:false,type:'gpt-actions-http-error',version:VERSION,code:err?.code||'',message:String(err?.message||err),requestedPort:PORT,pid:process.pid}));
 process.exit(1);
});
server.listen(PORT,HOST,()=>{
 const addr=server.address();
 const boundPort=typeof addr==='object'&&addr?addr.port:PORT;
 console.log(JSON.stringify({ok:true,type:'gpt-actions-http',version:VERSION,runtimeVersion:agentRuntime.context.version,url:`http://${HOST}:${boundPort}`,port:boundPort,requestedPort:PORT,setupPath:`/setup/${CAP}/openapi.json`,macroActions:Object.keys(MACROS).length,subActions:Object.values(MACROS).reduce((n,x)=>n+Object.keys(x).length,0),pid:process.pid}));
});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>server.close(()=>process.exit(0)));
