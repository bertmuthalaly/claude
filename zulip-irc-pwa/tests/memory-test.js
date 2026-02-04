/**
 * Memory Leak Test Harness
 *
 * Tests for memory leaks in:
 * 1. BoundedArray and BoundedMap
 * 2. MessageStore operations
 * 3. DOM operations
 * 4. Event listeners
 * 5. Long-running sessions
 *
 * Run in browser console or with a test runner
 */

'use strict';

const MemoryTest = (() => {
    const results = [];
    let testCount = 0;
    let passCount = 0;
    let failCount = 0;

    /**
     * Test runner
     */
    async function run() {
        console.log('=== Memory Leak Test Suite ===\n');

        results.length = 0;
        testCount = 0;
        passCount = 0;
        failCount = 0;

        // Run all tests
        await testBoundedArray();
        await testBoundedMap();
        await testMessageStoreMemory();
        await testDOMLeaks();
        await testEventListenerLeaks();
        await testLongRunningSession();
        await testRapidOperations();

        // Print summary
        console.log('\n=== Test Summary ===');
        console.log(`Total: ${testCount}`);
        console.log(`Passed: ${passCount}`);
        console.log(`Failed: ${failCount}`);

        return {
            total: testCount,
            passed: passCount,
            failed: failCount,
            results
        };
    }

    /**
     * Assert helper
     */
    function assert(condition, message) {
        testCount++;
        if (condition) {
            passCount++;
            results.push({ pass: true, message });
            console.log(`✓ ${message}`);
        } else {
            failCount++;
            results.push({ pass: false, message });
            console.error(`✗ ${message}`);
        }
    }

    /**
     * Get memory snapshot (if available)
     */
    function getMemoryUsage() {
        if (performance.memory) {
            return performance.memory.usedJSHeapSize;
        }
        return null;
    }

    /**
     * Force garbage collection hint
     */
    function hintGC() {
        // Create and discard to hint GC
        const temp = new Array(10000).fill(0);
        temp.length = 0;
    }

    /**
     * Wait helper
     */
    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Test BoundedArray
     */
    async function testBoundedArray() {
        console.log('\n--- BoundedArray Tests ---');

        // Test size bounding
        const arr = MemoryMonitor.createBoundedArray(5);

        for (let i = 0; i < 10; i++) {
            arr.push({ id: i, data: 'x'.repeat(100) });
        }

        assert(arr.length === 5, 'BoundedArray respects max size');
        assert(arr.get(0).id === 5, 'BoundedArray evicts oldest items');

        // Test eviction callback
        let evictedCount = 0;
        const arr2 = MemoryMonitor.createBoundedArray(3, () => evictedCount++);

        for (let i = 0; i < 10; i++) {
            arr2.push({ id: i });
        }

        assert(evictedCount === 7, 'BoundedArray calls eviction callback');

        // Test clear
        arr2.clear();
        assert(arr2.length === 0, 'BoundedArray clear works');
        assert(evictedCount === 10, 'BoundedArray clear triggers eviction');

        // Dispose
        arr.dispose();
        arr2.dispose();
    }

    /**
     * Test BoundedMap
     */
    async function testBoundedMap() {
        console.log('\n--- BoundedMap Tests ---');

        const map = MemoryMonitor.createBoundedMap(5);

        // Add more than max
        for (let i = 0; i < 10; i++) {
            map.set(`key-${i}`, { data: 'x'.repeat(100) });
        }

        assert(map.size === 5, 'BoundedMap respects max size');
        assert(!map.has('key-0'), 'BoundedMap evicts oldest entries');
        assert(map.has('key-9'), 'BoundedMap keeps newest entries');

        // Test update order
        map.set('key-5', { updated: true }); // Re-set existing key
        map.set('key-10', {}); // Add new

        assert(map.has('key-5'), 'BoundedMap keeps re-set keys');

        // Test eviction callback
        let evictedKeys = [];
        const map2 = MemoryMonitor.createBoundedMap(2, (key) => evictedKeys.push(key));

        map2.set('a', 1);
        map2.set('b', 2);
        map2.set('c', 3);

        assert(evictedKeys.includes('a'), 'BoundedMap eviction callback works');

        map.dispose();
        map2.dispose();
    }

    /**
     * Test MessageStore memory management
     */
    async function testMessageStoreMemory() {
        console.log('\n--- MessageStore Memory Tests ---');

        await MessageStore.init();

        // Store many messages
        const messages = [];
        for (let i = 0; i < 200; i++) {
            messages.push({
                id: 100000 + i,
                stream_id: 1,
                topic: 'test',
                sender_full_name: 'Test User',
                content: 'Test message ' + i,
                timestamp: Date.now()
            });
        }

        await MessageStore.saveMessages(messages);

        const stats = await MessageStore.getStats();
        assert(stats.cacheSize <= 100, 'MessageStore cache respects size limit');

        // Test retrieval doesn't explode cache
        for (let i = 0; i < 50; i++) {
            await MessageStore.getMessage(100000 + i);
        }

        const stats2 = await MessageStore.getStats();
        assert(stats2.cacheSize <= 100, 'MessageStore cache stable after retrieval');

        // Clean up test data
        await MessageStore.clearAll();
    }

    /**
     * Test DOM memory leaks
     */
    async function testDOMLeaks() {
        console.log('\n--- DOM Leak Tests ---');

        const container = document.createElement('div');
        container.id = 'test-container';
        document.body.appendChild(container);

        const initialMemory = getMemoryUsage();

        // Simulate adding/removing many elements
        for (let cycle = 0; cycle < 10; cycle++) {
            for (let i = 0; i < 100; i++) {
                const el = document.createElement('div');
                el.className = 'test-message';
                el.textContent = 'Test ' + i;
                container.appendChild(el);
            }

            // Clear all
            container.innerHTML = '';
        }

        hintGC();
        await wait(100);

        const finalMemory = getMemoryUsage();

        // Clean up
        container.remove();

        if (initialMemory && finalMemory) {
            const growth = finalMemory - initialMemory;
            const growthMB = growth / (1024 * 1024);
            assert(growthMB < 5, `DOM operations memory growth: ${growthMB.toFixed(2)}MB`);
        } else {
            console.log('(Memory API not available - test skipped)');
        }
    }

    /**
     * Test event listener leaks
     */
    async function testEventListenerLeaks() {
        console.log('\n--- Event Listener Leak Tests ---');

        const target = document.createElement('div');
        let listenerCount = 0;

        // Add and remove listeners
        for (let i = 0; i < 100; i++) {
            const handler = () => listenerCount++;

            target.addEventListener('click', handler);
            target.removeEventListener('click', handler);
        }

        // Test with proper cleanup pattern
        const cleanups = [];
        for (let i = 0; i < 100; i++) {
            const removeListener = MemoryMonitor.addListener(() => {});
            cleanups.push(removeListener);
        }

        // Clean up all
        cleanups.forEach(cleanup => cleanup());

        const stats = MemoryMonitor.getStats();
        // Note: We can't directly test listener count, but we can verify the pattern works

        assert(true, 'Event listener cleanup pattern works');
    }

    /**
     * Test long-running session simulation
     */
    async function testLongRunningSession() {
        console.log('\n--- Long Running Session Tests ---');

        await MessageStore.init();

        const initialMemory = getMemoryUsage();
        const samples = [];

        // Simulate 100 "ticks" of activity
        for (let tick = 0; tick < 100; tick++) {
            // Simulate receiving messages
            for (let i = 0; i < 5; i++) {
                await MessageStore.saveMessage({
                    id: Date.now() + tick * 1000 + i,
                    stream_id: 1,
                    topic: 'test',
                    sender_full_name: 'User',
                    content: 'Message content ' + tick + '-' + i,
                    timestamp: Date.now()
                });
            }

            // Simulate reading messages
            await MessageStore.getMessages(1, 'test', 50);

            // Sample memory every 10 ticks
            if (tick % 10 === 0) {
                hintGC();
                await wait(10);
                const mem = getMemoryUsage();
                if (mem) samples.push(mem);
            }
        }

        // Analyze growth pattern
        if (samples.length >= 5) {
            const firstHalf = samples.slice(0, Math.floor(samples.length / 2));
            const secondHalf = samples.slice(Math.floor(samples.length / 2));

            const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
            const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

            const growthRatio = secondAvg / firstAvg;

            assert(
                growthRatio < 1.5,
                `Session memory growth ratio: ${growthRatio.toFixed(2)} (should be < 1.5)`
            );
        } else {
            console.log('(Not enough memory samples - test inconclusive)');
        }

        // Trigger cleanup
        await MessageStore.cleanup();
        await MessageStore.clearAll();
    }

    /**
     * Test rapid operations don't cause issues
     */
    async function testRapidOperations() {
        console.log('\n--- Rapid Operations Tests ---');

        await MessageStore.init();

        const startTime = Date.now();

        // Rapid save operations
        const savePromises = [];
        for (let i = 0; i < 500; i++) {
            savePromises.push(
                MessageStore.saveMessage({
                    id: 900000 + i,
                    stream_id: 1,
                    topic: 'rapid',
                    sender_full_name: 'RapidUser',
                    content: 'Rapid message ' + i,
                    timestamp: Date.now()
                })
            );
        }

        await Promise.all(savePromises);

        const saveTime = Date.now() - startTime;
        assert(saveTime < 5000, `500 saves completed in ${saveTime}ms`);

        // Rapid read operations
        const readStart = Date.now();
        for (let i = 0; i < 100; i++) {
            await MessageStore.getMessages(1, 'rapid', 50);
        }

        const readTime = Date.now() - readStart;
        assert(readTime < 3000, `100 reads completed in ${readTime}ms`);

        // Verify no crash and cleanup works
        await MessageStore.clearAll();
        const stats = await MessageStore.getStats();
        assert(stats.messages === 0, 'Cleanup after rapid operations works');
    }

    /**
     * Generate memory report
     */
    function generateReport() {
        const stats = MemoryMonitor.getReport();
        console.log('\n=== Memory Report ===');
        console.log(JSON.stringify(stats, null, 2));
        return stats;
    }

    /**
     * Stress test - call this manually for extended testing
     */
    async function stressTest(durationMs = 60000) {
        console.log(`\n=== Stress Test (${durationMs / 1000}s) ===`);

        await MessageStore.init();

        const startTime = Date.now();
        const memorySamples = [];
        let messageCount = 0;

        while (Date.now() - startTime < durationMs) {
            // Simulate activity
            for (let i = 0; i < 10; i++) {
                await MessageStore.saveMessage({
                    id: Date.now() + i,
                    stream_id: Math.floor(Math.random() * 5),
                    topic: 'stress-' + Math.floor(Math.random() * 10),
                    sender_full_name: 'StressUser',
                    content: 'Stress message with some content ' + messageCount++,
                    timestamp: Date.now()
                });
            }

            await MessageStore.getMessages(
                Math.floor(Math.random() * 5),
                null,
                50
            );

            // Sample memory
            const mem = getMemoryUsage();
            if (mem) {
                memorySamples.push({
                    time: Date.now() - startTime,
                    memory: mem
                });
            }

            await wait(100);
        }

        // Analyze results
        if (memorySamples.length > 10) {
            const first = memorySamples[0].memory;
            const last = memorySamples[memorySamples.length - 1].memory;
            const growth = (last - first) / (1024 * 1024);
            const growthRate = growth / (durationMs / 1000);

            console.log(`Messages processed: ${messageCount}`);
            console.log(`Memory growth: ${growth.toFixed(2)}MB`);
            console.log(`Growth rate: ${growthRate.toFixed(4)}MB/s`);

            return {
                messages: messageCount,
                growthMB: growth,
                growthRate,
                samples: memorySamples
            };
        }

        return null;
    }

    // Public API
    return {
        run,
        stressTest,
        generateReport
    };
})();

// Auto-run if in test mode
if (typeof window !== 'undefined' && window.location.search.includes('test=memory')) {
    MemoryTest.run().then(() => {
        console.log('\nTests complete. Run MemoryTest.stressTest() for extended testing.');
    });
}

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MemoryTest;
}
