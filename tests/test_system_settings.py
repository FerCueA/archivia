import importlib.util,json,tarfile,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('settings',Path(__file__).resolve().parents[1]/'src/system-settings.py');settings=importlib.util.module_from_spec(spec);spec.loader.exec_module(settings)
class Integration(unittest.TestCase):
 def test_autostart_toggle_keeps_entry_and_launcher(self):
  with tempfile.TemporaryDirectory() as tmp:
   settings.AUTOSTART=Path(tmp)/'autostart/app.desktop';settings.autostart(False)
   self.assertIn('X-GNOME-Autostart-enabled=false',settings.AUTOSTART.read_text());self.assertIn('--background',settings.AUTOSTART.read_text());settings.autostart(True);self.assertIn('X-GNOME-Autostart-enabled=true',settings.AUTOSTART.read_text())
 def members(self):return [tarfile.TarInfo(n) for n in ['nube-local/bin/nube-local-service','nube-local/scripts/install.py','nube-local/src/tray.py']]
 def test_updater_accepts_complete_regular_payload(self):settings.validate_archive(self.members())
 def test_updater_rejects_traversal_links_duplicates_and_incomplete_payload(self):
  for name in ['../outside','/tmp/outside','nube-local/../outside','nube-local//src/a']:
   with self.assertRaises(ValueError):settings.validate_archive(self.members()+[tarfile.TarInfo(name)])
  link=tarfile.TarInfo('nube-local/link');link.type=tarfile.SYMTYPE;link.linkname='/tmp'
  with self.assertRaises(ValueError):settings.validate_archive(self.members()+[link])
  with self.assertRaises(ValueError):settings.validate_archive(self.members()+[self.members()[0]])
  with self.assertRaises(ValueError):settings.validate_archive([])
 def test_updater_rejects_oversized_payload(self):
  members=self.members();members[0].size=601*1024**2
  with self.assertRaises(ValueError):settings.validate_archive(members)
if __name__=='__main__':unittest.main()
