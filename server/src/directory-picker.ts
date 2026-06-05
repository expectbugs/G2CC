// Directory picker — enumerates /home/user/* directories for the HUD picker
// that runs after the user selects "Claude Code" from the dispatch menu.
//
// NEW in G2CC (no g2code/g2aria source). Plain function over readdirSync.
// **No truncation; no max-N cap.** The HUD scrolls through the full list per
// the no-truncation rule.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DirectoryEntry } from '@g2cc/shared'

const HOME_USER = '/home/user'

/** Return the full sorted list of /home/user/<name>/ directories.
 *  Filters: skip dotfiles; skip non-directories. (Note: prior JSDoc claimed
 *  "skip the G2CC tree itself" — not actually implemented; G2CC is listed
 *  alongside everything else under /home/user/. Doc-fix only, behavior
 *  unchanged.) */
export function listProjectDirectories(): DirectoryEntry[] {
  const entries: DirectoryEntry[] = []

  let names: string[]
  try {
    names = readdirSync(HOME_USER)
  } catch (err) {
    // Loud-and-proud: log and return empty — caller decides how to surface.
    console.error(`[directory-picker] cannot read ${HOME_USER}: ${(err as Error).message}`)
    return []
  }

  for (const name of names) {
    if (name.startsWith('.')) continue
    const fullPath = join(HOME_USER, name)
    let stats
    try {
      stats = statSync(fullPath)
    } catch (err) {
      // Symlink target gone, permission denied, etc. — log loudly; skip entry.
      console.warn(`[directory-picker] stat failed for ${fullPath}: ${(err as Error).message}`)
      continue
    }
    if (!stats.isDirectory()) continue

    entries.push({
      name,
      path: fullPath,
      // Node's mtimeMs is a sub-millisecond FLOAT (e.g. 1749865721361.572). The
      // Android client deserializes DirectoryEntry.mtime as a Kotlin Long, and
      // kotlinx.serialization throws on a fractional number — which silently
      // dropped the entire directory_list_reply and hung the HUD on "loading
      // directories…" forever. Floor to integer ms so it's Long-parseable. (Sub-ms
      // precision is meaningless for a directory mtime.)
      mtime: Math.floor(stats.mtimeMs),
    })
  }

  // Sort alphabetically by name. (Most-recent-first is also reasonable;
  // alphabetical is more predictable for HUD navigation.)
  entries.sort((a, b) => a.name.localeCompare(b.name))

  return entries
}
