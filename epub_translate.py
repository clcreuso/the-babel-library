#!/usr/bin/env python3
"""Fast, resumable EPUB translation pipeline driven by output-only Codex workers."""

from __future__ import annotations

import argparse
import hashlib
import html
import html.entities
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import zipfile
from collections import Counter, defaultdict
from concurrent.futures import CancelledError, ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET


VERSION = "0.1.2"
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"
XHTML_NS = "http://www.w3.org/1999/xhtml"
OPF_NS = "http://www.idpf.org/2007/opf"
DC_NS = "http://purl.org/dc/elements/1.1/"
NCX_NS = "http://www.daisy.org/z3986/2005/ncx/"
CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container"
BLOCK_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "dt", "dd", "caption", "blockquote", "td", "th", "li"}
PROTECTED_TAGS = {"code", "pre", "kbd", "samp", "script", "style", "math"}
PROTECTED_CLASSES = {"pre", "prev", "pre-ex", "code-para", "programlisting", "screen"}
TRANSLATABLE_ATTRS = {"alt", "title", "aria-label"}
STRUCTURAL_ATTRS = {"id", "class", "href", "src", "style", "role", "type", "name", "epub:type"}
PLACEHOLDER_RE = re.compile(r"⟦(?:OPEN|CLOSE|LOCK):\d+⟧")
WORD_RE = re.compile(r"[^\W\d_]+(?:['’_-][^\W\d_]+)*", re.UNICODE)
CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]")
INVISIBLE_METADATA_RE = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]")
HTML_ENTITY_RE = re.compile(r"&([A-Za-z][A-Za-z0-9]+);")
WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL", "CLOCK$",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}
MAX_EPUB_MEMBERS = 20_000
MAX_EPUB_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
MAX_MEMBER_COMPRESSION_RATIO = 1_000
DEFAULT_WORKER_TIMEOUT = 30 * 60
DEFAULT_EDITORIAL_TIMEOUT = 10 * 60

# Only unmistakably terminal failures belong here. Unknown Codex failures remain
# retryable because model and transport behavior can evolve independently of this
# pipeline.
TERMINAL_CODEX_FAILURES = {
    "usage_limit": (
        "you've hit your usage limit",
        "you have hit your usage limit",
        "insufficient_quota",
    ),
    "authentication": (
        "not logged in",
        "authentication required",
        "invalid api key",
        "incorrect api key",
    ),
}
TERMINAL_CODEX_DETAILS = {
    "usage_limit": "Codex usage limit reached; resume after the allowance is available again.",
    "authentication": "Codex authentication is unavailable; authenticate the CLI, then resume.",
}


LANGUAGES = {
    "english": ("English", "en"), "en": ("English", "en"),
    "french": ("French", "fr"), "fr": ("French", "fr"), "français": ("French", "fr"),
    "german": ("German", "de"), "de": ("German", "de"), "deutsch": ("German", "de"),
    "spanish": ("Spanish", "es"), "es": ("Spanish", "es"), "español": ("Spanish", "es"),
    "italian": ("Italian", "it"), "it": ("Italian", "it"), "italiano": ("Italian", "it"),
    "portuguese": ("Portuguese", "pt"), "pt": ("Portuguese", "pt"),
    "dutch": ("Dutch", "nl"), "nl": ("Dutch", "nl"),
    "polish": ("Polish", "pl"), "pl": ("Polish", "pl"),
    "japanese": ("Japanese", "ja"), "ja": ("Japanese", "ja"),
    "chinese": ("Chinese", "zh"), "zh": ("Chinese", "zh"),
}

UI_TRANSLATIONS = {
    "fr": {
        "Contents": "Sommaire", "Table of Contents": "Table des matières", "Index": "Index",
        "Introduction": "Introduction", "Preface": "Préface", "Acknowledgments": "Remerciements",
        "Afterword": "Postface", "About the Author": "À propos de l’auteur", "Cover": "Couverture",
        "Title Page": "Page de titre", "Copyright": "Droits d’auteur",
        "Copyright Page": "Page de copyright", "Body Matter": "Corps du livre",
        "Landmarks": "Repères", "Code Snippets": "Extraits de code", "Summary": "Résumé",
    }
}

SPEED_PROFILES = {
    "fast": {"batch_tokens": 6000, "repair_tokens": 1200, "workers": 10, "reasoning_effort": "low"},
    "standard": {"batch_tokens": 6000, "repair_tokens": 1000, "workers": 8, "reasoning_effort": "low"},
    "editorial": {"batch_tokens": 3500, "repair_tokens": 800, "workers": 4, "reasoning_effort": "medium"},
}

FRENCH_GLOSSARY = """# Glossaire commun anglais-français

- Source : anglais (`en`)
- Cible : français (`fr`)

Conserver les noms de produits, marques, langages de programmation, classes, modules, méthodes,
variables, constantes, bibliothèques, commandes, fichiers, URL et API. Employer un français
naturel, professionnel et cohérent. Ne traduire un terme technique que lorsqu’un équivalent
français est établi dans le domaine concerné.

## Repères de décision — non contraignants

- Traiter les choix terminologiques déjà validés dans le livre comme une mémoire de cohérence,
  sans forcer une traduction lorsque le contexte, une interface ou un jeu de mots justifie un écart.
- Préférer l’usage réellement établi dans la communauté technique francophone à une traduction
  littérale. Un terme anglais courant peut rester en anglais s’il est plus naturel et précis.
- Préserver les distinctions conceptuelles du texte source ; ne pas fusionner deux notions seulement
  parce qu’elles admettent parfois la même traduction française.
- En cas d’ambiguïté, s’appuyer d’abord sur le chapitre, les exemples et le ton de l’auteur.
"""

GENERIC_GLOSSARY = """# Shared translation glossary

Preserve product names, programming language names, source code, commands, paths, URLs, identifiers,
class names, method names, variables, constants, modules, libraries and APIs. Translate all natural
language faithfully and consistently into the target language.
"""


def local_name(tag: object) -> str:
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1]


def namespace(tag: object) -> str:
    if isinstance(tag, str) and tag.startswith("{"):
        return tag[1:].split("}", 1)[0]
    return ""


def normalize_space(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def clean_metadata_text(text: str | None) -> str:
    """Remove invisible formatting controls and normalize human-readable metadata."""
    return normalize_space(INVISIBLE_METADATA_RE.sub("", text or ""))


def stable_hash(value: str, length: int = 12) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def resolve_language(value: str) -> tuple[str, str]:
    key = value.strip().casefold()
    if key in LANGUAGES:
        return LANGUAGES[key]
    if re.fullmatch(r"[a-zA-Z]{2,3}", value.strip()):
        code = value.strip().lower()
        return code, code
    raise ValueError(f"Unsupported target language {value!r}; use a language name or BCP 47 code")


def epub_book_title(epub: Path) -> str | None:
    try:
        with zipfile.ZipFile(epub) as archive:
            container = ET.fromstring(archive.read("META-INF/container.xml"))
            rootfile = next(
                (node for node in container.iter() if local_name(node.tag) == "rootfile"),
                None,
            )
            if rootfile is None or not rootfile.attrib.get("full-path"):
                return None
            package = ET.fromstring(archive.read(rootfile.attrib["full-path"]))
            title = next(
                (node for node in package.iter() if local_name(node.tag) == "title" and normalize_space(node.text)),
                None,
            )
            return normalize_space(title.text) if title is not None else None
    except (OSError, KeyError, ET.ParseError, zipfile.BadZipFile):
        return None


def safe_book_name(value: str) -> str:
    value = clean_metadata_text(value).replace("/", "-").replace("\\", "-").replace(":", " -")
    value = re.sub(r"\s*\((?:for|pour|by|par)?\s*\)\s*$", "", value, flags=re.I)
    value = value.strip(" \"'«»“”")
    value = re.sub(r"[\x00-\x1f<>\"|?*]", "", value).strip(" .")
    value = re.sub(r"\.{2,}", ".", value)
    value = value[:100].rstrip(" .") or "Untitled book"
    if value.split(".", 1)[0].upper() in WINDOWS_RESERVED_NAMES:
        value = f"_{value}"
    return value


def short_book_name(epub: Path) -> str:
    resolved = epub.resolve()
    if resolved.parent.parent.name == "books":
        return resolved.parent.name
    title = epub_book_title(resolved)
    if title:
        title = re.split(r"\s*(?::|—|–)\s*", title, maxsplit=1)[0]
        return safe_book_name(title)
    filename = re.sub(r"\s+\([a-zA-Z]{2,3}\)$", "", epub.stem)
    filename = filename.split(" (", 1)[0]
    return safe_book_name(filename)


def project_paths(epub: Path, target_code: str, book_name: str | None = None) -> dict[str, Path]:
    resolved = epub.resolve()
    books_root = resolved.parent.parent if resolved.parent.parent.name == "books" else resolved.parent / "books"
    if book_name is None and resolved.parent.parent.name == "books":
        root = resolved.parent
    else:
        root = books_root / safe_book_name(book_name or short_book_name(resolved))
    return {
        "root": root,
        "source": root / "original.epub",
        "original": root / "extracted original",
        "working": root / f"working {target_code}",
        "jobs": root / f"translation jobs {target_code}",
        "final": root / f"translated-{target_code}.epub",
        "memory": root / f"translation_memory_{target_code}.json",
        "global_memory": books_root / ".translation-memory" / f"{target_code}.json",
    }


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def write_jsonl_atomic(path: Path, rows: list[dict]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    write_jsonl(temporary, rows)
    os.replace(temporary, path)


def write_json_atomic(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def archive_existing(path: Path) -> None:
    if not path.exists():
        return
    stamp = time.strftime("%Y%m%d-%H%M%S")
    destination = path.with_name(f"{path.name} - archived {stamp}")
    counter = 1
    while destination.exists():
        destination = path.with_name(f"{path.name} - archived {stamp}-{counter}")
        counter += 1
    path.rename(destination)


def safe_extract(epub: Path, destination: Path) -> None:
    with zipfile.ZipFile(epub) as archive:
        if archive.testzip():
            raise RuntimeError("The source EPUB has a corrupt ZIP member")
        infos = archive.infolist()
        if len(infos) > MAX_EPUB_MEMBERS:
            raise RuntimeError(f"EPUB contains too many ZIP members ({len(infos)})")
        total_size = sum(info.file_size for info in infos)
        if total_size > MAX_EPUB_UNCOMPRESSED_BYTES:
            raise RuntimeError("EPUB uncompressed size exceeds the safety limit")
        root = destination.resolve()
        for info in infos:
            member = info.filename.replace("\\", "/")
            member_parts = [part for part in member.split("/") if part not in {"", "."}]
            if (member.startswith("/") or re.match(r"^[A-Za-z]:", member)
                    or any(part == ".." for part in member_parts)):
                raise RuntimeError(f"Unsafe ZIP member: {info.filename}")
            target = (destination / info.filename).resolve()
            if target != root and root not in target.parents:
                raise RuntimeError(f"Unsafe ZIP member: {info.filename}")
            if (info.file_size > 10 * 1024 * 1024 and info.compress_size > 0
                    and info.file_size / info.compress_size > MAX_MEMBER_COMPRESSION_RATIO):
                raise RuntimeError(f"Suspicious ZIP compression ratio: {info.filename}")
        archive.extractall(destination)


def expand_xhtml_entities(text: str) -> str:
    """Replace common HTML named entities with XML-safe numeric references."""
    xml_entities = {"amp", "lt", "gt", "quot", "apos"}

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name in xml_entities:
            return match.group(0)
        value = html.entities.html5.get(name + ";")
        if value is None:
            return match.group(0)
        return "".join(f"&#{ord(character)};" for character in value)

    return HTML_ENTITY_RE.sub(replace, text)


def read_xml_text(path: Path) -> str:
    raw = path.read_bytes()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16")
    match = re.match(br"\s*<\?xml[^>]*encoding=[\"']([^\"']+)", raw[:256], re.I)
    encoding = match.group(1).decode("ascii", "replace") if match else "utf-8"
    return raw.decode(encoding)


def register_namespaces_from_text(text: str) -> None:
    for prefix, uri in re.findall(r"\sxmlns(?::([A-Za-z_][\w.-]*))?=[\"']([^\"']+)[\"']", text):
        try:
            ET.register_namespace(prefix or "", uri)
        except ValueError:
            pass


def parse_xml(path: Path) -> ET.ElementTree:
    text = read_xml_text(path)
    register_namespaces_from_text(text)
    parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True, insert_pis=True))
    try:
        root = ET.fromstring(text, parser=parser)
    except ET.ParseError as original_error:
        expanded = expand_xhtml_entities(text)
        if expanded == text:
            raise original_error
        parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True, insert_pis=True))
        root = ET.fromstring(expanded, parser=parser)
    return ET.ElementTree(root)


def find_package(original: Path) -> str:
    container = parse_xml(original / "META-INF" / "container.xml").getroot()
    rootfile = next((e for e in container.iter() if local_name(e.tag) == "rootfile"), None)
    if rootfile is None or not rootfile.attrib.get("full-path"):
        raise RuntimeError("META-INF/container.xml does not identify an OPF package")
    return rootfile.attrib["full-path"]


def element_paths(root: ET.Element) -> tuple[dict[int, list[int]], dict[int, ET.Element]]:
    paths: dict[int, list[int]] = {id(root): []}
    parents: dict[int, ET.Element] = {}
    stack = [root]
    while stack:
        parent = stack.pop()
        base = paths[id(parent)]
        children = list(parent)
        for index, child in enumerate(children):
            paths[id(child)] = base + [index]
            parents[id(child)] = parent
            stack.append(child)
    return paths, parents


def element_at(root: ET.Element, path: list[int]) -> ET.Element:
    current = root
    for index in path:
        current = list(current)[index]
    return current


def has_protected_class(element: ET.Element) -> bool:
    classes = set(element.attrib.get("class", "").split())
    return bool(classes & PROTECTED_CLASSES)


def flatten_content(element: ET.Element) -> tuple[str, list[str], list[tuple[ET.Element, str]]]:
    """Return mixed content with immutable placeholders and writable text slots."""
    parts: list[str] = []
    tokens: list[str] = []
    slots: list[tuple[ET.Element, str]] = []
    counter = 0

    def add_text(owner: ET.Element, field: str) -> None:
        value = getattr(owner, field) or ""
        parts.append(value)
        slots.append((owner, field))

    def walk(parent: ET.Element) -> None:
        nonlocal counter
        add_text(parent, "text")
        for child in list(parent):
            tag = local_name(child.tag)
            counter += 1
            number = counter
            if tag in PROTECTED_TAGS or has_protected_class(child) or namespace(child.tag).endswith("MathML"):
                token = f"⟦LOCK:{number}⟧"
                parts.append(token)
                tokens.append(token)
            else:
                opening = f"⟦OPEN:{number}⟧"
                closing = f"⟦CLOSE:{number}⟧"
                parts.append(opening)
                tokens.append(opening)
                walk(child)
                parts.append(closing)
                tokens.append(closing)
            add_text(child, "tail")

    walk(element)
    return "".join(parts), tokens, slots


def model_text(value: str) -> str:
    return normalize_space(html.unescape(value))


def natural_language_present(value: str) -> bool:
    text = PLACEHOLDER_RE.sub(" ", value)
    if len(CJK_RE.findall(text)) >= 4:
        return True
    words = WORD_RE.findall(text)
    return len(words) >= 2 and any(len(word) > 2 for word in words)


def has_descendant_block(element: ET.Element) -> bool:
    return any(local_name(child.tag) in BLOCK_TAGS for child in element.iter() if child is not element)


def ancestor_is_protected(element: ET.Element, parents: dict[int, ET.Element]) -> bool:
    current = parents.get(id(element))
    while current is not None:
        if local_name(current.tag) in PROTECTED_TAGS or has_protected_class(current):
            return True
        current = parents.get(id(current))
    return False


def make_segment_id(rel: str, kind: str, path: list[int], extra: str = "") -> str:
    return f"s-{stable_hash(f'{rel}|{kind}|{path}|{extra}', 16)}"


def extract_document_segments(path: Path, rel: str, media_type: str) -> list[dict]:
    tree = parse_xml(path)
    root = tree.getroot()
    paths, parents = element_paths(root)
    candidates = {"text", "tspan"} if media_type == "image/svg+xml" else BLOCK_TAGS
    segments: list[dict] = []
    for element in root.iter():
        tag = local_name(element.tag)
        if tag not in candidates or ancestor_is_protected(element, parents) or has_protected_class(element):
            continue
        if tag in BLOCK_TAGS and has_descendant_block(element):
            continue
        if media_type == "image/svg+xml" and any(local_name(child.tag) in candidates for child in element.iter() if child is not element):
            continue
        source, placeholders, _ = flatten_content(element)
        source = model_text(source)
        if not natural_language_present(source):
            continue
        path_value = paths[id(element)]
        segment_id = make_segment_id(rel, "element", path_value)
        segments.append({
            "id": segment_id,
            "file": rel,
            "kind": "element",
            "path": path_value,
            "tag": tag,
            "source": source,
            "placeholders": placeholders,
            "source_hash": stable_hash(source, 32),
        })
    for element in root.iter():
        if ancestor_is_protected(element, parents):
            continue
        for attr in TRANSLATABLE_ATTRS:
            value = element.attrib.get(attr)
            if not value:
                continue
            source = model_text(value)
            if not natural_language_present(source):
                continue
            path_value = paths[id(element)]
            segment_id = make_segment_id(rel, "attribute", path_value, attr)
            segments.append({
                "id": segment_id,
                "file": rel,
                "kind": "attribute",
                "path": path_value,
                "attribute": attr,
                "tag": local_name(element.tag),
                "source": source,
                "placeholders": [],
                "source_hash": stable_hash(source, 32),
            })
    return segments


def extract_opf_segments(path: Path, rel: str) -> list[dict]:
    tree = parse_xml(path)
    root = tree.getroot()
    paths, _ = element_paths(root)
    segments = []
    for element in root.iter():
        tag = local_name(element.tag)
        if tag not in {"title", "description", "subject"} or namespace(element.tag) != DC_NS:
            continue
        source = model_text(element.text or "")
        if not natural_language_present(source):
            continue
        literal_map: dict[str, str] = {}
        def protect_markup(match: re.Match[str]) -> str:
            token = f"⟦LOCK:{len(literal_map) + 1}⟧"
            literal_map[token] = match.group(0)
            return token
        protected_source = re.sub(r"</?[^>]+>", protect_markup, source)
        path_value = paths[id(element)]
        segment_id = make_segment_id(rel, "metadata", path_value, tag)
        segments.append({
            "id": segment_id,
            "file": rel,
            "kind": "metadata",
            "path": path_value,
            "tag": tag,
            "source": protected_source,
            "placeholders": PLACEHOLDER_RE.findall(protected_source),
            "literal_map": literal_map,
            "source_hash": stable_hash(protected_source, 32),
        })
    return segments


def media_inventory(original: Path, opf_rel: str) -> tuple[dict[str, dict], set[str], list[str]]:
    tree = parse_xml(original / opf_rel)
    root = tree.getroot()
    opf_dir = Path(opf_rel).parent
    items: dict[str, dict] = {}
    id_to_rel: dict[str, str] = {}
    for element in root.iter():
        if local_name(element.tag) != "item":
            continue
        href = unquote(element.attrib.get("href", ""))
        rel = (opf_dir / href).as_posix()
        item_id = element.attrib.get("id", "")
        items[rel] = {
            "id": item_id,
            "media_type": element.attrib.get("media-type", "application/octet-stream"),
            "properties": element.attrib.get("properties", ""),
        }
        id_to_rel[item_id] = rel
    spine = []
    for element in root.iter():
        if local_name(element.tag) == "itemref":
            ref = element.attrib.get("idref", "")
            if ref in id_to_rel:
                spine.append(id_to_rel[ref])
    serial = {opf_rel}
    for rel, item in items.items():
        if "nav" in item["properties"].split() or item["media_type"] == "application/x-dtbncx+xml":
            serial.add(rel)
        if Path(rel).name.casefold() in {"nav.xhtml", "toc.xhtml", "toc.ncx"}:
            serial.add(rel)
    return items, serial, spine


def package_source_language(original: Path, opf_rel: str) -> tuple[str, str]:
    root = parse_xml(original / opf_rel).getroot()
    language = next((e for e in root.iter() if local_name(e.tag) == "language" and namespace(e.tag) == DC_NS), None)
    code = normalize_space(language.text if language is not None else "en").split("-", 1)[0].lower() or "en"
    name = next((name for name, value in LANGUAGES.values() if value == code), code)
    return name, code


def prepare(epub: Path, target_name: str, target_code: str, paths: dict[str, Path], force: bool,
            resume: bool, keep_input: bool = False, glossary_path: Path | None = None) -> dict:
    input_epub = epub.resolve()
    if not input_epub.is_file():
        raise FileNotFoundError(input_epub)
    with zipfile.ZipFile(input_epub) as archive:
        if archive.testzip():
            raise RuntimeError("The EPUB ZIP archive is corrupt")
        if "META-INF/encryption.xml" in archive.namelist():
            raise RuntimeError("Encrypted/DRM-protected EPUBs are not supported by the fast pipeline")
    paths["root"].mkdir(parents=True, exist_ok=True)
    canonical_source = paths["source"]
    input_is_in_books = any(part.casefold() == "books" for part in input_epub.parts)
    remove_input_after_prepare = input_epub != canonical_source and not keep_input and not input_is_in_books
    if input_epub != canonical_source:
        if canonical_source.exists():
            if input_epub.read_bytes() != canonical_source.read_bytes():
                raise RuntimeError(
                    f"A different original.epub already exists in {paths['root']}; "
                    "choose another --book-name"
                )
        else:
            shutil.copy2(input_epub, canonical_source)
    epub = canonical_source
    if resume and (paths["jobs"] / "segments.jsonl").exists():
        project = json.loads((paths["jobs"] / "project.json").read_text(encoding="utf-8"))
        if remove_input_after_prepare:
            input_epub.unlink()
        return project
    existing = [paths["original"], paths["working"], paths["jobs"]]
    if any(path.exists() for path in existing):
        if not force:
            raise RuntimeError("Previous extraction exists; use --resume or --force to archive it")
        for path in existing:
            archive_existing(path)
    paths["original"].mkdir(parents=True)
    safe_extract(epub, paths["original"])
    shutil.copytree(paths["original"], paths["working"])
    for name in ("batches", "prompts", "reports", "logs"):
        (paths["jobs"] / name).mkdir(parents=True, exist_ok=True)

    opf_rel = find_package(paths["original"])
    source_name, source_code = package_source_language(paths["original"], opf_rel)
    items, serial, spine = media_inventory(paths["original"], opf_rel)
    segments: list[dict] = []
    file_has_segments: set[str] = set()
    excluded_serial_content = {rel for rel in serial if rel != opf_rel}
    for rel, item in sorted(items.items()):
        media_type = item["media_type"]
        if rel in excluded_serial_content:
            continue
        if media_type in {"application/xhtml+xml", "application/x-dtbook+xml", "image/svg+xml"}:
            try:
                extracted = extract_document_segments(paths["original"] / rel, rel, media_type)
            except (ET.ParseError, UnicodeError) as exc:
                error_report = {"file": rel, "media_type": media_type, "error": str(exc)}
                write_json_atomic(paths["jobs"] / "preparation_error.json", error_report)
                raise RuntimeError(f"Cannot parse translatable document {rel}: {exc}") from exc
            if extracted:
                file_has_segments.add(rel)
                segments.extend(extracted)
    opf_segments = extract_opf_segments(paths["original"] / opf_rel, opf_rel)
    segments.extend(opf_segments)
    if opf_segments:
        file_has_segments.add(opf_rel)

    all_files = sorted(path.relative_to(paths["original"]).as_posix() for path in paths["original"].rglob("*") if path.is_file())
    manifest_rows = []
    for rel in all_files:
        if rel in serial:
            category, reason, status = "serial-final", "generated from validated translated headings", "pending"
        elif rel in file_has_segments:
            category, reason, status = "parallel", "contains extracted reader-visible segments", "pending"
        else:
            category, reason, status = "preserve", "binary, technical, image-only or protected content", "preserved"
        manifest_rows.append({
            "relative_path": rel,
            "media_type": items.get(rel, {}).get("media_type", "application/octet-stream"),
            "category": category,
            "reason": reason,
            "status": status,
        })

    if glossary_path is not None:
        glossary = glossary_path.resolve().read_text(encoding="utf-8")
    else:
        glossary = FRENCH_GLOSSARY if target_code == "fr" and source_code == "en" else (
            GENERIC_GLOSSARY + f"\nSource language: {source_name} (`{source_code}`)\nTarget language: {target_name} (`{target_code}`)\n"
        )
    (paths["jobs"] / "translation_glossary.md").write_text(glossary, encoding="utf-8")
    write_jsonl(paths["jobs"] / "segments.jsonl", segments)
    write_jsonl(paths["jobs"] / "translation_manifest.jsonl", manifest_rows)
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": False,
        "required": ["translations"],
        "properties": {
            "translations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["id", "target"],
                    "properties": {"id": {"type": "string"}, "target": {"type": "string"}},
                },
            }
        },
    }
    (paths["jobs"] / "translation_output.schema.json").write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
    project = {
        "source_epub": str(paths["source"]),
        "source_language": source_name,
        "source_language_code": source_code,
        "target_language": target_name,
        "target_language_code": target_code,
        "opf": opf_rel,
        "serial_files": sorted(serial),
        "spine_files": spine,
        "segments": len(segments),
        "files": len(all_files),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    (paths["jobs"] / "project.json").write_text(json.dumps(project, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    counts = Counter(row["category"] for row in manifest_rows)
    (paths["jobs"] / "translation_progress.md").write_text(
        "# Fast EPUB translation\n\n"
        f"- Files: {len(all_files)}\n- Segments: {len(segments)}\n"
        f"- Parallel content files: {counts['parallel']}\n- Generated serial files: {counts['serial-final']}\n"
        f"- Preserved files: {counts['preserve']}\n- Status: prepared\n",
        encoding="utf-8",
    )
    if remove_input_after_prepare:
        input_epub.unlink()
    return project


def bootstrap_legacy_project(paths: dict[str, Path], target_name: str, target_code: str) -> dict:
    """Adopt a completed translation made by the former file-oriented workflow."""
    if not paths["source"].is_file() or not paths["original"].is_dir() or not paths["working"].is_dir():
        raise RuntimeError("Legacy project is missing original.epub, extracted original, or the working directory")
    paths["jobs"].mkdir(parents=True, exist_ok=True)
    opf_rel = find_package(paths["original"])
    source_name, source_code = package_source_language(paths["original"], opf_rel)
    items, serial, spine = media_inventory(paths["original"], opf_rel)
    all_files = sorted(path.relative_to(paths["original"]).as_posix()
                       for path in paths["original"].rglob("*") if path.is_file())
    working_files = {path.relative_to(paths["working"]).as_posix()
                     for path in paths["working"].rglob("*") if path.is_file()}
    if set(all_files) != working_files:
        raise RuntimeError("Legacy working resource inventory differs from the extracted original")
    manifest_rows = []
    for rel in all_files:
        if rel in serial:
            category, reason, status = "serial-final", "legacy translated navigation/package", "pending"
        elif (paths["original"] / rel).read_bytes() != (paths["working"] / rel).read_bytes():
            category, reason, status = "parallel", "translated by the legacy workflow", "pending"
        else:
            category, reason, status = "preserve", "unchanged legacy resource", "preserved"
        manifest_rows.append({
            "relative_path": rel,
            "media_type": items.get(rel, {}).get("media_type", "application/octet-stream"),
            "category": category,
            "reason": reason,
            "status": status,
        })
    project = {
        "source_epub": str(paths["source"]),
        "source_language": source_name,
        "source_language_code": source_code,
        "target_language": target_name,
        "target_language_code": target_code,
        "opf": opf_rel,
        "serial_files": sorted(serial),
        "spine_files": spine,
        "segments": 0,
        "files": len(all_files),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "adopted_legacy_project": True,
    }
    write_json_atomic(paths["jobs"] / "project.json", project)
    write_jsonl(paths["jobs"] / "translation_manifest.jsonl", manifest_rows)
    write_jsonl(paths["jobs"] / "segments.jsonl", [])
    write_jsonl(paths["jobs"] / "translations.jsonl", [])
    return project


def memory_key(segment: dict, source_code: str, target_code: str, glossary_version: str = "") -> str:
    version = f"|glossary:{glossary_version}" if glossary_version else ""
    return stable_hash(f"{source_code}>{target_code}{version}|{normalize_space(segment['source'])}", 40)


def load_memory(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def merge_memory_atomic(path: Path, updates: dict[str, str], timeout: float = 30.0) -> dict[str, str]:
    """Merge translation-memory entries while serializing concurrent writers."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.with_name(f".{path.name}.lock")
    deadline = time.monotonic() + timeout
    descriptor: int | None = None
    while descriptor is None:
        try:
            descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 300:
                    lock.unlink()
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Timed out waiting for translation-memory lock {lock}")
            time.sleep(0.05)
    try:
        current = load_memory(path)
        current.update(updates)
        write_json_atomic(path, current)
        return current
    finally:
        os.close(descriptor)
        try:
            lock.unlink()
        except FileNotFoundError:
            pass


def load_translations(path: Path) -> dict[str, dict]:
    return {row["id"]: row for row in read_jsonl(path)}


def materialize_exact_translation_aliases(paths: dict[str, Path], project: dict,
                                          segments: list[dict],
                                          completed: dict[str, dict]) -> int:
    """Fill only exact duplicate segments from already approved local translations."""
    resolved: dict[str, dict] = {}
    for segment in segments:
        row = completed.get(segment["id"])
        target = row.get("target") if row else None
        if (
            isinstance(target, str)
            and normalize_space(target)
            and PLACEHOLDER_RE.findall(target) == segment.get("placeholders", [])
        ):
            key = memory_key(segment, project["source_language_code"], project["target_language_code"])
            resolved.setdefault(key, row)
    added = 0
    for segment in segments:
        if segment["id"] in completed:
            continue
        key = memory_key(segment, project["source_language_code"], project["target_language_code"])
        representative = resolved.get(key)
        representative_target = representative.get("target") if representative else None
        if (
            isinstance(representative_target, str)
            and normalize_space(representative_target)
            and PLACEHOLDER_RE.findall(representative_target) == segment.get("placeholders", [])
        ):
            completed[segment["id"]] = {
                "id": segment["id"],
                "target": representative_target,
                "source": "deduplicated-local",
            }
            added += 1
    if added:
        write_jsonl_atomic(
            paths["jobs"] / "translations.jsonl",
            [completed[key] for key in sorted(completed)],
        )
    return added


def estimate_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


def make_batches(segments: list[dict], max_tokens: int) -> list[list[dict]]:
    batches: list[list[dict]] = []
    current: list[dict] = []
    used = 0
    for segment in segments:
        cost = estimate_tokens(segment["source"]) + 24
        if current and used + cost > max_tokens:
            batches.append(current)
            current, used = [], 0
        current.append(segment)
        used += cost
    if current:
        batches.append(current)
    return batches


def validate_translation_rows(batch: list[dict], payload: dict) -> tuple[dict[str, str], dict[str, str], list[str]]:
    """Validate independently so one malformed row does not discard its valid neighbours."""
    expected = {segment["id"]: segment for segment in batch}
    valid: dict[str, str] = {}
    invalid: dict[str, str] = {}
    response_errors: list[str] = []
    if not isinstance(payload, dict) or not isinstance(payload.get("translations"), list):
        return {}, {segment_id: "response does not contain a translations array" for segment_id in expected}, []
    seen: set[str] = set()
    for index, row in enumerate(payload["translations"]):
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not isinstance(row.get("target"), str):
            response_errors.append(f"invalid translation row at index {index}")
            continue
        segment_id = row["id"]
        if segment_id not in expected:
            response_errors.append(f"unexpected segment id {segment_id}")
            continue
        if segment_id in seen:
            valid.pop(segment_id, None)
            invalid[segment_id] = "duplicate segment id"
            continue
        seen.add(segment_id)
        target = normalize_space(row["target"])
        if not target:
            invalid[segment_id] = "empty target"
            continue
        expected_tokens = expected[segment_id].get("placeholders", [])
        actual_tokens = PLACEHOLDER_RE.findall(target)
        if actual_tokens != expected_tokens:
            invalid[segment_id] = "placeholder sequence changed"
            continue
        valid[segment_id] = target
    for segment_id in expected:
        if segment_id not in seen:
            invalid[segment_id] = "missing translation row"
    return valid, invalid, response_errors


def validate_translation_payload(batch: list[dict], payload: dict) -> dict[str, str]:
    valid, invalid, response_errors = validate_translation_rows(batch, payload)
    if invalid or response_errors:
        details = [f"{segment_id}: {reason}" for segment_id, reason in sorted(invalid.items())]
        details.extend(response_errors)
        raise ValueError("; ".join(details))
    return valid


def relevant_glossary(glossary: str, batch: list[dict]) -> str:
    source = " ".join(row["source"] for row in batch).casefold()
    selected: list[str] = []
    for line in glossary.splitlines():
        stripped = line.strip()
        if stripped.startswith("-") and ":" in stripped:
            source_terms = stripped[1:].split(":", 1)[0]
            variants = [normalize_space(term).casefold() for term in re.split(r"[/;]", source_terms)]
            if not any(term and term in source for term in variants):
                continue
        selected.append(line)
    return "\n".join(selected).strip()


def build_prompt(template: str, glossary: str, project: dict, batch: list[dict],
                 repair_reasons: dict[str, str] | None = None) -> str:
    payload = [{"id": row["id"], "file": row["file"], "kind": row["kind"], "source": row["source"]} for row in batch]
    repair = ""
    if repair_reasons:
        repair = (
            "\n\n## Corrections demandées\n\n"
            "Ces segments ont échoué à la validation précédente. Corrige précisément l’erreur indiquée :\n\n"
            + json.dumps(repair_reasons, ensure_ascii=False, separators=(",", ":"))
        )
    return (
        template.rstrip() + "\n\n## Mission\n\n"
        f"SOURCE_LANGUAGE: {project['source_language']}\nTARGET_LANGUAGE: {project['target_language']}\n"
        f"TARGET_LANGUAGE_CODE: {project['target_language_code']}\n\n"
        f"## Glossaire pertinent\n\n{relevant_glossary(glossary, batch)}"
        f"{repair}\n\n## Segments JSON\n\n"
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    )


def classify_codex_failure(log_text: str) -> dict[str, object]:
    """Classify only known terminal failures; leave unfamiliar errors retryable."""
    tail = log_text.splitlines()[-80:]
    for kind, markers in TERMINAL_CODEX_FAILURES.items():
        for line in tail:
            folded = line.casefold()
            same_line_match = any(marker in folded for marker in markers)
            diagnostic_prefix = re.match(r"^\s*(?:error|fatal)\s*:", line, flags=re.I)
            structured_code = "insufficient_quota" in folded
            if same_line_match and (diagnostic_prefix or structured_code):
                return {
                    "kind": kind,
                    "retryable": False,
                    "detail": TERMINAL_CODEX_DETAILS[kind],
                }
    return {"kind": "worker_error", "retryable": True, "detail": ""}


def run_one_batch(paths: dict[str, Path], project: dict, template: str, glossary: str, batch_id: str,
                  batch: list[dict], reasoning_effort: str, attempt: int,
                  repair_reasons: dict[str, str] | None = None,
                  timeout: int = DEFAULT_WORKER_TIMEOUT) -> dict:
    suffix = "" if attempt == 0 else f"-retry{attempt}"
    prompt_path = paths["jobs"] / "prompts" / f"{batch_id}{suffix}.md"
    report_path = paths["jobs"] / "reports" / f"{batch_id}{suffix}.json"
    log_path = paths["jobs"] / "logs" / f"{batch_id}{suffix}.log"
    prompt = build_prompt(template, glossary, project, batch, repair_reasons)
    prompt_path.write_text(prompt, encoding="utf-8")
    command = [
        "codex", "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
        "--ignore-rules", "--color", "never", "-C", str(paths["root"]),
        "--output-schema", str(paths["jobs"] / "translation_output.schema.json"),
        "-c", f'model_reasoning_effort="{reasoning_effort}"',
        "-o", str(report_path), "-",
    ]
    started = time.time()
    try:
        with prompt_path.open("rb") as stdin, log_path.open("wb") as stderr:
            process = subprocess.run(
                command, stdin=stdin, stdout=subprocess.DEVNULL, stderr=stderr, timeout=timeout,
            )
    except subprocess.TimeoutExpired:
        error = f"codex exec timed out after {timeout} seconds"
        return {
            "batch_id": batch_id, "attempt": attempt, "segments": len(batch),
            "exit_code": -1, "seconds": round(time.time() - started, 1),
            "source_tokens_estimated": sum(estimate_tokens(row["source"]) for row in batch),
            "prompt_tokens_estimated": estimate_tokens(prompt), "report": str(report_path),
            "error": error, "response_errors": [], "translations": {},
            "invalid": {row["id"]: error for row in batch},
            "valid_segments": 0, "invalid_segments": len(batch),
        }
    result = {
        "batch_id": batch_id, "attempt": attempt, "segments": len(batch),
        "exit_code": process.returncode, "seconds": round(time.time() - started, 1),
        "source_tokens_estimated": sum(estimate_tokens(row["source"]) for row in batch),
        "prompt_tokens_estimated": estimate_tokens(prompt),
        "report": str(report_path), "error": None, "response_errors": [],
    }
    if process.returncode != 0:
        log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        failure = classify_codex_failure(log_text)
        result["failure_class"] = failure["kind"]
        result["retryable"] = failure["retryable"]
        detail = str(failure["detail"])
        result["error"] = detail or f"codex exec exited with {process.returncode}"
        result["invalid"] = {row["id"]: result["error"] for row in batch}
        result["translations"] = {}
        return result
    try:
        report_text = report_path.read_text(encoding="utf-8")
        result["report_tokens_estimated"] = estimate_tokens(report_text)
        payload = json.loads(report_text)
        translations, invalid, response_errors = validate_translation_rows(batch, payload)
        result["translations"] = translations
        result["invalid"] = invalid
        result["response_errors"] = response_errors
    except Exception as exc:
        result["error"] = str(exc)
        result["invalid"] = {row["id"]: result["error"] for row in batch}
        result["translations"] = {}
    result["valid_segments"] = len(result["translations"])
    result["invalid_segments"] = len(result["invalid"])
    return result


def record_translation_run(paths: dict[str, Path], current: dict) -> dict:
    """Persist each invocation and expose cumulative effort without losing resume history."""
    history_path = paths["jobs"] / "translation_run_history.jsonl"
    summary_path = paths["jobs"] / "translation_run.json"
    history: list[dict] = []
    discarded_history_lines: list[int] = []
    history_backup = ""
    if history_path.exists():
        for line_number, line in enumerate(history_path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                discarded_history_lines.append(line_number)
                continue
            if isinstance(row, dict):
                history.append(row)
            else:
                discarded_history_lines.append(line_number)
        if discarded_history_lines:
            backup = history_path.with_name(
                f"{history_path.stem}.corrupt-{time.time_ns()}{history_path.suffix}"
            )
            shutil.copy2(history_path, backup)
            history_backup = str(backup)
    if not history and summary_path.exists():
        legacy = json.loads(summary_path.read_text(encoding="utf-8"))
        legacy_snapshot = legacy.get("last_run") if isinstance(legacy.get("last_run"), dict) else legacy
        if isinstance(legacy_snapshot, dict) and legacy_snapshot:
            legacy_snapshot = dict(legacy_snapshot)
            legacy_snapshot.setdefault("run_number", 1)
            history.append(legacy_snapshot)
    snapshot = dict(current)
    snapshot["run_number"] = max((int(row.get("run_number", 0)) for row in history), default=0) + 1
    snapshot["recorded_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    history.append(snapshot)
    write_jsonl_atomic(history_path, history)

    aggregate = dict(snapshot)
    sum_fields = (
        "initial_batches", "repair_batches", "batch_attempts", "first_pass_invalid",
        "repair_segments_submitted", "salvaged_valid_segments", "external_blocked_segments", "wall_seconds",
        "worker_seconds", "source_tokens_submitted_estimated",
        "prompt_tokens_submitted_estimated", "report_tokens_estimated",
    )
    for field in sum_fields:
        aggregate[field] = round(sum(float(row.get(field, 0)) for row in history), 1)
        if field not in {"wall_seconds", "worker_seconds"}:
            aggregate[field] = int(aggregate[field])
    aggregate["memory_hits"] = sum(int(row.get("memory_hits", 0)) for row in history)
    aggregate["unique_pending_segments"] = max(
        (int(row.get("unique_pending_segments", 0)) for row in history), default=0
    )
    aggregate["deduplicated"] = max((int(row.get("deduplicated", 0)) for row in history), default=0)
    aggregate["attempts"] = [
        {**attempt, "run_number": row.get("run_number", index)}
        for index, row in enumerate(history, start=1)
        for attempt in row.get("attempts", [])
    ]
    aggregate["runs"] = len(history)
    aggregate["history_file"] = history_path.name
    if discarded_history_lines:
        aggregate["history_recovery"] = {
            "discarded_lines": discarded_history_lines,
            "backup": history_backup,
        }
    aggregate["last_run"] = snapshot
    write_json_atomic(summary_path, aggregate)
    return aggregate


def translate(paths: dict[str, Path], workers: int, batch_tokens: int, repair_tokens: int,
              max_retries: int, reasoning_effort: str,
              worker_timeout: int = DEFAULT_WORKER_TIMEOUT) -> dict:
    translation_started = time.time()
    project = json.loads((paths["jobs"] / "project.json").read_text(encoding="utf-8"))
    segments = read_jsonl(paths["jobs"] / "segments.jsonl")
    segments_by_id = {segment["id"]: segment for segment in segments}
    translations_path = paths["jobs"] / "translations.jsonl"
    completed = load_translations(translations_path)
    already_completed = len(completed)
    glossary = (paths["jobs"] / "translation_glossary.md").read_text(encoding="utf-8")
    glossary_version = stable_hash(glossary, 12)
    source_code = project["source_language_code"]
    target_code = project["target_language_code"]

    local_memory = load_memory(paths["memory"])
    global_memory = load_memory(paths["global_memory"])
    combined_memory = {**global_memory, **local_memory}
    memory_hits = 0
    for segment in segments:
        if segment["id"] in completed:
            continue
        current_key = memory_key(segment, source_code, target_code, glossary_version)
        target = combined_memory.get(current_key)
        if target is not None:
            completed[segment["id"]] = {"id": segment["id"], "target": target, "source": "memory"}
            memory_hits += 1

    resolved_by_key: dict[str, str] = {}
    for segment_id in completed:
        segment = segments_by_id.get(segment_id)
        if segment:
            resolved_by_key[memory_key(segment, source_code, target_code, glossary_version)] = segment_id
    unique_pending: list[dict] = []
    aliases: dict[str, str] = {}
    representative_by_key: dict[str, str] = dict(resolved_by_key)
    for segment in segments:
        if segment["id"] in completed:
            continue
        key = memory_key(segment, source_code, target_code, glossary_version)
        if key in representative_by_key:
            aliases[segment["id"]] = representative_by_key[key]
        else:
            representative_by_key[key] = segment["id"]
            unique_pending.append(segment)

    results: list[dict] = []
    batch_rows: list[dict] = []
    initial_batches = 0
    repair_batches = 0
    repair_segments_submitted = 0
    salvaged_segments = 0
    first_pass_invalid = 0
    external_blocked_segments = 0
    attempt_metrics: list[dict] = []
    pending = unique_pending
    pending_reasons: dict[str, str] = {}
    blocking_failure: dict[str, object] | None = None
    template = Path(__file__).with_name("translate_epub_file.md").read_text(encoding="utf-8")

    for attempt in range(max_retries + 1):
        if not pending:
            break
        token_limit = batch_tokens if attempt == 0 else repair_tokens
        wave_batches = make_batches(pending, token_limit)
        if attempt == 0:
            initial_batches = len(wave_batches)
            prefix = "b"
        else:
            repair_batches += len(wave_batches)
            repair_segments_submitted += len(pending)
            prefix = f"r{attempt}-"
        indexed_batches: list[tuple[str, list[dict], dict[str, str]]] = []
        for index, batch in enumerate(wave_batches, start=1):
            signature = stable_hash("|".join(row["id"] for row in batch), 8)
            batch_id = f"{prefix}{index:04d}-{signature}"
            reasons = {row["id"]: pending_reasons[row["id"]] for row in batch if row["id"] in pending_reasons}
            indexed_batches.append((batch_id, batch, reasons))
            batch_rows.append({
                "batch_id": batch_id,
                "attempt": attempt,
                "token_limit": token_limit,
                "segment_ids": [row["id"] for row in batch],
            })
            (paths["jobs"] / "batches" / f"{batch_id}.json").write_text(
                json.dumps(batch, ensure_ascii=False) + "\n", encoding="utf-8"
            )
        write_json_atomic(paths["jobs"] / "batches.json", batch_rows)

        next_pending: dict[str, str] = {}
        wave_started = time.time()
        valid_in_wave = 0
        blocked_in_wave = 0
        with ThreadPoolExecutor(max_workers=min(max(1, workers), len(indexed_batches))) as executor:
            futures = {
                executor.submit(
                    run_one_batch, paths, project, template, glossary, batch_id, batch,
                    reasoning_effort, attempt, reasons, worker_timeout,
                ): (batch_id, batch)
                for batch_id, batch, reasons in indexed_batches
            }
            for future in as_completed(futures):
                batch_id, batch = futures[future]
                try:
                    result = future.result()
                except CancelledError:
                    detail = (
                        str(blocking_failure["detail"])
                        if blocking_failure else "Cancelled after an external Codex blocker."
                    )
                    result = {
                        "batch_id": batch_id, "attempt": attempt, "segments": len(batch),
                        "exit_code": -1, "seconds": 0.0, "error": detail, "response_errors": [],
                        "failure_class": (
                            blocking_failure["kind"] if blocking_failure else "external"
                        ),
                        "retryable": False,
                        "translations": {}, "invalid": {row["id"]: detail for row in batch},
                        "valid_segments": 0, "invalid_segments": len(batch),
                    }
                except Exception as exc:
                    result = {
                        "batch_id": batch_id, "attempt": attempt, "segments": len(batch),
                        "exit_code": -1, "seconds": 0.0, "error": str(exc), "response_errors": [],
                        "translations": {}, "invalid": {row["id"]: str(exc) for row in batch},
                        "valid_segments": 0, "invalid_segments": len(batch),
                    }
                translations = result.get("translations", {})
                invalid = result.get("invalid", {})
                valid_in_wave += len(translations)
                if translations and invalid:
                    salvaged_segments += len(translations)
                for segment_id, target in translations.items():
                    completed[segment_id] = {
                        "id": segment_id, "target": target, "source": "worker",
                        "batch_id": batch_id, "attempt": attempt,
                    }
                for segment_id, reason in invalid.items():
                    if segment_id in segments_by_id:
                        next_pending[segment_id] = reason
                if result.get("retryable") is False:
                    blocked_in_wave += len(invalid)
                if result.get("retryable") is False and blocking_failure is None:
                    blocking_failure = {
                        "kind": result.get("failure_class", "external"),
                        "detail": result.get("error", "Codex cannot continue this run"),
                        "batch_id": batch_id,
                    }
                    for pending_future in futures:
                        if pending_future is not future and not pending_future.done():
                            pending_future.cancel()
                results.append({k: v for k, v in result.items() if k not in {"translations", "invalid"}} | {
                    "valid_segments": len(translations),
                    "invalid_segments": len(invalid),
                    "invalid_reasons": Counter(invalid.values()),
                })
                write_jsonl_atomic(translations_path, [completed[key] for key in sorted(completed)])
        if attempt == 0:
            first_pass_invalid = max(0, len(next_pending) - blocked_in_wave)
        external_blocked_segments += blocked_in_wave
        attempt_metrics.append({
            "attempt": attempt,
            "batches": len(indexed_batches),
            "submitted_segments": len(pending),
            "valid_segments": valid_in_wave,
            "invalid_segments": max(0, len(next_pending) - blocked_in_wave),
            "blocked_segments": blocked_in_wave,
            "wall_seconds": round(time.time() - wave_started, 1),
        })
        pending = [segments_by_id[segment_id] for segment_id in next_pending]
        pending_reasons = next_pending
        if blocking_failure is not None:
            break

    failures = [segment["id"] for segment in pending]
    if not failures:
        for alias, representative in aliases.items():
            if representative not in completed:
                failures.append(representative)
                continue
            completed[alias] = {
                "id": alias, "target": completed[representative]["target"], "source": "deduplicated"
            }
    write_jsonl_atomic(translations_path, [completed[key] for key in sorted(completed)])

    memory_updates: dict[str, str] = {}
    for segment_id, row in completed.items():
        segment = segments_by_id.get(segment_id)
        if segment:
            memory_updates[memory_key(segment, source_code, target_code, glossary_version)] = row["target"]
    merge_memory_atomic(paths["memory"], memory_updates)
    merge_memory_atomic(paths["global_memory"], memory_updates)
    write_json_atomic(paths["jobs"] / "batch_results.json", results)

    wall_seconds = round(time.time() - translation_started, 1)
    worker_seconds = round(sum(float(row.get("seconds", 0)) for row in results), 1)
    source_tokens_submitted = sum(int(row.get("source_tokens_estimated", 0)) for row in results)
    prompt_tokens_submitted = sum(int(row.get("prompt_tokens_estimated", 0)) for row in results)
    report_tokens_estimated = sum(int(row.get("report_tokens_estimated", 0)) for row in results)
    stats = {
        "status": "blocked_external" if blocking_failure else ("incomplete" if failures else "complete"),
        "segments": len(segments),
        "unique_pending_segments": len(unique_pending),
        "already_completed": already_completed,
        "memory_hits": memory_hits,
        "deduplicated": len(aliases),
        "initial_batches": initial_batches,
        "repair_batches": repair_batches,
        "batch_attempts": len(results),
        "first_pass_invalid": first_pass_invalid,
        "external_blocked_segments": external_blocked_segments,
        "repair_segments_submitted": repair_segments_submitted,
        "salvaged_valid_segments": salvaged_segments,
        "workers": workers,
        "batch_tokens": batch_tokens,
        "repair_tokens": repair_tokens,
        "reasoning_effort": reasoning_effort,
        "glossary_version": glossary_version,
        "wall_seconds": wall_seconds,
        "worker_seconds": worker_seconds,
        "source_tokens_submitted_estimated": source_tokens_submitted,
        "prompt_tokens_submitted_estimated": prompt_tokens_submitted,
        "report_tokens_estimated": report_tokens_estimated,
        "attempts": attempt_metrics,
        "failures": failures,
        "blocking_failure": blocking_failure,
    }
    stats = record_translation_run(paths, stats)
    blocker_line = ""
    if blocking_failure:
        blocker_line = (
            f"- External blocker: {blocking_failure['kind']} — "
            f"{clean_metadata_text(str(blocking_failure['detail']))}\n"
        )
    (paths["jobs"] / "translation_progress.md").write_text(
        "# Fast EPUB translation\n\n"
        f"- Status: {stats['status']}\n"
        f"- Completed segments: {len(completed)} / {len(segments)}\n"
        f"- Recorded runs: {stats.get('runs', 1)}\n"
        f"- Initial translation batches: {stats.get('initial_batches', 0)}\n"
        f"- Repair batches: {stats.get('repair_batches', 0)}\n"
        f"- Cumulative translation time: {stats.get('wall_seconds', 0)} seconds\n"
        f"{blocker_line}",
        encoding="utf-8",
    )
    if failures:
        if blocking_failure:
            raise RuntimeError(
                f"Translation paused by {blocking_failure['kind']}: {blocking_failure['detail']}. "
                "Valid translations were preserved; resume when the external condition is resolved."
            )
        preview = ", ".join(failures[:20])
        suffix = "…" if len(failures) > 20 else ""
        raise RuntimeError(f"Translation failed for {len(failures)} segment(s): {preview}{suffix}")
    return stats


def apply_target_to_element(element: ET.Element, target: str, expected_tokens: list[str]) -> None:
    _, current_tokens, slots = flatten_content(element)
    if current_tokens != expected_tokens:
        raise RuntimeError("Document structure changed between extraction and reinsertion")
    actual_tokens = PLACEHOLDER_RE.findall(target)
    if actual_tokens != expected_tokens:
        raise RuntimeError("Translated placeholders do not match the source structure")
    pieces = PLACEHOLDER_RE.split(target)
    if len(pieces) != len(slots):
        raise RuntimeError("Translated mixed-content slot count is invalid")
    for (owner, field), value in zip(slots, pieces):
        setattr(owner, field, value)


def consume_doctype(text: str, start: int) -> int:
    quote = ""
    subset_depth = 0
    index = start
    while index < len(text):
        character = text[index]
        if quote:
            if character == quote:
                quote = ""
        elif character in {'"', "'"}:
            quote = character
        elif character == "[":
            subset_depth += 1
        elif character == "]" and subset_depth:
            subset_depth -= 1
        elif character == ">" and subset_depth == 0:
            return index + 1
        index += 1
    return start


def xml_prologue_extras(path: Path) -> list[str]:
    """Keep a source document's DOCTYPE, leading comments and processing instructions."""
    if not path.exists():
        return []
    text = read_xml_text(path)
    position = 0
    declaration = re.match(r"\s*<\?xml\b.*?\?>", text, re.I | re.S)
    if declaration:
        position = declaration.end()
    extras: list[str] = []
    while position < len(text):
        whitespace = re.match(r"\s*", text[position:])
        position += whitespace.end() if whitespace else 0
        if text.startswith("<!--", position):
            end = text.find("-->", position + 4)
            if end < 0:
                break
            extras.append(text[position:end + 3])
            position = end + 3
        elif text.startswith("<?", position):
            end = text.find("?>", position + 2)
            if end < 0:
                break
            extras.append(text[position:end + 2])
            position = end + 2
        elif text[position:position + 9].casefold() == "<!doctype":
            end = consume_doctype(text, position)
            if end == position:
                break
            extras.append(text[position:end])
            position = end
        else:
            break
    return extras


def write_tree(tree: ET.ElementTree, path: Path) -> None:
    extras = xml_prologue_extras(path)
    payload = ET.tostring(tree.getroot(), encoding="utf-8", xml_declaration=True,
                          short_empty_elements=True)
    if extras:
        declaration_end = payload.find(b"?>") + 2
        insertion = ("\n" + "\n".join(extras)).encode("utf-8")
        payload = payload[:declaration_end] + insertion + payload[declaration_end:]
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_bytes(payload)
    os.replace(temporary, path)


def visible_text(element: ET.Element) -> str:
    return normalize_space("".join(element.itertext()))


def set_visible_text(element: ET.Element, value: str) -> None:
    fields: list[tuple[ET.Element, str]] = []
    for node in element.iter():
        if node.text is not None:
            fields.append((node, "text"))
        for child in list(node):
            if child.tail is not None:
                fields.append((child, "tail"))
    chosen = next(((owner, field) for owner, field in fields if normalize_space(getattr(owner, field))), None)
    for owner, field in fields:
        setattr(owner, field, "")
    if chosen:
        setattr(chosen[0], chosen[1], value)
    else:
        element.text = value


def heading_title_pair(source_heading: ET.Element, target_heading: ET.Element) -> tuple[str, str]:
    """Return the most navigation-friendly source/target title for a heading."""
    source_attribute = normalize_space(source_heading.attrib.get("title"))
    target_attribute = normalize_space(target_heading.attrib.get("title"))
    if source_attribute and target_attribute:
        return source_attribute, target_attribute
    return visible_text(source_heading), visible_text(target_heading)


def id_heading_map(original: Path, working: Path, rels: list[str]) -> dict[tuple[str, str], tuple[str, str]]:
    result: dict[tuple[str, str], tuple[str, str]] = {}
    heading_tags = {"h1", "h2", "h3", "h4", "h5", "h6"}
    for rel in rels:
        source_path, target_path = original / rel, working / rel
        if not source_path.exists() or not target_path.exists():
            continue
        try:
            source_root = parse_xml(source_path).getroot()
            target_root = parse_xml(target_path).getroot()
        except ET.ParseError:
            continue
        source_paths, source_parents = element_paths(source_root)
        source_order = list(source_root.iter())
        default_heading = next(
            (node for node in source_order
             if local_name(node.tag) in heading_tags
             and (normalize_space(node.attrib.get("title")) or visible_text(node))),
            None,
        )
        if default_heading is not None:
            path = source_paths.get(id(default_heading))
            if path is not None:
                try:
                    target_heading = element_at(target_root, path)
                except (IndexError, KeyError):
                    pass
                else:
                    # The empty fragment is the canonical destination for links such as
                    # ``Chapter1.xhtml``. Many production EPUBs omit heading anchors.
                    result[(rel, "")] = heading_title_pair(default_heading, target_heading)
        for element in source_order:
            fragment = element.attrib.get("id")
            if not fragment:
                continue
            heading = element
            while heading is not None and local_name(heading.tag) not in heading_tags:
                heading = source_parents.get(id(heading))
            if heading is None:
                continue
            source_title = visible_text(heading)
            if re.fullmatch(r"(?:chapter|chapitre)\s+\d+", source_title, re.I) and re.fullmatch(r"ch\d+", fragment, re.I):
                start = source_order.index(heading) + 1
                heading = next((node for node in source_order[start:] if local_name(node.tag) in heading_tags and "h2a" in node.attrib.get("class", "").split()), heading)
                source_title = visible_text(heading)
            path = source_paths.get(id(heading))
            if path is None:
                continue
            try:
                target_heading = element_at(target_root, path)
            except (IndexError, KeyError):
                continue
            mapped_source, mapped_target = heading_title_pair(heading, target_heading)
            result[(rel, fragment)] = (
                mapped_source or source_title,
                mapped_target or visible_text(target_heading),
            )
    return result


def translated_label(source_label: str, source_title: str, target_title: str) -> str | None:
    source_label_n = normalize_space(source_label)
    source_title_n = normalize_space(source_title)
    if source_label_n.casefold() == source_title_n.casefold():
        return target_title
    if source_label_n.casefold().endswith(source_title_n.casefold()):
        prefix = source_label_n[: len(source_label_n) - len(source_title_n)]
        return prefix + target_title
    return None


def navigation_label_replacement(source_label: str, href: str, rel: str,
                                 heading_map: dict[tuple[str, str], tuple[str, str]],
                                 ui: dict[str, str]) -> str | None:
    """Resolve a local navigation label, including document links without fragments."""
    parts = urlsplit(href)
    if parts.scheme or parts.netloc:
        return None
    source_label_n = normalize_space(source_label)
    if source_label_n in ui:
        return ui[source_label_n]
    target_rel = (Path(rel).parent / unquote(parts.path)).as_posix() if parts.path else rel
    mapping = heading_map.get((target_rel, unquote(parts.fragment)))
    if not mapping:
        return None
    return translated_label(source_label_n, mapping[0], mapping[1])


def document_title_replacement(source_label: str, rel: str,
                               heading_map: dict[tuple[str, str], tuple[str, str]],
                               ui: dict[str, str], source_book_title: str,
                               target_book_title: str) -> str | None:
    """Localize document titles that combine the book title with a UI or chapter label."""
    source_label_n = normalize_space(source_label)
    if source_label_n in ui:
        return ui[source_label_n]
    source_book_title_n = normalize_space(source_book_title)
    target_book_title_n = normalize_space(target_book_title)
    source_title_variants = []
    for candidate in (source_book_title_n, source_book_title_n.rstrip(".!?…")):
        if candidate and candidate not in source_title_variants:
            source_title_variants.append(candidate)
    for source_title_variant in source_title_variants:
        if source_label_n.casefold() == source_title_variant.casefold():
            return target_book_title_n or None
        prefix = source_title_variant + ":"
        if not source_label_n.casefold().startswith(prefix.casefold()):
            continue
        suffix = normalize_space(source_label_n[len(prefix):])
        if suffix in ui:
            return f"{target_book_title_n} : {ui[suffix]}" if target_book_title_n else ui[suffix]
        mapping = heading_map.get((rel, ""))
        if mapping:
            mapped_source, mapped_target = map(normalize_space, mapping)
            if mapped_source.casefold().startswith(suffix.casefold()):
                # Preserve a short source suffix such as "Chapter 1" when the
                # canonical heading is "Chapter 1: Full title".
                target_suffix = mapped_target
                if len(suffix) < len(mapped_source) and ":" in mapped_source and ":" in mapped_target:
                    target_suffix = mapped_target.split(":", 1)[0].strip()
                return f"{target_book_title_n} : {target_suffix}" if target_book_title_n else target_suffix
    mapping = heading_map.get((rel, ""))
    if mapping:
        return translated_label(source_label_n, mapping[0], mapping[1])
    return None


def sync_xhtml_links(source_path: Path, target_path: Path, rel: str,
                     heading_map: dict[tuple[str, str], tuple[str, str]], ui: dict[str, str],
                     source_book_title: str = "", target_book_title: str = "") -> None:
    source_tree, target_tree = parse_xml(source_path), parse_xml(target_path)
    source_nodes, target_nodes = list(source_tree.getroot().iter()), list(target_tree.getroot().iter())
    if len(source_nodes) != len(target_nodes):
        raise RuntimeError(f"Cannot synchronize navigation structure for {rel}")
    for source, target in zip(source_nodes, target_nodes):
        if local_name(source.tag) not in {"a", "h1", "h2", "h3", "title"}:
            continue
        if local_name(source.tag) != "a":
            label = visible_text(source)
            replacement = document_title_replacement(
                label, rel, heading_map, ui, source_book_title, target_book_title,
            )
            if replacement:
                set_visible_text(target, replacement)
            continue
        href = source.attrib.get("href")
        if not href:
            continue
        replacement = navigation_label_replacement(visible_text(source), href, rel, heading_map, ui)
        protected_descendant = any(
            node is not target and (local_name(node.tag) in PROTECTED_TAGS or has_protected_class(node))
            for node in target.iter()
        )
        if replacement and not protected_descendant:
            set_visible_text(target, replacement)
    root = target_tree.getroot()
    if root.attrib.get("lang"):
        root.attrib["lang"] = ui.get("__code__", root.attrib["lang"])
    if root.attrib.get(XML_LANG):
        root.attrib[XML_LANG] = ui.get("__code__", root.attrib[XML_LANG])
    write_tree(target_tree, target_path)


def sync_ncx(source_path: Path, target_path: Path, rel: str,
             heading_map: dict[tuple[str, str], tuple[str, str]], title: str,
             target_code: str, ui: dict[str, str]) -> None:
    source_tree, target_tree = parse_xml(source_path), parse_xml(target_path)
    source_points = [e for e in source_tree.getroot().iter() if local_name(e.tag) == "navPoint"]
    target_points = [e for e in target_tree.getroot().iter() if local_name(e.tag) == "navPoint"]
    for source_point, target_point in zip(source_points, target_points):
        source_content = next((e for e in source_point.iter() if local_name(e.tag) == "content"), None)
        source_text = next((e for e in source_point.iter() if local_name(e.tag) == "text"), None)
        target_text = next((e for e in target_point.iter() if local_name(e.tag) == "text"), None)
        if source_content is None or source_text is None or target_text is None:
            continue
        replacement = navigation_label_replacement(
            visible_text(source_text), source_content.attrib.get("src", ""), rel, heading_map, ui,
        )
        if replacement:
            target_text.text = replacement
    doc_title = next((e for e in target_tree.getroot().iter() if local_name(e.tag) == "docTitle"), None)
    if doc_title is not None:
        text_node = next((e for e in doc_title.iter() if local_name(e.tag) == "text"), None)
        if text_node is not None:
            text_node.text = title
    target_tree.getroot().attrib[XML_LANG] = target_code
    write_tree(target_tree, target_path)


def translated_book_title(opf_path: Path) -> str:
    root = parse_xml(opf_path).getroot()
    node = next((e for e in root.iter() if local_name(e.tag) == "title" and namespace(e.tag) == DC_NS), None)
    return visible_text(node) if node is not None else ""


def package_version(root: ET.Element) -> float:
    raw = root.attrib.get("version", "").strip()
    match = re.match(r"^\d+(?:\.\d+)?", raw)
    return float(match.group(0)) if match else 2.0


def safe_resource_path(root_dir: Path, relative_path: str) -> Path:
    """Resolve a manifest resource while keeping it inside the extracted EPUB."""
    candidate_rel = Path(relative_path)
    if candidate_rel.is_absolute():
        raise RuntimeError(f"Unsafe absolute EPUB resource path: {relative_path}")
    root = root_dir.resolve()
    candidate = (root / candidate_rel).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise RuntimeError(f"EPUB resource escapes the extracted root: {relative_path}") from exc
    return candidate


def find_cover_resource(root_dir: Path, opf_rel: str) -> str | None:
    root = parse_xml(root_dir / opf_rel).getroot()
    opf_dir = Path(opf_rel).parent
    cover_id = next(
        (node.attrib.get("content") for node in root.iter()
         if local_name(node.tag) == "meta" and node.attrib.get("name") == "cover"),
        None,
    )
    items = []
    for node in root.iter():
        if local_name(node.tag) != "item" or not node.attrib.get("href"):
            continue
        item_id = node.attrib.get("id", "")
        href = unquote(node.attrib["href"])
        rel = (opf_dir / href).as_posix()
        try:
            safe_resource_path(root_dir, rel)
        except RuntimeError:
            continue
        items.append({
            "id": item_id,
            "href": href,
            "rel": rel,
            "media_type": node.attrib.get("media-type", ""),
            "properties": node.attrib.get("properties", "").split(),
        })
    image_items = [item for item in items if item["media_type"].casefold().startswith("image/")]
    property_cover = next((item for item in image_items if "cover-image" in item["properties"]), None)
    if package_version(root) >= 3 and property_cover:
        return property_cover["rel"]
    if cover_id:
        declared = next((item for item in image_items if item["id"] == cover_id), None)
        if declared:
            return declared["rel"]
        # Some EPUB 2 producers incorrectly store the image href instead of the
        # manifest id. Treat that as a strong selection hint, then canonicalize it
        # during the editorial stage.
        declared_by_href = next(
            (
                item for item in image_items
                if item["href"] == unquote(cover_id)
                or item["rel"] == (opf_dir / unquote(cover_id)).as_posix()
            ),
            None,
        )
        if declared_by_href:
            return declared_by_href["rel"]
    if property_cover:
        return property_cover["rel"]
    heuristic = next(
        (item for item in image_items if "cover" in f"{item['id']} {item['href']}".casefold()),
        None,
    )
    return heuristic["rel"] if heuristic else None


def normalize_cover_declaration(root: ET.Element, opf_rel: str, cover_rel: str | None) -> dict:
    """Canonicalize the selected cover without changing which image the pipeline chose."""
    result = {
        "resource": cover_rel,
        "manifest_id": "",
        "meta_updated": False,
        "cover_image_property_added": False,
        "cover_image_properties_removed": [],
    }
    if not cover_rel:
        return result
    opf_dir = Path(opf_rel).parent
    cover_item = next(
        (
            node for node in root.iter()
            if local_name(node.tag) == "item"
            and node.attrib.get("id")
            and node.attrib.get("media-type", "").casefold().startswith("image/")
            and (opf_dir / unquote(node.attrib.get("href", ""))).as_posix() == cover_rel
        ),
        None,
    )
    if cover_item is None:
        return result
    cover_id = cover_item.attrib["id"]
    result["manifest_id"] = cover_id
    metadata = next((node for node in root.iter() if local_name(node.tag) == "metadata"), None)
    if metadata is not None:
        cover_meta = next(
            (
                node for node in metadata
                if local_name(node.tag) == "meta" and node.attrib.get("name") == "cover"
            ),
            None,
        )
        if cover_meta is None:
            cover_meta = ET.SubElement(metadata, f"{{{OPF_NS}}}meta")
            cover_meta.attrib["name"] = "cover"
        if cover_meta.attrib.get("content") != cover_id:
            cover_meta.attrib["content"] = cover_id
            result["meta_updated"] = True
    if package_version(root) >= 3:
        removed_from = []
        for node in root.iter():
            if local_name(node.tag) != "item" or node is cover_item:
                continue
            properties = node.attrib.get("properties", "").split()
            if "cover-image" not in properties:
                continue
            properties = [value for value in properties if value != "cover-image"]
            if properties:
                node.attrib["properties"] = " ".join(properties)
            else:
                node.attrib.pop("properties", None)
            removed_from.append(node.attrib.get("id", ""))
        result["cover_image_properties_removed"] = removed_from
        properties = cover_item.attrib.get("properties", "").split()
        if "cover-image" not in properties:
            cover_item.attrib["properties"] = " ".join([*properties, "cover-image"])
            result["cover_image_property_added"] = True
    return result


def image_dimensions(path: Path) -> tuple[int, int] | None:
    """Read common raster dimensions without adding a runtime image dependency."""
    data = path.read_bytes()
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24 and data[12:16] == b"IHDR":
        width, height = struct.unpack(">II", data[16:24])
        return (width, height) if width > 0 and height > 0 else None
    if data.startswith((b"GIF87a", b"GIF89a")) and len(data) >= 10:
        width, height = struct.unpack("<HH", data[6:10])
        return (width, height) if width > 0 and height > 0 else None
    if data.startswith(b"\xff\xd8"):
        index = 2
        start_of_frame = {
            0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
            0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
        }
        while index + 4 <= len(data):
            if data[index] != 0xFF:
                index += 1
                continue
            while index < len(data) and data[index] == 0xFF:
                index += 1
            if index >= len(data):
                break
            marker = data[index]
            index += 1
            if marker in {0xD8, 0xD9}:
                continue
            if index + 2 > len(data):
                break
            length = struct.unpack(">H", data[index:index + 2])[0]
            if length < 2 or index + length > len(data):
                break
            if marker in start_of_frame and length >= 7:
                height, width = struct.unpack(">HH", data[index + 3:index + 7])
                return (width, height) if width > 0 and height > 0 else None
            index += length
    return None


def source_editorial_context(paths: dict[str, Path], project: dict) -> dict:
    opf_root = parse_xml(paths["original"] / project["opf"]).getroot()
    metadata = []
    for node in opf_root.iter():
        if namespace(node.tag) == DC_NS:
            metadata.append({
                "field": local_name(node.tag),
                "value": clean_metadata_text("".join(node.itertext())),
                "attributes": {local_name(key): value for key, value in node.attrib.items()},
            })
    items, _, spine = media_inventory(paths["original"], project["opf"])
    preferred = ("titlepage", "title", "copyright", "about-this-book", "preface", "foreword")
    front_matter = []
    ranked = sorted(
        (rel for rel in spine if items.get(rel, {}).get("media_type") in {"application/xhtml+xml", "application/x-dtbook+xml"}),
        key=lambda rel: next((index for index, name in enumerate(preferred) if name in Path(rel).stem.casefold()), 99),
    )
    for rel in ranked[:6]:
        try:
            text = clean_metadata_text(" ".join(parse_xml(paths["original"] / rel).getroot().itertext()))
        except ET.ParseError:
            continue
        if text:
            front_matter.append({"file": rel, "text": text[:5000]})
    return {
        "source_language": project["source_language"],
        "target_language": project["target_language"],
        "target_language_code": project["target_language_code"],
        "opf_metadata": metadata,
        "front_matter": front_matter,
        "cover_resource": find_cover_resource(paths["original"], project["opf"]),
    }


def editorial_schema() -> dict:
    string = {"type": "string"}
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": False,
        "required": [
            "title", "subtitle", "full_title", "title_sort", "creators", "publisher",
            "publication_date", "description", "subjects", "cover_text",
            "front_matter_replacements", "notes",
        ],
        "properties": {
            "title": string, "subtitle": string, "full_title": string, "title_sort": string,
            "creators": {"type": "array", "items": string, "minItems": 1},
            "publisher": string, "publication_date": string, "description": string,
            "subjects": {"type": "array", "items": string, "minItems": 3, "maxItems": 7},
            "cover_text": {
                "type": "object", "additionalProperties": False,
                "required": ["title", "subtitle", "author", "contributor"],
                "properties": {"title": string, "subtitle": string, "author": string, "contributor": string},
            },
            "front_matter_replacements": {
                "type": "array",
                "items": {
                    "type": "object", "additionalProperties": False,
                    "required": ["source", "target"],
                    "properties": {"source": string, "target": string},
                },
            },
            "notes": {"type": "array", "items": string},
        },
    }


def validate_editorial_decision(payload: object) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Editorial response is not a JSON object")
    allowed_fields = set(editorial_schema()["required"])
    unknown_fields = sorted(set(payload) - allowed_fields)
    if unknown_fields:
        raise ValueError(f"Editorial response contains unknown fields: {', '.join(unknown_fields)}")
    required_strings = ("title", "subtitle", "full_title", "title_sort", "publisher", "publication_date", "description")
    for key in required_strings:
        if not isinstance(payload.get(key), str):
            raise ValueError(f"Editorial field {key} is missing or invalid")
        payload[key] = clean_metadata_text(payload[key])
    for key in ("creators", "subjects", "notes"):
        if not isinstance(payload.get(key), list) or not all(isinstance(value, str) for value in payload[key]):
            raise ValueError(f"Editorial field {key} is missing or invalid")
        payload[key] = [clean_metadata_text(value) for value in payload[key] if clean_metadata_text(value)]
    if not payload["title"] or not payload["full_title"] or not payload["creators"]:
        raise ValueError("Editorial title and creator fields must not be empty")
    if not 3 <= len(payload["subjects"]) <= 7:
        raise ValueError("Editorial subjects must contain between 3 and 7 values")
    cover_text = payload.get("cover_text")
    if not isinstance(cover_text, dict):
        raise ValueError("Editorial cover_text is missing or invalid")
    unknown_cover_fields = sorted(set(cover_text) - {"title", "subtitle", "author", "contributor"})
    if unknown_cover_fields:
        raise ValueError(f"Editorial cover_text contains unknown fields: {', '.join(unknown_cover_fields)}")
    for key in ("title", "subtitle", "author", "contributor"):
        if not isinstance(cover_text.get(key), str):
            raise ValueError(f"Editorial cover_text.{key} is missing or invalid")
        cover_text[key] = clean_metadata_text(cover_text[key])
    replacements = payload.setdefault("front_matter_replacements", [])
    if not isinstance(replacements, list):
        raise ValueError("Editorial front_matter_replacements is invalid")
    cleaned_replacements = []
    for replacement in replacements:
        if not isinstance(replacement, dict) or not isinstance(replacement.get("source"), str) \
                or not isinstance(replacement.get("target"), str):
            raise ValueError("Each front-matter replacement needs source and target strings")
        unknown_replacement_fields = sorted(set(replacement) - {"source", "target"})
        if unknown_replacement_fields:
            raise ValueError(
                "Editorial front-matter replacement contains unknown fields: "
                + ", ".join(unknown_replacement_fields)
            )
        source = clean_metadata_text(replacement["source"])
        target = clean_metadata_text(replacement["target"])
        if source and target:
            cleaned_replacements.append({"source": source, "target": target})
    payload["front_matter_replacements"] = cleaned_replacements
    return payload


def record_editorial_failure(editorial_dir: Path, kind: str, retryable: bool,
                             detail: str, log_path: Path) -> dict:
    failure_report = {
        "status": "error" if retryable else "blocked_external",
        "kind": kind,
        "retryable": retryable,
        "detail": clean_metadata_text(detail)[:300],
        "log": str(log_path),
        "recovery": "Resume later, or provide a schema-valid decision with --editorial-decision.",
    }
    write_json_atomic(editorial_dir / "editorial_failure.json", failure_report)
    return failure_report


def run_editorial_review(paths: dict[str, Path], project: dict, reasoning_effort: str, resume: bool,
                         timeout: int = DEFAULT_EDITORIAL_TIMEOUT,
                         decision_source: Path | None = None) -> dict:
    editorial_dir = paths["jobs"] / "editorial"
    editorial_dir.mkdir(parents=True, exist_ok=True)
    context = source_editorial_context(paths, project)
    context_path = editorial_dir / "editorial_context.json"
    decision_path = editorial_dir / "metadata_decision.json"
    context_path.write_text(json.dumps(context, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if decision_source is not None:
        source = decision_source.resolve()
        if not source.is_file():
            raise FileNotFoundError(source)
        try:
            payload = json.loads(source.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"Invalid editorial decision JSON in {source}: {exc.msg} "
                f"at line {exc.lineno}, column {exc.colno}"
            ) from exc
        decision = validate_editorial_decision(payload)
        write_json_atomic(decision_path, decision)
        failure_path = editorial_dir / "editorial_failure.json"
        if failure_path.exists():
            failure_path.unlink()
        return decision
    if resume and decision_path.exists():
        decision = validate_editorial_decision(json.loads(decision_path.read_text(encoding="utf-8")))
        failure_path = editorial_dir / "editorial_failure.json"
        if failure_path.exists():
            failure_path.unlink()
        return decision
    schema_path = editorial_dir / "editorial_output.schema.json"
    schema_path.write_text(json.dumps(editorial_schema(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    template = Path(__file__).with_name("translate_epub_editorial.md").read_text(encoding="utf-8")
    prompt = template.rstrip() + "\n\n## Contexte JSON\n\n" + json.dumps(context, ensure_ascii=False, separators=(",", ":")) + "\n"
    prompt_path = editorial_dir / "editorial_prompt.md"
    log_path = editorial_dir / "editorial.log"
    prompt_path.write_text(prompt, encoding="utf-8")
    command = [
        "codex", "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
        "--ignore-rules", "--color", "never", "-C", str(paths["root"]),
        "--output-schema", str(schema_path), "-c", f'model_reasoning_effort="{reasoning_effort}"',
        "-o", str(decision_path), "-",
    ]
    try:
        with prompt_path.open("rb") as stdin, log_path.open("wb") as stderr:
            process = subprocess.run(
                command, stdin=stdin, stdout=subprocess.DEVNULL, stderr=stderr, timeout=timeout,
            )
    except subprocess.TimeoutExpired as exc:
        record_editorial_failure(
            editorial_dir, "timeout", True,
            f"Editorial Codex review timed out after {timeout} seconds.", log_path,
        )
        raise RuntimeError(f"Editorial Codex review timed out after {timeout} seconds; see {log_path}") from exc
    if process.returncode != 0:
        log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        failure = classify_codex_failure(log_text)
        record_editorial_failure(
            editorial_dir, str(failure["kind"]), bool(failure["retryable"]),
            str(failure["detail"]) or f"Editorial Codex review exited with {process.returncode}.",
            log_path,
        )
        if failure["retryable"] is False:
            raise RuntimeError(
                f"Editorial review paused by {failure['kind']}: {failure['detail']}. "
                "Resume later or provide --editorial-decision."
            )
        raise RuntimeError(f"Editorial Codex review exited with {process.returncode}; see {log_path}")
    decision = validate_editorial_decision(json.loads(decision_path.read_text(encoding="utf-8")))
    write_json_atomic(decision_path, decision)
    failure_path = editorial_dir / "editorial_failure.json"
    if failure_path.exists():
        failure_path.unlink()
    return decision


def set_or_create_dc(metadata: ET.Element, field: str, value: str) -> ET.Element:
    node = next((item for item in metadata if namespace(item.tag) == DC_NS and local_name(item.tag) == field), None)
    if node is None:
        node = ET.SubElement(metadata, f"{{{DC_NS}}}{field}")
    node.text = clean_metadata_text(value)
    return node


def set_or_create_meta(metadata: ET.Element, name: str, content: str) -> ET.Element:
    node = next((item for item in metadata if local_name(item.tag) == "meta" and item.attrib.get("name") == name), None)
    if node is None:
        node = ET.SubElement(metadata, f"{{{OPF_NS}}}meta")
        node.attrib["name"] = name
    node.attrib["content"] = clean_metadata_text(content)
    return node


def replace_front_matter_labels(paths: dict[str, Path], project: dict, decision: dict) -> list[str]:
    changed = []
    replacements = {
        clean_metadata_text(item["source"]).strip('"\'«»').casefold(): item["target"]
        for item in decision.get("front_matter_replacements", [])
    }
    source_opf = parse_xml(paths["original"] / project["opf"]).getroot()
    source_title = next(
        (clean_metadata_text("".join(node.itertext())) for node in source_opf.iter()
         if local_name(node.tag) == "title" and namespace(node.tag) == DC_NS),
        "",
    )
    if source_title:
        replacements.setdefault(source_title.strip('"\'«»').casefold(), decision["full_title"])
    candidate_files = [item["file"] for item in source_editorial_context(paths, project)["front_matter"]]
    for rel in candidate_files:
        source_path, target_path = paths["original"] / rel, paths["working"] / rel
        if not source_path.exists() or not target_path.exists():
            continue
        source_tree, target_tree = parse_xml(source_path), parse_xml(target_path)
        source_nodes, target_nodes = list(source_tree.getroot().iter()), list(target_tree.getroot().iter())
        file_changed = False
        for source, target in zip(source_nodes, target_nodes):
            for field in ("text", "tail"):
                raw = getattr(source, field) or ""
                key = clean_metadata_text(raw).strip('"\'«»').casefold()
                replacement = replacements.get(key)
                if replacement:
                    leading = raw[:len(raw) - len(raw.lstrip())]
                    trailing = raw[len(raw.rstrip()):]
                    setattr(target, field, leading + replacement + trailing)
                    file_changed = True
            if (local_name(source.tag) == "title"
                    and clean_metadata_text("".join(source.itertext())).strip('"\'«»').casefold() in replacements):
                set_visible_text(target, decision["full_title"])
                file_changed = True
        if file_changed:
            write_tree(target_tree, target_path)
            changed.append(rel)
    return changed


def sniff_image_media_type(path: Path) -> str | None:
    data = path.read_bytes()[:512]
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if b"<svg" in data.lstrip(b"\xef\xbb\xbf\x00\t\r\n ").lower():
        return "image/svg+xml"
    return None


def apply_editorial_metadata(paths: dict[str, Path], project: dict, decision: dict, cover_image: Path | None) -> dict:
    opf_path = paths["working"] / project["opf"]
    cover_rel = find_cover_resource(paths["working"], project["opf"])
    tree = parse_xml(opf_path)
    root = tree.getroot()
    metadata = next((node for node in root.iter() if local_name(node.tag) == "metadata"), None)
    if metadata is None:
        raise RuntimeError("The OPF package has no metadata element")
    set_or_create_dc(metadata, "title", decision["full_title"])
    set_or_create_dc(metadata, "language", project["target_language_code"])
    creator_nodes = [node for node in metadata if namespace(node.tag) == DC_NS and local_name(node.tag) == "creator"]
    for index, creator in enumerate(decision["creators"]):
        if index < len(creator_nodes):
            creator_nodes[index].text = creator
        else:
            node = ET.SubElement(metadata, f"{{{DC_NS}}}creator")
            node.text = creator
    set_or_create_dc(metadata, "publisher", decision["publisher"])
    publication = next(
        (node for node in metadata if namespace(node.tag) == DC_NS and local_name(node.tag) == "date"
         and (node.attrib.get(f"{{{OPF_NS}}}event") == "publication" or node.attrib.get("event") == "publication")),
        None,
    )
    if publication is not None and decision["publication_date"]:
        publication.text = decision["publication_date"]
    set_or_create_dc(metadata, "description", decision["description"])
    for node in list(metadata):
        if namespace(node.tag) == DC_NS and local_name(node.tag) == "subject":
            metadata.remove(node)
    for subject in decision["subjects"]:
        node = ET.SubElement(metadata, f"{{{DC_NS}}}subject")
        node.text = subject
    set_or_create_meta(metadata, "calibre:title_sort", decision["title_sort"])
    set_or_create_meta(metadata, "calibre:subtitle", decision["subtitle"])
    for node in metadata.iter():
        if namespace(node.tag) == DC_NS and node.text:
            node.text = clean_metadata_text(node.text)
        if local_name(node.tag) == "meta" and "content" in node.attrib:
            node.attrib["content"] = clean_metadata_text(node.attrib["content"])
    cover_declaration = normalize_cover_declaration(root, project["opf"], cover_rel)
    write_tree(tree, opf_path)
    changed_front_matter = replace_front_matter_labels(paths, project, decision)
    manifest_rows = read_jsonl(paths["jobs"] / "translation_manifest.jsonl")
    for row in manifest_rows:
        if row["relative_path"] in changed_front_matter and row["category"] == "preserve":
            row.update({"category": "editorial", "reason": "editorially corrected front matter", "status": "pending"})

    items, serial, _ = media_inventory(paths["working"], project["opf"])
    content_rels = [
        rel for rel, item in items.items()
        if item["media_type"] in {"application/xhtml+xml", "application/x-dtbook+xml"} and rel not in serial
    ]
    heading_map = id_heading_map(paths["original"], paths["working"], content_rels)
    ui = dict(UI_TRANSLATIONS.get(project["target_language_code"], {}))
    ui["__code__"] = project["target_language_code"]
    source_title = translated_book_title(paths["original"] / project["opf"])
    for rel in serial:
        if rel == project["opf"] or not (paths["working"] / rel).exists():
            continue
        media_type = items.get(rel, {}).get("media_type", "")
        if media_type == "application/x-dtbncx+xml" or rel.endswith(".ncx"):
            sync_ncx(
                paths["original"] / rel, paths["working"] / rel, rel, heading_map,
                decision["full_title"], project["target_language_code"], ui,
            )
        elif media_type in {"application/xhtml+xml", "application/x-dtbook+xml"}:
            sync_xhtml_links(
                paths["original"] / rel, paths["working"] / rel, rel, heading_map, ui,
                source_title, decision["full_title"],
            )

    cover_status = "preserved"
    cover_warnings: list[str] = []
    source_cover_path = safe_resource_path(paths["original"], cover_rel) if cover_rel else None
    source_dimensions = (
        image_dimensions(source_cover_path)
        if source_cover_path and source_cover_path.is_file()
        else None
    )
    localized_dimensions = None
    if cover_image is not None:
        cover_image = cover_image.resolve()
        if not cover_image.is_file():
            raise FileNotFoundError(cover_image)
        if cover_rel is None:
            raise RuntimeError("No cover image is identified in the OPF package")
        items, _, _ = media_inventory(paths["working"], project["opf"])
        expected_type = items.get(cover_rel, {}).get("media_type", "")
        actual_type = sniff_image_media_type(cover_image)
        equivalent_types = {"image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg"}
        expected_type = equivalent_types.get(expected_type.casefold(), expected_type.casefold())
        actual_type = equivalent_types.get((actual_type or "").casefold(), (actual_type or "").casefold())
        if not actual_type:
            raise RuntimeError("The localized cover is not a recognized JPEG, PNG, GIF, WebP, or SVG image")
        if expected_type and actual_type != expected_type:
            raise RuntimeError(
                f"Localized cover format {actual_type} does not match OPF media type {expected_type}"
            )
        localized_dimensions = image_dimensions(cover_image)
        if source_dimensions and localized_dimensions and source_dimensions != localized_dimensions:
            source_ratio = source_dimensions[0] / source_dimensions[1]
            localized_ratio = localized_dimensions[0] / localized_dimensions[1]
            ratio_delta = abs(localized_ratio - source_ratio) / source_ratio
            cover_warnings.append(
                "Localized cover dimensions differ from the source "
                f"({localized_dimensions[0]}×{localized_dimensions[1]} instead of "
                f"{source_dimensions[0]}×{source_dimensions[1]})."
            )
            if ratio_delta > 0.01:
                cover_warnings.append(
                    f"Localized cover aspect ratio differs from the source by {ratio_delta:.1%}; "
                    "review crop and layout before publishing."
                )
        destination = safe_resource_path(paths["working"], cover_rel)
        shutil.copy2(cover_image, destination)
        cover_status = "localized"
        for row in manifest_rows:
            if row["relative_path"] == cover_rel:
                row.update({"category": "editorial", "reason": "localized cover image", "status": "pending"})
    write_jsonl(paths["jobs"] / "translation_manifest.jsonl", manifest_rows)
    return {
        "metadata": decision,
        "front_matter_files": changed_front_matter,
        "cover_resource": cover_rel,
        "cover_status": cover_status,
        "cover_declaration": cover_declaration,
        "cover_geometry": {
            "source": list(source_dimensions) if source_dimensions else None,
            "localized": list(localized_dimensions) if localized_dimensions else None,
            "exact_match": (
                source_dimensions == localized_dimensions
                if source_dimensions and localized_dimensions else None
            ),
        },
        "warnings": cover_warnings,
    }


def editorial(paths: dict[str, Path], reasoning_effort: str, resume: bool, cover_image: Path | None,
              target_name: str | None = None, target_code: str | None = None,
              timeout: int = DEFAULT_EDITORIAL_TIMEOUT,
              decision_source: Path | None = None) -> dict:
    project_path = paths["jobs"] / "project.json"
    if not project_path.exists():
        inferred_code = target_code or paths["working"].name.rsplit(" ", 1)[-1]
        inferred_name = target_name or resolve_language(inferred_code)[0]
        bootstrap_legacy_project(paths, inferred_name, inferred_code)
    project = json.loads(project_path.read_text(encoding="utf-8"))
    decision = run_editorial_review(paths, project, reasoning_effort, resume, timeout, decision_source)
    source_cover_rel = find_cover_resource(paths["original"], project["opf"])
    source_cover_path = safe_resource_path(paths["original"], source_cover_rel) if source_cover_rel else None
    source_cover_dimensions = (
        image_dimensions(source_cover_path)
        if source_cover_path and source_cover_path.is_file()
        else None
    )
    geometry_guidance = (
        f"Source cover geometry: {source_cover_dimensions[0]} × {source_cover_dimensions[1]} pixels; "
        "preserve these exact pixel dimensions and aspect ratio when possible.\n"
        if source_cover_dimensions else
        "Source cover geometry: preserve the original pixel dimensions and aspect ratio when possible.\n"
    )
    cover_prompt = (
        "Use case: text-localization\n"
        f"Asset type: {project['target_language']} EPUB front cover\n"
        f"Primary request: Localize only the reader-visible wording on the existing front cover from "
        f"{project['source_language']} into {project['target_language']}. Preserve the original artwork, composition, "
        "typographic hierarchy, publisher marks, author identity, colors, crop, aspect ratio, and print-design character.\n"
        "Input image: edit target, the original EPUB cover.\n"
        f"Text (verbatim): title \"{decision['cover_text']['title']}\"; subtitle \"{decision['cover_text']['subtitle']}\"; "
        f"author \"{decision['cover_text']['author']}\"; contributor \"{decision['cover_text']['contributor']}\".\n"
        f"{geometry_guidance}"
        f"Constraints: spell every supplied string exactly in {project['target_language']}; omit empty strings; "
        "add no other wording or watermark; retain all publisher and brand marks unchanged; keep safe margins.\n"
        "Avoid: changing any non-text image content, logo, palette, crop, or adding decorative elements.\n"
    )
    editorial_dir = paths["jobs"] / "editorial"
    (editorial_dir / "cover_prompt.md").write_text(cover_prompt, encoding="utf-8")
    result = apply_editorial_metadata(paths, project, decision, cover_image)
    result["reasoning_effort"] = reasoning_effort
    write_json_atomic(paths["jobs"] / "editorial" / "editorial_report.json", result)
    for stale in (
        paths["jobs"] / "validation.json",
        paths["jobs"] / "final_report.json",
        paths["final"],
    ):
        if stale.exists():
            stale.unlink()
    return result


def apply(paths: dict[str, Path]) -> dict:
    project = json.loads((paths["jobs"] / "project.json").read_text(encoding="utf-8"))
    segments = read_jsonl(paths["jobs"] / "segments.jsonl")
    translations = load_translations(paths["jobs"] / "translations.jsonl")
    materialize_exact_translation_aliases(paths, project, segments, translations)
    missing = [row["id"] for row in segments if row["id"] not in translations]
    if missing:
        raise RuntimeError(f"Missing translations for {len(missing)} segments")
    by_file: dict[str, list[dict]] = defaultdict(list)
    for segment in segments:
        by_file[segment["file"]].append(segment)
    for rel, file_segments in by_file.items():
        source_path, target_path = paths["original"] / rel, paths["working"] / rel
        shutil.copy2(source_path, target_path)
        tree = parse_xml(target_path)
        root = tree.getroot()
        for segment in file_segments:
            element = element_at(root, segment["path"])
            target = translations[segment["id"]]["target"]
            if segment["kind"] == "element":
                apply_target_to_element(element, target, segment.get("placeholders", []))
            elif segment["kind"] == "attribute":
                element.attrib[segment["attribute"]] = target
            elif segment["kind"] == "metadata":
                for token, literal in segment.get("literal_map", {}).items():
                    target = target.replace(token, literal)
                element.text = target
        if root.attrib.get("lang"):
            root.attrib["lang"] = project["target_language_code"]
        if root.attrib.get(XML_LANG):
            root.attrib[XML_LANG] = project["target_language_code"]
        if rel == project["opf"]:
            language = next((e for e in root.iter() if local_name(e.tag) == "language" and namespace(e.tag) == DC_NS), None)
            if language is not None:
                language.text = project["target_language_code"]
            title_node = next((e for e in root.iter() if local_name(e.tag) == "title" and namespace(e.tag) == DC_NS), None)
            title = visible_text(title_node) if title_node is not None else ""
            for node in root.iter():
                if local_name(node.tag) == "meta" and node.attrib.get("name") == "calibre:title_sort":
                    node.attrib["content"] = title
        write_tree(tree, target_path)

    items, serial, _ = media_inventory(paths["original"], project["opf"])
    content_rels = [rel for rel, item in items.items() if item["media_type"] in {"application/xhtml+xml", "application/x-dtbook+xml"} and rel not in serial]
    heading_map = id_heading_map(paths["original"], paths["working"], content_rels)
    ui = dict(UI_TRANSLATIONS.get(project["target_language_code"], {}))
    ui["__code__"] = project["target_language_code"]
    source_title = translated_book_title(paths["original"] / project["opf"])
    title = translated_book_title(paths["working"] / project["opf"])
    translated_content_rels = [rel for rel in content_rels if rel in by_file]
    for rel in translated_content_rels:
        sync_xhtml_links(
            paths["original"] / rel, paths["working"] / rel, rel, heading_map, ui,
            source_title, title,
        )
    for rel in project["serial_files"]:
        if rel == project["opf"]:
            continue
        shutil.copy2(paths["original"] / rel, paths["working"] / rel)
        media_type = items.get(rel, {}).get("media_type", "")
        if media_type == "application/x-dtbncx+xml" or rel.endswith(".ncx"):
            sync_ncx(
                paths["original"] / rel, paths["working"] / rel, rel, heading_map, title,
                project["target_language_code"], ui,
            )
        elif media_type in {"application/xhtml+xml", "application/x-dtbook+xml"}:
            sync_xhtml_links(
                paths["original"] / rel, paths["working"] / rel, rel, heading_map, ui,
                source_title, title,
            )
    for stale in (
        paths["jobs"] / "editorial" / "editorial_report.json",
        paths["jobs"] / "validation.json",
        paths["jobs"] / "final_report.json",
        paths["final"],
    ):
        if stale.exists():
            stale.unlink()
    return {"applied_segments": len(segments), "files": len(by_file), "generated_serial": len(serial)}


def protected_payload(element: ET.Element) -> tuple:
    return (local_name(element.tag), tuple(sorted(element.attrib.items())), "".join(element.itertext()))


def navigation_sync_errors(original: Path, working: Path, rels: list[str],
                           heading_map: dict[tuple[str, str], tuple[str, str]],
                           ui: dict[str, str], source_book_title: str,
                           target_book_title: str) -> list[str]:
    """Verify that every deterministically resolvable navigation label was localized."""
    errors: list[str] = []
    for rel in rels:
        source_path, target_path = original / rel, working / rel
        try:
            source_root = parse_xml(source_path).getroot()
            target_root = parse_xml(target_path).getroot()
        except (OSError, ET.ParseError):
            continue
        source_nodes, target_nodes = list(source_root.iter()), list(target_root.iter())
        if len(source_nodes) != len(target_nodes):
            continue
        if rel.endswith(".ncx") or namespace(source_root.tag) == NCX_NS:
            source_points = [node for node in source_nodes if local_name(node.tag) == "navPoint"]
            target_points = [node for node in target_nodes if local_name(node.tag) == "navPoint"]
            for source_point, target_point in zip(source_points, target_points):
                source_content = next((node for node in source_point.iter() if local_name(node.tag) == "content"), None)
                source_text = next((node for node in source_point.iter() if local_name(node.tag) == "text"), None)
                target_text = next((node for node in target_point.iter() if local_name(node.tag) == "text"), None)
                if source_content is None or source_text is None or target_text is None:
                    continue
                expected = navigation_label_replacement(
                    visible_text(source_text), source_content.attrib.get("src", ""), rel, heading_map, ui,
                )
                if expected and visible_text(target_text) != normalize_space(expected):
                    errors.append(f"Navigation label was not localized in {rel}: {visible_text(source_text)!r}")
            continue
        for source, target in zip(source_nodes, target_nodes):
            if local_name(source.tag) in {"h1", "h2", "h3", "title"}:
                expected = document_title_replacement(
                    visible_text(source), rel, heading_map, ui, source_book_title, target_book_title,
                )
                if expected and visible_text(target) != normalize_space(expected):
                    errors.append(f"Navigation heading was not localized in {rel}: {visible_text(source)!r}")
                continue
            if local_name(source.tag) != "a" or not source.attrib.get("href"):
                continue
            protected_descendant = any(
                node is not target and (local_name(node.tag) in PROTECTED_TAGS or has_protected_class(node))
                for node in target.iter()
            )
            if protected_descendant:
                continue
            expected = navigation_label_replacement(
                visible_text(source), source.attrib["href"], rel, heading_map, ui,
            )
            if expected and visible_text(target) != normalize_space(expected):
                errors.append(f"Navigation label was not localized in {rel}: {visible_text(source)!r}")
    return errors


def validate(paths: dict[str, Path]) -> dict:
    project = json.loads((paths["jobs"] / "project.json").read_text(encoding="utf-8"))
    manifest_rows = read_jsonl(paths["jobs"] / "translation_manifest.jsonl")
    errors: list[str] = []
    warnings: list[str] = []
    original_files = {p.relative_to(paths["original"]).as_posix() for p in paths["original"].rglob("*") if p.is_file()}
    working_files = {p.relative_to(paths["working"]).as_posix() for p in paths["working"].rglob("*") if p.is_file()}
    if original_files != working_files:
        errors.append("Working resource inventory differs from the source")
    items, serial, spine = media_inventory(paths["working"], project["opf"])
    parsed = 0
    for rel, item in items.items():
        if not (paths["working"] / rel).is_file():
            errors.append(f"Missing manifest resource: {rel}")
            continue
        if item["media_type"] not in {"application/xhtml+xml", "application/x-dtbook+xml", "application/x-dtbncx+xml", "image/svg+xml"}:
            continue
        try:
            target_root = parse_xml(paths["working"] / rel).getroot()
            source_root = parse_xml(paths["original"] / rel).getroot()
        except ET.ParseError as exc:
            errors.append(f"XML parse error in {rel}: {exc}")
            continue
        parsed += 1
        source_nodes, target_nodes = list(source_root.iter()), list(target_root.iter())
        if [node.tag for node in source_nodes] != [node.tag for node in target_nodes]:
            errors.append(f"Element structure changed in {rel}")
            continue
        for source, target in zip(source_nodes, target_nodes):
            for key in set(source.attrib) | set(target.attrib):
                key_name = local_name(key)
                if key_name in STRUCTURAL_ATTRS and source.attrib.get(key) != target.attrib.get(key):
                    if rel == project["opf"] and key_name == "content" and source.attrib.get("name") == "calibre:title_sort":
                        continue
                    errors.append(f"Structural attribute {key_name} changed in {rel}")
            if (not project.get("adopted_legacy_project")
                    and (local_name(source.tag) in PROTECTED_TAGS or has_protected_class(source))
                    and protected_payload(source) != protected_payload(target)):
                errors.append(f"Protected content changed in {rel}")
    opf_root = parse_xml(paths["working"] / project["opf"]).getroot()
    language = next((e for e in opf_root.iter() if local_name(e.tag) == "language" and namespace(e.tag) == DC_NS), None)
    if language is None or visible_text(language) != project["target_language_code"]:
        errors.append("The OPF target language is incorrect")
    for node in opf_root.iter():
        if namespace(node.tag) == DC_NS and node.text and INVISIBLE_METADATA_RE.search(node.text):
            errors.append(f"Invisible formatting character remains in dc:{local_name(node.tag)}")
        if local_name(node.tag) == "meta" and INVISIBLE_METADATA_RE.search(node.attrib.get("content", "")):
            errors.append(f"Invisible formatting character remains in meta:{node.attrib.get('name', '')}")
    editorial_report_path = paths["jobs"] / "editorial" / "editorial_report.json"
    if editorial_report_path.exists():
        editorial_report = json.loads(editorial_report_path.read_text(encoding="utf-8"))
        warnings.extend(str(value) for value in editorial_report.get("warnings", []) if str(value))
        decision = editorial_report.get("metadata", {})
        title = next((visible_text(node) for node in opf_root.iter()
                      if local_name(node.tag) == "title" and namespace(node.tag) == DC_NS), "")
        if decision.get("full_title") and title != decision["full_title"]:
            errors.append("The OPF title differs from the approved editorial title")
        if editorial_report.get("cover_status") == "localized":
            cover_rel = editorial_report.get("cover_resource")
            try:
                working_cover = safe_resource_path(paths["working"], cover_rel) if cover_rel else None
                original_cover = safe_resource_path(paths["original"], cover_rel) if cover_rel else None
            except RuntimeError as exc:
                errors.append(str(exc))
                working_cover = original_cover = None
            if not working_cover or not working_cover.is_file():
                errors.append("The localized cover resource is missing")
            elif original_cover and working_cover.read_bytes() == original_cover.read_bytes():
                errors.append("The localized cover is identical to the source cover")
        declared_cover = editorial_report.get("cover_declaration", {})
        declared_id = declared_cover.get("manifest_id")
        if declared_id:
            cover_meta = next(
                (
                    node for node in opf_root.iter()
                    if local_name(node.tag) == "meta" and node.attrib.get("name") == "cover"
                ),
                None,
            )
            if cover_meta is None or cover_meta.attrib.get("content") != declared_id:
                errors.append("The OPF cover metadata does not reference the selected manifest image")
            if package_version(opf_root) >= 3:
                property_ids = [
                    node.attrib.get("id", "")
                    for node in opf_root.iter()
                    if local_name(node.tag) == "item"
                    and "cover-image" in node.attrib.get("properties", "").split()
                ]
                if property_ids != [declared_id]:
                    errors.append(
                        "The EPUB 3 package must declare exactly one cover-image matching the selected cover"
                    )
    for rel in spine:
        if not (paths["working"] / rel).exists():
            errors.append(f"Spine resource is missing: {rel}")
    content_rels = [
        rel for rel, item in items.items()
        if item["media_type"] in {"application/xhtml+xml", "application/x-dtbook+xml"} and rel not in serial
    ]
    heading_map = id_heading_map(paths["original"], paths["working"], content_rels)
    ui = dict(UI_TRANSLATIONS.get(project["target_language_code"], {}))
    source_title = translated_book_title(paths["original"] / project["opf"])
    target_title = translated_book_title(paths["working"] / project["opf"])
    errors.extend(navigation_sync_errors(
        paths["original"], paths["working"], serial, heading_map, ui, source_title, target_title,
    ))
    for row in manifest_rows:
        if row["category"] == "preserve":
            source = paths["original"] / row["relative_path"]
            target = paths["working"] / row["relative_path"]
            if source.read_bytes() != target.read_bytes():
                errors.append(f"Preserved resource changed: {row['relative_path']}")
    segments = {row["id"]: row for row in read_jsonl(paths["jobs"] / "segments.jsonl")}
    translations = load_translations(paths["jobs"] / "translations.jsonl")
    english_words = set("the and that this with from into your you are is of to in for as on be it these those can will when how not but or an a by".split())
    french_words = set("le la les de des du et un une que qui dans pour est sont avec sur ce cette ces vous votre par pas en au aux".split())
    for segment_id, segment in segments.items():
        target = translations.get(segment_id, {}).get("target", "")
        plain = PLACEHOLDER_RE.sub(" ", target)
        if len(plain) < 160:
            continue
        words = [word.casefold() for word in WORD_RE.findall(plain)]
        if project["target_language_code"] == "fr":
            english_count = sum(word in english_words for word in words)
            french_count = sum(word in french_words for word in words)
            if english_count >= 12 and english_count > french_count * 2:
                warnings.append(f"Possible untranslated English passage: {segment['file']} / {segment_id}")
        elif normalize_space(target) == normalize_space(segment["source"]):
            warnings.append(f"Long segment unchanged from source: {segment['file']} / {segment_id}")
    if not errors:
        for row in manifest_rows:
            if row["category"] != "preserve":
                row["status"] = "validated"
        write_jsonl(paths["jobs"] / "translation_manifest.jsonl", manifest_rows)
    result = {"errors": errors, "warnings": warnings, "parsed_documents": parsed, "spine_items": len(spine),
              "files": len(working_files), "serial_files": len(serial)}
    (paths["jobs"] / "validation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if errors:
        raise RuntimeError(f"Validation failed with {len(errors)} error(s); see validation.json")
    return result


def build(paths: dict[str, Path]) -> dict:
    if not (paths["jobs"] / "validation.json").exists():
        raise RuntimeError("Run validation before building the EPUB")
    validation = json.loads((paths["jobs"] / "validation.json").read_text(encoding="utf-8"))
    if validation.get("errors"):
        raise RuntimeError("Cannot build an EPUB with validation errors")
    mimetype = paths["working"] / "mimetype"
    if mimetype.read_bytes() != b"application/epub+zip":
        raise RuntimeError("Invalid EPUB mimetype file")
    temporary = paths["final"].with_suffix(".building.epub")
    if temporary.exists():
        temporary.unlink()
    files = sorted(path for path in paths["working"].rglob("*") if path.is_file() and path.name != ".DS_Store")
    with zipfile.ZipFile(temporary, "w") as archive:
        archive.write(mimetype, "mimetype", compress_type=zipfile.ZIP_STORED)
        for path in files:
            rel = path.relative_to(paths["working"]).as_posix()
            if rel == "mimetype" or rel.startswith("__MACOSX/"):
                continue
            archive.write(path, rel, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    with zipfile.ZipFile(temporary) as archive:
        infos = archive.infolist()
        if archive.testzip() or not infos or infos[0].filename != "mimetype" or infos[0].compress_type != zipfile.ZIP_STORED:
            raise RuntimeError("Final EPUB ZIP validation failed")
        final_files = {name for name in archive.namelist() if not name.endswith("/")}
    os.replace(temporary, paths["final"])
    manifest_rows = read_jsonl(paths["jobs"] / "translation_manifest.jsonl")
    counts = Counter(row["category"] for row in manifest_rows)
    statuses = Counter(row["status"] for row in manifest_rows)
    run_stats = {}
    if (paths["jobs"] / "translation_run.json").exists():
        run_stats = json.loads((paths["jobs"] / "translation_run.json").read_text(encoding="utf-8"))
    editorial_stats = {}
    editorial_report_path = paths["jobs"] / "editorial" / "editorial_report.json"
    if editorial_report_path.exists():
        editorial_stats = json.loads(editorial_report_path.read_text(encoding="utf-8"))
    result = {"epub": str(paths["final"]), "files": len(final_files), "categories": counts,
              "statuses": statuses, "translation": run_stats, "editorial": editorial_stats,
              "zip_integrity": "ok"}
    (paths["jobs"] / "final_report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2, default=dict) + "\n", encoding="utf-8")
    (paths["jobs"] / "translation_progress.md").write_text(
        "# Fast EPUB translation\n\n"
        f"- Final EPUB: {paths['final']}\n- Files: {len(final_files)}\n"
        f"- Translated/generated files: {counts['parallel'] + counts['serial-final']}\n"
        f"- Preserved files: {counts['preserve']}\n- Validated files: {statuses['validated']}\n"
        f"- Initial translation batches: {run_stats.get('initial_batches', 'n/a')}\n"
        f"- Repair batches: {run_stats.get('repair_batches', 'n/a')}\n"
        f"- Recorded runs: {run_stats.get('runs', 'n/a')}\n"
        f"- Parallel workers: {run_stats.get('workers', 'n/a')}\n"
        f"- Translation time: {run_stats.get('wall_seconds', 'n/a')} seconds\n"
        f"- Editorial title: {editorial_stats.get('metadata', {}).get('full_title', 'n/a')}\n"
        f"- Cover status: {editorial_stats.get('cover_status', 'n/a')}\n"
        "- ZIP integrity: OK\n- Status: complete\n",
        encoding="utf-8",
    )
    return result


def print_result(stage: str, result: dict) -> None:
    print(json.dumps({"stage": stage, **result}, ensure_ascii=False, default=dict))


def main() -> int:
    parser = argparse.ArgumentParser(description="Translate an EPUB quickly with output-only parallel Codex workers")
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    parser.add_argument("epub", type=Path)
    parser.add_argument("target_language")
    parser.add_argument("--stage", choices=("all", "prepare", "translate", "apply", "editorial", "validate", "build"), default="all")
    parser.add_argument("--profile", choices=tuple(SPEED_PROFILES), default="standard")
    parser.add_argument("--workers", type=int)
    parser.add_argument("--batch-tokens", type=int)
    parser.add_argument("--repair-tokens", type=int)
    parser.add_argument("--max-retries", type=int, default=2)
    parser.add_argument("--worker-timeout", type=int, default=DEFAULT_WORKER_TIMEOUT,
                        help="Maximum seconds allowed for each Codex translation batch")
    parser.add_argument("--editorial-timeout", type=int, default=DEFAULT_EDITORIAL_TIMEOUT,
                        help="Maximum seconds allowed for the Codex metadata review")
    parser.add_argument("--reasoning-effort", choices=("low", "medium", "high"))
    parser.add_argument("--editorial-reasoning-effort", choices=("low", "medium", "high"), default="medium")
    parser.add_argument("--cover-image", type=Path, help="Localized cover image to install during the editorial stage")
    parser.add_argument(
        "--editorial-decision", type=Path,
        help="Use a schema-valid editorial decision JSON instead of calling Codex",
    )
    parser.add_argument("--glossary", type=Path, help="Custom UTF-8 glossary used for translation batches")
    parser.add_argument("--book-name", help="Short folder name created under books/")
    parser.add_argument("--keep-source", action="store_true", help="Keep the input EPUB after original.epub is initialized")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    profile = SPEED_PROFILES[args.profile]
    batch_tokens = args.batch_tokens or profile["batch_tokens"]
    repair_tokens = args.repair_tokens or profile["repair_tokens"]
    workers = args.workers or profile["workers"]
    reasoning_effort = args.reasoning_effort or profile["reasoning_effort"]
    target_name, target_code = resolve_language(args.target_language)
    paths = project_paths(args.epub, target_code, args.book_name)
    try:
        if args.stage in {"all", "prepare"}:
            result = prepare(args.epub, target_name, target_code, paths, args.force, args.resume,
                             args.keep_source, args.glossary)
            print_result("prepare", result)
        if args.stage in {"all", "translate"}:
            result = translate(paths, workers, batch_tokens, repair_tokens, args.max_retries, reasoning_effort,
                               args.worker_timeout)
            print_result("translate", result)
        if args.stage in {"all", "apply"}:
            result = apply(paths)
            print_result("apply", result)
        if args.stage in {"all", "editorial"}:
            result = editorial(paths, args.editorial_reasoning_effort, args.resume, args.cover_image,
                               target_name, target_code, args.editorial_timeout, args.editorial_decision)
            print_result("editorial", result)
        if args.stage in {"all", "validate"}:
            result = validate(paths)
            print_result("validate", result)
        if args.stage in {"all", "build"}:
            result = build(paths)
            print_result("build", result)
    except Exception as exc:
        print(json.dumps({"stage": args.stage, "status": "error", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
