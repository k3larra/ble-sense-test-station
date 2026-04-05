#!/usr/bin/env python3
from __future__ import annotations

import json
import platform
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from collections import deque
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    import serial  # type: ignore
    from serial.tools import list_ports  # type: ignore
except ImportError:
    serial = None
    list_ports = None


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "sensor_table_monitor"
SKETCH_DIR = ROOT / "sense_table_stream"
HOST = "127.0.0.1"
PORT = 8765
APP_VERSION = "0.9"

BOARD_PROFILE = {
    "id": "nano33ble",
    "label": "Arduino Nano 33 BLE / BLE Sense",
    "platform": "arduino:mbed_nano",
    "fqbn_candidates": [
        "arduino:mbed_nano:nano33ble",
        "arduino:mbed:nano33ble",
    ],
}

LIBRARIES_BY_REVISION = {
    "rev1": [
        "Arduino_APDS9960",
        "Arduino_HTS221",
        "Arduino_LPS22HB",
        "Arduino_LSM9DS1",
    ],
    "rev2": [
        "Arduino_APDS9960",
        "Arduino_BMI270_BMM150",
        "Arduino_HS300x",
        "Arduino_LPS22HB",
    ],
}

SENSOR_DEFINITIONS = [
    {"key": "temp", "label": "Temperature", "model": "HTS221", "note": "Air temperature"},
    {"key": "humidity", "label": "Humidity", "model": "HTS221", "note": "Relative humidity"},
    {"key": "pressure", "label": "Pressure", "model": "LPS22HB", "note": "Barometric pressure"},
    {"key": "accelerometer", "label": "Accelerometer", "model": "LSM9DS1", "note": "3-axis acceleration"},
    {"key": "gyroscope", "label": "Gyroscope", "model": "LSM9DS1", "note": "3-axis rotation"},
    {"key": "magnetometer", "label": "Magnetometer", "model": "LSM9DS1", "note": "3-axis magnetic field"},
    {"key": "color", "label": "Color", "model": "APDS9960", "note": "Needs visible light"},
    {"key": "proximity", "label": "Proximity", "model": "APDS9960", "note": "Distance estimate"},
    {"key": "gesture", "label": "Gesture", "model": "APDS9960", "note": "Wave a hand to verify"},
    {"key": "microphone", "label": "Microphone", "model": "MP34DT05", "note": "Clap or tap near the board"},
]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def clamp_log_lines(lines: deque[dict[str, str]], entry: dict[str, str], limit: int = 250) -> None:
    lines.append(entry)
    while len(lines) > limit:
        lines.popleft()


def normalize_port_entry(port_entry: Any) -> dict[str, Any]:
    if isinstance(port_entry, dict) and "port" in port_entry:
        port_data = port_entry.get("port") or {}
        boards = port_entry.get("matching_boards") or port_entry.get("boards") or []
        return {
            "address": port_data.get("address"),
            "label": port_data.get("label") or port_data.get("address"),
            "protocol": port_data.get("protocol") or port_entry.get("protocol"),
            "board_name": boards[0].get("name") if boards else None,
            "fqbn": boards[0].get("fqbn") if boards else None,
        }

    if isinstance(port_entry, dict):
        boards = port_entry.get("boards") or port_entry.get("matching_boards") or []
        return {
            "address": port_entry.get("address"),
            "label": port_entry.get("address"),
            "protocol": port_entry.get("protocol"),
            "board_name": boards[0].get("name") if boards else None,
            "fqbn": boards[0].get("fqbn") if boards else None,
        }

    return {"address": None, "label": None, "protocol": None, "board_name": None, "fqbn": None}


def read_command_json(command: list[str], cwd: Path | None = None) -> Any:
    completed = subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)
    stdout = (completed.stdout or "").strip()
    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip()
        raise RuntimeError(stderr or stdout or f"Command failed: {' '.join(command)}")
    if not stdout:
        return None
    return json.loads(stdout)


def value_is_number(value: Any) -> bool:
    return isinstance(value, (int, float))


@dataclass
class SensorTracker:
    key: str
    status: str = "waiting"
    note: str = "Waiting for data."
    value: str = "--"
    seen: bool = False
    activity_seen: bool = False


@dataclass
class AppState:
    logs: deque[dict[str, str]] = field(default_factory=deque)
    busy: bool = False
    current_task: str = "Idle"
    ports: list[dict[str, Any]] = field(default_factory=list)
    connected_port: str | None = None
    serial_thread: threading.Thread | None = None
    serial_stop: threading.Event = field(default_factory=threading.Event)
    serial_handle: Any = None
    serial_error: str | None = None
    last_snapshot: dict[str, Any] | None = None
    snapshot_count: int = 0
    last_data_at: str | None = None
    upload_result: str | None = None
    setup_result: str | None = None
    command_result: str | None = None
    detected_revision: str | None = None
    sensor_state: dict[str, SensorTracker] = field(
        default_factory=lambda: {item["key"]: SensorTracker(item["key"]) for item in SENSOR_DEFINITIONS}
    )
    lock: threading.Lock = field(default_factory=threading.Lock)

    def log(self, level: str, message: str) -> None:
        with self.lock:
            clamp_log_lines(self.logs, {"time": now_iso(), "level": level, "message": message})

    def set_busy(self, is_busy: bool, task: str) -> None:
        with self.lock:
            self.busy = is_busy
            self.current_task = task

    def set_command_result(self, message: str) -> None:
        with self.lock:
            self.command_result = message


STATE = AppState()


def get_python_command() -> list[str]:
    return [sys.executable]


def get_install_help() -> dict[str, str]:
    system = platform.system().lower()
    if system == "darwin":
        return {
            "arduino_cli": "Install Arduino CLI with Homebrew: brew update && brew install arduino-cli",
            "arduino_cli_url": "https://docs.arduino.cc/arduino-cli/installation/",
            "pyserial": f"Install pyserial with: {sys.executable} -m pip install pyserial",
        }
    if system == "windows":
        return {
            "arduino_cli": "Install Arduino CLI from the official Arduino CLI installation page.",
            "arduino_cli_url": "https://docs.arduino.cc/arduino-cli/installation/",
            "pyserial": f"Install pyserial with: {sys.executable} -m pip install pyserial",
        }
    return {
        "arduino_cli": "Install Arduino CLI from the official Arduino CLI installation page.",
        "arduino_cli_url": "https://docs.arduino.cc/arduino-cli/installation/",
        "pyserial": f"Install pyserial with: {sys.executable} -m pip install pyserial",
    }


def find_arduino_cli() -> str | None:
    return shutil.which("arduino-cli")


def list_serial_ports() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if list_ports is not None:
        for port_info in list_ports.comports():
            result.append(
                {
                    "address": port_info.device,
                    "label": f"{port_info.device} - {port_info.description}",
                    "protocol": "serial",
                    "board_name": None,
                    "fqbn": None,
                    "description": port_info.description,
                    "manufacturer": port_info.manufacturer,
                    "hwid": port_info.hwid,
                }
            )

    cli = find_arduino_cli()
    if cli:
        try:
            board_list = read_command_json([cli, "board", "list", "--format", "json"])
            if isinstance(board_list, list):
                for item in board_list:
                    normalized = normalize_port_entry(item)
                    existing = next((entry for entry in result if entry["address"] == normalized["address"]), None)
                    if existing:
                        existing["board_name"] = normalized["board_name"] or existing["board_name"]
                        existing["fqbn"] = normalized["fqbn"] or existing["fqbn"]
                    elif normalized["address"]:
                        result.append(normalized)
        except Exception as exc:  # pragma: no cover
            STATE.log("warn", f"Board detection via arduino-cli failed: {exc}")

    result.sort(key=lambda item: item["address"] or "")
    return result


def detect_board_revision(port: str | None) -> str:
    ports = list_serial_ports()
    if port:
        match = next((item for item in ports if item["address"] == port), None)
        if match:
            searchable = " ".join(
                str(match.get(key) or "") for key in ("label", "board_name", "description", "manufacturer", "hwid")
            ).lower()
            if "rev2" in searchable:
                return "rev2"
            if "sense" in searchable:
                return "rev1"

    return "rev2"


def get_installed_arduino_cores(cli: str) -> set[str]:
    payload = read_command_json([cli, "core", "list", "--format", "json"])
    platforms = payload.get("platforms", []) if isinstance(payload, dict) else []
    installed: set[str] = set()
    for platform_info in platforms:
        if not isinstance(platform_info, dict):
            continue
        if platform_info.get("installed_version"):
            platform_id = platform_info.get("id")
            if platform_id:
                installed.add(str(platform_id))
    return installed


def get_installed_arduino_libraries(cli: str) -> set[str]:
    payload = read_command_json([cli, "lib", "list", "--format", "json"])
    entries = payload.get("installed_libraries", []) if isinstance(payload, dict) else []
    installed: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        library = entry.get("library")
        if not isinstance(library, dict):
            continue
        name = library.get("name")
        if name:
            installed.add(str(name))
    return installed


def ensure_arduino_dependencies(revision: str) -> None:
    cli = find_arduino_cli()
    if not cli:
        raise RuntimeError(get_install_help()["arduino_cli"])

    installed_cores = get_installed_arduino_cores(cli)
    core_missing = BOARD_PROFILE["platform"] not in installed_cores
    required_libraries = LIBRARIES_BY_REVISION[revision]
    installed_libraries = get_installed_arduino_libraries(cli)
    missing_libraries = [library for library in required_libraries if library not in installed_libraries]

    if not core_missing and not missing_libraries:
        STATE.log("info", f"Arduino dependencies for {revision.upper()} are already installed.")
        STATE.log("info", "Using PDM from the board core; no separate PDM library install is required.")
        return

    STATE.log("info", "Updating Arduino core index.")
    update_process = subprocess.run([cli, "core", "update-index"], capture_output=True, text=True, check=False)
    if update_process.returncode != 0:
        raise RuntimeError((update_process.stderr or update_process.stdout or "core update-index failed.").strip())

    if core_missing:
        STATE.log("info", f"Installing board core {BOARD_PROFILE['platform']}.")
        core_process = subprocess.run(
            [cli, "core", "install", BOARD_PROFILE["platform"]],
            capture_output=True,
            text=True,
            check=False,
        )
        if core_process.returncode != 0:
            raise RuntimeError((core_process.stderr or core_process.stdout or "core install failed.").strip())
    else:
        STATE.log("info", f"Board core {BOARD_PROFILE['platform']} is already installed.")

    for library in missing_libraries:
        STATE.log("info", f"Installing Arduino library {library}.")
        library_process = subprocess.run(
            [cli, "lib", "install", library],
            capture_output=True,
            text=True,
            check=False,
        )
        if library_process.returncode != 0:
            raise RuntimeError((library_process.stderr or library_process.stdout or f"Library install failed: {library}").strip())

    if not missing_libraries:
        STATE.log("info", f"{revision.upper()} sensor libraries are already installed.")

    STATE.log("info", "Using PDM from the board core; no separate PDM library install is required.")


def select_fqbn_for_port(port: str | None) -> str:
    ports = list_serial_ports()
    if port:
        match = next((item for item in ports if item["address"] == port), None)
        if match and match.get("fqbn"):
            return str(match["fqbn"])
    return BOARD_PROFILE["fqbn_candidates"][0]


def compile_and_upload(port: str, revision: str) -> str:
    cli = find_arduino_cli()
    if not cli:
        raise RuntimeError(get_install_help()["arduino_cli"])

    fqbn = select_fqbn_for_port(port)
    STATE.log("info", f"Compiling sense_table_stream for {fqbn} ({revision}).")
    compile_command = [cli, "compile", "--fqbn", fqbn]
    if revision == "rev2":
        compile_command.extend(["--build-property", "compiler.cpp.extra_flags=-DBLE_SENSE_REV2"])
    compile_command.append(str(SKETCH_DIR))
    compile_process = subprocess.run(
        compile_command,
        capture_output=True,
        text=True,
        check=False,
    )
    if compile_process.returncode != 0:
        raise RuntimeError((compile_process.stderr or compile_process.stdout or "Compile failed.").strip())

    STATE.log("info", f"Uploading test sketch to {port}.")
    upload_process = subprocess.run(
        [cli, "upload", "-p", port, "--fqbn", fqbn, str(SKETCH_DIR)],
        capture_output=True,
        text=True,
        check=False,
    )
    if upload_process.returncode != 0:
        raise RuntimeError((upload_process.stderr or upload_process.stdout or "Upload failed.").strip())

    return f"Uploaded {SKETCH_DIR.name} to {port} using {fqbn} ({revision})."


def update_sensor_state(snapshot: dict[str, Any]) -> None:
    sensors = STATE.sensor_state

    temp = snapshot.get("temp_c")
    sensors["temp"].seen = value_is_number(temp)
    sensors["temp"].value = "--" if not value_is_number(temp) else f"{temp:.2f} deg C"
    sensors["temp"].status = "ok" if sensors["temp"].seen else "problem"
    sensors["temp"].note = "Reading received." if sensors["temp"].seen else "No temperature reading."

    humidity = snapshot.get("humidity_pct")
    sensors["humidity"].seen = value_is_number(humidity)
    sensors["humidity"].value = "--" if not value_is_number(humidity) else f"{humidity:.2f} %RH"
    sensors["humidity"].status = "ok" if sensors["humidity"].seen else "problem"
    sensors["humidity"].note = "Reading received." if sensors["humidity"].seen else "No humidity reading."

    pressure = snapshot.get("pressure_kpa")
    sensors["pressure"].seen = value_is_number(pressure)
    sensors["pressure"].value = "--" if not value_is_number(pressure) else f"{pressure:.2f} kPa"
    sensors["pressure"].status = "ok" if sensors["pressure"].seen else "problem"
    sensors["pressure"].note = "Reading received." if sensors["pressure"].seen else "No pressure reading."

    accel = snapshot.get("accel_g")
    accel_ok = isinstance(accel, list) and len(accel) == 3 and all(value_is_number(item) for item in accel)
    sensors["accelerometer"].seen = accel_ok
    sensors["accelerometer"].value = "--" if not accel_ok else f"x={accel[0]:.3f}, y={accel[1]:.3f}, z={accel[2]:.3f} g"
    sensors["accelerometer"].status = "ok" if accel_ok else "problem"
    sensors["accelerometer"].note = "Live 3-axis data received." if accel_ok else "No accelerometer reading."

    gyro = snapshot.get("gyro_dps")
    gyro_ok = isinstance(gyro, list) and len(gyro) == 3 and all(value_is_number(item) for item in gyro)
    sensors["gyroscope"].seen = gyro_ok
    sensors["gyroscope"].value = "--" if not gyro_ok else f"x={gyro[0]:.2f}, y={gyro[1]:.2f}, z={gyro[2]:.2f} dps"
    sensors["gyroscope"].status = "ok" if gyro_ok else "problem"
    sensors["gyroscope"].note = "Live 3-axis data received." if gyro_ok else "No gyroscope reading."

    mag = snapshot.get("mag_ut")
    mag_ok = isinstance(mag, list) and len(mag) == 3 and all(value_is_number(item) for item in mag)
    sensors["magnetometer"].seen = mag_ok
    sensors["magnetometer"].value = "--" if not mag_ok else f"x={mag[0]:.2f}, y={mag[1]:.2f}, z={mag[2]:.2f} uT"
    sensors["magnetometer"].status = "ok" if mag_ok else "problem"
    sensors["magnetometer"].note = "Live 3-axis data received." if mag_ok else "No magnetometer reading."

    color = snapshot.get("color")
    color_ok = isinstance(color, dict) and all(value_is_number(color.get(key)) for key in ("r", "g", "b", "c"))
    sensors["color"].seen = color_ok
    sensors["color"].value = "--" if not color_ok else f"r={color['r']}, g={color['g']}, b={color['b']}, c={color['c']}"
    sensors["color"].status = "ok" if color_ok else "problem"
    sensors["color"].note = "Reading received." if color_ok else "No color reading."

    proximity = snapshot.get("proximity")
    prox_ok = value_is_number(proximity)
    sensors["proximity"].seen = prox_ok
    sensors["proximity"].value = "--" if not prox_ok else str(proximity)
    sensors["proximity"].status = "ok" if prox_ok else "problem"
    sensors["proximity"].note = "Reading received." if prox_ok else "No proximity reading."

    gesture = snapshot.get("gesture")
    if isinstance(gesture, str) and gesture in {"up", "down", "left", "right"}:
        sensors["gesture"].activity_seen = True
    sensors["gesture"].seen = isinstance(gesture, str)
    sensors["gesture"].value = gesture if isinstance(gesture, str) else "--"
    sensors["gesture"].status = "ok" if sensors["gesture"].activity_seen else "needs-action"
    sensors["gesture"].note = (
        "Gesture detected."
        if sensors["gesture"].activity_seen
        else "Wave a hand above the sensor to verify gesture detection."
    )

    mic = snapshot.get("mic_peak_pct")
    mic_ok = value_is_number(mic)
    if mic_ok and float(mic) >= 2.0:
        sensors["microphone"].activity_seen = True
    sensors["microphone"].seen = mic_ok
    sensors["microphone"].value = "--" if not mic_ok else f"{mic:.1f} %"
    if not mic_ok:
        sensors["microphone"].status = "problem"
        sensors["microphone"].note = "No microphone reading."
    elif sensors["microphone"].activity_seen:
        sensors["microphone"].status = "ok"
        sensors["microphone"].note = "Sound activity detected."
    else:
        sensors["microphone"].status = "needs-action"
        sensors["microphone"].note = "Clap or tap near the board to verify the microphone."


def disconnect_serial() -> None:
    STATE.serial_stop.set()
    handle = STATE.serial_handle
    if handle is not None:
        try:
            handle.close()
        except Exception:
            pass
    STATE.serial_handle = None
    STATE.connected_port = None


def serial_reader_loop(handle: Any, port: str) -> None:
    STATE.log("info", f"Listening for sensor data on {port}.")
    while not STATE.serial_stop.is_set():
        try:
            raw_line = handle.readline()
        except Exception as exc:
            STATE.serial_error = str(exc)
            STATE.log("error", f"Serial read failed: {exc}")
            break

        if not raw_line:
            continue

        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line.startswith("{"):
            continue

        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            STATE.log("warn", f"Malformed JSON from board: {line[:120]}")
            continue

        with STATE.lock:
            STATE.last_snapshot = payload
            STATE.snapshot_count += 1
            STATE.last_data_at = now_iso()
            update_sensor_state(payload)

    disconnect_serial()


def connect_serial(port: str) -> str:
    if serial is None:
        raise RuntimeError(get_install_help()["pyserial"])

    disconnect_serial()
    STATE.serial_stop = threading.Event()
    try:
        handle = serial.Serial(port=port, baudrate=115200, timeout=1)
    except Exception as exc:
        raise RuntimeError(f"Could not open {port}: {exc}") from exc

    STATE.serial_handle = handle
    STATE.connected_port = port
    STATE.serial_error = None
    thread = threading.Thread(target=serial_reader_loop, args=(handle, port), daemon=True)
    STATE.serial_thread = thread
    thread.start()
    return f"Connected to {port}. Waiting for live JSON snapshots."


def get_summary() -> dict[str, int]:
    statuses = {"ok": 0, "needs-action": 0, "problem": 0, "waiting": 0}
    for sensor in STATE.sensor_state.values():
        statuses[sensor.status] = statuses.get(sensor.status, 0) + 1
    return statuses


def get_status_payload() -> dict[str, Any]:
    install_help = get_install_help()
    ports = list_serial_ports()
    with STATE.lock:
        STATE.ports = ports
        return {
            "app": {
                "title": "BLE Sense Test Station",
                "version": APP_VERSION,
                "boardProfile": BOARD_PROFILE,
                "python": sys.version.split()[0],
                "platform": platform.platform(),
            },
            "busy": STATE.busy,
            "currentTask": STATE.current_task,
            "requirements": {
                "arduinoCliFound": bool(find_arduino_cli()),
                "pyserialFound": serial is not None,
                "sketchFound": SKETCH_DIR.exists(),
            },
            "installHelp": install_help,
            "ports": ports,
            "connectedPort": STATE.connected_port,
            "detectedRevision": STATE.detected_revision,
            "serialConnected": STATE.connected_port is not None,
            "serialError": STATE.serial_error,
            "snapshotCount": STATE.snapshot_count,
            "lastDataAt": STATE.last_data_at,
            "lastSnapshot": STATE.last_snapshot,
            "setupResult": STATE.setup_result,
            "uploadResult": STATE.upload_result,
            "commandResult": STATE.command_result,
            "summary": get_summary(),
            "sensors": [
                {
                    **definition,
                    "status": STATE.sensor_state[definition["key"]].status,
                    "value": STATE.sensor_state[definition["key"]].value,
                    "statusNote": STATE.sensor_state[definition["key"]].note,
                }
                for definition in SENSOR_DEFINITIONS
            ],
            "logs": list(STATE.logs),
        }


class ApiHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        STATE.log("debug", format % args)

    def send_json(self, payload: dict[str, Any], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/status":
            self.send_json(get_status_payload())
            return
        if parsed.path in {"/", "/index.html"}:
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            payload = self.read_json_body()
            if parsed.path == "/api/setup":
                self.run_task("Preparing Arduino toolchain", self.handle_setup)
                self.send_json({"ok": True, "message": STATE.setup_result})
                return
            if parsed.path == "/api/install-pyserial":
                result = self.install_pyserial()
                self.send_json({"ok": True, "message": result})
                return
            if parsed.path == "/api/connect":
                port = str(payload.get("port") or "")
                if not port:
                    raise RuntimeError("Select a serial port first.")
                result = connect_serial(port)
                STATE.set_command_result(result)
                self.send_json({"ok": True, "message": result})
                return
            if parsed.path == "/api/disconnect":
                disconnect_serial()
                STATE.set_command_result("Disconnected from serial port.")
                self.send_json({"ok": True, "message": "Disconnected."})
                return
            if parsed.path == "/api/upload":
                port = str(payload.get("port") or "")
                if not port:
                    raise RuntimeError("Select a serial port first.")
                self.run_task("Compiling and uploading", lambda: self.handle_upload(port))
                self.send_json({"ok": True, "message": STATE.upload_result})
                return
            if parsed.path == "/api/run-full-test":
                port = str(payload.get("port") or "")
                if not port:
                    raise RuntimeError("Select a serial port first.")
                self.run_task("Preparing, uploading and connecting", lambda: self.handle_full_test(port))
                self.send_json({"ok": True, "message": STATE.command_result})
                return
            self.send_json({"ok": False, "error": "Unknown endpoint."}, status=HTTPStatus.NOT_FOUND)
        except Exception as exc:
            STATE.log("error", str(exc))
            self.send_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def run_task(self, task_name: str, callback: Any) -> None:
        STATE.set_busy(True, task_name)
        try:
            callback()
        finally:
            STATE.set_busy(False, "Idle")

    def handle_setup(self) -> None:
        revision = detect_board_revision(None)
        ensure_arduino_dependencies(revision)
        STATE.detected_revision = revision
        STATE.setup_result = f"Arduino core and {revision.upper()} libraries are ready."
        STATE.set_command_result(STATE.setup_result)

    def install_pyserial(self) -> str:
        STATE.set_busy(True, "Installing pyserial")
        try:
            process = subprocess.run(
                [*get_python_command(), "-m", "pip", "install", "pyserial"],
                capture_output=True,
                text=True,
                check=False,
            )
            if process.returncode != 0:
                raise RuntimeError((process.stderr or process.stdout or "pyserial installation failed.").strip())
            STATE.log("info", "pyserial installed successfully.")
            STATE.set_command_result("pyserial installed. Restart the launcher once to enable serial access.")
            return "pyserial installed. Restart the launcher once to enable serial access."
        finally:
            STATE.set_busy(False, "Idle")

    def handle_upload(self, port: str) -> None:
        revision = detect_board_revision(port)
        STATE.detected_revision = revision
        ensure_arduino_dependencies(revision)
        result = compile_and_upload(port, revision)
        STATE.upload_result = result
        STATE.set_command_result(result)

    def handle_full_test(self, port: str) -> None:
        revision = detect_board_revision(port)
        STATE.detected_revision = revision
        ensure_arduino_dependencies(revision)
        STATE.setup_result = f"Arduino core and {revision.upper()} libraries are ready."
        upload_result = compile_and_upload(port, revision)
        STATE.upload_result = upload_result
        time.sleep(2)
        refreshed_ports = list_serial_ports()
        refreshed_port = next((item["address"] for item in refreshed_ports if item["address"] == port), None) or port
        serial_result = connect_serial(refreshed_port)
        STATE.set_command_result(f"{upload_result} {serial_result}")


def main() -> None:
    STATE.log("info", "BLE Sense Test Station starting.")
    STATE.log("info", f"Serving UI from {STATIC_DIR}.")
    server = ThreadingHTTPServer((HOST, PORT), ApiHandler)
    url = f"http://{HOST}:{PORT}/"
    print(f"BLE Sense Test Station running at {url}")
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        disconnect_serial()
        server.server_close()


if __name__ == "__main__":
    main()
