import json
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
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
DATA_DIR = ROOT / "test_records"
RESULTS_JSON = DATA_DIR / "board_tests.json"
RESULTS_CSV = DATA_DIR / "board_tests.csv"
TEST_METADATA_JSON = DATA_DIR / "test_metadata.json"
KIT_TEMPLATES_JSON = DATA_DIR / "kit_templates.json"
HOST = "127.0.0.1"
PORT = 8765
APP_VERSION = "1.3"

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

ITEM_SEVERITIES = {"critical", "missing", "optional"}
ITEM_KINDS = {"component", "controller"}
DEFAULT_KIT_TEMPLATES = [
    {
        "id": "ble-sense-standard",
        "name": "BLE Sense Standard Kit",
        "description": "Default teaching kit for BLE Sense checks.",
        "items": [
            {
                "id": "ble-sense-board",
                "label": "1 Arduino Nano 33 BLE Sense with headers",
                "kind": "controller",
                "severity": "critical",
                "requires_test": True,
            },
            {"id": "breadboard", "label": "1 Breadboard", "kind": "component", "severity": "missing"},
            {"id": "connection-wires", "label": "20 Connection wires", "kind": "component", "severity": "missing"},
            {"id": "potentiometer", "label": "1 potentiometer / trimmer", "kind": "component", "severity": "missing"},
            {"id": "buttons", "label": "3 buttons / tactile switches", "kind": "component", "severity": "missing"},
            {"id": "led-ring", "label": "1 LED ring or stripe", "kind": "component", "severity": "missing"},
            {"id": "servo", "label": "1 micro servo motor", "kind": "component", "severity": "missing"},
            {"id": "usb-cable", "label": "1 micro USB cable", "kind": "component", "severity": "critical"},
            {"id": "piezo", "label": "1 piezo speaker", "kind": "component", "severity": "optional"},
            {"id": "color-leds", "label": "5 Different color LEDs", "kind": "component", "severity": "optional"},
        ],
    }
]


@dataclass
class SensorTracker:
    key: str
    status: str = "waiting"
    value: str = "--"
    note: str = "Waiting for data."
    seen: bool = False
    activity_seen: bool = False


@dataclass
class AppState:
    logs: deque[dict[str, str]] = field(default_factory=deque)
    busy: bool = False
    current_task: str = "Idle"
    ports: list[dict[str, Any]] = field(default_factory=list)
    kit_templates: list[dict[str, Any]] = field(default_factory=list)
    active_template_id: str = ""
    connected_port: str | None = None
    serial_thread: threading.Thread | None = None
    serial_stop: threading.Event = field(default_factory=threading.Event)
    serial_handle: Any = None
    serial_error: str | None = None
    last_snapshot: dict[str, Any] | None = None
    current_board_uid: str | None = None
    current_port_hwid: str | None = None
    arduino_test_requested: bool = False
    board_test_run: bool = False
    snapshot_count: int = 0
    last_data_at: str | None = None
    upload_result: str | None = None
    setup_result: str | None = None
    command_result: str | None = None
    detected_revision: str | None = None
    revision_override: str = "auto"
    current_inventory_id: str = ""
    current_inventory_name: str = ""
    current_operator: str = ""
    checklist_state: dict[str, bool] = field(default_factory=dict)
    notes: str = ""
    editing_inventory_id: str = ""
    editing_saved_board_uid: str = ""
    test_history: list[dict[str, Any]] = field(default_factory=list)
    test_metadata: dict[str, str] = field(default_factory=dict)
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


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def clamp_log_lines(logs: deque[dict[str, str]], entry: dict[str, str], limit: int = 200) -> None:
    logs.append(entry)
    while len(logs) > limit:
        logs.popleft()


def value_is_number(value: Any) -> bool:
    return isinstance(value, (int, float))


def ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def slugify(text: str, fallback: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.strip().lower()).strip("-")
    return slug or fallback


def unique_slug(base: str, existing: set[str]) -> str:
    candidate = base
    index = 2
    while candidate in existing:
        candidate = f"{base}-{index}"
        index += 1
    return candidate


def default_kit_templates() -> list[dict[str, Any]]:
    return json.loads(json.dumps(DEFAULT_KIT_TEMPLATES))


def normalize_template_item(item: Any, existing_ids: set[str], index: int) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise RuntimeError("Each template item must be an object.")
    label = str(item.get("label") or "").strip()
    if not label:
        raise RuntimeError("Each template item must have a label.")
    kind = str(item.get("kind") or "component").strip().lower()
    if kind not in ITEM_KINDS:
        raise RuntimeError(f"Invalid item kind for '{label}'.")
    severity = str(item.get("severity") or "missing").strip().lower()
    if severity not in ITEM_SEVERITIES:
        raise RuntimeError(f"Invalid severity for '{label}'.")
    fallback_id = f"item-{index + 1}"
    item_id = slugify(str(item.get("id") or label), fallback_id)
    item_id = unique_slug(item_id, existing_ids)
    existing_ids.add(item_id)
    requires_test = kind == "controller"
    return {
        "id": item_id,
        "label": label,
        "kind": kind,
        "severity": severity,
        "requires_test": requires_test,
    }


def normalize_kit_template(template: Any, existing_ids: set[str], index: int) -> dict[str, Any]:
    if not isinstance(template, dict):
        raise RuntimeError("Each kit template must be an object.")
    name = str(template.get("name") or "").strip()
    if not name:
        raise RuntimeError("Each kit template must have a name.")
    fallback_id = f"kit-template-{index + 1}"
    template_id = slugify(str(template.get("id") or name), fallback_id)
    template_id = unique_slug(template_id, existing_ids)
    existing_ids.add(template_id)
    description = str(template.get("description") or "").strip()
    raw_items = template.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise RuntimeError(f"Kit template '{name}' must include at least one item.")
    item_ids: set[str] = set()
    items = [normalize_template_item(item, item_ids, item_index) for item_index, item in enumerate(raw_items)]
    controllers = [item for item in items if item["kind"] == "controller"]
    if len(controllers) != 1:
        raise RuntimeError(f"Kit template '{name}' must contain exactly one controller item.")
    controllers[0]["requires_test"] = True
    return {
        "id": template_id,
        "name": name,
        "description": description,
        "items": items,
    }


def normalize_kit_templates(payload: Any) -> list[dict[str, Any]]:
    raw_templates = payload.get("templates") if isinstance(payload, dict) else payload
    if not isinstance(raw_templates, list) or not raw_templates:
        raise RuntimeError("At least one kit template is required.")
    existing_ids: set[str] = set()
    return [normalize_kit_template(template, existing_ids, index) for index, template in enumerate(raw_templates)]


def persist_kit_templates(templates: list[dict[str, Any]]) -> None:
    ensure_data_dir()
    KIT_TEMPLATES_JSON.write_text(json.dumps({"templates": templates}, indent=2), encoding="utf-8")


def load_kit_templates() -> list[dict[str, Any]]:
    ensure_data_dir()
    if not KIT_TEMPLATES_JSON.exists():
        templates = default_kit_templates()
        persist_kit_templates(templates)
        return templates
    try:
        payload = json.loads(KIT_TEMPLATES_JSON.read_text(encoding="utf-8"))
        templates = normalize_kit_templates(payload)
        persist_kit_templates(templates)
        return templates
    except Exception:
        templates = default_kit_templates()
        persist_kit_templates(templates)
        return templates


def get_template_by_id(template_id: str) -> dict[str, Any] | None:
    normalized = template_id.strip()
    return next((template for template in STATE.kit_templates if template["id"] == normalized), None)


def get_active_template() -> dict[str, Any]:
    if STATE.active_template_id:
        match = get_template_by_id(STATE.active_template_id)
        if match:
            return match
    if not STATE.kit_templates:
        STATE.kit_templates = default_kit_templates()
    template = STATE.kit_templates[0]
    STATE.active_template_id = template["id"]
    return template


def get_controller_item(template: dict[str, Any] | None = None) -> dict[str, Any]:
    active_template = template or get_active_template()
    controller = next((item for item in active_template["items"] if item["kind"] == "controller"), None)
    if not controller:
        raise RuntimeError(f"Kit template '{active_template['name']}' is missing its controller item.")
    return controller


def get_controller_item_id(template: dict[str, Any] | None = None) -> str:
    return str(get_controller_item(template)["id"])


def build_checklist_state(template: dict[str, Any], existing: dict[str, bool] | None = None) -> dict[str, bool]:
    previous = existing or {}
    return {str(item["id"]): bool(previous.get(str(item["id"]), False)) for item in template["items"]}


def set_active_template(template_id: str) -> dict[str, Any]:
    template = get_template_by_id(template_id)
    if not template:
        raise RuntimeError("Choose a valid kit set.")
    STATE.active_template_id = template["id"]
    STATE.checklist_state = build_checklist_state(template, STATE.checklist_state)
    return template


def save_template(payload: dict[str, Any]) -> dict[str, Any]:
    raw_template = payload.get("template")
    templates = list(STATE.kit_templates)
    target_id = str(payload.get("templateId") or (raw_template.get("id") if isinstance(raw_template, dict) else "") or "").strip()
    if target_id:
        templates = [template for template in templates if template["id"] != target_id]
    normalized = normalize_kit_template(raw_template, {template["id"] for template in templates}, len(templates))
    if target_id:
        normalized["id"] = target_id
    templates.append(normalized)
    templates.sort(key=lambda item: item["name"].lower())
    STATE.kit_templates = normalize_kit_templates({"templates": templates})
    persist_kit_templates(STATE.kit_templates)
    set_active_template(normalized["id"])
    STATE.set_command_result(f"Saved kit set '{normalized['name']}'.")
    return normalized


def delete_template(template_id: str) -> None:
    normalized = template_id.strip()
    if len(STATE.kit_templates) <= 1:
        raise RuntimeError("Keep at least one kit set.")
    existing = get_template_by_id(normalized)
    if not existing:
        raise RuntimeError("Choose a valid kit set to delete.")
    STATE.kit_templates = [template for template in STATE.kit_templates if template["id"] != normalized]
    persist_kit_templates(STATE.kit_templates)
    set_active_template(STATE.kit_templates[0]["id"])
    STATE.set_command_result(f"Deleted kit set '{existing['name']}'.")


def load_test_history() -> list[dict[str, Any]]:
    ensure_data_dir()
    if not RESULTS_JSON.exists():
        return []
    try:
        payload = json.loads(RESULTS_JSON.read_text(encoding="utf-8"))
        return payload if isinstance(payload, list) else []
    except Exception:
        return []


def empty_test_metadata() -> dict[str, str]:
    return {
        "test_name": "",
        "test_responsible": "",
        "notes": "",
        "saved_at": "",
        "updated_at": "",
    }


def normalize_test_metadata(payload: Any) -> dict[str, str]:
    metadata = empty_test_metadata()
    if isinstance(payload, dict):
        metadata.update(
            {
                "test_name": str(payload.get("test_name") or payload.get("testName") or "").strip(),
                "test_responsible": str(
                    payload.get("test_responsible") or payload.get("testResponsible") or ""
                ).strip(),
                "notes": str(payload.get("notes") or "").strip(),
                "saved_at": str(payload.get("saved_at") or payload.get("savedAt") or "").strip(),
                "updated_at": str(payload.get("updated_at") or payload.get("updatedAt") or "").strip(),
            }
        )
    return metadata


def load_test_metadata() -> dict[str, str]:
    ensure_data_dir()
    if not TEST_METADATA_JSON.exists():
        return empty_test_metadata()
    try:
        return normalize_test_metadata(json.loads(TEST_METADATA_JSON.read_text(encoding="utf-8")))
    except Exception:
        return empty_test_metadata()


def metadata_is_saved() -> bool:
    return bool(STATE.test_metadata.get("test_name") and STATE.test_metadata.get("test_responsible"))


def save_test_metadata(payload: dict[str, Any]) -> dict[str, str]:
    test_name = str(payload.get("testName") or payload.get("test_name") or "").strip()
    responsible = str(payload.get("testResponsible") or payload.get("test_responsible") or "").strip()
    notes = str(payload.get("notes") or "").strip()
    if not test_name:
        raise RuntimeError("Enter a test name before saving test metadata.")
    if not responsible:
        raise RuntimeError("Enter the test responsible before saving test metadata.")

    now = now_iso()
    existing_saved_at = str(STATE.test_metadata.get("saved_at") or "").strip()
    metadata = {
        "test_name": test_name,
        "test_responsible": responsible,
        "notes": notes,
        "saved_at": existing_saved_at or now,
        "updated_at": now if existing_saved_at else "",
    }
    ensure_data_dir()
    try:
        TEST_METADATA_JSON.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(f"Could not write test metadata in {TEST_METADATA_JSON}: {exc}") from exc
    STATE.test_metadata = metadata
    STATE.log("info", f"Saved test metadata in {TEST_METADATA_JSON}.")
    STATE.set_command_result("Test metadata saved.")
    return metadata


def write_csv(rows: list[dict[str, Any]]) -> None:
    ensure_data_dir()
    headers = [
        "tested_at",
        "inventory_id",
        "inventory_name",
        "kit_template_name",
        "board_uid",
        "operator",
        "port",
        "revision",
        "result",
        "ok_count",
        "needs_action_count",
        "problem_count",
        "waiting_count",
        "missing_critical_items",
        "missing_standard_items",
        "missing_optional_items",
        "notes",
    ]
    lines = [",".join(headers)]
    for row in rows:
        values = []
        for header in headers:
            value = row.get(header, "")
            if isinstance(value, list):
                value = " | ".join(str(item) for item in value)
            text = str(value).replace('"', '""')
            values.append(f'"{text}"')
        lines.append(",".join(values))
    RESULTS_CSV.write_text("\n".join(lines) + "\n", encoding="utf-8")


def persist_history() -> None:
    ensure_data_dir()
    try:
        RESULTS_JSON.write_text(json.dumps(STATE.test_history, indent=2), encoding="utf-8")
        write_csv(STATE.test_history)
    except OSError as exc:
        raise RuntimeError(f"Could not write result files in {DATA_DIR}: {exc}") from exc


def reset_sensor_trackers() -> None:
    for definition in SENSOR_DEFINITIONS:
        STATE.sensor_state[definition["key"]] = SensorTracker(definition["key"])
    STATE.last_snapshot = None
    STATE.current_board_uid = None
    STATE.current_port_hwid = None
    STATE.arduino_test_requested = False
    STATE.board_test_run = False
    STATE.snapshot_count = 0
    STATE.last_data_at = None
    STATE.serial_error = None


def reset_current_kit() -> None:
    reset_sensor_trackers()
    STATE.current_inventory_id = ""
    STATE.current_inventory_name = ""
    STATE.current_operator = ""
    STATE.notes = ""
    STATE.editing_inventory_id = ""
    STATE.editing_saved_board_uid = ""
    STATE.checklist_state = build_checklist_state(get_active_template())


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


def read_command_json(command: list[str], cwd: Path | None = None) -> Any:
    completed = subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)
    stdout = (completed.stdout or "").strip()
    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip()
        raise RuntimeError(stderr or stdout or f"Command failed: {' '.join(command)}")
    if not stdout:
        return {}
    return json.loads(stdout)


def normalize_port_entry(item: dict[str, Any]) -> dict[str, Any]:
    port = item.get("port") if isinstance(item.get("port"), dict) else {}
    matching = item.get("matching_board") if isinstance(item.get("matching_board"), dict) else {}
    return {
        "address": port.get("address"),
        "label": f"{port.get('address')} - {port.get('label') or port.get('protocol_label') or 'Serial port'}",
        "protocol": port.get("protocol"),
        "board_name": matching.get("name"),
        "fqbn": matching.get("fqbn"),
        "description": port.get("label") or port.get("protocol_label"),
        "manufacturer": port.get("properties", {}).get("manufacturer") if isinstance(port.get("properties"), dict) else None,
        "hwid": port.get("properties", {}).get("pid") if isinstance(port.get("properties"), dict) else None,
    }


def find_arduino_cli() -> str | None:
    direct = shutil.which("arduino-cli")
    if direct:
        return direct

    candidates = [
        Path(r"C:\Program Files\Arduino CLI\arduino-cli.exe"),
        Path(r"C:\Users\k3lar\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


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
        except Exception as exc:
            STATE.log("warn", f"Board detection via arduino-cli failed: {exc}")

    result.sort(key=lambda item: item["address"] or "")
    return result


def get_port_hwid(port: str | None) -> str:
    if not port:
        return ""
    match = next((item for item in list_serial_ports() if item.get("address") == port), None)
    return str(match.get("hwid") or "").strip() if match else ""


def get_current_board_hardware_id() -> str:
    snapshot_uid = ""
    if isinstance(STATE.last_snapshot, dict):
        snapshot_uid = str(STATE.last_snapshot.get("board_uid") or "").strip()
    return str(STATE.current_board_uid or snapshot_uid or STATE.current_port_hwid or "").strip()


def board_test_has_run() -> bool:
    return STATE.board_test_run or STATE.snapshot_count > 0 or bool(get_current_board_hardware_id())


def arduino_test_is_selected() -> bool:
    return STATE.arduino_test_requested or board_test_has_run()


def request_arduino_test() -> None:
    controller_item_id = get_controller_item_id()
    STATE.arduino_test_requested = True
    STATE.checklist_state[controller_item_id] = True


def reset_arduino_test_flag() -> None:
    disconnect_serial()
    reset_sensor_trackers()
    STATE.checklist_state[get_controller_item_id()] = False
    STATE.set_command_result("Arduino test flag cleared. You can run the Arduino test again.")
    STATE.log("info", "Arduino test flag cleared for the current kit.")


def saved_board_test_available_for_edit() -> bool:
    return bool(STATE.editing_inventory_id and STATE.editing_saved_board_uid)


def get_arduino_checklist_detail(board_hardware_id: str) -> str:
    if board_test_has_run():
        return f"Hardware ID: {board_hardware_id}" if board_hardware_id else "Arduino test completed for this kit."
    if STATE.arduino_test_requested:
        return "Attach the board that belongs to this kit, then press Run test and save results or Test Arduino."
    if saved_board_test_available_for_edit():
        if STATE.editing_saved_board_uid:
            return f"Saved board test on file. Check to retest. Last hardware ID: {STATE.editing_saved_board_uid}"
        return "Saved board test on file. Check to retest with the board that belongs to this kit."
    return ""


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


def get_effective_revision(port: str | None) -> str:
    override = str(STATE.revision_override or "auto").strip().lower()
    if override in {"rev1", "rev2"}:
        return override
    return detect_board_revision(port)


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
        STATE.log("info", "Using PDM from the board core, no separate PDM library install is required.")
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
    compile_process = subprocess.run(compile_command, capture_output=True, text=True, check=False)
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
    sensors["gesture"].note = "Gesture detected." if sensors["gesture"].activity_seen else "Wave a hand above the sensor to verify gesture detection."

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
            board_uid = str(payload.get("board_uid") or "").strip()
            if board_uid:
                STATE.current_board_uid = board_uid
            STATE.checklist_state[get_controller_item_id()] = True
            update_sensor_state(payload)

    disconnect_serial()


def connect_serial(port: str) -> str:
    if serial is None:
        raise RuntimeError(get_install_help()["pyserial"])

    disconnect_serial()
    reset_sensor_trackers()
    STATE.serial_stop = threading.Event()
    try:
        handle = serial.Serial(port=port, baudrate=115200, timeout=1)
    except Exception as exc:
        raise RuntimeError(f"Could not open {port}: {exc}") from exc

    STATE.serial_handle = handle
    STATE.connected_port = port
    STATE.current_port_hwid = get_port_hwid(port)
    STATE.board_test_run = True
    STATE.checklist_state[get_controller_item_id()] = True
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


def classify_result(
    summary: dict[str, int],
    checklist_state: dict[str, bool],
    template: dict[str, Any],
    controller_checked: bool,
    controller_tested: bool,
) -> str:
    items = {str(item["id"]): item for item in template["items"]}
    missing_critical = [
        item["label"]
        for item_id, item in items.items()
        if item["severity"] == "critical" and not checklist_state.get(item_id, False)
    ]
    missing_standard = [
        item["label"]
        for item_id, item in items.items()
        if item["severity"] == "missing" and not checklist_state.get(item_id, False)
    ]
    if missing_critical:
        return "FAIL"
    if controller_checked and not controller_tested:
        return "FAIL"
    if summary.get("problem", 0) > 0:
        return "FAIL"
    if missing_standard:
        return "KIT-INCOMPLETE"
    if summary.get("needs-action", 0) > 0:
        return "ATTENTION"
    return "PASS"


def get_used_kit_numbers(excluding: str = "") -> set[str]:
    excluded = excluding.strip()
    return {
        str(row.get("inventory_id") or "").strip()
        for row in STATE.test_history
        if str(row.get("inventory_id") or "").strip() and str(row.get("inventory_id") or "").strip() != excluded
    }


def find_record_by_hardware_id(hardware_id: str, excluding_inventory_id: str = "") -> dict[str, Any] | None:
    normalized = hardware_id.strip().lower()
    excluded = excluding_inventory_id.strip()
    if not normalized:
        return None
    return next(
        (
            row
            for row in STATE.test_history
            if str(row.get("board_uid") or "").strip().lower() == normalized
            and str(row.get("inventory_id") or "").strip() != excluded
        ),
        None,
    )


def load_test_for_update(inventory_id: str) -> dict[str, Any]:
    kit_number = inventory_id.strip()
    if not kit_number:
        raise RuntimeError("Choose a kit to update.")
    record = next((row for row in STATE.test_history if str(row.get("inventory_id") or "").strip() == kit_number), None)
    if not record:
        raise RuntimeError(f"Kit number {kit_number} was not found in the saved results.")

    disconnect_serial()
    reset_sensor_trackers()
    STATE.current_inventory_id = str(record.get("inventory_id") or "").strip()
    STATE.current_inventory_name = str(record.get("inventory_name") or "").strip()
    STATE.current_operator = str(record.get("operator") or "").strip()
    STATE.notes = str(record.get("notes") or "").strip()
    template_id = str(record.get("kit_template_id") or "").strip()
    if template_id:
        set_active_template(template_id)
    STATE.detected_revision = str(record.get("revision") or "").strip() or None
    STATE.last_snapshot = record.get("last_snapshot")
    STATE.editing_saved_board_uid = str(record.get("board_uid") or "").strip()
    checklist = record.get("checklist") or {}
    STATE.checklist_state = build_checklist_state(get_active_template())
    if isinstance(checklist, dict):
        for item in get_active_template()["items"]:
            item_id = str(item["id"])
            STATE.checklist_state[item_id] = bool(checklist.get(item_id, False))
    STATE.current_board_uid = None
    STATE.arduino_test_requested = False
    STATE.board_test_run = False
    STATE.checklist_state[get_controller_item_id()] = False

    sensors = record.get("sensors") or {}
    if isinstance(sensors, dict):
        for key, sensor in sensors.items():
            if key in STATE.sensor_state and isinstance(sensor, dict):
                STATE.sensor_state[key].status = str(sensor.get("status") or "waiting")
                STATE.sensor_state[key].value = str(sensor.get("value") or "--")
                STATE.sensor_state[key].note = str(sensor.get("note") or "Waiting for data.")

    STATE.editing_inventory_id = kit_number
    STATE.set_command_result(f"Updating saved result for kit {kit_number}. Make changes, then save the result again.")
    STATE.log("info", f"Loaded saved result for kit {kit_number} for updating.")
    return record


def record_current_test() -> dict[str, Any]:
    if not STATE.test_history and not metadata_is_saved():
        raise RuntimeError("Save test metadata before recording the first kit result.")
    active_template = get_active_template()
    controller_item = get_controller_item(active_template)
    controller_item_id = str(controller_item["id"])
    kit_number = STATE.current_inventory_id.strip()
    if not kit_number:
        raise RuntimeError("Enter a kit number before saving.")
    if not kit_number.isdigit() or len(kit_number) > 4:
        raise RuntimeError("Kit number must be 1 to 4 digits.")
    editing_kit = STATE.editing_inventory_id.strip()
    if kit_number in get_used_kit_numbers(excluding=editing_kit):
        raise RuntimeError(f"Kit number {kit_number} has already been saved in this batch.")
    effective_checklist = build_checklist_state(active_template, STATE.checklist_state)
    if arduino_test_is_selected() or saved_board_test_available_for_edit():
        effective_checklist[controller_item_id] = True
    controller_checked = bool(effective_checklist.get(controller_item_id, False))
    controller_tested = board_test_has_run() or saved_board_test_available_for_edit()
    if controller_checked and not controller_tested:
        raise RuntimeError("The BLE Sense board is marked present but has not been tested yet.")
    summary = get_summary()
    template_items = {str(item["id"]): item for item in active_template["items"]}
    missing_critical_items = [
        item["label"]
        for item_id, item in template_items.items()
        if item["severity"] == "critical" and not effective_checklist.get(item_id, False)
    ]
    missing_standard_items = [
        item["label"]
        for item_id, item in template_items.items()
        if item["severity"] == "missing" and not effective_checklist.get(item_id, False)
    ]
    missing_optional_items = [
        item["label"]
        for item_id, item in template_items.items()
        if item["severity"] == "optional" and not effective_checklist.get(item_id, False)
    ]
    board_hardware_id = get_current_board_hardware_id() or STATE.editing_saved_board_uid
    duplicate_hardware_record = find_record_by_hardware_id(board_hardware_id, excluding_inventory_id=editing_kit)
    if duplicate_hardware_record:
        duplicate_kit = str(duplicate_hardware_record.get("inventory_id") or "another kit").strip()
        raise RuntimeError(f"Hardware ID {board_hardware_id} has already been saved for kit {duplicate_kit}.")
    record = {
        "tested_at": now_iso(),
        "inventory_id": kit_number,
        "inventory_name": STATE.current_inventory_name.strip(),
        "kit_template_id": active_template["id"],
        "kit_template_name": active_template["name"],
        "board_uid": board_hardware_id,
        "operator": STATE.current_operator.strip(),
        "port": STATE.connected_port or "",
        "revision": STATE.detected_revision or "",
        "result": classify_result(summary, effective_checklist, active_template, controller_checked, controller_tested),
        "ok_count": summary.get("ok", 0),
        "needs_action_count": summary.get("needs-action", 0),
        "problem_count": summary.get("problem", 0),
        "waiting_count": summary.get("waiting", 0),
        "missing_critical_items": missing_critical_items,
        "missing_standard_items": missing_standard_items,
        "missing_optional_items": missing_optional_items,
        "notes": STATE.notes.strip(),
        "summary": summary,
        "checklist": effective_checklist,
        "items": active_template["items"],
        "last_snapshot": STATE.last_snapshot,
        "sensors": {
            definition["key"]: {
                "status": STATE.sensor_state[definition["key"]].status,
                "value": STATE.sensor_state[definition["key"]].value,
                "note": STATE.sensor_state[definition["key"]].note,
            }
            for definition in SENSOR_DEFINITIONS
        },
    }
    if editing_kit:
        existing_index = next(
            (index for index, row in enumerate(STATE.test_history) if str(row.get("inventory_id") or "").strip() == editing_kit),
            None,
        )
        if existing_index is None:
            raise RuntimeError(f"Kit number {editing_kit} was not found in the saved results.")
        STATE.test_history.pop(existing_index)
        STATE.test_history.append(record)
        STATE.editing_inventory_id = ""
        STATE.editing_saved_board_uid = ""
    else:
        STATE.test_history.append(record)
    persist_history()
    kit_label = record["inventory_id"] or record["inventory_name"] or "unnamed kit"
    action = "Updated" if editing_kit else "Saved"
    STATE.log(
        "info",
        f"{action} result for {kit_label} in {RESULTS_JSON} and {RESULTS_CSV}.",
    )
    return record


def delete_saved_result(inventory_id: str) -> dict[str, Any]:
    kit_number = inventory_id.strip()
    if not kit_number:
        raise RuntimeError("Choose a saved result to delete.")
    existing_index = next(
        (index for index, row in enumerate(STATE.test_history) if str(row.get("inventory_id") or "").strip() == kit_number),
        None,
    )
    if existing_index is None:
        raise RuntimeError(f"Kit number {kit_number} was not found in the saved results.")
    record = STATE.test_history.pop(existing_index)
    persist_history()
    if STATE.editing_inventory_id.strip() == kit_number:
        disconnect_serial()
        reset_current_kit()
    STATE.set_command_result(f"Deleted saved result for kit {kit_number}.")
    STATE.log("info", f"Deleted saved result for kit {kit_number} from {RESULTS_JSON} and {RESULTS_CSV}.")
    return record


def get_history_summary() -> dict[str, int]:
    summary = {"total": len(STATE.test_history), "PASS": 0, "ATTENTION": 0, "FAIL": 0, "KIT-INCOMPLETE": 0}
    for row in STATE.test_history:
        result = str(row.get("result") or "")
        if result in summary:
            summary[result] += 1
    return summary


def get_results_summary_payload() -> dict[str, Any]:
    with STATE.lock:
        return {
            "app": {
                "title": "BLE Sense Test Station",
                "version": APP_VERSION,
                "root": str(ROOT),
            },
            "generatedAt": now_iso(),
            "testMetadata": STATE.test_metadata,
            "historySummary": get_history_summary(),
            "historyFiles": {
                "json": str(RESULTS_JSON),
                "csv": str(RESULTS_CSV),
                "metadata": str(TEST_METADATA_JSON),
                "kitTemplates": str(KIT_TEMPLATES_JSON),
            },
            "records": list(STATE.test_history),
        }


def get_status_payload() -> dict[str, Any]:
    install_help = get_install_help()
    ports = list_serial_ports()
    with STATE.lock:
        STATE.ports = ports
        active_template = get_active_template()
        controller_item = get_controller_item(active_template)
        controller_item_id = str(controller_item["id"])
        if arduino_test_is_selected():
            STATE.checklist_state[controller_item_id] = True
        board_hardware_id = get_current_board_hardware_id()
        return {
            "app": {
                "title": "BLE Sense Test Station",
                "version": APP_VERSION,
                "root": str(ROOT),
                "staticDir": str(STATIC_DIR),
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
            "revisionOverride": STATE.revision_override,
            "serialConnected": STATE.connected_port is not None,
            "serialError": STATE.serial_error,
            "snapshotCount": STATE.snapshot_count,
            "lastDataAt": STATE.last_data_at,
            "lastSnapshot": STATE.last_snapshot,
            "boardHardwareId": board_hardware_id,
            "setupResult": STATE.setup_result,
            "uploadResult": STATE.upload_result,
            "commandResult": STATE.command_result,
            "summary": get_summary(),
            "historySummary": get_history_summary(),
            "historyCount": len(STATE.test_history),
            "usedKitNumbers": sorted(get_used_kit_numbers(), key=lambda value: (0, int(value)) if value.isdigit() else (1, value)),
            "editingInventoryId": STATE.editing_inventory_id,
            "activeKitTemplateId": active_template["id"],
            "kitTemplates": STATE.kit_templates,
            "historyFiles": {
                "json": str(RESULTS_JSON),
                "csv": str(RESULTS_CSV),
                "metadata": str(TEST_METADATA_JSON),
                "kitTemplates": str(KIT_TEMPLATES_JSON),
            },
            "testMetadata": {
                **STATE.test_metadata,
                "isSaved": metadata_is_saved(),
                "required": not STATE.test_history and not metadata_is_saved(),
            },
            "inventory": {
                "inventoryId": STATE.current_inventory_id,
                "inventoryName": STATE.current_inventory_name,
                "operator": STATE.current_operator,
                "notes": STATE.notes,
                "kitTemplateId": active_template["id"],
                "checklist": [
                    {
                        **item,
                        "present": STATE.checklist_state.get(str(item["id"]), False),
                        "detail": get_arduino_checklist_detail(board_hardware_id) if item["id"] == controller_item_id else "",
                        "autoPresent": item["id"] == controller_item_id and arduino_test_is_selected(),
                        "testCompleted": item["id"] == controller_item_id and board_test_has_run(),
                        "key": "arduino" if item["id"] == controller_item_id else "",
                    }
                    for item in active_template["items"]
                ],
            },
            "sensors": [
                {
                    **definition,
                    "status": STATE.sensor_state[definition["key"]].status,
                    "value": STATE.sensor_state[definition["key"]].value,
                    "statusNote": STATE.sensor_state[definition["key"]].note,
                }
                for definition in SENSOR_DEFINITIONS
            ],
            "recentTests": STATE.test_history[-10:],
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

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

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
        if parsed.path == "/api/results-summary":
            self.send_json(get_results_summary_payload())
            return
        if parsed.path == "/api/check-kit-number":
            query = urlparse(self.path).query
            kit_number = ""
            for part in query.split("&"):
                key, _, value = part.partition("=")
                if key == "kit":
                    kit_number = value.strip()
                    break
            if kit_number and (not kit_number.isdigit() or len(kit_number) > 4):
                self.send_json({"ok": False, "error": "Kit number must be 1 to 4 digits."}, status=HTTPStatus.BAD_REQUEST)
                return
            self.send_json({"ok": True, "exists": kit_number in get_used_kit_numbers()})
            return
        if parsed.path in {"/", "/index.html"}:
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            payload = self.read_json_body()
            if parsed.path == "/api/setup":
                self.apply_revision_override(payload)
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
                self.apply_revision_override(payload)
                self.run_task("Compiling and uploading", lambda: self.handle_upload(port))
                self.send_json({"ok": True, "message": STATE.upload_result})
                return
            if parsed.path == "/api/run-full-test":
                port = str(payload.get("port") or "")
                if not port:
                    raise RuntimeError("Select a serial port first.")
                request_arduino_test()
                self.apply_revision_override(payload)
                self.run_task("Preparing, uploading and connecting", lambda: self.handle_full_test(port))
                self.send_json({"ok": True, "message": STATE.command_result})
                return
            if parsed.path == "/api/request-arduino-test":
                request_arduino_test()
                self.send_json({"ok": True, "message": "Arduino test selected for this kit."})
                return
            if parsed.path == "/api/set-session":
                self.handle_set_session(payload)
                self.send_json({"ok": True, "message": "Session details saved."})
                return
            if parsed.path == "/api/templates/select":
                template_id = str(payload.get("templateId") or "").strip()
                template = set_active_template(template_id)
                reset_current_kit()
                STATE.set_command_result(f"Selected kit set '{template['name']}'.")
                self.send_json({"ok": True, "message": STATE.command_result, "template": template})
                return
            if parsed.path == "/api/templates/save":
                template = save_template(payload)
                reset_current_kit()
                self.send_json({"ok": True, "message": STATE.command_result, "template": template})
                return
            if parsed.path == "/api/templates/delete":
                template_id = str(payload.get("templateId") or "").strip()
                delete_template(template_id)
                reset_current_kit()
                self.send_json({"ok": True, "message": STATE.command_result})
                return
            if parsed.path == "/api/set-test-metadata":
                metadata = save_test_metadata(payload)
                self.send_json({"ok": True, "message": STATE.command_result, "metadata": metadata})
                return
            if parsed.path == "/api/record-result":
                record = record_current_test()
                kit_label = record["inventory_id"] or record["inventory_name"] or "unnamed kit"
                action = "Updated" if payload.get("update") else "Saved"
                disconnect_serial()
                reset_current_kit()
                STATE.set_command_result(
                    f"{action} {kit_label} as {record['result']} in {RESULTS_JSON.name} and {RESULTS_CSV.name}. Ready for the next kit."
                )
                self.send_json({"ok": True, "message": STATE.command_result, "record": record})
                return
            if parsed.path == "/api/edit-result":
                inventory_id = str(payload.get("inventoryId") or "").strip()
                record = load_test_for_update(inventory_id)
                self.send_json({"ok": True, "message": STATE.command_result, "record": record})
                return
            if parsed.path == "/api/delete-result":
                inventory_id = str(payload.get("inventoryId") or "").strip()
                record = delete_saved_result(inventory_id)
                self.send_json({"ok": True, "message": STATE.command_result, "record": record})
                return
            if parsed.path == "/api/reset-for-next":
                disconnect_serial()
                reset_current_kit()
                STATE.set_command_result("Current kit data cleared.")
                self.send_json({"ok": True, "message": STATE.command_result})
                return
            if parsed.path == "/api/reset-arduino-test":
                reset_arduino_test_flag()
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

    def apply_revision_override(self, payload: dict[str, Any]) -> None:
        if "revisionOverride" not in payload:
            return
        revision_override = str(payload.get("revisionOverride") or "auto").strip().lower()
        if revision_override not in {"auto", "rev1", "rev2"}:
            raise RuntimeError("Revision override must be Auto, Rev1 or Rev2.")
        STATE.revision_override = revision_override

    def handle_setup(self) -> None:
        revision = get_effective_revision(None)
        ensure_arduino_dependencies(revision)
        STATE.detected_revision = revision
        STATE.setup_result = f"Arduino core and {revision.upper()} libraries are ready."
        STATE.set_command_result(STATE.setup_result)

    def handle_set_session(self, payload: dict[str, Any]) -> None:
        template_id = str(payload.get("kitTemplateId") or STATE.active_template_id or "").strip()
        if template_id:
            set_active_template(template_id)
        active_template = get_active_template()
        controller_item_id = get_controller_item_id(active_template)
        kit_number = str(payload.get("inventoryId") or "").strip()
        if kit_number and (not kit_number.isdigit() or len(kit_number) > 4):
            raise RuntimeError("Kit number must be 1 to 4 digits.")
        STATE.current_inventory_id = kit_number
        STATE.current_inventory_name = str(payload.get("inventoryName") or "").strip()
        STATE.current_operator = str(payload.get("operator") or "").strip()
        STATE.notes = str(payload.get("notes") or "").strip()
        revision_override = str(payload.get("revisionOverride") or "auto").strip().lower()
        if revision_override not in {"auto", "rev1", "rev2"}:
            raise RuntimeError("Revision override must be Auto, Rev1 or Rev2.")
        STATE.revision_override = revision_override
        checklist = payload.get("checklist") or {}
        STATE.checklist_state = build_checklist_state(active_template, STATE.checklist_state)
        if isinstance(checklist, dict):
            for item in active_template["items"]:
                item_id = str(item["id"])
                if item_id == controller_item_id and not arduino_test_is_selected():
                    STATE.checklist_state[item_id] = False
                    continue
                STATE.checklist_state[item_id] = bool(checklist.get(item_id, False))
        if arduino_test_is_selected():
            STATE.checklist_state[controller_item_id] = True

    def install_pyserial(self) -> str:
        STATE.set_busy(True, "Installing pyserial")
        try:
            process = subprocess.run([*get_python_command(), "-m", "pip", "install", "pyserial"], capture_output=True, text=True, check=False)
            if process.returncode != 0:
                raise RuntimeError((process.stderr or process.stdout or "pyserial installation failed.").strip())
            STATE.log("info", "pyserial installed successfully.")
            STATE.set_command_result("pyserial installed. Restart the launcher once to enable serial access.")
            return "pyserial installed. Restart the launcher once to enable serial access."
        finally:
            STATE.set_busy(False, "Idle")

    def handle_upload(self, port: str) -> None:
        revision = get_effective_revision(port)
        STATE.detected_revision = revision
        disconnect_serial()
        ensure_arduino_dependencies(revision)
        result = compile_and_upload(port, revision)
        STATE.upload_result = result
        STATE.set_command_result(result)

    def handle_full_test(self, port: str) -> None:
        revision = get_effective_revision(port)
        STATE.detected_revision = revision
        disconnect_serial()
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
    ensure_data_dir()
    STATE.kit_templates = load_kit_templates()
    STATE.active_template_id = STATE.kit_templates[0]["id"]
    STATE.checklist_state = build_checklist_state(get_active_template())
    STATE.test_history = load_test_history()
    STATE.test_metadata = load_test_metadata()
    STATE.log("info", "BLE Sense Test Station starting.")
    STATE.log("info", f"Serving UI from {STATIC_DIR}.")
    server = ThreadingHTTPServer((HOST, PORT), ApiHandler)
    url = f"http://{HOST}:{PORT}/"
    print(f"BLE Sense Test Station running at {url}")
    print(f"Project root: {ROOT}")
    print(f"Static UI: {STATIC_DIR}")
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
