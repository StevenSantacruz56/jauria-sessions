# Jauria 1.0.1

Entrega de preparación para publicar el código: GPLv3 únicamente para el código propio, actualización de Vite y revisión de exposición. El repositorio continúa privado y el instalador permanece local; no se cambian los runners o sesiones que ya están ejecutándose.

## Cambios

- Vite 6.4.6 reemplaza 6.4.1. El análisis npm del snapshot actualizado no reporta vulnerabilidades.
- Se documenta la alerta de GLib como dependencia condicionada a Linux/BSD, ausente del target Apple Silicon soportado; no se declara parcheada para otros targets.
- LICENSE contiene GNU GPLv3 íntegra. npm y Cargo identifican el código propio como GPL-3.0-only; bibliotecas, tipografías y marca conservan términos separados.
- El bundle incorpora licencia y avisos, y el DMG añade una referencia a la fuente de su versión. Al redistribuir, debes proporcionar el código correspondiente conforme a GPLv3; el empaquetador no certifica cumplimiento automático.
- README en español e inglés, preguntas frecuentes y metadatos de cita describen funciones y requisitos. La guía de descubrimiento distingue búsqueda pública, rastreo y citación, sin prometer recomendaciones de asistentes.
- Instalación y seguridad distinguen uso, compilación, distribución local y preparación para cambiar la visibilidad.

Las funciones de sesiones, historial, avisos y terminales de [1.0.0](RELEASE_1.0.0.md) se conservan. Las cifras de rendimiento de esa entrega describen aquel benchmark, no una medición nueva de esta actualización.

## Revisión y límites

El [registro de preparación](PUBLICATION_READINESS.md) describe historial, metadatos y superficies de GitHub revisadas, sin publicar valores sensibles. No se detectaron credenciales en el snapshot escaneado. La autoría incluye nombre y correo personales: no se eliminan ni se publican sus valores en el informe. No se reescribe el historial.

La revisión de dependencias y exposición es acotada y no sustituye una auditoría completa ni demuestra ausencia de vulnerabilidades. Las validaciones reportadas son locales; el estado de [Actions](https://github.com/StevenSantacruz56/jauria-sessions/actions) sigue siendo una comprobación separada.

## Validación de esta actualización

- Build frontend y pruebas con Node 24.22.3: correctos; 66 pruebas pasan y tres suites de navegador quedan fuera del glob por ser opt-in.
- Integración de avisos/Configuración: correcta en Chrome y WebKit; regresión de streams nativos con Chrome: correcta.
- Runner y almacenamiento: 385 pruebas correctas, con seis helpers ignorados. Puente nativo: 38 pruebas correctas. Python: 16 pruebas correctas tras ampliar el empaquetado de licencias y avisos.
- Compilación de escritorio release optimizada correcta con Vite 6.4.6. Se comprueba que LICENSE, NOTICE y el documento de dependencias están incluidos en el bundle.
- Análisis npm actualizado: cero vulnerabilidades reportadas. El estado de la alerta GLib se conserva con su justificación de target en el registro de preparación.

La comprobación de historial se repite sobre el commit final antes de subirlo. El resultado y su alcance se conservan como evidencia de publicación, sin añadir valores sensibles al repositorio. La aprobación para cambiar la visibilidad es distinta de publicar el instalador o dar por aprobado CI.
