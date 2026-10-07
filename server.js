import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import { Readable } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Security and compression headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: true
}));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    app: 'CineSync',
    uptime: Math.floor(process.uptime()),
    activeRooms: rooms.size,
    timestamp: Date.now()
  });
});

/**
 * Universal Video Stream Proxy & Range Corrector
 */
app.get('/api/stream-proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).send('Missing "url" query parameter');
  }

  try {
    let fetchUrl = targetUrl;
    const requestHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*'
    };

    if (req.headers.range) {
      requestHeaders['Range'] = req.headers.range;
    }

    const customToken = req.query.token || 'G9EyUX5BxXUtomQdnNN8qke6Oc3sZeJq';

    if (targetUrl.includes('proxy.moron-bots.workers.dev/')) {
      try {
        const afterDomain = targetUrl.split('proxy.moron-bots.workers.dev/')[1];
        const firstSlash = afterDomain.indexOf('/');
        const tokenAndBase64 = firstSlash !== -1 ? afterDomain.slice(0, firstSlash) : afterDomain;
        const colonIdx = tokenAndBase64.indexOf(':');
        if (colonIdx !== -1) {
          const token = tokenAndBase64.slice(0, colonIdx);
          const base64Url = tokenAndBase64.slice(colonIdx + 1);
          const decodedTarget = Buffer.from(base64Url, 'base64').toString('utf8');
          if (decodedTarget.startsWith('http')) {
            fetchUrl = decodedTarget;
            requestHeaders['Cookie'] = `accountToken=${token || customToken}`;
            requestHeaders['Referer'] = 'https://gofile.io/';
          }
        }
      } catch (err) {
        console.warn('Could not decode moron-bots target:', err);
      }
    } else if (targetUrl.includes('gofile.io')) {
      requestHeaders['Cookie'] = `accountToken=${customToken}`;
      requestHeaders['Referer'] = 'https://gofile.io/';
    }

    const upstreamRes = await fetch(fetchUrl, {
      method: 'GET',
      headers: requestHeaders,
      redirect: 'follow'
    });

    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      if (fetchUrl !== targetUrl) {
        return res.redirect(targetUrl);
      }
      return res.status(upstreamRes.status).send(`Upstream error: ${upstreamRes.statusText}`);
    }

    // CORS is crucial for WebVTT Subtitles
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    
    // Auto-detect Content-Type for subtitles if missing
    let contentType = upstreamRes.headers.get('content-type') || 'video/mp4';
    if (targetUrl.endsWith('.vtt')) contentType = 'text/vtt';
    if (targetUrl.endsWith('.srt')) contentType = 'text/plain'; // Fallback
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', 'inline');

    const contentRange = upstreamRes.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    const contentLength = upstreamRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    res.status(upstreamRes.status);

    if (req.method === 'HEAD') {
      return res.end();
    }

    if (upstreamRes.body) {
      const nodeStream = Readable.fromWeb(upstreamRes.body);
      req.on('close', () => nodeStream.destroy());
      nodeStream.on('error', () => nodeStream.destroy());
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error('[Stream Proxy Error]', err);
    if (!res.headersSent) {
      res.status(502).send('Error streaming media: ' + err.message);
    }
  }
});

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);

const rooms = new Map();

function broadcastToRoom(roomId, message, excludePeerId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify(message);
  for (const [pId, peer] of room.peers.entries()) {
    if (excludePeerId && pId === excludePeerId) continue;
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(payload);
    }
  }
}

function sendSafe(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function generateRoomId() {
  return 'cs-' + crypto.randomBytes(4).toString('hex');
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  let currentRoomId = null;
  let currentPeerId = null;
  let isHost = false;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const { type } = data;

      switch (type) {
        case 'create-room': {
          const roomId = generateRoomId();
          const hostToken = crypto.randomBytes(32).toString('hex');
          const peerId = 'peer-' + crypto.randomBytes(6).toString('hex');
          const nickname = (data.nickname || 'Host').trim().slice(0, 30);

          const newRoom = {
            id: roomId,
            hostToken,
            hostPeerId: peerId,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            videoState: {
              url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
              title: 'Big Buck Bunny (Sample)',
              sourceType: 'sample',
              subtitleUrl: null, // Subtitle Tracking
              isPlaying: false,
              currentTime: 0,
              updatedAt: Date.now()
            },
            peers: new Map()
          };

          newRoom.peers.set(peerId, { ws, peerId, nickname, isHost: true, joinedAt: Date.now() });
          rooms.set(roomId, newRoom);
          currentRoomId = roomId;
          currentPeerId = peerId;
          isHost = true;

          sendSafe(ws, {
            type: 'room-created',
            roomId,
            peerId,
            hostToken,
            nickname,
            videoState: newRoom.videoState,
            peers: [{ peerId, nickname, isHost: true }]
          });
          break;
        }

        case 'join-room': {
          const roomId = (data.roomId || '').trim().toLowerCase();
          const room = rooms.get(roomId);

          if (!room) {
            sendSafe(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found.' });
            return;
          }

          const candidateToken = data.hostToken;
          const isReconnectingHost = candidateToken && candidateToken === room.hostToken;
          const peerId = 'peer-' + crypto.randomBytes(6).toString('hex');
          const nickname = (data.nickname || (isReconnectingHost ? 'Host' : 'Guest')).trim().slice(0, 30);

          if (isReconnectingHost) {
            room.hostPeerId = peerId;
            isHost = true;
          }

          room.peers.set(peerId, { ws, peerId, nickname, isHost: isReconnectingHost, joinedAt: Date.now() });
          room.lastActivity = Date.now();
          currentRoomId = roomId;
          currentPeerId = peerId;

          const peerList = Array.from(room.peers.values()).map(p => ({ peerId: p.peerId, nickname: p.nickname, isHost: p.isHost }));

          broadcastToRoom(roomId, { type: 'peer-joined', peer: { peerId, nickname, isHost: isReconnectingHost } }, peerId);

          sendSafe(ws, {
            type: 'room-joined',
            roomId,
            peerId,
            isHost: isReconnectingHost,
            nickname,
            peers: peerList,
            videoState: room.videoState
          });
          break;
        }

        case 'signal': {
          if (!currentRoomId || !currentPeerId) return;
          const room = rooms.get(currentRoomId);
          if (!room) return;

          const { targetPeerId, signalType, signalData } = data;
          const targetPeer = room.peers.get(targetPeerId);

          if (targetPeer && targetPeer.ws.readyState === WebSocket.OPEN) {
            sendSafe(targetPeer.ws, { type: 'signal', fromPeerId: currentPeerId, signalType, signalData });
          }
          break;
        }

        case 'host-action': {
          if (!currentRoomId) return;
          const room = rooms.get(currentRoomId);
          if (!room || data.hostToken !== room.hostToken) return;

          const { action } = data;

          if (action === 'kick-peer') {
            const targetPeerId = data.targetPeerId;
            const target = room.peers.get(targetPeerId);
            if (target) {
              sendSafe(target.ws, { type: 'kicked', reason: 'You were removed by the host.' });
              try { target.ws.close(); } catch (_) {}
              room.peers.delete(targetPeerId);
              broadcastToRoom(currentRoomId, { type: 'peer-left', peerId: targetPeerId, reason: 'kicked' });
            }
          } else if (action === 'end-room') {
            broadcastToRoom(currentRoomId, { type: 'room-ended', message: 'Host ended the room.' });
            for (const peer of room.peers.values()) { try { peer.ws.close(); } catch (_) {} }
            rooms.delete(currentRoomId);
            currentRoomId = null;
          } else if (action === 'set-video') {
            room.videoState = {
              url: data.videoState.url || '',
              title: data.videoState.title || 'Untitled Video',
              sourceType: data.videoState.sourceType || 'url',
              subtitleUrl: null, // Clear subtitle when video changes
              isPlaying: false,
              currentTime: 0,
              updatedAt: Date.now()
            };
            room.lastActivity = Date.now();
            broadcastToRoom(currentRoomId, { type: 'video-updated', videoState: room.videoState });
          } else if (action === 'set-subtitle') { // NEW: Handle Subtitles
            room.videoState.subtitleUrl = data.url;
            room.lastActivity = Date.now();
            broadcastToRoom(currentRoomId, { type: 'subtitle-updated', url: data.url });
          }
          break;
        }

        case 'sync-event': {
          if (!currentRoomId) return;
          const room = rooms.get(currentRoomId);
          if (room && room.hostPeerId === currentPeerId) {
            room.videoState.isPlaying = Boolean(data.isPlaying);
            room.videoState.currentTime = Number(data.currentTime) || 0;
            room.videoState.updatedAt = Date.now();
            room.lastActivity = Date.now();
            broadcastToRoom(currentRoomId, { type: 'sync-event', fromPeerId: currentPeerId, ...data }, currentPeerId);
          }
          break;
        }

        case 'encrypted-chat-relay': {
          if (!currentRoomId || !currentPeerId) return;
          broadcastToRoom(currentRoomId, { type: 'encrypted-chat-relay', fromPeerId: currentPeerId, ...data }, currentPeerId);
          break;
        }

        case 'reaction': {
          if (!currentRoomId || !currentPeerId) return;
          broadcastToRoom(currentRoomId, { type: 'reaction', fromPeerId: currentPeerId, emoji: data.emoji, senderNickname: data.senderNickname });
          break;
        }

        case 'ping': {
          sendSafe(ws, { type: 'pong', timestamp: data.timestamp });
          break;
        }
      }
    } catch (err) {
      console.error('[Signaling Error]', err.message);
    }
  });

  ws.on('close', () => {
    if (currentRoomId && currentPeerId) {
      const room = rooms.get(currentRoomId);
      if (room) {
        room.peers.delete(currentPeerId);
        broadcastToRoom(currentRoomId, { type: 'peer-left', peerId: currentPeerId, reason: 'disconnected' });
        if (room.peers.size === 0) {
          rooms.delete(currentRoomId);
        } else if (room.hostPeerId === currentPeerId) {
          broadcastToRoom(currentRoomId, { type: 'host-disconnected', message: 'Host has temporarily disconnected.' });
        }
      }
    }
  });
  ws.on('error', () => { try { ws.close(); } catch (_) {} });
});

setInterval(() => {
  const now = Date.now();
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
  for (const [roomId, room] of rooms.entries()) {
    if (room.peers.size === 0 || now - room.lastActivity > 4 * 60 * 60 * 1000) {
      rooms.delete(roomId);
    }
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🎬 CineSync Server running on http://0.0.0.0:${PORT}`);
  console.log(`======================================================\n`);
});
