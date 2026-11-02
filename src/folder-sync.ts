import {limitedReadable,limitedWritable} from './preferences';
import { watch, createReadStream, createWriteStream } from 'node:fs';
import { readdir, lstat, mkdir, readFile, writeFile, rename, unlink, link, statfs, open, copyFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';
import { planSync } from './planner.js';
import { trashRecoverably } from './local-trash';
import { SyncState } from './sync-state';
import { errorDetails } from './sync-errors';

export const LOCAL_ROOT = path.join(homedir(), 'ProtonDrive');
const ignored = (name: string) => name.startsWith('.') || name.includes('.nube-conflicto-');
function segment(name: string) {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new Error('Nombre remoto no seguro');
  return name;
}
async function digest(filename: string) {
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export async function scanLocal(root: string, directories: string[] = [], identities: Record<string,string> = Object.create(null), cache?:Map<string,{key:string,hash:string}>, metadata:Record<string,any>=Object.create(null), excluded:Set<string>=new Set(), omit:(relative:string)=>boolean=()=>false): Promise<Record<string,string>> {
  const result: Record<string,string> = Object.create(null);
  async function scan(relative: string) {
    const dir = path.join(root, relative);
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Carpeta local no segura');
    for (const entry of await readdir(dir, {withFileTypes:true})) {
      const rel = relative ? relative+'/'+entry.name : entry.name;
      if (ignored(entry.name) || omit(rel) || entry.isSymbolicLink()){excluded.add(rel);continue;}
      const info=await lstat(path.join(root,rel),{bigint:true});
      if(info.isSymbolicLink()){excluded.add(rel);continue;}
      identities[rel]=`${info.dev}:${info.ino}`;metadata[rel]={size:Number(info.size),modifiedAt:new Date(Number(info.mtimeNs/1000000n)).toISOString()};
      if (entry.isDirectory()) {directories.push(rel);await scan(rel);}
      else if (entry.isFile()) {const key=`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;const saved=cache?.get(rel);const hash=saved?.key===key?saved.hash:await digest(path.join(root,rel));result[rel]=hash;cache?.set(rel,{key,hash});}
    }
  }
  await scan('');
  return result;
}

export class FolderSync {
  active = false;
  status = 'Sincronización detenida';
  lastError:any=null;
  progress:any={phase:'paused',path:null,bytes:0,totalBytes:null,speed:0,eta:null,completed:0,total:0};
  recovery:any={interruptedOperations:0,lastRecoveredAt:null};
  indexMode='sin índice';
  nextRetryAt:string|null=null;
  private store:SyncState|null=null;
  private eventCursor:string|undefined;
  private scanComplete=false;
  private nodeDirty=new Set<string>();
  private verifiedDigests:Record<string,{revision:string,hash:string}>=Object.create(null);
  private abort=new AbortController();
  private currentJournal:string|null=null;
  private conflicts=new Map<string,any>();
  private detectedConflicts=new Map<string,any>();
  private transferStart=0;
  private recoveryUploads=new Map<string,string>();
  private root: any;
  private nodes = new Map<string, any>();
  private baseline: Record<string,string> = Object.create(null);
  private records: Record<string,any> = Object.create(null);
  private ready=false;
  private hashCache=new Map<string,{key:string,hash:string}>();
  private syncScheduled=false;
  private reschedule=false;
  private subscription: any;
  private watcher: any;
  private timer: any;
  private retry: any;
  private backoff = 5000;
  private startEpoch=0;
  private summary:any={pendingCount:null,pendingPaths:[],lastCheckedAt:null,lastCompletedAt:null,lastTransferAt:null,knownFiles:0};
  private pendingPaths:Set<string>|null=null;
  private queue = Promise.resolve();
  constructor(private sdk: any, private dataRoot: string, private localRoot=LOCAL_ROOT, private options: {remoteRootUid?:string, trashLocal?:(filename:string)=>Promise<void>, resetRemoteCache?:()=>Promise<void>, freeBytes?:()=>Promise<number>, retryDelay?:number,uploadKiB?:number,downloadKiB?:number,exclusions?:string[],beforeOperation?:()=>Promise<void>,massDeleteLimit?:number,review?:(snapshot:any)=>Promise<boolean>,batchLimit?:number,onOperationDone?:(kind:string,bytes:number,relative:string)=>void,onEvent?:(event:any)=>void} = {}) {}
  private recordHistory(kind:string,relative:string,result:string,detail=''){const time=new Date().toISOString();this.store?.history(kind,relative,result,detail,time);this.options.onEvent?.({time,kind,path:relative,result,detail});}
  async prepareView(){try{await this.ensureStore();const saved=this.store!.meta('snapshot');if(saved?.localRoot===this.localRoot&&saved.summary)this.summary={...this.summary,...saved.summary};}catch(e){this.handleError(e);}}
  private excluded(relative:string){return (this.options.exclusions??[]).some(p=>relative===p||relative.startsWith(p+'/'));}
  private protectedPath(relative:string){return (this.options.exclusions??[]).some(p=>relative===p||relative.startsWith(p+'/')||p.startsWith(relative+'/'));}
  async suspend(){await this.stop(false);await this.queue;}
  async dispose(){await this.stop(false);await this.queue;await this.persistBaseline();this.store?.close();this.store=null;}
  private enqueue(task: ()=>Promise<void>) {
    this.queue=this.queue.then(task).catch(error=>this.handleError(error));return this.queue;
  }
  private handleError(error:any) {
    const detail=errorDetails(error);
    if(detail.kind==='cancelled' && !this.active)return;
    this.lastError={...detail,time:new Date().toISOString(),path:this.progress.path};
    this.status=detail.message;this.progress.phase=detail.retryable?'waiting':'error';
    try{this.recordHistory('error',this.progress.path??'',detail.kind,detail.message);}catch{}
    if(detail.kind==='index'){this.active=false;this.abort.abort();this.subscription?.dispose();this.watcher?.close();}
    if(this.active && detail.retryable && !this.retry) {
      const delay=this.options.retryDelay??this.backoff;
      this.nextRetryAt=new Date(Date.now()+delay).toISOString();
      this.retry=setTimeout(()=>{this.retry=null;this.nextRetryAt=null;void this.now();},delay);
      this.backoff=Math.min(this.backoff*2,300000);
    }
  }
  private putNode(uid:string,node:any){this.nodes.set(uid,node);this.nodeDirty.add(uid);}
  private clearNodes(){for(const uid of this.nodes.keys())this.nodeDirty.add(uid);this.nodes.clear();}
  private hashFor(node:any){const known=this.verifiedDigests[node.uid];return node.activeRevision?.claimedDigests?.sha1??(known && known.revision===node.activeRevision?.uid?known.hash:undefined)??'unknown:'+node.activeRevision?.uid;}
  view(){let history:any[]=[];try{history=this.store?.historyList()??[];}catch(error){this.handleError(Object.assign(new Error('Índice no disponible',{cause:error}),{code:'STATE_CORRUPT'}));}return {recovery:this.recovery,summary:{...this.summary,pendingCount:this.pendingPaths?this.pendingPaths.size:this.summary.pendingCount,pendingPaths:this.pendingPaths?[...this.pendingPaths].slice(0,50):this.summary.pendingPaths},progress:this.progress,error:this.lastError,nextRetryAt:this.nextRetryAt,indexMode:this.indexMode,conflictCount:this.conflicts.size,conflicts:[...this.conflicts.values()].slice(0,100),history,baselineReady:this.ready};}
  private async ensureStore(){
    if(this.store)return;
    await mkdir(this.dataRoot,{recursive:true,mode:0o700});
    try{this.store=new SyncState(this.dataRoot);for(const c of this.store.conflicts())this.conflicts.set(c.id,c);}
    catch(error){throw Object.assign(new Error('No se puede abrir el índice local',{cause:error}),{code:'STATE_CORRUPT'});}
  }
  async start(){try{return await this.startInternal();}catch(error){this.handleError(error);throw error;}}
  private async startInternal() {
    if(this.active)return;const epoch=++this.startEpoch;await this.queue;if(epoch!==this.startEpoch||this.active)return;
    this.abort=new AbortController();await this.ensureStore();
    await mkdir(this.localRoot,{recursive:true});
    this.root=this.options.remoteRootUid?await this.sdk.getNode(this.options.remoteRootUid):await this.sdk.getMyFilesRootFolder();
    this.baseline=Object.create(null);this.records=Object.create(null);this.ready=false;this.clearNodes();this.putNode(this.root.uid,this.root);
    let saved:any;
    try{saved=this.store!.load();}catch(error){throw Object.assign(new Error('Índice ilegible',{cause:error}),{code:'STATE_CORRUPT'});}
    const matches=saved?.remoteUid===this.root.uid && saved?.localRoot===this.localRoot;
    if(!matches && saved?.nodes)for(const node of saved.nodes)this.nodeDirty.add(node.uid);
    if(matches){
      if(saved.summary)this.summary={...this.summary,...saved.summary};
      for(const [name,entry] of Object.entries(saved.entries) as any[]){if(entry.hash)this.baseline[name]=entry.hash;if(entry.record)this.records[name]=entry.record;if(entry.localCache?.key&&entry.localCache?.hash)this.hashCache.set(name,entry.localCache);}
      this.ready=!!saved.ready;this.eventCursor=saved.eventCursor;this.scanComplete=!!saved.scanComplete;
      this.verifiedDigests=saved.verifiedDigests??Object.create(null);
      for(const node of saved.nodes)this.putNode(node.uid,node);
      if(!this.nodes.has(this.root.uid) || [...this.nodes.values()].some(n=>n.uid!==this.root.uid && !this.nodes.has(n.parentUid))){this.scanComplete=false;this.eventCursor=undefined;}
    }else{
      this.eventCursor=undefined;this.scanComplete=false;
      try{const legacy=JSON.parse(await readFile(path.join(this.dataRoot,'folder-baseline.json'),'utf8'));if(legacy.remoteUid===this.root.uid && legacy.localRoot===this.localRoot){this.baseline=Object.assign(Object.create(null),legacy.hashes);this.records=Object.assign(Object.create(null),legacy.records??{});this.ready=!!legacy.ready;}}
      catch(error:any){if(error.code!=='ENOENT')throw Object.assign(new Error('Índice anterior ilegible',{cause:error}),{code:'STATE_CORRUPT'});}
    }
    if(epoch!==this.startEpoch)return;
    // Clean only temporary files explicitly registered by our interrupted operations.
    const interrupted=this.store!.pending();this.recovery.interruptedOperations=interrupted.length;
    for(const operation of interrupted){
      if(operation.kind==='upload' && operation.payload.hash)this.recoveryUploads.set(operation.path,operation.payload.hash);
      if(operation.kind==='backup' && typeof operation.payload.backup==='string' && operation.payload.backup.startsWith(this.localRoot+path.sep) && path.basename(operation.payload.backup).startsWith('.nube-conflicto-')){
        try{const checked=await this.safeLocal(path.relative(this.localRoot,operation.payload.backup));if(checked.exists && await digest(checked.target)===operation.payload.hash){await(this.options.trashLocal?this.options.trashLocal(checked.target):trashRecoverably(checked.target));this.recordHistory('recuperación',operation.path,'correcto','La copia anterior se ha conservado en la papelera.');}}catch{this.recordHistory('recuperación',operation.path,'aviso','La copia anterior se conserva para revisión.');}
      }
      const temp=operation.payload.temp;
      if(typeof temp==='string' && temp.startsWith(this.localRoot+path.sep) && path.basename(temp).startsWith('.nube-part-')){try{const checked=await this.safeLocal(path.relative(this.localRoot,temp));if(checked.exists)await unlink(checked.target);}catch{this.recordHistory('recuperación',operation.path,'aviso','El temporal no se elimina porque su ruta ha cambiado.');}}
      this.recordHistory('recuperación',operation.path,'interrumpida','Se volverá a comparar el archivo antes de continuar.');this.store!.end(operation.id,'interrupted');
    }
    if(interrupted.length)this.recovery.lastRecoveredAt=new Date().toISOString();
    for(const name of new Set([...Object.keys(this.records),...Object.keys(this.baseline)]))if(this.excluded(name))this.forget(name);
    this.active=true;this.lastError=null;this.progress.phase='indexing';
    try{
      await this.enqueue(async()=>{
        if(this.scanComplete && this.eventCursor && typeof this.sdk.iterateEvents==='function'){
          this.indexMode='eventos guardados';await this.refreshEvents();
        }else await this.fullIndex();
        if(this.active)await this.reconcile();
      });
      if(!this.active)return;
      if(typeof this.sdk.iterateEvents==='function'){
        // Poll the SDK event stream at its normal foreground cadence. A
        // completion-driven timer cannot leave duplicate loops after pause.
        let disposed=false,timer:ReturnType<typeof setTimeout>;
        const scheduleEvents=()=>{if(disposed)return;timer=setTimeout(async()=>{if(disposed||!this.active)return;if(this.retry || (this.lastError&&!this.lastError.retryable)){scheduleEvents();return;}await this.enqueue(async()=>{if(!this.scanComplete)await this.fullIndex();else await this.refreshEvents();await this.reconcile();});if(!disposed)scheduleEvents();},30000+Math.random()*1000);};
        scheduleEvents();this.subscription={dispose:()=>{disposed=true;clearTimeout(timer);}};
      }else{
        this.subscription=await this.sdk.subscribeToTreeEvents(this.root.treeEventScopeId,(event:any)=>this.enqueue(async()=>{await this.applyEvent(event);await this.persistBaseline();this.schedule();}));
      }
      this.watcher=watch(this.localRoot,{recursive:true},(_,filename)=>{if(!filename)this.hashCache.clear();else for(const key of this.hashCache.keys())if(this.under(key,String(filename)))this.hashCache.delete(key);this.schedule();});
      this.watcher.on('error',(e:any)=>this.handleError(e));
      await writeFile(path.join(this.dataRoot,'sync-enabled.json'),JSON.stringify({enabled:true}),{mode:0o600});
    }catch(error){await this.stop(false);throw error;}
  }
  private async fullIndex(){
    this.indexMode='revisión completa';this.progress.phase='indexing';this.status='Examinando Mis archivos por primera vez o reconstruyendo el índice…';
    this.scanComplete=false;
    if(this.options.resetRemoteCache)await this.options.resetRemoteCache();
    this.root=this.options.remoteRootUid?await this.sdk.getNode(this.options.remoteRootUid):await this.sdk.getMyFilesRootFolder();
    this.clearNodes();this.putNode(this.root.uid,this.root);
    this.eventCursor=undefined;
    if(typeof this.sdk.iterateEvents==='function')for await(const e of this.sdk.iterateEvents(this.root.treeEventScopeId,undefined,this.abort.signal))this.eventCursor=e.eventId;
    await this.walkRemote(this.root);
    if(!this.active)return;
    this.scanComplete=true;
    if(this.eventCursor)await this.refreshEvents(true);
    await this.persistBaseline();
  }
  private async applyEvent(event:any){
    if(!this.active)return;
    if(event.type==='tree_remove' || (event.nodeUid===this.root.uid && (event.type==='node_deleted'||event.isTrashed))){await this.stop();this.status='Carpeta remota no disponible';return;}
    if(event.type==='tree_refresh'){await this.fullIndex();return;}
    if(event.nodeUid && event.nodeUid!==this.root.uid){
      if(event.type==='node_deleted'||event.isTrashed)this.removeNode(event.nodeUid);
      else{let node:any;try{node=await this.sdk.getNode(event.nodeUid);}catch(error){if(errorDetails(error).status===404){this.removeNode(event.nodeUid);return;}throw error;}if(this.nodes.has(node.parentUid)){const old=this.nodes.get(node.uid),isNew=!old;this.putNode(node.uid,node);if((isNew||!old.name.ok) && node.type==='folder')await this.walkRemote(node);}else this.removeNode(node.uid);}
    }
  }
  private async refreshEvents(fromFull=false){
    if(!this.active || typeof this.sdk.iterateEvents!=='function' || !this.eventCursor)return;
    const previous=this.eventCursor;let next=previous;
    try{
      for await(const event of this.sdk.iterateEvents(this.root.treeEventScopeId,previous,this.abort.signal)){
        if(event.type==='tree_refresh'){if(fromFull)throw Object.assign(new Error('El servidor requiere repetir el índice'),{code:'CHANGED'});await this.fullIndex();return;}
        if(!this.active)throw new DOMException('paused','AbortError');
        await this.applyEvent(event);if(!this.active)throw new DOMException('paused','AbortError');next=event.eventId??next;
      }
      this.eventCursor=next;await this.persistBaseline();
    }catch(error:any){const d=errorDetails(error);if(!fromFull && (d.status===410 || d.status===422)){await this.fullIndex();return;}throw error;}
  }
  private removeNode(uid:string) {
    for(const n of [...this.nodes.values()]) if(n.parentUid===uid) this.removeNode(n.uid);
    this.nodes.delete(uid);this.nodeDirty.add(uid);
  }
  private async walkRemote(parent:any) {
    this.progress={...this.progress,phase:'indexing',path:this.relative(parent)||'Mis archivos'};
    for await(const node of this.sdk.iterateFolderChildren(parent.uid)) {
      if(!this.active) return;
      if(!node.name.ok || ignored(node.name.value)){this.putNode(node.uid,node);continue;}
      segment(node.name.value);
      this.putNode(node.uid,node);
      this.status=`Sincronizando: examinados ${this.nodes.size-1} elementos de Mis archivos…`;
      if(node.type==='folder') await this.walkRemote(node);
    }
  }
  private relative(node:any): string | null {
    if(node.uid===this.root.uid) return '';
    const parts=[]; const seen=new Set();
    while(node && node.uid!==this.root.uid) {
      if(seen.has(node.uid) || !node.name.ok || ignored(node.name.value)) return null;
      seen.add(node.uid);parts.unshift(segment(node.name.value));node=this.nodes.get(node.parentUid);
    }
    return node ? parts.join('/') : null;
  }
  private schedule() {
    if(!this.active || this.retry || (this.lastError&&!this.lastError.retryable)) return;
    clearTimeout(this.timer);
    this.timer=setTimeout(()=>{if(this.syncScheduled){this.reschedule=true;return;}this.syncScheduled=true;void this.enqueue(async()=>{await this.refreshEvents();await this.reconcile();}).finally(()=>{this.syncScheduled=false;if(this.reschedule){this.reschedule=false;this.schedule();}});},800);
  }
  async now() { if(!this.active)return this.start();clearTimeout(this.retry);this.retry=null;this.nextRetryAt=null;await this.enqueue(async()=>{if(!this.scanComplete)await this.fullIndex();else await this.refreshEvents();await this.reconcile();}); }
  private async safeLocal(relative:string, createParents=false, kind:'file'|'folder'='file') {
    const parts=relative.split('/').map(segment); let dir=this.localRoot;
    const rootStat=await lstat(dir);
    if(!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Raíz local no segura');
    for(const p of parts.slice(0,-1)) {
      dir=path.join(dir,p);
      if(createParents) await mkdir(dir).catch((e:any)=>{if(e.code!=='EEXIST') throw e;});
      const st=await lstat(dir);
      if(st.isSymbolicLink() || !st.isDirectory()) throw new Error('Ruta local no segura');
    }
    const target=path.join(this.localRoot,...parts);
    const st=await lstat(target,{bigint:true}).catch((e:any)=>{if(e.code==='ENOENT') return null;throw e;});
    if(st && (st.isSymbolicLink() || (kind==='file' ? !st.isFile() : !st.isDirectory()))) throw new Error('Destino no seguro');
    return {target,exists:!!st,identity:st?`${st.dev}:${st.ino}`:null};
  }
  private updateBytes(bytes:number,total:number|null){
    const seconds=Math.max((performance.now()-this.transferStart)/1000,0.05),speed=bytes/seconds;
    this.progress={...this.progress,bytes,totalBytes:total,speed,eta:total!==null&&speed>0?Math.max(0,(total-bytes)/speed):null};
  }
  private async operation<T>(kind:string,relative:string,work:(id:string)=>Promise<T>,payload:any={}):Promise<T>{
    await this.options.beforeOperation?.();await this.ensureStore();const id=this.store!.begin(kind,relative,payload);this.currentJournal=id;this.transferStart=performance.now();
    this.progress={...this.progress,phase:kind,path:relative,bytes:0,totalBytes:null,speed:0,eta:null};
    try{const result=await work(id);this.store!.end(id);this.recordHistory(kind,relative,'correcto',payload.destination?'Destino: '+payload.destination:'');this.lastError=null;this.summary.lastTransferAt=new Date().toISOString();this.options.onOperationDone?.(kind,this.progress.bytes??0,relative);return result;}
    catch(error){const d=errorDetails(error);this.recordHistory(kind,relative,'fallo',d.message);throw error;}
    finally{this.currentJournal=null;}
  }
  private async syncDirectory(dir:string){const fd=await open(dir,'r');try{await fd.sync();}catch(e:any){if(!['EINVAL','ENOTSUP'].includes(e.code))throw e;}finally{await fd.close();}}
  private async download(node:any,relative:string,expected:string|null){
    const {target}=await this.safeLocal(relative,true);
    const temp=path.join(path.dirname(target),'.nube-part-'+randomBytes(12).toString('hex'));
    const payload={temp,remoteUid:node.uid,revision:node.activeRevision?.uid,expected};
    return this.operation('download',relative,async()=>{
      let stream:ReturnType<typeof createWriteStream>|undefined;
      try{
        const downloader=node.activeRevision?.uid && typeof this.sdk.getFileRevisionDownloader==='function'?await this.sdk.getFileRevisionDownloader(node.activeRevision.uid,this.abort.signal):await this.sdk.getFileDownloader(node.uid,this.abort.signal);
        const size=downloader.getClaimedSizeInBytes?.()??node.activeRevision?.claimedSize??null;
        if(size!==null){const fs=await statfs(path.dirname(target));const available=this.options.freeBytes?await this.options.freeBytes():Number(fs.bavail)*Number(fs.bsize);if(size>available)throw Object.assign(new Error('Espacio insuficiente'),{code:'ENOSPC'});}
        this.updateBytes(0,size);
        stream=createWriteStream(temp,{flags:'wx',mode:0o600});
        await once(stream,'open');
        const completion=downloader.downloadToStream(limitedWritable(Writable.toWeb(stream) as WritableStream<Uint8Array>,this.options.downloadKiB??0,this.abort.signal),(bytes:number)=>this.updateBytes(bytes,size));
        await completion.completion();
        const sha=await digest(temp),claimed=node.activeRevision?.claimedDigests?.sha1;
        if(claimed && claimed!==sha)throw Object.assign(new Error('Integridad incorrecta'),{code:'INTEGRITY'});
        const fd=await open(temp,'r');try{await fd.sync();}finally{await fd.close();}
        const current=await this.safeLocal(relative);
        if(expected===null){await link(temp,target);await unlink(temp);}
        else{if(!current.exists || await digest(target)!==expected)throw Object.assign(new Error('Archivo modificado durante la descarga'),{code:'CHANGED'});await rename(temp,target);}
        await this.syncDirectory(path.dirname(target));
        this.verifiedDigests[node.uid]={revision:node.activeRevision?.uid,hash:sha};this.nodeDirty.add(node.uid);
        this.baseline[relative]=sha;await this.persistBaseline();
        return sha;
      }finally{if(stream&&!stream.closed){const closed=new Promise<void>(resolve=>stream!.once('close',()=>resolve()));stream.destroy();await closed;}await unlink(temp).catch(()=>{});}
    },payload);
  }
  private async uploadFile(relative:string,hash:string,existing?:any){
    return this.operation('upload',relative,async()=>{
      const current=await this.safeLocal(relative);
      if(!current.exists || await digest(current.target)!==hash)throw Object.assign(new Error('Archivo modificado antes de la subida'),{code:'CHANGED'});
      const parent=await this.parentFor(relative),file=Bun.file(current.target);
      const metadata={mediaType:file.type||'application/octet-stream',expectedSize:file.size,expectedSha1:hash};
      if(existing){const fresh=await this.sdk.getNode(existing.uid);if(fresh.activeRevision?.uid!==existing.activeRevision?.uid)throw Object.assign(new Error('Archivo remoto modificado'),{code:'CHANGED'});}
      this.updateBytes(0,file.size);
      const uploader=existing?await this.sdk.getFileRevisionUploader(existing.uid,metadata,this.abort.signal):await this.sdk.getFileUploader(parent.uid,path.posix.basename(relative),metadata,this.abort.signal);
      const result=await(await uploader.uploadFromStream(limitedReadable(file.stream(),this.options.uploadKiB??0,this.abort.signal),[],(bytes:number)=>this.updateBytes(bytes,file.size))).completion();
      const fresh=await this.sdk.getNode(result.nodeUid);this.putNode(fresh.uid,fresh);
      this.verifiedDigests[fresh.uid]={revision:fresh.activeRevision?.uid,hash};this.baseline[relative]=hash;this.recoveryUploads.delete(relative);
      await this.persistBaseline();this.updateBytes(file.size,file.size);return fresh;
    },{hash,remoteUid:existing?.uid,revision:existing?.activeRevision?.uid});
  }
  private async parentFor(relative:string) {
    let node=this.root; let rel='';
    for(const part of relative.split('/').slice(0,-1)) {
      segment(part);rel=rel?rel+'/'+part:part;
      const found=[...this.nodes.values()].filter(n=>this.relative(n)===rel);
      if(found.length>1 || (found.length && found[0].type!=='folder')) throw new Error('Ruta remota ambigua');
      node=found[0] ?? await this.sdk.createFolder(node.uid,part);
      this.putNode(node.uid,node);
    }
    return node;
  }
  private remoteTree() {
    const result:Record<string,any>=Object.create(null);
    for(const node of this.nodes.values()) {
      const rel=this.relative(node);
      if(!rel || this.excluded(rel)) continue;
      if(result[rel]) throw new Error('Nombres remotos duplicados');
      result[rel]={kind:node.type,uid:node.uid,node,protected:!!node.protectedChildren,hash:this.hashFor(node),size:node.activeRevision?.claimedSize??null,modifiedAt:node.activeRevision?.claimedModificationTime??node.modificationTime??null};
    }
    return result;
  }
  private async localTree() {
    const directories:string[]=[],ids:Record<string,string>=Object.create(null),metadata:Record<string,any>=Object.create(null),excluded=new Set<string>();
    const hashes=await scanLocal(this.localRoot,directories,ids,this.hashCache,metadata,excluded,rel=>this.excluded(rel));
    const tree:Record<string,any>=Object.create(null);
    for(const rel of directories) tree[rel]={kind:'folder',id:ids[rel],...metadata[rel]};
    for(const [rel,hash] of Object.entries(hashes)) tree[rel]={kind:'file',id:ids[rel],hash,...metadata[rel]};
    return {tree,hashes,directories,excluded};
  }
  private under(name:string, prefix:string) {return name===prefix || name.startsWith(prefix+'/');}
  private forget(prefix:string) {
    for(const name of Object.keys(this.records)) if(this.under(name,prefix)) delete this.records[name];
    for(const name of Object.keys(this.baseline)) if(this.under(name,prefix)) delete this.baseline[name];
  }
  private rekey(oldPath:string,newPath:string) {
    for(const dictionary of [this.records,this.baseline]) {
      const moves=Object.keys(dictionary).filter(p=>this.under(p,oldPath)).map(p=>[p,newPath+p.slice(oldPath.length),dictionary[p]] as const);
      for(const [old] of moves) delete dictionary[old];
      for(const [,name,value] of moves) dictionary[name]=value;
    }
  }
  private unchanged(tree:Record<string,any>,prefix:string,remote:boolean) {
    for(const [rel,entry] of Object.entries(tree)) if(this.under(rel,prefix)) {
      const old=this.records[rel];
      if(!old || old.kind!==entry.kind) return false;
      if(remote && old.remoteUid!==entry.uid) return false;
      if(entry.kind==='file' && (!old.hash || old.hash!==entry.hash)) return false;
    }
    // Missing descendants are fine only if both sides are deleting the same tree;
    // new or edited descendants above always prevent a destructive resolution.
    return true;
  }
  private async trashLocal(relative:string,kind:'file'|'folder',expectedId?:string) {
    const current=await this.safeLocal(relative,false,kind);
    if(!current.exists) return;
    if(expectedId && current.identity!==expectedId) throw new Error('Ruta modificada antes de enviarla a la papelera');
    if(this.options.trashLocal) await this.options.trashLocal(current.target);
    else {
      await trashRecoverably(current.target);
    }
  }
  private async trashRemote(uid:string) {
    for await(const result of this.sdk.trashNodes([uid])) if(!result.ok) throw result.error;
    this.removeNode(uid);
  }
  private async verifyRemoteSubtree(uid:string,prefix:string):Promise<boolean> {
    if(this.nodes.get(uid)?.protectedChildren)return false;
    // A deliberate folder deletion checks its contents through the SDK so that
    // excluded/new children are not silently deleted with an already-known tree.
    for await(const child of this.sdk.iterateFolderChildren(uid)) {
      if(!child.name.ok || ignored(child.name.value) || this.protectedPath(prefix+'/'+child.name.value)) return false;
      const rel=prefix+'/'+segment(child.name.value),known=this.records[rel];
      if(!known || known.remoteUid!==child.uid) return false;
      if(child.type==='file' && child.activeRevision?.claimedDigests?.sha1!==known.hash) return false;
      if(child.type==='folder' && !await this.verifyRemoteSubtree(child.uid,rel)) return false;
    }
    return true;
  }
  private async moveRemote(node:any,destination:string) {
    const parent=await this.parentFor(destination),name=segment(path.posix.basename(destination));
    let current=node;
    const sameNameAtTarget=[...this.nodes.values()].some(n=>n.uid!==node.uid && n.parentUid===parent.uid && n.name.ok && n.name.value===node.name.value);
    const move=async()=>{for await(const result of this.sdk.moveNodes([current.uid],parent.uid))if(!result.ok)throw result.error;current={...current,parentUid:parent.uid};this.putNode(current.uid,current);};
    const renameNode=async()=>{current=await this.sdk.renameNode(current.uid,name);this.putNode(current.uid,current);};
    if(sameNameAtTarget && name!==node.name.value) {await renameNode();if(current.parentUid!==parent.uid)await move();}
    else {if(current.parentUid!==parent.uid)await move();if(!current.name.ok || current.name.value!==name)await renameNode();}
  }
  private async organize(blocked:Set<string>) {
    let changed=0;
    // Parent folders are handled before descendants; a folder move rekeys the
    // whole baseline and avoids uploading/downloading its children again.
    for(let pass=0;pass<10000;pass++) {
      if(!this.active)return changed;
      const local=await this.localTree(),remote=this.remoteTree();let again=false;
      const localById=new Map<string,string[]>(),remoteById=new Map<string,string>();
      for(const [p,e] of Object.entries(local.tree)){const key=e.kind+':'+e.id;localById.set(key,[...(localById.get(key)??[]),p]);}
      for(const [p,e] of Object.entries(remote))remoteById.set(e.uid,p);
      const names=Object.keys(this.records).sort((a,b)=>a.split('/').length-b.split('/').length || a.localeCompare(b));
      for(const oldPath of names) {
        if(this.protectedPath(oldPath))continue;
        if([...blocked].some(p=>this.under(oldPath,p))) continue;
        const old=this.records[oldPath];if(!old)continue;
        if((local.tree[oldPath]&&local.tree[oldPath].kind!==old.kind)||(remote[oldPath]&&remote[oldPath].kind!==old.kind)){blocked.add(oldPath);this.captureConflict(oldPath,'structure',local.tree[oldPath]?oldPath:undefined,remote[oldPath]?oldPath:undefined,'Un archivo y una carpeta ocupan el mismo nombre.',local.tree,remote);continue;}
        const localMatches=localById.get(old.kind+':'+old.localId)??[];
        const remoteMatch=remoteById.get(old.remoteUid);
        const lp=localMatches.length===1?localMatches[0]:(local.tree[oldPath]?.kind===old.kind?oldPath:undefined);
        const rp=remoteMatch??(remote[oldPath]?.kind===old.kind?oldPath:undefined);
        if(lp && rp) {
          if(lp===rp) {if(lp!==oldPath){this.rekey(oldPath,lp);again=true;break;}continue;}
          if(lp!==oldPath && rp!==oldPath) {blocked.add(oldPath);blocked.add(lp);blocked.add(rp);this.captureConflict(oldPath,'structure',lp,rp,'El mismo elemento se ha organizado de forma distinta.',local.tree,remote);continue;}
          const destination=lp!==oldPath?lp:rp;
          if(lp!==oldPath) {
            if(remote[destination] && remote[destination].uid!==old.remoteUid) {blocked.add(oldPath);blocked.add(destination);this.captureConflict(oldPath,'structure',lp,rp,'El destino contiene otro elemento.',local.tree,remote);continue;}
            await this.operation('move-remote',oldPath,()=>this.moveRemote(remote[rp].node,destination),{uid:remote[rp].uid,destination});
          } else {
            if(local.tree[destination]) {blocked.add(oldPath);blocked.add(destination);this.captureConflict(oldPath,'structure',lp,rp,'El destino contiene otro elemento.',local.tree,remote);continue;}
            const source=await this.safeLocal(lp,false,old.kind),target=await this.safeLocal(destination,true,old.kind);
            if(source.identity!==local.tree[lp].id || target.exists)throw new Error('Ruta modificada antes del movimiento');
            await this.operation('move-local',lp,async()=>{if(old.kind==='file'){await link(source.target,target.target);await unlink(source.target);}else await rename(source.target,target.target);},{destination,identity:source.identity});
          }
          this.rekey(oldPath,destination);await this.persistBaseline();changed++;again=true;break;
        }
        if(old.kind!=='folder') {
          if((lp && lp!==oldPath) || (rp && rp!==oldPath)) {blocked.add(oldPath);if(lp)blocked.add(lp);if(rp)blocked.add(rp);this.captureConflict(oldPath,'structure',lp,rp,'Un lado ha borrado el elemento y el otro lo ha movido.',local.tree,remote);}
          continue;
        }
        if(!lp && !rp){this.forget(oldPath);again=true;break;}
        if(!this.ready || (lp && lp!==oldPath) || (rp && rp!==oldPath)) {blocked.add(oldPath);if(lp)blocked.add(lp);if(rp)blocked.add(rp);if(this.ready)this.captureConflict(oldPath,'structure',lp,rp,'Borrado y organización simultáneos.',local.tree,remote);continue;}
        if(!lp && rp) {
          if(!this.unchanged(remote,rp,true) || !await this.verifyRemoteSubtree(remote[rp].uid,rp)){blocked.add(oldPath);this.captureConflict(oldPath,'structure',undefined,rp,'La carpeta se borró en local, pero cambió en la nube.',local.tree,remote);continue;}
          await this.operation('delete-remote',rp,()=>this.trashRemote(remote[rp].uid),{uid:remote[rp].uid});
        } else if(lp && !rp) {
          if([...local.excluded].some(p=>this.under(p,lp)) || !this.unchanged(local.tree,lp,false)){blocked.add(oldPath);this.captureConflict(oldPath,'structure',lp,undefined,'La carpeta se borró en la nube, pero cambió en local.',local.tree,remote);continue;}
          await this.operation('delete-local',lp,()=>this.trashLocal(lp,'folder',local.tree[lp].id));
        }
        this.forget(oldPath);await this.persistBaseline();changed++;again=true;break;
      }
      if(!again)return changed;
    }
    throw new Error('Demasiados cambios estructurales en una sola pasada');
  }
  private async reconcile() {
    if(!this.active || !this.scanComplete) return;
    this.detectedConflicts=new Map();this.progress={...this.progress,phase:'planning',path:null,completed:0,total:0};
    this.status=`Sincronizando ${this.localRoot}…`;this.pendingPaths=null;this.summary.pendingCount=null;
    const blocked=new Set<string>(this.options.exclusions??[]);
    let snapshot=await this.localTree();
    const initialRemote=this.remoteTree();
    for(const [rel,record] of Object.entries(this.records)) {
      if(this.excluded(rel))continue;
      const node=this.nodes.get(record.remoteUid);
      if([...snapshot.excluded].some(p=>this.under(rel,p)) || (node && (!this.relative(node) || node.mediaType?.includes('proton')))) {
        blocked.add(rel);this.captureConflict(rel,'unavailable',snapshot.tree[rel]?rel:undefined,undefined,'Este elemento no se puede leer o está excluido. No se aplicarán borrados.',snapshot.tree,initialRemote);
      }
    }
    if(this.options.review&&!await this.options.review({local:snapshot.tree,remote:initialRemote,baseline:this.baseline,records:this.records,excluded:[...snapshot.excluded,...blocked]})){this.progress={...this.progress,phase:'review',path:null};this.status='Vista previa lista. Revisa los cambios antes de aplicarlos.';return;}
    if(this.options.massDeleteLimit!==undefined){const localIds=new Set(Object.values(snapshot.tree).map((e:any)=>e.id)),remoteIds=new Set(Object.values(initialRemote).map((e:any)=>e.uid));const names=Object.keys(this.baseline);const deletions=names.filter(p=>!this.excluded(p)&&((!snapshot.tree[p]&&initialRemote[p]?.hash===this.baseline[p]&&!localIds.has(this.records[p]?.localId))||(!initialRemote[p]&&snapshot.tree[p]?.hash===this.baseline[p]&&!remoteIds.has(this.records[p]?.remoteUid)))).length;if(deletions>this.options.massDeleteLimit&&deletions>names.length*0.2)throw Object.assign(new Error('Se han detectado muchos borrados. Vuelve a comparar sin borrados anteriores para conservar ambas carpetas.'),{code:'MASS_DELETE'});}
    const organized=await this.organize(blocked);
    snapshot=await this.localTree();
    let directoryConflicts=0;
    const isBlocked=(rel:string)=>[...blocked].some(p=>this.under(rel,p));
    for(const rel of snapshot.directories) if(!isBlocked(rel)) {
      try {await this.parentFor(rel+'/placeholder');} catch(error) {if(errorDetails(error).kind!=='unknown')throw error;directoryConflicts++;blocked.add(rel);this.captureConflict(rel,'structure',snapshot.tree[rel]?rel:undefined,this.remoteTree()[rel]?rel:undefined,'No se puede combinar el archivo y la carpeta de ese destino.',snapshot.tree,this.remoteTree());}
    }
    for(const node of [...this.nodes.values()]) {
      const rel=this.relative(node);
      if(rel && node.type==='folder' && !isBlocked(rel)) {
        try {await this.safeLocal(rel+'/placeholder',true);} catch(error) {if(errorDetails(error).kind!=='unknown')throw error;directoryConflicts++;blocked.add(rel);this.captureConflict(rel,'structure',snapshot.tree[rel]?rel:undefined,this.remoteTree()[rel]?rel:undefined,'No se puede combinar el archivo y la carpeta de ese destino.',snapshot.tree,this.remoteTree());}
      }
    }
    snapshot=await this.localTree();const local=snapshot.hashes;
    const remote:Record<string,string>=Object.create(null);const entries=new Map<string,any>();
    for(const [rel,entry] of Object.entries(this.remoteTree())) {
      if(this.excluded(rel) || entry.kind!=='file' || entry.node.mediaType?.includes('proton')) continue;
      entries.set(rel,entry.node);if(entry.node.activeRevision || this.recoveryUploads.get(rel)!==local[rel])remote[rel]=entry.hash;
    }
    const actions=planSync(local,remote,this.baseline);
    this.pendingPaths=new Set([...actions.map((a:any)=>a.path),...[...this.detectedConflicts.values()].map(c=>c.path)]);
    this.progress={phase:'planning',path:null,bytes:0,totalBytes:null,speed:0,eta:null,completed:0,total:actions.length};
    let uploaded=0,downloaded=0,deleted=0,pending=directoryConflicts+blocked.size;
    await this.persistBaseline();let processed=0,executed=0,hasMore=false;
    for(const action of actions) {
      this.progress.completed=processed;
      this.status=`Sincronizando: ${++processed} de ${actions.length} operaciones`;
      if(!this.active) return;
      const rel=action.path;if(isBlocked(rel))continue;
      if(action.type==='conflict') {pending++;this.captureConflict(rel,'file',local[rel]!==undefined?rel:undefined,entries.has(rel)?rel:undefined,'Las dos versiones han cambiado o un borrado coincide con una edición.',snapshot.tree,this.remoteTree());continue;}
      if(executed>=(this.options.batchLimit??20)){hasMore=true;break;}executed++;
      if(action.type==='upload') {
        await this.uploadFile(rel,local[rel],entries.get(rel));uploaded++;
      } else if(action.type==='download') {
        this.baseline[rel]=await this.download(entries.get(rel),rel,local[rel]??null);downloaded++;
      } else if(action.type==='delete-local' || action.type==='delete-remote') {
        if(!this.ready){pending++;continue;}
        if(action.type==='delete-local') {
          const current=await this.safeLocal(rel);
          if(current.exists && await digest(current.target)!==this.baseline[rel]) {pending++;continue;}
          await this.operation('delete-local',rel,()=>this.trashLocal(rel,'file',snapshot.tree[rel]?.id));
        } else {
          const node=entries.get(rel),fresh=await this.sdk.getNode(node.uid);
          if(fresh.activeRevision?.uid!==node.activeRevision?.uid) {pending++;continue;}
          await this.operation('delete-remote',rel,()=>this.trashRemote(node.uid),{uid:node.uid});
        }
        this.forget(rel);await this.persistBaseline();deleted++;
      }
      this.pendingPaths.delete(rel);
      if(processed % 10 === 0) await this.persistBaseline();
    }
    // Record identities only for entries actually known to match on both sides.
    const finalLocal=await this.localTree(),finalRemote=this.remoteTree();
    for(const [rel,entry] of Object.entries(finalLocal.tree)) {
      const other=finalRemote[rel];if(!other || isBlocked(rel) || other.kind!==entry.kind)continue;
      if(entry.kind==='folder')this.records[rel]={kind:'folder',localId:entry.id,remoteUid:other.uid};
      else if(entry.hash===other.hash || (this.baseline[rel]===entry.hash && !remote[rel]?.startsWith('unknown:'))) {
        this.baseline[rel]=entry.hash;
        this.records[rel]={kind:'file',localId:entry.id,remoteUid:other.uid,hash:entry.hash};
      }
    }
    for(const rel of Object.keys(this.records))if(!finalLocal.tree[rel] && !finalRemote[rel])this.forget(rel);
    const wasReady=this.ready;this.ready=this.ready||!hasMore;
    if(!hasMore)this.conflicts=this.detectedConflicts;this.store?.saveConflicts([...this.conflicts.values()]);
    this.summary.lastCheckedAt=new Date().toISOString();this.summary.pendingCount=this.pendingPaths?.size??pending;this.summary.pendingPaths=[...(this.pendingPaths??[])].slice(0,50);this.summary.knownFiles=Object.entries(finalLocal.tree).filter(([p,e]:any)=>e.kind==='file'&&finalRemote[p]?.kind==='file'&&e.hash===finalRemote[p].hash).length;if(!hasMore&&this.ready&&this.summary.pendingCount===0)this.summary.lastCompletedAt=this.summary.lastCheckedAt;
    await this.persistBaseline();this.backoff=5000;this.lastError=null;this.nextRetryAt=null;this.progress={...this.progress,path:null,completed:hasMore?processed-1:actions.length,phase:hasMore?'planning':'idle'};
    this.status=`Sincronización activa\nLocal: ${this.localRoot}\nNube: Mis archivos (raíz)\nÚltima revisión: ${new Date().toLocaleTimeString('es-ES')}\nSubidos: ${uploaded} · Descargados: ${downloaded} · Borrados a papelera: ${deleted}\nMovimientos y carpetas organizadas: ${organized}\nConflictos pendientes: ${pending}`;
    if(hasMore || (!wasReady && this.ready && pending))this.schedule();
  }
  private conflictValue(relative:string,kind:string,lp:string|undefined,rp:string|undefined,reason:string,local:Record<string,any>,remote:Record<string,any>){
    const summarize=(tree:Record<string,any>,prefix:string|undefined,cloud:boolean)=>prefix?Object.keys(tree).filter(p=>this.under(p,prefix)).sort().map(p=>[p,tree[p].kind,cloud?tree[p].uid:tree[p].id,tree[p].hash??null,cloud?tree[p].node?.activeRevision?.uid:null]):[];
    const fingerprint=createHash('sha256').update(JSON.stringify([summarize(local,lp,false),summarize(remote,rp,true)])).digest('hex');
    const id=createHash('sha256').update(kind+':'+relative).digest('hex');
    const summary=(e:any)=>e?{kind:e.kind,hash:e.kind==='file'?e.hash:null,size:e.kind==='file'?e.size:null,modifiedAt:e.modifiedAt??null}:null;
    return {id,path:relative,kind,localPath:lp??null,remotePath:rp??null,reason,fingerprint,local:summary(lp?local[lp]:null),remote:summary(rp?remote[rp]:null)};
  }
  private captureConflict(relative:string,kind:string,lp:string|undefined,rp:string|undefined,reason:string,local:Record<string,any>,remote:Record<string,any>){
    const value=this.conflictValue(relative,kind,lp,rp,reason,local,remote);this.detectedConflicts.set(value.id,value);this.conflicts.set(value.id,value);
  }
  private async copyName(relative:string,label:string,kind:string){
    const parsed=path.posix.parse(relative),stem=kind==='file'?parsed.name:parsed.base,extension=kind==='file'?parsed.ext:'';
    const stamp=new Date().toISOString().slice(0,19).replace(/[T:]/g,'-');
    const local=(await this.localTree()).tree,remote=this.remoteTree();
    for(let i=0;i<1000;i++){const name=path.posix.join(parsed.dir,`${stem} (${label} ${stamp}${i?'-'+i:''})${extension}`);if(!local[name]&&!remote[name])return name;}
    throw new Error('No se encuentra un nombre libre para conservar la copia');
  }
  private async preserveLocal(relative:string,expectedHash:string){
    const source=await this.safeLocal(relative);const backup=path.join(path.dirname(source.target),'.nube-conflicto-'+randomBytes(12).toString('hex')+'-'+path.basename(relative));
    const journal=this.store!.begin('backup',relative,{backup,hash:expectedHash});
    await copyFile(source.target,backup,1);
    if(await digest(backup)!==expectedHash){await unlink(backup).catch(()=>{});throw Object.assign(new Error('La versión local ha cambiado'),{code:'CHANGED'});}
    const fd=await open(backup,'r');try{await fd.sync();}finally{await fd.close();}await this.syncDirectory(path.dirname(backup));
    this.recordHistory('copia de seguridad',relative,'correcto','Versión local conservada antes de resolver el conflicto.');return {filename:backup,journal};
  }
  async resolveConflict(id:string,choice:'local'|'remote'|'both'){
    if(!['local','remote','both'].includes(choice))throw Object.assign(new Error('Selección inválida'),{httpStatus:400});
    // Unlike background jobs, a resolution must reject to its HTTP caller.
    const task=this.queue.then(async()=>{
      if(!this.active)throw Object.assign(new Error('Activa la sincronización primero'),{httpStatus:409});
      await this.refreshEvents();
      const conflict=this.conflicts.get(id);if(!conflict)throw Object.assign(new Error('El conflicto ya no está pendiente'),{httpStatus:409});
      if(conflict.kind==='unavailable')throw Object.assign(new Error('Revisa los permisos o las exclusiones antes de resolver este elemento.'),{httpStatus:409});
      const local=(await this.localTree()).tree,remote=this.remoteTree();
      const fresh=this.conflictValue(conflict.path,conflict.kind,conflict.localPath??undefined,conflict.remotePath??undefined,conflict.reason,local,remote);
      if(fresh.fingerprint!==conflict.fingerprint){this.conflicts.set(id,fresh);throw Object.assign(new Error('Las versiones han cambiado. Revisa el conflicto de nuevo.'),{httpStatus:409});}
      const lp=conflict.localPath as string|null,rp=conflict.remotePath as string|null,l=lp?local[lp]:null,r=rp?remote[rp]:null;
      if(conflict.kind==='file'){
        if(choice==='local' && !l){if(r)await this.operation('delete-remote',rp!,()=>this.trashRemote(r.uid));this.forget(conflict.path);}
        else if(choice==='remote' && !r){if(l)await this.operation('delete-local',lp!,()=>this.trashLocal(lp!,'file',l.id));this.forget(conflict.path);}
        else if(choice==='local' || (!r && l)){await this.uploadFile(lp!,l.hash,r?.node);}
        else if(choice==='remote' || (!l && r)){
          const backup=l?await this.preserveLocal(lp!,l.hash):null;
          try{await this.download(r.node,rp!,l?.hash??null);}finally{if(backup){try{await (this.options.trashLocal?this.options.trashLocal(backup.filename):trashRecoverably(backup.filename));this.store?.end(backup.journal);}catch{this.recordHistory('copia de seguridad',lp!,'conservada','La versión anterior permanece en un archivo oculto de la misma carpeta.');}}}
        }else{
          // Store the cloud version in a new visible file on both sides first.
          const alternate=await this.copyName(conflict.path,'copia nube','file');
          const hash=await this.download(r.node,alternate,null);
          await this.uploadFile(alternate,hash);await this.uploadFile(lp!,l.hash,r.node);
        }
      }else{
        if(choice==='local' && !l){if(r)await this.operation('delete-remote',rp!,()=>this.trashRemote(r.uid));}
        else if(choice==='remote' && !r){if(l)await this.operation('delete-local',lp!,()=>this.trashLocal(lp!,l.kind,l.id));}
        else if(choice==='local' && l && r){
          const occupied=remote[lp!];if(occupied && occupied.uid!==r.uid){const alternate=await this.copyName(lp!,'copia nube',occupied.kind);await this.moveRemote(occupied.node,alternate);}
          if(lp===rp && l.kind!==r.kind){const alternate=await this.copyName(rp!,'copia nube',r.kind);await this.moveRemote(r.node,alternate);}else await this.moveRemote(r.node,lp!);
        }else if(choice==='remote' && l && r){
          const occupied=local[rp!];if(occupied && lp!==rp){const alternate=await this.copyName(rp!,'copia local',occupied.kind);const from=await this.safeLocal(rp!,false,occupied.kind),to=await this.safeLocal(alternate,true,occupied.kind);await rename(from.target,to.target);}
          if(lp!==rp){const from=await this.safeLocal(lp!,false,l.kind),to=await this.safeLocal(rp!,true,l.kind);if(to.exists)throw Object.assign(new Error('El destino está ocupado'),{httpStatus:409});await rename(from.target,to.target);}
          else if(l.kind!==r.kind){const alternate=await this.copyName(lp!,'copia local',l.kind);const from=await this.safeLocal(lp!,false,l.kind),to=await this.safeLocal(alternate,true,l.kind);await rename(from.target,to.target);}
        }else if(choice==='both' && l && r && lp===rp){const alternate=await this.copyName(rp!,'copia nube',r.kind);await this.moveRemote(r.node,alternate);}
        // A missing side is restored by the normal non-destructive merge when
        // choosing the existing side or keeping both. Different paths are kept.
        this.forget(conflict.path);if(lp)this.forget(lp);if(rp)this.forget(rp);
      }
      this.conflicts.delete(id);this.store?.saveConflicts([...this.conflicts.values()]);
      this.recordHistory('resolver conflicto',conflict.path,'correcto',choice==='both'?'Se conservan ambas versiones.':choice==='local'?'Se conserva la versión local.':'Se conserva la versión de la nube.');
      await this.persistBaseline();await this.reconcile();
    });
    this.queue=task.catch(error=>this.handleError(error));return task;
  }
  async rebuildIndex(){
    await this.stop(false);await this.queue;
    this.store?.close();this.store=null;
    const stamp=Date.now();
    for(const filename of ['sync-state.sqlite','sync-state.sqlite-wal','sync-state.sqlite-shm','folder-baseline.json']){
      const source=path.join(this.dataRoot,filename);await rename(source,source+'.before-rebuild-'+stamp).catch((e:any)=>{if(e.code!=='ENOENT')throw e;});
    }
    this.conflicts.clear();this.verifiedDigests=Object.create(null);this.nodeDirty.clear();this.hashCache.clear();
    await this.start();
  }
  private async persistBaseline(){
    if(!this.root || !this.store)return;
    this.store.save({schema:3,localRoot:this.localRoot,remoteUid:this.root.uid,ready:this.ready,eventCursor:this.eventCursor,scanComplete:this.scanComplete,verifiedDigests:this.verifiedDigests,summary:{...this.summary,pendingCount:this.pendingPaths?this.pendingPaths.size:this.summary.pendingCount,pendingPaths:this.pendingPaths?[...this.pendingPaths].slice(0,50):this.summary.pendingPaths}},this.nodes,this.baseline,this.records,this.nodeDirty,this.hashCache);
    this.nodeDirty.clear();
  }
  async stop(persist=true) {
    this.startEpoch++;this.active=false;this.abort.abort();clearTimeout(this.timer);clearTimeout(this.retry);this.retry=null;this.nextRetryAt=null;
    this.watcher?.close();this.subscription?.dispose();this.status='Sincronización pausada';this.progress.phase='paused';
    await this.persistBaseline();
    if(persist) await writeFile(path.join(this.dataRoot,'sync-enabled.json'),JSON.stringify({enabled:false}),{mode:0o600});
  }
}
