#!/usr/bin/env python3
"""PDF sidecar for dsh-ailearn.

Everything the plugin needs from a PDF, without any Node dependency:
  probe   <pdf>                         -> page count, page size, text-layer coverage, outline
  render  <pdf> <first> <last> <dpi> <quality> <outdir>
                                        -> one JPEG per page + a manifest on stdout

All output is a single JSON object on stdout. Errors go to stderr with a
non-zero exit code, so the caller can surface the reason verbatim.
"""
import io
import json
import os
import sys


def _load_pymupdf():
    try:
        import pymupdf as fitz  # 1.24+
        return fitz
    except Exception:
        pass
    try:
        import fitz  # legacy name
        return fitz
    except Exception as exc:
        raise RuntimeError(
            "PyMuPDF is not importable in this Python: %s. "
            "Install it with: %s -m pip install pymupdf" % (exc, sys.executable)
        )


def cmd_probe(argv):
    path = argv[0]
    fitz = _load_pymupdf()
    doc = fitz.open(path)
    total = doc.page_count
    sample = list(range(0, total, max(1, total // 40)))[:40]
    with_text = 0
    for i in sample:
        try:
            if doc[i].get_text().strip():
                with_text += 1
        except Exception:
            pass
    first = doc[0].rect if total else None
    outline = []
    try:
        for level, title, page in doc.get_toc(simple=True):
            outline.append({"level": level, "title": title, "pdfPage": page})
    except Exception:
        pass
    return {
        "ok": True,
        "pageCount": total,
        "widthPt": round(first.width, 2) if first else None,
        "heightPt": round(first.height, 2) if first else None,
        "sampledPages": len(sample),
        "sampledWithText": with_text,
        "hasTextLayer": with_text > 0,
        "outline": outline[:400],
        "python": sys.executable,
    }


def cmd_render(argv):
    path, first, last, dpi, quality, outdir = argv[0], int(argv[1]), int(argv[2]), int(argv[3]), int(argv[4]), argv[5]
    prefix = argv[6] if len(argv) > 6 else "p"
    fitz = _load_pymupdf()
    doc = fitz.open(path)
    last = min(last, doc.page_count - 1)
    first = max(first, 0)
    os.makedirs(outdir, exist_ok=True)
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    pages = []
    for index in range(first, last + 1):
        page = doc[index]
        pix = page.get_pixmap(matrix=mat)
        img = pix.tobytes("jpeg", jpg_quality=quality) if _supports_quality(pix) else pix.tobytes("jpeg")
        name = "%s%04d.jpg" % (prefix, index + 1)
        full = os.path.join(outdir, name)
        with open(full, "wb") as handle:
            handle.write(img)
        pages.append({
            "index": index,
            "file": full,
            "bytes": len(img),
            "width": pix.width,
            "height": pix.height,
        })
    return {"ok": True, "pages": pages, "dpi": dpi}


def _supports_quality(pix):
    try:
        pix.tobytes("jpeg", jpg_quality=80)
        return True
    except TypeError:
        return False


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: pdfkit.py <probe|render> ..."}))
        return 2
    cmd = sys.argv[1]
    argv = sys.argv[2:]
    try:
        if cmd == "probe":
            result = cmd_probe(argv)
        elif cmd == "render":
            result = cmd_render(argv)
        else:
            result = {"ok": False, "error": "unknown command: %s" % cmd}
    except Exception as exc:
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())