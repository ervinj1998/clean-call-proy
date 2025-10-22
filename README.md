# Clean Call P2P

Web app de llamadas de voz 1–4 participantes sobre WebRTC mesh, señalizada con Firebase Realtime Database. Objetivo: simplicidad, seguridad y mantenibilidad sin vendor lock-in.

## Arquitectura
- **Frontend**: JavaScript nativo (ESM) + Vite como dev server. UI mínima (`index.html` + módulos en `src/`).
- **Señalización**: `FirebaseSignalingClient` encapsula CRUD de `rooms/<roomId>`, exigiendo autenticación anónima y exponiendo una interfaz intercambiable (futuro WebSocket).
- **WebRTC**: `PeerMeshManager` crea RTCPeerConnection por par. Reusa un único `MediaStream` local con filtros nativos (`echoCancellation`, `noiseSuppression`, `autoGainControl`). Hook preparado para `AudioWorklet` + RNNoise (deshabilitado por defecto).
- **Topología y reglas**: Mesh hasta 4 peers. Cada peer crea ofertas a miembros existentes; ofertas/answers/candidatos se limpian tras conectar. `onDisconnect().remove()` en `members/<peerId>` y `onDisconnect(room).remove()` se programa solo cuando queda un miembro, garantizando borrado total de la sala.
- **Observabilidad ligera**: logs en consola con contexto (`[CleanCall]`, `[PeerMesh]`), notificaciones básicas en UI, eventos de estado ICE.

## Estructura de carpetas
```
.
├── index.html
├── package.json
├── src/
│   ├── app.js            # orquestador UI + signaling + WebRTC
│   ├── signaling.js      # contrato Firebase y helpers para reemplazo por WS
│   ├── ui.js             # controlador de interfaz mínima
│   └── webrtc.js         # mesh manager y pipeline de audio
├── README.md
├── vite.config.js
└── .eslintrc.json
```

## Requisitos previos
1. Node.js 18+ y npm.
2. Proyecto Firebase con Realtime Database (modo locked) y Auth anónima habilitada.
3. Opcional: cuenta Vercel para deploy estático.

## Configuración Firebase
1. Crea proyecto → habilita **Authentication → Sign-in method → Anonymous**.
2. Crea base Realtime Database en la región deseada (modo locked).
3. Duplica `.env.example` como `.env` y completa los valores `VITE_FIREBASE_*` con la configuración Web de Firebase.

> Alternativamente puedes inyectar `window.__FIREBASE_CONFIG__` manualmente antes de cargar `src/app.js`, pero la práctica recomendada es usar variables de entorno con el prefijo `VITE_`.

### Esquema y contrato de señalización
```
rooms/<roomId>/
 ├─ createdAt: serverTimestamp
 ├─ offer/<offerId>: { from, to, description, createdAt }
 ├─ answer/<offerId>: { from, to, description, createdAt }
 ├─ callerCandidates/<offerId>/<pushId>: { owner, candidate, createdAt }
 ├─ calleeCandidates/<offerId>/<pushId>: { owner, candidate, createdAt }
 └─ members/<peerId>: { peerId, joinedAt, lastSeen }
```
- `offerId = sanitize(">${from}__${to}")` para cada par.
- Cada peer inicia handshake hacia miembros existentes; nuevos miembros escuchan ofertas dirigidas a su `peerId`.
- Al cerrar ICE (`connected/completed`), se limpian candidatos/offers/answers.
- `members` controla límite duro (≤4) mediante transacción.
- `onDisconnect(member)` borra presencia individual; watcher cliente elimina ofertas/respuestas asociadas; cuando la lista queda vacía, se elimina `rooms/<roomId>`.


## Scripts npm
```bash
npm install
npm run dev      # Vite + HMR
npm run build    # salida estática en dist/
npm run preview  # serve estático post-build
npm run lint     # ESLint sobre src/
```

## Desarrollo local
1. `npm install`
2. Duplica `.env.example` → `.env` y completa los `VITE_FIREBASE_*`.
3. `npm run dev`
4. Abre `http://localhost:5173` en dos o más pestañas para pruebas.
5. Usa “Generar ID” → “Crear sala” en primera pestaña, “Unirse” en otras.

## Checklist de pruebas multi-pestaña
- [ ] Dos pestañas se conectan y se escuchan mutuamente.
- [ ] Tercera y cuarta pestaña se conectan (mesh completo) y se reproducen audios remotos.
- [ ] Quinta pestaña recibe mensaje de sala llena.
- [ ] Cerrar pestañas una a una → `members` se actualiza y las conexiones restantes continúan.
- [ ] Al cerrar la última pestaña, verifica en Firebase que `rooms/<roomId>` se elimina.
- [ ] Refrescar sala antigua genera nuevo ID (no se reutiliza al estar eliminada).

## Deploy en Vercel
1. `npm run build`
2. En Vercel: **New Project → Import repo**
3. Ajusta build command `npm run build`, output `dist`.
4. Configura variables de entorno si prefieres no exponer credenciales en `index.html`. Se puede inyectar JSON en `window.__FIREBASE_CONFIG__` mediante snippet.

## Migración futura a WebSocket (Vercel Edge)
- `FirebaseSignalingClient` actúa como capa de abstracción: implementar `WebSocketSignalingClient` con mismos métodos (`ensureRoom`, `joinRoom`, `subscribeToOffers`, etc.) y cambiar la inyección en `app.js`.
- Mantener el contrato `offerId`, `members` y límite 4 para compatibilidad.

## Troubleshooting (ICE / NAT / Audio)
| Problema | Síntoma | Acción |
| --- | --- | --- |
| NAT estricto sin TURN | Participantes se quedan en “connecting” | Añadir servidor TURN (ej. coturn) en `ICE_SERVERS` cuando sea necesario |
| Permiso micrófono denegado | Status “Permiso de micrófono denegado” | Rehabilitar permisos en el navegador o limpiar caché de permisos |
| Eco/ruido residual | Audio degradado | Activar monitor local solo con auriculares; integrar hook RNNoise via `window.cleanCall.enableRnNoise()` con módulo WASM |
| Offer/answer stale | Consola marca error de ICE | Sala limpia al colgar; si persiste, borrar rama `rooms/<roomId>` manualmente y reiniciar |

## Roadmap sugerido
- Integrar módulos de RNNoise (WASM) y UI para activarlo.
- Persistir métricas básicas (`connectionState`, `iceConnectionState`) en log collector simple.
- Implementar `WebSocketSignalingClient` para operar en Vercel Edge.
- Añadir tests automáticos con Playwright (multi-tab) y pipeline CI.

---
Licencia MIT. Feedback y mejoras bienvenidas.
