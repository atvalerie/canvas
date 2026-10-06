const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOADS = path.join(DATA, "uploads");
const INDEX = path.join(__dirname, "public", "index.html");

const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_ITEMS = 1000000;
const REGION_LIMIT = 50000;
const MAX_TEXT = 500;
const MAX_POINTS = 2000;
const BOUND = 1e6;
const RATE_PER_MIN = 30;

const VERSION = Date.now().toString(36);

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
};

fs.mkdirSync(UPLOADS, { recursive: true });

const store = require("./db")(DATA);
const tagFor = (name, owner) => store.tag(name, owner);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    store.close();
    process.exit(0);
  });
}

const clients = new Set();
function broadcast(event) {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 25000);

const hits = new Map();
function limited(ip, max = RATE_PER_MIN) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || h.reset < now) h = { count: 0, reset: now + 60000 };
  hits.set(ip, h);
  return ++h.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (h.reset < now) hits.delete(ip);
}, 60000);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return fwd.split(",")[0].trim();
  }
  return req.socket.remoteAddress;
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, "too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.toString("latin1", 0, 4) === "GIF8") return "gif";
  if (
    b.toString("latin1", 0, 4) === "RIFF" &&
    b.toString("latin1", 8, 12) === "WEBP"
  )
    return "webp";
  if (b.toString("latin1", 4, 8) === "ftyp") return "mp4";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return "webm";
  return null;
}

const ownerOf = (key) =>
  crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);

function getKey(req) {
  const key = req.headers["x-key"];
  if (typeof key !== "string" || key.length < 16 || key.length > 64)
    throw new HttpError(400, "missing key");
  return key;
}

const num = (v) => {
  v = Number(v);
  if (!Number.isFinite(v)) throw new HttpError(400, "bad position");
  return Math.round(Math.max(-BOUND, Math.min(BOUND, v)));
};

function cleanPoints(v) {
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_POINTS)
    throw new HttpError(400, "bad stroke");
  return v.map((p) => {
    const x = Array.isArray(p) ? Number(p[0]) : NaN;
    const y = Array.isArray(p) ? Number(p[1]) : NaN;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(x) > 20000 ||
      Math.abs(y) > 20000
    ) {
      throw new HttpError(400, "bad stroke");
    }
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  });
}

function scale(v) {
  v = Number(v);
  if (!Number.isFinite(v)) throw new HttpError(400, "bad scale");
  return Math.round(Math.max(0.1, Math.min(10, v)) * 1000) / 1000;
}

function cleanName(v) {
  const name = String(v || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
  if (!name) throw new HttpError(400, "name required");
  return name;
}

function identity(name, key) {
  const user = cleanName(name);
  const owner = ownerOf(key);
  return { user, owner, tag: tagFor(user, owner) };
}

function send(res, status, body, headers = {}) {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "content-type": isObj ? "application/json" : "text/plain",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function addItem(item) {
  if (store.count() >= MAX_ITEMS) throw new HttpError(507, "canvas is full");
  store.add(item);
  broadcast({ t: "add", item });
  return item;
}

function removeItem({ n, item }) {
  const file = item.file || item.image;
  if (file) fs.unlink(path.join(UPLOADS, file), () => {});
  store.remove(n);
  broadcast({ t: "del", id: item.id });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const m = req.method;

  if (m === "GET" && p === "/") {
    return send(res, 200, fs.readFileSync(INDEX), {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });
  }

  if (m === "GET" && p === "/api/items") {
    const q = url.searchParams;
    let list;
    if (q.has("x1")) {
      const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((k) =>
        Number(q.get(k)),
      );
      if (![x1, y1, x2, y2].every(Number.isFinite))
        throw new HttpError(400, "bad region");
      list = store.region(x1, y1, x2, y2, REGION_LIMIT);
    } else {
      list = store.all(REGION_LIMIT);
    }
    if (!/\bgzip\b/.test(req.headers["accept-encoding"] || ""))
      return send(res, 200, list);
    return zlib.gzip(JSON.stringify(list), (err, buf) => {
      if (err) return send(res, 500, { error: "server error" });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "x-content-type-options": "nosniff",
      });
      res.end(buf);
    });
  }

  if (m === "GET" && p === "/api/me")
    return send(res, 200, { owner: ownerOf(getKey(req)) });

  if (m === "GET" && p === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`data: ${JSON.stringify({ t: "hello", v: VERSION })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (m === "GET" && p.startsWith("/i/")) {
    const name = p.slice(3);
    const m2 = /^[a-f0-9]{24}\.(png|jpg|gif|webp|mp4|webm)$/.exec(name);
    if (!m2) throw new HttpError(404, "not found");
    const file = path.join(UPLOADS, name);
    if (!fs.existsSync(file)) throw new HttpError(404, "not found");
    const size = fs.statSync(file).size;
    let start = 0,
      end = size - 1,
      status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      if (range[1] === "") start = Math.max(0, size - Number(range[2]));
      else {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      }
      if (start > end)
        return send(res, 416, "", { "content-range": `bytes */${size}` });
      status = 206;
    }
    res.writeHead(status, {
      "content-type": MIME[m2[1]],
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
      ...(status === 206 && {
        "content-range": `bytes ${start}-${end}/${size}`,
      }),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  if (m === "POST" && p === "/api/items") {
    const key = getKey(req);
    const body = JSON.parse((await readBody(req, 65536)).toString() || "{}");
    const ip = clientIp(req);
    if (body.type === "stroke") {
      if (limited("s:" + ip, 300)) throw new HttpError(429, "slow down");
      const item = addItem({
        id: crypto.randomBytes(6).toString("hex"),
        type: "stroke",
        x: num(body.x),
        y: num(body.y),
        points: cleanPoints(body.points),
        ...(/^#[0-9a-f]{6}$/i.test(body.c) && { c: body.c }),
        w: Math.round(Math.max(1, Math.min(40, Number(body.w) || 4)) * 10) / 10,
        ...identity(body.user, key),
        ts: Date.now(),
      });
      return send(res, 201, item);
    }
    if (limited(ip)) throw new HttpError(429, "slow down");
    const text = String(body.text || "")
      .trim()
      .slice(0, MAX_TEXT);
    if (!text) throw new HttpError(400, "empty text");
    const item = addItem({
      id: crypto.randomBytes(6).toString("hex"),
      type: "text",
      x: num(body.x),
      y: num(body.y),
      text,
      ...identity(body.user, key),
      ts: Date.now(),
    });
    return send(res, 201, item);
  }

  if (m === "POST" && p === "/api/upload") {
    if (limited(clientIp(req))) throw new HttpError(429, "slow down");
    const key = getKey(req);
    const x = num(url.searchParams.get("x"));
    const y = num(url.searchParams.get("y"));
    const user = cleanName(url.searchParams.get("user"));
    const owner = ownerOf(key);
    const buf = await readBody(req, MAX_UPLOAD);
    const ext = sniff(buf);
    if (!ext) throw new HttpError(415, "png, jpg, gif, webp, mp4 or webm only");
    const video = ext === "mp4" || ext === "webm";
    if (!video && buf.length > MAX_IMAGE) throw new HttpError(413, "too large");
    const name = crypto.randomBytes(12).toString("hex") + "." + ext;
    fs.writeFileSync(path.join(UPLOADS, name), buf);
    const item = addItem({
      id: crypto.randomBytes(6).toString("hex"),
      type: video ? "video" : "image",
      x,
      y,
      file: name,
      user,
      owner,
      tag: tagFor(user, owner),
      ts: Date.now(),
    });
    return send(res, 201, item);
  }

  const itemRoute = /^\/api\/items\/([a-f0-9]+)$/.exec(p);
  if (itemRoute && (m === "PATCH" || m === "DELETE")) {
    if (limited("e:" + clientIp(req), 120))
      throw new HttpError(429, "slow down");
    const entry = store.get(itemRoute[1]);
    if (!entry) throw new HttpError(404, "not found");
    const item = entry.item;
    if (item.owner !== ownerOf(getKey(req)))
      throw new HttpError(403, "not yours");
    if (m === "DELETE") {
      removeItem(entry);
      return send(res, 200, { ok: true });
    }
    const body = JSON.parse((await readBody(req, 4096)).toString() || "{}");
    if (body.x !== undefined || body.y !== undefined) {
      item.x = num(body.x);
      item.y = num(body.y);
    }
    if (body.s !== undefined) item.s = scale(body.s);
    if (body.text !== undefined) {
      const text = String(body.text).trim().slice(0, MAX_TEXT);
      if (item.type !== "text" || !text) throw new HttpError(400, "bad text");
      item.text = text;
    }
    store.update(entry.n, item);
    broadcast({ t: "move", item });
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, "not found");
}

http
  .createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError)
        return send(res, err.status, { error: err.message });
      if (err instanceof SyntaxError)
        return send(res, 400, { error: "bad json" });
      console.error(err);
      send(res, 500, { error: "server error" });
    });
  })
  .listen(PORT, () => console.log(`canvas on http://localhost:${PORT}`));
