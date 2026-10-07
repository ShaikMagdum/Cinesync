/**
 * CineSync Frame-Accurate Playback Synchronization Engine
 * Features:
 * - Host-authoritative playback control (Play, Pause, Seek, Media selection)
 * - Automatic drift correction engine (> 0.35s hard resync, 0.08s - 0.35s micro-rate nudge)
 * - Infinite sync loop prevention (isRemoteUpdate flag guarding)
 * - Latency compensation with one-way trip estimation
 */

class CineSyncEngine {
  constructor(videoElement, options = {}) {
    this.video = videoElement;
    this.isHost = false;
    this.onBroadcastSync = options.onBroadcastSync || null;
    this.onStatusChange = options.onStatusChange || null;
    this.onDriftCorrected = options.onDriftCorrected || null;

    // Guard against echo-loops
    this.isRemoteUpdate = false;
    this.isSeeking = false;
    this.seekDebounceTimer = null;
    this.heartbeatInterval = null;
    this.microAdjustTimer = null;

    // Diagnostics state
    this.lastDrift = 0;
    this.syncState = 'idle'; // 'locked' | 'adjusting' | 'resyncing' | 'idle'

    this.bindLocalVideoEvents();
  }

  setHostMode(isHost) {
    this.isHost = isHost;
    if (this.isHost) {
      this.startHeartbeat();
    } else {
      this.stopHeartbeat();
    }
    this.updateStatus();
  }

  /**
   * Bind local HTML5 video events
   */
  bindLocalVideoEvents() {
    this.video.addEventListener('play', () => {
      if (this.isRemoteUpdate) return;
      if (this.isHost) {
        this.broadcast({
          action: 'play',
          currentTime: this.video.currentTime,
          isPlaying: true,
          hostTimestamp: Date.now()
        });
      }
    });

    this.video.addEventListener('pause', () => {
      if (this.isRemoteUpdate) return;
      if (this.isHost) {
        this.broadcast({
          action: 'pause',
          currentTime: this.video.currentTime,
          isPlaying: false,
          hostTimestamp: Date.now()
        });
      }
    });

    this.video.addEventListener('seeking', () => {
      if (this.isRemoteUpdate || !this.isHost) return;
      this.isSeeking = true;
    });

    this.video.addEventListener('seeked', () => {
      if (this.isRemoteUpdate || !this.isHost) return;
      this.isSeeking = false;

      // Debounce seek to avoid spamming network while scrubbing
      clearTimeout(this.seekDebounceTimer);
      this.seekDebounceTimer = setTimeout(() => {
        this.broadcast({
          action: 'seek',
          currentTime: this.video.currentTime,
          isPlaying: !this.video.paused,
          hostTimestamp: Date.now()
        });
      }, 80);
    });
  }

  /**
   * Broadcast sync event to peers
   */
  broadcast(payload) {
    if (this.onBroadcastSync && this.isHost) {
      this.onBroadcastSync(payload);
    }
  }

  /**
   * Periodic Host Heartbeat: keeps all guests locked onto host timeline
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (!this.isHost || this.video.paused || this.isSeeking) return;
      this.broadcast({
        action: 'heartbeat',
        currentTime: this.video.currentTime,
        isPlaying: true,
        hostTimestamp: Date.now()
      });
    }, 1000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Guest: Process incoming sync event from Host
   */
  handleHostSync(data) {
    if (this.isHost) return; // Host ignores sync commands

    const { action, currentTime, isPlaying, hostTimestamp } = data;
    const now = Date.now();
    // One-way delay estimate (clamped to realistic range 0 to 1.5s)
    const oneWayDelay = Math.max(0, Math.min(1.5, (now - (hostTimestamp || now)) / 1000));
    const targetTime = currentTime + (isPlaying ? oneWayDelay : 0);
    const drift = Math.abs(this.video.currentTime - targetTime);

    this.lastDrift = drift;

    this.isRemoteUpdate = true;

    try {
      if (action === 'pause') {
        if (!this.video.paused) {
          this.video.pause();
        }
        if (drift > 0.05) {
          this.video.currentTime = currentTime;
        }
        this.syncState = 'locked';
      } else if (action === 'play') {
        if (drift > 0.15) {
          this.video.currentTime = targetTime;
        }
        if (this.video.paused) {
          this.video.play().catch(e => console.warn('[Sync] Autoplay prevented, waiting user tap:', e));
        }
        this.syncState = 'locked';
      } else if (action === 'seek') {
        this.video.currentTime = targetTime;
        if (isPlaying && this.video.paused) {
          this.video.play().catch(() => {});
        } else if (!isPlaying && !this.video.paused) {
          this.video.pause();
        }
        this.syncState = 'locked';
      } else if (action === 'heartbeat') {
        // Evaluate drift during active playback
        if (isPlaying && this.video.paused) {
          this.video.play().catch(() => {});
        }

        // Automatic Drift Correction Decision Matrix
        if (drift > 0.35) {
          // Hard Resync: Frame-accurate seek jump
          this.video.currentTime = targetTime;
          this.syncState = 'resyncing';
          if (this.onDriftCorrected) {
            this.onDriftCorrected({ type: 'hard', drift, targetTime });
          }
        } else if (drift > 0.08) {
          // Micro-adjustment: smoothly nudge playbackRate to catch up without audio glitch
          clearTimeout(this.microAdjustTimer);
          this.syncState = 'adjusting';
          const rate = targetTime > this.video.currentTime ? 1.05 : 0.95;
          this.video.playbackRate = rate;

          this.microAdjustTimer = setTimeout(() => {
            this.video.playbackRate = 1.0;
            this.syncState = 'locked';
            this.updateStatus();
          }, 1200);

          if (this.onDriftCorrected) {
            this.onDriftCorrected({ type: 'micro', drift, rate });
          }
        } else {
          // Locked within ±80ms threshold!
          this.syncState = 'locked';
          this.video.playbackRate = 1.0;
        }
      }
    } finally {
      // Release remote guard shortly after execution
      setTimeout(() => {
        this.isRemoteUpdate = false;
        this.updateStatus();
      }, 50);
    }
  }

  /**
   * Manually force sync to current Host timeline
   */
  forceSyncToHost(currentTime, isPlaying, hostTimestamp) {
    if (this.isHost) return;
    this.handleHostSync({
      action: 'seek',
      currentTime,
      isPlaying,
      hostTimestamp: hostTimestamp || Date.now()
    });
  }

  updateStatus() {
    if (this.onStatusChange) {
      this.onStatusChange({
        isHost: this.isHost,
        syncState: this.syncState,
        drift: this.lastDrift,
        playbackRate: this.video.playbackRate,
        currentTime: this.video.currentTime,
        isPlaying: !this.video.paused
      });
    }
  }

  destroy() {
    this.stopHeartbeat();
    clearTimeout(this.seekDebounceTimer);
    clearTimeout(this.microAdjustTimer);
  }
}

window.CineSyncEngine = CineSyncEngine;
