#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_docx.py — zero-dependency JSON -> Microsoft Word (.docx) generator.

Part of the orion skill `generate-project-writeup`. Turns a structured JSON
"report data" file into a styled .docx using ONLY the Python standard library
(zipfile + string templating of OOXML). No python-docx, no pandoc, no Word
install required — runs on any machine with Python 3.8+.

Usage:
    python build_docx.py <report-data.json> <output.docx>

The JSON contract (see SKILL.md for the authoring guide):

{
  "blocks": [
    { "type": "title_block",
      "banner":   "ORG  |  PROGRAMME",            # small caps eyebrow (optional)
      "title":    "Project Name",                  # big title
      "codename": "Codename (optional)",           # shown under title (optional)
      "subtitle": "One-line description",           # optional
      "fields":   [["Business Unit","..."], ["Date","..."], ["Owner","..."]],
      "report_type": "AI-Assisted Development — Project Summary Report",  # optional
      "confidential": "CONFIDENTIAL — internal use only"                  # optional, red
    },

    { "type": "toc" },                              # Word table-of-contents field
    { "type": "page_break" },

    { "type": "heading", "level": 1, "text": "Financial Summary" },
    { "type": "paragraph", "text": "Body text.", "style": "normal|note|confidential" },
    { "type": "paragraph", "runs": [ {"text":"bold ","bold":true}, {"text":"plain"} ] },
    { "type": "bullets", "items": ["first", "second"] },

    { "type": "table",
      "caption": "Table 1 — Cost Comparison",       # optional bold caption above table
      "headers": ["Approach", "Team Size", "Duration", "Cost"],
      "rows":    [ ["...","...","...","..."], ... ],
      "bold_first_col": false,                       # optional
      "emphasize_last_row": false,                   # optional (e.g. a Savings / total row)
      "widths":  [40, 20, 20, 20]                    # optional column weights (any units)
    }
  ]
}

Cell text and paragraph text may contain "\n" to split into multiple lines.
"""

import json
import sys
import zipfile
from xml.sax.saxutils import escape

# ---------------------------------------------------------------------------
# Palette (hex, no leading #)
# ---------------------------------------------------------------------------
BRAND      = "1E3A8A"   # deep blue — H1 / title / table header fill
ACCENT     = "2563EB"   # blue — H2
INK        = "1F2937"   # body text
MUTED      = "6B7280"   # eyebrow / notes
HEADER_TXT = "FFFFFF"   # table header text
ZEBRA      = "EEF2FB"   # alt row fill
BORDER     = "D1D5DB"   # table borders
CONFID     = "B91C1C"   # confidential red
RULE       = "1E3A8A"   # title rule


def esc(s):
    return escape(str(s) if s is not None else "")


# ---------------------------------------------------------------------------
# Low-level run / paragraph helpers
# ---------------------------------------------------------------------------
def _rpr(bold=False, italic=False, color=None, size=None, caps=False, font=None):
    p = []
    if font:
        p.append('<w:rFonts w:ascii="%s" w:hAnsi="%s"/>' % (font, font))
    if bold:
        p.append("<w:b/>")
    if italic:
        p.append("<w:i/>")
    if caps:
        p.append("<w:smallCaps/>")
    if color:
        p.append('<w:color w:val="%s"/>' % color)
    if size:  # size in points -> half-points
        p.append('<w:sz w:val="%d"/>' % (size * 2))
    return "<w:rPr>%s</w:rPr>" % "".join(p) if p else ""


def _run(text, **kw):
    # split on newlines, inserting <w:br/> between lines
    parts = str(text).split("\n")
    rpr = _rpr(**kw)
    out = []
    for i, part in enumerate(parts):
        if i:
            out.append('<w:r>%s<w:br/></w:r>' % rpr)
        out.append('<w:r>%s<w:t xml:space="preserve">%s</w:t></w:r>' % (rpr, esc(part)))
    return "".join(out)


def _ppr(style=None, align=None, before=0, after=140, outline=None,
         border_bottom=False, keep_next=False, shade=None):
    p = []
    if style:
        p.append('<w:pStyle w:val="%s"/>' % style)
    if keep_next:
        p.append("<w:keepNext/>")
    if shade:
        p.append('<w:shd w:val="clear" w:color="auto" w:fill="%s"/>' % shade)
    if border_bottom:
        p.append('<w:pBdr><w:bottom w:val="single" w:sz="12" w:space="6" '
                 'w:color="%s"/></w:pBdr>' % RULE)
    p.append('<w:spacing w:before="%d" w:after="%d"/>' % (before, after))
    if outline is not None:
        p.append('<w:outlineLvl w:val="%d"/>' % outline)
    if align:
        p.append('<w:jc w:val="%s"/>' % align)
    return "<w:pPr>%s</w:pPr>" % "".join(p)


def _para(runs_xml, **ppr_kw):
    return "<w:p>%s%s</w:p>" % (_ppr(**ppr_kw), runs_xml)


# ---------------------------------------------------------------------------
# Block builders
# ---------------------------------------------------------------------------
def block_title_block(b):
    out = []
    if b.get("banner"):
        out.append(_para(_run(b["banner"], bold=True, color=MUTED, size=10, caps=True),
                         align="center", after=80))
    out.append(_para(_run(b.get("title", ""), bold=True, color=BRAND, size=30),
                     align="center", after=40))
    if b.get("codename"):
        out.append(_para(_run(b["codename"], italic=True, color=ACCENT, size=14),
                         align="center", after=60))
    if b.get("subtitle"):
        out.append(_para(_run(b["subtitle"], color=INK, size=13),
                         align="center", after=160, border_bottom=True))
    else:
        out.append(_para("", align="center", after=120, border_bottom=True))
    for label, value in b.get("fields", []):
        runs = _run(label + ":  ", bold=True, color=INK, size=11) + \
               _run(value, color=INK, size=11)
        out.append(_para(runs, align="center", after=40))
    if b.get("report_type"):
        out.append(_para(_run(b["report_type"], bold=True, color=ACCENT, size=12),
                         align="center", before=120, after=40))
    if b.get("confidential"):
        out.append(_para(_run(b["confidential"], bold=True, color=CONFID, size=10, caps=True),
                         align="center", after=120))
    return "".join(out)


def block_heading(b):
    level = max(1, min(3, int(b.get("level", 1))))
    color = BRAND if level == 1 else (ACCENT if level == 2 else INK)
    size = {1: 18, 2: 14, 3: 12}[level]
    return _para(_run(b.get("text", ""), bold=True, color=color, size=size),
                 style="Heading%d" % level, outline=level - 1,
                 before=240 if level == 1 else 160, after=80, keep_next=True)


def block_paragraph(b):
    style = b.get("style", "normal")
    if "runs" in b:
        runs = "".join(_run(r.get("text", ""), bold=r.get("bold", False),
                            italic=r.get("italic", False), color=r.get("color"),
                            size=r.get("size")) for r in b["runs"])
        return _para(runs, after=140)
    text = b.get("text", "")
    if style == "note":
        return _para(_run(text, italic=True, color=MUTED, size=10), after=140)
    if style == "confidential":
        return _para(_run(text, bold=True, color=CONFID, size=10), after=140)
    return _para(_run(text, color=INK), after=140)


def block_bullets(b):
    out = []
    for item in b.get("items", []):
        runs = _run("•   ", color=ACCENT) + _run(item, color=INK)
        out.append(_para(runs, after=60, before=0))
    return "".join(out)


def block_page_break(b):
    return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'


def block_toc(b):
    title = _para(_run(b.get("title", "Contents"), bold=True, color=BRAND, size=16),
                  outline=0, after=80, keep_next=True)
    instr = ' TOC \\o "1-3" \\h \\z \\u '
    field = ('<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>'
             '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
             '<w:r><w:instrText xml:space="preserve">%s</w:instrText></w:r>'
             '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
             '<w:r><w:rPr><w:i/><w:color w:val="%s"/></w:rPr>'
             '<w:t xml:space="preserve">Right-click here and choose '
             '&quot;Update Field&quot; to build the table of contents.</w:t></w:r>'
             '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' % (esc(instr), MUTED))
    return title + field


def _cell(text, *, width=None, fill=None, bold=False, color=INK, align=None):
    tcpr = ['<w:tcW w:w="%d" w:type="%s"/>' % (
        (width or 0), "pct" if width else "auto")]
    if fill:
        tcpr.append('<w:shd w:val="clear" w:color="auto" w:fill="%s"/>' % fill)
    tcpr.append('<w:vAlign w:val="center"/>')
    tcpr.append('<w:tcMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/>'
                '<w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar>')
    runs = _run(text, bold=bold, color=color, size=10)
    p = _para(runs, before=0, after=0, align=align)
    return "<w:tc><w:tcPr>%s</w:tcPr>%s</w:tc>" % ("".join(tcpr), p)


def block_table(b):
    out = []
    if b.get("caption"):
        out.append(_para(_run(b["caption"], bold=True, color=INK, size=11),
                         before=120, after=40, keep_next=True))
    headers = b.get("headers", [])
    rows = b.get("rows", [])
    ncol = len(headers) or (len(rows[0]) if rows else 1)

    widths = b.get("widths")
    if widths and len(widths) == ncol:
        total = float(sum(widths)) or 1.0
        pct = [int(round(5000 * w / total)) for w in widths]
    else:
        pct = [int(round(5000 / ncol))] * ncol

    grid = "".join('<w:gridCol w:w="%d"/>' % (9000 // ncol) for _ in range(ncol))
    borders = ("<w:tblBorders>"
               + "".join('<w:%s w:val="single" w:sz="4" w:space="0" w:color="%s"/>' % (e, BORDER)
                         for e in ("top", "left", "bottom", "right", "insideH", "insideV"))
               + "</w:tblBorders>")
    tblpr = ('<w:tblPr><w:tblStyle w:val="TableGrid"/>'
             '<w:tblW w:w="5000" w:type="pct"/>%s'
             '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" '
             'w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>' % borders)

    trs = []
    if headers:
        cells = "".join(_cell(h, width=pct[i], fill=BRAND, bold=True,
                              color=HEADER_TXT, align="left")
                        for i, h in enumerate(headers))
        trs.append('<w:tr><w:trPr><w:tblHeader/></w:trPr>%s</w:tr>' % cells)

    last = len(rows) - 1
    for ri, row in enumerate(rows):
        zebra = ZEBRA if (ri % 2 == 1) else None
        emph = b.get("emphasize_last_row") and ri == last
        fill = BRAND if emph else zebra
        txtcolor = HEADER_TXT if emph else INK
        cells = []
        for ci in range(ncol):
            val = row[ci] if ci < len(row) else ""
            bold = emph or (b.get("bold_first_col") and ci == 0)
            cells.append(_cell(val, width=pct[ci], fill=fill, bold=bold,
                               color=txtcolor, align="left"))
        trs.append("<w:tr>%s</w:tr>" % "".join(cells))

    out.append('<w:tbl>%s<w:tblGrid>%s</w:tblGrid>%s</w:tbl>'
               % (tblpr, grid, "".join(trs)))
    out.append(_para("", before=0, after=80))  # spacer after table
    return "".join(out)


BUILDERS = {
    "title_block": block_title_block,
    "heading": block_heading,
    "paragraph": block_paragraph,
    "bullets": block_bullets,
    "page_break": block_page_break,
    "toc": block_toc,
    "table": block_table,
}


# ---------------------------------------------------------------------------
# Package parts
# ---------------------------------------------------------------------------
CONTENT_TYPES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>'''

RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''

DOC_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>'''

# updateFields makes Word offer to refresh the TOC on open
SETTINGS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:updateFields w:val="true"/>
</w:settings>'''


def styles_xml():
    def h(idx, name, size, color):
        return ('<w:style w:type="paragraph" w:styleId="Heading%d">'
                '<w:name w:val="heading %d"/><w:basedOn w:val="Normal"/>'
                '<w:next w:val="Normal"/><w:qFormat/>'
                '<w:pPr><w:keepNext/><w:outlineLvl w:val="%d"/>'
                '<w:spacing w:before="240" w:after="80"/></w:pPr>'
                '<w:rPr><w:b/><w:color w:val="%s"/><w:sz w:val="%d"/></w:rPr>'
                '</w:style>' % (idx, idx, idx - 1, color, size * 2))
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:docDefaults><w:rPrDefault><w:rPr>'
            '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>'
            '<w:color w:val="%s"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>'
            '<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/>'
            '</w:pPr></w:pPrDefault></w:docDefaults>'
            '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">'
            '<w:name w:val="Normal"/><w:qFormat/></w:style>'
            + h(1, "Heading1", 18, BRAND) + h(2, "Heading2", 14, ACCENT)
            + h(3, "Heading3", 12, INK)
            + '<w:style w:type="table" w:default="1" w:styleId="TableGrid">'
              '<w:name w:val="Table Grid"/><w:tblPr></w:tblPr></w:style>'
            + '</w:styles>') % INK


def document_xml(blocks):
    body = []
    for b in blocks:
        fn = BUILDERS.get(b.get("type"))
        if fn:
            body.append(fn(b))
    sect = ('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
            '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
            'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>')
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<w:body>%s%s</w:body></w:document>' % ("".join(body), sect))


def build(data, out_path):
    blocks = data.get("blocks", [])
    parts = {
        "[Content_Types].xml": CONTENT_TYPES,
        "_rels/.rels": RELS,
        "word/_rels/document.xml.rels": DOC_RELS,
        "word/document.xml": document_xml(blocks),
        "word/styles.xml": styles_xml(),
        "word/settings.xml": SETTINGS,
    }
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in parts.items():
            z.writestr(name, content.encode("utf-8"))


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: python build_docx.py <data.json> <out.docx>\n")
        return 2
    with open(argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)
    build(data, argv[2])
    sys.stdout.write("Wrote %s (%d blocks)\n" % (argv[2], len(data.get("blocks", []))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
