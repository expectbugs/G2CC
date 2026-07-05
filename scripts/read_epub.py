#!/usr/bin/env python3
"""EPUB reader helper for the DE Reader window (upgrades.md Phase 7; the
"sovereign chapters" remodel 2026-07-01).

Chapters = the book's OWN declared structure. The TOC (NCX navMap / EPUB3 nav)
is walked depth-first into an ORDERED, fragment-aware list; each spine document
is then SPLIT at its TOC anchor points (`<... id="frag">`) into the real
narrative chapters. So an omnibus whose 3 novels are one big XHTML blob each
becomes its ~150 real chapters ("33. Juniper: Death Pays"), not 3 giant
sections. Books whose TOC is coarse (file-level only) degrade gracefully to the
spine items — exactly the pre-remodel behaviour.

Format is preserved to what a text display can honour: scene breaks (<hr>, or a
paragraph whose class marks it a break/ornament, or a symbols-only line) render
as a "·  ·  ·" divider; chapter-heading paragraphs (h1..h6, or class cn/ct)
render as heading lines. Italics/bold flatten to plain text (a mono display has
no faces) — the words are never dropped. NO truncation. Loud-fails to stderr.

ebooklib 0.20 API (verified 2026-06-11 / re-verified 2026-07-01): spine =
[(idref, linear)]; ITEM_DOCUMENT items; book.toc = nested Links / (Section,
children) with .href/.title.

Usage:
  read_epub.py list <book.epub>
      -> {"title": str, "chapters": [{"idx": int, "title": str}]}
  read_epub.py read <book.epub> <idx>
      -> {"title": str, "chapterTitle": str, "text": str}   (NO truncation)
  read_epub.py pages <book.epub>
      -> {"title": str, "chapters": [{"idx": int, "title": str, "text": str}]}
      EVERY chapter's text in ONE parse (the server paginates each -> the
      whole-book page map). Same text `read` returns, so counts match.
"""
from html.parser import HTMLParser
import io
import json
import posixpath
import re
import sys
import warnings

warnings.filterwarnings("ignore")  # ebooklib future-option warnings are noise here

import ebooklib
from ebooklib import epub

DIVIDER = "·  ·  ·"   # the rendered scene break (· is firmware-safe)
HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
# A whole line that is ONLY ornament/separator glyphs (a "* * *" dinkus, an <hr>, a
# dash rule) IS a scene break — detected by CONTENT, NEVER by class. Class-based
# detection is unsafe: some epubs put class="sb" ("scene break") on the PROSE
# paragraph that follows the ornament, so suppressing by class drops real text.
# '.' is deliberately EXCLUDED — a lone "..." is a prose beat, not a scene break. The
# limit is generous (a wide "* * * * * *" dinkus) but symbols-only, so no prose matches.
_SYMBOL_ONLY = re.compile(r"^[\s*#·•◦‣⁂⁃♦▪∗＊﹡\-_~=+]{1,24}$")


class _HtmlText(HTMLParser):
    """HTML -> text: block elements break to newlines, <hr> emits a scene-break line,
    and ALL text is kept (bold/italic faces flatten to plain — a mono display has
    none; the words are never dropped). Scene-break ORNAMENTS are recognised by line
    CONTENT downstream (html_to_text via _SYMBOL_ONLY), never by class, so a prose
    paragraph can never be mistaken for a break and eaten."""

    SKIP = {"script", "style", "head"}
    BREAK = {"p", "br", "div", "li", "tr", "blockquote", "section"} | HEADING_TAGS

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = io.StringIO()
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif self._skip:
            return
        elif tag == "hr":
            self.out.write("\n" + DIVIDER + "\n")
        elif tag in self.BREAK:
            self.out.write("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip > 0:
            self._skip -= 1
        elif self._skip:
            return
        elif tag in HEADING_TAGS or tag == "p":
            self.out.write("\n")

    def handle_data(self, data):
        if self._skip == 0:
            self.out.write(data)


def html_to_text(s):
    p = _HtmlText()
    p.feed(s)
    lines = [ln.strip() for ln in p.out.getvalue().split("\n")]
    out = []
    blank = 0
    for ln in lines:
        if ln and _SYMBOL_ONLY.match(ln):
            # a symbols-only line (a "* * *" dinkus, an <hr>-divider, a dash rule) IS a
            # scene break → the standard divider, standing alone with a blank line each side.
            while out and out[-1] == "":
                out.pop()
            out.append("")
            out.append(DIVIDER)
            out.append("")
            blank = 1
            continue
        if not ln:
            blank += 1
            if blank > 1:
                continue
        else:
            blank = 0
        out.append(ln)
    return "\n".join(out).strip()


def book_title(book):
    meta = book.get_metadata("DC", "title")
    return meta[0][0] if meta else "(untitled)"


def _norm(name):
    """Normalise an href/item name for matching: strip a leading path so
    'OEBPS/xhtml/part2.html' and 'xhtml/part2.html' both key on 'part2.html'."""
    return (name or "").split("/")[-1]


def _norm_path(name):
    """Normalise an href/item PATH for matching, keeping the directory (review
    2026-07-05: basename-only keying merged two same-named files from different
    folders — e.g. book1/c1.xhtml + book2/c1.xhtml in a merged omnibus — into
    ONE anchor list, splitting chapters at the other book's titles)."""
    p = posixpath.normpath((name or "").lstrip("/"))
    return "" if p == "." else p


def toc_entries(book):
    """Depth-first ORDERED list of (file, fragment_or_None, title) from the TOC —
    sections AND leaves, so a novel's own title-page anchor and its chapter
    anchors both appear, in reading order."""
    out = []

    def add(link):
        href = getattr(link, "href", None)
        title = getattr(link, "title", None)
        if not href or not title:
            return
        file, _, frag = href.partition("#")
        out.append((file, frag or None, " ".join(title.split())))

    def walk(items):
        for it in items:
            if isinstance(it, tuple) and len(it) == 2:
                sec, children = it
                add(sec)
                walk(children)
            else:
                add(it)

    walk(book.toc or [])
    return out


def spine_documents(book):
    """Spine-ordered ITEM_DOCUMENT items (reading order)."""
    docs = []
    for idref, _linear in book.spine:
        item = book.get_item_with_id(idref)
        if item is not None and item.get_type() == ebooklib.ITEM_DOCUMENT:
            docs.append(item)
    if not docs:  # malformed spine — fall back to declared documents
        docs = list(book.get_items_of_type(ebooklib.ITEM_DOCUMENT))
    return docs


def _id_offsets(html, ids):
    """Char offset of the '<' opening the element bearing each id (or None).
    Uses a proper HTML parse (attr order/quotes safe), then maps line/col ->
    offset."""
    want = set(ids)
    hits = {}

    class _F(HTMLParser):
        def handle_starttag(self, tag, attrs):
            i = dict(attrs).get("id")
            if i in want and i not in hits:
                hits[i] = self.getpos()   # (line, col) of the '<'

    f = _F()
    f.convert_charrefs = False
    try:
        f.feed(html)
    except Exception:
        pass
    line_start = [0]
    for ln in html.split("\n"):
        line_start.append(line_start[-1] + len(ln) + 1)
    res = {}
    for i in ids:
        pos = hits.get(i)
        res[i] = (line_start[pos[0] - 1] + pos[1]) if pos else None
    return res


def build_chapters(book):
    """Split each spine doc at its TOC anchor points -> the real chapters.
    Returns [(title, text)] in reading order. Front matter / anchorless docs
    stay one chapter each (graceful degrade)."""
    entries = toc_entries(book)
    # full TOC path (normalised, directory KEPT) -> ordered [(fragment_or_None,
    # title)]. Review 2026-07-05: keying by basename alone merged same-named
    # files from different directories into one anchor list.
    by_path = {}
    for file, frag, title in entries:
        by_path.setdefault(_norm_path(file), []).append((frag, title))

    def toc_for_name(raw_name):
        """The TOC bucket for one spine doc: exact normalised path first; else a
        single path-SUFFIX match (TOC hrefs are nav-dir-relative while item
        names are OPF-root-relative — 'xhtml/p2.html' vs 'OEBPS/xhtml/p2.html');
        else an UNAMBIGUOUS basename match (the old tolerance). An ambiguous
        match degrades the doc to anchorless (one chapter) — loud on stderr,
        never a cross-book split."""
        n = _norm_path(raw_name)
        if n in by_path:
            return by_path[n]
        suffix = [k for k in by_path if k.endswith("/" + n) or n.endswith("/" + k)]
        if len(suffix) == 1:
            return by_path[suffix[0]]
        if len(suffix) > 1:
            print(f"read_epub: ambiguous TOC path match for {raw_name!r} ({suffix}) — treating as anchorless", file=sys.stderr)
            return []
        base = _norm(n)
        base_keys = [k for k in by_path if _norm(k) == base]
        if len(base_keys) == 1:
            return by_path[base_keys[0]]
        if len(base_keys) > 1:
            print(f"read_epub: TOC basename {base!r} ambiguous across {base_keys} — treating {raw_name!r} as anchorless", file=sys.stderr)
        return []

    chapters = []
    for si, item in enumerate(spine_documents(book)):
        html = item.get_content().decode("utf-8", errors="replace")
        toc_for = toc_for_name(item.get_name())
        frags = [(f, t) for (f, t) in toc_for if f]      # anchored chapters
        lead_title = next((t for (f, t) in toc_for if not f), None)  # file-level title (novel title page)

        if not frags:
            title = lead_title or f"Section {si + 1}"
            chapters.append((title, html_to_text(html)))
            continue

        offs = _id_offsets(html, [f for f, _ in frags])
        # keep only anchors we actually found, in document order
        found = sorted(((offs[f], f, t) for (f, t) in frags if offs.get(f) is not None),
                       key=lambda x: x[0])
        if not found:   # ids not present (rare) -> whole doc, one chapter; reuse the anchored TOC title if any
            chapters.append((lead_title or frags[0][1] or f"Section {si + 1}", html_to_text(html)))
            continue

        # leading segment (top of the doc -> first anchor) = the novel title page etc.
        first_off = found[0][0]
        if first_off > 0:
            lead = html_to_text(html[:first_off])
            if lead.strip():
                chapters.append((lead_title or f"Section {si + 1}", lead))

        for j, (off, _f, title) in enumerate(found):
            end = found[j + 1][0] if j + 1 < len(found) else len(html)
            chapters.append((title, html_to_text(html[off:end])))

    # never hand back an empty book
    if not chapters:
        chapters = [("(empty book)", "(this book has no readable text)")]
    return chapters


def cmd_list(path):
    book = epub.read_epub(path)
    chapters = [{"idx": i, "title": t} for i, (t, _txt) in enumerate(build_chapters(book))]
    print(json.dumps({"title": book_title(book), "chapters": chapters}))


def cmd_read(path, idx):
    book = epub.read_epub(path)
    chs = build_chapters(book)
    if idx < 0 or idx >= len(chs):
        raise IndexError(f"chapter {idx} out of range (0..{len(chs) - 1})")
    title, text = chs[idx]
    print(json.dumps({
        "title": book_title(book),
        "chapterTitle": title,
        "text": text or "(this chapter has no text)",
    }))


def cmd_pages(path):
    book = epub.read_epub(path)
    chapters = [{"idx": i, "title": t, "text": txt or "(this chapter has no text)"}
                for i, (t, txt) in enumerate(build_chapters(book))]
    print(json.dumps({"title": book_title(book), "chapters": chapters}))


def main():
    if len(sys.argv) < 3:
        raise ValueError("usage: read_epub.py list|pages <book.epub> | read <book.epub> <idx>")
    cmd, path = sys.argv[1], sys.argv[2]
    if cmd == "list":
        cmd_list(path)
    elif cmd == "read":
        cmd_read(path, int(sys.argv[3]))
    elif cmd == "pages":
        cmd_pages(path)
    else:
        raise ValueError(f"unknown command '{cmd}'")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud
        sys.stderr.write(f"read_epub error: {e}\n")
        sys.exit(1)
