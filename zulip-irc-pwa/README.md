# ZulipIRC - Low Bandwidth Zulip Client

A minimalist, memory-efficient Progressive Web App for communicating via Zulip in low bandwidth environments. Optimized for iOS Safari with Service Worker support.

## Features

- **Offline-First**: Messages queue automatically when offline and sync when connection returns
- **Low Bandwidth Optimized**: Minimal data transfer, efficient caching, request deduplication
- **Memory Efficient**: Bounded data structures prevent memory leaks during long sessions
- **iOS Optimized**: Works as installed PWA with iOS-specific keyboard and viewport handling
- **Dark Theme**: OLED-friendly dark theme for battery efficiency

## Quick Start

```bash
# Start development server
node serve.js

# Open http://localhost:8080
# For memory tests: http://localhost:8080/tests/
```

## Architecture

### Core Components

1. **memory-monitor.js** - Memory tracking and leak prevention
   - Bounded arrays/maps with automatic eviction
   - Memory sampling and leak detection
   - GC hints for iOS Safari

2. **message-store.js** - IndexedDB persistence layer
   - Offline message storage
   - Message queue for pending sends
   - Automatic cleanup of old data

3. **zulip-client.js** - Zulip API client
   - Exponential backoff retry logic
   - Long-polling with reconnection
   - Request deduplication

4. **app.js** - Main application logic
   - UI event handling
   - Module coordination
   - Session management

5. **sw.js** - Service Worker
   - Cache-first for static assets
   - Network-first for API with fallback
   - Background sync support

## Memory Management Strategy

The app is designed for long-running sessions on memory-constrained iOS devices:

### Bounded Collections
```javascript
// Arrays that auto-evict oldest items
const messages = MemoryMonitor.createBoundedArray(100);

// Maps that evict LRU entries
const cache = MemoryMonitor.createBoundedMap(50);
```

### Automatic Cleanup
- Messages older than 7 days are purged
- DOM elements are removed when messages evicted from display list
- IndexedDB cache limited to 100 items in memory

### Leak Detection
```javascript
// Monitors memory growth patterns
MemoryMonitor.addListener((type, data) => {
  if (type === 'leak') {
    console.warn('Potential leak:', data);
  }
});
```

## Running Memory Tests

Open the test page in your browser:
```
http://localhost:8080/tests/
```

Or run tests programmatically:
```javascript
// Run all tests
const results = await MemoryTest.run();

// Run stress test (60 seconds)
await MemoryTest.stressTest(60000);

// Generate memory report
MemoryTest.generateReport();
```

## Configuration

### Zulip Connection
Enter your Zulip server details in the sidebar:
- **Server URL**: `your-org.zulipchat.com`
- **Email**: Your Zulip email
- **API Key**: Generate at Settings > Your bots > API Key

### Limits (adjustable in code)

```javascript
// MessageStore limits
MAX_MESSAGES_IN_MEMORY: 100,
MAX_MESSAGES_PER_STREAM: 500,
MAX_QUEUE_SIZE: 50,
MAX_MESSAGE_AGE_DAYS: 7

// ZulipClient limits
TIMEOUT: 30000,
MAX_RETRIES: 3,
BATCH_SIZE: 50
```

## iOS Installation

1. Open the app URL in Safari
2. Tap the Share button
3. Select "Add to Home Screen"
4. Name it and tap Add

The app will now work offline and behave like a native app.

## Offline Behavior

When offline:
- Previously loaded messages remain visible
- New messages queue automatically
- Status indicator shows "queued" state
- Messages sync when connection returns

## File Structure

```
zulip-irc-pwa/
├── index.html          # Main HTML shell
├── manifest.json       # PWA manifest
├── sw.js               # Service Worker
├── serve.js            # Development server
├── css/
│   └── style.css       # Minimal dark theme
├── js/
│   ├── memory-monitor.js   # Memory management
│   ├── message-store.js    # IndexedDB storage
│   ├── zulip-client.js     # Zulip API client
│   └── app.js              # Main application
└── tests/
    ├── index.html          # Test runner UI
    └── memory-test.js      # Memory leak tests
```

## Error Handling

All errors are handled gracefully:
- Network failures trigger automatic retry with backoff
- API errors show user-friendly toast notifications
- Queue failures are persisted for retry
- Service Worker falls back to cache on network failure

## Browser Support

- iOS Safari 14+
- Chrome 80+
- Firefox 75+
- Edge 80+

Note: Full Service Worker + IndexedDB support required.

## License

MIT
