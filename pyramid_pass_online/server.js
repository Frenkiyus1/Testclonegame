'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const TICK_RATE = 30;
const SNAPSHOT_RATE = 15;
const WORLD_W = 3300;
const FLOOR_TOP = 138;
const FLOOR_BOTTOM = 500;
const MATCH_SECONDS = 90;
const MAX_PLAYERS = 4;
const COLORS = ['#4fd1e6', '#ef8ec6', '#8bd969', '#ffb85a'];
const CHARACTER_NAMES = ['Nefra', 'Khepri', 'Sati', 'Anuk'];
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  pingInterval: 10000,
  pingTimeout: 20000,
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const rooms = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function sanitizeName(value) {
  const cleaned = String(value || 'Explorer')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return cleaned || 'Explorer';
}

function sanitizeSessionId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function sanitizeRoomCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}

function generateRoomCode() {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let code = '';
    for (let i = 0; i < 5; i += 1) {
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error('Unable to allocate a room code');
}

function createPlayer(sessionId, socketId, name, slot) {
  const spawns = [
    [160, 245],
    [220, 330],
    [300, 210],
    [360, 390],
  ];
  const [x, y] = spawns[slot];
  return {
    sessionId,
    socketId,
    connected: true,
    name: sanitizeName(name),
    slot,
    color: COLORS[slot],
    character: CHARACTER_NAMES[slot],
    x,
    y,
    vx: 0,
    vy: 0,
    facing: 1,
    dashCooldown: 0,
    invuln: 0,
    input: { up: false, down: false, left: false, right: false },
    lastInputAt: Date.now(),
  };
}

function publicPlayer(player) {
  return {
    sessionId: player.sessionId,
    connected: player.connected,
    name: player.name,
    slot: player.slot,
    color: player.color,
    character: player.character,
    x: player.x,
    y: player.y,
    vx: player.vx,
    vy: player.vy,
    facing: player.facing,
    dashCooldown: player.dashCooldown,
    invuln: player.invuln,
  };
}

function connectedPlayers(room) {
  return [...room.players.values()].filter((player) => player.connected);
}

function roomLobbyPayload(room) {
  return {
    code: room.code,
    status: room.status,
    hostSessionId: room.hostSessionId,
    players: [...room.players.values()]
      .sort((a, b) => a.slot - b.slot)
      .map(publicPlayer),
    requiredPlayers: MAX_PLAYERS,
  };
}

function emitLobby(room) {
  io.to(room.code).emit('lobbyState', roomLobbyPayload(room));
}

function freeSlot(room) {
  const used = new Set([...room.players.values()].map((player) => player.slot));
  for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  return -1;
}

function makeEnemies() {
  const enemies = [];
  for (let i = 0; i < 18; i += 1) {
    const seed = (i * 97 + 31) % 211;
    const y = FLOOR_TOP + 60 + ((seed * 13) % 285);
    enemies.push({
      id: i,
      x: 700 + i * 142 + ((seed % 7) - 3) * 11,
      y,
      baseY: y,
      vx: 0,
      vy: 0,
      radius: 22,
      phase: seed / 17,
      speed: 72 + (seed % 24),
      alert: 0,
      stun: 0,
    });
  }
  return enemies;
}

function makeTraps() {
  return [
    [930, 220, 62],
    [1240, 372, 70],
    [1570, 235, 64],
    [1910, 395, 76],
    [2240, 245, 66],
    [2570, 405, 72],
    [2860, 305, 64],
  ].map(([x, y, radius], id) => ({ id, x, y, radius }));
}

function resetPlayerForMatch(player) {
  const spawns = [
    [160, 245],
    [220, 330],
    [300, 210],
    [360, 390],
  ];
  const [x, y] = spawns[player.slot];
  player.x = x;
  player.y = y;
  player.vx = 0;
  player.vy = 0;
  player.facing = 1;
  player.dashCooldown = 0;
  player.invuln = 1.5;
  player.input = { up: false, down: false, left: false, right: false };
}

function startMatch(room) {
  for (const player of room.players.values()) resetPlayerForMatch(player);
  const first = [...room.players.values()].sort((a, b) => a.slot - b.slot)[0];
  room.status = 'playing';
  room.game = {
    remaining: MATCH_SECONDS,
    lives: 3,
    score: 0,
    passes: 0,
    combo: 0,
    checkpoint: 160,
    winner: false,
    result: null,
    enemies: makeEnemies(),
    traps: makeTraps(),
    ball: {
      holderSessionId: first.sessionId,
      inFlight: false,
      fromX: first.x,
      fromY: first.y - 25,
      targetSessionId: null,
      t: 0,
      duration: 0.35,
      x: first.x,
      y: first.y - 25,
    },
  };
  io.to(room.code).emit('matchStarted', { code: room.code });
  emitSnapshot(room);
}

function endMatch(room, result) {
  if (room.status !== 'playing') return;
  room.status = 'ended';
  room.game.result = result;
  io.to(room.code).emit('matchEnded', {
    result,
    score: Math.floor(room.game.score),
    passes: room.game.passes,
    remaining: Math.max(0, room.game.remaining),
  });
  emitLobby(room);
}

function choosePassTarget(room, holder) {
  const candidates = connectedPlayers(room).filter((player) => player.sessionId !== holder.sessionId);
  let best = null;
  let bestScore = -Infinity;

  for (const player of candidates) {
    const dx = player.x - holder.x;
    const dy = Math.abs(player.y - holder.y);
    const d = distance(player, holder);
    if (d > 470) continue;
    const forwardBonus = dx * holder.facing > -30 ? 180 : -100;
    const score = forwardBonus + dx * holder.facing * 1.25 - dy * 0.7 - d * 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = player;
    }
  }

  if (!best) {
    for (const player of candidates) {
      const d = distance(player, holder);
      if (d < 390 && -d > bestScore) {
        bestScore = -d;
        best = player;
      }
    }
  }
  return best;
}

function performPass(room, sessionId) {
  if (room.status !== 'playing' || !room.game) return;
  const ball = room.game.ball;
  if (ball.inFlight || ball.holderSessionId !== sessionId) return;
  const holder = room.players.get(sessionId);
  if (!holder || !holder.connected) return;
  const target = choosePassTarget(room, holder);
  if (!target) return;

  ball.inFlight = true;
  ball.fromX = holder.x;
  ball.fromY = holder.y - 25;
  ball.targetSessionId = target.sessionId;
  ball.t = 0;
  ball.duration = clamp(distance(holder, target) / 760, 0.24, 0.58);
  room.game.combo += 1;
  room.game.passes += 1;
  room.game.score += 30 + room.game.combo * 8;
  io.to(room.code).emit('gameEffect', {
    type: 'pass',
    x: holder.x,
    y: holder.y - 20,
    color: '#ffe26f',
  });
}

function performDash(room, sessionId) {
  if (room.status !== 'playing') return;
  const player = room.players.get(sessionId);
  if (!player || !player.connected || player.dashCooldown > 0) return;

  let dx = Number(player.input.right) - Number(player.input.left);
  let dy = Number(player.input.down) - Number(player.input.up);
  if (dx === 0 && dy === 0) dx = player.facing || 1;
  const magnitude = Math.hypot(dx, dy) || 1;
  player.vx += (dx / magnitude) * 500;
  player.vy += (dy / magnitude) * 500;
  player.dashCooldown = 2.4;
  io.to(room.code).emit('gameEffect', {
    type: 'dash',
    x: player.x,
    y: player.y,
    color: player.color,
  });
}

function loseLife(room, player) {
  if (!room.game || player.invuln > 0) return;
  room.game.lives -= 1;
  room.game.combo = 0;
  room.game.score = Math.max(0, room.game.score - 120);
  player.invuln = 2;
  player.x = Math.max(room.game.checkpoint, player.x - 150);
  player.y = 300;
  player.vx = -180;
  player.vy = 0;
  io.to(room.code).emit('gameEffect', {
    type: 'hit',
    x: player.x,
    y: player.y,
    color: '#ff6b65',
  });
  if (room.game.lives <= 0) endMatch(room, 'lost');
}

function updatePlayer(room, player, dt) {
  if (!player.connected) return;
  player.dashCooldown = Math.max(0, player.dashCooldown - dt);
  player.invuln = Math.max(0, player.invuln - dt);

  // Prevent a stuck key from moving a disconnected or inactive browser forever.
  if (Date.now() - player.lastInputAt > 2000) {
    player.input = { up: false, down: false, left: false, right: false };
  }

  let ax = Number(player.input.right) - Number(player.input.left);
  let ay = Number(player.input.down) - Number(player.input.up);
  const magnitude = Math.hypot(ax, ay);
  if (magnitude > 0) {
    ax /= magnitude;
    ay /= magnitude;
    player.vx += ax * 900 * dt;
    player.vy += ay * 900 * dt;
    if (Math.abs(ax) > 0.1) player.facing = Math.sign(ax);
  }

  const friction = Math.pow(0.0018, dt);
  player.vx *= friction;
  player.vy *= friction;
  const speed = Math.hypot(player.vx, player.vy);
  const maxSpeed = 235;
  if (speed > maxSpeed) {
    player.vx = (player.vx / speed) * maxSpeed;
    player.vy = (player.vy / speed) * maxSpeed;
  }

  player.x += player.vx * dt;
  player.y += player.vy * dt;
  player.x = clamp(player.x, 35, WORLD_W - 70);
  player.y = clamp(player.y, FLOOR_TOP + 35, FLOOR_BOTTOM - 18);

  for (const trap of room.game.traps) {
    const d = Math.hypot(player.x - trap.x, player.y - trap.y);
    if (d < trap.radius) {
      const strength = clamp((trap.radius - d) / trap.radius, 0, 1);
      const slow = Math.max(0.2, 1 - dt * (2.8 + strength * 2));
      player.vx *= slow;
      player.vy *= slow;
    }
  }
}

function updateBall(room, dt) {
  const game = room.game;
  const ball = game.ball;
  if (!ball.inFlight) {
    const holder = room.players.get(ball.holderSessionId);
    if (!holder) return;
    ball.x = holder.x + holder.facing * 8;
    ball.y = holder.y - 25;
    game.checkpoint = Math.max(game.checkpoint, holder.x - 120);
    if (holder.x > WORLD_W - 150) {
      game.score += game.remaining * 18 + game.lives * 220 + game.combo * 60;
      endMatch(room, 'won');
    }
    return;
  }

  const target = room.players.get(ball.targetSessionId);
  if (!target || !target.connected) {
    ball.inFlight = false;
    ball.targetSessionId = null;
    return;
  }

  ball.t += dt / ball.duration;
  const t = clamp(ball.t, 0, 1);
  const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  ball.x = ball.fromX + (target.x - ball.fromX) * eased;
  ball.y = ball.fromY + (target.y - 25 - ball.fromY) * eased - Math.sin(Math.PI * t) * 70;

  for (const enemy of game.enemies) {
    if (enemy.stun <= 0 && Math.hypot(enemy.x - ball.x, enemy.y - ball.y) < enemy.radius + 10) {
      const previousHolder = room.players.get(ball.holderSessionId);
      ball.inFlight = false;
      ball.targetSessionId = null;
      game.combo = 0;
      game.score = Math.max(0, game.score - 70);
      enemy.stun = 0.9;
      if (previousHolder) {
        previousHolder.x = Math.max(game.checkpoint, previousHolder.x - 100);
        previousHolder.y = clamp(previousHolder.y, FLOOR_TOP + 35, FLOOR_BOTTOM - 18);
      }
      io.to(room.code).emit('gameEffect', {
        type: 'intercept',
        x: enemy.x,
        y: enemy.y,
        color: '#d8794d',
      });
      return;
    }
  }

  if (t >= 1) {
    ball.inFlight = false;
    ball.holderSessionId = target.sessionId;
    ball.targetSessionId = null;
    game.score += 55 + game.combo * 12;
    io.to(room.code).emit('gameEffect', {
      type: 'catch',
      x: target.x,
      y: target.y - 20,
      color: '#ffe778',
    });
  }
}

function updateEnemies(room, dt) {
  const game = room.game;
  const ballHolder = room.players.get(game.ball.holderSessionId);
  if (!ballHolder) return;

  for (const enemy of game.enemies) {
    enemy.phase += dt;
    enemy.stun = Math.max(0, enemy.stun - dt);
    const dx = ballHolder.x - enemy.x;
    const dy = ballHolder.y - enemy.y;
    const d = Math.hypot(dx, dy);

    if (enemy.stun > 0) {
      enemy.vx *= 0.9;
      enemy.vy *= 0.9;
    } else if (d < 360) {
      enemy.alert = 1;
      enemy.vx += (dx / (d || 1)) * enemy.speed * 2.5 * dt;
      enemy.vy += (dy / (d || 1)) * enemy.speed * 2.5 * dt;
    } else {
      enemy.alert = Math.max(0, enemy.alert - dt * 1.5);
      enemy.vx += Math.sin(enemy.phase * 1.4) * 25 * dt;
      enemy.vy += (enemy.baseY + Math.sin(enemy.phase) * 45 - enemy.y) * 0.9 * dt;
    }

    enemy.vx *= Math.pow(0.09, dt);
    enemy.vy *= Math.pow(0.09, dt);
    enemy.x += enemy.vx * dt;
    enemy.y += enemy.vy * dt;
    enemy.y = clamp(enemy.y, FLOOR_TOP + 35, FLOOR_BOTTOM - 18);

    if (
      !game.ball.inFlight &&
      Math.hypot(enemy.x - ballHolder.x, enemy.y - ballHolder.y) < enemy.radius + 16
    ) {
      loseLife(room, ballHolder);
      enemy.stun = 0.8;
      if (room.status !== 'playing') return;
    }
  }
}

function emitSnapshot(room) {
  if (!room.game) return;
  const game = room.game;
  io.to(room.code).emit('snapshot', {
    serverTime: Date.now(),
    status: room.status,
    worldWidth: WORLD_W,
    remaining: game.remaining,
    lives: game.lives,
    score: Math.floor(game.score),
    passes: game.passes,
    combo: game.combo,
    checkpoint: game.checkpoint,
    players: [...room.players.values()].sort((a, b) => a.slot - b.slot).map(publicPlayer),
    enemies: game.enemies.map((enemy) => ({
      id: enemy.id,
      x: enemy.x,
      y: enemy.y,
      alert: enemy.alert,
      stun: enemy.stun,
    })),
    traps: game.traps,
    ball: game.ball,
  });
}

function updateRoom(room, dt) {
  if (room.status !== 'playing' || !room.game) return;
  room.game.remaining -= dt;
  if (room.game.remaining <= 0) {
    room.game.remaining = 0;
    endMatch(room, 'lost');
    return;
  }

  for (const player of room.players.values()) updatePlayer(room, player, dt);
  updateBall(room, dt);
  if (room.status !== 'playing') return;
  updateEnemies(room, dt);
  room.game.score += dt * 1.2;
}

function findRoomForSocket(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function bindPlayerToSocket(socket, room, player) {
  player.socketId = socket.id;
  player.connected = true;
  player.lastInputAt = Date.now();
  socket.data.roomCode = room.code;
  socket.data.sessionId = player.sessionId;
  socket.join(room.code);
  socket.emit('joinedRoom', {
    code: room.code,
    sessionId: player.sessionId,
    slot: player.slot,
    isHost: room.hostSessionId === player.sessionId,
  });
  emitLobby(room);
  if (room.status === 'playing') emitSnapshot(room);
}

function leaveCurrentRoom(socket, immediate = false) {
  const room = findRoomForSocket(socket);
  const sessionId = socket.data.sessionId;
  if (!room || !sessionId) return;
  const player = room.players.get(sessionId);
  if (!player || player.socketId !== socket.id) return;

  player.connected = false;
  player.socketId = null;
  player.input = { up: false, down: false, left: false, right: false };
  socket.leave(room.code);

  if (room.hostSessionId === sessionId) {
    const replacement = connectedPlayers(room).sort((a, b) => a.slot - b.slot)[0];
    if (replacement) room.hostSessionId = replacement.sessionId;
  }

  emitLobby(room);
  io.to(room.code).emit('roomNotice', `${player.name} đã mất kết nối.`);

  const removePlayer = () => {
    const currentRoom = rooms.get(room.code);
    const currentPlayer = currentRoom?.players.get(sessionId);
    if (!currentRoom || !currentPlayer || currentPlayer.connected) return;
    currentRoom.players.delete(sessionId);
    if (currentRoom.players.size === 0) {
      rooms.delete(currentRoom.code);
      return;
    }
    if (!currentRoom.players.has(currentRoom.hostSessionId)) {
      const replacement = [...currentRoom.players.values()].sort((a, b) => a.slot - b.slot)[0];
      currentRoom.hostSessionId = replacement.sessionId;
    }
    emitLobby(currentRoom);
  };

  if (immediate) removePlayer();
  else setTimeout(removePlayer, 30000);

  socket.data.roomCode = null;
  socket.data.sessionId = null;
}

io.on('connection', (socket) => {
  socket.on('createRoom', (payload = {}, acknowledge = () => {}) => {
    try {
      leaveCurrentRoom(socket, true);
      const sessionId = sanitizeSessionId(payload.sessionId);
      if (!sessionId) return acknowledge({ ok: false, error: 'Phiên người chơi không hợp lệ.' });
      const code = generateRoomCode();
      const room = {
        code,
        status: 'lobby',
        hostSessionId: sessionId,
        players: new Map(),
        game: null,
        snapshotAccumulator: 0,
        createdAt: Date.now(),
      };
      const player = createPlayer(sessionId, socket.id, payload.name, 0);
      room.players.set(sessionId, player);
      rooms.set(code, room);
      bindPlayerToSocket(socket, room, player);
      acknowledge({ ok: true, code });
    } catch (error) {
      console.error(error);
      acknowledge({ ok: false, error: 'Không thể tạo phòng.' });
    }
  });

  socket.on('joinRoom', (payload = {}, acknowledge = () => {}) => {
    const code = sanitizeRoomCode(payload.code);
    const sessionId = sanitizeSessionId(payload.sessionId);
    const room = rooms.get(code);
    if (!room) return acknowledge({ ok: false, error: 'Không tìm thấy phòng.' });
    if (!sessionId) return acknowledge({ ok: false, error: 'Phiên người chơi không hợp lệ.' });

    leaveCurrentRoom(socket, true);
    let player = room.players.get(sessionId);
    if (player) {
      player.name = sanitizeName(payload.name || player.name);
      bindPlayerToSocket(socket, room, player);
      return acknowledge({ ok: true, code, reconnected: true });
    }

    if (room.status !== 'lobby') {
      return acknowledge({ ok: false, error: 'Trận đã bắt đầu. Chỉ người chơi cũ mới có thể vào lại.' });
    }
    if (room.players.size >= MAX_PLAYERS) {
      return acknowledge({ ok: false, error: 'Phòng đã đủ bốn người.' });
    }
    const slot = freeSlot(room);
    if (slot < 0) return acknowledge({ ok: false, error: 'Phòng đã đầy.' });
    player = createPlayer(sessionId, socket.id, payload.name, slot);
    room.players.set(sessionId, player);
    bindPlayerToSocket(socket, room, player);
    io.to(room.code).emit('roomNotice', `${player.name} đã vào phòng.`);
    acknowledge({ ok: true, code });
  });

  socket.on('startMatch', (_payload, acknowledge = () => {}) => {
    const room = findRoomForSocket(socket);
    if (!room) return acknowledge({ ok: false, error: 'Bạn chưa ở trong phòng.' });
    if (room.hostSessionId !== socket.data.sessionId) {
      return acknowledge({ ok: false, error: 'Chỉ chủ phòng mới được bắt đầu.' });
    }
    if (room.status === 'playing') return acknowledge({ ok: false, error: 'Trận đang diễn ra.' });
    if (connectedPlayers(room).length !== MAX_PLAYERS) {
      return acknowledge({ ok: false, error: 'Cần đúng bốn người đang online để bắt đầu.' });
    }
    startMatch(room);
    acknowledge({ ok: true });
  });

  socket.on('returnToLobby', (_payload, acknowledge = () => {}) => {
    const room = findRoomForSocket(socket);
    if (!room) return acknowledge({ ok: false, error: 'Bạn chưa ở trong phòng.' });
    if (room.hostSessionId !== socket.data.sessionId) {
      return acknowledge({ ok: false, error: 'Chỉ chủ phòng mới được đưa cả đội về sảnh.' });
    }
    room.status = 'lobby';
    room.game = null;
    emitLobby(room);
    io.to(room.code).emit('returnedToLobby');
    acknowledge({ ok: true });
  });

  socket.on('input', (payload = {}) => {
    const room = findRoomForSocket(socket);
    const player = room?.players.get(socket.data.sessionId);
    if (!room || !player || player.socketId !== socket.id) return;
    player.input = {
      up: Boolean(payload.up),
      down: Boolean(payload.down),
      left: Boolean(payload.left),
      right: Boolean(payload.right),
    };
    player.lastInputAt = Date.now();
  });

  socket.on('action', (payload = {}) => {
    const room = findRoomForSocket(socket);
    if (!room) return;
    if (payload.type === 'pass') performPass(room, socket.data.sessionId);
    if (payload.type === 'dash') performDash(room, socket.data.sessionId);
  });

  socket.on('leaveRoom', () => leaveCurrentRoom(socket, true));
  socket.on('disconnect', () => leaveCurrentRoom(socket, false));
});

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = clamp((now - lastTick) / 1000, 0, 0.08);
  lastTick = now;

  for (const room of rooms.values()) {
    updateRoom(room, dt);
    room.snapshotAccumulator += dt;
    if (room.status === 'playing' && room.snapshotAccumulator >= 1 / SNAPSHOT_RATE) {
      room.snapshotAccumulator = 0;
      emitSnapshot(room);
    }
  }
}, 1000 / TICK_RATE);

server.listen(PORT, HOST, () => {
  console.log(`Pyramid Pass Online listening on http://${HOST}:${PORT}`);
});
