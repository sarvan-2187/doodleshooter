// On-screen touch controls: floating joystick, drag-to-look and one button per PC action.
// Everything is fed into Input (setAction / touchMove / touchLook), so the game code never knows.

// stick offset in px -> game move vector. y is up = forward. mag has the dead zone removed, raw does not.
export function stickVector(dx, dy, R, dead = 0.12) {
  const len = Math.hypot(dx, dy), raw = Math.min(1, len / R);
  if (raw < dead) return { x: 0, y: 0, mag: 0, raw };
  const mag = (raw - dead) / (1 - dead);
  return { x: (dx / len) * mag, y: (-dy / len) * mag, mag, raw };
}


// 24x24 stroke icons, one per action (digits on the weapon slots stay as text)
const ICONS = {
  fire: '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  aim: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18"/>',
  block: '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/>',
  jump: '<path d="M6 13l6-6 6 6M6 19l6-6 6 6"/>',
  crouch: '<path d="M6 9l6 6 6-6M5 20h14"/>',
  dash: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  grapple: '<circle cx="12" cy="5" r="2"/><path d="M12 7v13M7 11h10M5 14a7 7 0 0 0 14 0"/>',
  reload: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>',
  grenade: '<circle cx="12" cy="14" r="6"/><path d="M10 8h4l1-3M15 5l3-1"/>',
  melee: '<path d="M20 4L10 14M7 11l6 6M10 14l-6 6"/>',
  board: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
};
const icon = (k) => (ICONS[k] ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>` : k);

const SPRINT_AT = 0.92, LOOK_PX = 0.0045, MIN_HOLD_MS = 50;
// [action, label, side, x, y, size, opts]  x/y are in button units from the side / bottom (top for 't'); c = centre offset
const BUTTONS = [
  ['fire', 'fire', 'r', 0.5, 0.3, 1.5, { look: 1 }],
  ['jump', 'jump', 'r', 2.3, 0.3, 1.1],
  ['crouch', 'crouch', 'r', 3.6, 0.3, 1.0],
  ['aim', 'aim', 'r', 0.5, 1.95, 1.1, { look: 1, id: 'aim' }],
  ['dash', 'dash', 'r', 1.8, 1.95, 1.1, { id: 'dash' }],
  ['grapple', 'grapple', 'r', 3.1, 1.95, 1.1],
  ['reload', 'reload', 'r', 0.5, 3.3, 0.9],
  ['grenade', 'grenade', 'r', 1.6, 3.3, 0.9],
  ['melee', 'melee', 'r', 2.7, 3.3, 0.9],
  ['fire', 'fire', 'l', 0.5, 2.7, 1.1, { look: 1 }],
  ['slot1', '1', 'c', -1.4, 0.3, 0.75], ['slot2', '2', 'c', -0.47, 0.3, 0.75], ['slot3', '3', 'c', 0.47, 0.3, 0.75], ['slot4', '4', 'c', 1.4, 0.3, 0.75],
  ['score', 'board', 't', -0.6, 0.3, 0.7, { id: 'board' }],
  ['pause', 'pause', 't', 0.6, 0.3, 0.7],
];

export class Touch {
  // state() -> { weapon: index, katana: bool, dashReady: bool, online: bool }
  constructor(input, state) {
    this.input = input; this.state = state; this.pointers = new Map(); this.gen = {}; this.btns = [];
    let saved = {}; try { saved = JSON.parse(localStorage.getItem('doodle_touch') || '{}'); } catch (e) { /* ignore */ }
    this.cfg = { sens: 100, size: 100, opacity: 80, fixed: false, ...saved };
    const root = this.root = document.getElementById('touch');
    root.innerHTML = '<div class="tz tzl"></div><div class="tz tzr"></div><div class="tring"><i></i></div>';
    this.ring = root.querySelector('.tring'); this.knob = this.ring.firstChild;
    this._wire(root.querySelector('.tzl'), (e) => this._stickDown(e), (e) => this._stickMove(e), () => this._stickUp());
    this._wire(root.querySelector('.tzr'), (e) => this._lookDown(e), (e) => this._lookMove(e), () => {});
    for (const [action, label, side, x, y, size, o = {}] of BUTTONS) {
      const el = document.createElement('div'); el.className = 'tb ' + side; el.innerHTML = icon(label); el.setAttribute('aria-label', action);
      el.style.cssText = `--x:${x};--y:${y};--s:${size}`; root.appendChild(el);
      const b = { action, el, look: !!o.look, id: o.id, down: false };
      this.btns.push(b); if (o.id) this[o.id + 'El'] = el;
      this._wire(el, (e) => this._press(b, e), (e) => { if (b.look) this._lookMove(e); }, () => this._release(b));
    }
    this.applyCfg(); this._vis = false; this._kat = null; this._w = -1;
  }

  _wire(el, down, move, up) {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } down(e); });
    el.addEventListener('pointermove', (e) => { if (this.pointers.has(e.pointerId)) move(e); });
    for (const t of ['pointerup', 'pointercancel']) el.addEventListener(t, (e) => { if (this.pointers.has(e.pointerId)) up(e); this.pointers.delete(e.pointerId); });
  }

  applyCfg() {
    const c = this.cfg, s = this.root.style;
    s.setProperty('--ts', c.size / 100); s.setProperty('--topa', c.opacity / 100); this.root.classList.toggle('fixed', c.fixed);
    try { localStorage.setItem('doodle_touch', JSON.stringify(c)); } catch (e) { /* ignore */ }
  }

  // ---- joystick ----
  _stickDown(e) {
    if ([...this.pointers.values()].some((p) => p.kind === 'stick')) return;
    const fixed = this.cfg.fixed, r = this.ring;
    if (!fixed) { r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; }
    r.classList.add('on'); const rc = r.getBoundingClientRect();
    this.pointers.set(e.pointerId, { kind: 'stick', ox: fixed ? rc.left + rc.width / 2 : e.clientX, oy: fixed ? rc.top + rc.height / 2 : e.clientY, R: rc.width / 2 });
    this.input.wake(); this._stickMove(e);
  }
  _stickMove(e) {
    const p = this.pointers.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.ox, dy = e.clientY - p.oy, v = stickVector(dx, dy, p.R), len = Math.hypot(dx, dy) || 1, k = Math.min(1, p.R / len);
    this.input.touchMove.x = v.x; this.input.touchMove.y = v.y; this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    const sprint = v.raw >= SPRINT_AT; if (sprint !== !!this.input.keys.sprint) this.input.setAction('sprint', sprint);
    this.input.wake();
  }
  _stickUp() {
    this.input.touchMove.x = 0; this.input.touchMove.y = 0; this.input.setAction('sprint', false);
    this.knob.style.transform = ''; if (!this.cfg.fixed) this.ring.classList.remove('on');
  }

  // ---- look ----
  _lookDown(e) { this.pointers.set(e.pointerId, { kind: 'look', x: e.clientX, y: e.clientY }); this.input.wake(); }
  _lookMove(e) {
    const p = this.pointers.get(e.pointerId); if (!p || p.kind !== 'look') return;
    const k = LOOK_PX * this.cfg.sens / 100;
    this.input.touchLook.x -= (e.clientX - p.x) * k; this.input.touchLook.y -= (e.clientY - p.y) * k; p.x = e.clientX; p.y = e.clientY; this.input.wake();
  }

  // ---- buttons ----
  _press(b, e) {
    const inp = this.input, a = b.action; b.down = true; b.el.classList.add('down'); b.at = performance.now(); this.gen[a] = (this.gen[a] || 0) + 1;
    this.pointers.set(e.pointerId, b.look ? { kind: 'look', x: e.clientX, y: e.clientY } : { kind: 'btn' });
    if (b.id === 'aim' && !this.state().katana) { inp.setAction('aim', !inp.keys.aim); return; } // guns toggle, katana block is held
    inp.setAction(a, true);
  }
  _release(b) {
    const a = b.action; b.down = false; b.el.classList.remove('down');
    if (b.id === 'aim' && !this.state().katana) return;
    const gen = this.gen[a], wait = Math.max(0, MIN_HOLD_MS - (performance.now() - b.at)); // a quick tap must live for a whole frame
    if (wait) setTimeout(() => { if (this.gen[a] === gen) this.input.setAction(a, false); }, wait); else this.input.setAction(a, false);
  }

  releaseAll() {
    for (const b of this.btns) { b.down = false; b.el.classList.remove('down'); this.input.setAction(b.action, false); }
    this._stickUp(); this.pointers.clear();
  }

  fullscreen() {
    const el = document.documentElement; if (document.fullscreenElement || !el.requestFullscreen) return;
    try { const p = el.requestFullscreen({ navigationUI: 'hide' }); if (p && p.then) p.then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape')).catch(() => {}); } catch (e) { /* ignore */ }
  }

  // called every frame; visible = touch device, in the game, no menu open
  update(visible) {
    if (visible !== this._vis) { this._vis = visible; this.root.classList.toggle('on', visible); if (!visible) this.releaseAll(); }
    if (!visible) return;
    const s = this.state();
    if (s.katana !== this._kat) { this._kat = s.katana; this.aimEl.innerHTML = icon(s.katana ? 'block' : 'aim'); this.input.setAction('aim', false); }
    if (s.weapon !== this._w) { this._w = s.weapon; for (const b of this.btns) if (b.action.startsWith('slot')) b.el.classList.toggle('active', b.action === 'slot' + (s.weapon + 1)); }
    this.aimEl.classList.toggle('on', !!this.input.keys.aim); this.dashEl.classList.toggle('ready', !!s.dashReady); this.boardEl.classList.toggle('gone', !s.online);
  }
}
