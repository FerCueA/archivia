import {cp,lstat,mkdir,readdir,readlink,rename,rm,writeFile,unlink,open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import {homedir} from 'node:os';

async function snapshot(root:string) {
  const content:Record<string,string>=Object.create(null),stamps:Record<string,string>=Object.create(null);
  async function walk(filename:string,relative:string) {
    const stat=await lstat(filename,{bigint:true});
    stamps[relative]=`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if(stat.isSymbolicLink()) content[relative]='link:'+await readlink(filename);
    else if(stat.isDirectory()) {content[relative]='directory';for(const name of (await readdir(filename)).sort())await walk(path.join(filename,name),relative+'/'+name);}
    else if(stat.isFile()) {const hash=createHash('sha256');for await(const chunk of createReadStream(filename))hash.update(chunk);content[relative]='file:'+hash.digest('hex');}
    else throw new Error('La papelera no admite este tipo de archivo');
    const after=await lstat(filename,{bigint:true});
    if(stamps[relative]!==`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}`)throw new Error('Archivo modificado durante la copia a la papelera');
  }
  await walk(root,'');return {content,stamps};
}
async function flush(filename:string):Promise<void>{const st=await lstat(filename);if(st.isSymbolicLink())return;if(st.isDirectory())for(const child of await readdir(filename))await flush(path.join(filename,child));const fd=await open(filename,'r');try{await fd.sync();}catch(e:any){if(!['EINVAL','ENOTSUP'].includes(e.code))throw e;}finally{await fd.close();}}
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function localDate() {
 const d=new Date(),pad=(v:number)=>String(v).padStart(2,'0');
 return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
/** Freedesktop home trash, with verified copy on cross-filesystem moves. */
export async function trashRecoverably(filename:string,trashRoot?:string,originalPath?:string) {
  if(!path.isAbsolute(filename))throw new Error('La papelera requiere una ruta absoluta');
  const data=process.env.XDG_DATA_HOME;
  const root=trashRoot??path.join(data&&path.isAbsolute(data)?data:path.join(homedir(),'.local/share'),'Trash');
  if(filename===root || filename.startsWith(root+'/'))throw new Error('No se puede enviar la papelera a sí misma');
  await mkdir(path.join(root,'files'),{recursive:true,mode:0o700});await mkdir(path.join(root,'info'),{recursive:true,mode:0o700});
  if(originalPath&&!path.isAbsolute(originalPath))throw new Error('La ruta de restauración debe ser absoluta');
  const restore=originalPath??filename;
  const characters=Array.from(path.basename(restore));while(Buffer.byteLength(characters.join(''))>180)characters.pop();
  const name=(characters.join('')||'archivo')+'-'+randomBytes(12).toString('hex');
  const target=path.join(root,'files',name),info=path.join(root,'info',name+'.trashinfo');
  const encoded=restore.split('/').map(encodeURIComponent).join('/');
  await writeFile(info,`[Trash Info]\nPath=${encoded}\nDeletionDate=${localDate()}\n`,{flag:'wx',mode:0o600});
  await flush(info);
  const infoDir=await open(path.dirname(info),'r');try{await infoDir.sync();}finally{await infoDir.close();}
  let moved=false;
  try {
    try {await rename(filename,target);moved=true;await flush(target);return target;}
    catch(error:any){if(error.code!=='EXDEV')throw error;}
    const before=await snapshot(filename);
    await cp(filename,target,{recursive:true,errorOnExist:true,force:false,dereference:false,verbatimSymlinks:true,preserveTimestamps:true});
    const source=await snapshot(filename),copy=await snapshot(target);
    if(!equal(before.stamps,source.stamps) || !equal(before.content,source.content) || !equal(source.content,copy.content))throw new Error('La copia a la papelera no coincide; se conserva el original');
    // The original is removed only after its complete content exists in Trash.
    await flush(target);
    moved=true; // Keep the verified copy even if removing the original only partly succeeds.
    await rm(filename,{recursive:true});return target;
  } finally {
    if(!moved) {await rm(target,{recursive:true,force:true}).catch(()=>{});await unlink(info).catch(()=>{});}
  }
}
