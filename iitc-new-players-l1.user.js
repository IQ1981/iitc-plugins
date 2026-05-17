// ==UserScript==
// @name         IITC Plugin: New Level 1 Players
// @namespace    https://github.com/iq1981/iitc-plugins
// @version      1.3.0
// @description  Detects new Level 1 agents via their L1 resonators and displays them in a popup
// @author       iq1981
// @match        https://intel.ingress.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

/* global L */
'use strict';

// ── Core plugin code ─────────────────────────────────────────────────────────
// Written as a plain function so it can run either via page-context injection
// (desktop Tampermonkey) or directly (iOS native IITC app, Orion, etc.)

function pluginMain () {
  if (typeof window.plugin !== 'function') window.plugin = function () {};
  if (window.plugin.newL1Players && window.plugin.newL1Players._loaded) return; // prevent double-init

  // ── Namespace ────────────────────────────────────────────────────────────
  const self = window.plugin.newL1Players = { _loaded: true };

  // ── Constants ────────────────────────────────────────────────────────────
  const RADII_KM       = [5, 10, 20, 50, 100, 200, 500, 1000];
  const DEFAULT_RADIUS = 50;
  const CYAN           = '#00ffff';
  const ID             = 'l1p';

  // ── State ────────────────────────────────────────────────────────────────
  self.players  = {};
  self.markers  = {};
  self.radiusKm = DEFAULT_RADIUS;

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
  function updateMarker (name) {
    const d = self.players[name];
    if (!d || !d.portals.length) return;
    const pos = [d.lat, d.lng];
    if (self.markers[name]) { self.markers[name].setLatLng(pos); return; }
    const m = L.circleMarker(pos, {
      radius: 10, color: CYAN, fillColor: CYAN, fillOpacity: 0.25, weight: 2, opacity: 0.9
    });
    m.bindTooltip('<b style="color:#00ffff">L1 ' + escHtml(name) + '</b>', {
      direction: 'top', className: `${ID}-tooltip`
    });
    m.addTo(window.map);
    self.markers[name] = m;
  }

  function clearMarkers () {
    Object.values(self.markers).forEach(m => window.map.removeLayer(m));
    self.markers = {};
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
    resonators.forEach(reso => {
      if (!reso || Number(reso.level) !== 1 || !reso.owner) return;
      const agent = reso.owner;
      if (!self.players[agent]) {
        self.players[agent] = { portals: [], firstSeen: now, lat: ll.lat, lng: ll.lng };
      }
      if (!self.players[agent].portals.some(p => p.guid === data.guid)) {
        self.players[agent].portals.push({ guid: data.guid, name: portalName, lat: ll.lat, lng: ll.lng });
      }
      updateMarker(agent);
    });
  }

  // ── Popup rendering ──────────────────────────────────────────────────────
  function renderBody () {
    const { lat, lng } = mapCenter();
    const filtered = Object.entries(self.players)
      .map(([name, d]) => ({ name, d, dist: haversineKm(lat, lng, d.lat, d.lng) }))
      .filter(({ dist }) => dist <= self.radiusKm)
      .sort((a, b) => a.dist - b.dist);

    const radiusSel = RADII_KM.map(r =>
      `<option value="${r}"${r === self.radiusKm ? ' selected' : ''}>${r} km</option>`
    ).join('');

    const rows = filtered.length
      ? filtered.map(({ name, d, dist }) => {
          const tip = d.portals.map(p => escHtml(p.name)).join(', ');
          return `<tr>
            <td><span class="${ID}-agent">${escHtml(name)}</span></td>
            <td>${dist.toFixed(1)} km</td>
            <td>${formatTime(d.firstSeen)}</td>
            <td title="${tip}">${d.portals.length}</td>
            <td><button class="${ID}-jump" data-agent="${escHtml(name)}">◎</button></td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="5" class="${ID}-empty">Keine L1-Agenten erkannt.</td></tr>`;

    return `
      <div class="${ID}-controls">
        <span class="${ID}-label">RADIUS</span>
        <select id="${ID}-radius">${radiusSel}</select>
        <button id="${ID}-clear">LEEREN</button>
        <button id="${ID}-refresh">↻</button>
      </div>
      <div class="${ID}-scroll">
        <table id="${ID}-table">
          <thead><tr>
            <th>Agent</th><th>Distanz</th><th>Erstsichtung</th><th>Portale</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="${ID}-footer">${filtered.length} sichtbar · ${Object.keys(self.players).length} gesamt</div>`;
  }

  function rerender () {
    const body = document.getElementById(`${ID}-body`);
    if (!body) return;
    body.innerHTML = renderBody();
    bindBodyEvents();
  }

  function bindBodyEvents () {
    const el = s => document.getElementById(`${ID}-${s}`);
    const r  = el('radius');
    if (r) r.addEventListener('change', e => { self.radiusKm = parseInt(e.target.value, 10); rerender(); });
    const c = el('clear');
    if (c) c.addEventListener('click', () => { self.players = {}; clearMarkers(); rerender(); });
    const rf = el('refresh');
    if (rf) rf.addEventListener('click', rerender);
    document.querySelectorAll(`.${ID}-jump`).forEach(btn => {
      btn.addEventListener('click', () => {
        const d = self.players[btn.dataset.agent];
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
      <div id="${ID}-header"><span>◈ NEW L1 AGENTS</span><button id="${ID}-close">✕</button></div>
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
      else         { el.style.transition = 'transform .2s ease'; el.style.transform = 'translateY(0)'; }
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

      /* FAB — always visible, left column below other plugin buttons */
      #${ID}-fab {
        position: fixed !important;
        bottom: 120px !important;
        left: 4px !important;
        z-index: 2147483647 !important;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: #00e5ff !important;
        border: 3px solid #000 !important;
        color: #000 !important;
        font-size: 20px;
        font-weight: 900;
        line-height: 1;
        cursor: pointer;
        display: flex !important;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 12px rgba(0,229,255,.7) !important;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
        outline: none;
      }
      #${ID}-fab:active { transform: scale(.92); background: #00b8d4 !important; }

      /* Desktop toolbox button */
      #${ID}-toolbtn {
        background: transparent; border: 1px solid #00ffff55; color: #00ffff;
        padding: 3px 10px; cursor: pointer; font-family: monospace; font-size: 11px;
        letter-spacing: 1px; margin-left: 8px; vertical-align: middle; min-height: 32px;
      }
      #${ID}-toolbtn:hover { background:#00ffff18; }

      /* Popup */
      #${ID}-popup {
        position: fixed; top: 60px; right: 20px;
        width: min(540px,96vw); max-height: min(500px,80vh);
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
        width:100% !important; max-height:75vh; border-radius:16px 16px 0 0; border-bottom:none;
      }
      #${ID}-handle { display:flex; justify-content:center; padding:10px 0 4px; flex-shrink:0; z-index:1; }
      #${ID}-pill   { width:40px; height:4px; border-radius:2px; background:#00ffff44; }
      #${ID}-header {
        display:flex; justify-content:space-between; align-items:center;
        padding:8px 14px; background:#00ffff14; border-bottom:1px solid #00ffff28;
        color:#00ffff; font-size:12px; letter-spacing:2px; z-index:1; flex-shrink:0;
      }
      #${ID}-close {
        background:transparent; border:none; color:#00ffff88; font-size:22px;
        cursor:pointer; min-width:44px; min-height:44px; display:flex; align-items:center; justify-content:center;
      }
      #${ID}-body { padding:10px 14px; overflow-y:auto; flex:1; z-index:1; -webkit-overflow-scrolling:touch; }
      .${ID}-controls { display:flex; align-items:center; gap:8px; margin-bottom:10px; flex-wrap:wrap; }
      .${ID}-label { color:#00ffff; font-size:11px; letter-spacing:1px; }
      #${ID}-radius {
        background:#0a1628; color:#00ffff; border:1px solid #00ffff44;
        padding:6px 8px; font-size:16px; min-height:40px; border-radius:2px;
      }
      #${ID}-clear {
        background:transparent; border:1px solid #ff660066; color:#ff6600cc;
        padding:6px 12px; cursor:pointer; font-size:11px; min-height:40px; border-radius:2px;
      }
      #${ID}-clear:active { border-color:#ff6600; color:#ff6600; }
      #${ID}-refresh {
        background:transparent; border:1px solid #00ffff44; color:#00ffff88;
        padding:6px 10px; cursor:pointer; font-size:16px; min-height:40px; border-radius:2px;
      }
      .${ID}-scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
      #${ID}-table { width:100%; border-collapse:collapse; }
      #${ID}-table th {
        color:#00ffff; border-bottom:1px solid #00ffff2a;
        padding:6px 8px; text-align:left; font-size:10px; letter-spacing:1px; white-space:nowrap; font-weight:normal;
      }
      #${ID}-table td { padding:8px; border-bottom:1px solid #ffffff08; vertical-align:middle; white-space:nowrap; }
      #${ID}-table tr:active td { background:#00ffff08; }
      .${ID}-agent { color:#00ffff; font-weight:bold; }
      .${ID}-jump {
        background:transparent; border:1px solid #00ffff44; color:#00ffff88;
        cursor:pointer; font-size:20px; min-width:44px; min-height:44px;
        display:inline-flex; align-items:center; justify-content:center; border-radius:4px;
      }
      .${ID}-jump:active { background:#00ffff18; border-color:#00ffff; color:#00ffff; }
      .${ID}-empty { text-align:center; color:#445; padding:22px 0; }
      .${ID}-footer { margin-top:8px; color:#334; font-size:10px; text-align:center; padding-bottom:env(safe-area-inset-bottom,0px); }
    `;
    document.head.appendChild(s);
  }

  // ── Setup ────────────────────────────────────────────────────────────────
  self.setup = function () {
    injectStyles();

    // FAB — always shown on all devices
    if (!document.getElementById(`${ID}-fab`)) {
      const fab = document.createElement('button');
      fab.id          = `${ID}-fab`;
      fab.textContent = '◈';
      fab.title       = 'L1 Agenten';
      fab.setAttribute('aria-label', 'L1 Agents');
      fab.addEventListener('click', togglePopup);
      document.body.appendChild(fab);
    }

    // Desktop: also add a text button to the IITC toolbox if present
    const toolbox = document.getElementById('toolbox');
    if (toolbox && window.innerWidth > 700 && !document.getElementById(`${ID}-toolbtn`)) {
      const btn = document.createElement('button');
      btn.id          = `${ID}-toolbtn`;
      btn.textContent = '◈ L1 AGENTS';
      btn.addEventListener('click', togglePopup);
      toolbox.appendChild(btn);
    }

    window.addHook('portalDetailLoaded', onPortalDetailLoaded);
    console.log('[IITC-L1Players] v1.3.0 geladen.');
  };

  // ── Bootstrap ────────────────────────────────────────────────────────────
  if (window.iitcLoaded) {
    self.setup();
  } else {
    window.addHook('iitcLoaded', self.setup);
  }
}

// ── Dual-mode loading ─────────────────────────────────────────────────────────
// 1) Try page-context injection (standard Tampermonkey/Violentmonkey on desktop)
// 2) If injection is blocked (iOS WKWebView CSP), run directly after IITC loads

(function () {
  const info = {};
  if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
    info.script = { version: GM_info.script.version, name: GM_info.script.name };
  }

  // Attempt injection
  const script = document.createElement('script');
  script.textContent = '(' + pluginMain.toString() + ')();';
  (document.body || document.head || document.documentElement).appendChild(script);

  // Fallback: if injection was blocked (iOS native app / CSP), run directly.
  // The _loaded flag inside pluginMain prevents double-init.
  function tryDirect () {
    if (typeof window.addHook === 'function') {
      pluginMain();
    } else {
      // IITC not ready yet — wait briefly and retry
      let n = 0;
      const t = setInterval(function () {
        n++;
        if (typeof window.addHook === 'function') { pluginMain(); clearInterval(t); }
        else if (n >= 30) clearInterval(t); // give up after ~15 s
      }, 500);
    }
  }

  // Give the injection a tick to execute first
  setTimeout(tryDirect, 100);
})();
