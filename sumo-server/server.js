// =========================================================
//  SCREAM SUMO — сервер
//  Express (раздача файлов) + Socket.io (комнаты, синхронизация в реальном времени)
// =========================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// rooms: { code: { players: [socketId, socketId] } }
const rooms = {};

function makeCode() {
  return Math.random().toString(36).substring(2, 7);
}

io.on('connection', (socket) => {
  socket.on('create-room', () => {
    let code = makeCode();
    while (rooms[code]) code = makeCode(); // на случай коллизии
    rooms[code] = { players: [socket.id] };
    socket.join(code);
    socket.data.room = code;
    socket.data.index = 0;
    socket.emit('room-created', { code, index: 0 });
  });

  socket.on('join-room', (code) => {
    const room = rooms[code];
    if (!room) {
      socket.emit('join-error', 'Комната не найдена');
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('join-error', 'Комната уже заполнена');
      return;
    }
    room.players.push(socket.id);
    socket.join(code);
    socket.data.room = code;
    socket.data.index = 1;
    socket.emit('room-joined', { code, index: 1 });
    io.to(code).emit('opponent-ready');
  });

  socket.on('state', (data) => {
    const code = socket.data.room;
    if (!code) return;
    // рассылаем всем в комнате, кроме отправителя
    socket.to(code).emit('state', data);
  });

  socket.on('end', (data) => {
    const code = socket.data.room;
    if (!code) return;
    socket.to(code).emit('end', data);
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    if (code && rooms[code]) {
      io.to(code).emit('opponent-left');
      delete rooms[code];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Сервер запущен на порту ' + PORT);
});
