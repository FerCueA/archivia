# Compatibilidad de Proton Drive no oficial · 0.16.2

| Entorno | Comprobaciones realizadas | Alcance |
|---|---|---|
| Linux Mint 22.3 / Cinnamon / X11 · x86-64 | Instalación, programa conectado, bandeja y pruebas de funciones | Equipo de desarrollo |
| Ubuntu Desktop 24.04 LTS · x86-64 | Dependencias, instalador aislado, 130 pruebas Bun, 26 pruebas Python, servicio con llavero Secret Service y ventana GTK/WebKit con siete pestañas | Contenedor Ubuntu 24.04; ventana en Xvfb |
| GNOME con X11 o Wayland | Selección de AppIndicator, diagnóstico y lanzador acorde con el identificador GTK | Pruebas de selección; falta sesión GNOME/Wayland interactiva completa |
| Ubuntu 22.04, 26.04 y otras distribuciones | Diagnóstico de dependencias disponible | Sin validación completa específica |
| ARM o Linux de 32 bits | No hay ejecutable incluido para estas arquitecturas | Necesita otra compilación |

Las pruebas en contenedor usan el kernel del equipo anfitrión. No equivalen a una prueba física completa de Ubuntu, un disco USB o una sesión Wayland. No se ha utilizado ninguna cuenta real de Proton en el contenedor.

## Instalar dependencias en Ubuntu o Mint

```bash
sudo apt update
sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1 gir1.2-ayatanaappindicator3-0.1 libsecret-1-0 gnome-keyring python3-pil poppler-utils
```

El escritorio necesita D-Bus y un proveedor Secret Service, como GNOME Keyring. Inicia el programa dentro de la sesión gráfica del usuario. En GNOME, el icono usa AppIndicators; si no aparece, revisa la extensión del escritorio. En instalaciones que no la incluyan:

```bash
sudo apt install gnome-shell-extension-appindicator
```

El programa sigue disponible en el menú de aplicaciones aunque no haya un anfitrión de bandeja. En Cinnamon/X11 utiliza el icono clásico con clic izquierdo para abrir y derecho para el menú; en GNOME/AppIndicator la apertura está en el menú del icono o en la activación secundaria permitida por el escritorio.

Las notificaciones, el inicio automático, la papelera, el selector de archivos y la expulsión de discos emplean interfaces estándar de Linux. No se llama a Nemo ni a herramientas exclusivas de Mint. El lanzador de GNOME coincide con `app.nube_local.desktop`; el acceso anterior se conserva oculto del menú para mantener anclajes existentes.

## Comprobar sin instalar

```bash
bash Archivia-0.16.2-linux-x64.run --check
```

El diagnóstico no modifica la aplicación. Comprueba x86-64, SSE4.2, glibc y bibliotecas; informa de componentes opcionales. El ejecutable usa el objetivo `bun-linux-x64-baseline`, sin exigir AVX2. Las distribuciones o arquitecturas sin dependencias compatibles no quedan soportadas por mostrar este diagnóstico.

## Reproducir las comprobaciones

La fuente incluye `.github/workflows/ubuntu.yml` para Ubuntu 24.04, compilación y pruebas. Después de compilar:

```bash
work/build/runtime/node_modules/.bin/bun test ./tests/*.bun.ts
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/install.py --check
# Requiere dbus-x11, xvfb y xauth. Usa una sesión de prueba sin cuenta de Proton.
dbus-run-session -- xvfb-run -a python3 tests/desktop_smoke.py
```

La prueba gráfica inicia un servicio sin sincronización activa, comprueba la interfaz real de GTK/WebKit y termina limpiamente. Para probar GNOME/Wayland de forma completa queda pendiente verificar la bandeja, el acceso desde el menú, la autorización en el navegador y suspensión/reanudación en una VM o equipo Ubuntu.

Fuentes de integración: [GNOME en Ubuntu](https://help.ubuntu.com/stable/ubuntu-help/gnome-on-ubuntu.html.es), [AppIndicators de Ubuntu](https://github.com/ubuntu/gnome-shell-extension-appindicator), [requisitos del runtime Bun](https://bun.sh/docs/installation).
