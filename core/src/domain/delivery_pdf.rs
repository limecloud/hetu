//! 中文交付 PDF 产品模板；固定版式不反推为可编辑源，也不声明 PDF/A。

use super::delivery_formats::{
    CONVERTER, Converted, Paragraph, ParagraphStyle, Source, paragraphs,
};
use super::{Error, Result, digest, ensure};
use pdf_writer::types::{CidFontType, FontFlags, SystemInfo, UnicodeCmap};
use pdf_writer::{Content, Finish, Name, Pdf, Rect, Ref, Str, TextStr};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use subsetter::GlyphRemapper;
use ttf_parser::{Face, GlyphId};

const FONT: &[u8] = include_bytes!("../../../assets/fonts/HetuExportSansSC-Regular.ttf");
const PAGE_WIDTH: f32 = 595.276;
const PAGE_HEIGHT: f32 = 841.89;
const MARGIN: f32 = 62.362;
const BOTTOM: f32 = PAGE_HEIGHT - MARGIN;
const MAX_CHARS: usize = 1_000_000;
const MAX_PARAGRAPHS: usize = 50_000;
const MAX_PAGES: usize = 2_000;
const MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy)]
struct Glyph {
    cid: u16,
    gid: u16,
    width: f32,
}

struct Font<'a> {
    face: Face<'a>,
    glyphs: BTreeMap<char, Glyph>,
}

#[derive(Clone, Copy)]
enum Alignment {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy)]
struct Style {
    size: f32,
    leading: f32,
    left: f32,
    right: f32,
    indent: f32,
    before: f32,
    after: f32,
    alignment: Alignment,
    keep_next: bool,
    page_break_before: bool,
}

struct Line {
    text: String,
    width: f32,
    indent: f32,
}

struct Block {
    lines: Vec<Line>,
    style: Style,
}

struct PlacedLine {
    text: String,
    x: f32,
    baseline: f32,
    size: f32,
}

#[derive(Default)]
struct Page {
    lines: Vec<PlacedLine>,
}

/// 使用随产品分发、可嵌入的静态字体生成可选择文字的 A4 中文 PDF。
pub fn render(sources: &[Source], profile: &str) -> Result<Converted> {
    ensure(
        matches!(profile, "hetu-novel-zh/1" | "hetu-screenplay-zh/1"),
        "invalid_input",
        "PDF 交付模板无效。",
    )?;
    ensure(
        sources.iter().all(|source| {
            source.kind
                == if profile == "hetu-novel-zh/1" {
                    "novel_chapter"
                } else {
                    "drama_script"
                }
        }),
        "invalid_input",
        "PDF 模板与正文类型不一致。",
    )?;
    // 在共享解析器分配段落之前检查输入预算。
    let input_chars = sources.iter().try_fold(0usize, |count, source| {
        let next = count
            + source.content.chars().count()
            + source.title.chars().count()
            + source.author.chars().count();
        ensure(
            next <= MAX_CHARS,
            "hetu.budget_exceeded",
            "PDF 文本超过百万字上限。",
        )?;
        Ok::<_, Error>(next)
    })?;
    ensure(input_chars > 0, "invalid_input", "PDF 没有可交付的文字。")?;
    let (mut paragraphs, mut losses) = paragraphs(sources)?;
    ensure(
        !paragraphs.is_empty() && paragraphs.len() <= MAX_PARAGRAPHS,
        "hetu.budget_exceeded",
        "PDF 段落为空或超过五万段上限。",
    )?;
    let mut tab_count = 0;
    let emphasis_count = paragraphs
        .iter()
        .flat_map(|paragraph| &paragraph.runs)
        .filter(|run| run.bold || run.italic)
        .count();
    for paragraph in &mut paragraphs {
        tab_count += paragraph.text.matches('\t').count();
        paragraph.text = paragraph
            .text
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .replace('\t', "    ");
    }
    if tab_count > 0 {
        losses.push(json!({"code":"pdf_tab_expanded","count":tab_count,
            "message":"固定版式中的制表符展开为四个空格。"}));
    }
    if emphasis_count > 0 {
        losses.push(json!({"code":"pdf_inline_emphasis_flattened","count":emphasis_count,
            "message":"当前 PDF 单字重模板按正文显示行内粗体和斜体，文字保留；需要强调样式时可选择 DOCX。"}));
    }
    let font = Font::new(&paragraphs)?;
    let mut forced_breaks = 0;
    let blocks = paragraphs
        .iter()
        .map(|paragraph| {
            let style = style(&paragraph.style, profile);
            let (lines, count) = wrap(&paragraph.text, style, &font)?;
            forced_breaks += count;
            Ok(Block { lines, style })
        })
        .collect::<Result<Vec<_>>>()?;
    if forced_breaks > 0 {
        losses.push(
            json!({"code":"pdf_long_token_wrapped","count":forced_breaks,
            "message":"超出版心的连续词或标识已按字形换行，原文字保持不变。"}),
        );
    }
    let pages = paginate(&blocks, &font)?;
    let (title, author) = super::delivery_formats::document_metadata(&paragraphs);
    let bytes = write_pdf(&pages, &font, title, author)?;
    ensure(
        bytes.len() <= MAX_BYTES,
        "hetu.budget_exceeded",
        "PDF 超过 64 MiB 输出上限。",
    )?;
    let report = json!({
        "schema_version":"1.0.0",
        "converter":CONVERTER,
        "format":"pdf",
        "profile":profile,
        "renderer":"hetu-pdf-layout/1",
        "page_count":pages.len(),
        "page_size":"A4",
        "font":"Hetu Export Sans SC Regular",
        "font_license":"OFL-1.1",
        "font_embedded":true,
        "font_subset":true,
        "selectable_text":true,
        "pdf_a":false,
        "input_count":sources.len(),
        "output_sha256":digest(&bytes),
        "output_size_bytes":bytes.len(),
        "warnings":[],
        "confirmation_required":!losses.is_empty(),
        "coverage":{"status":"supported_subset","industry_interoperability":"not_verified"},
        "losses":losses,
        "limits":{"characters":MAX_CHARS,"paragraphs":MAX_PARAGRAPHS,
            "pages":MAX_PAGES,"output_bytes":MAX_BYTES}
    });
    Ok(Converted {
        bytes,
        media_type: "application/pdf",
        extension: "pdf",
        report,
    })
}

impl<'a> Font<'a> {
    fn new(paragraphs: &[Paragraph]) -> Result<Self> {
        let face = Face::parse(FONT, 0)
            .map_err(|_| Error::new("hetu.integrity_failure", "随附 PDF 字体不可读取。"))?;
        let mut characters: BTreeSet<char> = paragraphs
            .iter()
            .flat_map(|paragraph| paragraph.text.chars())
            .filter(|character| *character != '\n')
            .collect();
        characters.extend('0'..='9');
        ensure(
            characters.len() < usize::from(u16::MAX),
            "hetu.budget_exceeded",
            "PDF 使用的不同字符超过 CID 字符映射上限。",
        )?;
        let mut missing = Vec::new();
        let mut unsupported = Vec::new();
        let mut glyphs = BTreeMap::new();
        for (index, character) in characters.into_iter().enumerate() {
            if requires_shaping(character) || character.is_control() {
                unsupported.push(character);
                continue;
            }
            match face.glyph_index(character).filter(|glyph| glyph.0 != 0) {
                Some(gid) => {
                    let width = face.glyph_hor_advance(gid).ok_or_else(|| {
                        Error::new("hetu.integrity_failure", "PDF 字体字形缺少宽度。")
                    })?;
                    glyphs.insert(
                        character,
                        Glyph {
                            cid: (index + 1) as u16,
                            gid: gid.0,
                            width: f32::from(width) / f32::from(face.units_per_em()),
                        },
                    );
                }
                None => missing.push(character),
            }
        }
        if !missing.is_empty() || !unsupported.is_empty() {
            let describe = |characters: &[char]| {
                characters
                    .iter()
                    .take(12)
                    .map(|character| format!("U+{:04X}", *character as u32))
                    .collect::<Vec<_>>()
                    .join("、")
            };
            return Err(Error::new(
                "hetu.format_unrepresentable",
                format!(
                    "PDF 字体缺字 {} 个 [{}]，需复杂塑形或控制处理的字符 {} 个 [{}]；请更换文字或交付格式，未生成缺字文件。",
                    missing.len(),
                    describe(&missing),
                    unsupported.len(),
                    describe(&unsupported)
                ),
            ));
        }
        Ok(Self { face, glyphs })
    }

    fn width(&self, character: char, size: f32) -> f32 {
        self.glyphs[&character].width * size
    }

    fn text_width(&self, text: &str, size: f32) -> f32 {
        text.chars()
            .map(|character| self.width(character, size))
            .sum()
    }

    fn ascender(&self, text: &str, size: f32) -> f32 {
        let top = text
            .chars()
            .filter_map(|character| {
                self.face
                    .glyph_bounding_box(GlyphId(self.glyphs[&character].gid))
            })
            .map(|bounds| bounds.y_max)
            .max()
            .unwrap_or(0)
            .max(self.face.ascender());
        f32::from(top) * size / f32::from(self.face.units_per_em())
    }
}

// 当前模板支持横排中文及无需上下文塑形的字符；无法可靠表现时显式拒绝。
fn requires_shaping(character: char) -> bool {
    matches!(character as u32,
        0x0300..=0x036f | 0x0590..=0x109f | 0x1100..=0x11ff |
        0x1780..=0x18af | 0x1ab0..=0x1aff | 0x1dc0..=0x1dff |
        0x200b..=0x200f | 0x202a..=0x202e | 0x2060..=0x206f |
        0x20d0..=0x20ff | 0xa960..=0xa97f | 0xd7b0..=0xd7ff |
        0xfb1d..=0xfdff | 0xfe00..=0xfe0f | 0xfe20..=0xfe2f |
        0xfe70..=0xfeff | 0xe0100..=0xe01ef)
}

fn style(kind: &ParagraphStyle, profile: &str) -> Style {
    let screenplay = profile == "hetu-screenplay-zh/1";
    let mut style = Style {
        size: if screenplay { 11.5 } else { 12.0 },
        leading: if screenplay { 21.0 } else { 22.0 },
        left: MARGIN,
        right: PAGE_WIDTH - MARGIN,
        indent: 0.0,
        before: 0.0,
        after: 6.0,
        alignment: Alignment::Left,
        keep_next: false,
        page_break_before: false,
    };
    match kind {
        ParagraphStyle::Title => {
            style.size = 22.0;
            style.leading = 34.0;
            style.after = 14.0;
            style.alignment = Alignment::Center;
            style.keep_next = true;
            style.page_break_before = true;
        }
        ParagraphStyle::Author => {
            style.size = 11.0;
            style.leading = 21.0;
            style.after = 18.0;
            style.alignment = Alignment::Center;
            style.keep_next = true;
        }
        ParagraphStyle::Heading1 | ParagraphStyle::Heading2 => {
            style.size = if matches!(kind, ParagraphStyle::Heading1) {
                16.0
            } else {
                14.0
            };
            style.leading = 28.0;
            style.before = 12.0;
            style.after = 8.0;
            style.keep_next = true;
        }
        ParagraphStyle::Body if !screenplay => style.indent = 24.0,
        ParagraphStyle::Scene => {
            style.before = 10.0;
            style.after = 8.0;
            style.keep_next = true;
        }
        ParagraphStyle::Character => {
            style.left = 132.0;
            style.right = PAGE_WIDTH - 132.0;
            style.alignment = Alignment::Center;
            style.before = 6.0;
            style.after = 0.0;
            style.keep_next = true;
        }
        ParagraphStyle::Dialogue | ParagraphStyle::Parenthetical => {
            style.left = 120.0;
            style.right = PAGE_WIDTH - 120.0;
            if matches!(kind, ParagraphStyle::Parenthetical) {
                style.size = 10.5;
                style.after = 0.0;
                style.keep_next = true;
            }
        }
        ParagraphStyle::Transition => style.alignment = Alignment::Right,
        ParagraphStyle::Separator => style.alignment = Alignment::Center,
        _ => {}
    }
    style
}

fn no_line_start(character: char) -> bool {
    "，。！？；：、）》」』】〕〉〗〙〛’”～…,.!?;:%)]}".contains(character)
}

fn no_line_end(character: char) -> bool {
    "（《「『【〔〈〖〘〚‘“([{ ".contains(character) && character != ' '
}

fn cjk(character: char) -> bool {
    matches!(character as u32, 0x2e80..=0xa4cf | 0xac00..=0xd7af | 0xf900..=0xfaff | 0x20000..=0x323af)
}

fn allowed_break(left: char, right: char) -> bool {
    !no_line_end(left)
        && !no_line_start(right)
        && (left == ' ' || left == '-' || left == '/' || cjk(left) || cjk(right))
}

fn wrap(text: &str, style: Style, font: &Font<'_>) -> Result<(Vec<Line>, usize)> {
    let mut lines = Vec::new();
    let mut forced = 0;
    for segment in text.split('\n') {
        let characters: Vec<char> = segment.chars().collect();
        if characters.is_empty() {
            lines.push(Line {
                text: String::new(),
                width: 0.0,
                indent: 0.0,
            });
            continue;
        }
        let mut start = 0;
        while start < characters.len() {
            let indent = if lines.is_empty() { style.indent } else { 0.0 };
            let available = style.right - style.left - indent;
            let mut width = 0.0;
            let mut end = start;
            let mut legal = None;
            while end < characters.len() {
                let next_width = font.width(characters[end], style.size);
                if width + next_width > available + 0.001 {
                    break;
                }
                width += next_width;
                end += 1;
                if end < characters.len() && allowed_break(characters[end - 1], characters[end]) {
                    legal = Some(end);
                }
            }
            ensure(
                end > start,
                "hetu.format_unrepresentable",
                "PDF 字形超出版心。",
            )?;
            if end < characters.len() {
                if let Some(boundary) = legal {
                    end = boundary;
                } else {
                    // 超长连续词可以按字形拆行，但仍遵守基本中文标点禁则。
                    while end > start
                        && (no_line_end(characters[end - 1]) || no_line_start(characters[end]))
                    {
                        end -= 1;
                    }
                    ensure(
                        end > start,
                        "hetu.format_unrepresentable",
                        "连续标点无法在 PDF 版心中安全换行。",
                    )?;
                    forced += 1;
                }
            }
            let text: String = characters[start..end].iter().collect();
            lines.push(Line {
                width: font.text_width(&text, style.size),
                text,
                indent,
            });
            start = end;
        }
    }
    Ok((lines, forced))
}

fn paginate(blocks: &[Block], font: &Font<'_>) -> Result<Vec<Page>> {
    // 从后往前计算必须与后文同页的最小链：人物名、括注与至少两行对白。
    let mut prefixes = vec![0.0; blocks.len()];
    for index in (0..blocks.len()).rev() {
        let block = &blocks[index];
        let height = block.lines.len() as f32 * block.style.leading;
        prefixes[index] = if block.style.keep_next {
            let next = blocks
                .get(index + 1)
                .map(|next| block.style.after + next.style.before + prefixes[index + 1])
                .unwrap_or(0.0);
            height + next
        } else {
            block.lines.len().min(2) as f32 * block.style.leading
        };
        ensure(
            prefixes[index] <= BOTTOM - MARGIN,
            "hetu.format_unrepresentable",
            "PDF 标题或人物对白关联段落超过整页，无法保持同页。",
        )?;
    }
    let mut pages = vec![Page::default()];
    let mut cursor = MARGIN;
    for (index, block) in blocks.iter().enumerate() {
        // 与 DOCX 的 Title 段前分页一致；首篇不产生空白页。
        if block.style.page_break_before && pages.last().is_some_and(|page| !page.lines.is_empty())
        {
            new_page(&mut pages)?;
            cursor = MARGIN;
        }
        let before = if pages.last().is_some_and(|page| !page.lines.is_empty()) {
            block.style.before
        } else {
            0.0
        };
        if cursor + before + prefixes[index] > BOTTOM + 0.001 {
            new_page(&mut pages)?;
            cursor = MARGIN;
        } else {
            cursor += before;
        }
        let mut first = 0;
        while first < block.lines.len() {
            let remaining = block.lines.len() - first;
            let mut capacity = ((BOTTOM - cursor + 0.001) / block.style.leading).floor() as usize;
            if capacity == 0 || (remaining >= 2 && capacity == 1) {
                new_page(&mut pages)?;
                cursor = MARGIN;
                continue;
            }
            if remaining > capacity && remaining - capacity == 1 && capacity >= 2 {
                capacity -= 1;
            }
            let count = remaining.min(capacity);
            for line in &block.lines[first..first + count] {
                let x = match block.style.alignment {
                    Alignment::Left => block.style.left + line.indent,
                    Alignment::Center => (block.style.left + block.style.right - line.width) / 2.0,
                    Alignment::Right => block.style.right - line.width,
                };
                let ascent = font.ascender(&line.text, block.style.size);
                // 字体墨迹不能越过当前行框；异常字形拒绝而不是裁切。
                let descent = line
                    .text
                    .chars()
                    .filter_map(|character| {
                        font.face
                            .glyph_bounding_box(GlyphId(font.glyphs[&character].gid))
                    })
                    .map(|bounds| bounds.y_min)
                    .min()
                    .unwrap_or(0)
                    .min(0);
                let ink_height = ascent
                    - f32::from(descent) * block.style.size / f32::from(font.face.units_per_em());
                ensure(
                    ink_height <= block.style.leading + 0.001,
                    "hetu.format_unrepresentable",
                    "PDF 字形高度超过模板行框。",
                )?;
                pages
                    .last_mut()
                    .expect("始终有当前页")
                    .lines
                    .push(PlacedLine {
                        text: line.text.clone(),
                        x,
                        baseline: PAGE_HEIGHT - cursor - ascent,
                        size: block.style.size,
                    });
                cursor += block.style.leading;
            }
            first += count;
            if first < block.lines.len() {
                new_page(&mut pages)?;
                cursor = MARGIN;
            }
        }
        cursor += block.style.after;
    }
    Ok(pages)
}

fn new_page(pages: &mut Vec<Page>) -> Result<()> {
    ensure(
        pages.len() < MAX_PAGES,
        "hetu.budget_exceeded",
        "PDF 超过两千页上限。",
    )?;
    pages.push(Page::default());
    Ok(())
}

fn write_pdf(pages: &[Page], font: &Font<'_>, title: &str, author: &str) -> Result<Vec<u8>> {
    let mut remapper = GlyphRemapper::new();
    for glyph in font.glyphs.values() {
        remapper.remap(glyph.gid);
    }
    let subset = subsetter::subset(FONT, 0, &remapper)
        .map_err(|_| Error::new("hetu.integrity_failure", "PDF 字体子集生成失败。"))?;
    let prefix: String = digest(&subset)
        .bytes()
        .take(6)
        .map(|byte| char::from(b'A' + byte % 26))
        .collect();
    let base_name = format!("{prefix}+HetuExportSansSC-Regular");
    let font_name = Name(base_name.as_bytes());
    let catalog_id = Ref::new(1);
    let pages_id = Ref::new(2);
    let font_id = Ref::new(3);
    let cid_id = Ref::new(4);
    let descriptor_id = Ref::new(5);
    let file_id = Ref::new(6);
    let unicode_id = Ref::new(7);
    let gid_map_id = Ref::new(8);
    let info_id = Ref::new(9);
    let system_info = SystemInfo {
        registry: Str(b"Adobe"),
        ordering: Str(b"Identity"),
        supplement: 0,
    };
    let mut pdf = Pdf::new();
    pdf.catalog(catalog_id)
        .pages(pages_id)
        .lang(TextStr("zh-CN"));
    let page_ids: Vec<_> = (0..pages.len())
        .map(|index| Ref::new(10 + index as i32 * 2))
        .collect();
    pdf.pages(pages_id)
        .kids(page_ids.iter().copied())
        .count(pages.len() as i32);
    let mut info = pdf.document_info(info_id);
    info.creator(TextStr("河图洛书"))
        .producer(TextStr("hetu-pdf-layout/1"));
    info.title(TextStr(title)).author(TextStr(author));
    info.finish();
    pdf.type0_font(font_id)
        .base_font(font_name)
        .encoding_predefined(Name(b"Identity-H"))
        .descendant_font(cid_id)
        .to_unicode(unicode_id);
    let mut cid = pdf.cid_font(cid_id);
    cid.subtype(CidFontType::Type2)
        .base_font(font_name)
        .system_info(system_info)
        .font_descriptor(descriptor_id)
        .cid_to_gid_map_stream(gid_map_id)
        .default_width(1000.0);
    let mut widths = vec![0.0; font.glyphs.len() + 1];
    let mut glyph_map = vec![0u8; (font.glyphs.len() + 1) * 2];
    let mut unicode = UnicodeCmap::new(Name(b"HetuUnicode"), system_info);
    for (&character, glyph) in &font.glyphs {
        widths[usize::from(glyph.cid)] = glyph.width * 1000.0;
        let mapped = remapper
            .get(glyph.gid)
            .ok_or_else(|| Error::new("hetu.integrity_failure", "PDF 字形映射缺失。"))?;
        let offset = usize::from(glyph.cid) * 2;
        glyph_map[offset..offset + 2].copy_from_slice(&mapped.to_be_bytes());
        unicode.pair(glyph.cid, character);
    }
    cid.widths().consecutive(0, widths);
    cid.finish();
    let scale = 1000.0 / f32::from(font.face.units_per_em());
    let bounds = font.face.global_bounding_box();
    pdf.font_descriptor(descriptor_id)
        .name(font_name)
        .flags(FontFlags::SYMBOLIC)
        .bbox(Rect::new(
            f32::from(bounds.x_min) * scale,
            f32::from(bounds.y_min) * scale,
            f32::from(bounds.x_max) * scale,
            f32::from(bounds.y_max) * scale,
        ))
        .italic_angle(0.0)
        .ascent(f32::from(font.face.ascender()) * scale)
        .descent(f32::from(font.face.descender()) * scale)
        .cap_height(f32::from(font.face.capital_height().unwrap_or(font.face.ascender())) * scale)
        .stem_v(80.0)
        .font_file2(file_id);
    pdf.stream(file_id, &subset)
        .pair(Name(b"Length1"), subset.len() as i32);
    pdf.stream(unicode_id, &unicode.finish());
    pdf.stream(gid_map_id, &glyph_map);
    for (index, page) in pages.iter().enumerate() {
        let content_id = Ref::new(page_ids[index].get() + 1);
        let mut writer = pdf.page(page_ids[index]);
        writer
            .parent(pages_id)
            .media_box(Rect::new(0.0, 0.0, PAGE_WIDTH, PAGE_HEIGHT))
            .contents(content_id);
        writer.resources().fonts().pair(Name(b"F1"), font_id);
        writer.finish();
        let mut content = Content::new();
        content.set_fill_gray(0.0);
        content.begin_text();
        for line in &page.lines {
            show_line(&mut content, font, line);
        }
        let footer = (index + 1).to_string();
        content.set_fill_gray(0.4);
        show_line(
            &mut content,
            font,
            &PlacedLine {
                x: (PAGE_WIDTH - font.text_width(&footer, 9.0)) / 2.0,
                baseline: 31.0,
                text: footer,
                size: 9.0,
            },
        );
        content.end_text();
        pdf.stream(content_id, &content.finish());
    }
    Ok(pdf.finish())
}

fn show_line(content: &mut Content, font: &Font<'_>, line: &PlacedLine) {
    if line.text.is_empty() {
        return;
    }
    let bytes: Vec<u8> = line
        .text
        .chars()
        .flat_map(|character| font.glyphs[&character].cid.to_be_bytes())
        .collect();
    content
        .set_font(Name(b"F1"), line.size)
        .set_text_matrix([1.0, 0.0, 0.0, 1.0, line.x, line.baseline])
        .show(Str(&bytes));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(text: &str) -> Source {
        Source {
            title: "雪线以北".into(),
            author: "演示作者".into(),
            kind: "novel_chapter".into(),
            source_format: "markdown".into(),
            language_tag: "zh-CN".into(),
            content: text.into(),
        }
    }

    #[test]
    fn chinese_pdf_has_embedded_subset_and_unicode_mapping() {
        let result = render(
            &[sample("# 第一章 初雪\n\n雪落在窗台。Hello, world! 2026。")],
            "hetu-novel-zh/1",
        )
        .unwrap();
        assert!(result.bytes.starts_with(b"%PDF-"));
        let raw = String::from_utf8_lossy(&result.bytes);
        assert!(raw.contains("/FontFile2"));
        assert!(raw.contains("/ToUnicode"));
        assert_eq!(result.report["page_count"], 1);
        assert!(result.bytes.len() < FONT.len() / 4);
    }

    #[test]
    fn each_selected_chapter_starts_on_a_new_page_without_blank_pages() {
        let sources = ["第一章 渡口", "第二章 灯火", "第三章 归途"]
            .into_iter()
            .map(|title| {
                let mut source = sample("船靠了岸。\n\n他提灯走向渡口。");
                source.title = title.into();
                source
            })
            .collect::<Vec<_>>();
        let result = render(&sources, "hetu-novel-zh/1").unwrap();
        assert_eq!(result.report["page_count"], 3);

        let (paragraphs, _) = paragraphs(&sources).unwrap();
        let font = Font::new(&paragraphs).unwrap();
        let blocks = paragraphs
            .iter()
            .map(|paragraph| {
                let style = style(&paragraph.style, "hetu-novel-zh/1");
                Block {
                    lines: wrap(&paragraph.text, style, &font).unwrap().0,
                    style,
                }
            })
            .collect::<Vec<_>>();
        let pages = paginate(&blocks, &font).unwrap();
        for (page, source) in pages.iter().zip(&sources) {
            assert_eq!(page.lines.first().unwrap().text, source.title);
            assert!(
                page.lines
                    .iter()
                    .any(|line| line.text == "他提灯走向渡口。")
            );
        }
    }

    #[test]
    fn missing_glyph_and_unshaped_text_are_explicit_errors() {
        for text in [
            "缺字：\u{10ffff}",
            "组合字母：e\u{0301}",
            "字形变体：木\u{fe00}",
        ] {
            let error = render(&[sample(text)], "hetu-novel-zh/1").err().unwrap();
            assert_eq!(error.code, "hetu.format_unrepresentable");
            assert!(error.message.contains("U+"));
        }
    }

    #[test]
    fn chinese_lines_obey_width_and_basic_punctuation_rules() {
        let paragraphs = vec![Paragraph {
            style: ParagraphStyle::Body,
            text: "“风停了，”她说，“我们走吧。”山道转过河岸，雪光映亮了远处的石桥。".repeat(10),
            runs: vec![],
        }];
        let font = Font::new(&paragraphs).unwrap();
        let style = style(&ParagraphStyle::Body, "hetu-novel-zh/1");
        let (lines, _) = wrap(&paragraphs[0].text, style, &font).unwrap();
        assert!(lines.len() > 3);
        assert_eq!(
            lines
                .iter()
                .map(|line| line.text.as_str())
                .collect::<String>(),
            paragraphs[0].text
        );
        for line in lines {
            assert!(line.width + line.indent <= style.right - style.left + 0.001);
            assert!(!no_line_start(line.text.chars().next().unwrap()));
            assert!(!no_line_end(line.text.chars().last().unwrap()));
        }
    }

    #[test]
    fn character_and_first_dialogue_lines_stay_on_same_page() {
        let mut paragraphs = vec![Paragraph {
            style: ParagraphStyle::Body,
            text: "山道尽头是一座石桥。".into(),
            runs: vec![],
        }];
        paragraphs.push(Paragraph {
            style: ParagraphStyle::Character,
            text: "林遥".into(),
            runs: vec![],
        });
        paragraphs.push(Paragraph {
            style: ParagraphStyle::Parenthetical,
            text: "（压低声音）".into(),
            runs: vec![],
        });
        paragraphs.push(Paragraph {
            style: ParagraphStyle::Dialogue,
            text: "等一等，桥上有人。我们必须先确认来者身份。".repeat(70),
            runs: vec![],
        });
        let font = Font::new(&paragraphs).unwrap();
        // 先用等高段落填到页底，覆盖人物与对白即将分离的分页点。
        let mut blocks = (0..29)
            .map(|_| {
                let style = style(&ParagraphStyle::Body, "hetu-screenplay-zh/1");
                Block {
                    lines: wrap(&paragraphs[0].text, style, &font).unwrap().0,
                    style,
                }
            })
            .collect::<Vec<_>>();
        blocks.extend(paragraphs[1..].iter().map(|paragraph| {
            let style = style(&paragraph.style, "hetu-screenplay-zh/1");
            Block {
                lines: wrap(&paragraph.text, style, &font).unwrap().0,
                style,
            }
        }));
        let pages = paginate(&blocks, &font).unwrap();
        assert!(pages.len() > 2);
        let page = pages
            .iter()
            .find(|page| page.lines.iter().any(|line| line.text == "林遥"))
            .unwrap();
        assert!(
            page.lines
                .iter()
                .any(|line| line.text.starts_with("等一等"))
        );
        assert!(
            pages
                .iter()
                .flat_map(|page| &page.lines)
                .all(|line| line.baseline > MARGIN)
        );
    }

    #[test]
    fn input_budget_is_enforced_before_layout() {
        let error = render(&[sample(&"字".repeat(MAX_CHARS + 1))], "hetu-novel-zh/1")
            .err()
            .unwrap();
        assert_eq!(error.code, "hetu.budget_exceeded");
    }

    #[test]
    fn inline_emphasis_downgrade_is_disclosed_before_author_acceptance() {
        let result = render(
            &[sample("正文含有**重要决定**与*低声旁白*。")],
            "hetu-novel-zh/1",
        )
        .unwrap();
        assert_eq!(result.report["confirmation_required"], true);
        assert!(
            result.report["losses"]
                .as_array()
                .unwrap()
                .iter()
                .any(|loss| loss["code"] == "pdf_inline_emphasis_flattened")
        );
    }
}
