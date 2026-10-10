# What changed and what to do on deploy

Set these two variables in Railway BEFORE deploying, or score/final editing stays disabled (503):

    SUBMIT_PASSWORD   new password for the edit prompts (the old "SYBAU" was public, treat it as burned)
    ADMIN_KEY         new key for /api/finals/add and /api/test-alert (the old "gameday" was public)

The old values stay in git history forever, so rotating them is the real fix; removing them from the code only stops new use.

## Fixes
- Finals store real school names ("Michigan State"), not raw OCR ("ICHIGONSTATE"). Same for the live board.
- Name matcher: exact match on any known school wins; "X ST" / "X STATE" can no longer collapse into roster school X (MICHIGAN ST was Michigan, FLORIDA ST was Florida, MISSISSIPPI ST was Ole Miss); best-scoring match wins instead of first (TEXASAGM was Texas).
- A stream is many games. Each game now gets its own final (id gets a _gN suffix after the first), with its own history, teams and dynasty. A new game starts when new teams appear AND the score or quarter goes backwards.
- FINAL on the score bug ends the game right away (2 reads in a row, after the 3rd quarter) instead of waiting for the stream to drop. A misread FINAL is pulled back if the clock is clearly running.
- Final score is a JOINT scoreline confirmed over several reads, so two moments can't be stitched into a score the game never had (the 21-21 final).
- Score legality: a jump no real scoring plays could produce (7 -> 27) is held until it repeats, instead of becoming a permanent floor.
- Finals the reader isn't sure about (tie, never saw the 4th quarter, thin evidence, unmatched team, two streams disagree) get an amber CHECK badge; editing one clears it. Both coaches streaming one game merge into one final with a green "2 STREAMS" badge.
- Stream-drop timing counts Twitch snapshots, not score ticks. A live stream no longer wipes its own earlier finals.
- "&" and "()" added to the team-name OCR whitelist (TEXAS A&M was read as TEXASAGM).
- Secrets only come from the environment; password compare is constant-time.
- Removed duplicate uploads (5 star 2/3/5/6/7, dynasty 5 star, dynasty-ticker.zip, root and UPLOAD index.html). public/index.html is the served page.
- Tests: `npm test` (17 tests; the game tests replay scripted camera reads through the real pipeline).

## Still needs real frames (not done)
- Replacing Tesseract on the score digits with a per-digit classifier.
- Widening the away-name box so long names stop losing their first letter.
