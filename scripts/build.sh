#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="$project_dir/work/build"
mkdir -p "$build_dir/runtime"
npm install --cache "$build_dir/npm-cache" --prefix "$build_dir/runtime" bun@1.4.4
if [[ ! -d "$build_dir/sdk/cli" ]]; then
  if [[ -f "$project_dir/vendor/proton-sdk-b68d64bd.tar.gz" ]]; then
    mkdir -p "$build_dir/sdk"
    tar -xzf "$project_dir/vendor/proton-sdk-b68d64bd.tar.gz" -C "$build_dir/sdk"
  else
    git clone https://github.com/ProtonDriveApps/sdk.git "$build_dir/sdk"
    git -C "$build_dir/sdk" checkout b68d64bd9f9c1f24be521c8b423c26f5dca1c681
  fi
fi
if [[ -f "$project_dir/vendor/cli-package-lock.json" ]]; then
  cp "$project_dir/vendor/cli-package-lock.json" "$build_dir/sdk/cli/package-lock.json"
fi
cd "$build_dir/sdk/cli"
npm ci --cache "$build_dir/npm-cache" --ignore-scripts --omit=dev --legacy-peer-deps
if [[ ! -e ../node_modules ]]; then ln -s cli/node_modules ../node_modules; fi
if rg -q 'openpgp/lightweight' node_modules/@protontech/crypto/src/pmcrypto/openpgp.ts; then
  (cd node_modules/@protontech/crypto && patch -p1 -i "$build_dir/sdk/config/js/patches/@protontech%2Fcrypto@2.0.0.patch")
fi
sed -i "s@ch.proton.drive/drive-sdk-cli@app.nube_local/proton-session@g" src/credentials/constants.ts
cp "$project_dir/src/sdk-probe.ts" src/nube-connection.ts
cp "$project_dir/src/folder-sync.ts" src/folder-sync.ts
cp "$project_dir/src/planner.js" src/planner.js
cp "$project_dir/src/local-trash.ts" src/local-trash.ts
cp "$project_dir/src/sync-state.ts" src/sync-state.ts
cp "$project_dir/src/sync-errors.ts" src/sync-errors.ts
cp "$project_dir/src/panel.ts" src/panel.ts
cp "$project_dir/src/preferences.ts" src/preferences.ts
cp "$project_dir/src/disk-adapter.ts" src/disk-adapter.ts
cp "$project_dir/src/external-sync.ts" src/external-sync.ts
cp "$project_dir/src/disk-review.ts" src/disk-review.ts
cp "$project_dir/src/duplicates.ts" src/duplicates.ts
cp "$project_dir/src/file-operations.ts" src/file-operations.ts
for module in activity recent-folders document-preview disk-diagnostics cloud-recovery organizer organization-date creation-time photo-date organization-rules cloud-safety run-health settings-transfer; do cp "$project_dir/src/$module.ts" "src/$module.ts"; done
"$build_dir/runtime/node_modules/.bin/bun" build src/nube-connection.ts --target bun --outfile "$project_dir/dist/connection.js"
mkdir -p "$project_dir/bin"
BUN_INSTALL="$build_dir/bun-install" BUN_INSTALL_CACHE_DIR="$build_dir/bun-cache" "$build_dir/runtime/node_modules/.bin/bun" build "$project_dir/dist/connection.js" --compile --target=bun-linux-x64-baseline --outfile "$project_dir/bin/nube-local-service"
echo 'Compilación terminada. Puedes ejecutar el instalador de Proton Drive.'

python3 - "$project_dir" <<'PYHASH'
import json,hashlib,sys
from pathlib import Path
root=Path(sys.argv[1]);release=root/'release.json';value=json.loads(release.read_text());value['serviceSha256']=hashlib.file_digest((root/'bin/nube-local-service').open('rb'),'sha256').hexdigest();release.write_text(json.dumps(value,indent=2)+'\n')
PYHASH
