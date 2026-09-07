# Human QA defect repair implementation plan

> Execute in the canonical roots. The user's supplied specification is the approved scope. Use subagent-driven development for the independent web implementation, followed by spec and quality review.

**Goal:** Repair viewport modal behavior and native scrolling, and verify canonical Godot identity routing without production gameplay writes.

**Architecture:** Keep deployed web commit ad12e1c as the integration base in the canonical web root. Mount dialogs at the document body, remove the persistent transformed page containing block, and retain native overflow behavior. Reuse Godot's existing explicit THERESIANS_PRODUCTION_SMOKE_TEST override; keep DEBUG localhost and release HTTPS defaults.

**Preservation:** Original web HEAD af13d37 and all six dirty files are retained in a named stash and .cache/human-qa-20260907. The protected DOCX SHA256 is 8D01C56568F9E2381CEE0A8A156678D91F1D957501EF07FDA348906BBBE8D15F. Godot starts at 2241f9e with pre-existing staged and unstaged changes; do not include those in task changes.

- [x] Verify production schema with BEGIN READ ONLY: nullable VARCHAR(8), partial unique index.
- [x] Verify production deployment identity: ad12e1c, deployment 8e5346fd-7fe0-4203-875b-afbd348148f7 SUCCESS.
- [x] Reproduce production Archive overlay after lower-table scrolling: overlay y=-726.6, height=622.6 for viewport height=694. Page ancestor has retained transform matrix. Center-table wheel changed page scrollTop to 694.4 in this run.
- [x] Add failing DOM regression tests for body-level modal placement, focus restoration/keyboard behavior, nested scrolling and CSS viewport contracts.
- [x] Implement shared viewport overlay behavior and apply to active major dialogs; preserve all business operations, approval gates and styling.
- [x] Verify main/native scrolling and eliminate unnecessary scroll containment; no global wheel handler.
- [x] Run focused Manage Users, Lesson Manager and layout tests under Node 20, then full backend, frontend, npm test, build and diff checks.
- [x] Recheck local rendered candidate at desktop, laptop, tablet and mobile dimensions; record automated evidence as human recheck pending.
- [x] Open/run canonical Godot via MCP; capture redacted actual profile request diagnostics. Stop before Start/gameplay writes. Use no fixture as real-account acceptance evidence.
- [x] Audit all alternate Godot copies, active processes, signing/artifacts and post-profile write endpoints without deletion.
- [x] Review changes against scope, then code quality. Produce immutable web candidate commit, preservation hashes and the complete 120-field consolidated report; do not deploy or sign.

Verification outcome: Node 20.20.2; focused modal/layout 119 tests passed, follow-up App/password 15 tests passed, full frontend npm test 350 tests in 45 suites passed, full backend 398 passed / 1 integration test skipped / 0 failed, production build compiled successfully. The original af13d37 source-import regression file is preserved byte-for-byte (Git blob 9cdf3cc6010fd4e2af4db09b2b265577d0d6e7a7). Human acceptance remains pending. The full 120-field report and Godot runtime/copy evidence are in the canonical Godot docs/qa directory.
