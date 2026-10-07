/**
 * CineSync Application Controller
 */
(function () {
  'use strict';

  let cryptoKey = null, base64CryptoKey = null, safetyFingerprint = null;
  let currentRoomId = null, localPeerId = null, localNickname = 'Viewer';
  let isHost = false, hostToken = null, ws = null, reconnectTimer = null;
  const peersMap = new Map();
  const webrtc = new window.CineWebRTC();
  let syncEngine = null;

  // DOM Elements
  const videoEl = document.getElementById('mainVideo');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const playPauseIcon = document.getElementById('playPauseIcon');
  const rewindBtn = document.getElementById('rewindBtn');
  const forwardBtn = document.getElementById('forwardBtn');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const exitFsOverlayBtn = document.getElementById('exitFsOverlayBtn');
  
  // Media Input DOMs
  const videoUrlInput = document.getElementById('videoUrlInput');
  const loadUrlBtn = document.getElementById('loadUrlBtn');
  const localVideoPicker = document.getElementById('localVideoPicker');
  const subUrlInput = document.getElementById('subUrlInput');
  const loadSubBtn = document.getElementById('loadSubBtn');
  const audioTrackContainer = document.getElementById('audioTrackContainer');
  const audioTrackSelect = document.getElementById('audioTrackSelect');
  
  const sampleBtns = document.querySelectorAll('.sample-btn');
  const mediaTitleDisplay = document.getElementById('mediaTitleDisplay');
  const videoRoleTag = document.getElementById('videoRoleTag');
  const syncOverlayDot = document.getElementById('syncOverlayDot');
  const syncOverlayText = document.getElementById('syncOverlayText');
  const reactionsContainer = document.getElementById('reactionsContainer');
  
  const headerRoomBadge = document.getElementById('headerRoomBadge');
  const headerRoomId = document.getElementById('headerRoomId');
  const headerCopyBtn = document.getElementById('headerCopyBtn');
  const sidebarTabs = document.querySelectorAll('.sidebar-tab');
  const tabContents = document.querySelectorAll('.tab-content');
  const chatMessages = document.getElementById('chatMessages');
  const chatForm = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');
  const reactionBtns = document.querySelectorAll('.reaction-btn');
  const roomModal = document.getElementById('roomModal');
  const createRoomForm = document.getElementById('createRoomForm');
  const joinRoomForm = document.getElementById('joinRoomForm');

  async function init() {
    initSyncEngine();
    bindUIEvents();
    const hashParams = parseUrlHash();

    if (hashParams.room && hashParams.key) {
      currentRoomId = hashParams.room;
      base64CryptoKey = hashParams.key;
      try {
        cryptoKey = await window.CineCrypto.importKey(base64CryptoKey);
        safetyFingerprint = await window.CineCrypto.computeSafetyFingerprint(base64CryptoKey);
        document.getElementById('joinRoomInput').value = currentRoomId;
        document.getElementById('joinKeyInput').value = base64CryptoKey;
        document.getElementById('modalTabJoin').click();
        const savedNick = sessionStorage.getItem('cinesync_nickname');
        if (savedNick) document.getElementById('joinNickname').value = savedNick;
        hostToken = sessionStorage.getItem(`cinesync_host_${currentRoomId}`);
        roomModal.classList.remove('hidden');
      } catch (err) {
        showToast('Invalid key in URL', 'error');
      }
    } else {
      roomModal.classList.remove('hidden');
    }
  }

  function parseUrlHash() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    return { room: params.get('room'), key: params.get('key') };
  }

  function initSyncEngine() {
    syncEngine = new window.CineSyncEngine(videoEl, {
      onBroadcastSync: (payload) => {
        webrtc.broadcastData({ type: 'sync-event', ...payload });
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'sync-event', ...payload }));
      },
      onStatusChange: (status) => updateSyncStatusUI(status),
      onDriftCorrected: () => {}
    });
  }

  function updateSyncStatusUI(status) {
    if (status.isHost) {
      videoRoleTag.className = 'video-role-tag role-host';
      videoRoleTag.textContent = '👑 Host Mode';
      syncOverlayDot.className = 'sync-dot';
      syncOverlayText.textContent = 'Authoritative';
    } else {
      videoRoleTag.className = 'video-role-tag role-guest';
      videoRoleTag.textContent = '🍿 Guest';
      if (status.syncState === 'locked') { syncOverlayDot.className = 'sync-dot'; syncOverlayText.textContent = 'Synced'; }
      else if (status.syncState === 'adjusting') { syncOverlayDot.className = 'sync-dot warning'; syncOverlayText.textContent = 'Adjusting'; }
      else { syncOverlayDot.className = 'sync-dot error'; syncOverlayText.textContent = 'Resyncing'; }
    }
    playPauseIcon.textContent = status.isPlaying ? '❚❚ Pause' : '▶ Play';
  }

  function connectSignalingServer(onOpenCallback) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return onOpenCallback && onOpenCallback();
    ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`);
    ws.onopen = () => { if (onOpenCallback) onOpenCallback(); };
    ws.onmessage = (event) => handleSignalingMessage(JSON.parse(event.data));
    ws.onclose = () => {
      clearTimeout(reconnectTimer);
      if (currentRoomId) reconnectTimer = setTimeout(() => connectSignalingServer(() => ws.send(JSON.stringify({ type: 'join-room', roomId: currentRoomId, nickname: localNickname, hostToken }))), 3000);
    };
  }

  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'room-created':
        currentRoomId = msg.roomId; localPeerId = msg.peerId; hostToken = msg.hostToken; isHost = true;
        sessionStorage.setItem(`cinesync_host_${currentRoomId}`, hostToken);
        window.location.hash = `#room=${currentRoomId}&key=${base64CryptoKey}`;
        applyRoomState(msg.roomId, msg.peers, msg.videoState, true);
        roomModal.classList.add('hidden');
        showToast('Private Room created!', 'success');
        break;
      case 'room-joined':
        currentRoomId = msg.roomId; localPeerId = msg.peerId; isHost = msg.isHost;
        applyRoomState(msg.roomId, msg.peers, msg.videoState, isHost);
        roomModal.classList.add('hidden');
        webrtc.init({ send: (d) => ws.send(JSON.stringify(d)) }, localPeerId, handlePeerDataMessage, handlePeerStateChange);
        msg.peers.forEach(p => { if (p.peerId !== localPeerId) webrtc.connectToPeer(p.peerId); });
        break;
      case 'peer-joined':
        peersMap.set(msg.peer.peerId, { nickname: msg.peer.nickname, isHost: msg.peer.isHost, connectionState: 'connecting' });
        renderPeerList(); showToast(`${msg.peer.nickname} joined!`, 'info');
        if (webrtc) webrtc.connectToPeer(msg.peer.peerId);
        break;
      case 'peer-left':
        peersMap.delete(msg.peerId); webrtc.cleanupPeer(msg.peerId); renderPeerList();
        break;
      case 'signal':
        webrtc.handleSignal(msg.fromPeerId, msg.signalType, msg.signalData);
        break;
      case 'video-updated':
        setVideoSource(msg.videoState.url, msg.videoState.title, false);
        break;
      case 'subtitle-updated': // Handle incoming subtitle requests
        setSubtitleSource(msg.url, false);
        showToast('Host added a subtitle track', 'info');
        break;
      case 'sync-event':
        if (!isHost) syncEngine.handleHostSync(msg);
        break;
      case 'encrypted-chat-relay':
        handleEncryptedChatPayload(msg);
        break;
      case 'reaction':
        spawnFloatingEmoji(msg.emoji);
        break;
      case 'room-ended':
      case 'kicked':
        leaveRoom();
        break;
    }
  }

  function applyRoomState(roomId, peers, videoState, hostStatus) {
    isHost = hostStatus;
    syncEngine.setHostMode(isHost);

    // Apply Guest Restrictions
    if (!isHost) {
      document.body.classList.add('guest-mode');
      document.querySelector('.sidebar-tab[data-tab="chatTab"]').click();
    } else {
      document.body.classList.remove('guest-mode');
    }

    headerRoomBadge.style.display = 'flex';
    headerRoomId.textContent = roomId;
    document.getElementById('inviteLinkInput').value = window.location.href;
    document.getElementById('hostManagementSection').style.display = isHost ? 'flex' : 'none';

    peersMap.clear();
    peers.forEach(p => peersMap.set(p.peerId, { nickname: p.nickname, isHost: p.isHost, connectionState: 'connecting' }));
    renderPeerList();

    if (videoState && videoState.url) setVideoSource(videoState.url, videoState.title, false);
    if (videoState && videoState.subtitleUrl) setSubtitleSource(videoState.subtitleUrl, false);
  }

  function handlePeerDataMessage(data) {
    if (data.type === 'e2ee-chat') handleEncryptedChatPayload(data);
    if (data.type === 'sync-event' && !isHost) syncEngine.handleHostSync(data);
    if (data.type === 'reaction') spawnFloatingEmoji(data.emoji);
  }

  function handlePeerStateChange(peerId, state) {
    const p = peersMap.get(peerId);
    if (p) {
      if (state.connectionState) p.connectionState = state.connectionState;
      if (state.rtt) p.rtt = state.rtt;
      renderPeerList();
    }
  }

  async function sendChatMessage(text) {
    if (!text || !cryptoKey) return;
    try {
      const encrypted = await window.CineCrypto.encrypt(cryptoKey, text);
      const payload = { type: 'e2ee-chat', senderNickname: localNickname, isHost, iv: encrypted.iv, ciphertext: encrypted.ciphertext, timestamp: Date.now() };
      if (webrtc.broadcastData(payload) === 0 && ws) ws.send(JSON.stringify({ ...payload, type: 'encrypted-chat-relay' }));
      appendChatMessage({ sender: localNickname, isSelf: true, isHost, text, timestamp: payload.timestamp });
    } catch (err) { showToast('Message failed', 'error'); }
  }

  async function handleEncryptedChatPayload(payload) {
    if (!cryptoKey) return;
    try {
      const plaintext = await window.CineCrypto.decrypt(cryptoKey, { iv: payload.iv, ciphertext: payload.ciphertext });
      appendChatMessage({ sender: payload.senderNickname, isSelf: false, isHost: payload.isHost, text: plaintext, timestamp: payload.timestamp });
    } catch (err) {}
  }

  function appendChatMessage({ sender, isSelf, isHost, text, timestamp }) {
    // 1. Sidebar Chat
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${isSelf ? 'self' : 'peer'}`;
    if (!isSelf) {
      const meta = document.createElement('div'); meta.className = 'message-meta';
      const senderSpan = document.createElement('span'); senderSpan.className = `message-sender ${isHost ? 'is-host' : ''}`;
      senderSpan.textContent = isHost ? `👑 ${sender}` : sender;
      meta.appendChild(senderSpan); msgDiv.appendChild(meta);
    }
    const bubble = document.createElement('div'); bubble.className = 'message-bubble'; bubble.textContent = text;
    msgDiv.appendChild(bubble); chatMessages.appendChild(msgDiv); chatMessages.scrollTop = chatMessages.scrollHeight;

    // 2. Fullscreen Video Chat Overlay
    const fsOverlay = document.getElementById('fullscreenChatOverlay');
    if (fsOverlay) {
      const fsMsg = document.createElement('div'); fsMsg.className = 'fs-chat-msg';
      const fsSender = document.createElement('span'); fsSender.className = `fs-chat-sender ${isSelf ? 'self' : (isHost ? 'host' : 'guest')}`;
      fsSender.textContent = (isHost ? '👑 ' : '') + sender + ': ';
      const fsText = document.createElement('span'); fsText.textContent = text;
      fsMsg.appendChild(fsSender); fsMsg.appendChild(fsText); fsOverlay.appendChild(fsMsg);
      if (fsOverlay.children.length > 8) fsOverlay.removeChild(fsOverlay.firstChild);
      setTimeout(() => { fsMsg.style.opacity = '0'; setTimeout(() => { if (fsMsg.parentNode === fsOverlay) fsOverlay.removeChild(fsMsg); }, 500); }, 12000); 
    }
  }

  function spawnFloatingEmoji(emoji) {
    const el = document.createElement('div'); el.className = 'floating-emoji'; el.textContent = emoji;
    el.style.left = `${10 + Math.random() * 80}%`;
    reactionsContainer.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2600);
  }

  // Set Subtitles dynamically
  function setSubtitleSource(url, broadcast = true) {
    if (!url) return;
    let playableUrl = url;
    if (url.includes('proxy.moron-bots.workers.dev') || url.includes('gofile.io')) playableUrl = `/api/stream-proxy?url=${encodeURIComponent(url)}`;
    
    // Remove existing
    const existing = document.getElementById('customSubTrack');
    if (existing) existing.remove();

    const track = document.createElement('track');
    track.id = 'customSubTrack';
    track.kind = 'subtitles';
    track.label = 'Custom Subs';
    track.srclang = 'en';
    track.src = playableUrl;
    track.default = true;

    videoEl.appendChild(track);
    
    // Force browser to enable the text track
    setTimeout(() => {
      if (videoEl.textTracks) {
        for (let i = 0; i < videoEl.textTracks.length; i++) {
          if (videoEl.textTracks[i].label === 'Custom Subs') videoEl.textTracks[i].mode = 'showing';
        }
      }
    }, 200);

    if (broadcast && isHost && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'host-action', action: 'set-subtitle', hostToken, url: url }));
    }
  }

  function setVideoSource(url, title = 'Stream', broadcast = true, token = '') {
    let playableUrl = url;
    if (url.includes('proxy.moron-bots.workers.dev') || url.includes('gofile.io')) playableUrl = `/api/stream-proxy?url=${encodeURIComponent(url)}${token ? '&token='+token : ''}`;
    
    // Remove subtitle when video changes to avoid desync
    const existingSub = document.getElementById('customSubTrack');
    if (existingSub) existingSub.remove();
    subUrlInput.value = '';

    videoEl.src = playableUrl;
    mediaTitleDisplay.textContent = title;
    
    if (broadcast && isHost && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'host-action', action: 'set-video', hostToken, videoState: { url, title, sourceType: 'url' } }));
    }
  }

  // Populate multiple audio tracks if the browser supports the API
  function populateAudioTracks() {
    if (!videoEl.audioTracks || videoEl.audioTracks.length <= 1) {
      audioTrackContainer.style.display = 'none';
      return;
    }
    audioTrackContainer.style.display = 'block';
    audioTrackSelect.innerHTML = '';
    
    for (let i = 0; i < videoEl.audioTracks.length; i++) {
      const track = videoEl.audioTracks[i];
      const option = document.createElement('option');
      option.value = i;
      option.text = track.language || track.label || `Track ${i + 1}`;
      if (track.enabled) option.selected = true;
      audioTrackSelect.appendChild(option);
    }
    
    audioTrackSelect.onchange = (e) => {
      const index = parseInt(e.target.value);
      for (let i = 0; i < videoEl.audioTracks.length; i++) {
        videoEl.audioTracks[i].enabled = (i === index);
      }
    };
  }

  function renderPeerList() {
    peerListContainer.replaceChildren();
    for (const [peerId, peer] of peersMap.entries()) {
      const item = document.createElement('div'); item.className = 'peer-item';
      const info = document.createElement('div'); info.className = 'peer-info';
      const avatar = document.createElement('div'); avatar.className = 'peer-avatar'; avatar.textContent = (peer.nickname || 'U').charAt(0).toUpperCase();
      const name = document.createElement('span'); name.className = 'peer-name'; name.textContent = peer.nickname + (peerId === localPeerId ? ' (You)' : '');
      info.appendChild(avatar); info.appendChild(name);
      const badges = document.createElement('div'); badges.className = 'peer-badges';
      if (peer.isHost) { const hb = document.createElement('span'); hb.className = 'badge-tag badge-host'; hb.textContent = 'HOST'; badges.appendChild(hb); }
      if (isHost && peerId !== localPeerId) {
        const kb = document.createElement('button'); kb.className = 'btn-icon-tiny'; kb.innerHTML = '✕'; kb.style.color = '#f87171';
        kb.onclick = () => ws.send(JSON.stringify({ type: 'host-action', action: 'kick-peer', targetPeerId: peerId, hostToken }));
        badges.appendChild(kb);
      }
      item.appendChild(info); item.appendChild(badges); peerListContainer.appendChild(item);
    }
  }

  function bindUIEvents() {
    videoEl.addEventListener('loadedmetadata', () => {
      showToast('Media loaded', 'success');
      populateAudioTracks(); // Check for multi-audio tracks when video metadata loads
    });

    playPauseBtn.addEventListener('click', () => { if (!isHost) return; videoEl.paused ? videoEl.play() : videoEl.pause(); });
    rewindBtn.addEventListener('click', () => { if (!isHost) return; videoEl.currentTime -= 10; });
    forwardBtn.addEventListener('click', () => { if (!isHost) return; videoEl.currentTime += 10; });

    // Double tap for fullscreen
    videoEl.addEventListener('dblclick', toggleFullscreen);
    fullscreenBtn.addEventListener('click', toggleFullscreen);
    
    function toggleFullscreen() {
      const w = document.querySelector('.video-wrapper');
      const isFs = document.fullscreenElement || document.webkitFullscreenElement;
      if (!isFs) {
        if (w.requestFullscreen) w.requestFullscreen();
        else if (w.webkitRequestFullscreen) w.webkitRequestFullscreen();
        else if (videoEl.webkitEnterFullscreen) videoEl.webkitEnterFullscreen(); // iOS
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      }
    }
    
    if (exitFsOverlayBtn) exitFsOverlayBtn.addEventListener('click', toggleFullscreen);

    loadUrlBtn.addEventListener('click', () => { if (isHost) setVideoSource(videoUrlInput.value.trim(), 'Stream'); });
    loadSubBtn.addEventListener('click', () => { if (isHost) setSubtitleSource(subUrlInput.value.trim()); });
    
    sampleBtns.forEach(btn => btn.addEventListener('click', () => { if (isHost) setVideoSource(btn.dataset.url, btn.dataset.title); }));
    
    sidebarTabs.forEach(tab => tab.addEventListener('click', () => {
      sidebarTabs.forEach(t => t.classList.remove('active')); tabContents.forEach(c => c.classList.remove('active'));
      tab.classList.add('active'); document.getElementById(tab.dataset.tab).classList.add('active');
    }));

    chatForm.addEventListener('submit', (e) => { e.preventDefault(); sendChatMessage(chatInput.value.trim()); chatInput.value = ''; });
    reactionBtns.forEach(btn => btn.addEventListener('click', () => sendReaction(btn.dataset.emoji)));
    
    document.getElementById('endRoomBtn').addEventListener('click', () => { if (confirm('End room?')) ws.send(JSON.stringify({ type: 'host-action', action: 'end-room', hostToken })); });
    document.getElementById('openRoomModalBtn').addEventListener('click', () => roomModal.classList.remove('hidden'));
    
    document.getElementById('modalTabCreate').addEventListener('click', () => { document.getElementById('modalTabCreate').classList.add('active'); document.getElementById('modalTabJoin').classList.remove('active'); createRoomForm.style.display = 'flex'; joinRoomForm.style.display = 'none'; });
    document.getElementById('modalTabJoin').addEventListener('click', () => { document.getElementById('modalTabJoin').classList.add('active'); document.getElementById('modalTabCreate').classList.remove('active'); joinRoomForm.style.display = 'flex'; createRoomForm.style.display = 'none'; });

    createRoomForm.addEventListener('submit', async (e) => {
      e.preventDefault(); localNickname = document.getElementById('createNickname').value.trim() || 'Host';
      cryptoKey = await window.CineCrypto.generateKey(); base64CryptoKey = await window.CineCrypto.exportKey(cryptoKey);
      connectSignalingServer(() => ws.send(JSON.stringify({ type: 'create-room', nickname: localNickname })));
    });

    joinRoomForm.addEventListener('submit', async (e) => {
      e.preventDefault(); localNickname = document.getElementById('joinNickname').value.trim() || 'Guest';
      let tRoom = document.getElementById('joinRoomInput').value.trim(), tKey = document.getElementById('joinKeyInput').value.trim();
      if (tRoom.includes('#')) { const p = new URLSearchParams(tRoom.split('#')[1]); tRoom = p.get('room') || tRoom; tKey = p.get('key') || tKey; }
      if (!tKey && base64CryptoKey) tKey = base64CryptoKey;
      currentRoomId = tRoom; base64CryptoKey = tKey;
      cryptoKey = await window.CineCrypto.importKey(base64CryptoKey);
      connectSignalingServer(() => ws.send(JSON.stringify({ type: 'join-room', roomId: currentRoomId, nickname: localNickname, hostToken: sessionStorage.getItem(`cinesync_host_${currentRoomId}`) })));
    });
  }

  function showToast(msg, type = 'info') {
    const t = document.createElement('div'); t.className = `toast ${type}`;
    t.innerHTML = `<span>${type === 'success' ? '✓' : type === 'error' ? '⚠' : 'ℹ'}</span><span>${msg}</span>`;
    toastContainer.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(100%)'; setTimeout(() => t.remove(), 300); }, 3500);
  }

  function leaveRoom() {
    currentRoomId = null; isHost = false; hostToken = null; webrtc.closeAll(); peersMap.clear(); renderPeerList();
    document.body.classList.remove('guest-mode'); window.location.hash = ''; roomModal.classList.remove('hidden');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
