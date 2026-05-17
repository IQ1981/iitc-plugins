// ==UserScript==
// @name         IITC Plugin: New Level 1 Players
// @namespace    https://github.com/iq1981/iitc-plugins
// @version      1.4.0
// @description  Tracks new L1 agents and detects when they complete training (level up)
// @author       iq1981
// @match        https://intel.ingress.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

/* global L */
'use strict';

function pluginMain () {
  if (typeof window.plugin !== 'function') window.plugin = function () {};
  if (window.plugin.newL1Players && window.plugin.newL1Players._loaded) return;

  // ── Namespace ────────────────────────────────────────────────────────────
  const self = window.plugin.newL1Players = { _loaded: true };

  // ── Constants ────────────────────────────────────────────────────────────
  const RADII_KM       = [5, 10, 20, 50, 100, 200, 500, 1000];
  const DEFAULT_RADIUS = 50;
  const ID             = 'l1p';
  const CYAN           = '#00ffff';
  const LIME           = '#39ff14';

  // ── State ────────────────────────────────────────────────────────────────
  // players[name]   = { portals, firstSeen, lat, lng }   ← active L1 agents
  // graduated[name] = { portals, firstSeen, lat, lng,    ← training completed
  //                     graduatedAt, level }
  self.players    = {};
  self.graduated  = {};
  self.markers    = {};     // L1 markers (cyan)
  self.gradMarkers= {};     // Graduated markers (lime)
  self.radiusKm   = DEFAULT_RADIUS;
  self.activeTab  = 'l1';  // 'l1' | 'grad'

  // ── Helpers ──────────────────────────────────────────────────────────────
  function haversineKm (lat1, lng1, lat2, lng2) {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2 +
                 Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                 Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function mapCenter () {
    const c = window.map.getCenter();
    return { lat: c.lat, lng: c.lng };
  }

  function escHtml (str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatTime (ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ── Marker management ────────────────────────────────────────────────────
  function putMarker (name, lat, lng, color, label, store) {
    const pos = [lat, lng];
    if (store[name]) { store[name].setLatLng(pos); return; }
    const m = L.circleMarker(pos, {
      radius: 10, color, fillColor: color, fillOpacity: 0.3, weight: 2, opacity: 0.9
    });
    m.bindTooltip('<b style="color:' + color + '">' + escHtml(label) + '</b>', {
      direction: 'top', className: `${ID}-tooltip`
    });
    m.addTo(window.map);
    store[name] = m;
  }

  function removeMarker (name, store) {
    if (store[name]) { window.map.removeLayer(store[name]); delete store[name]; }
  }

  function clearAllMarkers () {
    Object.values(self.markers).forEach(m => window.map.removeLayer(m));
    Object.values(self.gradMarkers).forEach(m => window.map.removeLayer(m));
    self.markers = {}; self.gradMarkers = {};
  }

  // ── Portal detail hook ───────────────────────────────────────────────────
  function onPortalDetailLoaded (data) {
    if (!data || !data.guid) return;
    const details = data.details ||
                    (window.portalDetail && window.portalDetail.get && window.portalDetail.get(data.guid));
    if (!details) return;
    const resonators = details.resonators || details.reso || [];
    if (!resonators.length) return;
    const portal = window.portals[data.guid];
    if (!portal) return;

    const ll         = portal.getLatLng();
    const portalName = (portal.options.data && portal.options.data.title) || 'Unknown Portal';
    const now        = Date.now();
    let   changed    = false;

    resonators.forEach(reso => {
      if (!reso || !reso.owner) return;
      const level = Number(reso.level);
      const agent = reso.owner;

      if (level === 1 && !self.graduated[agent]) {
        // ── Active L1 agent ──
        if (!self.players[agent]) {
          self.players[agent] = { portals: [], firstSeen: now, lat: ll.lat, lng: ll.lng };
          changed = true;
        }
        if (!self.players[agent].portals.some(p => p.guid === data.guid)) {
          self.players[agent].portals.push({ guid: data.guid, name: portalName, lat: ll.lat, lng: ll.lng });
        }
        putMarker(agent, ll.lat, ll.lng, CYAN, 'L1 ' + agent, self.markers);

      } else if (level >= 2 && self.players[agent] && !self.graduated[agent]) {
        // ── Training completed: was L1, now L2+ ──
        self.graduated[agent] = {
          ...self.players[agent],
          graduatedAt: now,
          level
        };
        delete self.players[agent];
        removeMarker(agent, self.markers);
        putMarker(agent, ll.lat, ll.lng, LIME, '✓ L' + level + ' ' + agent, self.gradMarkers);
        changed = true;
      }
    });

    if (changed) rerenderSilent();
  }

  // Silent rerender (update badge counts without full popup rebuild)
  function rerenderSilent () {
    updateBadges();
  }

  // ── Rendering helpers ────────────────────────────────────────────────────
  function filteredByRadius (collection) {
    const { lat, lng } = mapCenter();
    return Object.entries(collection)
      .map(([name, d]) => ({ name, d, dist: haversineKm(lat, lng, d.lat, d.lng) }))
      .filter(({ dist }) => dist <= self.radiusKm)
      .sort((a, b) => a.dist - b.dist);
  }

  function renderL1Table () {
    const rows = filteredByRadius(self.players);
    if (!rows.length) return `<tr><td colspan="5" class="${ID}-empty">Keine aktiven L1-Agenten erkannt.</td></tr>`;
    return rows.map(({ name, d, dist }) => {
      const tip = d.portals.map(p => escHtml(p.name)).join(', ');
      return `<tr>
        <td><span class="${ID}-agent">${escHtml(name)}</span></td>
        <td>${dist.toFixed(1)} km</td>
        <td>${formatTime(d.firstSeen)}</td>
        <td title="${tip}">${d.portals.length}</td>
        <td><button class="${ID}-jump" data-agent="${escHtml(name)}" data-src="players">◎</button></td>
      </tr>`;
    }).join('');
  }

  function renderGradTable () {
    const rows = filteredByRadius(self.graduated);
    if (!rows.length) return `<tr><td colspan="6" class="${ID}-empty">Noch kein Agent hat das Training abgeschlossen.</td></tr>`;
    return rows.map(({ name, d, dist }) => {
      const tip = d.portals.map(p => escHtml(p.name)).join(', ');
      return `<tr>
        <td><span class="${ID}-agent-grad">${escHtml(name)}</span></td>
        <td class="${ID}-lvl">L${d.level}</td>
        <td>${dist.toFixed(1)} km</td>
        <td>${formatTime(d.firstSeen)}</td>
        <td>${formatTime(d.graduatedAt)}</td>
        <td><button class="${ID}-jump" data-agent="${escHtml(name)}" data-src="graduated">◎</button></td>
      </tr>`;
    }).join('');
  }

  function renderBody () {
    const { lat, lng } = mapCenter();
    const l1Count   = filteredByRadius(self.players).length;
    const gradCount = filteredByRadius(self.graduated).length;

    const radiusSel = RADII_KM.map(r =>
      `<option value="${r}"${r === self.radiusKm ? ' selected' : ''}>${r} km</option>`
    ).join('');

    const l1Body = `
      <table class="${ID}-table">
        <thead><tr>
          <th>Agent</th><th>Distanz</th><th>Erstsichtung</th><th>Portale</th><th></th>
        </tr></thead>
        <tbody>${renderL1Table()}</tbody>
      </table>`;

    const gradBody = `
      <table class="${ID}-table">
        <thead><tr>
          <th>Agent</th><th>Level</th><th>Distanz</th><th>Erstsichtung</th><th>Training ✓</th><th></th>
        </tr></thead>
        <tbody>${renderGradTable()}</tbody>
      </table>`;

    return `
      <div class="${ID}-controls">
        <span class="${ID}-label">RADIUS</span>
        <select id="${ID}-radius">${radiusSel}</select>
        <button id="${ID}-clear">LEEREN</button>
        <button id="${ID}-refresh">↻</button>
      </div>
      <div class="${ID}-tabs">
        <button class="${ID}-tab${self.activeTab === 'l1'   ? ' active' : ''}" data-tab="l1">
          L1 AGENTEN <span class="${ID}-badge">${l1Count}</span>
        </button>
        <button class="${ID}-tab${self.activeTab === 'grad' ? ' active' : ''}" data-tab="grad">
          TRAINING ✓ <span class="${ID}-badge ${ID}-badge-grad">${gradCount}</span>
        </button>
      </div>
      <div class="${ID}-scroll">
        <div id="${ID}-panel-l1"   style="display:${self.activeTab === 'l1'   ? 'block' : 'none'}">${l1Body}</div>
        <div id="${ID}-panel-grad" style="display:${self.activeTab === 'grad' ? 'block' : 'none'}">${gradBody}</div>
      </div>
      <div class="${ID}-footer">
        ${l1Count} L1 aktiv · ${gradCount} Training abgeschlossen · ${Object.keys(self.players).length + Object.keys(self.graduated).length} gesamt
      </div>`;
  }

  function rerender () {
    const body = document.getElementById(`${ID}-body`);
    if (!body) return;
    body.innerHTML = renderBody();
    bindBodyEvents();
  }

  function updateBadges () {
    const { lat, lng } = mapCenter();
    const b1 = document.querySelector(`.${ID}-badge:not(.${ID}-badge-grad)`);
    const b2 = document.querySelector(`.${ID}-badge-grad`);
    if (b1) b1.textContent = filteredByRadius(self.players).length;
    if (b2) b2.textContent = filteredByRadius(self.graduated).length;
  }

  // ── Event binding ────────────────────────────────────────────────────────
  function bindBodyEvents () {
    const el = s => document.getElementById(`${ID}-${s}`);

    const r = el('radius');
    if (r) r.addEventListener('change', e => { self.radiusKm = parseInt(e.target.value, 10); rerender(); });

    const c = el('clear');
    if (c) c.addEventListener('click', () => {
      self.players = {}; self.graduated = {};
      clearAllMarkers();
      rerender();
    });

    const rf = el('refresh');
    if (rf) rf.addEventListener('click', rerender);

    // Tabs
    document.querySelectorAll(`.${ID}-tab`).forEach(tab => {
      tab.addEventListener('click', () => {
        self.activeTab = tab.dataset.tab;
        document.querySelectorAll(`.${ID}-tab`).forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const l1   = document.getElementById(`${ID}-panel-l1`);
        const grad = document.getElementById(`${ID}-panel-grad`);
        if (l1)   l1.style.display   = self.activeTab === 'l1'   ? 'block' : 'none';
        if (grad) grad.style.display  = self.activeTab === 'grad' ? 'block' : 'none';
      });
    });

    // Jump buttons
    document.querySelectorAll(`.${ID}-jump`).forEach(btn => {
      btn.addEventListener('click', () => {
        const src = btn.dataset.src === 'graduated' ? self.graduated : self.players;
        const d   = src[btn.dataset.agent];
        if (d) window.map.setView([d.lat, d.lng], Math.max(window.map.getZoom(), 15));
      });
    });
  }

  // ── Popup lifecycle ──────────────────────────────────────────────────────
  function togglePopup () {
    const existing = document.getElementById(`${ID}-popup`);
    if (existing) { existing.remove(); return; }

    const mobile = window.innerWidth <= 700;
    const popup  = document.createElement('div');
    popup.id = `${ID}-popup`;
    if (mobile) popup.classList.add(`${ID}-mobile`);

    popup.innerHTML = `
      ${mobile ? `<div id="${ID}-handle"><div id="${ID}-pill"></div></div>` : ''}
      <div id="${ID}-header"><span>◈ NEW AGENTS</span><button id="${ID}-close">✕</button></div>
      <div id="${ID}-body">${renderBody()}</div>`;
    document.body.appendChild(popup);

    document.getElementById(`${ID}-close`).addEventListener('click', () => popup.remove());
    if (mobile) addSwipeClose(popup); else makeDraggable(popup, document.getElementById(`${ID}-header`));
    bindBodyEvents();

    if (mobile) {
      popup.style.transform = 'translateY(100%)';
      requestAnimationFrame(() => {
        popup.style.transition = 'transform 0.28s cubic-bezier(.2,.8,.3,1)';
        popup.style.transform  = 'translateY(0)';
      });
    }
  }

  // ── Swipe to close ───────────────────────────────────────────────────────
  function addSwipeClose (el) {
    const handle = document.getElementById(`${ID}-handle`);
    if (!handle) return;
    let sy = 0, cy = 0;
    handle.addEventListener('touchstart', e => { sy = e.touches[0].clientY; el.style.transition = 'none'; }, { passive: true });
    handle.addEventListener('touchmove',  e => { cy = e.touches[0].clientY - sy; if (cy > 0) el.style.transform = `translateY(${cy}px)`; }, { passive: true });
    handle.addEventListener('touchend',   () => {
      if (cy > 80) { el.style.transition = 'transform .2s ease'; el.style.transform = 'translateY(100%)'; setTimeout(() => el.remove(), 200); }
      else         { el.style.transition = 'transform .2s ease'; el.style.transform  = 'translateY(0)'; }
      cy = 0;
    }, { passive: true });
  }

  // ── Drag (desktop) ───────────────────────────────────────────────────────
  function makeDraggable (el, handle) {
    let ox = 0, oy = 0;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', e => {
      const r = el.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top;
      const mv = ev => { el.style.left = (ev.clientX-ox)+'px'; el.style.top = (ev.clientY-oy)+'px'; el.style.right = el.style.bottom = 'auto'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      e.preventDefault();
    });
  }

  // ── Styles ───────────────────────────────────────────────────────────────
  function injectStyles () {
    if (document.getElementById(`${ID}-styles`)) return;
    const s = document.createElement('style');
    s.id = `${ID}-styles`;
    s.textContent = `
      .${ID}-tooltip { background:#0a0e1a; border:1px solid #00ffff55; color:#ccc; font-family:monospace; }

      /* ── FAB ── */
      #${ID}-fab {
        position: fixed !important;
        bottom: 120px !important;
        left: 4px !important;
        z-index: 2147483647 !important;
        width: 44px; height: 44px;
        border-radius: 50%;
        background: #00e5ff !important;
        border: 3px solid #000 !important;
        color: #000 !important;
        font-size: 20px; font-weight: 900; line-height: 1;
        cursor: pointer;
        display: flex !important; align-items: center; justify-content: center;
        box-shadow: 0 2px 12px rgba(0,229,255,.7) !important;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation; outline: none;
      }
      #${ID}-fab:active { transform: scale(.92); background: #00b8d4 !important; }

      /* ── Desktop toolbox button ── */
      #${ID}-toolbtn {
        background: transparent; border: 1px solid #00ffff55; color: #00ffff;
        padding: 3px 10px; cursor: pointer; font-family: monospace; font-size: 11px;
        letter-spacing: 1px; margin-left: 8px; vertical-align: middle; min-height: 32px;
      }
      #${ID}-toolbtn:hover { background:#00ffff18; }

      /* ── Popup shell ── */
      #${ID}-popup {
        position: fixed; top: 60px; right: 20px;
        width: min(580px, 96vw); max-height: min(540px, 82vh);
        background: #080c18; border: 1px solid #00ffff33;
        box-shadow: 0 0 24px #00ffff1a;
        z-index: 10000; font-family: monospace; font-size: 12px; color: #9ab;
        display: flex; flex-direction: column; -webkit-overflow-scrolling: touch;
      }
      #${ID}-popup::before {
        content:''; position:absolute; inset:0; pointer-events:none; z-index:0;
        background: repeating-linear-gradient(0deg,transparent 0,transparent 3px,rgba(0,255,255,.012) 3px,rgba(0,255,255,.012) 4px);
      }
      #${ID}-popup.${ID}-mobile {
        top:auto !important; bottom:0 !important; left:0 !important; right:0 !important;
        width:100% !important; max-height:80vh; border-radius:16px 16px 0 0; border-bottom:none;
      }

      /* ── Handle / pill ── */
      #${ID}-handle { display:flex; justify-content:center; padding:10px 0 4px; flex-shrink:0; z-index:1; }
      #${ID}-pill   { width:40px; height:4px; border-radius:2px; background:#00ffff44; }

      /* ── Header ── */
      #${ID}-header {
        display:flex; justify-content:space-between; align-items:center;
        padding:8px 14px; background:#00ffff14; border-bottom:1px solid #00ffff28;
        color:#00ffff; font-size:12px; letter-spacing:2px; z-index:1; flex-shrink:0;
      }
      #${ID}-close {
        background:transparent; border:none; color:#00ffff88; font-size:22px;
        cursor:pointer; min-width:44px; min-height:44px;
        display:flex; align-items:center; justify-content:center;
        -webkit-tap-highlight-color:transparent;
      }

      /* ── Body ── */
      #${ID}-body { padding:10px 14px; overflow-y:auto; flex:1; z-index:1; -webkit-overflow-scrolling:touch; }

      /* ── Controls ── */
      .${ID}-controls { display:flex; align-items:center; gap:8px; margin-bottom:10px; flex-wrap:wrap; }
      .${ID}-label    { color:#00ffff; font-size:11px; letter-spacing:1px; }
      #${ID}-radius {
        background:#0a1628; color:#00ffff; border:1px solid #00ffff44;
        padding:6px 8px; font-size:16px; min-height:40px; border-radius:2px;
      }
      #${ID}-clear {
        background:transparent; border:1px solid #ff660066; color:#ff6600cc;
        padding:6px 12px; cursor:pointer; font-size:11px; min-height:40px; border-radius:2px;
        -webkit-tap-highlight-color:transparent;
      }
      #${ID}-clear:active  { border-color:#ff6600; color:#ff6600; }
      #${ID}-refresh {
        background:transparent; border:1px solid #00ffff44; color:#00ffff88;
        padding:6px 10px; cursor:pointer; font-size:16px; min-height:40px; border-radius:2px;
        -webkit-tap-highlight-color:transparent;
      }
      #${ID}-refresh:active { color:#00ffff; }

      /* ── Tabs ── */
      .${ID}-tabs {
        display: flex; border-bottom: 1px solid #00ffff22; margin-bottom: 10px;
        flex-shrink: 0;
      }
      .${ID}-tab {
        flex: 1; background: transparent; border: none; border-bottom: 2px solid transparent;
        color: #556; padding: 8px 4px; cursor: pointer; font-family: monospace;
        font-size: 11px; letter-spacing: 1px; min-height: 40px;
        display: flex; align-items: center; justify-content: center; gap: 6px;
        -webkit-tap-highlight-color: transparent;
        transition: color .15s, border-color .15s;
      }
      .${ID}-tab.active        { color:#00ffff; border-bottom-color:#00ffff; }
      .${ID}-tab:nth-child(2).active { color:#39ff14; border-bottom-color:#39ff14; }

      /* ── Badges ── */
      .${ID}-badge {
        background:#00ffff22; color:#00ffff; border-radius:10px;
        padding:1px 7px; font-size:10px; min-width:20px; text-align:center;
      }
      .${ID}-badge-grad { background:#39ff1422; color:#39ff14; }

      /* ── Scroll + Table ── */
      .${ID}-scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
      .${ID}-table  { width:100%; border-collapse:collapse; }
      .${ID}-table th {
        color:#00ffff; border-bottom:1px solid #00ffff2a;
        padding:6px 8px; text-align:left; font-size:10px; letter-spacing:1px;
        white-space:nowrap; font-weight:normal;
      }
      .${ID}-table td { padding:8px; border-bottom:1px solid #ffffff08; vertical-align:middle; white-space:nowrap; }
      .${ID}-table tr:active td { background:#00ffff06; }

      .${ID}-agent      { color:#00ffff; font-weight:bold; }
      .${ID}-agent-grad { color:#39ff14; font-weight:bold; }
      .${ID}-lvl        { color:#39ff14; font-weight:bold; text-align:center; }

      .${ID}-jump {
        background:transparent; border:1px solid #00ffff33; color:#00ffff77;
        cursor:pointer; font-size:20px; min-width:44px; min-height:44px;
        display:inline-flex; align-items:center; justify-content:center; border-radius:4px;
        -webkit-tap-highlight-color:transparent;
      }
      .${ID}-jump:active { background:#00ffff18; border-color:#00ffff; color:#00ffff; }

      .${ID}-empty  { text-align:center; color:#334; padding:22px 0; }
      .${ID}-footer {
        margin-top:8px; color:#334; font-size:10px; text-align:center; letter-spacing:.5px;
        padding-bottom:env(safe-area-inset-bottom, 0px);
      }
    `;
    document.head.appendChild(s);
  }

  // ── Setup ────────────────────────────────────────────────────────────────
  self.setup = function () {
    injectStyles();

    if (!document.getElementById(`${ID}-fab`)) {
      const fab = document.createElement('button');
      fab.id = `${ID}-fab`;
      fab.textContent = '◈';
      fab.title = 'L1 Agenten & Training';
      fab.setAttribute('aria-label', 'L1 Agents');
      fab.addEventListener('click', togglePopup);
      document.body.appendChild(fab);
    }

    const toolbox = document.getElementById('toolbox');
    if (toolbox && window.innerWidth > 700 && !document.getElementById(`${ID}-toolbtn`)) {
      const btn = document.createElement('button');
      btn.id = `${ID}-toolbtn`;
      btn.textContent = '◈ NEW AGENTS';
      btn.addEventListener('click', togglePopup);
      toolbox.appendChild(btn);
    }

    window.addHook('portalDetailLoaded', onPortalDetailLoaded);
    console.log('[IITC-L1Players] v1.4.0 geladen.');
  };

  // ── Bootstrap ────────────────────────────────────────────────────────────
  if (window.iitcLoaded) {
    self.setup();
  } else {
    window.addHook('iitcLoaded', self.setup);
  }
}

// ── Dual-mode loading ─────────────────────────────────────────────────────────
(function () {
  const script = document.createElement('script');
  script.textContent = '(' + pluginMain.toString() + ')();';
  (document.body || document.head || document.documentElement).appendChild(script);

  setTimeout(function () {
    if (typeof window.addHook === 'function') {
      pluginMain();
    } else {
      let n = 0;
      const t = setInterval(function () {
        n++;
        if (typeof window.addHook === 'function') { pluginMain(); clearInterval(t); }
        else if (n >= 30) clearInterval(t);
      }, 500);
    }
  }, 100);
})();
