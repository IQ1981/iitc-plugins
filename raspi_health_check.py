#!/usr/bin/env python3
"""
Raspberry Pi Health Check & Auto-Repair
Prüft das System auf Fehler, erstellt ein Protokoll und versucht Fehler zu beheben.
"""

import subprocess
import os
import sys
import logging
import shutil
import re
from datetime import datetime
from pathlib import Path

LOG_DIR = Path("/var/log/raspi-health")
LOG_FILE = LOG_DIR / f"health_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
TEMP_WARNING = 70.0
TEMP_CRITICAL = 80.0
DISK_WARNING = 80
DISK_CRITICAL = 90


def setup_logging() -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("raspi-health")
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
    """Führt einen Shell-Befehl aus und gibt (returncode, stdout, stderr) zurück."""
    result = subprocess.run(
        cmd, shell=True, capture_output=True, text=True, timeout=timeout
    )
    return result.returncode, result.stdout.strip(), result.stderr.strip()


# ---------------------------------------------------------------------------
# Prüfungen
# ---------------------------------------------------------------------------

def check_cpu_temperature(log: logging.Logger) -> list[dict]:
    issues = []
    temp_file = Path("/sys/class/thermal/thermal_zone0/temp")
    if not temp_file.exists():
        log.warning("CPU-Temperaturdatei nicht gefunden – Prüfung übersprungen.")
        return issues

    try:
        temp_c = int(temp_file.read_text().strip()) / 1000
        log.info(f"CPU-Temperatur: {temp_c:.1f} °C")
        if temp_c >= TEMP_CRITICAL:
            issues.append({
                "type": "temperature",
                "severity": "critical",
                "message": f"CPU-Temperatur kritisch: {temp_c:.1f} °C (Grenzwert: {TEMP_CRITICAL} °C)",
                "value": temp_c,
            })
        elif temp_c >= TEMP_WARNING:
            issues.append({
                "type": "temperature",
                "severity": "warning",
                "message": f"CPU-Temperatur erhöht: {temp_c:.1f} °C (Grenzwert: {TEMP_WARNING} °C)",
                "value": temp_c,
            })
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
        issues.append({
            "type": "disk_space",
            "severity": "critical",
            "message": f"Kritisch wenig Speicherplatz: {pct:.1f}% belegt",
            "value": pct,
        })
    elif pct >= DISK_WARNING:
        issues.append({
            "type": "disk_space",
            "severity": "warning",
            "message": f"Speicherplatz knapp: {pct:.1f}% belegt",
            "value": pct,
        })
    return issues


def check_memory(log: logging.Logger) -> list[dict]:
    issues = []
    rc, out, _ = run("free -m")
    if rc != 0:
        return issues

    for line in out.splitlines():
        if line.startswith("Mem:"):
            parts = line.split()
            total = int(parts[1])
            used = int(parts[2])
            pct = (used / total) * 100
            log.info(f"RAM-Nutzung: {pct:.1f}% ({used} MB / {total} MB)")
            if pct >= 95:
                issues.append({
                    "type": "memory",
                    "severity": "critical",
                    "message": f"RAM kritisch voll: {pct:.1f}%",
                    "value": pct,
                })
            elif pct >= 85:
                issues.append({
                    "type": "memory",
                    "severity": "warning",
                    "message": f"RAM-Nutzung hoch: {pct:.1f}%",
                    "value": pct,
                })
    return issues


def check_filesystem(log: logging.Logger) -> list[dict]:
    issues = []
    rc, out, _ = run("dmesg --level=err,crit,alert,emerg -T 2>/dev/null | tail -50")
    if rc == 0 and out:
        fs_errors = [l for l in out.splitlines() if any(k in l.lower() for k in
                     ["ext4-fs error", "i/o error", "buffer i/o", "end_request", "filesystem error"])]
        if fs_errors:
            issues.append({
                "type": "filesystem",
                "severity": "critical",
                "message": f"Dateisystemfehler im Kernel-Log gefunden ({len(fs_errors)} Einträge)",
                "details": fs_errors,
            })
            for line in fs_errors[:5]:
                log.error(f"  FS-Fehler: {line}")
        else:
            log.info("Keine Dateisystemfehler im Kernel-Log.")
    return issues


def check_failed_services(log: logging.Logger) -> list[dict]:
    issues = []
    rc, out, _ = run("systemctl --failed --no-legend --no-pager 2>/dev/null")
    if rc == 0 and out:
        failed = [l.split()[0] for l in out.splitlines() if l.strip()]
        if failed:
            issues.append({
                "type": "services",
                "severity": "warning",
                "message": f"Fehlgeschlagene Dienste: {', '.join(failed)}",
                "details": failed,
            })
            log.warning(f"Fehlgeschlagene Dienste: {', '.join(failed)}")
        else:
            log.info("Alle systemd-Dienste laufen korrekt.")
    return issues


def check_network(log: logging.Logger) -> list[dict]:
    issues = []
    rc, _, _ = run("ping -c 2 -W 3 8.8.8.8")
    if rc != 0:
        issues.append({
            "type": "network",
            "severity": "warning",
            "message": "Keine Internetverbindung (ping zu 8.8.8.8 fehlgeschlagen)",
        })
        log.warning("Netzwerk: Keine Internetverbindung.")
    else:
        log.info("Netzwerk: Internetverbindung vorhanden.")
    return issues


def check_updates_needed(log: logging.Logger) -> list[dict]:
    issues = []
    rc, out, _ = run("apt-get -s upgrade 2>/dev/null | grep -c '^Inst'", timeout=60)
    try:
        count = int(out.strip()) if rc == 0 else 0
    except ValueError:
        count = 0

    if count > 0:
        severity = "critical" if count > 50 else "warning"
        issues.append({
            "type": "updates",
            "severity": severity,
            "message": f"{count} ausstehende Systemupdates",
            "value": count,
        })
        log.warning(f"Ausstehende Updates: {count}")
    else:
        log.info("System ist aktuell.")
    return issues


def check_swap(log: logging.Logger) -> list[dict]:
    issues = []
    rc, out, _ = run("free -m")
    if rc != 0:
        return issues
    for line in out.splitlines():
        if line.startswith("Swap:"):
            parts = line.split()
            total = int(parts[1])
            used = int(parts[2])
            if total == 0:
                log.info("Kein Swap konfiguriert.")
                return issues
            pct = (used / total) * 100
            log.info(f"Swap-Nutzung: {pct:.1f}% ({used} MB / {total} MB)")
            if pct >= 80:
                issues.append({
                    "type": "swap",
                    "severity": "warning",
                    "message": f"Swap stark genutzt: {pct:.1f}%",
                    "value": pct,
                })
    return issues


def check_zombie_processes(log: logging.Logger) -> list[dict]:
    issues = []
    rc, out, _ = run("ps aux | awk '$8==\"Z\" {print $0}'")
    if rc == 0 and out:
        zombies = out.strip().splitlines()
        if zombies:
            issues.append({
                "type": "zombies",
                "severity": "warning",
                "message": f"{len(zombies)} Zombie-Prozesse gefunden",
                "details": zombies,
            })
            log.warning(f"Zombie-Prozesse: {len(zombies)}")
    else:
        log.info("Keine Zombie-Prozesse.")
    return issues


# ---------------------------------------------------------------------------
# Reparaturen
# ---------------------------------------------------------------------------

def repair_disk_space(issue: dict, log: logging.Logger) -> bool:
    log.info("Reparatur: Bereinige Festplattenplatz...")
    success = True

    rc, _, _ = run("apt-get autoremove -y 2>/dev/null", timeout=120)
    if rc == 0:
        log.info("  apt autoremove: erfolgreich")
    else:
        log.warning("  apt autoremove: fehlgeschlagen")
        success = False

    rc, _, _ = run("apt-get clean 2>/dev/null", timeout=60)
    if rc == 0:
        log.info("  apt clean: erfolgreich")
    else:
        log.warning("  apt clean: fehlgeschlagen")

    rc, _, _ = run("journalctl --vacuum-time=7d 2>/dev/null", timeout=30)
    if rc == 0:
        log.info("  Alte Logs bereinigt (älter als 7 Tage)")

    rc, _, _ = run("find /tmp -type f -atime +7 -delete 2>/dev/null", timeout=30)
    if rc == 0:
        log.info("  /tmp bereinigt (Dateien älter als 7 Tage)")

    return success


def repair_memory(issue: dict, log: logging.Logger) -> bool:
    log.info("Reparatur: Bereinige Page-Cache...")
    rc, _, _ = run("sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null")
    if rc == 0:
        log.info("  Page-Cache geleert.")
        return True
    log.warning("  Page-Cache konnte nicht geleert werden (Root-Rechte erforderlich).")
    return False


def repair_services(issue: dict, log: logging.Logger) -> bool:
    log.info("Reparatur: Versuche fehlgeschlagene Dienste neu zu starten...")
    all_ok = True
    for svc in issue.get("details", []):
        rc, _, _ = run(f"systemctl restart {svc} 2>/dev/null", timeout=30)
        if rc == 0:
            log.info(f"  Dienst '{svc}' neu gestartet.")
        else:
            log.warning(f"  Dienst '{svc}' konnte nicht neu gestartet werden.")
            all_ok = False
    return all_ok


def repair_network(issue: dict, log: logging.Logger) -> bool:
    log.info("Reparatur: Versuche Netzwerk neu zu starten...")

    rc, _, _ = run("systemctl restart networking 2>/dev/null", timeout=30)
    if rc == 0:
        rc2, _, _ = run("ping -c 2 -W 3 8.8.8.8")
        if rc2 == 0:
            log.info("  Netzwerk wiederhergestellt.")
            return True

    rc, _, _ = run("systemctl restart NetworkManager 2>/dev/null", timeout=30)
    if rc == 0:
        import time
        time.sleep(5)
        rc2, _, _ = run("ping -c 2 -W 3 8.8.8.8")
        if rc2 == 0:
            log.info("  Netzwerk über NetworkManager wiederhergestellt.")
            return True

    log.warning("  Netzwerk konnte nicht automatisch repariert werden.")
    return False


def repair_updates(issue: dict, log: logging.Logger) -> bool:
    log.info("Reparatur: Installiere ausstehende Updates...")
    env = os.environ.copy()
    env["DEBIAN_FRONTEND"] = "noninteractive"

    rc, _, err = run("apt-get update -qq 2>/dev/null", timeout=120)
    if rc != 0:
        log.warning(f"  apt-get update fehlgeschlagen: {err[:200]}")
        return False

    rc, _, err = run(
        "apt-get upgrade -y -o Dpkg::Options::='--force-confdef' "
        "-o Dpkg::Options::='--force-confold' 2>/dev/null",
        timeout=600,
    )
    if rc == 0:
        log.info("  Updates erfolgreich installiert.")
        return True
    log.warning(f"  Updates fehlgeschlagen: {err[:200]}")
    return False


REPAIR_MAP = {
    "disk_space": repair_disk_space,
    "memory": repair_memory,
    "services": repair_services,
    "network": repair_network,
    "updates": repair_updates,
}

REPAIR_SKIP_MESSAGE = {
    "temperature": "Hohe Temperatur kann nicht per Software behoben werden – bitte Kühlung prüfen.",
    "filesystem": "Dateisystemfehler erfordern manuelle Prüfung (z. B. fsck beim nächsten Boot).",
    "zombies": "Zombie-Prozesse verschwinden meist beim nächsten Reboot automatisch.",
    "swap": "Swap-Nutzung: keine automatische Reparatur – ggf. RAM-Nutzung prüfen.",
}


# ---------------------------------------------------------------------------
# Hauptprogramm
# ---------------------------------------------------------------------------

def main() -> None:
    if os.geteuid() != 0:
        print("HINWEIS: Ohne Root-Rechte sind einige Prüfungen und Reparaturen eingeschränkt.")

    log = setup_logging()
    log.info("=" * 60)
    log.info("Raspberry Pi Health Check gestartet")
    log.info(f"Protokolldatei: {LOG_FILE}")
    log.info("=" * 60)

    checks = [
        ("CPU-Temperatur",     check_cpu_temperature),
        ("Festplattenplatz",   check_disk_space),
        ("Arbeitsspeicher",    check_memory),
        ("Swap",               check_swap),
        ("Dateisystem",        check_filesystem),
        ("Systemdienste",      check_failed_services),
        ("Netzwerk",           check_network),
        ("Zombie-Prozesse",    check_zombie_processes),
        ("System-Updates",     check_updates_needed),
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

        if itype in REPAIR_SKIP_MESSAGE:
            log.warning(f"  Übersprungen: {REPAIR_SKIP_MESSAGE[itype]}")
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
