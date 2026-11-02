/** Linux atomic rename without replacing another path; works on FAT/NTFS too. */
export async function renameNoReplace(from:string,to:string){
 const code="import ctypes,os,sys;lib=ctypes.CDLL(None,use_errno=True);f=lib.renameat2;f.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];r=f(-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),1);sys.exit(ctypes.get_errno() if r else 0)";
 const child=Bun.spawn(['/usr/bin/python3','-c',code,from,to],{stdout:'ignore',stderr:'ignore'});const status=await child.exited;
 if(status)throw Object.assign(new Error('No se pudo mover el archivo sin sobrescribir otro.'),{code:status===17?'EEXIST':status===28?'ENOSPC':'CHANGED'});
}
