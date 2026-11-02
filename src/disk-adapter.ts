import {renameNoReplace} from './file-operations';
/** Filesystem implementation of the small SDK surface used by FolderSync. */
import {lstat,readdir,readFile,realpath,open,writeFile,mkdir,rename,link,unlink,statfs} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import {trashRecoverably} from './local-trash';
export type DiskPair={enabled:boolean,sourceRelative:string,target:string,pairId:string,volume:string,mount:string,targetRelative?:string,mountId?:string,reviewBeforeSync?:boolean,filesystem?:string};
export const diskDefaults:DiskPair={enabled:false,sourceRelative:'',target:'',pairId:'',volume:'',mount:'',targetRelative:'',reviewBeforeSync:true};
const offline=()=>Object.assign(new Error('Disco externo desconectado o carpeta no disponible. No se aplican cambios.'),{code:'DISK_OFFLINE'});
function decode(s:string){return s.replace(/\\([0-7]{3})/g,(_,v)=>String.fromCharCode(parseInt(v,8)));}
export async function mountedVolumes(){
 const text=await readFile('/proc/self/mountinfo','utf8');
 const mounts=text.trim().split('\n').map(line=>{const [a,b]=line.split(' - '),left=a.split(' '),right=b.split(' ');return {filesystem:right[0],mountId:left[0],mount:decode(left[4]),device:left[2],source:decode(right[1]??''),root:decode(left[3])};}).filter(m=>['/media/','/mnt/','/run/media/'].some(p=>m.mount.startsWith(p)));
 const result=[];for(const m of mounts){
 let volume='device:'+m.source+':'+m.root;
 try{const device=await realpath(m.source);for(const uuid of await readdir('/dev/disk/by-uuid')){if(await realpath('/dev/disk/by-uuid/'+uuid).catch(()=>null)===device){volume='uuid:'+uuid+':'+m.root;break;}}}catch{}
 result.push({...m,volume});}return result;
}
export async function mountIdentity(folder:string){const matches=(await mountedVolumes()).filter(m=>folder===m.mount||folder.startsWith(m.mount+'/')).sort((a,b)=>b.mount.length-a.mount.length);if(!matches.length)throw offline();return matches[0];
}
export function validateDiskConfig(input:any):Pick<DiskPair,'enabled'|'sourceRelative'|'target'|'reviewBeforeSync'>{
 if(!input||typeof input.enabled!=='boolean'||typeof input.sourceRelative!=='string'||typeof input.target!=='string')throw new Error('Configuración del disco no válida.');
 if(input.reviewBeforeSync!==undefined&&typeof input.reviewBeforeSync!=='boolean')throw new Error('La opción de revisión no es válida.');
 const rel=input.sourceRelative.trim(),target=input.target.trim();
 if(rel&&(rel.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.'))||/[\\\0]/.test(rel)))throw new Error('La subcarpeta debe ser una ruta relativa dentro de ProtonDrive, sin «..» ni enlaces.');
 if(target&&(!path.isAbsolute(target)||target.includes('\0')||!['/media/','/mnt/','/run/media/'].some(p=>target.startsWith(p))))throw new Error('Selecciona una carpeta de un disco montado en /media, /mnt o /run/media.');
 if(input.enabled&&!target)throw new Error('Conecta el disco y elige su carpeta antes de activar la sincronización.');
 return {enabled:input.enabled,sourceRelative:rel,reviewBeforeSync:input.reviewBeforeSync??true,target:target?path.resolve(target):''};
}
export async function directDirectory(folder:string){let current='/';for(const part of folder.split('/').filter(Boolean)){current=path.join(current,part);const s=await lstat(current);if(s.isSymbolicLink()||!s.isDirectory())throw new Error('La carpeta contiene un enlace simbólico o no es un directorio.');}}
export async function pairDisk(input:any,localRoot:string,previous:DiskPair=diskDefaults):Promise<DiskPair>{
 const config=validateDiskConfig(input);if(!config.enabled)return {...previous,...config};
 const source=path.join(localRoot,config.sourceRelative);await directDirectory(source);await directDirectory(config.target);
 if(source===config.target||source.startsWith(config.target+'/')||config.target.startsWith(source+'/'))throw new Error('Las carpetas no pueden coincidir ni contenerse.');
 const mounted=await mountIdentity(config.target);if(mounted.mount===config.target)throw new Error('Elige una carpeta dentro del disco, no la raíz completa de la unidad.');
 const marker=path.join(config.target,'.proton-drive-pair.json');let pairId='';
 try{const stat=await lstat(marker);if(stat.isSymbolicLink()||!stat.isFile())throw new Error('El identificador de la carpeta no es un archivo seguro.');const saved=JSON.parse(await readFile(marker,'utf8'));if(!/^[a-f0-9]{48}$/.test(saved.id))throw new Error('Identificador del disco no válido.');pairId=saved.id;}catch(e:any){if(e.code!=='ENOENT')throw e;pairId=randomBytes(24).toString('hex');const f=await open(marker,'wx',0o600);try{await f.writeFile(JSON.stringify({id:pairId,version:1}));await f.sync();}finally{await f.close();}}
 return {...config,pairId,volume:mounted.volume,mount:mounted.mount,mountId:mounted.mountId,filesystem:mounted.filesystem,targetRelative:path.relative(mounted.mount,config.target)};
}
export async function findPairedMount(pair:DiskPair,mounts?:any[],readMarker?: (folder:string)=>Promise<string>){
 const relative=pair.targetRelative||path.relative(pair.mount,pair.target);
 if(!relative||path.isAbsolute(relative)||relative.split(path.sep).some(p=>p==='..'||p==='.'||!p))throw offline();
 const candidates=[];for(const m of mounts??await mountedVolumes()){
  if(m.volume!==pair.volume)continue;const target=path.join(m.mount,relative);
  try{let id:string;if(readMarker)id=await readMarker(target);else{await directDirectory(target);const marker=path.join(target,'.proton-drive-pair.json');const st=await lstat(marker);if(st.isSymbolicLink()||!st.isFile())continue;id=JSON.parse(await readFile(marker,'utf8')).id;}if(id===pair.pairId)candidates.push({...pair,target,mount:m.mount,mountId:m.mountId,filesystem:m.filesystem??pair.filesystem,targetRelative:relative});}catch{}
 }
 if(candidates.length>1)throw new Error('Hay varias unidades con el mismo identificador. Desconecta la copia duplicada antes de continuar.');
 if(!candidates.length)throw offline();return candidates[0];
}
export class DiskAdapter{
 private nodes=new Map<string,any>();private paths=new Map<string,string>();private cache=new Map<string,{key:string,hash:string}>();private epoch=randomBytes(8).toString('hex');private serial=0;private events:any[]=[];private initialized=false;
 private aliases=new Map<string,string>();
 private cancelled=false;
 cancel(){this.cancelled=true;}
 readonly rootUid:string;
 constructor(private pair:DiskPair,private guardOverride?:()=>Promise<void>,private trash?:(p:string)=>Promise<any>){this.rootUid='disk-root-'+pair.pairId;}
 async guard(){if(this.cancelled)throw new DOMException('Sincronización externa detenida','AbortError');if(this.guardOverride){await this.guardOverride();return;}try{const m=await mountIdentity(this.pair.target);if(m.volume!==this.pair.volume)throw offline();await directDirectory(this.pair.target);const markerPath=path.join(this.pair.target,'.proton-drive-pair.json');const st=await lstat(markerPath);if(st.isSymbolicLink()||!st.isFile())throw offline();const marker=JSON.parse(await readFile(markerPath,'utf8'));if(marker.id!==this.pair.pairId)throw offline();}catch{throw offline();}}
 private rawUid(st:any){return 'disk-'+this.pair.pairId+'-'+st.ino;}
 private uid(st:any){const raw=this.rawUid(st);return this.aliases.get(raw)??raw;}
 private async node(filename:string,parentUid?:string):Promise<any>{
  await this.guard();const st=await lstat(filename,{bigint:true});if(st.isSymbolicLink()||(!st.isDirectory()&&!st.isFile()))throw new Error('Elemento externo no compatible.');
  const uid=filename===this.pair.target?this.rootUid:this.uid(st),name=path.basename(filename);
  if(st.isDirectory())return {uid,parentUid,type:'folder',name:{ok:true,value:name},treeEventScopeId:this.rootUid,protectedChildren:filename!==this.pair.target&&(await readdir(filename)).some(child=>child.startsWith('.'))};
  const key=`${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;let hash=this.cache.get(filename)?.key===key?this.cache.get(filename)!.hash:'';
  if(!hash){const h=createHash('sha1');for await(const c of createReadStream(filename)){await this.guard();h.update(c);}const after=await lstat(filename,{bigint:true});if(key!==`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}`)throw Object.assign(new Error('Archivo externo modificado durante la lectura'),{code:'CHANGED'});hash=h.digest('hex');this.cache.set(filename,{key,hash});}
  return {uid,parentUid,type:'file',name:{ok:true,value:name},mediaType:'application/octet-stream',activeRevision:{uid:uid+'@'+key,claimedSize:Number(st.size),claimedDigests:{sha1:hash},claimedModificationTime:new Date(Number(st.mtimeNs/1000000n)).toISOString()}};
 }
 private async refresh(){
  await this.guard();const fresh=new Map<string,any>(),locations=new Map<string,string>();
  const walk=async(filename:string,parent?:string)=>{const n=await this.node(filename,parent);if(fresh.has(n.uid))throw new Error('El disco contiene enlaces duros ambiguos.');fresh.set(n.uid,n);locations.set(n.uid,filename);if(n.type==='folder')for(const child of await readdir(filename)){if(child.startsWith('.')||child.includes('.nube-conflicto-'))continue;const next=path.join(filename,child);const st=await lstat(next);if(st.isSymbolicLink()||(!st.isFile()&&!st.isDirectory())){
    throw new Error('El disco contiene enlaces simbólicos o elementos especiales. Se pausa para conservar los archivos.');
   }await walk(next,n.uid);}};
  await walk(this.pair.target);await this.guard();
  for(const [uid,n] of fresh)if(JSON.stringify(n)!==JSON.stringify(this.nodes.get(uid)))this.events.push({type:'node_updated',nodeUid:uid,eventId:this.epoch+':'+(++this.serial)});
  for(const uid of this.nodes.keys())if(!fresh.has(uid))this.events.push({type:'node_deleted',nodeUid:uid,eventId:this.epoch+':'+(++this.serial)});
  this.nodes=fresh;this.paths=locations;this.initialized=true;
 }
 private async filename(uid:string){await this.guard();const filename=this.paths.get(uid);if(!filename)throw Object.assign(new Error('Elemento externo no encontrado'),{httpCode:404});const parent=path.dirname(filename);await directDirectory(filename===this.pair.target?filename:parent);return filename;}
 async getMyFilesRootFolder(){await this.refresh();return this.nodes.get(this.rootUid);}
 async getNode(uid:string){const filename=await this.filename(uid),old=this.nodes.get(uid);const n=await this.node(filename,old?.parentUid);if(n.uid!==uid)throw Object.assign(new Error('Elemento externo sustituido'),{code:'CHANGED'});return n;}
 async *iterateFolderChildren(uid:string){await this.guard();for(const n of this.nodes.values())if(n.parentUid===uid)yield n;}
 async *iterateEvents(_:string,last?:string,signal?:AbortSignal){signal?.throwIfAborted();await this.refresh();if(last&&!last.startsWith(this.epoch+':')){yield {type:'tree_refresh',eventId:this.epoch+':'+this.serial};return;}if(!last){yield {type:'checkpoint',eventId:this.epoch+':'+this.serial};this.events=[];return;}const index=Number(last.split(':')[1]);if(this.events.length&&index<Number(this.events[0].eventId.split(':')[1])-1){yield {type:'tree_refresh',eventId:this.epoch+':'+this.serial};return;}for(const e of this.events.filter(e=>Number(e.eventId.split(':')[1])>index)){signal?.throwIfAborted();yield e;} // keep a bounded log; force refresh for expired cursors
  if(this.events.length>10000)this.events=this.events.slice(-5000);
 }
 private safeName(name:string){if(!name||name==='.'||name==='..'||/[\/\\\0]/.test(name)||name.startsWith('.'))throw new Error('Nombre externo no seguro.');return name;}
 async createFolder(uid:string,name:string){const parent=await this.filename(uid),dest=path.join(parent,this.safeName(name));await this.guard();await mkdir(dest);await this.refresh();return [...this.nodes.values()].find(n=>this.paths.get(n.uid)===dest);}
 async getFileUploader(parentUid:string,name:string,metadata:any,signal?:AbortSignal){return this.uploader(await this.filename(parentUid),this.safeName(name),metadata,signal);}
 async getFileRevisionUploader(uid:string,metadata:any,signal?:AbortSignal){const filename=await this.filename(uid),node=await this.getNode(uid);return this.uploader(path.dirname(filename),path.basename(filename),metadata,signal,node);}
 private commitNew(from:string,to:string){return renameNoReplace(from,to);}
 private uploader(parent:string,name:string,metadata:any,signal?:AbortSignal,existing?:any){return {uploadFromStream:async(source:ReadableStream<Uint8Array>,_:any[]=[],progress?:(n:number)=>void)=>{
  const reader=source.getReader(),dest=path.join(parent,name),temp=path.join(parent,'.nube-part-'+randomBytes(12).toString('hex'));let file:any;
  try{await this.guard();const space=await statfs(parent);if(metadata.expectedSize>Number(space.bavail)*Number(space.bsize))throw Object.assign(new Error('Espacio insuficiente en el externo'),{code:'ENOSPC'});file=await open(temp,'wx',0o600);const hash=createHash('sha1');let bytes=0;for(;;){signal?.throwIfAborted();const chunk=await reader.read();if(chunk.done)break;await this.guard();await file.writeFile(chunk.value);hash.update(chunk.value);bytes+=chunk.value.length;progress?.(bytes);}if(hash.digest('hex')!==metadata.expectedSha1)throw Object.assign(new Error('Integridad incorrecta'),{code:'INTEGRITY'});await file.sync();await file.close();file=null;await this.guard();await directDirectory(parent);
   if(existing){const current=await this.getNode(existing.uid);if(current.activeRevision.uid!==existing.activeRevision.uid)throw Object.assign(new Error('El archivo externo ha cambiado'),{code:'CHANGED'});await(this.trash?this.trash(dest):trashRecoverably(dest));await this.guard();await this.commitNew(temp,dest);}else{await this.commitNew(temp,dest);}if(existing){for(const [key,value] of this.aliases)if(value===existing.uid)this.aliases.delete(key);this.aliases.set(this.rawUid(await lstat(dest,{bigint:true})),existing.uid);}await this.refresh();const node=[...this.nodes.values()].find(n=>this.paths.get(n.uid)===dest);return {completion:async()=>({nodeUid:node.uid})};
  }catch(e){await reader.cancel(e).catch(()=>{});throw e;}finally{reader.releaseLock();if(file)await file.close().catch(()=>{});await this.guard().then(()=>unlink(temp).catch(()=>{})).catch(()=>{});}
 }};}
 async getFileDownloader(uid:string,signal?:AbortSignal){const filename=await this.filename(uid),node=await this.getNode(uid);return {getClaimedSizeInBytes:()=>node.activeRevision.claimedSize,downloadToStream:(target:WritableStream<Uint8Array>,progress?:(n:number)=>void)=>({completion:async()=>{const writer=target.getWriter();let bytes=0;try{for await(const chunk of createReadStream(filename)){signal?.throwIfAborted();await this.guard();await writer.write(new Uint8Array(chunk));bytes+=chunk.length;progress?.(bytes);}const current=await this.getNode(uid);if(current.activeRevision.uid!==node.activeRevision.uid)throw Object.assign(new Error('Archivo externo modificado'),{code:'CHANGED'});await writer.close();}catch(e){await writer.abort(e).catch(()=>{});throw e;}finally{writer.releaseLock();}}})};}
 async renameNode(uid:string,name:string){const from=await this.filename(uid),dest=path.join(path.dirname(from),this.safeName(name));await this.move(from,dest);return this.getNode(uid);}
 async *moveNodes(uids:string[],parentUid:string){for(const uid of uids){const from=await this.filename(uid),parent=await this.filename(parentUid);await this.move(from,path.join(parent,path.basename(from)));yield {ok:true,uid};}}
 private async move(from:string,to:string){await this.guard();try{await lstat(to);throw Object.assign(new Error('El destino ya existe'),{code:'EEXIST'});}catch(e:any){if(e.code!=='ENOENT')throw e;}await rename(from,to);await this.refresh();}
 async *trashNodes(uids:string[]){for(const uid of uids){const file=await this.filename(uid);if(uid===this.rootUid)throw new Error('La raíz del disco está protegida.');const old=new Map(this.nodes);await this.refresh();const affected=[...this.paths].filter(([,p])=>p===file||p.startsWith(file+'/')).map(([id])=>id);if(affected.some(id=>JSON.stringify(this.nodes.get(id))!==JSON.stringify(old.get(id)))||[...old.keys()].some(id=>!this.nodes.has(id)))throw Object.assign(new Error('La carpeta externa ha cambiado antes del borrado'),{code:'CHANGED'});const check=async(p:string):Promise<void>=>{const st=await lstat(p);if(st.isSymbolicLink())throw Object.assign(new Error('Elemento externo protegido'),{code:'CHANGED'});if(st.isDirectory())for(const name of await readdir(p)){if(name.startsWith('.'))throw Object.assign(new Error('La carpeta contiene archivos ocultos que no se sincronizan'),{code:'CHANGED'});await check(path.join(p,name));}};await check(file);await this.guard();await(this.trash?this.trash(file):trashRecoverably(file));await this.refresh();yield {ok:true,uid};}}
}
