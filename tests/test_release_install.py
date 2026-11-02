import importlib.util,hashlib,io,json,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('update_settings',Path(__file__).resolve().parents[1]/'src/system-settings.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class DownloadInstall(unittest.TestCase):
 def package(self,root,version='0.16.2',unsafe=False):
  data=io.BytesIO()
  with tarfile.open(fileobj=data,mode='w:gz') as archive:
   for name,value in [('bin/nube-local-service',b'executable'),('scripts/install.py',b'installer'),('src/tray.py',b'tray'),('release.json',json.dumps({'version':version,'platform':'linux','arch':'x64'}).encode())]:
    entry=tarfile.TarInfo('nube-local/'+name);entry.size=len(value);archive.addfile(entry,io.BytesIO(value))
   if unsafe:
    entry=tarfile.TarInfo('nube-local/link');entry.type=tarfile.SYMTYPE;entry.linkname='/tmp/outside';archive.addfile(entry)
  # A hostile header must never be executed by the update helper.
  content=(b'#!/bin/sh\ntouch /tmp/should-never-be-executed\n#3\n#4\n#5\n#6\n#7\n__PROTON_DRIVE_ARCHIVE__\n'+data.getvalue());sha=hashlib.sha256(content).hexdigest();folder=root/'updates';folder.mkdir(exist_ok=True);file=folder/(sha+'.run');file.write_bytes(content);return file,sha
 def test_confirmed_verified_archive_uses_existing_update_worker_and_cancel_does_not_extract(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);file,sha=self.package(root)
   with patch.object(module,'STATE',root),patch.object(module,'launch_archive',return_value={'updating':True}) as launch:
    self.assertEqual(module.install_downloaded(str(file),sha,'0.16.2',confirm=lambda _:False),{'cancelled':True});launch.assert_not_called()
    self.assertEqual(module.install_downloaded(str(file),sha,'0.16.2',confirm=lambda m:m['repository']=='FerCueA/archivia'),{'updating':True});self.assertEqual(launch.call_count,1)
 def test_tampered_bytes_wrong_version_and_links_are_rejected_before_confirmation(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);file,sha=self.package(root)
   with patch.object(module,'STATE',root):
    with self.assertRaises(ValueError):module.install_downloaded(str(file),sha,'0.17.0',confirm=lambda _:self.fail('must not confirm'))
    file.write_bytes(file.read_bytes()+b'tamper')
    with self.assertRaises(ValueError):module.install_downloaded(str(file),sha,'0.16.2',confirm=lambda _:self.fail('must not confirm'))
    file,sha=self.package(root,unsafe=True)
    with self.assertRaises(ValueError):module.install_downloaded(str(file),sha,'0.16.2',confirm=lambda _:self.fail('must not confirm'))
 def test_file_outside_private_downloads_cannot_be_selected(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);file,sha=self.package(root);outside=root/'outside.run';file.rename(outside)
   with patch.object(module,'STATE',root):
    with self.assertRaises(ValueError):module.install_downloaded(str(outside),sha,'0.16.2',confirm=lambda _:True)
if __name__=='__main__':unittest.main()
