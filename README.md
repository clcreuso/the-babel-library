# codex-epub-translator

[![Tests](https://github.com/clcreuso/codex-epub-translator/actions/workflows/tests.yml/badge.svg)](https://github.com/clcreuso/codex-epub-translator/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A fast, resumable EPUB translation pipeline powered by the Codex CLI.

The translator extracts reader-visible text into balanced JSON batches, runs parallel output-only Codex workers, safely restores inline markup, performs a separate editorial metadata review, validates the translated EPUB, and rebuilds a standards-compliant archive.

> [!IMPORTANT]
> Translate only books you are legally allowed to modify. Book files, extracted content, covers, and generated translations are deliberately excluded from this repository.

## Highlights

- Parallel, resumable translation with per-segment recovery.
- Cumulative run history that survives no-op resumes and records external blockers separately.
- Immutable placeholders protect markup, code, links, and identifiers.
- Translation memory shared across local books.
- Separate editorial pass for title, subtitle, description, subjects, and metadata cleanup.
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
git clone https://github.com/clcreuso/codex-epub-translator.git
cd codex-epub-translator
```

Place the EPUB in the repository folder, then send this message in Codex:

```text
[translate_epub.md](translate_epub.md) "My Book.epub" French --profile fast
```

This is a Codex prompt, not a shell command. Codex reads the linked workflow, runs the Python pipeline, follows its progress, handles the editorial metadata pass, optionally localizes the cover, and returns the final EPUB.

The project is created next to the input file:

```text
books/Book title/
├── original.epub
├── translated-fr.epub
├── extracted original/
├── working fr/
└── translation jobs fr/
```

The repository contains an empty `books/` directory through `books/.gitkeep`; every generated book project inside it remains ignored by Git.

By default, the input EPUB outside `books/` is deleted only after `original.epub` has been copied and preparation has completed successfully. Add `--keep-source` to the Codex prompt if you want to retain it:

```text
[translate_epub.md](translate_epub.md) "My Book.epub" French --profile fast --keep-source
```

## Profiles

| Profile | Workers | Batch size | Reasoning | Intended use |
| --- | ---: | ---: | --- | --- |
| `fast` | 10 | ~6,000 tokens | low | Fast first pass |
| `standard` | 8 | ~6,000 tokens | low | General use |
| `editorial` | 4 | ~3,500 tokens | medium | Smaller, more deliberate batches |

Every setting can be overridden with `--workers`, `--batch-tokens`, `--repair-tokens`, `--max-retries`, and `--reasoning-effort`. Stalled model calls are bounded by `--worker-timeout` (30 minutes per batch) and `--editorial-timeout` (10 minutes) by default.

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
review warnings rather than silently distorting or rejecting otherwise useful artwork.

## Pipeline stages

```text
prepare → translate → apply → editorial → validate → build
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
