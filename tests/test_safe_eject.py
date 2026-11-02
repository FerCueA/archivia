import importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gio,GLib,Gtk
spec=importlib.util.spec_from_file_location('settings',Path(__file__).resolve().parents[1]/'src/system-settings.py');settings=importlib.util.module_from_spec(spec);spec.loader.exec_module(settings)
class Volume:
 def get_uuid(self):return 'ABC'
class Drive:
 def __init__(self):self.calls=[];self.stopped=False
 def can_stop(self):return not self.stopped
 def can_eject(self):return False
 def stop(self,flags,operation,cancel,callback,data):
  self.calls.append('stop');self.stopped=True;GLib.idle_add(callback,self,object(),data)
 def stop_finish(self,result):self.calls.append('stop_finish');return True
class Mount:
 def __init__(self,root,drive):self.root=root;self.drive=drive;self.calls=[]
 def get_root(self):return Gio.File.new_for_path(str(self.root))
 def get_volume(self):return Volume()
 def get_drive(self):return self.drive
 def unmount_with_operation(self,flags,operation,cancel,callback,data):self.calls.append('unmount');GLib.idle_add(callback,self,object(),data)
 def unmount_with_operation_finish(self,result):self.calls.append('finish');return True
class Ejection(unittest.TestCase):
 def run_eject(self,root,mounts,protected='/home/test/ProtonDrive',volume='uuid:ABC:/'):
  monitor=type('Monitor',(),{'get_mounts':lambda _:mounts})();factory=type('Factory',(),{'get':staticmethod(lambda:monitor)})
  with patch.object(Gio,'VolumeMonitor',factory),patch.object(Gtk,'init',lambda *_:None),patch.object(Gtk,'MountOperation',lambda:object()):return settings.eject_disk(str(root),'pair',volume,protected)
 def marker(self,root):
  (root/'.proton-drive-pair.json').write_text(json.dumps({'id':'pair'}))
 def test_drive_stop_waits_for_finish_and_reports_safe_to_unplug(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);self.marker(root);drive=Drive();result=self.run_eject(root,[Mount(root,drive)]);self.assertEqual(drive.calls,['stop','stop_finish']);self.assertTrue(result['safeToUnplug'])
 def test_protected_cloud_root_on_another_partition_prevents_ejection(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);self.marker(root);drive=Drive()
   with self.assertRaises(ValueError):self.run_eject(root,[Mount(root,drive),Mount('/',drive)])
   self.assertEqual(drive.calls,[])
 def test_wrong_volume_or_marker_never_invokes_unmount(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);self.marker(root);drive=Drive()
   with self.assertRaises(ValueError):self.run_eject(root,[Mount(root,drive)],volume='uuid:OTHER:/')
   (root/'.proton-drive-pair.json').write_text('{"id":"other"}')
   with self.assertRaises(ValueError):self.run_eject(root,[Mount(root,drive)])
   self.assertEqual(drive.calls,[])
 def test_volume_only_unmount_does_not_claim_other_partitions_are_safe(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);self.marker(root);drive=Drive();drive.stopped=True;mount=Mount(root,drive);result=self.run_eject(root,[mount,Mount('/media/other',drive)]);self.assertEqual(mount.calls,['unmount','finish']);self.assertFalse(result['safeToUnplug'])
if __name__=='__main__':unittest.main()
