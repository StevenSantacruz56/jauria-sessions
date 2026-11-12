# Desarrollo y validación

La raíz contiene documentación curada y scripts portables. La aplicación permanece en `experiments/tauri-vertical/desktop`; el proceso runner en `experiments/tauri-vertical/runner`. Los imports compartidos `#[path]` dependen de esta disposición.

```sh
python3 scripts/build-macos.py --check-only
python3 scripts/build-macos.py
```

El primer comando realiza frontend y tests del runner y del bridge nativo sin generar el bundle Tauri. Ambos ejecutan los tests Rust del runner y las suites `rpc` y `storage_retention`, además de `cargo test --locked` en `desktop/src-tauri` para el bridge nativo. Los tests existentes crean fixtures temporales y procesos de prueba; no necesitan login de proveedores. No se incluyen los harnesses locales de pruebas con proveedores ni los registros originales.

El fixture `runner/tests/fixtures/protocol.synthetic.jsonl` contiene exclusivamente mensajes construidos para pruebas: dos solicitudes de aprobación, 24 fragmentos de mensaje y tres terminaciones de turno. La prueba `replay_synthetic_protocol_offline` conserva las aserciones del replay: dos denegaciones, tres terminaciones y más de veinte eventos normalizados. No es una transcripción nativa ni demuestra comportamiento real del proveedor.

El workflow `.github/workflows/macos.yml` configura Node 24 para ejecutar los tests TypeScript con el soporte nativo de borrado de tipos; no implica que los tests locales se hayan ejecutado en Node 24. Usa Rust estable, macOS Apple Silicon, permisos de repositorio de solo lectura y acciones fijadas a SHA. No instala CLI de proveedores, no realiza login, no firma, no publica ni sube perfiles o evidencia. Referencia del runner: https://docs.github.com/en/actions/reference/runners/github-hosted-runners .

Los resultados deben verificarse sobre el snapshot final: una compilación anterior al freeze no valida cambios posteriores. Firma, notarización, instalador de distribución, Intel y otras plataformas quedan fuera de esta preparación.

Los scripts originales de build/launch de laboratorio se sustituyen por `scripts/build-macos.py` y `scripts/launch-macos.py`; no se copian sus rutas de SDK, cachés, preferencias de perfil ni fallbacks a experimentos externos. La detección de ejecutables de proveedores en el backend no cambia en este paquete.
