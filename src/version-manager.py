#!/usr/bin/env python3
"""Restore a validated local application copy without rolling back user documents or databases."""
import json,os,re,time,subprocess,urllib.request,urllib.error,fcntl
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime,timezone

import importlib.util
_spec=importlib.util.spec_from_file_location('proton_bootstrap',Path(__file__).with_name('bootstrap.py'));bootstrap=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(bootstrap)

@contextmanager
def update_lock(root):
    with (Path(root)/'update.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('Hay otra actualización o restauración en curso.')
        yield

def valid_app(folder):
    if folder.is_symlink() or not folder.is_dir():return False
    for name in ('bin/nube-local-service','src/launcher.py','src/tray.py','release.json'):
        p=folder/name
        if p.is_symlink() or not p.is_file():return False
    if any(p.is_symlink() for p in folder.rglob('*')):return False
    try:return bool(re.fullmatch(r'\d+\.\d+\.\d+',json.loads((folder/'release.json').read_text())['version']))
    except Exception:return False

def previous_apps(root):
    return sorted((p for p in root.glob('app-previous-*') if valid_app(p)),key=lambda p:p.name,reverse=True)

def stop_service():
    requested=False
    # Ask the registered indicator to stop so it cannot restart the old backend.
    try:
        from gi.repository import Gio,GLib
        bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
        def call(dest,obj,interface,method,args=None):return bus.call_sync(dest,obj,interface,method,args,None,0,3000,None).unpack()
        if call('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','NameHasOwner',GLib.Variant('(s)',('app.nube_local.tray',)))[0]:
            Gio.DBusActionGroup.get(bus,'app.nube_local.tray','/app/nube_local/tray').activate_action('quit',None);bus.flush_sync(None);requested=True;time.sleep(.5)
        items=call('org.kde.StatusNotifierWatcher','/StatusNotifierWatcher','org.freedesktop.DBus.Properties','Get',GLib.Variant('(ss)',('org.kde.StatusNotifierWatcher','RegisteredStatusNotifierItems')))[0]
        for registered in items:
            dest,_,obj=registered.partition('/')
            if 'nube_local' not in obj:continue
            props=call(dest,'/'+obj,'org.freedesktop.DBus.Properties','GetAll',GLib.Variant('(s)',('org.kde.StatusNotifierItem',)))[0]
            if props.get('Id')!='nube-local':continue
            menu=props['Menu'];layout=call(dest,menu,'com.canonical.dbusmenu','GetLayout',GLib.Variant('(iias)',(0,-1,[])))[1]
            def find(node):
                ident,props,children=node
                if props.get('label')=='Salir de Proton Drive':return ident
                for child in children:
                    found=find(child.unpack() if hasattr(child,'unpack') else child)
                    if found is not None:return found
            ident=find(layout)
            if ident is not None:
                requested=True;call(dest,menu,'com.canonical.dbusmenu','Event',GLib.Variant('(isvu)',(ident,'clicked',GLib.Variant('s',''),0)))
    except Exception:pass
    client=urllib.request.build_opener(urllib.request.ProxyHandler({}));base='http://127.0.0.1:47831'
    try:
        html=client.open(base,timeout=2).read().decode();token=re.search(r'const token="([a-f0-9]{64})"',html)
        if not token:raise RuntimeError('Puerto ocupado por otro programa.')
        if not requested:client.open(urllib.request.Request(base+'/quit',data=b'',headers={'X-Nube-Token':token[1]}),timeout=5).close()
    except urllib.error.URLError:pass
    for _ in range(100):
        try:client.open(base,timeout=.2).close()
        except urllib.error.URLError:return
        time.sleep(.1)
    raise RuntimeError('No se pudo detener el servicio. No se cambia la aplicación.')

def atomic(file,value):
    temp=file.with_name(file.name+'.rollback-tmp');temp.write_text(json.dumps(value));temp.chmod(0o600);temp.replace(file)

def rollback(root,previous,stop=stop_service,locked=False):
    if not locked:
        with update_lock(root):return rollback(root,previous,stop,locked=True)
    root=Path(root).resolve();previous=Path(previous)
    if previous.parent!=root or previous not in previous_apps(root) or not bootstrap.valid(previous):raise ValueError('Copia anterior no válida.')
    stop()
    if previous not in previous_apps(root) or not bootstrap.valid(previous):raise ValueError('La copia ha cambiado. No se restaura.')
    state=root/'state';state.mkdir(mode=0o700,exist_ok=True)
    atomic(state/'sync-enabled.json',{'enabled':False})
    ext=state/'external-sync.json'
    if ext.exists():
        value=json.loads(ext.read_text());value['enabled']=False;atomic(ext,value)
    current=root/'app';saved=root/('app-previous-'+str(time.time_ns()))
    bootstrap.durable_json(root/'app-swap.json',{'old':saved.name,'new':previous.name})
    if current.exists():current.rename(saved)
    try:previous.rename(current)
    except Exception:
        if saved.exists():saved.rename(current)
        raise
    (root/'app-swap.json').unlink(missing_ok=True);bootstrap.sync_dir(root)
    version=json.loads((current/'release.json').read_text())['version']
    installation=root/'installation.json'
    try:value=json.loads(installation.read_text())
    except (OSError,ValueError):value={}
    value['version']=version;atomic(installation,value)
    atomic(state/'update-result.json',{'ok':True,'time':datetime.now(timezone.utc).isoformat(),'message':'Aplicación restaurada a '+version+'. Documentos e índices conservados; sincronizaciones pausadas para revisión.'})
    return version

if __name__=='__main__':
    import sys
    root=Path(sys.argv[1]).resolve();previous=root/sys.argv[2]
    rollback(root,previous)
    subprocess.Popen([str(root/'nube-local')],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
