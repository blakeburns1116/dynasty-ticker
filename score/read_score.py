#!/usr/bin/env python3
"""
read_score.py — read the EA College Football score bug off a single stream frame.

Usage:
    python3 read_score.py FRAME.jpg [--template template.json] [--debug]

Prints one line of JSON:
    {"ok": true, "away":"GASO","awayScore":14,"home":"UTSA","homeScore":21,
     "quarter":"2ND","clock":"12:34","confidence":0.82}
or {"ok": false, "reason": "no scoreboard detected"} when it can't read one
(menus, replays, cutscenes, webcam covering the bug, etc.).

The scoreboard layout is defined in template.json as FRACTIONS of the frame
(0..1), so one template works across 720p/900p/1080p. It ships with a sensible
default for the bottom-left EA score bug, but MUST be calibrated against a real
frame from your streams — see calibrate.py.
"""
import sys, json, re, argparse, os
import cv2
import numpy as np
import pytesseract

HERE = os.path.dirname(os.path.abspath(__file__))

# Default layout. Each field is [x, y, w, h] as fractions of the whole frame.
# These are starting estimates for the horizontal score bug EA parks at the
# lower-left. Real streams vary, so calibrate.py overwrites these.
DEFAULT_TEMPLATE = {
    "note": "fractional [x,y,w,h] boxes; calibrate against a real frame",
    "fields": {
        "away":      [0.050, 0.905, 0.060, 0.045],
        "awayScore": [0.112, 0.905, 0.035, 0.045],
        "home":      [0.050, 0.945, 0.060, 0.045],
        "homeScore": [0.112, 0.945, 0.035, 0.045],
        "quarter":   [0.150, 0.905, 0.055, 0.045],
        "clock":     [0.150, 0.945, 0.070, 0.045]
    }
}

QUARTERS = {"1ST", "2ND", "3RD", "4TH", "OT", "HALF", "FINAL"}


def load_template(path):
    if path and os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return DEFAULT_TEMPLATE


def crop_frac(img, box):
    h, w = img.shape[:2]
    x, y, bw, bh = box
    x0, y0 = int(x * w), int(y * h)
    x1, y1 = int((x + bw) * w), int((y + bh) * h)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)
    if x1 <= x0 or y1 <= y0:
        return None
    return img[y0:y1, x0:x1]


def prep(cell, invert_auto=True, scale=4):
    """Grayscale, upscale, and threshold a small cell for OCR."""
    g = cv2.cvtColor(cell, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    g = cv2.GaussianBlur(g, (3, 3), 0)
    _, th = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Tesseract wants dark text on a light background. Score bugs are usually
    # light text on dark, which Otsu renders as white-on-black (mostly black).
    # If the cell is mostly dark, flip it so the background is white.
    if invert_auto and np.mean(th) < 127:
        th = cv2.bitwise_not(th)
    # pad so glyphs aren't touching the edge
    th = cv2.copyMakeBorder(th, 10, 10, 10, 10, cv2.BORDER_CONSTANT, value=255)
    return th


WHITELIST = {
    # allow letters that EA's stylized digits get misread as, then map them back
    # in parse_int (O->0 is very common for a lone zero score).
    "digits": "0123456789OolIiSB",
    "clock": "0123456789:OolIi",
    "alpha": "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "quarter": "0123456789STNDRDTHOTHALFIN",
}

# common OCR confusions for glyph->digit on the EA scoreboard font
DIGIT_FIX = str.maketrans({"O": "0", "o": "0", "l": "1", "I": "1", "i": "1", "S": "5", "B": "8"})

def _ocr_once(img, kind, psm):
    wl = WHITELIST.get(kind)
    cfg = f"--psm {psm}"
    if wl:
        cfg += f" -c tessedit_char_whitelist={wl}"
    data = pytesseract.image_to_data(img, config=cfg, output_type=pytesseract.Output.DICT)
    words, confs = [], []
    for t, c in zip(data["text"], data["conf"]):
        t = t.strip()
        if t:
            words.append(t)
            try:
                cv = float(c)
            except ValueError:
                cv = -1
            if cv >= 0:
                confs.append(cv)
    text = "".join(words)
    conf = (sum(confs) / len(confs) / 100.0) if confs else 0.0
    return text, conf


def ocr(cell, kind):
    """OCR a cell, trying several page-segmentation modes and keeping the best.
    Single-line (7), single-word (8), and block (6) each fail on different real
    stream frames, so we take the highest-confidence non-empty read."""
    if cell is None or cell.size == 0:
        return "", 0.0
    img = prep(cell)
    best_text, best_conf = "", 0.0
    for psm in (7, 8, 6):
        text, conf = _ocr_once(img, kind, psm)
        if text and conf > best_conf:
            best_text, best_conf = text, conf
    return best_text, best_conf


def parse_int(s):
    s = s.translate(DIGIT_FIX)
    s = re.sub(r"\D", "", s)
    return int(s) if s.isdigit() else None


def norm_clock(s):
    s = s.replace(" ", "").translate(DIGIT_FIX)
    m = re.search(r"(\d{1,2}):(\d{2})", s)
    if not m:
        # OCR often drops the colon ("318" -> 3:18, "1205" -> 12:05)
        digits = re.sub(r"\D", "", s)
        if len(digits) == 3:
            m = re.match(r"(\d)(\d{2})", digits)
        elif len(digits) == 4:
            m = re.match(r"(\d{2})(\d{2})", digits)
    if m:
        mm, ss = int(m.group(1)), int(m.group(2))
        if 0 <= mm <= 15 and 0 <= ss <= 59:
            return f"{mm}:{ss:02d}"
    return None


def norm_quarter(s):
    s = s.upper()
    # find an ordinal like 1ST/2ND/3RD/4TH anywhere in the (often noisy) text
    m = re.search(r"([1-4])\s*(ST|ND|RD|TH)", s)
    if m:
        return f"{m.group(1)}{m.group(2)}"
    s2 = s.replace(" ", "")
    for q in QUARTERS:
        if q in s2:
            return q
    return None


def read(path, template):
    img = cv2.imread(path)
    if img is None:
        return {"ok": False, "reason": f"could not open image: {path}"}
    f = template["fields"]

    away, ca = ocr(crop_frac(img, f["away"]), "alpha")
    home, ch = ocr(crop_frac(img, f["home"]), "alpha")
    asc, cas = ocr(crop_frac(img, f["awayScore"]), "digits")
    hsc, chs = ocr(crop_frac(img, f["homeScore"]), "digits")
    qtr, cq = ocr(crop_frac(img, f["quarter"]), "quarter")
    clk, cc = ocr(crop_frac(img, f["clock"]), "clock")

    away_score = parse_int(asc)
    home_score = parse_int(hsc)
    clock = norm_clock(clk)
    quarter = norm_quarter(qtr)

    # Gameplay sanity gate: a real score bug shows a clock AND at least one score.
    # If neither reads, we're almost certainly not looking at live gameplay.
    if clock is None and away_score is None and home_score is None:
        return {"ok": False, "reason": "no scoreboard detected (menu/replay/covered?)"}

    confidence = round(
        sum([ca, ch, cas, chs, cq, cc]) / 6.0, 2
    )
    return {
        "ok": True,
        "away": away or None,
        "awayScore": away_score,
        "home": home or None,
        "homeScore": home_score,
        "quarter": quarter,
        "clock": clock,
        "confidence": confidence,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frame")
    ap.add_argument("--template", default=os.path.join(HERE, "template.json"))
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()
    tpl = load_template(args.template)
    result = read(args.frame, tpl)
    print(json.dumps(result))
    if args.debug:
        sys.stderr.write(f"template: {args.template}\n")


if __name__ == "__main__":
    main()
