#!/usr/bin/env python3
"""Create public installers and rebuildable sources, excluding all user state."""
import argparse, hashlib, json, re, tarfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
def digest(file):
 with file.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=root/'work/release');args=parser.parse_args()
 meta=json.loads((root/'release.json').read_text());version=meta['version']
 if not re.fullmatch(r'\d+\.\d+\.\d+',version):raise ValueError('Invalid version')
 if digest(root/'bin/nube-local-service')!=meta['serviceSha256']:raise ValueError('Binary checksum mismatch')
 output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
 common=['assets','src','scripts','Instalar Nube Local.sh','README.md','COMPATIBILIDAD.md','LICENSE','PROTON-SDK-LICENSE.md','THIRD-PARTY-NOTICES.txt','BUN-LICENSE.md','THIRD-PARTY-SOURCES.md','release.json']
 def filter_member(member):
  if '__pycache__' in Path(member.name).parts or member.name.endswith('.pyc'):return None
  if member.issym() or member.islnk():raise ValueError('Unexpected link: '+member.name)
  member.uid=member.gid=0;member.uname=member.gname='';return member
 installer=output/f'Archivia-{version}-linux-x64.run'
 header='''#!/usr/bin/env bash
set -euo pipefail
package_dir="$(mktemp -d -t proton-drive-installer.XXXXXX)"
trap 'rm -rf -- "$package_dir"' EXIT
tail -n +9 "$0" | tar -xz -C "$package_dir"
"$package_dir/nube-local/Instalar Nube Local.sh" "$@"
exit 0
__PROTON_DRIVE_ARCHIVE__
'''
 with installer.open('wb') as stream:
  stream.write(header.encode())
  with tarfile.open(fileobj=stream,mode='w:gz') as archive:
   for name in ['bin']+common:archive.add(root/name,arcname='nube-local/'+name,filter=filter_member)
 installer.chmod(0o755)
 source=output/f'Archivia-{version}-sources.tar.gz'
 with tarfile.open(source,'w:gz') as archive:
  for name in common+['.github','.gitignore','tests','vendor','package.json','example.json','dist/connection.js']:
   archive.add(root/name,arcname='archivia/'+name,filter=filter_member)
 (output/'SHA256SUMS.txt').write_text(''.join(digest(file)+'  '+file.name+'\n' for file in [installer,source]))
 print(output)
if __name__=='__main__':main()
