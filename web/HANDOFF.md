# web/ handoff

Next.js and Tailwind dashboard, authored at 1920×1080 and scaled to the window. It renders only what glue serves.

## Data path
- `lib/store.ts` polls `GET $NEXT_PUBLIC_GLUE_URL/state?plantId=plant-a` and `plant-b` once a second, one poller for the page.
- `lib/contract.ts` checks each body against `shared/types.ts`. A mismatch shows "Glue answered with the wrong shape", it is never guessed around.
- Buttons POST `/propose`, `/veto`, `/reset` through `lib/glue.ts`, then read `/state` straight away. Glue's refusal text is shown as is.
- There is no mock path. With glue down the page shows "No plant data", the last error and the retry count, and no values. After 3 failed polls in a session it switches to that screen; before that the page dims and says reconnecting.
- The timing chart is recorded by this browser from the moment the page opens (`/state` carries current values only). Missing seconds stay gaps in the line.

## Commands
```
bun install --linker hoisted
bun run dev          # http://localhost:3000
bun run build
bun run start
bun x tsc --noEmit
bun test ./lib
```
Env, both optional:
- `NEXT_PUBLIC_GLUE_URL`, default `http://localhost:7200`. `localhost` on purpose: it reaches glue in WSL on either bind, 127.0.0.1 does not.
- `NEXT_PUBLIC_PID_URL`, default `/pid-tk-101.svg`.

Windows Bun 1.3.14: if `next` fails with "Cannot find module 'picocolors'", `node_modules/picocolors` came out empty from the shared Bun cache. Reinstall with a clean cache and delete `.next` (Turbopack caches the failure):
```
$env:BUN_INSTALL_CACHE_DIR = "$env:TEMP\ar-bun-cache"; bun install --linker hoisted --force; Remove-Item -Recurse -Force .next
```

## What decides each claim on screen
All in `lib/derive.ts`, tested in `lib/derive.test.ts`, no timers.
- "It learned.": a blocked proposal in the plant's newest thread has a `no` vote citing an event whose `proposalId` is an executed proposal the plant still holds, older than the block. Seeded history has `proposalId: null` and reset clears proposals, so neither passes. Both block times come from `audit`; nothing claims the repeat was faster.
- "Plant B learned from Plant A.": a blocked proposal in the viewed plant has a `no` vote citing a `scope: "company"` rule whose source plant is the other plant. The source comes from Company's text `(first learned in plant-a)`, because company rules carry null component ids and glue trims history.
- Voter outlines: the plant's newest proposal while voting, in the veto window or blocked, plus any open proposal in the other plant that needs a local voter.
- The refusal on a blocked parent stays on screen when a counter nests under it, reason clamped to three lines, rules first. Clicking the header shows every voter.

## Design rules
- The Tailwind type scale in `app/globals.css` starts at 18px and `text-xs`, `text-sm` do not exist. SVG text is raised to 18px by `enforceMinimumText`.
- Red for no, critical, blocked, vetoed. Green for yes, ok, executed. Amber for warning, voting, veto window. Grey outlines while a voter is voting. Ice blue is identity, selection and this-session marks, never status. Every colour sits next to its word.
- Custom CSS is in `@layer base` and `@layer components`. Anything unlayered beats Tailwind utilities.

## Not stubbed, not faked
Nothing in `web/` invents data. Agent labels such as "[GPT fallback]" arrive inside vote reasons and are shown unedited. The component vendor field is not displayed because it would claim a vendor the run may not be using.
