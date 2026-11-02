#!/usr/bin/env python3
"""Headless GTK/WebKit + Secret Service smoke test; use inside dbus-run-session and Xvfb."""
import os,sys,json,re,time,tempfile,subprocess,urllib.request
from pathlib import Path
PROJECT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='proton-desktop-smoke-') as tmp:
    root=Path(tmp);folder=root/'files';folder.mkdir();state=root/'state';log=(root/'service.log').open('w');home=root/'home';home.mkdir();isolated={**os.environ,'HOME':str(home),'XDG_DATA_HOME':str(home/'.local/share'),'XDG_CONFIG_HOME':str(home/'.config'),'XDG_CACHE_HOME':str(home/'.cache')}
    keyring=subprocess.Popen(['gnome-keyring-daemon','--foreground','--components=secrets','--control-directory='+str(root/'keyring')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=isolated)
    from gi.repository import Gio,GLib
    bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
    for _ in range(50):
        if bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','NameHasOwner',GLib.Variant('(s)',('org.freedesktop.secrets',)),None,0,1000,None).unpack()[0]:break
        time.sleep(.1)
    else:keyring.terminate();keyring.wait();raise RuntimeError('Isolated Secret Service did not start')
    env={**isolated,'NUBE_LOCAL_APP':str(PROJECT),'NUBE_LOCAL_DATA':str(state),'NUBE_LOCAL_TEST_MODE':'1','NUBE_LOCAL_TEST_FOLDER':str(folder),'NUBE_LOCAL_PORT':'47835'}
    service=subprocess.Popen([str(PROJECT/'bin/nube-local-service')],env=env,stdout=log,stderr=log)
    try:
        client=urllib.request.build_opener(urllib.request.ProxyHandler({}));base='http://127.0.0.1:47835'
        for _ in range(100):
            try:html=client.open(base,timeout=1).read().decode();break
            except Exception:time.sleep(.1)
        else:
            log.flush();raise RuntimeError('Service startup failed: '+(root/'service.log').read_text()[-1000:])
        token=re.search(r'const token="([a-f0-9]{64})"',html)[1]
        current=json.load(client.open(urllib.request.Request(base+'/state',headers={'X-Nube-Token':token})))
        assert not current['syncActive'] and not current['connected']
        import gi
        gi.require_version('Gtk','3.0');gi.require_version('WebKit2','4.1')
        from gi.repository import Gtk,WebKit2,GLib
        Gtk.init(None);window=Gtk.Window();window.set_default_size(1000,800);view=WebKit2.WebView();view.get_settings().set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER);window.add(view);result={'ok':False};timeout=None
        def failed(*args):result['error']='WebKit page failed';Gtk.main_quit();return False
        def checked(web,value,user):
            try:
                data=json.loads(web.run_javascript_finish(value).get_js_value().to_string())
                assert data['tabs']==7 and data['settingsOutsideSync'] and data['updatesOutsideSync'] and data['separateOrganizer'],data
                result['ok']=True
            except Exception as e:result['error']=str(e)
            Gtk.main_quit()
        def loaded(web,event):
            if event==WebKit2.LoadEvent.FINISHED:
                code="JSON.stringify({tabs:document.querySelectorAll('[role=tablist] [role=tab]').length,settingsOutsideSync:!document.querySelector('#sync-pane #save-settings')&&!!document.querySelector('#settings-pane #save-settings'),updatesOutsideSync:!!document.querySelector('#updates-pane #install-update'),separateOrganizer:!!document.querySelector('#organizer-pane #org-scope')})"
                web.run_javascript(code,None,checked,None)
        view.connect('load-changed',loaded);view.connect('load-failed',failed);view.load_uri(base);window.show_all()
        timeout=GLib.timeout_add_seconds(30,lambda:(result.update(error='GUI timeout'),Gtk.main_quit(),False)[-1]);Gtk.main();window.destroy()
        assert result['ok'],result
        client.open(urllib.request.Request(base+'/quit',data=b'',headers={'X-Nube-Token':token}),timeout=5).close();service.wait(timeout=15)
        assert json.loads((state/'service-run.json').read_text())['clean']
        print('Ubuntu desktop smoke: binary, Secret Service, HTTP, GTK/WebKit, seven tabs and clean shutdown passed.')
    finally:
        if service.poll() is None:service.terminate();service.wait(timeout=15)
        keyring.terminate();keyring.wait(timeout=5)
