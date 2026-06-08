// G2 Capability Demonstrator (g2cap)
// Exercises the Even Hub SDK display+input surface so a BTSnoop of THIS app (loaded in the Even
// App) reveals how each SDK call maps to the e0-XX BLE wire frames our renderer targets.
// Scope: DISPLAY + INPUT only — no mic/IMU/device-status (see docs/SDK_CAPABILITY_MAP.md).
//
// Nav model (the same everywhere, so a capture run is predictable):
//   double-tap (global)        -> next step; past a group's end -> back to the group menu
//   tap / scroll / list-select -> interact with the page's focusable container  [CAPTURED]
//   from the MENU: tap a group -> enter it
// Every page keeps a top "nav" text container (breadcrumb + last event) and exactly ONE
// container with isEventCapture=1 (enforced at runtime). Test params are baked into container
// names + on-screen text so the capture is self-documenting.

import {
  waitForEvenAppBridge, type EvenAppBridge, type EvenHubEvent,
  CreateStartUpPageContainer, RebuildPageContainer,
  TextContainerProperty, TextContainerUpgrade,
  ListContainerProperty, ListItemContainerProperty,
  ImageContainerProperty, ImageRawDataUpdate,
  StartUpPageCreateResult, OsEventTypeList, EventSourceType, type LaunchSource, type DeviceStatus,
} from '@evenrealities/even_hub_sdk'
import {
  NAV_ID, NAV_NAME, NAV_X, NAV_Y, NAV_W, NAV_H,
  BODY_ID, BODY_NAME, CONTENT_X, CONTENT_Y, CONTENT_W, CONTENT_H,
} from './constants'
import { bmp4, raw4, bmp24 } from './images'

let bridge: EvenAppBridge
let launched = false
let groupIdx = -1 // -1 = group menu
let stepIdx = 0
let lastEvent = '(none)'
// Battery / device status, keyed by serial — populated by onDeviceStatusChanged (glasses + ring).
const deviceStatuses = new Map<string, DeviceStatus>()
let deviceInfoLine = '(getDeviceInfo not called yet)'

// ───────────────────────── container builders ─────────────────────────
interface Geom { x: number; y: number; w: number; h: number }
interface Style { bw?: number; bc?: number; br?: number; pad?: number }
const FULL: Geom = { x: CONTENT_X, y: CONTENT_Y, w: CONTENT_W, h: CONTENT_H }

function navC(focus: boolean, content?: string): TextContainerProperty {
  return new TextContainerProperty({
    containerID: NAV_ID, containerName: NAV_NAME,
    xPosition: NAV_X, yPosition: NAV_Y, width: NAV_W, height: NAV_H,
    borderWidth: 1, borderColor: 6, borderRadius: 0, paddingLength: 2,
    isEventCapture: focus ? 1 : 0,
    content: (content ?? navLine()).slice(0, 1000),
  })
}
function bodyText(content: string, style: Style = {}, focus = false,
                  id = BODY_ID, name = BODY_NAME, geom: Geom = FULL): TextContainerProperty {
  return new TextContainerProperty({
    containerID: id, containerName: name,
    xPosition: geom.x, yPosition: geom.y, width: geom.w, height: geom.h,
    borderWidth: style.bw ?? 0, borderColor: style.bc ?? 0,
    borderRadius: style.br ?? 0, paddingLength: style.pad ?? 0,
    isEventCapture: focus ? 1 : 0, content: content.slice(0, 1000),
  })
}
function bodyList(items: string[], selBorder: number, itemWidth: number, focus = true,
                  id = BODY_ID, name = BODY_NAME, geom: Geom = FULL): ListContainerProperty {
  return new ListContainerProperty({
    containerID: id, containerName: name,
    xPosition: geom.x, yPosition: geom.y, width: geom.w, height: geom.h,
    borderWidth: 1, borderColor: 6, borderRadius: 2, paddingLength: 4,
    isEventCapture: focus ? 1 : 0,
    itemContainer: new ListItemContainerProperty({
      itemCount: items.length, itemWidth, isItemSelectBorderEn: selBorder,
      itemName: items.map((s) => s.slice(0, 64)),
    }),
  })
}
function imageBox(id: number, name: string, x: number, y: number, w: number, h: number): ImageContainerProperty {
  return new ImageContainerProperty({ containerID: id, containerName: name, xPosition: x, yPosition: y, width: w, height: h })
}

// ───────────────────────── SDK ops ─────────────────────────
interface PageSpec { texts?: TextContainerProperty[]; lists?: ListContainerProperty[]; images?: ImageContainerProperty[] }

async function render(spec: PageSpec): Promise<string> {
  const texts = spec.texts ?? [], lists = spec.lists ?? [], images = spec.images ?? []
  const focus = [...texts, ...lists].filter((c) => c.isEventCapture === 1).length
  if (focus !== 1) throw new Error(`page needs exactly 1 isEventCapture=1 (got ${focus})`) // loud, never silent
  const total = texts.length + lists.length + images.length
  const payload = { containerTotalNum: total, textObject: texts, listObject: lists, imageObject: images }
  if (!launched) {
    launched = true
    const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(payload))
    return `create[${total}]=${r === StartUpPageCreateResult.success ? 'ok' : r}`
  }
  const ok = await bridge.rebuildPageContainer(new RebuildPageContainer(payload))
  return `rebuild[${total}]=${ok}`
}
async function upgrade(content: string, offset?: number, length?: number, id = BODY_ID, name = BODY_NAME): Promise<string> {
  const data: Partial<TextContainerUpgrade> = { containerID: id, containerName: name, content: content.slice(0, 2000) }
  if (offset !== undefined) data.contentOffset = offset
  if (length !== undefined) data.contentLength = length
  const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade(data))
  return `upgrade(off=${offset ?? '-'},len=${length ?? '-'})=${ok}`
}
async function pushImage(id: number, name: string, data: number[]): Promise<string> {
  const r = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: id, containerName: name, imageData: data }))
  return `img[${name}]=${r}`
}
async function refreshNav(): Promise<void> {
  if (!launched) return
  try {
    await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: NAV_ID, containerName: NAV_NAME, content: navLine().slice(0, 2000) }))
  } catch (e) { console.warn('[nav] refresh failed', e) }
}

// Battery / device-status display (the STATUS group). Shows the host-decoded battery % on-glass so
// it can be correlated with the battery packets in the BTSnoop (glasses device-info + ring's link).
function statusText(): string {
  const lines = ['DEVICE STATUS / BATTERY', deviceInfoLine, '', 'onDeviceStatusChanged:']
  if (deviceStatuses.size === 0) lines.push(' (none yet — wait a few s / toggle charging)')
  for (const s of deviceStatuses.values()) {
    lines.push(` ${s.sn}: batt=${s.batteryLevel ?? '?'}%  chg=${s.isCharging ? 'Y' : 'N'}  wear=${s.isWearing ? 'Y' : 'N'}  case=${s.isInCase ? 'Y' : 'N'}`)
  }
  return lines.join('\n')
}
async function refreshStatusBody(): Promise<void> {
  if (groupIdx < 0 || GROUPS[groupIdx].name !== 'STATUS') return
  try {
    await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: BODY_ID, containerName: 'sbody', content: statusText().slice(0, 2000) }))
  } catch (e) { console.warn('[status] refresh failed', e) }
}

// ───────────────────────── nav text + input description ─────────────────────────
function currentLabel(): string {
  if (groupIdx < 0) return 'MENU'
  const g = GROUPS[groupIdx]
  return `${g.name} ${stepIdx + 1}/${g.steps.length} ${g.steps[stepIdx].label}`
}
function navLine(): string {
  // SINGLE line + human-readable only. (A 2-line bar got cut off on glass, and dumping the step
  // RESULT note here is what looked like "cut-off code" — results now go to the console only.)
  return `G2CAP ${currentLabel()}  ·  2x=next  ·  ${lastEvent}`
}
const GEST: Record<number, string> = {
  1: 'scrollUp', 2: 'scrollDn', 3: '2tap', 4: 'fgEnter', 5: 'fgExit', 6: 'abnExit', 7: 'sysExit', 8: 'imu',
}
function gestureName(t: OsEventTypeList | undefined): string {
  return t === undefined || t === OsEventTypeList.CLICK_EVENT ? 'tap' : (GEST[t] ?? `t${t}`)
}
function sourceName(s: EventSourceType | undefined): string {
  return s === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R ? 'R'
    : s === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L ? 'L'
    : s === EventSourceType.TOUCH_EVENT_FROM_RING ? 'ring' : ''
}
function describe(ev: EvenHubEvent): string {
  if (ev.audioEvent) return `audio ${ev.audioEvent.audioPcm?.length ?? '?'}B`
  const c = ev.textEvent ?? ev.listEvent ?? ev.sysEvent
  if (!c) return ev.jsonData ? `json ${JSON.stringify(ev.jsonData).slice(0, 40)}` : 'empty'
  const t = ev.textEvent?.eventType ?? ev.listEvent?.eventType ?? ev.sysEvent?.eventType
  const name = ev.textEvent?.containerName ?? ev.listEvent?.containerName ?? 'sys'
  const src = sourceName(ev.sysEvent?.eventSource)
  const li = ev.listEvent ? ` #${ev.listEvent.currentSelectItemIndex ?? '?'}:${ev.listEvent.currentSelectItemName ?? ''}` : ''
  return `${gestureName(t)}${src ? '/' + src : ''} @${name}${li}`
}

// ───────────────────────── multi-container helpers ─────────────────────────
function textRows(count: number, prefix: string, baseId: number, w = CONTENT_W, x = CONTENT_X): TextContainerProperty[] {
  const rh = Math.floor(CONTENT_H / count)
  return Array.from({ length: count }, (_, i) =>
    bodyText(`${prefix}${i}`, { bw: 1, bc: 6, pad: 1 }, false, baseId + i, `${prefix}${i}`,
      { x, y: CONTENT_Y + i * rh, w, h: rh - 2 }))
}

// ───────────────────────── the capability matrix ─────────────────────────
interface Step { label: string; run: () => Promise<string> }
interface Group { name: string; steps: Step[] }

const GROUPS: Group[] = [
  {
    name: 'INPUT',
    steps: [
      {
        label: 'echo gestures',
        run: async () => {
          const help = [
            'INPUT ECHO — this body is focusable.',
            'Do each gesture, watch the nav line:',
            ' tap / scroll up / scroll down',
            ' double-tap = NEXT step',
            'Repeat from R temple, L temple, ring.',
            '', ...Array.from({ length: 9 }, (_, i) => `· filler line ${i} (overflow → scroll)`),
          ].join('\n')
          return render({ texts: [navC(false), bodyText(help, { bw: 1, bc: 8, pad: 4 }, true)] })
        },
      },
    ],
  },
  {
    name: 'TEXT',
    steps: [
      { label: 'plain', run: () => render({ texts: [navC(true), bodyText('PLAIN no border', {}, false)] }) },
      { label: 'BW3 BC10 BR5 P7', run: () => render({ texts: [navC(true), bodyText('BW3 BC10 BR5 P7', { bw: 3, bc: 10, br: 5, pad: 7 })] }) },
      { label: 'BW1 BC15 BR0 P0', run: () => render({ texts: [navC(true), bodyText('BW1 BC15 BR0 P0', { bw: 1, bc: 15, br: 0, pad: 0 })] }) },
      { label: 'BW5 BC0 BR10 P32', run: () => render({ texts: [navC(true), bodyText('BW5 BC0 BR10 P32', { bw: 5, bc: 0, br: 10, pad: 32 })] }) },
      { label: 'multi-3 text', run: () => render({ texts: [navC(true), ...textRows(3, 'm', 10)] }) },
      { label: 'multi-8cap (8 text total)', run: () => render({ texts: [navC(true), ...textRows(7, 'm', 10)] }) },
    ],
  },
  {
    name: 'UPGRADE',
    steps: [
      { label: 'setup 0-F', run: () => render({ texts: [navC(true), bodyText('0123456789ABCDEF', { bw: 1, bc: 8 }, false)] }) },
      { label: 'full replace', run: () => upgrade('FULL-REPLACED-CONTENT') },
      { label: 'partial off4 len4', run: () => upgrade('####', 4, 4) },
    ],
  },
  {
    name: 'LIST',
    steps: [
      { label: 'list5 sel1 wAuto', run: () => render({ texts: [navC(false)], lists: [bodyList(['it-0', 'it-1', 'it-2', 'it-3', 'it-4'], 1, 0, true)] }) },
      { label: 'list20 sel0 w120', run: () => render({ texts: [navC(false)], lists: [bodyList(Array.from({ length: 20 }, (_, i) => `it-${i}`), 0, 120, true)] }) },
    ],
  },
  {
    name: 'IMAGE',
    steps: [
      // FORMAT SWEEP — earlier raw-gray8 and canvas-PNG both failed to render. Each step pushes the
      // SAME gray-bands tile in a different byte FORMAT (all number[]); the nav says which. WATCH:
      // the format that paints the 4 bands is what updateImageRawData wants. BMP4 = the exact 4bpp BMP
      // our direct-BLE renderer proved the firmware accepts (render/Gray4Bmp.kt) — the top bet.
      {
        label: 'fmt BMP4 (want bands)',
        run: async () => {
          const n = await render({ texts: [navC(true)], images: [imageBox(BODY_ID, 'img', 188, CONTENT_Y, 200, 100)] })
          return `${n}; ${await pushImage(BODY_ID, 'img', bmp4(200, 100))}`
        },
      },
      {
        label: 'fmt BMP24 (want bands)',
        run: async () => {
          const n = await render({ texts: [navC(true)], images: [imageBox(BODY_ID, 'img', 188, CONTENT_Y, 200, 100)] })
          return `${n}; ${await pushImage(BODY_ID, 'img', bmp24(200, 100))}`
        },
      },
      {
        label: 'fmt RAW4 (want bands)',
        run: async () => {
          const n = await render({ texts: [navC(true)], images: [imageBox(BODY_ID, 'img', 188, CONTENT_Y, 200, 100)] })
          return `${n}; ${await pushImage(BODY_ID, 'img', raw4(200, 100))}`
        },
      },
    ],
  },
  {
    name: 'MIXED+RAMP',
    steps: [
      {
        label: 'text+list+image',
        run: async () => {
          const n = await render({
            texts: [navC(false), bodyText('mixed page', { bw: 1, bc: 7 }, false, 10, 'mxtext', { x: 0, y: CONTENT_Y, w: 286, h: 120 })],
            lists: [bodyList(['a', 'b', 'c'], 1, 0, true, 11, 'mxlist', { x: 300, y: CONTENT_Y, w: 276, h: 120 })],
            images: [imageBox(12, 'mximg', 188, CONTENT_Y + 126, 200, 100)],
          })
          return `${n}; ${await pushImage(12, 'mximg', bmp4(200, 100))}`
        },
      },
      {
        label: 'ramp-12 (8txt+4img caps)',
        run: async () => {
          const txt = textRows(7, 'r', 20, 280, 0)
          const imgs = Array.from({ length: 4 }, (_, j) => imageBox(30 + j, `i${j}`, 296, CONTENT_Y + j * 60, 120, 56))
          let n = await render({ texts: [navC(true), ...txt], images: imgs })
          for (const im of imgs) n += `; ${await pushImage(im.containerID!, im.containerName!, bmp4(120, 56))}`
          return n
        },
      },
    ],
  },
  {
    name: 'STATUS',
    steps: [
      {
        // Reads device info + battery and shows it on-glass. The battery PACKETS are the Even App's
        // own polling (glasses device-info service + the ring's direct link) — present in any capture
        // while connected; this just surfaces the % so we can decode which bytes carry it.
        label: 'device + battery (glasses/ring)',
        run: async () => {
          try {
            const di = await bridge.getDeviceInfo()
            deviceInfoLine = di
              ? `getDeviceInfo: model=${di.model} sn=${di.sn} batt=${di.status?.batteryLevel ?? '?'}%`
              : 'getDeviceInfo: null'
          } catch (e) { deviceInfoLine = `getDeviceInfo ERR ${e}` }
          console.log('[status]', deviceInfoLine)
          return render({ texts: [navC(true), bodyText(statusText(), { bw: 1, bc: 7, pad: 4 }, false, BODY_ID, 'sbody')] })
        },
      },
    ],
  },
  {
    name: 'EXIT',
    steps: [
      { label: 'shutdown(1) confirm', run: async () => `shutdown(1)=${await bridge.shutDownPageContainer(1)}` },
      { label: 'shutdown(0) now', run: async () => `shutdown(0)=${await bridge.shutDownPageContainer(0)}` },
    ],
  },
]

// ───────────────────────── runner ─────────────────────────
async function showMenu(): Promise<void> {
  groupIdx = -1; stepIdx = 0
  const items = GROUPS.map((g, i) => `${i + 1}. ${g.name}`)
  const note = await render({ texts: [navC(false, `G2CAP MENU — tap a group | ${lastEvent}`)], lists: [bodyList(items, 1, 0, true, BODY_ID, 'menu')] })
  console.log('[menu]', note)
}
async function enterGroup(i: number): Promise<void> {
  if (i < 0 || i >= GROUPS.length) return
  groupIdx = i; stepIdx = 0
  await runStep()
}
async function runStep(): Promise<void> {
  const step = GROUPS[groupIdx].steps[stepIdx]
  let note: string
  try { note = await step.run() } catch (e) { note = `ERR ${e}`; console.error('[step]', e); lastEvent = 'step ERROR (see log)' }
  // result note → console only; NOT the nav bar (the long result string was the "cut-off code")
  console.log(`[step] ${currentLabel()} ${note}`)
  await refreshNav()
}
async function advance(): Promise<void> {
  if (groupIdx < 0) return // in the menu, advance is via tapping a group
  stepIdx++
  if (stepIdx >= GROUPS[groupIdx].steps.length) { await showMenu(); return }
  await runStep()
}

function onEvent(ev: EvenHubEvent): void {
  lastEvent = describe(ev)
  const t = ev.textEvent?.eventType ?? ev.listEvent?.eventType ?? ev.sysEvent?.eventType
  if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) { void advance(); return }
  if (groupIdx < 0 && ev.listEvent && (t === undefined || t === OsEventTypeList.CLICK_EVENT)) {
    const idx = ev.listEvent.currentSelectItemIndex
    if (typeof idx === 'number') { void enterGroup(idx); return }
  }
  void refreshNav()
}

async function init(): Promise<void> {
  console.log('[g2cap] init')
  bridge = await waitForEvenAppBridge()
  bridge.onLaunchSource((s: LaunchSource) => { lastEvent = `launch:${s}`; console.log('[launch]', s) })
  bridge.onEvenHubEvent(onEvent)
  bridge.onDeviceStatusChanged((s: DeviceStatus) => {
    if (s.sn) deviceStatuses.set(s.sn, s)
    console.log('[status] changed', s.sn, 'batt', s.batteryLevel, 'chg', s.isCharging)
    void refreshStatusBody()
  })
  await showMenu()
}
void init().catch((e) => console.error('[init] fatal', e))
