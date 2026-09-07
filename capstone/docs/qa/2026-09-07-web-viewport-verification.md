# Web viewport and native scroll verification — 2026-09-07

Status: **TECHNICALLY FIXED — HUMAN RECHECK PENDING**. Browser automation and tests do not replace the human's acceptance of the reported visual defects.

Canonical source: `C:\Users\vince\Documents\Capstone-Project\Theresian's Quest- Web`, application `capstone`, branch `codex/human-qa-defects-20260907`. Integration base is deployed `ad12e1c47583623dd59e55480bc59cf33949d671`. No deployment was performed.

## Reproduction and correction

Production Manage Users was inspected through the authenticated browser without submitting any account operation. With the lower table visible, the old overlay began at y=-726.6 and had height 622.6 in a 694-high viewport. It was inside the scrolling page, whose retained entry-animation transform established a containing block. This reproduced the misplaced backdrop and uncovered viewport.

The shared ModalPortal mounts existing dialog markup under document.body, applies a fixed full-viewport backdrop, centers and bounds dialog content, locks/restores background scroll, stacks nested dialogs, traps focus, and restores the trigger without moving the page. Native focus movement inside a long dialog can reveal its target. The page entry animation no longer retains a transform after completion. Vertical table overscroll remains native. No wheel handler or wheel preventDefault was introduced.

All custom dialog call sites use the shared wrapper: Manage Users; Lesson & Question Manager; student lifecycle/progress reset; learning-cycle reset; Activity Reset; Parent Add Child; Settings confirmation; and all temporary-password dialogs. Manage Users Add Account remains the existing inline form. Native browser confirmations remain native. Approval and busy-dismissal rules are unchanged.

## Rendered candidate checks

The successful production bundle was served locally with synthetic UI fixtures and no outbound proxy or production credentials. Mutation requests were rejected; no business action was submitted to production. The fixtures are layout evidence only, never real-account integration proof.

Browser viewport matrix: desktop 1440×900, laptop 1366×768, tablet 768×1024, mobile 390×844. Fractional dimensions up to 0.4px reflect browser/device scaling. Existing short entrance animations were allowed to settle before assessing centering.

| Check | Observed technical evidence |
| --- | --- |
| Archive at desktop top/middle/bottom | Overlay [0,0,1440,900], BODY parent; settled dialog [550.8,247.75,338.4,404.49] at each position. Underlying page positions included approximately 40, 493.6, and 856px. |
| Modal/background interaction | Wheel with Archive open left the background at 493.6px. Cancel restored overflow:auto and the prior scroll position. |
| Responsive Archive | Full viewport overlay at all four sizes; mobile dialog [36,202.15,318.4,439.69]. |
| Mobile long Edit | Dialog [11.7,11.7,367,820.6], content height 2668px. Wheel moved its own scrollTop 0→844 while background stayed at 760. |
| Keyboard long Edit | Shift+Tab wrapped to Update User, scrolled dialog to 1847.2, and left the button visibly within y=762.74–810.74. Tab returned focus and scroll to the first input/top. |
| Upload | Full viewport/body portal across the four sizes. Settled mobile bounds [11.7,11.7,367,820.6]; internal overflow retained. No file uploaded. |
| Preview/Review | Desktop settled bounds [310,70,820,760] at middle and bottom table positions. Full overlay and bounded preview at all four sizes. |
| Review wheel and keyboard | Review body moved 0→900 by wheel; End moved it to 3984 (4397 content / 413 visible). Approve stayed disabled before the final card and became enabled after it was visible. Approve was not clicked. |
| Remove confirmation | Opened from lower table, underlying page 1939.2; settled dialog [360,277,720,345.99]. Cancel restored table wheel; scroll moved to 1489.6. No removal submitted. |
| Push replacement confirmation | A second local fixture scenario returned a static HTTP 409 conflict and never published. Opened from the last table row at pageTop 1899.2; desktop dialog [360,264.15,720,371.7]. Full viewport/body overlay and centered dialog at all four sizes; mobile [11.7,112.65,367,618.69]. Cancelled without replacement. |
| Student lifecycle dialog | Archive Student Progress mounted at BODY with full desktop overlay; no action submitted. |
| Parent Add Child | Mobile bounds [11.7,11.7,367,820.6], content 1044px; no account operation submitted. |
| Activity Reset | Mobile bounds [11.7,207.4,367,429.19], full viewport overlay; reset remained disabled and was cancelled. |

Native wheel measurements on populated synthetic pages, without dragging a scrollbar: Dashboard 0→332.8; Manage Users 40→490.4 and onward to 856; Lesson Manager 0→900 and bottom reverse 1939.2→1489.6; Student Progress 0→900; Child Progress 0→632; Activity Log 0→900; Screen Time 0→900; archived-user view 0→468.8. With viewport 1366×500, sidebar scrollTop moved 0→372.8 (500 visible / 873 content).

Some immediate wheel attempts after navigation/viewport changes did not move the page in browser automation. After inspecting the rendered hit target, settled center-wheel checks above passed. No standalone persistent wheel failure was reproduced; no global wheel workaround was added. Human mouse/trackpad recheck is still required.

## Regression and preservation evidence

- Node 20.20.2: focused shared/dialog/layout tests, 11 suites / 119 passed; follow-up App/password assertions, 2 suites / 15 passed.
- Full frontend `npm test -- --watch=false --runInBand`: 45 suites / 350 passed, 0 failed.
- Full backend `node --test --test-concurrency=2` across backend, database and migration test files: 399 tests, 398 passed, 1 skipped, 0 failed. The production migration integration test was intentionally not connected to a database.
- Production `react-scripts/scripts/build.js`: compiled successfully; main.c4963ddb.js and main.2628803a.css. Later changes only adjusted tests/documentation.
- Spec review passed; independent quality review found no blocking issue. Pre-existing unnamed student lifecycle dialogs were recorded as a nonblocking accessibility follow-up.
- Both unstaged and staged diff checks are required at candidate creation. Backend runtime, package/lockfiles, Grounded AI, publication logic, and ID contracts have no task delta against the deployment base.
- The protected DOCX is preserved exactly: SHA256 `8D01C56568F9E2381CEE0A8A156678D91F1D957501EF07FDA348906BBBE8D15F`.
- Root-only source-import tests from af13d37 are preserved exactly: Git blob `9cdf3cc6010fd4e2af4db09b2b265577d0d6e7a7`.
- Original dirty backend work is retained in the named preservation stash and `.cache/human-qa-20260907`; deployed source already includes the approved stricter ID contracts. No old source was blindly reapplied over production.

Raw local test/build logs are retained under the canonical web root `.cache/human-qa-20260907`. The complete 120-field report, real canonical Godot request evidence, and alternate-project inventory are under the canonical Godot root `docs/qa`.
