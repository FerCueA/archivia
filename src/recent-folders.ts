import {readFile,mkdir,open,rename} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';
export class RecentFolders{
 private folders:any[]=[];error:string|null=null;
 constructor(private data:string){}
 async init(){try{const saved=JSON.parse(await readFile(path.join(this.data,'duplicate-folders.json'),'utf8'));if(!Array.isArray(saved))throw Error();this.folders=saved.filter(e=>typeof e.path==='string'&&path.isAbsolute(e.path)&&typeof e.lastUsed==='string').slice(0,10).map(e=>({...e,id:this.id(e.path)}));}catch(e:any){if(e.code!=='ENOENT')this.error='No se pueden leer las carpetas recordadas. Puedes elegir una carpeta de nuevo.';}}
 private id(p:string){return createHash('sha256').update(p).digest('hex');}
 view(){return {folders:this.folders,error:this.error};}
 get(id:string){const e=this.folders.find(e=>e.id===id);if(!e)throw new Error('La carpeta recordada ya no está disponible. Elígela de nuevo.');return e.path;}
 async remember(p:string){this.folders=[{id:this.id(p),path:p,lastUsed:new Date().toISOString()},...this.folders.filter(e=>e.path!==p)].slice(0,10);await this.save();}
 async forget(id:string){this.folders=this.folders.filter(e=>e.id!==id);await this.save();}
 private async save(){try{await mkdir(this.data,{recursive:true,mode:0o700});const file=path.join(this.data,'duplicate-folders.json'),temp=file+'.tmp';const fd=await open(temp,'w',0o600);try{await fd.writeFile(JSON.stringify(this.folders));await fd.sync();}finally{await fd.close();}await rename(temp,file);this.error=null;}catch{this.error='Las carpetas de esta sesión no se pueden guardar para el próximo inicio.';}}
}
