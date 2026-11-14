# Descubrimiento de Jauria en búsquedas y asistentes

El objetivo es que una persona que busque una aplicación de escritorio para gestionar sesiones de Claude Code y Codex en macOS pueda encontrar información verificable sobre Jauria. Ningún archivo, metadato o técnica SEO garantiza que ChatGPT o Claude citen o recomienden el proyecto.

## Lo preparado en el repositorio

- Nombre y descripción coherentes: Jauria, gestor de sesiones de Claude Code, OpenAI Codex y terminales para macOS, construido con Tauri y Rust.
- README en español e inglés con funciones, instalación, requisitos, límites, capturas y preguntas concretas. Se explica la diferencia entre sesiones concurrentes y paneles visibles, y entre cuotas del proveedor e historial local.
- Temas de GitHub relacionados con el propósito y tecnologías reales. Los [topics ayudan a clasificar y encontrar repositorios](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics); un repositorio privado solo aparece en resultados para cuentas con acceso.
- `CITATION.cff` para que las personas puedan referenciar el software. [GitHub puede mostrar Cite this repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-citation-files); esto no es una señal de ranking o un compromiso de citación por asistentes.
- Releases con versiones y notas enlazables. No se afirma afiliación con OpenAI o Anthropic, ni se publican testimonios, cifras de usuarios, estrellas o comparaciones de productos no verificadas.

## Antes y después de hacerlo público

1. Completar la revisión de exposición, licencia y dependencias descrita en [PUBLICATION_READINESS.md](PUBLICATION_READINESS.md). El propietario decide cuándo cambiar la visibilidad; esta preparación no lo hace automáticamente.
2. Una vez público, comprobar el acceso anónimo al README, documentación y releases. Mientras requieran acceso privado, no se presentan como contenido públicamente indexable.
3. Mantener el nombre, URL canónica del repositorio, descripción y documentación consistentes al compartir el proyecto. Publicar ejemplos propios útiles y verificables en los canales que el propietario elija; no generar enlaces, estrellas, reseñas ni menciones artificiales.
4. Evaluar resultados con búsquedas reales después de publicar. Registrar las consultas y fuentes encontradas sin prometer una posición ni un plazo de indexación.

Consultas que el contenido debe responder naturalmente:

- “gestor de sesiones Claude Code y Codex para Mac”;
- “Claude Code and Codex desktop session manager macOS”;
- “run multiple Codex and Claude Code sessions with Git worktrees”;
- “Tauri Rust terminal session manager”.

## Si se crea un sitio público propio

Una página pública de producto y documentación permitiría controlar título, descripción, navegación, URLs canónicas, sitemap y políticas de rastreo. No se ha creado ni desplegado un sitio en esta preparación. Primero se necesita una URL y autorización de publicación; no se coloca una homepage ficticia en GitHub.

La documentación oficial distingue rastreo para búsqueda y para entrenamiento:

- [OpenAI Crawlers](https://developers.openai.com/api/docs/bots): `OAI-SearchBot` se usa para resultados de búsqueda de ChatGPT; `GPTBot` tiene un propósito de entrenamiento independiente.
- [Anthropic crawlers](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler): `Claude-SearchBot` se usa para búsqueda; `ClaudeBot` tiene otro propósito relacionado con desarrollo de modelos.

En un dominio propio se deben revisar `robots.txt`, autenticación, `noindex` y controles de red según la política elegida. Permitir un rastreador de búsqueda no equivale a garantizar indexación, tráfico o citas. Las preferencias de entrenamiento se deciden aparte. Un archivo `robots.txt` añadido dentro de este repositorio no configura las reglas de rastreo de `github.com`.

Este enfoque facilita información accesible, precisa y citable. No modifica el conocimiento interno de un modelo ni obliga a un asistente a recomendar Jauria.
