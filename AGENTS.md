# Repository Guidelines

## Project Structure & Module Organization
- `src/app.js` orquesta el flujo de UI, señalización y estado WebRTC; los módulos de soporte residen en `src/signaling.js`, `src/ui.js` y `src/webrtc.js`.
- `index.html` inicia la entrada de Vite; las variables de entorno provienen de `.env` con prefijo `VITE_` o de globales inyectados antes de cargar `app.js`.
- Coloca utilidades reutilizables en un `src/lib/` dedicado (créalo cuando haga falta) y agrupa los activos de medios junto a las funciones que los usan, por ejemplo en `src/ui/`.

## Build, Test, and Development Commands
- `pnpm install` instala dependencias usando las versiones fijadas en `pnpm-lock.yaml`.
- `pnpm dev` inicia el servidor de desarrollo de Vite con recarga en caliente en `http://localhost:5173`.
- `pnpm build` genera el paquete de producción en `dist/`; revísalo con `pnpm preview` antes de desplegar.
- `pnpm lint` ejecuta ESLint sobre `src/`, detectando problemas de estilo y seguridad.

## Coding Style & Naming Conventions
- Usa sintaxis moderna de módulos ES con sangría de 2 espacios, punto y coma final y comillas simples salvo que un template literal mejore la legibilidad.
- Nombra las clases y fábricas exportadas en PascalCase (`FirebaseSignalingClient`), los helpers en camelCase (`createUIController`) y las constantes en UPPER_SNAKE_CASE (`DEFAULT_AUDIO_CONSTRAINTS`).
- Centraliza el logging con el namespace `[CleanCall]` para facilitar el rastreo.

## Testing Guidelines
- Adopta Vitest al añadir cobertura automatizada; guarda los unit tests como `src/__tests__/<modulo>.spec.js`.
- Prueba manualmente el flujo extremo a extremo tras cada cambio: creación de sala, unión de múltiples pares, monitor de audio local y cierre de llamada.
- Documenta casos límite detectados en el PR para orientar futuras pruebas automatizadas.

## Commit & Pull Request Guidelines
- Emplea asuntos de commit cortos e imperativos (`fix: manejar permission-denied`) y agrupa los cambios relacionados.
- Cada PR debe incluir un resumen conciso, notas de pruebas (`pnpm build`, pasos manuales), actualizaciones de entorno/features y evidencia visual cuando haya cambios de UI.

## Instrucciones para la interacción en terminal
- Responde siempre en español dentro de la terminal.
- Explica cada cambio realizado para mantener el control de versiones y el contexto del equipo.
- Ajusta tu trabajo a las tecnologías y herramientas disponibles en este repositorio; pregunta antes de introducir alternativas distintas.
