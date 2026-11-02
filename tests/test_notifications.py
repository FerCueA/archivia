import ast,tempfile,types,unittest
from pathlib import Path
import gi
from gi.repository import GLib
class Bus:
 def __init__(self):self.calls=[];self.callback=None
 def signal_subscribe(self,*args):self.callback=args[-1]
 def call_sync(self,*args):self.calls.append(args);return GLib.Variant('(u)',(len(self.calls),))
class Notifications(unittest.TestCase):
 def test_native_notification_is_actionable_escaped_and_deduplicated_across_restart(self):
  with tempfile.TemporaryDirectory() as tmp:
   source=Path(__file__).resolve().parents[1]/'src/tray.py';tree=ast.parse(source.read_text());func=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='notify_mint');bus=Bus();opened=[]
   gio=types.SimpleNamespace(bus_get_sync=lambda *a:bus,BusType=types.SimpleNamespace(SESSION=0),DBusSignalFlags=types.SimpleNamespace(NONE=0),DBusCallFlags=types.SimpleNamespace(NONE=0))
   env={'STATE':Path(tmp),'PROJECT':source.parents[1],'last_notification':None,'notification_bus':None,'notification_ids':set(),'Gio':gio,'GLib':GLib,'json':__import__('json'),'open_window':lambda:opened.append(True)}
   exec(compile(ast.Module(body=[func],type_ignores=[]),'tray-function','exec'),env);notify=env['notify_mint'];notify('key','Attention','a < b & c');self.assertEqual(len(bus.calls),1);self.assertEqual(bus.calls[0][4].unpack()[4],'a &lt; b &amp; c');notify('key','Again','same');self.assertEqual(len(bus.calls),1)
   env['last_notification']=None;notify('key','After restart','same');self.assertEqual(len(bus.calls),1);notify('new','New error','different');self.assertEqual(len(bus.calls),2)
   bus.callback(None,None,None,None,None,GLib.Variant('(us)',(999,'default')));self.assertEqual(opened,[]);bus.callback(None,None,None,None,None,GLib.Variant('(us)',(1,'default')));self.assertEqual(opened,[True])
if __name__=='__main__':unittest.main()

class IndicatorStatus(unittest.TestCase):
 def test_indicator_never_claims_up_to_date_for_unknown_or_pending_changes_and_exposes_review(self):
  import re,datetime
  class Item:
   label='';visible=True
   def set_label(self,value):self.label=value
   def set_sensitive(self,value):pass
   def set_visible(self,value):self.visible=value
   def set_icon_full(self,*args):self.icon=args
   def set_title(self,value):self.title=value
  with tempfile.TemporaryDirectory() as tmp:
   source=Path(__file__).resolve().parents[1]/'src/tray.py';tree=ast.parse(source.read_text());func=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='apply_state');indicator=Item();status=Item();details=[Item() for _ in range(8)]
   env={'Path':Path,'re':re,'datetime':datetime.datetime,'PROJECT':source.parents[1],'STATE':Path(tmp),'connected':False,'active':False,'inflight':False,'restart_delay':3,'service_failures':0,'current_folder':Path(tmp),'indicator':indicator,'status_item':status,'toggle_item':Item(),'eject_item':Item(),'detail_items':details}
   exec(compile(ast.Module(body=[func],type_ignores=[]),'indicator-function','exec'),env)
   state={'connected':True,'syncActive':True,'preferences':{'notifications':False},'progress':{'phase':'idle'},'summary':{'pendingCount':None},'external':{}}
   env['apply_state'](state);self.assertIn('Comprobando',status.label)
   state['summary']['pendingCount']=3;env['apply_state'](state);self.assertIn('3 elementos pendientes',status.label)
   state['summary']={'pendingCount':0,'lastCompletedAt':'2026-01-01T12:30:00Z'};env['apply_state'](state);self.assertIn('Al día',status.label);self.assertTrue(any('Última sincronización completa' in d.label for d in details))
   state['cloudSafety']={'preview':{'id':'x','reason':'review'}};env['apply_state'](state);self.assertIn('masivos',status.label);self.assertIn('tray-error.svg',indicator.icon[0])

class ClassicIcon(unittest.TestCase):
 def test_x11_primary_click_opens_window_and_right_click_opens_menu(self):
  class Icon:
   def __init__(self):self.handlers={}
   def connect(self,name,callback):self.handlers[name]=callback
   def set_visible(self,value):pass
   def is_embedded(self):return True
   def set_title(self,value):pass
   def set_tooltip_text(self,value):pass
   def set_from_file(self,value):pass
  with tempfile.TemporaryDirectory() as tmp:
   source=Path(__file__).resolve().parents[1]/'src/tray.py';tree=ast.parse(source.read_text());cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='TrayIndicator');icon=Icon();opened=[];menus=[]
   env={'os':types.SimpleNamespace(environ={'XDG_SESSION_TYPE':'x11'}),'Gtk':types.SimpleNamespace(StatusIcon=types.SimpleNamespace(new_from_file=lambda _:icon)),'GLib':types.SimpleNamespace(timeout_add_seconds=lambda *a:None),'PROJECT':source.parents[1],'STATE':Path(tmp),'json':__import__('json'),'open_window':lambda:opened.append(True)}
   exec(compile(ast.Module(body=[cls],type_ignores=[]),'tray-class','exec'),env);indicator=env['TrayIndicator']();indicator.set_menu(types.SimpleNamespace(popup=lambda *args:menus.append(args)));icon.handlers['activate'](icon);self.assertEqual(opened,[True]);icon.handlers['popup-menu'](icon,3,123);self.assertEqual(len(menus),1);indicator.check_embedding();self.assertTrue(__import__('json').loads((Path(tmp)/'tray-ui.json').read_text())['singleClick'])
