/**
 * Zulip API Client - Low bandwidth optimized
 *
 * Features:
 * 1. Request retry with exponential backoff
 * 2. Request deduplication
 * 3. Response compression support
 * 4. Offline queue integration
 * 5. Long-polling with automatic reconnection
 */

'use strict';

const ZulipClient = (() => {
    // Configuration
    const CONFIG = {
        TIMEOUT: 30000,              // 30s timeout
        MAX_RETRIES: 3,              // Retry 3 times
        RETRY_BASE_DELAY: 1000,      // 1s base delay
        RETRY_MAX_DELAY: 30000,      // 30s max delay
        POLL_TIMEOUT: 90000,         // 90s long poll
        RECONNECT_DELAY: 5000,       // 5s reconnect delay
        BATCH_SIZE: 50,              // Fetch 50 messages at a time
        HEARTBEAT_INTERVAL: 60000,   // Heartbeat every 60s
    };

    // State
    let serverUrl = '';
    let email = '';
    let apiKey = '';
    let isConnected = false;
    let queueId = null;
    let lastEventId = -1;
    let pollController = null;
    let heartbeatInterval = null;
    let listeners = new Set();
    let pendingRequests = new Map();

    /**
     * Initialize the client
     */
    function init(config) {
        serverUrl = config.serverUrl?.replace(/\/$/, '') || '';
        email = config.email || '';
        apiKey = config.apiKey || '';

        if (!serverUrl || !email || !apiKey) {
            throw new Error('Missing required configuration');
        }
    }

    /**
     * Make an authenticated API request with retry logic
     */
    async function request(endpoint, options = {}) {
        const url = `${serverUrl}/api/v1${endpoint}`;
        const method = options.method || 'GET';
        const body = options.body;

        // Create request key for deduplication
        const requestKey = `${method}:${endpoint}:${JSON.stringify(body || '')}`;

        // Check for duplicate in-flight request
        if (pendingRequests.has(requestKey)) {
            return pendingRequests.get(requestKey);
        }

        const headers = {
            'Authorization': `Basic ${btoa(`${email}:${apiKey}`)}`,
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip, deflate',
        };

        if (body && !(body instanceof FormData)) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        const requestPromise = executeWithRetry(async (attempt) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), options.timeout || CONFIG.TIMEOUT);

            try {
                const response = await fetch(url, {
                    method,
                    headers,
                    body: body instanceof FormData ? body : body,
                    signal: controller.signal,
                    credentials: 'omit',
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    const error = new Error(`HTTP ${response.status}`);
                    error.status = response.status;
                    error.retryable = response.status >= 500 || response.status === 429;

                    if (response.status === 429) {
                        // Rate limited - get retry-after
                        const retryAfter = response.headers.get('Retry-After');
                        error.retryAfter = retryAfter ? parseInt(retryAfter, 10) * 1000 : CONFIG.RETRY_BASE_DELAY * Math.pow(2, attempt);
                    }

                    throw error;
                }

                return await response.json();
            } catch (error) {
                clearTimeout(timeoutId);

                if (error.name === 'AbortError') {
                    const timeoutError = new Error('Request timeout');
                    timeoutError.retryable = true;
                    throw timeoutError;
                }

                if (error instanceof TypeError) {
                    // Network error
                    error.retryable = true;
                }

                throw error;
            }
        });

        pendingRequests.set(requestKey, requestPromise);

        try {
            const result = await requestPromise;
            return result;
        } finally {
            pendingRequests.delete(requestKey);
        }
    }

    /**
     * Execute a function with retry logic
     */
    async function executeWithRetry(fn, maxRetries = CONFIG.MAX_RETRIES) {
        let lastError;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await fn(attempt);
            } catch (error) {
                lastError = error;

                if (!error.retryable || attempt === maxRetries) {
                    throw error;
                }

                // Calculate delay with exponential backoff and jitter
                let delay = error.retryAfter ||
                    Math.min(CONFIG.RETRY_BASE_DELAY * Math.pow(2, attempt), CONFIG.RETRY_MAX_DELAY);
                delay += Math.random() * 1000; // Add jitter

                console.log(`[ZulipClient] Retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
                await sleep(delay);
            }
        }

        throw lastError;
    }

    /**
     * Sleep helper
     */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Connect to Zulip and register for events
     */
    async function connect() {
        if (isConnected) return;

        try {
            emit('connecting');

            // Register event queue
            const params = new URLSearchParams();
            params.append('event_types', JSON.stringify(['message', 'update_message', 'reaction']));
            params.append('slim_presence', 'true');
            params.append('all_public_streams', 'true');

            const result = await request('/register', {
                method: 'POST',
                body: params.toString()
            });

            queueId = result.queue_id;
            lastEventId = result.last_event_id;
            isConnected = true;

            emit('connected', result);

            // Start long polling
            startPolling();

            // Start heartbeat
            startHeartbeat();

            console.log('[ZulipClient] Connected');
            return result;
        } catch (error) {
            emit('error', error);
            throw error;
        }
    }

    /**
     * Disconnect from Zulip
     */
    async function disconnect() {
        isConnected = false;

        // Stop polling
        if (pollController) {
            pollController.abort();
            pollController = null;
        }

        // Stop heartbeat
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }

        // Deregister queue
        if (queueId) {
            try {
                await request(`/events?queue_id=${queueId}`, { method: 'DELETE' });
            } catch (e) {
                // Ignore errors during disconnect
            }
            queueId = null;
        }

        lastEventId = -1;
        emit('disconnected');
        console.log('[ZulipClient] Disconnected');
    }

    /**
     * Start long polling for events
     */
    async function startPolling() {
        if (!isConnected || !queueId) return;

        pollController = new AbortController();

        while (isConnected && queueId) {
            try {
                const url = `/events?queue_id=${encodeURIComponent(queueId)}&last_event_id=${lastEventId}`;

                const result = await request(url, {
                    timeout: CONFIG.POLL_TIMEOUT,
                });

                if (result.events && result.events.length > 0) {
                    for (const event of result.events) {
                        lastEventId = Math.max(lastEventId, event.id);
                        handleEvent(event);
                    }
                }
            } catch (error) {
                if (!isConnected) break;

                console.error('[ZulipClient] Poll error:', error.message);

                if (error.status === 400 || error.message?.includes('BAD_EVENT_QUEUE_ID')) {
                    // Queue expired, reconnect
                    queueId = null;
                    emit('queue_expired');
                    await sleep(CONFIG.RECONNECT_DELAY);
                    try {
                        await connect();
                    } catch (e) {
                        emit('error', e);
                    }
                    break;
                }

                // Wait before retrying
                await sleep(CONFIG.RECONNECT_DELAY);
            }
        }
    }

    /**
     * Handle incoming event
     */
    function handleEvent(event) {
        switch (event.type) {
            case 'message':
                emit('message', event.message);
                break;
            case 'update_message':
                emit('message_update', event);
                break;
            case 'reaction':
                emit('reaction', event);
                break;
            case 'heartbeat':
                // Just a keepalive
                break;
            default:
                // Ignore other events
                break;
        }
    }

    /**
     * Start heartbeat to detect connection issues
     */
    function startHeartbeat() {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }

        heartbeatInterval = setInterval(async () => {
            if (!isConnected) return;

            try {
                // Simple endpoint to check connectivity
                await request('/users/me', { timeout: 10000 });
            } catch (error) {
                console.warn('[ZulipClient] Heartbeat failed:', error.message);
                emit('heartbeat_failed', error);
            }
        }, CONFIG.HEARTBEAT_INTERVAL);
    }

    /**
     * Get subscribed streams
     */
    async function getStreams() {
        const result = await request('/users/me/subscriptions');
        return result.subscriptions || [];
    }

    /**
     * Get messages
     */
    async function getMessages(options = {}) {
        const params = new URLSearchParams();
        params.append('anchor', options.anchor || 'newest');
        params.append('num_before', options.numBefore || CONFIG.BATCH_SIZE);
        params.append('num_after', options.numAfter || 0);
        params.append('apply_markdown', 'false');

        if (options.narrow) {
            params.append('narrow', JSON.stringify(options.narrow));
        }

        const result = await request(`/messages?${params.toString()}`);
        return result.messages || [];
    }

    /**
     * Send a message
     */
    async function sendMessage(params) {
        const formParams = new URLSearchParams();
        formParams.append('type', params.type || 'stream');

        if (params.type === 'private') {
            formParams.append('to', JSON.stringify(params.to));
        } else {
            formParams.append('to', params.stream);
            formParams.append('topic', params.topic || '(no topic)');
        }

        formParams.append('content', params.content);

        const result = await request('/messages', {
            method: 'POST',
            body: formParams.toString()
        });

        return result;
    }

    /**
     * Send queued message (from offline queue)
     */
    async function sendQueuedMessage(queuedMsg) {
        return await sendMessage({
            type: queuedMsg.type,
            stream: queuedMsg.stream,
            topic: queuedMsg.topic,
            to: queuedMsg.to,
            content: queuedMsg.content
        });
    }

    /**
     * Get topics for a stream
     */
    async function getTopics(streamId) {
        const result = await request(`/users/me/${streamId}/topics`);
        return result.topics || [];
    }

    /**
     * Add event listener
     */
    function on(event, callback) {
        const listener = { event, callback };
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    /**
     * Emit event to listeners
     */
    function emit(event, data) {
        listeners.forEach(listener => {
            if (listener.event === event || listener.event === '*') {
                try {
                    listener.callback(data, event);
                } catch (e) {
                    console.error('[ZulipClient] Listener error:', e);
                }
            }
        });
    }

    /**
     * Check if connected
     */
    function getIsConnected() {
        return isConnected;
    }

    /**
     * Get current server info
     */
    function getServerInfo() {
        return {
            url: serverUrl,
            email,
            connected: isConnected,
            queueId
        };
    }

    /**
     * Process offline queue
     */
    async function processQueue() {
        if (!isConnected) return { sent: 0, failed: 0 };

        const pending = await MessageStore.getPendingMessages();
        let sent = 0;
        let failed = 0;

        for (const item of pending) {
            try {
                await MessageStore.updateQueueItem(item.queueId, {
                    status: 'sending',
                    attempts: item.attempts + 1
                });

                const result = await sendQueuedMessage(item);

                await MessageStore.removeFromQueue(item.queueId);
                sent++;

                emit('queue_sent', { item, result });
            } catch (error) {
                failed++;

                const shouldRetry = item.attempts < CONFIG.MAX_RETRIES &&
                    (error.retryable || error.status >= 500);

                await MessageStore.updateQueueItem(item.queueId, {
                    status: shouldRetry ? 'pending' : 'failed',
                    lastError: error.message
                });

                emit('queue_failed', { item, error });
            }
        }

        return { sent, failed };
    }

    /**
     * Dispose client
     */
    function dispose() {
        disconnect();
        listeners.clear();
        pendingRequests.clear();
    }

    // Public API
    return {
        init,
        connect,
        disconnect,
        getStreams,
        getMessages,
        sendMessage,
        getTopics,
        processQueue,
        on,
        isConnected: getIsConnected,
        getServerInfo,
        dispose,
        CONFIG
    };
})();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ZulipClient;
}
