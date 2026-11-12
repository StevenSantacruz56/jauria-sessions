# Jauria

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="experiments/tauri-vertical/desktop/public/brand/jauria-logo-horizontal-oscuro.svg">
  <img src="experiments/tauri-vertical/desktop/public/brand/jauria-logo-horizontal-transparente.svg" alt="Jauría" width="240">
</picture>

Jauria reúne Codex, Claude Code y una terminal zsh en una aplicación de escritorio para macOS. Mantén tus sesiones organizadas por carpeta, vuelve a su historial y trabaja en dos paneles. Para tareas de programación, registra un proyecto Git y prepara un worktree separado para cada tarea.

Candidato de desarrollo v0.1. La compilación y las pruebas locales no equivalen a aceptación de producto, instalación validada en otro Mac ni certificación de todos los flujos con proveedores reales.

## Para qué sirve

Para quien ya trabaja con las CLI de Codex o Claude Code y necesita mantener a mano la carpeta, el estado y la salida de cada sesión. Puedes abrir una sesión sin registrar un proyecto, consultar una sesión terminada o ver dos sesiones lado a lado. Para dos tareas de programación sobre un mismo repositorio, usa worktrees separados.

La opción **Terminal** abre una terminal normal con `/bin/zsh -il`, para ejecutar comandos como `pwd`, `git status` o las pruebas de tu proyecto. Carga la configuración de inicio de tu zsh y no requiere una CLI de IA.

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

Pulsa **Dividir** para mostrar dos paneles y elige una sesión distinta en el menú de cada uno. Dividir cambia la vista; no crea otra sesión. Hay **dos plazas de ejecución en total**, no dos por proveedor. Las sesiones con estado incierto pueden seguir ocupando una plaza hasta resolverlas.

## Sesiones, proyectos e historial

- **Sesión:** una ejecución en una carpeta. **Interrumpir (Ctrl-C)** interrumpe el trabajo actual, sin garantizar que termine la sesión. **Terminar** detiene la sesión administrada y conserva archivos e historial; no revierte cambios.
- **Ventana:** cerrarla o salir de la interfaz deja las sesiones en ejecución en el runner local. Si el runner termina, las sesiones no se reanudan automáticamente. Vuelve a abrir con el mismo perfil de datos para consultar su estado e historial.
- **Historial:** la salida guardada de sesiones terminadas se consulta en solo lectura; seleccionarla no reinicia el proceso. En Información puedes eliminar salida o compactar eventos de sesiones finalizadas.
- **Proyecto:** registra un repositorio para organizar tareas. Usa **Registrar proyecto…**, **Nueva tarea** y **Preparar worktree** antes de iniciar el proveedor desde la tarea. Cerrar una sesión no completa la tarea. **Cerrar proyecto** lo oculta conservando tareas, archivos e historial; puede bloquearse mientras haya trabajo pendiente. Puedes volver desde **Proyectos cerrados → Reabrir**.

Jauria admite un solo escritor administrado por worktree Git: no abras dos sesiones que editen la misma copia. Usa un worktree por tarea paralela. Terminal comparte estas restricciones y los bloqueos de recuperación y verificación. Estas protecciones no controlan procesos que abras por fuera de Jauria ni los cambios de carpeta que hagas dentro de una shell.

## Capturas

Capturas de la aplicación en macOS, con carpetas y sesiones temporales de demostración.

![Diálogo Nueva sesión para elegir herramienta, carpeta de trabajo y nombre](docs/screenshots/nueva-sesion.jpg)

*Nueva sesión: selección de herramienta, carpeta y nombre opcional en una demostración propia.*

![Vista de terminal dividida con dos sesiones de demostración en paneles separados](docs/screenshots/terminal-dividida.jpg)

*Terminal dividida: dos sesiones de demostración visibles lado a lado, sin datos de usuarios.*

## CPU, RAM y cuotas

**Uso y recursos** muestra procesos observados de la interfaz, el runner, las CLI y sus hijos. No garantiza el consumo total: puede excluir servicios reparentados y procesos WebKit no atribuibles. El pie de ventana resume el proceso de interfaz.

La CPU usa **100 % por núcleo** y puede superar ese valor; la primera muestra queda pendiente. La RAM es **RSS residente**, que puede contar memoria compartida más de una vez. Son observaciones del momento, no requisitos mínimos ni promesas de rendimiento.

**Actualizar cuotas** consulta las ventanas informadas por Codex. Para Claude Code se usan datos de la barra de estado de una sesión nativa compatible, cuando los entregue tras una respuesta. Si faltan datos, están vencidos o falla la consulta, la interfaz lo indica: no se inventa un saldo. Las cuotas del proveedor son distintas del límite local de dos sesiones y de la cuota de almacenamiento del historial.

## Requisitos

Esta entrega soporta **macOS en Apple Silicon**. Para compilar requiere Xcode Command Line Tools, Rust estable con soporte de edición 2024, Node.js 24 y npm, Git y Python 3.9 o posterior. Las versiones de dependencias están fijadas en los lockfiles. Los scripts descubren `cargo`, `rustc`, `node` y `npm` mediante `PATH` y conservan la configuración de herramientas del usuario.

Para sesiones reales, instala y autentica las CLI por separado. El backend actual espera Codex en `/opt/homebrew/bin/codex` y Claude Code en `~/.local/bin/claude`. No se promete compatibilidad con Intel ni con otras ubicaciones de Codex en este corte. Las cuentas, permisos y límites dependen del proveedor; Jauria no incluye credenciales.

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

La compilación instala dependencias npm con `npm ci`, construye el frontend, ejecuta tests locales de frontend y runner con fixtures temporales, compila el runner release y crea una app de escritorio debug sin firma de distribución ni notarización. La salida está en `experiments/tauri-vertical/desktop/src-tauri/target/debug/bundle/macos/`. Los nombres del bundle proceden de la configuración Tauri.

La estructura `experiments/tauri-vertical/{desktop,runner}` se conserva intencionalmente: desktop comparte módulos Rust mediante rutas relativas. No muevas esas carpetas por separado.

Consulta [desarrollo](docs/DEVELOPMENT.md), [privacidad y seguridad](SECURITY.md) y [contribuciones](CONTRIBUTING.md).

## Licencias y marca

**No se ha seleccionado una licencia de código abierto para el código propio de Jauria.** Este repositorio privado no concede una licencia OSS por publicarse en GitHub. La decisión queda pendiente del titular. Los componentes de terceros conservan sus propios términos, independientes de esa decisión; consulta [NOTICE](NOTICE.md) y [las dependencias directas](docs/DEPENDENCIES.md).

Las fuentes Bricolage Grotesque, Inter y JetBrains Mono incluyen sus textos OFL en `experiments/tauri-vertical/desktop/public/brand/fuentes/`. Los activos de marca mantienen sus bytes originales y metadatos de procedencia; los permisos sobre la marca son independientes de las licencias de fuentes y dependencias.
