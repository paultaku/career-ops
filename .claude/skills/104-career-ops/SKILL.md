---
name: 104-career-ops
description: >-
  Capture a 104.com.tw job posting from the user's own Chrome through Orca computer use, then
  run career-ops auto-pipeline on the captured JD. Use when the user gives a 104.com.tw/job/
  URL to evaluate, apply to, or add to career-ops: 104 answers career-ops' own fetchers
  (check-liveness, fetch-jd, WebFetch) with an anti-bot challenge.
---

# 104 → career-ops

104 serves automated fetches an anti-bot challenge, so career-ops cannot read the JD itself. This skill reads it the way a person does, from the user's real Chrome tab, then hands the text to career-ops. The JD is captured exactly once, in the user's browser; nothing here works around the challenge.

Run every step in order. A step is done only when its completion line holds.

## 1. Normalize the URL

Accept only `https://www.104.com.tw/job/{id}` where `{id}` is `[A-Za-z0-9]+`. Drop any query string or fragment (`?jobsource=…`). The normalized URL is the only form ever passed to a shell command; a URL that does not match this shape is refused and the user is asked for the plain job link.

**Done when:** you hold one URL matching `^https://www\.104\.com\.tw/job/[A-Za-z0-9]+$`.

## 2. Preflight Orca

Resolve the Orca executable with the rules in `~/.claude/skills/orca-computer-use/SKILL.md`, and load `ORCA skills get computer-use` once. Then:

```text
ORCA computer permissions --json
```

Both `accessibility` and `screenshots` must be `granted`. Known quirk: Orca can report `granted` while every read still fails with `permission_denied`. In that case stop and tell the user to switch **Orca Computer Use** off and on in System Settings → Privacy & Security → Accessibility (helper app: `/Applications/Orca.app/Contents/Resources/Orca Computer Use.app`), then retry.

**Done when:** permissions are granted and a `get-app-state` on Chrome returns `ok: true`.

## 3. Open the posting in Chrome

```bash
open -g -a "Google Chrome" "<normalized URL>"
ORCA computer list-windows --app com.google.Chrome --json
```

`-g` opens the tab without raising Chrome. Pick the window whose title contains `104 人力銀行`; note its `id`. The user's other windows and tabs hold private work: read only the target window, and never repeat other tab titles back.

The window title and screenshots can lag behind the real active tab, so they never identify the posting. The address bar does: `get-app-state --window-id <id> --query 網址與搜尋列` must show `104.com.tw/job/{id}`. If the wrong tab is active, select the right one through its tab-strip element (`get-app-state --query <job title>`, then `click --element-index` on the `tab` line) and check the address bar again. Never click page coordinates: a click on 104 can land on a link and open another job.

**Done when:** the target window's address bar shows `104.com.tw/job/{id}`.

## 4. Capture the page text

**Accessibility tree first.** Chrome often exposes the page body once the tab is active. Run `ORCA computer wait --app com.google.Chrome --window-id <id> --text 工作內容 --timeout 20000 --json`; if it succeeds, save `get-app-state --window-id <id> --no-screenshot --json` → `result.snapshot.treeText` to `{scratchpad}/104-{id}-tree.txt`. Keep the text of `heading`, `text` and `container, Text:` lines; drop element indexes and control lines. If the address bar in that same tree shows `104.com.tw/job/{id}`, skip to the completion check below.

**Clipboard fallback**, only when the wait times out:

1. Save the user's clipboard: `pbpaste > {scratchpad}/clipboard-backup.txt`.
2. Select all, then copy, in the target window:
   ```text
   ORCA computer hotkey --app com.google.Chrome --window-id <id> --key CmdOrCtrl+A --no-screenshot --json
   ORCA computer hotkey --app com.google.Chrome --window-id <id> --key CmdOrCtrl+C --no-screenshot --json
   ```
   If a hotkey fails with `background_unavailable` (the window is on another Space), ask the user before adding `--restore-window`: it brings Chrome to the front over their work. A freshly opened tab has focus in the address bar, so a copy of just the URL means focus never reached the page: stop and ask the user to click once in the job description, rather than clicking for them.
3. `pbpaste > {scratchpad}/104-{id}-raw.txt`.
4. Restore the user's clipboard: `pbcopy < {scratchpad}/clipboard-backup.txt`. Do this even when an earlier sub-step failed.

**Done when:** the captured text contains `工作內容`, `條件要求` and the job title the address-bar tab carries, and the clipboard (if used) is restored. A capture without them (login wall, challenge page, a URL, another job) counts as JD unavailable: report it and stop. After two failed captures, stop and ask the user to paste the JD.

## 5. Trim to the posting

The copied page also carries 104's header, recommended jobs from other companies, and browser-extension widgets. Keep only this posting: from the company-name line above the job title through the end of the `福利制度` block (the line after `其他福利`). Cut from `聯絡方式` / `104人力銀行提醒您` onward. Write the result to `{scratchpad}/104-{id}-jd.txt`, verbatim: no translation, no summarizing.

Extract for the hand-off:
- **Posted:** the `MM/DD更新` marker beside the title.
- **Employer:** the company line (e.g. `台達電子工業股份有限公司 _DELTA ELECTRONICS INC.`).
- **Hiring signals:** `N 天內聯絡過求職者`, `應徵人數 …`.

**Done when:** the trimmed file starts at the company/title and ends at the benefits list, with no other company's job in it.

## 6. Hand off to career-ops

Invoke the `career-ops` skill with args `auto-pipeline <normalized URL>` and treat the trimmed file as Step 0's extracted JD: career-ops must not fetch the URL again. Carry these facts into the evaluation:

- **Liveness:** the posting was read live in the user's browser on {today}; `check-liveness.mjs` returns `uncertain` on 104 because of the challenge. Record both in Block G; neither one is a closed signal.
- **Employer confirmation:** 104 is a job board, so follow AGENTS.md → "Aggregator Listings -- Confirm at the Employer". If the role is not findable on the employer's own careers site, the result is *unconfirmed at employer* (legitimacy at most Proceed with Caution), and the 104 URL stays canonical.
- **JD archive:** paste the trimmed file into `## Job Description (archived verbatim)`, first line `Posted: {MM/DD更新 marker}`.
- **Tracker notes:** include `104 job {id}`.

Everything after this (gates, scoring, report, PDF, tracker merge) follows career-ops' own rules.

**Done when:** career-ops reports a saved report path and a merged tracker row, or a gate that stopped it, and you have told the user which one.
