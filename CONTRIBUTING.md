# Contributing to CODE DNA

Thanks for helping improve CODE DNA. The project is an early, browser-based static-analysis prototype. Changes should keep the interface clear about what was detected, inferred, estimated, or not analyzed.

## Local development

1. Install Node.js 20 or newer.
2. Run `npm start` from the repository root.
3. Open `http://127.0.0.1:4173` in a current browser.
4. Run `npm test` before submitting analyzer or graph changes.

The project currently has no external npm dependencies or build step.

## Change guidelines

- Keep project reading local to the browser. Do not add uploads, analytics, or third-party network calls without an explicit design and privacy review.
- Do not execute code from scanned projects.
- Preserve ZIP path validation, size limits, and visible skip reasons.
- Keep folder-containment relationships distinct from detected source imports.
- Label approximate counts, static matches, and manifest-based inferences accurately.
- Add focused tests for analyzer and graph behavior when changing those modules.
- Keep responsive layout and keyboard-accessible controls in mind.

## Pull request notes

Describe the user-facing change, the evidence or behavior it affects, and any known limitations. Include a screenshot for visible interface changes when possible. Never include a scanned project's private source files or secrets in screenshots or fixtures.
