# Final native scrolling and door-monitoring release audit plan

## Scope and safety boundaries

- Work only in the isolated web worktree based on `612445569add9913d4159df4ee00f0d0aa26478a` and the isolated Godot worktree based on tools commit `bc3ee90890f036b165e6f99344cd897ee3b4a924` (product baseline `f4c7a2d01556e468a036d221a1a7844fa9f57ea7`).
- Do not alter the protected dirty worktrees, production, migrations, question content/lifecycle, account data, OpenAI configuration or calls, signing material, or APK artifacts.
- Website work must remain CSS/layout-test only. It must not add wheel listeners or global scroll prevention.
- Godot source may change only in `scripts/door.gd`; a directly coupled test-only file under `tools/` is permitted only if needed to prove the regression.

## Evidence gathered before implementation

1. No client source registers a global `wheel` handler or calls `preventDefault()` for wheel input. Existing `preventDefault()` calls are keyboard/form handlers.
2. The shared shell has `.page-content { overflow-y: auto }`, but its flex ancestors use `min-height: 100vh` and `.main-content { overflow: hidden }` without the `height: 100vh` and `min-height: 0` constraints needed for a reliable flex scrolling region.
3. The existing Manager preview, account, parent-child, settings/password, and analytics sidebar surfaces already expose native overflow regions. The changes will retain these regions and make their flex sizing / touch behavior explicit where the audit test identifies a gap.
4. On the clean Godot product baseline, the reported engine diagnostic is caused by `Door._begin_transition()` setting `Area2D.monitoring = false` synchronously while entered from `_on_body_entered()`, an Area2D in/out signal. Godot's diagnostic explicitly requires deferred mutation.

## Implementation sequence

### 1. Web CSS contract, test first

1. Add a focused layout stylesheet contract test that first expects:
   - the app shell has a bounded viewport and its flex children can shrink;
   - `.page-content` is the native vertical scroll surface and keeps touch momentum;
   - the sidebar preserves its independently native scroll surface;
   - existing modal and preview scroll surfaces are retained without a wheel handler;
   - tables keep horizontal scrolling without suppressing vertical page/modal scrolling;
   - mobile and keyboard semantics remain native (no `touch-action: none`, no wheel interception).
2. Run this test and record the expected failure against the unmodified stylesheet.
3. Apply the smallest CSS-only fix: add the viewport/shrink constraints and explicit native scroll behavior to the shared shell, without changing color, typography, card/table data, navigation, or modal/review logic.
4. Run the focused test again, then the existing viewport/review-gate tests.

### 2. Door diagnostic, test first

1. In the new Godot worktree, import and run the relevant smoke/door regression on the unmodified candidate. Capture the `blocked during in/out signal` diagnostic and confirm its source line is `Door._begin_transition()`.
2. Add a tools-only regression that verifies Door's transition lock is deferred, while preserving destination resolution, spawn values, return context, input lock, and single-transition guard.
3. Run it to demonstrate the failure against the immediate assignment.
4. Make the one source change in `scripts/door.gd`: defer the existing monitoring disable. Defer the rare error-path re-enable as well so it cannot be called from the same signal stack. Do not change any door configuration or scene.
5. Re-run the targeted door test, Player House / Teacher House / interior-exterior smoke, and existing New Game, Save/Load, RemoteSync, First Bandit, and randomization regressions. Confirm the engine diagnostic count is zero.

### 3. Full gate and release assembly

1. Install the web candidate through a fresh Node 20 `npm ci`, then run focused scrolling and grounded-AI suites, full backend, full frontend, `npm test`, production build, and `git diff --check`.
2. Run the Godot clean import plus the full relevant harness suite with isolated user data and a log file. Separate nonfatal importer warnings from `SCRIPT ERROR`, resource error, and the door-monitoring diagnostic. Remove generated test artifacts only from the disposable isolated worktree after inspecting exact paths.
3. Recheck both worktrees have only the allowed files. Commit the focused web CSS/test/doc work and the Godot door/test work separately.
4. Report each requested matrix item with command/log evidence and state the signing identity as a separate human blocker. Do not push, deploy, build an APK, or mutate production.

## Self-review against the approved specification

- Native scrolling: CSS native overflow only; no JavaScript wheel system, no global interception, no scrollbar removal.
- Nested/modal/table/mobile/accessibility: the test contract covers page, sidebar, modal/preview, tables, touch momentum, and absence of event interception; existing final-question observer and review logic remain untouched.
- Visual freeze: the scroll change is limited to the shared sizing/overflow contract; no visual tokens or arbitrary geometry change.
- Door scope: baseline reproduction precedes implementation; only the known unsafe property mutation can change in product source, with a tools-only regression permitted.
- Godot freeze: no scene, resource, UI, map, TileSet, quest, battle, NPC, Student-ID, routing, Save/Load, or RemoteSync product change is planned.
- Local-only: no production request, OpenAI request, migration, account/content mutation, signing change, or APK build is included.
