// Main IRC App - ties together State, IRC, UI, and Service Worker
// Minimalist, memory-conscious implementation

const App = (() => {
  // DOM references (cached to avoid repeated queries)
  const $ = (sel) => document.querySelector(sel);
  const dom = {};

  // Current state
  let activeChannel = null;
  let activeConnection = null;

  // Settings
  const settings = {
    maxVisibleMessages: 100,
    bandwidthMode: 'low', // low, normal, high
    notifications: true
  };

  // Debounce helper
  const debounce = (fn, ms) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };

  // Throttle helper
  const throttle = (fn, ms) => {
    let last = 0;
    return (...args) => {
      const now = Date.now();
      if (now - last >= ms) {
        last = now;
        fn(...args);
      }
    };
  };

  // Virtual scrolling - only render visible messages
  const MessageRenderer = {
    pool: [],
    poolSize: 50,

    getElement() {
      return this.pool.pop() || document.createElement('div');
    },

    returnElement(el) {
      if (this.pool.length < this.poolSize) {
        el.textContent = '';
        el.className = 'msg';
        this.pool.push(el);
      }
    },

    render(messages, container) {
      // Clear existing
      while (container.firstChild) {
        this.returnElement(container.firstChild);
        container.removeChild(container.firstChild);
      }

      // Only render last N messages
      const visible = messages.slice(-settings.maxVisibleMessages);

      // Use document fragment for batch insert
      const frag = document.createDocumentFragment();

      for (const msg of visible) {
        const el = this.getElement();
        el.className = `msg ${msg['msg/type'] || 'msg'}`;

        const time = new Date(msg['msg/ts']).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        });

        if (msg['msg/type'] === 'system') {
          el.innerHTML = `<span class="time">${time}</span> ${escapeHtml(msg['msg/nick'])} ${escapeHtml(msg['msg/text'])}`;
        } else if (msg['msg/type'] === 'action') {
          el.innerHTML = `<span class="time">${time}</span> * <span class="nick">${escapeHtml(msg['msg/nick'])}</span> ${escapeHtml(msg['msg/text'])}`;
        } else {
          el.innerHTML = `<span class="time">${time}</span> <span class="nick">&lt;${escapeHtml(msg['msg/nick'])}&gt;</span> ${escapeHtml(msg['msg/text'])}`;
        }

        frag.appendChild(el);
      }

      container.appendChild(frag);

      // Scroll to bottom
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  };

  // HTML escape
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Channel list rendering
  function renderChannels() {
    const channels = State.getAllChannels();
    const frag = document.createDocumentFragment();

    for (const ch of channels) {
      const el = document.createElement('div');
      el.className = `channel-item${ch['chan/name'] === activeChannel ? ' active' : ''}`;
      el.dataset.channel = ch['chan/name'];

      const name = document.createElement('span');
      name.textContent = ch['chan/display'] || ch['chan/name'];
      el.appendChild(name);

      if (ch['chan/unread'] > 0) {
        const badge = document.createElement('span');
        badge.className = 'unread';
        badge.textContent = ch['chan/unread'] > 99 ? '99+' : ch['chan/unread'];
        el.appendChild(badge);
      }

      el.addEventListener('click', () => selectChannel(ch['chan/name']));
      frag.appendChild(el);
    }

    dom.channels.textContent = '';
    dom.channels.appendChild(frag);
  }

  // Select channel
  function selectChannel(chanName) {
    activeChannel = chanName;

    // Update header
    const display = chanName ? chanName.split(':')[1] : 'Not connected';
    dom.channelHeader.textContent = display;
    dom.channelDesktop.textContent = display;

    // Clear unread
    if (chanName) {
      State.updateUnread(chanName, 0);
    }

    // Render messages
    const messages = chanName ? State.getMessages(chanName) : [];
    MessageRenderer.render(messages, dom.messages);

    // Update channel list
    renderChannels();

    // Close sidebar on mobile
    dom.sidebar.classList.remove('open');
    dom.overlay.classList.remove('show');
  }

  // Update connection status indicator
  function updateStatus(status) {
    dom.status.className = status;
  }

  // Update bandwidth display
  const updateBandwidth = throttle(() => {
    const bw = IRC.getBandwidth();
    dom.bandwidth.textContent = `↓${formatBytes(bw.inRate)}/s ↑${formatBytes(bw.outRate)}/s`;
  }, 1000);

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + 'B';
    return (bytes / 1024).toFixed(1) + 'K';
  }

  // Send message
  function sendMessage() {
    const text = dom.input.value.trim();
    if (!text || !activeChannel || !activeConnection) return;

    const conn = IRC.get(activeConnection);
    if (!conn) return;

    const target = activeChannel.split(':')[1];

    // Handle commands
    if (text.startsWith('/')) {
      const [cmd, ...args] = text.slice(1).split(' ');
      switch (cmd.toLowerCase()) {
        case 'me':
          conn.action(target, args.join(' '));
          break;
        case 'join':
          conn.join(args[0]);
          break;
        case 'part':
          conn.part(target, args.join(' '));
          break;
        case 'nick':
          conn.send(`NICK ${args[0]}`);
          break;
        case 'quit':
          conn.quit(args.join(' ') || 'Goodbye');
          break;
        case 'msg':
          conn.say(args[0], args.slice(1).join(' '));
          break;
        default:
          // Raw command
          conn.send(text.slice(1));
      }
    } else {
      conn.say(target, text);
    }

    dom.input.value = '';
    resizeInput();
  }

  // Auto-resize input
  function resizeInput() {
    dom.input.style.height = 'auto';
    dom.input.style.height = Math.min(dom.input.scrollHeight, 100) + 'px';
  }

  // Service Worker communication
  let swRegistration = null;

  async function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    try {
      swRegistration = await navigator.serviceWorker.register('/sw.js');

      // Listen for messages
      navigator.serviceWorker.addEventListener('message', (event) => {
        const { type, data } = event.data;

        switch (type) {
          case 'STATE':
            if (data) State.deserialize(data);
            break;

          case 'SYNC_PENDING':
            // Send pending messages
            for (const msg of data) {
              const conn = IRC.get(msg.connection);
              if (conn) conn.say(msg.channel, msg.text);
            }
            navigator.serviceWorker.controller?.postMessage({ type: 'CLEAR_PENDING' });
            break;

          case 'FOCUS_CHANNEL':
            selectChannel(`${data.connection}:${data.channel}`);
            break;

          case 'KEEPALIVE':
            // Ping connections
            break;
        }
      });

      // Request state from SW
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'GET_STATE' });
      }

      console.log('Service Worker registered');
    } catch (err) {
      console.error('SW registration failed:', err);
    }
  }

  // Save state periodically
  const saveState = debounce(() => {
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'SAVE_STATE',
        data: State.serialize()
      });
    }
  }, 5000);

  // Connection handling
  async function connect(server, nick, channel) {
    const id = `${server}-${Date.now()}`;
    activeConnection = id;

    try {
      const conn = await IRC.connect(id, server, nick, {
        bandwidth: settings.bandwidthMode === 'low' ? 300 : 1000
      });

      conn.on('registered', () => {
        if (channel) conn.join(channel);
        updateStatus('connected');
      });

      conn.on('message', (data) => {
        // Update unread for non-active channels
        const chanName = `${id}:${data.channel}`;
        if (chanName !== activeChannel) {
          const channels = State.getAllChannels();
          const ch = channels.find(c => c['chan/name'] === chanName);
          if (ch) {
            State.updateUnread(chanName, (ch['chan/unread'] || 0) + 1);
          }

          // Notification for mentions
          if (settings.notifications && data.text.toLowerCase().includes(nick.toLowerCase())) {
            showNotification(data.channel, data.nick, data.text);
          }
        }

        // Re-render if active channel
        if (chanName === activeChannel) {
          const messages = State.getMessages(activeChannel);
          MessageRenderer.render(messages, dom.messages);
        }

        renderChannels();
        saveState();
      });

      conn.on('join', (data) => {
        if (data.nick === nick) {
          selectChannel(`${id}:${data.channel}`);
        }
        renderChannels();
      });

      updateStatus('connected');
    } catch (err) {
      console.error('Connection failed:', err);
      updateStatus('');
      alert('Connection failed. Make sure the server supports WebSocket connections.');
    }
  }

  // Notifications
  async function showNotification(channel, nick, text) {
    if (!('Notification' in window)) return;

    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }

    if (Notification.permission === 'granted') {
      new Notification(`${nick} in ${channel}`, {
        body: text.slice(0, 100),
        tag: channel,
        renotify: true
      });
    }
  }

  // State subscription
  function onStateChange(db) {
    // Update bandwidth display
    updateBandwidth();

    // Get connection status
    const connections = State.q('[:find [(pull ?e [*]) ...] :where [?e :conn/id]]', db) || [];
    if (connections.length > 0) {
      const status = connections[0]['conn/status'];
      updateStatus(status);
    }
  }

  // Initialize
  function init() {
    // Cache DOM elements
    dom.sidebar = $('#sidebar');
    dom.overlay = $('#overlay');
    dom.channels = $('#channels');
    dom.messages = $('#messages');
    dom.input = $('#input');
    dom.status = $('#status');
    dom.channelHeader = $('#channel');
    dom.channelDesktop = $('#channel-desktop');
    dom.bandwidth = $('#bandwidth');

    // Menu toggle
    $('#menu-btn').addEventListener('click', () => {
      dom.sidebar.classList.toggle('open');
      dom.overlay.classList.toggle('show');
    });

    dom.overlay.addEventListener('click', () => {
      dom.sidebar.classList.remove('open');
      dom.overlay.classList.remove('show');
    });

    // Send message
    $('#send').addEventListener('click', sendMessage);
    dom.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    dom.input.addEventListener('input', resizeInput);

    // Connect form
    $('#connect-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const server = $('#server').value.trim();
      const nick = $('#nick').value.trim();
      const channel = $('#join-channel').value.trim();

      if (server && nick) {
        connect(server, nick, channel);
      }
    });

    // Subscribe to state changes
    State.subscribe(onStateChange);

    // Init service worker
    initServiceWorker();

    // Bandwidth update interval
    setInterval(updateBandwidth, 1000);

    // Memory stats (debug)
    if (location.search.includes('debug')) {
      setInterval(() => {
        console.log('State:', State.getStats());
        if (performance.memory) {
          console.log('Memory:', {
            used: (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(2) + 'MB',
            total: (performance.memory.totalJSHeapSize / 1024 / 1024).toFixed(2) + 'MB'
          });
        }
      }, 5000);
    }

    // Handle visibility change - save state when hidden
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        saveState();
      }
    });

    // Handle beforeunload - cleanup
    window.addEventListener('beforeunload', () => {
      IRC.cleanup();
    });

    console.log('IRC App initialized');
  }

  // Public API
  return {
    init,
    connect,
    selectChannel,
    getState: () => State,
    getIRC: () => IRC
  };
})();

// Start app when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', App.init);
} else {
  App.init();
}
