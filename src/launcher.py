#!/usr/bin/env python3
"""User entry point, also called by XDG autostart."""
import os
from pathlib import Path
import subprocess
import sys

PROJECT = Path(__file__).resolve().parents[1]
INSTALL = PROJECT.parent
STATE = Path(os.environ.get('NUBE_LOCAL_DATA', str(INSTALL / 'state')))
STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(STATE, 0o700)
env = dict(os.environ, NUBE_LOCAL_DATA=str(STATE), NUBE_LOCAL_APP=str(PROJECT))
if '--background' in sys.argv:
    os.execve(sys.executable, [sys.executable, str(PROJECT / 'src/tray.py')], env)
with (STATE / 'desktop.log').open('a') as log:
    subprocess.Popen([sys.executable, str(PROJECT / 'src/tray.py')], env=env,
                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
if '--background' not in sys.argv:
    os.execve(sys.executable, [sys.executable, str(PROJECT / 'src/desktop.py')], env)
