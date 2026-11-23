# Jauria — sesiones de Claude Code y Codex en macOS

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="experiments/tauri-vertical/desktop/public/brand/jauria-logo-horizontal-oscuro.svg">
  <img src="experiments/tauri-vertical/desktop/public/brand/jauria-logo-horizontal-transparente.svg" alt="Jauría" width="240">
</picture>

[Español](README.md) · [English](README.en.md)

**Jauria is a macOS desktop session manager for Claude Code, OpenAI Codex and terminals, built with Tauri and Rust.**

Jauria es una aplicación de escritorio para macOS que reúne **Codex, Claude Code y terminales zsh**. Abre sesiones en cualquier carpeta, organízalas, consulta su historial y trabaja con dos paneles lado a lado. Puedes ejecutar hasta 8 sesiones simultáneas configurables; ver dos paneles no limita el número de sesiones abiertas. Para editar un mismo repositorio en paralelo, usa un worktree Git distinto por sesión.

**Versión estable: 1.3.3 · macOS Apple Silicon · código GPLv3.** Consulta [VERSION](VERSION), el [changelog](CHANGELOG.md), las [notas de 1.3.3](docs/RELEASE_1.3.3.md) y la [release de GitHub](https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.3.3). El DMG se publica sin firma Developer ID ni notarización; consulta sus límites antes de instalarlo.

Proyecto independiente, sin afiliación con OpenAI ni Anthropic.

> Esta rama (`feat/redesign-1.4`) contiene el rediseño **1.4 sin publicar**: describe funciones de 1.4 que aún no tienen release ni etiqueta. La versión publicada sigue siendo 1.3.3; su app no puede guardar **Configuración** con su propio runner (ver [CHANGELOG](CHANGELOG.md)).

## Para qué sirve

Para quien ya trabaja con las CLI de Codex o Claude Code y necesita mantener a mano la carpeta, el estado y la salida de cada sesión. Puedes abrir una sesión sin registrar un proyecto, consultar una sesión terminada o ver dos sesiones lado a lado. Para dos tareas de programación sobre un mismo repositorio, usa worktrees separados.

La opción **Terminal** abre una terminal normal con `/bin/zsh -il`, para ejecutar comandos como `pwd`, `git status` o las pruebas de tu proyecto. Carga la configuración de inicio de tu zsh y no requiere una CLI de IA.

Las sesiones interactivas de **Claude Code** cargan la configuración y los servidores MCP de tu cuenta y de la carpeta elegida, siguiendo las aprobaciones y la confianza de Claude. `/mcp` permite consultarlos. La prueba de diagnóstico permanece aislada, con MCP desactivados. Tras actualizar desde una versión que los desactivaba, abre una nueva sesión de Claude: los flags de un proceso ya iniciado no cambian.

Los permisos de las sesiones nativas se resuelven mediante la configuración de Claude Code o Codex de tu cuenta y de la carpeta elegida. Jauria no sustituye el modo de permisos ni copia aprobaciones entre proyectos. Las decisiones guardadas se reutilizan según su alcance; una autorización solo para la sesión puede volver a pedirse en otra. Los cambios del lanzador se aplican a sesiones nuevas, sin alterar procesos ya iniciados. Consulta [permisos y decisiones](docs/NATIVE_PERMISSIONS.md).

## Uso rápido

Con la aplicación abierta:

1. Pulsa **Nueva sesión** o `⌘N`.
2. Elige **Codex**, **Claude Code** o **Terminal** en Herramienta.
3. La carpeta personal viene seleccionada. Elige otra **Carpeta de trabajo** si lo necesitas; puedes volver con **Usar mi carpeta personal**. No hace falta registrar un proyecto.
4. Añade un **Nombre** opcional y pulsa **Iniciar sesión**.
5. En Codex o Claude Code, escribe tu petición y atiende los permisos que solicite la herramienta. En Terminal, ejecuta tus comandos habituales, por ejemplo:

   ```sh
   pwd
   git status  # si elegiste una carpeta dentro de un repositorio Git
   ```

Pulsa **Dividir** para mostrar dos paneles y elige una sesión distinta en el menú de cada uno. Dividir cambia la vista; no crea otra sesión. El selector separa **Abiertas** e **Historial**, y distingue las sesiones con nombres iguales por carpeta o identificador. El límite predeterminado es de **dos sesiones simultáneas** y puedes cambiarlo entre 1 y 8 en **Configuración…** (`⌘,`). El límite es compartido por los proveedores. Reducirlo no detiene sesiones abiertas. Las sesiones con estado incierto pueden seguir ocupando una plaza hasta resolverlas.

Pulsa `⌘⇧P` o el botón de búsqueda de la barra superior para abrir la **paleta de comandos**: escribe parte del nombre de una sesión, un tablero de Pulso o una acción (sin importar mayúsculas ni acentos; las iniciales también sirven) y pulsa Intro. Primero aparecen las sesiones que te necesitan. Las acciones que no están disponibles se muestran con el motivo. **Terminar** y **Cambiar nombre** abren su confirmación o formulario habitual, e **Interrumpir** solo enfoca su botón; la paleta nunca escribe en el terminal. Escape la cierra y devuelve el foco al terminal.

| Atajo | Acción |
| --- | --- |
| `⌘N` | Nueva sesión |
| `⌘⇧P` | Paleta de comandos |
| `⌘K` | Buscar en la lista de agentes |
| `⌘I` | Mostrar u ocultar Información |
| `⌘,` | Configuración |

Abre **Acciones de la sesión → Cambiar nombre…** en el menú de los tres puntos del panel para cambiar el nombre de una sesión activa o del historial. El nuevo nombre se guarda localmente y no modifica la conversación del proveedor.

En **Configuración…** puedes elegir la apariencia y el máximo de sesiones. El cambio de capacidad se aplica a los próximos inicios; se mantienen las protecciones de worktree. La apariencia se guarda para la interfaz local; la capacidad se guarda en el perfil del runner.

Actualizar el código o reemplazar la app no actualiza un runner que ya está ejecutándose. Si Información → Diagnóstico indica un runner anterior, termina primero el trabajo activo y usa **Reiniciar runner…**. Las nuevas opciones de capacidad, renombrado y lanzamiento se habilitan con el runner actualizado; las preferencias nativas de permisos se aplican a sesiones nuevas.

## Pulso: un tablero por proyecto

Pulso presenta el trabajo en cuatro columnas fijas: **Por hacer, En curso, En espera y Hecho**. Cada proyecto tiene su pestaña; **Pendientes** es una pestaña fija para tarjetas sin proyecto, incluidas las terminadas.

1. En Pulso, pulsa el **+** (Nuevo proyecto) de la barra superior, junto a las pestañas de tableros. Escribe el nombre y confirma **Crear proyecto**. Si hay sesión actual, la casilla para usarla como principal aparece marcada; puedes desmarcarla. El proyecto se abre como pestaña de tablero.
2. Usa **Añadir fase** dentro de cualquiera de las tres primeras columnas. En Pendientes, la acción es **Añadir pendiente**.
3. Arrastra el agarre de una tarjeta a otra columna o abre su menú **…** (Mover a Por hacer, En curso, En espera o Hecho), también con el teclado. Cambia el estado conservando el orden de fases; no hay reordenación dentro de una columna, columnas personalizadas ni traslado entre proyectos.
4. El título de una tarjeta abre el drawer derecho; no inicia un PTY. Allí puedes editar título, notas y estado, consultar el último avance y siguiente paso, y desplegar **Guardar avance** para añadir un checkpoint inmutable. El historial carga 10 por página.
5. **Plan y sesiones**, en la barra del proyecto, abre el plan opcional, la sesión principal y los vínculos. El acceso automático a Pulso y los avisos de macOS se administran en **Configuración**. El tablero recuerda el último proyecto y ofrece **Abrir sesión principal**, **Reanudar sesión principal** o **Abrir conversación activa**, según su estado.

Puedes volver directamente a una sesión viva, consultar su historial o editar y copiar contexto para abrir una sesión nueva vacía. Jauria no envía ese contexto al PTY. La reanudación Claude por ID reservado sigue siendo un intento sujeto al historial del proveedor y a los bloqueos existentes; Codex conserva terminal, historial y contexto, sin reanudación nativa. La CLI local mantiene permisos manuales acotados por proyecto y políticas revocables. La importación del Site y la sincronización en la nube siguen pendientes.

### Pulso con Claude Code y Codex

Pulso es el tablero local de proyectos, fases y avances de Jauría. En 1.3.3, las sesiones nuevas de Claude Code y Codex iniciadas desde Jauría reciben automáticamente el MCP `jauria-pulso` y acceso a todos los proyectos locales, incluida la creación. El interruptor **Configuración → Pulso para agentes → Acceso automático a Pulso** está activado por defecto y permite apagarlo. Cada sesión usa una credencial privada revocada al terminar; Jauría no cambia los permisos nativos de archivos, comandos o red.

Una conversación ya abierta no carga el MCP añadido después de iniciarse. Para continuar allí, usa **Configuración → Acceso manual para sesiones existentes** y **Copiar instrucciones para el agente**. Ese texto incluye la ruta del permiso privado, pero no su token; compártelo únicamente en la conversación elegida. Las políticas manuales recordadas pueden acotar el acceso por proyecto, herramienta y carpeta. [Alcance y seguridad](docs/PULSO.md#privacidad-permisos-y-límites).

Cuando un programa emite explícitamente **OSC 7501**, la vista viva y **Actividad** muestran su estado. Esta señal no cambia fases ni prueba que el trabajo esté validado. No se instalan hooks ni se modifica la configuración de los agentes. Sin emisión, la sesión aparece como **progreso no informado**, aunque su proceso siga abierto; el replay no genera estados ni avisos. Desde 1.4, con un runner 1.4, el runner lee esas señales y conserva el estado, la duración del turno y lo que ya viste: sobreviven a cerrar la ventana y reconectar. Con un runner 1.3.x la reconexión reinicia este estado efímero.

El tablero consulta un snapshot acotado con contadores y páginas por columna; no hay polling de Pulso oculto. Se conservan los presupuestos locales de 1.1.0 y el respaldo consistente de SQLite. Consulta [la guía de Pulso](docs/PULSO.md), [la revisión de Herdr y decisiones](docs/HERDR_REVIEW.md), [las reglas de estados de 1.3.1](docs/RELEASE_1.3.1.md) y [la entrega 1.3.3](docs/RELEASE_1.3.3.md).

La entrega **1.3.3** incluye un DMG verificado para Apple Silicon en GitHub Releases. Consulta [las pruebas y límites de esta versión](docs/RELEASE_1.3.3.md), [la implementación de actividad](docs/RELEASE_1.3.1.md) y [las pruebas anteriores de Pulso](docs/PULSO_VALIDATION_1.3.0.md). Las capturas utilizan un perfil sintético separado.

![Tablero Pulso en Jauria 1.3.2](docs/screenshots/pulso-1.3.2.png)

Tablero de ejemplo en Jauria 1.3.2. Captura sintética: no contiene sesiones ni tareas reales.

## Sesiones e historial

- **Sesión:** una ejecución en una carpeta. **Interrumpir (Ctrl-C)** interrumpe el trabajo actual, sin garantizar que termine la sesión. **Terminar** detiene la sesión administrada y conserva archivos e historial; no revierte cambios.
- **Ventana:** cerrarla o salir de la interfaz deja las sesiones en ejecución en el runner local. Si el runner termina, las sesiones no se reanudan automáticamente. Vuelve a abrir con el mismo perfil de datos para consultar su estado e historial.
- **Historial:** la salida guardada de sesiones terminadas se consulta en solo lectura; seleccionarla no reinicia el proceso. En Información puedes eliminar salida o compactar eventos de sesiones finalizadas.

Jauria admite un solo escritor administrado por worktree Git: no abras dos sesiones que editen la misma copia. Usa un worktree por cada trabajo en paralelo. Terminal comparte estas restricciones y los bloqueos de recuperación. Estas protecciones no controlan procesos que abras por fuera de Jauria ni los cambios de carpeta que hagas dentro de una shell.

Desde 1.4 Jauria ya no incluye **Repositorios** ni tareas Git (registro de repositorios, worktree por tarea, revisión, verificación y relevo). Si tu perfil tiene datos de esa función de una versión anterior, se conservan en disco y se ignoran; Jauria no borra worktrees ni ramas. Puedes abrir una sesión normal en cualquiera de esas carpetas.

**Historial local parcial** indica que Jauria dejó de guardar salida al alcanzar su límite local. La sesión sigue funcionando y puedes escribir, interrumpirla o terminarla. La salida nueva puede faltar al reconectar. Este estado no indica que hayas agotado la cuota de Claude o Codex.

**Actividad** ordena las sesiones por acción requerida, avisos, turnos terminados, trabajo en curso y espera. La fila y la cabecera del terminal muestran el estado declarado por el agente; mientras trabaja se indica desde cuándo lo informa. Una sesión abierta sin reporte queda marcada como progreso no informado. **Avisos** reúne las causas pendientes y permite abrir la sesión desde la barra superior. La campana y el Dock cuentan avisos sin ver. El fin de un turno sigue pendiente aunque el agente pase a `idle` (con un runner 1.4, también aunque empiece otro turno), hasta que abres la sesión; un bloqueo permanece visible mientras el agente lo declare. Marcar visto no resuelve un fallo ni concede permisos. Los avisos de macOS siguen siendo opcionales y usan textos sin nombres ni rutas. Consulta [las reglas y límites](docs/SESSION_ALERTS.md#actividad-y-avisos-desde-131) y [la interfaz con el runner](docs/SESSION_ALERTS.md#la-interfaz-con-el-runner-14-e).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/actividad-1.3.2-aviso-oscuro.png">
  <img src="docs/screenshots/actividad-1.3.2-aviso.png" alt="Actividad en 1.3.2 con una sesión que solicita atención y otra sin progreso informado">
</picture>

![Actividad en 1.3.2 con una sesión que informa trabajo en curso](docs/screenshots/actividad-1.3.2-en-curso.png)

*Capturas sintéticas de la interfaz: no contienen proyectos, sesiones ni rutas reales.*

## Preguntas frecuentes

### ¿Cómo gestionar sesiones de Claude Code y Codex en paralelo en Mac?

Abre una sesión por herramienta y carpeta desde Nueva sesión. Configuración permite un máximo combinado de 1 a 8 sesiones, con dos paneles de vista. Usa worktrees diferentes para dos tareas que escriban sobre el mismo repositorio Git.

### ¿Necesito crear un proyecto para cada sesión?

Puedes iniciar sesiones en cualquier carpeta, incluida tu carpeta personal, sin registrar un proyecto. Los proyectos de Pulso organizan planes y fases sin exigir Git ni crear worktrees.

### ¿Jauria incluye el acceso a los modelos o aumenta sus cuotas?

Codex y Claude Code usan sus propias CLI, cuentas y límites. Jauria conserva la configuración nativa del proveedor; las cuotas de Claude o Codex son independientes del máximo de sesiones y del historial local.

### ¿Funciona en Windows, Linux o Mac Intel?

La distribución validada actualmente es macOS Apple Silicon. Esta entrega no ofrece soporte para Windows, Linux ni Intel.

### ¿Se puede citar o reutilizar este proyecto?

El código propio está bajo GPL-3.0-only, con condiciones separadas para terceros y marca. [CITATION.cff](CITATION.cff) proporciona la referencia del software; para citar una versión concreta, enlaza también su release. La [guía de descubrimiento](docs/DISCOVERABILITY.md) describe cómo preparar el contenido para búsqueda pública sin prometer indexación o recomendaciones de asistentes.

## Capturas

Las capturas son de versiones publicadas (1.0.0 a 1.3.3) y **no muestran la interfaz de 1.4** (barra superior con pestañas y campana, barra lateral con Proyectos y Agentes, cabecera de panel de 32 px, barra de estado, paleta). Se sustituirán al publicar 1.4. Las dos primeras muestran la aplicación en macOS con sesiones temporales de demostración. La vista de Configuración de 1.3.3 y la de pestañas de 1.0.0 usan componentes reales con datos sintéticos, sin perfiles de usuario.

![Diálogo Nueva sesión para elegir herramienta, carpeta de trabajo y nombre](docs/screenshots/nueva-sesion.jpg)

*Nueva sesión: selección de herramienta, carpeta y nombre opcional en una demostración propia.*

![Vista de terminal dividida con dos sesiones de demostración en paneles separados](docs/screenshots/terminal-dividida.jpg)

*Terminal dividida: dos sesiones de demostración visibles lado a lado, sin datos de usuarios.*

![Configuración de Jauria 1.3.3 con acceso automático a Pulso](docs/screenshots/configuracion-1.3.3.png)

*Configuración: acceso automático a Pulso activado por defecto y permisos manuales disponibles en una sección desplegable. Vista sintética de la interfaz.*

![Pestañas Abiertas e Historial con apariencia de navegador](docs/screenshots/pestanas-1.0.0.png)

*Pestaña activa elevada y contadores separados; el selector del panel distingue abiertas e historial.*

## CPU, RAM y cuotas

**Uso y recursos** muestra procesos observados de la interfaz, el runner, las CLI y sus hijos. No garantiza el consumo total: puede excluir servicios reparentados y procesos WebKit no atribuibles. El pie de ventana resume el proceso de interfaz.

La CPU usa **100 % por núcleo** y puede superar ese valor; la primera muestra queda pendiente. La RAM es **RSS residente**, que puede contar memoria compartida más de una vez. Son observaciones del momento, no requisitos mínimos ni promesas de rendimiento.

**Actualizar cuotas** consulta las ventanas informadas por Codex. Para Claude Code se usan datos de la barra de estado de una sesión nativa compatible, cuando los entregue tras una respuesta. Si faltan datos, están vencidos o falla la consulta, la interfaz lo indica: no se inventa un saldo. Las cuotas del proveedor son distintas del límite local de sesiones simultáneas y de la cuota de almacenamiento del historial.

## Requisitos

Esta entrega soporta **macOS en Apple Silicon**. Para compilar requiere Xcode Command Line Tools, Rust estable con soporte de edición 2024, Node.js 24 y npm, Git y Python 3.9 o posterior. Las versiones de dependencias están fijadas en los lockfiles. Los scripts descubren `cargo`, `rustc`, `node` y `npm` mediante `PATH` y conservan la configuración de herramientas del usuario.

Para sesiones reales, instala y autentica las CLI por separado. El backend actual espera Codex en `/opt/homebrew/bin/codex` y Claude Code en `~/.local/bin/claude`. No se promete compatibilidad con Intel ni con otras ubicaciones de Codex en este corte. Las cuentas, permisos y límites dependen del proveedor; Jauria no incluye credenciales.

## Instalar sin compilar

La instalación para otros usuarios se prepara como un archivo **`.dmg` para Apple Silicon**: abre la imagen y arrastra **Jauria** a **Aplicaciones**. Jauria no requiere instalar Rust ni Node para abrir la app; las CLI de los proveedores y su acceso se preparan por separado. Consulta [la guía de instalación](docs/INSTALLATION.md).

La [release v1.3.3](https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.3.3) incluye código fuente y `Jauria_1.3.3_aarch64_unsigned.dmg`, `SHA256SUMS` y el recibo JSON. Comprueba el checksum antes de instalar. La app incluida **no tiene firma Developer ID ni notarización**: macOS puede bloquear su apertura. No desactives Gatekeeper ni elimines la cuarentena; si se bloquea, espera una entrega firmada y notarizada. Consulta [la guía de instalación](docs/INSTALLATION.md).

## Compilar y abrir

Desde la raíz de un checkout limpio:

```sh
git clone https://github.com/StevenSantacruz56/jauria-sessions.git
cd jauria-sessions

xcode-select --install  # solo si faltan las herramientas de desarrollo
cargo --version
rustc --version
node --version
npm --version
python3 scripts/build-macos.py
python3 scripts/launch-macos.py --data "$HOME/Library/Application Support/Jauria-local"
```

La compilación instala dependencias npm con `npm ci`, construye el frontend, ejecuta tests locales de frontend y runner con fixtures temporales y las suites de navegador (requieren Google Chrome y Playwright WebKit: `npx playwright install webkit` en `experiments/tauri-vertical/desktop`; `--skip-browser-tests` las omite y lo indica), compila el runner release y crea una app de escritorio optimizada en modo release, sin firma de distribución ni notarización. La salida está en `experiments/tauri-vertical/desktop/src-tauri/target/release/bundle/macos/`. Para una compilación de desarrollo usa `--debug` tanto en el script de build como en el de apertura. Los nombres del bundle proceden de la configuración Tauri.

La estructura `experiments/tauri-vertical/{desktop,runner}` se conserva intencionalmente: desktop comparte módulos Rust mediante rutas relativas. No muevas esas carpetas por separado.

Consulta [desarrollo](docs/DEVELOPMENT.md), [privacidad y seguridad](SECURITY.md) y [contribuciones](CONTRIBUTING.md).

## Licencias y marca

El **código propio de Jauria está bajo GPLv3, versión 3 únicamente** (`GPL-3.0-only`): consulta [LICENSE](LICENSE). Al redistribuir binarios o modificaciones, cumple las condiciones de esa licencia y proporciona el código fuente correspondiente. La licencia no equivale a firma o notarización de macOS.

Los derechos sobre el nombre, logotipos y demás identidad de marca se mantienen separados. Las fuentes y bibliotecas conservan sus licencias originales. Consulta [NOTICE](NOTICE.md) y [las dependencias](docs/DEPENDENCIES.md).

La [revisión de exposición y dependencias](docs/PUBLICATION_READINESS.md) describe lo comprobado antes de hacer público el repositorio y los pendientes.

Las fuentes Bricolage Grotesque, Inter y JetBrains Mono incluyen sus textos OFL en `experiments/tauri-vertical/desktop/public/brand/fuentes/`. Los activos de marca mantienen sus bytes originales y metadatos de procedencia; los permisos sobre la marca son independientes de las licencias de fuentes y dependencias.
