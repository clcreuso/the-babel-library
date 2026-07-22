# Security policy

## Supported version

Security fixes are applied to the latest version on the `main` branch.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not open a public issue for vulnerabilities involving archive extraction, path traversal, command execution, credential exposure, or unintended file deletion.

## Security notes

- EPUBs are untrusted ZIP archives. The pipeline rejects path traversal during extraction and encrypted/DRM-protected inputs.
- Translation workers run in a read-only sandbox and receive extracted text through standard input.
- The input EPUB is deleted after successful preparation unless `--keep-source` is used.
- Book text is sent to Codex for translation. Do not process confidential or restricted material.
- Never commit `books/`, EPUB files, generated prompts, reports, logs, or translation memory.
