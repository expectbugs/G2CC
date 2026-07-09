// windows/registry.ts — the ONE place adding a window touches: a new file in windows/
// plus ONE line here, and the host never changes (overhaul.md §1.3, docs/WINDOW_API.md).
//
// The host (window-manager.ts) maps WINDOW_FACTORIES to build its window list, wrapping
// each in its reRender closure. Main is special-cased in the host (it needs the live
// window-list + MRU + unseen getters), so it is NOT in this list.

import type { OsWindow, WmContext } from './types.js'
import { AriaWindow } from './aria.js'
import { CcWindow } from './cc.js'
import { MailWindow } from './mail.js'
import { FilesWindow } from './files.js'
import { ReaderWindow } from './reader.js'
import { TimersWindow } from './timers.js'
import { CalendarWindow } from './calendar.js'
import { GamesWindow } from './games.js'
import { NoticesWindow } from './notices.js'
import { ScoutWindow } from './scout.js'
import { SearchWindow } from './search.js'
import { TerminalWindow } from './terminal.js'
import { DeliveriesWindow } from './deliveries.js'
import { MediaWindow } from './media.js'
import { SmsWindow } from './sms.js'

/** A window factory: given host services + a reRender callback, build the window. */
export type WindowFactory = (ctx: WmContext, reRender: () => void) => OsWindow

/** Registration order = the default (never-used) MRU tail order. Adding a window =
 *  a new windows/<id>.ts + ONE line here. The host needs no edit. */
export const WINDOW_FACTORIES: WindowFactory[] = [
  (c, rr) => new AriaWindow(c, rr),
  (c, rr) => new CcWindow(c, rr),
  (c, rr) => new ScoutWindow(c, rr),
  (c, rr) => new MailWindow(c, rr),
  (c, rr) => new FilesWindow(c, rr),
  (c, rr) => new ReaderWindow(c, rr),
  (c, rr) => new TimersWindow(c, rr),
  (c, rr) => new CalendarWindow(c, rr),
  (c, rr) => new GamesWindow(c, rr),
  (c, rr) => new NoticesWindow(c, rr),
  (c, rr) => new SearchWindow(c, rr),
  (c, rr) => new TerminalWindow(c, rr),
  (c, rr) => new DeliveriesWindow(c, rr),
  (c, rr) => new MediaWindow(c, rr),
  (c, rr) => new SmsWindow(c, rr),
]
