'use strict';
/* =====================================================================
   صح أو طيح! — لعبة صح/خطأ جماعية بأسلوب Jackbox
   الخادم: Node.js + Express + Socket.io

   التشغيل:   npm install   ثم   npm start
   الشاشة الرئيسية (على الكمبيوتر/التلفزيون):  http://localhost:3000
   اللاعبون يدخلون بمسح الباركود الظاهر على الشاشة الرئيسية.
   ===================================================================== */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

/* ───────────────────────── الإعدادات ───────────────────────── */
const CONFIG = {
  PORT: Number(process.env.PORT) || 3000,
  HOST_IP: process.env.HOST_IP || '', // لفرض عنوان شبكة معيّن، مثال: HOST_IP=192.168.1.5
  QUESTION_MS: 15000,        // مدة السؤال (15 ثانية)
  REVEAL_TO_FALL_MS: 3000,   // من لحظة الكشف حتى اهتزاز وسقوط المنصة الخاطئة
  RESULT_MS: 5000,           // مدة عرض النتيجة قبل السؤال التالي
  ALL_ANSWERED_MS: 3000,     // إذا جاوب الجميع ينزل العداد إلى 3 ثوانٍ (0 = بدون اختصار)
  ELIMINATE_NO_ANSWER: true, // اللي ما يجاوب قبل نهاية الوقت يطيح
  SHUFFLE_QUESTIONS: true,   // ترتيب عشوائي للأسئلة في كل لعبة
  MAX_PLAYERS: 40,
  NAME_MAX: 14,              // أقصى عدد حروف للاسم
  LOBBY_GRACE_MS: 60000,     // حذف اللاعب المنقطع من غرفة الانتظار بعد دقيقة
  HOST_GRACE_MS: 10 * 60000, // إغلاق الغرفة إذا غابت الشاشة الرئيسية 10 دقائق
};

/* ───────────────────────── الأسئلة (Mock Data) ───────────────────────── */
const QUESTIONS = [
  { text: 'تويوتا لاندكروزر موديل 2013 فئة 6 سلندر يتوفر بناقل حركة عادي.', answer: true, category: 'سيارات' },
  { text: 'سيارة سوزوكي جيمني لا يمكن رفعها أو تعديلها للبر.', answer: false, category: 'سيارات' },
  { text: 'السامري هو فن فلكلوري شعبي يعتمد على الإيقاع والقصائد النبطية.', answer: true, category: 'تراث' },
  { text: 'إطارات البالون (مثل الشاهين) مخصصة للقيادة بسرعات عالية جداً على الشوارع المبللة.', answer: false, category: 'سيارات' },
  { text: 'البطريق طائر يمتلك أجنحة ولكنه لا يستطيع الطيران.', answer: true, category: 'حيوانات' },
];

// ألوان الشخصيات (بعيدة عن أخضر "صح" وأحمر "خطأ" حتى تبان فوق المنصات)
const COLORS = [
  '#FFD23F', '#4CC9F0', '#F72585', '#9B5DE5', '#FF9F1C', '#56CFE1', '#F15BB5', '#3A86FF',
  '#FFB4A2', '#CDB4DB', '#FF7F51', '#A0C4FF', '#E9C46A', '#FDFFB6', '#FFC6FF', '#C77DFF',
];

/* ───────────────────────── اكتشاف عنوان الشبكة المحلية ───────────────────────── */
const VIRTUAL_IF = /(vmware|virtualbox|vbox|vethernet|hyper-?v|docker|wsl|loopback|pseudo|tailscale|zerotier|hamachi|utun|awdl|llw|anpi|virbr|veth|br-|tun\d|tap\d|vpn)/i;
const LAN_IF = /(wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d|^wl|^enp|^eno|^ens)/i;

// ترجع كل عناوين IPv4 المحلية مرتبة: الأرجح أنها شبكة الواي فاي أولاً
function networkAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      const isV4 = a.family === 'IPv4' || a.family === 4;
      if (!isV4 || a.internal || a.address.startsWith('169.254.')) continue;
      let score = 0;
      if (a.address.startsWith('192.168.')) score += 30;
      else if (a.address.startsWith('10.')) score += 20;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 10;
      if (LAN_IF.test(name)) score += 20;
      if (VIRTUAL_IF.test(name)) score -= 50;
      found.push({ name, address: a.address, score });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const list = found.map(({ name, address }) => ({ name, address }));
  if (CONFIG.HOST_IP) {
    return [{ name: 'HOST_IP', address: CONFIG.HOST_IP }, ...list.filter((a) => a.address !== CONFIG.HOST_IP)];
  }
  return list;
}

/* ───────────────────────── Express ───────────────────────── */
const app = express();
app.disable('x-powered-by');
// الملفات إما داخل مجلد public (نسخة الكمبيوتر) أو جنب server.js مباشرة (نسخة الموقع)
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
} else {
  const PAGES = {
    '/': 'index.html', '/index.html': 'index.html', '/mobile.html': 'mobile.html',
    '/host.js': 'host.js', '/client.js': 'client.js', '/style.css': 'style.css',
  };
  for (const [route, file] of Object.entries(PAGES)) {
    app.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
  }
}

// باركود احتياطي من الخادم: يُستخدم تلقائياً إذا ما تحمّلت مكتبة qrcode.js (مثلاً بدون إنترنت)
app.get('/qr.svg', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 300);
  if (!text) return res.status(400).end();
  try {
    const svg = await QRCode.toString(text, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#1a1033', light: '#ffffff' },
    });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (err) {
    res.status(500).end();
  }
});

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 10000 });

/* ───────────────────────── الغرف واللاعبين ───────────────────────── */
const rooms = new Map(); // code -> room

const makeId = () => crypto.randomBytes(9).toString('base64url');

function makeRoomCode() {
  for (let i = 0; i < 2000; i++) {
    const code = String(crypto.randomInt(1000, 10000));
    if (!rooms.has(code)) return code;
  }
  throw new Error('No free room codes');
}

function createRoom() {
  const room = {
    code: makeRoomCode(),
    key: makeId(),        // مفتاح سري حتى ترجع الشاشة الرئيسية لنفس الغرفة بعد التحديث
    hostId: null,         // socket.id للشاشة الرئيسية
    hostTimer: null,
    phase: 'lobby',       // lobby | question | reveal | result | gameover
    players: new Map(),   // playerId -> player
    seq: 0,               // ترتيب الانضمام
    order: [],            // ترتيب الأسئلة في هذه اللعبة
    qIndex: -1,
    deadline: 0,
    timer: null,
    game: 0,              // رقم اللعبة (يزيد مع كل بداية جديدة)
    roundPlayers: null,   // اللاعبين المشاركين في الجولة الحالية
    allAnswered: false,
    result: null,
    winners: [],
    startCount: 0,
  };
  rooms.set(room.code, room);
  return room;
}

const playersOf = (room) => [...room.players.values()].sort((a, b) => a.seq - b.seq);
const alivePlayers = (room) => playersOf(room).filter((p) => p.alive && !p.spectator);
const currentQuestion = (room) => (room.qIndex >= 0 && room.qIndex < room.order.length ? QUESTIONS[room.order[room.qIndex]] : null);
const inRound = (room, p) => !!(room.roundPlayers && room.roundPlayers.has(p.id));

function cleanName(raw) {
  const s = String(raw || '')
    .replace(/[\u0000-\u001f\u007f<>​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, CONFIG.NAME_MAX).join('').trim();
}

function pickColor(room) {
  const used = new Map(COLORS.map((c) => [c, 0]));
  for (const p of room.players.values()) used.set(p.color, (used.get(p.color) || 0) + 1);
  const min = Math.min(...used.values());
  const free = COLORS.filter((c) => used.get(c) === min);
  return free[crypto.randomInt(free.length)];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function schedule(room, ms, fn) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    room.timer = null;
    fn();
  }, ms);
}

/* ───────────────────────── ما يُرسل لكل شاشة ───────────────────────── */
// الشاشة الرئيسية: الإجابات تبقى سرية (answered فقط) حتى لحظة الكشف
function hostView(room) {
  const q = currentQuestion(room);
  const showChoices = room.phase === 'reveal' || room.phase === 'result';
  const inGame = room.phase === 'question' || showChoices;
  return {
    code: room.code,
    phase: room.phase,
    round: q && inGame ? { id: room.game + '-' + room.qIndex, index: room.qIndex, total: room.order.length, text: q.text, category: q.category } : null,
    remainingMs: room.phase === 'question' ? Math.max(0, room.deadline - Date.now()) : 0,
    questionMs: CONFIG.QUESTION_MS,
    allAnswered: room.allAnswered,
    startCount: room.startCount,
    players: playersOf(room).map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      connected: p.connected,
      alive: p.alive,
      spectator: p.spectator,
      inRound: inGame && inRound(room, p),
      answered: p.answer !== null,
      choice: showChoices ? p.answer : null, // true | false | null (ما جاوب)
    })),
    result: room.phase === 'result' && room.result ? room.result : null,
    winners: room.phase === 'gameover' ? room.winners : [],
  };
}

// جوال اللاعب: حالته هو فقط
function playerView(room, p) {
  const inGame = room.phase === 'question' || room.phase === 'reveal' || room.phase === 'result';
  const view = {
    phase: room.phase,
    me: { id: p.id, name: p.name, color: p.color, alive: p.alive, spectator: p.spectator, answered: p.answer !== null },
    inRound: inGame && inRound(room, p),
    round: inGame ? { id: room.game + '-' + room.qIndex, index: room.qIndex, total: room.order.length } : null,
    remainingMs: room.phase === 'question' ? Math.max(0, room.deadline - Date.now()) : 0,
    questionMs: CONFIG.QUESTION_MS,
    outcome: null,
    winners: [],
    iWon: false,
  };
  if (room.phase === 'result' && room.result && view.inRound) {
    const r = room.result;
    if (r.fallen.includes(p.id)) view.outcome = p.answer === null ? 'timeout' : 'wrong';
    else if (p.answer === r.correct) view.outcome = 'correct';
    else if (r.mercy) view.outcome = 'mercy';
    else view.outcome = 'safe'; // ما جاوب لكن ما طاح (إذا ELIMINATE_NO_ANSWER = false)
  }
  if (room.phase === 'gameover') {
    view.winners = room.winners.map((w) => w.name);
    view.iWon = room.winners.some((w) => w.id === p.id);
  }
  return view;
}

function broadcast(room) {
  if (room.hostId) io.to(room.hostId).emit('state', hostView(room));
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('you', playerView(room, p));
  }
}

/* ───────────────────────── دورة اللعب ───────────────────────── */
function startGame(room) {
  for (const p of room.players.values()) {
    p.alive = true;
    p.spectator = false;
    p.answer = null;
  }
  room.game += 1;
  room.order = QUESTIONS.map((_, i) => i);
  if (CONFIG.SHUFFLE_QUESTIONS) shuffle(room.order);
  room.qIndex = -1;
  room.winners = [];
  room.result = null;
  room.startCount = room.players.size;
  nextQuestion(room);
}

function nextQuestion(room) {
  room.qIndex += 1;
  const alive = alivePlayers(room);
  if (room.qIndex >= room.order.length || alive.length === 0) return endGame(room);

  for (const p of room.players.values()) p.answer = null;
  room.roundPlayers = new Set(alive.map((p) => p.id));
  room.result = null;
  room.allAnswered = false;
  room.phase = 'question';
  room.deadline = Date.now() + CONFIG.QUESTION_MS;
  schedule(room, CONFIG.QUESTION_MS, () => reveal(room));
  broadcast(room);
}

// الكشف: الشخصيات تنزلق لمنصة اختيارها
function reveal(room) {
  room.phase = 'reveal';
  room.deadline = 0;
  schedule(room, CONFIG.REVEAL_TO_FALL_MS, () => resolveRound(room));
  broadcast(room);
}

// الإقصاء: المنصة الخاطئة تهتز وتسقط ومعها اللاعبين
function resolveRound(room) {
  const q = currentQuestion(room);
  const players = alivePlayers(room).filter((p) => inRound(room, p));
  let fallen = players.filter((p) => (p.answer === null ? CONFIG.ELIMINATE_NO_ANSWER : p.answer !== q.answer));

  // إذا كان الكل بيطيح، محد يطيح هالمرة (عشان يكون في فائز)
  const mercy = fallen.length > 0 && fallen.length === players.length;
  if (mercy) fallen = [];
  for (const p of fallen) p.alive = false;

  room.result = { correct: q.answer, fallen: fallen.map((p) => p.id), mercy };
  room.phase = 'result';

  const aliveCount = alivePlayers(room).length;
  const lastQuestion = room.qIndex >= room.order.length - 1;
  const decided = room.startCount > 1 && aliveCount <= 1;
  schedule(room, CONFIG.RESULT_MS, () => (lastQuestion || decided ? endGame(room) : nextQuestion(room)));
  broadcast(room);
}

function endGame(room) {
  clearTimeout(room.timer);
  room.phase = 'gameover';
  room.deadline = 0;
  room.roundPlayers = null;
  room.winners = alivePlayers(room).map((p) => ({ id: p.id, name: p.name, color: p.color }));
  broadcast(room);
}

function resetToLobby(room) {
  clearTimeout(room.timer);
  Object.assign(room, {
    phase: 'lobby', qIndex: -1, order: [], deadline: 0, roundPlayers: null,
    allAnswered: false, result: null, winners: [], startCount: 0,
  });
  for (const p of room.players.values()) {
    p.alive = true;
    p.spectator = false;
    p.answer = null;
    if (!p.connected) scheduleRemoval(room, p);
  }
  broadcast(room);
}

// إذا جاوب كل المتصلين، نختصر العداد
function checkAllAnswered(room) {
  if (room.phase !== 'question') return;
  const waiting = alivePlayers(room).filter((p) => inRound(room, p) && p.connected);
  if (!waiting.length || waiting.some((p) => p.answer === null)) return;
  room.allAnswered = true;
  if (CONFIG.ALL_ANSWERED_MS && room.deadline - Date.now() > CONFIG.ALL_ANSWERED_MS) {
    room.deadline = Date.now() + CONFIG.ALL_ANSWERED_MS;
    schedule(room, CONFIG.ALL_ANSWERED_MS, () => reveal(room));
  }
}

// اللاعب المنقطع يُحذف من غرفة الانتظار بعد مهلة (أثناء اللعب يبقى ويُحسب "ما جاوب")
function scheduleRemoval(room, p) {
  clearTimeout(p.removeTimer);
  p.removeTimer = setTimeout(() => {
    if (p.connected || rooms.get(room.code) !== room || !room.players.has(p.id)) return;
    if (room.phase === 'lobby' || room.phase === 'gameover' || p.spectator) {
      room.players.delete(p.id);
      broadcast(room);
    }
  }, CONFIG.LOBBY_GRACE_MS);
}

function closeRoom(room) {
  clearTimeout(room.timer);
  for (const p of room.players.values()) {
    clearTimeout(p.removeTimer);
    if (p.socketId) io.to(p.socketId).emit('room:closed');
  }
  rooms.delete(room.code);
}

function attachPlayer(socket, room, p) {
  // لو هذا الاتصال كان مربوط بلاعب ثاني قبل، نفكّه
  const prevRoom = socket.data.role === 'player' ? rooms.get(socket.data.code) : null;
  const prev = prevRoom ? prevRoom.players.get(socket.data.playerId) : null;
  if (prev && prev !== p && prev.socketId === socket.id) {
    prev.socketId = null;
    prev.connected = false;
  }
  const oldSocketId = p.socketId;
  p.socketId = socket.id;
  p.connected = true;
  clearTimeout(p.removeTimer);
  socket.data = { role: 'player', code: room.code, playerId: p.id };
  // نفس اللاعب فتح من صفحة ثانية: نقفل القديمة
  if (oldSocketId && oldSocketId !== socket.id) {
    const old = io.sockets.sockets.get(oldSocketId);
    if (old) {
      old.emit('replaced');
      old.disconnect(true);
    }
  }
}

/* ───────────────────────── Socket.io ───────────────────────── */
const noop = () => {};

io.on('connection', (socket) => {
  socket.data = { role: null, code: null, playerId: null };

  const hostRoom = () => {
    const room = socket.data.role === 'host' ? rooms.get(socket.data.code) : null;
    return room && room.hostId === socket.id ? room : null;
  };

  /* ---------- الشاشة الرئيسية ---------- */
  socket.on('host:hello', (msg, ack) => {
    const reply = typeof ack === 'function' ? ack : noop;
    msg = msg && typeof msg === 'object' ? msg : {};
    let room = rooms.get(String(msg.code || ''));
    if (room && room.key !== msg.key) room = null;
    if (!room) room = createRoom();

    const oldHostId = room.hostId;
    room.hostId = socket.id;
    clearTimeout(room.hostTimer);
    socket.data = { role: 'host', code: room.code, playerId: null };
    if (oldHostId && oldHostId !== socket.id) {
      const old = io.sockets.sockets.get(oldHostId);
      if (old) {
        old.emit('host:replaced');
        old.disconnect(true);
      }
    }
    reply({ ok: true, code: room.code, key: room.key, network: { port: CONFIG.PORT, addresses: networkAddresses() } });
    broadcast(room);
  });

  socket.on('host:start', (msg, ack) => {
    const reply = typeof ack === 'function' ? ack : noop;
    const room = hostRoom();
    if (!room) return reply({ ok: false, error: 'الغرفة غير موجودة' });
    if (room.phase !== 'lobby') return reply({ ok: false, error: 'اللعبة شغالة' });
    if (room.players.size < 1) return reply({ ok: false, error: 'انتظر دخول لاعب واحد على الأقل' });
    startGame(room);
    reply({ ok: true });
  });

  socket.on('host:reset', (msg, ack) => {
    const reply = typeof ack === 'function' ? ack : noop;
    const room = hostRoom();
    if (!room) return reply({ ok: false });
    resetToLobby(room);
    reply({ ok: true });
  });

  socket.on('host:kick', (msg, ack) => {
    const reply = typeof ack === 'function' ? ack : noop;
    const room = hostRoom();
    const p = room && msg ? room.players.get(String(msg.playerId)) : null;
    if (!p) return reply({ ok: false });
    room.players.delete(p.id);
    clearTimeout(p.removeTimer);
    if (room.roundPlayers) room.roundPlayers.delete(p.id);
    const s = p.socketId ? io.sockets.sockets.get(p.socketId) : null;
    if (s) {
      s.emit('kicked');
      s.data = { role: null, code: null, playerId: null };
      s.disconnect(true);
    }
    checkAllAnswered(room);
    broadcast(room);
    reply({ ok: true });
  });

  /* ---------- اللاعب ---------- */
  socket.on('player:join', (msg, ack) => {
    const reply = typeof ack === 'function' ? ack : noop;
    msg = msg && typeof msg === 'object' ? msg : {};
    const room = rooms.get(String(msg.room || '').trim());
    if (!room) return reply({ ok: false, reason: 'no-room', error: 'الغرفة غير موجودة. امسح الباركود من الشاشة من جديد' });

    const done = (p) => {
      attachPlayer(socket, room, p);
      reply({ ok: true, playerId: p.id, name: p.name, color: p.color });
      if (room.phase === 'question') checkAllAnswered(room);
      broadcast(room);
    };

    // 1) رجوع لاعب موجود (تحديث الصفحة أو انقطاع الواي فاي)
    const known = msg.playerId ? room.players.get(String(msg.playerId)) : null;
    if (known) return done(known);

    // 2) لاعب جديد
    const name = cleanName(msg.name);
    if (!name) return reply({ ok: false, reason: 'name', error: 'اكتب اسمك أول' });
    const same = [...room.players.values()].find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (same) {
      if (!same.connected) return done(same); // نفس الاسم وكان منقطع: نرجّعه مكانه
      return reply({ ok: false, reason: 'name', error: 'الاسم مستخدم، اختر اسم ثاني' });
    }
    if (room.players.size >= CONFIG.MAX_PLAYERS) return reply({ ok: false, reason: 'full', error: 'الغرفة ممتلئة' });

    // دخل واللعبة شغالة: يلعب معهم من السؤال الجاي
    const midGame = room.phase === 'question' || room.phase === 'reveal' || room.phase === 'result';
    const p = {
      id: makeId(),
      name,
      color: pickColor(room),
      seq: room.seq++,
      socketId: null,
      connected: false,
      alive: true,
      spectator: false,
      answer: null,
      removeTimer: null,
    };
    room.players.set(p.id, p);
    if (midGame) room.startCount += 1;
    done(p);
  });

  socket.on('player:answer', (msg, ack) => {
    const reply = typeof ack === 'function' ? ack : noop;
    const room = socket.data.role === 'player' ? rooms.get(socket.data.code) : null;
    const p = room ? room.players.get(socket.data.playerId) : null;
    if (!room || !p || p.socketId !== socket.id) return reply({ ok: false, error: 'انقطع الاتصال، حدّث الصفحة' });
    if (room.phase !== 'question') return reply({ ok: false, error: 'خلص الوقت' });
    if (!p.alive || p.spectator || !inRound(room, p)) return reply({ ok: false, error: 'أنت خارج هذي الجولة' });
    if (p.answer !== null) return reply({ ok: true, already: true });
    if (!msg || typeof msg.answer !== 'boolean') return reply({ ok: false, error: 'إجابة غير صالحة' });

    p.answer = msg.answer; // سرية: ما تنكشف للشاشة الرئيسية إلا عند نهاية الوقت
    reply({ ok: true });
    checkAllAnswered(room);
    broadcast(room);
  });

  /* ---------- الانقطاع ---------- */
  socket.on('disconnect', () => {
    const { role, code, playerId } = socket.data || {};
    const room = rooms.get(code);
    if (!room) return;
    if (role === 'host') {
      if (room.hostId !== socket.id) return;
      room.hostId = null;
      clearTimeout(room.hostTimer);
      room.hostTimer = setTimeout(() => closeRoom(room), CONFIG.HOST_GRACE_MS);
    } else if (role === 'player') {
      const p = room.players.get(playerId);
      if (!p || p.socketId !== socket.id) return;
      p.socketId = null;
      p.connected = false;
      scheduleRemoval(room, p);
      checkAllAnswered(room);
      broadcast(room);
    }
  });
});

/* ───────────────────────── التشغيل ───────────────────────── */
// يفتح الشاشة الرئيسية في المتصفح تلقائياً (يُستخدم من ملف start-game.bat)
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${CONFIG.PORT} is already in use. Close the other app or run with another port, e.g. PORT=3001\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(CONFIG.PORT, () => {
  const addrs = networkAddresses();
  const line = '─'.repeat(58);
  console.log(`\n  ${line}`);
  console.log('   True/False Elimination is running');
  console.log(`  ${line}`);
  console.log(`   Host screen (open on the TV / laptop):  http://localhost:${CONFIG.PORT}`);
  if (addrs.length) {
    console.log(`   Players join over Wi-Fi via:            http://${addrs[0].address}:${CONFIG.PORT}  (scan the QR)`);
    if (addrs.length > 1) {
      console.log('   Other network addresses:');
      for (const a of addrs.slice(1)) console.log(`     - http://${a.address}:${CONFIG.PORT}   (${a.name})`);
    }
  } else {
    console.log('   ! No Wi-Fi / LAN address found. Connect this computer to the same network as the phones.');
  }
  console.log('   Phones cannot connect? Allow Node.js through the firewall (Private networks).');
  console.log(`  ${line}\n`);
  if (process.env.OPEN_BROWSER) openBrowser(`http://localhost:${CONFIG.PORT}`);
});
