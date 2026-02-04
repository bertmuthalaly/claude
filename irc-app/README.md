# IRC Lite

A lightweight IRC client designed for low bandwidth connections. Uses Service Workers for offline support and DataScript for memory-efficient state management.

## Features

- **Low Bandwidth**: Optimized for airplane wifi, international roaming, and slow connections
- **Service Worker**: Works offline, caches messages, syncs when reconnected
- **Memory Efficient**: Uses DataScript with automatic message pruning to prevent memory leaks
- **Mobile Ready**: Responsive design works on iPhone 16 Pro and other mobile devices
- **PWA**: Install as an app on iOS/Android/Desktop
- **Minimalist**: Single-purpose, no bloat

## Quick Start

```bash
# Install dependencies
npm install

# Start server (requires HTTPS for Service Workers)
npm run serve

# Or with HTTPS (generate certs first)
npm run serve:https
```

Open `http://localhost:3000` in your browser.

## Using with Zulip IRC Bridge

To connect to Zulip via IRC:

1. In Zulip, go to **Settings > Personal settings > Account & privacy**
2. Look for **IRC/XMPP integration**
3. Note your IRC server address and credentials
4. In IRC Lite:
   - Server: Your Zulip IRC gateway (e.g., `irc.zulipchat.com:6697`)
   - Nick: Your Zulip username
   - Channel: The stream name prefixed with `#` (e.g., `#general`)

## Keyboard Shortcuts

- `Enter` - Send message
- `Shift+Enter` - New line

## Commands

- `/me <action>` - Send action message
- `/join <channel>` - Join channel
- `/part [message]` - Leave current channel
- `/nick <newnick>` - Change nickname
- `/msg <user> <message>` - Private message
- `/quit [message]` - Disconnect

## Architecture

```
index.html    - Single-page app shell with embedded CSS
state.js      - DataScript-based state management
network.js    - Network resilience utilities
irc.js        - IRC protocol over WebSocket
app.js        - UI and app logic
sw.js         - Service Worker for offline support
```

### State Management

Uses DataScript (Datomic-like database in JS) for:
- Immutable state updates
- Efficient querying
- Automatic message pruning (max 500/channel)
- Serialization for Service Worker sync

### Memory Management

- Message pool for DOM element reuse
- Automatic old message pruning
- Subscription cleanup on unmount
- No closure leaks in event handlers

### Network Resilience

- Automatic reconnection with exponential backoff
- Message queue for offline sending
- Bandwidth detection and adaptation
- Ping/pong keep-alive

## Testing

### Unit Tests

```bash
npm test
```

### Memory Leak Tests

Open `tests/memory-test.html` in Chrome with flags:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --enable-precise-memory-info \
  --expose-gc \
  file:///path/to/irc-app/tests/memory-test.html

# Linux
google-chrome \
  --enable-precise-memory-info \
  --expose-gc \
  file:///path/to/irc-app/tests/memory-test.html
```

### Test Scenarios

1. **Message Churn**: Add 10,000 messages, verify pruning to 500
2. **Channel Churn**: Create/destroy 100 channels with messages
3. **Subscription Leak**: Subscribe/unsubscribe 1,000 times
4. **DOM Leak**: Render messages 100 times
5. **Long Running**: 30-second simulation of normal usage

## Browser Requirements

- Chrome/Safari/Firefox with WebSocket support
- Service Workers (requires HTTPS in production)
- IndexedDB for state persistence

## WebSocket IRC Notes

Most IRC networks don't support direct WebSocket connections. Options:

1. **Direct WebSocket**: Some modern IRC servers support it (libera.chat, etc.)
2. **IRC WebSocket Gateway**: Use a gateway like `webirc` or `KiwiIRC`
3. **Self-hosted Gateway**: Run `websockify` or similar

Example with websockify:
```bash
websockify 6698 irc.libera.chat:6667
# Then connect to ws://localhost:6698
```

## License

MIT
