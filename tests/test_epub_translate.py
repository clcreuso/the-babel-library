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
    <item id="nav" href="OEBPS/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover" href="OEBPS/cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine toc="ncx"><itemref idref="chapter"/></spine>
</package>""",
            "OEBPS/ch01.xhtml": """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en">
<head><title>Tiny Book</title></head><body>
<h1 id="chapter-one">Object Design</h1>
<p>A <code>Gear</code> sends messages.</p>
<p><img src="diagram.png" alt="Useful diagram"/></p>
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
            paths = pipeline.project_paths(epub, "fr")
            self.assertEqual(paths["root"], root.resolve() / "books" / "Tiny Book")
            self.assertEqual(paths["source"].name, "original.epub")
            self.assertEqual(paths["final"].name, "translated-fr.epub")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            self.assertEqual(paths["source"].read_bytes(), source_bytes)
            self.assertFalse(epub.exists())
            segments = pipeline.read_jsonl(paths["jobs"] / "segments.jsonl")
            self.assertGreaterEqual(len(segments), 5)
            self.assertTrue(any("⟦LOCK:" in row["source"] for row in segments))

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
            pipeline.editorial(paths, "medium", resume=True, cover_image=localized_cover)
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
                self.assertIn("Gear", "".join(chapter.itertext()))
                self.assertIn("Conception objet", "".join(nav.itertext()))
                self.assertIn("Couverture", "".join(nav.itertext()))
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

    def test_custom_glossary_and_keep_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            glossary = root / "glossary.md"
            glossary.write_text("- code review: revue de code\n", encoding="utf-8")
            paths = pipeline.project_paths(epub, "fr")
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
            paths = pipeline.project_paths(epub, "fr")
            pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            calls = []

            def fake_run(_paths, _project, _template, _glossary, batch_id, batch,
                         _reasoning_effort, attempt, repair_reasons, _timeout):
                calls.append((attempt, [row["id"] for row in batch], repair_reasons))
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
            self.assertEqual(stats["workers"], 10)
            self.assertEqual(stats["first_pass_invalid"], 1)
            self.assertEqual(stats["repair_segments_submitted"], 1)
            self.assertEqual(len(pipeline.load_translations(paths["jobs"] / "translations.jsonl")), stats["segments"])
            self.assertTrue(paths["global_memory"].is_file())

    def test_resume_preserves_cumulative_translation_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr")
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
            paths = pipeline.project_paths(epub, "fr")
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
            paths = pipeline.project_paths(epub, "fr")
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
            paths = pipeline.project_paths(epub, "fr")
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
            paths = pipeline.project_paths(epub, "fr")
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
            paths = pipeline.project_paths(epub, "fr")
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
            paths = pipeline.project_paths(epub, "fr")
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
            paths = pipeline.project_paths(epub, "fr")
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
            paths = pipeline.project_paths(epub, "fr")
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
            paths = pipeline.project_paths(source, "fr", "Different project")
            pipeline.prepare(source, "French", "fr", paths, force=False, resume=False)
            self.assertTrue(source.exists())
            self.assertTrue(paths["source"].exists())

    def test_resume_does_not_delete_input_before_project_is_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr")
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
            paths = pipeline.project_paths(epub, "fr")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            batch = [pipeline.read_jsonl(paths["jobs"] / "segments.jsonl")[0]]
            template = "Translate."
            glossary = "Preserve code."
            with patch.object(pipeline.subprocess, "run", side_effect=subprocess.TimeoutExpired("codex", 1)):
                result = pipeline.run_one_batch(
                    paths, project, template, glossary, "timeout", batch, "low", 0, timeout=1,
                )
            self.assertIn("timed out", result["error"])
            self.assertEqual(set(result["invalid"]), {batch[0]["id"]})

    def test_usage_limit_log_is_classified_as_terminal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            batch = [pipeline.read_jsonl(paths["jobs"] / "segments.jsonl")[0]]

            def fake_process(*_args, **kwargs):
                kwargs["stderr"].write(
                    b"ERROR: You've hit your usage limit. Purchase more credits or try again later.\n"
                )
                return SimpleNamespace(returncode=1)

            with patch.object(pipeline.subprocess, "run", side_effect=fake_process):
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
            paths = pipeline.project_paths(epub, "fr")
            project = pipeline.prepare(epub, "French", "fr", paths, force=False, resume=False)
            batch = [pipeline.read_jsonl(paths["jobs"] / "segments.jsonl")[0]]

            def fake_process(*_args, **_kwargs):
                (paths["jobs"] / "reports" / "malformed.json").write_text("not json", encoding="utf-8")
                return SimpleNamespace(returncode=0)

            with patch.object(pipeline.subprocess, "run", side_effect=fake_process):
                result = pipeline.run_one_batch(
                    paths, project, "Translate.", "Preserve code.", "malformed", batch, "low", 0,
                )
            self.assertTrue(result["error"])
            self.assertEqual(set(result["invalid"]), {batch[0]["id"]})

    def test_legacy_memory_is_not_reused_across_glossary_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epub = self.create_fixture(root)
            paths = pipeline.project_paths(epub, "fr")
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
