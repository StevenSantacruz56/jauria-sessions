# Jauria 1.3.0 — continuidad y configuración

Entrega local para macOS Apple Silicon. La instalación sigue siendo local, sin firma Developer ID ni notarización; no publica binarios en GitHub.

El tablero ofrece un acceso directo a la conversación principal y reutiliza una continuación que ya esté viva. Se corrige el refresco que podía ocultar la acción de reanudación después de terminar una sesión. Las fases priorizan la sesión de su último checkpoint. El último tablero se recuerda por perfil sin iniciar procesos.

Configuración reúne permisos Pulso, políticas recordadas y revocación, apariencia, límite de sesiones y avisos nativos. Centralizar la interfaz no amplía autoridad: los permisos siguen sujetos a proyecto, proveedor y carpeta, con recordar desmarcado inicialmente. Los permisos nativos de Claude Code y Codex siguen a cargo de sus CLI.

El ajuste local `Jauria-1.3.0-ux-fixes.app` aclara la recuperación: abrir una sesión viva y reanudar una conversación cerrada tienen etiquetas distintas. En el detalle del proyecto aparece una sola acción para la conversación activa y los historiales con el mismo título se distinguen por identificador. Desde una fase se conserva la acción de reanudar cada conversación histórica vinculada. Configuración explica el alcance del acceso y el paso de copiar el comando a la sesión elegida. Cuando ninguna sesión necesita atención, lo indica y desactiva el acceso correspondiente. La compilación y las 157 comprobaciones afectadas aprobaron; la revisión nativa de este paquete ajustado sigue pendiente porque Computer Use rechazó abrirlo, según [la validación](PULSO_VALIDATION_1.3.0.md).

Se mantienen las decisiones de [la revisión de Herdr](HERDR_REVIEW.md): navegación directa, separación de vista y runtime y señales explícitas de estado. Sin mods JavaScript, SSH remoto ni reanudación automática.

Consulta [el flujo de recuperación](PULSO.md#recuperar-el-trabajo) y [la instalación](INSTALLATION.md). Codex conserva continuidad por historial/contexto; la reanudación nativa de Codex no está incluida. La identidad exacta de Claude no garantiza que el proveedor conserve su historial.
