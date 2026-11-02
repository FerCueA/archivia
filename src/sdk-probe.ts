import {ReleaseUpdater} from './release-updater';
import {CloudSafety} from './cloud-safety';
import {RunHealth} from './run-health';
import {exportSettings,importSettings,stageSettingsImport,commitSettingsImport,recoverSettingsImport} from './settings-transfer';
import {ActivityLog,taskAlerts} from './activity';
import {RecentFolders} from './recent-folders';
import {DocumentPreview} from './document-preview';
import {DiskDiagnostics,testDisk} from './disk-diagnostics';
import {CloudRecovery} from './cloud-recovery';
import {FolderOrganizer} from './organizer';
import {DuplicateFinder} from './duplicates';
import {homedir} from 'node:os';
import {ExternalSync} from './external-sync';
import {loadPreferences,savePreferences,validatePreferences,validateFolder,networkDecision} from './preferences';
import { init } from './init';
import { FolderSync, LOCAL_ROOT } from './folder-sync';
import { panel } from './panel';
import { errorDetails } from './sync-errors';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

// Dedicated namespace: never read or modify the official CLI session.
const dataRoot = process.env.NUBE_LOCAL_DATA ?? path.resolve('work/nube-local-state');
process.env.PROTON_DRIVE_CACHE_DIR = dataRoot;
process.env.PROTON_DRIVE_CREDENTIALS_STORE = 'keychain';
process.env.PROTON_DRIVE_LOG_LEVEL = 'ERROR';
process.env.PROTON_DRIVE_BASE_URL = 'drive-api.proton.me';
let quitting=false;
process.umask(0o077);
await mkdir(dataRoot, { recursive: true, mode: 0o700 });
const csrf = randomBytes(32).toString('hex');
const app = await init({ appVersion: 'external-drive-nube_local@0.16.1-alpha', clientUidPrefix: 'nube_local', enableMetrics: false, enableConsoleLog: false, enablePersistedEvents: false });
const testing=process.env.NUBE_LOCAL_TEST_MODE==='1';
const releaseUpdater=new ReleaseUpdater(dataRoot,'0.16.1');await releaseUpdater.init();
const restoredSettings=await recoverSettingsImport(dataRoot);const cloudSafety=new CloudSafety(e=>activity.record('cloud',e)),runHealth=new RunHealth(dataRoot);
let preferences=await loadPreferences(dataRoot);
let localRoot=testing?process.env.NUBE_LOCAL_TEST_FOLDER||preferences.localRoot:preferences.localRoot;
const hostScript=path.join(process.env.NUBE_LOCAL_APP??path.resolve(path.dirname(process.execPath),'..'),'src/system-settings.py');
async function host(...args:string[]){const proc=Bun.spawn(['/usr/bin/python3',hostScript,...args],{stdout:'pipe',stderr:'pipe',env:{...process.env,NUBE_LOCAL_DATA:dataRoot}});const [output]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text()]);await proc.exited;let result:any;try{result=JSON.parse(output);}catch{throw new Error('No se pudo completar la operación de escritorio. Abre la aplicación desde tu sesión de Linux.');}if(result.error)throw new Error(result.error);return result;}
const activity=new ActivityLog(dataRoot);await activity.importPrevious();activity.record('system',{kind:'app-start',result:'correcto',detail:'Proton Drive 0.16.1'});const recentFolders=new RecentFolders(dataRoot);await recentFolders.init();const documentPreview=new DocumentPreview(dataRoot,path.join(path.dirname(hostScript),'preview-render.py'));const diskChecks=new DiskDiagnostics(dataRoot);await diskChecks.init();const cloudRecovery=new CloudRecovery(app.sdk);let diskTestController:AbortController|null=null,diskTestTask:Promise<void>|null=null;let diskTestState:any={phase:'idle',message:'Conecta una unidad para realizar las pruebas físicas.'};
let settingsImportRevision=0;
const makeEngine=()=>{cloudSafety.clear();return new FolderSync(app.sdk,dataRoot,localRoot,{...preferences,batchLimit:Number.MAX_SAFE_INTEGER,review:snapshot=>cloudSafety.check(snapshot),onEvent:e=>activity.record('cloud',e),resetRemoteCache:app.clearCaches,remoteRootUid:testing?process.env.NUBE_LOCAL_TEST_REMOTE_ROOT:undefined});};
let folderSync=makeEngine();await folderSync.prepareView();
const organizer=new FolderOrganizer(dataRoot,e=>activity.record('duplicates',e));
const duplicates=new DuplicateFinder(undefined,200000,dataRoot,undefined,e=>activity.record('duplicates',e));await duplicates.recover();let chosenDuplicateFolder:string|null=null;let chosenOrganizerFolder:string|null=null;let documentWriteTask:Promise<void>|null=null;let documentPausedCloud=false;
const externalSync=new ExternalSync(dataRoot,()=>localRoot,e=>activity.record('external',e));await externalSync.init();
let system:any={metered:'unknown',autostart:preferences.autostart};
let meteredPaused=false,networkChecking=false,desiredEnabled=false;
let chosenExternalSource:{relative:string,revision:number}|null=null;let chosenFolder:string|null=null;let chosenExternalFolder:string|null=null;
async function checkNetwork(force=false){if(quitting||desktopEjecting||networkChecking||testing||(!force&&(busy||authTask)))return;networkChecking=true;try{system=await host('--status');const decision=networkDecision(folderSync.active,meteredPaused,desiredEnabled,preferences.pauseMetered,system.metered);if(decision==='pause'){desiredEnabled=true;await folderSync.stop(false);meteredPaused=true;}else if(decision==='resume'&&app.auth.isLoggedIn()){meteredPaused=false;await folderSync.start();}
 }catch{}finally{networkChecking=false;}}
function networkBlocked(){return preferences.pauseMetered&&(system.metered==='metered'||(meteredPaused&&system.metered==='unknown'));}
let busy = false;let desktopEjecting=false;let resumeCloudAfterEject=false;
let loginUrl: string | null = null;
let message = app.auth.isLoggedIn() ? 'Cuenta conectada. Puedes usar tu carpeta local.' : 'Preparado. Conecta tu cuenta para probar el acceso real.';
let authTask: Promise<void> | null = null;
const page=panel(csrf,localRoot);
function respond(value: unknown, status = 200) { return Response.json(value, {status,headers:{'Cache-Control':'no-store'}}); }
function safeError(error:any){console.error('Operación:',error?.name??'Error');return error?.httpStatus?error.message:errorDetails(error).message;}
async function runOperation(kind: string) {
  busy = true;
  try {
    if (!app.auth.isLoggedIn()) throw new Error('Inicia sesión primero');
    const root = await app.sdk.getMyFilesRootFolder();
    if (kind === 'list') {
      const names: string[] = [];
      for await (const node of app.sdk.iterateFolderChildren(root.uid)) names.push(node.name.ok ? node.name.value : '[Nombre no disponible]');
      message = 'Conexión confirmada. Archivos en la raíz:\n' + (names.join('\n') || '(vacía)');
    } else {
      const folderName = 'Nube Local - prueba ' + new Date().toISOString().replace(/[:.]/g,'-');
      const folder = await app.sdk.createFolder(root.uid, folderName);
      message = 'Carpeta de prueba creada. Subiendo archivo…';
      const bytes = new TextEncoder().encode('Prueba de Nube Local: ' + randomBytes(16).toString('hex') + '\n');
      const uploader = await app.sdk.getFileUploader(folder.uid, 'prueba.txt', {mediaType:'text/plain', expectedSize: bytes.length, expectedSha1: createHash('sha1').update(bytes).digest('hex')});
      const upload = await uploader.uploadFromStream(new Blob([bytes]).stream(), []);
      const { nodeUid } = await upload.completion();
      message = 'Subida completada. Descargando y verificando…';
      const downloader = await app.sdk.getFileDownloader(nodeUid);
      const chunks: Uint8Array[] = [];
      const writable = new WritableStream<Uint8Array>({write(chunk){ chunks.push(new Uint8Array(chunk)); }});
      await downloader.downloadToStream(writable).completion();
      const downloaded = Buffer.concat(chunks);
      if (!downloaded.equals(Buffer.from(bytes))) throw new Error('La comparación de contenido falló');
      const localDir = path.join(dataRoot, 'transferencia-verificada');
      await mkdir(localDir, {recursive:true});
      await writeFile(path.join(localDir, 'prueba.txt'), downloaded, {mode:0o600});
      message = 'SUBIDA Y DESCARGA VERIFICADAS.\nCarpeta en la nube: '+folderName+'\nArchivo local: '+path.join(localDir,'prueba.txt')+'\nEl contenido descargado coincide exactamente. La carpeta de prueba se conserva en la nube.';
    }
  } catch(error) { message = safeError(error); }
  finally { busy = false; }
}
const server = Bun.serve({hostname:'127.0.0.1',port: Number(process.env.NUBE_LOCAL_PORT ?? 47831),idleTimeout:30,maxRequestBodySize:65536,async fetch(req) {
  const url = new URL(req.url);
  if (req.headers.get('host') !== '127.0.0.1:'+server.port) return new Response('Host no permitido',{status:403});
  if (url.pathname === '/' && req.method === 'GET') return new Response(page,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",'X-Content-Type-Options':'nosniff'}});
  if (req.headers.get('X-Nube-Token') !== csrf) return respond({error:'Acceso denegado'},403);
  if (req.headers.has('origin') && req.headers.get('origin') !== url.origin) return respond({error:'Origen no permitido'},403);
  if (url.pathname === '/state' && req.method === 'GET') {let updateResult:any=null;try{updateResult=JSON.parse(await readFile(path.join(dataRoot,'update-result.json'),'utf8'));}catch{}const state:any={syncTemporarilyPaused:!!documentWriteTask&&documentPausedCloud&&desiredEnabled&&!folderSync.active,updates:releaseUpdater.view(),settingsImportRevision,runHealth:runHealth.view(),cloudSafety:cloudSafety.view(),activity:activity.view(),recentFolders:recentFolders.view(),cloudRecovery:cloudRecovery.view(),diskChecks:{...diskChecks.view(),task:diskTestState},organizer:organizer.view(),duplicates:duplicates.view(),chosenDuplicateFolder,chosenOrganizerFolder,external:externalSync.view(),chosenExternalFolder,chosenExternalSource,updateResult,message,loginUrl,busy:busy||desktopEjecting,version:'0.16.1',preferences,system,meteredPaused,chosenFolder,localRoot,...folderSync.view(),connected:app.auth.isLoggedIn(),syncActive:folderSync.active,syncStatus:folderSync.status};return respond({...state,alerts:taskAlerts(state)});}
  if(url.pathname==='/activity'&&req.method==='GET')return respond(activity.list(url.searchParams.get('source')??'all',url.searchParams.get('query')??'',Number(url.searchParams.get('page')??0),url.searchParams.get('result')??'all'));
  if(url.pathname==='/duplicates/preview'&&req.method==='GET'){try{const snapshot=await duplicates.previewSource(url.searchParams.get('groupId')??'',url.searchParams.get('fileId')??'');const result=await documentPreview.render(snapshot,Number(url.searchParams.get('page')??1));if(result.kind==='image')return new Response(Buffer.from(result.data,'base64'),{headers:{'Content-Type':'image/png','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Preview-Page':String(result.page),'X-Preview-Pages':String(result.pages)}});return respond(result);}catch(e:any){return respond({error:e.message},400);}}
  if(url.pathname==='/organizer/entries'&&req.method==='GET')return respond(organizer.entries(Number(url.searchParams.get('page')??0),url.searchParams.get('query')??''));
  if(url.pathname==='/duplicates/results'&&req.method==='GET')return respond(duplicates.results(Number(url.searchParams.get('page')??0),url.searchParams.get('sort')??'size',(url.searchParams.get('query')??'').slice(0,500),url.searchParams.get('memberGroup')??'',Number(url.searchParams.get('memberPage')??0)));
  if (req.method !== 'POST') return respond({},405);
  if(url.pathname==='/quit') {if(quitting)return respond({ok:true});quitting=true;organizer.requestStop();setTimeout(async()=>{server.stop(true);await releaseUpdater.close();cloudRecovery.cancel();diskTestController?.abort();await diskTestTask;await duplicates.shutdown();await documentPreview.close();await documentWriteTask;await organizer.close();await externalSync.close();await folderSync.suspend();activity.close();await app.dispose();await runHealth.finish().catch(()=>{});process.exit(0);},100);return respond({ok:true});}
  if(url.pathname==='/pause'){cloudSafety.cancelApproval();desiredEnabled=false;meteredPaused=false;await folderSync.stop();message='Sincronización pausada.';return respond({ok:true});}
  if(url.pathname==='/external/eject'){
    if(desktopEjecting||externalSync.view().ejecting)return respond({error:'El disco ya se está desmontando.'},409);
    desktopEjecting=true;duplicates.requestStop();organizer.requestStop();void (async()=>{diskTestController?.abort();await diskTestTask;await documentWriteTask;await duplicates.wait();await organizer.wait();return await externalSync.eject(config=>host('--eject',config.target,config.pairId,config.volume,localRoot));})().then(result=>{message=result.message;}).catch(e=>{message='No se pudo expulsar el disco: '+e.message;}).finally(async()=>{duplicates.releaseStop();organizer.releaseStop();desktopEjecting=false;if(resumeCloudAfterEject&&!quitting){resumeCloudAfterEject=false;await checkNetwork(true);if(desiredEnabled&&!networkBlocked())void folderSync.start().catch(e=>{message=safeError(e);});}});return respond({ok:true},202);
  }
  if(url.pathname==='/external/test-cancel'){diskTestController?.abort();return respond({ok:true});}
  if(url.pathname==='/updates/cancel'){releaseUpdater.cancel();return respond({ok:true});}
  if(url.pathname==='/organizer/cancel'){organizer.cancel();return respond({ok:true});}
  if(url.pathname==='/duplicates/cancel'){duplicates.cancel();return respond({ok:true});}
  if (busy || desktopEjecting || authTask) return respond({error:'Operación en curso'},409);
  if(url.pathname==='/updates/check'||url.pathname==='/updates/download'||url.pathname==='/updates/configure'||url.pathname==='/updates/install'){
    try{const body=await req.json();if(url.pathname==='/updates/configure'){await releaseUpdater.configure(body.enabled);return respond({ok:true});}if(url.pathname==='/updates/check'){void releaseUpdater.check().catch(()=>{});return respond({ok:true},202);}if(url.pathname==='/updates/download'){void releaseUpdater.download(body.id).catch(()=>{});return respond({ok:true},202);}const item=await releaseUpdater.installSnapshot(body.id);busy=true;void host('--install-downloaded',item.file,item.sha256,item.version).then(result=>{message=result.cancelled?'Selección cancelada.':'Instalando actualización desde GitHub; la aplicación se reiniciará.';}).catch(e=>{message='No se pudo instalar la actualización: '+e.message;}).finally(()=>{busy=false;});return respond({ok:true},202);}catch(e:any){return respond({error:e.message},400);}
  }
  if(url.pathname==='/organizer/prepare'||url.pathname==='/organizer/recommend'||url.pathname==='/organizer/undo-preview'){
    let input:any,root:string|undefined;try{input=await req.json();if(url.pathname!=='/organizer/undo-preview'){if(!['proton','chosen','recent'].includes(input?.scope))throw new Error('Carpeta no válida');root=input.scope==='proton'?localRoot:input.scope==='recent'?recentFolders.get(input.id):chosenOrganizerFolder;if(!root||root==='/'||root===homedir())throw new Error('Elige una carpeta de documentos, no la carpeta completa del usuario.');}}catch(e:any){return respond({error:e.message||'Petición no válida'},400);}
    busy=true;void(async()=>{if(root){if(url.pathname==='/organizer/recommend')await organizer.recommend(root,input);else await organizer.prepare(root,input);await recentFolders.remember(root);}else await organizer.prepareUndo();})().catch(e=>{message='No se pudo preparar la organización: '+e.message;}).finally(()=>{busy=false;});return respond({ok:true},202);
  }
  if(url.pathname==='/organizer/apply'){
    let body:any;try{body=await req.json();if(!/^[a-f0-9]{64}$/.test(body?.id??'')||organizer.view().plan?.id!==body.id)throw new Error('Genera y revisa otra vista previa.');organizer.validateSelection(body.id,body.selectedIds);}catch(e:any){return respond({error:e.message},400);}
    busy=true;const wasActive=folderSync.active;documentPausedCloud=wasActive;duplicates.requestStop();documentWriteTask=(async()=>{let resume:(()=>void)|undefined;try{await duplicates.wait();await folderSync.suspend();resume=await externalSync.pauseForDocuments();await organizer.apply(body.id,body.selectedIds);message=organizer.view().message;}catch(e:any){message='Organización detenida: '+e.message;}finally{duplicates.invalidate();duplicates.releaseStop();if(!quitting&&!desktopEjecting)resume?.();if(desktopEjecting&&wasActive)resumeCloudAfterEject=true;await checkNetwork(true);if(!quitting&&!desktopEjecting&&wasActive&&desiredEnabled&&!networkBlocked())await folderSync.start().catch(()=>{});busy=false;}})().finally(()=>{documentWriteTask=null;documentPausedCloud=false;});return respond({ok:true},202);
  }
  if(url.pathname==='/cloud/approve'){
    try{const body=await req.json();if(!folderSync.active||networkBlocked())throw Error('Activa la sincronización antes de revisar los cambios.');cloudSafety.approve(body.id);busy=true;void folderSync.now().finally(()=>{busy=false;});return respond({ok:true},202);}catch(e:any){return respond({error:e.message},400);}
  }
  if(url.pathname==='/settings/export'){
    let bundle:any;try{bundle=exportSettings(preferences,organizer.view().settings,externalSync.view().config);}catch(e:any){return respond({error:e.message},400);}busy=true;void host('--export-settings',JSON.stringify(bundle)).then(r=>{message=r.cancelled?'Selección cancelada.':'Copia de ajustes guardada, sin sesión ni contraseñas.';}).catch(e=>{message='No se pudieron exportar los ajustes: '+e.message;}).finally(()=>{busy=false;});return respond({ok:true},202);
  }
  if(url.pathname==='/settings/import'){
    busy=true;void(async()=>{const result=await host('--import-settings');if(result.cancelled){message='Selección cancelada.';return;}if(quitting||desktopEjecting)throw Error('La aplicación está cerrándose o expulsando el disco. Inténtalo después.');const next=importSettings(result.bundle,localRoot);desiredEnabled=false;meteredPaused=false;documentPausedCloud=folderSync.active;documentWriteTask=(async()=>{await folderSync.suspend();await externalSync.pauseForDocuments();await stageSettingsImport(dataRoot,next);try{await host('--autostart',String(next.preferences.autostart));await folderSync.dispose();await externalSync.reloadDisabled();organizer.reloadSettings();preferences=next.preferences;folderSync=makeEngine();await folderSync.prepareView();desiredEnabled=false;meteredPaused=false;await commitSettingsImport(dataRoot);settingsImportRevision++;chosenFolder=null;chosenExternalFolder=null;message='Ajustes importados. La carpeta local se conserva; nube y disco quedan pausados. Revisa antes de activar.';}catch(e){await recoverSettingsImport(dataRoot);preferences=await loadPreferences(dataRoot);await host('--autostart',String(preferences.autostart));await externalSync.reloadDisabled();organizer.reloadSettings();folderSync=makeEngine();await folderSync.prepareView();await writeFile(path.join(dataRoot,'sync-enabled.json'),JSON.stringify({enabled:false}),{mode:0o600});throw e;}})().finally(()=>{documentWriteTask=null;documentPausedCloud=false;});await documentWriteTask;})().catch(e=>{message='No se pudieron importar los ajustes: '+e.message;}).finally(()=>{busy=false;});return respond({ok:true},202);
  }
  if(url.pathname==='/update/rollback'){
    busy=true;void host('--rollback').then(r=>{message=r.cancelled?'Selección cancelada.':'Volviendo a la aplicación anterior…';}).catch(e=>{message='No se pudo volver a la versión anterior: '+e.message;}).finally(()=>{busy=false;});return respond({ok:true},202);
  }
  if(url.pathname==='/duplicates/forget-folder'){try{const body=await req.json();await recentFolders.forget(body.id);return respond({ok:true});}catch{return respond({error:'Carpeta no válida'},400);}}
  if(url.pathname==='/recovery/local-trash'){try{await host('--open-trash');return respond({ok:true});}catch{return respond({error:'No se pudo abrir la papelera de Linux.'},500);}}
  if(url.pathname==='/recovery/cloud-list'){if(!app.auth.isLoggedIn())return respond({error:'Conecta la cuenta de Proton.'},400);void cloudRecovery.refresh().catch(e=>{message=e.message;});return respond({ok:true},202);}
  if(url.pathname==='/recovery/cloud-restore'){
    let body:any;try{body=await req.json();}catch{return respond({error:'Petición no válida'},400);}if(!/^[a-f0-9]{48}$/.test(body?.id??''))return respond({error:'Elemento no válido'},400);
    busy=true;const wasActive=folderSync.active;documentPausedCloud=wasActive;documentWriteTask=(async()=>{let resume:(()=>void)|undefined;try{await folderSync.suspend();resume=await externalSync.pauseForDocuments();const name=await cloudRecovery.restore(body.id);activity.record('cloud',{kind:'restore-cloud',path:name,result:'correcto'});message='Elemento restaurado de la papelera de Proton.';}catch(e:any){message='No se pudo restaurar: '+e.message;activity.record('cloud',{kind:'restore-cloud',result:'fallo',detail:e.message});}finally{if(!quitting&&!desktopEjecting)resume?.();if(desktopEjecting&&wasActive)resumeCloudAfterEject=true;await checkNetwork(true);if(!quitting&&!desktopEjecting&&wasActive&&desiredEnabled&&!networkBlocked())await folderSync.start().catch(()=>{});busy=false;}})().finally(()=>{documentWriteTask=null;documentPausedCloud=false;});return respond({ok:true},202);
  }
  if(url.pathname==='/external/manual-check'){try{const body=await req.json();await diskChecks.manual(body.id,body.status,body.note??'');activity.record('external',{kind:'manual-check',path:body.id,result:body.status==='fail'?'fallo':body.status==='pass'?'correcto':'aviso',detail:'Marcado manualmente: '+(body.note??'')});return respond({ok:true});}catch(e:any){return respond({error:e.message},400);}}
  if(url.pathname==='/external/test'){
    let body:any;try{body=await req.json();}catch{return respond({error:'Petición no válida'},400);}if(![16,256,1024].includes(body?.sizeMiB))return respond({error:'Tamaño de prueba no válido'},400);
    busy=true;diskTestController=new AbortController();diskTestState={phase:'running',message:'Prueba temporal de escritura, lectura y renombrado en curso…'};
    diskTestTask=(async()=>{let resume:(()=>void)|undefined;try{const context=await externalSync.diagnosticContext();resume=context.resume;const result=await testDisk(context.pair.target,context.guard,body.sizeMiB,diskTestController!.signal);await diskChecks.saveRun({...result,filesystem:(context.pair as any).filesystem??'no identificado',target:context.pair.target});diskTestState={phase:result.status==='pass'?'complete':'warning',message:result.status==='pass'?'Prueba temporal completada; se han retirado sus archivos.':result.note};activity.record('external',{kind:'disk-test',result:result.status==='pass'?'correcto':'aviso',detail:body.sizeMiB+' MiB; lectura y escritura verificadas'});}catch(e:any){diskTestState={phase:e.name==='AbortError'?'cancelled':'error',message:e.name==='AbortError'?'Prueba cancelada; los documentos se conservan.':e.message};await diskChecks.saveRun({time:new Date().toISOString(),method:'temporary-files',status:'fail',sizeMiB:body.sizeMiB,note:e.message}).catch(()=>{});activity.record('external',{kind:'disk-test',result:'fallo',detail:e.message});}finally{if(!quitting&&!desktopEjecting)resume?.();busy=false;diskTestController=null;}})().finally(()=>{diskTestTask=null;});return respond({ok:true},202);
  }
  if(url.pathname==='/organizer/choose'){busy=true;void host('--organizer-folder',chosenOrganizerFolder||localRoot).then(result=>{if(result.folder)chosenOrganizerFolder=result.folder;message=result.cancelled?'Selección cancelada.':'Carpeta seleccionada para organizar. Prepara una vista previa antes de mover archivos.';}).catch(e=>{message='No se pudo elegir la carpeta: '+e.message;}).finally(()=>{busy=false;});return respond({ok:true},202);}
  if(url.pathname==='/duplicates/choose'){
    busy=true;void host('--duplicates-folder',chosenDuplicateFolder||localRoot).then(result=>{if(result.folder)chosenDuplicateFolder=result.folder;message=result.cancelled?'Selección cancelada.':'Carpeta seleccionada. Pulsa Buscar duplicados para analizarla.';}).catch(e=>{message='No se pudo elegir la carpeta: '+e.message;}).finally(()=>{busy=false;});return respond({ok:true},202);
  }
  if(url.pathname==='/duplicates/scan'){
    try{const input=await req.json();if(!['proton','chosen','recent'].includes(input?.scope))return respond({error:'Carpeta no válida'},400);const root=input.scope==='proton'?localRoot:input.scope==='recent'?recentFolders.get(input.id):chosenDuplicateFolder;if(!root)throw new Error('Elige primero una carpeta.');if(root==='/'||root===homedir())throw new Error('Elige una carpeta de documentos, no la raíz ni la carpeta completa del usuario.');await duplicates.start(root);await recentFolders.remember(root);return respond({ok:true},202);}catch(e:any){return respond({error:e.message},400);}
  }
  if(url.pathname==='/duplicates/reveal'){
    try{const body=await req.json();const file=await duplicates.reveal(body.groupId,body.fileId);await host('--reveal',file);return respond({ok:true});}catch(e:any){return respond({error:e.message},400);}
  }
  if(url.pathname==='/duplicates/trash'||url.pathname==='/duplicates/recover'){
    let body:any;try{body=await req.json();}catch{return respond({error:'Petición no válida'},400);}if(url.pathname==='/duplicates/trash'&&(!/^[a-f0-9]{64}$/.test(body?.groupId??'')||!Array.isArray(body?.removeIds)||body.removeIds.length<1||body.removeIds.length>100||!body.removeIds.every((id:any)=>typeof id==='string'&&/^[a-f0-9]{48}$/.test(id))||typeof body.keepId!=='string'||!/^[a-f0-9]{48}$/.test(body.keepId)||body.removeIds.includes(body.keepId)))return respond({error:'Selección no válida: conserva al menos una copia.'},400);
    busy=true;const cloudWasActive=folderSync.active;documentPausedCloud=cloudWasActive;
    documentWriteTask=(async()=>{let resumeExternal:(()=>void)|undefined;try{await folderSync.suspend();resumeExternal=await externalSync.pauseForDocuments();if(url.pathname==='/duplicates/recover')await duplicates.recover();else await duplicates.remove(body.groupId,body.keepId,body.removeIds);message=url.pathname==='/duplicates/recover'?'Registro de traslados revisado. Consulta el aviso en Duplicados.':'Copias seleccionadas enviadas a la papelera.';}catch(e:any){message='No se pudo completar la operación de duplicados: '+e.message;}finally{if(!quitting&&!desktopEjecting)resumeExternal?.();if(desktopEjecting&&cloudWasActive)resumeCloudAfterEject=true;await checkNetwork(true);if(!quitting&&!desktopEjecting&&cloudWasActive&&desiredEnabled&&!networkBlocked())await folderSync.start().catch(e=>{message=safeError(e);});busy=false;}})().catch(e=>{message='No se pudo completar la operación de duplicados: '+e.message;busy=false;}).finally(()=>{documentWriteTask=null;documentPausedCloud=false;});return respond({ok:true},202);
  }
  if(url.pathname==='/external/choose-source'){
    busy=true;void host('--folder',localRoot).then(async result=>{if(result.cancelled){message='Selección cancelada.';return;}if(result.folder){const root=await realpath(localRoot),selected=await realpath(result.folder),relative=path.relative(root,selected);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Elige ProtonDrive o una carpeta dentro de ProtonDrive.');chosenExternalSource={relative,revision:(chosenExternalSource?.revision??0)+1};message='Carpeta seleccionada. Guarda los ajustes del disco para aplicarla.';}}).catch(e=>{message='No se pudo elegir la carpeta: '+e.message;}).finally(()=>{busy=false;});return respond({ok:true},202);
  }
  if(url.pathname==='/external/choose'){
    busy=true;void host('--external-folder').then(result=>{if(result.folder)chosenExternalFolder=result.folder;message=result.cancelled?'Selección cancelada.':'Carpeta seleccionada. Guarda los ajustes del disco para vincularlo.';}).catch(e=>{message='No se pudo elegir la carpeta: '+e.message;}).finally(()=>{busy=false;});return respond({ok:true},202);
  }
  if(url.pathname==='/external/settings'){
    try{const input=await req.json();await externalSync.configure(input);chosenExternalFolder=null;return respond({ok:true});}catch(e:any){return respond({error:e.message},400);}
  }
  if(['/external/sync','/external/apply','/external/resume','/external/resolve','/external/rebuild'].includes(url.pathname)){
    let body:any={};if(url.pathname==='/external/apply'){try{body=await req.json();}catch{return respond({error:'Petición no válida'},400);}if(!/^[a-f0-9]{64}$/.test(body.id??''))return respond({error:'Vista previa no válida'},400);}
    if(url.pathname==='/external/resolve'){try{body=await req.json();}catch{return respond({error:'Petición no válida'},400);}if(!/^[a-f0-9]{64}$/.test(body.id??'')||!['local','remote','both'].includes(body.choice))return respond({error:'Selección no válida'},400);}
    busy=true;void (url.pathname==='/external/sync'?externalSync.now():url.pathname==='/external/apply'?externalSync.apply(body.id):url.pathname==='/external/resume'?externalSync.resume():url.pathname==='/external/rebuild'?externalSync.rebuild():externalSync.resolve(body.id,body.choice)).catch(e=>{message='No se pudo completar la sincronización externa: '+e.message;}).finally(()=>{busy=false;});return respond({ok:true},202);
  }
  if(networkBlocked()&&['/resolve','/rebuild','/roundtrip'].includes(url.pathname))return respond({error:'La sincronización está pausada por la conexión de uso medido. Cambia de red o desactiva esa opción en Ajustes.'},409);
  if(url.pathname==='/settings'){
    let next:any;try{next=validatePreferences(await req.json());await validateFolder(next.localRoot,dataRoot,localRoot);}catch(e:any){return respond({error:e.message},400);}
    busy=true;
    const previous=preferences,wasActive=folderSync.active||meteredPaused;
    try{
      await host('--autostart',String(next.autostart));
      await folderSync.dispose();await savePreferences(dataRoot,next);preferences=next;localRoot=next.localRoot;chosenFolder=null;folderSync=makeEngine();await externalSync.localRootChanged();
      desiredEnabled=wasActive;meteredPaused=wasActive&&networkBlocked();
      message='Configuración guardada. '+(previous.localRoot!==localRoot?'La carpeta anterior se conserva; la nueva se combinará sin propagar borrados anteriores.':'');
      if(wasActive&&!meteredPaused)void folderSync.start().catch(e=>{message=safeError(e);}).finally(()=>{busy=false;});else busy=false;
      return respond({ok:true},202);
    }catch(e:any){busy=false;try{await host('--autostart',String(previous.autostart));await savePreferences(dataRoot,previous);preferences=previous;localRoot=previous.localRoot;folderSync=makeEngine();if(wasActive&&!networkBlocked())void folderSync.start().catch(()=>{});}catch{}return respond({error:safeError(e)},500);}
  }
  if(url.pathname==='/open-folder'){try{await host('--open-folder',localRoot);return respond({ok:true});}catch{return respond({error:'No se pudo abrir la carpeta.'},500);}}
  if(url.pathname==='/choose-folder'||url.pathname==='/update'){
    busy=true;message=url.pathname==='/update'?'Selecciona el instalador en la ventana del escritorio.':'Selecciona una carpeta en la ventana del escritorio.';
    void host(url.pathname==='/update'?'--update':'--folder',chosenFolder||localRoot).then(result=>{if(result.folder)chosenFolder=result.folder;message=result.updating?'Instalando actualización; la aplicación se reiniciará.':result.cancelled?'Selección cancelada.':'Carpeta seleccionada. Pulsa Guardar ajustes para aplicarla.';}).catch(e=>{message='No se pudo completar la operación: '+e.message;}).finally(()=>{busy=false;});
    return respond({ok:true},202);
  }
  if(url.pathname==='/resolve'){
    let body:any;try{body=await req.json();}catch{return respond({error:'Petición no válida'},400);}
    if(!/^[a-f0-9]{64}$/.test(body?.id??'')||!['local','remote','both'].includes(body?.choice))return respond({error:'Selección no válida'},400);
    busy=true;message='Resolviendo el conflicto seleccionado…';
    void folderSync.resolveConflict(body.id,body.choice).then(()=>{message='Conflicto resuelto.';}).catch(error=>{message=safeError(error);}).finally(()=>{busy=false;});
    return respond({ok:true},202);
  }
  if(url.pathname==='/rebuild'){
    busy=true;message='Reconstruyendo la sincronización sin aplicar borrados anteriores…';
    void folderSync.rebuildIndex().then(()=>{message='Índice reconstruido. La sincronización continúa.';}).catch(error=>{message=safeError(error);}).finally(()=>{busy=false;});
    return respond({ok:true},202);
  }
  if (url.pathname === '/sync' || url.pathname === '/pause') {
    busy=true;
    void (async()=> {try {if(!app.auth.isLoggedIn()) throw new Error('Inicia sesión primero');if(url.pathname==='/pause') await folderSync.stop();else {desiredEnabled=true;await checkNetwork(true);if(networkBlocked()){meteredPaused=true;await writeFile(path.join(dataRoot,'sync-enabled.json'),JSON.stringify({enabled:true}));message='Pausada en conexión de uso medido.';return;}await folderSync.now();}message='Consulta el estado de la carpeta arriba.';}catch(error){message=safeError(error);}finally{busy=false;}})();
    return respond({ok:true});
  }
  if (url.pathname === '/login') {
    if(app.auth.isLoggedIn() && folderSync.lastError?.kind!=='auth'){message='La cuenta ya está conectada.';return respond({ok:true});}
    if(folderSync.lastError?.kind==='auth'){await folderSync.stop(false);await app.auth.logout();await app.clearCaches();}
    message='Preparando el inicio de sesión…';
    authTask = app.auth.authViaWeb(url => {loginUrl=url;message='Pulsa «Continuar en Proton» y completa allí el inicio de sesión.';}).then(async()=>{message='Sesión iniciada. Activando sincronización…';desiredEnabled=true;await checkNetwork(true);if(networkBlocked()){meteredPaused=true;await writeFile(path.join(dataRoot,'sync-enabled.json'),JSON.stringify({enabled:true}));}else await folderSync.start();}).catch(error=>{message=safeError(error);}).finally(()=>{loginUrl=null;authTask=null;});
    return respond({ok:true});
  }
  if (url.pathname === '/list' || url.pathname === '/roundtrip') {void runOperation(url.pathname.slice(1));return respond({ok:true});}
  return respond({},404);
}});
await runHealth.start();if(runHealth.view().uncleanPrevious)activity.record('system',{kind:'recovery-start',result:'aviso',detail:'La sesión anterior terminó sin cierre limpio. Se revalidan el índice y las operaciones antes de continuar.'});if(restoredSettings)activity.record('system',{kind:'settings-recovery',result:'aviso',detail:'Se han recuperado los ajustes anteriores a una importación interrumpida.'});
try {desiredEnabled=!!JSON.parse(await readFile(path.join(dataRoot,'sync-enabled.json'),'utf8')).enabled;await checkNetwork();if(app.auth.isLoggedIn()&&desiredEnabled){if(networkBlocked())meteredPaused=true;else await folderSync.start();}}catch(error:any){if(error.code!=='ENOENT')message=safeError(error);}
setInterval(()=>{void checkNetwork();if(!testing&&!quitting&&!busy&&!networkBlocked()&&releaseUpdater.due())void releaseUpdater.check().catch(()=>{});},15000);
console.log('Nube Local: http://127.0.0.1:'+server.port);
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,async()=>{if(quitting)return;quitting=true;organizer.requestStop();server.stop(true);await releaseUpdater.close();cloudRecovery.cancel();diskTestController?.abort();await diskTestTask;await duplicates.shutdown();await documentPreview.close();await documentWriteTask;await organizer.close();await externalSync.close();await folderSync.suspend();activity.close();await app.dispose();await runHealth.finish().catch(()=>{});process.exit(0);});
