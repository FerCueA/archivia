#!/usr/bin/env python3
"""Native dialogs and Linux desktop integration, never receives shell commands."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import shutil
import re,stat
from contextlib import contextmanager
import gi
from gi.repository import Gio, GLib
PROJECT=Path(__file__).resolve().parents[1]
INSTALL=PROJECT.parent
STATE=Path(os.environ.get('NUBE_LOCAL_DATA',str(INSTALL/'state')))
AUTOSTART=Path.home()/'.config/autostart/nube-local.desktop'

def version_manager():
    import importlib.util
    spec=importlib.util.spec_from_file_location('proton_versions',PROJECT/'src/version-manager.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def settings_dialog(mode,payload=None):
    gi.require_version('Gtk','3.0')
    from gi.repository import Gtk
    Gtk.init(None)
    export=mode=='export'
    choose=Gtk.FileChooserDialog(title='Exportar ajustes de Proton Drive' if export else 'Importar ajustes de Proton Drive',action=Gtk.FileChooserAction.SAVE if export else Gtk.FileChooserAction.OPEN)
    choose.add_buttons('Cancelar',Gtk.ResponseType.CANCEL,'Guardar' if export else 'Seleccionar',Gtk.ResponseType.OK)
    if export:choose.set_current_name('ProtonDrive-ajustes.json');choose.set_do_overwrite_confirmation(True)
    response=choose.run();filename=choose.get_filename() if response==Gtk.ResponseType.OK else None;choose.destroy()
    if not filename:return {'cancelled':True}
    file=Path(filename)
    if export:
        value=json.loads(payload)
        if value.get('kind')!='proton-drive-settings':raise ValueError('Copia no válida')
        temp=file.with_name(file.name+'.tmp-'+os.urandom(6).hex())
        try:
            with temp.open('x',encoding='utf8') as out:os.chmod(temp,0o600);json.dump(value,out,ensure_ascii=False,indent=2);out.flush();os.fsync(out.fileno())
            temp.replace(file)
        finally:temp.unlink(missing_ok=True)
        return {'ok':True}
    if file.stat().st_size>131072:raise ValueError('El archivo de ajustes es demasiado grande.')
    value=json.loads(file.read_text())
    if value.get('kind')!='proton-drive-settings' or value.get('schema')!=1:raise ValueError('Copia de ajustes no compatible.')
    confirm=Gtk.MessageDialog(message_type=Gtk.MessageType.QUESTION,buttons=Gtk.ButtonsType.OK_CANCEL,text='¿Importar estos ajustes?')
    confirm.format_secondary_text('Se conservarán la cuenta, los documentos y la carpeta local de este equipo. Se restaurarán preferencias y carpetas protegidas; las sincronizaciones con Proton y el disco quedarán pausadas para revisión.')
    approved=confirm.run()==Gtk.ResponseType.OK;confirm.destroy()
    return {'bundle':value} if approved else {'cancelled':True}

def rollback_dialog():
    manager=version_manager();candidate=next((p for p in manager.previous_apps(INSTALL) if manager.bootstrap.valid(p)),None);copies=[candidate] if candidate else []
    if not copies:raise ValueError('No hay una aplicación anterior válida para restaurar.')
    previous=copies[0];version=json.loads((previous/'release.json').read_text())['version']
    gi.require_version('Gtk','3.0')
    from gi.repository import Gtk
    Gtk.init(None);confirm=Gtk.MessageDialog(message_type=Gtk.MessageType.QUESTION,buttons=Gtk.ButtonsType.OK_CANCEL,text='¿Volver a Proton Drive '+version+'?')
    confirm.format_secondary_text('Se conserva la aplicación actual como copia. Los documentos, la sesión y los índices no se sustituyen. Las sincronizaciones quedarán pausadas para que revises la versión restaurada.')
    approved=confirm.run()==Gtk.ResponseType.OK;confirm.destroy()
    if not approved:return {'cancelled':True}
    log=(STATE/'update.log').open('a');subprocess.Popen([sys.executable,str(PROJECT/'src/version-manager.py'),str(INSTALL),previous.name],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    return {'updating':True}

def network():
    try:
        bus=Gio.bus_get_sync(Gio.BusType.SYSTEM,None)
        value=bus.call_sync('org.freedesktop.NetworkManager','/org/freedesktop/NetworkManager','org.freedesktop.DBus.Properties','Get',GLib.Variant('(ss)',('org.freedesktop.NetworkManager','Metered')),None,0,3000,None).unpack()[0]
        return 'metered' if value in (1,3) else 'unmetered' if value in (2,4) else 'unknown'
    except Exception:
        return 'unknown'

def platform_report():
    import importlib.util
    spec=importlib.util.spec_from_file_location('platform_check',PROJECT/'src/platform-check.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module.inspect_runtime()

def status():
    manager=version_manager();candidate=next((p for p in manager.previous_apps(INSTALL) if manager.bootstrap.valid(p)),None);copies=[candidate] if candidate else []
    return {'platform':platform_report(),'previousVersion':json.loads((copies[0]/'release.json').read_text())['version'] if copies else None,'metered':network(),'autostart':AUTOSTART.exists() and 'X-GNOME-Autostart-enabled=false' not in AUTOSTART.read_text()}

def autostart(enabled):
    AUTOSTART.parent.mkdir(parents=True,exist_ok=True)
    launcher=INSTALL/'nube-local'
    text=('[Desktop Entry]\nVersion=1.0\nType=Application\nName=Proton Drive\nExec="'+str(launcher)+'" --background\nIcon='+str(PROJECT/'assets/tray-active.svg')+'\nTerminal=false\nStartupNotify=false\nX-GNOME-Autostart-Delay=10\nX-GNOME-Autostart-enabled='+str(enabled).lower()+'\n')
    temp=AUTOSTART.with_suffix('.desktop.tmp');temp.write_text(text);temp.chmod(0o644);temp.replace(AUTOSTART)

def eject_disk(target, pair_id, volume_id, protected_root):
    gi.require_version('Gtk','3.0')
    from gi.repository import Gtk
    Gtk.init(None)
    target=Path(target)
    if target.resolve()!=target:raise ValueError('La carpeta externa contiene enlaces.')
    marker=target/'.proton-drive-pair.json'
    if marker.is_symlink() or json.loads(marker.read_text()).get('id')!=pair_id:raise ValueError('El identificador de la carpeta ha cambiado.')
    monitor=Gio.VolumeMonitor.get()
    mounts=monitor.get_mounts()
    matching=[m for m in mounts if m.get_root().get_path() and (str(target)==m.get_root().get_path() or str(target).startswith(m.get_root().get_path()+'/'))]
    if not matching:raise ValueError('No se encuentra la unidad montada.')
    mount=max(matching,key=lambda m:len(m.get_root().get_path()))
    volume=mount.get_volume()
    if volume_id.startswith('uuid:'):
        expected=volume_id.split(':',2)[1]
        if volume is None or not volume.get_uuid() or volume.get_uuid().lower()!=expected.lower():raise ValueError('No se puede confirmar la identidad de la unidad.')
    drive=mount.get_drive()
    siblings=[m for m in mounts if m==mount or (drive is not None and m.get_drive()==drive)]
    for item in siblings:
        root=item.get_root().get_path()
        if root and (protected_root==root or protected_root.startswith(root.rstrip('/')+'/')):raise ValueError('La carpeta local de Proton Drive está en esta unidad. Muévela antes de expulsarla.')
    operation=Gtk.MountOperation()
    loop=GLib.MainLoop();result={};cancel=Gio.Cancellable()
    stop_drive=drive is not None and drive.can_stop()
    scope='drive' if drive is not None and (stop_drive or drive.can_eject()) else 'volume'
    def done(obj, task, _):
        try:
            if scope=='drive':
                if stop_drive:drive.stop_finish(task)
                else:drive.eject_with_operation_finish(task)
            else:mount.unmount_with_operation_finish(task)
            result['ok']=True
        except Exception as error:result['error']=str(error)
        loop.quit()
    if scope=='drive':
        if stop_drive:drive.stop(Gio.MountUnmountFlags.NONE,operation,cancel,done,None)
        else:drive.eject_with_operation(Gio.MountUnmountFlags.NONE,operation,cancel,done,None)
    else:mount.unmount_with_operation(Gio.MountUnmountFlags.NONE,operation,cancel,done,None)
    timeout=GLib.timeout_add_seconds(60,lambda:(cancel.cancel(),False)[1])
    loop.run()
    if GLib.MainContext.default().find_source_by_id(timeout):GLib.source_remove(timeout)
    if result.get('error'):raise ValueError(result['error'])
    if not result.get('ok'):raise ValueError('No se ha confirmado el desmontaje.')
    safe=scope=='drive' or len(siblings)==1
    return {'ok':True,'safeToUnplug':safe,'message':'Disco expulsado. Ya puedes desconectarlo.' if safe else 'Carpeta desmontada. Hay otras particiones de esta unidad: desmóntalas antes de desconectar el disco.'}

def validate_archive(members):
    names={m.name for m in members}
    if len(names)!=len(members):raise ValueError('El instalador contiene rutas duplicadas.')
    if not {'nube-local/bin/nube-local-service','nube-local/scripts/install.py','nube-local/src/tray.py'}.issubset(names):raise ValueError('El instalador está incompleto.')
    if len(members)>1000 or sum(m.size for m in members)>600*1024**2:raise ValueError('Instalador demasiado grande.')
    for m in members:
        parts=Path(m.name).parts
        if m.name != str(Path(m.name)) or not parts or parts[0]!='nube-local' or '..' in parts or Path(m.name).is_absolute() or not (m.isfile() or m.isdir()):raise ValueError('El instalador contiene rutas no permitidas.')

def launch_archive(archive,members):
    target=Path(tempfile.mkdtemp(prefix='proton-drive-update-'))
    try:
        for member in members:
            out=target/member.name
            if member.isdir():out.mkdir(parents=True,exist_ok=True)
            else:
                out.parent.mkdir(parents=True,exist_ok=True)
                with archive.extractfile(member) as source,out.open('wb') as output:shutil.copyfileobj(source,output)
                out.chmod(member.mode&0o755)
        log=(STATE/'update.log').open('a')
        try:subprocess.Popen([sys.executable,str(PROJECT/'src/system-settings.py'),'--apply-update',str(target)],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        finally:log.close()
    except Exception:
        shutil.rmtree(target);raise
    return {'updating':True}

@contextmanager
def downloaded_archive(filename,sha256,version):
    if not re.fullmatch('[a-f0-9]{64}',sha256) or not re.fullmatch(r'\d+\.\d+\.\d+',version):raise ValueError('Datos de actualización no válidos.')
    package=Path(filename);expected=STATE/'updates'/(sha256+'.run')
    if package!=expected or package.resolve()!=package or package.is_symlink():raise ValueError('El instalador no está en la carpeta privada de descargas.')
    info=package.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size>200*1024**2:raise ValueError('Instalador no válido.')
    with package.open('rb') as original,tempfile.TemporaryFile() as snapshot:
        shutil.copyfileobj(original,snapshot);snapshot.seek(0)
        if hashlib.file_digest(snapshot,'sha256').hexdigest()!=sha256:raise ValueError('El SHA-256 del instalador ha cambiado; no se instala.')
        snapshot.seek(0);lines=[snapshot.readline() for _ in range(8)]
        if lines[-1]!=b'__PROTON_DRIVE_ARCHIVE__\n':raise ValueError('No es un instalador compatible.')
        with tarfile.open(fileobj=snapshot,mode='r:gz') as archive:
            members=archive.getmembers();validate_archive(members)
            member=archive.getmember('nube-local/release.json')
            if not member.isfile() or member.size>65536:raise ValueError('Metadatos de versión no válidos.')
            release=json.load(archive.extractfile(member))
            if release.get('version')!=version or release.get('platform')!='linux' or release.get('arch')!='x64':raise ValueError('La versión o arquitectura del instalador no coincide.')
            yield archive,members,{'version':version,'sha256':sha256,'repository':'FerCueA/archivia'}

def install_downloaded(filename,sha256,version,confirm=None):
    with downloaded_archive(filename,sha256,version) as (archive,members,metadata):
        if confirm is None:
            gi.require_version('Gtk','3.0')
            from gi.repository import Gtk
            Gtk.init(None);prompt=Gtk.MessageDialog(message_type=Gtk.MessageType.QUESTION,buttons=Gtk.ButtonsType.OK_CANCEL,text='¿Instalar Archivia '+version+' desde GitHub?')
            prompt.format_secondary_text('Origen: FerCueA/archivia\nSHA-256 verificado: '+sha256+'\n\nSe conservarán la sesión, los ajustes, los documentos y una copia de la aplicación anterior. El programa se reiniciará.')
            approved=prompt.run()==Gtk.ResponseType.OK;prompt.destroy()
        else:approved=confirm(metadata)
        if not approved:return {'cancelled':True}
        return launch_archive(archive,members)

def dialog(mode,initial=None):
    gi.require_version('Gtk','3.0')
    from gi.repository import Gtk
    Gtk.init(None)
    choose=Gtk.FileChooserDialog(title='Carpeta para organizar' if mode=='organizer' else 'Carpeta para analizar duplicados' if mode=='duplicates' else 'Carpeta de sincronización' if mode in ('folder','external') else 'Instalar actualización de Proton Drive',action=Gtk.FileChooserAction.SELECT_FOLDER if mode in ('folder','external','duplicates','organizer') else Gtk.FileChooserAction.OPEN)
    choose.add_buttons('Cancelar',Gtk.ResponseType.CANCEL,'Seleccionar',Gtk.ResponseType.OK)
    choose.set_default_size(900,600)
    if initial and Path(initial).is_dir():choose.set_current_folder(str(Path(initial)))
    if mode=='update':
        file_filter=Gtk.FileFilter();file_filter.set_name('Instalador Proton Drive (*.run)');file_filter.add_pattern('*.run');choose.add_filter(file_filter)
    result=choose.run();filename=choose.get_filename() if result==Gtk.ResponseType.OK else None;choose.destroy()
    while Gtk.events_pending():Gtk.main_iteration()
    if not filename:return {'cancelled':True}
    if mode in ('folder','external','duplicates','organizer'):return {'folder':filename}
    package=Path(filename)
    # Read the archive directly; never execute the shell header of a chosen file.
    with package.open('rb') as original, tempfile.TemporaryFile() as file:
        shutil.copyfileobj(original,file);file.seek(0)
        digest=hashlib.file_digest(file,'sha256').hexdigest();file.seek(0)
        lines=[file.readline() for _ in range(8)]
        if lines[-1]!=b'__PROTON_DRIVE_ARCHIVE__\n':raise ValueError('No es un instalador compatible de Proton Drive.')
        with tarfile.open(fileobj=file,mode='r:gz') as archive:
            members=archive.getmembers()
            validate_archive(members)
            prompt=Gtk.MessageDialog(message_type=Gtk.MessageType.QUESTION,buttons=Gtk.ButtonsType.OK_CANCEL,text='¿Instalar esta actualización de Proton Drive?')
            prompt.format_secondary_text('Archivo: '+package.name+'\n\nSe conservarán la sesión, los ajustes y los documentos. La aplicación se reiniciará.\n\nInstala únicamente paquetes de una fuente en la que confíes. Las versiones oficiales de este proyecto se publican en github.com/FerCueA/archivia. Los paquetes se verifican por SHA-256; no hay firma digital independiente.\n\nSHA-256: '+digest)
            approved=prompt.run()==Gtk.ResponseType.OK;prompt.destroy()
            if not approved:return {'cancelled':True}
            return launch_archive(archive,members)
    return {'updating':True}

def update_healthy(expected):
    import urllib.request,time,re
    client=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(60):
        try:
            html=client.open('http://127.0.0.1:47831/',timeout=1).read().decode();token=re.search(r'const token="([a-f0-9]{64})"',html)[1]
            state=json.load(client.open(urllib.request.Request('http://127.0.0.1:47831/state',headers={'X-Nube-Token':token}),timeout=1))
            if state.get('version')==expected:return True
        except Exception:pass
        time.sleep(.5)
    return False

def apply_update(target):
    manager=version_manager()
    with manager.update_lock(INSTALL):return apply_update_locked(target,manager)

def apply_update_locked(target,manager):
    target=Path(target);installer=target/'nube-local/scripts/install.py';recovered=None;before=set(p.name for p in INSTALL.glob('app-previous-*'))
    try:
        subprocess.run([sys.executable,str(installer)],check=True,env={**os.environ,'NUBE_LOCAL_UPDATE_LOCK_HELD':'1'})
        expected=json.loads((target/'nube-local/release.json').read_text())['version']
        if not update_healthy(expected):raise RuntimeError('La versión nueva no responde.')
        result={'ok':True,'time':datetime.now(timezone.utc).isoformat(),'message':'Actualización instalada. Se han conservado los ajustes y los documentos.'}
    except Exception:
        try:
            candidates=[p for p in manager.previous_apps(INSTALL) if p.name not in before]
            if candidates:recovered=manager.rollback(INSTALL,candidates[0],locked=True)
        except Exception:pass
        result={'ok':False,'time':datetime.now(timezone.utc).isoformat(),'message':('La actualización no respondió; se restauró '+recovered+' con las sincronizaciones pausadas.' if recovered else 'No se pudo completar la actualización. Consulta update.log en la carpeta de estado.')}
        subprocess.Popen([str(INSTALL/'nube-local')],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    finally:
        shutil.rmtree(target)
    (STATE/'update-result.json').write_text(json.dumps(result))
    return result

if __name__=='__main__':
    try:
        mode=sys.argv[1]
        if mode=='--export-settings':result=settings_dialog('export',sys.argv[2])
        elif mode=='--import-settings':result=settings_dialog('import')
        elif mode=='--rollback':result=rollback_dialog()
        elif mode=='--status':result=status()
        elif mode=='--autostart':autostart(sys.argv[2]=='true');result={'ok':True}
        elif mode=='--open-folder':Gio.AppInfo.launch_default_for_uri(Path(sys.argv[2]).as_uri(),None);result={'ok':True}
        elif mode=='--eject':result=eject_disk(*sys.argv[2:6])
        elif mode=='--duplicates-folder':result=dialog('duplicates',sys.argv[2] if len(sys.argv)>2 else None)
        elif mode=='--organizer-folder':result=dialog('organizer',sys.argv[2] if len(sys.argv)>2 else None)
        elif mode=='--open-trash':Gio.AppInfo.launch_default_for_uri('trash:///',None);result={'ok':True}
        elif mode=='--reveal':
            bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
            try:bus.call_sync('org.freedesktop.FileManager1','/org/freedesktop/FileManager1','org.freedesktop.FileManager1','ShowItems',GLib.Variant('(ass)',([Path(sys.argv[2]).as_uri()],'')),None,0,5000,None)
            except Exception:Gio.AppInfo.launch_default_for_uri(Path(sys.argv[2]).parent.as_uri(),None)
            result={'ok':True}
        elif mode=='--external-folder':result=dialog('external')
        elif mode=='--folder':result=dialog('folder',sys.argv[2] if len(sys.argv)>2 else None)
        elif mode=='--update':result=dialog('update')
        elif mode=='--install-downloaded':result=install_downloaded(*sys.argv[2:5])
        elif mode=='--inspect-downloaded':
            with downloaded_archive(*sys.argv[2:5]) as (_,__,metadata):result=metadata
        elif mode=='--apply-update':
            result=apply_update(sys.argv[2])
        else:raise ValueError('Acción no válida')
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'error':str(error)}));sys.exit(1)
