/**
 * Service Worker - Offline support and background sync
 *
 * Strategies:
 * 1. Cache-first for static assets
 * 2. Network-first for API calls with offline fallback
 * 3. Background sync for queued messages
 * 4. Minimal cache size for low storage devices
 */

'use strict';

const CACHE_NAME = 'zulip-irc-v1';
const STATIC_CACHE = 'zulip-irc-static-v1';

// Static assets to cache
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/css/style.css',
    '/js/memory-monitor.js',
    '/js/message-store.js',
    '/js/zulip-client.js',
    '/js/app.js'
];

// Cache size limits
const MAX_CACHE_SIZE = 50;
const MAX_CACHE_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Install event - cache static assets
 */
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => {
                console.log('[SW] Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => self.skipWaiting())
            .catch((error) => {
                console.error('[SW] Install failed:', error);
            })
    );
});

/**
 * Activate event - clean old caches
 */
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => name !== CACHE_NAME && name !== STATIC_CACHE)
                        .map((name) => {
                            console.log('[SW] Deleting old cache:', name);
                            return caches.delete(name);
                        })
                );
            })
            .then(() => self.clients.claim())
    );
});

/**
 * Fetch event - handle requests
 */
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    // Skip chrome-extension and other non-http(s) requests
    if (!url.protocol.startsWith('http')) {
        return;
    }

    // API requests - network first with timeout
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkFirstWithTimeout(event.request, 10000));
        return;
    }

    // Static assets - cache first
    if (isStaticAsset(url.pathname)) {
        event.respondWith(cacheFirst(event.request));
        return;
    }

    // Default - network first
    event.respondWith(networkFirst(event.request));
});

/**
 * Cache-first strategy
 */
async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) {
        return cached;
    }

    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        // Return offline fallback if available
        return caches.match('/index.html');
    }
}

/**
 * Network-first strategy
 */
async function networkFirst(request) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
            await trimCache(CACHE_NAME, MAX_CACHE_SIZE);
        }
        return response;
    } catch (error) {
        const cached = await caches.match(request);
        if (cached) {
            return cached;
        }
        throw error;
    }
}

/**
 * Network-first with timeout
 */
async function networkFirstWithTimeout(request, timeout) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(request, { signal: controller.signal });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);

        // Try cache
        const cached = await caches.match(request);
        if (cached) {
            return cached;
        }

        // Return error response
        return new Response(JSON.stringify({ error: 'Offline' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * Check if URL is a static asset
 */
function isStaticAsset(pathname) {
    return pathname === '/' ||
           pathname.endsWith('.html') ||
           pathname.endsWith('.css') ||
           pathname.endsWith('.js') ||
           pathname.endsWith('.json') ||
           pathname.endsWith('.png') ||
           pathname.endsWith('.ico');
}

/**
 * Trim cache to max size
 */
async function trimCache(cacheName, maxSize) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();

    if (keys.length > maxSize) {
        // Delete oldest entries
        const toDelete = keys.slice(0, keys.length - maxSize);
        await Promise.all(toDelete.map((key) => cache.delete(key)));
    }
}

/**
 * Background sync - process message queue
 */
self.addEventListener('sync', (event) => {
    if (event.tag === 'send-messages') {
        event.waitUntil(processMessageQueue());
    }
});

/**
 * Process queued messages
 */
async function processMessageQueue() {
    // Notify clients to process queue
    const clients = await self.clients.matchAll();
    clients.forEach((client) => {
        client.postMessage({
            type: 'QUEUE_SYNC'
        });
    });
}

/**
 * Push notification handling (if enabled)
 */
self.addEventListener('push', (event) => {
    if (!event.data) return;

    try {
        const data = event.data.json();

        const options = {
            body: data.content || 'New message',
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            tag: data.id || 'zulip-message',
            renotify: true,
            data: {
                streamId: data.stream_id,
                topic: data.topic
            }
        };

        event.waitUntil(
            self.registration.showNotification(data.sender || 'ZulipIRC', options)
        );
    } catch (error) {
        console.error('[SW] Push handling failed:', error);
    }
});

/**
 * Notification click handling
 */
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clientList) => {
                // Focus existing window or open new one
                for (const client of clientList) {
                    if ('focus' in client) {
                        return client.focus();
                    }
                }

                if (self.clients.openWindow) {
                    return self.clients.openWindow('/');
                }
            })
    );
});

/**
 * Periodic background sync (if supported)
 */
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'check-messages') {
        event.waitUntil(checkNewMessages());
    }
});

/**
 * Check for new messages in background
 */
async function checkNewMessages() {
    // Notify clients to check messages
    const clients = await self.clients.matchAll();
    clients.forEach((client) => {
        client.postMessage({
            type: 'BACKGROUND_SYNC'
        });
    });
}

/**
 * Message handler for client communication
 */
self.addEventListener('message', (event) => {
    const { type, data } = event.data || {};

    switch (type) {
        case 'SKIP_WAITING':
            self.skipWaiting();
            break;

        case 'GET_CACHE_STATUS':
            getCacheStatus().then((status) => {
                event.ports[0].postMessage(status);
            });
            break;

        case 'CLEAR_CACHE':
            caches.delete(CACHE_NAME).then(() => {
                event.ports[0].postMessage({ success: true });
            });
            break;
    }
});

/**
 * Get cache status
 */
async function getCacheStatus() {
    const cacheNames = await caches.keys();
    const status = {
        caches: [],
        totalSize: 0
    };

    for (const name of cacheNames) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        status.caches.push({
            name,
            entries: keys.length
        });
    }

    return status;
}

console.log('[SW] Service Worker loaded');
