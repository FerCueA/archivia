import importlib.util,unittest,types,ast,tempfile,json
from pathlib import Path
SRC=Path(__file__).resolve().parents[1]/'src';spec=importlib.util.spec_from_file_location('platform_check',SRC/'platform-check.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Platforms(unittest.TestCase):
 def test_ubuntu_gnome_uses_indicators_on_wayland_and_x11_while_cinnamon_keeps_primary_click(self):
  deps={k:True for k in ['Gtk','WebKit2','AyatanaAppIndicator3','libsecret','flock','Pillow','PDF']}
  for session in ['wayland','x11']:
   report=module.inspect_runtime({'ID':'ubuntu','VERSION_ID':'24.04','PRETTY_NAME':'Ubuntu 24.04'}, {'XDG_CURRENT_DESKTOP':'ubuntu:GNOME','XDG_SESSION_TYPE':session,'DBUS_SESSION_BUS_ADDRESS':'test'},'x86_64',('glibc','2.39'),deps,'sse4_2');self.assertTrue(report['ok']);self.assertEqual(report['trayBackend'],'appindicator')
  self.assertEqual(module.desktop_backend({'XDG_CURRENT_DESKTOP':'X-Cinnamon','XDG_SESSION_TYPE':'x11'}),'classic-x11')
 def test_preflight_rejects_wrong_architecture_or_missing_core_libraries_and_optional_tools_only_warn(self):
  deps={k:True for k in ['Gtk','WebKit2','AyatanaAppIndicator3','libsecret','flock']}
  report=module.inspect_runtime({}, {},'aarch64',('glibc','2.39'),deps,'');self.assertFalse(report['ok']);self.assertTrue(any('ARM' in e for e in report['errors']))
  report=module.inspect_runtime({}, {},'x86_64',('glibc','2.39'),deps,'sse4_2');self.assertTrue(report['ok']);self.assertTrue(any('EXIF' in w for w in report['warnings']))
  deps['WebKit2']=False;report=module.inspect_runtime({}, {},'x86_64',('glibc','2.39'),deps,'sse4_2');self.assertFalse(report['ok']);self.assertIn('gir1.2-webkit2-4.1',report['installCommand'])
 def test_gnome_tray_never_tries_legacy_status_icon_even_on_x11(self):
  cls=next(n for n in ast.parse((SRC/'tray.py').read_text()).body if isinstance(n,ast.ClassDef) and n.name=='TrayIndicator')
  calls=[]
  class Native:
   def set_status(self,*a):pass
   def set_title(self,*a):pass
  with tempfile.TemporaryDirectory() as tmp:
   env={'os':types.SimpleNamespace(environ={'XDG_SESSION_TYPE':'x11','XDG_CURRENT_DESKTOP':'ubuntu:GNOME'}),'Gtk':types.SimpleNamespace(),'GLib':types.SimpleNamespace(),'PROJECT':SRC.parent,'STATE':Path(tmp),'json':json,'AppIndicator':types.SimpleNamespace(Indicator=types.SimpleNamespace(new=lambda *a:Native()),IndicatorCategory=types.SimpleNamespace(APPLICATION_STATUS=0),IndicatorStatus=types.SimpleNamespace(ACTIVE=0))}
   exec(compile(ast.Module(body=[cls],type_ignores=[]),'indicator-platform','exec'),env);indicator=env['TrayIndicator']();self.assertIsNone(indicator.classic);self.assertEqual(json.loads((Path(tmp)/'tray-ui.json').read_text())['backend'],'appindicator')
