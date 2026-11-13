/* =====================================================================
   صح أو طيح! — منطق الشاشة الرئيسية (Host Screen)
   - يعرض الباركود والرابط ويستقبل اللاعبين
   - يرسم الساحة ثلاثية الأبعاد (SVG) والشخصيات فوقها (HTML)
   - الانزلاق للمنصات عند الكشف، ثم اهتزاز وسقوط المنصة الخاطئة
   ===================================================================== */
(() => {
  'use strict';

  /* ───────────────────────── أدوات صغيرة ───────────────────────── */
  const $ = (sel) => document.querySelector(sel);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function make(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function svgNode(tag, attrs, parent) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  // رقم ثابت بين 0 و 1 لكل نص (توزيع طبيعي للشخصيات بدون ما يتغير كل مرة)
  function seeded(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 10000) / 10000;
  }

  // تفتيح (amt > 0) أو تغميق (amt < 0) للون
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const mix = (c) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
    const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  function playersLabel(n) {
    if (n === 1) return 'لاعب واحد';
    if (n === 2) return 'لاعبَين';
    if (n >= 3 && n <= 10) return n + ' لاعبين';
    return n + ' لاعب';
  }

  const CHECK_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" ' +
    'stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // الشخصية: كائن هلامي بعيون (نفس الرسمة على الجوال)
  function buildAvatar(color) {
    const av = make('div', 'avatar');
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
    body: document.body,
    roomCode: $('#roomCode'), hudPlayers: $('#hudPlayers'), hudWaiting: $('#hudWaiting'), endBtn: $('#endBtn'),
    lobby: $('#lobby'), qr: $('#qr'), joinUrl: $('#joinUrl'), copyBtn: $('#copyBtn'), lobbyCode: $('#lobbyCode'),
    netRow: $('#netRow'), netSelect: $('#netSelect'), netWarn: $('#netWarn'),
    lobbyCount: $('#lobbyCount'), startBtn: $('#startBtn'),
    question: $('#question'), qCategory: $('#qCategory'), qRound: $('#qRound'), qText: $('#qText'),
    timer: $('#timer'), timerNum: $('#timerNum'), timerArc: $('#timerArc'), answered: $('#answered'),
    gameover: $('#gameover'), goTitle: $('#goTitle'), goNames: $('#goNames'), againBtn: $('#againBtn'),
    arena: $('#arena'), crowd: $('#crowd'), emptyHint: $('#emptyHint'),
    banner: $('#banner'), bannerMain: $('#bannerMain'), bannerSub: $('#bannerSub'),
    confetti: $('#confetti'), offline: $('#offline'), toast: $('#toast'),
    inviteBtn: $('#inviteBtn'), invite: $('#invite'), qrInvite: $('#qrInvite'),
    inviteUrl: $('#inviteUrl'), inviteCopy: $('#inviteCopy'), inviteClose: $('#inviteClose'),
    plat: { false: $('#plat-false'), mid: $('#plat-mid'), true: $('#plat-true') },
  };

  // فُتحت الصفحة بدون السيرفر (مثلاً بالضغط المزدوج على الملف)
  if (typeof io !== 'function') {
    ui.offline.hidden = false;
    $('#offlineTitle').textContent = 'السيرفر مو شغال';
    $('#offlineText').textContent = 'شغّل الأمر npm start ثم افتح http://localhost:3000';
    return;
  }

  /* ───────────────────────── هندسة الساحة (منظور ثلاثي الأبعاد) ─────────────────────────
     الأرضية مستوى مائل؛ نحسب إسقاط كل نقطة (x عرضاً، y عمقاً، h ارتفاعاً) على الشاشة.
     خطأ يسار، صح يمين، والممر في الوسط.                                                  */
  const SCENE = {
    tilt: (50 * Math.PI) / 180,
    dist: 1500,
    far: -240,
    near: 240,
    thick: 34,
    pole: 125,
    zones: {
      false: { x0: -700, x1: -235, cols: 5, rows: 5, label: 'خطأ' },
      mid: { x0: -195, x1: 195, cols: 4, rows: 5 },
      true: { x0: 235, x1: 700, cols: 5, rows: 5, label: 'صح' },
    },
  };
  const SIN = Math.sin(SCENE.tilt);
  const COS = Math.cos(SCENE.tilt);

  function project(x, y, h) {
    h = h || 0;
    const z = y * SIN + h * COS;
    const k = SCENE.dist / (SCENE.dist - z);
    return { x: x * k, y: (y * COS - h * SIN) * k, k };
  }

  const fit = { w: 0, h: 0, s: 1, ox: 0, oy: 0 };

  function computeFit() {
    const w = ui.arena.clientWidth;
    const h = ui.arena.clientHeight;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const z of Object.values(SCENE.zones)) {
      const corners = [
        project(z.x0, SCENE.far, SCENE.pole + 125), project(z.x1, SCENE.far, SCENE.pole + 125),
        project(z.x0, SCENE.near, -SCENE.thick), project(z.x1, SCENE.near, -SCENE.thick),
      ];
      for (const p of corners) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    const padX = w * 0.025, padT = h * 0.03, padB = h * 0.05;
    const s = Math.max(0.05, Math.min((w - 2 * padX) / (maxX - minX), (h - padT - padB) / (maxY - minY)));
    fit.w = w;
    fit.h = h;
    fit.s = s;
    fit.ox = w / 2 - ((minX + maxX) / 2) * s;
    fit.oy = padT + (h - padT - padB - (maxY - minY) * s) / 2 - minY * s;
  }

  function P(x, y, h) {
    const p = project(x, y, h);
    return { x: fit.ox + p.x * fit.s, y: fit.oy + p.y * fit.s, k: p.k };
  }

  const pts = (list) => list.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');

  // رسم المنصات الثلاث. كل منصة في طبقة مستقلة حتى تطيح لوحدها (transform: translateY)
  function drawPlatforms() {
    if (!fit.w || !fit.h) return;
    for (const key of ['false', 'mid', 'true']) {
      const z = SCENE.zones[key];
      const { x0, x1, cols, rows } = z;
      const y0 = SCENE.far, y1 = SCENE.near, T = SCENE.thick;
      const root = svgNode('svg', { width: fit.w, height: fit.h, 'aria-hidden': 'true' });

      const defs = svgNode('defs', {}, root);
      const glow = svgNode('filter', { id: 'glow-' + key, x: '-10%', y: '-10%', width: '120%', height: '120%' }, defs);
      svgNode('feGaussianBlur', { stdDeviation: (3.4 * fit.s).toFixed(2), result: 'b' }, glow);
      const merge = svgNode('feMerge', {}, glow);
      svgNode('feMergeNode', { in: 'b' }, merge);
      svgNode('feMergeNode', { in: 'SourceGraphic' }, merge);
      const haze = svgNode('filter', { id: 'haze-' + key, x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
      svgNode('feGaussianBlur', { stdDeviation: (30 * fit.s).toFixed(1) }, haze);

      // انعكاس الضوء تحت المنصة
      const hc = P((x0 + x1) / 2, y1, -T * 2.5);
      svgNode('ellipse', {
        class: 'halo', cx: hc.x, cy: hc.y, rx: ((x1 - x0) * 0.55 * fit.s).toFixed(1), ry: (60 * fit.s).toFixed(1),
        filter: 'url(#haze-' + key + ')',
      }, root);

      // اللافتة (صح / خطأ) خلف الحافة البعيدة
      if (z.label) drawSign(root, z);

      // الوجه الأمامي (سماكة المنصة)
      svgNode('polygon', { class: 'face face-front', points: pts([P(x0, y1, 0), P(x1, y1, 0), P(x1, y1, -T), P(x0, y1, -T)]) }, root);
      // الوجه الجانبي المقابل للوسط
      if (key !== 'mid') {
        const sx = key === 'false' ? x1 : x0;
        svgNode('polygon', { class: 'face face-side', points: pts([P(sx, y0, 0), P(sx, y1, 0), P(sx, y1, -T), P(sx, y0, -T)]) }, root);
      }
      // السطح
      svgNode('polygon', { class: 'slab', points: pts([P(x0, y0, 0), P(x1, y0, 0), P(x1, y1, 0), P(x0, y1, 0)]) }, root);
      // البلاطات المضيئة
      const tiles = svgNode('g', { class: 'tiles', filter: 'url(#glow-' + key + ')' }, root);
      const gap = 7;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const ax = x0 + ((x1 - x0) * c) / cols + gap, bx = x0 + ((x1 - x0) * (c + 1)) / cols - gap;
          const ay = y0 + ((y1 - y0) * r) / rows + gap, by = y0 + ((y1 - y0) * (r + 1)) / rows - gap;
          svgNode('polygon', { class: 'tile', points: pts([P(ax, ay, 0), P(bx, ay, 0), P(bx, by, 0), P(ax, by, 0)]) }, tiles);
        }
      }
      ui.plat[key].replaceChildren(root);
    }
  }

  function drawSign(root, z) {
    const cx = (z.x0 + z.x1) / 2;
    const half = (z.x1 - z.x0) * 0.2;
    const y = SCENE.far - 6;
    const top = P(cx, y, SCENE.pole);
    const u = top.k * fit.s;
    for (const dx of [-half, half]) {
      const a = P(cx + dx, y, 0), b = P(cx + dx, y, SCENE.pole);
      svgNode('line', { class: 'pole', x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': (8 * u).toFixed(1) }, root);
    }
    const w = 250 * u, h = 96 * u;
    const g = svgNode('g', { class: 'sign' }, root);
    svgNode('rect', {
      class: 'sign-board', x: top.x - w / 2, y: top.y - h + 12 * u, width: w, height: h,
      rx: 24 * u, 'stroke-width': (5 * u).toFixed(1),
    }, g);
    const t = svgNode('text', {
      class: 'sign-text', x: top.x, y: top.y - h / 2 + 12 * u, 'font-size': (58 * u).toFixed(1),
      'text-anchor': 'middle', 'dominant-baseline': 'central',
    }, g);
    t.textContent = z.label;
  }

  /* ───────────────────────── توزيع الشخصيات ───────────────────────── */
  function layoutZone(key, ids) {
    const z = SCENE.zones[key];
    const out = new Map();
    const n = ids.length;
    if (!n) return out;
    const W = z.x1 - z.x0, D = SCENE.near - SCENE.far;
    const ix0 = z.x0 + W * 0.13, iw = W * 0.74;
    const iy0 = SCENE.far + D * 0.13, id = D * 0.8;
    // العمق يبان أقصر على الشاشة (المنظور)، فنفضّل أعمدة أكثر من الصفوف
    const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt((n * iw) / (id * COS)))));
    const rows = Math.ceil(n / cols);
    const cw = iw / cols, rh = id / rows;
    ids.forEach((pid, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const inRow = r === rows - 1 ? n - r * cols : cols;
      const jx = (seeded(pid + 'x') - 0.5) * cw * 0.3;
      const jy = (seeded(pid + 'y') - 0.5) * rh * 0.3;
      // صفوف متبادلة حتى ما تغطي علامة اللي قدّام وجه اللي وراه
      const stagger = rows > 1 && cols > 1 ? (r % 2 ? 0.22 : -0.22) * cw : 0;
      out.set(pid, {
        x: ix0 + (c + 0.5 + (cols - inRow) / 2) * cw + jx + stagger,
        y: iy0 + (r + 0.5) * rh + jy,
      });
    });
    return out;
  }

  const crowdFactor = (n) => Math.max(0.5, Math.min(1, 1.12 - 0.022 * n));

  /* ───────────────────────── الشخصيات على الشاشة ───────────────────────── */
  const nodes = new Map(); // playerId -> { el, zone, nameEl, moveTimer }

  function ensureNode(p) {
    let n = nodes.get(p.id);
    if (n) {
      if (n.nameEl.textContent !== p.name) n.nameEl.textContent = p.name;
      return n;
    }
    const el = make('div', 'player entering no-tr');
    el.dataset.id = p.id;
    el.style.setProperty('--d', (-seeded(p.id + 'd') * 1.7).toFixed(2) + 's');

    const hole = make('div', 'hole');
    hole.appendChild(make('i'));
    const fall = make('div', 'p-fall');
    const scale = make('div', 'p-scale');
    const tag = make('div', 'p-tag');
    const mark = make('div', 'p-mark');
    mark.innerHTML = CHECK_SVG + '<b class="m-q">؟</b><b class="m-crown">👑</b>';
    const nameEl = make('span', 'p-name', p.name);
    const kick = make('button', 'p-kick', '✕');
    kick.type = 'button';
    kick.title = 'إخراج اللاعب';
    kick.setAttribute('aria-label', 'إخراج ' + p.name);
    kick.addEventListener('click', (e) => {
      e.stopPropagation();
      socket.emit('host:kick', { playerId: p.id }, () => {});
    });
    tag.append(mark, nameEl, kick);
    scale.append(tag, buildAvatar(p.color), make('div', 'p-shadow'));
    fall.appendChild(scale);
    el.append(hole, fall);
    ui.crowd.appendChild(el);

    n = { el, zone: null, nameEl, moveTimer: null };
    nodes.set(p.id, n);
    setTimeout(() => el.classList.remove('entering'), 700);
    return n;
  }

  function removeNode(id, n) {
    nodes.delete(id);
    clearTimeout(n.moveTimer);
    if (n.el.classList.contains('falling') || n.el.classList.contains('sink')) {
      n.el.remove();
      return;
    }
    n.el.classList.add('leaving');
    setTimeout(() => n.el.remove(), 400);
  }

  // من يظهر في الساحة، وفي أي منطقة
  function displayed() {
    const ph = S.phase;
    if (ph === 'lobby') return S.players.map((p) => ({ p, zone: 'mid' }));
    if (ph === 'question') return S.players.filter((p) => p.inRound).map((p) => ({ p, zone: 'mid' }));
    if (ph === 'reveal' || ph === 'result') {
      return S.players.filter((p) => p.inRound).map((p) => ({
        p, zone: p.choice === true ? 'true' : p.choice === false ? 'false' : 'mid',
      }));
    }
    if (ph === 'gameover') {
      return S.winners.map((w) => ({ p: Object.assign({ connected: true }, w, S.players.find((x) => x.id === w.id) || {}), zone: 'mid' }));
    }
    return [];
  }

  function renderArena() {
    if (!S || !fit.w) return;
    const list = displayed();
    const byZone = { false: [], mid: [], true: [] };
    for (const d of list) byZone[d.zone].push(d.p.id);
    const slots = new Map();
    for (const key of Object.keys(byZone)) {
      for (const [id, pos] of layoutZone(key, byZone[key])) slots.set(id, pos);
    }
    ui.crowd.style.setProperty('--av', (70 * fit.s * crowdFactor(list.length)).toFixed(1) + 'px');

    const seen = new Set();
    const fresh = [];
    const roundKey = S.round ? S.round.id : '';
    for (const d of list) {
      const p = d.p;
      seen.add(p.id);
      const isNew = !nodes.has(p.id);
      const n = ensureNode(p);
      if (isNew) fresh.push(n);

      // انتقال لمنطقة ثانية = انزلاق (مع تأخير بسيط مختلف لكل لاعب)
      if (n.zone !== null && n.zone !== d.zone) {
        const delay = S.phase === 'reveal' ? seeded(p.id + ':' + roundKey) * 0.35 : seeded(p.id + 'back') * 0.2;
        n.el.style.setProperty('--delay', delay.toFixed(2) + 's');
        n.el.classList.add('moving');
        clearTimeout(n.moveTimer);
        n.moveTimer = setTimeout(() => {
          n.el.classList.remove('moving');
          n.el.style.setProperty('--delay', '0s');
        }, 1500);
      }
      n.zone = d.zone;

      const pos = slots.get(p.id);
      const scr = P(pos.x, pos.y, 0);
      n.el.style.left = scr.x.toFixed(1) + 'px';
      n.el.style.top = scr.y.toFixed(1) + 'px';
      n.el.style.zIndex = String(Math.round(scr.y));
      n.el.style.setProperty('--k', scr.k.toFixed(3));

      n.el.classList.toggle('answered', S.phase === 'question' && p.answered);
      n.el.classList.toggle('noanswer', (S.phase === 'reveal' || S.phase === 'result') && p.choice === null);
      n.el.classList.toggle('winner', S.phase === 'gameover');
      n.el.classList.toggle('offline', p.connected === false && S.phase !== 'gameover');
    }
    for (const [id, n] of nodes) if (!seen.has(id)) removeNode(id, n);

    // الشخصيات الجديدة تظهر في مكانها مباشرة بدون انزلاق من الزاوية
    if (fresh.length) {
      void ui.crowd.offsetWidth;
      for (const n of fresh) n.el.classList.remove('no-tr');
    }

    // تلميح الساحة الفاضية
    const c = P(0, 0, 0);
    ui.emptyHint.style.left = c.x + 'px';
    ui.emptyHint.style.top = c.y + 'px';
    ui.emptyHint.hidden = !(S.phase === 'lobby' && S.players.length === 0);
  }

  /* ───────────────────────── مؤثرات المراحل ───────────────────────── */
  let revealTimer = null;

  function phaseEffects(prevPhase, prevRound) {
    const ph = S.phase;
    const round = S.round ? S.round.id : '';
    if (ph === prevPhase && round === prevRound) return;
    clearTimeout(revealTimer);

    if (ph === 'question') {
      restorePlatforms();
      clearPlayerFx();
      hideBanner();
      ui.question.classList.remove('q-in');
      void ui.question.offsetWidth;
      ui.question.classList.add('q-in');
    } else if (ph === 'reveal') {
      showBanner('انتهى الوقت!', '', 'time');
      revealTimer = setTimeout(() => {
        if (S.phase === 'reveal') showBanner('والجواب الصحيح…', '', 'suspense');
      }, 1300);
    } else if (ph === 'result') {
      runResult();
    } else if (ph === 'gameover') {
      restorePlatforms();
      clearPlayerFx();
      hideBanner();
      launchConfetti();
    } else if (ph === 'lobby') {
      restorePlatforms();
      clearPlayerFx();
      hideBanner();
      ui.confetti.replaceChildren();
    }
  }

  // الإقصاء: المنصة الخاطئة تهتز ثم تطيح، ومعها اللي واقفين عليها
  function runResult() {
    const r = S.result;
    if (!r) return;
    const right = r.correct ? 'true' : 'false';
    const wrong = r.correct ? 'false' : 'true';
    const fallen = new Set(r.fallen);

    ui.plat[right].classList.add('win');
    ui.plat[wrong].classList.add(r.mercy ? 'shaking' : 'falling');

    for (const [id, n] of nodes) {
      if (fallen.has(id)) n.el.classList.add(n.zone === 'mid' ? 'sink' : 'falling');
      else if (n.zone === right) n.el.classList.add('cheer');
      else if (r.mercy && n.zone === wrong) n.el.classList.add('shaking');
    }

    let sub;
    if (r.mercy) sub = 'الكل غلط! محد طاح هالمرة 😅';
    else if (!r.fallen.length) sub = 'محد طاح! كلكم صح 🎉';
    else sub = 'طاح ' + playersLabel(r.fallen.length) + '!';
    showBanner('الجواب الصحيح: ' + (r.correct ? 'صح' : 'خطأ'), sub, r.correct ? 'true' : 'false');
  }

  // المنصة اللي طاحت ترجع تطلع من تحت
  function restorePlatforms() {
    for (const el of Object.values(ui.plat)) {
      el.classList.remove('win', 'shaking');
      if (el.classList.contains('falling')) {
        el.classList.remove('falling');
        el.classList.add('rising');
        setTimeout(() => el.classList.remove('rising'), 950);
      }
    }
  }

  function clearPlayerFx() {
    for (const n of nodes.values()) n.el.classList.remove('cheer', 'shaking', 'falling', 'sink');
  }

  function showBanner(main, sub, tone) {
    ui.bannerMain.textContent = main;
    ui.bannerSub.textContent = sub || '';
    ui.bannerSub.hidden = !sub;
    ui.banner.className = 'banner';
    void ui.banner.offsetWidth; // إعادة تشغيل الحركة
    ui.banner.className = 'banner show tone-' + (tone || 'plain');
  }

  function hideBanner() {
    ui.banner.className = 'banner';
  }

  function launchConfetti() {
    const colors = ['#3cf58f', '#ff4467', '#c9f94e', '#ffd23f', '#4cc9f0', '#f72585', '#ffffff'];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 80; i++) {
      const c = make('i');
      c.style.left = (Math.random() * 100).toFixed(1) + '%';
      c.style.background = colors[i % colors.length];
      c.style.animationDelay = (Math.random() * 2).toFixed(2) + 's';
      c.style.animationDuration = (2.8 + Math.random() * 2.2).toFixed(2) + 's';
      c.style.setProperty('--x', Math.round(Math.random() * 180 - 90) + 'px');
      c.style.setProperty('--r', Math.round(Math.random() * 900 - 450) + 'deg');
      frag.appendChild(c);
    }
    ui.confetti.replaceChildren(frag);
  }

  /* ───────────────────────── اللوحات العلوية ───────────────────────── */
  function renderPanels() {
    const ph = S.phase;
    const inGame = ph === 'question' || ph === 'reveal' || ph === 'result';
    ui.body.dataset.phase = ph;
    ui.roomCode.textContent = S.code;
    ui.lobbyCode.textContent = S.code;

    ui.lobby.hidden = ph !== 'lobby';
    ui.question.hidden = !inGame || !S.round;
    ui.gameover.hidden = ph !== 'gameover';

    // الشريط العلوي
    const alive = S.players.filter((p) => p.alive && !p.spectator).length;
    ui.hudPlayers.hidden = !inGame;
    ui.hudPlayers.textContent = 'باقي ' + alive + ' من ' + S.startCount;
    const waiting = S.players.filter((p) => p.spectator).length;
    ui.hudWaiting.hidden = !(waiting && ph !== 'lobby');
    ui.hudWaiting.textContent = waiting === 1 ? 'لاعب ينتظر اللعبة الجاية' : playersLabel(waiting) + ' ينتظرون اللعبة الجاية';
    ui.endBtn.hidden = !inGame;
    ui.inviteBtn.hidden = ph === 'lobby';
    if (!inGame) disarmEnd();

    if (ph === 'lobby') {
      const n = S.players.length;
      ui.lobbyCount.textContent = n ? 'داخل الغرفة: ' + playersLabel(n) : 'ما دخل أحد للحين';
      ui.startBtn.disabled = n < 1 || startPending;
      updateJoin();
    }

    if (inGame && S.round) {
      const r = S.round;
      ui.qCategory.textContent = r.category || 'سؤال';
      ui.qRound.textContent = 'السؤال ' + (r.index + 1) + ' من ' + r.total;
      if (ui.qText.textContent !== r.text) ui.qText.textContent = r.text;
      const inRound = S.players.filter((p) => p.inRound);
      const done = inRound.filter((p) => p.answered).length;
      if (ph === 'question') {
        ui.answered.textContent = S.allAnswered ? 'الكل جاوب!' : 'جاوب ' + done + ' من ' + inRound.length;
      } else {
        ui.answered.textContent = 'انتهى الوقت';
        ui.timerNum.textContent = '0';
        ui.timerArc.style.strokeDashoffset = '100';
        ui.timer.classList.remove('urgent');
      }
    }

    if (ph === 'gameover') {
      const w = S.winners;
      ui.goNames.classList.toggle('many', w.length > 3);
      if (w.length === 1) {
        ui.goTitle.textContent = '👑 الفائز';
        ui.goNames.textContent = w[0].name;
      } else if (w.length > 1) {
        ui.goTitle.textContent = '👑 صمدوا للنهاية';
        ui.goNames.textContent = w.map((x) => x.name).join('، ');
      } else {
        ui.goTitle.textContent = 'انتهت اللعبة';
        ui.goNames.textContent = 'ما بقى أحد!';
      }
    }
  }

  // العداد يتحرك محلياً بين رسائل السيرفر
  let deadline = 0;
  function tick() {
    if (S && S.phase === 'question') {
      const left = Math.max(0, deadline - performance.now());
      const sec = String(Math.ceil(left / 1000));
      if (ui.timerNum.textContent !== sec) ui.timerNum.textContent = sec;
      ui.timerArc.style.strokeDashoffset = (100 * (1 - left / S.questionMs)).toFixed(2);
      ui.timer.classList.toggle('urgent', left <= 5000);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  /* ───────────────────────── الرابط والباركود ───────────────────────── */
  let bases = []; // [{ base, label }]
  let baseIdx = 0;
  const qrDrawn = new Map(); // مربع الباركود -> الرابط المرسوم فيه

  function setNetwork(net) {
    const list = [];
    const isLocal = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(location.hostname);
    // اللعبة على موقع إنترنت (مو على كمبيوتر البيت): رابط الموقع نفسه يكفي، والأصدقاء يدخلون من أي مكان
    const isPublic = !isLocal && !/^\d+\.\d+\.\d+\.\d+$/.test(location.hostname);
    if (isPublic) {
      bases = [{ base: location.origin, label: location.host }];
      baseIdx = 0;
      ui.netRow.hidden = true;
      ui.netWarn.hidden = true;
      $('#joinHint').textContent = 'أصدقاؤك يدخلون من أي مكان، حتى لو مو على نفس الواي فاي.';
      updateJoin();
      return;
    }
    if (!isLocal) list.push({ base: location.origin, label: location.host + ' (العنوان الحالي)' });
    const port = (net && net.port) || location.port || 80;
    for (const a of (net && net.addresses) || []) {
      const base = 'http://' + a.address + ':' + port;
      if (!list.some((x) => x.base === base)) list.push({ base, label: a.address + ' (' + a.name + ')' });
    }
    ui.netWarn.hidden = list.length > 0;
    if (!list.length) list.push({ base: location.origin, label: location.host });

    const prev = bases[baseIdx] && bases[baseIdx].base;
    bases = list;
    baseIdx = Math.max(0, bases.findIndex((b) => b.base === prev));
    ui.netSelect.replaceChildren(...bases.map((b, i) => {
      const o = make('option', null, b.label);
      o.value = String(i);
      return o;
    }));
    ui.netSelect.value = String(baseIdx);
    ui.netRow.hidden = bases.length < 2;
    updateJoin();
  }

  function joinUrl() {
    return S && bases.length ? bases[baseIdx].base + '/mobile.html?room=' + S.code : '';
  }

  function updateJoin() {
    const url = joinUrl();
    if (!url) return;
    if (ui.joinUrl.textContent !== url) ui.joinUrl.textContent = url;
    if (ui.inviteUrl.textContent !== url) ui.inviteUrl.textContent = url;
    drawQR(ui.qr, url);
    drawQR(ui.qrInvite, url);
  }

  function drawQR(box, url) {
    if (qrDrawn.get(box) === url) return;
    if (window.QR_LIB === 'loading') return; // نرسمه أول ما تتحمّل المكتبة
    qrDrawn.set(box, url);
    box.classList.remove('loading');
    box.replaceChildren();
    let drawn = false;
    if (window.QR_LIB === 'ready' && typeof window.QRCode === 'function') {
      // qrcode.js
      try {
        new window.QRCode(box, {
          text: url, width: 512, height: 512,
          colorDark: '#1a1033', colorLight: '#ffffff',
          correctLevel: window.QRCode.CorrectLevel.M,
        });
        box.removeAttribute('title');
        drawn = true;
      } catch (e) {
        box.replaceChildren();
      }
    }
    if (!drawn) {
      // بديل بدون إنترنت: باركود SVG من السيرفر
      const img = new Image();
      img.alt = 'باركود الدخول';
      img.src = '/qr.svg?text=' + encodeURIComponent(url);
      box.appendChild(img);
    }
  }

  window.addEventListener('qrlib', () => {
    qrDrawn.clear();
    updateJoin();
  });
  setTimeout(() => {
    if (window.QR_LIB === 'loading') {
      window.QR_LIB = 'failed';
      window.dispatchEvent(new Event('qrlib'));
    }
  }, 3500);

  ui.netSelect.addEventListener('change', () => {
    baseIdx = Number(ui.netSelect.value) || 0;
    updateJoin();
  });

  // نسخ الرابط (Clipboard API، مع طريقة احتياطية إذا الصفحة مو على localhost)
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* نجرب الطريقة القديمة */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function wireCopy(btn, textEl) {
    let timer = null;
    btn.addEventListener('click', async () => {
      const url = joinUrl();
      if (!url) return;
      const ok = await copyText(url);
      btn.textContent = ok ? 'تم النسخ ✓' : 'انسخه يدوياً';
      if (!ok) {
        const range = document.createRange();
        range.selectNodeContents(textEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      clearTimeout(timer);
      timer = setTimeout(() => { btn.textContent = 'نسخ الرابط'; }, 2000);
    });
  }
  wireCopy(ui.copyBtn, ui.joinUrl);
  wireCopy(ui.inviteCopy, ui.inviteUrl);

  // باركود الدخول متى ما تبي، حتى وسط اللعب
  function openInvite() {
    updateJoin();
    ui.invite.hidden = false;
    ui.inviteClose.focus();
  }
  function closeInvite() {
    ui.invite.hidden = true;
  }
  ui.inviteBtn.addEventListener('click', openInvite);
  ui.inviteClose.addEventListener('click', closeInvite);
  ui.invite.addEventListener('click', (e) => { if (e.target === ui.invite) closeInvite(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ui.invite.hidden) closeInvite(); });

  /* ───────────────────────── أزرار المضيف ───────────────────────── */
  let startPending = false;
  ui.startBtn.addEventListener('click', () => {
    startPending = true;
    ui.startBtn.disabled = true;
    keepAwake();
    socket.emit('host:start', {}, (res) => {
      startPending = false;
      if (!res || !res.ok) {
        toast((res && res.error) || 'تعذر بدء اللعبة');
        if (S && S.phase === 'lobby') ui.startBtn.disabled = S.players.length < 1;
      }
    });
  });

  ui.againBtn.addEventListener('click', () => socket.emit('host:reset', {}, () => {}));

  // إنهاء اللعبة يحتاج ضغطتين حتى ما ينضغط بالغلط
  let endArmed = null;
  function disarmEnd() {
    clearTimeout(endArmed);
    endArmed = null;
    ui.endBtn.textContent = 'إنهاء اللعبة';
    ui.endBtn.classList.remove('armed');
  }
  ui.endBtn.addEventListener('click', () => {
    if (!endArmed) {
      ui.endBtn.textContent = 'متأكد؟ اضغط مرة ثانية';
      ui.endBtn.classList.add('armed');
      endArmed = setTimeout(disarmEnd, 3000);
      return;
    }
    disarmEnd();
    socket.emit('host:reset', {}, () => {});
  });

  let toastTimer = null;
  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2800);
  }

  // إبقاء الشاشة شغالة أثناء اللعب
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* غير مدعوم */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake();
  });
  keepAwake();

  /* ───────────────────────── الاتصال بالسيرفر ───────────────────────── */
  let S = null; // آخر حالة من السيرفر
  const socket = io();

  socket.on('connect', () => {
    ui.offline.hidden = true;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('tfe-host') || 'null'); } catch (e) { saved = null; }
    socket.emit('host:hello', saved || {}, (res) => {
      if (!res || !res.ok) return toast('تعذر تجهيز الغرفة');
      try { sessionStorage.setItem('tfe-host', JSON.stringify({ code: res.code, key: res.key })); } catch (e) { /* */ }
      setNetwork(res.network);
    });
  });

  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') return;
    $('#offlineTitle').textContent = 'انقطع الاتصال بالسيرفر';
    $('#offlineText').textContent = 'نحاول نرجع… تأكد إن السيرفر شغال (npm start).';
    ui.offline.hidden = false;
  });

  socket.on('host:replaced', () => {
    $('#offlineTitle').textContent = 'الغرفة مفتوحة في نافذة ثانية';
    $('#offlineText').textContent = 'كمّل من النافذة الثانية، أو حدّث هذي الصفحة لفتح غرفة جديدة.';
    ui.offline.hidden = false;
    try { sessionStorage.removeItem('tfe-host'); } catch (e) { /* */ }
  });

  socket.on('state', (s) => {
    const prevIds = S ? new Set(S.players.map((p) => p.id)) : null;
    const prevPhase = S ? S.phase : null;
    const prevRound = S && S.round ? S.round.id : '';
    S = s;
    if (s.phase === 'question') deadline = performance.now() + s.remainingMs;
    renderPanels();
    renderArena();
    phaseEffects(prevPhase, prevRound);
    // صديق دخل وسط اللعب: نبلّغ المضيف لأن شخصيته تطلع من السؤال الجاي
    if (prevIds && s.phase !== 'lobby') {
      for (const p of s.players) {
        if (!prevIds.has(p.id)) toast(p.name + (s.phase === 'gameover' ? ' دخل! يلعب معكم في اللعبة الجاية' : ' دخل! يلعب من السؤال الجاي'));
      }
    }
  });

  /* ───────────────────────── تغيير حجم الشاشة ───────────────────────── */
  function relayout() {
    computeFit();
    drawPlatforms();
    ui.crowd.classList.add('instant');
    renderArena();
    void ui.crowd.offsetWidth;
    ui.crowd.classList.remove('instant');
  }
  new ResizeObserver(relayout).observe(ui.arena);
})();
