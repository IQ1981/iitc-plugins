// ==UserScript==
// @name         IITC Plugin: New Level 1 Players
// @namespace    https://github.com/iq1981/iitc-plugins
// @version      1.2.0
// @description  Detects new Level 1 agents via their L1 resonators and displays them in a popup
// @author       iq1981
// @match        https://intel.ingress.com/*
// @grant        none
// ==/UserScript==

/* global L, map */
'use strict';

function wrapper (plugin_info) { // eslint-disable-line no-unused-vars
  if (typeof window.plugin !== 'function') window.plugin = function () {};

  // ── Namespace ──────────────────────────────────────────────────────────────
  const self = window.plugin.newL1Players = {};

  // ── Constants ──────────────────────────────────────────────────────────────
  const RADII_KM       = [5, 10, 20, 50, 100, 200, 500, 1000];
  const DEFAULT_RADIUS = 50;
  const CYAN           = '#00ffff';
  const ID             = 'l1p';

  // ── State ──────────────────────────────────────────────────────────────────
  // players[name] = { portals:[{guid,name,lat,lng}], firstSeen, lat, lng }
  self.players  = {};
  self.markers  = {};
  self.radiusKm = DEFAULT_RADIUS;

  // ── Device detection ───────────────────────────────────────────────────────
  function isMobile () {
    return window.innerWidth <= 640 ||
           /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
           typeof window.useAndroidPanes === 'function'; // IITC-CE Mobile
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
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

  // ── Marker management ──────────────────────────────────────────────────────
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

  // ── Portal detail hook ─────────────────────────────────────────────────────
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

  // ── Popup rendering ────────────────────────────────────────────────────────
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
            <td><button class="${ID}-jump" data-agent="${escHtml(name)}" title="Zur Position springen">◎</button></td>
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
      <div class="${ID}-footer">${filtered.length} Agent(en) · ${Object.keys(self.players).length} gesamt</div>`;
  }

  function rerender () {
    const body = document.getElementById(`${ID}-body`);
    if (!body) return;
    body.innerHTML = renderBody();
    bindBodyEvents();
  }

  function bindBodyEvents () {
    const el = id => document.getElementById(`${ID}-${id}`);

    const radiusSel = el('radius');
    if (radiusSel) {
      radiusSel.addEventListener('change', e => {
        self.radiusKm = parseInt(e.target.value, 10);
        rerender();
      });
    }

    const clearBtn = el('clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => { self.players = {}; clearMarkers(); rerender(); });
    }

    const refreshBtn = el('refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', rerender);

    document.querySelectorAll(`.${ID}-jump`).forEach(btn => {
      btn.addEventListener('click', () => {
        const d = self.players[btn.dataset.agent];
        if (d) window.map.setView([d.lat, d.lng], Math.max(window.map.getZoom(), 15));
      });
    });
  }

  // ── Popup lifecycle ────────────────────────────────────────────────────────
  function togglePopup () {
    const existing = document.getElementById(`${ID}-popup`);
    if (existing) { existing.remove(); return; }

    const mobile = isMobile();

    const popup = document.createElement('div');
    popup.id = `${ID}-popup`;
    if (mobile) popup.classList.add(`${ID}-mobile`);

    popup.innerHTML = `
      ${mobile ? `<div id="${ID}-handle"><div id="${ID}-pill"></div></div>` : ''}
      <div id="${ID}-header">
        <span>◈ NEW L1 AGENTS</span>
        <button id="${ID}-close" title="Schließen">✕</button>
      </div>
      <div id="${ID}-body">${renderBody()}</div>`;

    document.body.appendChild(popup);

    document.getElementById(`${ID}-close`).addEventListener('click', () => popup.remove());

    if (mobile) {
      addSwipeClose(popup);
    } else {
      makeDraggable(popup, document.getElementById(`${ID}-header`));
    }

    bindBodyEvents();

    // Animate in on mobile
    if (mobile) {
      popup.style.transform = 'translateY(100%)';
      requestAnimationFrame(() => {
        popup.style.transition = 'transform 0.28s cubic-bezier(.2,.8,.3,1)';
        popup.style.transform  = 'translateY(0)';
      });
    }
  }

  // ── Swipe-down to close (mobile) ───────────────────────────────────────────
  function addSwipeClose (el) {
    const handle = document.getElementById(`${ID}-handle`);
    if (!handle) return;

    let startY = 0, currentY = 0, dragging = false;

    handle.addEventListener('touchstart', e => {
      startY  = e.touches[0].clientY;
      dragging = true;
      el.style.transition = 'none';
    }, { passive: true });

    handle.addEventListener('touchmove', e => {
      if (!dragging) return;
      currentY = e.touches[0].clientY - startY;
      if (currentY > 0) el.style.transform = `translateY(${currentY}px)`;
    }, { passive: true });

    handle.addEventListener('touchend', () => {
      dragging = false;
      if (currentY > 80) {
        el.style.transition = 'transform 0.2s ease';
        el.style.transform  = 'translateY(100%)';
        setTimeout(() => el.remove(), 200);
      } else {
        el.style.transition = 'transform 0.2s ease';
        el.style.transform  = 'translateY(0)';
      }
      currentY = 0;
    }, { passive: true });
  }

  // ── Mouse drag (desktop) ───────────────────────────────────────────────────
  function makeDraggable (el, handle) {
    let ox = 0, oy = 0;
    handle.style.cursor = 'move';

    const start = (clientX, clientY) => {
      const rect = el.getBoundingClientRect();
      ox = clientX - rect.left;
      oy = clientY - rect.top;
    };
    const move = (clientX, clientY) => {
      el.style.left = (clientX - ox) + 'px';
      el.style.top  = (clientY - oy) + 'px';
      el.style.right = el.style.bottom = 'auto';
    };

    handle.addEventListener('mousedown', e => {
      start(e.clientX, e.clientY);
      const onMove = ev => move(ev.clientX, ev.clientY);
      const onUp   = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });

    // Touch drag on tablets (landscape, wider than 640px)
    handle.addEventListener('touchstart', e => {
      if (isMobile()) return;
      start(e.touches[0].clientX, e.touches[0].clientY);
      const onMove = ev => { ev.preventDefault(); move(ev.touches[0].clientX, ev.touches[0].clientY); };
      const onEnd  = () => { handle.removeEventListener('touchmove', onMove); handle.removeEventListener('touchend', onEnd); };
      handle.addEventListener('touchmove', onMove, { passive: false });
      handle.addEventListener('touchend', onEnd, { passive: true });
    }, { passive: true });
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  function injectStyles () {
    const css = `
      .${ID}-tooltip {
        background: #0a0e1a; border: 1px solid #00ffff55;
        color: #ccc; font-family: 'Courier New', monospace;
      }

      /* ── Desktop toolbar button ── */
      #${ID}-toolbtn {
        background: transparent;
        border: 1px solid #00ffff55;
        color: #00ffff;
        padding: 3px 10px;
        cursor: pointer;
        font-family: 'Courier New', monospace;
        font-size: 11px;
        letter-spacing: 1px;
        margin-left: 8px;
        vertical-align: middle;
        min-height: 32px;
        -webkit-tap-highlight-color: transparent;
      }
      #${ID}-toolbtn:hover,
      #${ID}-toolbtn:active { background: #00ffff18; border-color: #00ffff; }

      /* ── FAB — always visible on mobile, left column below plugin buttons ── */
      #${ID}-fab {
        position: fixed;
        bottom: 110px;
        left: 4px;
        z-index: 2147483647;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: #00ffff;
        border: none;
        color: #000;
        font-size: 22px;
        font-weight: bold;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 0 0 3px #000, 0 0 20px #00ffff99;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }
      #${ID}-fab:active {
        transform: scale(0.92);
        background: #00dddd;
      }

      /* ── Popup shell ── */
      #${ID}-popup {
        position: fixed;
        top: 60px;
        right: 20px;
        width: min(540px, 96vw);
        max-height: min(500px, 80vh);
        background: #080c18;
        border: 1px solid #00ffff33;
        box-shadow: 0 0 24px #00ffff1a, inset 0 0 60px #00001a;
        z-index: 10000;
        font-family: 'Courier New', monospace;
        font-size: 12px;
        color: #9ab;
        display: flex;
        flex-direction: column;
        -webkit-overflow-scrolling: touch;
      }

      /* Scanline overlay */
      #${ID}-popup::before {
        content: '';
        position: absolute;
        inset: 0;
        background: repeating-linear-gradient(
          0deg, transparent 0px, transparent 3px,
          rgba(0,255,255,0.012) 3px, rgba(0,255,255,0.012) 4px
        );
        pointer-events: none;
        z-index: 0;
      }

      /* ── Mobile: bottom sheet ── */
      #${ID}-popup.${ID}-mobile {
        top: auto !important;
        bottom: 0 !important;
        left: 0 !important;
        right: 0 !important;
        width: 100% !important;
        max-height: 75vh;
        border-radius: 16px 16px 0 0;
        border-bottom: none;
      }

      /* Pull handle */
      #${ID}-handle {
        display: flex;
        justify-content: center;
        padding: 10px 0 4px;
        cursor: grab;
        flex-shrink: 0;
        z-index: 1;
      }
      #${ID}-pill {
        width: 40px;
        height: 4px;
        border-radius: 2px;
        background: #00ffff44;
      }

      /* ── Header ── */
      #${ID}-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 14px;
        background: #00ffff14;
        border-bottom: 1px solid #00ffff28;
        color: #00ffff;
        font-size: 12px;
        letter-spacing: 2px;
        z-index: 1;
        flex-shrink: 0;
        cursor: move;
      }
      #${ID}-popup.${ID}-mobile #${ID}-header { cursor: default; }

      #${ID}-close {
        background: transparent;
        border: none;
        color: #00ffff88;
        font-size: 20px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
        min-width: 36px;
        min-height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        -webkit-tap-highlight-color: transparent;
      }
      #${ID}-close:active { color: #fff; }

      /* ── Body ── */
      #${ID}-body {
        padding: 10px 14px;
        overflow-y: auto;
        flex: 1;
        z-index: 1;
        -webkit-overflow-scrolling: touch;
      }

      /* ── Controls row ── */
      .${ID}-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }
      .${ID}-label {
        color: #00ffff;
        font-size: 11px;
        letter-spacing: 1px;
        flex-shrink: 0;
      }
      #${ID}-radius {
        background: #0a1628;
        color: #00ffff;
        border: 1px solid #00ffff44;
        padding: 6px 8px;
        font-family: 'Courier New', monospace;
        font-size: 16px; /* prevents iOS auto-zoom on focus */
        min-height: 36px;
        flex-shrink: 0;
        border-radius: 2px;
      }
      #${ID}-clear {
        background: transparent;
        border: 1px solid #ff660066;
        color: #ff6600cc;
        padding: 6px 12px;
        cursor: pointer;
        font-family: 'Courier New', monospace;
        font-size: 11px;
        letter-spacing: 1px;
        min-height: 36px;
        flex-shrink: 0;
        border-radius: 2px;
        -webkit-tap-highlight-color: transparent;
      }
      #${ID}-clear:active { border-color: #ff6600; color: #ff6600; }
      #${ID}-refresh {
        background: transparent;
        border: 1px solid #00ffff44;
        color: #00ffff88;
        padding: 6px 10px;
        cursor: pointer;
        font-size: 16px;
        min-height: 36px;
        flex-shrink: 0;
        border-radius: 2px;
        -webkit-tap-highlight-color: transparent;
      }
      #${ID}-refresh:active { color: #00ffff; border-color: #00ffff; }

      /* ── Table ── */
      .${ID}-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }

      #${ID}-table { width: 100%; border-collapse: collapse; }

      #${ID}-table th {
        color: #00ffff;
        border-bottom: 1px solid #00ffff2a;
        padding: 6px 8px;
        text-align: left;
        font-size: 10px;
        letter-spacing: 1px;
        white-space: nowrap;
        font-weight: normal;
      }
      #${ID}-table td {
        padding: 8px 8px;
        border-bottom: 1px solid #ffffff08;
        vertical-align: middle;
        white-space: nowrap;
      }
      #${ID}-table tr:active td { background: #00ffff0a; }

      .${ID}-agent { color: #00ffff; font-weight: bold; }

      .${ID}-jump {
        background: transparent;
        border: 1px solid #00ffff44;
        color: #00ffff88;
        cursor: pointer;
        font-size: 20px;
        min-width: 40px;
        min-height: 40px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        -webkit-tap-highlight-color: transparent;
      }
      .${ID}-jump:active { background: #00ffff18; border-color: #00ffff; color: #00ffff; }

      .${ID}-empty { text-align: center; color: #445; padding: 22px 0; }

      .${ID}-footer {
        margin-top: 8px;
        color: #334;
        font-size: 10px;
        text-align: center;
        letter-spacing: 1px;
        padding-bottom: env(safe-area-inset-bottom, 0px); /* iPhone notch */
      }
    `;
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ── Setup ──────────────────────────────────────────────────────────────────
  self.setup = function () {
    injectStyles();

    const mobile  = isMobile();
    const toolbox = document.getElementById('toolbox');

    if (mobile) {
      // Always show a solid cyan FAB on mobile — left column, above the bottom bar.
      // This is guaranteed visible regardless of toolbox availability.
      const fab = document.createElement('button');
      fab.id    = `${ID}-fab`;
      fab.textContent = '◈';
      fab.title = 'Neue Level-1-Agenten anzeigen';
      fab.setAttribute('aria-label', 'L1 Agents');
      fab.addEventListener('click', togglePopup);
      document.body.appendChild(fab);
    } else {
      // Desktop: text button in the IITC toolbox
      const toolboxBtn = document.createElement('button');
      toolboxBtn.id          = `${ID}-toolbtn`;
      toolboxBtn.textContent = '◈ L1 AGENTS';
      toolboxBtn.title       = 'Neue Level-1-Agenten anzeigen';
      toolboxBtn.addEventListener('click', togglePopup);
      if (toolbox) {
        toolbox.appendChild(toolboxBtn);
      } else {
        toolboxBtn.style.cssText = 'position:fixed;bottom:24px;left:60px;z-index:9999;';
        document.body.appendChild(toolboxBtn);
      }
    }

    window.addHook('portalDetailLoaded', onPortalDetailLoaded);

    console.log('[IITC-L1Players] Plugin geladen.');
  };

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  if (window.iitcLoaded) {
    self.setup();
  } else {
    window.addHook('iitcLoaded', self.setup);
  }
}

// Inject into page context (required for IITC plugins)
const script = document.createElement('script');
const info   = {};
if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
  info.script = {
    version    : GM_info.script.version,
    name       : GM_info.script.name,
    description: GM_info.script.description
  };
}
script.appendChild(document.createTextNode('(' + wrapper + ')(' + JSON.stringify(info) + ');'));
(document.body || document.head || document.documentElement).appendChild(script);
