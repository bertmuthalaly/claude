/**
 * Message Store - IndexedDB backed storage with memory-efficient caching
 *
 * Design principles:
 * 1. IndexedDB as source of truth
 * 2. Small in-memory cache with bounded size
 * 3. Lazy loading of messages
 * 4. Automatic cleanup of old data
 */

'use strict';

const MessageStore = (() => {
    const DB_NAME = 'zulip-irc';
    const DB_VERSION = 1;
    const STORES = {
        MESSAGES: 'messages',
        QUEUE: 'queue',
        CONFIG: 'config',
        STREAMS: 'streams'
    };

    // Configuration
    const CONFIG = {
        MAX_MESSAGES_IN_MEMORY: 100,    // Keep only 100 messages in RAM
        MAX_MESSAGES_PER_STREAM: 500,   // Keep 500 messages per stream in DB
        MAX_QUEUE_SIZE: 50,              // Max 50 queued messages
        CLEANUP_INTERVAL: 300000,        // Cleanup every 5 minutes
        MAX_MESSAGE_AGE_DAYS: 7          // Delete messages older than 7 days
    };

    // State
    let db = null;
    let isInitialized = false;
    let cleanupInterval = null;

    // In-memory cache using bounded structures
    let messageCache = null;
    let streamCache = null;

    /**
     * Initialize the database
     */
    async function init() {
        if (isInitialized) return;

        try {
            db = await openDatabase();
            isInitialized = true;

            // Initialize bounded caches
            messageCache = MemoryMonitor.createBoundedMap(
                CONFIG.MAX_MESSAGES_IN_MEMORY,
                (key, value) => {
                    // Message evicted from cache - no action needed, it's in IndexedDB
                }
            );

            streamCache = MemoryMonitor.createBoundedMap(50);

            // Start periodic cleanup
            cleanupInterval = setInterval(cleanup, CONFIG.CLEANUP_INTERVAL);

            console.log('[MessageStore] Initialized');
        } catch (error) {
            console.error('[MessageStore] Init failed:', error);
            throw error;
        }
    }

    /**
     * Open IndexedDB database
     */
    function openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => {
                reject(new Error(`IndexedDB error: ${request.error?.message || 'Unknown'}`));
            };

            request.onsuccess = () => {
                resolve(request.result);
            };

            request.onupgradeneeded = (event) => {
                const database = event.target.result;

                // Messages store
                if (!database.objectStoreNames.contains(STORES.MESSAGES)) {
                    const msgStore = database.createObjectStore(STORES.MESSAGES, { keyPath: 'id' });
                    msgStore.createIndex('streamTopic', ['stream_id', 'topic'], { unique: false });
                    msgStore.createIndex('timestamp', 'timestamp', { unique: false });
                }

                // Queue store for offline messages
                if (!database.objectStoreNames.contains(STORES.QUEUE)) {
                    const queueStore = database.createObjectStore(STORES.QUEUE, {
                        keyPath: 'queueId',
                        autoIncrement: true
                    });
                    queueStore.createIndex('status', 'status', { unique: false });
                }

                // Config store
                if (!database.objectStoreNames.contains(STORES.CONFIG)) {
                    database.createObjectStore(STORES.CONFIG, { keyPath: 'key' });
                }

                // Streams store
                if (!database.objectStoreNames.contains(STORES.STREAMS)) {
                    database.createObjectStore(STORES.STREAMS, { keyPath: 'stream_id' });
                }
            };
        });
    }

    /**
     * Execute a transaction
     */
    function transaction(storeNames, mode = 'readonly') {
        if (!db) throw new Error('Database not initialized');

        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        return db.transaction(names, mode);
    }

    /**
     * Get object store
     */
    function getStore(storeName, mode = 'readonly') {
        return transaction(storeName, mode).objectStore(storeName);
    }

    /**
     * Promisify IDB request
     */
    function promisify(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Save a message
     */
    async function saveMessage(message) {
        if (!isInitialized) await init();

        const normalizedMsg = {
            id: message.id,
            stream_id: message.stream_id || 0,
            topic: message.subject || message.topic || '',
            sender: message.sender_full_name || message.sender || 'Unknown',
            sender_id: message.sender_id,
            content: message.content || '',
            timestamp: message.timestamp || Date.now(),
            type: message.type || 'stream'
        };

        try {
            const store = getStore(STORES.MESSAGES, 'readwrite');
            await promisify(store.put(normalizedMsg));

            // Update cache
            messageCache.set(normalizedMsg.id, normalizedMsg);

            return normalizedMsg;
        } catch (error) {
            console.error('[MessageStore] Save failed:', error);
            throw error;
        }
    }

    /**
     * Save multiple messages efficiently
     */
    async function saveMessages(messages) {
        if (!isInitialized) await init();
        if (!messages.length) return;

        const tx = transaction(STORES.MESSAGES, 'readwrite');
        const store = tx.objectStore(STORES.MESSAGES);

        const promises = messages.map(msg => {
            const normalizedMsg = {
                id: msg.id,
                stream_id: msg.stream_id || 0,
                topic: msg.subject || msg.topic || '',
                sender: msg.sender_full_name || msg.sender || 'Unknown',
                sender_id: msg.sender_id,
                content: msg.content || '',
                timestamp: msg.timestamp || Date.now(),
                type: msg.type || 'stream'
            };

            messageCache.set(normalizedMsg.id, normalizedMsg);
            return promisify(store.put(normalizedMsg));
        });

        await Promise.all(promises);
    }

    /**
     * Get a message by ID
     */
    async function getMessage(id) {
        if (!isInitialized) await init();

        // Check cache first
        if (messageCache.has(id)) {
            return messageCache.get(id);
        }

        try {
            const store = getStore(STORES.MESSAGES);
            const msg = await promisify(store.get(id));

            if (msg) {
                messageCache.set(id, msg);
            }

            return msg;
        } catch (error) {
            console.error('[MessageStore] Get failed:', error);
            return null;
        }
    }

    /**
     * Get messages for a stream/topic
     */
    async function getMessages(streamId, topic = null, limit = 50) {
        if (!isInitialized) await init();

        try {
            const store = getStore(STORES.MESSAGES);
            const index = store.index('streamTopic');

            const range = topic
                ? IDBKeyRange.only([streamId, topic])
                : IDBKeyRange.bound([streamId, ''], [streamId, '\uffff']);

            const messages = [];
            const request = index.openCursor(range, 'prev');

            return new Promise((resolve, reject) => {
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor && messages.length < limit) {
                        messages.push(cursor.value);
                        messageCache.set(cursor.value.id, cursor.value);
                        cursor.continue();
                    } else {
                        resolve(messages.reverse());
                    }
                };
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            console.error('[MessageStore] GetMessages failed:', error);
            return [];
        }
    }

    /**
     * Queue a message for sending (offline support)
     */
    async function queueMessage(message) {
        if (!isInitialized) await init();

        const queuedMsg = {
            ...message,
            status: 'pending',
            createdAt: Date.now(),
            attempts: 0
        };

        try {
            // Check queue size
            const queueSize = await getQueueSize();
            if (queueSize >= CONFIG.MAX_QUEUE_SIZE) {
                throw new Error('Message queue full');
            }

            const store = getStore(STORES.QUEUE, 'readwrite');
            const id = await promisify(store.add(queuedMsg));
            queuedMsg.queueId = id;

            return queuedMsg;
        } catch (error) {
            console.error('[MessageStore] Queue failed:', error);
            throw error;
        }
    }

    /**
     * Get all pending messages from queue
     */
    async function getPendingMessages() {
        if (!isInitialized) await init();

        try {
            const store = getStore(STORES.QUEUE);
            const index = store.index('status');
            const request = index.getAll(IDBKeyRange.only('pending'));
            return await promisify(request);
        } catch (error) {
            console.error('[MessageStore] GetPending failed:', error);
            return [];
        }
    }

    /**
     * Update queue item status
     */
    async function updateQueueItem(queueId, updates) {
        if (!isInitialized) await init();

        try {
            const store = getStore(STORES.QUEUE, 'readwrite');
            const item = await promisify(store.get(queueId));

            if (item) {
                Object.assign(item, updates);
                await promisify(store.put(item));
            }
        } catch (error) {
            console.error('[MessageStore] UpdateQueue failed:', error);
        }
    }

    /**
     * Remove item from queue
     */
    async function removeFromQueue(queueId) {
        if (!isInitialized) await init();

        try {
            const store = getStore(STORES.QUEUE, 'readwrite');
            await promisify(store.delete(queueId));
        } catch (error) {
            console.error('[MessageStore] RemoveQueue failed:', error);
        }
    }

    /**
     * Get queue size
     */
    async function getQueueSize() {
        if (!isInitialized) await init();

        try {
            const store = getStore(STORES.QUEUE);
            return await promisify(store.count());
        } catch (error) {
            return 0;
        }
    }

    /**
     * Save streams list
     */
    async function saveStreams(streams) {
        if (!isInitialized) await init();

        const tx = transaction(STORES.STREAMS, 'readwrite');
        const store = tx.objectStore(STORES.STREAMS);

        for (const stream of streams) {
            streamCache.set(stream.stream_id, stream);
            await promisify(store.put(stream));
        }
    }

    /**
     * Get streams list
     */
    async function getStreams() {
        if (!isInitialized) await init();

        try {
            const store = getStore(STORES.STREAMS);
            const streams = await promisify(store.getAll());
            streams.forEach(s => streamCache.set(s.stream_id, s));
            return streams;
        } catch (error) {
            console.error('[MessageStore] GetStreams failed:', error);
            return [];
        }
    }

    /**
     * Save config value
     */
    async function setConfig(key, value) {
        if (!isInitialized) await init();

        try {
            const store = getStore(STORES.CONFIG, 'readwrite');
            await promisify(store.put({ key, value }));
        } catch (error) {
            console.error('[MessageStore] SetConfig failed:', error);
        }
    }

    /**
     * Get config value
     */
    async function getConfig(key) {
        if (!isInitialized) await init();

        try {
            const store = getStore(STORES.CONFIG);
            const result = await promisify(store.get(key));
            return result?.value;
        } catch (error) {
            console.error('[MessageStore] GetConfig failed:', error);
            return null;
        }
    }

    /**
     * Cleanup old messages and failed queue items
     */
    async function cleanup() {
        if (!isInitialized) return;

        const cutoffTime = Date.now() - (CONFIG.MAX_MESSAGE_AGE_DAYS * 24 * 60 * 60 * 1000);

        try {
            // Clean old messages
            const msgStore = getStore(STORES.MESSAGES, 'readwrite');
            const msgIndex = msgStore.index('timestamp');
            const msgRange = IDBKeyRange.upperBound(cutoffTime);

            let deletedCount = 0;
            const msgRequest = msgIndex.openCursor(msgRange);

            await new Promise((resolve, reject) => {
                msgRequest.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        cursor.delete();
                        messageCache.delete(cursor.value.id);
                        deletedCount++;
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
                msgRequest.onerror = () => reject(msgRequest.error);
            });

            // Clean failed queue items (older than 1 hour)
            const queueCutoff = Date.now() - (60 * 60 * 1000);
            const queueStore = getStore(STORES.QUEUE, 'readwrite');
            const queueRequest = queueStore.openCursor();

            await new Promise((resolve, reject) => {
                queueRequest.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        const item = cursor.value;
                        if (item.status === 'failed' && item.createdAt < queueCutoff) {
                            cursor.delete();
                        }
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
                queueRequest.onerror = () => reject(queueRequest.error);
            });

            if (deletedCount > 0) {
                console.log(`[MessageStore] Cleaned ${deletedCount} old messages`);
            }
        } catch (error) {
            console.error('[MessageStore] Cleanup failed:', error);
        }
    }

    /**
     * Clear all data
     */
    async function clearAll() {
        if (!isInitialized) await init();

        try {
            const tx = transaction(Object.values(STORES), 'readwrite');

            for (const storeName of Object.values(STORES)) {
                tx.objectStore(storeName).clear();
            }

            messageCache.clear();
            streamCache.clear();

            console.log('[MessageStore] Cleared all data');
        } catch (error) {
            console.error('[MessageStore] Clear failed:', error);
        }
    }

    /**
     * Get storage stats
     */
    async function getStats() {
        if (!isInitialized) await init();

        try {
            const stats = {
                messages: await promisify(getStore(STORES.MESSAGES).count()),
                queue: await promisify(getStore(STORES.QUEUE).count()),
                streams: await promisify(getStore(STORES.STREAMS).count()),
                cacheSize: messageCache.size
            };

            // Estimate storage size if available
            if (navigator.storage && navigator.storage.estimate) {
                const estimate = await navigator.storage.estimate();
                stats.storageUsed = estimate.usage;
                stats.storageQuota = estimate.quota;
            }

            return stats;
        } catch (error) {
            console.error('[MessageStore] GetStats failed:', error);
            return {};
        }
    }

    /**
     * Dispose and cleanup
     */
    function dispose() {
        if (cleanupInterval) {
            clearInterval(cleanupInterval);
            cleanupInterval = null;
        }

        if (messageCache) {
            messageCache.dispose();
            messageCache = null;
        }

        if (streamCache) {
            streamCache.dispose();
            streamCache = null;
        }

        if (db) {
            db.close();
            db = null;
        }

        isInitialized = false;
        console.log('[MessageStore] Disposed');
    }

    // Public API
    return {
        init,
        saveMessage,
        saveMessages,
        getMessage,
        getMessages,
        queueMessage,
        getPendingMessages,
        updateQueueItem,
        removeFromQueue,
        getQueueSize,
        saveStreams,
        getStreams,
        setConfig,
        getConfig,
        cleanup,
        clearAll,
        getStats,
        dispose,
        CONFIG
    };
})();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MessageStore;
}
