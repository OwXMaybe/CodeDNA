# Feature status and roadmap

This file separates what the prototype currently does from the larger CODE DNA vision. Roadmap items are not implemented features.

## Available now

- ZIP, browser folder, individual-file, and drag-and-drop intake.
- Local progress feedback and a completion notice.
- Readable-file inventory, skip reasons, approximate line metrics, and supported-language totals.
- Manifest-based direct dependency and technology evidence.
- Software Anatomy report for languages, detected tools, package scripts, top-level structure, dependencies, and configuration evidence.
- DNA Map with explicit folder/file containment, statically detected relative-import edges, search, zoom, and evidence details.
- Chunked large-file scanning for supported metadata and basic JS/TS declaration/import patterns.
- A local-only workflow with bounded metadata-only session recovery.

## Known gaps

- No Git repository import or history analysis.
- No complete parser/AST or robust language adapter system.
- No general call graph, type-reference graph, or cross-language data-flow tracking.
- No verified application entry-point or runtime behavior detection.
- No database schema visualization, API/service inventory, deployment topology, or infrastructure analysis beyond visible file evidence.
- No vulnerability database, package license audit, or automated security verdicts.
- No AI-generated explanations or code-change impact analysis.
- Import aliases, package exports, and many dynamic/runtime relationships are unresolved.

## Possible next phases

1. Improve language-aware parsing and import resolution while retaining exact source evidence.
2. Expand manifest, test, API, infrastructure, and deployment evidence with explicit confidence and provenance.
3. Add architecture-level views and richer navigation for larger repositories.
4. Consider optional Git history and security-data integrations only with clear privacy boundaries and user controls.

Priorities may change. Every new analyzer capability should state its supported inputs, evidence source, confidence, and failure cases.
