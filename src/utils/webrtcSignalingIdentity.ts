/**
 * Cloud / LAN WebRTC signaling identity helpers.
 * See arkkvm-cloud/docs/ws/MULTI_CLIENT_SIGNALING.md
 */

export type SignalingMode = 'cloud' | 'lan';

export type SignalingIdentity = {
  /** Cloud-minted id; required on cloud uplink after first metadata frame. */
  cloudClientId?: string;
  /** Device WebRTC session id from answer; stamped on cloud ICE. */
  webrtcSessionId?: string;
  /**
   * Increments on each beginNegotiation. Cloud ICE queued before the bump
   * belongs to the previous offer and must not be flushed with the new id.
   */
  negotiationEpoch: number;
  clientType: 'user' | 'agent';
  mode: SignalingMode;
};

export function createUserSignalingIdentity(
  mode: SignalingMode,
  clientType: 'user' | 'agent' = 'user',
): SignalingIdentity {
  return { mode, clientType, negotiationEpoch: 0 };
}

/** Clear device session id before a new negotiation; keep cloudClientId. */
export function clearWebRTCSessionId(identity: SignalingIdentity): void {
  delete identity.webrtcSessionId;
}

/**
 * Start a new offer. Drops the previous device session id and advances the
 * epoch so held ICE from the last offer is not sent with the next answer.
 * cloudClientId is unchanged.
 */
export function beginNegotiation(identity: SignalingIdentity): number {
  identity.negotiationEpoch += 1;
  clearWebRTCSessionId(identity);
  return identity.negotiationEpoch;
}

/**
 * Cloud ICE uplink requires a device session_id; LAN never does.
 * Used by OutboundIceGate and buildSignalingOutbound.
 */
export function canStampCloudIce(identity: SignalingIdentity): boolean {
  return identity.mode !== 'cloud' || !!identity.webrtcSessionId;
}

type HeldIceCandidate = {
  epoch: number;
  candidate: RTCIceCandidateInit;
};

/**
 * Outbound local-ICE gate: in cloud mode, hold candidates until this offer's
 * session_id is known so the device fail-closed path does not drop them.
 * LAN always passes.
 */
export class OutboundIceGate {
  private pending: HeldIceCandidate[] = [];

  /**
   * Accept a local candidate. LAN sends immediately. Cloud sends immediately
   * only after this offer's session_id is known; otherwise the candidate is
   * held with the negotiation epoch it was gathered in.
   */
  push(
    identity: SignalingIdentity,
    candidate: RTCIceCandidateInit,
  ): RTCIceCandidateInit[] {
    if (identity.mode !== 'cloud') {
      return [candidate];
    }
    if (identity.webrtcSessionId) {
      return [candidate];
    }
    this.pending.push({ epoch: identity.negotiationEpoch, candidate });
    return [];
  }

  /**
   * Drain held candidates for the current epoch once session_id is set.
   * Candidates gathered under a previous epoch stay queued until clear().
   */
  flush(identity: SignalingIdentity): RTCIceCandidateInit[] {
    if (!canStampCloudIce(identity) || this.pending.length === 0) {
      return [];
    }
    const ready: RTCIceCandidateInit[] = [];
    const stillHeld: HeldIceCandidate[] = [];
    for (const item of this.pending) {
      if (item.epoch === identity.negotiationEpoch) {
        ready.push(item.candidate);
      } else {
        stillHeld.push(item);
      }
    }
    this.pending = stillHeld;
    return ready;
  }

  clear(): void {
    this.pending = [];
  }
}

/** Parse minted client_id from the first device-metadata (or equivalent) frame. */
export function parseMintedClientId(message: {
  client_id?: unknown;
  clientId?: unknown;
  data?: { client_id?: unknown; clientId?: unknown };
}): string | undefined {
  const top = message.client_id ?? message.clientId;
  if (typeof top === 'string' && top.length > 0) return top;
  const nested = message.data?.client_id ?? message.data?.clientId;
  if (typeof nested === 'string' && nested.length > 0) return nested;
  return undefined;
}

/** Parse session_id from an answer frame (top-level). */
export function parseSessionId(message: {
  session_id?: unknown;
  sessionId?: unknown;
}): string | undefined {
  const id = message.session_id ?? message.sessionId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Build the JSON object sent on the signaling WebSocket.
 * Cloud mode stamps client_id (and session_id for ICE); always sets offer clientType.
 */
export function buildSignalingOutbound(
  identity: SignalingIdentity,
  type: string,
  data: unknown,
): Record<string, unknown> {
  const message: Record<string, unknown> = { type, data };

  if (type === 'offer' && data && typeof data === 'object' && !Array.isArray(data)) {
    const offerData = { ...(data as Record<string, unknown>) };
    if (offerData.clientType == null) {
      offerData.clientType = identity.clientType;
    }
    message.data = offerData;
  }

  if (identity.mode === 'cloud') {
    if (identity.cloudClientId) {
      message.client_id = identity.cloudClientId;
    }
    if (
      (type === 'new-ice-candidate' || type === 'ice') &&
      identity.webrtcSessionId
    ) {
      message.session_id = identity.webrtcSessionId;
    }
  }

  return message;
}
