// Full-mail-program smoke (upgrades.md v2 Phase 8). Three layers, all isolated:
// (1) read_maildir image extraction + del→Trash + mark_unread + senders on a
// SANDBOX maildir; (2) send_mail reply/forward/compose in DRY-RUN (builds RFC822
// + files to a sandbox Sent, NEVER invokes msmtp — no outbound side effect);
// (3) the MailWindow state machine with runMaildir/runSend STUBBED (so no real
// inbox is read/mutated and no mail is sent) — Compose/Reply/Forward/Del/Unread
// flows + image pages. NEVER touches Adam's real mail or sends email.
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const PY = '/home/user/G2CC/audio/venv/bin/python'
const RM = '/home/user/G2CC/scripts/read_maildir.py'
const SM = '/home/user/G2CC/scripts/send_mail.py'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

const sb = mkdtempSync(join(tmpdir(), 'g2cc-mail8-'))
try {
  const acct = join(sb, 'marzello.net')
  for (const f of ['INBOX', 'Sent', 'Trash']) for (const s of ['new', 'cur', 'tmp']) mkdirSync(join(acct, f, s), { recursive: true })
  const INBOX = join(acct, 'INBOX'), SENT = join(acct, 'Sent'), TRASH = join(acct, 'Trash')
  const msg = `From: Bob <bob@y.com>\r\nTo: adam@marzello.net\r\nSubject: status update\r\n` +
    `Message-ID: <m1@y.com>\r\nReferences: <t0@y.com>\r\nDate: Mon, 02 Jun 2026 09:00:00 -0500\r\n` +
    `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=BB\r\n\r\n` +
    `--BB\r\nContent-Type: text/plain\r\n\r\nthe body text\r\n` +
    `--BB\r\nContent-Type: image/png\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    PNG.toString('base64') + `\r\n--BB--\r\n`
  writeFileSync(join(INBOX, 'new', '9000.bob'), msg)
  const rm = (...a) => JSON.parse(execFileSync(PY, [RM, ...a], { encoding: 'utf8' }))

  // === 1. read_maildir: images + senders + mark_unread + del ===
  const read = rm('read', INBOX, '9000.bob')
  assert.equal(read.images.length, 1, 'inline image extracted')
  assert.ok(read.images[0].inline && existsSync(read.images[0].path), 'image cached to disk, inline flag set')
  assert.equal(read.message_id, '<m1@y.com>', 'threading headers present')
  const senders = rm('senders', INBOX, '10').senders
  assert.deepEqual(senders, [{ name: 'Bob', address: 'bob@y.com' }], 'recent senders for the recipient pick')
  rm('mark_unread', INBOX, '9000.bob')   // in new/, no S → already unread (no-op)
  const del = rm('del', INBOX, '9000.bob')
  assert.ok(del.trashed.startsWith(join(TRASH, 'cur')), 'del moves to the sibling Trash maildir')
  assert.equal(readdirSync(join(INBOX, 'new')).length, 0, 'gone from INBOX')
  // clobber guard: mark_read must REFUSE to overwrite an existing cur/ target (no mail loss)
  writeFileSync(join(INBOX, 'new', '9100.dup'), 'From: x\r\n\r\nbody\r\n')
  writeFileSync(join(INBOX, 'cur', '9100.dup:2,S'), 'EXISTING — must not be clobbered')
  let clobberRefused = false
  try { execFileSync(PY, [RM, 'mark_read', INBOX, '9100.dup'], { encoding: 'utf8', stdio: 'pipe' }) } catch { clobberRefused = true }
  assert.ok(clobberRefused, 'mark_read refuses to clobber an existing target (no mail loss)')
  assert.equal(readFileSync(join(INBOX, 'cur', '9100.dup:2,S'), 'utf8'), 'EXISTING — must not be clobbered', 'existing message preserved')
  console.error('  1. read_maildir: image extract + senders + mark_unread + del→Trash + clobber guard ✓')

  // === 2. send_mail DRY-RUN: build + file to Sent, NO msmtp ===
  // restore one message for reply/forward to read
  writeFileSync(join(INBOX, 'cur', '9001.bob:2,S'), msg)
  const sm = (req) => JSON.parse(execFileSync(PY, [SM], { input: JSON.stringify(req), encoding: 'utf8' }))
  const FROM = 'adam@marzello.net'
  const rep = sm({ mode: 'reply', maildir: INBOX, key: '9001.bob', body: 'on it', from_addr: FROM, sent_maildir: SENT, dry_run: true })
  assert.equal(rep.sent, false, 'dry-run does not send')
  const repRaw = readFileSync(rep.sent_path, 'utf8')
  assert.ok(repRaw.includes('Subject: Re: status update') && repRaw.includes('In-Reply-To: <m1@y.com>') &&
            repRaw.includes('References: <t0@y.com> <m1@y.com>') && repRaw.includes('> the body text'),
    'reply: Re: subject, threading headers, quoted original')
  const fwd = sm({ mode: 'forward', maildir: INBOX, key: '9001.bob', to: 'carol@z.com', from_addr: FROM, sent_maildir: SENT, dry_run: true })
  assert.ok(readFileSync(fwd.sent_path, 'utf8').includes('Subject: Fwd: status update'), 'forward: Fwd: subject + inline original')
  const cmp = sm({ mode: 'compose', to: 'dave@w.com', body: 'meeting at 3', from_addr: FROM, sent_maildir: SENT, dry_run: true })
  assert.ok(readFileSync(cmp.sent_path, 'utf8').includes('Subject: meeting at 3'), 'compose: auto-subject from body')
  let threw = false
  try { execFileSync(PY, [SM], { input: JSON.stringify({ mode: 'compose', to: 'bad', body: 'x', from_addr: FROM, dry_run: true }), encoding: 'utf8' }) } catch { threw = true }
  assert.ok(threw, 'bad recipient loud-fails')
  // a Sent-FILING failure must NOT surface as a send-failure (else a retry duplicates the real email)
  const bad = sm({ mode: 'compose', to: 'x@y.com', body: 'hi', from_addr: FROM, sent_maildir: '/proc/g2cc-cannot-create', dry_run: true })
  assert.equal(bad.sent_path, null, 'a Sent-filing failure → sent_path=null, no crash/send-failure')
  console.error('  2. send_mail dry-run: reply threading + forward + compose + bad-recipient + Sent-filing-failure-is-not-send-failure ✓')

  // === 3. MailWindow state machine (stubbed subprocesses) ===
  const { WindowManager } = await import('../dist/os-windows.js')
  const wm = new WindowManager({
    send: () => {}, audio: () => {}, displayReload: () => {}, log: () => {},
    pool: { count: 0 }, config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions', quickPrompts: [] } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  try {
    const mail = wm.windows.find((w) => w.id === 'mail')
    const imgPath = join(sb, 'p.png'); writeFileSync(imgPath, PNG)
    const calls = []
    mail.runMaildir = async (a) => {
      calls.push(a[0])
      if (a[0] === 'list') return JSON.stringify({ total: 1, unreadTotal: 1, rows: [{ key: 'K1', from: 'Bob', subject: 'status', date: 0, unread: true }] })
      if (a[0] === 'read') return JSON.stringify({ from: 'Bob <bob@y.com>', to: 'adam', subject: 'status', date: 'd', body: 'hi', message_id: '<m1@y.com>', images: [{ path: imgPath, name: 'p.png' }] })
      if (a[0] === 'senders') return JSON.stringify({ senders: [{ name: 'Bob', address: 'bob@y.com' }] })
      return JSON.stringify({ key: a[2], already: false, trashed: '/t/x' })
    }
    const sends = []
    mail.runSend = async (req) => { sends.push(req); return { to: req.to ?? 'bob@y.com', sent: false, sent_path: '/sent/x' } }

    // image pages: open K1 via the list tap → pages include a trailing image page
    await mail.view()                       // refresh() populates rows from the stub
    await mail.onBrowseSelect(0)            // open K1
    assert.equal(mail.level, 'read')
    assert.ok(mail.pages.some((p) => typeof p === 'object' && p.kind === 'image'), 'read view has a trailing image page (PAGE-2)')

    // Reply: dictate body → confirm → send
    await mail.onMenuSelect('Reply'); assert.equal(mail.listening, true, 'Reply starts body dictation')
    await mail.onMenuSelect('Done'); assert.equal(mail.transcribing, true)
    await mail.onStt('on it, shipping today'); assert.equal(mail.pendingText, 'on it, shipping today')
    await mail.onMenuSelect('Confirm')
    assert.deepEqual({ m: sends.at(-1).mode, k: sends.at(-1).key, b: sends.at(-1).body }, { m: 'reply', k: 'K1', b: 'on it, shipping today' }, 'Reply send request')

    // Forward: pick recipient → confirm → send
    mail.level = 'read'; mail.readKey = 'K1'
    await mail.onMenuSelect('Forward'); assert.equal(mail.composeStage, 'pickRecipient', 'Forward → recipient pick')
    await mail.onBrowseSelect(0); assert.equal(mail.composeStage, 'confirm', 'pick → recipient confirm')
    await mail.onMenuSelect('Confirm')
    assert.deepEqual({ m: sends.at(-1).mode, to: sends.at(-1).to }, { m: 'forward', to: 'bob@y.com' }, 'Forward send request')

    // long body PAGINATES the confirm card (review fix: was an unpaginated wall-crash that lost the body)
    mail.level = 'read'; mail.readKey = 'K1'
    await mail.onMenuSelect('Reply'); await mail.onMenuSelect('Done')
    const longBody = 'sentence number twelve here. '.repeat(60)   // ~1700 chars → multi-page
    await mail.onStt(longBody)
    const cv = await mail.view()
    assert.ok(cv.menu.includes('Next') && /\d+\/\d+/.test(cv.title), 'long body confirm card paginates (Next + page count)')
    await mail.onMenuSelect('Confirm')
    assert.equal(sends.at(-1).body, longBody.trim(), 'the FULL body sends (display paginates, send is complete)')

    // Compose from the list: pick → dictate body → confirm → send → LIST (not a stale readKey)
    mail.level = 'list'
    await mail.onMenuSelect('Compose'); assert.equal(mail.composeStage, 'pickRecipient', 'Compose → recipient pick')
    await mail.onBrowseSelect(0); assert.equal(mail.listening, true, 'pick → body dictation')
    await mail.onMenuSelect('Done'); await mail.onStt('lunch tomorrow?')
    await mail.onMenuSelect('Confirm')
    assert.deepEqual({ m: sends.at(-1).mode, to: sends.at(-1).to, b: sends.at(-1).body }, { m: 'compose', to: 'bob@y.com', b: 'lunch tomorrow?' }, 'Compose send request')
    assert.equal(mail.level, 'list', 'compose returns to LIST (no stale readKey for Reply/Del to act on)')

    // Del: Cancel-first confirm → Delete
    mail.level = 'read'; mail.readKey = 'K1'
    await mail.onMenuSelect('Del'); assert.equal(mail.level, 'confirmDel')
    assert.equal((await mail.view()).menu[0], 'Cancel', 'delete confirm is Cancel-FIRST')
    calls.length = 0
    await mail.onMenuSelect('Delete'); assert.ok(calls.includes('del') && mail.level === 'list', 'Delete → Trash + back to list')

    // Unread
    mail.level = 'read'; mail.readKey = 'K1'; calls.length = 0
    await mail.onMenuSelect('Unread'); assert.ok(calls.includes('mark_unread') && mail.level === 'list', 'Unread → mark_unread + list')
    console.error('  3. MailWindow: image pages, Reply/Forward/Compose send routing, Del (Cancel-first), Unread ✓')
  } finally {
    wm.dispose()
  }
} finally {
  rmSync(sb, { recursive: true, force: true })
}
console.log('phase8b-mail: ALL OK')
