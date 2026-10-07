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

// Security and compression headers (allowing iframe embedding in AI Studio and preview environments)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0, // No caching during development/updates
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
 * Fixes CORS, replaces 'Content-Disposition: attachment' with 'inline',
 * and handles Range requests (206 Partial Content) for streaming hosts like Gofile and Cloudflare workers.
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

    // Forward client Range header if present
    if (req.headers.range) {
      requestHeaders['Range'] = req.headers.range;
    }

    const customToken = req.query.token || 'G9EyUX5BxXUtomQdnNN8qke6Oc3sZeJq';

    // 1. Special handling for proxy.moron-bots.workers.dev
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
    } 
    // 2. Direct Gofile links (e.g. store-*.gofile.io/download/web/...)
    else if (targetUrl.includes('gofile.io')) {
      requestHeaders['Cookie'] = `accountToken=${customToken}`;
      requestHeaders['Referer'] = 'https://gofile.io/';
    }

    // Fetch upstream
    const upstreamRes = await fetch(fetchUrl, {
      method: 'GET',
      headers: requestHeaders,
      redirect: 'follow'
    });

    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      // If direct gofile or upstream with token failed, fallback to direct targetUrl
      if (fetchUrl !== targetUrl) {
        return res.redirect(targetUrl);
      }
      return res.status(upstreamRes.status).send(`Upstream error: ${upstreamRes.statusText}`);
    }

    // Set CORS and media streaming headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    
    // CRITICAL: Force inline display so browser doesn't download it as an attachment
    res.setHeader('Content-Disposition', 'inline');

    const contentRange = upstreamRes.headers.get('content-range');
    if (contentRange) {
      res.setHeader('Content-Range', contentRange);
    }

    const contentLength = upstreamRes.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    // Pass status (200 or 206 Partial Content)
    res.status(upstreamRes.status);

    // If HEAD request, terminate after sending headers
    if (req.method === 'HEAD') {
      return res.end();
    }

    // Stream upstream body directly into client response using Node.js stream pipeline
    if (upstreamRes.body) {
      const nodeStream = Readable.fromWeb(upstreamRes.body);

      // Handle socket aborts without memory leaks or hanging promises
      req.on('close', () => {
        nodeStream.destroy();
      });

      nodeStream.on('error', (err) => {
        // Client aborted or socket closed - normal during video scrubbing
        nodeStream.destroy();
      });

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

// Fallback route to serve index.html for SPA/Direct navigation
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);

/* ==========================================================================
   IN-MEMORY WEBSOCKET SIGNALING & ROOM COORDINATION
   Strictly Zero Disk Storage, Zero Chat Persistence, Zero Logging of Payloads
   ========================================================================== */

/**
 * Room Session Interface (Volatile RAM only):
 * rooms.set(roomId, {
 *   id: string,
 *   hostToken: string,       // Cryptographic 32-byte secret known only to host
 *   hostPeerId: string,
 *   createdAt: number,
 *   lastActivity: number,
 *   videoState: {
 *     url: string,
 *     title: string,
 *     sourceType: 'url' | 'sample' | 'local',
 *     isPlaying: boolean,
 *     currentTime: number,
 *     updatedAt: number
 *   },
 *   peers: Map<peerId, {
 *     ws: WebSocket,
 *     peerId: string,
 *     nickname: string,
 *     isHost: boolean,
 *     joinedAt: number
 *   }>
 * })
 */
const rooms = new Map();

// Helper to broadcast JSON to specific peers in a room
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

// Helper to safely send message to a single WebSocket client
function sendSafe(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// Generate secure random room ID
function generateRoomId() {
  return 'cs-' + crypto.randomBytes(4).toString('hex');
}

// WebSocket Server initialization
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  let currentRoomId = null;
  let currentPeerId = null;
  let isHost = false;

  // Track liveness
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const { type } = data;

      switch (type) {
        /* ==========================================
           1. CREATE ROOM
           ========================================== */
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
              isPlaying: false,
              currentTime: 0,
              updatedAt: Date.now()
            },
            peers: new Map()
          };

          newRoom.peers.set(peerId, {
            ws,
            peerId,
            nickname,
            isHost: true,
            joinedAt: Date.now()
          });

          rooms.set(roomId, newRoom);
          currentRoomId = roomId;
          currentPeerId = peerId;
          isHost = true;

          sendSafe(ws, {
            type: 'room-created',
            roomId,
            peerId,
            hostToken, // Host keeps this in memory/sessionStorage to authorize control
            nickname,
            videoState: newRoom.videoState,
            peers: [{ peerId, nickname, isHost: true }]
          });
          break;
        }

        /* ==========================================
           2. JOIN ROOM
           ========================================== */
        case 'join-room': {
          const roomId = (data.roomId || '').trim().toLowerCase();
          const room = rooms.get(roomId);

          if (!room) {
            sendSafe(ws, {
              type: 'error',
              code: 'ROOM_NOT_FOUND',
              message: 'Room not found. It may have ended or expired.'
            });
            return;
          }

          // Check if reconnecting host with valid hostToken
          const candidateToken = data.hostToken;
          const isReconnectingHost = candidateToken && candidateToken === room.hostToken;

          const peerId = 'peer-' + crypto.randomBytes(6).toString('hex');
          const nickname = (data.nickname || (isReconnectingHost ? 'Host' : 'Guest')).trim().slice(0, 30);

          if (isReconnectingHost) {
            room.hostPeerId = peerId;
            isHost = true;
          }

          room.peers.set(peerId, {
            ws,
            peerId,
            nickname,
            isHost: isReconnectingHost,
            joinedAt: Date.now()
          });
          room.lastActivity = Date.now();

          currentRoomId = roomId;
          currentPeerId = peerId;

          // Assemble list of current peers
          const peerList = Array.from(room.peers.values()).map(p => ({
            peerId: p.peerId,
            nickname: p.nickname,
            isHost: p.isHost
          }));

          // Notify existing room peers that someone joined
          broadcastToRoom(roomId, {
            type: 'peer-joined',
            peer: { peerId, nickname, isHost: isReconnectingHost }
          }, peerId);

          // Confirm join to the new peer
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

        /* ==========================================
           3. WEBRTC SIGNALING ROUTING
           (Direct peer-to-peer offers, answers, ICE candidates)
           ========================================== */
        case 'signal': {
          if (!currentRoomId || !currentPeerId) return;
          const room = rooms.get(currentRoomId);
          if (!room) return;

          const { targetPeerId, signalType, signalData } = data;
          const targetPeer = room.peers.get(targetPeerId);

          if (targetPeer && targetPeer.ws.readyState === WebSocket.OPEN) {
            sendSafe(targetPeer.ws, {
              type: 'signal',
              fromPeerId: currentPeerId,
              signalType,
              signalData
            });
          }
          break;
        }

        /* ==========================================
           4. HOST PRIVILEGED ACTIONS
           ========================================== */
        case 'host-action': {
          if (!currentRoomId) return;
          const room = rooms.get(currentRoomId);
          if (!room) return;

          // Cryptographic host authentication verification
          if (!data.hostToken || data.hostToken !== room.hostToken) {
            sendSafe(ws, {
              type: 'error',
              code: 'UNAUTHORIZED',
              message: 'Forbidden: Invalid host credentials'
            });
            return;
          }

          const { action } = data;

          if (action === 'kick-peer') {
            const targetPeerId = data.targetPeerId;
            const target = room.peers.get(targetPeerId);
            if (target) {
              sendSafe(target.ws, {
                type: 'kicked',
                reason: 'You were removed from the room by the host.'
              });
              try { target.ws.close(); } catch (_) {}
              room.peers.delete(targetPeerId);
              broadcastToRoom(currentRoomId, {
                type: 'peer-left',
                peerId: targetPeerId,
                reason: 'kicked'
              });
            }
          } else if (action === 'end-room') {
            broadcastToRoom(currentRoomId, {
              type: 'room-ended',
              message: 'The host has ended this CineSync room.'
            });
            // Evict and terminate all sockets in room
            for (const peer of room.peers.values()) {
              try { peer.ws.close(); } catch (_) {}
            }
            rooms.delete(currentRoomId);
            currentRoomId = null;
          } else if (action === 'set-video') {
            // Update authoritative video state
            room.videoState = {
              url: data.videoState.url || '',
              title: data.videoState.title || 'Untitled Video',
              sourceType: data.videoState.sourceType || 'url',
              isPlaying: false,
              currentTime: 0,
              updatedAt: Date.now()
            };
            room.lastActivity = Date.now();
            broadcastToRoom(currentRoomId, {
              type: 'video-updated',
              videoState: room.videoState
            });
          }
          break;
        }

        /* ==========================================
           5. PLAYBACK SYNC RELAY (FALLBACK / AUTHORITY)
           ========================================== */
        case 'sync-event': {
          if (!currentRoomId) return;
          const room = rooms.get(currentRoomId);
          if (!room) return;

          // Only host or validated peers can propagate playback updates
          if (room.hostPeerId === currentPeerId) {
            room.videoState.isPlaying = Boolean(data.isPlaying);
            room.videoState.currentTime = Number(data.currentTime) || 0;
            room.videoState.updatedAt = Date.now();
            room.lastActivity = Date.now();

            // Broadcast to other peers in room
            broadcastToRoom(currentRoomId, {
              type: 'sync-event',
              fromPeerId: currentPeerId,
              action: data.action,
              currentTime: data.currentTime,
              isPlaying: data.isPlaying,
              hostTimestamp: data.hostTimestamp || Date.now()
            }, currentPeerId);
          }
          break;
        }

        /* ==========================================
           6. E2EE CHAT RELAY FALLBACK
           (Used if WebRTC DataChannel is negotiating or firewalled)
           Note: Payloads are client-side encrypted AES-256-GCM.
           Server only forwards ciphertext & random IV. Zero plaintext!
           ========================================== */
        case 'encrypted-chat-relay': {
          if (!currentRoomId || !currentPeerId) return;
          const room = rooms.get(currentRoomId);
          if (!room) return;

          // Forward encrypted payload to all other peers without logging
          broadcastToRoom(currentRoomId, {
            type: 'encrypted-chat-relay',
            fromPeerId: currentPeerId,
            senderNickname: data.senderNickname,
            isHost,
            iv: data.iv,
            ciphertext: data.ciphertext,
            timestamp: data.timestamp || Date.now()
          }, currentPeerId);
          break;
        }

        /* ==========================================
           7. EMOJI REACTION RELAY
           ========================================== */
        case 'reaction': {
          if (!currentRoomId || !currentPeerId) return;
          broadcastToRoom(currentRoomId, {
            type: 'reaction',
            fromPeerId: currentPeerId,
            emoji: data.emoji,
            senderNickname: data.senderNickname
          });
          break;
        }

        /* ==========================================
           8. PING / LATENCY PROBE
           ========================================== */
        case 'ping': {
          sendSafe(ws, {
            type: 'pong',
            timestamp: data.timestamp
          });
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('[Signaling Error]', err.message);
    }
  });

  // Handle client disconnect
  ws.on('close', () => {
    if (currentRoomId && currentPeerId) {
      const room = rooms.get(currentRoomId);
      if (room) {
        room.peers.delete(currentPeerId);

        broadcastToRoom(currentRoomId, {
          type: 'peer-left',
          peerId: currentPeerId,
          reason: 'disconnected'
        });

        // Clean up empty room immediately
        if (room.peers.size === 0) {
          rooms.delete(currentRoomId);
        } else if (room.hostPeerId === currentPeerId) {
          // Notify room that the host disconnected
          broadcastToRoom(currentRoomId, {
            type: 'host-disconnected',
            message: 'Host has temporarily disconnected.'
          });
        }
      }
    }
  });

  ws.on('error', () => {
    try { ws.close(); } catch (_) {}
  });
});

// Periodic housekeeping: ping-pong & clean dead sessions every 30 seconds
const housekeepingInterval = setInterval(() => {
  const now = Date.now();

  // Heartbeat ping to clients
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });

  // Purge abandoned rooms (inactive for over 4 hours)
  for (const [roomId, room] of rooms.entries()) {
    if (room.peers.size === 0 || now - room.lastActivity > 4 * 60 * 60 * 1000) {
      rooms.delete(roomId);
    }
  }
}, 30000);

wss.on('close', () => {
  clearInterval(housekeepingInterval);
});

// Start listening
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🎬 CineSync Server running on http://0.0.0.0:${PORT}`);
  console.log(`🔒 Zero permanent storage active. In-memory E2EE signaling ready.`);
  console.log(`======================================================\n`);
});
