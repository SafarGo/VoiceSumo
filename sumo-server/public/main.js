// =========================================================
//  SCREAM SUMO — прототип
//  Phaser (рендер+физика) + Socket.io (сервер, WebSocket) + Web Audio (микрофон)
// =========================================================

// ---------- Настройки геймплея (крути их для баланса) ----------
const ARENA_CENTER = { x: 400, y: 300 };
const ARENA_RADIUS = 220;
const PLAYER_RADIUS = 40;
const DASH_COOLDOWN_MS = 300;     // как часто можно "толкаться" криком
const MIN_SCREAM_VOLUME = 0.10;   // порог громкости (0..1), ниже — игнорим
const DASH_FORCE = 260;           // сила толчка при макс. громкости
const DRAG = 0.90;                // "трение" — насколько быстро гасится скорость (0..1 за кадр)
const SPIN_SPEED = 0.05;          // скорость постоянного вращения сумоиста (рад/кадр)

// ---------- Диагностика: показываем ошибки прямо в интерфейсе ----------
window.addEventListener('error', (e) => {
  const el = document.getElementById('status');
  if (el) el.textContent = 'Ошибка скрипта: ' + e.message;
});

// ---------- Состояние сети ----------
let socket = null;
let myIndex = 0; // 0 = создатель комнаты (синий), 1 = присоединившийся (красный)
let remoteState = null; // {x,y,rotation}

// ---------- Состояние микрофона ----------
let audioCtx, analyser, micData;
let currentVolume = 0;

// ---------- Состояние Phaser ----------
let game = null;
let scene = null;
let players = [];
let lastDashTime = 0;
let gameEnded = false;
let volumeText = null;
let networkInterval = null;

// =========================================================
//  UI / DOM
// =========================================================
const uiEl = document.getElementById('ui');
const gameContainerEl = document.getElementById('gameContainer');
const roomCodeBoxEl = document.getElementById('roomCodeBox');
const roomCodeEl = document.getElementById('roomCode');
const statusEl = document.getElementById('status');
const codeInputEl = document.getElementById('codeInput');

document.getElementById('createBtn').addEventListener('click', createRoom);
document.getElementById('joinBtn').addEventListener('click', joinRoom);

let micGranted = false;
let micFlowStarted = false;
let opponentJoined = false;
let opponentMicReady = false;

function connectSocket() {
  if (socket) return socket;
  socket = io(); // подключаемся к тому же серверу, с которого загружена страница
  socket.on('connect_error', () => {
    statusEl.textContent = 'Не удалось подключиться к серверу';
  });
  socket.on('opponent-joined', () => {
    opponentJoined = true;
    updateLobbyStatus();
    beginMicFlow();
  });
  socket.on('peer-mic-ready', () => {
    opponentMicReady = true;
    updateLobbyStatus();
  });
  socket.on('start-game', () => {
    setTimeout(startGame, 300);
  });
  socket.on('join-error', (msg) => {
    statusEl.textContent = msg;
  });
  socket.on('state', (data) => {
    remoteState = data;
  });
  socket.on('end', (data) => {
    if (!gameEnded) finishGame(data.winner);
  });
  socket.on('opponent-left', () => {
    statusEl.textContent = 'Соперник отключился';
  });
  return socket;
}

function updateLobbyStatus() {
  if (!opponentJoined) {
    statusEl.textContent = 'Комната создана. Жду второго игрока...';
  } else if (!micGranted) {
    statusEl.textContent = 'Разреши доступ к микрофону во всплывающем окне браузера...';
  } else if (!opponentMicReady) {
    statusEl.textContent = 'Твой микрофон готов. Жду, пока соперник разрешит свой...';
  } else {
    statusEl.textContent = 'Оба готовы! Запуск игры...';
  }
}

async function beginMicFlow() {
  if (micFlowStarted) return;
  micFlowStarted = true;
  updateLobbyStatus();
  const ok = await initMic();
  if (ok) {
    micGranted = true;
    socket.emit('mic-ready');
    updateLobbyStatus();
  } else {
    statusEl.textContent = 'Доступ к микрофону не получен. Разреши его в настройках браузера и обнови страницу.';
  }
}

function createRoom() {
  const s = connectSocket();
  s.emit('create-room');
  s.once('room-created', ({ code, index }) => {
    myIndex = index;
    roomCodeEl.textContent = code;
    roomCodeBoxEl.classList.remove('hidden');
    updateLobbyStatus();
    beginMicFlow(); // хост запрашивает микрофон сразу, не дожидаясь второго игрока
  });
}

function joinRoom() {
  const code = codeInputEl.value.trim().toLowerCase();
  if (!code) {
    statusEl.textContent = 'Введи код комнаты';
    return;
  }
  const s = connectSocket();
  s.emit('join-room', code);
  s.once('room-joined', ({ index }) => {
    myIndex = index;
    opponentJoined = true;
    updateLobbyStatus();
    beginMicFlow();
  });
}

// =========================================================
//  Микрофон — громкость через Web Audio API (RMS)
// =========================================================
async function initMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    micData = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);
    requestAnimationFrame(sampleMic);
    return true;
  } catch (e) {
    return false;
  }
}

function sampleMic() {
  if (analyser) {
    analyser.getByteTimeDomainData(micData);
    let sumSquares = 0;
    for (let i = 0; i < micData.length; i++) {
      const v = (micData[i] - 128) / 128;
      sumSquares += v * v;
    }
    currentVolume = Math.sqrt(sumSquares / micData.length);
  }
  requestAnimationFrame(sampleMic);
}

// =========================================================
//  Запуск игры
// =========================================================
function startGame() {
  uiEl.classList.add('hidden');
  gameContainerEl.classList.remove('hidden');

  const config = {
    type: Phaser.AUTO,
    width: 800,
    height: 600,
    parent: 'gameContainer',
    backgroundColor: '#10101c',
    physics: { default: 'arcade', arcade: { debug: false } },
    scene: { create, update },
  };
  game = new Phaser.Game(config);
}

function create() {
  scene = this;

  const g = this.add.graphics();
  g.fillStyle(0x3d2817, 1);
  g.fillCircle(ARENA_CENTER.x, ARENA_CENTER.y, ARENA_RADIUS);
  g.lineStyle(6, 0xffd700, 1);
  g.strokeCircle(ARENA_CENTER.x, ARENA_CENTER.y, ARENA_RADIUS);

  const colors = [0x4da6ff, 0xff4d4d];
  const startPositions = [
    { x: ARENA_CENTER.x - 80, y: ARENA_CENTER.y },
    { x: ARENA_CENTER.x + 80, y: ARENA_CENTER.y },
  ];

  players = [];
  for (let i = 0; i < 2; i++) {
    const c = this.add.circle(startPositions[i].x, startPositions[i].y, PLAYER_RADIUS, colors[i]);
    c.setStrokeStyle(4, 0xffffff, 0.9);
    this.physics.add.existing(c);
    c.body.setCircle(PLAYER_RADIUS);
    c.body.setBounce(1, 1);
    c.body.setCollideWorldBounds(false);
    c.body.setDamping(false);
    players.push(c);
  }

  this.physics.add.collider(players[0], players[1]);

  players.forEach((p) => {
    const nose = this.add.circle(p.x + PLAYER_RADIUS * 0.7, p.y, 7, 0xffffff);
    p.nose = nose;
  });

  volumeText = this.add.text(10, 10, 'Громкость: 0%', { font: '16px Arial', fill: '#fff' });
  this.add.text(10, 32, 'Сумоист крутится сам — кричи в микрофон, чтобы рвануть вперёд', { font: '13px Arial', fill: '#999' });

  // сеть отправляется по таймеру (30 раз/сек), а не привязана к частоте кадров устройства —
  // так телефон с 120Hz-экраном не заваливает сервер лишними сообщениями
  networkInterval = setInterval(() => {
    if (gameEnded || !socket || !players.length) return;
    const me = players[myIndex];
    socket.emit('state', { x: me.x, y: me.y, rotation: me.rotation });
  }, 33);
}

function update(time, delta) {
  if (gameEnded) return;

  // нормализуем к базовой частоте 60 кадров/сек, чтобы скорость вращения
  // и торможение были одинаковыми на экране с 60Hz и с 120Hz
  const dt = delta / (1000 / 60);

  const me = players[myIndex];
  const opponent = players[myIndex === 0 ? 1 : 0];

  me.rotation += SPIN_SPEED * dt;
  const facingAngle = me.rotation;
  const dragFactor = Math.pow(DRAG, dt);
  me.body.velocity.x *= dragFactor;
  me.body.velocity.y *= dragFactor;

  if (currentVolume > MIN_SCREAM_VOLUME && time - lastDashTime > DASH_COOLDOWN_MS) {
    lastDashTime = time;
    const power = Math.min(currentVolume, 1);
    const force = power * DASH_FORCE * 10;
    me.body.velocity.x += Math.cos(facingAngle) * force;
    me.body.velocity.y += Math.sin(facingAngle) * force;
  }

  if (remoteState) {
    opponent.x = Phaser.Math.Linear(opponent.x, remoteState.x, 0.35);
    opponent.y = Phaser.Math.Linear(opponent.y, remoteState.y, 0.35);
    opponent.rotation = remoteState.rotation;
  }

  players.forEach((p) => {
    p.nose.x = p.x + Math.cos(p.rotation) * PLAYER_RADIUS * 0.7;
    p.nose.y = p.y + Math.sin(p.rotation) * PLAYER_RADIUS * 0.7;
  });

  const dist = Phaser.Math.Distance.Between(me.x, me.y, ARENA_CENTER.x, ARENA_CENTER.y);
  if (dist > ARENA_RADIUS + PLAYER_RADIUS * 0.5) {
    const winner = myIndex === 0 ? 2 : 1;
    finishGame(winner);
    if (socket) socket.emit('end', { winner });
  }

  volumeText.setText('Громкость: ' + Math.round(currentVolume * 100) + '%');
}

function finishGame(winner) {
  if (gameEnded) return;
  gameEnded = true;
  if (networkInterval) clearInterval(networkInterval);
  scene.physics.pause();
  const label = winner === 1 ? 'Игрок 1 (синий)' : 'Игрок 2 (красный)';
  scene.add.text(
    ARENA_CENTER.x,
    ARENA_CENTER.y,
    label + ' победил!\nОбновите страницу для новой игры',
    { font: '24px Arial', fill: '#fff', align: 'center', backgroundColor: '#000000aa', padding: { x: 12, y: 10 } }
  ).setOrigin(0.5);
}
