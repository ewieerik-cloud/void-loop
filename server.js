/* ══════════════════════════════════════════════════════════════
   server.js  —  VOID LOOP multiplayer server
   ─ Serves index.html as static file
   ─ Manages rooms: create / join / leave / disconnect
   ─ Relays messages between clients (does NOT run game logic)
   ─ HOST CLIENT is authoritative for all game simulation
   ─ Guests send inputs → server relays to host
   ─ Host sends game state → server relays to guests
══════════════════════════════════════════════════════════════ */
'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }
});

// Serve static files (index.html, assets) from same directory
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ──────────────────────────────────────────────
   ROOM STATE
   rooms: Map<roomCode, Room>
   Room = {
     code:    string,
     host:    socketId (first joiner),
     players: Map<socketId, { idx, name, color, socketId }>
   }
────────────────────────────────────────────── */
const rooms = new Map();

/** Generate a unique 6-char alphanumeric room code */
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:6}, ()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

/* ──────────────────────────────────────────────
   SOCKET EVENTS
────────────────────────────────────────────── */
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  /* ── CREATE ROOM ─────────────────────────── */
  socket.on('create_room', ({ name, color }) => {
    const code = genCode();
    const room = { code, host: socket.id, players: new Map() };
    const player = { idx: 0, name: name || 'PILOT', color: color || '#ff3300', socketId: socket.id };

    room.players.set(socket.id, player);
    rooms.set(code, room);
    socket.join(code);
    socket._roomCode = code;

    // ► HOST: receives room_created with their room code
    socket.emit('room_created', {
      roomCode: code,
      playerIdx: 0,
      lobby: lobbySnapshot(room)
    });
    console.log(`[room] Created ${code} by ${name}`);
  });

  /* ── JOIN ROOM ───────────────────────────── */
  socket.on('join_room', ({ roomCode, name, color }) => {
    const code = roomCode?.toUpperCase();
    const room = rooms.get(code);

    if (!room) { socket.emit('room_error', 'Room not found'); return; }
    if (room.players.size >= 4) { socket.emit('room_error', 'Room is full'); return; }

    const idx = nextFreeIdx(room);
    const player = { idx, name: name || 'PILOT', color: color || '#00aaff', socketId: socket.id };

    room.players.set(socket.id, player);
    socket.join(code);
    socket._roomCode = code;

    // ► GUEST: receives room_joined with their player index
    socket.emit('room_joined', {
      roomCode: code,
      playerIdx: idx,
      lobby: lobbySnapshot(room)
    });

    // ► ALL IN ROOM: lobby updated with new player
    io.to(code).emit('lobby_update', { lobby: lobbySnapshot(room) });
    console.log(`[room] ${name} joined ${code} as P${idx+1}`);
  });

  /* ── GAME START (host only) ──────────────── */
  socket.on('game_start', () => {
    const room = rooms.get(socket._roomCode);
    console.log(`[game_start] from ${socket.id}, room=${socket._roomCode}, host=${room?.host}, match=${room?.host === socket.id}`);
    if (!room || room.host !== socket.id) return;
    // Broadcast to ALL in room — client skips if already in play mode
    io.to(room.code).emit('game_start');
    console.log(`[room] Game started in ${room.code} — notified ${room.players.size} players`);
  });

  /* ── GAME STATE RELAY (host → guests) ───── */
  // Host sends full game state snapshot every ~50ms.
  // Server just relays it — no game logic here.
  socket.on('game_state', (state) => {
    const room = rooms.get(socket._roomCode);
    if (!room || room.host !== socket.id) return;
    // ► ALL GUESTS in room (not host)
    socket.to(room.code).emit('game_state', state);
  });

  /* ── PLAYER INPUT RELAY (guest → host) ───── */
  // Guests send their key state every frame.
  // Server tags the packet with sender's player index and relays to host.
  socket.on('player_input', (keys) => {
    const room = rooms.get(socket._roomCode);
    if (!room) return;
    const me = room.players.get(socket.id);
    if (!me) return;
    // ► HOST only
    io.to(room.host).emit('guest_input', { idx: me.idx, keys });
  });

  /* ── GAME OVER relay ─────────────────────── */
  socket.on('game_over', (data) => {
    const room = rooms.get(socket._roomCode);
    if (!room || room.host !== socket.id) return;
    socket.to(room.code).emit('game_over', data);
  });

  /* ── DISCONNECT ──────────────────────────── */
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    const code = socket._roomCode;
    const room = rooms.get(code);
    if (!room) return;

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      rooms.delete(code);
      console.log(`[room] Deleted empty room ${code}`);
      return;
    }

    // If host left, promote next player to host
    if (room.host === socket.id) {
      room.host = room.players.keys().next().value;
      io.to(room.host).emit('promoted_to_host');
      console.log(`[room] New host in ${code}: ${room.host}`);
    }

    // ► ALL IN ROOM: updated lobby
    io.to(code).emit('lobby_update', { lobby: lobbySnapshot(room) });
  });
});

/* ──────────────────────────────────────────────
   HELPERS
────────────────────────────────────────────── */
function lobbySnapshot(room) {
  // Returns an array of {idx, name, color} for the lobby display
  const arr = Array.from(room.players.values())
    .sort((a, b) => a.idx - b.idx)
    .map(p => ({ idx: p.idx, name: p.name, color: p.color }));
  return arr;
}

function nextFreeIdx(room) {
  const used = new Set(Array.from(room.players.values()).map(p => p.idx));
  for (let i = 0; i < 4; i++) if (!used.has(i)) return i;
  return 3;
}

/* ──────────────────────────────────────────────
   START SERVER
────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`VOID LOOP server running on http://localhost:${PORT}`);
  console.log('Place index.html in the same directory and run: node server.js');
});
