import {createHash} from 'node:crypto';
import {statfs,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {planSync} from './planner.js';
export type ReviewSnapshot={local:Record<string,any>,remote:Record<string,any>,baseline:Record<string,string>,records:Record<string,any>,excluded?:string[]};
const under=(p:string,root:string)=>p===root||p.startsWith(root+'/');
function canonical(value:any):any{if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
function clean(tree:Record<string,any>){return Object.fromEntries(Object.entries(tree).map(([p,e])=>[p,{kind:e.kind,hash:e.hash??null,id:e.id??null,uid:e.uid??null,size:e.size??null,modifiedAt:e.modifiedAt??null,protected:!!e.protected}]));}
export function reviewPlan(snapshot:ReviewSnapshot,context:any={}){
 const local=Object.assign(Object.create(null),clean(snapshot.local)),remote=Object.assign(Object.create(null),clean(snapshot.remote)),baseline=Object.assign(Object.create(null),snapshot.baseline),records=Object.assign(Object.create(null),structuredClone(snapshot.records));
 const digest=createHash('sha256').update(JSON.stringify(canonical({local,remote,baseline,records:snapshot.records,excluded:[...(snapshot.excluded??[])].sort(),context}))).digest('hex');
 const comparable=(tree:any)=>canonical(Object.fromEntries(Object.entries(tree).map(([p,e]:any)=>[p,{kind:e.kind,hash:e.hash??null}])));const initiallyIdentical=JSON.stringify(comparable(local))===JSON.stringify(comparable(remote));
 const actions:any[]=[],blocked=new Set(snapshot.excluded??[]),moves:{from:string,to:string}[]=[];
 for(const p of blocked)if(snapshot.records[p])actions.push({type:'conflict',path:p,detail:'Elemento excluido o no disponible; no se aplicarán borrados'});
 const rekey=(tree:any,from:string,to:string)=>{for(const p of Object.keys(tree).filter(p=>under(p,from))){tree[to+p.slice(from.length)]=tree[p];delete tree[p];}};
 const isBlocked=(p:string)=>[...blocked].some(root=>under(p,root));
 // Mirror the identity-based organization before planning file transfers.
 for(const original of Object.keys(snapshot.records).sort((a,b)=>a.split('/').length-b.split('/').length)){
  let oldPath=original;for(const m of moves)if(under(oldPath,m.from))oldPath=m.to+oldPath.slice(m.from.length);
  if(isBlocked(oldPath))continue;
  const old=records[oldPath];if(!old)continue;const ls=Object.keys(local).filter(p=>local[p].id===old.localId&&local[p].kind===old.kind),rs=Object.keys(remote).filter(p=>remote[p].uid===old.remoteUid);
  const lp=ls.length===1?ls[0]:local[oldPath]?.kind===old.kind?oldPath:undefined,rp=rs[0]??(remote[oldPath]?.kind===old.kind?oldPath:undefined);
  if(lp&&rp&&lp===rp&&lp!==oldPath){rekey(baseline,oldPath,lp);rekey(records,oldPath,lp);moves.push({from:oldPath,to:lp});continue;}
  if(lp&&rp&&lp!==rp){
   if(lp!==oldPath&&rp!==oldPath){actions.push({type:'conflict',path:oldPath,detail:'Movido de forma distinta en ambos discos'});blocked.add(lp);blocked.add(rp);continue;}
   const to=lp!==oldPath?lp:rp,from=lp!==oldPath?rp:lp,tree=lp!==oldPath?remote:local;
   if(tree[to]){actions.push({type:'conflict',path:oldPath,detail:'El destino contiene otro elemento'});blocked.add(from);blocked.add(to);continue;}
   actions.push({type:lp!==oldPath?'move-remote':'move-local',path:from,destination:to});rekey(tree,from,to);rekey(baseline,from,to);rekey(records,from,to);moves.push({from:oldPath,to});
  }
 }
 const unchanged=(tree:any,p:string)=>Object.entries(tree).filter(([q])=>under(q,p)).every(([q,e]:any)=>{const old=records[q];return old&&old.kind===e.kind&&(e.kind!=='file'||old.hash===e.hash);});
 for(const p of Object.keys(records).sort((a,b)=>a.split('/').length-b.split('/').length)){const old=records[p];if(old.kind!=='folder'||isBlocked(p))continue;const l=local[p],r=remote[p];if(!l&&!r)continue;if(!l&&r||l&&!r){const tree=l?local:remote;if(tree[p]?.protected||!unchanged(tree,p)||(snapshot.excluded??[]).some(q=>under(q,p))){actions.push({type:'conflict',path:p,detail:'Carpeta borrada en un lado y cambiada en el otro'});blocked.add(p);}else{actions.push({type:l?'delete-local-folder':'delete-remote-folder',path:p});blocked.add(p);}}}
 for(const p of new Set([...Object.keys(local),...Object.keys(remote)])){
  if(isBlocked(p))continue;const l=local[p],r=remote[p];
  if(l&&r&&l.kind!==r.kind){actions.push({type:'conflict',path:p,detail:'Archivo y carpeta ocupan el mismo nombre'});blocked.add(p);continue;}
  if(l?.kind==='folder'&&!r)actions.push({type:'mkdir-remote',path:p});if(r?.kind==='folder'&&!l)actions.push({type:'mkdir-local',path:p});
 }
 const hashes=(tree:any)=>Object.fromEntries(Object.entries(tree).filter(([p,e]:any)=>e.kind==='file'&&!isBlocked(p)).map(([p,e]:any)=>[p,e.hash]));
 const filtered=Object.fromEntries(Object.entries(baseline).filter(([p])=>!isBlocked(p)));
 for(const action of planSync(hashes(local),hashes(remote),filtered)){actions.push({...action,bytes:action.type==='upload'?local[action.path]?.size??0:action.type==='download'?remote[action.path]?.size??0:0});}
 const uploadBytes=actions.filter(a=>a.type==='upload').reduce((n,a)=>n+a.bytes,0),downloadBytes=actions.filter(a=>a.type==='download').reduce((n,a)=>n+a.bytes,0);
 const trashPaths=actions.filter(a=>a.type==='upload'&&remote[a.path]||a.type==='delete-remote'||a.type==='delete-remote-folder').map(a=>a.path);
 const trashBytes=Object.entries(remote).filter(([p,e])=>e.kind==='file'&&trashPaths.some(root=>under(p,root))).reduce((n,[,e])=>n+(e.size??0),0);
 return {id:digest,createdAt:new Date().toISOString(),actions,uploadBytes,downloadBytes,trashBytes,totalBytes:uploadBytes+downloadBytes,totalFiles:actions.filter(a=>a.type==='upload'||a.type==='download').length,conflicts:actions.filter(a=>a.type==='conflict').length,identical:initiallyIdentical};
}
export async function spaceBudget(plan:ReturnType<typeof reviewPlan>,source:string,target:string,probe=async(p:string)=>{const [fs,st]=await Promise.all([statfs(p),lstat(p)]);return {free:Number(fs.bavail)*Number(fs.bsize),device:String(st.dev)};}){
 const [local,external,trash]=await Promise.all([probe(source),probe(target),probe(homedir())]);
 const groups=new Map<string,{free:number,needed:number}>();for(const [disk,needed] of [[local,plan.downloadBytes],[external,plan.uploadBytes],[trash,plan.trashBytes]] as const){const group=groups.get(disk.device)??{free:disk.free,needed:0};group.free=Math.min(group.free,disk.free);group.needed+=needed;groups.set(disk.device,group);}
 return {localFree:local.free,externalFree:external.free,localNeeded:plan.downloadBytes,externalNeeded:plan.uploadBytes,trashNeeded:plan.trashBytes,enough:[...groups.values()].every(g=>g.free>=g.needed),note:'Se reserva espacio para copias temporales y para las versiones externas que van a la papelera. No se cuenta con espacio que liberarían los borrados.'};
}
export class ReviewGate{
 preview:any=null;private approved:string|null=null;private force=false;
 constructor(private source:()=>string,private target:()=>string,private context:()=>any,private required:()=>boolean,private started:(p:any)=>void,private budget=spaceBudget){}
 request(){this.force=true;this.approved=null;}
 approve(id:string){if(!this.preview||this.preview.id!==id)throw new Error('La vista previa ha cambiado. Revísala de nuevo.');if(!this.preview.space.enough)throw new Error('No hay espacio suficiente para aplicar estos cambios.');this.approved=id;}
 clear(){this.approved=null;this.preview=null;}
 async check(snapshot:ReviewSnapshot){const plan=reviewPlan(snapshot,this.context());const space=await this.budget(plan,this.source(),this.target());this.preview={...plan,space};
  if(plan.identical){this.approved=null;this.force=false;return true;}
  if(this.approved){const valid=this.approved===plan.id;this.approved=null;if(!valid)throw Object.assign(new Error('La vista previa ha cambiado; no se aplican los cambios anteriores.'),{code:'REVIEW_CHANGED'});if(!space.enough)throw Object.assign(new Error('No queda espacio suficiente'),{code:'ENOSPC'});this.force=false;this.started(plan);return true;}
  if(!this.required()&&!this.force){if(!space.enough)throw Object.assign(new Error('No queda espacio suficiente'),{code:'ENOSPC'});this.started(plan);return true;}return false;
 }
}
