const remoteAudioCards = new Map();

function byId(id) {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Elemento #${id} no encontrado en DOM`);
  }
  return el;
}

const elements = {
  roomIdInput: byId('roomIdInput'),
  generateRoomIdButton: byId('generateRoomIdButton'),
  copyRoomIdButton: byId('copyRoomIdButton'),
  createRoomButton: byId('createRoomButton'),
  joinRoomButton: byId('joinRoomButton'),
  hangUpButton: byId('hangUpButton'),
  statusBadge: byId('statusBadge'),
  localAudio: byId('localAudio'),
  monitorToggle: byId('monitorToggle'),
  remoteAudios: byId('remoteAudios')
};

export function createUIController(callbacks) {
  const {
    onGenerateRoomId,
    onCopyRoomId,
    onCreateRoom,
    onJoinRoom,
    onHangUp,
    onMonitorToggle
  } = callbacks;

  elements.generateRoomIdButton.addEventListener('click', async () => {
    const newId = await onGenerateRoomId?.();
    if (typeof newId === 'string') {
      setRoomId(newId);
    }
  });

  elements.copyRoomIdButton.addEventListener('click', async () => {
    if (!elements.roomIdInput.value) {
      updateStatus('No hay ID para copiar', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(elements.roomIdInput.value.trim());
      updateStatus('ID copiado al portapapeles', 'info');
      onCopyRoomId?.(elements.roomIdInput.value.trim());
    } catch (error) {
      console.error('Clipboard error', error);
      updateStatus('No se pudo copiar el ID', 'error');
    }
  });

  elements.createRoomButton.addEventListener('click', async () => {
    disablePrimaryButtons(true);
    try {
      const roomId = elements.roomIdInput.value.trim();
      await onCreateRoom?.(roomId);
    } finally {
      disablePrimaryButtons(false);
    }
  });

  elements.joinRoomButton.addEventListener('click', async () => {
    disablePrimaryButtons(true);
    try {
      const roomId = elements.roomIdInput.value.trim();
      await onJoinRoom?.(roomId);
    } finally {
      disablePrimaryButtons(false);
    }
  });

  elements.hangUpButton.addEventListener('click', async () => {
    elements.hangUpButton.disabled = true;
    try {
      await onHangUp?.();
    } finally {
      elements.hangUpButton.disabled = false;
    }
  });

  elements.monitorToggle.addEventListener('change', (event) => {
    const enabled = Boolean(event.target.checked);
    onMonitorToggle?.(enabled);
    elements.localAudio.muted = !enabled;
    elements.localAudio.volume = enabled ? 1 : 0;
  });

  return {
    getRoomId,
    setRoomId,
    updateStatus,
    setAvailability,
    attachLocalStream,
    upsertRemoteStream,
    removeRemoteStream,
    resetRemoteStreams,
    setHangUpAvailable,
    setButtonsDisabled: disablePrimaryButtons,
    focusRoomInput: () => elements.roomIdInput.focus()
  };
}

function disablePrimaryButtons(disabled) {
  elements.generateRoomIdButton.disabled = disabled;
  elements.copyRoomIdButton.disabled = disabled;
  elements.createRoomButton.disabled = disabled;
  elements.joinRoomButton.disabled = disabled;
}

function setHangUpAvailable(enabled) {
  elements.hangUpButton.disabled = !enabled;
}

function getRoomId() {
  return elements.roomIdInput.value.trim();
}

function setRoomId(value) {
  elements.roomIdInput.value = value;
}

function updateStatus(message, tone = 'info') {
  elements.statusBadge.textContent = message;
  elements.statusBadge.dataset.tone = tone;
}

function setAvailability({ inCall, roomId }) {
  elements.createRoomButton.disabled = inCall;
  elements.joinRoomButton.disabled = inCall;
  elements.generateRoomIdButton.disabled = inCall;
  if (roomId) {
    setRoomId(roomId);
  }
  setHangUpAvailable(inCall);
}

function attachLocalStream(stream) {
  if (!stream) {
    elements.localAudio.srcObject = null;
    return;
  }
  if (elements.localAudio.srcObject !== stream) {
    elements.localAudio.srcObject = stream;
  }
}

function createRemoteCard(peerId) {
  const card = document.createElement('div');
  card.className = 'remote-card';
  card.dataset.peerId = peerId;

  const header = document.createElement('header');
  header.textContent = `Remoto: ${peerId}`;

  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.controls = true;
  audio.playsInline = true;

  card.append(header, audio);
  elements.remoteAudios.append(card);
  remoteAudioCards.set(peerId, { card, audio, header });
  return { card, audio, header };
}

function upsertRemoteStream(peerId, stream) {
  const existing = remoteAudioCards.get(peerId) ?? createRemoteCard(peerId);
  if (existing.audio.srcObject !== stream) {
    existing.audio.srcObject = stream;
  }
}

function removeRemoteStream(peerId) {
  const existing = remoteAudioCards.get(peerId);
  if (!existing) {
    return;
  }
  existing.audio.srcObject = null;
  existing.card.remove();
  remoteAudioCards.delete(peerId);
}

function resetRemoteStreams() {
  remoteAudioCards.forEach(({ audio, card }) => {
    audio.srcObject = null;
    card.remove();
  });
  remoteAudioCards.clear();
}
