#!/usr/bin/env python3
"""Native GTK window for the localhost interface (no browser tab)."""
import os
from pathlib import Path
import sys
from urllib.parse import urlparse
import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, Gio, GLib, WebKit2

PROJECT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:47831/'
GLib.set_application_name('Proton Drive')
Gtk.Window.set_default_icon_from_file(str(PROJECT / 'assets/tray-active.svg'))

class NubeLocal(Gtk.Application):
    def __init__(self):
        super().__init__(application_id='app.nube_local.desktop', flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.window = None
        self.retry = None

    def do_activate(self):
        if self.window is not None:
            self.window.present()
            return
        self.window = Gtk.ApplicationWindow(application=self)
        self.window.set_title('Proton Drive')
        if os.environ.get('XDG_SESSION_TYPE')=='x11':self.window.set_wmclass('nube-local', 'Proton Drive')
        self.window.set_default_size(1000, 780)
        header = Gtk.HeaderBar(title='Proton Drive', subtitle='Cliente no oficial · Tu carpeta sincronizada')
        header.set_show_close_button(True)
        folder = Gtk.Button.new_from_icon_name('folder-open-symbolic', Gtk.IconSize.BUTTON)
        folder.set_tooltip_text('Abrir carpeta ProtonDrive')
        folder.connect('clicked', lambda *_: self.open_folder())
        header.pack_start(folder)
        refresh = Gtk.Button.new_from_icon_name('view-refresh-symbolic', Gtk.IconSize.BUTTON)
        refresh.set_tooltip_text('Actualizar estado')
        refresh.connect('clicked', lambda *_: self.web.load_uri(BASE))
        header.pack_end(refresh)
        self.window.set_titlebar(header)
        self.web = WebKit2.WebView()
        self.web.get_settings().set_enable_developer_extras(False)
        self.web.connect('decide-policy', self.policy)
        self.web.connect('load-failed', self.failed)
        self.web.connect('load-changed', self.loaded)
        self.window.add(self.web)
        self.window.connect('destroy', self.closed)
        self.web.load_uri(BASE)
        self.window.show_all()

    def open_folder(self):
        root=Path.home()/'ProtonDrive'
        try:
            import json
            state=Path(os.environ.get('NUBE_LOCAL_DATA',str(PROJECT.parent/'state')))
            root=Path(json.loads((state/'preferences.json').read_text()).get('localRoot',str(root)))
        except (OSError,ValueError):
            pass
        Gio.AppInfo.launch_default_for_uri(root.as_uri(),None)

    def loaded(self, web, event):
        if event == WebKit2.LoadEvent.FINISHED and web.get_uri() == BASE:
            state=Path(os.environ.get('NUBE_LOCAL_DATA', str(PROJECT.parent / 'state')))
            state.mkdir(parents=True, exist_ok=True)
            (state / 'window-ready.json').write_text('{"window":"native-gtk","loaded":true}')
            preview=os.environ.get('NUBE_LOCAL_PREVIEW')
            if preview:
                def capture():
                    def done(view, result, _):
                        try:
                            view.get_snapshot_finish(result).write_to_png(preview)
                        except Exception:
                            pass
                    web.get_snapshot(WebKit2.SnapshotRegion.FULL_DOCUMENT, WebKit2.SnapshotOptions.NONE, None, done, None)
                    return False
                GLib.timeout_add_seconds(3, capture)

    def policy(self, web, decision, kind):
        if kind in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION, WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            uri = decision.get_navigation_action().get_request().get_uri()
            parsed = urlparse(uri)
            if parsed.scheme == 'http' and parsed.hostname == '127.0.0.1' and parsed.port == 47831:
                decision.use()
            elif parsed.scheme == 'https' and parsed.hostname == 'account.proton.me':
                # Login happens only in the official website in the user's browser.
                Gio.AppInfo.launch_default_for_uri(uri, None)
                decision.ignore()
            elif uri == 'about:blank':
                decision.use()
            else:
                decision.ignore()
            return True
        return False

    def failed(self, web, event, uri, error):
        if self.retry is None:
            self.retry = GLib.timeout_add_seconds(3, self.reload_service)
        return False

    def reload_service(self):
        self.retry = None
        if self.window is not None:
            self.web.load_uri(BASE)
        return False

    def closed(self, *_):
        self.window = None
        if self.retry is not None:
            GLib.source_remove(self.retry)
            self.retry = None

if __name__ == '__main__':
    raise SystemExit(NubeLocal().run(sys.argv))
