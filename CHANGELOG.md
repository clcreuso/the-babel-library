# Changelog

All notable changes to this project will be documented here.

## 0.1.1 - 2026-07-22

- Fixed OPF cover selection so declared image resources take priority and non-images are never selected.
- Added EPUB 2 named-entity parsing and preservation of DOCTYPEs and leading processing instructions.
- Removed title-, publisher-, artwork-, and language-specific editorial logic.
- Added model-driven front-matter harmonization and localized-cover format validation.
- Prevented automatic deletion of any input already located under `books/`.
- Added cross-platform path sanitization, archive expansion limits, and Codex call timeouts.
- Made shared translation-memory writes concurrency-safe and removed glossary-blind legacy reuse.
- Added coverage for the security and compatibility cases above.

## 0.1.0 - 2026-07-22

- Added fast, standard, and editorial translation profiles.
- Added parallel JSON translation batches with partial-response salvage and targeted repairs.
- Added per-book and shared translation memory.
- Added protected markup and code placeholders.
- Added deterministic XHTML reinsertion, navigation synchronization, validation, and EPUB rebuilding.
- Added a separate Codex editorial metadata review.
- Added optional OPF-constrained localized cover installation.
- Added adoption support for projects produced by the legacy workflow.
- Added custom glossary support.
