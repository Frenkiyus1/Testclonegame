(() => {
  'use strict';

  const socket = io({ autoConnect: true });
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const FLOOR_TOP = 138;
  const FLOOR_BOTTOM = 500;

  const ui = {
    connectionBadge: document.getElementById('connectionBadge'),
    landingOverlay: document.getElementById('landingOverlay'),
    lobbyOverlay: document.getElementById('lobbyOverlay'),
    endOverlay: document.getElementById('endOverlay'),
    hud: document.getElementById('hud'),
    mobileControls: document.getElementById('mobileControls'),
    playerName: document.getElementById('playerName'),
    roomCodeInput: document.getElementById('roomCodeInput'),
    createRoomBtn: document.getElementById('createRoomBtn'),
    joinRoomBtn: document.getElementById('joinRoomBtn'),
    landingError: document.getElementById('landingError'),
    roomCodeDisplay: document.getElementById('roomCodeDisplay'),
    copyInviteBtn: document.getElementById('copyInviteBtn'),
    playersGrid: document.getElementById('playersGrid'),
    lobbyStatus: document.getElementById('lobbyStatus'),
    lobbyError: document.getElementById('lobbyError'),
    startMatchBtn: document.getElementById('startMatchBtn'),
    leaveRoomBtn: document.getElementById('leaveRoomBtn'),
    returnLobbyBtn: document.getElementById('returnLobbyBtn'),
    roomHud: document.getElementById('roomHud'),
    timeHud: document.getElementById('timeHud'),
    scoreHud: document.getElementById('scoreHud'),
    livesHud: document.getElementById('livesHud'),
    objective: document.getElementById('objective'),
    endEyebrow: document.getElementById('endEyebrow'),
    endTitle: document.getElementById('endTitle'),
    endSummary: document.getElementById('endSummary'),
    endScore: document.getElementById('endScore'),
    endPasses: document.getElementById('endPasses'),
    hostOnlyNote: document.getElementById('hostOnlyNote'),
    toast: document.getElementById('toast'),
  };

  const sessionId = getOrCreateSessionId();
  let currentRoom = null;
  let currentLobby = null;
  let mySlot = null;
  let isHost = false;
  let joined = false;
  let gameActive = false;
  let snapshot = null;
  let cameraX = 0;
  let lastFrame = performance.now();
  let shake = 0;
  let redFlash = 0;
  let toastTimer = null;
  let reconnecting = false;
  let audioContext = null;

  const renderPlayers = new Map();
  const renderEnemies = new Map();
  const particles = [];
  const input = { up: false, down: false, left: false, right: false };
  let lastSentInput = '';

  const playerNameSaved = localStorage.getItem('pyramidPassName');
  if (playerNameSaved) ui.playerName.value = playerNameSaved;
  const roomFromUrl = new URLSearchParams(location.search).get('room');
  if (roomFromUrl) ui.roomCodeInput.value = normalizeRoomCode(roomFromUrl);

  function getOrCreateSessionId() {
    let value = localStorage.getItem('pyramidPassSessionId');
    if (!value) {
      value = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem('pyramidPassSessionId', value);
    }
    return value;
  }

  function normalizeRoomCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  }

  function getName() {
    const name = ui.playerName.value.trim().replace(/\s+/g, ' ').slice(0, 16);
    if (name) localStorage.setItem('pyramidPassName', name);
    return name || 'Explorer';
  }

  function showOnly(overlay) {
    ui.landingOverlay.classList.toggle('hidden', overlay !== ui.landingOverlay);
    ui.lobbyOverlay.classList.toggle('hidden', overlay !== ui.lobbyOverlay);
    ui.endOverlay.classList.toggle('hidden', overlay !== ui.endOverlay);
  }

  function showToast(message, duration = 2200) {
    clearTimeout(toastTimer);
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), duration);
  }

  function setError(element, message = '') {
    element.textContent = message;
  }

  function setButtonsBusy(busy) {
    ui.createRoomBtn.disabled = busy;
    ui.joinRoomBtn.disabled = busy;
  }

  function joinPayload(code) {
    return {
      code: normalizeRoomCode(code),
      name: getName(),
      sessionId,
    };
  }

  function createRoom() {
    setError(ui.landingError);
    setButtonsBusy(true);
    socket.emit('createRoom', { name: getName(), sessionId }, (response) => {
      setButtonsBusy(false);
      if (!response?.ok) return setError(ui.landingError, response?.error || 'Không thể tạo phòng.');
      currentRoom = response.code;
      joined = true;
      history.replaceState({}, '', `?room=${currentRoom}`);
    });
  }

  function joinRoom(code = ui.roomCodeInput.value) {
    const normalized = normalizeRoomCode(code);
    if (normalized.length !== 5) {
      setError(ui.landingError, 'Mã phòng phải có đúng 5 ký tự.');
      return;
    }
    setError(ui.landingError);
    setButtonsBusy(true);
    socket.emit('joinRoom', joinPayload(normalized), (response) => {
      setButtonsBusy(false);
      if (!response?.ok) return setError(ui.landingError, response?.error || 'Không thể vào phòng.');
      currentRoom = response.code;
      joined = true;
      history.replaceState({}, '', `?room=${currentRoom}`);
    });
  }

  function leaveRoom() {
    socket.emit('leaveRoom');
    currentRoom = null;
    currentLobby = null;
    joined = false;
    gameActive = false;
    snapshot = null;
    renderPlayers.clear();
    renderEnemies.clear();
    ui.hud.classList.add('hidden');
    ui.mobileControls.classList.add('hidden');
    showOnly(ui.landingOverlay);
    history.replaceState({}, '', location.pathname);
  }

  function renderLobby(lobby) {
    currentLobby = lobby;
    currentRoom = lobby.code;
    joined = true;
    isHost = lobby.hostSessionId === sessionId;
    ui.roomCodeDisplay.textContent = lobby.code;
    ui.roomHud.textContent = `Phòng ${lobby.code}`;
    ui.playersGrid.innerHTML = '';

    const bySlot = new Map(lobby.players.map((player) => [player.slot, player]));
    for (let slot = 0; slot < lobby.requiredPlayers; slot += 1) {
      const player = bySlot.get(slot);
      const card = document.createElement('div');
      card.className = `player-card${player ? '' : ' empty'}`;
      if (!player) {
        card.innerHTML = `
          <div class="player-avatar" style="background:#33465b">P${slot + 1}</div>
          <div class="player-info"><strong>Đang chờ…</strong><span>Vị trí còn trống</span></div>`;
      } else {
        const hostMark = lobby.hostSessionId === player.sessionId ? ' · Chủ phòng' : '';
        const youMark = player.sessionId === sessionId ? ' · Bạn' : '';
        const connectionClass = player.connected ? 'online-dot' : 'offline-dot';
        const connectionText = player.connected ? 'Online' : 'Mất kết nối';
        card.innerHTML = `
          <div class="player-avatar" style="background:${player.color}">P${slot + 1}</div>
          <div class="player-info">
            <strong>${escapeHtml(player.name)}</strong>
            <span class="${connectionClass}">${connectionText}${hostMark}${youMark}</span>
          </div>`;
      }
      ui.playersGrid.appendChild(card);
    }

    const onlineCount = lobby.players.filter((player) => player.connected).length;
    const missing = lobby.requiredPlayers - onlineCount;
    ui.lobbyStatus.textContent = missing === 0
      ? 'Đã đủ bốn người. Chủ phòng có thể bắt đầu.'
      : `Đang chờ ${missing} người còn lại…`;
    ui.startMatchBtn.disabled = !isHost || missing !== 0;
    ui.startMatchBtn.textContent = isHost
      ? (missing === 0 ? 'Bắt đầu trận đấu' : 'Bắt đầu khi đủ 4 người')
      : 'Đang chờ chủ phòng';

    if (!gameActive && lobby.status === 'lobby') showOnly(ui.lobbyOverlay);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    }[char]));
  }

  function startMatch() {
    setError(ui.lobbyError);
    socket.emit('startMatch', {}, (response) => {
      if (!response?.ok) setError(ui.lobbyError, response?.error || 'Không thể bắt đầu trận.');
    });
  }

  function returnToLobby() {
    socket.emit('returnToLobby', {}, (response) => {
      if (!response?.ok) showToast(response?.error || 'Không thể về phòng chờ.');
    });
  }

  function copyInvite() {
    const inviteUrl = `${location.origin}${location.pathname}?room=${currentRoom}`;
    navigator.clipboard?.writeText(inviteUrl)
      .then(() => showToast('Đã sao chép link mời.'))
      .catch(() => window.prompt('Sao chép link này:', inviteUrl));
  }

  function beginGameView() {
    gameActive = true;
    showOnly(null);
    ui.hud.classList.remove('hidden');
    ui.mobileControls.classList.remove('hidden');
    ui.objective.textContent = `Bạn là P${mySlot + 1}. Đưa Mặt Trời Vàng đến ngôi đền.`;
    snapshot = null;
    renderPlayers.clear();
    renderEnemies.clear();
    particles.length = 0;
    beep(520, .1, 'triangle', .04);
  }

  function endGameView(data) {
    gameActive = false;
    ui.mobileControls.classList.add('hidden');
    ui.endScore.textContent = data.score;
    ui.endPasses.textContent = data.passes;
    if (data.result === 'won') {
      ui.endEyebrow.textContent = 'Temple unlocked';
      ui.endTitle.textContent = 'CHIẾN THẮNG!';
      ui.endSummary.textContent = `Cả đội đã đưa báu vật tới đền với ${Math.ceil(data.remaining)} giây còn lại.`;
      beep(659, .14, 'triangle', .05);
      setTimeout(() => beep(784, .18, 'triangle', .05), 130);
      setTimeout(() => beep(988, .25, 'triangle', .05), 260);
    } else {
      ui.endEyebrow.textContent = 'The desert wins';
      ui.endTitle.textContent = 'HẾT LƯỢT';
      ui.endSummary.textContent = 'Hãy chuyền sớm hơn và dùng lướt khi xác ướp áp sát người giữ báu vật.';
      beep(170, .3, 'sawtooth', .04);
    }
    ui.returnLobbyBtn.disabled = !isHost;
    ui.returnLobbyBtn.textContent = isHost ? 'Về phòng chờ' : 'Chờ chủ phòng';
    ui.hostOnlyNote.textContent = isHost ? '' : 'Chỉ chủ phòng có thể đưa cả đội về sảnh.';
    showOnly(ui.endOverlay);
  }

  function beep(frequency = 440, duration = .08, type = 'sine', volume = .03) {
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      gain.gain.value = volume;
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start();
      gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + duration);
      oscillator.stop(audioContext.currentTime + duration);
    } catch (_error) {}
  }

  function sendInput(force = false) {
    if (!joined || !gameActive) return;
    const serialized = JSON.stringify(input);
    if (!force && serialized === lastSentInput) return;
    lastSentInput = serialized;
    socket.emit('input', input);
  }

  function setInput(control, value) {
    if (input[control] === value) return;
    input[control] = value;
    sendInput();
  }

  function action(type) {
    if (!gameActive) return;
    socket.emit('action', { type });
    if (type === 'pass') beep(420, .05, 'triangle', .025);
    if (type === 'dash') beep(220, .06, 'sawtooth', .022);
  }

  socket.on('connect', () => {
    ui.connectionBadge.textContent = '● Online';
    ui.connectionBadge.className = 'connection online';
    if (reconnecting && currentRoom && joined) {
      socket.emit('joinRoom', joinPayload(currentRoom), (response) => {
        if (!response?.ok) {
          joined = false;
          gameActive = false;
          showOnly(ui.landingOverlay);
          setError(ui.landingError, response?.error || 'Không thể vào lại phòng.');
        }
      });
    }
    reconnecting = false;
  });

  socket.on('disconnect', () => {
    ui.connectionBadge.textContent = '● Mất kết nối';
    ui.connectionBadge.className = 'connection offline';
    reconnecting = true;
    showToast('Mất kết nối, đang thử nối lại…', 4000);
  });

  socket.on('joinedRoom', (data) => {
    currentRoom = data.code;
    mySlot = data.slot;
    isHost = data.isHost;
    joined = true;
    ui.roomHud.textContent = `Phòng ${data.code}`;
    history.replaceState({}, '', `?room=${data.code}`);
  });

  socket.on('lobbyState', (data) => renderLobby(data));
  socket.on('roomNotice', (message) => showToast(message));
  socket.on('matchStarted', () => beginGameView());
  socket.on('snapshot', (data) => {
    if (!gameActive && data.status === 'playing') beginGameView();
    receiveSnapshot(data);
  });
  socket.on('matchEnded', (data) => endGameView(data));
  socket.on('returnedToLobby', () => {
    gameActive = false;
    snapshot = null;
    ui.hud.classList.add('hidden');
    ui.mobileControls.classList.add('hidden');
    if (currentLobby) renderLobby(currentLobby);
  });

  socket.on('gameEffect', (effect) => {
    if (!effect) return;
    const amounts = { pass: 10, catch: 14, dash: 18, hit: 24, intercept: 18 };
    spawnParticles(effect.x, effect.y, effect.color || '#fff', amounts[effect.type] || 10, effect.type === 'hit' ? 220 : 140);
    if (effect.type === 'hit') {
      shake = 12;
      redFlash = .42;
      beep(125, .2, 'square', .04);
    }
    if (effect.type === 'catch') beep(610, .06, 'triangle', .03);
    if (effect.type === 'intercept') beep(150, .12, 'sawtooth', .035);
  });

  function receiveSnapshot(data) {
    snapshot = data;
    ui.timeHud.textContent = `⏱ ${Math.max(0, Math.ceil(data.remaining))}`;
    ui.scoreHud.textContent = `⭐ ${data.score}`;
    ui.livesHud.textContent = `${'❤'.repeat(Math.max(0, data.lives))}${'♡'.repeat(Math.max(0, 3 - data.lives))}`;

    for (const player of data.players) {
      const existing = renderPlayers.get(player.sessionId);
      if (!existing) renderPlayers.set(player.sessionId, { ...player, tx: player.x, ty: player.y, trail: [] });
      else Object.assign(existing, { ...player, tx: player.x, ty: player.y });
    }
    for (const enemy of data.enemies) {
      const existing = renderEnemies.get(enemy.id);
      if (!existing) renderEnemies.set(enemy.id, { ...enemy, tx: enemy.x, ty: enemy.y });
      else Object.assign(existing, { ...enemy, tx: enemy.x, ty: enemy.y });
    }
  }

  function spawnParticles(x, y, color, count = 12, speed = 140) {
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const magnitude = speed * (.35 + Math.random() * .65);
      particles.push({
        x, y,
        vx: Math.cos(angle) * magnitude,
        vy: Math.sin(angle) * magnitude,
        life: .35 + Math.random() * .5,
        size: 2 + Math.random() * 5,
        color,
      });
    }
  }

  function updateVisuals(dt) {
    const smoothing = 1 - Math.pow(.00008, dt);
    for (const player of renderPlayers.values()) {
      player.x += (player.tx - player.x) * smoothing;
      player.y += (player.ty - player.y) * smoothing;
      player.trail ||= [];
      player.trail.unshift({ x: player.x, y: player.y });
      if (player.trail.length > 7) player.trail.pop();
    }
    for (const enemy of renderEnemies.values()) {
      enemy.x += (enemy.tx - enemy.x) * smoothing;
      enemy.y += (enemy.ty - enemy.y) * smoothing;
    }

    const me = renderPlayers.get(sessionId);
    if (me && snapshot) {
      const target = clamp(me.x - W * .34, 0, snapshot.worldWidth - W);
      cameraX += (target - cameraX) * (1 - Math.pow(.001, dt));
    }

    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const particle = particles[i];
      particle.life -= dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vx *= Math.pow(.14, dt);
      particle.vy *= Math.pow(.14, dt);
      particle.vy += 120 * dt;
      if (particle.life <= 0) particles.splice(i, 1);
    }

    shake = Math.max(0, shake - dt * 34);
    redFlash = Math.max(0, redFlash - dt);
  }

  function drawSky(now) {
    const gradient = ctx.createLinearGradient(0, 0, 0, H);
    gradient.addColorStop(0, '#143055');
    gradient.addColorStop(.48, '#d76e48');
    gradient.addColorStop(.7, '#efb85d');
    gradient.addColorStop(1, '#d89c48');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);

    const sunX = 760 - cameraX * .05;
    const sunY = 105;
    const glow = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, 95);
    glow.addColorStop(0, 'rgba(255,246,173,1)');
    glow.addColorStop(.2, 'rgba(255,218,94,.9)');
    glow.addColorStop(1, 'rgba(255,203,69,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(sunX, sunY, 95, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffe17a';
    ctx.beginPath(); ctx.arc(sunX, sunY, 29, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,.6)';
    for (let i = 0; i < 36; i += 1) {
      const x = (i * 173 % 1030) - cameraX * .015;
      const y = 18 + (i * 59 % 105);
      ctx.globalAlpha = .2 + .55 * Math.abs(Math.sin(i * 3.7 + now * .001));
      ctx.fillRect(x, y, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#c98245';
    ctx.beginPath(); ctx.moveTo(0, 220);
    for (let x = 0; x <= W + 80; x += 80) {
      const worldX = x + cameraX * .12;
      ctx.quadraticCurveTo(x + 40, 176 + Math.sin(worldX * .004) * 24, x + 80, 220);
    }
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();

    ctx.fillStyle = '#dca451';
    ctx.beginPath(); ctx.moveTo(0, 258);
    for (let x = 0; x <= W + 90; x += 90) {
      const worldX = x + cameraX * .24;
      ctx.quadraticCurveTo(x + 45, 208 + Math.sin(worldX * .005) * 18, x + 90, 258);
    }
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();
  }

  function drawPyramid(x, y, scale) {
    const base = 120 * scale;
    ctx.fillStyle = '#8c522c';
    ctx.beginPath();
    ctx.moveTo(x - base * .56, y + 72 * scale);
    ctx.lineTo(x, y - 30 * scale);
    ctx.lineTo(x + base * .56, y + 72 * scale);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#bd7940';
    ctx.beginPath();
    ctx.moveTo(x, y - 30 * scale);
    ctx.lineTo(x + base * .56, y + 72 * scale);
    ctx.lineTo(x + base * .1, y + 72 * scale);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(62,34,24,.25)';
    ctx.lineWidth = 2;
    for (let i = 1; i < 5; i += 1) {
      const yy = y - 30 * scale + (102 * scale) * (i / 5);
      const half = (yy - (y - 30 * scale)) * base * .56 / (102 * scale);
      ctx.beginPath(); ctx.moveTo(x - half, yy); ctx.lineTo(x + half, yy); ctx.stroke();
    }
  }

  function drawObelisk(x, y, scale) {
    ctx.fillStyle = '#6c4932';
    ctx.fillRect(x - 9 * scale, y + 10 * scale, 18 * scale, 60 * scale);
    ctx.beginPath();
    ctx.moveTo(x - 9 * scale, y + 10 * scale);
    ctx.lineTo(x, y - 8 * scale);
    ctx.lineTo(x + 9 * scale, y + 10 * scale);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#a36d41';
    ctx.fillRect(x, y + 10 * scale, 9 * scale, 60 * scale);
  }

  function drawScenery() {
    const worldWidth = snapshot?.worldWidth || 3300;
    for (let x = 50, i = 0; x < worldWidth; x += 185, i += 1) {
      const offset = ((i * 71) % 101) - 50;
      const worldX = x + offset;
      const screenX = worldX - cameraX * .42;
      if (screenX < -180 || screenX > W + 180) continue;
      const y = 82 + ((i * 43) % 43);
      const scale = .72 + ((i * 29) % 55) / 100;
      if (i % 3 === 0) drawPyramid(screenX, y, scale);
      else if (i % 3 === 1) drawObelisk(screenX, y, scale);
      else {
        ctx.fillStyle = '#7d5234';
        ctx.fillRect(screenX - 28 * scale, y + 25, 56 * scale, 34 * scale);
        ctx.fillStyle = '#b57945';
        ctx.fillRect(screenX - 20 * scale, y + 16, 12 * scale, 43 * scale);
        ctx.fillRect(screenX + 9 * scale, y + 20, 12 * scale, 39 * scale);
      }
    }
  }

  function drawGround() {
    const gradient = ctx.createLinearGradient(0, FLOOR_TOP, 0, H);
    gradient.addColorStop(0, '#e8bc5d');
    gradient.addColorStop(1, '#b96e2d');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, FLOOR_TOP, W, H - FLOOR_TOP);

    for (let i = 0; i < 8; i += 1) {
      const y = FLOOR_TOP + 25 + i * 48;
      ctx.strokeStyle = `rgba(106,62,30,${.05 + i * .009})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = -20; x < W + 30; x += 30) {
        const yy = y + Math.sin((x + cameraX) * .018 + i) * 3;
        if (x === -20) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }

    const worldWidth = snapshot?.worldWidth || 3300;
    const templeX = worldWidth - 105 - cameraX;
    if (templeX > -260 && templeX < W + 260) {
      ctx.fillStyle = '#673d2b'; ctx.fillRect(templeX - 90, 150, 180, 310);
      ctx.fillStyle = '#a56f41'; ctx.fillRect(templeX - 72, 165, 144, 295);
      ctx.fillStyle = '#ddb15d';
      for (let i = -1; i <= 1; i += 1) ctx.fillRect(templeX + i * 50 - 10, 185, 20, 240);
      ctx.fillStyle = '#31231f'; ctx.fillRect(templeX - 34, 270, 68, 190);
      ctx.fillStyle = '#f8cb58'; ctx.beginPath(); ctx.arc(templeX, 243, 17, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#f8e59c'; ctx.lineWidth = 3;
      for (let i = 0; i < 8; i += 1) {
        const angle = i * Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(templeX + Math.cos(angle) * 25, 243 + Math.sin(angle) * 25);
        ctx.lineTo(templeX + Math.cos(angle) * 38, 243 + Math.sin(angle) * 38);
        ctx.stroke();
      }
    }
  }

  function drawTrap(trap, now) {
    const x = trap.x - cameraX;
    if (x < -100 || x > W + 100) return;
    const pulse = .93 + Math.sin(now * .002 + trap.id) * .04;
    ctx.save(); ctx.translate(x, trap.y); ctx.scale(pulse, pulse);
    const gradient = ctx.createRadialGradient(0, 0, 6, 0, 0, trap.radius);
    gradient.addColorStop(0, 'rgba(77,43,25,.7)');
    gradient.addColorStop(.62, 'rgba(139,84,42,.42)');
    gradient.addColorStop(1, 'rgba(100,58,31,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath(); ctx.arc(0, 0, trap.radius, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(78,42,23,.25)'; ctx.lineWidth = 2;
    for (let i = 0; i < 4; i += 1) {
      ctx.beginPath(); ctx.arc(0, 0, trap.radius * (.25 + i * .18), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  function drawShadow(worldX, y, width = 34, height = 10, alpha = .22) {
    ctx.fillStyle = `rgba(59,34,20,${alpha})`;
    ctx.beginPath(); ctx.ellipse(worldX - cameraX, y + 19, width, height, 0, 0, Math.PI * 2); ctx.fill();
  }

  function drawExplorer(player, holderId) {
    const x = player.x - cameraX;
    const y = player.y;
    if (x < -70 || x > W + 70) return;
    const blink = player.invuln > 0 && Math.floor(player.invuln * 10) % 2 === 0;
    ctx.globalAlpha = player.connected ? (blink ? .3 : 1) : .32;
    drawShadow(player.x, player.y, 23, 7, .22);

    if (player.sessionId === holderId) {
      ctx.strokeStyle = `${player.color}66`;
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      player.trail.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x - cameraX, point.y + 8);
        else ctx.lineTo(point.x - cameraX, point.y + 8);
      });
      ctx.stroke();
    }

    ctx.strokeStyle = '#443025'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - 7, y + 10); ctx.lineTo(x - 10, y + 23); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + 7, y + 10); ctx.lineTo(x + 11, y + 23); ctx.stroke();

    ctx.fillStyle = player.color;
    ctx.beginPath();
    ctx.moveTo(x - 15, y - 5); ctx.lineTo(x + 15, y - 5);
    ctx.lineTo(x + 19, y + 14); ctx.lineTo(x - 19, y + 14); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f7d56c'; ctx.fillRect(x - 17, y + 4, 34, 5);
    ctx.fillStyle = '#bb7347'; ctx.beginPath(); ctx.arc(x, y - 18, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f2d6a2';
    ctx.beginPath(); ctx.arc(x, y - 20, 13, Math.PI, Math.PI * 2);
    ctx.lineTo(x + 11, y - 10); ctx.lineTo(x - 11, y - 10); ctx.closePath(); ctx.fill();
    ctx.fillStyle = player.color; ctx.fillRect(x - 13, y - 22, 26, 6);
    ctx.fillStyle = '#2d211c';
    const faceX = (player.facing || 1) * 3;
    ctx.fillRect(x + faceX - 4, y - 18, 3, 2);
    ctx.fillRect(x + faceX + 3, y - 18, 3, 2);

    if (player.sessionId === holderId) {
      ctx.strokeStyle = '#fff5a8'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y - 2, 25, 0, Math.PI * 2); ctx.stroke();
    }
    if (player.sessionId === sessionId) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y - 2, 30, 0, Math.PI * 2); ctx.stroke();
    }

    ctx.textAlign = 'center';
    ctx.font = '900 10px system-ui';
    ctx.fillStyle = '#fff';
    const label = `P${player.slot + 1} ${player.name}${player.sessionId === sessionId ? ' · BẠN' : ''}`;
    ctx.fillText(label, x, y - 43);
    ctx.globalAlpha = 1;
  }

  function drawMummy(enemy) {
    const x = enemy.x - cameraX;
    const y = enemy.y;
    if (x < -80 || x > W + 80) return;
    drawShadow(enemy.x, enemy.y, 24, 8, .25);
    ctx.save(); ctx.translate(x, y);
    if (enemy.stun > 0) ctx.rotate(Math.sin(enemy.stun * 25) * .18);
    ctx.fillStyle = '#d7c7a3';
    ctx.beginPath(); ctx.roundRect(-17, -25, 34, 47, 10); ctx.fill();
    ctx.strokeStyle = '#9b8d73'; ctx.lineWidth = 3;
    for (let yy = -18; yy < 18; yy += 8) {
      ctx.beginPath(); ctx.moveTo(-14, yy); ctx.lineTo(14, yy + 4); ctx.stroke();
    }
    ctx.fillStyle = enemy.alert > 0 ? '#ff564a' : '#72dbd3';
    ctx.fillRect(-8, -15, 5, 3); ctx.fillRect(4, -15, 5, 3);
    ctx.strokeStyle = '#d7c7a3'; ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-13, -4); ctx.lineTo(-27, -11); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(13, -4); ctx.lineTo(28, -9); ctx.stroke();
    ctx.restore();
  }

  function drawBall(now) {
    if (!snapshot?.ball) return;
    let x = snapshot.ball.x;
    let y = snapshot.ball.y;
    if (!snapshot.ball.inFlight) {
      const holder = renderPlayers.get(snapshot.ball.holderSessionId);
      if (holder) {
        x = holder.x + (holder.facing || 1) * 8;
        y = holder.y - 25;
      }
    }
    x -= cameraX;
    const pulse = 1 + Math.sin(now * .005) * .08;
    ctx.save(); ctx.translate(x, y); ctx.scale(pulse, pulse);
    const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 34);
    glow.addColorStop(0, 'rgba(255,249,189,1)');
    glow.addColorStop(.3, 'rgba(255,211,74,.95)');
    glow.addColorStop(1, 'rgba(255,189,45,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, 34, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffd44e'; ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff5b2'; ctx.lineWidth = 2;
    for (let i = 0; i < 8; i += 1) {
      const angle = i * Math.PI / 4 + now * .0008;
      ctx.beginPath(); ctx.moveTo(Math.cos(angle) * 14, Math.sin(angle) * 14);
      ctx.lineTo(Math.cos(angle) * 22, Math.sin(angle) * 22); ctx.stroke();
    }
    ctx.restore();
  }

  function drawParticles() {
    for (const particle of particles) {
      ctx.globalAlpha = clamp(particle.life / .8, 0, 1);
      ctx.fillStyle = particle.color;
      ctx.fillRect(particle.x - cameraX - particle.size / 2, particle.y - particle.size / 2, particle.size, particle.size);
    }
    ctx.globalAlpha = 1;
  }

  function drawMiniMap() {
    if (!snapshot) return;
    const x = 20;
    const y = H - 42;
    const width = W - 40;
    const height = 8;
    ctx.fillStyle = 'rgba(10,20,34,.42)'; ctx.fillRect(x, y, width, height);
    ctx.fillStyle = '#ffd45b';
    const furthest = Math.max(...snapshot.players.map((player) => player.x));
    ctx.fillRect(x, y, clamp(furthest / snapshot.worldWidth, 0, 1) * width, height);
    for (const player of snapshot.players) {
      ctx.fillStyle = player.color;
      ctx.beginPath(); ctx.arc(x + (player.x / snapshot.worldWidth) * width, y + 4, player.sessionId === sessionId ? 6 : 4, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawDashMeter() {
    const me = renderPlayers.get(sessionId);
    if (!me) return;
    const x = 20;
    const y = H - 70;
    const width = 150;
    ctx.fillStyle = 'rgba(8,19,31,.58)'; ctx.fillRect(x, y, width, 12);
    ctx.fillStyle = '#48d0ed'; ctx.fillRect(x, y, width * (1 - clamp(me.dashCooldown / 2.4, 0, 1)), 12);
    ctx.fillStyle = '#fff'; ctx.font = '800 11px system-ui'; ctx.textAlign = 'left'; ctx.fillText('LƯỚT', x + width + 12, y + 10);
  }

  function drawWaitingScene(now) {
    drawSky(now);
    drawScenery();
    drawGround();
    const titleX = W / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(17,34,53,.45)';
    ctx.font = '900 28px system-ui';
    ctx.fillText('PYRAMID PASS ONLINE', titleX, H - 70);
  }

  function drawFrame(now) {
    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - .5) * shake * 2, (Math.random() - .5) * shake * 2);
    drawSky(now);
    drawScenery();
    drawGround();

    if (snapshot) {
      for (const trap of snapshot.traps) drawTrap(trap, now);
      const drawables = [];
      for (const enemy of renderEnemies.values()) drawables.push({ y: enemy.y, type: 'enemy', value: enemy });
      for (const player of renderPlayers.values()) drawables.push({ y: player.y, type: 'player', value: player });
      drawables.sort((a, b) => a.y - b.y);
      for (const item of drawables) {
        if (item.type === 'enemy') drawMummy(item.value);
        else drawExplorer(item.value, snapshot.ball.holderSessionId);
      }
      drawBall(now);
      drawParticles();
      drawMiniMap();
      drawDashMeter();
    }

    if (redFlash > 0) {
      ctx.fillStyle = `rgba(255,78,66,${redFlash * .55})`;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  function frame(now) {
    const dt = Math.min(.04, (now - lastFrame) / 1000 || 0);
    lastFrame = now;
    updateVisuals(dt);
    if (gameActive || snapshot) drawFrame(now);
    else drawWaitingScene(now);
    requestAnimationFrame(frame);
  }

  const movementKeys = {
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
  };

  window.addEventListener('keydown', (event) => {
    const control = movementKeys[event.code];
    if (control) {
      event.preventDefault();
      setInput(control, true);
    }
    if (event.code === 'Space' && !event.repeat) {
      event.preventDefault();
      action('pass');
    }
    if ((event.code === 'ShiftLeft' || event.code === 'ShiftRight') && !event.repeat) {
      event.preventDefault();
      action('dash');
    }
    if (event.code === 'Enter' && !ui.landingOverlay.classList.contains('hidden')) joinRoom();
  });

  window.addEventListener('keyup', (event) => {
    const control = movementKeys[event.code];
    if (control) {
      event.preventDefault();
      setInput(control, false);
    }
  });

  window.addEventListener('blur', () => {
    for (const key of Object.keys(input)) input[key] = false;
    sendInput(true);
  });

  document.querySelectorAll('[data-control]').forEach((button) => {
    const control = button.dataset.control;
    const down = (event) => { event.preventDefault(); setInput(control, true); };
    const up = (event) => { event.preventDefault(); setInput(control, false); };
    button.addEventListener('pointerdown', down);
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
    button.addEventListener('pointerleave', up);
  });

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      action(button.dataset.action);
    });
  });

  ui.roomCodeInput.addEventListener('input', () => {
    ui.roomCodeInput.value = normalizeRoomCode(ui.roomCodeInput.value);
  });
  ui.createRoomBtn.addEventListener('click', createRoom);
  ui.joinRoomBtn.addEventListener('click', () => joinRoom());
  ui.copyInviteBtn.addEventListener('click', copyInvite);
  ui.startMatchBtn.addEventListener('click', startMatch);
  ui.leaveRoomBtn.addEventListener('click', leaveRoom);
  ui.returnLobbyBtn.addEventListener('click', returnToLobby);

  setInterval(() => sendInput(true), 500);
  requestAnimationFrame(frame);
})();
