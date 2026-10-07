# CineSync Security Architecture & Threat Model

CineSync is engineered from the ground up on a **Zero-Knowledge, Zero-Persistence** security foundation. The server acts exclusively as an ephemeral WebRTC signaling conduit and static file host; it possesses zero mathematical capability to read chat messages or inspect private communications.

---

## 1. Cryptographic Specifications

| Component | Standard / Algorithm | Parameters | Purpose |
|---|---|---|---|
| **Cipher Suite** | AES-GCM (RFC 5116) | 256-bit key, 128-bit Auth Tag | End-to-End Chat Encryption |
| **IV / Nonce** | CSPRNG (`crypto.getRandomValues`) | 96 bits (12 bytes) random per message | Replay & Nonce-reuse defense |
| **Key Generation** | Web Crypto API (`SubtleCrypto`) | AES-GCM 256-bit | Generated locally in client browser |
| **Key Exchange** | URL Fragment Identifier (RFC 3986 §3.5) | `#room=ID&key=BASE64` | Never transmitted over HTTP to server |
| **Safety Fingerprint** | SHA-256 Digest | 16 hexadecimal bytes | Out-of-band verification number |
| **Transport Security** | WebRTC DataChannel (DTLS 1.3 / SRTP) | SCTP over DTLS | Peer-to-peer data transport |

---

## 2. Zero-Knowledge Key Distribution (RFC 3986 §3.5)

According to **RFC 3986 Section 3.5 (Uniform Resource Identifier: Fragment)**:
> *"The fragment identifier component of a URI allows for indirect identification of a secondary resource by reference to a primary resource... The fragment identifier is not used in the scheme-specific processing of a URI; instead, the fragment identifier is separated from the rest of the URI prior to a dereference, and thus the identifier's dereference is performed solely by the user agent."*

### Why This Matters:
1. When a room creator shares `https://example.com/#room=cs-a1b2&key=dGhpc2lzYTI1NmJpdGtleQ`:
   - The browser sends an HTTP `GET /` request to the server.
   - The fragment `#room=cs-a1b2&key=...` **is stripped by the browser and NEVER sent across the network to the server or reverse proxies (Cloudflare, Nginx, Render)**.
   - The server access logs only record `GET / HTTP/1.1`.
2. The server never receives, sees, or stores the decryption key.
3. Even if an attacker gains full root access to the Node.js server or intercepts all server traffic, they cannot decrypt any chat payloads.

---

## 3. End-to-End Encryption (E2EE) Lifecycle

### A. Room Creation
1. The host browser executes `window.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])`.
2. The key is exported to raw bytes and encoded as URL-safe Base64.
3. The host computes a SHA-256 fingerprint:
   $$\text{Fingerprint} = \text{SHA256}(\text{RawKey})[0..16]$$
   Formatted as `XXXX · XXXX · XXXX · XXXX`.
4. The key is appended to the browser address bar strictly inside the URL hash `#key=...`.

### B. Message Encryption & Transmission
1. Before transmitting any chat message, the sender's browser generates a fresh 12-byte random IV:
   ```javascript
   const iv = window.crypto.getRandomValues(new Uint8Array(12));
   ```
2. The message is encrypted with AES-256-GCM producing ciphertext and a 128-bit authentication tag.
3. The encrypted payload `{ iv, ciphertext, senderNickname, timestamp }` is transmitted directly to peers over WebRTC `RTCDataChannel`.
4. If a peer is behind a restrictive symmetric NAT or firewall where direct P2P is establishing, the payload can be relayed via the server's WebSocket. Because the payload is already encrypted with AES-256-GCM, the server merely sees high-entropy ciphertext.

### C. Decryption & Integrity Verification
1. The recipient receives `{ iv, ciphertext }`.
2. The recipient calls `window.crypto.subtle.decrypt(...)`.
3. If any byte was altered in transit or if an incorrect key was used, AES-GCM authentication fails immediately and rejects the payload with an AEAD integrity error.

---

## 4. Host Privilege Authorization (Anti-Spoofing)

To prevent rogue participants from hijacking playback, kicking the host, or terminating rooms:
1. Upon room creation, the server generates a cryptographically secure 32-byte hexadecimal token:
   ```javascript
   const hostToken = crypto.randomBytes(32).toString('hex');
   ```
2. The host token is stored in server volatile RAM associated with the room session and transmitted once to the host client.
3. Any privileged host operation (`set-video`, `kick-peer`, `end-room`) MUST provide `hostToken`.
4. The server strictly verifies:
   ```javascript
   if (!data.hostToken || data.hostToken !== room.hostToken) {
     return sendError(ws, 'Forbidden: Invalid host credentials');
   }
   ```
5. Guest participants never possess `hostToken` and cannot elevate their privileges.

---

## 5. Cross-Site Scripting (XSS) & DOM Hardening

- **Zero `innerHTML` on Untrusted Data**: All chat messages, peer nicknames, and system events are rendered strictly using `document.createElement` and `element.textContent = messageText`.
- **URL Protocol Whitelisting**: Custom video stream URLs are strictly validated. Any URL containing `javascript:`, `data:text/html`, or unauthorized schemes is rejected.
- **Security Headers**: The Express server injects defense-in-depth headers:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: SAMEORIGIN`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`

---

## 6. Zero Storage & Ephemeral Lifecycle

- **No Databases**: CineSync uses zero MongoDB, PostgreSQL, SQLite, or Redis.
- **No Disk Logging**: Messages are never written to disk or logged to `stdout`.
- **Automatic Eviction**:
  - Rooms exist in memory `Map<roomId, RoomState>`.
  - When the last peer disconnects or the host clicks "End Movie Room", the room and all associated references are immediately deleted from RAM.
  - An automated housekeeping timer purges any inactive room older than 4 hours.
