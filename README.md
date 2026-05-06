# BLE Sense Test Station

Version: `1.3`

This repository is now arranged so a teaching assistant can start one local tool instead of juggling Arduino IDE, Arduino CLI and a browser serial session.

## Intended flow

1. Clone the repository to the machine you want to use in the lab, or download the ZIP from GitHub's `Code` dropdown and extract it.
2. Start the launcher:
   - Windows: `LaunchSensorTableMonitor.cmd`
   - macOS: `LaunchSensorTableMonitor.command`
   - Any platform with Python: `python ble_sense_test_station.py`
3. If this is a new batch and no kit records exist yet, fill in the test metadata:
   - test name
   - test responsible
   - test notes
4. Choose the active kit set, or edit the kit set if the lab setup has changed.
5. Fill in the kit details:
   - kit number
   - kit name
   - operator
   - kit notes
6. Tick the kit checklist items that are present.
7. Plug in an Arduino Nano 33 BLE Sense and choose the detected serial port.
8. Tick the BLE Sense checklist row if that board belongs to the kit and should be tested.
9. Click `Run Test`.
10. When the board has streamed sensor data, click `Save Results`.

The local runner will:

- check whether `arduino-cli` is installed
- check whether Python can access serial ports through `pyserial`
- detect whether the connected board looks like Nano 33 BLE Sense Rev1 or Rev2
- check whether the needed Arduino core and matching sensor libraries are already installed
- only install missing Arduino dependencies when required
- use the `PDM` support that comes with the Nano 33 BLE core instead of trying to install it as a separate library
- compile and upload `sense_table_stream`
- close any existing serial connection before re-uploading, so changing Rev1/Rev2 can be retried without unplugging the board
- reconnect to the board and read live JSON sensor data
- automatically check the Arduino checklist row once the Arduino test has run
- save the board hardware ID when the board or serial port exposes one
- prevent the same saved hardware ID from being used by another kit in the same batch
- show which sensors are verified, which need interaction, and which appear broken
- save the kit result to local JSON and CSV reports

You can also click `Test Board` to run only the Arduino upload/connect test without saving the kit result.

The `Reset` button clears the current kit details, checklist, live sensor state and edit state. It does not delete previously saved result files.

## Kit sets

Kit sets are editable checklist templates stored in `test_records/kit_templates.json`.

Each kit set contains:

- exactly one BLE Sense controller item, which always requires a hardware test before the kit can pass
- any number of normal component items
- a severity for each item:
  - `critical`: if missing, the result becomes `FAIL`
  - `missing`: if missing, the result becomes `KIT-INCOMPLETE`
  - `optional`: recorded as missing, but does not lower the result

You can create, duplicate, edit and delete kit sets in the UI. The active kit set applies to the current batch entry and controls which checklist items are shown.

## Test metadata and reports

Saved test data is stored in `test_records/` on the local machine:

- `test_metadata.json`: batch-level test name, responsible person, notes and saved date
- `kit_templates.json`: editable kit set definitions
- `board_tests.json`: full saved kit records
- `board_tests.csv`: spreadsheet-friendly saved kit summary

The metadata form is shown when no kit records exist and metadata has not been saved yet. Once saved, the metadata is visible in the UI and can be edited with `Edit Test Metadata`.

Test records and metadata are machine-local and are not included in the repo by default.

Saved kit results now include:

- the kit set used for the test
- grouped missing items by severity
- the BLE Sense board hardware ID when available
- sensor summary and detailed sensor readings

The `Saved Results` section shows the latest saved boards in the main test page. Use `Summarise Results` to open a separate summary page while testing continues. The summary page lists all saved boards, totals the missing kit items across the batch, and includes a `Print / Save PDF` button for a cleaner printed or PDF report.

## What the status colors mean

- `Verified`: the sensor is returning data or a positive activity event was detected
- `Needs action`: the sensor likely works, but the TA still needs to interact with it, such as waving over the gesture sensor or clapping near the microphone
- `Problem`: the runner expected data but did not get any
- `Waiting`: the board is not streaming yet

## Moving to another lab machine

If you want to continue from another computer:

1. Clone the repo on that machine:
   - `git clone https://github.com/k3larra/ble-sense-test-station.git`
2. Enter the folder:
   - `cd ble-sense-test-station`
3. Start the launcher there.
4. If needed, install Python 3, `arduino-cli`, and `pyserial` on that machine.

Your test records, test metadata and any local Python environment are machine-local, so they are not included in the repo by default.

## Tool requirements

The launcher itself only needs Python 3.

For firmware upload it also needs `arduino-cli`.

- On macOS, the runner points TAs toward the official Homebrew install path from Arduino's CLI installation docs.
- On Windows, the runner points TAs toward the official Arduino CLI installation page.

For local serial reading it needs `pyserial`. There is an `Install pyserial` button in the UI.

## Current board support

The current guided upload flow targets `sense_table_stream` on the Arduino Nano 33 BLE / BLE Sense family. The Python runner is structured around a board profile so it can be extended later for other teaching-kit boards.

## Repo contents

The repository is intended to contain only the files needed for the Sensor Table Monitor:

- `ble_sense_test_station.py`
- `LaunchSensorTableMonitor.cmd`
- `LaunchSensorTableMonitor.command`
- `LaunchSensorTableMonitor.ps1`
- `README.md`
- `sense_table_stream/`
- `sensor_table_monitor/`
