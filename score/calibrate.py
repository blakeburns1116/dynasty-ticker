#!/usr/bin/env python3
"""
calibrate.py — line up the score-bug read-boxes with a REAL frame.

Why this exists: the reader only works if template.json's boxes sit right on top
of where EA draws each number. This tool draws the current boxes onto your real
frame so you can see the fit, tweak the numbers in template.json, and re-run until
each box hugs its field. Then it OCRs the frame so you can confirm the read.

Usage:
    python3 calibrate.py real_frame.jpg
        -> writes calibrated_overlay.png (open it and look)
        -> prints what the reader currently extracts

Workflow:
    1. Get a real frame: a screenshot of a stream mid-game, or run
       ./grab.sh SOMELOGIN real_frame.jpg while they're live.
    2. python3 calibrate.py real_frame.jpg
    3. Open calibrated_overlay.png. Each labeled rectangle should sit on its
       number. If not, edit the [x,y,w,h] fractions in template.json (x,y are the
       top-left corner as a fraction of width/height; w,h are size fractions).
    4. Re-run until the boxes line up and the printed read is correct.
"""
import sys, os, json
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, "template.json")

COLORS = {
    "away": (0, 200, 255), "awayScore": (0, 200, 255),
    "home": (0, 255, 120), "homeScore": (0, 255, 120),
    "quarter": (255, 180, 0), "clock": (255, 120, 200),
}

def main():
    if len(sys.argv) < 2:
        print("usage: python3 calibrate.py real_frame.jpg", file=sys.stderr)
        sys.exit(2)
    frame = sys.argv[1]
    img = cv2.imread(frame)
    if img is None:
        print(f"could not open {frame}", file=sys.stderr)
        sys.exit(1)
    h, w = img.shape[:2]
    tpl = json.load(open(TPL))
    overlay = img.copy()
    for name, (x, y, bw, bh) in tpl["fields"].items():
        p0 = (int(x * w), int(y * h))
        p1 = (int((x + bw) * w), int((y + bh) * h))
        color = COLORS.get(name, (255, 255, 255))
        cv2.rectangle(overlay, p0, p1, color, 2)
        cv2.putText(overlay, name, (p0[0], max(0, p0[1] - 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)
    out = os.path.join(os.path.dirname(os.path.abspath(frame)), "calibrated_overlay.png")
    cv2.imwrite(out, overlay)
    print(f"wrote {out}  (frame is {w}x{h}) — open it and check the boxes")

    # show what the reader currently gets so you can judge the calibration
    os.system(f'python3 "{os.path.join(HERE, "read_score.py")}" "{frame}" --template "{TPL}"')

if __name__ == "__main__":
    main()
