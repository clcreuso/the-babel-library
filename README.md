# The Babel Library

[![Tests](https://github.com/clcreuso/the-babel-library/actions/workflows/tests.yml/badge.svg)](https://github.com/clcreuso/the-babel-library/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A Codex-powered EPUB translator.** The Babel Library is a fast, resumable translation pipeline
for producing structurally valid EPUBs while preserving markup, metadata, navigation, and artwork.

> [!NOTE]
> The project was rebuilt in 2026 from its original Node.js/OpenAI API implementation into the
> current Python/Codex CLI pipeline. The complete original code and history remain available in the
> [`legacy-node-v1`](https://github.com/clcreuso/the-babel-library/tree/legacy-node-v1) tag.

The translator extracts reader-visible text into balanced JSON batches, runs parallel output-only Codex workers, safely restores inline markup, performs separate editorial metadata and bounded style-compatibility reviews, validates the translated EPUB, and rebuilds a standards-compliant archive.

> [!IMPORTANT]
> Translate only books you are legally allowed to modify. Book files, extracted content, covers, and generated translations are deliberately excluded from this repository.

## Highlights

- Parallel, resumable translation with per-segment recovery.
- Cumulative run history that survives no-op resumes and records external blockers separately.
- Immutable placeholders protect markup, code, links, and identifiers.
- Translation memory shared across local books.
- Separate editorial pass for title, subtitle, description, subjects, and metadata cleanup.
- Bounded AI style review that can apply only pre-approved, low-risk CSS transformations backed by
  XHTML template usage and final resource hashes. Paired root text/background colors are atomic,
  as is the recoverable multi-file application of approved style changes.
- Optional localized cover installation; only the selected OPF cover can be replaced, and malformed
  EPUB 2/3 cover declarations are normalized without changing the selected artwork.
- EPUB 2 named-entity support with DOCTYPE and processing-instruction preservation.
- Archive traversal, decompression-bomb, worker-timeout, and accidental-deletion safeguards.
- XHTML/XML, resource inventory, spine, metadata, and ZIP validation.
- EPUB-compatible archive ordering: uncompressed `mimetype` first.
- Standard-library-only Python implementation.

## Requirements

- Python 3.10 or newer.
- [Codex CLI](https://developers.openai.com/codex/cli/) installed and authenticated.
- Network access for Codex translation workers.
- Optional: the Codex desktop image editor for creating a localized cover.

Check your setup:

```sh
npm install --global @openai/codex
codex login
python3 --version
codex --version
```

## Quick start in Codex

Clone the repository and open its folder in Codex:

```sh
git clone https://github.com/clcreuso/the-babel-library.git
cd the-babel-library
```

The EPUB may be anywhere on your machine, including outside the repository. Send this message in Codex:

```text
[translate_epub.md](translate_epub.md) "My Book.epub" French --profile fast
```

This is a Codex prompt, not a shell command. Codex reads the linked workflow, runs the Python pipeline, follows its progress, handles the editorial metadata pass, optionally localizes the cover, and returns the final EPUB.

The project is always created in the repository's `books/` directory:

```text
books/Book title/
├── original.epub
├── translated-fr.epub
├── extracted original/
├── working fr/
└── translation jobs fr/
```

The repository contains an empty `books/` directory through `books/.gitkeep`; every generated book project inside it remains ignored by Git.

The input EPUB is never moved or deleted. The pipeline works from the canonical `original.epub` copy stored in the book project.

## Profiles

| Profile | Workers | Batch size | Reasoning | Intended use |
| --- | ---: | ---: | --- | --- |
| `fast` | 10 | ~6,000 tokens | low | Fast first pass |
| `standard` | 8 | ~6,000 tokens | low | General use |
| `editorial` | 4 | ~3,500 tokens | medium | Smaller, more deliberate batches |

Every setting can be overridden with `--workers`, `--batch-tokens`, `--repair-tokens`, `--max-retries`, and `--reasoning-effort`. Stalled model calls are bounded by `--worker-timeout` (30 minutes per batch), `--editorial-timeout` (10 minutes), and `--style-timeout` (10 minutes) by default.

## Resume a run

Send the workflow another Codex message:

```text
[translate_epub.md](translate_epub.md) "books/Book title/original.epub" French --resume
```

Completed translations are not recalculated. Invalid rows are retried in small repair batches, while valid rows from partial responses are retained.

Every invocation is appended to `translation_run_history.jsonl`. The summary in
`translation_run.json` remains cumulative, so a quick no-op resume cannot erase the duration,
batch count, or token estimates of the original run. Clear external blockers such as an exhausted
usage allowance or missing authentication pause the run without wasting repair attempts; resume
after the condition is resolved.
If a history line was externally corrupted, valid rows are salvaged and the original JSONL file is
kept as a timestamped `.corrupt-*` backup before the clean history is rewritten.

Use one pipeline writer per book project at a time. Parallelism is already managed inside a
translation run; launching two independent `translate` stages against the same book directory is
not supported.

## Custom glossary

Reference a UTF-8 Markdown glossary when a book needs domain-specific terminology:

```text
[translate_epub.md](translate_epub.md) "My Book.epub" French --profile fast --glossary glossary.example.md
```

The glossary content is included in the translation-memory version, so changing it does not silently reuse incompatible translations.
Glossary guidance is deliberately advisory: it helps the model remember terminology and distinctions
while leaving room for context, established usage, quotations, interfaces, and wordplay.

## Direct Python usage

The Python command is the lower-level interface used by the Codex workflow. It remains available for automation and debugging:

```sh
python3 epub_translate.py "My Book.epub" French --profile fast
```

## Editorial metadata and cover

The normal pipeline runs a separate Codex metadata review after text reinsertion. To run it independently:

```sh
python3 epub_translate.py "books/Book title/original.epub" French \
  --stage editorial
```

This creates an approved metadata decision and a cover-editing prompt under `translation jobs fr/editorial/`. After producing a localized cover in Codex, install it without rerunning the metadata decision:

```sh
python3 epub_translate.py "books/Book title/original.epub" French \
  --stage editorial --resume \
  --cover-image "/path/to/cover-fr.jpg"
python3 epub_translate.py "books/Book title/original.epub" French --stage validate
python3 epub_translate.py "books/Book title/original.epub" French --stage build
```

If the Codex editorial call is unavailable, a human or supervising agent can provide the same
schema-valid decision explicitly:

```sh
python3 epub_translate.py "books/Book title/original.epub" French \
  --stage editorial --editorial-decision "/path/to/metadata-decision.json"
```

This is an explicit recovery path, not a hard-coded fallback: the decision is still validated,
saved as project memory, and applied by the same deterministic stage.

The cover step is intentionally constrained to the image selected from the OPF manifest. Other
images remain preserved. The replacement must use the same declared image format. The generated
cover prompt includes the source pixel geometry; differing dimensions or aspect ratio produce
review warnings rather than silently distorting or rejecting otherwise useful artwork. Before
installation, compare the edited cover with the source: only the explicitly supplied book-identity
fields may change, while every unlisted endorsement, award, series line, prior-book title, and
publisher mark must remain verbatim and in the same visual role.

Reader-facing XHTML document titles are translated with the rest of the content. Deterministic
navigation synchronization then uses validated chapter headings and editorial book metadata as its
canonical source, including common labels assembled from several consecutive headings or a book
title placed before or after the chapter label. Unrecognized wording remains model-authored rather
than being guessed by language-specific code.

## Style compatibility review

After editorial metadata, the normal pipeline inventories CSS declarations and their actual use in
XHTML templates. Codex receives only bounded candidates for issues such as clipped code, impossible
pagination, fixed image heights, root colors that conflict with night mode, and unavailable remote
fonts:

```sh
python3 epub_translate.py "books/Book title/original.epub" French --stage style
```

The model cannot return arbitrary CSS. Every selected change must match a candidate identifier and
an allowed transformation; the pipeline then records before/after hashes and validation rejects any
later unapproved change. Relative line-length constraints and publisher typography are preserved
unless they demonstrably prevent reflow or access to content.

As with metadata, a reviewed decision can be supplied explicitly:

```sh
python3 epub_translate.py "books/Book title/original.epub" French \
  --stage style --style-decision "/path/to/style-decision.json"
```

## Pipeline stages

```text
prepare → translate → apply → editorial → style → validate → build
```

Each stage can be selected with `--stage`. See the detailed [French workflow guide](translate_epub.md) for generated files, repair behavior, and operational details.

## Post-run learning review

After a completed translation, Codex can review the real execution artifacts, inspect quality and
efficiency signals, and propose small, generalizable, testable improvements:

```text
[review_translation.md](review_translation.md)
```

Run it in the same Codex session immediately after `translate_epub.md`; the book, target language,
working directory, and final output are inherited from that session. The review is strictly
read-only: it does not modify files, run tests, rebuild the EPUB, or apply its proposals. A clean run
or an isolated model variation may correctly result in no recommendation.

## Tests

```sh
python3 -m unittest discover -s tests -v
```

The test suite uses synthetic EPUB fixtures and does not call Codex or include copyrighted book content.

## Privacy and cost

Reader-visible text is sent to Codex workers for translation. Do not process confidential or restricted material. Translation can consume substantial model tokens; start with a small EPUB if you need to estimate time and cost.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request. Please never attach copyrighted EPUBs or extracted book content to issues, commits, or test fixtures.

## License

The software is released under the [MIT License](LICENSE). This license applies only to the repository's code and documentation, not to any books processed with it.
