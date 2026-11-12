# Contribuir

Coordina el cambio con el propietario antes de modificar contratos de datos, permisos, recuperación, Git o adaptación de proveedores. La licencia del código propio sigue pendiente; no presupongas una licencia OSS ni una cesión de derechos por participar.

Mantén la separación entre tarea, sesión, turno e intento y un escritor administrado por worktree. No cambies silenciosamente el modo de acceso de un proveedor. No copies credenciales o perfiles para facilitar pruebas.

Ejecuta las comprobaciones de `docs/DEVELOPMENT.md`. Las pruebas con fallos, procesos resistentes o cambios Git deben utilizar exclusivamente fixtures desechables. No pruebes fallos contra repositorios de trabajo ni sesiones reales. Describe qué cambió, por qué, qué verificaste y qué queda pendiente; una prueba sintética no acredita compatibilidad con un proveedor real.

Los cambios que afecten a datos, permisos, recuperación o Git requieren revisión independiente coordinada por el propietario. Commit, push, PR, publicación y cambios de configuración del remoto requieren instrucciones explícitas para esa acción.
