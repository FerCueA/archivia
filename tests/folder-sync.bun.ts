import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,rename,lstat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {FolderSync,scanLocal} from '../src/folder-sync';

export class FakeSDK {
  nodes=new Map<string,any>();data=new Map<string,Uint8Array>();callback:any;uploads=0;downloads=0;trashed=new Map<string,any>();
  constructor(){this.nodes.set('root',{uid:'root',name:{ok:true,value:'root'},type:'folder',treeEventScopeId:'scope'});}
  async getMyFilesRootFolder(){return this.nodes.get('root');}
  async *iterateFolderChildren(uid:string){for(const n of this.nodes.values())if(n.parentUid===uid)yield n;}
  async createFolder(parentUid:string,name:string){const n={uid:crypto.randomUUID(),parentUid,name:{ok:true,value:name},type:'folder',treeEventScopeId:'scope'};this.nodes.set(n.uid,n);return n;}
  async getNode(uid:string){return this.nodes.get(uid);}
  async subscribeToTreeEvents(_:string,callback:any){this.callback=callback;return {dispose(){}};}
  async renameNode(uid:string,name:string){const old=this.nodes.get(uid);if([...this.nodes.values()].some(n=>n.uid!==uid && n.parentUid===old.parentUid && n.name.value===name))throw new Error('collision');const n={...old,name:{ok:true,value:name}};this.nodes.set(uid,n);return n;}
  async *moveNodes(uids:string[],parentUid:string){for(const uid of uids){const n={...this.nodes.get(uid),parentUid};this.nodes.set(uid,n);yield {ok:true,uid};}}
  async *trashNodes(uids:string[]){const remove=(uid:string)=>{for(const n of [...this.nodes.values()])if(n.parentUid===uid)remove(n.uid);this.trashed.set(uid,this.nodes.get(uid));this.nodes.delete(uid);};for(const uid of uids){remove(uid);yield{ok:true,uid};}}
  async getFileUploader(parentUid:string,name:string,metadata:any){return this.uploader(parentUid,name,metadata);}
  async getFileRevisionUploader(uid:string,metadata:any){const n=this.nodes.get(uid);return this.uploader(n.parentUid,n.name.value,metadata,uid);}
  uploader(parentUid:string,name:string,metadata:any,uid=crypto.randomUUID()){
    return {uploadFromStream:async(stream:any)=>{const bytes=new Uint8Array(await new Response(stream).arrayBuffer());const sha=createHash('sha1').update(bytes).digest('hex');expect(sha).toBe(metadata.expectedSha1);this.nodes.set(uid,{uid,parentUid,type:'file',name:{ok:true,value:name},mediaType:'text/plain',activeRevision:{uid:crypto.randomUUID(),claimedDigests:{sha1:sha}}});this.data.set(uid,bytes);this.uploads++;return {completion:async()=>({nodeUid:uid})};}};
  }
  async getFileDownloader(uid:string){return {downloadToStream:(stream:any)=>({completion:async()=>{const wr=stream.getWriter();await wr.write(this.data.get(uid));await wr.close();this.downloads++;}})};}
  async addFile(parentUid:string,name:string,text:string){const bytes=new TextEncoder().encode(text);const up=this.uploader(parentUid,name,{expectedSha1:createHash('sha1').update(bytes).digest('hex')});return (await up.uploadFromStream(new Blob([bytes]).stream())).completion();}
}
test('folder engine uploads, downloads, updates and sends local deletions to remote trash',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'nube-test-'));const local=path.join(temp,'local');const state=path.join(temp,'state');await mkdir(local);await mkdir(state);
  const sdk=new FakeSDK();const remote=await sdk.getMyFilesRootFolder();
  await sdk.createFolder(remote.uid,'vacia-remota');await mkdir(path.join(local,'vacia-local'));await sdk.addFile(remote.uid,'remoto.txt','desde la nube');await writeFile(path.join(local,'local.txt'),'desde local');
  const engine=new FolderSync(sdk,state,local);
  try {
    await engine.start();expect([...sdk.nodes.values()].some(n=>n.name.ok && n.name.value==='ProtonDrive')).toBe(false);expect(await readFile(path.join(local,'remoto.txt'),'utf8')).toBe('desde la nube');
    await expect((await import('node:fs/promises')).stat(path.join(local,'vacia-remota'))).resolves.toBeDefined();expect([...sdk.nodes.values()].some(n=>n.name.value==='vacia-local')).toBe(true);
    const uploaded=[...sdk.nodes.values()].find(n=>n.name.value==='local.txt');expect(new TextDecoder().decode(sdk.data.get(uploaded.uid))).toBe('desde local');
    await writeFile(path.join(local,'local.txt'),'editado');await engine.now();expect(new TextDecoder().decode(sdk.data.get(uploaded.uid))).toBe('editado');
    await rm(path.join(local,'local.txt'));await engine.now();expect(sdk.nodes.has(uploaded.uid)).toBe(false);expect(sdk.trashed.has(uploaded.uid)).toBe(true);
  }finally{await engine.stop();await rm(temp,{recursive:true,force:true});}
});
test('scanner ignores hidden files and symlinks',async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'nube-scan-'));
 try{await writeFile(path.join(temp,'ok.txt'),'ok');await writeFile(path.join(temp,'.secret'),'secret');await symlink('/etc/passwd',path.join(temp,'link'));expect(Object.keys(await scanLocal(temp))).toEqual(['ok.txt']);}finally{await rm(temp,{recursive:true,force:true});}
});
test('pause during first inventory stays paused and does not re-enable startup',async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'nube-pause-'));const local=path.join(temp,'local');const state=path.join(temp,'state');await mkdir(local);await mkdir(state);
 const sdk=new FakeSDK();const original=sdk.iterateFolderChildren.bind(sdk);
 let release:any,entered:any;const gate=new Promise<void>(r=>release=r);const ready=new Promise<void>(r=>entered=r);
 sdk.iterateFolderChildren=async function*(uid:string){entered();await gate;yield* original(uid);};
 const engine=new FolderSync(sdk,state,local);
 try{const start=engine.start();await ready;await engine.stop();release();await start;expect(engine.active).toBe(false);expect(JSON.parse(await readFile(path.join(state,'sync-enabled.json'),'utf8')).enabled).toBe(false);}finally{release();await engine.stop();await rm(temp,{recursive:true,force:true});}
});

export async function fixture() {
 const temp=await mkdtemp(path.join(os.tmpdir(),'proton-bidir-'));const local=path.join(temp,'local'),state=path.join(temp,'state'),trash=path.join(temp,'trash');
 await mkdir(local);await mkdir(state);await mkdir(trash);const sdk=new FakeSDK();
 const engine=new FolderSync(sdk,state,local,{trashLocal:async(filename)=>{await rename(filename,path.join(trash,path.basename(filename)));}});
 const node=(name:string)=>[...sdk.nodes.values()].find(n=>n.name.value===name);
 const event=async(uid:string,deleted=false)=>{await sdk.callback({type:deleted?'node_deleted':'node_updated',nodeUid:uid});await engine.now();};
 return {temp,local,state,trash,sdk,engine,node,event,close:async()=>{await engine.stop();await rm(temp,{recursive:true,force:true});}};
}
test('file rename locally and move remotely preserve identity and content',async()=>{
 const f=await fixture();try{
  await writeFile(path.join(f.local,'antes.txt'),'original');await f.engine.start();const uid=f.node('antes.txt').uid;const uploads=f.sdk.uploads;
  await rename(path.join(f.local,'antes.txt'),path.join(f.local,'despues.txt'));await f.engine.now();expect(f.node('despues.txt').uid).toBe(uid);expect(f.sdk.uploads).toBe(uploads);
  const folder=await f.sdk.createFolder('root','organizada');await f.event(folder.uid);for await(const _ of f.sdk.moveNodes([uid],folder.uid)){}await f.event(uid);
  expect(await readFile(path.join(f.local,'organizada/despues.txt'),'utf8')).toBe('original');expect(await lstat(path.join(f.local,'despues.txt')).catch(()=>null)).toBeNull();
 }finally{await f.close();}
});
test('directory renames in both directions move the tree without reuploading files',async()=>{
 const f=await fixture();try{
  await mkdir(path.join(f.local,'carpeta'));await writeFile(path.join(f.local,'carpeta/a.txt'),'a');await mkdir(path.join(f.local,'carpeta/vacia'));await f.engine.start();const uid=f.node('carpeta').uid;const uploads=f.sdk.uploads;
  await rename(path.join(f.local,'carpeta'),path.join(f.local,'renombrada'));await f.engine.now();expect(f.node('renombrada').uid).toBe(uid);expect(f.sdk.uploads).toBe(uploads);
  await f.sdk.renameNode(uid,'desde-nube');await f.event(uid);expect(await readFile(path.join(f.local,'desde-nube/a.txt'),'utf8')).toBe('a');expect((await lstat(path.join(f.local,'desde-nube/vacia'))).isDirectory()).toBe(true);
 }finally{await f.close();}
});
test('remote file deletion goes to local trash',async()=>{
 const f=await fixture();try{
  const {nodeUid}=await f.sdk.addFile('root','archivo.txt','conservar');await f.engine.start();for await(const _ of f.sdk.trashNodes([nodeUid])){}await f.event(nodeUid,true);
  expect(await lstat(path.join(f.local,'archivo.txt')).catch(()=>null)).toBeNull();expect(await readFile(path.join(f.trash,'archivo.txt'),'utf8')).toBe('conservar');
 }finally{await f.close();}
});
test('local folder deletion trashes remote subtree and does not recreate local folder',async()=>{
 const f=await fixture();try{
  await mkdir(path.join(f.local,'borrar'));await writeFile(path.join(f.local,'borrar/a.txt'),'a');await f.engine.start();const uid=f.node('borrar').uid;
  await rm(path.join(f.local,'borrar'),{recursive:true});await f.engine.now();expect(f.sdk.trashed.has(uid)).toBe(true);expect(await lstat(path.join(f.local,'borrar')).catch(()=>null)).toBeNull();
 }finally{await f.close();}
});
test('remote folder deletion sends local subtree to trash',async()=>{
 const f=await fixture();try{
  const folder=await f.sdk.createFolder('root','borrar');await f.sdk.addFile(folder.uid,'a.txt','a');await f.engine.start();for await(const _ of f.sdk.trashNodes([folder.uid])){}await f.event(folder.uid,true);
  expect(await lstat(path.join(f.local,'borrar')).catch(()=>null)).toBeNull();expect(await readFile(path.join(f.trash,'borrar/a.txt'),'utf8')).toBe('a');
 }finally{await f.close();}
});
test('folder deletion versus a new remote child stays conflicted without deleting it',async()=>{
 const f=await fixture();try{
  await mkdir(path.join(f.local,'conflicto'));await writeFile(path.join(f.local,'conflicto/a.txt'),'a');await f.engine.start();const folder=f.node('conflicto');
  await rm(path.join(f.local,'conflicto'),{recursive:true});const {nodeUid}=await f.sdk.addFile(folder.uid,'nuevo.txt','nuevo');await f.event(nodeUid);
  expect(f.sdk.nodes.has(folder.uid)).toBe(true);expect(f.sdk.nodes.has(nodeUid)).toBe(true);expect(await lstat(path.join(f.local,'conflicto')).catch(()=>null)).toBeNull();expect(f.engine.status).toContain('pendientes: 1');
 }finally{await f.close();}
});
test('remote deletion versus local edits preserves local content as a conflict',async()=>{
 const f=await fixture();try{
  const folder=await f.sdk.createFolder('root','conflicto');await f.sdk.addFile(folder.uid,'a.txt','a');await f.engine.start();await writeFile(path.join(f.local,'conflicto/a.txt'),'editado');for await(const _ of f.sdk.trashNodes([folder.uid])){}await f.event(folder.uid,true);
  expect(await readFile(path.join(f.local,'conflicto/a.txt'),'utf8')).toBe('editado');expect(f.engine.status).toContain('pendientes: 1');
 }finally{await f.close();}
});
test('identities survive a restart and local rename is still recognized',async()=>{
 const f=await fixture();let second:any;try{
  await writeFile(path.join(f.local,'uno.txt'),'uno');await f.engine.start();const uid=f.node('uno.txt').uid;await f.engine.stop();await rename(path.join(f.local,'uno.txt'),path.join(f.local,'dos.txt'));
  second=new FolderSync(f.sdk,f.state,f.local);await second.start();expect(f.node('dos.txt').uid).toBe(uid);
 }finally{if(second)await second.stop();await f.close();}
});
