// Network resilience utilities for low bandwidth and flaky connections
// Designed for airplane wifi and international roaming

const Network = (() => {
  // Connection quality tracking
  let quality = {
    rtt: 0,           // Round trip time estimate
    bandwidth: 0,     // Estimated bandwidth (bytes/sec)
    loss: 0,          // Packet loss estimate (0-1)
    online: navigator.onLine
  };

  // Ping history for RTT calculation
  const rttSamples = [];
  const MAX_RTT_SAMPLES = 10;

  // Update RTT estimate
  const updateRTT = (sample) => {
    rttSamples.push(sample);
    if (rttSamples.length > MAX_RTT_SAMPLES) {
      rttSamples.shift();
    }
    quality.rtt = rttSamples.reduce((a, b) => a + b, 0) / rttSamples.length;
  };

  // Detect connection quality from Network Information API
  const updateConnectionInfo = () => {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      // effectiveType: slow-2g, 2g, 3g, 4g
      const speedMap = {
        'slow-2g': 50,
        '2g': 150,
        '3g': 500,
        '4g': 5000
      };
      quality.bandwidth = speedMap[conn.effectiveType] || 500;
      quality.rtt = conn.rtt || quality.rtt;
    }
  };

  // Online/offline detection
  window.addEventListener('online', () => {
    quality.online = true;
    dispatchEvent(new CustomEvent('network-change', { detail: quality }));
  });

  window.addEventListener('offline', () => {
    quality.online = false;
    dispatchEvent(new CustomEvent('network-change', { detail: quality }));
  });

  // Connection change detection
  if (navigator.connection) {
    navigator.connection.addEventListener('change', () => {
      updateConnectionInfo();
      dispatchEvent(new CustomEvent('network-change', { detail: quality }));
    });
  }

  // Initialize
  updateConnectionInfo();

  // Adaptive retry with exponential backoff
  class RetryQueue {
    constructor(options = {}) {
      this.queue = [];
      this.processing = false;
      this.maxRetries = options.maxRetries || 5;
      this.baseDelay = options.baseDelay || 1000;
      this.maxDelay = options.maxDelay || 30000;
      this.onProcess = options.onProcess || (() => Promise.resolve());
    }

    add(item, priority = 0) {
      this.queue.push({ item, priority, attempts: 0 });
      this.queue.sort((a, b) => b.priority - a.priority);
      this.process();
    }

    async process() {
      if (this.processing || this.queue.length === 0 || !quality.online) {
        return;
      }

      this.processing = true;

      while (this.queue.length > 0 && quality.online) {
        const entry = this.queue[0];

        try {
          await this.onProcess(entry.item);
          this.queue.shift(); // Success, remove from queue
        } catch (err) {
          entry.attempts++;

          if (entry.attempts >= this.maxRetries) {
            console.error('Max retries exceeded:', entry.item);
            this.queue.shift(); // Give up
          } else {
            // Exponential backoff
            const delay = Math.min(
              this.baseDelay * Math.pow(2, entry.attempts - 1),
              this.maxDelay
            );

            // Adjust delay based on network quality
            const adjustedDelay = delay * (1 + quality.loss);

            await sleep(adjustedDelay);
          }
        }
      }

      this.processing = false;
    }

    clear() {
      this.queue = [];
    }

    get length() {
      return this.queue.length;
    }
  }

  // Message batching for bandwidth efficiency
  class MessageBatcher {
    constructor(options = {}) {
      this.batch = [];
      this.maxSize = options.maxSize || 10;
      this.maxWait = options.maxWait || 500;
      this.onFlush = options.onFlush || (() => {});
      this.timer = null;
    }

    add(message) {
      this.batch.push(message);

      if (this.batch.length >= this.maxSize) {
        this.flush();
      } else if (!this.timer) {
        // Adjust wait time based on network quality
        const wait = quality.rtt > 500 ? this.maxWait * 2 : this.maxWait;
        this.timer = setTimeout(() => this.flush(), wait);
      }
    }

    flush() {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }

      if (this.batch.length > 0) {
        const messages = this.batch;
        this.batch = [];
        this.onFlush(messages);
      }
    }
  }

  // Simple text compression using dictionary encoding
  // Optimized for IRC messages (repeated nicks, common words)
  class MessageCompressor {
    constructor() {
      this.dict = new Map();
      this.nextCode = 256;
      this.maxDictSize = 4096;

      // Pre-populate with common IRC words
      const common = [
        'the', 'and', 'that', 'have', 'for', 'not', 'with', 'you',
        'this', 'but', 'his', 'from', 'they', 'say', 'her', 'she',
        'will', 'one', 'all', 'would', 'there', 'their', 'what',
        'JOIN', 'PART', 'QUIT', 'PRIVMSG', 'NOTICE', 'PING', 'PONG',
        'MODE', 'NICK', 'KICK', 'BAN', 'TOPIC'
      ];

      common.forEach((word, i) => {
        this.dict.set(word, String.fromCharCode(i));
      });
    }

    compress(text) {
      // Simple word-level compression
      return text.replace(/\b\w{3,}\b/g, word => {
        if (this.dict.has(word)) {
          return '\x00' + this.dict.get(word);
        }
        if (this.dict.size < this.maxDictSize) {
          this.dict.set(word, String.fromCharCode(this.nextCode++));
        }
        return word;
      });
    }

    decompress(text) {
      const reverseDict = new Map();
      this.dict.forEach((v, k) => reverseDict.set(v, k));

      return text.replace(/\x00(.)/g, (_, code) => {
        return reverseDict.get(code) || code;
      });
    }

    // Get compression ratio
    ratio(original, compressed) {
      return 1 - (compressed.length / original.length);
    }
  }

  // Connection health monitor
  class HealthMonitor {
    constructor(options = {}) {
      this.checkInterval = options.checkInterval || 30000;
      this.onHealthChange = options.onHealthChange || (() => {});
      this.pingFn = options.pingFn || (() => Promise.resolve());
      this.timer = null;
      this.healthy = true;
      this.consecutiveFailures = 0;
    }

    start() {
      this.check();
      this.timer = setInterval(() => this.check(), this.checkInterval);
    }

    stop() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }

    async check() {
      if (!quality.online) {
        this.setHealth(false);
        return;
      }

      const start = Date.now();

      try {
        await this.pingFn();
        updateRTT(Date.now() - start);
        this.consecutiveFailures = 0;
        this.setHealth(true);
      } catch (err) {
        this.consecutiveFailures++;
        quality.loss = Math.min(this.consecutiveFailures * 0.1, 0.9);

        if (this.consecutiveFailures >= 3) {
          this.setHealth(false);
        }
      }
    }

    setHealth(healthy) {
      if (this.healthy !== healthy) {
        this.healthy = healthy;
        this.onHealthChange(healthy);
      }
    }
  }

  // Helper
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  return {
    getQuality: () => ({ ...quality }),
    updateRTT,

    // Bandwidth-adaptive settings
    getOptimalSettings() {
      if (quality.bandwidth < 100) {
        return {
          batchSize: 20,
          pollInterval: 5000,
          compression: true,
          imageQuality: 'low'
        };
      } else if (quality.bandwidth < 500) {
        return {
          batchSize: 10,
          pollInterval: 2000,
          compression: true,
          imageQuality: 'medium'
        };
      }
      return {
        batchSize: 5,
        pollInterval: 1000,
        compression: false,
        imageQuality: 'high'
      };
    },

    RetryQueue,
    MessageBatcher,
    MessageCompressor,
    HealthMonitor
  };
})();

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Network;
}
