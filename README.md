# Jauria

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="experiments/tauri-vertical/desktop/public/brand/jauria-logo-horizontal-oscuro.svg">
  <img src="experiments/tauri-vertical/desktop/public/brand/jauria-logo-horizontal-transparente.svg" alt="Jauría" width="240">
</picture>

Aplicación local para macOS que organiza proyectos, tareas, worktrees y sesiones de Codex y Claude Code. Combina terminal nativa, historial SQLite, revisión de cambios, verificaciones y relevo manual entre proveedores.

Candidato de desarrollo v0.1. La compilación local y CI no equivalen a aceptación de producto, instalación validada en otro Mac ni certificación de todos los flujos con proveedores reales.

## Requisitos

Esta entrega soporta **macOS en Apple Silicon**. Requiere Xcode Command Line Tools, Rust estable con soporte de edición 2024, Node.js 24 y npm, Git y Python 3.9 o posterior. Las versiones de dependencias están fijadas en los lockfiles. Los scripts descubren `cargo`, `rustc`, `node` y `npm` mediante `PATH` y conservan la configuración de herramientas del usuario.

Para sesiones reales, instala y autentica las CLI por separado. El backend actual espera Codex en `/opt/homebrew/bin/codex` y Claude Code en `~/.local/bin/claude`. No se promete compatibilidad con Intel ni con otras ubicaciones de Codex en este corte. Las cuentas, permisos y límites dependen del proveedor; Jauria no incluye credenciales.

## Compilar y abrir

Desde la raíz de un checkout limpio:

```sh
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
