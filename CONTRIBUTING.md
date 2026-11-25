# Contribuir

Coordina el cambio con el propietario antes de modificar contratos de datos, permisos, recuperación, Git o adaptación de proveedores. El código propio está bajo GPL-3.0-only, según [LICENSE](LICENSE); las contribuciones de código se incorporan bajo esa misma licencia. Esto no transfiere derechos de marca ni cambia las licencias de terceros.

Mantén la separación entre sesión, turno e intento y un escritor administrado por worktree. No cambies silenciosamente el modo de acceso de un proveedor. No copies credenciales o perfiles para facilitar pruebas.

Ejecuta las comprobaciones de `docs/DEVELOPMENT.md`. Las pruebas con fallos, procesos resistentes o cambios Git deben utilizar exclusivamente fixtures desechables. No pruebes fallos contra repositorios de trabajo ni sesiones reales. Describe qué cambió, por qué, qué verificaste y qué queda pendiente; una prueba sintética no acredita compatibilidad con un proveedor real.

Los cambios que afecten a datos, permisos, recuperación o Git requieren revisión independiente coordinada por el propietario. Commit, push, PR, publicación y cambios de configuración del remoto requieren instrucciones explícitas para esa acción.


## Versiones y changelog

Registra los cambios de producto en [CHANGELOG.md](CHANGELOG.md), bajo `Unreleased`. Usa versiones `MAJOR.MINOR.PATCH`: patch para correcciones compatibles, minor para capacidades nuevas y major para cambios incompatibles del contrato publicado. La serie 1.x corresponde a las versiones oficiales de Jauria.

`VERSION` es la fuente de verdad. Para preparar una versión:

1. Ejecuta `python3 scripts/version.py --set 1.0.1` con la versión elegida. Sincroniza los paquetes npm, los paquetes propios de Rust, sus lockfiles, Tauri y la etiqueta de la interfaz; no modifica versiones de dependencias.
2. Mueve las entradas de `Unreleased` a una sección fechada y actualiza los enlaces del changelog. El script no inventa ni publica notas. Actualiza también README.md y README.en.md para que la versión, requisitos y disponibilidad de instaladores coincidan con la entrega.
3. Ejecuta `python3 scripts/version.py --check` y las comprobaciones de desarrollo. La compilación rechaza versiones divergentes o una entrega sin entrada fechada.
4. Tras la instrucción del propietario para publicar, crea el tag `vX.Y.Z` sobre el commit validado y usa su sección del changelog para las notas de GitHub. Una release de código no acredita firma o notarización del bundle.

Los números de esquema de almacenamiento y de protocolo son independientes de la versión de producto. Cambiar la versión de Jauria no migra datos ni reinicia sesiones.
