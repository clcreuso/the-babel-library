# Contributing

Thank you for helping improve `codex-epub-translator`.

## Before opening a pull request

1. Create a focused branch.
2. Keep the implementation compatible with Python 3.10+.
3. Add or update a synthetic test for behavior changes.
4. Run the complete test suite:

   ```sh
   python3 -m unittest discover -s tests -v
   ```

5. Check that no book content or generated project files are staged:

   ```sh
   git status --short
   git ls-files | grep -E '\.(epub|mobi|azw3)$|^books/' | grep -v '^books/\.gitkeep$'
   ```

## Test data policy

Tests must construct small synthetic EPUBs in temporary directories. Do not commit real books, covers, extracted chapters, translation outputs, or third-party copyrighted samples.

## Design principles

- Preserve source structure and protected content.
- Make interrupted translations resumable.
- Save valid partial work before retrying invalid segments.
- Keep model output constrained by schemas.
- Prefer deterministic XML, ZIP, and validation operations.
- Treat destructive file operations explicitly and test them.

## Reporting bugs

Include the Python and Codex CLI versions, command-line flags, stage that failed, and a minimal synthetic reproduction. Remove book text and personal paths from logs before sharing them.
