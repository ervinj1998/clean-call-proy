const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' }
];

export const DEFAULT_AUDIO_CONSTRAINTS = {
  audio: {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true }
  }
};

function createLogger(namespace) {
  return {
    info: (...args) => console.log(`[${namespace}]`, ...args),
    warn: (...args) => console.warn(`[${namespace}]`, ...args),
    error: (...args) => console.error(`[${namespace}]`, ...args)
  };
}

export class PeerMeshManager {
  constructor(options) {
    const {
      signalingClient,
      onLocalStream,
      onRemoteStream,
      onRemoteStreamRemoved,
      onStatus,
      workletUrl = '',
      logger = createLogger('PeerMesh')
    } = options;

    this.signaling = signalingClient;
    this.onLocalStream = onLocalStream;
    this.onRemoteStream = onRemoteStream;
    this.onRemoteStreamRemoved = onRemoteStreamRemoved;
    this.onStatus = onStatus;
    this.logger = logger;
    this.workletUrl = workletUrl;

    this.roomId = null;
    this.peerId = null;
    this.localStream = null;
    this.connections = new Map();
    this.subscriptions = new Set();
    this.audioContext = null;
    this.processedLocalStream = null;
  }

  async ensureLocalStream(constraints = DEFAULT_AUDIO_CONSTRAINTS) {
    if (this.localStream) {
      return this.localStream;
    }
    this.logger.info('Solicitando stream local con constraints', constraints);
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.localStream = stream;
    this.onLocalStream?.(stream);
    return stream;
  }

  async enableRnNoiseWorklet() {
    if (!this.workletUrl) {
      this.logger.warn('No hay URL de AudioWorklet configurada, omitiendo RNNoise');
      return null;
    }
    if (!this.localStream) {
      throw new Error('LocalStream no disponible para RNNoise');
    }
    if (this.audioContext) {
      return this.processedLocalStream ?? this.localStream;
    }
    this.audioContext = new AudioContext();
    await this.audioContext.audioWorklet.addModule(this.workletUrl);
    const source = this.audioContext.createMediaStreamSource(this.localStream);
    const rnNoiseNode = new AudioWorkletNode(this.audioContext, 'rnnoise-processor');
    const destination = this.audioContext.createMediaStreamDestination();
    source.connect(rnNoiseNode).connect(destination);
    this.processedLocalStream = destination.stream;
    this.logger.info('RNNoise AudioWorklet conectado (deshabilitado por defecto)');
    return this.processedLocalStream;
  }

  async join(roomId, { createIfMissing = false } = {}) {
    if (this.roomId) {
      throw new Error('already-in-room');
    }

    const normalizedRoomId = roomId.trim();
    if (!normalizedRoomId) {
      throw new Error('invalid-room-id');
    }

    await this.ensureLocalStream();

    this.roomId = normalizedRoomId;
    this.peerId = `peer-${crypto.randomUUID().slice(0, 8)}`;

    await this.signaling.ensureRoom(this.roomId, { createIfMissing });
    const joinResult = await this.signaling.joinRoom(this.roomId, this.peerId);
    const existingPeers = joinResult.members.filter((id) => id !== this.peerId);

    this.logger.info('Unido a sala', this.roomId, 'con peerId', this.peerId, 'otros miembros', existingPeers);
    this.onStatus?.({ type: 'joined', peers: existingPeers });

    this.subscriptions.add(
      this.signaling.subscribeToMembers(this.roomId, ({ members }) => {
        const others = members.filter((id) => id !== this.peerId);
        this.logger.info('Actualización de miembros', others);
        this.signaling.scheduleRoomCleanup(this.roomId, members.length === 1 && members[0] === this.peerId);
        if (members.length === 0) {
          this.signaling.removeRoomIfEmpty(this.roomId).catch((error) => this.logger.warn('Error al eliminar sala vacía', error));
        }
        this.onStatus?.({ type: 'members', members, roomId: this.roomId });
        this.connections.forEach((connection, remoteId) => {
          if (!others.includes(remoteId)) {
            this.logger.info('Remoto salió, cerrando', remoteId);
            this.teardownConnection(remoteId, 'peer-left');
          }
        });
      })
    );

    this.subscriptions.add(
      this.signaling.subscribeToOffers(this.roomId, this.peerId, (offer) => {
        this.logger.info('Oferta recibida', offer);
        this.handleOffer(offer).catch((error) => this.logger.error('Error al manejar oferta', error));
      })
    );

    for (const remotePeerId of existingPeers) {
      // Intentamos establecer conexión como originador
      await this.createConnection(remotePeerId, { initiator: true });
    }

    return { roomId: this.roomId, peerId: this.peerId };
  }

  async leave() {
    if (!this.roomId || !this.peerId) {
      return;
    }
    this.logger.info('Saliendo de la sala', this.roomId);

    this.subscriptions.forEach((unsubscribe) => {
      try {
        unsubscribe();
      } catch (error) {
        this.logger.warn('Error al cancelar subscripción', error);
      }
    });
    this.subscriptions.clear();

    const teardownPromises = Array.from(this.connections.keys()).map((remoteId) => this.teardownConnection(remoteId, 'bye'));
    await Promise.allSettled(teardownPromises);

    await this.signaling.leaveRoom(this.roomId, this.peerId);
    await this.signaling.removeRoomIfEmpty(this.roomId).catch(() => {});

    this.roomId = null;
    this.peerId = null;
    this.onStatus?.({ type: 'left' });
  }

  async createConnection(remotePeerId, { initiator, offerId } = { initiator: false }) {
    if (this.connections.has(remotePeerId)) {
      return this.connections.get(remotePeerId);
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const connectionOfferId = offerId ?? this.signaling.buildOfferId(this.peerId, remotePeerId);

    this.localStream?.getTracks().forEach((track) => pc.addTrack(track, this.localStream));

    const connection = {
      remotePeerId,
      offerId: connectionOfferId,
      initiator,
      pc,
      candidateSubscriptions: [],
      answerSubscription: null,
      closing: false
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }
      this.signaling
        .addIceCandidate(this.roomId, connection.offerId, initiator ? 'caller' : 'callee', event.candidate.toJSON(), this.peerId)
        .catch((error) => this.logger.warn('Error al publicar ICE', error));
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        this.onRemoteStream?.(remotePeerId, stream);
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      this.logger.info('ICE state', remotePeerId, state);
      if (state === 'failed' || state === 'closed') {
        this.teardownConnection(remotePeerId, `ice-${state}`);
      }
      if (state === 'connected' || state === 'completed') {
        this.signaling.clearCandidates(this.roomId, connection.offerId).catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.logger.info('Peer connection state', remotePeerId, state);
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.teardownConnection(remotePeerId, state);
      }
    };

    this.connections.set(remotePeerId, connection);

    if (initiator) {
      await this.handleInitiatorFlow(connection);
    }

    return connection;
  }

  async handleInitiatorFlow(connection) {
    const { pc, remotePeerId } = connection;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await this.signaling.postOffer(this.roomId, {
      offerId: connection.offerId,
      from: this.peerId,
      to: remotePeerId,
      description: pc.localDescription
    });

    connection.answerSubscription = this.signaling.subscribeToAnswers(this.roomId, connection.offerId, async (answerSignal) => {
      if (!answerSignal?.description) {
        return;
      }
      await pc.setRemoteDescription(answerSignal.description);
      await this.signaling.clearAnswer(this.roomId, connection.offerId);
      if (connection.answerSubscription) {
        connection.answerSubscription();
        this.subscriptions.delete(connection.answerSubscription);
        connection.answerSubscription = null;
      }
    });

    const unsubscribe = this.signaling.subscribeToIceCandidates(this.roomId, connection.offerId, 'callee', async ({ candidate }) => {
      if (!candidate) {
        return;
      }
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        this.logger.warn('ICE callee candidate rejection', error);
      }
    });
    connection.candidateSubscriptions.push(unsubscribe);
  }

  async handleOffer(offerSignal) {
    const remotePeerId = offerSignal.from;
    let connection = this.connections.get(remotePeerId);
    if (!connection) {
      connection = await this.createConnection(remotePeerId, { initiator: false, offerId: offerSignal.id });
    } else {
      connection.offerId = offerSignal.id;
    }

    const { pc } = connection;
    await pc.setRemoteDescription(offerSignal.description);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.signaling.postAnswer(this.roomId, connection.offerId, {
      from: this.peerId,
      to: remotePeerId,
      description: pc.localDescription
    });

    await this.signaling.clearOffer(this.roomId, connection.offerId).catch(() => {});

    const unsubscribe = this.signaling.subscribeToIceCandidates(this.roomId, connection.offerId, 'caller', async ({ candidate }) => {
      if (!candidate) {
        return;
      }
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        this.logger.warn('ICE caller candidate rejection', error);
      }
    });
    connection.candidateSubscriptions.push(unsubscribe);
  }

  async teardownConnection(remotePeerId, reason = 'teardown') {
    const connection = this.connections.get(remotePeerId);
    if (!connection || connection.closing) {
      return;
    }
    connection.closing = true;
    this.logger.info('Cerrando conexión con', remotePeerId, 'por', reason);

    connection.candidateSubscriptions.forEach((unsubscribe) => {
      try {
        unsubscribe();
      } catch (error) {
        this.logger.warn('Error al quitar listener de candidatos', error);
      }
    });
    connection.candidateSubscriptions = [];

    if (connection.answerSubscription) {
      connection.answerSubscription();
      connection.answerSubscription = null;
    }

    try {
      connection.pc.onicecandidate = null;
      connection.pc.ontrack = null;
      connection.pc.oniceconnectionstatechange = null;
      connection.pc.onconnectionstatechange = null;
      connection.pc.close();
    } catch (error) {
      this.logger.warn('Error al cerrar RTCPeerConnection', error);
    }

    this.connections.delete(remotePeerId);
    this.onRemoteStreamRemoved?.(remotePeerId);
    await this.signaling.clearCandidates(this.roomId, connection.offerId).catch(() => {});
    if (connection.initiator) {
      await this.signaling.clearOffer(this.roomId, connection.offerId).catch(() => {});
    } else {
      await this.signaling.clearAnswer(this.roomId, connection.offerId).catch(() => {});
    }
  }
}
