import {readFile,writeFile,rename,mkdir,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
export const defaults={uploadKiB:0,downloadKiB:0,pauseMetered:true,notifications:true,autostart:true,localRoot:path.join(homedir(),'ProtonDrive'),exclusions:[] as string[]};
export type Preferences=typeof defaults;
export function validatePreferences(value:any):Preferences{
  if(!value||typeof value!=='object')throw new Error('Configuración no válida');
  for(const key of ['uploadKiB','downloadKiB'])if(!Number.isInteger(value[key])||value[key]<0||value[key]>1048576)throw new Error('Los límites deben ser enteros entre 0 y 1048576 KiB/s.');
  for(const key of ['pauseMetered','notifications','autostart'])if(typeof value[key]!=='boolean')throw new Error('Preferencia no válida: '+key);
  if(typeof value.localRoot!=='string'||!path.isAbsolute(value.localRoot)||value.localRoot.includes('\0'))throw new Error('Elige una ruta absoluta para la carpeta local.');
  if(!Array.isArray(value.exclusions)||value.exclusions.length>100)throw new Error('Se admiten hasta 100 exclusiones.');
  const exclusions=value.exclusions.map((p:any)=>{if(typeof p!=='string'||p.length>500||!p||p.split('/').some(s=>!s||s==='.'||s==='..')||/[\\\0\n\r]/.test(p))throw new Error('Las exclusiones son rutas relativas, una por línea, sin comodines ni «..».');return p;});
  return {uploadKiB:value.uploadKiB,downloadKiB:value.downloadKiB,pauseMetered:value.pauseMetered,notifications:value.notifications,autostart:value.autostart,localRoot:path.resolve(value.localRoot),exclusions:[...new Set(exclusions)]};
}
export async function loadPreferences(root:string):Promise<Preferences>{try{return validatePreferences({...defaults,...JSON.parse(await readFile(path.join(root,'preferences.json'),'utf8'))});}catch(e:any){if(e.code==='ENOENT')return {...defaults,exclusions:[]};throw e;}}
export async function savePreferences(root:string,p:Preferences){await mkdir(root,{recursive:true,mode:0o700});const file=path.join(root,'preferences.json');await writeFile(file+'.tmp',JSON.stringify(p,null,2),{mode:0o600});await rename(file+'.tmp',file);}
export async function validateFolder(folder:string,state:string,previous:string){
 const home=homedir();
 if(folder===home||folder==='/'||!(folder.startsWith(home+'/')||folder.startsWith('/media/')||folder.startsWith('/mnt/')))throw new Error('Elige una carpeta dentro de tu usuario, /media o /mnt; no la carpeta de usuario completa.');
 const overlap=(a:string,b:string)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
 if(overlap(folder,path.resolve(state))||overlap(folder,path.join(home,'.local'))||overlap(folder,path.join(home,'.config')))throw new Error('La carpeta no puede contener la instalación ni la configuración del sistema.');
 if(folder!==previous&&overlap(folder,previous))throw new Error('La carpeta nueva no puede estar dentro de la anterior ni contenerla.');
 let current='/';for(const part of folder.split('/').filter(Boolean)){current=path.join(current,part);try{const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('La ruta contiene un enlace simbólico o un archivo.');}catch(e:any){if(e.code!=='ENOENT')throw e;}}
 await mkdir(folder,{recursive:true});if(await realpath(folder)!==folder)throw new Error('La carpeta debe ser una ruta directa, sin enlaces.');
}
/** Backpressure on plaintext streams, with bounded slices and abortable waits.
 * Limits average application bytes; encryption/HTTP overhead is additional. */
export class RateGate{
 private next=0;
 constructor(private kib:number,private signal?:AbortSignal){}
 async take(bytes:number){
  this.signal?.throwIfAborted();if(!this.kib)return;
  const now=performance.now();this.next=Math.max(this.next,now)+bytes*1000/(this.kib*1024);
  const delay=this.next-now;
  await new Promise<void>((resolve,reject)=>{const finish=()=>{this.signal?.removeEventListener('abort',abort);resolve();};const timer=setTimeout(finish,delay);const abort=()=>{clearTimeout(timer);this.signal?.removeEventListener('abort',abort);reject(this.signal?.reason??new DOMException('Cancelado','AbortError'));};this.signal?.addEventListener('abort',abort,{once:true});if(this.signal?.aborted)abort();});
 }
}
export function limitedReadable(source:ReadableStream<Uint8Array>,kib:number,signal?:AbortSignal):ReadableStream<Uint8Array>{
 if(!kib)return source;const reader=source.getReader(),gate=new RateGate(kib,signal);let pending:Uint8Array|undefined,offset=0;
 return new ReadableStream({async pull(c){try{if(!pending||offset>=pending.length){const r=await reader.read();if(r.done){reader.releaseLock();c.close();return;}pending=r.value;offset=0;}const n=Math.min(16384,pending.length-offset);await gate.take(n);c.enqueue(pending.subarray(offset,offset+n));offset+=n;}catch(e){await reader.cancel(e).catch(()=>{});c.error(e);}},async cancel(reason){await reader.cancel(reason);}}, {highWaterMark:0});
}
export function limitedWritable(target:WritableStream<Uint8Array>,kib:number,signal?:AbortSignal):WritableStream<Uint8Array>{
 if(!kib)return target;const writer=target.getWriter(),gate=new RateGate(kib,signal);
 return new WritableStream({async write(chunk){for(let i=0;i<chunk.length;i+=16384){const part=chunk.subarray(i,i+16384);await gate.take(part.length);await writer.write(part);}},async close(){await writer.close();},async abort(reason){await writer.abort(reason);}});
}

export function networkDecision(active:boolean,pausedByNetwork:boolean,desired:boolean,pauseMetered:boolean,metered:string):'pause'|'resume'|'none'{
 if(pauseMetered&&metered==='metered'&&active)return 'pause';
 if(pausedByNetwork&&desired&&(!pauseMetered||metered==='unmetered'))return 'resume';
 return 'none';
}
