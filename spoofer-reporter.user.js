// ==UserScript==
// @name         IITC Plugin: Spoofer Detector & Reporter
// @version      0.3.0
// @description  Detects suspicious agent movement (GPS spoofing), logs portal visits with timestamps, and creates Niantic report packages
// @author       IITC Community
// @category     Info
// @namespace    https://iitc.app/
// @match        https://intel.ingress.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

/* global $, L, map, window */

function wrapper(plugin_info) {
  'use strict';

  if (typeof window.plugin !== 'function') window.plugin = function () {};

  // ─── Constants ───────────────────────────────────────────────────────────────
  const PLUGIN_ID        = 'spooferReporter';
  const STORAGE_KEY      = 'iitc_spoofer_incidents';
  const STORAGE_KEY_LOG  = 'iitc_spoofer_portal_log';

  // Minimum speed in km/h to flag as suspicious.
  // Ingress enforces ~80 km/h in-game; we use 150 km/h as conservative threshold
  // to account for measurement noise and edge cases like rapid portal loading.
  const DEFAULT_SPEED_THRESHOLD = 150;

  // Minimum time between two data points (ms) – avoid false positives from
  // near-simultaneous portal loads of the same agent.
  const MIN_INTERVAL_MS = 5000;

  // ─── State ────────────────────────────────────────────────────────────────────
  const self = window.plugin[PLUGIN_ID] = {
    speedThreshold: DEFAULT_SPEED_THRESHOLD,
    agentLastSeen:  {},   // agentName → { lat, lng, time, portalName }
    incidents:      [],   // array of incident objects
    portalLog:      [],   // array of portal visit entries
    activeTab:      'incidents', // 'incidents' | 'log'
  };

  // ─── Haversine distance (km) ──────────────────────────────────────────────────
  function haversineKm(lat1, lng1, lat2, lng2) {
    const R   = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a   = Math.sin(dLat / 2) ** 2
              + Math.cos(lat1 * Math.PI / 180)
              * Math.cos(lat2 * Math.PI / 180)
              * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ─── Record an agent activity and check for anomalies ────────────────────────
  function recordActivity(agentName, lat, lng, portalName, actionTime) {
    if (!agentName || !lat || !lng) return;

    const prev = self.agentLastSeen[agentName];
    const now  = actionTime || Date.now();

    if (prev) {
      const dtMs = now - prev.time;
      if (dtMs >= MIN_INTERVAL_MS && dtMs < 30 * 60 * 1000) { // max 30-min window
        const distKm  = haversineKm(prev.lat, prev.lng, lat, lng);
        const speedKmh = (distKm / (dtMs / 3600000));

        if (speedKmh >= self.speedThreshold) {
          addIncident({
            agent:       agentName,
            speedKmh:    Math.round(speedKmh),
            distKm:      Math.round(distKm * 10) / 10,
            dtMinutes:   Math.round(dtMs / 60000 * 10) / 10,
            from:        { lat: prev.lat, lng: prev.lng, portal: prev.portalName },
            to:          { lat, lng, portal: portalName },
            detectedAt:  new Date().toISOString(),
          });
        }
      }
    }

    self.agentLastSeen[agentName] = { lat, lng, time: now, portalName };
    addPortalLogEntry(agentName, lat, lng, portalName, now);
  }

  // ─── Add incident (deduplicate within 5 min for same agent) ──────────────────
  function addIncident(incident) {
    const fiveMin = 5 * 60 * 1000;
    const isDupe  = self.incidents.some(
      i => i.agent === incident.agent
        && Math.abs(new Date(i.detectedAt) - new Date(incident.detectedAt)) < fiveMin
    );
    if (isDupe) return;

    self.incidents.push(incident);
    saveIncidents();
    showNotification(incident);
    updateBadge();
    updateSidebar();
  }

  // ─── Persist to localStorage ──────────────────────────────────────────────────
  function saveIncidents() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(self.incidents.slice(-200)));
    } catch (e) { /* storage full */ }
  }

  function loadIncidents() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) self.incidents = JSON.parse(raw);
    } catch (e) { self.incidents = []; }
  }

  // ─── Portal visit log ─────────────────────────────────────────────────────────
  function addPortalLogEntry(agentName, lat, lng, portalName, time) {
    // Deduplicate: same agent + same portal within 2 minutes
    const twoMin = 2 * 60 * 1000;
    const isDupe = self.portalLog.some(
      e => e.agent === agentName
        && e.portalName === portalName
        && Math.abs(e.time - time) < twoMin
    );
    if (isDupe) return;

    self.portalLog.push({ agent: agentName, portalName, lat, lng, time });
    savePortalLog();

    // Refresh log tab if it's currently visible
    if (self.activeTab === 'log') updateSidebar();
  }

  function savePortalLog() {
    try {
      // Keep last 1000 entries
      localStorage.setItem(STORAGE_KEY_LOG, JSON.stringify(self.portalLog.slice(-1000)));
    } catch (e) { /* storage full */ }
  }

  function loadPortalLog() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_LOG);
      if (raw) self.portalLog = JSON.parse(raw);
    } catch (e) { self.portalLog = []; }
  }

  // Returns all log entries for a given agent, newest first
  function getAgentHistory(agentName) {
    return self.portalLog
      .filter(e => e.agent === agentName)
      .sort((a, b) => b.time - a.time);
  }

  function exportPortalLogCSV(filterAgent) {
    const entries = filterAgent
      ? self.portalLog.filter(e => e.agent === filterAgent)
      : self.portalLog;

    if (entries.length === 0) {
      alert('Keine Portal-Log-Einträge vorhanden.');
      return;
    }

    const header = 'Datum,Uhrzeit,Agent,Portal,Lat,Lng,Intel-Link';
    const rows = entries
      .slice()
      .sort((a, b) => a.time - b.time)
      .map(e => {
        const d   = new Date(e.time);
        const dat = d.toLocaleDateString('de-DE');
        const tim = d.toLocaleTimeString('de-DE');
        const link = `https://intel.ingress.com/?ll=${e.lat.toFixed(6)},${e.lng.toFixed(6)}&z=17`;
        return [
          dat, tim,
          `"${e.agent.replace(/"/g, '""')}"`,
          `"${(e.portalName || '').replace(/"/g, '""')}"`,
          e.lat.toFixed(6), e.lng.toFixed(6),
          link,
        ].join(',');
      });

    const filename = filterAgent
      ? `portal-log-${filterAgent}-${new Date().toISOString().slice(0, 10)}.csv`
      : `portal-log-all-${new Date().toISOString().slice(0, 10)}.csv`;

    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Toast notification ───────────────────────────────────────────────────────
  function showNotification(incident) {
    const msg = `⚠️ Spoofer erkannt: <b>${escHtml(incident.agent)}</b><br>`
              + `${incident.distKm} km in ${incident.dtMinutes} min`
              + ` → ${incident.speedKmh} km/h`;

    if (window.IITC && window.IITC.ui && window.IITC.ui.toast) {
      window.IITC.ui.toast(msg, 'warning', 8000);
    } else {
      // Fallback: jQuery-based toast
      const $toast = $('<div class="spoofer-toast">').html(msg).appendTo('body');
      setTimeout(() => $toast.remove(), 8000);
    }
  }

  // ─── Build Niantic report text ─────────────────────────────────────────────────
  function buildReportText(incident) {
    const history = getAgentHistory(incident.agent).slice(0, 30);
    const historyLines = history.length > 0
      ? [
          ``,
          `Portal visit history for ${incident.agent} (most recent first):`,
          ...history.map(e => {
            const d = new Date(e.time);
            return `  ${d.toLocaleDateString('de-DE')} ${d.toLocaleTimeString('de-DE')}`
                 + `  |  ${e.portalName || '(unknown)'}`
                 + `  |  ${e.lat.toFixed(6)}, ${e.lng.toFixed(6)}`
                 + `  |  https://intel.ingress.com/?ll=${e.lat.toFixed(6)},${e.lng.toFixed(6)}&z=17`;
          }),
        ]
      : [``, `(No portal visit history available)`];

    return [
      `[Spoofer Report – generated by IITC Spoofer Detector]`,
      ``,
      `Agent:            ${incident.agent}`,
      `Detected:         ${new Date(incident.detectedAt).toLocaleString()}`,
      ``,
      `From portal:      ${incident.from.portal}`,
      `  Coordinates:    ${incident.from.lat.toFixed(6)}, ${incident.from.lng.toFixed(6)}`,
      `  Intel link:     https://intel.ingress.com/?ll=${incident.from.lat},${incident.from.lng}&z=17`,
      ``,
      `To portal:        ${incident.to.portal}`,
      `  Coordinates:    ${incident.to.lat.toFixed(6)}, ${incident.to.lng.toFixed(6)}`,
      `  Intel link:     https://intel.ingress.com/?ll=${incident.to.lat},${incident.to.lng}&z=17`,
      ``,
      `Distance:         ${incident.distKm} km`,
      `Time between:     ${incident.dtMinutes} minutes`,
      `Calculated speed: ${incident.speedKmh} km/h`,
      ``,
      `This movement is physically impossible at ${incident.speedKmh} km/h in a walking game.`,
      `Please investigate for GPS spoofing / location falsification.`,
      ...historyLines,
    ].join('\n');
  }

  // ─── Open Niantic report form ─────────────────────────────────────────────────
  function openNianticReport(incident) {
    const text = buildReportText(incident);
    // Copy to clipboard so user can paste into the form
    navigator.clipboard.writeText(text).then(() => {
      alert(
        'Report-Text wurde in die Zwischenablage kopiert.\n\n'
        + 'Das Niantic-Formular wird jetzt geöffnet.\n'
        + 'Wähle dort: Ingress → Report a player → GPS spoofing\n'
        + 'und füge den Text ein (Strg+V).'
      );
      window.open('https://niantic.helpshift.com/hc/en/6-ingress/contact-us/', '_blank');
    }).catch(() => {
      // Fallback: show text in dialog
      const $dlg = createTextDialog('Niantic Report – bitte kopieren', text);
      $dlg.dialog('open');
    });
  }

  // ─── Export all incidents as CSV ──────────────────────────────────────────────
  function exportCSV() {
    if (self.incidents.length === 0) {
      alert('Keine Vorfälle gespeichert.');
      return;
    }
    const header = 'Detected,Agent,Speed_kmh,Distance_km,Time_min,From_Portal,From_Lat,From_Lng,To_Portal,To_Lat,To_Lng';
    const rows   = self.incidents.map(i =>
      [
        i.detectedAt, i.agent, i.speedKmh, i.distKm, i.dtMinutes,
        `"${(i.from.portal || '').replace(/"/g, '""')}"`,
        i.from.lat.toFixed(6), i.from.lng.toFixed(6),
        `"${(i.to.portal   || '').replace(/"/g, '""')}"`,
        i.to.lat.toFixed(6), i.to.lng.toFixed(6),
      ].join(',')
    );
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `spoofer-incidents-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Sidebar panel ────────────────────────────────────────────────────────────
  function buildTabBar() {
    const t = self.activeTab;
    return `
      <div id="spoofer-tabs">
        <button class="spoofer-tab ${t === 'incidents' ? 'active' : ''}" data-tab="incidents">
          ⚠ Vorfälle (${self.incidents.length})
        </button>
        <button class="spoofer-tab ${t === 'log' ? 'active' : ''}" data-tab="log">
          📍 Portal-Log (${self.portalLog.length})
        </button>
      </div>`;
  }

  function buildIncidentsHTML() {
    if (self.incidents.length === 0) {
      return '<p class="spoofer-empty">Noch keine Vorfälle erkannt.<br>'
           + 'Das Plugin überwacht Agenten-Bewegungen automatisch.</p>';
    }

    const rows = self.incidents.slice().reverse().slice(0, 50).map((inc, idx) => {
      const realIdx = self.incidents.length - 1 - idx;
      return `
        <div class="spoofer-incident" data-idx="${realIdx}">
          <b>${escHtml(inc.agent)}</b>
          <span class="spoofer-speed">${inc.speedKmh} km/h</span><br>
          <small>${inc.distKm} km · ${inc.dtMinutes} min · ${new Date(inc.detectedAt).toLocaleString()}</small><br>
          <button class="spoofer-btn-report" data-idx="${realIdx}">📋 Niantic melden</button>
          <button class="spoofer-btn-map"    data-idx="${realIdx}">🗺 Zeigen</button>
          <button class="spoofer-btn-history" data-agent="${escHtml(inc.agent)}">🕐 Verlauf</button>
          <button class="spoofer-btn-del"    data-idx="${realIdx}">🗑</button>
        </div>`;
    }).join('');

    return `
      <div id="spoofer-controls">
        <label>Speed-Schwellwert:
          <input type="number" id="spoofer-threshold" value="${self.speedThreshold}" min="50" max="999" step="10"> km/h
        </label>
        <button id="spoofer-export-csv">⬇ CSV</button>
        <button id="spoofer-clear-all">🗑 Alle</button>
      </div>
      <div id="spoofer-list">${rows}</div>`;
  }

  function buildPortalLogHTML(filterAgent) {
    const entries = filterAgent
      ? self.portalLog.filter(e => e.agent === filterAgent)
      : self.portalLog;

    const agents = [...new Set(self.portalLog.map(e => e.agent))].sort();

    const agentOptions = agents.map(a =>
      `<option value="${escHtml(a)}" ${filterAgent === a ? 'selected' : ''}>${escHtml(a)}</option>`
    ).join('');

    const filterBar = `
      <div id="spoofer-log-controls">
        <select id="spoofer-log-filter">
          <option value="">— Alle Agenten —</option>
          ${agentOptions}
        </select>
        <button id="spoofer-log-export">⬇ CSV</button>
        <button id="spoofer-log-clear">🗑 Löschen</button>
      </div>`;

    if (entries.length === 0) {
      return filterBar + '<p class="spoofer-empty">Keine Einträge'
           + (filterAgent ? ` für <b>${escHtml(filterAgent)}</b>` : '')
           + '.</p>';
    }

    const rows = entries
      .slice()
      .sort((a, b) => b.time - a.time)
      .slice(0, 200)
      .map(e => {
        const d    = new Date(e.time);
        const date = d.toLocaleDateString('de-DE');
        const time = d.toLocaleTimeString('de-DE');
        const link = `https://intel.ingress.com/?ll=${e.lat.toFixed(6)},${e.lng.toFixed(6)}&z=17`;
        return `
          <div class="spoofer-log-entry">
            <span class="spoofer-log-time">${date} ${time}</span><br>
            <b>${escHtml(e.agent)}</b> → <span class="spoofer-log-portal">${escHtml(e.portalName || '(unbekannt)')}</span><br>
            <small>
              ${e.lat.toFixed(5)}, ${e.lng.toFixed(5)} &nbsp;
              <a href="${link}" target="_blank">Intel ↗</a>
            </small>
          </div>`;
      }).join('');

    return filterBar + `<div id="spoofer-log-list">${rows}</div>`;
  }

  function buildSidebarHTML(filterAgent) {
    return buildTabBar()
      + (self.activeTab === 'incidents'
          ? buildIncidentsHTML()
          : buildPortalLogHTML(filterAgent));
  }

  function updateSidebar(filterAgent) {
    const $panel = $('#spoofer-panel-content');
    if ($panel.length === 0) return;
    $panel.html(buildSidebarHTML(filterAgent));
    bindSidebarEvents();
  }

  function bindSidebarEvents() {
    // Tab switching
    $('.spoofer-tab').on('click', function () {
      self.activeTab = $(this).data('tab');
      updateSidebar();
    });

    // ── Incidents tab ──────────────────────────────────────────────────────────
    $('#spoofer-threshold').on('change', function () {
      self.speedThreshold = parseInt($(this).val(), 10) || DEFAULT_SPEED_THRESHOLD;
    });

    $('#spoofer-export-csv').on('click', exportCSV);

    $('#spoofer-clear-all').on('click', function () {
      if (confirm('Alle gespeicherten Vorfälle löschen?')) {
        self.incidents = [];
        saveIncidents();
        updateSidebar();
      }
    });

    $('.spoofer-btn-report').on('click', function () {
      const inc = self.incidents[parseInt($(this).data('idx'), 10)];
      if (inc) openNianticReport(inc);
    });

    $('.spoofer-btn-map').on('click', function () {
      const inc = self.incidents[parseInt($(this).data('idx'), 10)];
      if (!inc) return;
      const mid = [(inc.from.lat + inc.to.lat) / 2, (inc.from.lng + inc.to.lng) / 2];
      map.setView(mid, 13);
      if (self._highlightLine) self._highlightLine.remove();
      self._highlightLine = L.polyline(
        [[inc.from.lat, inc.from.lng], [inc.to.lat, inc.to.lng]],
        { color: '#ff4444', weight: 3, dashArray: '6,4', opacity: 0.9 }
      ).addTo(map).bindPopup(
        `<b>${escHtml(inc.agent)}</b>: ${inc.speedKmh} km/h`
      ).openPopup();
    });

    // Switch to Portal-Log and pre-filter by agent
    $('.spoofer-btn-history').on('click', function () {
      const agent = $(this).data('agent');
      self.activeTab = 'log';
      updateSidebar(agent);
    });

    $('.spoofer-btn-del').on('click', function () {
      const idx = parseInt($(this).data('idx'), 10);
      self.incidents.splice(idx, 1);
      saveIncidents();
      updateSidebar();
    });

    // ── Portal-Log tab ─────────────────────────────────────────────────────────
    $('#spoofer-log-filter').on('change', function () {
      updateSidebar($(this).val() || undefined);
    });

    $('#spoofer-log-export').on('click', function () {
      const agent = $('#spoofer-log-filter').val() || undefined;
      exportPortalLogCSV(agent);
    });

    $('#spoofer-log-clear').on('click', function () {
      const agent = $('#spoofer-log-filter').val();
      const msg   = agent
        ? `Portal-Log für "${agent}" löschen?`
        : 'Gesamten Portal-Log löschen?';
      if (!confirm(msg)) return;
      if (agent) {
        self.portalLog = self.portalLog.filter(e => e.agent !== agent);
      } else {
        self.portalLog = [];
      }
      savePortalLog();
      updateSidebar();
    });
  }

  // ─── IITC Hooks ───────────────────────────────────────────────────────────────

  // portalDetailsUpdated fires when a user clicks a portal and details load.
  // The resonator data includes owner + installation time.
  function onPortalDetailsUpdated(data) {
    if (!data || !data.guid) return;
    const portal  = window.portals[data.guid];
    if (!portal) return;

    const ll      = portal.getLatLng();
    const lat     = ll.lat;
    const lng     = ll.lng;
    const name    = (portal.options && portal.options.data && portal.options.data.title) || data.guid;
    const details = data.details;

    if (!details) return;

    // Check resonator owners
    if (details.resonators) {
      details.resonators.forEach(res => {
        if (!res || !res.owner) return;
        const t = res.installation_time ? parseInt(res.installation_time, 10) * 1000 : Date.now();
        recordActivity(res.owner, lat, lng, name, t);
      });
    }

    // Check portal owner (capturer)
    if (details.captured && details.captured.capturingPlayerId) {
      recordActivity(details.captured.capturingPlayerId, lat, lng, name, Date.now());
    }
  }

  // mapDataEntityPassedAction fires for every entity update pushed from the server
  // (partial data but covers large map area automatically without user interaction).
  function onMapDataEntityPassedAction(data) {
    if (!data || !data.raw || !data.raw[2]) return;
    const entity = data.raw[2];
    // Entity type: portal
    if (entity[0] !== 'p') return;

    const lat        = entity[2] / 1e6;
    const lng        = entity[3] / 1e6;
    const owner      = entity[6];
    const portalName = entity[9] || entity[0];
    const captureTime = entity[11] ? parseInt(entity[11], 10) * 1000 : Date.now();

    if (owner) recordActivity(owner, lat, lng, portalName, captureTime);
  }

  // ─── Utility ──────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function createTextDialog(title, text) {
    const $ta = $('<textarea readonly style="width:100%;height:300px;font-family:monospace;font-size:11px">').val(text);
    const $dlg = $('<div>').attr('title', title).append($ta);
    $dlg.dialog({ modal: true, width: 600,
      buttons: { 'Schließen': function () { $(this).dialog('close'); } } });
    return $dlg;
  }

  // ─── CSS ──────────────────────────────────────────────────────────────────────
  function injectCSS() {
    $('<style>').text(`
      /* ── FAB button + slide-up panel ── */
      #spoofer-fab-wrapper {
        position: fixed; bottom: 16px; right: 16px; z-index: 8000;
        display: flex; flex-direction: column; align-items: flex-end;
      }

      #spoofer-fab-btn {
        position: relative;
        background: #e67e22; color: #fff; border: none;
        padding: 9px 16px; border-radius: 24px; font-size: 13px; font-weight: bold;
        cursor: pointer; box-shadow: 0 3px 10px rgba(0,0,0,.5);
        transition: background .2s, transform .2s;
        white-space: nowrap;
      }
      #spoofer-fab-btn:hover  { background: #d35400; }
      #spoofer-fab-btn.active { background: #c0392b; border-radius: 0 0 24px 24px; }

      #spoofer-fab-badge {
        display: inline-block; background: #fff; color: #c0392b;
        font-size: 10px; font-weight: bold; border-radius: 10px;
        padding: 1px 5px; margin-left: 6px; vertical-align: middle;
      }

      #spoofer-floating-panel {
        width: 320px;
        background: #111; border: 1px solid #444; border-radius: 6px 6px 0 0;
        box-shadow: 0 -4px 16px rgba(0,0,0,.6);
        overflow: hidden;
        max-height: 0;
        opacity: 0;
        transition: max-height .35s ease, opacity .25s ease;
        display: flex; flex-direction: column;
      }
      #spoofer-floating-panel.open {
        max-height: 72vh;
        opacity: 1;
      }

      /* ── Toast ── */
      .spoofer-toast {
        position: fixed; bottom: 60px; right: 16px; z-index: 9999;
        background: #c0392b; color: #fff;
        padding: 10px 14px; border-radius: 6px;
        box-shadow: 0 2px 8px rgba(0,0,0,.5);
        max-width: 320px; font-size: 13px; line-height: 1.4;
        animation: spoofer-fadein .3s ease;
      }
      @keyframes spoofer-fadein { from { opacity:0; transform:translateY(8px); } to { opacity:1; } }

      #spoofer-controls {
        padding: 6px 8px; background: #1a1a1a; border-bottom: 1px solid #333;
        display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
      }
      #spoofer-controls label { color: #ccc; font-size: 12px; }
      #spoofer-controls input[type=number] { width: 54px; background: #222; color: #fff; border: 1px solid #555; padding: 2px 4px; }
      #spoofer-controls button, .spoofer-btn-report, .spoofer-btn-map, .spoofer-btn-del {
        background: #2c2c2c; color: #ddd; border: 1px solid #555;
        padding: 3px 8px; font-size: 11px; cursor: pointer; border-radius: 3px;
      }
      #spoofer-controls button:hover, .spoofer-btn-report:hover, .spoofer-btn-map:hover { background: #444; }

      /* ── Tabs ── */
      #spoofer-tabs {
        display: flex; background: #1a1a1a; border-bottom: 2px solid #333;
      }
      .spoofer-tab {
        flex: 1; padding: 6px 4px; background: none; border: none;
        color: #888; font-size: 11px; cursor: pointer; border-bottom: 2px solid transparent;
        margin-bottom: -2px;
      }
      .spoofer-tab.active { color: #f39c12; border-bottom-color: #f39c12; }
      .spoofer-tab:hover:not(.active) { color: #ccc; background: #222; }

      /* ── Incidents tab ── */
      #spoofer-list { overflow-y: auto; max-height: calc(72vh - 120px); }
      .spoofer-incident {
        padding: 8px; border-bottom: 1px solid #2a2a2a;
        font-size: 12px; color: #ccc; line-height: 1.6;
      }
      .spoofer-incident b { color: #f39c12; }
      .spoofer-speed { float: right; color: #e74c3c; font-weight: bold; font-size: 13px; }
      .spoofer-incident small { color: #777; }

      /* ── Portal-Log tab ── */
      #spoofer-log-controls {
        padding: 6px 8px; background: #1a1a1a; border-bottom: 1px solid #333;
        display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
      }
      #spoofer-log-controls select {
        flex: 1; min-width: 0; background: #222; color: #ddd;
        border: 1px solid #555; padding: 3px 4px; font-size: 11px;
      }
      #spoofer-log-list { overflow-y: auto; max-height: calc(72vh - 120px); }
      .spoofer-log-entry {
        padding: 7px 8px; border-bottom: 1px solid #222;
        font-size: 12px; color: #ccc; line-height: 1.5;
      }
      .spoofer-log-entry b { color: #3498db; }
      .spoofer-log-time { color: #888; font-size: 11px; }
      .spoofer-log-portal { color: #ecf0f1; }
      .spoofer-log-entry small { color: #666; }
      .spoofer-log-entry a { color: #3498db; text-decoration: none; }
      .spoofer-log-entry a:hover { text-decoration: underline; }
      .spoofer-empty { padding: 12px 8px; color: #666; font-size: 12px; }
    `).appendTo('head');
  }

  // ─── Setup ────────────────────────────────────────────────────────────────────
  self.setup = function () {
    loadIncidents();
    loadPortalLog();
    injectCSS();

    // Register hooks
    window.addHook('portalDetailsUpdated',      onPortalDetailsUpdated);
    window.addHook('mapDataEntityPassedAction', onMapDataEntityPassedAction);

    // Create FAB button + slide-up panel
    createFAB();

    console.log('[IITC Spoofer Reporter] Plugin geladen. Speed-Schwelle:', self.speedThreshold, 'km/h');
  };

  function createFAB() {
    if ($('#spoofer-fab-wrapper').length) return;

    const $panel = $('<div id="spoofer-floating-panel">').html(
      '<div id="spoofer-panel-content"></div>'
    );

    const $badge = $('<span id="spoofer-fab-badge">').text('0').hide();

    const $btn = $('<button id="spoofer-fab-btn">')
      .html('⚠ Spoofer')
      .append($badge)
      .on('click', toggleSidebarPanel);

    const $wrapper = $('<div id="spoofer-fab-wrapper">')
      .append($panel)
      .append($btn);

    $('body').append($wrapper);
    updateSidebar();
    updateBadge();
  }

  function updateBadge() {
    const $badge = $('#spoofer-fab-badge');
    if (!$badge.length) return;
    if (self.incidents.length > 0) {
      $badge.text(self.incidents.length).show();
    } else {
      $badge.hide();
    }
  }

  function toggleSidebarPanel() {
    const $panel = $('#spoofer-floating-panel');
    const isOpen = $panel.hasClass('open');
    if (isOpen) {
      $panel.removeClass('open');
      $('#spoofer-fab-btn').removeClass('active');
    } else {
      updateSidebar();
      $panel.addClass('open');
      $('#spoofer-fab-btn').addClass('active');
    }
  }

  // ─── Bootstrap ────────────────────────────────────────────────────────────────
  const setup = self.setup;
  if (window.iitcLoaded) {
    setup();
  } else {
    window.addHook('iitcLoaded', setup);
  }
}

// ─── Userscript injection wrapper ─────────────────────────────────────────────
const info = {};
if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
  info.script = {
    version:     GM_info.script.version,
    name:        GM_info.script.name,
    description: GM_info.script.description,
  };
}
const script = document.createElement('script');
script.appendChild(document.createTextNode('(' + wrapper + ')(' + JSON.stringify(info) + ');'));
(document.body || document.head || document.documentElement).appendChild(script);
