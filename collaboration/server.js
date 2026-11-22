'use strict';
// Flexcel Collaborative prototype: local/LAN room relay for committed PF cell edits.
// Run from the project root: npm run collab:server
// Default listens only on 127.0.0.1. Use FLEXCEL_HOST=0.0.0.0 for a trusted LAN.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const HOST = process.env.FLEXCEL_HOST || '127.0.0.1';
const PORT = Number(process.env.FLEXCEL_PORT || 8787);
const STORAGE = process.env.FLEXCEL_ROOMS_FILE || path.join(__dirname, 'rooms.private.json');
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_ROOMS = 100;
const ROOM_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid FLEXCEL_PORT');

const rooms = new Map();
function validId(id) { return typeof id === 'string' && /^[a-f0-9]{12,24}$/.test(id); }
function validSecret(secret) { return typeof secret === 'string' && /^[a-f0-9]{40,64}$/.test(secret); }
function hashed(secret) { return crypto.createHash('sha256').update(secret).digest('hex'); }
function matchesSecret(expected, candidate) {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hashed(candidate), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function validCell(value) {
  return value === null || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= 20000);
}
function validateFlow(flow) {
  if (!flow || typeof flow !== 'object' || Array.isArray(flow) ||
      flow.flow_type !== 'PF Flow' ||
      !['Pro', 'Con'].includes(flow.firstSpeaker) ||
      !Array.isArray(flow['flow-data']) || flow['flow-data'].length !== 2) {
    throw new Error('Invalid PF flow');
  }
  for (const grid of flow['flow-data']) {
    if (!Array.isArray(grid) || grid.length < 1 || grid.length > 250) throw new Error('Invalid rows');
    for (const row of grid) {
      if (!Array.isArray(row) || row.length > 30 || row.some(v => !validCell(v))) {
        throw new Error('Invalid cells');
      }
    }
  }
  if (flow.boldElements !== undefined &&
      (!Array.isArray(flow.boldElements) || flow.boldElements.length !== 2 ||
       flow.boldElements.some(sheet => !Array.isArray(sheet) || sheet.length > 2000 ||
         sheet.some(rc => !Array.isArray(rc) || rc.length !== 2 ||
           !rc.every(n => Number.isInteger(n) && n >= 0 && n < 251))))) {
    throw new Error('Invalid bold coordinates');
  }
}
function record(room) {
  return {
    id: room.id, passwordHash: room.passwordHash, rev: room.rev,
    updatedAt: room.updatedAt, flow: room.flow
  };
}
function saveRooms() {
  const next = STORAGE + '.tmp';
  fs.mkdirSync(path.dirname(STORAGE), { recursive: true });
  fs.writeFileSync(next, JSON.stringify({ version: 1, rooms: [...rooms.values()].map(record) }), { mode: 0o600 });
  fs.renameSync(next, STORAGE);
}
function loadRooms() {
  if (!fs.existsSync(STORAGE)) return;
  const stored = JSON.parse(fs.readFileSync(STORAGE, 'utf8'));
  if (stored.version !== 1 || !Array.isArray(stored.rooms)) throw new Error('Unsupported rooms storage');
  for (const item of stored.rooms.slice(0, MAX_ROOMS)) {
    try {
      validateFlow(item.flow);
      if (!validId(item.id) || !/^[a-f0-9]{64}$/.test(item.passwordHash) ||
          !Number.isSafeInteger(item.rev) || item.rev < 0 ||
          !Number.isFinite(item.updatedAt) || Date.now() - item.updatedAt > ROOM_EXPIRY_MS) continue;
      rooms.set(item.id, { ...item, peers: new Set() });
    } catch { /* Skip malformed stored room entries */ }
  }
}
loadRooms();
let saveTimer;
function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { saveRooms(); } catch (err) { console.error('Room save failed:', err.message); }
  }, 250);
}
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function error(ws, message) { send(ws, { type: 'error', message }); }
function broadcast(room, message) {
  for (const peer of room.peers) send(peer, message);
}
function presence(room) { broadcast(room, { type: 'presence', participants: room.peers.size }); }
function cleanOldRooms() {
  let changed = false;
  for (const [id, room] of rooms) {
    if (room.peers.size === 0 && Date.now() - room.updatedAt > ROOM_EXPIRY_MS) {
      rooms.delete(id); changed = true;
    }
  }
  if (changed) persistSoon();
}
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'flexcel-collaboration' }));
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
wss.on('connection', ws => {
  let room = null;
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return ws.close(1003, 'JSON text only');
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); }
    catch { return error(ws, 'Invalid JSON'); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return error(ws, 'Invalid message');
    if (!room) {
      if (!['create', 'join'].includes(msg.type) || !validId(msg.room) || !validSecret(msg.secret)) {
        return error(ws, 'Invalid room credentials');
      }
      const existing = rooms.get(msg.room);
      if (msg.type === 'create') {
        if (existing) return error(ws, 'Room code already exists. Create a new one.');
        cleanOldRooms();
        if (rooms.size >= MAX_ROOMS) return error(ws, 'Room capacity reached');
        try { validateFlow(msg.flow); }
        catch { return error(ws, 'Cannot share an invalid PF flow'); }
        room = {
          id: msg.room, passwordHash: hashed(msg.secret), rev: 0,
          updatedAt: Date.now(), flow: JSON.parse(JSON.stringify(msg.flow)), peers: new Set()
        };
        rooms.set(room.id, room);
        persistSoon();
      } else {
        if (!existing || !matchesSecret(existing.passwordHash, msg.secret)) {
          return error(ws, 'Room code or invite secret is incorrect');
        }
        if (existing.peers.size >= 2) return error(ws, 'Room already has two participants');
        room = existing;
      }
      room.peers.add(ws);
      send(ws, { type: 'welcome', room: room.id, rev: room.rev, participants: room.peers.size, flow: room.flow });
      presence(room);
      console.log('Room connected:', room.id, 'participants:', room.peers.size);
      return;
    }
    if (msg.type === 'cell') {
      if (!Number.isInteger(msg.sheet) || msg.sheet < 0 || msg.sheet > 1 ||
          !Array.isArray(msg.cells) || msg.cells.length < 1 || msg.cells.length > 300) {
        return error(ws, 'Invalid cell update');
      }
      const rows = room.flow['flow-data'][msg.sheet];
      for (const item of msg.cells) {
        if (!Array.isArray(item) || item.length !== 3 ||
            !Number.isInteger(item[0]) || item[0] < 0 || item[0] >= rows.length ||
            !Number.isInteger(item[1]) || item[1] < 0 || item[1] >= 30 ||
            !validCell(item[2])) return error(ws, 'Invalid cell coordinates or value');
      }
      // Sequential server ordering. Updates to different cells do not overwrite each other.
      for (const [row, col, value] of msg.cells) rows[row][col] = value;
      room.rev++;
      room.updatedAt = Date.now();
      persistSoon();
      broadcast(room, { type: 'cell', sheet: msg.sheet, cells: msg.cells, rev: room.rev });
      return;
    }
    error(ws, 'Unsupported message type');
  });
  ws.on('close', () => {
    if (room) {
      room.peers.delete(ws);
      presence(room);
      console.log('Room disconnected:', room.id, 'participants:', room.peers.size);
    }
  });
  ws.on('error', err => console.error('WebSocket error:', err.message));
});
server.listen(PORT, HOST, () => {
  console.log(`Flexcel collaboration server: ws://${HOST}:${PORT}`);
  console.log('Local/LAN prototype. Use a trusted network. Do not port-forward this server.');
});
const prune = setInterval(cleanOldRooms, 60 * 60 * 1000);
prune.unref();
function shutdown() {
  if (saveTimer) clearTimeout(saveTimer);
  try { saveRooms(); } catch (err) { console.error('Unable to save room data:', err.message); }
  server.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
