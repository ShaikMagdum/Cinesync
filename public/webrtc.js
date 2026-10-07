/**
 * CineSync WebRTC P2P DataChannel & Mesh Connection Manager
 * Establishes direct encrypted peer-to-peer data channels for zero-server data transit.
 */

class CineWebRTC {
  constructor() {
    this.localPeerId = null;
    this.signaling = null;
    this.peerConnections = new Map(); // targetPeerId -> RTCPeerConnection
    this.dataChannels = new Map();    // targetPeerId -> RTCDataChannel
    this.pendingCandidates = new Map(); // targetPeerId -> RTCIceCandidate[]
    this.peerLatencies = new Map();   // targetPeerId -> ms
    
    // Callbacks
    this.onMessageCallback = null;
    this.onPeerStateChangeCallback = null;

    // Public STUN configuration
    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ],
      iceCandidatePoolSize: 6
    };
  }

  /**
   * Initialize WebRTC manager with local identity & signaling channel
   */
  init(signaling, localPeerId, onMessage, onPeerStateChange) {
    this.signaling = signaling;
    this.localPeerId = localPeerId;
    this.onMessageCallback = onMessage;
    this.onPeerStateChangeCallback = onPeerStateChange;

    // Start periodic P2P ping to track round-trip time (RTT)
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => this.pingAllPeers(), 4000);
  }

  /**
   * Helper: create or get RTCPeerConnection for a remote peer
   */
  getOrCreateConnection(remotePeerId, isInitiator = false) {
    if (this.peerConnections.has(remotePeerId)) {
      return this.peerConnections.get(remotePeerId);
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peerConnections.set(remotePeerId, pc);

    // ICE Candidate generation
    pc.onicecandidate = (event) => {
      if (event.candidate && this.signaling) {
        this.signaling.send({
          type: 'signal',
          targetPeerId: remotePeerId,
          signalType: 'ice-candidate',
          signalData: event.candidate
        });
      }
    };

    // Connection state logging & events
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (this.onPeerStateChangeCallback) {
        this.onPeerStateChangeCallback(remotePeerId, {
          connectionState: state,
          hasDataChannel: this.dataChannels.has(remotePeerId) && this.dataChannels.get(remotePeerId).readyState === 'open'
        });
      }

      if (state === 'failed' || state === 'closed') {
        this.cleanupPeer(remotePeerId);
      }
    };

    // If we are NOT the initiator, listen for data channel created by initiator
    if (!isInitiator) {
      pc.ondatachannel = (event) => {
        this.setupDataChannel(remotePeerId, event.channel);
      };
    }

    return pc;
  }

  /**
   * Setup RTCDataChannel event handlers
   */
  setupDataChannel(remotePeerId, dc) {
    this.dataChannels.set(remotePeerId, dc);

    dc.onopen = () => {
      console.log(`[WebRTC] DataChannel open with peer: ${remotePeerId}`);
      if (this.onPeerStateChangeCallback) {
        this.onPeerStateChangeCallback(remotePeerId, {
          connectionState: 'connected',
          hasDataChannel: true
        });
      }
      // Send initial ping immediately
      this.pingPeer(remotePeerId);
    };

    dc.onclose = () => {
      console.log(`[WebRTC] DataChannel closed with peer: ${remotePeerId}`);
      this.dataChannels.delete(remotePeerId);
      if (this.onPeerStateChangeCallback) {
        this.onPeerStateChangeCallback(remotePeerId, {
          connectionState: 'disconnected',
          hasDataChannel: false
        });
      }
    };

    dc.onerror = (err) => {
      console.warn(`[WebRTC] DataChannel error with ${remotePeerId}:`, err);
    };

    dc.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // Handle internal P2P latency ping/pong
        if (data._rtcType === 'ping') {
          dc.send(JSON.stringify({ _rtcType: 'pong', originTime: data.originTime }));
          return;
        }
        if (data._rtcType === 'pong') {
          const rtt = Math.max(1, Date.now() - data.originTime);
          this.peerLatencies.set(remotePeerId, rtt);
          if (this.onPeerStateChangeCallback) {
            this.onPeerStateChangeCallback(remotePeerId, { rtt });
          }
          return;
        }

        // Deliver application payload to callback
        if (this.onMessageCallback) {
          this.onMessageCallback(data, remotePeerId);
        }
      } catch (err) {
        console.error('[WebRTC] Parse error on incoming data channel message:', err);
      }
    };
  }

  /**
   * Initiate a connection to a remote peer (creates Offer and DataChannel)
   */
  async connectToPeer(remotePeerId) {
    if (this.localPeerId === remotePeerId) return;

    try {
      const pc = this.getOrCreateConnection(remotePeerId, true);
      const dc = pc.createDataChannel('cinesync-secure-channel', {
        ordered: true
      });
      this.setupDataChannel(remotePeerId, dc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (this.signaling) {
        this.signaling.send({
          type: 'signal',
          targetPeerId: remotePeerId,
          signalType: 'offer',
          signalData: offer
        });
      }
    } catch (err) {
      console.error(`[WebRTC] Failed to connect to peer ${remotePeerId}:`, err);
    }
  }

  /**
   * Handle incoming WebRTC signaling messages from server
   */
  async handleSignal(fromPeerId, signalType, signalData) {
    if (fromPeerId === this.localPeerId) return;

    try {
      if (signalType === 'offer') {
        const pc = this.getOrCreateConnection(fromPeerId, false);
        await pc.setRemoteDescription(new RTCSessionDescription(signalData));

        // Flush queued ICE candidates
        if (this.pendingCandidates.has(fromPeerId)) {
          const queued = this.pendingCandidates.get(fromPeerId);
          for (const cand of queued) {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          }
          this.pendingCandidates.delete(fromPeerId);
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        if (this.signaling) {
          this.signaling.send({
            type: 'signal',
            targetPeerId: fromPeerId,
            signalType: 'answer',
            signalData: answer
          });
        }
      } else if (signalType === 'answer') {
        const pc = this.peerConnections.get(fromPeerId);
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(signalData));

          // Flush queued ICE candidates
          if (this.pendingCandidates.has(fromPeerId)) {
            const queued = this.pendingCandidates.get(fromPeerId);
            for (const cand of queued) {
              await pc.addIceCandidate(new RTCIceCandidate(cand));
            }
            this.pendingCandidates.delete(fromPeerId);
          }
        }
      } else if (signalType === 'ice-candidate') {
        const pc = this.peerConnections.get(fromPeerId);
        if (pc && pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(new RTCIceCandidate(signalData));
        } else {
          // Queue candidate until remote description is set
          if (!this.pendingCandidates.has(fromPeerId)) {
            this.pendingCandidates.set(fromPeerId, []);
          }
          this.pendingCandidates.get(fromPeerId).push(signalData);
        }
      }
    } catch (err) {
      console.error(`[WebRTC] Signal handling error from ${fromPeerId}:`, err);
    }
  }

  /**
   * Broadcast message over all active WebRTC DataChannels
   * @returns {number} count of peers successfully reached via P2P
   */
  broadcastData(data) {
    const payload = JSON.stringify(data);
    let sentCount = 0;

    for (const [peerId, dc] of this.dataChannels.entries()) {
      if (dc.readyState === 'open') {
        try {
          dc.send(payload);
          sentCount++;
        } catch (err) {
          console.warn(`[WebRTC] Failed to send on DataChannel to ${peerId}:`, err);
        }
      }
    }

    return sentCount;
  }

  /**
   * Check if any P2P DataChannel is open
   */
  hasActiveDataChannels() {
    for (const dc of this.dataChannels.values()) {
      if (dc.readyState === 'open') return true;
    }
    return false;
  }

  /**
   * Send ping to measure RTT
   */
  pingPeer(peerId) {
    const dc = this.dataChannels.get(peerId);
    if (dc && dc.readyState === 'open') {
      try {
        dc.send(JSON.stringify({ _rtcType: 'ping', originTime: Date.now() }));
      } catch (_) {}
    }
  }

  pingAllPeers() {
    for (const peerId of this.dataChannels.keys()) {
      this.pingPeer(peerId);
    }
  }

  /**
   * Cleanup specific peer resources
   */
  cleanupPeer(peerId) {
    const dc = this.dataChannels.get(peerId);
    if (dc) {
      try { dc.close(); } catch (_) {}
      this.dataChannels.delete(peerId);
    }

    const pc = this.peerConnections.get(peerId);
    if (pc) {
      try { pc.close(); } catch (_) {}
      this.peerConnections.delete(peerId);
    }

    this.pendingCandidates.delete(peerId);
    this.peerLatencies.delete(peerId);
  }

  /**
   * Cleanup everything upon leaving room
   */
  closeAll() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    for (const peerId of Array.from(this.peerConnections.keys())) {
      this.cleanupPeer(peerId);
    }
  }
}

window.CineWebRTC = CineWebRTC;
