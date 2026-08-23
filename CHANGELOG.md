# Changelog

All notable changes to this project will be documented here.

## Unreleased

- Adopted The Babel Library as the canonical project identity and preserved the original Node.js
  implementation and its complete history under the `legacy-node-v1` tag.
- Made Codex worker processes explicitly cancellable, retained validated partial work when an
  invocation is interrupted, and finalized the same translation-history record on exit.
- Let AI-approved editorial replacements synchronize book-specific navigation labels without
  hard-coded translations, including labels that omit a heading ordinal.
- Translated reader-facing XHTML document titles and generalized navigation synchronization for
  labels composed from multiple headings or a book title in prefix/suffix position; unresolved
  wording remains model-authored and the same resolver now backs validation.
- Tightened localized-cover prompts and workflow review so unlisted endorsements, series lines,
  prior-book titles, and publisher copy must remain verbatim instead of being silently removed or
  partially translated.
- Added a bounded Codex style-compatibility stage between editorial review and validation. It
  analyzes CSS against XHTML template usage, permits only enumerated low-risk transformations,
  records approved resource hashes, and rejects later unapproved style changes. Root text/background
  colors are coupled, and approved multi-file changes recover cleanly after an interruption.
- Protected table- and block-based code listings from translation, versioned the new validation
  rule for existing projects, preserved multipart heading markup while harmonizing navigation,
  and improved semantic repair context without exceeding repair batch budgets.
- Anchored every generated book project under the repository `books/` directory and retained the
  original input EPUB regardless of its location.
- Preserved cumulative translation metrics and added a chronological JSONL history for every resume.
- Classified clear Codex quota and authentication failures as external blockers instead of retrying
  them as malformed translations; matching is anchored to the same CLI diagnostic line and reports
  store a standardized message rather than copied log or book content.
- Allowed `apply` to recover exact local duplicate segments after supervised manual repairs.
- Added an explicit, schema-validated `--editorial-decision` recovery path.
- Normalized EPUB 2/3 cover declarations to the selected manifest image, enforced a unique EPUB 3
  `cover-image`, and rejected cover resources that escape the extracted EPUB root.
- Added source-cover geometry to the editing prompt and non-blocking review warnings for dimension
  or aspect-ratio changes.
- Expanded the default French glossary with advisory decision cues that favor contextual,
  community-established terminology without imposing fixed book-specific translations.
- Tightened supervised recovery validation for local aliases and external editorial-decision files,
  and persisted editorial timeout recovery state.

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
