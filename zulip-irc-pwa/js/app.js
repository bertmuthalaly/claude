/**
 * Main Application - ZulipIRC
 *
 * Coordinates all modules and handles UI
 */

'use strict';

const App = (() => {
    // DOM elements
    const elements = {};

    // State
    let currentStream = null;
    let currentTopic = null;
    let streams = [];
    let isOnline = navigator.onLine;

    // Bounded message list for display
    let displayedMessages = null;

    /**
     * Initialize the app
     */
    async function init() {
        try {
            // Cache DOM elements
            cacheElements();

            // Initialize modules
            await MessageStore.init();
            MemoryMonitor.start();

            // Set up bounded display list
            displayedMessages = MemoryMonitor.createBoundedArray(100, (msg) => {
                // Remove DOM element when message evicted
                const el = document.getElementById(`msg-${msg.id}`);
                if (el) el.remove();
            });

            // Set up event listeners
            setupEventListeners();

            // Register service worker
            await registerServiceWorker();

            // Restore session
            await restoreSession();

            // Set up memory monitoring
            setupMemoryMonitoring();

            console.log('[App] Initialized');
        } catch (error) {
            console.error('[App] Init failed:', error);
            showToast('Failed to initialize app', true);
        }
    }

    /**
     * Cache DOM element references
     */
    function cacheElements() {
        elements.menuBtn = document.getElementById('menu-btn');
        elements.sidebar = document.getElementById('sidebar');
        elements.channelName = document.getElementById('channel-name');
        elements.status = document.getElementById('status');
        elements.streamsList = document.getElementById('streams-list');
        elements.messages = document.getElementById('messages');
        elements.messageForm = document.getElementById('message-form');
        elements.messageInput = document.getElementById('message-input');
        elements.sendBtn = document.getElementById('send-btn');
        elements.queueStatus = document.getElementById('queue-status');
        elements.queueCount = document.getElementById('queue-count');
        elements.serverUrl = document.getElementById('server-url');
        elements.userEmail = document.getElementById('user-email');
        elements.apiKey = document.getElementById('api-key');
        elements.connectBtn = document.getElementById('connect-btn');
        elements.disconnectBtn = document.getElementById('disconnect-btn');
        elements.toast = document.getElementById('toast');
    }

    /**
     * Set up event listeners
     */
    function setupEventListeners() {
        // Menu toggle
        elements.menuBtn.addEventListener('click', toggleSidebar);

        // Close sidebar on outside click
        document.addEventListener('click', (e) => {
            if (elements.sidebar.classList.contains('visible') &&
                !elements.sidebar.contains(e.target) &&
                e.target !== elements.menuBtn) {
                toggleSidebar();
            }
        });

        // Message form
        elements.messageForm.addEventListener('submit', handleSendMessage);

        // Connect/disconnect
        elements.connectBtn.addEventListener('click', handleConnect);
        elements.disconnectBtn.addEventListener('click', handleDisconnect);

        // Online/offline events
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        // Visibility change - pause/resume polling
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // iOS keyboard handling
        if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
            elements.messageInput.addEventListener('focus', () => {
                setTimeout(() => {
                    elements.messages.scrollTop = elements.messages.scrollHeight;
                }, 300);
            });
        }

        // Zulip client events
        ZulipClient.on('connected', handleConnected);
        ZulipClient.on('disconnected', handleDisconnected);
        ZulipClient.on('message', handleNewMessage);
        ZulipClient.on('error', handleError);
        ZulipClient.on('connecting', () => updateStatus('connecting'));
        ZulipClient.on('queue_expired', () => {
            showToast('Reconnecting...');
        });
    }

    /**
     * Register service worker
     */
    async function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) {
            console.warn('[App] Service workers not supported');
            return;
        }

        try {
            const registration = await navigator.serviceWorker.register('/sw.js', {
                scope: '/'
            });

            registration.addEventListener('updatefound', () => {
                const newWorker = registration.installing;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        showToast('Update available - refresh to update');
                    }
                });
            });

            // Listen for messages from service worker
            navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

            console.log('[App] Service worker registered');
        } catch (error) {
            console.error('[App] Service worker registration failed:', error);
        }
    }

    /**
     * Handle messages from service worker
     */
    function handleServiceWorkerMessage(event) {
        const { type, data } = event.data;

        switch (type) {
            case 'QUEUE_SYNC':
                // Service worker synced queue
                updateQueueStatus();
                break;
            case 'BACKGROUND_SYNC':
                showToast('Messages synced');
                break;
        }
    }

    /**
     * Restore previous session
     */
    async function restoreSession() {
        const serverUrl = await MessageStore.getConfig('serverUrl');
        const email = await MessageStore.getConfig('email');
        const apiKey = await MessageStore.getConfig('apiKey');

        if (serverUrl) elements.serverUrl.value = serverUrl;
        if (email) elements.userEmail.value = email;
        if (apiKey) elements.apiKey.value = apiKey;

        // Restore last stream/topic
        currentStream = await MessageStore.getConfig('lastStream');
        currentTopic = await MessageStore.getConfig('lastTopic');

        // Load cached streams
        streams = await MessageStore.getStreams();
        renderStreams();

        // Load cached messages
        if (currentStream) {
            await loadMessages(currentStream, currentTopic);
            updateChannelName();
        }

        // Auto-connect if credentials saved
        if (serverUrl && email && apiKey && isOnline) {
            handleConnect();
        }

        updateQueueStatus();
    }

    /**
     * Handle connect button
     */
    async function handleConnect() {
        const serverUrl = elements.serverUrl.value.trim();
        const email = elements.userEmail.value.trim();
        const apiKey = elements.apiKey.value.trim();

        if (!serverUrl || !email || !apiKey) {
            showToast('Please fill all fields', true);
            return;
        }

        elements.connectBtn.disabled = true;

        try {
            // Normalize URL
            let normalizedUrl = serverUrl;
            if (!normalizedUrl.startsWith('http')) {
                normalizedUrl = `https://${normalizedUrl}`;
            }

            ZulipClient.init({
                serverUrl: normalizedUrl,
                email,
                apiKey
            });

            await ZulipClient.connect();

            // Save credentials
            await MessageStore.setConfig('serverUrl', normalizedUrl);
            await MessageStore.setConfig('email', email);
            await MessageStore.setConfig('apiKey', apiKey);

            // Fetch streams
            streams = await ZulipClient.getStreams();
            await MessageStore.saveStreams(streams);
            renderStreams();

            // Select first stream if none selected
            if (!currentStream && streams.length > 0) {
                selectStream(streams[0].stream_id, streams[0].name);
            }

            // Process any queued messages
            const queueResult = await ZulipClient.processQueue();
            if (queueResult.sent > 0) {
                showToast(`Sent ${queueResult.sent} queued message(s)`);
            }

            toggleSidebar();
        } catch (error) {
            console.error('[App] Connect failed:', error);
            showToast(`Connect failed: ${error.message}`, true);
        } finally {
            elements.connectBtn.disabled = false;
        }
    }

    /**
     * Handle disconnect button
     */
    async function handleDisconnect() {
        await ZulipClient.disconnect();
    }

    /**
     * Handle connected event
     */
    function handleConnected() {
        updateStatus('online');
        elements.connectBtn.classList.add('hidden');
        elements.disconnectBtn.classList.remove('hidden');
        showToast('Connected');
    }

    /**
     * Handle disconnected event
     */
    function handleDisconnected() {
        updateStatus('offline');
        elements.connectBtn.classList.remove('hidden');
        elements.disconnectBtn.classList.add('hidden');
    }

    /**
     * Handle new message
     */
    async function handleNewMessage(message) {
        // Save to store
        await MessageStore.saveMessage(message);

        // Display if in current stream/topic
        if (message.stream_id === currentStream) {
            if (!currentTopic || message.subject === currentTopic) {
                appendMessage(message);
            }
        }
    }

    /**
     * Handle error
     */
    function handleError(error) {
        console.error('[App] Error:', error);
        showToast(error.message || 'Connection error', true);
    }

    /**
     * Handle send message
     */
    async function handleSendMessage(e) {
        e.preventDefault();

        const content = elements.messageInput.value.trim();
        if (!content) return;

        if (!currentStream) {
            showToast('Select a channel first', true);
            return;
        }

        const stream = streams.find(s => s.stream_id === currentStream);
        if (!stream) {
            showToast('Invalid channel', true);
            return;
        }

        const messageData = {
            type: 'stream',
            stream: stream.name,
            topic: currentTopic || 'general',
            content
        };

        elements.messageInput.value = '';
        elements.sendBtn.disabled = true;

        try {
            if (ZulipClient.isConnected() && isOnline) {
                await ZulipClient.sendMessage(messageData);
            } else {
                // Queue for later
                await MessageStore.queueMessage(messageData);
                showToast('Message queued for sending');
                updateQueueStatus();

                // Show as pending
                appendMessage({
                    id: `pending-${Date.now()}`,
                    stream_id: currentStream,
                    subject: currentTopic || 'general',
                    sender_full_name: 'You',
                    content,
                    timestamp: Date.now(),
                    pending: true
                });
            }
        } catch (error) {
            console.error('[App] Send failed:', error);

            // Queue on failure
            await MessageStore.queueMessage(messageData);
            showToast('Message queued (send failed)');
            updateQueueStatus();
        } finally {
            elements.sendBtn.disabled = false;
        }
    }

    /**
     * Select a stream
     */
    async function selectStream(streamId, streamName) {
        currentStream = streamId;
        currentTopic = null;

        await MessageStore.setConfig('lastStream', streamId);
        await MessageStore.setConfig('lastTopic', null);

        updateChannelName();
        await loadMessages(streamId);

        // Update active state
        document.querySelectorAll('.stream-item').forEach(el => {
            el.classList.toggle('active', parseInt(el.dataset.streamId) === streamId);
        });
    }

    /**
     * Select a topic
     */
    async function selectTopic(streamId, topic) {
        currentStream = streamId;
        currentTopic = topic;

        await MessageStore.setConfig('lastStream', streamId);
        await MessageStore.setConfig('lastTopic', topic);

        updateChannelName();
        await loadMessages(streamId, topic);
        toggleSidebar();
    }

    /**
     * Load messages for stream/topic
     */
    async function loadMessages(streamId, topic = null) {
        // Clear current messages
        elements.messages.innerHTML = '';
        displayedMessages.clear();

        // Load from cache first
        const cachedMessages = await MessageStore.getMessages(streamId, topic, 50);

        for (const msg of cachedMessages) {
            appendMessage(msg, false);
        }

        // Fetch new messages if online
        if (ZulipClient.isConnected() && isOnline) {
            try {
                const narrow = [{ operator: 'stream', operand: streamId }];
                if (topic) {
                    narrow.push({ operator: 'topic', operand: topic });
                }

                const messages = await ZulipClient.getMessages({
                    narrow,
                    numBefore: 50,
                    numAfter: 0
                });

                await MessageStore.saveMessages(messages);

                // Update display with any new messages
                for (const msg of messages) {
                    if (!document.getElementById(`msg-${msg.id}`)) {
                        appendMessage(msg, false);
                    }
                }
            } catch (error) {
                console.error('[App] Fetch messages failed:', error);
            }
        }

        scrollToBottom();
    }

    /**
     * Append a message to the display
     */
    function appendMessage(message, scroll = true) {
        // Track in bounded list
        displayedMessages.push(message);

        const el = document.createElement('div');
        el.id = `msg-${message.id}`;
        el.className = 'message' + (message.pending ? ' pending' : '');

        const time = formatTime(message.timestamp);
        const sender = escapeHtml(message.sender_full_name || message.sender || 'Unknown');
        const content = escapeHtml(message.content || '');
        const topic = message.subject || message.topic;

        el.innerHTML = `
            <span class="msg-time">${time}</span>
            <span class="msg-sender">${sender}</span>
            ${topic && !currentTopic ? `<span class="msg-topic">[${escapeHtml(topic)}]</span>` : ''}
            <span class="msg-content">${content}</span>
        `;

        elements.messages.appendChild(el);

        if (scroll) {
            scrollToBottom();
        }
    }

    /**
     * Render streams list
     */
    function renderStreams() {
        elements.streamsList.innerHTML = '';

        for (const stream of streams) {
            const el = document.createElement('div');
            el.className = 'stream-item' + (stream.stream_id === currentStream ? ' active' : '');
            el.dataset.streamId = stream.stream_id;
            el.textContent = `# ${stream.name}`;

            el.addEventListener('click', () => selectStream(stream.stream_id, stream.name));

            elements.streamsList.appendChild(el);
        }
    }

    /**
     * Toggle sidebar
     */
    function toggleSidebar() {
        elements.sidebar.classList.toggle('visible');
        elements.sidebar.classList.toggle('hidden');
    }

    /**
     * Update channel name display
     */
    function updateChannelName() {
        const stream = streams.find(s => s.stream_id === currentStream);
        let name = stream ? `#${stream.name}` : 'ZulipIRC';
        if (currentTopic) {
            name += ` > ${currentTopic}`;
        }
        elements.channelName.textContent = name;
    }

    /**
     * Update status indicator
     */
    function updateStatus(status) {
        elements.status.className = status;
    }

    /**
     * Update queue status display
     */
    async function updateQueueStatus() {
        const count = await MessageStore.getQueueSize();

        if (count > 0) {
            elements.queueCount.textContent = count;
            elements.queueStatus.classList.remove('hidden');
            updateStatus('queued');
        } else {
            elements.queueStatus.classList.add('hidden');
            if (ZulipClient.isConnected()) {
                updateStatus('online');
            }
        }
    }

    /**
     * Handle online event
     */
    async function handleOnline() {
        isOnline = true;
        showToast('Back online');

        if (!ZulipClient.isConnected()) {
            // Try to reconnect
            const serverUrl = await MessageStore.getConfig('serverUrl');
            if (serverUrl) {
                handleConnect();
            }
        } else {
            // Process queue
            const result = await ZulipClient.processQueue();
            if (result.sent > 0) {
                showToast(`Sent ${result.sent} queued message(s)`);
            }
            updateQueueStatus();
        }
    }

    /**
     * Handle offline event
     */
    function handleOffline() {
        isOnline = false;
        updateStatus('offline');
        showToast('You are offline');
    }

    /**
     * Handle visibility change
     */
    function handleVisibilityChange() {
        if (document.hidden) {
            // Page hidden - could pause non-essential operations
        } else {
            // Page visible - refresh if needed
            if (ZulipClient.isConnected() && currentStream) {
                loadMessages(currentStream, currentTopic);
            }
        }
    }

    /**
     * Setup memory monitoring
     */
    function setupMemoryMonitoring() {
        MemoryMonitor.addListener((type, data) => {
            switch (type) {
                case 'warning':
                    console.warn(`[Memory] Warning: ${data.usedMB.toFixed(2)}MB used`);
                    break;
                case 'critical':
                    console.error(`[Memory] Critical: ${data.usedMB.toFixed(2)}MB used`);
                    // Force cleanup
                    MemoryMonitor.forceCleanup();
                    MessageStore.cleanup();
                    break;
                case 'leak':
                    if (data.detected) {
                        console.error('[Memory] Potential leak detected:', data);
                    }
                    break;
            }
        });
    }

    /**
     * Show toast notification
     */
    function showToast(message, isError = false) {
        elements.toast.textContent = message;
        elements.toast.className = isError ? 'error' : '';
        elements.toast.classList.remove('hidden');

        setTimeout(() => {
            elements.toast.classList.add('hidden');
        }, 3000);
    }

    /**
     * Scroll messages to bottom
     */
    function scrollToBottom() {
        elements.messages.scrollTop = elements.messages.scrollHeight;
    }

    /**
     * Format timestamp
     */
    function formatTime(timestamp) {
        const date = new Date(timestamp * 1000 || timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    /**
     * Escape HTML
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Dispose app
     */
    function dispose() {
        ZulipClient.dispose();
        MessageStore.dispose();
        MemoryMonitor.stop();

        if (displayedMessages) {
            displayedMessages.dispose();
        }
    }

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Cleanup on page unload
    window.addEventListener('unload', dispose);

    // Public API
    return {
        init,
        dispose,
        showToast
    };
})();
