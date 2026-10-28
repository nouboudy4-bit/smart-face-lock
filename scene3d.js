/* 3D-иллюстрация: умный дверной замок с распознаванием лица.
   Камера + PIR + Raspberry Pi у двери → соленоидный замок; события по MQTT → сервер → Telegram.
   Нужны vendor/three.min.js и vendor/OrbitControls.js (Three.js r147).
   API: FaceLock3D.mount(host, onState), FaceLock3D.start(), FaceLock3D.stop(), FaceLock3D.toggleRotate() */
(function () {
  let renderer, scene, camera, controls, host, clock, running = false, raf = 0, onState = () => {};
  const packets = [], routes = {};
  let door, bolt, panelLed, panelDisp, phoneTex, person, scan, porch;
  const msgs = [];
  const VISITORS = [
    { name: 'Айгерим', kind: 'known', shirt: 0x2563eb, hair: 0x2b1a10, dist: 0.31 },
    { name: 'Неизвестный', kind: 'unknown', shirt: 0x3f4654, hair: 0x1f2937, hood: true, dist: 0.71 },
    { name: 'Фото Айгерим', kind: 'spoof', shirt: 0x7c3aed, hair: 0x111111, dist: 0.33 },
  ];
  const ST = { vi: 0, t: 0, phase: '', sent: {} };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const ease = x => x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x);
  const hhmm = () => new Date().toTimeString().slice(0, 5);

  // ---------- вспомогательное ----------
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function canvasTex(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = 8;
    return { c, ctx: c.getContext('2d'), tex };
  }
  function mat(color, o = {}) { return new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.6, metalness: 0.1 }, o)); }
  function box(w, h, d, color, o) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, o)); m.castShadow = m.receiveShadow = true; return m;
  }
  function label(text, sub, color) {
    const { ctx, tex } = canvasTex(512, 150);
    ctx.fillStyle = 'rgba(10,16,30,.88)'; rr(ctx, 4, 4, 504, 142, 26); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 5; rr(ctx, 4, 4, 504, 142, 26); ctx.stroke();
    ctx.fillStyle = '#e8eefc'; ctx.textAlign = 'center';
    let fs = 52; do { ctx.font = `700 ${fs}px Inter,Segoe UI,sans-serif`; fs -= 2; } while (ctx.measureText(text).width > 460);
    ctx.fillText(text, 256, sub ? 70 : 92);
    if (sub) { ctx.fillStyle = '#8fa0c4'; ctx.font = '34px Inter,Segoe UI,sans-serif'; ctx.fillText(sub, 256, 120); }
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    s.scale.set(1.5, 0.44, 1); s.renderOrder = 10; return s;
  }

  // ---------- человек ----------
  function makePerson(v) {
    const g = new THREE.Group();
    const skin = mat(0xd9a77f), shirt = mat(v.shirt), pants = mat(0x1e293b), shoe = mat(0x111111);
    const limb = (r, h, m) => { const p = new THREE.Group(); const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.9, h, 12), m); c.position.y = -h / 2; c.castShadow = true; p.add(c); return p; };
    g.legL = limb(0.075, 0.86, pants); g.legL.position.set(-0.1, 0.9, 0); g.add(g.legL);
    g.legR = limb(0.075, 0.86, pants); g.legR.position.set(0.1, 0.9, 0); g.add(g.legR);
    [g.legL, g.legR].forEach(l => { const s = box(0.13, 0.07, 0.24, 0x111111); s.material = shoe; s.position.set(0, -0.86, -0.05); l.add(s); });
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.62, 16), shirt); torso.position.y = 1.2; torso.castShadow = true; g.add(torso);
    const sh = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), shirt); sh.scale.y = 0.45; sh.position.y = 1.5; g.add(sh);
    g.armL = limb(0.055, 0.6, shirt); g.armL.position.set(-0.25, 1.48, 0); g.add(g.armL);
    g.armR = limb(0.055, 0.6, shirt); g.armR.position.set(0.25, 1.48, 0); g.add(g.armR);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 10), skin); neck.position.y = 1.56; g.add(neck);
    const head = new THREE.Group(); head.position.y = 1.7; g.add(head); g.head = head;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 20), skin); skull.scale.set(1, 1.15, 1.05); skull.castShadow = true; head.add(skull);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.128, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.5), mat(v.hair));
    hair.scale.set(1, 1.15, 1.08); hair.position.y = 0.01; head.add(hair);
    if (v.hood) {
      const hood = new THREE.Mesh(new THREE.SphereGeometry(0.165, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.62), shirt);
      hood.scale.set(1, 1.15, 1.1); hood.position.set(0, 0.01, 0.03); head.add(hood);
    }
    const eye = mat(0x111111);
    [-0.045, 0.045].forEach(x => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.017, 10, 8), eye); e.position.set(x, 0.02, -0.122); head.add(e); });
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.05, 8), skin); nose.rotation.x = -Math.PI / 2; nose.position.set(0, -0.02, -0.13); head.add(nose);
    if (v.kind === 'spoof') { // держит телефон с фото перед лицом
      const ph = new THREE.Group(); ph.position.set(0, 1.68, -0.32); g.add(ph); g.photo = ph;
      ph.add(box(0.16, 0.3, 0.015, 0x0d0f13));
      const ft = canvasTex(128, 240), c = ft.ctx;
      c.fillStyle = '#cfd8e3'; c.fillRect(0, 0, 128, 240);
      c.fillStyle = '#d9a77f'; c.beginPath(); c.ellipse(64, 120, 38, 50, 0, 0, 7); c.fill();
      c.fillStyle = '#2b1a10'; c.beginPath(); c.ellipse(64, 86, 40, 26, 0, Math.PI, 0); c.fill();
      c.fillStyle = '#111'; c.beginPath(); c.arc(50, 116, 4, 0, 7); c.arc(78, 116, 4, 0, 7); c.fill();
      c.strokeStyle = '#8a4b3b'; c.lineWidth = 3; c.beginPath(); c.arc(64, 140, 12, 0.2, Math.PI - 0.2); c.stroke();
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.145, 0.28), new THREE.MeshBasicMaterial({ map: ft.tex, toneMapped: false }));
      scr.rotation.y = Math.PI; scr.position.z = -0.009; ph.add(scr);
      g.armR.rotation.x = 1.35; g.armR.rotation.z = 0.35;
    }
    g.traverse(o => { if (o.isMesh) o.castShadow = true; });
    return g;
  }

  // ---------- сцена ----------
  function build() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1220);
    scene.fog = new THREE.Fog(0x0b1220, 14, 28);
    scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x1a1410, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(5, 9, 7); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -6, near: 1, far: 30 });
    scene.add(sun);
    porch = new THREE.SpotLight(0xffd9a0, 1.2, 9, 0.7, 0.5); porch.position.set(0, 3.2, 1.4); porch.target.position.set(0, 0, 1.5);
    porch.castShadow = true; scene.add(porch, porch.target);

    // пол: плитка снаружи
    const ft = canvasTex(512, 512), f = ft.ctx;
    f.fillStyle = '#3a4252'; f.fillRect(0, 0, 512, 512);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { f.fillStyle = `hsl(220,10%,${24 + Math.random() * 6}%)`; f.fillRect(x * 64 + 2, y * 64 + 2, 60, 60); }
    ft.tex.wrapS = ft.tex.wrapT = THREE.RepeatWrapping; ft.tex.repeat.set(5, 5);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), mat(0xffffff, { map: ft.tex, roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
    // коврик у двери
    const rug = box(1.3, 0.02, 0.7, 0x5b3a29, { roughness: 1 }); rug.position.set(0, 0.01, 0.75); scene.add(rug);

    // стена с проёмом
    const wallM = mat(0xc9ced8, { roughness: 0.95 });
    const wl = new THREE.Mesh(new THREE.BoxGeometry(3.45, 3.2, 0.2), wallM); wl.position.set(-2.275, 1.6, 0);
    const wr = wl.clone(); wr.position.x = 2.275;
    const wt = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 0.2), wallM); wt.position.set(0, 2.65, 0);
    [wl, wr, wt].forEach(w => { w.castShadow = w.receiveShadow = true; scene.add(w); });
    const trim = mat(0x8b5e3c);
    [[0.06, 2.12, 0.26, -0.53, 1.06], [0.06, 2.12, 0.26, 0.53, 1.06], [1.12, 0.06, 0.26, 0, 2.13]].forEach(([w, h, d, x, y]) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), trim); m.position.set(x, y, 0); m.castShadow = true; scene.add(m);
    });
    // табличка
    const sign = canvasTex(256, 96); sign.ctx.fillStyle = '#1b2a44'; sign.ctx.fillRect(0, 0, 256, 96);
    sign.ctx.fillStyle = '#e8eefc'; sign.ctx.font = 'bold 44px sans-serif'; sign.ctx.textAlign = 'center'; sign.ctx.fillText('LAB 502', 128, 62);
    const sm = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.19), new THREE.MeshStandardMaterial({ map: sign.tex })); sm.position.set(0, 2.42, 0.11); scene.add(sm);

    // дверь на петлях
    const hinge = new THREE.Group(); hinge.position.set(-0.5, 0, 0.0); scene.add(hinge); door = hinge;
    const dt = canvasTex(256, 512), d = dt.ctx;
    d.fillStyle = '#7a4a28'; d.fillRect(0, 0, 256, 512);
    for (let i = 0; i < 60; i++) { d.strokeStyle = `rgba(40,22,10,${0.1 + Math.random() * 0.2})`; d.lineWidth = 1 + Math.random() * 2; const x = Math.random() * 256; d.beginPath(); d.moveTo(x, 0); d.bezierCurveTo(x + 8, 170, x - 8, 340, x + 4, 512); d.stroke(); }
    d.strokeStyle = 'rgba(0,0,0,.35)'; d.lineWidth = 6; d.strokeRect(36, 40, 184, 190); d.strokeRect(36, 280, 184, 190);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.98, 2.08, 0.06), [mat(0x6b4226), mat(0x6b4226), mat(0x6b4226), mat(0x6b4226), mat(0xffffff, { map: dt.tex }), mat(0xffffff, { map: dt.tex })]);
    leaf.position.set(0.49, 1.04, 0); leaf.castShadow = leaf.receiveShadow = true; hinge.add(leaf);
    const handle = box(0.14, 0.03, 0.05, 0xc0c6cf, { metalness: 0.9, roughness: 0.25 }); handle.position.set(0.86, 1.0, 0.07); hinge.add(handle);
    // соленоидный замок + ригель
    const lockBody = box(0.12, 0.2, 0.05, 0x9aa3ad, { metalness: 0.8, roughness: 0.3 }); lockBody.position.set(0.88, 1.18, 0.06); hinge.add(lockBody);
    bolt = box(0.12, 0.04, 0.03, 0xe5e7eb, { metalness: 0.95, roughness: 0.2 }); bolt.position.set(0.98, 1.18, 0.06); hinge.add(bolt);
    const strike = box(0.05, 0.12, 0.05, 0x6b7280, { metalness: 0.8 }); strike.position.set(0.535, 1.18, 0.11); scene.add(strike);

    // настенный модуль: камера + ИК-подсветка + PIR + экран, внутри Raspberry Pi
    const unit = new THREE.Group(); unit.position.set(0.95, 1.55, 0.13); scene.add(unit);
    unit.add(box(0.24, 0.42, 0.06, 0x111827, { metalness: 0.4, roughness: 0.35 }));
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 24), mat(0x0a0a0a, { metalness: 0.9, roughness: 0.1 }));
    lens.rotation.x = Math.PI / 2; lens.position.set(0, 0.14, 0.04); unit.add(lens);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.022, 24), new THREE.MeshBasicMaterial({ color: 0x1e3a8a })); glass.position.set(0, 0.14, 0.056); unit.add(glass);
    panelLed = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.007, 8, 32), new THREE.MeshBasicMaterial({ color: 0x38bdf8 }));
    panelLed.position.set(0, 0.14, 0.035); unit.add(panelLed);
    const pir = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xf5f5f5, { roughness: 0.3 }));
    pir.rotation.x = Math.PI / 2; pir.position.set(0, -0.15, 0.03); unit.add(pir);
    panelDisp = canvasTex(256, 160);
    const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.112), new THREE.MeshBasicMaterial({ map: panelDisp.tex, toneMapped: false }));
    disp.position.set(0, 0.0, 0.031); unit.add(disp);
    unit.userData.lensWorld = V(0.95, 1.69, 0.2);

    // стол охраны / администратора: сервер и телефон
    const desk = box(1.6, 0.06, 0.9, 0x334155); desk.position.set(3.4, 0.76, 2.2); scene.add(desk);
    [[-0.72, -0.38], [0.72, -0.38], [-0.72, 0.38], [0.72, 0.38]].forEach(([x, z]) => { const l = box(0.05, 0.74, 0.05, 0x1f2937); l.position.set(3.4 + x, 0.37, 2.2 + z); scene.add(l); });
    const srv = box(0.5, 0.3, 0.45, 0x2a2f3a, { metalness: 0.5, roughness: 0.4 }); srv.position.set(3.0, 0.94, 2.1); scene.add(srv);
    const srvLed = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.01), new THREE.MeshBasicMaterial({ color: 0xa78bfa })); srvLed.position.set(3.0, 0.94, 2.33); scene.add(srvLed);
    const ph = new THREE.Group(); ph.position.set(3.7, 0.8, 2.25); ph.rotation.y = -0.3; scene.add(ph);
    ph.add(box(0.36, 0.03, 0.72, 0x0d0f13, { metalness: 0.6, roughness: 0.3 }));
    phoneTex = canvasTex(400, 800);
    const pscr = new THREE.Mesh(new THREE.PlaneGeometry(0.33, 0.68), new THREE.MeshBasicMaterial({ map: phoneTex.tex, toneMapped: false }));
    pscr.rotation.x = -Math.PI / 2; pscr.position.y = 0.017; ph.add(pscr); ph.userData.base = ph.position.x; scene.userData.phone = ph;

    // подписи
    const L = (s, x, y, z) => { s.position.set(x, y, z); scene.add(s); };
    L(label('Камера · PIR', 'Raspberry Pi 4 внутри', '#38bdf8'), 1.75, 2.15, 0.3);
    L(label('Соленоидный замок', '12 В · через реле', '#fbbf24'), -1.35, 1.25, 0.4);
    L(label('Сервер', 'MQTT · FastAPI · журнал', '#a78bfa'), 3.0, 1.6, 2.1);
    L(label('Telegram', 'админ получает фото', '#38bdf8'), 4.1, 1.35, 2.6);

    // маршруты пакетов
    const q = (a, c, b) => new THREE.QuadraticBezierCurve3(a, c, b);
    routes.lock = { curve: q(V(0.95, 1.45, 0.2), V(0.75, 1.5, 0.35), V(0.4, 1.18, 0.12)), color: 0x34d399, speed: 1.6 };
    routes.mqtt = { curve: q(V(0.95, 1.6, 0.2), V(2.2, 3.0, 1.0), V(3.0, 1.1, 2.1)), color: 0x38bdf8, speed: 0.8 };
    routes.tg = { curve: q(V(3.0, 1.1, 2.1), V(3.4, 1.8, 2.3), V(3.7, 0.85, 2.25)), color: 0xf87171, speed: 1.1 };
    Object.values(routes).forEach(r => {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(r.curve.getPoints(50)),
        new THREE.LineDashedMaterial({ color: r.color, dashSize: 0.08, gapSize: 0.07, transparent: true, opacity: 0.4 }));
      l.computeLineDistances(); scene.add(l);
    });

    // визуализация сканирования: пирамида лучей + рамка + сетка точек
    scan = new THREE.Group(); scene.add(scan);
    scan.lines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3)),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.7 }));
    scan.frame = new THREE.LineLoop(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3)),
      new THREE.LineBasicMaterial({ color: 0x38bdf8 }));
    const dots = []; for (let i = 0; i < 68; i++) { const a = i / 68 * Math.PI * 2; dots.push(Math.cos(a) * (0.07 + (i % 3) * 0.025), Math.sin(a) * (0.09 + (i % 4) * 0.012), 0); }
    scan.dots = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(dots, 3)),
      new THREE.PointsMaterial({ color: 0x38bdf8, size: 0.018 }));
    scan.add(scan.lines, scan.frame, scan.dots); scan.visible = false;
  }

  // ---------- экраны ----------
  function drawDisp(state) {
    const { ctx, tex } = panelDisp;
    const col = { idle: '#64748b', motion: '#38bdf8', scan: '#38bdf8', ok: '#34d399', deny: '#f87171', spoof: '#fbbf24' }[state];
    ctx.fillStyle = '#05080f'; ctx.fillRect(0, 0, 256, 160);
    ctx.strokeStyle = col; ctx.lineWidth = 8; ctx.fillStyle = col; ctx.textAlign = 'center';
    if (state === 'ok') { ctx.beginPath(); ctx.moveTo(84, 82); ctx.lineTo(116, 112); ctx.lineTo(176, 50); ctx.stroke(); }
    else if (state === 'deny' || state === 'spoof') { ctx.beginPath(); ctx.moveTo(96, 46); ctx.lineTo(160, 110); ctx.moveTo(160, 46); ctx.lineTo(96, 110); ctx.stroke(); }
    else if (state === 'scan') { ctx.strokeRect(80, 30, 96, 96); ctx.fillRect(80, 30 + (performance.now() / 6 % 96), 96, 4); }
    else { ctx.beginPath(); ctx.arc(128, 78, 32, 0, 7); ctx.stroke(); }
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText({ idle: 'ожидание', motion: 'движение', scan: 'сканирую…', ok: 'открыто', deny: 'отказ', spoof: 'фото!' }[state], 128, 150);
    tex.needsUpdate = true;
  }
  function drawPhone() {
    const { ctx, c, tex } = phoneTex, W = c.width, H = c.height;
    ctx.fillStyle = '#0e1621'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#17212f'; ctx.fillRect(0, 0, W, 96);
    ctx.fillStyle = '#38bdf8'; ctx.beginPath(); ctx.arc(46, 54, 26, 0, 7); ctx.fill();
    ctx.fillStyle = '#e5edf7'; ctx.font = '700 26px sans-serif'; ctx.fillText('Lab502 Door Bot', 86, 50);
    ctx.fillStyle = '#6f86a8'; ctx.font = '20px sans-serif'; ctx.fillText('бот', 86, 78);
    let y = H - 20;
    for (let i = msgs.length - 1; i >= 0 && y > 130; i--) {
      const m = msgs[i], h = 26 + m.lines.length * 32 + (m.photo ? 120 : 0);
      y -= h; ctx.fillStyle = '#182533'; rr(ctx, 16, y, W - 32, h, 16); ctx.fill();
      ctx.fillStyle = m.color; ctx.fillRect(16, y + 8, 6, h - 16);
      let yy = y + 36;
      if (m.photo) { ctx.fillStyle = '#334155'; rr(ctx, 36, y + 14, 150, 108, 10); ctx.fill(); ctx.fillStyle = '#94a3b8'; ctx.beginPath(); ctx.arc(111, y + 56, 22, 0, 7); ctx.fill(); ctx.fillRect(81, y + 84, 60, 30); yy += 120; }
      m.lines.forEach((l, k) => { ctx.fillStyle = k ? '#e5edf7' : m.color; ctx.font = (k ? '' : '700 ') + '24px sans-serif'; ctx.fillText(l, 36, yy + k * 32); });
      y -= 14;
    }
    tex.needsUpdate = true;
  }
  function pushMsg(m) { msgs.push(m); if (msgs.length > 4) msgs.shift(); drawPhone(); scene.userData.phone.userData.buzz = 0.6; }

  // ---------- пакеты ----------
  function sendPacket(name, color, onArrive) {
    const r = routes[name];
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 14), new THREE.MeshBasicMaterial({ color: color || r.color }));
    m.add(new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 14), new THREE.MeshBasicMaterial({ color: color || r.color, transparent: true, opacity: 0.25, depthWrite: false })));
    scene.add(m); packets.push({ m, r, t: 0, onArrive });
  }

  // ---------- сценарий ----------
  function newVisitor() {
    if (person) scene.remove(person);
    const v = VISITORS[ST.vi];
    person = makePerson(v); person.position.set(0, 0, 6); person.rotation.y = 0; scene.add(person);
    ST.t = 0; ST.sent = {};
  }
  function setState(phase, v, extra) {
    if (ST.phase === phase) return;
    ST.phase = phase;
    drawDisp({ idle: 'idle', motion: 'motion', scan: 'scan', ok: 'ok', deny: 'deny', spoof: 'spoof', open: 'ok', leave: v.kind === 'known' ? 'idle' : (v.kind === 'spoof' ? 'spoof' : 'deny') }[phase] || 'idle');
    onState(Object.assign({ phase, who: v.name, kind: v.kind, dist: v.dist }, extra || {}));
  }
  function walk(p, k) { const s = Math.sin(k * 9) * 0.5 * p; person.legL.rotation.x = s; person.legR.rotation.x = -s; if (!person.photo) { person.armL.rotation.x = -s * 0.8; person.armR.rotation.x = s * 0.8; } }

  function updateScenario(dt) {
    const v = VISITORS[ST.vi]; ST.t += dt; const t = ST.t;
    const ok = v.kind === 'known';
    // подход
    if (t < 4.2) {
      const k = ease(t / 4.2); person.position.z = 6 - k * 4.75; walk(1, t);
      setState(t > 1.6 ? 'motion' : 'idle', v);
    } else if (t < 6.4) { // сканирование
      walk(0, 0); setState('scan', v);
    } else if (ok) {
      if (!ST.sent.ok) { ST.sent.ok = 1; setState('ok', v); sendPacket('lock'); sendPacket('mqtt', 0x34d399, () => sendPacket('tg', 0x34d399, () => pushMsg({ color: '#34d399', lines: ['🔓 Вход: ' + v.name, 'сходство ' + (1 - v.dist).toFixed(2) + ' · ' + hhmm()] }))); }
      const tb = t - 6.4;
      bolt.position.x = 0.98 - ease(tb / 0.4) * 0.12 + ease((tb - 6.2) / 0.4) * 0.12;
      door.rotation.y = ease((tb - 0.5) / 1.1) * 1.35 - ease((tb - 4.6) / 1.4) * 1.35;
      if (tb > 0.9 && tb < 4.2) { const k = ease((tb - 0.9) / 3.3); person.position.z = 1.25 - k * 3.2; walk(1, t); setState('open', v); }
      if (tb >= 4.2) { walk(0, 0); person.visible = false; setState('leave', v); }
      if (tb > 7.2) next();
    } else {
      if (!ST.sent.deny) {
        ST.sent.deny = 1; setState(v.kind === 'spoof' ? 'spoof' : 'deny', v);
        const red = v.kind === 'spoof' ? 0xfbbf24 : 0xf87171;
        sendPacket('mqtt', red, () => sendPacket('tg', red, () => pushMsg(v.kind === 'spoof'
          ? { color: '#fbbf24', lines: ['⚠️ Попытка обмана', 'показали фото · ' + hhmm()], photo: true }
          : { color: '#f87171', lines: ['🚫 Неизвестное лицо', 'у двери · ' + hhmm()], photo: true })));
      }
      const tb = t - 6.4;
      if (tb > 2.6) { // разворачивается и уходит
        person.rotation.y = Math.min(Math.PI, (tb - 2.6) * 4);
        if (person.photo) person.photo.visible = false;
        const k = ease((tb - 3.0) / 3.2); person.position.z = 1.25 + k * 4.8; if (tb > 3.0) walk(1, t);
        setState('leave', v);
      }
      if (tb > 6.6) next();
    }
    // лучи сканирования
    const scanning = ST.phase === 'scan' || (t >= 6.4 && t < 8.4 && !(ok && t > 7));
    scan.visible = scanning && person.visible;
    if (scan.visible) {
      const head = new THREE.Vector3(); person.head.getWorldPosition(head); head.z -= 0.13;
      if (person.photo) person.photo.getWorldPosition(head), head.z -= 0.02;
      const L = V(0.95, 1.69, 0.18), s = 0.15;
      const cs = [V(head.x - s, head.y + s, head.z), V(head.x + s, head.y + s, head.z), V(head.x + s, head.y - s, head.z), V(head.x - s, head.y - s, head.z)];
      const lp = scan.lines.geometry.attributes.position, fp = scan.frame.geometry.attributes.position;
      cs.forEach((c, i) => { lp.setXYZ(i * 2, L.x, L.y, L.z); lp.setXYZ(i * 2 + 1, c.x, c.y, c.z); fp.setXYZ(i, c.x, c.y, c.z); });
      lp.needsUpdate = fp.needsUpdate = true;
      scan.dots.position.copy(head);
      const col = ST.phase === 'scan' ? 0x38bdf8 : ok ? 0x34d399 : v.kind === 'spoof' ? 0xfbbf24 : 0xf87171;
      [scan.lines, scan.frame, scan.dots].forEach(o => o.material.color.setHex(col));
      scan.dots.scale.setScalar(ST.phase === 'scan' ? 0.8 + Math.sin(performance.now() / 120) * 0.15 : 1);
    }
    // кольцо подсветки камеры
    const ledCol = { idle: 0x334155, motion: 0x38bdf8, scan: 0x38bdf8, ok: 0x34d399, open: 0x34d399, deny: 0xf87171, spoof: 0xfbbf24, leave: 0x334155 }[ST.phase] || 0x334155;
    panelLed.material.color.setHex(ledCol);
    porch.intensity = ST.phase === 'idle' ? 0.6 : 1.4;
    if (ST.phase === 'scan') drawDisp('scan');
  }
  function next() { ST.vi = (ST.vi + 1) % VISITORS.length; newVisitor(); }

  function frame() {
    raf = requestAnimationFrame(frame);
    const real = Math.min(clock.getDelta(), 0.25);
    updateScenario(real);
    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i]; p.t += real * p.r.speed;
      if (p.t >= 1) { scene.remove(p.m); packets.splice(i, 1); p.onArrive && p.onArrive(); continue; }
      p.m.position.copy(p.r.curve.getPoint(p.t));
    }
    const ph = scene.userData.phone;
    if (ph.userData.buzz > 0) { ph.userData.buzz -= real; ph.position.x = ph.userData.base + Math.sin(clock.elapsedTime * 80) * 0.015; }
    controls.update(); renderer.render(scene, camera);
  }
  function resize() {
    if (!host) return; const w = host.clientWidth || 1, h = host.clientHeight || 1;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  window.FaceLock3D = {
    mount(el, cb) {
      if (renderer) return true;
      if (!window.THREE) { el.innerHTML = '<p style="padding:40px;color:#f87171">Не найден vendor/three.min.js</p>'; return false; }
      host = el; onState = cb || onState; clock = new THREE.Clock();
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio * 1.5));
      renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.domElement.style.cssText = 'width:100%;height:100%;display:block';
      el.appendChild(renderer.domElement);
      camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100); camera.position.set(4.3, 3.1, 6.7);
      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.target.set(1.2, 1.1, 1.0); controls.enableDamping = true;
      controls.autoRotate = true; controls.autoRotateSpeed = 0.35;
      controls.minDistance = 3; controls.maxDistance = 14; controls.maxPolarAngle = Math.PI * 0.49;
      build();
      msgs.push({ color: '#34d399', lines: ['👋 Бот подключён', 'замок lab502 онлайн'] });
      drawPhone(); drawDisp('idle'); newVisitor(); resize();
      addEventListener('resize', resize);
      return true;
    },
    start() { if (!renderer || running) return; running = true; resize(); clock.getDelta(); frame(); },
    stop() { running = false; cancelAnimationFrame(raf); },
    toggleRotate() { controls.autoRotate = !controls.autoRotate; return controls.autoRotate; },
  };
})();
