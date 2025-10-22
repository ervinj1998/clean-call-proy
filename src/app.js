import { createUIController } from './ui.js';
import { FirebaseSignalingClient, createRandomRoomId } from './signaling.js';
import { PeerMeshManager, DEFAULT_AUDIO_CONSTRAINTS } from './webrtc.js';

function loadFirebaseConfig() {
  const fromWindow = window.__FIREBASE_CONFIG__;
  if (fromWindow?.apiKey) {
    return fromWindow;
  }

  const env = import.meta.env ?? {};
  const config = {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    databaseURL: env.VITE_FIREBASE_DATABASE_URL,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID
  };

  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length) {
    throw new Error(
      `Config Firebase incompleta. Define ${missing.join(
        ', '
      )} en .env (prefijo VITE_) o inyecta window.__FIREBASE_CONFIG__ antes de cargar app.js.`
    );
  }

  return config;
}

function loadWorkletUrl() {
  const globalValue = (window.__RNNOISE_WORKLET_URL__ ?? '').trim();
  if (globalValue) {
    return globalValue;
  }
  const envValue = import.meta.env?.VITE_RNNOISE_WORKLET_URL ?? '';
  return envValue;
}

function createLogger() {
  const namespace = '[CleanCall]';
  return {
    info: (...args) => console.log(namespace, ...args),
    warn: (...args) => console.warn(namespace, ...args),
    error: (...args) => console.error(namespace, ...args)
  };
}

const firebaseConfig = loadFirebaseConfig();
const workletUrl = loadWorkletUrl();
const logger = createLogger();

const ui = createUIController({
  onGenerateRoomId: handleGenerateRoomId,
  onCopyRoomId: () => logger.info('ID copiado'),
  onCreateRoom: (roomId) => handleJoin(roomId, { createIfMissing: true }),
  onJoinRoom: (roomId) => handleJoin(roomId, { createIfMissing: false }),
  onHangUp: () => handleHangUp(),
  onMonitorToggle: (enabled) => logger.info('Monitor local', enabled ? 'activado' : 'apagado')
});

const signalingClient = new FirebaseSignalingClient(firebaseConfig);
const meshManager = new PeerMeshManager({
  signalingClient,
  workletUrl,
  onLocalStream: (stream) => ui.attachLocalStream(stream),
  onRemoteStream: (peerId, stream) => {
    logger.info('Adjuntando stream remoto', peerId);
    ui.upsertRemoteStream(peerId, stream);
    updateStatus(`🟢 Conectado con ${peerId}`);
  },
  onRemoteStreamRemoved: (peerId) => {
    ui.removeRemoteStream(peerId);
    updateStatus(`🔌 ${peerId} desconectado`, 'info');
  },
  onStatus: handleMeshStatus,
  logger
});

let sessionActive = false;
let activeRoomId = null;

async function handleGenerateRoomId() {
  const roomId = createRandomRoomId();
  ui.setRoomId(roomId);
  updateStatus('Nuevo ID generado');
  return roomId;
}

async function ensureLocalStream() {
  try {
    await meshManager.ensureLocalStream(DEFAULT_AUDIO_CONSTRAINTS);
  } catch (error) {
    logger.error('No se pudo obtener audio local', error);
    throw new Error('permission-denied');
  }
}

async function handleJoin(roomId, { createIfMissing }) {
  if (sessionActive) {
    updateStatus('Ya estás en una sala', 'info');
    return;
  }

  const sanitizedRoomId = (roomId || '').trim() || createRandomRoomId();
  ui.setRoomId(sanitizedRoomId);

  try {
    await ensureLocalStream();
    const result = await meshManager.join(sanitizedRoomId, { createIfMissing });
    sessionActive = true;
    activeRoomId = sanitizedRoomId;
    ui.setAvailability({ inCall: true, roomId: sanitizedRoomId });
    ui.setHangUpAvailable(true);
    updateStatus(`En sala ${result.roomId}. ID propio: ${result.peerId}`);
  } catch (error) {
    logger.error('No se pudo unir/crear sala', error);
    if (error.message === 'room-not-found') {
      updateStatus('La sala no existe. Crea una nueva primero.', 'error');
    } else if (error.message === 'room-full') {
      updateStatus('Sala llena (máximo 4). No se pudo unir.', 'error');
    } else if (error.message === 'permission-denied') {
      updateStatus('Permiso de micrófono denegado.', 'error');
    } else if (error.message === 'already-in-room') {
      updateStatus('Ya estás conectado.', 'info');
    } else {
      updateStatus('Error al conectar. Revisa consola.', 'error');
    }
    throw error;
  }
}

async function handleHangUp() {
  if (!sessionActive) {
    return;
  }
  await meshManager.leave();
  sessionActive = false;
  ui.setAvailability({ inCall: false, roomId: activeRoomId });
  ui.resetRemoteStreams();
  updateStatus('Sesión finalizada');
  activeRoomId = null;
}

function handleMeshStatus(event) {
  switch (event.type) {
    case 'joined':
      updateStatus(`🟢 Conectado. Otros participantes: ${event.peers.length}`);
      break;
    case 'members':
      updateStatus(`Participantes totales: ${event.members.length}`);
      break;
    case 'left':
      updateStatus('Llamada cerrada');
      break;
    default:
      break;
  }
}

function updateStatus(message, tone = 'info') {
  ui.updateStatus(message, tone);
}

window.addEventListener('beforeunload', () => {
  if (sessionActive) {
    meshManager.leave().catch(() => {});
  }
});

// Exponemos hooks opcionales para pruebas avanzadas
window.cleanCall = {
  enableRnNoise: () => meshManager.enableRnNoiseWorklet(),
  state: () => ({ sessionActive, activeRoomId })
};

ui.focusRoomInput();
