// Service Worker for IRC app
// Handles offline caching, background sync, and message buffering

const CACHE_NAME = 'irc-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/state.js',
  '/irc.js',
  '/app.js',
  '/manifest.json'
];

// State persistence key
const STATE_KEY = 'irc-state';
const PENDING_KEY = 'irc-pending';

// Install - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate - clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  // Skip non-GET and WebSocket
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('ws://') || event.request.url.includes('wss://')) return;

  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        // Cache-first for static assets
        if (cached) {
          // Revalidate in background for HTML/JS
          if (event.request.url.endsWith('.html') || event.request.url.endsWith('.js')) {
            fetch(event.request)
              .then(response => {
                if (response.ok) {
                  caches.open(CACHE_NAME)
                    .then(cache => cache.put(event.request, response));
                }
              })
              .catch(() => {});
          }
          return cached;
        }

        // Network with timeout for other requests
        return fetchWithTimeout(event.request, 10000)
          .then(response => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME)
                .then(cache => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => {
            // Return offline page for navigation
            if (event.request.mode === 'navigate') {
              return caches.match('/index.html');
            }
            return new Response('Offline', { status: 503 });
          });
      })
  );
});

// Fetch with timeout
function fetchWithTimeout(request, timeout) {
  return Promise.race([
    fetch(request),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeout)
    )
  ]);
}

// Handle messages from main thread
self.addEventListener('message', (event) => {
  const { type, data } = event.data;

  switch (type) {
    case 'SAVE_STATE':
      saveState(data);
      break;

    case 'GET_STATE':
      getState().then(state => {
        event.source.postMessage({ type: 'STATE', data: state });
      });
      break;

    case 'QUEUE_MESSAGE':
      queuePendingMessage(data);
      break;

    case 'GET_PENDING':
      getPendingMessages().then(messages => {
        event.source.postMessage({ type: 'PENDING_MESSAGES', data: messages });
      });
      break;

    case 'CLEAR_PENDING':
      clearPendingMessages();
      break;

    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
  }
});

// State persistence using IndexedDB
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('irc-db', 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('state')) {
        db.createObjectStore('state');
      }
      if (!db.objectStoreNames.contains('pending')) {
        db.createObjectStore('pending', { autoIncrement: true });
      }
    };
  });

  return dbPromise;
}

async function saveState(state) {
  try {
    const db = await openDB();
    const tx = db.transaction('state', 'readwrite');
    tx.objectStore('state').put(state, STATE_KEY);
    await tx.complete;
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}

async function getState() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readonly');
      const request = tx.objectStore('state').get(STATE_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Failed to get state:', err);
    return null;
  }
}

async function queuePendingMessage(message) {
  try {
    const db = await openDB();
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').add(message);
    await tx.complete;

    // Register for background sync if available
    if (self.registration.sync) {
      self.registration.sync.register('send-messages');
    }
  } catch (err) {
    console.error('Failed to queue message:', err);
  }
}

async function getPendingMessages() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pending', 'readonly');
      const request = tx.objectStore('pending').getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Failed to get pending messages:', err);
    return [];
  }
}

async function clearPendingMessages() {
  try {
    const db = await openDB();
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').clear();
    await tx.complete;
  } catch (err) {
    console.error('Failed to clear pending messages:', err);
  }
}

// Background sync for pending messages
self.addEventListener('sync', (event) => {
  if (event.tag === 'send-messages') {
    event.waitUntil(syncPendingMessages());
  }
});

async function syncPendingMessages() {
  const messages = await getPendingMessages();
  if (messages.length === 0) return;

  // Notify clients to send messages
  const clients = await self.clients.matchAll();
  clients.forEach(client => {
    client.postMessage({
      type: 'SYNC_PENDING',
      data: messages
    });
  });
}

// Push notifications for mentions
self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body: data.text,
    icon: '/icon-192.png',
    badge: '/icon-72.png',
    tag: data.channel,
    renotify: true,
    data: {
      channel: data.channel,
      connection: data.connection
    }
  };

  event.waitUntil(
    self.registration.showNotification(`${data.nick} in ${data.channel}`, options)
  );
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // Focus existing window or open new
        for (const client of clients) {
          if (client.url.includes('/index.html') && 'focus' in client) {
            client.postMessage({
              type: 'FOCUS_CHANNEL',
              data: event.notification.data
            });
            return client.focus();
          }
        }
        return self.clients.openWindow('/');
      })
  );
});

// Periodic sync for connection keepalive (if supported)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'keepalive') {
    event.waitUntil(keepConnectionAlive());
  }
});

async function keepConnectionAlive() {
  const clients = await self.clients.matchAll();
  clients.forEach(client => {
    client.postMessage({ type: 'KEEPALIVE' });
  });
}

console.log('Service Worker loaded');
