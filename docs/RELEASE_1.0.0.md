# Jauria 1.0.0

Primera versión oficial de Jauria para macOS Apple Silicon. Esta entrega publica código y documentación; el instalador DMG permanece local, sin firma Developer ID ni notarización y sin adjuntos binarios en GitHub. Consulta [instalación y actualización](INSTALLATION.md) y [el changelog](../CHANGELOG.md).

## Cambios de uso

- **Cambiar nombre…** en las acciones del panel renombra sesiones activas y del historial. Conserva proceso, carpeta, estado e identificador; no renombra la conversación del proveedor.
- **Configuración…** en la navegación o `⌘,` guarda la apariencia y el límite combinado de 1 a 8 sesiones. El valor inicial es 2; reducirlo no detiene procesos. Continúan las reservas por estado incierto y la protección de un escritor por worktree.
- **Abiertas** e **Historial** usan pestañas con apariencia de navegador. El selector separa ambos grupos y evita repetir el proveedor en nombres predeterminados; distingue sesiones con nombres iguales por carpeta o identificador.
- La **campana** concentra el indicador de avisos nuevos; el resumen y Marcar vistos aparecen en la vista de atención. El contador del Dock usa el mismo conjunto de avisos. Ver un aviso no resuelve un fallo ni aprueba permisos.
- **Historial local parcial** informa del límite de guardado en Información, sin franja roja ni confusión con la cuota del proveedor. Una pérdida irrecuperable o un fallo de E/S mantiene su advertencia.
- Las sesiones nativas usan los permisos guardados por Codex y Claude Code sin imponer flags que los reemplacen. Una aprobación temporal conserva el alcance definido por el proveedor.

## Validación local

| Área | Resultado y alcance |
| --- | --- |
| Python | 13 pruebas de sincronización de versión y empaquetado; las herramientas DMG se simulan en los tests unitarios. |
| Runner y almacenamiento | 385 pruebas correctas; 6 helpers de subproceso ignorados. Incluye cuotas, fallos de escritura, bloqueos, custodia y ciclo de vida. |
| Puente nativo | 38 pruebas correctas de contratos, validación y políticas de inicio. |
| Frontend | Build correcto y 66 pruebas correctas; 3 suites de navegador opt-in omitidas en el glob general. |
| Navegadores | Suites de Configuración, avisos y archivo/vivo ejecutadas en Chrome y WebKit con datos sintéticos. Comprobación del backfill durante escritura en WebKit. |
| Runner del bundle | 8 pruebas RPC correctas sobre preferencias, renombrado y continuidad del historial. |
| App nativa | Perfiles aislados: Configuración con `⌘,`, guardado del límite, cierre con Escape, renombrado activo y finalizado con texto Unicode. Apertura del bundle optimizado en modo normal y perfil vacío. |
| DMG local | Imagen verificada, montada en solo lectura y desmontada. Atajo Applications e instrucciones presentes; hashes de ejecutables coincidentes con el bundle. |

Las pruebas no usaron sesiones reales ni credenciales de proveedores. Las suites sintéticas y las pruebas con fixtures no acreditan todas las interacciones de los proveedores en todas las versiones de macOS. Las validaciones anteriores son locales; el estado de [GitHub Actions](https://github.com/StevenSantacruz56/jauria-sessions/actions) se consulta por separado.

## Latencia medida

Benchmark A/B del listener con dos PTYs propios, 40 muestras por operación y respuesta exacta del proceso hijo. Se distingue el eco del proceso del eco del comando del kernel.

| Operación | Antes: mediana / p95 | Con readiness: mediana / p95 |
| --- | ---: | ---: |
| Consulta de estado | 13,378 / 15,884 ms | 1,030 / 1,450 ms |
| Lectura de eventos | 10,962 / 13,830 ms | 0,087 / 0,129 ms |
| Confirmación de entrada | 12,487 / 14,874 ms | 0,067 / 0,090 ms |
| Entrada → eco del proceso | 25,256 / 28,001 ms | 1,766 / 2,001 ms |

El cambio sustituye la espera fija de 10 ms por conexión por una espera de legibilidad del socket. La interfaz prioriza las terminales visibles y espacía consultas del archivo durante escritura nativa sincronizada. Estas cifras no miden la presentación de un frame en WKWebView ni el tiempo de respuesta de Claude o Codex y no son un umbral garantizado en otros equipos. El benchmark se reproduce siguiendo [desarrollo](DEVELOPMENT.md#latencia-de-entrada).

## Límites y actualización

- Arquitectura arm64 y mínimo declarado macOS 11.0; solo se ha validado el Mac de pruebas actual, no toda la matriz de sistemas. No incluye Intel ni Windows.
- El DMG local se identifica como `unsigned`. Una firma de desarrollo o ad-hoc no equivale a Developer ID ni a notarización; no se indica al usuario que desactive protecciones del sistema.
- El historial sigue teniendo presupuestos de disco y memoria. Alcanzar el límite local no detiene la terminal, pero la salida no guardada puede faltar al reconectar. Un hueco irrecuperable no permite reconstruir exactamente una TUI.
- Un runner ya abierto conserva su ejecutable. Instalar la app o actualizar el repositorio no lo reinicia. Termina el trabajo activo antes de usar Información → Diagnóstico → Reiniciar runner…; los cambios de lanzamiento se aplican a sesiones nuevas.
- Las notificaciones de macOS siguen siendo opcionales, solo mientras Jauria está abierta y sujetas a la entrega del sistema. Las terminales nativas no infieren permisos ni fin de turno a partir del texto.

Hubo revisión independiente del backend y pruebas locales. Dos intentos de revisión con Claude Code agotaron el tiempo de espera; no se presenta una aprobación de Claude como evidencia de esta entrega.
