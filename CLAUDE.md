# Continuidad de Jauría para Claude Code

Este archivo es el punto de entrada para retomar el proyecto en otra sesión. Lee el estado actual de Git y de la instalación antes de actuar: los datos de esta sección se verificaron el **23 de noviembre de 2026** y pueden cambiar.

## Estado de la entrega

- La versión estable publicada es **1.3.3**. El commit de la entrega es `b296f6e`, etiquetado `v1.3.3` y presente en `main` al cerrar esa entrega. La [release de GitHub](https://github.com/StevenSantacruz56/jauria-sessions/releases/tag/v1.3.3) contiene el DMG Apple Silicon sin firma Developer ID, `SHA256SUMS` y su recibo JSON. No muevas la etiqueta existente para documentar cambios posteriores.
- El DMG de esa release tiene SHA-256 `a59bb4b28ef68c53ea6bd205133cd04375389758cc80fde39ec5a956c91c0f52`. El código y las notas de la entrega están en [README.md](README.md), [docs/RELEASE_1.3.3.md](docs/RELEASE_1.3.3.md) y [CHANGELOG.md](CHANGELOG.md).
- El trabajo de Pulso, MCP, configuración, Actividad y avisos está implementado en 1.3.3. La revisión de Herdr y sus límites están en [docs/HERDR_REVIEW.md](docs/HERDR_REVIEW.md), y las reglas de los avisos en [docs/SESSION_ALERTS.md](docs/SESSION_ALERTS.md).
- **La app instalada en `/Applications/Jauria.app` aún era 1.3.0 en este equipo al verificarla.** Había sesiones Claude activas administradas por el runner; por eso no se reemplazó la app ni se reinició el runner. Esta diferencia entre release publicada e instalación local es el paso operativo pendiente. Comprueba de nuevo versión y procesos antes de actualizar. Sigue [docs/INSTALLATION.md](docs/INSTALLATION.md#actualizar-una-instalación-existente) cuando las sesiones hayan terminado de forma controlada; cerrar la ventana no termina necesariamente el runner.

## Pulso y acceso de agentes

Pulso es el tablero **local** de proyectos, fases y checkpoints de Jauría. En 1.3.3, cada sesión **nueva** de Claude Code o Codex abierta desde Jauría recibe automáticamente el MCP `jauria-pulso`, con permiso para leer y editar todos los proyectos y crear proyectos. No incluye las tarjetas independientes de **Pendientes**. El interruptor está en **Configuración → Pulso para agentes → Acceso automático a Pulso**, activado por defecto. Las sesiones iniciadas fuera de Jauría no reciben ese permiso.

Una sesión iniciada antes de la actualización no incorpora el MCP a mitad de ejecución. En ella, usa **Configuración → Acceso manual para sesiones existentes** y concede el alcance elegido, o abre una sesión nueva con la app y el runner actualizados. El permiso de Pulso no cambia las aprobaciones nativas del proveedor para archivos, comandos o red. Las políticas manuales recordadas pueden ser más estrechas. Consulta [docs/PULSO.md](docs/PULSO.md#acceso-de-claude-code-y-codex-a-pulso) antes de modificar permisos.

Cada sesión usa un permiso privado revocable; no publiques su archivo, ruta de perfil, token, base SQLite ni transcripciones. El MCP valida el permiso en cada operación. El modo estructurado de Codex solo habilita el MCP de Pulso administrado por Jauría. Si Claude pregunta «¿qué es Pulso?», explica que es el tablero local y comprueba `/mcp` en una **sesión nueva** antes de diagnosticar un fallo de conexión.

## Dónde continuar el código

| Área | Archivos principales |
| --- | --- |
| Interfaz de Configuración y acceso manual | `experiments/tauri-vertical/desktop/src/settings-panel.ts`, `src/agent-permissions.ts`, `src/main.ts` |
| Ajustes y ciclo de sesiones del runner | `experiments/tauri-vertical/runner/src/app_settings.rs`, `src/runner.rs` |
| Pulso, almacenamiento y MCP | `experiments/tauri-vertical/runner/src/pulso.rs`, `src/pulso_store.rs`, `src/pulso_mcp.rs`, `src/pulso_mcp_config.rs` |
| Integración Codex | `experiments/tauri-vertical/runner/src/runner_codex.rs`, `src/codex_runtime.rs`, `src/codex_transport.rs` |
| Pruebas de Configuración | `experiments/tauri-vertical/desktop/tests/settings-panel.test.ts`, `tests/agent-permissions.test.ts` |

Las rutas abreviadas `src/...` y `tests/...` en la tabla se resuelven dentro del directorio de su fila. Para entender el comportamiento antes de cambiarlo, consulta también [docs/PULSO.md](docs/PULSO.md), [docs/NATIVE_PERMISSIONS.md](docs/NATIVE_PERMISSIONS.md) y las notas de release.

## Verificación y publicación

Desde la raíz del repositorio:

```sh
git status --short --branch
git log -1 --oneline --decorate
python3 scripts/version.py --check
```

Para reconstruir y ejecutar la batería del proyecto en un Mac Apple Silicon con Xcode Command Line Tools, Rust, Node 24 y npm disponibles en `PATH`:

```sh
python3 scripts/build-macos.py
```

El build de 1.3.3 y sus pruebas pasaron antes de publicar la release; también pasaron 56 pruebas de navegador de Configuración y permisos en Chromium y WebKit. Si reconstruyes, verifica el artefacto **de esa nueva compilación** y su versión antes de sustituir una instalación. Los paquetes y checksums publicados son inmutables. Una nueva entrega de código necesita incrementar `VERSION`, actualizar documentación y producir sus propios artefactos; no reutilices el DMG ni el checksum de 1.3.3.

La distribución actual es macOS Apple Silicon. El DMG publicado **no tiene firma Developer ID ni notarización**; no desactives Gatekeeper ni elimines la cuarentena para forzar su instalación. La revisión de seguridad de 1.3.3 cubrió rutas modificadas, identidad y alcance de permisos, configuración MCP y exposición de credenciales; **no fue una auditoría integral**. La alerta de Dependabot por `glib` 0.18.5 (`GHSA-wrw7-89jp-8q8g`) se clasificó `not_used` para el target macOS porque esa dependencia es del stack GTK de Linux; reevalúala antes de soportar Linux. No añadas perfiles locales, tokens o capturas con datos reales al repositorio ni al paquete.

## Primeros pasos en la próxima sesión

1. Confirma `git status`, rama, `main` remoto, etiqueta y versión real de la app instalada. Este archivo puede quedar desactualizado tras nuevos cambios.
2. Lee la petición actual del usuario y las guías enlazadas. Si sigue pendiente actualizar `/Applications/Jauria.app`, verifica si aún hay sesiones administradas vivas y preserva su trabajo; aplica el procedimiento de instalación cuando ya hayan terminado.
3. Comprueba la versión del runner tras abrir la app actualizada y valida Pulso con una sesión nueva de Claude Code o Codex. Una sesión antigua puede requerir acceso manual.
