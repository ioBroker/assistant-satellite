# @iobroker/assistant-satellite

A standalone **voice satellite** for the [`ioBroker.assistant`](https://github.com/ioBroker/ioBroker.assistant)
adapter. It runs the wake word on the device, streams the microphone to the adapter, and plays the
spoken reply — over the same UDP protocol as the Hannah satellite. **No ioBroker install required**;
runs on a bare Raspberry Pi via `npx`.

> STT → LLM → TTS all run in the adapter. The satellite only does: wake word · mic capture · playback.

## Requirements

- Node.js ≥ 18
- Audio backend (auto-selected by platform):
  - **Linux**: ALSA tools — `sudo apt install alsa-utils` (`arecord`/`aplay`)
  - **Windows / macOS**: **ffmpeg** (provides `ffmpeg`/`ffplay`) on the PATH
- A running `ioBroker.assistant` instance with the **Voice** server enabled

Wake-word inference uses `onnxruntime-node`, which ships prebuilt binaries for Linux (x64/arm64),
Windows (x64) and macOS (x64/arm64) — so the satellite runs on all three; only the audio backend differs.

## Quick start

```bash
# 1. First run writes a default config and exits:
npx @iobroker/assistant-satellite

# 2. Edit config.json — at least set "host" (the ioBroker host) and your ALSA devices:
#    "host": "192.168.1.129", "micDevice": "plughw:2,0", "speakerDevice": "plughw:2,0"

# 3. Run:
npx @iobroker/assistant-satellite config.json
```

On first run it downloads the OpenWakeWord models into `modelsDir`. Then say the wake word
(default **"hey jarvis"**) → speak → the answer is played back.

Find your ALSA device with `arecord -l` / `aplay -l` (→ `plughw:<card>,<device>`; the `plug` prefix
lets ALSA resample so 16 kHz capture works on any card).

### As a bare command

The package exposes an `assistant-satellite` binary (like `mocha`, `eslint`, … — via the `bin` field),
so you don't have to type `node build/cli.js`. Get it onto your PATH by installing globally:

```bash
npm i -g @iobroker/assistant-satellite     # after publish; or `npm i -g .` / `npm link` from a clone
assistant-satellite check config.json
assistant-satellite config.json
sudo assistant-satellite install config.json
```

`npx @iobroker/assistant-satellite …` works without a global install. All subcommands
(`check` / `install` / `uninstall`) accept the same forms.

## Configuration (`config.json`)

| Key                              | Default          | Meaning                                              |
|----------------------------------|------------------|------------------------------------------------------|
| `logLevel`                       | `info`           | `info` or `debug` (wake-word/mic diagnostics)        |
| `device` / `room`                | `satellite` / `` | identity reported to the adapter                     |
| `host` / `port`                  | `` / `7775`      | ioBroker.assistant voice-server address              |
| `listenPort`                     | `7776`           | UDP port the satellite receives TTS on               |
| `audioBackend`                   | `auto`           | `auto` / `alsa` / `ffmpeg`                           |
| `micDevice` / `speakerDevice`    | `default`        | see per-platform notes below                         |
| `wakewordModel`                  | `hey_jarvis`     | built-in name, URL, or local `.onnx` path            |
| `wakewordThreshold`              | `0.5`            | detection sensitivity (0–1)                          |
| `silenceThreshold` / `silenceMs` | `300` / `800`    | end-of-speech (VAD)                                  |
| `minRecordMs` / `maxRecordMs`    | `800` / `8000`   | recording bounds                                     |

Built-in wake words: `hey_jarvis`, `alexa`, `hey_mycroft`, `hey_rhasspy`.

### Audio devices per platform

- **Linux (alsa):** `micDevice`/`speakerDevice` = ALSA names, e.g. `plughw:2,0`. List with `arecord -l` /
  `aplay -l` (the `plug` prefix lets ALSA resample so 16 kHz capture works on any card).
- **Windows (ffmpeg):** `micDevice` = the DirectShow device **name**, e.g. `Microphone (Poly Sync 20)`.
  List with `ffmpeg -hide_banner -list_devices true -f dshow -i dummy`. Playback uses the default output
  (`speakerDevice` is ignored via ffplay).
- **macOS (ffmpeg):** `micDevice` = the avfoundation audio **index**, e.g. `0`. List with
  `ffmpeg -hide_banner -f avfoundation -list_devices true -i ""`.

## Run as a service (systemd)

The satellite already retries registration and re-registers automatically if the adapter restarts, so
`systemd` only needs to keep the process alive.

First verify everything is present (Node, systemd, root, audio tools, **live mic-in / speaker-out test**,
config) — `install` runs these automatically and aborts on failure:

```bash
node build/cli.js check config.json     # dry-run of the same checks
```

Then install itself as a service (Linux, needs `sudo`):

```bash
# from a clone (build first), pointing at your config:
npm run build
sudo node build/cli.js install config.json      # add --force to install despite check failures
# …or, after `npm i -g @iobroker/assistant-satellite`:
sudo assistant-satellite install /path/to/config.json
```

`install` writes `/etc/systemd/system/assistant-satellite.service` (running as **your** user, in the
`audio` group, with absolute paths to `node`, `cli.js` and the config), then `daemon-reload` +
`enable --now`. Manage it with:

```bash
journalctl -u assistant-satellite -f          # logs
sudo systemctl restart assistant-satellite
sudo node build/cli.js uninstall              # stop + remove  (or: sudo assistant-satellite uninstall)
```

<details><summary>Prefer a handwritten unit file?</summary>

```ini
[Unit]
Description=ioBroker assistant satellite
After=network-online.target sound.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/assistant-satellite
ExecStart=/usr/bin/node /opt/assistant-satellite/build/cli.js /opt/assistant-satellite/config.json
Restart=always
RestartSec=5
User=iob
SupplementaryGroups=audio

[Install]
WantedBy=multi-user.target
```
</details>

## Status

Early scaffold. The audio/UDP/registration/playback pipeline follows the working Hannah satellite;
the **OpenWakeWord** inference (`src/wakeword.ts`) is a from-scratch Node port and its frame math /
threshold should be validated on the target device.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
* (@GermanBluefox) Initial commit


## License

MIT License

Copyright (c) 2025-2026 Denis Haev <dogafox@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
