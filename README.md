# codex-epub-translator

[![Tests](https://github.com/clcreuso/codex-epub-translator/actions/workflows/tests.yml/badge.svg)](https://github.com/clcreuso/codex-epub-translator/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A fast, resumable EPUB translation pipeline powered by the Codex CLI.

The translator extracts reader-visible text into balanced JSON batches, runs parallel output-only Codex workers, safely restores inline markup, performs a separate editorial metadata review, validates the translated EPUB, and rebuilds a standards-compliant archive.

> [!IMPORTANT]
> Translate only books you are legally allowed to modify. Book files, extracted content, covers, and generated translations are deliberately excluded from this repository.

## Highlights

- Parallel, resumable translation with per-segment recovery.
- Immutable placeholders protect markup, code, links, and identifiers.
- Translation memory shared across local books.
- Separate editorial pass for title, subtitle, description, subjects, and metadata cleanup.
- Optional localized cover installation; only the OPF-declared cover can be replaced.
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

## Quick start

Clone the repository and run:

```sh
git clone https://github.com/clcreuso/codex-epub-translator.git
cd codex-epub-translator
python3 epub_translate.py "/path/to/book.epub" French --profile fast
```

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

By default, the input EPUB outside `books/` is deleted only after `original.epub` has been copied and preparation has completed successfully. Add `--keep-source` if you want to retain it:

```sh
python3 epub_translate.py "/path/to/book.epub" French --keep-source
```

## Profiles

| Profile | Workers | Batch size | Reasoning | Intended use |
| --- | ---: | ---: | --- | --- |
| `fast` | 10 | ~6,000 tokens | low | Fast first pass |
| `standard` | 8 | ~6,000 tokens | low | General use |
| `editorial` | 4 | ~3,500 tokens | medium | Smaller, more deliberate batches |

Every setting can be overridden with `--workers`, `--batch-tokens`, `--repair-tokens`, `--max-retries`, and `--reasoning-effort`.

## Resume a run

```sh
python3 epub_translate.py "books/Book title/original.epub" French --resume
```

Completed translations are not recalculated. Invalid rows are retried in small repair batches, while valid rows from partial responses are retained.

## Custom glossary

Pass a UTF-8 Markdown glossary when a book needs domain-specific terminology:

```sh
python3 epub_translate.py "book.epub" French \
  --glossary glossary.example.md
```

The glossary content is included in the translation-memory version, so changing it does not silently reuse incompatible translations.

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

The cover step is intentionally constrained to the image explicitly identified as the cover in the OPF manifest. Other images remain preserved.

## Pipeline stages

```text
prepare → translate → apply → editorial → validate → build
```

Each stage can be selected with `--stage`. See the detailed [French workflow guide](translate_epub.md) for generated files, repair behavior, and operational details.

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
