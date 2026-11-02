#!/usr/bin/env bash
set -euo pipefail
launcher="${HOME}/.local/share/nube-local/nube-local"
if [[ ! -x "$launcher" ]]; then
  echo 'Primero compila con scripts/build.sh e instala con «Instalar Nube Local.sh», sin sudo.' >&2
  exit 1
fi
exec "$launcher" "$@"
