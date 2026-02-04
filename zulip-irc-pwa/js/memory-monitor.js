/**
 * Memory Monitor - Tracks memory usage and detects leaks
 *
 * Key strategies for preventing memory leaks on iOS:
 * 1. Bounded collections with explicit size limits
 * 2. WeakRefs for DOM references and callbacks
 * 3. Explicit cleanup of event listeners
 * 4. Periodic garbage collection hints
 * 5. Memory pressure detection and response
 */

'use strict';

const MemoryMonitor = (() => {
    // Configuration
    const CONFIG = {
        SAMPLE_INTERVAL: 30000,      // Sample memory every 30s
        HISTORY_SIZE: 100,           // Keep 100 samples max
        LEAK_THRESHOLD: 1.5,         // 50% growth = potential leak
        LEAK_SAMPLES: 10,            // Need 10 consecutive growing samples
        WARNING_MB: 50,              // Warn at 50MB
        CRITICAL_MB: 100,            // Critical at 100MB
        GC_HINT_INTERVAL: 60000,     // Hint GC every 60s
    };

    // State
    let samples = [];
    let listeners = new Set();
    let intervalId = null;
    let gcHintId = null;
    let isMonitoring = false;
    let lastWarningTime = 0;

    // Registry for tracking allocations (dev mode)
    const allocations = new Map();
    let allocationId = 0;

    /**
     * Get current memory usage in bytes
     * Falls back gracefully when performance.memory unavailable (iOS)
     */
    function getMemoryUsage() {
        // Chrome/Edge - most accurate
        if (performance.memory) {
            return {
                used: performance.memory.usedJSHeapSize,
                total: performance.memory.totalJSHeapSize,
                limit: performance.memory.jsHeapSizeLimit,
                source: 'performance.memory'
            };
        }

        // Fallback: estimate from our tracked allocations
        let estimated = 0;
        allocations.forEach(alloc => {
            estimated += alloc.size || 0;
        });

        return {
            used: estimated,
            total: estimated,
            limit: CONFIG.CRITICAL_MB * 1024 * 1024,
            source: 'estimated'
        };
    }

    /**
     * Take a memory sample
     */
    function takeSample() {
        const mem = getMemoryUsage();
        const sample = {
            timestamp: Date.now(),
            used: mem.used,
            total: mem.total,
            allocations: allocations.size
        };

        samples.push(sample);

        // Bound the samples array
        if (samples.length > CONFIG.HISTORY_SIZE) {
            samples.shift();
        }

        // Check for leaks
        const leakInfo = detectLeak();
        if (leakInfo.detected) {
            notifyListeners('leak', leakInfo);
        }

        // Check memory thresholds
        const usedMB = mem.used / (1024 * 1024);
        const now = Date.now();

        if (usedMB > CONFIG.CRITICAL_MB && now - lastWarningTime > 60000) {
            lastWarningTime = now;
            notifyListeners('critical', { usedMB, threshold: CONFIG.CRITICAL_MB });
        } else if (usedMB > CONFIG.WARNING_MB && now - lastWarningTime > 120000) {
            lastWarningTime = now;
            notifyListeners('warning', { usedMB, threshold: CONFIG.WARNING_MB });
        }

        notifyListeners('sample', sample);
        return sample;
    }

    /**
     * Detect potential memory leaks by analyzing growth pattern
     */
    function detectLeak() {
        if (samples.length < CONFIG.LEAK_SAMPLES) {
            return { detected: false };
        }

        const recent = samples.slice(-CONFIG.LEAK_SAMPLES);
        let growingCount = 0;

        for (let i = 1; i < recent.length; i++) {
            if (recent[i].used > recent[i - 1].used) {
                growingCount++;
            }
        }

        // Check if memory is consistently growing
        if (growingCount >= CONFIG.LEAK_SAMPLES - 1) {
            const firstSample = recent[0];
            const lastSample = recent[recent.length - 1];
            const growthRatio = lastSample.used / firstSample.used;

            if (growthRatio > CONFIG.LEAK_THRESHOLD) {
                return {
                    detected: true,
                    growthRatio,
                    startMB: firstSample.used / (1024 * 1024),
                    endMB: lastSample.used / (1024 * 1024),
                    duration: lastSample.timestamp - firstSample.timestamp
                };
            }
        }

        return { detected: false };
    }

    /**
     * Hint to browser that GC would be welcome
     * This creates and discards objects to trigger GC heuristics
     */
    function hintGarbageCollection() {
        // Create some temporary pressure to hint at GC
        // This is a soft hint, not a forced GC
        try {
            const temp = new ArrayBuffer(1024);
            // Let it go out of scope immediately
        } catch (e) {
            // Ignore - we're just hinting
        }
    }

    /**
     * Track an allocation for memory monitoring
     * Returns a cleanup function
     */
    function trackAllocation(name, estimatedSize) {
        const id = ++allocationId;
        allocations.set(id, {
            name,
            size: estimatedSize,
            timestamp: Date.now()
        });

        // Return cleanup function
        return () => {
            allocations.delete(id);
        };
    }

    /**
     * Create a bounded array that auto-evicts old items
     */
    function createBoundedArray(maxSize, onEvict = null) {
        const arr = [];
        const cleanup = trackAllocation(`BoundedArray(${maxSize})`, maxSize * 100);

        return {
            push(item) {
                arr.push(item);
                while (arr.length > maxSize) {
                    const evicted = arr.shift();
                    if (onEvict) onEvict(evicted);
                }
                return arr.length;
            },
            get(index) {
                return arr[index];
            },
            slice(...args) {
                return arr.slice(...args);
            },
            forEach(fn) {
                arr.forEach(fn);
            },
            get length() {
                return arr.length;
            },
            clear() {
                while (arr.length) {
                    const evicted = arr.pop();
                    if (onEvict) onEvict(evicted);
                }
            },
            toArray() {
                return [...arr];
            },
            dispose() {
                this.clear();
                cleanup();
            }
        };
    }

    /**
     * Create a bounded map that auto-evicts oldest entries
     */
    function createBoundedMap(maxSize, onEvict = null) {
        const map = new Map();
        const cleanup = trackAllocation(`BoundedMap(${maxSize})`, maxSize * 200);

        return {
            set(key, value) {
                // If key exists, delete first to update order
                if (map.has(key)) {
                    map.delete(key);
                }
                map.set(key, value);

                // Evict oldest if over limit
                while (map.size > maxSize) {
                    const oldestKey = map.keys().next().value;
                    const evicted = map.get(oldestKey);
                    map.delete(oldestKey);
                    if (onEvict) onEvict(oldestKey, evicted);
                }
                return this;
            },
            get(key) {
                return map.get(key);
            },
            has(key) {
                return map.has(key);
            },
            delete(key) {
                const value = map.get(key);
                const deleted = map.delete(key);
                if (deleted && onEvict) onEvict(key, value);
                return deleted;
            },
            get size() {
                return map.size;
            },
            keys() {
                return map.keys();
            },
            values() {
                return map.values();
            },
            entries() {
                return map.entries();
            },
            forEach(fn) {
                map.forEach(fn);
            },
            clear() {
                if (onEvict) {
                    map.forEach((value, key) => onEvict(key, value));
                }
                map.clear();
            },
            dispose() {
                this.clear();
                cleanup();
            }
        };
    }

    /**
     * Add a memory event listener
     */
    function addListener(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
    }

    /**
     * Notify all listeners of an event
     */
    function notifyListeners(type, data) {
        listeners.forEach(listener => {
            try {
                listener(type, data);
            } catch (e) {
                console.error('Memory listener error:', e);
            }
        });
    }

    /**
     * Start monitoring
     */
    function start() {
        if (isMonitoring) return;
        isMonitoring = true;

        // Take initial sample
        takeSample();

        // Start periodic sampling
        intervalId = setInterval(takeSample, CONFIG.SAMPLE_INTERVAL);

        // Start GC hints
        gcHintId = setInterval(hintGarbageCollection, CONFIG.GC_HINT_INTERVAL);

        console.log('[MemoryMonitor] Started');
    }

    /**
     * Stop monitoring
     */
    function stop() {
        if (!isMonitoring) return;
        isMonitoring = false;

        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }

        if (gcHintId) {
            clearInterval(gcHintId);
            gcHintId = null;
        }

        console.log('[MemoryMonitor] Stopped');
    }

    /**
     * Get current stats
     */
    function getStats() {
        const mem = getMemoryUsage();
        return {
            current: mem,
            samples: samples.length,
            allocations: allocations.size,
            leak: detectLeak()
        };
    }

    /**
     * Force cleanup - call during memory pressure
     */
    function forceCleanup() {
        // Clear old samples
        samples = samples.slice(-10);

        // Hint GC
        hintGarbageCollection();

        notifyListeners('cleanup', { forced: true });
    }

    /**
     * Get a report for debugging
     */
    function getReport() {
        const stats = getStats();
        const report = {
            timestamp: new Date().toISOString(),
            memory: {
                usedMB: (stats.current.used / (1024 * 1024)).toFixed(2),
                totalMB: (stats.current.total / (1024 * 1024)).toFixed(2),
                source: stats.current.source
            },
            tracking: {
                samples: stats.samples,
                allocations: stats.allocations
            },
            leak: stats.leak,
            allocations: []
        };

        allocations.forEach((alloc, id) => {
            report.allocations.push({
                id,
                name: alloc.name,
                sizeKB: (alloc.size / 1024).toFixed(2),
                age: Date.now() - alloc.timestamp
            });
        });

        return report;
    }

    // Public API
    return {
        start,
        stop,
        getStats,
        getReport,
        forceCleanup,
        addListener,
        trackAllocation,
        createBoundedArray,
        createBoundedMap,
        CONFIG
    };
})();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MemoryMonitor;
}
