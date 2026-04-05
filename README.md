# BLE Sense Test Station

Version: `0.9`

This repository is now arranged so a teaching assistant can start one local tool instead of juggling Arduino IDE, Arduino CLI and a browser serial session.

## Intended flow

1. Download or clone the repository.
2. Start the launcher:
   - Windows: `LaunchSensorTableMonitor.cmd`
   - macOS: `LaunchSensorTableMonitor.command`
   - Any platform with Python: `python ble_sense_test_station.py`
3. Plug in an Arduino Nano 33 BLE Sense.
4. In the page that opens, choose the detected serial port.
5. Click `Prepare, Upload and Start Test`.

The local runner will:

- check whether `arduino-cli` is installed
- check whether Python can access serial ports through `pyserial`
- detect whether the connected board looks like Nano 33 BLE Sense Rev1 or Rev2
- check whether the needed Arduino core and matching sensor libraries are already installed
- only install missing Arduino dependencies when required
- use the `PDM` support that comes with the Nano 33 BLE core instead of trying to install it as a separate library
- compile and upload `sense_table_stream`
- reconnect to the board and read live JSON sensor data
- show which sensors are verified, which need interaction, and which appear broken

## What the status colors mean

- `Verified`: the sensor is returning data or a positive activity event was detected
- `Needs action`: the sensor likely works, but the TA still needs to interact with it, such as waving over the gesture sensor or clapping near the microphone
- `Problem`: the runner expected data but did not get any
- `Waiting`: the board is not streaming yet

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
