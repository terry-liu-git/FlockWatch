import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";

const app = express();
app.use(cors());
app.use(express.json());

/**
 * In-memory store (hackathon-friendly).
 * If you want persistence, swap this to a DB later.
 */
const sessions = new Map(); // sessionId -> { sessionId, createdAt, participants: Map(userId -> {...}), events: [] }
const sseClients = new Map(); // sessionId -> Set(res)

/** Utility: create/get session */
function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      createdAt: Date.now(),
      participants: new Map(),
      events: []
    });
  }
  return sessions.get(sessionId);
}

/** Utility: broadcast via SSE */
function broadcast(sessionId, payload) {
  const clients = sseClients.get(sessionId);
  if (!clients) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

/** Health check */
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * Create a session (optional).
 * Partner may already create sessions from laptop side.
 */
app.post("/api/sessions", (req, res) => {
  const sessionId = req.body.sessionId || nanoid(8).toUpperCase();
  const session = getOrCreateSession(sessionId);
  res.json({ sessionId: session.sessionId });
});

/**
 * Join session (mobile)
 */
app.post("/api/sessions/:sessionId/join", (req, res) => {
  const { sessionId } = req.params;
  const { userId, deviceId, deviceType } = req.body;

  if (!userId || !deviceId) {
    return res.status(400).json({ error: "userId and deviceId required" });
  }

  const session = getOrCreateSession(sessionId);
  session.participants.set(userId, {
    userId,
    deviceId,
    deviceType: deviceType || "mobile",
    joinedAt: Date.now(),
    lastSeenAt: Date.now(),
    score: 100
  });

  const event = {
    id: nanoid(),
    sessionId,
    userId,
    deviceId,
    deviceType: deviceType || "mobile",
    type: "JOIN",
    ts: Date.now(),
    meta: {}
  };
  session.events.push(event);
  broadcast(sessionId, { kind: "event", event });

  res.json({ ok: true, sessionId });
});

/**
 * Post integrity events
 */
app.post("/api/sessions/:sessionId/event", (req, res) => {
  const { sessionId } = req.params;
  const { userId, deviceId, deviceType, type, ts, meta } = req.body;

  if (!userId || !deviceId || !type) {
    return res.status(400).json({ error: "userId, deviceId, type required" });
  }

  const session = getOrCreateSession(sessionId);
  const p = session.participants.get(userId);
  if (p) p.lastSeenAt = Date.now();

  const event = {
    id: nanoid(),
    sessionId,
    userId,
    deviceId,
    deviceType: deviceType || "mobile",
    type,
    ts: ts || Date.now(),
    meta: meta || {}
  };

  // Simple scoring rules (adjust freely)
  if (p) {
    if (type === "TAB_HIDDEN" || type === "WINDOW_BLUR") p.score -= 25;
    if (type === "BREAK_OVERTIME") p.score -= 15;
    if (type === "BREAK_START") p.score -= 0;
    if (p.score < 0) p.score = 0;
  }

  session.events.push(event);

  broadcast(sessionId, { kind: "event", event });
  if (p) broadcast(sessionId, { kind: "participant", participant: p });

  res.json({ ok: true });
});

/**
 * Fetch participants + scores (dashboard can use this)
 */
app.get("/api/sessions/:sessionId/participants", (req, res) => {
  const session = getOrCreateSession(req.params.sessionId);
  const participants = Array.from(session.participants.values());
  res.json({ participants });
});

/**
 * Fetch event history
 */
app.get("/api/sessions/:sessionId/events", (req, res) => {
  const session = getOrCreateSession(req.params.sessionId);
  res.json({ events: session.events });
});

/**
 * Server-Sent Events stream (realtime without websockets)
 * Dashboard/mobile can listen if needed.
 */
app.get("/api/sessions/:sessionId/stream", (req, res) => {
  const { sessionId } = req.params;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set());
  sseClients.get(sessionId).add(res);

  // send a hello packet
  res.write(`data: ${JSON.stringify({ kind: "hello", ts: Date.now() })}\n\n`);

  req.on("close", () => {
    sseClients.get(sessionId)?.delete(res);
  });
});

const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));