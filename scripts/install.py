#!/usr/bin/env python3
"""Install Nube Local for this user; preserve account and local files."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import re
import time
import tempfile
import atexit
import fcntl
import importlib.util

SOURCE = Path(__file__).resolve().parents[1]
HOME = Path.home()
INSTALL = HOME / '.local/share/nube-local'
APP = INSTALL / 'app'
STATE = INSTALL / 'state'
MENU = HOME / '.local/share/applications/app.nube_local.desktop.desktop'
AUTOSTART = HOME / '.config/autostart/nube-local.desktop'
PREVIOUS_STATE = SOURCE.parents[1] / 'work/nube-local-state'

# Check requirements before changing an existing installation. --check is read-only.
spec=importlib.util.spec_from_file_location('platform_check',SOURCE/'src/platform-check.py');platform_check=importlib.util.module_from_spec(spec);spec.loader.exec_module(platform_check)
report=platform_check.inspect_runtime()
if '--check' in sys.argv:
    print(json.dumps(report,ensure_ascii=False,indent=2));raise SystemExit(0 if report['ok'] else 1)
if not report['ok']:
    print('No se puede instalar todavía:\n'+'\n'.join(report['errors']))
    print('En Ubuntu o Linux Mint:\n'+report['installCommand']);raise SystemExit(1)
for warning in report['warnings']:print('Aviso:',warning)
import gi
if not (SOURCE / 'bin/nube-local-service').is_file():
    raise SystemExit('Falta el ejecutable bin/nube-local-service.')
# Preview support is optional; synchronization remains available without it.
import importlib.util
if importlib.util.find_spec('PIL') is None:
    print('Vistas previas de imágenes: instala python3-pil si quieres habilitarlas.')
if not Path('/usr/bin/pdftoppm').exists():
    print('Vistas previas de PDF: instala poppler-utils si quieres habilitarlas.')
os.umask(0o077)
INSTALL.mkdir(parents=True, exist_ok=True)
if os.environ.get('NUBE_LOCAL_UPDATE_LOCK_HELD')!='1':
    update_lock=(INSTALL/'update.lock').open('a')
    try:fcntl.flock(update_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise RuntimeError('Ya hay una actualización o restauración en curso.')
staging = Path(tempfile.mkdtemp(prefix='app-staging-', dir=INSTALL))
atexit.register(lambda: shutil.rmtree(staging) if staging.exists() else None)
for dirname in ('bin', 'assets'):
    shutil.copytree(SOURCE / dirname, staging / dirname)
(staging / 'src').mkdir()
for filename in ('desktop.py', 'tray.py', 'launcher.py', 'system-settings.py', 'preview-render.py', 'version-manager.py', 'bootstrap.py', 'platform-check.py'):
    shutil.copy2(SOURCE / 'src' / filename, staging / 'src' / filename)
for filename in ('PROTON-SDK-LICENSE.md', 'THIRD-PARTY-NOTICES.txt', 'README.md', 'COMPATIBILIDAD.md', 'LICENSE', 'BUN-LICENSE.md', 'THIRD-PARTY-SOURCES.md', 'release.json'):
    shutil.copy2(SOURCE / filename, staging / filename)

service_url='http://127.0.0.1:'+str(int(os.environ.get('NUBE_LOCAL_PORT','47831')))
client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
tray_stop_requested=False
def quit_previous():
    try:
        with client.open(service_url+'/', timeout=3) as r:
            page = r.read().decode()
        token = re.search(r'const token="([a-f0-9]{64})"', page)
        if not token or not any(title in page for title in ('<title>Nube Local','<title>Proton Drive')):
            raise RuntimeError('El puerto está ocupado por otro programa.')
        req = urllib.request.Request(service_url+'/quit', data=b'', method='POST', headers={'X-Nube-Token': token.group(1)})
        if not tray_stop_requested:
            with client.open(req, timeout=10) as r:
                if r.status != 200:raise RuntimeError('No se pudo detener la versión anterior.')
    except urllib.error.URLError as error:
        # An unavailable service means there is nothing to stop.
        if isinstance(error, urllib.error.HTTPError):
            raise
        return
    for _ in range(100):
        try:
            client.open(service_url+'/', timeout=.2).close()
        except urllib.error.URLError:
            return
        time.sleep(.1)
    raise RuntimeError('La versión anterior no se ha detenido; no se modifica su estado.')

# Stop the registered indicator through its own menu (works across PID namespaces).
from gi.repository import Gio, GLib
try:
    bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
    def bus_call(dest,obj,interface,method,args=None):
        return bus.call_sync(dest,obj,interface,method,args,None,0,3000,None).unpack()
    if bus_call('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','NameHasOwner',GLib.Variant('(s)',('app.nube_local.tray',)))[0]:
        Gio.DBusActionGroup.get(bus,'app.nube_local.tray','/app/nube_local/tray').activate_action('quit',None);bus.flush_sync(None);tray_stop_requested=True;time.sleep(.5)
    indicators=bus_call('org.kde.StatusNotifierWatcher','/StatusNotifierWatcher','org.freedesktop.DBus.Properties','Get',GLib.Variant('(ss)',('org.kde.StatusNotifierWatcher','RegisteredStatusNotifierItems')))[0]
    for registered in indicators:
        dest,_,obj=registered.partition('/')
        if 'nube_local' not in obj:continue
        props=bus_call(dest,'/'+obj,'org.freedesktop.DBus.Properties','GetAll',GLib.Variant('(s)',('org.kde.StatusNotifierItem',)))[0]
        if props.get('Id')!='nube-local':continue
        layout=bus_call(dest,props['Menu'],'com.canonical.dbusmenu','GetLayout',GLib.Variant('(iias)',(0,-1,[])))[1]
        for item in layout[2]:
            if item[1].get('label','').startswith('Salir de '):
                tray_stop_requested=True
                bus_call(dest,props['Menu'],'com.canonical.dbusmenu','Event',GLib.Variant('(isvu)',(item[0],'clicked',GLib.Variant('i',0),0)))
                time.sleep(.5)
except Exception:
    pass
quit_previous()

STATE.mkdir(mode=0o700, exist_ok=True)
if not (INSTALL / 'installation.json').exists() and PREVIOUS_STATE.is_dir():
    # Copy durable preferences only. SQLite caches and WAL files are disposable.
    for filename in ('folder-baseline.json','sync-enabled.json','clientUid.json','config.json','events.json'):
        previous=PREVIOUS_STATE / filename
        if previous.is_file():
            shutil.copy2(previous, STATE / filename)
os.chmod(STATE, 0o700)
if APP.exists() and not (INSTALL/'installation.json').exists():raise RuntimeError('La instalación anterior no está reconocida; no se reemplaza.')
shutil.copy2(SOURCE/'src/bootstrap.py',INSTALL/'bootstrap.py.tmp')
with (INSTALL/'bootstrap.py.tmp').open('rb') as staged_bootstrap:os.fsync(staged_bootstrap.fileno())
(INSTALL/'bootstrap.py.tmp').replace(INSTALL/'bootstrap.py')
launcher=INSTALL/'nube-local'
launcher_temp=INSTALL/'nube-local.tmp'
launcher_temp.write_text('#!/usr/bin/env bash\nexec python3 "'+str(INSTALL/'bootstrap.py')+'" "$@"\n');launcher_temp.chmod(0o755)
with launcher_temp.open('rb') as stable_launcher:os.fsync(stable_launcher.fileno())
launcher_temp.replace(launcher)
spec=importlib.util.spec_from_file_location('bootstrap',INSTALL/'bootstrap.py');bootstrap=importlib.util.module_from_spec(spec);spec.loader.exec_module(bootstrap)
if (INSTALL/'app-swap.json').exists():bootstrap.recover_swap(INSTALL)
if not bootstrap.valid(staging):raise RuntimeError('La aplicación preparada no supera la verificación de integridad.')
for staged_file in staging.rglob('*'):
    if staged_file.is_file():
        with staged_file.open('rb') as durable:os.fsync(durable.fileno())
for staged_dir in sorted((p for p in staging.rglob('*') if p.is_dir()),key=lambda p:len(p.parts),reverse=True):bootstrap.sync_dir(staged_dir)
bootstrap.sync_dir(staging)
backup = INSTALL / ('app-previous-' + str(time.time_ns()))
bootstrap.durable_json(INSTALL/'app-swap.json',{'old':backup.name,'new':staging.name})
if APP.exists():
    if not (INSTALL / 'installation.json').exists() or backup.exists():
        raise RuntimeError('Ya existe una carpeta de instalación no reconocida o una copia anterior. No se reemplaza.')
    APP.rename(backup)
try:
    staging.rename(APP)
except Exception:
    if backup.exists() and not APP.exists():backup.rename(APP)
    raise
launcher = INSTALL / 'nube-local'
(INSTALL/'app-swap.json').unlink(missing_ok=True);bootstrap.sync_dir(INSTALL)
launcher.chmod(0o755)
service = APP / 'bin/nube-local-service'
service.chmod(0o755)
MENU.parent.mkdir(parents=True, exist_ok=True)
AUTOSTART.parent.mkdir(parents=True, exist_ok=True)
desktop = ('[Desktop Entry]\nVersion=1.0\nType=Application\nName=Proton Drive\n'
           'Comment=Sincronización con Proton Drive\nExec="'+str(launcher)+'"\n'
           'Icon='+str(APP / 'assets/tray-active.svg')+'\nTerminal=false\n'
           'StartupNotify=true\nStartupWMClass=nube-local\nCategories=Network;FileTransfer;\n')
MENU.write_text(desktop)
# Keep existing pinned launchers working without a second menu entry.
(HOME/'.local/share/applications/nube-local.desktop').write_text(desktop+'NoDisplay=true\n')
MENU.chmod(0o644)
enabled=True
try:enabled=bool(json.loads((STATE/'preferences.json').read_text()).get('autostart',True))
except (OSError,ValueError):
    if AUTOSTART.exists():enabled='X-GNOME-Autostart-enabled=false' not in AUTOSTART.read_text()
AUTOSTART.write_text(desktop.replace('Exec="'+str(launcher)+'"','Exec="'+str(launcher)+'" --background').replace('StartupNotify=true','StartupNotify=false')+
                     'X-GNOME-Autostart-enabled='+str(enabled).lower()+'\nX-GNOME-Autostart-Delay=10\n')
AUTOSTART.chmod(0o644)
(INSTALL / 'installation.json').write_text(json.dumps({'name':'Proton Drive','version':'0.16.1','autostart':enabled},indent=2))
print('Proton Drive (cliente no oficial) instalado en', INSTALL)
print('Inicio automático:', 'habilitado' if enabled else 'deshabilitado', '· Acceso disponible en el menú de aplicaciones.')
if '--no-launch' not in sys.argv:
    subprocess.Popen([str(launcher)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
