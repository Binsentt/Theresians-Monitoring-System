# Consolidated Release Completion Design

## Purpose

Complete the remaining local release gates without modifying production, the protected Set A DOCX, the existing Godot product source, or the approved question-publication lifecycle.

## Boundaries

- The web implementation starts from `7dcaa5f15c250d9cb2b4c5c5f3b67ec7e9d62efb` in an isolated worktree.
- The Godot harness implementation starts from `72614863fe0f9f9ff0d142e22ee6abb0584dfb04` in a separate isolated worktree.
- No push, deployment, production read/write, migration, question lifecycle action, OpenAI call, APK build, or product-scene/script change is in scope.
- The existing Lesson and Question Manager behavior is regression-tested, not redesigned.

## Phone contract and legacy compatibility

The canonical supplied phone value is exactly eleven ASCII digits beginning with `09` (`09XXXXXXXXX`). Empty values remain allowed only for fields already optional.

The backend remains authoritative through a shared validator. Creation, an empty-to-supplied value, and an explicitly changed value must pass the canonical rule. An unchanged stored legacy value is preserved byte-for-byte during an unrelated profile update and is not silently rewritten, truncated, or normalized. The frontend mirrors the validation message, uses numeric/digit-oriented input with an eleven-character entry limit, and does not mutate an existing legacy value merely by rendering it.

## Student Quest Activity

`admin_audit_logs` remains independent, immutable for this work, and absent from the Student Activity presentation. The visible Student Activity query and UI use canonical gameplay payload/state already stored or supplied by game-facing routes: current quest/task, canonical quest name, grade, and optional difficulty. It does not infer quest state from a website URL, page view, or generic frontend click.

New Game records the canonical initial Tutorial state. Save and Load retain the actual saved current quest rather than replacing it with a generic Load Game label. Battle/quest activity renders canonical difficulty only when supplied by the game state. Role and relationship scope checks continue to be enforced by the backend query paths and are covered by authorization regressions.

## Reset Activity Log

The reset is an Admin-only backend action with a modal requiring typed `RESET`. It is limited to the safely classified Student quest-activity records that the Student Activity view exposes. It never targets accounts, account relationships, teacher assignments, progress, saves, game results, playtime, questions/publications, or `admin_audit_logs`. The operation is transactional and the UI reloads its data after success.

No migration is permitted. If the audit shows that existing schema/payload fields cannot safely identify only canonical Student quest activity, implementation stops for separate schema review.

## Godot harness recovery and freeze

Only files under `tools/` may change in the Godot worktree. The First Bandit harness will match the approved `DialoguePanel/DialogueLabel` scene contract and deliberately issue one interaction per line plus the final close. The New Game stub will include the required canonical profile. Tests that depend on autoloads run through project/scene context. The production-polish harness will wait for loader completion before freeing test instances; it must expose rather than suppress genuine errors.

No Godot product scene, script, UI metric, dialogue, quest order, battle, controls, or NPC behavior is changed. A graphical inspection occurs only in a disposable imported sandbox. Any unexplained product-file delta or visual difference is a stop condition.

## Verification and delivery

Test-first changes receive focused regressions before implementation. The final gate includes focused and full Node 20 backend/frontend tests, production build, diff checks, Godot project-context tests, static scene checks, and visual inspection. Commits remain focused: phone compatibility, activity/reset behavior, web regressions, and Godot harness corrections. Both worktrees must be clean before reporting final hashes and remaining blockers.
