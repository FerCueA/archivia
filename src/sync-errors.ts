export function errorDetails(error:any) {
 let item=error;const codes:string[]=[],statuses:number[]=[],names:string[]=[];
 for(let i=0;item && i<5;i++,item=item.cause){if(item.code)codes.push(String(item.code));if(item.name)names.push(item.name);const s=item.httpCode??item.httpStatus??item.status??item.response?.status;if(s)statuses.push(Number(s));}
 let kind='unknown',message='No se pudo completar la operación. Tus archivos se conservan.',retryable=false;
 if(names.includes('AbortError')||codes.includes('ABORT_ERR')){kind='cancelled';message='Operación interrumpida; se reanudará al activar la sincronización.';}
 else if(codes.includes('REVIEW_CHANGED')){kind='review';message='Los archivos han cambiado desde la vista previa. Revisa el nuevo listado antes de aplicar.';}
 else if(codes.includes('DISK_OFFLINE')){kind='external';message='Disco externo desconectado. No se aplican borrados.';}
 else if(codes.includes('MASS_DELETE')){kind='mass-delete';message='Se han detectado muchos borrados. Revisa las carpetas o vuelve a comparar sin aplicar borrados anteriores.';}
 else if(statuses.includes(401)||names.some(n=>/Unauthenticated|Authentication/.test(n))){kind='auth';message='La sesión necesita volver a conectarse. Pulsa Conectar cuenta.';}
 else if(codes.includes('ENOSPC')){kind='disk';message='No queda espacio suficiente en el disco. Libera espacio y pulsa Reintentar.';}
 else if(codes.some(c=>['EACCES','EPERM','EROFS'].includes(c))||statuses.includes(403)){kind='permission';message='No hay permiso para escribir en la carpeta o el disco es de solo lectura.';}
 else if(names.some(n=>/Integrity|Signature/.test(n))||codes.includes('INTEGRITY')){kind='integrity';message='La comprobación de integridad no ha pasado. No se ha reemplazado el archivo local.';}
 else if(codes.includes('STATE_CORRUPT')||names.some(n=>/SQLite/.test(n))){kind='index';message='No se puede leer el índice. No se aplicarán borrados; revisa o reconstruye la sincronización.';}
 else if(codes.some(c=>['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENETUNREACH','ENETDOWN','EAI_AGAIN','ENOTFOUND'].includes(c))||statuses.some(s=>s===429||s>=500)||names.some(n=>/FetchError|Timeout|Network/.test(n))){kind='network';message='La conexión no está disponible o el servidor pide esperar. Se reintentará automáticamente.';retryable=true;}
 else if(codes.some(c=>['CHANGED','ENOENT','EEXIST'].includes(c)) || statuses.some(s=>s===404||s===409)){kind='changed';message='El archivo ha cambiado durante la operación; se volverá a comparar.';retryable=true;}
 return {kind,message,retryable,code:codes[0]??names[0]??'Error',status:statuses[0]??null};
}
