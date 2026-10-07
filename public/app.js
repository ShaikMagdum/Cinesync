/**
 * CineSync Application Controller
 * Coordinates WebCrypto, WebRTC mesh signaling, Playback synchronization, and UI state.
 */

(function () {
  'use strict';

  // State Management
  let cryptoKey = null;
  let base64CryptoKey = null;
  let safetyFingerprint = null;
  let currentRoomId = null;
  let localPeerId = null;
  let localNickname = 'Viewer';
  let isHost = false;
  let hostToken = null;
  let ws = null;
  let reconnectTimer = null;

  // Track room participants
  const peersMap = new Map(); // peerId -> { nickname, isHost, connectionState, rtt }

  // Modules
  const webrtc = new window.CineWebRTC();
  let syncEngine = null;

  // DOM Elements
  const videoEl = document.getElementById('mainVideo');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const playPauseIcon = document.getElementById('playPauseIcon');
  const rewindBtn = document.getElementById('rewindBtn');
  const forwardBtn = document.getElementById('forwardBtn');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const forceSyncBtn = document.getElementById('forceSyncBtn');
  const videoUrlInput = document.getElementById('videoUrlInput');
  const loadUrlBtn = document.getElementById('loadUrlBtn');
  const localVideoPicker = document.getElementById('localVideoPicker');
  const sampleBtns = document.querySelectorAll('.sample-btn');
  const mediaTitleDisplay = document.getElementById('mediaTitleDisplay');

  const videoRoleTag = document.getElementById('videoRoleTag');
  const syncOverlayDot = document.getElementById('syncOverlayDot');
  const syncOverlayText = document.getElementById('syncOverlayText');
  const reactionsContainer = document.getElementById('reactionsContainer');

  const headerRoomBadge = document.getElementById('headerRoomBadge');
  const headerRoomId = document.getElementById('headerRoomId');
  const headerCopyBtn = document.getElementById('headerCopyBtn');
  const fingerprintModalBtn = document.getElementById('fingerprintModalBtn');
  const openRoomModalBtn = document.getElementById('openRoomModalBtn');
  const gofileModalBtn = document.getElementById('gofileModalBtn');
  const deployModalBtn = document.getElementById('deployModalBtn');

  // Sidebar Elements
  const sidebarTabs = document.querySelectorAll('.sidebar-tab');
  const tabContents = document.querySelectorAll('.tab-content');
  const chatMessages = document.getElementById('chatMessages');
  const chatForm = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');
  const reactionBtns = document.querySelectorAll('.reaction-btn');

  const inviteLinkInput = document.getElementById('inviteLinkInput');
  const copyInviteBtn = document.getElementById('copyInviteBtn');
  const fingerprintValue = document.getElementById('fingerprintValue');
  const peerListContainer = document.getElementById('peerListContainer');
  const hostManagementSection = document.getElementById('hostManagementSection');
  const endRoomBtn = document.getElementById('endRoomBtn');

  // Diagnostics Elements
  const diagDriftValue = document.getElementById('diagDriftValue');
  const diagSyncState = document.getElementById('diagSyncState');
  const diagPlaybackRate = document.getElementById('diagPlaybackRate');
  const diagTransport = document.getElementById('diagTransport');
  const diagRtt = document.getElementById('diagRtt');

  // Modals
  const roomModal = document.getElementById('roomModal');
  const modalTabCreate = document.getElementById('modalTabCreate');
  const modalTabJoin = document.getElementById('modalTabJoin');
  const createRoomForm = document.getElementById('createRoomForm');
  const joinRoomForm = document.getElementById('joinRoomForm');
  const createNicknameInput = document.getElementById('createNickname');
  const joinNicknameInput = document.getElementById('joinNickname');
  const joinRoomInput = document.getElementById('joinRoomInput');
  const joinKeyGroup = document.getElementById('joinKeyGroup');
  const joinKeyInput = document.getElementById('joinKeyInput');

  const fingerprintModal = document.getElementById('fingerprintModal');
  const modalFingerprintValue = document.getElementById('modalFingerprintValue');
  const closeFingerprintModalBtn = document.getElementById('closeFingerprintModalBtn');

  const gofileModal = document.getElementById('gofileModal');
  const closeGofileModalBtn = document.getElementById('closeGofileModalBtn');
  const gofileStreamForm = document.getElementById('gofileStreamForm');
  const gofileUrlInput = document.getElementById('gofileUrlInput');
  const gofileTokenInput = document.getElementById('gofileTokenInput');
  const gofileLoadSampleBtn = document.getElementById('gofileLoadSampleBtn');

  const deployModal = document.getElementById('deployModal');
  const closeDeployModalBtn = document.getElementById('closeDeployModalBtn');

  const toastContainer = document.getElementById('toastContainer');

  /* ==========================================================================
     INIT & BOOTSTRAP
     ========================================================================== */

  async function init() {
    initSyncEngine();
    bindUIEvents();

    // Check URL Hash for existing room & encryption key (RFC 3986 §3.5)
    const hashParams = parseUrlHash();

    if (hashParams.room && hashParams.key) {
      currentRoomId = hashParams.room;
      base64CryptoKey = hashParams.key;

      try {
        cryptoKey = await window.CineCrypto.importKey(base64CryptoKey);
        safetyFingerprint = await window.CineCrypto.computeSafetyFingerprint(base64CryptoKey);
        updateFingerprintUI(safetyFingerprint);

        // Pre-fill Join form
        joinRoomInput.value = currentRoomId;
        joinKeyInput.value = base64CryptoKey;
        switchModalTab('join');

        // Check if user previously saved nickname in session
        const savedNick = sessionStorage.getItem('cinesync_nickname');
        if (savedNick) {
          joinNicknameInput.value = savedNick;
        }

        // Check if user is reconnecting host
        const savedToken = sessionStorage.getItem(`cinesync_host_${currentRoomId}`);
        if (savedToken) {
          hostToken = savedToken;
        }

        showModal(roomModal);
      } catch (err) {
        showToast('Invalid encryption key in URL fragment', 'error');
        showModal(roomModal);
      }
    } else {
      showModal(roomModal);
    }

    // Set initial default video
    setVideoSource('https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4', 'Big Buck Bunny (Sample)');
  }

  function parseUrlHash() {
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    return {
      room: params.get('room'),
      key: params.get('key')
    };
  }

  function updateUrlHash(roomId, keyBase64) {
    window.location.hash = `#room=${encodeURIComponent(roomId)}&key=${encodeURIComponent(keyBase64)}`;
  }

  /* ==========================================================================
     SYNCHRONIZATION ENGINE INITIALIZATION
     ========================================================================== */

  function initSyncEngine() {
    syncEngine = new window.CineSyncEngine(videoEl, {
      onBroadcastSync: (payload) => {
        // Send via WebRTC P2P DataChannels
        const p2pCount = webrtc.broadcastData({
          type: 'sync-event',
          ...payload
        });

        // Also relay via WebSocket signaling server as backup/authoritative channel
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'sync-event',
            ...payload
          }));
        }
      },
      onStatusChange: (status) => {
        updateSyncStatusUI(status);
      },
      onDriftCorrected: (detail) => {
        if (detail.type === 'hard') {
          showToast(`Frame-accurate re-sync (drift: ${(detail.drift * 1000).toFixed(0)}ms)`, 'info');
        }
      }
    });
  }

  function updateSyncStatusUI(status) {
    if (status.isHost) {
      videoRoleTag.className = 'video-role-tag role-host';
      videoRoleTag.textContent = '👑 Host Mode (Controlling)';
      syncOverlayDot.className = 'sync-dot';
      syncOverlayText.textContent = 'Authoritative Clock';
      diagSyncState.textContent = 'HOST MASTER';
      diagSyncState.style.color = 'var(--accent-gold)';
    } else {
      videoRoleTag.className = 'video-role-tag role-guest';
      videoRoleTag.textContent = '🍿 Date Guest (Synced)';

      const driftMs = Math.round(status.drift * 1000);
      diagDriftValue.textContent = `±${driftMs} ms`;
      diagPlaybackRate.textContent = `${status.playbackRate.toFixed(2)}x`;

      if (status.syncState === 'locked') {
        syncOverlayDot.className = 'sync-dot';
        syncOverlayText.textContent = `Synced (±${driftMs}ms)`;
        diagSyncState.textContent = 'LOCKED';
        diagSyncState.style.color = 'var(--accent-emerald)';
      } else if (status.syncState === 'adjusting') {
        syncOverlayDot.className = 'sync-dot warning';
        syncOverlayText.textContent = `Micro-adjusting (${driftMs}ms)`;
        diagSyncState.textContent = 'SMOOTH NUDGE';
        diagSyncState.style.color = 'var(--accent-gold)';
      } else if (status.syncState === 'resyncing') {
        syncOverlayDot.className = 'sync-dot error';
        syncOverlayText.textContent = `Re-syncing (${driftMs}ms)`;
        diagSyncState.textContent = 'HARD RESYNC';
        diagSyncState.style.color = 'var(--accent-red)';
      }
    }

    // Play/Pause icon reflection
    playPauseIcon.textContent = status.isPlaying ? '❚❚ Pause' : '▶ Play';
  }

  /* ==========================================================================
     WEBSOCKET SIGNALING & PROTOCOL COORDINATION
     ========================================================================== */

  function connectSignalingServer(onOpenCallback) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      if (ws.readyState === WebSocket.OPEN && onOpenCallback) onOpenCallback();
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[Signaling] Connected to CineSync server');
      if (onOpenCallback) onOpenCallback();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleSignalingMessage(msg);
      } catch (err) {
        console.error('[Signaling] Parse error:', err);
      }
    };

    ws.onclose = () => {
      console.warn('[Signaling] Connection closed');
      clearTimeout(reconnectTimer);
      // Attempt auto-reconnect if inside a room
      if (currentRoomId) {
        reconnectTimer = setTimeout(() => {
          connectSignalingServer(() => {
            if (currentRoomId) {
              ws.send(JSON.stringify({
                type: 'join-room',
                roomId: currentRoomId,
                nickname: localNickname,
                hostToken
              }));
            }
          });
        }, 3000);
      }
    };

    ws.onerror = (err) => {
      console.error('[Signaling] WebSocket error:', err);
    };
  }

  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'room-created': {
        currentRoomId = msg.roomId;
        localPeerId = msg.peerId;
        hostToken = msg.hostToken;
        isHost = true;

        sessionStorage.setItem('cinesync_nickname', localNickname);
        sessionStorage.setItem(`cinesync_host_${currentRoomId}`, hostToken);

        updateUrlHash(currentRoomId, base64CryptoKey);
        applyRoomState(msg.roomId, msg.peers, msg.videoState, true);
        hideModal(roomModal);
        showToast('Private Movie Room created! Encryption key active.', 'success');
        break;
      }

      case 'room-joined': {
        currentRoomId = msg.roomId;
        localPeerId = msg.peerId;
        isHost = msg.isHost;

        sessionStorage.setItem('cinesync_nickname', localNickname);
        applyRoomState(msg.roomId, msg.peers, msg.videoState, isHost);

        hideModal(roomModal);
        showToast(`Joined room "${currentRoomId}"`, 'success');

        // Connect WebRTC to all existing peers
        webrtc.init(
          { send: (data) => ws && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(data)) },
          localPeerId,
          handlePeerDataMessage,
          handlePeerStateChange
        );

        for (const peer of msg.peers) {
          if (peer.peerId !== localPeerId) {
            webrtc.connectToPeer(peer.peerId);
          }
        }
        break;
      }

      case 'peer-joined': {
        const p = msg.peer;
        peersMap.set(p.peerId, {
          nickname: p.nickname,
          isHost: p.isHost,
          connectionState: 'connecting',
          rtt: null
        });
        renderPeerList();
        appendSystemMessage(`${p.nickname} joined the theater.`);
        showToast(`${p.nickname} joined!`, 'info');

        // Connect WebRTC to newcomer if we are existing peer
        if (webrtc) {
          webrtc.connectToPeer(p.peerId);
        }
        break;
      }

      case 'peer-left': {
        const peer = peersMap.get(msg.peerId);
        const name = peer ? peer.nickname : 'A viewer';
        peersMap.delete(msg.peerId);
        webrtc.cleanupPeer(msg.peerId);
        renderPeerList();
        appendSystemMessage(`${name} left the room.`);
        break;
      }

      case 'signal': {
        // Route SDP offer/answer/ice to WebRTC engine
        webrtc.handleSignal(msg.fromPeerId, msg.signalType, msg.signalData);
        break;
      }

      case 'video-updated': {
        setVideoSource(msg.videoState.url, msg.videoState.title, false);
        appendSystemMessage(`Movie source updated: ${msg.videoState.title}`);
        break;
      }

      case 'sync-event': {
        if (!isHost) {
          syncEngine.handleHostSync(msg);
        }
        break;
      }

      case 'encrypted-chat-relay': {
        // Fallback encrypted chat payload from server relay
        handleEncryptedChatPayload(msg);
        break;
      }

      case 'reaction': {
        spawnFloatingEmoji(msg.emoji);
        break;
      }

      case 'kicked': {
        showToast('You were removed from the room by the host.', 'error');
        leaveRoom();
        break;
      }

      case 'room-ended': {
        showToast('The host has ended this movie room.', 'warning');
        leaveRoom();
        break;
      }

      case 'error': {
        showToast(msg.message || 'Operation failed', 'error');
        break;
      }
    }
  }

  function applyRoomState(roomId, peers, videoState, hostStatus) {
    isHost = hostStatus;
    syncEngine.setHostMode(isHost);

    // Update Header
    headerRoomBadge.style.display = 'flex';
    headerRoomId.textContent = roomId;
    inviteLinkInput.value = window.location.href;

    // Host Management section
    hostManagementSection.style.display = isHost ? 'flex' : 'none';

    // Populate peers
    peersMap.clear();
    for (const p of peers) {
      peersMap.set(p.peerId, {
        nickname: p.nickname,
        isHost: p.isHost,
        connectionState: p.peerId === localPeerId ? 'self' : 'connecting',
        rtt: null
      });
    }
    renderPeerList();

    // Set video if provided
    if (videoState && videoState.url) {
      setVideoSource(videoState.url, videoState.title, false);
      if (videoState.currentTime && !isHost) {
        videoEl.currentTime = videoState.currentTime;
      }
    }

    // Initialize WebRTC for local client
    webrtc.init(
      { send: (data) => ws && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(data)) },
      localPeerId,
      handlePeerDataMessage,
      handlePeerStateChange
    );
  }

  /* ==========================================================================
     P2P WEBRTC DATA CHANNEL MESSAGING
     ========================================================================== */

  function handlePeerDataMessage(data, remotePeerId) {
    switch (data.type) {
      case 'e2ee-chat': {
        handleEncryptedChatPayload(data);
        break;
      }
      case 'sync-event': {
        if (!isHost) {
          syncEngine.handleHostSync(data);
        }
        break;
      }
      case 'reaction': {
        spawnFloatingEmoji(data.emoji);
        break;
      }
    }
  }

  function handlePeerStateChange(peerId, stateUpdate) {
    const p = peersMap.get(peerId);
    if (p) {
      if (stateUpdate.connectionState) p.connectionState = stateUpdate.connectionState;
      if (stateUpdate.rtt !== undefined) p.rtt = stateUpdate.rtt;
      renderPeerList();
    }

    // Update diagnostics telemetry
    const hasP2P = webrtc.hasActiveDataChannels();
    diagTransport.textContent = hasP2P ? 'Direct DataChannel' : 'Signaling Relay';
    diagTransport.style.color = hasP2P ? 'var(--accent-emerald)' : 'var(--accent-cyan)';

    if (stateUpdate.rtt) {
      diagRtt.textContent = `${stateUpdate.rtt} ms`;
    }
  }

  /* ==========================================================================
     E2EE CHAT LOGIC (Strict TextContent DOM Bindings)
     ========================================================================== */

  async function sendChatMessage(text) {
    if (!text || !cryptoKey) return;

    try {
      // 1. Encrypt text client-side using AES-256-GCM
      const encrypted = await window.CineCrypto.encrypt(cryptoKey, text);

      const payload = {
        type: 'e2ee-chat',
        senderNickname: localNickname,
        isHost: isHost,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        timestamp: Date.now()
      };

      // 2. Broadcast directly via WebRTC DataChannel
      const sentCount = webrtc.broadcastData(payload);

      // 3. If no direct DataChannel open, relay via server (server only sees ciphertext!)
      if (sentCount === 0 && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          ...payload,
          type: 'encrypted-chat-relay'
        }));
      }

      // 4. Render locally
      appendChatMessage({
        sender: localNickname,
        isSelf: true,
        isHost: isHost,
        text: text,
        timestamp: payload.timestamp
      });
    } catch (err) {
      console.error('[Chat] Encryption/Send failed:', err);
      showToast('Failed to encrypt message', 'error');
    }
  }

  async function handleEncryptedChatPayload(payload) {
    if (!cryptoKey) return;

    try {
      // Decrypt message with local AES-256-GCM key
      const plaintext = await window.CineCrypto.decrypt(cryptoKey, {
        iv: payload.iv,
        ciphertext: payload.ciphertext
      });

      appendChatMessage({
        sender: payload.senderNickname || 'Date Partner',
        isSelf: false,
        isHost: Boolean(payload.isHost),
        text: plaintext,
        timestamp: payload.timestamp || Date.now()
      });
    } catch (err) {
      console.warn('[Chat] Decryption failed:', err);
      appendSystemMessage('⚠️ Received corrupted message or invalid key.');
    }
  }

  /**
   * DOM Sanitization: Strictly build DOM tree and use .textContent (No innerHTML!)
   */
  function appendChatMessage({ sender, isSelf, isHost, text, timestamp }) {
    // 1. --- SIDEBAR CHAT LOGIC ---
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${isSelf ? 'self' : 'peer'}`;

    if (!isSelf) {
      const meta = document.createElement('div');
      meta.className = 'message-meta';

      const senderSpan = document.createElement('span');
      senderSpan.className = `message-sender ${isHost ? 'is-host' : ''}`;
      senderSpan.textContent = isHost ? `👑 ${sender}` : sender;

      meta.appendChild(senderSpan);
      msgDiv.appendChild(meta);
    }

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = text; // SAFE textContent binding

    const time = document.createElement('div');
    time.className = 'message-time';
    const dateObj = new Date(timestamp);
    time.textContent = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    bubble.appendChild(time);
    msgDiv.appendChild(bubble);

    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // 2. --- FULLSCREEN VIDEO OVERLAY LOGIC (RIGHT SIDE) ---
    const fsOverlay = document.getElementById('fullscreenChatOverlay');
    if (fsOverlay) {
      const fsMsg = document.createElement('div');
      fsMsg.className = 'fs-chat-msg';
      
      const fsSender = document.createElement('span');
      fsSender.className = `fs-chat-sender ${isSelf ? 'self' : (isHost ? 'host' : 'guest')}`;
      fsSender.textContent = (isHost ? '👑 ' : '') + sender + ': ';
      
      const fsText = document.createElement('span');
      fsText.textContent = text; // SAFE textContent binding
      
      fsMsg.appendChild(fsSender);
      fsMsg.appendChild(fsText);
      
      fsOverlay.appendChild(fsMsg);
      
      // Prevent overlay from flooding the screen (keep max 8 visible at a time)
      if (fsOverlay.children.length > 8) {
        fsOverlay.removeChild(fsOverlay.firstChild);
      }

      // Auto-hide the message from the video screen after 12 seconds
      setTimeout(() => {
        fsMsg.style.opacity = '0';
        setTimeout(() => {
          if (fsMsg.parentNode === fsOverlay) {
            fsOverlay.removeChild(fsMsg);
          }
        }, 500); // Wait for CSS opacity transition to finish
      }, 12000); 
    }
  }

  function appendSystemMessage(text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-message system';
    msgDiv.textContent = text; // SAFE textContent binding
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  /* ==========================================================================
     REACTIONS & FLOATING ANIMATIONS
     ========================================================================== */

  function sendReaction(emoji) {
    if (!currentRoomId) return;

    const payload = {
      type: 'reaction',
      emoji,
      senderNickname: localNickname
    };

    webrtc.broadcastData(payload);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }

    spawnFloatingEmoji(emoji);
  }

  function spawnFloatingEmoji(emoji) {
    const el = document.createElement('div');
    el.className = 'floating-emoji';
    el.textContent = emoji;

    // Randomize horizontal trajectory
    const leftPercent = 10 + Math.random() * 80;
    el.style.left = `${leftPercent}%`;

    reactionsContainer.appendChild(el);

    setTimeout(() => {
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    }, 2600);
  }

  /* ==========================================================================
     VIDEO SOURCE CONTROLS
     ========================================================================== */

  function setVideoSource(url, title = 'Direct Stream', broadcast = true, token = '') {
    // Protocol validation
    if (url.startsWith('javascript:') || url.startsWith('data:text/html')) {
      showToast('Unsafe video URL protocol rejected', 'error');
      return;
    }

    // Auto-detect if URL needs our streaming proxy (e.g. moron-bots, gofile, or restricted CDNs)
    let playableUrl = url;
    if (url.includes('proxy.moron-bots.workers.dev') || url.includes('gofile.io')) {
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
      playableUrl = `/api/stream-proxy?url=${encodeURIComponent(url)}${tokenParam}`;
    }

    // Extract human-readable title from URL if generic
    if (!title || title === 'Direct Stream' || title === 'Custom Stream' || title === 'Gofile Stream') {
      try {
        const decoded = decodeURIComponent(url);
        const lastPart = decoded.split('/').pop().split('?')[0];
        if (lastPart && (lastPart.endsWith('.mp4') || lastPart.endsWith('.mkv') || lastPart.endsWith('.webm'))) {
          title = lastPart.replace(/\.[^/.]+$/, '');
        }
      } catch (_) {}
    }

    videoEl.src = playableUrl;
    mediaTitleDisplay.textContent = title;

    if (broadcast && isHost && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'host-action',
        action: 'set-video',
        hostToken,
        videoState: {
          url,
          title,
          sourceType: 'url'
        }
      }));
    }
  }

  /* ==========================================================================
     PEER LIST RENDERING (XSS-Safe DOM Bindings)
     ========================================================================== */

  function renderPeerList() {
    peerListContainer.replaceChildren();

    for (const [peerId, peer] of peersMap.entries()) {
      const item = document.createElement('div');
      item.className = 'peer-item';

      const info = document.createElement('div');
      info.className = 'peer-info';

      const avatar = document.createElement('div');
      avatar.className = 'peer-avatar';
      avatar.textContent = (peer.nickname || 'U').charAt(0).toUpperCase();

      const name = document.createElement('span');
      name.className = 'peer-name';
      name.textContent = peer.nickname + (peerId === localPeerId ? ' (You)' : '');

      info.appendChild(avatar);
      info.appendChild(name);

      const badges = document.createElement('div');
      badges.className = 'peer-badges';

      if (peer.isHost) {
        const hostBadge = document.createElement('span');
        hostBadge.className = 'badge-tag badge-host';
        hostBadge.textContent = 'HOST';
        badges.appendChild(hostBadge);
      }

      if (peer.rtt !== null && peer.rtt !== undefined) {
        const pingBadge = document.createElement('span');
        pingBadge.className = 'badge-tag badge-p2p';
        pingBadge.textContent = `${peer.rtt}ms`;
        badges.appendChild(pingBadge);
      }

      // Host Kick Action
      if (isHost && peerId !== localPeerId) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'btn-icon-tiny';
        kickBtn.title = `Kick ${peer.nickname}`;
        kickBtn.innerHTML = '✕';
        kickBtn.style.color = '#f87171';
        kickBtn.onclick = () => {
          if (confirm(`Remove ${peer.nickname} from the movie room?`)) {
            ws.send(JSON.stringify({
              type: 'host-action',
              action: 'kick-peer',
              targetPeerId: peerId,
              hostToken
            }));
          }
        };
        badges.appendChild(kickBtn);
      }

      item.appendChild(info);
      item.appendChild(badges);
      peerListContainer.appendChild(item);
    }
  }

  /* ==========================================================================
     UI EVENT BINDINGS
     ========================================================================== */

  function bindUIEvents() {
    // Video lifecycle event listeners
    videoEl.addEventListener('loadedmetadata', () => {
      console.log('[Video] Metadata loaded. Duration:', videoEl.duration);
      showToast('Movie loaded and ready to sync!', 'success');
    });

    videoEl.addEventListener('canplay', () => {
      console.log('[Video] Ready to play');
    });

    videoEl.addEventListener('error', () => {
      const currentSrc = videoEl.currentSrc || videoEl.src;
      const err = videoEl.error;
      console.warn('[Video Player Error] Source failed:', currentSrc, err);
      
      if (currentSrc && !currentSrc.includes('/api/stream-proxy') && currentSrc.startsWith('http')) {
        showToast('Switching to CineSync Stream Proxy...', 'info');
        videoEl.src = `/api/stream-proxy?url=${encodeURIComponent(currentSrc)}`;
        videoEl.load();
      } else if (err) {
        let detail = 'Format or network issue';
        if (err.code === 1) detail = 'Aborted';
        if (err.code === 2) detail = 'Network error downloading media';
        if (err.code === 3) detail = 'Decode error';
        if (err.code === 4) detail = 'Format unsupported in this browser';
        showToast(`Playback error: ${detail}`, 'error');
      }
    });

    // Play/Pause button
    playPauseBtn.addEventListener('click', () => {
      if (!isHost) {
        showToast('Only the host controls playback. Use Re-Sync if drifting.', 'info');
        return;
      }
      if (videoEl.paused) {
        videoEl.play().catch(e => console.warn('Play error:', e));
      } else {
        videoEl.pause();
      }
    });

    // Skip controls
    rewindBtn.addEventListener('click', () => {
      if (!isHost) return;
      videoEl.currentTime = Math.max(0, videoEl.currentTime - 10);
    });

    forwardBtn.addEventListener('click', () => {
      if (!isHost) return;
      videoEl.currentTime = Math.min(videoEl.duration || 99999, videoEl.currentTime + 10);
    });

    // Force Re-Sync
    forceSyncBtn.addEventListener('click', () => {
      if (isHost) {
        showToast('You are the host clock source.', 'info');
        return;
      }
      showToast('Re-syncing timeline to Host...', 'info');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'request-sync' }));
      }
    });

    // Fullscreen toggle
    fullscreenBtn.addEventListener('click', () => {
      const wrapper = document.querySelector('.video-wrapper');
      if (!document.fullscreenElement) {
        wrapper.requestFullscreen().catch(() => videoEl.requestFullscreen());
      } else {
        document.exitFullscreen();
      }
    });

    // Load custom URL
    loadUrlBtn.addEventListener('click', () => {
      const url = videoUrlInput.value.trim();
      if (!url) return;
      if (!isHost) {
        showToast('Only the host can change the video stream', 'info');
        return;
      }
      setVideoSource(url, 'Custom Stream');
      videoUrlInput.value = '';
    });

    // Local file selector (zero server upload)
    localVideoPicker.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const blobUrl = URL.createObjectURL(file);
      setVideoSource(blobUrl, file.name);
      showToast(`Loaded local file: ${file.name}. Note: Date partner must also select the same file copy!`, 'info');
    });

    // Sample video buttons
    sampleBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        if (!isHost) {
          showToast('Only the host can switch sample films', 'info');
          return;
        }
        const url = btn.dataset.url;
        const title = btn.dataset.title;
        setVideoSource(url, title);
      });
    });

    // Sidebar Tab Switching
    sidebarTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetId = tab.dataset.tab;
        sidebarTabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(targetId).classList.add('active');
      });
    });

    // Chat submit
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (!text) return;
      sendChatMessage(text);
      chatInput.value = '';
    });

    // Emoji reaction buttons
    reactionBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        sendReaction(btn.dataset.emoji);
      });
    });

    // Copy Invite Link
    const copyLinkHandler = () => {
      if (!currentRoomId || !base64CryptoKey) {
        showToast('No active room to copy', 'error');
        return;
      }
      const fullUrl = `${window.location.origin}${window.location.pathname}#room=${encodeURIComponent(currentRoomId)}&key=${encodeURIComponent(base64CryptoKey)}`;
      navigator.clipboard.writeText(fullUrl).then(() => {
        showToast('Private invite link copied to clipboard!', 'success');
      }).catch(() => {
        showToast('Failed to copy link', 'error');
      });
    };

    copyInviteBtn.addEventListener('click', copyLinkHandler);
    headerCopyBtn.addEventListener('click', copyLinkHandler);

    // End Room (Host)
    endRoomBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to end this CineSync room for all date participants?')) {
        ws.send(JSON.stringify({
          type: 'host-action',
          action: 'end-room',
          hostToken
        }));
      }
    });

    // Safety Fingerprint Modals
    fingerprintModalBtn?.addEventListener('click', () => showModal(fingerprintModal));
    closeFingerprintModalBtn?.addEventListener('click', () => hideModal(fingerprintModal));

    // Gofile Streamer Modal
    gofileModalBtn?.addEventListener('click', () => showModal(gofileModal));
    closeGofileModalBtn?.addEventListener('click', () => hideModal(gofileModal));

    gofileLoadSampleBtn?.addEventListener('click', () => {
      gofileUrlInput.value = 'https://proxy.moron-bots.workers.dev/G9EyUX5BxXUtomQdnNN8qke6Oc3sZeJq:aHR0cHM6Ly9zdG9yZS1uYS1waHgtNC5nb2ZpbGUuaW8vZG93bmxvYWQvd2ViLzA1MzI2ZWMyLTQxMDEtNGUxNS1iYzg0LTI3OWMzZTc4NjY0My9TcGlkZXItTWFuJTIwQnJhbmQlMjBOZXclMjBEYXklMjAoMjAyNiklMjAxMDgwcCUyMERTNEslMjBXRUItREwlMjAlNUJUZWx1Z3UlMjAoQUFDMi4wKSU1RCUyMHgyNjQlMjBFU3ViLm1wNA/Spider-Man%20Brand%20New%20Day%20%282026%29%201080p%20DS4K%20WEB-DL%20%5BTelugu%20%28AAC2.0%29%5D%20x264%20ESub.mp4';
    });

    gofileStreamForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const rawUrl = gofileUrlInput.value.trim();
      const token = gofileTokenInput.value.trim() || 'G9EyUX5BxXUtomQdnNN8qke6Oc3sZeJq';
      if (!rawUrl) return;

      if (!isHost) {
        showToast('Only the host can initiate movie playback', 'info');
        return;
      }

      setVideoSource(rawUrl, 'Gofile Stream', true, token);
      hideModal(gofileModal);
      showToast('Gofile stream loaded with HTTP 206 Range acceleration!', 'success');
    });

    // Deploy Modal
    deployModalBtn?.addEventListener('click', () => showModal(deployModal));
    closeDeployModalBtn?.addEventListener('click', () => hideModal(deployModal));

    openRoomModalBtn.addEventListener('click', () => showModal(roomModal));

    // Room Modal Form Tabs
    modalTabCreate.addEventListener('click', () => switchModalTab('create'));
    modalTabJoin.addEventListener('click', () => switchModalTab('join'));

    // Create Room Form Submission
    createRoomForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      localNickname = createNicknameInput.value.trim() || 'Host';

      try {
        // 1. Generate fresh AES-256-GCM CryptoKey
        cryptoKey = await window.CineCrypto.generateKey();
        base64CryptoKey = await window.CineCrypto.exportKey(cryptoKey);
        safetyFingerprint = await window.CineCrypto.computeSafetyFingerprint(base64CryptoKey);
        updateFingerprintUI(safetyFingerprint);

        // 2. Connect to signaling and create room
        connectSignalingServer(() => {
          ws.send(JSON.stringify({
            type: 'create-room',
            nickname: localNickname
          }));
        });
      } catch (err) {
        console.error('Room creation failed:', err);
        showToast('Failed to create room: ' + err.message, 'error');
      }
    });

    // Join Room Form Submission
    joinRoomForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      localNickname = joinNicknameInput.value.trim() || 'Guest';

      let inputVal = joinRoomInput.value.trim();
      let targetRoomId = inputVal;
      let targetKey = joinKeyInput.value.trim();

      // Check if user pasted a full URL
      if (inputVal.includes('#')) {
        const hashPart = inputVal.split('#')[1];
        const params = new URLSearchParams(hashPart);
        targetRoomId = params.get('room') || targetRoomId;
        targetKey = params.get('key') || targetKey;
      }

      if (!targetKey && base64CryptoKey) {
        targetKey = base64CryptoKey;
      }

      if (!targetRoomId || !targetKey) {
        showToast('Please provide both Room ID and Decryption Key', 'error');
        return;
      }

      try {
        currentRoomId = targetRoomId;
        base64CryptoKey = targetKey;
        cryptoKey = await window.CineCrypto.importKey(base64CryptoKey);
        safetyFingerprint = await window.CineCrypto.computeSafetyFingerprint(base64CryptoKey);
        updateFingerprintUI(safetyFingerprint);
        updateUrlHash(currentRoomId, base64CryptoKey);

        const savedToken = sessionStorage.getItem(`cinesync_host_${currentRoomId}`);

        connectSignalingServer(() => {
          ws.send(JSON.stringify({
            type: 'join-room',
            roomId: currentRoomId,
            nickname: localNickname,
            hostToken: savedToken
          }));
        });
      } catch (err) {
        console.error('Join failed:', err);
        showToast('Invalid decryption key or room code', 'error');
      }
    });
  }

  function updateFingerprintUI(fp) {
    fingerprintValue.textContent = fp;
    modalFingerprintValue.textContent = fp;
  }

  function switchModalTab(mode) {
    if (mode === 'create') {
      modalTabCreate.classList.add('active');
      modalTabJoin.classList.remove('active');
      createRoomForm.style.display = 'flex';
      joinRoomForm.style.display = 'none';
    } else {
      modalTabJoin.classList.add('active');
      modalTabCreate.classList.remove('active');
      joinRoomForm.style.display = 'flex';
      createRoomForm.style.display = 'none';
      if (!base64CryptoKey) {
        joinKeyGroup.style.display = 'flex';
      }
    }
  }

  function showModal(modal) {
    modal.classList.remove('hidden');
  }

  function hideModal(modal) {
    modal.classList.add('hidden');
  }

  function leaveRoom() {
    currentRoomId = null;
    isHost = false;
    hostToken = null;
    webrtc.closeAll();
    peersMap.clear();
    renderPeerList();
    headerRoomBadge.style.display = 'none';
    window.location.hash = '';
    showModal(roomModal);
  }

  /* ==========================================================================
     TOAST NOTIFICATION ENGINE
     ========================================================================== */

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const iconSpan = document.createElement('span');
    iconSpan.textContent = type === 'success' ? '✓' : type === 'error' ? '⚠' : 'ℹ';

    const textSpan = document.createElement('span');
    textSpan.textContent = message;

    toast.appendChild(iconSpan);
    toast.appendChild(textSpan);

    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 3500);
  }

  // Kickstart on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
