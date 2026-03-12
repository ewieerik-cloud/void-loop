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
app.use(express.static(path.join(__dirname, 'public')));
// Serve index.html for all GET requests (handles invite links like /?join=CODE)
app.get('*', (req, res) => res.sendFile(path.join(__dirname,'public', 'index.html')));

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
    // If already in a room, leave it first to prevent orphaned rooms
    if (socket._roomCode) {
      console.log(`[create_room] ${socket.id} already owns room ${socket._roomCode} — leaving first`);
      _handlePlayerLeave(socket);
    }
    const code = genCode();
    const room = { code, host: socket.id, players: new Map() };
    const player = { idx: 0, name: name || 'PILOT', color: color || '#ff3300', socketId: socket.id };

    room.players.set(socket.id, player);
    rooms.set(code, room);
    socket.join(code);
    socket._roomCode = code;

    console.log(`[create_room] ${name} (${socket.id}) created room ${code}`);
    // ► HOST: receives room_created with their room code
    socket.emit('room_created', {
      roomCode: code,
      playerIdx: 0,
      lobby: lobbySnapshot(room)
    });
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

    console.log(`[join_room] ${name} (${socket.id}) joining room ${code} as P${idx+1}`);
    // ► GUEST: receives room_joined with their player index
    socket.emit('room_joined', {
      roomCode: code,
      playerIdx: idx,
      lobby: lobbySnapshot(room)
    });

    // ► ALL IN ROOM: lobby updated with new player
    io.to(code).emit('lobby_update', { lobby: lobbySnapshot(room) });
    console.log(`[join_room] room ${code} now has ${room.players.size} players`);
  });

  /* ── GAME START (host only) ──────────────── */
  socket.on('game_start', () => {
    const room = rooms.get(socket._roomCode);
    console.log(`[game_start] from ${socket.id}, active_room=${socket._roomCode}, host=${room?.host}, is_host=${room?.host === socket.id}, players=${room?.players.size}`);
    if (!room || room.host !== socket.id) return;
    io.to(room.code).emit('game_start');
    console.log(`[game_start] sent to room ${room.code} — ${room.players.size} players notified`);
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

  /* ── GAME OVER relay (host → guests) ────── */
  // Host emits this when all players are dead.
  socket.on('game_over', (data) => {
    const room = rooms.get(socket._roomCode);
    if (!room || room.host !== socket.id) return;
    socket.to(room.code).emit('game_over', data);
  });

  /* ── PARTY RETRY (host → all) ───────────── */
  // Host clicked retry — broadcast so all guests restart together.
  socket.on('party_retry', () => {
    const room = rooms.get(socket._roomCode);
    if (!room || room.host !== socket.id) return;
    io.to(room.code).emit('party_retry');
  });

  /* ── HOST LEFT GAME (returned to lobby) ─── */
  // Host went back to the lobby screen mid-session (did NOT disconnect).
  // Guests receive this and return to lobby too. Room stays alive.
  socket.on('host_left_game', () => {
    const room = rooms.get(socket._roomCode);
    if (!room || room.host !== socket.id) return;
    socket.to(room.code).emit('host_left_game');
    console.log(`[room] Host returned to lobby in ${room.code}`);
  });

  /* ── EXPLICIT LEAVE ROOM ─────────────────── */
  // Player voluntarily leaves the room (BACK button etc.) without disconnecting.
  socket.on('leave_room', () => {
    const code = socket._roomCode;
    if (!code) return;
    console.log(`[-] ${socket.id} left room ${code} voluntarily`);
    _handlePlayerLeave(socket);
  });

  /* ── DISCONNECT ──────────────────────────── */
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    _handlePlayerLeave(socket);
  });
});

/* ──────────────────────────────────────────────
   HELPERS
────────────────────────────────────────────── */

/**
 * Remove a player from their room. Called on disconnect AND on explicit leave_room.
 * Promotes a new host if needed, notifies remaining players, deletes empty rooms.
 */
function _handlePlayerLeave(socket) {
  const code = socket._roomCode;
  const room = rooms.get(code);
  if (!room) return;

  room.players.delete(socket.id);
  socket.leave(code);
  socket._roomCode = null;

  if (room.players.size === 0) {
    rooms.delete(code);
    console.log(`[room] Deleted empty room ${code}`);
    return;
  }

  // Promote next player if host left
  if (room.host === socket.id) {
    room.host = room.players.keys().next().value;
    io.to(room.host).emit('promoted_to_host');
    console.log(`[room] New host in ${code}: ${room.host}`);
  }

  io.to(code).emit('lobby_update', { lobby: lobbySnapshot(room) });
}
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
