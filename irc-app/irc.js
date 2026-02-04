// Minimalist IRC protocol handler with WebSocket transport
// Designed for low bandwidth and connection resilience

const IRC = (() => {
  // Connection instances keyed by ID
  const connections = new Map();

  // Bandwidth tracking
  let bytesIn = 0, bytesOut = 0;
  let lastBandwidthReset = Date.now();

  // Message queue for offline/reconnect
  const pendingMessages = new Map();

  // IRC message parser - zero allocation where possible
  const parseMessage = (raw) => {
    let prefix = null, command, params = [];
    let i = 0;

    // Parse prefix
    if (raw[0] === ':') {
      const space = raw.indexOf(' ');
      prefix = raw.substring(1, space);
      i = space + 1;
    }

    // Parse command
    let cmdEnd = raw.indexOf(' ', i);
    if (cmdEnd === -1) cmdEnd = raw.length;
    command = raw.substring(i, cmdEnd);
    i = cmdEnd + 1;

    // Parse params
    while (i < raw.length) {
      if (raw[i] === ':') {
        params.push(raw.substring(i + 1));
        break;
      }
      const nextSpace = raw.indexOf(' ', i);
      if (nextSpace === -1) {
        params.push(raw.substring(i));
        break;
      }
      params.push(raw.substring(i, nextSpace));
      i = nextSpace + 1;
    }

    return { prefix, command, params };
  };

  // Extract nick from prefix
  const getNick = (prefix) => {
    if (!prefix) return null;
    const bang = prefix.indexOf('!');
    return bang === -1 ? prefix : prefix.substring(0, bang);
  };

  // Connection class
  class Connection {
    constructor(id, server, nick, options = {}) {
      this.id = id;
      this.server = server;
      this.nick = nick;
      this.channels = new Set();
      this.ws = null;
      this.reconnectAttempts = 0;
      this.maxReconnectAttempts = options.maxReconnect || 10;
      this.reconnectDelay = options.reconnectDelay || 1000;
      this.handlers = new Map();
      this.pingInterval = null;
      this.lastPong = Date.now();
      this.buffer = '';
      this.ssl = options.ssl !== false;

      // Bandwidth throttling
      this.messageQueue = [];
      this.flushInterval = null;
      this.bytesPerSecond = options.bandwidth || 500; // Low bandwidth mode
    }

    connect() {
      return new Promise((resolve, reject) => {
        // Construct WebSocket URL
        // Format: wss://irc.example.com:port or use a gateway
        const [host, port] = this.server.split(':');
        const wsPort = port || (this.ssl ? '6697' : '6667');
        const protocol = this.ssl ? 'wss' : 'ws';

        // Try direct WebSocket first, many modern IRC servers support it
        // Fall back to gateway if needed
        const wsUrl = `${protocol}://${host}:${wsPort}`;

        State.addConnection(this.id, this.server, this.nick, this.ssl);
        State.updateConnectionStatus(this.id, 'connecting');

        try {
          this.ws = new WebSocket(wsUrl);
          this.ws.binaryType = 'arraybuffer';
        } catch (e) {
          State.updateConnectionStatus(this.id, 'error');
          reject(e);
          return;
        }

        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
          State.updateConnectionStatus(this.id, 'connected');

          // IRC registration
          this.send(`NICK ${this.nick}`);
          this.send(`USER ${this.nick} 0 * :IRC Client`);

          // Start ping interval
          this.pingInterval = setInterval(() => this.ping(), 30000);

          // Start message flush interval (bandwidth control)
          this.flushInterval = setInterval(() => this.flushQueue(), 100);

          resolve(this);
        };

        this.ws.onmessage = (event) => {
          const data = typeof event.data === 'string'
            ? event.data
            : new TextDecoder().decode(event.data);

          bytesIn += data.length;
          this.buffer += data;

          // Process complete lines
          let newline;
          while ((newline = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.substring(0, newline).replace(/\r$/, '');
            this.buffer = this.buffer.substring(newline + 1);
            if (line) this.handleMessage(line);
          }
        };

        this.ws.onclose = () => {
          this.cleanup();
          State.updateConnectionStatus(this.id, 'disconnected');
          this.scheduleReconnect();
        };

        this.ws.onerror = (err) => {
          State.updateConnectionStatus(this.id, 'error');
          console.error('WebSocket error:', err);
        };
      });
    }

    handleMessage(raw) {
      const msg = parseMessage(raw);
      const nick = getNick(msg.prefix);

      switch (msg.command) {
        case 'PING':
          this.send(`PONG :${msg.params[0]}`);
          break;

        case 'PONG':
          this.lastPong = Date.now();
          break;

        case 'PRIVMSG': {
          const target = msg.params[0];
          const text = msg.params[1] || '';
          const chanName = `${this.id}:${target}`;

          // Handle CTCP ACTION
          if (text.startsWith('\x01ACTION ') && text.endsWith('\x01')) {
            const action = text.slice(8, -1);
            State.addMessage(chanName, nick, action, 'action');
          } else {
            State.addMessage(chanName, nick, text, 'msg');
          }

          // Update unread if not active channel
          this.emit('message', { channel: target, nick, text });
          break;
        }

        case 'NOTICE':
          if (msg.params[0] === '*' || msg.params[0] === this.nick) {
            // Server notice
            this.emit('notice', { text: msg.params[1] });
          } else {
            const chanName = `${this.id}:${msg.params[0]}`;
            State.addMessage(chanName, nick || 'server', msg.params[1], 'notice');
          }
          break;

        case 'JOIN': {
          const channel = msg.params[0];
          if (nick === this.nick) {
            this.channels.add(channel);
            State.addChannel(this.id, channel);
          }
          const chanName = `${this.id}:${channel}`;
          State.addMessage(chanName, nick, 'joined', 'system');
          this.emit('join', { channel, nick });
          break;
        }

        case 'PART': {
          const channel = msg.params[0];
          if (nick === this.nick) {
            this.channels.delete(channel);
          }
          const chanName = `${this.id}:${channel}`;
          State.addMessage(chanName, nick, `left: ${msg.params[1] || ''}`, 'system');
          this.emit('part', { channel, nick, reason: msg.params[1] });
          break;
        }

        case 'QUIT': {
          const reason = msg.params[0] || '';
          this.channels.forEach(ch => {
            State.addMessage(`${this.id}:${ch}`, nick, `quit: ${reason}`, 'system');
          });
          this.emit('quit', { nick, reason });
          break;
        }

        case 'NICK': {
          const newNick = msg.params[0];
          if (nick === this.nick) {
            this.nick = newNick;
          }
          this.emit('nick', { oldNick: nick, newNick });
          break;
        }

        case 'KICK': {
          const [channel, kicked, reason] = msg.params;
          if (kicked === this.nick) {
            this.channels.delete(channel);
          }
          State.addMessage(`${this.id}:${channel}`, nick, `kicked ${kicked}: ${reason || ''}`, 'system');
          break;
        }

        case '001': // RPL_WELCOME
          this.emit('registered');
          // Rejoin channels
          this.channels.forEach(ch => this.join(ch));
          break;

        case '353': // RPL_NAMREPLY
          // Names in channel
          break;

        case '366': // RPL_ENDOFNAMES
          break;

        case '433': // ERR_NICKNAMEINUSE
          this.nick = this.nick + '_';
          this.send(`NICK ${this.nick}`);
          break;

        default:
          // Log numeric replies
          if (/^\d{3}$/.test(msg.command)) {
            this.emit('numeric', { code: msg.command, params: msg.params });
          }
      }
    }

    // Bandwidth-controlled send
    send(data) {
      this.messageQueue.push(data);
    }

    flushQueue() {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.messageQueue.length === 0) return;

      // Send messages respecting bandwidth limit
      let bytesSent = 0;
      const maxBytes = this.bytesPerSecond / 10; // Per 100ms

      while (this.messageQueue.length > 0 && bytesSent < maxBytes) {
        const msg = this.messageQueue.shift();
        const payload = msg + '\r\n';
        bytesSent += payload.length;
        bytesOut += payload.length;
        this.ws.send(payload);
      }
    }

    // Force send (for PING/PONG)
    sendImmediate(data) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const payload = data + '\r\n';
        bytesOut += payload.length;
        this.ws.send(payload);
      }
    }

    ping() {
      // Check if we got a pong recently
      if (Date.now() - this.lastPong > 120000) {
        console.warn('Connection timeout, reconnecting...');
        this.ws.close();
        return;
      }
      this.sendImmediate(`PING :${Date.now()}`);
    }

    join(channel) {
      this.send(`JOIN ${channel}`);
    }

    part(channel, reason = '') {
      this.send(`PART ${channel}${reason ? ' :' + reason : ''}`);
    }

    say(target, text) {
      // Split long messages
      const maxLen = 400; // Conservative for IRC
      for (let i = 0; i < text.length; i += maxLen) {
        const chunk = text.substring(i, i + maxLen);
        this.send(`PRIVMSG ${target} :${chunk}`);
      }

      // Add to local state
      const chanName = `${this.id}:${target}`;
      State.addMessage(chanName, this.nick, text, 'msg');
    }

    action(target, text) {
      this.send(`PRIVMSG ${target} :\x01ACTION ${text}\x01`);
      State.addMessage(`${this.id}:${target}`, this.nick, text, 'action');
    }

    quit(reason = 'Goodbye') {
      this.send(`QUIT :${reason}`);
      this.cleanup();
    }

    cleanup() {
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
      if (this.flushInterval) {
        clearInterval(this.flushInterval);
        this.flushInterval = null;
      }
      if (this.ws) {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.close();
        this.ws = null;
      }
    }

    scheduleReconnect() {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.emit('reconnect_failed');
        return;
      }

      const delay = Math.min(
        this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
        60000
      );
      this.reconnectAttempts++;

      setTimeout(() => {
        if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
          this.connect().catch(err => {
            console.error('Reconnect failed:', err);
          });
        }
      }, delay);
    }

    // Event handling
    on(event, handler) {
      if (!this.handlers.has(event)) {
        this.handlers.set(event, new Set());
      }
      this.handlers.get(event).add(handler);
    }

    off(event, handler) {
      const handlers = this.handlers.get(event);
      if (handlers) handlers.delete(handler);
    }

    emit(event, data) {
      const handlers = this.handlers.get(event);
      if (handlers) handlers.forEach(h => h(data));
    }
  }

  return {
    // Create and track connection
    connect(id, server, nick, options) {
      if (connections.has(id)) {
        connections.get(id).cleanup();
      }

      const conn = new Connection(id, server, nick, options);
      connections.set(id, conn);
      return conn.connect();
    },

    // Get connection by ID
    get(id) {
      return connections.get(id);
    },

    // Disconnect
    disconnect(id) {
      const conn = connections.get(id);
      if (conn) {
        conn.quit();
        connections.delete(id);
        State.removeConnection(id);
      }
    },

    // Bandwidth stats
    getBandwidth() {
      const now = Date.now();
      const elapsed = (now - lastBandwidthReset) / 1000;
      const inRate = bytesIn / elapsed;
      const outRate = bytesOut / elapsed;

      // Reset periodically
      if (elapsed > 10) {
        bytesIn = bytesOut = 0;
        lastBandwidthReset = now;
      }

      return {
        inRate: Math.round(inRate),
        outRate: Math.round(outRate),
        totalIn: bytesIn,
        totalOut: bytesOut
      };
    },

    // Cleanup all connections
    cleanup() {
      connections.forEach(conn => conn.cleanup());
      connections.clear();
    }
  };
})();

// Export for SW
if (typeof self !== 'undefined' && self.registration) {
  self.IRC = IRC;
}
