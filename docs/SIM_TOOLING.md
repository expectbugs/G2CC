# EvenHub Simulator — visual design loop on this box (reproducible)

The Even Hub **simulator** renders a Hub-app exactly as the G2 glasses would (576×288, the real LVGL
"g2" font) and exposes an HTTP automation API. We use it as a **visual design loop**: render a layout
→ screenshot the 576×288 framebuffer → look at it / measure it → iterate. No glasses needed, fully
scriptable. *(Caveat from the sim's own README: font rendering "may not perfectly match hardware" —
validate final pixel-tight layouts on the real glasses before locking them.)*

This box is NVIDIA + X11 + **no Wayland**, which the sim (a Tauri/WebKitGTK app) does not love. The
setup below is what actually works; the gotchas below cost an afternoon — **read them.**

## One-time setup (already done on `beardos`, 2026-06-10)

1. **`nvidia-drm.modeset=1`** — added to `GRUB_CMDLINE_LINUX_DEFAULT` in `/etc/default/grub`, regenerated
   (`grub-mkconfig -o /boot/grub/grub.cfg`), rebooted. Gives the system a GBM-capable DRM device.
   Backups: `/etc/default/grub.bak-modeset`, `/boot/grub/grub.cfg.bak-modeset`. Recovery entries are
   modeset-free (safe fallback). Confirm active: `dmesg | grep -i nvidia-drm` shows "fbcon: nvidia-drmdrmfb".
2. **EGL GBM platform lib** — `sudo emerge gui-libs/egl-gbm`, then `sudo ldconfig`. This is **THE
   fix** — without `libnvidia-egl-gbm.so` (+ its registration in `/usr/share/egl/egl_external_platform.d/`)
   EGL can't open a GBM display → `EGL_NOT_INITIALIZED`. Verify: `eglinfo -B | grep -A1 'GBM platform'`
   shows `EGL vendor string: NVIDIA`. *(We also installed `egl-x11`/`egl-wayland` while testing a wrong
   theory — they're harmless but NOT required; unmerge for minimalism. vkms is likewise NOT needed.)*
3. **GTK-Wayland symbol stub** — the sim binary hard-references `gdk_wayland_window_get_wl_surface`,
   absent on this no-Wayland GTK. Build the no-op stub: `gcc -shared -fPIC -O2 -o
   scripts/simtools/gtkwl_stub.so scripts/simtools/gtkwl_stub.c`. (Only called on the Wayland path,
   which we never take — `GDK_BACKEND=x11`.)

## Run it

```bash
# 1. serve the app (vite, from sdk-demo) — leave running
cd /home/user/G2CC/sdk-demo && node_modules/.bin/vite --host 127.0.0.1 --port 5174 &

# 2. launch the sim  (apps: fontcal.html | mockup.html)
GDK_BACKEND=x11 LD_PRELOAD=/home/user/G2CC/scripts/simtools/gtkwl_stub.so DISPLAY=:0.0 \
  nohup node /home/user/g2code/node_modules/@evenrealities/evenhub-simulator/bin/index.js \
  http://127.0.0.1:5174/mockup.html --automation-port 9898 > /tmp/sim.log 2>&1 < /dev/null & disown
sleep 14   # it needs ~12s to load + render (+ a couple more for image tiles)

# 3. screenshot the glasses framebuffer (independent of the blank on-screen window — see gotcha 3)
curl -s http://127.0.0.1:9898/api/screenshot/glasses -o /tmp/raw.png

# 4. composite alpha -> green-on-black (the real G2 look) and open it
python3 -c "import numpy as np;from PIL import Image;a=np.array(Image.open('/tmp/raw.png').convert('RGBA'));al=a[...,3:4]/255.0;Image.fromarray((np.array([0,255,0])*al).astype('uint8')).save('/tmp/view.png')"
DISPLAY=:0.0 xdg-open /tmp/view.png &     # viewnior is the default handler here

# 5. measure font/glyph widths from a fontcal shot
python3 /home/user/G2CC/scripts/measure_fontcal.py /tmp/raw.png
```

Automation API (`http://127.0.0.1:9898`): `GET /api/screenshot/glasses` (576×288 RGBA PNG),
`GET /api/screenshot/webview`, `GET /api/console` (webview console + errors), `POST /api/input`
(`{"action":"up|down|click|double_click"}`).

## Gotchas / lessons (the expensive ones — DO NOT relearn)

1. **NEVER `pkill -f sim-linux-x64` (or any `-f` pattern that also appears in your own command).**
   `-f` matches the whole command line, and the harness wraps your command in an `eval '…'` whose text
   contains that pattern → **pkill SIGKILLs your own shell mid-launch.** Symptom: empty log, no output,
   "exit 1", looks exactly like a "flaky sim". Use a **process-name** match: `pkill -9 evenhub-simulat`
   (the binary's comm; your bash/node never match it). This one masqueraded as sim flakiness for ~15
   launch cycles.
2. **The screenshot is GREEN (R0 G255 B0); the glyphs/content live in the ALPHA channel.** A luminance
   convert (`.convert('L')`) of solid green is a flat ~150 everywhere and **throws the text away** — it
   looks blank. Ink = `alpha > 128`. This false "blank" reading is what sent a chase through vkms /
   Wayland / mount-namespaces *after the real fix (egl-gbm) had already worked.* When something "fails",
   **suspect your own measurement first** (Adam's repeated nudge is what caught it).
3. **The live on-screen windows ("Browser"/"Glasses Display") are BLANK** — the on-screen GBM buffer
   alloc fails (`Failed to create GBM buffer … Invalid argument`, harmless/cosmetic on NVIDIA). The
   `/api/screenshot/glasses` path renders **independently** and works. Don't debug the blank windows.
4. **Launch via the node wrapper** (`…/evenhub-simulator/bin/index.js`), not the binary directly, and
   **keep launch commands short** (long `sleep`s get interrupted by incoming chat messages, so the
   backgrounded launch line never runs and no log is created).
5. **A short title/status bar triggers a firmware overflow scrollbar** (a green tick top/bottom-right
   that even clips text). Make text bars tall enough for their content (≥~38px) and it vanishes. (On
   real glasses scrollbars only show while scrolling; in the sim they show statically — Adam's call.)

## Apps + outputs

- `sdk-demo/fontcal.html` (`src/fontcal.ts`) — font calibration: 8 known strings; `measure_fontcal.py`
  reads glyph widths off the alpha channel.
- `sdk-demo/mockup.html` (`src/mockup.ts`) — the DE layout mockup: firmware chrome (title + top-right
  clock / narrow native-list menu / status bar with right-aligned window tabs) + a 4-tile **image**
  content pane (Claude response drawn to canvas with real typography → gray4 → `updateImageRawData`).

## Measured G2 firmware-font metrics (sim, 2026-06-10 — confirm on glass before locking)

Glyph widths: `W`≈15.8px, `N`/uppercase≈11.4–11.9, digits≈11.0, lowercase≈9.6, **realistic mixed text
≈9.0px/char**, `i`≈4.8. Rows ~34px fit 8 in 288px. Chars per region (avg / worst-case all-`W`):
**content @432px ≈43 / ~27**, **menu @144px ≈14 / ~9**, full width @576px ≈58 / ~36.

**Box-drawing renders ~2× WIDER than `fwTextWidth` assumes (Adam on glass, 2026-06-16).** A
horizontal rule `─` (U+2500) renders **~21 px** on the firmware, NOT the lowercase 9.6 px the
`else` branch of `fwTextWidth` (os-compose) gives it. TWO consistent on-glass cals nail it: a
**47-col `─` bar = 2.2 content rows** and a **28-col bar = 1.25 rows** — both ⇒ **~21–22 cols per
~466 px content row ⇒ `─` ≈ 21 px** (a first round-1 guess of 14 px was too low and still wrapped).
Consequence: any line that is mostly box-drawing (U+2500–U+257F: `─│┌┐└┘├┤┼` etc.) under-measures
~2.2×, so it firmware-wraps past its intended row count — invisible, same class as the CJK/Cyrillic
bumps already in `fwTextWidth`. **Fixed Terminal-local** (`os-windows.ts` `termTextWidth` prices
U+2500–257F at 21 px + the adjacent shape/technical/dingbat ranges claude uses at a safe 14 px,
fed to `wrapLinesPx`'s `widthFn`; the rule-bar `collapseRules` clamps to `TERM_RULE_COLS`=18). A
global `fwTextWidth` bump for box-drawing is the clean root fix if it ever bites another window —
left Terminal-local per Adam's scope (it would shift CC/Aria `─`-divider pagination). Blocks +
geometric shapes (U+2580–U+25FF) are likely wide too but uncal'd; termTextWidth over-prices them
14 px conservatively.
