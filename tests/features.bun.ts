import {test,expect} from 'bun:test';
import {FakeSDK,fixture} from './folder-sync.bun';
import {FolderSync} from '../src/folder-sync';
import {SyncState} from '../src/sync-state';
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm,readdir,symlink} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';

class EventSDK extends FakeSDK {
 sequence=0;events:any[]=[];listCalls=0;refreshRequired=false;breakEventsOnce=false;failUploadOnce=false;
 record(uid:string,type='node_updated'){this.events.push({type,nodeUid:uid,eventId:String(++this.sequence),treeEventScopeId:'scope',isTrashed:false});}
 async createFolder(parent:string,name:string){const n=await super.createFolder(parent,name);this.record(n.uid,'node_created');return n;}
 async *iterateFolderChildren(uid:string){this.listCalls++;yield* super.iterateFolderChildren(uid);}
 async getNode(uid:string){const n=await super.getNode(uid);if(!n)throw Object.assign(new Error('missing'),{httpCode:404});return n;}
 uploader(parent:string,name:string,metadata:any,uid?:string){const base=super.uploader(parent,name,metadata,uid);return{uploadFromStream:async(stream:any,_:any=[],progress?:any)=>{const c=await base.uploadFromStream(stream);progress?.(metadata.expectedSize);return{completion:async()=>{const r=await c.completion();this.record(r.nodeUid);if(this.failUploadOnce){this.failUploadOnce=false;throw Object.assign(new Error('connection dropped after commit'),{code:'ECONNRESET'});}return r;}};}};}
 async *iterateEvents(_scope:string,last?:string){
  if(last===undefined){yield{type:'fast_forward',eventId:String(this.sequence)};return;}
  if(this.refreshRequired){this.refreshRequired=false;yield{type:'tree_refresh',eventId:String(this.sequence)};return;}
  for(const e of this.events.filter(e=>Number(e.eventId)>Number(last))){yield e;if(this.breakEventsOnce){this.breakEventsOnce=false;throw Object.assign(new Error('event stream interrupted'),{code:'ECONNRESET'});}}
 }
 async renameNode(uid:string,name:string){const n=await super.renameNode(uid,name);this.record(uid);return n;}
 async *trashNodes(uids:string[]){for await(const r of super.trashNodes(uids)){this.record(r.uid,'node_deleted');yield r;}}
}
async function eventFixture(options:any={}){
 const temp=await mkdtemp(path.join(os.tmpdir(),'proton-features-')),local=path.join(temp,'local'),state=path.join(temp,'state');await mkdir(local);await mkdir(state);const sdk=new EventSDK();const engine=new FolderSync(sdk,state,local,options);
 return{temp,local,state,sdk,engine,close:async()=>{await engine.stop();await rm(temp,{recursive:true,force:true});}};
}
async function until(check:()=>Promise<boolean>|boolean){const deadline=Date.now()+3000;while(!await check()){if(Date.now()>deadline)throw new Error('timeout');await Bun.sleep(10);}}

test('warm restart replays offline changes without recursively listing the cloud',async()=>{
 const f=await eventFixture();let second:any;try{
  const {nodeUid}=await f.sdk.addFile('root','old.txt','old');await f.engine.start();await f.engine.stop();
  await f.sdk.renameNode(nodeUid,'new.txt');const up=await f.sdk.getFileRevisionUploader(nodeUid,{expectedSha1:(await import('node:crypto')).createHash('sha1').update('new').digest('hex')});await(await up.uploadFromStream(new Blob(['new']).stream())).completion();
  f.sdk.listCalls=0;second=new FolderSync(f.sdk,f.state,f.local);await second.start();expect(f.sdk.listCalls).toBe(0);expect(second.indexMode).toBe('eventos guardados');expect(await readFile(path.join(f.local,'new.txt'),'utf8')).toBe('new');expect(await lstat(path.join(f.local,'old.txt')).catch(()=>null)).toBeNull();
 }finally{if(second)await second.stop();await f.close();}
});
test('expired event cursor triggers a safe full refresh',async()=>{
 const f=await eventFixture();let second:any;try{await f.sdk.addFile('root','a.txt','a');await f.engine.start();await f.engine.stop();f.sdk.refreshRequired=true;f.sdk.listCalls=0;second=new FolderSync(f.sdk,f.state,f.local);await second.start();expect(f.sdk.listCalls).toBeGreaterThan(0);expect(await readFile(path.join(f.local,'a.txt'),'utf8')).toBe('a');}finally{if(second)await second.stop();await f.close();}
});
test('network loss midway through download keeps the old file and retries',async()=>{
 const f=await eventFixture({retryDelay:20});try{
  const {nodeUid}=await f.sdk.addFile('root','a.txt','old');await f.engine.start();const normal=f.sdk.getFileDownloader.bind(f.sdk);let fail=true;
  f.sdk.getFileDownloader=async(uid:string)=>fail?{downloadToStream:(stream:any)=>({completion:async()=>{fail=false;const w=stream.getWriter();await w.write(new TextEncoder().encode('partial'));throw Object.assign(new Error('network'),{code:'ECONNRESET'});}})}:normal(uid);
  await f.sdk.addFile('root','temporary.txt','');f.sdk.nodes.delete([...f.sdk.nodes.values()].find(n=>n.name.value==='temporary.txt')!.uid);
  const uploader=await f.sdk.getFileRevisionUploader(nodeUid,{expectedSha1:(await import('node:crypto')).createHash('sha1').update('new').digest('hex')});await(await uploader.uploadFromStream(new Blob(['new']).stream())).completion();
  await f.engine.now();expect(await readFile(path.join(f.local,'a.txt'),'utf8')).toBe('old');expect(f.engine.view().error.kind).toBe('network');
  await until(async()=>await readFile(path.join(f.local,'a.txt'),'utf8')==='new' && f.engine.view().progress.phase==='idle');expect((await readdir(f.local)).some(n=>n.startsWith('.nube-part-'))).toBe(false);
 }finally{await f.close();}
});
test('disk full preserves original and exposes an actionable error until retry',async()=>{
 let free=1000000;const f=await eventFixture({freeBytes:async()=>free});try{
  const {nodeUid}=await f.sdk.addFile('root','a.txt','old');await f.engine.start();free=0;const up=await f.sdk.getFileRevisionUploader(nodeUid,{expectedSha1:(await import('node:crypto')).createHash('sha1').update('changed').digest('hex')});await(await up.uploadFromStream(new Blob(['changed']).stream())).completion();f.sdk.nodes.get(nodeUid).activeRevision.claimedSize=7;
  await f.engine.now();expect(await readFile(path.join(f.local,'a.txt'),'utf8')).toBe('old');expect(f.engine.view().error.kind).toBe('disk');expect(f.engine.view().nextRetryAt).toBeNull();free=1000000;await f.engine.now();expect(await readFile(path.join(f.local,'a.txt'),'utf8')).toBe('changed');
 }finally{await f.close();}
});
test('expired authentication does not retry blindly or overwrite local data',async()=>{
 const f=await eventFixture();try{await f.sdk.addFile('root','a.txt','server');f.sdk.getFileDownloader=async()=>{throw Object.assign(new Error('expired'),{httpCode:401});};await f.engine.start();expect(f.engine.view().error.kind).toBe('auth');expect(f.engine.view().nextRetryAt).toBeNull();expect(await lstat(path.join(f.local,'a.txt')).catch(()=>null)).toBeNull();}finally{await f.close();}
});
test('upload committed before connection loss is adopted after restart instead of duplicated',async()=>{
 const f=await eventFixture();let second:any;try{await writeFile(path.join(f.local,'a.txt'),'a');f.sdk.failUploadOnce=true;await f.engine.start();expect(f.sdk.uploads).toBe(1);await f.engine.stop();second=new FolderSync(f.sdk,f.state,f.local);await second.start();expect(f.sdk.uploads).toBe(1);expect(second.view().history.some((r:any)=>r.kind==='recuperación')).toBe(true);}finally{if(second)await second.stop();await f.close();}
});
test('event cursor is not advanced when a replay fails midway',async()=>{
 const f=await eventFixture();try{await f.engine.start();const before=(new SyncState(f.state)).meta('snapshot').eventCursor;await f.sdk.addFile('root','a.txt','a');f.sdk.breakEventsOnce=true;await f.engine.now();const stored=new SyncState(f.state);expect(stored.meta('snapshot').eventCursor).toBe(before);stored.close();await f.engine.now();expect(await readFile(path.join(f.local,'a.txt'),'utf8')).toBe('a');}finally{await f.close();}
});
test('a killed process leaves a durable journal that cleans only its registered temporary file',async()=>{
 const f=await eventFixture();let second:any;try{
  await f.engine.start();await f.engine.stop();const temp=path.join(f.local,'.nube-part-killed'),untouched=path.join(f.local,'.nube-part-unrelated');await writeFile(untouched,'keep');
  const module=fileURLToPath(new URL('../src/sync-state.ts',import.meta.url));const code=`import {SyncState} from ${JSON.stringify(module)};import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(temp)},'partial');const s=new SyncState(${JSON.stringify(f.state)});s.begin('download','a.txt',{temp:${JSON.stringify(temp)}});process.stdout.write('ready');setInterval(()=>{},1000);`;
  const child=Bun.spawn([process.execPath,'--eval',code],{stdout:'pipe',stderr:'pipe'});const reader=child.stdout.getReader();await reader.read();child.kill('SIGKILL');await child.exited;
  second=new FolderSync(f.sdk,f.state,f.local);await second.start();expect(await lstat(temp).catch(()=>null)).toBeNull();expect(await readFile(untouched,'utf8')).toBe('keep');expect(second.view().history.some((r:any)=>r.kind==='recuperación')).toBe(true);
 }finally{if(second)await second.stop();await f.close();}
});
test('corrupt index fails closed without deleting either side',async()=>{
 const f=await eventFixture();try{await writeFile(path.join(f.state,'sync-state.sqlite'),'not a database');await writeFile(path.join(f.local,'a.txt'),'local');await f.sdk.addFile('root','b.txt','remote');await expect(f.engine.start()).rejects.toThrow();expect(f.engine.view().error.kind).toBe('index');expect(f.sdk.trashed.size).toBe(0);expect(await readFile(path.join(f.local,'a.txt'),'utf8')).toBe('local');}finally{await f.close();}
});
test('a symlink replacing a tracked file is not interpreted as a cloud deletion',async()=>{
 const f=await eventFixture();try{await writeFile(path.join(f.local,'a.txt'),'a');await f.engine.start();await rm(path.join(f.local,'a.txt'));await symlink('/etc/passwd',path.join(f.local,'a.txt'));await f.engine.now();expect(f.sdk.trashed.size).toBe(0);expect(f.engine.view().conflicts[0].kind).toBe('unavailable');}finally{await f.close();}
});

for(const choice of ['local','remote','both'] as const)test('content conflict can keep '+choice,async()=>{
 const f=await fixture();try{
  await writeFile(path.join(f.local,'a.txt'),'base');await f.engine.start();const uid=f.node('a.txt').uid;
  await writeFile(path.join(f.local,'a.txt'),'LOCAL');await f.sdk.addFile('root','a.txt','CLOUD');
  // Fake helper creates a fresh UID: remove the old version so there is one name.
  const newNode=[...f.sdk.nodes.values()].filter(n=>n.name.value==='a.txt').find(n=>n.uid!==uid)!;f.sdk.nodes.delete(uid);await (f.engine as any).enqueue(async()=>{(f.engine as any).removeNode(uid);(f.engine as any).putNode(newNode.uid,newNode);});await f.engine.now();
  const conflict=f.engine.view().conflicts.find((c:any)=>c.path==='a.txt');expect(conflict).toBeDefined();await f.engine.resolveConflict(conflict.id,choice);
  const expected=choice==='remote'?'CLOUD':'LOCAL';expect(await readFile(path.join(f.local,'a.txt'),'utf8')).toBe(expected);expect(new TextDecoder().decode(f.sdk.data.get(f.node('a.txt').uid))).toBe(expected);
  if(choice==='both'){const side=(await readdir(f.local)).find(n=>n.includes('copia nube'))!;expect(await readFile(path.join(f.local,side),'utf8')).toBe('CLOUD');expect(f.node(side)).toBeDefined();}
  expect(f.engine.view().conflictCount).toBe(0);
 }finally{await f.close();}
});
test('stale conflict decision is rejected when local content changes again',async()=>{
 const f=await fixture();try{await writeFile(path.join(f.local,'a.txt'),'base');await f.engine.start();await writeFile(path.join(f.local,'a.txt'),'local');const node=f.node('a.txt');const up=await f.sdk.getFileRevisionUploader(node.uid,{expectedSha1:(await import('node:crypto')).createHash('sha1').update('cloud').digest('hex')});await(await up.uploadFromStream(new Blob(['cloud']).stream())).completion();await f.event(node.uid);const c=f.engine.view().conflicts[0];await writeFile(path.join(f.local,'a.txt'),'newer');await expect(f.engine.resolveConflict(c.id,'remote')).rejects.toThrow('han cambiado');expect(await readFile(path.join(f.local,'a.txt'),'utf8')).toBe('newer');}finally{await f.close();}
});
test('integrity failure never replaces a known good local version',async()=>{
 const f=await eventFixture();try{const {nodeUid}=await f.sdk.addFile('root','a.txt','old');await f.engine.start();const up=await f.sdk.getFileRevisionUploader(nodeUid,{expectedSha1:(await import('node:crypto')).createHash('sha1').update('good').digest('hex')});await(await up.uploadFromStream(new Blob(['good']).stream())).completion();f.sdk.data.set(nodeUid,new TextEncoder().encode('corrupted'));await f.engine.now();expect(await readFile(path.join(f.local,'a.txt'),'utf8')).toBe('old');expect(f.engine.view().error.kind).toBe('integrity');expect(f.engine.view().nextRetryAt).toBeNull();}finally{await f.close();}
});
test('pause aborts an incomplete download and activation recovers it',async()=>{
 const f=await eventFixture();try{await f.sdk.addFile('root','a.txt','complete');const normal=f.sdk.getFileDownloader.bind(f.sdk);let enter:any;const entered=new Promise<void>(r=>enter=r);let abortOnce=true;
 f.sdk.getFileDownloader=async(uid:string,signal?:AbortSignal)=>abortOnce?{downloadToStream:(stream:any)=>({completion:async()=>{const writer=stream.getWriter();await writer.write(new TextEncoder().encode('partial'));enter();await new Promise((_,reject)=>signal!.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}));}})}:normal(uid);
 const starting=f.engine.start();await entered;await f.engine.stop();await starting;expect(await lstat(path.join(f.local,'a.txt')).catch(()=>null)).toBeNull();abortOnce=false;await f.engine.start();expect(await readFile(path.join(f.local,'a.txt'),'utf8')).toBe('complete');expect(f.engine.view().error).toBeNull();}finally{await f.close();}
});
for(const choice of ['local','remote','both'] as const)test('folder deletion versus remote edit can be resolved as '+choice,async()=>{
 const f=await fixture();try{await mkdir(path.join(f.local,'folder'));await writeFile(path.join(f.local,'folder/a.txt'),'base');await f.engine.start();const folder=f.node('folder');await rm(path.join(f.local,'folder'),{recursive:true});const {nodeUid}=await f.sdk.addFile(folder.uid,'new.txt','cloud');await f.event(nodeUid);const c=f.engine.view().conflicts[0];expect(c).toBeDefined();await f.engine.resolveConflict(c.id,choice);if(choice==='local'){expect(f.sdk.nodes.has(folder.uid)).toBe(false);expect(await lstat(path.join(f.local,'folder')).catch(()=>null)).toBeNull();}else{expect(await readFile(path.join(f.local,'folder/new.txt'),'utf8')).toBe('cloud');}expect(f.engine.view().conflictCount).toBe(0);}finally{await f.close();}
});
test('keeping both divergent folder moves creates both complete trees',async()=>{
 const f=await fixture();try{await mkdir(path.join(f.local,'original'));await writeFile(path.join(f.local,'original/a.txt'),'a');await f.engine.start();const uid=f.node('original').uid;await renameLocal();async function renameLocal(){await(await import('node:fs/promises')).rename(path.join(f.local,'original'),path.join(f.local,'local-name'));}await f.sdk.renameNode(uid,'cloud-name');await f.event(uid);const c=f.engine.view().conflicts[0];await f.engine.resolveConflict(c.id,'both');expect(await readFile(path.join(f.local,'local-name/a.txt'),'utf8')).toBe('a');expect(await readFile(path.join(f.local,'cloud-name/a.txt'),'utf8')).toBe('a');expect(f.node('local-name')).toBeDefined();expect(f.node('cloud-name')).toBeDefined();}finally{await f.close();}
});
test('manual rebuild preserves files and quarantines the corrupt index',async()=>{
 const f=await eventFixture();try{await writeFile(path.join(f.state,'sync-state.sqlite'),'broken');await writeFile(path.join(f.local,'local.txt'),'local');await f.sdk.addFile('root','remote.txt','remote');await f.engine.start().catch(()=>{});await f.engine.rebuildIndex();expect(await readFile(path.join(f.local,'local.txt'),'utf8')).toBe('local');expect(await readFile(path.join(f.local,'remote.txt'),'utf8')).toBe('remote');expect((await readdir(f.state)).some(n=>n.includes('before-rebuild'))).toBe(true);expect(f.sdk.trashed.size).toBe(0);}finally{await f.close();}
});
test('progress reports actual bytes, total, speed and an estimate while downloading',async()=>{
 const f=await eventFixture();try{const text='x'.repeat(100);const {nodeUid}=await f.sdk.addFile('root','progress.txt',text);let enter:any,release:any;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 f.sdk.getFileDownloader=async()=>({getClaimedSizeInBytes:()=>100,downloadToStream:(stream:any,onProgress:any)=>({completion:async()=>{const writer=stream.getWriter();await writer.write(new TextEncoder().encode(text.slice(0,50)));onProgress(50);enter();await gate;await writer.write(new TextEncoder().encode(text.slice(50)));onProgress(100);await writer.close();}})});
 const starting=f.engine.start();await entered;const p=f.engine.view().progress;expect(p.phase).toBe('download');expect(p.path).toBe('progress.txt');expect(p.bytes).toBe(50);expect(p.totalBytes).toBe(100);expect(p.speed).toBeGreaterThan(0);expect(p.eta).toBeGreaterThanOrEqual(0);release();await starting;expect(f.engine.view().history.some((r:any)=>r.kind==='download'&&r.result==='correcto')).toBe(true);
 }finally{await f.close();}
});
test('remote folder deletion does not silently remove a new excluded local file',async()=>{
 const f=await fixture();try{const folder=await f.sdk.createFolder('root','folder');await f.sdk.addFile(folder.uid,'a.txt','a');await f.engine.start();await writeFile(path.join(f.local,'folder/.excluded'),'private');for await(const _ of f.sdk.trashNodes([folder.uid])){}await f.event(folder.uid,true);expect(await readFile(path.join(f.local,'folder/.excluded'),'utf8')).toBe('private');expect(f.engine.view().conflictCount).toBeGreaterThan(0);}finally{await f.close();}
});
test('unreadable remote folder metadata never becomes a local deletion and can recover',async()=>{
 const f=await eventFixture();try{const folder=await f.sdk.createFolder('root','folder');await f.sdk.addFile(folder.uid,'a.txt','preserve');await f.engine.start();f.sdk.nodes.set(folder.uid,{...f.sdk.nodes.get(folder.uid),name:{ok:false,error:new Error('decrypt')}});f.sdk.refreshRequired=true;await f.engine.now();expect(await readFile(path.join(f.local,'folder/a.txt'),'utf8')).toBe('preserve');expect(f.engine.view().conflicts.some((c:any)=>c.kind==='unavailable')).toBe(true);expect(f.sdk.trashed.size).toBe(0);await f.sdk.renameNode(folder.uid,'folder');await f.engine.now();expect(await readFile(path.join(f.local,'folder/a.txt'),'utf8')).toBe('preserve');expect(f.engine.view().conflictCount).toBe(0);}finally{await f.close();}
});
test('cached local fingerprints survive restart but never hide offline edits',async()=>{
 const f=await eventFixture();let second:any;try{const {nodeUid}=await f.sdk.addFile('root','a.txt','old');await f.engine.start();await f.engine.stop();const saved=new SyncState(f.state);expect(saved.load().entries['a.txt'].localCache.hash).toBeDefined();saved.close();await writeFile(path.join(f.local,'a.txt'),'offline edit');f.sdk.listCalls=0;second=new FolderSync(f.sdk,f.state,f.local);await second.start();expect(f.sdk.listCalls).toBe(0);expect(new TextDecoder().decode(f.sdk.data.get(nodeUid))).toBe('offline edit');}finally{if(second)await second.stop();await f.close();}
});
test('a local filesystem change refreshes cloud events before deciding to upload',async()=>{
 const f=await eventFixture();try{const {nodeUid}=await f.sdk.addFile('root','a.txt','base');await f.engine.start();const up=await f.sdk.getFileRevisionUploader(nodeUid,{expectedSha1:(await import('node:crypto')).createHash('sha1').update('remote change').digest('hex')});await(await up.uploadFromStream(new Blob(['remote change']).stream())).completion();await writeFile(path.join(f.local,'a.txt'),'local change');await until(()=>f.engine.view().conflictCount===1);expect(await readFile(path.join(f.local,'a.txt'),'utf8')).toBe('local change');expect(new TextDecoder().decode(f.sdk.data.get(nodeUid))).toBe('remote change');}finally{await f.close();}
});
