#!/usr/bin/env python3
"""
Home Assistant OS Health Check & Auto-Repair
Prüft HAOS auf Fehler, erstellt ein Protokoll unter /config/raspi-health/
und versucht behebbare Fehler automatisch zu reparieren.

Ausführen im Terminal-Addon:  python3 raspi_health_check.py
"""

import subprocess
import os
import sys
import logging
import json
import shutil
import time
from datetime import datetime
from pathlib import Path

# /config ist in HAOS der persistente Speicher (HA-Konfigurationsordner)
LOG_DIR = Path("/config/raspi-health")
LOG_FILE = LOG_DIR / f"health_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

TEMP_WARNING  = 70.0
TEMP_CRITICAL = 80.0
DISK_WARNING  = 80
DISK_CRITICAL = 90


def setup_logging() -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("haos-health")
    logger.setLevel(logging.DEBUG)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S")

    fh = logging.FileHandler(LOG_FILE)
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(fmt)
    logger.addHandler(ch)

    return logger


def run(cmd: str, timeout: int = 30) -> tuple[int, str, str]:
    result = subprocess.run(
        cmd, shell=True, capture_output=True, text=True, timeout=timeout
    )
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def ha_json(sub: str, timeout: int = 30) -> dict | None:
    """Ruft einen `ha`-CLI-Befehl ab und gibt das JSON-Datenobjekt zurück."""
    rc, out, _ = run(f"ha {sub} --raw-json", timeout=timeout)
    if rc != 0:
        return None
    try:
        payload = json.loads(out)
        if payload.get("result") == "ok":
            return payload.get("data", {})
    except json.JSONDecodeError:
        pass
    return None


# ---------------------------------------------------------------------------
# Prüfungen
# ---------------------------------------------------------------------------

def check_temperature(log: logging.Logger) -> list[dict]:
    issues = []
    temp_file = Path("/sys/class/thermal/thermal_zone0/temp")
    if not temp_file.exists():
        log.warning("Temperaturdatei nicht gefunden – Prüfung übersprungen.")
        return issues
    try:
        temp_c = int(temp_file.read_text().strip()) / 1000
        log.info(f"CPU-Temperatur: {temp_c:.1f} °C")
        if temp_c >= TEMP_CRITICAL:
            issues.append({"type": "temperature", "severity": "critical",
                           "message": f"CPU-Temperatur kritisch: {temp_c:.1f} °C (Grenze: {TEMP_CRITICAL} °C)"})
        elif temp_c >= TEMP_WARNING:
            issues.append({"type": "temperature", "severity": "warning",
                           "message": f"CPU-Temperatur erhöht: {temp_c:.1f} °C (Grenze: {TEMP_WARNING} °C)"})
    except Exception as e:
        log.error(f"Temperaturauslese-Fehler: {e}")
    return issues


def check_disk_space(log: logging.Logger) -> list[dict]:
    issues = []
    total, used, free = shutil.disk_usage("/")
    pct = (used / total) * 100
    free_gb = free / (1024 ** 3)
    log.info(f"Festplattennutzung: {pct:.1f}% (frei: {free_gb:.2f} GB)")
    if pct >= DISK_CRITICAL:
        issues.append({"type": "disk_space", "severity": "critical",
                       "message": f"Kritisch wenig Speicherplatz: {pct:.1f}% belegt"})
    elif pct >= DISK_WARNING:
        issues.append({"type": "disk_space", "severity": "warning",
                       "message": f"Speicherplatz knapp: {pct:.1f}% belegt"})
    return issues


def check_memory(log: logging.Logger) -> list[dict]:
    issues = []
    rc, out, _ = run("free -m")
    if rc != 0:
        return issues
    for line in out.splitlines():
        if line.startswith("Mem:"):
            parts = line.split()
            total, used = int(parts[1]), int(parts[2])
            pct = (used / total) * 100
            log.info(f"RAM-Nutzung: {pct:.1f}% ({used} MB / {total} MB)")
            if pct >= 95:
                issues.append({"type": "memory", "severity": "critical",
                               "message": f"RAM kritisch voll: {pct:.1f}%"})
            elif pct >= 85:
                issues.append({"type": "memory", "severity": "warning",
                               "message": f"RAM-Nutzung hoch: {pct:.1f}%"})
    return issues


def check_ha_core(log: logging.Logger) -> list[dict]:
    issues = []
    data = ha_json("core info")
    if data is None:
        log.warning("HA Core: Keine Antwort vom Supervisor.")
        issues.append({"type": "ha_core_unreachable", "severity": "critical",
                       "message": "HA Core nicht erreichbar (Supervisor antwortet nicht)"})
        return issues

    state   = data.get("state", "unknown")
    version = data.get("version", "?")
    latest  = data.get("version_latest", "?")
    update  = data.get("update_available", False)

    log.info(f"HA Core: state={state}, version={version}, latest={latest}")

    if state != "running":
        issues.append({"type": "ha_core_stopped", "severity": "critical",
                       "message": f"HA Core läuft nicht (state: {state})"})
    if update:
        issues.append({"type": "ha_core_update", "severity": "warning",
                       "message": f"HA Core Update verfügbar: {version} → {latest}"})
    return issues


def check_supervisor(log: logging.Logger) -> list[dict]:
    issues = []
    data = ha_json("supervisor info")
    if data is None:
        log.warning("Supervisor: keine Antwort.")
        return issues

    healthy = data.get("healthy", True)
    version = data.get("version", "?")
    latest  = data.get("version_latest", "?")
    update  = data.get("update_available", False)

    log.info(f"Supervisor: healthy={healthy}, version={version}, latest={latest}")

    if not healthy:
        issues.append({"type": "supervisor_unhealthy", "severity": "critical",
                       "message": "Supervisor meldet sich als NICHT gesund"})
    if update:
        issues.append({"type": "supervisor_update", "severity": "warning",
                       "message": f"Supervisor Update verfügbar: {version} → {latest}"})
    return issues


def check_haos(log: logging.Logger) -> list[dict]:
    issues = []
    data = ha_json("os info")
    if data is None:
        log.warning("HAOS-Info nicht verfügbar.")
        return issues

    version = data.get("version", "?")
    latest  = data.get("version_latest", "?")
    update  = data.get("update_available", False)

    log.info(f"HAOS: version={version}, latest={latest}")

    if update:
        issues.append({"type": "haos_update", "severity": "warning",
                       "message": f"HAOS Update verfügbar: {version} → {latest}"})
    return issues


def check_addons(log: logging.Logger) -> list[dict]:
    issues = []
    data = ha_json("addons list")
    if data is None:
        log.warning("Add-on-Liste nicht abrufbar.")
        return issues

    addons = data.get("addons", [])
    failed, outdated = [], []

    for addon in addons:
        state  = addon.get("state", "")
        slug   = addon.get("slug", "?")
        name   = addon.get("name", slug)
        update = addon.get("update_available", False)

        if state not in ("started", "stopped_by_user", "disabled", ""):
            failed.append({"slug": slug, "name": name, "state": state})
            log.warning(f"  Add-on FEHLER: {name} (state: {state})")
        elif state == "started":
            log.info(f"  Add-on OK: {name}")

        if update:
            outdated.append({"slug": slug, "name": name})

    if failed:
        issues.append({"type": "addon_failed", "severity": "critical",
                       "message": f"{len(failed)} Add-on(s) im Fehlerzustand",
                       "details": failed})
    if outdated:
        issues.append({"type": "addon_updates", "severity": "warning",
                       "message": f"{len(outdated)} Add-on(s) haben Updates",
                       "details": outdated})
    return issues


def check_network(log: logging.Logger) -> list[dict]:
    issues = []
    rc, _, _ = run("ping -c 2 -W 3 8.8.8.8")
    if rc != 0:
        issues.append({"type": "network", "severity": "warning",
                       "message": "Keine Internetverbindung (ping zu 8.8.8.8 fehlgeschlagen)"})
        log.warning("Netzwerk: Keine Internetverbindung.")
    else:
        log.info("Netzwerk: Internetverbindung vorhanden.")
    return issues


def check_watchdog(log: logging.Logger) -> list[dict]:
    issues = []
    data = ha_json("core info")
    if data and not data.get("watchdog", True):
        issues.append({"type": "watchdog_off", "severity": "warning",
                       "message": "HA Core Watchdog ist deaktiviert"})
        log.warning("Watchdog ist deaktiviert.")
    else:
        log.info("Watchdog: aktiv.")
    return issues


# ---------------------------------------------------------------------------
# Reparaturen
# ---------------------------------------------------------------------------

def repair_ha_core_stopped(issue: dict, log: logging.Logger) -> bool:
    log.info("Reparatur: Starte HA Core neu...")
    rc, _, err = run("ha core restart", timeout=120)
    if rc == 0:
        time.sleep(15)
        data = ha_json("core info")
        if data and data.get("state") == "running":
            log.info("  HA Core läuft wieder.")
            return True
    log.warning(f"  Neustart fehlgeschlagen: {err[:200]}")
    return False


def repair_ha_core_update(issue: dict, log: logging.Logger) -> bool:
    log.info("Reparatur: Installiere HA Core Update...")
    rc, _, err = run("ha core update", timeout=300)
    if rc == 0:
        log.info("  HA Core Update erfolgreich.")
        return True
    log.warning(f"  Update fehlgeschlagen: {err[:200]}")
    return False


def repair_supervisor_unhealthy(issue: dict, log: logging.Logger) -> bool:
    log.info("Reparatur: Lade Supervisor neu...")
    rc, _, err = run("ha supervisor reload", timeout=60)
    if rc == 0:
        time.sleep(10)
        data = ha_json("supervisor info")
        if data and data.get("healthy"):
            log.info("  Supervisor ist wieder gesund.")
            return True
    log.warning(f"  Supervisor-Reload fehlgeschlagen: {err[:200]}")
    return False


def repair_supervisor_update(issue: dict, log: logging.Logger) -> bool:
    log.info("Reparatur: Installiere Supervisor Update...")
    rc, _, err = run("ha supervisor update", timeout=300)
    if rc == 0:
        log.info("  Supervisor Update erfolgreich.")
        return True
    log.warning(f"  Supervisor Update fehlgeschlagen: {err[:200]}")
    return False


def repair_haos_update(issue: dict, log: logging.Logger) -> bool:
    log.info("Reparatur: Installiere HAOS Update...")
    rc, _, err = run("ha os update", timeout=600)
    if rc == 0:
        log.info("  HAOS Update erfolgreich (System startet ggf. neu).")
        return True
    log.warning(f"  HAOS Update fehlgeschlagen: {err[:200]}")
    return False


def repair_addon_failed(issue: dict, log: logging.Logger) -> bool:
    all_ok = True
    for addon in issue.get("details", []):
        slug = addon["slug"]
        name = addon["name"]
        log.info(f"  Starte Add-on '{name}' ({slug}) neu...")
        rc, _, err = run(f"ha addons restart {slug}", timeout=60)
        if rc == 0:
            time.sleep(5)
            data = ha_json(f"addons info {slug}")
            if data and data.get("state") == "started":
                log.info(f"    '{name}' läuft wieder.")
            else:
                log.warning(f"    '{name}' startet nicht (state unbekannt).")
                all_ok = False
        else:
            log.warning(f"    Neustart von '{name}' fehlgeschlagen: {err[:100]}")
            all_ok = False
    return all_ok


def repair_addon_updates(issue: dict, log: logging.Logger) -> bool:
    all_ok = True
    for addon in issue.get("details", []):
        slug = addon["slug"]
        name = addon["name"]
        log.info(f"  Update Add-on '{name}' ({slug})...")
        rc, _, err = run(f"ha addons update {slug}", timeout=300)
        if rc == 0:
            log.info(f"    '{name}' aktualisiert.")
        else:
            log.warning(f"    Update von '{name}' fehlgeschlagen: {err[:100]}")
            all_ok = False
    return all_ok


def repair_disk_space(issue: dict, log: logging.Logger) -> bool:
    log.info("Reparatur: Bereinige Festplattenplatz...")
    # Alte HA-Backups bereinigen (behält nur die neuesten 3)
    rc, out, _ = run("ha backups list --raw-json")
    freed = False
    if rc == 0:
        try:
            backups = json.loads(out).get("data", {}).get("backups", [])
            backups_sorted = sorted(backups, key=lambda b: b.get("date", ""), reverse=True)
            to_delete = backups_sorted[3:]
            for b in to_delete:
                slug = b.get("slug")
                log.info(f"  Lösche altes Backup: {b.get('name', slug)}")
                run(f"ha backups remove {slug}", timeout=60)
                freed = True
        except Exception:
            pass

    # Alte Log-Protokolle bereinigen (älter als 30 Tage)
    rc2, _, _ = run(f"find {LOG_DIR} -name '*.log' -mtime +30 -delete 2>/dev/null")
    if rc2 == 0:
        log.info("  Alte Health-Logs bereinigt (> 30 Tage).")
        freed = True

    return freed


def repair_network(issue: dict, log: logging.Logger) -> bool:
    log.info("Reparatur: Versuche Netzwerk neu zu starten...")
    rc, _, _ = run("ha network reload", timeout=30)
    if rc == 0:
        time.sleep(5)
        rc2, _, _ = run("ping -c 2 -W 3 8.8.8.8")
        if rc2 == 0:
            log.info("  Netzwerk wiederhergestellt.")
            return True
    log.warning("  Netzwerk konnte nicht automatisch repariert werden.")
    return False


def repair_watchdog_off(issue: dict, log: logging.Logger) -> bool:
    log.info("Reparatur: Aktiviere Watchdog...")
    rc, _, err = run("ha core options --watchdog true", timeout=30)
    if rc == 0:
        log.info("  Watchdog aktiviert.")
        return True
    log.warning(f"  Watchdog-Aktivierung fehlgeschlagen: {err[:100]}")
    return False


REPAIR_MAP = {
    "ha_core_stopped":      repair_ha_core_stopped,
    "ha_core_update":       repair_ha_core_update,
    "supervisor_unhealthy": repair_supervisor_unhealthy,
    "supervisor_update":    repair_supervisor_update,
    "haos_update":          repair_haos_update,
    "addon_failed":         repair_addon_failed,
    "addon_updates":        repair_addon_updates,
    "disk_space":           repair_disk_space,
    "network":              repair_network,
    "watchdog_off":         repair_watchdog_off,
}

REPAIR_SKIP = {
    "temperature":           "Hohe Temperatur – bitte Kühlung prüfen (Lüfter, Gehäuse, Platzierung).",
    "memory":                "Hohe RAM-Nutzung – prüfe speicherhungrige Add-ons in HA.",
    "ha_core_unreachable":   "Supervisor nicht erreichbar – manueller Eingriff erforderlich.",
}


# ---------------------------------------------------------------------------
# Hauptprogramm
# ---------------------------------------------------------------------------

def main() -> None:
    log = setup_logging()
    log.info("=" * 60)
    log.info("Home Assistant OS Health Check gestartet")
    log.info(f"Protokolldatei: {LOG_FILE}")
    log.info("=" * 60)

    checks = [
        ("CPU-Temperatur",     check_temperature),
        ("Festplattenplatz",   check_disk_space),
        ("Arbeitsspeicher",    check_memory),
        ("HA Core",            check_ha_core),
        ("Supervisor",         check_supervisor),
        ("HAOS Version",       check_haos),
        ("Add-ons",            check_addons),
        ("Netzwerk",           check_network),
        ("Watchdog",           check_watchdog),
    ]

    all_issues: list[dict] = []
    for name, fn in checks:
        log.info(f"--- Prüfe: {name} ---")
        try:
            found = fn(log)
            all_issues.extend(found)
        except Exception as e:
            log.error(f"Fehler bei Prüfung '{name}': {e}")

    log.info("=" * 60)
    log.info(f"Prüfung abgeschlossen – {len(all_issues)} Problem(e) gefunden.")

    if not all_issues:
        log.info("System ist gesund. Keine Reparaturen notwendig.")
        log.info("=" * 60)
        return

    critical = [i for i in all_issues if i["severity"] == "critical"]
    warnings  = [i for i in all_issues if i["severity"] == "warning"]
    log.info(f"  Kritisch: {len(critical)}  |  Warnungen: {len(warnings)}")

    log.info("=" * 60)
    log.info("Starte Reparaturversuche...")

    results: list[dict] = []
    for issue in all_issues:
        itype = issue["type"]
        log.info(f"--- Reparatur: {itype} ({issue['severity']}) ---")
        log.info(f"    {issue['message']}")

        if itype in REPAIR_SKIP:
            log.warning(f"  Übersprungen: {REPAIR_SKIP[itype]}")
            results.append({"issue": issue, "fixed": False, "skipped": True})
            continue

        repair_fn = REPAIR_MAP.get(itype)
        if repair_fn is None:
            log.warning(f"  Keine Reparaturroutine für Typ '{itype}'.")
            results.append({"issue": issue, "fixed": False, "skipped": True})
            continue

        try:
            fixed = repair_fn(issue, log)
        except Exception as e:
            log.error(f"  Reparatur-Ausnahme: {e}")
            fixed = False

        results.append({"issue": issue, "fixed": fixed, "skipped": False})

    log.info("=" * 60)
    log.info("Zusammenfassung")
    log.info("=" * 60)
    fixed_count   = sum(1 for r in results if r["fixed"])
    skipped_count = sum(1 for r in results if r["skipped"])
    failed_count  = sum(1 for r in results if not r["fixed"] and not r["skipped"])

    for r in results:
        status = "BEHOBEN" if r["fixed"] else ("ÜBERSPRUNGEN" if r["skipped"] else "FEHLGESCHLAGEN")
        log.info(f"  [{status:>13}] {r['issue']['message']}")

    log.info("-" * 60)
    log.info(f"Behoben: {fixed_count}  |  Übersprungen: {skipped_count}  |  Fehlgeschlagen: {failed_count}")
    log.info(f"Vollständiges Protokoll: {LOG_FILE}")
    log.info("=" * 60)

    sys.exit(1 if failed_count > 0 else 0)


if __name__ == "__main__":
    main()
