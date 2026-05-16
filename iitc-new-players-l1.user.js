// ==UserScript==
// @name         IITC Plugin: New Level 1 Players
// @namespace    https://github.com/iq1981/iitc-plugins
// @version      1.0.0
// @description  Detects new Level 1 agents via their L1 resonators and displays them in a popup
// @author       iq1981
// @match        https://intel.ingress.com/*
// @grant        none
// @require      https://code.jquery.com/jquery-3.6.0.min.js
// ==/UserScript==

/* global L, map */
'use strict';

function wrapper (plugin_info) { // eslint-disable-line no-unused-vars
  if (typeof window.plugin !== 'function') window.plugin = function () {};

  // ── Namespace ──────────────────────────────────────────────────────────────
  const self = window.plugin.newL1Players = {};

  // ── Constants ──────────────────────────────────────────────────────────────
  const RADII_KM      = [5, 10, 20, 50, 100, 200, 500, 1000];
  const DEFAULT_RADIUS = 50;
  const CYAN           = '#00ffff';
  const PLUGIN_ID      = 'l1p';

  // ── State ──────────────────────────────────────────────────────────────────
  // players[name] = { portals:[{guid,name,lat,lng}], firstSeen, lat, lng }
  self.players  = {};
  self.markers  = {}; // name → L.circleMarker
  self.radiusKm = DEFAULT_RADIUS;

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
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTime (ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ── Marker management ──────────────────────────────────────────────────────
  function updateMarker (name) {
    const d = self.players[name];
    if (!d || !d.portals.length) return;

    const pos = [d.lat, d.lng];
    if (self.markers[name]) {
      self.markers[name].setLatLng(pos);
      return;
    }

    const m = L.circleMarker(pos, {
      radius      : 10,
      color       : CYAN,
      fillColor   : CYAN,
      fillOpacity : 0.25,
      weight      : 2,
      opacity     : 0.9
    });
    m.bindTooltip('<b style="color:#00ffff">L1 ' + escHtml(name) + '</b>', {
      direction: 'top',
      className: 'l1p-tooltip'
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

    // Support both IITC-CE and classic data layouts
    const details = (data.details) ||
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
        self.players[agent] = {
          portals  : [],
          firstSeen: now,
          lat      : ll.lat,
          lng      : ll.lng
        };
      }

      const already = self.players[agent].portals.some(p => p.guid === data.guid);
      if (!already) {
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
          const portals = d.portals.map(p => escHtml(p.name)).join(', ');
          return `<tr>
            <td><span class="${PLUGIN_ID}-agent">${escHtml(name)}</span></td>
            <td>${dist.toFixed(1)} km</td>
            <td>${formatTime(d.firstSeen)}</td>
            <td title="${portals}">${d.portals.length}</td>
            <td><button class="${PLUGIN_ID}-jump" data-agent="${escHtml(name)}" title="Zur Position springen">◎</button></td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="5" class="${PLUGIN_ID}-empty">Keine L1-Agenten in diesem Bereich erkannt.</td></tr>`;

    return `
      <div class="${PLUGIN_ID}-controls">
        <span class="${PLUGIN_ID}-label">RADIUS</span>
        <select id="${PLUGIN_ID}-radius">${radiusSel}</select>
        <button id="${PLUGIN_ID}-clear">LEEREN</button>
        <button id="${PLUGIN_ID}-refresh">↻</button>
      </div>
      <div class="${PLUGIN_ID}-scroll">
        <table id="${PLUGIN_ID}-table">
          <thead>
            <tr>
              <th>Agent</th><th>Distanz</th><th>Erstsichtung</th><th>Portale</th><th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="${PLUGIN_ID}-footer">${filtered.length} Agent(en) sichtbar · ${Object.keys(self.players).length} gesamt</div>`;
  }

  function rerender () {
    const body = document.getElementById(`${PLUGIN_ID}-body`);
    if (!body) return;
    body.innerHTML = renderBody();
    bindBodyEvents();
  }

  function bindBodyEvents () {
    const radiusSel = document.getElementById(`${PLUGIN_ID}-radius`);
    if (radiusSel) {
      radiusSel.addEventListener('change', e => {
        self.radiusKm = parseInt(e.target.value, 10);
        rerender();
      });
    }

    const clearBtn = document.getElementById(`${PLUGIN_ID}-clear`);
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        self.players = {};
        clearMarkers();
        rerender();
      });
    }

    const refreshBtn = document.getElementById(`${PLUGIN_ID}-refresh`);
    if (refreshBtn) {
      refreshBtn.addEventListener('click', rerender);
    }

    document.querySelectorAll(`.${PLUGIN_ID}-jump`).forEach(btn => {
      btn.addEventListener('click', () => {
        const agent = btn.dataset.agent;
        const d     = self.players[agent];
        if (d) window.map.setView([d.lat, d.lng], Math.max(window.map.getZoom(), 15));
      });
    });
  }

  // ── Popup lifecycle ────────────────────────────────────────────────────────
  function togglePopup () {
    const existing = document.getElementById(`${PLUGIN_ID}-popup`);
    if (existing) { existing.remove(); return; }

    const popup = document.createElement('div');
    popup.id = `${PLUGIN_ID}-popup`;
    popup.innerHTML = `
      <div id="${PLUGIN_ID}-header">
        <span>◈ NEW L1 AGENTS</span>
        <button id="${PLUGIN_ID}-close" title="Schließen">✕</button>
      </div>
      <div id="${PLUGIN_ID}-body">${renderBody()}</div>`;
    document.body.appendChild(popup);

    document.getElementById(`${PLUGIN_ID}-close`).addEventListener('click', () => popup.remove());

    makeDraggable(popup, document.getElementById(`${PLUGIN_ID}-header`));
    bindBodyEvents();
  }

  // ── Drag support ───────────────────────────────────────────────────────────
  function makeDraggable (el, handle) {
    let ox = 0, oy = 0;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', e => {
      const rect = el.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;

      const onMove = ev => {
        el.style.left   = (ev.clientX - ox) + 'px';
        el.style.top    = (ev.clientY - oy) + 'px';
        el.style.right  = 'auto';
        el.style.bottom = 'auto';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  function injectStyles () {
    const css = `
      /* ── Leaflet tooltip ── */
      .l1p-tooltip { background: #0a0e1a; border: 1px solid #00ffff55; color: #ccc; font-family: 'Courier New', monospace; }

      /* ── Toolbar button ── */
      #l1p-toolbtn {
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
      }
      #l1p-toolbtn:hover { background: #00ffff18; border-color: #00ffff; }

      /* ── Popup shell ── */
      #l1p-popup {
        position: fixed;
        top: 60px;
        right: 20px;
        width: 540px;
        max-height: 500px;
        background: #080c18;
        border: 1px solid #00ffff33;
        box-shadow: 0 0 24px #00ffff1a, inset 0 0 60px #00001a;
        z-index: 10000;
        font-family: 'Courier New', monospace;
        font-size: 12px;
        color: #9ab;
        display: flex;
        flex-direction: column;
        user-select: none;
      }

      /* scanline overlay */
      #l1p-popup::before {
        content: '';
        position: absolute;
        inset: 0;
        background: repeating-linear-gradient(
          0deg,
          transparent 0px,
          transparent 3px,
          rgba(0,255,255,0.012) 3px,
          rgba(0,255,255,0.012) 4px
        );
        pointer-events: none;
        z-index: 0;
      }

      #l1p-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 7px 12px;
        background: #00ffff14;
        border-bottom: 1px solid #00ffff28;
        color: #00ffff;
        font-size: 12px;
        letter-spacing: 2px;
        z-index: 1;
        flex-shrink: 0;
      }

      #l1p-close {
        background: transparent;
        border: none;
        color: #00ffff88;
        font-size: 13px;
        cursor: pointer;
        padding: 0 3px;
        line-height: 1;
      }
      #l1p-close:hover { color: #fff; }

      #l1p-body {
        padding: 10px 12px;
        overflow-y: auto;
        flex: 1;
        z-index: 1;
      }

      /* ── Controls row ── */
      .l1p-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
      }
      .l1p-label {
        color: #00ffff;
        font-size: 11px;
        letter-spacing: 1px;
        flex-shrink: 0;
      }
      #l1p-radius {
        background: #0a1628;
        color: #00ffff;
        border: 1px solid #00ffff44;
        padding: 2px 5px;
        font-family: 'Courier New', monospace;
        font-size: 11px;
        flex-shrink: 0;
      }
      #l1p-clear {
        background: transparent;
        border: 1px solid #ff660066;
        color: #ff6600cc;
        padding: 2px 8px;
        cursor: pointer;
        font-family: 'Courier New', monospace;
        font-size: 10px;
        letter-spacing: 1px;
        flex-shrink: 0;
      }
      #l1p-clear:hover { border-color: #ff6600; color: #ff6600; }
      #l1p-refresh {
        background: transparent;
        border: 1px solid #00ffff44;
        color: #00ffff88;
        padding: 2px 7px;
        cursor: pointer;
        font-size: 13px;
        flex-shrink: 0;
      }
      #l1p-refresh:hover { color: #00ffff; border-color: #00ffff; }

      /* ── Table ── */
      .l1p-scroll { overflow-x: auto; }

      #l1p-table {
        width: 100%;
        border-collapse: collapse;
      }
      #l1p-table th {
        color: #00ffff;
        border-bottom: 1px solid #00ffff2a;
        padding: 4px 8px;
        text-align: left;
        font-size: 10px;
        letter-spacing: 1px;
        white-space: nowrap;
        font-weight: normal;
      }
      #l1p-table td {
        padding: 5px 8px;
        border-bottom: 1px solid #ffffff08;
        vertical-align: middle;
        white-space: nowrap;
      }
      #l1p-table tr:hover td { background: #00ffff08; }

      .l1p-agent { color: #00ffff; font-weight: bold; }

      .l1p-jump {
        background: transparent;
        border: 1px solid #00ffff44;
        color: #00ffff88;
        cursor: pointer;
        font-size: 14px;
        padding: 1px 5px;
        line-height: 1;
      }
      .l1p-jump:hover { background: #00ffff18; border-color: #00ffff; color: #00ffff; }

      .l1p-empty {
        text-align: center;
        color: #445;
        padding: 18px 0;
      }

      /* ── Footer ── */
      .l1p-footer {
        margin-top: 8px;
        color: #334;
        font-size: 10px;
        text-align: center;
        letter-spacing: 1px;
      }
    `;
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ── Setup ──────────────────────────────────────────────────────────────────
  self.setup = function () {
    injectStyles();

    // Add button to IITC toolbox
    const btn = document.createElement('button');
    btn.id        = `${PLUGIN_ID}-toolbtn`;
    btn.textContent = '◈ L1 AGENTS';
    btn.title       = 'Neue Level-1-Agenten anzeigen';
    btn.addEventListener('click', togglePopup);

    const toolbox = document.getElementById('toolbox');
    if (toolbox) {
      toolbox.appendChild(btn);
    } else {
      // Fallback: fixed-position button
      btn.style.cssText = 'position:fixed;bottom:24px;left:60px;z-index:9999;';
      document.body.appendChild(btn);
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
