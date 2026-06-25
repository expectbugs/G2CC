#!/usr/bin/env python3
"""EPUB reader helper for the DE Reader window (upgrades.md Phase 7).

ebooklib 0.20 API verified live 2026-06-11 (B9): spine = [(idref, linear)],
documents are ITEM_DOCUMENT items, toc entries are Link / (Section, children)
with .href/.title. Chapters = spine-ordered document items (front matter
included — navigable, never dropped); titles resolve toc-href → title with a
positional fallback. html→text follows read_maildir.py's approach. Loud-fails
to stderr + exit 1.

Usage:
  read_epub.py list <book.epub>
      -> JSON {"title": str, "chapters": [{"idx": int, "title": str}]}
  read_epub.py read <book.epub> <idx>
      -> JSON {"title": str, "chapterTitle": str, "text": str}   (NO truncation)
  read_epub.py pages <book.epub>
      -> JSON {"title": str, "chapters": [{"idx": int, "title": str, "text": str}]}
      EVERY chapter's text in ONE parse (the server paginates each → the
      absolute whole-book page map). Same text the per-chapter `read` returns,
      so page counts match what reading shows.   (NO truncation)
"""
import html.parser
import io
import json
import sys
import warnings

warnings.filterwarnings("ignore")  # ebooklib future-option warnings are noise here

import ebooklib
from ebooklib import epub


class _HtmlText(html.parser.HTMLParser):
    """Crude HTML -> text: drops tags/scripts, keeps text + line breaks
    (read_maildir.py's approach, plus heading spacing for book chapters)."""
    SKIP = {"script", "style", "head"}
    BREAK = {"p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "blockquote", "section"}

    def __init__(self):
        super().__init__()
        self.out = io.StringIO()
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag in self.BREAK:
            self.out.write("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip > 0:
            self._skip -= 1
        elif tag in ("h1", "h2", "h3", "h4", "h5", "p"):
            self.out.write("\n")

    def handle_data(self, data):
        if self._skip == 0:
            self.out.write(data)


def html_to_text(s):
    p = _HtmlText()
    p.feed(s)
    text = p.out.getvalue()
    lines = [ln.strip() for ln in text.split("\n")]
    out = []
    blank = 0
    for ln in lines:
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


def toc_titles(book):
    """href (fragment-stripped) -> toc title, walking nested sections."""
    out = {}

    def walk(items):
        for it in items:
            if isinstance(it, tuple) and len(it) == 2:
                sec, children = it
                href = getattr(sec, "href", None)
                title = getattr(sec, "title", None)
                if href and title:
                    out.setdefault(href.split("#")[0], title)
                walk(children)
            else:
                href = getattr(it, "href", None)
                title = getattr(it, "title", None)
                if href and title:
                    out.setdefault(href.split("#")[0], title)

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


def cmd_list(path):
    book = epub.read_epub(path)
    titles = toc_titles(book)
    chapters = []
    for i, item in enumerate(spine_documents(book)):
        title = titles.get(item.get_name()) or f"Section {i + 1}"
        chapters.append({"idx": i, "title": " ".join(title.split())})
    print(json.dumps({"title": book_title(book), "chapters": chapters}))


def cmd_read(path, idx):
    book = epub.read_epub(path)
    docs = spine_documents(book)
    if idx < 0 or idx >= len(docs):
        raise IndexError(f"chapter {idx} out of range (0..{len(docs) - 1})")
    item = docs[idx]
    text = html_to_text(item.get_content().decode("utf-8", errors="replace"))
    title = toc_titles(book).get(item.get_name()) or f"Section {idx + 1}"
    print(json.dumps({
        "title": book_title(book),
        "chapterTitle": " ".join(title.split()),
        "text": text or "(this section has no text)",
    }))


def cmd_pages(path):
    book = epub.read_epub(path)
    titles = toc_titles(book)
    chapters = []
    for i, item in enumerate(spine_documents(book)):
        title = titles.get(item.get_name()) or f"Section {i + 1}"
        text = html_to_text(item.get_content().decode("utf-8", errors="replace"))
        chapters.append({
            "idx": i,
            "title": " ".join(title.split()),
            "text": text or "(this section has no text)",  # same placeholder as cmd_read → counts match
        })
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
