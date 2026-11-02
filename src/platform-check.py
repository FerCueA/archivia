#!/usr/bin/env python3
"""Dependency diagnostics shared by the installer and desktop, without changing the system."""
import os,sys,json,platform,ctypes,shutil
from pathlib import Path
PACKAGES='python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1 gir1.2-ayatanaappindicator3-0.1 libsecret-1-0 gnome-keyring python3-pil poppler-utils'

def desktop_backend(environment=None):
    env=os.environ if environment is None else environment
    desktop=env.get('XDG_CURRENT_DESKTOP','').lower()
    return 'classic-x11' if env.get('XDG_SESSION_TYPE')=='x11' and not any(d in desktop for d in ['gnome','ubuntu','kde','plasma']) else 'appindicator'

def dependencies():
    result={}
    try:
        import gi
        for name,version in [('Gtk','3.0'),('WebKit2','4.1'),('AyatanaAppIndicator3','0.1')]:
            try:gi.require_version(name,version);__import__('gi.repository',fromlist=[name]);result[name]=True
            except (ImportError,ValueError):result[name]=False
    except ImportError:result={name:False for name in ['Gtk','WebKit2','AyatanaAppIndicator3']}
    try:ctypes.CDLL('libsecret-1.so.0');result['libsecret']=True
    except OSError:result['libsecret']=False
    result['flock']=shutil.which('flock') is not None
    import importlib.util
    result['Pillow']=importlib.util.find_spec('PIL') is not None
    result['PDF']=shutil.which('pdftoppm') is not None and shutil.which('pdfinfo') is not None
    return result

def inspect_runtime(info=None,environment=None,machine=None,libc=None,available=None,flags=None):
    env=os.environ if environment is None else environment
    if info is None:
        try:info=platform.freedesktop_os_release()
        except OSError:info={}
    available=dependencies() if available is None else available
    arch=machine or platform.machine();libc=libc or platform.libc_ver();errors=[];warnings=[]
    if arch.lower() not in ['x86_64','amd64']:errors.append('Este instalador incluye un binario Linux x86-64; no es para ARM.')
    try:
        if libc[0]!='glibc' or tuple(int(n) for n in libc[1].split('.')[:2])<(2,17):errors.append('Se necesita glibc 2.17 o posterior.')
    except (ValueError,IndexError):warnings.append('No se pudo comprobar la versión de glibc.')
    if flags is None:
        try:flags=Path('/proc/cpuinfo').read_text().lower()
        except OSError:flags=''
    if flags and arch.lower() in ['x86_64','amd64'] and 'sse4_2' not in flags:errors.append('El procesador necesita SSE4.2 para este binario.')
    for dep in ['Gtk','WebKit2','AyatanaAppIndicator3','libsecret','flock']:
        if not available.get(dep):errors.append('Falta dependencia: '+dep)
    if not available.get('Pillow'):warnings.append('Sin python3-pil no habrá EXIF ni vistas previas de imágenes.')
    if not available.get('PDF'):warnings.append('Sin poppler-utils no habrá vistas previas de PDF.')
    if not env.get('DBUS_SESSION_BUS_ADDRESS'):warnings.append('Abre el programa dentro de tu sesión de escritorio: necesita D-Bus y un llavero Secret Service.')
    desktop=env.get('XDG_CURRENT_DESKTOP','desconocido');session=env.get('XDG_SESSION_TYPE','desconocida');backend=desktop_backend(env)
    if any(d in desktop.lower() for d in ['gnome','ubuntu']):warnings.append('GNOME necesita AppIndicators para mostrar el icono. La ventana también se abre desde el menú de aplicaciones.')
    return {'distribution':info.get('PRETTY_NAME',info.get('ID','Linux')),'distributionId':info.get('ID','unknown'),'version':info.get('VERSION_ID',''),'architecture':arch,'libc':list(libc),'desktop':desktop,'session':session,'trayBackend':backend,'dependencies':available,'errors':errors,'warnings':warnings,'ok':not errors,'installCommand':'sudo apt install '+PACKAGES,'indicatorCommand':'sudo apt install gnome-shell-extension-appindicator'}

if __name__=='__main__':
    report=inspect_runtime();print(json.dumps(report,ensure_ascii=False,indent=2));sys.exit(0 if report['ok'] else 1)
