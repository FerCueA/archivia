#!/usr/bin/env python3
"""Stable launcher kept outside app/, including recovery of interrupted version swaps."""
import json,os,sys,time,fcntl,hashlib,re
from pathlib import Path

def durable_json(file,value):
    temp=file.with_name(file.name+'.swap-tmp')
    with temp.open('w') as out:os.chmod(temp,0o600);json.dump(value,out);out.flush();os.fsync(out.fileno())
    temp.replace(file);sync_dir(file.parent)

def sync_dir(root):
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)

def valid(folder):
    if folder.is_symlink() or not folder.is_dir() or any((folder/p).is_symlink() for p in ['src','bin']):return False
    if not all((folder/p).is_file() and not (folder/p).is_symlink() for p in ['bin/nube-local-service','src/launcher.py','release.json']):return False
    try:
        release=json.loads((folder/'release.json').read_text())
        if not re.fullmatch(r'\d+\.\d+\.\d+',release['version']):return False
        expected=release.get('serviceSha256')
        if expected is None:return True
        with (folder/'bin/nube-local-service').open('rb') as binary:return hashlib.file_digest(binary,'sha256').hexdigest()==expected
    except Exception:return False

def recover_swap(root):
    root=Path(root);journal=root/'app-swap.json'
    if not journal.exists():return False
    data=json.loads(journal.read_text());candidates=[]
    for key,prefixes in [('old',('app-previous-',)),('new',('app-previous-','app-staging-'))]:
        name=data.get(key)
        if not isinstance(name,str) or Path(name).name!=name or not name.startswith(prefixes):raise ValueError('Registro de cambio de aplicación no válido.')
        candidates.append(root/name)
    app=root/'app';recovered=False
    if not valid(app):
        candidate=next((p for p in candidates if valid(p)),None)
        if candidate is None:raise ValueError('No hay una aplicación completa para recuperar. Ejecuta el instalador.')
        if app.exists() or app.is_symlink():app.rename(root/('app-invalid-'+str(time.time_ns())))
        candidate.rename(app);sync_dir(root);state=root/'state';state.mkdir(mode=0o700,exist_ok=True);durable_json(state/'sync-enabled.json',{'enabled':False})
        ext=state/'external-sync.json'
        if ext.exists():value=json.loads(ext.read_text());value['enabled']=False;durable_json(ext,value)
        durable_json(state/'update-result.json',{'ok':False,'time':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'message':'Se recuperó la aplicación tras un cambio de versión interrumpido. Documentos e índices conservados; sincronizaciones pausadas.'});recovered=True
    if not (root/'installation.json').exists():durable_json(root/'installation.json',{'name':'Proton Drive','version':json.loads((app/'release.json').read_text())['version']})
    journal.unlink();sync_dir(root)
    return recovered

def launch(root,args):
    root=Path(root)
    for _ in range(600):
        if not (root/'app-swap.json').exists():break
        with (root/'update.lock').open('a') as lock:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:time.sleep(.1);continue
            recover_swap(root);break
    if (root/'app-swap.json').exists():raise RuntimeError('Hay un cambio de versión en curso. Inténtalo de nuevo.')
    if not valid(root/'app'):raise RuntimeError('La aplicación no está completa. Ejecuta el instalador.')
    os.execv(sys.executable,[sys.executable,str(root/'app/src/launcher.py'),*args])

if __name__=='__main__':launch(Path(__file__).resolve().parent,sys.argv[1:])
