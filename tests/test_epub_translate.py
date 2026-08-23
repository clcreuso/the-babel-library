#!/usr/bin/env python3
import json
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import xml.etree.ElementTree as ET

import epub_translate as pipeline


MIMETYPE = b"application/epub+zip"


class FastEpubPipelineTests(unittest.TestCase):
    def create_fixture(self, root: Path) -> Path:
        files = {
            "META-INF/container.xml": """<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>""",
            "content.opf": """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">tiny-book</dc:identifier>
    <dc:title>Tiny Book?</dc:title><dc:language>en</dc:language>
    <dc:description>&lt;p&gt;A small book about objects.&lt;/p&gt;</dc:description>
    <meta name="cover" content="cover"/>
  </metadata>
  <manifest>
    <item id="chapter" href="OEBPS/ch01.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="OEBPS/book.css" media-type="text/css"/>
    <item id="nav" href="OEBPS/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover" href="OEBPS/cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine toc="ncx"><itemref idref="chapter"/></spine>
</package>""",
            "OEBPS/ch01.xhtml": """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en">
<head><title>Tiny Book</title><link href="book.css" rel="stylesheet" type="text/css"/></head><body class="book">
<h1 id="chapter-one">Object Design</h1>
<p>A <code>Gear</code> sends messages.</p>
<table class="processedcode"><tr><td class="codeline">puts "Hello world"</td></tr></table>
<p><img class="figure" src="diagram.png" alt="Useful diagram"/></p>
</body></html>""",
            "OEBPS/nav.xhtml": """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en">
<head><title>Tiny Book: Table of Contents</title></head><body>
<nav><h1>Table of Contents</h1><ol>
<li><a href="ch01.xhtml">Object Design</a></li>
<li><a href="cover.jpg">Cover</a></li>
</ol></nav>
</body></html>""",
            "toc.ncx": """<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" xml:lang="en" version="2005-1">
<head/><docTitle><text>Tiny Book</text></docTitle><navMap>
<navPoint id="n1" playOrder="1"><navLabel><text>Object Design</text></navLabel><content src="OEBPS/ch01.xhtml"/></navPoint>
</navMap></ncx>""",
            "OEBPS/diagram.png": b"not-a-real-png-but-preserved",
            "OEBPS/cover.jpg": b"source-cover",
            "OEBPS/book.css": b"""@font-face {
  font-family: RemoteBook;
  src: url(https://example.invalid/book.woff);
}
body.book {
  color: #333;
  background-color: #fff;
  min-height: 450px;
}
.processedcode {
  overflow-x: scroll;
  page-break-inside: avoid;
  word-break: keep-all;
}
img.figure {
  width: 600px;
  max-width: 100%;
  height: 400px;
}
""",
        }
        epub = root / "tiny.epub"
        with zipfile.ZipFile(epub, "w") as archive:
            archive.writestr("mimetype", MIMETYPE, compress_type=zipfile.ZIP_STORED)
            for name, content in files.items():
                archive.writestr(name, content, compress_type=zipfile.ZIP_DEFLATED)
        return epub

    def test_prepare_apply_validate_and_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            source_bytes = epub.read_bytes()
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            self.assertEqual(paths["root"], root.resolve() / "books" / "Tiny Book")
            self.assertEqual(paths["source"].name, "original.epub")
            self.assertEqual(paths["final"].name, "translated-fr.epub")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            self.assertEqual(paths["source"].read_bytes(), source_bytes)
            self.assertTrue(epub.exists())
            self.assertEqual(project["protection_schema_version"], pipeline.PROTECTION_SCHEMA_VERSION)
            progress = (paths["jobs"] / "translation_progress.md").read_text(encoding="utf-8")
            self.assertIn("Protected code containers skipped: 2", progress)
            segments = pipeline.read_jsonl(paths["jobs"] / "segments.jsonl")
            self.assertGreaterEqual(len(segments), 5)
            self.assertTrue(any("⟦LOCK:" in row["source"] for row in segments))
            self.assertFalse(any("Hello world" in row["source"] for row in segments))
            self.assertTrue(any(row["tag"] == "title" for row in segments))

            translations = []
            for segment in segments:
                target = segment["source"]
                target = target.replace("Tiny Book", "Petit livre")
                target = target.replace("Object Design", "Conception objet")
                target = target.replace("A small book about objects.", "Un petit livre sur les objets.")
                target = target.replace("A ⟦LOCK:1⟧ sends messages.", "Un ⟦LOCK:1⟧ envoie des messages.")
                target = target.replace("Useful diagram", "Schéma utile")
                translations.append({"id": segment["id"], "target": target, "source": "test"})
            pipeline.write_jsonl(paths["jobs"] / "translations.jsonl", translations)

            applied = pipeline.apply(paths)
            self.assertEqual(applied["applied_segments"], len(segments))
            manifest_rows = pipeline.read_jsonl(paths["jobs"] / "translation_manifest.jsonl")
            chapter_row = next(
                row for row in manifest_rows if row["relative_path"] == "OEBPS/ch01.xhtml"
            )
            chapter_row.update({"category": "preserve", "status": "preserved"})
            pipeline.write_jsonl(paths["jobs"] / "translation_manifest.jsonl", manifest_rows)
            editorial_dir = paths["jobs"] / "editorial"
            editorial_dir.mkdir(parents=True)
            decision = {
                "title": "Petit livre",
                "subtitle": "Conception objet",
                "full_title": "Petit livre : conception objet",
                "title_sort": "Petit livre : conception objet",
                "creators": ["A. Autrice"],
                "publisher": "Maison test",
                "publication_date": "2025-01-01",
                "description": "Un petit livre sur la conception objet.",
                "subjects": ["Conception objet", "Programmation", "Tests logiciels"],
                "cover_text": {
                    "title": "Petit livre", "subtitle": "Conception objet",
                    "author": "A. Autrice", "contributor": "",
                },
                "front_matter_replacements": [
                    {"source": "Object Design", "target": "Conception objet"},
                    {"source": "Cover", "target": "Couverture éditoriale"},
                ],
                "notes": ["Titre et sous-titre harmonisés."],
            }
            pipeline.write_json_atomic(editorial_dir / "metadata_decision.json", decision)
            localized_cover = root / "cover-fr.jpg"
            localized_cover.write_bytes(b"\xff\xd8\xfflocalized-cover")
            (paths["jobs"] / "validation.json").write_text('{"errors": []}', encoding="utf-8")
            paths["final"].write_bytes(b"stale-final")
            editorial = pipeline.editorial(paths, "medium", resume=True, cover_image=localized_cover)
            self.assertEqual(editorial["cover_status"], "localized")
            editorial_manifest = pipeline.read_jsonl(
                paths["jobs"] / "translation_manifest.jsonl"
            )
            chapter_row = next(
                row for row in editorial_manifest if row["relative_path"] == "OEBPS/ch01.xhtml"
            )
            self.assertEqual(chapter_row["category"], "editorial")
            self.assertEqual(
                chapter_row["reason"], "editorially synchronized reader-facing metadata",
            )
            cover_prompt = (editorial_dir / "cover_prompt.md").read_text(encoding="utf-8")
            self.assertIn("Every visible text region not explicitly listed", cover_prompt)
            self.assertIn("unlisted endorsements", cover_prompt)
            self.assertFalse((paths["jobs"] / "validation.json").exists())
            self.assertFalse(paths["final"].exists())
            opf_path = paths["working"] / "content.opf"
            broken_tree = pipeline.parse_xml(opf_path)
            broken_meta = next(
                node for node in broken_tree.getroot().iter()
                if pipeline.local_name(node.tag) == "meta" and node.attrib.get("name") == "cover"
            )
            broken_meta.attrib["content"] = "wrong-cover"
            pipeline.write_tree(broken_tree, opf_path)
            with self.assertRaisesRegex(RuntimeError, "Validation failed"):
                pipeline.validate(paths)
            broken_validation = json.loads(
                (paths["jobs"] / "validation.json").read_text(encoding="utf-8")
            )
            self.assertTrue(any("cover metadata" in error for error in broken_validation["errors"]))
            resumed_editorial = pipeline.editorial(
                paths, "medium", resume=True, cover_image=localized_cover,
            )
            self.assertIn("OEBPS/ch01.xhtml", resumed_editorial["front_matter_files"])
            validation = pipeline.validate(paths)
            self.assertEqual(validation["errors"], [])
            result = pipeline.build(paths)
            self.assertEqual(result["zip_integrity"], "ok")

            with zipfile.ZipFile(paths["final"]) as archive:
                infos = archive.infolist()
                self.assertEqual(infos[0].filename, "mimetype")
                self.assertEqual(infos[0].compress_type, zipfile.ZIP_STORED)
                chapter = ET.fromstring(archive.read("OEBPS/ch01.xhtml"))
                nav = ET.fromstring(archive.read("OEBPS/nav.xhtml"))
                ncx = ET.fromstring(archive.read("toc.ncx"))
                self.assertIn("Conception objet", "".join(chapter.itertext()))
                chapter_title = next(
                    node for node in chapter.iter() if pipeline.local_name(node.tag) == "title"
                )
                self.assertEqual(chapter_title.text, "Petit livre : conception objet")
                self.assertIn("Gear", "".join(chapter.itertext()))
                self.assertIn('puts "Hello world"', "".join(chapter.itertext()))
                self.assertIn("Conception objet", "".join(nav.itertext()))
                self.assertIn("Couverture éditoriale", "".join(nav.itertext()))
                nav_title = next(node for node in nav.iter() if pipeline.local_name(node.tag) == "title")
                self.assertEqual(nav_title.text, "Petit livre : conception objet : Table des matières")
                self.assertIn("Conception objet", "".join(ncx.itertext()))
                self.assertEqual(project["target_language_code"], "fr")
                opf = ET.fromstring(archive.read("content.opf"))
                title = next(node for node in opf.iter() if pipeline.local_name(node.tag) == "title")
                self.assertEqual(title.text, "Petit livre : conception objet")
                cover_meta = next(
                    node for node in opf.iter()
                    if pipeline.local_name(node.tag) == "meta" and node.attrib.get("name") == "cover"
                )
                cover_item = next(
                    node for node in opf.iter()
                    if pipeline.local_name(node.tag) == "item" and node.attrib.get("id") == "cover"
                )
                self.assertEqual(cover_meta.attrib["content"], "cover")
                self.assertIn("cover-image", cover_item.attrib.get("properties", "").split())
                self.assertEqual(archive.read("OEBPS/cover.jpg"), b"\xff\xd8\xfflocalized-cover")

    def test_metadata_cleaning_removes_invisible_controls(self):
        self.assertEqual(
            pipeline.clean_metadata_text('  "Looks Good to Me" (for \u200b \u2060)  '),
            '"Looks Good to Me" (for )',
        )
        self.assertEqual(
            pipeline.safe_book_name('"Looks Good to Me" (for \u200b \u200b)'),
            "Looks Good to Me",
        )

    def test_ai_style_review_applies_only_approved_candidates_and_validates_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            segments = pipeline.read_jsonl(paths["jobs"] / "segments.jsonl")
            pipeline.write_jsonl(
                paths["jobs"] / "translations.jsonl",
                [{"id": row["id"], "target": row["source"], "source": "test"} for row in segments],
            )
            pipeline.apply(paths)

            context, candidates = pipeline.style_context(paths, project)
            self.assertGreaterEqual(len(context["candidates"]), 7)
            kinds = {row["kind"] for row in context["candidates"]}
            self.assertTrue({
                "remote-font-face", "root-color", "root-fixed-height",
                "code-overflow", "code-pagination", "code-wrapping",
                "image-fixed-height",
            } <= kinds)
            root_colors = [
                candidate for candidate in candidates.values()
                if candidate["kind"] == "root-color"
            ]
            self.assertEqual(len(root_colors), 1)
            self.assertEqual(len(root_colors[0]["_spans"]), 2)
            changes = []
            for candidate in context["candidates"]:
                allowed = candidate["allowed_actions"][0]
                changes.append({
                    "candidate_id": candidate["candidate_id"],
                    "action": allowed["action"],
                    "replacement": allowed["replacement"],
                    "reason": f"Low-risk correction for {candidate['kind']}.",
                })
            decision = {
                "summary": "Remove only rendering constraints identified by the bounded audit.",
                "changes": changes,
                "observations": ["The relative maximum image width remains unchanged."],
            }
            decision_path = root / "style-decision.json"
            pipeline.write_json_atomic(decision_path, decision)
            paths["final"].write_bytes(b"stale")
            (paths["jobs"] / "validation.json").write_text('{"errors": []}', encoding="utf-8")
            with patch.object(pipeline.subprocess, "run") as run:
                report = pipeline.style(
                    paths, "medium", resume=False, decision_source=decision_path,
                )
            run.assert_not_called()
            self.assertTrue(report["corrected"])
            self.assertFalse(paths["final"].exists())
            self.assertFalse((paths["jobs"] / "validation.json").exists())

            css = (paths["working"] / "OEBPS" / "book.css").read_text(encoding="utf-8")
            self.assertNotIn("@font-face", css)
            self.assertNotIn("background-color", css)
            self.assertNotIn("color: #333", css)
            self.assertNotIn("min-height", css)
            self.assertIn("overflow-x: visible", css)
            self.assertIn("page-break-inside: auto", css)
            self.assertIn("word-break: normal", css)
            self.assertIn("max-width: 100%", css)
            self.assertIn("height: auto", css)
            manifest = {
                row["relative_path"]: row
                for row in pipeline.read_jsonl(paths["jobs"] / "translation_manifest.jsonl")
            }
            self.assertEqual(manifest["OEBPS/book.css"]["category"], "style")
            self.assertEqual(pipeline.validate(paths)["errors"], [])

            with (paths["working"] / "OEBPS" / "book.css").open("a", encoding="utf-8") as stream:
                stream.write("\n/* unapproved */\n")
            with self.assertRaisesRegex(RuntimeError, "Validation failed"):
                pipeline.validate(paths)
            validation = json.loads(
                (paths["jobs"] / "validation.json").read_text(encoding="utf-8")
            )
            self.assertTrue(any(
                "changed after approval" in error for error in validation["errors"]
            ))

    def test_root_text_and_background_colors_share_one_candidate_across_selectors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            css_path = paths["working"] / "OEBPS" / "book.css"
            css_path.write_text(
                "html { background-color: #fff; }\n"
                "body.book { color: #333; }\n",
                encoding="utf-8",
            )

            _, candidates = pipeline.style_context(paths, project)
            root_colors = [
                candidate for candidate in candidates.values()
                if candidate["kind"] == "root-color"
            ]
            self.assertEqual(len(root_colors), 1)
            self.assertEqual(len(root_colors[0]["_spans"]), 2)
            pipeline.apply_style_decision(paths, project, {
                "summary": "Release the paired root colors.",
                "changes": [{
                    "candidate_id": root_colors[0]["candidate_id"],
                    "action": "remove",
                    "replacement": "",
                    "reason": "Text and background must follow the reader theme together.",
                }],
                "observations": [],
            })
            corrected_css = css_path.read_text(encoding="utf-8")
            self.assertNotIn("color: #333", corrected_css)
            self.assertNotIn("background-color", corrected_css)

    def test_interrupted_style_transaction_restores_every_target_on_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            working = root / "working fr"
            jobs = root / "translation jobs fr"
            working.mkdir()
            jobs.mkdir()
            first = working / "a.css"
            second = working / "b.css"
            first.write_text("a-before", encoding="utf-8")
            second.write_text("b-before", encoding="utf-8")
            paths = {
                "root": root,
                "working": working,
                "jobs": jobs,
            }
            real_replace = pipeline.os.replace

            def interrupt_second_css(source, destination):
                source_path = Path(source)
                destination_path = Path(destination)
                if (
                    destination_path.resolve() == second.resolve()
                    and source_path.name.endswith(".after")
                ):
                    raise KeyboardInterrupt("simulated process interruption")
                return real_replace(source, destination)

            with patch.object(pipeline.os, "replace", side_effect=interrupt_second_css):
                with self.assertRaises(KeyboardInterrupt):
                    pipeline.apply_style_transaction(paths, {
                        first: b"a-after",
                        second: b"b-after",
                    })

            self.assertEqual(first.read_text(encoding="utf-8"), "a-after")
            self.assertEqual(second.read_text(encoding="utf-8"), "b-before")
            self.assertTrue(
                (jobs / "style" / "style_apply_transaction.json").exists()
            )

            self.assertTrue(pipeline.recover_style_transaction(paths))
            self.assertEqual(first.read_text(encoding="utf-8"), "a-before")
            self.assertEqual(second.read_text(encoding="utf-8"), "b-before")
            self.assertFalse(
                (jobs / "style" / "style_apply_transaction.json").exists()
            )

    def test_style_decision_rejects_unknown_or_unapproved_edits(self):
        candidate = {
            "_allowed": {("replace", "visible")},
        }
        base = {
            "summary": "Safe review.",
            "observations": [],
            "changes": [{
                "candidate_id": "known",
                "action": "replace",
                "replacement": "hidden",
                "reason": "Not actually allowed.",
            }],
        }
        with self.assertRaisesRegex(ValueError, "Unauthorized"):
            pipeline.validate_style_decision(base, {"known": candidate})
        base["changes"][0]["candidate_id"] = "unknown"
        base["changes"][0]["replacement"] = "visible"
        with self.assertRaisesRegex(ValueError, "Unknown"):
            pipeline.validate_style_decision(base, {"known": candidate})

    def test_noop_style_review_keeps_existing_validation_and_final_epub(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            decision = {
                "summary": "No safe correction selected.",
                "changes": [],
                "observations": [],
            }
            decision_path = root / "style-decision.json"
            pipeline.write_json_atomic(decision_path, decision)
            validation_path = paths["jobs"] / "validation.json"
            validation_path.write_text('{"errors": []}', encoding="utf-8")
            paths["final"].write_bytes(b"existing-final")
            report = pipeline.style(
                paths, "medium", resume=False, decision_source=decision_path,
            )
            self.assertFalse(report["corrected"])
            self.assertEqual(paths["final"].read_bytes(), b"existing-final")
            self.assertTrue(validation_path.exists())

    def test_custom_glossary_and_keep_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            glossary = root / "glossary.md"
            glossary.write_text("- code review: revue de code\n", encoding="utf-8")
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            pipeline.prepare(
                epub, "French", "fr", paths, force=False, resume=False,
                keep_input=True, glossary_path=glossary,
            )
            self.assertTrue(epub.exists())
            self.assertEqual(
                (paths["jobs"] / "translation_glossary.md").read_text(encoding="utf-8"),
                "- code review: revue de code\n",
            )

    def test_placeholder_changes_are_rejected(self):
        batch = [{"id": "one", "source": "A ⟦OPEN:1⟧word⟦CLOSE:1⟧.",
                  "placeholders": ["⟦OPEN:1⟧", "⟦CLOSE:1⟧"]}]
        valid = {"translations": [{"id": "one", "target": "Un ⟦OPEN:1⟧mot⟦CLOSE:1⟧."}]}
        self.assertEqual(pipeline.validate_translation_payload(batch, valid)["one"], valid["translations"][0]["target"])
        invalid = {"translations": [{"id": "one", "target": "Un ⟦CLOSE:1⟧mot⟦OPEN:1⟧."}]}
        with self.assertRaises(ValueError):
            pipeline.validate_translation_payload(batch, invalid)

    def test_table_based_code_containers_are_not_extracted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "chapter.xhtml"
            path.write_text("""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<table class="processedcode"><tr><td class="codeline">puts "Hello world"</td></tr></table>
<div class="source-code"><p>Spanish example text must stay unchanged.</p></div>
<dl><dd class="processedcode">A definition-list code sample stays unchanged.</dd></dl>
<p class="barcode">A barcode explanation remains narrative text.</p>
<p>This narrative sentence should be translated.</p>
</body></html>""", encoding="utf-8")
            segments = pipeline.extract_document_segments(
                path, "chapter.xhtml", "application/xhtml+xml",
            )
            self.assertEqual(
                [row["source"] for row in segments],
                [
                    "A barcode explanation remains narrative text.",
                    "This narrative sentence should be translated.",
                ],
            )
            inline = ET.fromstring('<span class="codeline">reader-visible wording</span>')
            self.assertFalse(pipeline.has_code_container_class(inline))

    def test_repair_batch_budget_counts_rejected_attempt(self):
        segments = [
            {
                "id": str(index),
                "source": "Short source.",
                "_previous_rejected_target": "x" * 400,
            }
            for index in range(3)
        ]
        batches = pipeline.make_batches(segments, 150)
        self.assertEqual([len(batch) for batch in batches], [1, 1, 1])

    def test_code_container_validation_is_versioned_for_existing_projects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            segments = pipeline.read_jsonl(paths["jobs"] / "segments.jsonl")
            pipeline.write_jsonl(
                paths["jobs"] / "translations.jsonl",
                [{"id": row["id"], "target": row["source"], "source": "test"} for row in segments],
            )
            pipeline.apply(paths)

            chapter_path = paths["working"] / "OEBPS" / "ch01.xhtml"
            chapter_tree = pipeline.parse_xml(chapter_path)
            code_cell = next(
                node for node in chapter_tree.getroot().iter()
                if "codeline" in node.attrib.get("class", "").split()
            )
            code_cell.text = 'puts "Bonjour"'
            pipeline.write_tree(chapter_tree, chapter_path)

            project.pop("protection_schema_version")
            pipeline.write_json_atomic(paths["jobs"] / "project.json", project)
            self.assertEqual(pipeline.validate(paths)["errors"], [])

            project["protection_schema_version"] = pipeline.PROTECTION_SCHEMA_VERSION
            pipeline.write_json_atomic(paths["jobs"] / "project.json", project)
            with self.assertRaisesRegex(RuntimeError, "Validation failed"):
                pipeline.validate(paths)
            report = json.loads((paths["jobs"] / "validation.json").read_text(encoding="utf-8"))
            self.assertTrue(any("class='codeline'" in error for error in report["errors"]))

    def test_single_word_headings_are_extracted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "chapter.xhtml"
            path.write_text("""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h2>Logic</h2><p>Rails</p>
</body></html>""", encoding="utf-8")
            segments = pipeline.extract_document_segments(
                path, "chapter.xhtml", "application/xhtml+xml",
            )
            self.assertEqual([row["source"] for row in segments], ["Logic"])

    def test_repair_prompt_includes_rejected_target_and_semantic_guidance(self):
        batch = [{
            "id": "one", "file": "chapter.xhtml", "kind": "element",
            "source": (
                "Modify the file in ⟦OPEN:1⟧db⟦CLOSE:1⟧ named "
                "⟦OPEN:2⟧seeds.rb⟦CLOSE:2⟧."
            ),
            "_previous_rejected_target": (
                "Modifier le fichier ⟦OPEN:2⟧seeds.rb⟦CLOSE:2⟧ dans "
                "⟦OPEN:1⟧db⟦CLOSE:1⟧."
            ),
        }]
        project = {
            "source_language": "English",
            "target_language": "French",
            "target_language_code": "fr",
        }
        prompt = pipeline.build_prompt(
            "Translate.", "Preserve code.", project, batch,
            {"one": "placeholder sequence changed"},
        )
        self.assertIn("previous_rejected_target", prompt)
        self.assertIn("relation sémantique", prompt)
        self.assertIn("sans échanger leurs rôles", prompt)

    def test_valid_rows_are_salvaged_from_a_partially_invalid_batch(self):
        batch = [
            {"id": "good", "source": "A plain sentence.", "placeholders": []},
            {"id": "bad", "source": "A ⟦LOCK:1⟧ sentence.", "placeholders": ["⟦LOCK:1⟧"]},
        ]
        payload = {"translations": [
            {"id": "good", "target": "Une phrase simple."},
            {"id": "bad", "target": "Une phrase sans marqueur."},
        ]}
        valid, invalid, response_errors = pipeline.validate_translation_rows(batch, payload)
        self.assertEqual(valid, {"good": "Une phrase simple."})
        self.assertEqual(invalid, {"bad": "placeholder sequence changed"})
        self.assertEqual(response_errors, [])

    def test_translate_repairs_only_invalid_segments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            calls = []

            def fake_run(_paths, _project, _template, _glossary, batch_id, batch,
                         _reasoning_effort, attempt, repair_reasons, _timeout):
                calls.append((
                    attempt,
                    [row["id"] for row in batch],
                    repair_reasons,
                    [row.get("_previous_rejected_target") for row in batch],
                ))
                invalid_id = batch[-1]["id"] if attempt == 0 else None
                translations = {
                    row["id"]: row["source"]
                    for row in batch
                    if row["id"] != invalid_id
                }
                invalid = {invalid_id: "placeholder sequence changed"} if invalid_id else {}
                return {
                    "batch_id": batch_id, "attempt": attempt, "segments": len(batch),
                    "exit_code": 0, "seconds": 0.1, "error": None, "response_errors": [],
                    "translations": translations, "invalid": invalid,
                    "invalid_targets": (
                        {invalid_id: "Traduction précédente rejetée."} if invalid_id else {}
                    ),
                }

            with patch.object(pipeline, "run_one_batch", side_effect=fake_run):
                stats = pipeline.translate(
                    paths, workers=10, batch_tokens=100000, repair_tokens=200,
                    max_retries=2, reasoning_effort="low",
                )

            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0][0], 0)
            self.assertEqual(calls[1][0], 1)
            self.assertEqual(len(calls[1][1]), 1)
            self.assertEqual(calls[1][2][calls[1][1][0]], "placeholder sequence changed")
            self.assertEqual(calls[1][3], ["Traduction précédente rejetée."])
            self.assertEqual(stats["workers"], 10)
            self.assertEqual(stats["first_pass_invalid"], 1)
            self.assertEqual(stats["repair_segments_submitted"], 1)
            self.assertEqual(len(pipeline.load_translations(paths["jobs"] / "translations.jsonl")), stats["segments"])
            self.assertTrue(paths["global_memory"].is_file())

    def test_resume_preserves_cumulative_translation_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)

            def fake_run(_paths, _project, _template, _glossary, batch_id, batch,
                         _reasoning_effort, attempt, _repair_reasons, _timeout):
                return {
                    "batch_id": batch_id, "attempt": attempt, "segments": len(batch),
                    "exit_code": 0, "seconds": 2.0, "error": None, "response_errors": [],
                    "translations": {row["id"]: row["source"] for row in batch}, "invalid": {},
                }

            with patch.object(pipeline, "run_one_batch", side_effect=fake_run):
                first = pipeline.translate(
                    paths, workers=2, batch_tokens=100000, repair_tokens=1000,
                    max_retries=0, reasoning_effort="low",
                )
                resumed = pipeline.translate(
                    paths, workers=2, batch_tokens=100000, repair_tokens=1000,
                    max_retries=0, reasoning_effort="low",
                )

            self.assertEqual(first["initial_batches"], 1)
            self.assertEqual(resumed["initial_batches"], 1)
            self.assertEqual(resumed["runs"], 2)
            self.assertEqual(resumed["last_run"]["initial_batches"], 0)
            self.assertGreaterEqual(resumed["worker_seconds"], 2.0)
            history = pipeline.read_jsonl(paths["jobs"] / "translation_run_history.jsonl")
            self.assertEqual(len(history), 2)

    def test_interrupted_translation_finalizes_started_history_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)

            def interrupt_worker(*_args, **_kwargs):
                raise KeyboardInterrupt("simulated user interruption")

            with patch.object(pipeline, "run_one_batch", side_effect=interrupt_worker):
                with self.assertRaisesRegex(KeyboardInterrupt, "simulated user interruption"):
                    pipeline.translate(
                        paths, workers=2, batch_tokens=100000, repair_tokens=1000,
                        max_retries=0, reasoning_effort="low",
                    )

            history = pipeline.read_jsonl(paths["jobs"] / "translation_run_history.jsonl")
            self.assertEqual(len(history), 1)
            self.assertEqual(history[0]["status"], "interrupted")
            self.assertEqual(history[0]["interruption"]["type"], "KeyboardInterrupt")
            self.assertIn("run_id", history[0])
            self.assertEqual(history[0]["run_number"], 1)
            self.assertIn("Status: interrupted", (
                paths["jobs"] / "translation_progress.md"
            ).read_text(encoding="utf-8"))

    def test_record_translation_run_updates_same_run_id(self):
        with tempfile.TemporaryDirectory() as directory:
            jobs = Path(directory) / "jobs"
            jobs.mkdir()
            paths = {"jobs": jobs}
            pipeline.record_translation_run(
                paths, {"status": "running", "initial_batches": 0, "attempts": []},
                run_id="stable-run",
            )
            aggregate = pipeline.record_translation_run(
                paths, {"status": "complete", "initial_batches": 2, "attempts": []},
                run_id="stable-run",
            )
            history = pipeline.read_jsonl(jobs / "translation_run_history.jsonl")
            self.assertEqual(len(history), 1)
            self.assertEqual(history[0]["status"], "complete")
            self.assertEqual(history[0]["run_number"], 1)
            self.assertEqual(aggregate["runs"], 1)
            self.assertEqual(aggregate["initial_batches"], 2)

    def test_legacy_run_summary_migrates_with_distinct_run_numbers(self):
        with tempfile.TemporaryDirectory() as directory:
            jobs = Path(directory) / "jobs"
            jobs.mkdir()
            paths = {"jobs": jobs}
            pipeline.write_json_atomic(
                jobs / "translation_run.json",
                {
                    "status": "incomplete", "initial_batches": 3, "wall_seconds": 12.0,
                    "attempts": [{"attempt": 0, "batches": 3}],
                },
            )
            aggregate = pipeline.record_translation_run(
                paths,
                {
                    "status": "complete", "initial_batches": 0, "wall_seconds": 0.2,
                    "attempts": [],
                },
            )
            history = pipeline.read_jsonl(jobs / "translation_run_history.jsonl")
            self.assertEqual([row["run_number"] for row in history], [1, 2])
            self.assertEqual(aggregate["initial_batches"], 3)
            self.assertEqual(aggregate["attempts"][0]["run_number"], 1)

    def test_corrupt_history_line_is_backed_up_and_valid_runs_are_salvaged(self):
        with tempfile.TemporaryDirectory() as directory:
            jobs = Path(directory) / "jobs"
            jobs.mkdir()
            paths = {"jobs": jobs}
            history_path = jobs / "translation_run_history.jsonl"
            history_path.write_text(
                '{"status":"incomplete","run_number":1,"initial_batches":2}\n'
                '{broken-json\n',
                encoding="utf-8",
            )
            aggregate = pipeline.record_translation_run(
                paths,
                {"status": "complete", "initial_batches": 0, "attempts": []},
            )
            self.assertEqual(aggregate["runs"], 2)
            self.assertEqual(aggregate["history_recovery"]["discarded_lines"], [2])
            self.assertTrue(Path(aggregate["history_recovery"]["backup"]).is_file())
            self.assertEqual(len(pipeline.read_jsonl(history_path)), 2)

    def test_terminal_codex_failure_stops_repair_waves(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            calls = []

            def blocked_run(_paths, _project, _template, _glossary, batch_id, batch,
                            _reasoning_effort, attempt, _repair_reasons, _timeout):
                calls.append(attempt)
                return {
                    "batch_id": batch_id, "attempt": attempt, "segments": len(batch),
                    "exit_code": 1, "seconds": 0.1, "error": "You've hit your usage limit.",
                    "failure_class": "usage_limit", "retryable": False,
                    "response_errors": [], "translations": {},
                    "invalid": {row["id"]: "You've hit your usage limit." for row in batch},
                }

            with patch.object(pipeline, "run_one_batch", side_effect=blocked_run):
                with self.assertRaisesRegex(RuntimeError, "paused by usage_limit"):
                    pipeline.translate(
                        paths, workers=2, batch_tokens=100000, repair_tokens=1000,
                        max_retries=2, reasoning_effort="low",
                    )

            self.assertEqual(calls, [0])
            stats = json.loads((paths["jobs"] / "translation_run.json").read_text(encoding="utf-8"))
            self.assertEqual(stats["status"], "blocked_external")
            self.assertEqual(stats["blocking_failure"]["kind"], "usage_limit")
            self.assertEqual(stats["first_pass_invalid"], 0)
            self.assertGreater(stats["external_blocked_segments"], 0)

    def test_blocked_translation_can_resume_without_losing_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)

            def blocked(_paths, _project, _template, _glossary, batch_id, batch,
                        _reasoning_effort, attempt, _repair_reasons, _timeout):
                return {
                    "batch_id": batch_id, "attempt": attempt, "segments": len(batch),
                    "exit_code": 1, "seconds": 0.1, "error": "Codex usage limit reached.",
                    "failure_class": "usage_limit", "retryable": False,
                    "response_errors": [], "translations": {},
                    "invalid": {row["id"]: "Codex usage limit reached." for row in batch},
                }

            def succeeds(_paths, _project, _template, _glossary, batch_id, batch,
                         _reasoning_effort, attempt, _repair_reasons, _timeout):
                return {
                    "batch_id": batch_id, "attempt": attempt, "segments": len(batch),
                    "exit_code": 0, "seconds": 0.1, "error": None, "response_errors": [],
                    "translations": {row["id"]: row["source"] for row in batch}, "invalid": {},
                }

            with patch.object(pipeline, "run_one_batch", side_effect=blocked):
                with self.assertRaises(RuntimeError):
                    pipeline.translate(
                        paths, workers=2, batch_tokens=100000, repair_tokens=1000,
                        max_retries=2, reasoning_effort="low",
                    )
            with patch.object(pipeline, "run_one_batch", side_effect=succeeds):
                stats = pipeline.translate(
                    paths, workers=2, batch_tokens=100000, repair_tokens=1000,
                    max_retries=2, reasoning_effort="low",
                )
            self.assertEqual(stats["status"], "complete")
            self.assertEqual(stats["runs"], 2)
            self.assertGreater(stats["external_blocked_segments"], 0)
            self.assertEqual(len(pipeline.read_jsonl(
                paths["jobs"] / "translation_run_history.jsonl"
            )), 2)

    def test_apply_materializes_only_exact_local_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            segments = pipeline.read_jsonl(paths["jobs"] / "segments.jsonl")
            representative = next(
                row for row in segments
                if row["file"] == "OEBPS/ch01.xhtml" and row["kind"] == "element"
            )
            alias = dict(representative)
            alias["id"] = "synthetic-exact-alias"
            pipeline.write_jsonl(paths["jobs"] / "segments.jsonl", [*segments, alias])
            pipeline.write_jsonl(
                paths["jobs"] / "translations.jsonl",
                [{"id": row["id"], "target": row["source"], "source": "test"} for row in segments],
            )

            pipeline.apply(paths)

            completed = pipeline.load_translations(paths["jobs"] / "translations.jsonl")
            self.assertEqual(completed[alias["id"]]["target"], representative["source"])
            self.assertEqual(completed[alias["id"]]["source"], "deduplicated-local")

    def test_local_aliases_reject_invalid_or_merely_similar_representatives(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            segments = pipeline.read_jsonl(paths["jobs"] / "segments.jsonl")
            representative = next(row for row in segments if row["kind"] == "element")
            exact_alias = {**representative, "id": "exact-alias"}
            similar_alias = {
                **representative,
                "id": "similar-alias",
                "source": representative["source"] + " Extra context.",
            }
            completed = {
                representative["id"]: {
                    "id": representative["id"],
                    "target": "",
                    "source": "manual",
                }
            }
            added = pipeline.materialize_exact_translation_aliases(
                paths, project, [representative, exact_alias, similar_alias], completed,
            )
            self.assertEqual(added, 0)
            self.assertNotIn(exact_alias["id"], completed)
            self.assertNotIn(similar_alias["id"], completed)

    def test_cover_selection_prioritizes_declared_image_and_rejects_non_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            opf = root / "content.opf"
            opf.write_text("""<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf"><metadata>
<meta name="cover" content="cover-page"/></metadata><manifest>
<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>
<item id="cover-css" href="cover.css" media-type="text/css"/>
<item id="fallback-cover" href="fallback-cover.jpg" media-type="image/jpeg"/>
<item id="official" href="images/front.png" media-type="image/png" properties="cover-image"/>
</manifest></package>""", encoding="utf-8")
            self.assertEqual(pipeline.find_cover_resource(root, "content.opf"), "images/front.png")
            opf.write_text(opf.read_text(encoding="utf-8").replace(
                'content="cover-page"', 'content="fallback-cover"'
            ), encoding="utf-8")
            self.assertEqual(pipeline.find_cover_resource(root, "content.opf"), "fallback-cover.jpg")

    def test_epub2_cover_path_is_normalized_to_manifest_id(self):
        with tempfile.TemporaryDirectory() as directory:
            opf = Path(directory) / "content.opf"
            opf.write_text("""<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata>
<meta name="cover" content="Images/front.png"/></metadata><manifest>
<item id="primary-art" href="Images/front.png" media-type="image/png"/>
</manifest></package>""", encoding="utf-8")
            self.assertEqual(
                pipeline.find_cover_resource(Path(directory), "content.opf"),
                "Images/front.png",
            )
            root = ET.parse(opf).getroot()
            result = pipeline.normalize_cover_declaration(root, "content.opf", "Images/front.png")
            cover_meta = next(
                node for node in root.iter()
                if pipeline.local_name(node.tag) == "meta" and node.attrib.get("name") == "cover"
            )
            self.assertEqual(cover_meta.attrib["content"], "primary-art")
            self.assertTrue(result["meta_updated"])
            self.assertEqual(result["manifest_id"], "primary-art")

    def test_epub3_cover_image_property_is_unique_and_authoritative(self):
        with tempfile.TemporaryDirectory() as directory:
            opf = Path(directory) / "content.opf"
            opf.write_text("""<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata>
<meta name="cover" content="old-cover"/></metadata><manifest>
<item id="old-cover" href="covers/legacy.jpg" media-type="image/jpeg"/>
<item id="real-cover" href="covers/real.jpg" media-type="image/jpeg" properties="cover-image"/>
</manifest></package>""", encoding="utf-8")
            selected = pipeline.find_cover_resource(Path(directory), "content.opf")
            self.assertEqual(selected, "covers/real.jpg")
            root = ET.parse(opf).getroot()
            result = pipeline.normalize_cover_declaration(root, "content.opf", selected)
            property_ids = [
                node.attrib.get("id")
                for node in root.iter()
                if pipeline.local_name(node.tag) == "item"
                and "cover-image" in node.attrib.get("properties", "").split()
            ]
            cover_meta = next(
                node for node in root.iter()
                if pipeline.local_name(node.tag) == "meta" and node.attrib.get("name") == "cover"
            )
            self.assertEqual(property_ids, ["real-cover"])
            self.assertEqual(cover_meta.attrib["content"], "real-cover")
            self.assertEqual(result["cover_image_properties_removed"], [])
            self.assertEqual(pipeline.package_version(ET.fromstring('<package version=""/>')), 2.0)

    def test_unsafe_cover_manifest_path_is_not_selected(self):
        with tempfile.TemporaryDirectory() as directory:
            opf = Path(directory) / "content.opf"
            opf.write_text("""<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata>
<meta name="cover" content="outside"/></metadata><manifest>
<item id="outside" href="../outside.jpg" media-type="image/jpeg"/>
</manifest></package>""", encoding="utf-8")
            self.assertIsNone(pipeline.find_cover_resource(Path(directory), "content.opf"))
            with self.assertRaisesRegex(RuntimeError, "escapes"):
                pipeline.safe_resource_path(Path(directory), "../outside.jpg")

    def test_raster_dimensions_are_detected_without_image_dependency(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cover.png"
            path.write_bytes(
                b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR"
                + (1200).to_bytes(4, "big") + (1387).to_bytes(4, "big")
            )
            self.assertEqual(pipeline.image_dimensions(path), (1200, 1387))
            path.write_bytes(
                b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR"
                + (1200).to_bytes(4, "big") + (0).to_bytes(4, "big")
            )
            self.assertIsNone(pipeline.image_dimensions(path))
            path.write_bytes(b"GIF89a" + (640).to_bytes(2, "little") + (960).to_bytes(2, "little"))
            self.assertEqual(pipeline.image_dimensions(path), (640, 960))
            path.write_bytes(
                b"\xff\xd8"
                + b"\xff\xe0\x00\x10" + b"\x00" * 14
                + b"\xff\xc0\x00\x11\x08"
                + (720).to_bytes(2, "big") + (480).to_bytes(2, "big")
                + b"\x03" + b"\x00" * 9
            )
            self.assertEqual(pipeline.image_dimensions(path), (480, 720))
            path.write_bytes(b"\xff\xd8\xff\xc0\x00")
            self.assertIsNone(pipeline.image_dimensions(path))
            path.write_bytes(
                b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"NOPE"
                + (1200).to_bytes(4, "big") + (1387).to_bytes(4, "big")
            )
            self.assertIsNone(pipeline.image_dimensions(path))

    def test_explicit_editorial_decision_bypasses_codex(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            decision = {
                "title": "Petit livre",
                "subtitle": "Guide libre",
                "full_title": "Petit livre : guide libre",
                "title_sort": "Petit livre",
                "creators": ["A. Autrice"],
                "publisher": "Maison test",
                "publication_date": "2025-01-01",
                "description": "Une description éditoriale.",
                "subjects": ["Programmation", "Conception", "Apprentissage"],
                "cover_text": {
                    "title": "Petit livre", "subtitle": "Guide libre",
                    "author": "A. Autrice", "contributor": "",
                },
                "front_matter_replacements": [],
                "notes": ["Décision humaine réutilisable."],
            }
            decision_path = root / "decision.json"
            decision_path.write_text(json.dumps(decision), encoding="utf-8")
            with patch.object(pipeline.subprocess, "run") as run:
                loaded = pipeline.run_editorial_review(
                    paths, project, "medium", resume=False, decision_source=decision_path,
                )
            run.assert_not_called()
            self.assertEqual(loaded["full_title"], decision["full_title"])
            saved = json.loads(
                (paths["jobs"] / "editorial" / "metadata_decision.json").read_text(encoding="utf-8")
            )
            self.assertEqual(saved["notes"], decision["notes"])

    def test_editorial_usage_limit_records_recovery_memory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)

            def fake_process(*_args, **kwargs):
                kwargs["stderr"].write(b"ERROR: You've hit your usage limit. Try again later.\n")
                return SimpleNamespace(returncode=1)

            with patch.object(pipeline.subprocess, "run", side_effect=fake_process):
                with self.assertRaisesRegex(RuntimeError, "Editorial review paused by usage_limit"):
                    pipeline.run_editorial_review(paths, project, "medium", resume=False)

            failure = json.loads(
                (paths["jobs"] / "editorial" / "editorial_failure.json").read_text(encoding="utf-8")
            )
            self.assertEqual(failure["status"], "blocked_external")
            self.assertFalse(failure["retryable"])
            self.assertIn("--editorial-decision", failure["recovery"])

    def test_editorial_decision_rejects_unknown_fields_and_reports_invalid_json_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            invalid_path = root / "broken-decision.json"
            invalid_path.write_text("{not-json", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, r"broken-decision\.json.*line 1"):
                pipeline.run_editorial_review(
                    paths, project, "medium", resume=False, decision_source=invalid_path,
                )
            payload = {
                "title": "Titre", "subtitle": "", "full_title": "Titre", "title_sort": "Titre",
                "creators": ["Autrice"], "publisher": "Maison", "publication_date": "2025",
                "description": "Description", "subjects": ["Un", "Deux", "Trois"],
                "cover_text": {"title": "Titre", "subtitle": "", "author": "Autrice", "contributor": ""},
                "front_matter_replacements": [], "notes": [], "unexpected": True,
            }
            with self.assertRaisesRegex(ValueError, "unknown fields: unexpected"):
                pipeline.validate_editorial_decision(payload)

    def test_editorial_timeout_replaces_stale_failure_memory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            editorial_dir = paths["jobs"] / "editorial"
            editorial_dir.mkdir(parents=True, exist_ok=True)
            pipeline.write_json_atomic(
                editorial_dir / "editorial_failure.json",
                {"status": "blocked_external", "kind": "authentication"},
            )
            with patch.object(
                pipeline.subprocess, "run", side_effect=subprocess.TimeoutExpired("codex", 3)
            ):
                with self.assertRaisesRegex(RuntimeError, "timed out"):
                    pipeline.run_editorial_review(
                        paths, project, "medium", resume=False, timeout=3,
                    )
            failure = json.loads(
                (editorial_dir / "editorial_failure.json").read_text(encoding="utf-8")
            )
            self.assertEqual(failure["kind"], "timeout")
            self.assertTrue(failure["retryable"])

    def test_epub2_named_entity_is_translated_and_doctype_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "chapter.xhtml"
            doctype = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">'
            path.write_text(f'''<?xml version="1.0" encoding="utf-8"?>
{doctype}
<?xml-stylesheet href="book.css" type="text/css"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>A&nbsp;useful sentence.</p></body></html>''', encoding="utf-8")
            segments = pipeline.extract_document_segments(path, "chapter.xhtml", "application/xhtml+xml")
            self.assertEqual(len(segments), 1)
            self.assertIn("A useful sentence", segments[0]["source"])
            tree = pipeline.parse_xml(path)
            pipeline.write_tree(tree, path)
            rewritten = path.read_text(encoding="utf-8")
            self.assertIn(doctype, rewritten)
            self.assertIn("<?xml-stylesheet", rewritten)

    def test_navigation_tolerates_spacing_noise_and_preserves_heading_structure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.xhtml"
            target = root / "target.xhtml"
            source.write_text("""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head>
<title>Part 1 Getting Started</title></head><body>
<h1><span>Part 1</span><br/><span>Getting Started</span></h1>
<h2>Summary</h2>
</body></html>""", encoding="utf-8")
            target.write_text("""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head>
<title>Partie 1 : prise en main</title></head><body>
<h1><span>Partie 1</span><br/><span>Prise en main</span></h1>
<h2>Synthèse</h2>
</body></html>""", encoding="utf-8")
            heading_map = {
                ("chapter.xhtml", ""): (
                    "Part 1 Getting Started",
                    "Partie 1 : prise en main",
                ),
            }
            pipeline.sync_xhtml_links(
                source, target, "chapter.xhtml", heading_map,
                {"__code__": "fr", "Summary": "Résumé"},
            )
            target_root = pipeline.parse_xml(target).getroot()
            target_heading = next(
                node for node in target_root.iter() if pipeline.local_name(node.tag) == "h1"
            )
            spans = [
                node for node in target_heading
                if pipeline.local_name(node.tag) == "span"
            ]
            self.assertEqual([span.text for span in spans], ["Partie 1", "Prise en main"])
            plain_heading = next(
                node for node in target_root.iter() if pipeline.local_name(node.tag) == "h2"
            )
            self.assertEqual(pipeline.visible_text(plain_heading), "Résumé")

            source_ncx = root / "source.ncx"
            target_ncx = root / "target.ncx"
            ncx = """<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<docTitle><text>Book</text></docTitle><navMap>
<navPoint id="n1"><navLabel><text>1. Pa rt 1: Getting Started</text></navLabel>
<content src="chapter.xhtml"/></navPoint>
</navMap></ncx>"""
            source_ncx.write_text(ncx, encoding="utf-8")
            target_ncx.write_text(ncx, encoding="utf-8")
            pipeline.sync_ncx(
                source_ncx, target_ncx, "toc.ncx", heading_map,
                "Livre", "fr", {"__code__": "fr"},
            )
            ncx_root = pipeline.parse_xml(target_ncx).getroot()
            labels = [
                pipeline.visible_text(node)
                for node in ncx_root.iter()
                if pipeline.local_name(node.tag) == "navLabel"
            ]
            self.assertEqual(labels, ["1. Partie 1 : prise en main"])

    def test_navigation_adapts_when_label_omits_heading_ordinal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "original"
            working = root / "working"
            original.mkdir()
            working.mkdir()
            source_chapter = original / "chapter.xhtml"
            target_chapter = working / "chapter.xhtml"
            source_chapter.write_text("""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h2 id="introduction">1. INTRODUCTION, OVERVIEW, AND SUMMARY</h2>
</body></html>""", encoding="utf-8")
            target_chapter.write_text("""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h2 id="introduction">1. INTRODUCTION, VUE D’ENSEMBLE ET RÉSUMÉ</h2>
</body></html>""", encoding="utf-8")
            heading_map = pipeline.id_heading_map(
                original, working, ["chapter.xhtml"],
            )
            self.assertEqual(
                pipeline.navigation_label_replacement(
                    "Introduction, Overview, and Summary",
                    "chapter.xhtml#introduction", "nav.xhtml", heading_map,
                    {"__code__": "fr"},
                ),
                "INTRODUCTION, VUE D’ENSEMBLE ET RÉSUMÉ",
            )
            self.assertEqual(
                pipeline.translated_label(
                    "Life and Death", "IV — Life and Death", "IV — Vie et mort",
                ),
                "Vie et mort",
            )
            self.assertIsNone(
                pipeline.translated_label(
                    "Publisher Introduction", "1. Introduction", "1. Introduction",
                )
            )

            source_nav = original / "nav.xhtml"
            target_nav = working / "nav.xhtml"
            nav = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol><li>
<a href="chapter.xhtml#introduction">Introduction, Overview, and Summary</a>
</li></ol></nav></body></html>"""
            source_nav.write_text(nav, encoding="utf-8")
            target_nav.write_text(nav, encoding="utf-8")
            ui = {"__code__": "fr"}
            self.assertEqual(
                len(pipeline.navigation_sync_errors(
                    original, working, ["nav.xhtml"], heading_map, ui, "Book", "Livre",
                )),
                1,
            )
            pipeline.sync_xhtml_links(
                source_nav, target_nav, "nav.xhtml", heading_map, ui, "Book", "Livre",
            )
            self.assertEqual(
                pipeline.navigation_sync_errors(
                    original, working, ["nav.xhtml"], heading_map, ui, "Book", "Livre",
                ),
                [],
            )

    def test_navigation_composes_split_headings_and_book_title_suffixes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "original"
            working = root / "working"
            original.mkdir()
            working.mkdir()
            chapter_rel = "chapter.xhtml"
            source_chapter = original / chapter_rel
            target_chapter = working / chapter_rel
            source_chapter.write_text("""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head>
<title>Part One: Getting Started, Adaptable Book</title></head><body>
<h1 id="part-one">Part One</h1><h1 id="getting-started">Getting Started</h1>
</body></html>""", encoding="utf-8")
            target_chapter.write_text("""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="fr"><head>
<title>Traduction libre produite par le worker</title></head><body>
<h1 id="part-one">Première partie</h1><h1 id="getting-started">Bien démarrer</h1>
</body></html>""", encoding="utf-8")
            heading_map = pipeline.id_heading_map(original, working, [chapter_rel])
            self.assertEqual(
                pipeline.navigation_label_replacement(
                    "Part One • Getting Started", "chapter.xhtml", "nav.xhtml",
                    heading_map, {"__code__": "fr"},
                ),
                "Première partie • Bien démarrer",
            )
            self.assertIsNone(
                pipeline.navigation_label_replacement(
                    "Part One • A publisher-specific bonus", "chapter.xhtml", "nav.xhtml",
                    heading_map, {"__code__": "fr"},
                )
            )
            self.assertIsNone(
                pipeline.document_title_replacement(
                    "Publisher Special Edition, Adaptable Book", chapter_rel, heading_map,
                    {"__code__": "fr"}, "Adaptable Book", "Livre adaptable",
                )
            )

            pipeline.sync_xhtml_links(
                source_chapter, target_chapter, chapter_rel, heading_map,
                {"__code__": "fr"}, "Adaptable Book", "Livre adaptable",
            )
            chapter_root = pipeline.parse_xml(target_chapter).getroot()
            chapter_title = next(
                node for node in chapter_root.iter() if pipeline.local_name(node.tag) == "title"
            )
            self.assertEqual(
                pipeline.visible_text(chapter_title),
                "Première partie: Bien démarrer, Livre adaptable",
            )

            source_nav = original / "nav.xhtml"
            target_nav = working / "nav.xhtml"
            nav = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head>
<title>Contents, Adaptable Book</title></head><body><nav><ol><li>
<a href="chapter.xhtml"><span>Part One</span> • <span>Getting Started</span></a>
</li></ol></nav></body></html>"""
            source_nav.write_text(nav, encoding="utf-8")
            target_nav.write_text(nav, encoding="utf-8")
            ui = {"__code__": "fr", "Contents": "Sommaire"}
            pipeline.sync_xhtml_links(
                source_nav, target_nav, "nav.xhtml", heading_map, ui,
                "Adaptable Book", "Livre adaptable",
            )
            nav_root = pipeline.parse_xml(target_nav).getroot()
            nav_title = next(
                node for node in nav_root.iter() if pipeline.local_name(node.tag) == "title"
            )
            link = next(node for node in nav_root.iter() if pipeline.local_name(node.tag) == "a")
            self.assertEqual(pipeline.visible_text(nav_title), "Sommaire, Livre adaptable")
            self.assertEqual(
                pipeline.visible_text(link), "Première partie • Bien démarrer",
            )
            self.assertEqual(len(list(link)), 2)
            self.assertEqual(
                pipeline.navigation_sync_errors(
                    original, working, ["nav.xhtml"], heading_map, ui,
                    "Adaptable Book", "Livre adaptable",
                ),
                [],
            )

            source_ncx = original / "toc.ncx"
            target_ncx = working / "toc.ncx"
            ncx = """<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<docTitle><text>Adaptable Book</text></docTitle><navMap>
<navPoint id="n1"><navLabel><text>Part One: Getting Started</text></navLabel>
<content src="chapter.xhtml"/></navPoint></navMap>
<pageList><navLabel><text>Page mapping for Adaptable Book</text></navLabel></pageList>
</ncx>"""
            source_ncx.write_text(ncx, encoding="utf-8")
            target_ncx.write_text(ncx, encoding="utf-8")
            ncx_ui = {**ui, "Page mapping for": "Correspondance des pages pour"}
            pipeline.sync_ncx(
                source_ncx, target_ncx, "toc.ncx", heading_map,
                "Livre adaptable", "fr", ncx_ui,
            )
            ncx_root = pipeline.parse_xml(target_ncx).getroot()
            ncx_text = [
                pipeline.visible_text(node) for node in ncx_root.iter()
                if pipeline.local_name(node.tag) == "text"
            ]
            self.assertEqual(
                ncx_text,
                [
                    "Livre adaptable",
                    "Première partie: Bien démarrer",
                    "Correspondance des pages pour Livre adaptable",
                ],
            )
            self.assertEqual(
                pipeline.navigation_sync_errors(
                    original, working, ["toc.ncx"], heading_map, ncx_ui,
                    "Adaptable Book", "Livre adaptable",
                ),
                [],
            )

    def test_malformed_translatable_xml_is_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "broken.xhtml"
            path.write_text('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Broken text</body></html>',
                            encoding="utf-8")
            with self.assertRaises(ET.ParseError):
                pipeline.extract_document_segments(path, "broken.xhtml", "application/xhtml+xml")

    def test_input_inside_books_is_never_deleted_when_target_name_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = self.create_fixture(root)
            source = root / "books" / "Source project" / "original.epub"
            source.parent.mkdir(parents=True)
            shutil.move(fixture, source)
            paths = pipeline.project_paths(source, "fr", "Different project", books_root=root / "books")
            pipeline.prepare(source, "French", "fr", paths, force=False, resume=False)
            self.assertTrue(source.exists())
            self.assertTrue(paths["source"].exists())

    def test_loose_epub_inside_books_does_not_create_nested_books_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            books_root = root / "books"
            books_root.mkdir()
            source = self.create_fixture(root)
            loose_epub = books_root / source.name
            shutil.move(source, loose_epub)

            paths = pipeline.project_paths(loose_epub, "fr", books_root=books_root)
            pipeline.prepare(loose_epub, "French", "fr", paths, force=False, resume=False)

            self.assertEqual(paths["root"], books_root.resolve() / "Tiny Book")
            self.assertFalse((books_root / "books").exists())
            self.assertTrue(loose_epub.exists())
            self.assertTrue(paths["source"].exists())

    def test_external_epub_is_copied_to_repository_books_and_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            external_root = root / "external"
            external_root.mkdir()
            source = self.create_fixture(external_root)
            books_root = root / "repository" / "books"

            paths = pipeline.project_paths(source, "fr", books_root=books_root)
            pipeline.prepare(source, "French", "fr", paths, force=False, resume=False)

            self.assertEqual(paths["root"], books_root.resolve() / "Tiny Book")
            self.assertTrue(source.exists())
            self.assertTrue(paths["source"].exists())

    def test_default_project_root_is_the_repository_books_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.create_fixture(Path(directory))

            paths = pipeline.project_paths(source, "fr")

            self.assertEqual(paths["root"].parent, pipeline.PROJECT_BOOKS_ROOT.resolve())

    def test_existing_canonical_project_path_is_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.create_fixture(root)
            books_root = root / "books"
            paths = pipeline.project_paths(source, "fr", books_root=books_root)
            pipeline.prepare(source, "French", "fr", paths, force=False, resume=False)

            resumed_paths = pipeline.project_paths(paths["source"], "fr", books_root=books_root)

            self.assertEqual(resumed_paths["root"], paths["root"])

    def test_resume_does_not_delete_input_before_project_is_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            retry_input = root / "retry.epub"
            shutil.copy2(paths["source"], retry_input)
            (paths["jobs"] / "project.json").write_text("invalid json", encoding="utf-8")
            with self.assertRaises(json.JSONDecodeError):
                pipeline.prepare(retry_input, "French", "fr", paths, force=False, resume=True)
            self.assertTrue(retry_input.exists())

    def test_zip_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = root / "unsafe.epub"
            with zipfile.ZipFile(epub, "w") as archive:
                archive.writestr("../outside.txt", "unsafe")
            with self.assertRaisesRegex(RuntimeError, "Unsafe ZIP member"):
                pipeline.safe_extract(epub, root / "output")
            self.assertFalse((root / "outside.txt").exists())
            backslash_epub = root / "unsafe-windows.epub"
            with zipfile.ZipFile(backslash_epub, "w") as archive:
                archive.writestr(r"..\outside.txt", "unsafe")
            with self.assertRaisesRegex(RuntimeError, "Unsafe ZIP member"):
                pipeline.safe_extract(backslash_epub, root / "output-windows")

    def test_book_names_are_cross_platform_safe(self):
        self.assertEqual(pipeline.safe_book_name("CON"), "_CON")
        self.assertNotIn("\\", pipeline.safe_book_name(r"Folder\\Book"))
        self.assertEqual(pipeline.safe_book_name(".."), "Untitled book")

    def test_non_latin_text_is_detected(self):
        self.assertTrue(pipeline.natural_language_present("これは日本語の文章です"))
        self.assertTrue(pipeline.natural_language_present("这是一个中文句子"))

    def test_worker_timeout_is_a_repairable_batch_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            batch = [pipeline.read_jsonl(paths["jobs"] / "segments.jsonl")[0]]
            template = "Translate."
            glossary = "Preserve code."
            with patch.object(
                pipeline, "run_codex_command",
                side_effect=subprocess.TimeoutExpired("codex", 1),
            ):
                result = pipeline.run_one_batch(
                    paths, project, template, glossary, "timeout", batch, "low", 0, timeout=1,
                )
            self.assertIn("timed out", result["error"])
            self.assertEqual(set(result["invalid"]), {batch[0]["id"]})

    def test_timed_out_codex_command_terminates_its_process_group(self):
        class TimedOutProcess:
            pid = 4242

            def __init__(self):
                self.wait_calls = 0

            def wait(self, timeout=None):
                self.wait_calls += 1
                if self.wait_calls == 1:
                    raise subprocess.TimeoutExpired("codex", timeout)
                return -15

            def poll(self):
                return None if self.wait_calls < 2 else -15

        process = TimedOutProcess()
        pipeline.reset_codex_worker_cancellation()
        with (
            patch.object(pipeline.subprocess, "Popen", return_value=process) as popen,
            patch.object(pipeline.os, "killpg") as killpg,
        ):
            with self.assertRaises(subprocess.TimeoutExpired):
                pipeline.run_codex_command(
                    ["codex", "exec"], stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1,
                )
        self.assertTrue(popen.call_args.kwargs.get("start_new_session"))
        killpg.assert_called_once_with(4242, pipeline.signal.SIGTERM)
        self.assertNotIn(process, pipeline._ACTIVE_CODEX_PROCESSES)

    def test_usage_limit_log_is_classified_as_terminal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            batch = [pipeline.read_jsonl(paths["jobs"] / "segments.jsonl")[0]]

            def fake_process(*_args, **kwargs):
                kwargs["stderr"].write(
                    b"ERROR: You've hit your usage limit. Purchase more credits or try again later.\n"
                )
                return SimpleNamespace(returncode=1)

            with patch.object(pipeline, "run_codex_command", side_effect=fake_process):
                result = pipeline.run_one_batch(
                    paths, project, "Translate.", "Preserve code.", "quota", batch, "low", 0,
                )
            self.assertEqual(result["failure_class"], "usage_limit")
            self.assertFalse(result["retryable"])
            self.assertIn("usage limit", result["error"])

    def test_book_content_cannot_trigger_terminal_failure_classification(self):
        result = pipeline.classify_codex_failure(
            "streaming: If the server returns an error 401 Unauthorized, reconnect.\n"
            "ERROR: stream disconnected before completion; retrying may help\n"
        )
        self.assertEqual(result["kind"], "worker_error")
        self.assertTrue(result["retryable"])

    def test_malformed_worker_json_is_a_repairable_batch_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            batch = [pipeline.read_jsonl(paths["jobs"] / "segments.jsonl")[0]]

            def fake_process(*_args, **_kwargs):
                (paths["jobs"] / "reports" / "malformed.json").write_text("not json", encoding="utf-8")
                return SimpleNamespace(returncode=0)

            with patch.object(pipeline, "run_codex_command", side_effect=fake_process):
                result = pipeline.run_one_batch(
                    paths, project, "Translate.", "Preserve code.", "malformed", batch, "low", 0,
                )
            self.assertTrue(result["error"])
            self.assertEqual(set(result["invalid"]), {batch[0]["id"]})

    def test_legacy_memory_is_not_reused_across_glossary_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr", books_root=root / "books")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            segments = pipeline.read_jsonl(paths["jobs"] / "segments.jsonl")
            legacy = {
                pipeline.memory_key(segment, project["source_language_code"], project["target_language_code"]):
                "Incorrect legacy translation"
                for segment in segments
            }
            pipeline.write_json_atomic(paths["global_memory"], legacy)

            def fake_run(_paths, _project, _template, _glossary, batch_id, batch,
                         _reasoning_effort, attempt, _repair_reasons, _timeout):
                translations = {row["id"]: row["source"] for row in batch}
                return {
                    "batch_id": batch_id, "attempt": attempt, "segments": len(batch),
                    "exit_code": 0, "seconds": 0.1, "error": None, "response_errors": [],
                    "translations": translations, "invalid": {},
                }

            with patch.object(pipeline, "run_one_batch", side_effect=fake_run):
                stats = pipeline.translate(
                    paths, workers=2, batch_tokens=100000, repair_tokens=1000,
                    max_retries=0, reasoning_effort="low",
                )
            self.assertEqual(stats["memory_hits"], 0)
            targets = {row["target"] for row in pipeline.read_jsonl(paths["jobs"] / "translations.jsonl")}
            self.assertNotIn("Incorrect legacy translation", targets)


if __name__ == "__main__":
    unittest.main()
