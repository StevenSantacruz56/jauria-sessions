# Instalar Jauria en macOS

La distribución actual es para Mac con Apple Silicon (arm64/aarch64). La configuración de la app declara macOS 11.0 como mínimo; la compatibilidad solo se ha validado en el Mac actual de pruebas, no en todas las versiones desde macOS 11. No hay paquete Intel ni Windows en esta distribución.

## Descargar e instalar 1.3.3

La [release v1.3.3](https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.3.3) ofrece el código fuente y un DMG verificado para Apple Silicon. El DMG **no tiene firma Developer ID ni notarización**; lee la sección de firma antes de instalarlo.

1. Descarga de esa misma release `Jauria_1.3.3_aarch64_unsigned.dmg`, `SHA256SUMS` y `Jauria_1.3.3_aarch64_unsigned.dmg.receipt.json`. Conserva los tres juntos; describen la misma imagen y sus verificaciones.
2. Para comprobar el archivo, ejecuta desde esa carpeta:

   ```sh
   shasum -a 256 -c SHA256SUMS
   ```

3. Abre el DMG y arrastra **Jauria.app** al acceso directo **Applications**.
4. Expulsa la imagen y abre Jauria desde Aplicaciones. No ejecutes la app directamente desde el DMG.
5. Pulsa **Nueva sesión**, elige Codex, Claude Code o Terminal y la carpeta de trabajo, y pulsa **Abrir sesión**. Vincularla a un proyecto de Pulso es opcional.

Conserva una sola `Jauria.app` en **/Applications**. Los bundles que aparecen en `target/debug` o `target/release` al compilar son salidas de desarrollo, no instalaciones adicionales; macOS puede mostrarlos como apps si se abrieron durante pruebas. Retira o archiva copias antiguas sin borrar el perfil de datos. La lista reciente de un lanzador puede tardar en reflejar la limpieza aunque Spotlight y Launch Services ya apunten a la app instalada.

Para ejecutar Jauria no necesitas Rust, Cargo, Node ni npm. Las CLI de proveedores se instalan y autentican por separado; Jauria no hace login ni importa sus credenciales. Esta versión busca Codex en `/opt/homebrew/bin/codex` y Claude Code en `~/.local/bin/claude`; comprueba **Información → Diagnóstico → Comprobar CLI** si no aparecen disponibles. Terminal usa `/bin/zsh -il` y no necesita un proveedor de IA.

Descarga siempre el DMG, checksum y recibo de la **misma** [release](https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.3.3). El checksum identifica el archivo; no aporta firma de editor ni notarización. Las releases anteriores no sustituyen la verificación de versión y checksum del paquete que instales.

## Estado de firma de esta distribución

`Jauria_<versión>_aarch64_unsigned.dmg` identifica una app sin firma Developer ID validada para distribución. Puede tener firma Apple Development o ad-hoc; eso no equivale a Developer ID ni a notarización. Esta entrega **no es una distribución pública sin fricción**: macOS puede bloquear una app descargada que no tiene las verificaciones necesarias. No desactives Gatekeeper ni elimines la cuarentena para instalarla. Si macOS la bloquea, solicita una release Developer ID notarizada al responsable de la distribución.

La firma Developer ID, la notarización y el stapling para distribución están pendientes de las credenciales y certificados correspondientes. Una identidad Apple Development no los sustituye. El empaquetador no firma, no busca identidades en el llavero y no solicita ni carga secretos.

Los nombres `_signed.dmg` y `_notarized.dmg` solo se usan si el script valida la firma Developer ID de la **app incluida**. `_notarized` exige además evaluación Gatekeeper y validación de su ticket stapled. El recibo deja explícito que el contenedor DMG creado por este script no está firmado ni notarizado (`dmgSigned: false`, `dmgNotarized: false`); las etiquetas describen la app incluida. `signed` en el recibo indica que codesign verificó una firma, incluso si es de desarrollo o ad-hoc; `developerIdSigned` distingue la firma válida para distribución.

## Actualizar una instalación existente

Guarda tu trabajo y termina de forma controlada las sesiones y procesos de trabajo administrados por Jauria antes de reemplazar la app o reiniciar el runner. Cierra la interfaz, reemplaza Jauria.app en Aplicaciones y vuelve a abrirla. Cerrar la interfaz no garantiza que el runner ni los procesos hayan terminado: comprueba su estado y usa la acción de reiniciar runner solo después de terminar el trabajo activo.

Las funciones nuevas del backend requieren un runner actualizado. Si **Configuración → Acerca de y diagnóstico** avisa de que las versiones no coinciden o de un runner anterior, usa **Reiniciar runner…** solo después de terminar el trabajo activo. Las sesiones antiguas no cambian de ejecutable ni de permisos al instalar la app.

Desde 1.0.1, el código propio se licencia bajo GPL-3.0-only. El bundle incorpora LICENSE y NOTICE; el DMG añade ambos textos y `SOURCE_REFERENCE.txt`, con enlaces a la etiqueta y al archivo de fuente de su misma versión. Esa referencia no entrega automáticamente el código ni certifica cumplimiento de GPL. Si redistribuyes binarios, proporciona la fuente correspondiente y los materiales de compilación conforme a [LICENSE](../LICENSE); el destinatario debe poder acceder al código. Un repositorio privado inaccesible para él no basta.

El paquete incluye el bundle proporcionado, esta guía, la licencia, la referencia a la fuente y los avisos de terceros disponibles. No se copian perfiles de usuario, tokens del runner, credenciales ni configuraciones de proveedores desde el equipo que empaqueta. El empaquetador rechaza rutas absolutas `/Users/<cuenta>/` dentro del bundle. La actualización conserva los datos externos de tu perfil; no los añadas manualmente al bundle ni al DMG.

## Crear el paquete desde un bundle existente

Este paso es para quien prepara la release, en macOS Apple Silicon, con Python 3.9 o posterior y las herramientas nativas `ditto`, `lipo`, `codesign` y `hdiutil`. La comprobación de notarización usa también `spctl` y `xcrun stapler`. No requiere reconstruir la app ni instalar dependencias Python.

Desde la raíz del repositorio:

```sh
python3 scripts/package-macos.py --app /ruta/absoluta/Jauria.app
```

La salida predeterminada es `dist/macos` dentro del repositorio. Puedes elegir un directorio distinto con `--output /ruta/absoluta/paquetes`. El script rechaza un destino que atraviese symlinks, esté dentro del bundle o contenga cualquiera de los archivos de salida. Usa un directorio de salida nuevo para cada entrega; nunca se sobrescriben un DMG, su recibo o `SHA256SUMS`.

Para exigir una app ya firmada y notarizada:

```sh
python3 scripts/package-macos.py --app /ruta/absoluta/Jauria.app --output /ruta/absoluta/paquetes --require-notarized
```

Esta opción verifica `codesign --verify --deep --strict` con requisito Developer ID, `spctl --assess` y `xcrun stapler validate` antes de crear el artefacto. No firma ni envía la app a Apple. El script comprueba la versión contra `VERSION`, los dos binarios arm64, rutas personales en el bundle y la copia temporal; crea una imagen comprimida UDZO y verifica su integridad con `hdiutil verify` antes de publicarla junto al checksum y recibo.

Antes de publicar una nueva versión en GitHub Releases, monta el DMG en modo de solo lectura y comprueba su contenido; verifica la app en un perfil aislado del equipo de prueba. Los tests unitarios simulan las herramientas y no crean imágenes reales. Esta verificación no sustituye una prueba de Gatekeeper sobre una descarga real ni una firma Developer ID.

La elección de DMG sigue el formato habitual de distribución de macOS descrito por [Tauri: DMG](https://v2.tauri.app/distribute/dmg/). La separación entre firma Developer ID, notarización y ad-hoc sigue [Tauri: macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/).
