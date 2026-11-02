import {reviewPlan,type ReviewSnapshot} from './disk-review';
export class CloudSafety{
 constructor(private onEvent?:(event:any)=>void){}
 cancelApproval(){this.approved=null;}
 private approved:string|null=null;preview:any=null;
 clear(){this.approved=null;this.preview=null;}
 view(){return {preview:this.preview};}
 approve(id:string){if(!this.preview||id!==this.preview.id)throw Error('Los cambios han variado. Revisa la lista actual.');this.approved=id;}
 check(snapshot:ReviewSnapshot){
  const local=new Map(Object.entries(snapshot.local).map(([p,e])=>[e.id,p])),remote=new Map(Object.entries(snapshot.remote).map(([p,e])=>[e.uid,p]));let deletions=0,moves=0,tracked=0;
  for(const [p,r] of Object.entries(snapshot.records)){if((snapshot.excluded??[]).some(q=>p===q||p.startsWith(q+'/')||q.startsWith(p+'/')))continue;tracked++;const lp=local.get(r.localId)??(snapshot.local[p]?.kind===r.kind?p:undefined),rp=remote.get(r.remoteUid)??(snapshot.remote[p]?.kind===r.kind?p:undefined);if(!lp!==!rp)deletions++;else if(lp&&rp&&lp!==rp)moves++;}
  const risky=deletions>=20||(deletions>=5&&deletions>=tracked*.5)||moves>=100;
  if(!risky){this.preview=null;this.approved=null;return true;}
  const plan=reviewPlan(snapshot,{scope:'cloud-mass-changes'});if(this.preview?.id!==plan.id)this.onEvent?.({kind:'cloud-review',result:'aviso',detail:deletions+' elementos borrados; '+moves+' movimientos pendientes de revisión.'});this.preview={...plan,deletions,moves,tracked,reason:(this.approved&&this.approved!==plan.id?'La lista ha cambiado desde la confirmación; revísala de nuevo. ':'')+'Se detectaron '+deletions+' elementos posiblemente borrados y '+moves+' elementos con cambios de ubicación. Revisa las rutas antes de permitir su propagación.'};
  if(this.approved===plan.id){this.onEvent?.({kind:'cloud-approve',result:'correcto',detail:'Cambios masivos autorizados tras revalidar la vista previa.'});this.approved=null;this.preview=null;return true;}this.approved=null;return false;
 }
}
