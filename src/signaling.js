import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-app.js';
import {
  getDatabase,
  ref,
  child,
  get,
  set,
  update,
  remove,
  onValue,
  onChildAdded,
  onChildRemoved,
  off,
  runTransaction,
  serverTimestamp,
  push,
  onDisconnect
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-database.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-auth.js';

const SIGNAL_PATHS = {
  OFFERS: 'offer',
  ANSWERS: 'answer',
  CALLER_CANDIDATES: 'callerCandidates',
  CALLEE_CANDIDATES: 'calleeCandidates',
  MEMBERS: 'members'
};

let firebaseApp;
let database;
let authInstance;
let authReadyPromise;

function assertConfig(config) {
  const required = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'];
  const missing = required.filter((key) => !config?.[key]);
  if (missing.length) {
    throw new Error(`Configuración Firebase incompleta. Faltan: ${missing.join(', ')}`);
  }
}

function ensureFirebase(config) {
  if (firebaseApp) {
    return;
  }
  assertConfig(config);
  firebaseApp = getApps().length ? getApps()[0] : initializeApp(config);
  database = getDatabase(firebaseApp);
  authInstance = getAuth(firebaseApp);
  authReadyPromise = signInAnonymously(authInstance).catch((error) => {
    console.error('Firebase auth error', error);
    throw error;
  });
}

function sanitizeKey(raw) {
  return raw.replace(/[.#$\[\]/]/g, '-');
}

function buildOfferKey(from, to) {
  return sanitizeKey(`${from}__${to}`);
}

function nowMs() {
  return Date.now();
}

export class FirebaseSignalingClient {
  constructor(config) {
    ensureFirebase(config);
    this.db = database;
    this.auth = authInstance;
    this.ready = authReadyPromise;
    this.cleanupHandles = new Map();
    this.cleanupArmed = new Map();
  }

  async ensureRoom(roomId, { createIfMissing = false } = {}) {
    await this.ready;
    const roomRef = ref(this.db, `rooms/${roomId}`);
    const snapshot = await get(roomRef);
    if (!snapshot.exists()) {
      if (!createIfMissing) {
        throw new Error('room-not-found');
      }
      const createResult = await runTransaction(roomRef, (current) => {
        if (current) {
          return; // abort
        }
        return {
          createdAt: serverTimestamp(),
          [SIGNAL_PATHS.MEMBERS]: {}
        };
      });
      if (!createResult.committed) {
        throw new Error('room-already-exists');
      }
    }
    return roomRef;
  }

  async joinRoom(roomId, peerId) {
    await this.ready;
    const membersRef = ref(this.db, `rooms/${roomId}/${SIGNAL_PATHS.MEMBERS}`);
    const joinResult = await runTransaction(membersRef, (current) => {
      const members = current ?? {};
      if (members[peerId]) {
        return members;
      }
      const activeIds = Object.keys(members);
      if (activeIds.length >= 4) {
        return; // abort transaction
      }
      return {
        ...members,
        [peerId]: {
          peerId,
          joinedAt: nowMs(),
          lastSeen: nowMs()
        }
      };
    });

    if (!joinResult.committed) {
      throw new Error('room-full');
    }

    const memberRef = child(membersRef, peerId);
    await update(memberRef, {
      lastSeen: serverTimestamp(),
      peerId
    });
    await onDisconnect(memberRef).remove();

    return {
      members: Object.keys(joinResult.snapshot.val() ?? {}),
      unsubscribe: () => off(membersRef)
    };
  }

  async leaveRoom(roomId, peerId) {
    const memberRef = ref(this.db, `rooms/${roomId}/${SIGNAL_PATHS.MEMBERS}/${peerId}`);
    try {
      await remove(memberRef);
    } catch (error) {
      console.warn('leaveRoom remove member error', error);
    }
    this.cancelRoomCleanup(roomId);
    await this.clearSignalsForPeer(roomId, peerId);
  }

  subscribeToMembers(roomId, callback) {
    const membersRef = ref(this.db, `rooms/${roomId}/${SIGNAL_PATHS.MEMBERS}`);
    const handler = (snapshot) => {
      const raw = snapshot.val() ?? {};
      const memberIds = Object.keys(raw);
      callback({
        members: memberIds,
        raw
      });
    };
    onValue(membersRef, handler);
    return () => off(membersRef, 'value', handler);
  }

  scheduleRoomCleanup(roomId, isSoleOccupant) {
    const roomRef = ref(this.db, `rooms/${roomId}`);
    let handle = this.cleanupHandles.get(roomId);
    if (!handle) {
      handle = onDisconnect(roomRef);
      this.cleanupHandles.set(roomId, handle);
    }

    const armed = this.cleanupArmed.get(roomId) ?? false;

    if (isSoleOccupant && !armed) {
      handle.remove().catch((error) => console.error('onDisconnect.remove failed', error));
      this.cleanupArmed.set(roomId, true);
    } else if (!isSoleOccupant && armed) {
      handle.cancel().catch((error) => console.error('onDisconnect.cancel failed', error));
      this.cleanupArmed.set(roomId, false);
    }
  }

  cancelRoomCleanup(roomId) {
    const handle = this.cleanupHandles.get(roomId);
    if (handle) {
      handle.cancel().catch(() => {});
    }
    this.cleanupArmed.delete(roomId);
  }

  async removeRoomIfEmpty(roomId) {
    const roomRef = ref(this.db, `rooms/${roomId}`);
    const snapshot = await get(roomRef);
    if (!snapshot.exists()) {
      return;
    }
    const members = snapshot.child(SIGNAL_PATHS.MEMBERS).val() ?? {};
    if (Object.keys(members).length === 0) {
      await remove(roomRef);
    }
  }

  subscribeToOffers(roomId, peerId, handler) {
    const offersRef = ref(this.db, `rooms/${roomId}/${SIGNAL_PATHS.OFFERS}`);
    const listener = (snapshot) => {
      const signal = snapshot.val();
      if (!signal) {
        return;
      }
      if (signal.to !== peerId) {
        return;
      }
      handler({ id: snapshot.key, ...signal });
    };
    onChildAdded(offersRef, listener);
    return () => off(offersRef, 'child_added', listener);
  }

  subscribeToAnswers(roomId, offerId, handler) {
    const answersRef = ref(this.db, `rooms/${roomId}/${SIGNAL_PATHS.ANSWERS}/${offerId}`);
    const listener = (snapshot) => {
      const value = snapshot.val();
      if (!value) {
        return;
      }
      handler({ id: snapshot.key, ...value });
    };
    onValue(answersRef, listener);
    return () => off(answersRef, 'value', listener);
  }

  subscribeToIceCandidates(roomId, offerId, role, handler) {
    const node = role === 'caller' ? SIGNAL_PATHS.CALLER_CANDIDATES : SIGNAL_PATHS.CALLEE_CANDIDATES;
    const candidatesRef = ref(this.db, `rooms/${roomId}/${node}/${offerId}`);
    const listener = (snapshot) => {
      const value = snapshot.val();
      if (!value) {
        return;
      }
      handler({ id: snapshot.key, ...value });
    };
    onChildAdded(candidatesRef, listener);
    return () => off(candidatesRef, 'child_added', listener);
  }

  async postOffer(roomId, { offerId, from, to, description }) {
    const offerRef = ref(this.db, `rooms/${roomId}/${SIGNAL_PATHS.OFFERS}/${offerId}`);
    await set(offerRef, {
      from,
      to,
      description,
      createdAt: serverTimestamp()
    });
  }

  async postAnswer(roomId, offerId, { from, to, description }) {
    const answerRef = ref(this.db, `rooms/${roomId}/${SIGNAL_PATHS.ANSWERS}/${offerId}`);
    await set(answerRef, {
      from,
      to,
      description,
      createdAt: serverTimestamp()
    });
  }

  async addIceCandidate(roomId, offerId, role, candidate, owner) {
    const node = role === 'caller' ? SIGNAL_PATHS.CALLER_CANDIDATES : SIGNAL_PATHS.CALLEE_CANDIDATES;
    const candidatesRef = ref(this.db, `rooms/${roomId}/${node}/${offerId}`);
    await push(candidatesRef, {
      owner,
      candidate,
      createdAt: serverTimestamp()
    });
  }

  async clearOffer(roomId, offerId) {
    const offerRef = ref(this.db, `rooms/${roomId}/${SIGNAL_PATHS.OFFERS}/${offerId}`);
    await remove(offerRef);
  }

  async clearAnswer(roomId, offerId) {
    const answerRef = ref(this.db, `rooms/${roomId}/${SIGNAL_PATHS.ANSWERS}/${offerId}`);
    await remove(answerRef);
  }

  async clearCandidates(roomId, offerId) {
    const callerRef = ref(this.db, `rooms/${roomId}/${SIGNAL_PATHS.CALLER_CANDIDATES}/${offerId}`);
    const calleeRef = ref(this.db, `rooms/${roomId}/${SIGNAL_PATHS.CALLEE_CANDIDATES}/${offerId}`);
    await Promise.all([remove(callerRef).catch(() => {}), remove(calleeRef).catch(() => {})]);
  }

  async clearSignalsForPeer(roomId, peerId) {
    const offerRef = ref(this.db, `rooms/${roomId}/${SIGNAL_PATHS.OFFERS}`);
    const offersSnap = await get(offerRef);
    const offers = offersSnap.val() ?? {};
    await Promise.all(
      Object.entries(offers)
        .filter(([, value]) => value.from === peerId || value.to === peerId)
        .map(([offerId]) => this.clearOffer(roomId, offerId))
    );

    const answerRef = ref(this.db, `rooms/${roomId}/${SIGNAL_PATHS.ANSWERS}`);
    const answersSnap = await get(answerRef);
    const answers = answersSnap.val() ?? {};
    await Promise.all(
      Object.entries(answers)
        .filter(([, value]) => value.from === peerId || value.to === peerId)
        .map(([offerId]) => this.clearAnswer(roomId, offerId))
    );
  }

  buildOfferId(from, to) {
    return buildOfferKey(from, to);
  }
}

export function createRandomRoomId() {
  const randomBytes = crypto.getRandomValues(new Uint8Array(8));
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const chars = Array.from(randomBytes, (byte) => alphabet[byte % alphabet.length]);
  const segments = [chars.slice(0, 4).join(''), chars.slice(4, 8).join('')];
  return segments.join('-');
}
