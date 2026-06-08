// G2 Capability Demonstrator — layout constants.
// Screen is 576x288, 4-bit gray (decoded; matches SDK docs). Origin top-left.

export const SCREEN_W = 576
export const SCREEN_H = 288

// Persistent nav/status bar (top). Container id 1.
export const NAV_ID = 1
export const NAV_NAME = 'nav'
export const NAV_X = 0
export const NAV_Y = 0
export const NAV_W = SCREEN_W
export const NAV_H = 40

// Content area (everything a test draws lives here). Body container id 2 by convention.
export const BODY_ID = 2
export const BODY_NAME = 'body'
export const CONTENT_X = 0
export const CONTENT_Y = 44
export const CONTENT_W = SCREEN_W
export const CONTENT_H = SCREEN_H - CONTENT_Y // 244

// SDK / firmware caps (from index.d.ts + g2-render-limits memory). Used by the cap-probe steps.
export const MAX_CONTAINERS = 12
export const MAX_TEXT = 8 // includes the nav text container
export const MAX_IMAGE = 4
export const IMG_MAX_W = 288
export const IMG_MAX_H = 144
