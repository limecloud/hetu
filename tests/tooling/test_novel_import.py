"""小说导入脚本的源保留、目录语义及电子书顺序验收。"""
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "tools/hetu-skills/base/skills/hetu-import/scripts/import_novel.py"
spec = importlib.util.spec_from_file_location("novel_import", SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class NovelImportTests(unittest.TestCase):
    def test_chinese_restart_duplicate_and_false_heading_preserve_every_character(self):
        text = "书名：渡口\r\n作者：作者\r\n\r\n第1章 开场\r\n原稿🌿\r\n第三回合时，他没有退让。\r\n第2章 接续\r\n原稿二\r\n第1章 新卷\r\n原稿三\r\n第2章 旧章号\r\n原稿四\r\n第2章 重号仍保留\r\n原稿五\r\n"
        units, warnings = m.make_layout(text)
        m.validate_layout(text, units)
        self.assertEqual("".join(text[u["start"]:u["end"]] for u in units), text)
        self.assertEqual(sum(u.get("kind") == "chapter" for u in units), 5)
        self.assertEqual(units[0]["kind"], "front_matter")
        self.assertEqual([u["volume"] for u in units if u.get("kind") == "chapter"], ["第1部分", "第1部分", "第2部分", "第2部分", "第2部分"])
        self.assertEqual(len(warnings), 2)

    def test_chinese_numerals_and_english_roman_restart(self):
        for text in ["第一章 河\n甲\n第十二章 海\n乙\n第一章 雨\n丙", "Chapter I\na\nChapter XII\nb\nChapter I\nc"]:
            units, warnings = m.make_layout(text)
            self.assertEqual(len(units), 3)
            self.assertEqual(units[-1]["volume"], "第2部分")
            self.assertEqual(len(warnings), 1)

    def test_layout_rejects_missing_overlap_empty_and_noninteger_ranges(self):
        for units in [[{"start": 1, "end": 3}], [{"start": 0, "end": 2}], [{"start": 0, "end": 0}], [{"start": False, "end": 3}]]:
            for u in units: u.update(title="原稿", volume="一")
            with self.assertRaises(ValueError): m.validate_layout("甲乙丙", units)
        units, warnings = m.make_layout("没有章标题。🌧️\n\n段落仍须保留。")
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["kind"], "unstructured")
        self.assertTrue(warnings)

    def test_encodings_are_strict_and_crlf_is_not_normalized(self):
        text = "第1章\r\n中文，🌿\r\n"
        self.assertEqual(m.decode(text.encode("utf-16"))[0], text)
        self.assertEqual(m.decode(text.encode("utf-8-sig"))[0], text)
        chinese = "第1章\r\n渡口原稿\r\n"
        self.assertEqual(m.decode(chinese.encode("gb18030")), (chinese, "gb18030"))
        with self.assertRaises(UnicodeDecodeError): m.decode(b"\xff", "utf-8")

    def test_epub_uses_spine_and_docx_preserves_paragraph_and_tab_order(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            epub = p / "novel.epub"
            with zipfile.ZipFile(epub, "w") as z:
                z.writestr("META-INF/container.xml", '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
                z.writestr("OEBPS/content.opf", '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="b" href="a.xhtml"/><item id="a" href="z.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>')
                z.writestr("OEBPS/a.xhtml", "<h1>第2章</h1><p>第二段</p>")
                z.writestr("OEBPS/z.xhtml", "<h1>第1章</h1><p>第一段</p><script>不要执行</script>")
            raw, text, encoding, warnings = m.read_source(epub)
            self.assertLess(text.index("第一段"), text.index("第二段"))
            self.assertNotIn("不要执行", text)
            self.assertEqual(raw, epub.read_bytes())
            self.assertEqual(encoding, "epub-spine")
            self.assertTrue(warnings)
            docx = p / "novel.docx"
            with zipfile.ZipFile(docx, "w") as z:
                z.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一章</w:t><w:tab/><w:t>渡口</w:t></w:r></w:p><w:p><w:r><w:t>原稿</w:t></w:r></w:p></w:body></w:document>')
            self.assertEqual(m.read_source(docx)[1], "第一章\t渡口\n\n原稿")

    def test_archive_traversal_and_oversized_declared_contents_are_rejected(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as z: z.writestr("../outside", "bad")
        buffer.seek(0)
        with self.assertRaises(ValueError): m.archive(buffer)


if __name__ == "__main__":
    unittest.main()
