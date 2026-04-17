#!/bin/sh
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1
python3 "$SCRIPT_DIR/ble_sense_test_station.py"
