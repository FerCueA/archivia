#!/usr/bin/env python3
"""Native Linux status indicator. It only contacts our localhost service."""
import fcntl
import json
import os
from pathlib import Path
import re
import threading
import subprocess
import sys
import time
from datetime import datetime
import urllib.request
import gi

gi.require_version('Gtk', '3.0')
gi.require_version('AyatanaAppIndicator3', '0.1')
from gi.repository import Gtk, GLib, Gio, AyatanaAppIndicator3 as AppIndicator

os.umask(0o077)
PROJECT = Path(__file__).resolve().parents[1]
STATE = Path(os.environ.get('NUBE_LOCAL_DATA', str(PROJECT.parents[1] / 'work/nube-local-state')))
STATE.mkdir(parents=True, exist_ok=True)
lock = (STATE / 'tray.lock').open('w')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(0)
(STATE / 'tray.pid').write_text(str(os.getpid()))
BASE = 'http://127.0.0.1:47831'
client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
class TrayIndicator:
    def __init__(self):
        self.filename=str(PROJECT/'assets/tray-offline.svg');self.title='Proton Drive';self.menu=None;self.target=None;self.native=None;self.classic=None
        if os.environ.get('XDG_SESSION_TYPE')=='x11' and not any(name in os.environ.get('XDG_CURRENT_DESKTOP','').lower() for name in ['gnome','ubuntu','kde','plasma']):
            self.classic=Gtk.StatusIcon.new_from_file(self.filename)
            self.classic.connect('activate',lambda *_:open_window())
            self.classic.connect('popup-menu',self.popup)
            self.classic.set_visible(True)
            GLib.timeout_add_seconds(2,self.check_embedding)
        else:self.fallback()
    def record(self,backend,single):
        try:(STATE/'tray-ui.json').write_text(json.dumps({'backend':backend,'singleClick':single}))
        except OSError:pass
    def check_embedding(self):
        if self.classic.is_embedded():self.record('classic-x11',True)
        else:self.classic.set_visible(False);self.classic=None;self.fallback()
        return False
    def fallback(self):
        self.native=AppIndicator.Indicator.new('nube-local',self.filename,AppIndicator.IndicatorCategory.APPLICATION_STATUS)
        self.native.set_status(AppIndicator.IndicatorStatus.ACTIVE);self.native.set_title(self.title)
        if self.menu:self.native.set_menu(self.menu)
        if self.target:self.native.set_secondary_activate_target(self.target)
        self.record('appindicator',False)
    def popup(self,icon,button,activate_time):
        if self.menu:self.menu.popup(None,None,None,None,button,activate_time)
    def set_status(self,value):
        if self.native:self.native.set_status(value)
    def set_title(self,title):
        self.title=title
        if self.native:self.native.set_title(title)
        if self.classic:self.classic.set_title('Proton Drive');self.classic.set_tooltip_text(title)
    def set_icon_full(self,filename,description):
        changed=self.filename!=filename;self.filename=filename
        if self.native:self.native.set_icon_full(filename,description)
        if self.classic and changed:self.classic.set_from_file(filename)
    def set_menu(self,menu):
        self.menu=menu
        if self.native:self.native.set_menu(menu)
    def set_secondary_activate_target(self,item):
        self.target=item
        if self.native:self.native.set_secondary_activate_target(item)

indicator = TrayIndicator()
indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
indicator.set_title('Proton Drive')
menu = Gtk.Menu()
status_item = Gtk.MenuItem(label='Conectando con Proton Drive…')
status_item.set_sensitive(False)
menu.append(status_item)
detail_items = [Gtk.MenuItem(label='') for _ in range(8)]
for detail in detail_items:
    detail.set_sensitive(False)
    menu.append(detail)
menu.append(Gtk.SeparatorMenuItem())
toggle_item = Gtk.MenuItem(label='Activar sincronización')
connected = False
active = False
inflight = False
backend = None
quitting = False
current_folder = Path.home() / 'ProtonDrive'
last_notification = None
notification_bus = None
notification_ids = set()
service_failures = 0
next_start = 0
restart_delay = 3

def open_window(*_):
    subprocess.Popen([sys.executable, str(PROJECT / 'src/desktop.py')],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)

def notify_mint(key, title, body):
    global last_notification, notification_bus
    if key == last_notification:
        return
    try:
        saved = json.loads((STATE / 'notifications.json').read_text())
        if saved.get('key') == key:
            last_notification = key
            return
    except (OSError, ValueError):
        pass
    try:
        if notification_bus is None:
            notification_bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            notification_bus.signal_subscribe('org.freedesktop.Notifications', 'org.freedesktop.Notifications', 'ActionInvoked', '/org/freedesktop/Notifications', None, Gio.DBusSignalFlags.NONE, lambda bus, sender, path, interface, signal, params: open_window() if params.unpack()[0] in notification_ids and params.unpack()[1] == 'default' else None)
        result = notification_bus.call_sync('org.freedesktop.Notifications', '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', 'Notify',
            GLib.Variant('(susssasa{sv}i)', ('Proton Drive', 0, str(PROJECT / 'assets/tray-error.svg'), title, GLib.markup_escape_text(body), ['default', 'Abrir Proton Drive'], {}, -1)), None, Gio.DBusCallFlags.NONE, 2000, None)
        notification_ids.add(result.unpack()[0])
        last_notification = key
        (STATE / 'notifications.json').write_text(json.dumps({'key': key}))
    except Exception:
        pass

def open_current_folder(*_):
    open_uri(current_folder.as_uri())

def ensure_backend():
    global backend, next_start, restart_delay
    executable = PROJECT / 'bin/nube-local-service'
    if quitting or not executable.exists() or time.monotonic() < next_start:
        return
    if backend is None or backend.poll() is not None:
        env = dict(os.environ, NUBE_LOCAL_DATA=str(STATE), NUBE_LOCAL_APP=str(PROJECT))
        with (STATE / 'service.log').open('a') as log:
            backend = subprocess.Popen(['flock','--nonblock','--no-fork',str(STATE / 'service.lock'),str(executable)], env=env, cwd=PROJECT,
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        next_start = time.monotonic() + restart_delay
        restart_delay = min(restart_delay * 2, 60)

def open_uri(uri):
    Gio.AppInfo.launch_default_for_uri(uri, None)

def request(route, method='GET'):
    with client.open(BASE, timeout=5) as r:
        page = r.read().decode()
    token = re.search(r'const token="([a-f0-9]{64})"', page).group(1)
    req = urllib.request.Request(BASE + route, data=b'' if method == 'POST' else None,
                                 method=method, headers={'X-Nube-Token': token})
    with client.open(req, timeout=5) as r:
        return json.load(r)

def apply_state(state):
    global connected, active, inflight, restart_delay, current_folder, service_failures
    inflight = False
    connected = state is not None
    if connected:
        restart_delay = 3
    active = bool(state and state.get('syncActive'))
    if state:
        current_folder = Path(state.get('localRoot', str(current_folder)))
        service_failures = 0
    else:
        service_failures += 1
    progress = (state or {}).get('progress') or {}
    phase = progress.get('phase', '')
    conflicts = (state or {}).get('conflictCount', 0)
    error = (state or {}).get('error')
    if not state:
        icon, label = 'offline', 'Reconectando con el servicio…'
    elif not state.get('connected'):
        icon, label = 'offline', 'Cuenta sin conectar · abrir para iniciar sesión'
    elif error:
        icon, label = 'error', error.get('message', 'Se requiere atención')
    elif state.get('cloudSafety', {}).get('preview'):
        icon, label = 'error', 'Cambios masivos pendientes de revisión'
    elif state.get('external', {}).get('config', {}).get('enabled') and (state['external'].get('diskError') or state['external'].get('conflictCount') or (state['external'].get('preview') or {}).get('actions')):
        icon, label = 'error', 'Disco externo · revisar cambios o avisos'
    elif state.get('meteredPaused'):
        icon, label = 'paused', 'Pausada · conexión de uso medido'
    elif state.get('syncTemporarilyPaused'):
        icon, label = 'working', 'Pausa temporal · revisión de documentos'
    elif not active:
        icon, label = 'paused', 'Sincronización pausada'
    elif phase not in ('idle', 'paused', '') or state.get('busy'):
        icon, label = 'working', {
            'indexing': 'Revisando archivos en la nube…',
            'planning': 'Comparando cambios…', 'upload': 'Subiendo archivo…',
            'download': 'Descargando archivo…', 'waiting': 'Esperando para reintentar…',
            'move-local': 'Organizando carpeta local…', 'move-remote': 'Organizando la nube…',
            'delete-local': 'Moviendo a la papelera local…',
            'delete-remote': 'Moviendo a la papelera de Proton…',
        }.get(phase, 'Sincronizando…')
    elif conflicts:
        icon, label = 'error', f'{conflicts} conflicto(s) · abrir para resolver'
    elif (state.get('summary') or {}).get('pendingCount') is None:
        icon, label = 'working', 'Comprobando si quedan cambios…'
    elif state['summary']['pendingCount'] > 0:
        icon, label = 'working', str(state['summary']['pendingCount']) + ' elementos pendientes'
    else:
        icon, label = 'active', 'Al día · sincronización activa'
    details = []
    completed = ((state or {}).get('summary') or {}).get('lastCompletedAt')
    if completed:
        try:details.append('Última sincronización completa: ' + datetime.fromisoformat(completed.replace('Z','+00:00')).astimezone().strftime('%d/%m %H:%M'))
        except (ValueError,TypeError):pass
    if state and state.get('nextRetryAt'):details.append('Reintento automático: ' + state['nextRetryAt'])
    if state and state.get('runHealth', {}).get('uncleanPrevious'):details.append('Sesión anterior interrumpida · consultar Actividad')
    filename = progress.get('path')
    if filename and phase not in ('idle', 'paused'):
        filename = str(filename).replace('\n', ' ')
        details.append('Archivo: ' + (filename if len(filename) <= 75 else '…' + filename[-74:]))
    if phase in ('upload', 'download'):
        done, total = progress.get('bytes') or 0, progress.get('totalBytes')
        transfer = f'{done / 1048576:.1f} MB'
        if total:
            transfer += f' de {total / 1048576:.1f} MB · {min(100, done * 100 / total):.0f}%'
        speed = progress.get('speed') or 0
        if speed > 0:
            transfer += f' · {speed / 1024:.0f} KB/s'
        eta = progress.get('eta')
        if eta is not None:
            transfer += f' · quedan {max(1, round(eta))} s'
        details.append(transfer)
    status = (state or {}).get('syncStatus', '')
    checked = re.search(r'Última revisión: ([^\n]+)', status)
    if checked:
        details.append('Última revisión: ' + checked.group(1))
    if conflicts and 'conflicto' not in label:
        details.append(f'Conflictos pendientes: {conflicts}')
    if state and state.get('external', {}).get('config', {}).get('enabled'):
        details.append('Disco externo: ' + state['external'].get('status', 'revisando'))
    details.append('Carpeta: ' + str(current_folder).replace(str(Path.home()), '~', 1))
    prefs = (state or {}).get('preferences', {})
    if prefs.get('notifications', True):
        if state and state.get('cloudSafety', {}).get('preview'):
            preview = state['cloudSafety']['preview']
            notify_mint('cloud-review:' + preview['id'], 'Cambios masivos pendientes', preview['reason'])
        elif error:
            notify_mint('error:' + str(error.get('kind')) + ':' + str(error.get('code')) + ':' + str(error.get('path')), 'Proton Drive necesita atención', error.get('message', 'Abre la aplicación para revisar el problema.'))
        elif conflicts:
            ids = ','.join(sorted(c.get('id', '') for c in state.get('conflicts', [])))
            notify_mint('conflicts:' + ids, 'Conflictos en Proton Drive', f'{conflicts} conflicto(s) pendiente(s). Abre la aplicación para elegir qué versión conservar.')
        elif state and state.get('external', {}).get('config', {}).get('enabled') and (state['external'].get('diskError') or state['external'].get('conflictCount')):
            ext = state['external']
            body = ext.get('diskError') or 'Hay conflictos entre el ordenador y el disco externo. Abre la aplicación para resolverlos.'
            notify_mint('external:' + body, 'Sincronización del disco externo', body)
        elif state and state.get('meteredPaused'):
            notify_mint('metered', 'Sincronización pausada', 'La conexión es de uso medido. Se reanudará al cambiar de red o desactivar esta opción en Ajustes.')
        elif state:
            # Clear the persistent fingerprint when attention is no longer needed.
            global last_notification
            last_notification = None
            try:
                (STATE / 'notifications.json').unlink(missing_ok=True)
            except OSError:
                pass
    for item, detail in zip(detail_items, details + [''] * len(detail_items)):
        item.set_label(detail)
        item.set_visible(bool(detail))
    indicator.set_icon_full(str(PROJECT / f'assets/tray-{icon}.svg'), label)
    indicator.set_title('Proton Drive — ' + label + (' · ' + details[0] if details else ''))
    status_item.set_label(label)
    toggle_item.set_label('Pausar sincronización' if active else 'Activar sincronización')
    toggle_item.set_sensitive(connected)
    ext = (state or {}).get('external', {})
    eject_item.set_visible(bool(ext.get('config', {}).get('enabled')))
    eject_item.set_sensitive(bool(ext.get('available') and not ext.get('suspended') and not ext.get('ejecting')))
    return False

def refresh_worker():
    try:
        state = request('/state')
    except Exception:
        state = None
        ensure_backend()
    GLib.idle_add(apply_state, state)

def refresh():
    global inflight
    if not inflight:
        inflight = True
        threading.Thread(target=refresh_worker, daemon=True).start()
    return True

def action(route, exit_after=False):
    global quitting
    if exit_after:
        quitting = True
    def worker():
        try:
            request(route, 'POST')
        except Exception:
            pass
        if exit_after:
            GLib.idle_add(Gtk.main_quit)
        else:
            GLib.idle_add(refresh)
    threading.Thread(target=worker, daemon=True).start()

for label, callback in [
    ('Abrir Proton Drive', open_window),
    ('Abrir carpeta ProtonDrive', open_current_folder),
]:
    item = Gtk.MenuItem(label=label)
    item.connect('activate', callback)
    if label == 'Abrir Proton Drive':
        menu.prepend(item)
        indicator.set_secondary_activate_target(item)
    else:
        menu.append(item)
toggle_item.connect('activate', lambda *_: action('/pause' if active else '/sync'))
menu.append(toggle_item)
item = Gtk.MenuItem(label='Sincronizar ahora')
item.connect('activate', lambda *_: action('/sync'))
menu.append(item)
eject_item = Gtk.MenuItem(label='Expulsar disco externo con seguridad')
eject_item.connect('activate', lambda *_: action('/external/eject'))
menu.append(eject_item)
menu.append(Gtk.SeparatorMenuItem())
item = Gtk.MenuItem(label='Salir de Proton Drive')
item.connect('activate', lambda *_: action('/quit', True))
menu.append(item)
menu.show_all()
eject_item.hide()
for detail in detail_items:
    detail.hide()
indicator.set_menu(menu)
tray_control=Gio.Application(application_id='app.nube_local.tray',flags=Gio.ApplicationFlags.IS_SERVICE)
try:
    tray_control.register(None)
    for name,callback in [('open',lambda *_:open_window()),('quit',lambda *_:action('/quit',True))]:
        control_action=Gio.SimpleAction.new(name,None);control_action.connect('activate',callback);tray_control.add_action(control_action)
except Exception:pass
GLib.timeout_add_seconds(3, refresh)
refresh()
Gtk.main()
