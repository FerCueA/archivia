# Archivia

Aplicación de escritorio para Linux que reúne sincronización con Proton Drive y discos externos, búsqueda de duplicados, organización de archivos, historial y recuperación.

**Proyecto independiente, no oficial ni respaldado por Proton.** La aplicación instalada se muestra actualmente como **Proton Drive**; Archivia es el nombre de este repositorio.

## Funciones

- Sincronización bidireccional con **Mis archivos** de Proton Drive: subidas, descargas, movimientos y borrados recuperables.
- Sincronización entre la carpeta local y un disco externo identificado, con revisión de cambios y expulsión segura.
- Duplicados por tamaño y SHA-256, con comprobación del contenido antes de retirar copias.
- Organización por tipo y fecha, EXIF, fechas del nombre, carpetas protegidas y selección de movimientos con vista previa.
- Historial, recuperación, revisión de cambios masivos, límites de transferencia y pausa en conexiones de uso medido.
- Exportación/importación de ajustes y actualizaciones desde GitHub Releases conservando una copia de la aplicación anterior.

La interfaz se divide en siete pestañas: Proton Drive, Disco externo, Duplicados, Organizar, Actividad, Ajustes y Actualizaciones.

## Estado y compatibilidad

Versión de desarrollo: **0.16.1**. No se recomienda tratar una sincronización como única copia de seguridad.

- Linux Mint 22.3 / Cinnamon / X11: utilizado y comprobado en el equipo de desarrollo.
- Ubuntu Desktop 24.04 x86-64: dependencias, 130 pruebas Bun, 26 pruebas Python y prueba GTK/WebKit con Secret Service en un contenedor.
- La sesión GNOME/Wayland interactiva completa y otras versiones de Ubuntu siguen pendientes de validación.
- Binario Linux x86-64 baseline, con SSE4.2. No incluye ARM ni 32 bits.

Consulta [COMPATIBILIDAD.md](COMPATIBILIDAD.md) para el alcance de las pruebas y las dependencias.

## Compilar e instalar

El repositorio contiene fuentes, no sesiones ni instaladores compilados. Requiere Node.js 22 o posterior, npm, git, patch y ripgrep para compilar. El script utiliza Bun 1.4.4 y una versión fijada del SDK oficial de Proton.

En Ubuntu/Mint:

```bash
sudo apt update
sudo apt install git patch ripgrep python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1 gir1.2-ayatanaappindicator3-0.1 libsecret-1-0 gnome-keyring python3-pil poppler-utils

git clone https://github.com/FerCueA/archivia.git
cd archivia
bash scripts/build.sh
python3 scripts/install.py --check
bash 'Instalar Nube Local.sh'
```

Ejecuta el instalador **sin sudo**, dentro de tu sesión de escritorio. Se instala para tu usuario y conserva una instalación anterior reconocida. Abre **Proton Drive** desde el menú de aplicaciones o con `bash scripts/open.sh`. La contraseña de Proton se introduce en su página oficial; la sesión se guarda en el llavero de Linux.

La carpeta predeterminada es `~/ProtonDrive`, vinculada a la raíz de **Mis archivos**. Compartido conmigo y Fotos no forman parte de esa raíz y no se incluyen.

## Actualizaciones

La pestaña Actualizaciones consulta las versiones estables de [GitHub Releases](https://github.com/FerCueA/archivia/releases), descarga el instalador y permite confirmar su instalación después de verificarlo. También admite seleccionar un `.run` manualmente. Una etiqueta `vVERSION` activa la compilación, las pruebas y la publicación automática de los archivos.

## Pruebas

Después de compilar:

```bash
work/build/runtime/node_modules/.bin/bun test ./tests/*.bun.ts
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/planner.test.js tests/connection-http.test.js
```

Las pruebas HTTP de conexión solo se ejecutan si se define `NUBE_TEST_URL`. No las apuntes a una cuenta real para realizar pruebas de modificación.

GitHub Actions incluye un flujo para Ubuntu 24.04 con compilación, pruebas y una ventana GTK/WebKit en Xvfb usando un llavero aislado, sin cuenta real de Proton.

## Licencias

El código propio se publica bajo [MIT](LICENSE). Los componentes de terceros conservan sus respectivas licencias y avisos: [licencia del SDK de Proton](PROTON-SDK-LICENSE.md) y [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt). Entre las dependencias hay componentes LGPL; MIT no sustituye sus condiciones de distribución.

## Privacidad

No subas documentos, sesiones, contraseñas, bases de datos ni copias de la carpeta de estado. Al comunicar un fallo, oculta rutas personales, direcciones de correo y cualquier credencial de los registros. Los ajustes exportados pueden contener rutas de carpetas.

## Instalación y actualizaciones

Descarga `Archivia-VERSION-linux-x64.run` de https://github.com/FerCueA/archivia/releases/latest y ejecútalo con `bash Archivia-VERSION-linux-x64.run`. El instalador añade Proton Drive al menú de aplicaciones; no necesitas Node ni usar un CLI de sincronización.

En **Actualizaciones** puedes buscar una versión, descargarla y confirmar su instalación. La consulta automática diaria es opcional; no descarga ni instala sin tu intervención. Se usa el repositorio público FerCueA/archivia sin enviar las credenciales de Proton. Se verifican el tamaño y SHA-256 del instalador, y se conservan los ajustes, documentos y una versión anterior para restaurar. SHA-256 comprueba integridad; no es una firma digital independiente de GitHub.

Para publicar una versión: actualiza las versiones y ejecuta `bash scripts/build.sh`, las pruebas y `python3 scripts/package.py`. Sube los cambios y una etiqueta `vVERSION`. GitHub Actions prueba en Ubuntu 24.04 y publica el instalador, fuentes y SHA256SUMS.txt solo después de superar las comprobaciones. Véase THIRD-PARTY-SOURCES.md para reconstrucción y componentes de terceros.
