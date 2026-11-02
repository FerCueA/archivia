import importlib.util,json,tempfile,unittest,types
from pathlib import Path
from unittest.mock import patch
SRC=Path(__file__).resolve().parents[1]/'src'
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,SRC/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
versions=load('versions','version-manager.py');settings=load('versions_settings','system-settings.py')
def app(folder,version):
 for name in ['bin/nube-local-service','src/launcher.py','src/tray.py']:
  file=folder/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_text('test')
 (folder/'release.json').write_text(json.dumps({'version':version}))
class Versions(unittest.TestCase):
 def test_rollback_preserves_documents_indexes_and_preferences_and_pauses_sync(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);app(root/'app','0.14.0');app(root/'app-previous-1','0.13.0');state=root/'state';state.mkdir();(state/'preferences.json').write_text('{"autostart":false}');(state/'sync-state.sqlite').write_bytes(b'index');(state/'external-sync.json').write_text('{"enabled":true,"target":"/mnt/disk"}');(root/'document').write_text('keep');stopped=[]
   self.assertEqual(versions.rollback(root,root/'app-previous-1',lambda:stopped.append(True)),'0.13.0');self.assertEqual(stopped,[True]);self.assertEqual((state/'sync-state.sqlite').read_bytes(),b'index');self.assertEqual((state/'preferences.json').read_text(),'{"autostart":false}');self.assertFalse(json.loads((state/'sync-enabled.json').read_text())['enabled']);self.assertFalse(json.loads((state/'external-sync.json').read_text())['enabled']);self.assertEqual((root/'document').read_text(),'keep');self.assertEqual(json.loads((versions.previous_apps(root)[0]/'release.json').read_text())['version'],'0.14.0')
 def test_invalid_copy_and_failure_to_stop_leave_current_application_intact(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);app(root/'app','0.14.0');app(root/'app-previous-1','0.13.0');(root/'app-previous-link').symlink_to(root/'app',target_is_directory=True)
   self.assertEqual(len(versions.previous_apps(root)),1)
   with self.assertRaises(ValueError):versions.rollback(root,root/'app',lambda:None)
   def fail():raise RuntimeError('busy')
   with self.assertRaises(RuntimeError):versions.rollback(root,root/'app-previous-1',fail)
   self.assertEqual(json.loads((root/'app/release.json').read_text())['version'],'0.14.0')
 def test_failed_update_healthcheck_restores_only_the_newly_created_previous_copy(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);app(root/'app','0.14.0');app(root/'app-previous-1','0.12.0');state=root/'state';state.mkdir();(state/'sync-state.sqlite').write_bytes(b'index');target=root/'package';(target/'nube-local').mkdir(parents=True);(target/'nube-local/release.json').write_text('{"version":"0.15.0"}')
   def install(*args,**kw):(root/'app').rename(root/'app-previous-9');app(root/'app','0.15.0')
   manager=types.SimpleNamespace(previous_apps=versions.previous_apps,update_lock=versions.update_lock,rollback=lambda r,p,**kw:versions.rollback(r,p,lambda:None,**kw))
   with patch.object(settings,'INSTALL',root),patch.object(settings,'STATE',state),patch.object(settings,'version_manager',lambda:manager),patch.object(settings,'update_healthy',lambda expected:False),patch.object(settings.subprocess,'run',install),patch.object(settings.subprocess,'Popen'):
    result=settings.apply_update(target)
   self.assertFalse(result['ok']);self.assertIn('restauró 0.14.0',result['message']);self.assertEqual(json.loads((root/'app/release.json').read_text())['version'],'0.14.0');self.assertEqual((state/'sync-state.sqlite').read_bytes(),b'index');self.assertFalse(target.exists())
if __name__=='__main__':unittest.main()

class InterruptedSwap(unittest.TestCase):
 def test_stable_launcher_restores_a_complete_copy_after_the_old_application_was_renamed(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);app(root/'app-previous-1','0.14.0');app(root/'app-staging-1','0.15.0');state=root/'state';state.mkdir();(state/'sync-state.sqlite').write_bytes(b'index');(root/'document').write_text('keep');versions.bootstrap.durable_json(root/'app-swap.json',{'old':'app-previous-1','new':'app-staging-1'})
   self.assertTrue(versions.bootstrap.recover_swap(root));self.assertEqual(json.loads((root/'app/release.json').read_text())['version'],'0.14.0');self.assertEqual((state/'sync-state.sqlite').read_bytes(),b'index');self.assertEqual((root/'document').read_text(),'keep');self.assertFalse(json.loads((state/'sync-enabled.json').read_text())['enabled']);self.assertFalse((root/'app-swap.json').exists())
 def test_simultaneous_restore_is_blocked_and_swap_paths_cannot_escape_installation(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);app(root/'app','0.14.0');app(root/'app-previous-1','0.13.0')
   with versions.update_lock(root):
    with self.assertRaises(RuntimeError):versions.rollback(root,root/'app-previous-1',lambda:None)
   versions.bootstrap.durable_json(root/'app-swap.json',{'old':'../escape','new':'app-staging-1'})
   with self.assertRaises(ValueError):versions.bootstrap.recover_swap(root)
   self.assertEqual(json.loads((root/'app/release.json').read_text())['version'],'0.14.0')

class VersionIntegrity(unittest.TestCase):
 def test_damaged_binary_is_rejected_before_restore(self):
  import hashlib
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);app(root/'app','0.14.0');old=root/'app-previous-1';app(old,'0.14.0');binary=old/'bin/nube-local-service';value={'version':'0.14.0','serviceSha256':hashlib.sha256(binary.read_bytes()).hexdigest()};(old/'release.json').write_text(json.dumps(value));self.assertTrue(versions.bootstrap.valid(old));binary.write_text('damaged');self.assertFalse(versions.bootstrap.valid(old))
   with self.assertRaises(ValueError):versions.rollback(root,old,lambda:None)
   self.assertTrue((root/'app').is_dir())
