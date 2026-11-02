# Fuentes y reconstrucción de componentes

Archivia incluye el SDK oficial de Proton Drive, Bun y OpenPGP. Sus licencias se conservan en PROTON-SDK-LICENSE.md, BUN-LICENSE.md y THIRD-PARTY-NOTICES.txt.

El archivo de fuentes de cada publicación incluye el proyecto, el SDK fijado en vendor/proton-sdk-b68d64bd.tar.gz y OpenPGP 6.3.1 en vendor/openpgp-6.3.1-source.tar.gz (commit y SHA-256 en vendor/openpgp-source.json). OpenPGP conserva su licencia LGPL y puede modificarse y reconstruirse siguiendo las instrucciones de su archivo fuente.

El ejecutable usa Bun 1.4.4: https://github.com/oven-sh/bun/tree/bun-v1.4.4. BUN-LICENSE.md contiene las licencias de Bun y de sus bibliotecas, incluido JavaScriptCore, y las instrucciones y enlaces para obtener y reconstruir sus fuentes correspondientes. Para usar un runtime modificado, reconstruye Bun según sus instrucciones y ejecuta `bun build dist/connection.js --compile --target=bun-linux-x64-baseline --outfile bin/nube-local-service` con ese runtime. El paquete de fuentes incluye dist/connection.js; para modificar las bibliotecas JavaScript, cambia sus fuentes y vuelve a ejecutar scripts/build.sh adaptando las versiones necesarias. El hash serviceSha256 de release.json debe corresponder al ejecutable reconstruido.

Estos permisos de modificación y reconstrucción se mantienen para los componentes cubiertos por sus licencias. El código propio se distribuye bajo MIT.
