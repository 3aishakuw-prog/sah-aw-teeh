/* =====================================================================
   صح أو طيح! — منطق شاشة اللاعب (الجوال)
   - الدخول بالاسم (كود الغرفة يجي من الرابط تلقائياً)
   - زرين كبار: صح / خطأ ، والإجابة سرية
   - يرجع اللاعب لمكانه تلقائياً إذا انقطع الاتصال أو حدّث الصفحة
   ===================================================================== */
(() => {
  'use strict';

  /* ───────────────────────── الحالة ───────────────────────── */
  const KEY = 'tfe-player';
  const params = new URLSearchParams(location.search);
  let roomCode = (params.get('room') || '').replace(/\D/g, '').slice(0, 6);
  let session = loadSession(); // { room, playerId, name }
  let V = null;                // آخر حالة من السيرفر
  let current = null;          // الشاشة الظاهرة
  let answeredRound = '';      // رقم الجولة اللي جاوبنا فيها (لإخفاء الأزرار فوراً)
  let deadline = 0;
  let joining = false;
  let stopped = false;         // بعد الإخراج أو إغلاق الغرفة ما نعيد الاتصال
  let lastResultKey = '';
  let meColor = '';

  /* ───────────────────────── أدوات ───────────────────────── */
  const $ = (sel) => document.querySelector(sel);

  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function saveSession() {
    try {
      if (session) sessionStorage.setItem(KEY, JSON.stringify(session));
      else sessionStorage.removeItem(KEY);
    } catch (e) { /* التخزين غير متاح */ }
  }
  function storedName() {
    try { return localStorage.getItem('tfe-name') || ''; } catch (e) { return ''; }
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const mix = (c) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
    const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  // نفس شخصية الشاشة الرئيسية
  function buildAvatar(color) {
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.setProperty('--c', color);
    av.style.setProperty('--c-hi', shade(color, 0.5));
    av.style.setProperty('--c-lo', shade(color, -0.38));
    av.innerHTML =
      '<div class="av-body"><i class="av-eye"></i><i class="av-eye"></i><i class="av-mouth"></i></div>' +
      '<i class="av-feet"></i>';
    return av;
  }

  /* ───────────────────────── عناصر الصفحة ───────────────────────── */
  const ui = {
    screens: document.querySelectorAll('.screen'),
    conn: $('#conn'), me: $('#me'), meAvatar: $('#meAvatar'), meName: $('#meName'),
    joinForm: $('#joinForm'), roomChip: $('#roomChip'), roomShow: $('#roomShow'),
    roomField: $('#roomField'), roomInput: $('#roomInput'),
    nameInput: $('#nameInput'), joinBtn: $('#joinBtn'), joinError: $('#joinError'),
    waitAvatar: $('#waitAvatar'), waitName: $('#waitName'),
    btnTrue: $('#btnTrue'), btnFalse: $('#btnFalse'), timebar: $('#timebar'),
    result: $('#s-result'), resIcon: $('#resIcon'), resTitle: $('#resTitle'), resSub: $('#resSub'),
    over: $('#s-over'), overIcon: $('#overIcon'), overTitle: $('#overTitle'), overSub: $('#overSub'),
    msgTitle: $('#msgTitle'), msgSub: $('#msgSub'), msgBtn: $('#msgBtn'),
    toast: $('#toast'),
  };

  const ME_SCREENS = new Set(['s-locked', 's-reveal', 's-result', 's-out', 's-spectate', 's-over', 's-next']);

  function show(id) {
    if (current === id) return;
    current = id;
    for (const s of ui.screens) s.classList.toggle('active', s.id === id);
    ui.me.hidden = !(V && ME_SCREENS.has(id));
    if (id === 's-answer') requestAnimationFrame(stepTimebar);
  }

  function message(title, sub, btnText, onClick) {
    ui.msgTitle.textContent = title;
    ui.msgSub.textContent = sub || '';
    ui.msgBtn.hidden = !btnText;
    if (btnText) {
      ui.msgBtn.textContent = btnText;
      ui.msgBtn.onclick = onClick;
    }
    show('s-msg');
  }

  let toastTimer = null;
  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2600);
  }

  function setError(msg) {
    ui.joinError.textContent = msg || '';
  }

  /* ───────────────────────── شاشة الدخول ───────────────────────── */
  if (roomCode) {
    ui.roomShow.textContent = roomCode;
  } else {
    ui.roomChip.hidden = true;
    ui.roomField.hidden = false;
  }
  ui.nameInput.value = (session && session.name) || storedName();
  ui.roomInput.addEventListener('input', () => {
    ui.roomInput.value = ui.roomInput.value.replace(/\D/g, '').slice(0, 4);
  });

  const currentRoom = () => roomCode || ui.roomInput.value.replace(/\D/g, '');

  // إذا ما عنده جلسة سابقة نعرض الاسم مباشرة (يقدر يكتب وهو يتصل)
  if (!(session && session.room === currentRoom())) show('s-join');

  if (typeof io !== 'function') {
    ui.conn.hidden = true;
    message('ما قدرنا نوصل للعبة', 'تأكد إن الكمبيوتر شغّل اللعبة وإن جوالك على نفس الواي فاي.');
    return;
  }

  const socket = io();

  ui.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const room = currentRoom();
    const name = ui.nameInput.value.trim();
    if (room.length < 4) return setError('اكتب كود الغرفة (4 أرقام) من الشاشة الكبيرة');
    if (!name) {
      ui.nameInput.focus();
      return setError('اكتب اسمك أول');
    }
    ui.nameInput.blur();
    join(room, name);
  });

  function join(room, name) {
    if (joining) return;
    joining = true;
    ui.joinBtn.disabled = true;
    const playerId = session && session.room === room ? session.playerId : null;
    const guard = setTimeout(() => { joining = false; ui.joinBtn.disabled = false; }, 8000);
    socket.emit('player:join', { room, name, playerId }, (res) => {
      clearTimeout(guard);
      joining = false;
      ui.joinBtn.disabled = false;
      if (!res || !res.ok) {
        if (res && res.reason === 'no-room') {
          session = null;
          saveSession();
        }
        show('s-join');
        setError((res && res.error) || 'تعذر الدخول، حاول مرة ثانية');
        return;
      }
      setError('');
      roomCode = room;
      session = { room, playerId: res.playerId, name: res.name };
      saveSession();
      try { localStorage.setItem('tfe-name', res.name); } catch (e) { /* */ }
      if (!params.get('room')) {
        try { history.replaceState(null, '', '?room=' + room); } catch (e) { /* */ }
      }
    });
  }

  /* ───────────────────────── الإجابة السرية ───────────────────────── */
  function answer(value) {
    if (!V || V.phase !== 'question' || current !== 's-answer') return;
    answeredRound = V.round ? V.round.id : '';
    if (navigator.vibrate) navigator.vibrate(30);
    show('s-locked'); // الزرين يختفون فوراً
    socket.emit('player:answer', { answer: value }, (res) => {
      if (res && res.ok) return;
      answeredRound = '';
      toast((res && res.error) || 'ما انحسبت الإجابة، حاول مرة ثانية');
      render();
    });
  }
  ui.btnTrue.addEventListener('click', () => answer(true));
  ui.btnFalse.addEventListener('click', () => answer(false));

  function stepTimebar() {
    if (current !== 's-answer' || !V || V.phase !== 'question') return;
    const left = Math.max(0, deadline - performance.now());
    ui.timebar.style.transform = 'scaleX(' + (left / V.questionMs).toFixed(4) + ')';
    ui.timebar.classList.toggle('urgent', left <= 5000);
    requestAnimationFrame(stepTimebar);
  }

  /* ───────────────────────── عرض الحالة ───────────────────────── */
  const RESULTS = {
    correct: { tone: 'good', icon: '🎉', title: 'صح! نجوت', sub: 'استعد للسؤال الجاي' },
    wrong: { tone: 'bad', icon: '💥', title: 'طحت!', sub: 'جوابك كان غلط' },
    timeout: { tone: 'bad', icon: '⏰', title: 'طحت!', sub: 'خلص الوقت وما جاوبت' },
    mercy: { tone: 'meh', icon: '😅', title: 'نجوت بأعجوبة', sub: 'الكل غلط، فمحد طاح هالمرة' },
    safe: { tone: 'meh', icon: '😮‍💨', title: 'نجوت', sub: 'ما جاوبت، بس هالمرة سلمت' },
  };

  function paintMe(me) {
    if (ui.meName.textContent !== me.name) {
      ui.meName.textContent = me.name;
      ui.waitName.textContent = me.name;
    }
    if (me.color !== meColor) {
      meColor = me.color;
      ui.meAvatar.replaceChildren(buildAvatar(me.color));
      ui.waitAvatar.replaceChildren(buildAvatar(me.color));
    }
  }

  function paintResult(outcome, roundId) {
    const r = RESULTS[outcome] || RESULTS.safe;
    ui.result.classList.remove('good', 'bad', 'meh');
    ui.result.classList.add(r.tone);
    ui.resIcon.textContent = r.icon;
    ui.resTitle.textContent = r.title;
    ui.resSub.textContent = r.sub;
    const key = roundId + ':' + outcome;
    if (key !== lastResultKey) {
      lastResultKey = key;
      if (navigator.vibrate) navigator.vibrate(r.tone === 'bad' ? [90, 50, 160] : 40);
    }
  }

  function paintOver(v) {
    const others = v.winners.filter((n) => n !== v.me.name);
    ui.over.classList.remove('good', 'bad', 'meh');
    if (v.iWon) {
      ui.over.classList.add('good');
      ui.overIcon.textContent = '🏆';
      ui.overTitle.textContent = v.winners.length === 1 ? 'أنت البطل!' : 'صمدت للنهاية!';
      ui.overSub.textContent = v.winners.length === 1 ? 'آخر واحد صامد' : 'معك: ' + others.join('، ');
    } else {
      ui.overIcon.textContent = '🎮';
      ui.overTitle.textContent = 'انتهت اللعبة';
      ui.overSub.textContent = v.winners.length === 1
        ? 'الفائز: ' + v.winners[0]
        : v.winners.length ? 'صمدوا للنهاية: ' + v.winners.join('، ') : 'ما بقى أحد!';
    }
  }

  function render() {
    const v = V;
    if (!v) return;
    paintMe(v.me);
    const roundId = v.round ? v.round.id : '';
    const answered = v.me.answered || (v.phase === 'question' && roundId !== '' && answeredRound === roundId);
    let id = 's-wait';
    // s-next: دخل وسط اللعب ويبدأ من السؤال الجاي
    if (v.phase === 'question') {
      id = v.me.spectator ? 's-spectate' : !v.me.alive ? 's-out' : !v.inRound ? 's-next' : answered ? 's-locked' : 's-answer';
    } else if (v.phase === 'reveal') {
      id = v.me.spectator ? 's-spectate' : !v.me.alive ? 's-out' : !v.inRound ? 's-next' : 's-reveal';
    } else if (v.phase === 'result') {
      id = v.outcome ? 's-result' : v.me.spectator ? 's-spectate' : !v.me.alive ? 's-out' : 's-next';
    } else if (v.phase === 'gameover') {
      id = 's-over';
    }
    if (id === 's-result') paintResult(v.outcome, roundId);
    if (id === 's-over') paintOver(v);
    show(id);
  }

  /* ───────────────────────── الاتصال ───────────────────────── */
  socket.on('connect', () => {
    ui.conn.hidden = true;
    if (session && session.name && session.room === currentRoom()) join(session.room, session.name);
    else if (!V) show('s-join');
  });

  socket.on('disconnect', (reason) => {
    if (stopped || reason === 'io server disconnect') return;
    ui.conn.textContent = 'انقطع الاتصال… نحاول نرجعك';
    ui.conn.classList.add('lost');
    ui.conn.hidden = false;
  });

  socket.on('you', (v) => {
    V = v;
    if (v.phase === 'question') deadline = performance.now() + v.remainingMs;
    render();
  });

  socket.on('kicked', () => {
    stopped = true;
    session = null;
    saveSession();
    V = null;
    message('تم إخراجك من الغرفة', 'إذا تبي ترجع، ادخل من جديد.', 'ادخل من جديد', () => {
      stopped = false;
      show('s-join');
      socket.connect();
    });
  });

  socket.on('room:closed', () => {
    stopped = true;
    session = null;
    saveSession();
    V = null;
    socket.disconnect();
    message('انتهت الغرفة', 'امسح الباركود من الشاشة الرئيسية من جديد.');
  });

  socket.on('replaced', () => {
    stopped = true;
    message('اللعبة مفتوحة في صفحة ثانية', 'كمّل من هناك، أو ارجع لهذي الصفحة.', 'كمّل هنا', () => {
      stopped = false;
      socket.connect();
    });
  });

  // الجوال يقفل الاتصال لما تنطفي الشاشة؛ نرجع أول ما يفتح
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !stopped && !socket.connected) socket.connect();
  });
})();
