// windows/_kbd.ts — the shared on-glass tap-keyboard MODEL (extracted verbatim from
// terminal.ts for Scout, docs/SCOUT.md — behaviour identical, the Terminal smoke is
// the regression gate). Char GROUPS in a native browse list → tap a group → tap a
// char → the OWNING window appends to its buffer; the action rows (Space/Bksp/
// Shift/Clear/Run/Done) are interpreted by the owner too. Pure data + one pure
// function — the buffer/level state stays in each window ("slow-ass by design,
// the fallback" — upgrades.md Phase 5; the only way to type an exact string when
// dictation can't emit '/' or a model number).

/** Char groups. '/' leads its group — slash commands were the original need. */
export const KBD_GROUPS: { label: string; chars: string }[] = [
  { label: 'a b c d e f g', chars: 'abcdefg' },
  { label: 'h i j k l m n', chars: 'hijklmn' },
  { label: 'o p q r s t u', chars: 'opqrstu' },
  { label: 'v w x y z', chars: 'vwxyz' },
  { label: '0 1 2 3 … 9', chars: '0123456789' },
  { label: '/ . , - _ : ; =', chars: '/.,-_:;=' },
  { label: '( ) [ ] { } < >', chars: '()[]{}<>' },
  { label: '! ? @ # $ % & *', chars: '!?@#$%&*' },
  { label: '+ | \\ ~ ^ " \' `', chars: '+|\\~^"\'`' },
]

export type KbdAction = 'space' | 'bksp' | 'shift' | 'clear' | 'run' | 'done' | 'groups'
export type KbdCell = { t: 'group'; chars: string } | { t: 'char'; ch: string } | { t: 'act'; a: KbdAction }

/** The current keyboard rows (the group list, or one group's chars) + a parallel
 *  cell map, so a window's view() and tap handler resolve the SAME indices (the
 *  browsePageItems pattern). `group` null = the group list. */
export function kbdModel(group: string | null, shift: boolean): { items: string[]; cells: KbdCell[] } {
  const items: string[] = []
  const cells: KbdCell[] = []
  if (group === null) {
    for (const g of KBD_GROUPS) {
      items.push(shift ? g.label.toUpperCase() : g.label)
      cells.push({ t: 'group', chars: shift ? g.chars.toUpperCase() : g.chars })
    }
    const acts: [string, KbdAction][] = [
      ['␣ Space', 'space'], ['⌫ Bksp', 'bksp'],
      [`⇧ Shift: ${shift ? 'ON' : 'off'}`, 'shift'],
      ['✕ Clear', 'clear'], ['⏎ Run', 'run'], ['‹ Done', 'done'],
    ]
    for (const [label, a] of acts) { items.push(label); cells.push({ t: 'act', a }) }
  } else {
    for (const ch of group) { items.push(ch); cells.push({ t: 'char', ch }) }
    items.push('‹ groups'); cells.push({ t: 'act', a: 'groups' })
  }
  return { items, cells }
}
