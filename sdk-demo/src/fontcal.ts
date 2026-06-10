// G2 firmware-font calibration harness.
// Renders known strings as left-aligned, zero-padding/zero-border text containers at known Y, so the
// pixel width of each (from the simulator's 576x288 framebuffer) gives us the real LVGL g2 font
// metrics — the font is variable-width (no single char width), so we measure repeated single glyphs
// + real strings. Loaded in the EvenHub simulator; screenshot via its /api/screenshot/glasses.
//
// ROW ORDER IS LOAD-BEARING — scripts/measure_fontcal.py maps row index -> string by this list.
import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'

// Each entry: [label-for-report, rendered-string]. Repeated single glyphs let us divide out per-glyph
// width; the mixed strings give realistic averages + the actual UI-ish content we'll use.
export const ROWS: Array<[string, string]> = [
  ['20xW', 'WWWWWWWWWWWWWWWWWWWW'],
  ['20xi', 'iiiiiiiiiiiiiiiiiiii'],
  ['20xN', 'NNNNNNNNNNNNNNNNNNNN'],
  ['10xDigit', '0123456789'],
  ['lower26', 'abcdefghijklmnopqrstuvwxyz'],
  ['upper26', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  ['sentence', 'The quick brown fox jumps over a'],
  ['ui-row', 'Inbox  Re: shipment delayed 3 days'],
]

const ROW_H = 34
const ROW_GAP = 2

async function main(): Promise<void> {
  const bridge = await waitForEvenAppBridge()
  const texts = ROWS.map(([name, content], i) =>
    new TextContainerProperty({
      containerID: i + 1,
      containerName: name,
      xPosition: 0,
      yPosition: i * (ROW_H + ROW_GAP),
      width: 576,
      height: ROW_H,
      borderWidth: 0,
      borderColor: 0,
      borderRadius: 0,
      paddingLength: 0,
      isEventCapture: i === 0 ? 1 : 0, // exactly one focusable, per firmware
      content,
    }),
  )
  await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: texts.length,
      textObject: texts,
      listObject: [],
      imageObject: [],
    }),
  )
  // Surfaced to /api/console so the run script can confirm the render landed before screenshotting.
  console.log(`[fontcal] rendered ${ROWS.length} rows @ ${ROW_H}px (gap ${ROW_GAP})`)
}

main().catch((e) => console.error('[fontcal] fatal', e))
