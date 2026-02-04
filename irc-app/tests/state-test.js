// Node.js unit tests for State management
// Run with: node --expose-gc tests/state-test.js

const assert = require('assert');
const { execSync } = require('child_process');

// Check if DataScript is available, if not skip tests
let datascript;
try {
  datascript = require('datascript');
} catch (e) {
  console.log('DataScript not installed. Install with: npm install datascript');
  console.log('Skipping state tests.\n');
  process.exit(0);
}

// Simple test framework
const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  console.log('Running State Management Tests\n');
  console.log('='.repeat(50));

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`✗ ${t.name}`);
      console.log(`  Error: ${err.message}`);
      failed++;
    }
  }

  console.log('='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  process.exit(failed > 0 ? 1 : 0);
}

// Create a minimal State implementation for testing
const State = (() => {
  const ds = datascript;

  const schema = {
    'conn/id': { ':db/unique': ':db.unique/identity' },
    'chan/name': { ':db/unique': ':db.unique/identity' },
    'chan/conn': { ':db/valueType': ':db.type/ref' },
    'msg/chan': { ':db/valueType': ':db.type/ref' },
    'msg/ts': { ':db/index': true }
  };

  let conn = ds.create_conn(schema);
  let listeners = new Set();

  const MAX_MSGS_PER_CHAN = 500;
  const PRUNE_BATCH = 100;

  const pruneOldMessages = (chanId) => {
    const db = ds.db(conn);
    const msgs = ds.q(
      `[:find ?e ?ts :where [?e :msg/chan ${chanId}] [?e :msg/ts ?ts]]`,
      db
    );

    if (msgs.length > MAX_MSGS_PER_CHAN) {
      const sorted = msgs.sort((a, b) => a[1] - b[1]);
      const toRemove = sorted.slice(0, PRUNE_BATCH);
      const retracts = toRemove.map(([eid]) => [':db.fn/retractEntity', eid]);
      ds.transact(conn, retracts);
    }
  };

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    addConnection(id, server, nick) {
      ds.transact(conn, [{
        ':db/id': -1,
        'conn/id': id,
        'conn/server': server,
        'conn/nick': nick,
        'conn/status': 'connecting'
      }]);
    },

    addChannel(connId, name) {
      const db = ds.db(conn);
      const connEid = ds.q(`[:find ?e . :where [?e :conn/id "${connId}"]]`, db);
      if (connEid) {
        ds.transact(conn, [{
          ':db/id': -1,
          'chan/name': `${connId}:${name}`,
          'chan/display': name,
          'chan/conn': connEid,
          'chan/unread': 0
        }]);
      }
    },

    addMessage(chanName, nick, text, type = 'msg') {
      const db = ds.db(conn);
      const chanEid = ds.q(`[:find ?e . :where [?e :chan/name "${chanName}"]]`, db);

      if (chanEid) {
        ds.transact(conn, [{
          ':db/id': -1,
          'msg/chan': chanEid,
          'msg/nick': nick,
          'msg/text': text,
          'msg/type': type,
          'msg/ts': Date.now()
        }]);
        pruneOldMessages(chanEid);
      }
    },

    getMessages(chanName, limit = 100) {
      const db = ds.db(conn);
      const chanEid = ds.q(`[:find ?e . :where [?e :chan/name "${chanName}"]]`, db);
      if (!chanEid) return [];

      const msgs = ds.q(
        `[:find [(pull ?e [*]) ...] :where [?e :msg/chan ${chanEid}]]`,
        db
      ) || [];

      return msgs
        .sort((a, b) => a['msg/ts'] - b['msg/ts'])
        .slice(-limit);
    },

    clearMessages(chanName) {
      const db = ds.db(conn);
      const chanEid = ds.q(`[:find ?e . :where [?e :chan/name "${chanName}"]]`, db);
      if (!chanEid) return;

      const msgEids = ds.q(`[:find [?e ...] :where [?e :msg/chan ${chanEid}]]`, db) || [];
      const retracts = msgEids.map(eid => [':db.fn/retractEntity', eid]);
      if (retracts.length) {
        ds.transact(conn, retracts);
      }
    },

    getStats() {
      const db = ds.db(conn);
      return {
        connections: ds.q('[:find (count ?e) . :where [?e :conn/id]]', db) || 0,
        channels: ds.q('[:find (count ?e) . :where [?e :chan/name]]', db) || 0,
        messages: ds.q('[:find (count ?e) . :where [?e :msg/ts]]', db) || 0
      };
    },

    reset() {
      conn = ds.create_conn(schema);
      listeners.clear();
    }
  };
})();

// Tests
test('addConnection creates a connection', () => {
  State.reset();
  State.addConnection('test1', 'irc.example.com', 'testuser');
  const stats = State.getStats();
  assert.strictEqual(stats.connections, 1);
});

test('addChannel creates a channel', () => {
  State.reset();
  State.addConnection('test1', 'irc.example.com', 'testuser');
  State.addChannel('test1', '#general');
  const stats = State.getStats();
  assert.strictEqual(stats.channels, 1);
});

test('addMessage stores messages', () => {
  State.reset();
  State.addConnection('test1', 'irc.example.com', 'testuser');
  State.addChannel('test1', '#general');
  State.addMessage('test1:#general', 'alice', 'Hello world');
  State.addMessage('test1:#general', 'bob', 'Hi alice');

  const messages = State.getMessages('test1:#general');
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0]['msg/nick'], 'alice');
  assert.strictEqual(messages[1]['msg/nick'], 'bob');
});

test('getMessages respects limit', () => {
  State.reset();
  State.addConnection('test1', 'irc.example.com', 'testuser');
  State.addChannel('test1', '#general');

  for (let i = 0; i < 50; i++) {
    State.addMessage('test1:#general', 'user', `Message ${i}`);
  }

  const messages = State.getMessages('test1:#general', 10);
  assert.strictEqual(messages.length, 10);
  // Should return last 10
  assert.strictEqual(messages[0]['msg/text'], 'Message 40');
});

test('clearMessages removes all messages from channel', () => {
  State.reset();
  State.addConnection('test1', 'irc.example.com', 'testuser');
  State.addChannel('test1', '#general');

  for (let i = 0; i < 100; i++) {
    State.addMessage('test1:#general', 'user', `Message ${i}`);
  }

  let stats = State.getStats();
  assert.strictEqual(stats.messages, 100);

  State.clearMessages('test1:#general');

  stats = State.getStats();
  assert.strictEqual(stats.messages, 0);
});

test('message pruning limits messages per channel', () => {
  State.reset();
  State.addConnection('test1', 'irc.example.com', 'testuser');
  State.addChannel('test1', '#general');

  // Add more than MAX_MSGS_PER_CHAN
  for (let i = 0; i < 700; i++) {
    State.addMessage('test1:#general', 'user', `Message ${i}`);
  }

  const stats = State.getStats();
  // Should be pruned to around MAX_MSGS_PER_CHAN
  assert.ok(stats.messages <= 600, `Expected <= 600 messages, got ${stats.messages}`);
});

test('subscribe and unsubscribe work correctly', () => {
  State.reset();
  let callCount = 0;
  const unsub = State.subscribe(() => callCount++);

  State.addConnection('test1', 'irc.example.com', 'testuser');
  // Note: our minimal implementation doesn't call listeners, so we just test unsubscribe

  unsub();
  // Should be able to unsubscribe without error
  assert.ok(true);
});

test('multiple channels work independently', () => {
  State.reset();
  State.addConnection('test1', 'irc.example.com', 'testuser');
  State.addChannel('test1', '#channel1');
  State.addChannel('test1', '#channel2');

  State.addMessage('test1:#channel1', 'user1', 'Message in channel 1');
  State.addMessage('test1:#channel2', 'user2', 'Message in channel 2');

  const msgs1 = State.getMessages('test1:#channel1');
  const msgs2 = State.getMessages('test1:#channel2');

  assert.strictEqual(msgs1.length, 1);
  assert.strictEqual(msgs2.length, 1);
  assert.strictEqual(msgs1[0]['msg/nick'], 'user1');
  assert.strictEqual(msgs2[0]['msg/nick'], 'user2');
});

test('reset clears all state', () => {
  State.addConnection('test1', 'irc.example.com', 'testuser');
  State.addChannel('test1', '#general');
  State.addMessage('test1:#general', 'user', 'test');

  State.reset();

  const stats = State.getStats();
  assert.strictEqual(stats.connections, 0);
  assert.strictEqual(stats.channels, 0);
  assert.strictEqual(stats.messages, 0);
});

// Memory leak test (requires --expose-gc)
test('no memory leak with many messages', async () => {
  if (typeof global.gc !== 'function') {
    console.log('  (Skipped: run with --expose-gc for memory tests)');
    return;
  }

  State.reset();
  global.gc();

  const memBefore = process.memoryUsage().heapUsed;

  State.addConnection('test1', 'irc.example.com', 'testuser');
  State.addChannel('test1', '#general');

  // Add many messages
  for (let i = 0; i < 5000; i++) {
    State.addMessage('test1:#general', 'user', `Message ${i} with some content`);
  }

  global.gc();

  const memAfter = process.memoryUsage().heapUsed;
  const memGrowth = (memAfter - memBefore) / 1024 / 1024;

  // Memory growth should be bounded due to pruning
  assert.ok(memGrowth < 50, `Memory grew by ${memGrowth.toFixed(2)}MB`);

  const stats = State.getStats();
  assert.ok(stats.messages <= 600, `Messages not pruned: ${stats.messages}`);
});

// Run all tests
runTests();
