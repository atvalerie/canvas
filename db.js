const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const CORE = new Set(["id", "type", "x", "y", "user", "owner", "tag", "ts"]);

function bounds(it) {
  const s = it.s || 1;
  let w = 420,
    h = 4096;
  if (it.type === "stroke") {
    const pad = it.w || 3;
    w = Math.max(1, ...it.points.map((p) => p[0])) + pad;
    h = Math.max(1, ...it.points.map((p) => p[1])) + pad;
  } else if (it.type === "text") {
    const text = it.text || "";
    h = (text.split("\n").length + Math.ceil(text.length / 30) + 1) * 24;
  }
  return [it.x - 20, it.x + w * s, it.y - 24, it.y + h * s];
}

function split(item) {
  const data = {};
  for (const k in item) if (!CORE.has(k)) data[k] = item[k];
  return JSON.stringify(data);
}

function toItem(row) {
  return {
    id: row.id,
    type: row.type,
    x: row.x,
    y: row.y,
    user: row.user,
    owner: row.owner,
    tag: row.tag ?? undefined,
    ts: row.ts,
    ...JSON.parse(row.data),
  };
}

module.exports = function open(dir) {
  const db = new DatabaseSync(path.join(dir, "canvas.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS items (
      n INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      owner TEXT NOT NULL,
      user TEXT NOT NULL,
      tag INTEGER,
      ts INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS items_owner ON items(owner);
    CREATE VIRTUAL TABLE IF NOT EXISTS items_rt USING rtree(n, minx, maxx, miny, maxy);
    CREATE TABLE IF NOT EXISTS users (
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      n INTEGER NOT NULL,
      PRIMARY KEY (name, owner)
    );
  `);

  const q = {
    insert: db.prepare(
      "INSERT INTO items (id, type, x, y, owner, user, tag, ts, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    rtInsert: db.prepare("INSERT INTO items_rt VALUES (?, ?, ?, ?, ?)"),
    byId: db.prepare("SELECT * FROM items WHERE id = ?"),
    update: db.prepare("UPDATE items SET x = ?, y = ?, data = ? WHERE n = ?"),
    rtUpdate: db.prepare(
      "UPDATE items_rt SET minx = ?, maxx = ?, miny = ?, maxy = ? WHERE n = ?",
    ),
    del: db.prepare("DELETE FROM items WHERE n = ?"),
    rtDel: db.prepare("DELETE FROM items_rt WHERE n = ?"),
    region: db.prepare(`
      SELECT i.* FROM items_rt r JOIN items i ON i.n = r.n
      WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?
      ORDER BY i.n LIMIT ?`),
    all: db.prepare("SELECT * FROM items ORDER BY n LIMIT ?"),
    count: db.prepare("SELECT COUNT(*) AS c FROM items"),
    tagGet: db.prepare("SELECT n FROM users WHERE name = ? AND owner = ?"),
    tagMax: db.prepare(
      "SELECT COALESCE(MAX(n), 0) AS m FROM users WHERE name = ?",
    ),
    tagInsert: db.prepare(
      "INSERT INTO users (name, owner, n) VALUES (?, ?, ?)",
    ),
    usersCount: db.prepare("SELECT COUNT(*) AS c FROM users"),
    byOwner: db.prepare("SELECT * FROM items WHERE owner = ?"),
    byName: db.prepare("SELECT * FROM items WHERE lower(user) = ?"),
    byNameTag: db.prepare(
      "SELECT * FROM items WHERE lower(user) = ? AND tag = ?",
    ),
  };

  function tx(fn) {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function insertRow(item) {
    const r = q.insert.run(
      item.id,
      item.type,
      item.x,
      item.y,
      item.owner,
      item.user,
      item.tag ?? null,
      item.ts,
      split(item),
    );
    q.rtInsert.run(Number(r.lastInsertRowid), ...bounds(item));
  }

  let count = q.count.get().c;

  function migrate() {
    const itemsFile = path.join(dir, "items.json");
    const usersFile = path.join(dir, "users.json");

    if (count === 0 && fs.existsSync(itemsFile)) {
      const list = JSON.parse(fs.readFileSync(itemsFile, "utf8"));
      let skipped = 0;
      tx(() => {
        for (const it of list) {
          const ok =
            it &&
            typeof it.id === "string" &&
            typeof it.type === "string" &&
            Number.isFinite(it.x) &&
            Number.isFinite(it.y) &&
            typeof it.owner === "string" &&
            typeof it.user === "string";
          if (!ok) {
            skipped++;
            continue;
          }
          insertRow({ ...it, ts: it.ts || Date.now() });
        }
      });
      count = q.count.get().c;
      fs.renameSync(itemsFile, itemsFile + ".migrated");
      console.log(`migrated ${count} items (${skipped} skipped)`);
    }

    if (q.usersCount.get().c === 0 && fs.existsSync(usersFile)) {
      const names = JSON.parse(fs.readFileSync(usersFile, "utf8"));
      tx(() => {
        for (const [name, owners] of Object.entries(names)) {
          owners.forEach((owner, i) => q.tagInsert.run(name, owner, i + 1));
        }
      });
      fs.renameSync(usersFile, usersFile + ".migrated");
      console.log("migrated users");
    }
  }
  migrate();

  return {
    count: () => count,

    add(item) {
      tx(() => insertRow(item));
      count++;
      return item;
    },

    get(id) {
      const row = q.byId.get(id);
      return row ? { n: row.n, item: toItem(row) } : null;
    },

    update(n, item) {
      tx(() => {
        q.update.run(item.x, item.y, split(item), n);
        q.rtUpdate.run(...bounds(item), n);
      });
    },

    remove(n) {
      tx(() => {
        q.del.run(n);
        q.rtDel.run(n);
      });
      count--;
    },

    find({ owner, name, tag }) {
      const rows = owner
        ? q.byOwner.all(owner)
        : tag
          ? q.byNameTag.all(name.toLowerCase(), tag)
          : q.byName.all(name.toLowerCase());
      return rows.map((row) => ({ n: row.n, item: toItem(row) }));
    },

    region: (x1, y1, x2, y2, limit) =>
      q.region.all(x1, x2, y1, y2, limit).map(toItem),

    all: (limit) => q.all.all(limit).map(toItem),

    tag(name, owner) {
      const key = name.toLowerCase();
      const row = q.tagGet.get(key, owner);
      if (row) return row.n;
      const n = q.tagMax.get(key).m + 1;
      q.tagInsert.run(key, owner, n);
      return n;
    },

    close: () => db.close(),
  };
};
