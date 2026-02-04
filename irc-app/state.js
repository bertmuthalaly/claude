// DataScript-based state management for IRC
// Minimalist, immutable, memory-efficient

const State = (() => {
  const ds = datascript;

  // Schema - sparse, only index what we query
  const schema = {
    'conn/id':      { ':db/unique': ':db.unique/identity' },
    'chan/name':    { ':db/unique': ':db.unique/identity' },
    'chan/conn':    { ':db/valueType': ':db.type/ref' },
    'msg/chan':     { ':db/valueType': ':db.type/ref' },
    'msg/ts':       { ':db/index': true },
    'user/nick':    {},
    'user/chan':    { ':db/valueType': ':db.type/ref' }
  };

  let conn = ds.create_conn(schema);
  let listeners = new Set();

  // Message pool - reuse message objects to reduce GC pressure
  const MSG_POOL_SIZE = 100;
  const msgPool = [];

  const getPooledMsg = () => msgPool.pop() || {};
  const returnToPool = (msg) => {
    if (msgPool.length < MSG_POOL_SIZE) {
      for (const k in msg) delete msg[k];
      msgPool.push(msg);
    }
  };

  // Limit messages per channel to prevent memory growth
  const MAX_MSGS_PER_CHAN = 500;
  const PRUNE_BATCH = 100;

  const pruneOldMessages = (chanId) => {
    const db = ds.db(conn);
    const msgs = ds.q(
      '[:find ?e ?ts :where [?e :msg/chan ?c] [?e :msg/ts ?ts] [(= ?c ?chanId)]]'
        .replace('?chanId', chanId),
      db
    );

    if (msgs.length > MAX_MSGS_PER_CHAN) {
      const sorted = msgs.sort((a, b) => a[1] - b[1]);
      const toRemove = sorted.slice(0, PRUNE_BATCH);
      const retracts = toRemove.map(([eid]) => [':db.fn/retractEntity', eid]);
      ds.transact(conn, retracts);
    }
  };

  const notify = () => {
    const db = ds.db(conn);
    listeners.forEach(fn => fn(db));
  };

  return {
    // Subscribe to state changes
    subscribe(fn) {
      listeners.add(fn);
      fn(ds.db(conn)); // Initial call
      return () => listeners.delete(fn);
    },

    // Connection management
    addConnection(id, server, nick, ssl = true) {
      ds.transact(conn, [{
        ':db/id': -1,
        'conn/id': id,
        'conn/server': server,
        'conn/nick': nick,
        'conn/ssl': ssl,
        'conn/status': 'connecting'
      }]);
      notify();
    },

    updateConnectionStatus(id, status) {
      const db = ds.db(conn);
      const eid = ds.q('[:find ?e . :where [?e :conn/id ?id]]'.replace('?id', `"${id}"`), db);
      if (eid) {
        ds.transact(conn, [{ ':db/id': eid, 'conn/status': status }]);
        notify();
      }
    },

    removeConnection(id) {
      const db = ds.db(conn);
      const eid = ds.q('[:find ?e . :where [?e :conn/id ?id]]'.replace('?id', `"${id}"`), db);
      if (eid) {
        ds.transact(conn, [[':db.fn/retractEntity', eid]]);
        notify();
      }
    },

    getConnection(id) {
      const db = ds.db(conn);
      return ds.pull(db, '[*]', ['conn/id', id]);
    },

    // Channel management
    addChannel(connId, name) {
      const db = ds.db(conn);
      const connEid = ds.q('[:find ?e . :where [?e :conn/id ?id]]'.replace('?id', `"${connId}"`), db);
      if (connEid) {
        ds.transact(conn, [{
          ':db/id': -1,
          'chan/name': `${connId}:${name}`,
          'chan/display': name,
          'chan/conn': connEid,
          'chan/unread': 0,
          'chan/joined': Date.now()
        }]);
        notify();
      }
    },

    getChannels(connId) {
      const db = ds.db(conn);
      const connEid = ds.q('[:find ?e . :where [?e :conn/id ?id]]'.replace('?id', `"${connId}"`), db);
      if (!connEid) return [];

      return ds.q(
        '[:find [(pull ?e [*]) ...] :where [?e :chan/conn ?c]]'.replace('?c', connEid),
        db
      ) || [];
    },

    getAllChannels() {
      const db = ds.db(conn);
      return ds.q('[:find [(pull ?e [* {:chan/conn [*]}]) ...] :where [?e :chan/name]]', db) || [];
    },

    updateUnread(chanName, count) {
      const db = ds.db(conn);
      const eid = ds.q('[:find ?e . :where [?e :chan/name ?n]]'.replace('?n', `"${chanName}"`), db);
      if (eid) {
        ds.transact(conn, [{ ':db/id': eid, 'chan/unread': count }]);
        notify();
      }
    },

    // Message management - memory efficient
    addMessage(chanName, nick, text, type = 'msg') {
      const db = ds.db(conn);
      const chanEid = ds.q('[:find ?e . :where [?e :chan/name ?n]]'.replace('?n', `"${chanName}"`), db);

      if (chanEid) {
        const ts = Date.now();
        ds.transact(conn, [{
          ':db/id': -1,
          'msg/chan': chanEid,
          'msg/nick': nick,
          'msg/text': text,
          'msg/type': type,
          'msg/ts': ts
        }]);

        // Prune old messages periodically
        pruneOldMessages(chanEid);
        notify();
      }
    },

    getMessages(chanName, limit = 100) {
      const db = ds.db(conn);
      const chanEid = ds.q('[:find ?e . :where [?e :chan/name ?n]]'.replace('?n', `"${chanName}"`), db);
      if (!chanEid) return [];

      const msgs = ds.q(
        `[:find [(pull ?e [*]) ...] :where [?e :msg/chan ${chanEid}]]`,
        db
      ) || [];

      return msgs
        .sort((a, b) => a['msg/ts'] - b['msg/ts'])
        .slice(-limit);
    },

    // Clear all messages for a channel (memory cleanup)
    clearMessages(chanName) {
      const db = ds.db(conn);
      const chanEid = ds.q('[:find ?e . :where [?e :chan/name ?n]]'.replace('?n', `"${chanName}"`), db);
      if (!chanEid) return;

      const msgEids = ds.q(`[:find [?e ...] :where [?e :msg/chan ${chanEid}]]`, db) || [];
      const retracts = msgEids.map(eid => [':db.fn/retractEntity', eid]);
      if (retracts.length) {
        ds.transact(conn, retracts);
        notify();
      }
    },

    // Bulk operations for efficiency
    addMessagesBatch(messages) {
      const db = ds.db(conn);
      const txData = [];
      const chanCache = new Map();

      for (const m of messages) {
        let chanEid = chanCache.get(m.chan);
        if (!chanEid) {
          chanEid = ds.q('[:find ?e . :where [?e :chan/name ?n]]'.replace('?n', `"${m.chan}"`), db);
          chanCache.set(m.chan, chanEid);
        }

        if (chanEid) {
          txData.push({
            ':db/id': -1 - txData.length,
            'msg/chan': chanEid,
            'msg/nick': m.nick,
            'msg/text': m.text,
            'msg/type': m.type || 'msg',
            'msg/ts': m.ts || Date.now()
          });
        }
      }

      if (txData.length) {
        ds.transact(conn, txData);
        notify();
      }
    },

    // State serialization for SW sync
    serialize() {
      const db = ds.db(conn);
      return ds.serializable(db);
    },

    deserialize(data) {
      if (data) {
        conn = ds.conn_from_db(ds.from_serializable(data));
        notify();
      }
    },

    // Memory stats
    getStats() {
      const db = ds.db(conn);
      return {
        connections: ds.q('[:find (count ?e) . :where [?e :conn/id]]', db) || 0,
        channels: ds.q('[:find (count ?e) . :where [?e :chan/name]]', db) || 0,
        messages: ds.q('[:find (count ?e) . :where [?e :msg/ts]]', db) || 0,
        poolSize: msgPool.length
      };
    },

    // Full reset for testing
    reset() {
      conn = ds.create_conn(schema);
      msgPool.length = 0;
      notify();
    },

    // Direct DB access for queries
    db: () => ds.db(conn),
    q: ds.q,
    pull: ds.pull
  };
})();

// Export for SW
if (typeof self !== 'undefined' && self.registration) {
  self.State = State;
}
