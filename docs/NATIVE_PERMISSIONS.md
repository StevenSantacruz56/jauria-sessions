# Permisos y decisiones de las sesiones nativas

Las sesiones de terminal de Claude Code y Codex usan la configuración nativa de la cuenta y de la carpeta seleccionada. Jauria conserva `HOME` y la carpeta real de trabajo; el lanzador no impone un modo de permisos, una política de aprobación, un sandbox ni un revisor alternativo. Las políticas administradas del proveedor siguen teniendo prioridad. Si la cuenta ya tiene una configuración más permisiva, las sesiones nuevas pueden pedir menos confirmaciones que antes: Jauria no agrega una política mínima propia a estas terminales nativas.

## Alcance de las decisiones

En Claude Code, el modo predeterminado guardado en `~/.claude/settings.json` se aplica a las sesiones nuevas según las reglas de precedencia del proveedor. Una aprobación guardada para un comando Bash se reutiliza en su repositorio; una aprobación de edición limitada a la sesión puede volver a pedirse en otra. La confianza de una carpeta distinta no se transfiere automáticamente. Consulta [configuración y precedencia](https://code.claude.com/docs/en/settings) y [permisos](https://code.claude.com/docs/en/permissions).

En Codex, las opciones de la línea de comandos prevalecen sobre los archivos de configuración. Por eso Jauria no fuerza las opciones de aprobación y sandbox para las sesiones nativas: el proveedor resuelve la configuración y las reglas guardadas según su alcance. Consulta [configuración de Codex](https://learn.chatgpt.com/docs/config-file/config-basic).

Una autorización de una sola ejecución o sesión no se convierte en una regla permanente por estar en el historial de Jauria. El registro de salida tampoco sustituye los archivos de permisos del proveedor. Jauria no copia reglas entre proyectos ni agrega excepciones globales.

## Actualizaciones del lanzador

La corrección elimina los flags que antes forzaban `default` en Claude y `workspace-write` / `on-request` / revisor humano en Codex. El único ajuste adicional de Claude es el callback de cuota `statusLine`; no incluye claves de permisos. Las opciones de presentación de Codex se mantienen.

Las sesiones ya iniciadas conservan sus argumentos originales. Actualizar los archivos no cambia el modo de un proceso activo: la corrección se aplica a sesiones que inicie el runner actualizado. El campo `nativePermissionsVersion: 1` identifica esa capacidad; una interfaz nueva avisa cuando se conecta a un runner anterior. Reiniciar el runner detiene sus sesiones y requiere la confirmación existente en la aplicación.

Las pruebas de diagnóstico permanecen aisladas y restrictivas. La ruta estructurada de Codex conserva su política explícita y su ledger; esta corrección corresponde a las terminales nativas utilizadas por la aplicación.

## Validación

Las pruebas comprueban los argumentos de ambos lanzadores, `HOME`, la carpeta de trabajo y el contenido del ajuste de cuota. También verifican que los probes mantengan su aislamiento. Son pruebas offline de construcción de argumentos; no demuestran por sí solas que un proveedor real omita un aviso concreto. No requieren invocar modelos, ampliar permisos ni modificar preferencias personales. La documentación consultada y las CLI locales corresponden al 13 de noviembre de 2026: Claude Code 2.1.325 y Codex 0.167.2.

Esta corrección usa las ubicaciones estándar bajo `HOME`. El entorno del lanzador no incorpora rutas personalizadas mediante `CLAUDE_CONFIG_DIR` o `CODEX_HOME`; ese soporte no forma parte de esta entrega.
