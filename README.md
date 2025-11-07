Reusable, mobile-friendly WaveSurfer audio player you can use across many Anki cards without pasting big code blocks into each template.

Maintain the code in this project and **copy the built files into Anki’s `collection.media` folder** whenever you update them.

## Project layout

```
wavesurfer_anki/
  src/
    _player.js                     # Main player logic (ES module)
    _player.css                    # Player styles (desktop + sticky mobile layout)
    _7.10.1_wavesurfer.esm.min.js  # WaveSurfer core (local copy)
    _7.10.1-regions.esm.min.js     # WaveSurfer Regions plugin (local copy)
  scripts/
    deploy-macos-linux.sh          # Copies files to Anki's media folder (edit the path once)
    deploy-windows.ps1             # Same for Windows/PowerShell (edit the path once)
  README.md
```

### Files overview

* **`_player.js`** — creates the WaveSurfer instance, region, pause-mark logic, “safe end parking” to avoid distortion, keyboard shortcuts, and hooks up the buttons.
* **`_player.css`** — styles for desktop and responsive sticky mobile player (speed chips, grid controls).
* **WaveSurfer libs** — local copies (avoid CSP/network issues in Anki).

## Anki field mapping

Provide these values from your **card template** (inline `<script>`). Anki replaces `{{fields}}` only in the card HTML, not inside external files.

| Config key | Typical source | Blank behavior |
| ------------ | -------------------- | ------------------------------------------------------------------------------------------------- |
| `wave` | `{{wave}}` | **Required.** Must be `[sound:foo.mp3]` or a direct media filename present in `collection.media`. |
| `start01` | `{{01_start}}` | Start at **0s**. |
| `end01` | `{{01_end}}` | Play until **audio end** (or see `start02`). |
| `start02` | `{{02_start}}` | If `end01` is blank and `start02` is valid, it’s used as the **end** time. |
| `pauseMarks` | `{{01_pause_marks}}` | Blank disables pause-at-marks logic entirely. |

**Pause marks format:** space/comma-separated seconds like `2.5s, 5, 10.2s`. They’re deduped, sorted, and clipped to the current region.

## Deploy to Anki’s media folder

Anki serves **only top-level files** in `collection.media` (no subfolders). Copy these four files there:

* `_player.js`
* `_player.css`
* `_7.10.1_wavesurfer.esm.min.js`
* `_7.10.1-regions.esm.min.js`

### 1) Find your `collection.media` path

* **Windows**: `C:\Users\<YOU>\AppData\Roaming\Anki2\User 1\collection.media`
* **macOS**: `~/Library/Application Support/Anki2/User 1/collection.media`
* **Linux**: `~/.local/share/Anki2/User 1/collection.media`

Adjust “User 1” if your profile name differs.

### 2) Use the deploy scripts (edit the path once)

**macOS/Linux — `scripts/deploy-macos-linux.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# EDIT THIS: your profile's collection.media path
ANKI_MEDIA="$HOME/Library/Application Support/Anki2/User 1/collection.media"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src"

cp -f "$SRC/_player.js"                     "$ANKI_MEDIA/"
cp -f "$SRC/_player.css"                    "$ANKI_MEDIA/"
cp -f "$SRC/_7.10.1_wavesurfer.esm.min.js"  "$ANKI_MEDIA/"
cp -f "$SRC/_7.10.1-regions.esm.min.js"     "$ANKI_MEDIA/"

echo "Deployed to: $ANKI_MEDIA"
```

Make executable and run:

```bash
chmod +x scripts/deploy-macos-linux.sh
./scripts/deploy-macos-linux.sh
```

**Windows (PowerShell) — `scripts/deploy-windows.ps1`**

```powershell
# EDIT THIS: your profile's collection.media path
$anki = "C:\Users\<YOU>\AppData\Roaming\Anki2\User 1\collection.media"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path (Join-Path $root "..") "src"

Copy-Item -Force (Join-Path $src "_player.js") $anki
Copy-Item -Force (Join-Path $src "_player.css") $anki
Copy-Item -Force (Join-Path $src "_7.10.1_wavesurfer.esm.min.js") $anki
Copy-Item -Force (Join-Path $src "_7.10.1-regions.esm.min.js") $anki

Write-Host "Deployed to: $anki"
```

Run from PowerShell:

```powershell
.\scripts\deploy-windows.ps1
```

> Tip: add version suffixes (e.g., `_player.v3.js`) and update the import in your card to avoid browser caching after updates.

## Add to your Anki card

1. **Include CSS**

```html
<link rel="stylesheet" href="_player.css">
```

2. **HTML structure** (IDs/classes must match CSS/JS)

```html
<div id="playerSafetySpacer" aria-hidden="true"></div>

<div id="playerContainer">
  <div id="speedRow" class="controls-row">
    <button class="btn-speed" type="button" onclick="setSpeed(0.3)">0.3</button>
    <button class="btn-speed" type="button" onclick="setSpeed(0.4)">0.4</button>
    <button class="btn-speed" type="button" onclick="setSpeed(0.5)">0.5</button>
    <button class="btn-speed" type="button" onclick="setSpeed(0.6)">0.6</button>
    <button class="btn-speed" type="button" onclick="setSpeed(0.8)">0.8</button>
    <button class="btn-speed" type="button" onclick="setSpeed(1)">1</button>
  </div>

  <div id="waveform"></div>
  <div id="timestamp">Current Time: 0.00s</div>

  <div id="controls">
    <button id="skipBackwardButton" type="button">-3s (g)</button>
    <button id="prevMarkButton"    type="button">Prev Mark (h)</button>
    <button id="playPauseButton"   type="button">Play/Pause (j)</button>
    <button id="stopButton"        type="button">Stop</button>

    <!-- Desktop-only (hidden by CSS on mobile) -->
    <button class="btn-speed" type="button" onclick="setSpeed(0.3)">0.3x</button>
    <button class="btn-speed" type="button" onclick="setSpeed(0.4)">0.4x</button>
    <button class="btn-speed" type="button" onclick="setSpeed(0.5)">0.5x</button>
    <button class="btn-speed" type="button" onclick="setSpeed(0.6)">0.6x</button>
    <button class="btn-speed" type="button" onclick="setSpeed(0.8)">0.8x</button>
    <button class="btn-speed" type="button" onclick="setSpeed(1)">Normal</button>

    <button id="resetRegionButton" type="button">Reset Region</button>
  </div>
</div>
```

3. **Inline init script** (Anki substitutes fields here)

```html
<script type="module">
  import initPlayer from "./_player.js";
  initPlayer({
    wave: "{{wave}}".trim(),
    start01: "{{01_start}}".trim(),
    end01: "{{01_end}}".trim(),
    start02: "{{02_start}}".trim(),
    pauseMarks: "{{01_pause_marks}}".trim()
  });
</script>
```

**Important:** keep `{{fields}}` only in the inline script. Anki does **not** substitute inside external files.

## Keyboard shortcuts

* `g` → -3s
* `h` → jump to previous pause mark and play
* `j` → play/pause
* `k` → +0.5s
* `l` / `p` → -100s

(Inputs/textareas are ignored.)

## Troubleshooting

* **Waveform doesn’t show**
	* Check the browser console (Previewer → right-click → Inspect → Console) for 404 or module errors.
	* Ensure all four files exist at the **top level** of `collection.media`.
	* Confirm `{{wave}}` resolves to `[sound:foo.mp3]` (or a valid filename present in `collection.media`).
* **`{{wave}}` prints literally**
	* You put placeholders into an external file. Keep them **only** in the inline `<script>`.
* **Works on desktop but not on phone**
	* Sync your media to AnkiDroid.
	* Avoid importing from subfolders—Anki serves only the root.
* **Audio distorts at end / won’t restart**
	* The code “parks” a few ms before the end to avoid ended-state glitches. Press play or click the waveform; it will snap to the region start if parked.
* **CSS not applying**
	* Verify IDs in your HTML match `_player.css`.
	* If using the Styling tab instead of `<link>`, add:

		```css

    @import url("_player.css");

    ```

## Maintenance workflow

1. Edit files in `src/`.
2. Run the deploy script to copy to `collection.media`.
3. Refresh the Anki preview (or sync and reopen on mobile).

> Consider versioning the filename (`_player.v3.js`) for safe rollouts across devices.

## Credits / License

* Uses [WaveSurfer](https://wavesurfer-js.org/) and its Regions plugin.
* Add a license file if you plan to share/distribute your player.
