/**
 * CineSync Cryptographic Core
 * End-to-End Encryption (E2EE) using Web Crypto API (AES-256-GCM)
 * Zero Plaintext Storage. Keys shared strictly via URL Hash Fragment (RFC 3986).
 */

class CineCrypto {
  /**
   * Helper: Convert ArrayBuffer / Uint8Array to URL-safe Base64 string
   */
  static bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /**
   * Helper: Convert URL-safe Base64 string to Uint8Array
   */
  static base64ToBuffer(base64) {
    let str = base64.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) {
      str += '=';
    }
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Generate a fresh 256-bit AES-GCM CryptoKey
   */
  static async generateKey() {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('Web Crypto API is not supported in this browser or context.');
    }
    return await window.crypto.subtle.generateKey(
      {
        name: 'AES-GCM',
        length: 256
      },
      true, // extractable for sharing via URL hash
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Export CryptoKey to URL-safe Base64 string
   */
  static async exportKey(key) {
    const rawBuffer = await window.crypto.subtle.exportKey('raw', key);
    return CineCrypto.bufferToBase64(rawBuffer);
  }

  /**
   * Import CryptoKey from URL-safe Base64 string
   */
  static async importKey(base64Key) {
    const rawBuffer = CineCrypto.base64ToBuffer(base64Key);
    return await window.crypto.subtle.importKey(
      'raw',
      rawBuffer,
      {
        name: 'AES-GCM'
      },
      false, // non-extractable once imported for added security
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypt plaintext string using AES-256-GCM with a random 12-byte IV
   * @param {CryptoKey} key 
   * @param {string} plaintext 
   * @returns {Promise<{ iv: string, ciphertext: string }>}
   */
  static async encrypt(key, plaintext) {
    if (!key) throw new Error('Encryption key not initialized');

    // 12 bytes (96 bits) is the standard recommended IV length for AES-GCM
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const encoded = encoder.encode(plaintext);

    const ciphertextBuffer = await window.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        tagLength: 128 // 128-bit authentication tag for AEAD integrity
      },
      key,
      encoded
    );

    return {
      iv: CineCrypto.bufferToBase64(iv),
      ciphertext: CineCrypto.bufferToBase64(ciphertextBuffer)
    };
  }

  /**
   * Decrypt AES-256-GCM ciphertext using the provided IV and key
   * @param {CryptoKey} key 
   * @param {{ iv: string, ciphertext: string }} payload 
   * @returns {Promise<string>}
   */
  static async decrypt(key, payload) {
    if (!key) throw new Error('Decryption key not initialized');
    if (!payload || !payload.iv || !payload.ciphertext) {
      throw new Error('Malformed encrypted payload');
    }

    const iv = CineCrypto.base64ToBuffer(payload.iv);
    const ciphertext = CineCrypto.base64ToBuffer(payload.ciphertext);

    try {
      const decryptedBuffer = await window.crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv,
          tagLength: 128
        },
        key,
        ciphertext
      );

      const decoder = new TextDecoder();
      return decoder.decode(decryptedBuffer);
    } catch (err) {
      throw new Error('Decryption failed: Message corrupted or invalid encryption key.');
    }
  }

  /**
   * Compute a short cryptographic safety fingerprint (hash) from key
   * Formatted like a Signal/WhatsApp safety number: "E4A2 - 9B81 - 77C0 - F31D"
   */
  static async computeSafetyFingerprint(base64Key) {
    const rawBuffer = CineCrypto.base64ToBuffer(base64Key);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', rawBuffer);
    const hashBytes = new Uint8Array(hashBuffer);

    let hex = '';
    for (let i = 0; i < 8; i++) {
      hex += hashBytes[i].toString(16).padStart(2, '0').toUpperCase();
    }

    return `${hex.slice(0, 4)} · ${hex.slice(4, 8)} · ${hex.slice(8, 12)} · ${hex.slice(12, 16)}`;
  }
}

// Export to global window scope for modular browser execution
window.CineCrypto = CineCrypto;
