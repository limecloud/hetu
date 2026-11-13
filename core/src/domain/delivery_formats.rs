//! 版本化交稿子集。格式转换不读写工作区，也不执行文档中的活动内容。
use super::{Error, Result, digest, ensure};
use pulldown_cmark::{Event as MarkdownEvent, Options, Parser, Tag, TagEnd};
use quick_xml::{NsReader, events::Event, name::ResolveResult};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read, Write};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

pub const CONVERTER: &str = "hetu-delivery-formats/1";
pub(crate) const TEXT_LIMIT: usize = 16 * 1024 * 1024;
const PACKAGE_LIMIT: usize = 32 * 1024 * 1024;
const WORD_NS: &[u8] = b"http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const PACKAGE_RELS_NS: &[u8] = b"http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS: &[u8] = b"http://schemas.openxmlformats.org/package/2006/content-types";

#[derive(Clone, Debug)]
pub struct Source {
    pub title: String,
    pub author: String,
    pub kind: String,
    pub source_format: String,
    pub language_tag: String,
    pub content: String,
}

pub struct Converted {
    pub bytes: Vec<u8>,
    pub media_type: &'static str,
    pub extension: &'static str,
    pub report: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParagraphStyle {
    Title,
    Author,
    Heading1,
    Heading2,
    Body,
    Scene,
    Character,
    Dialogue,
    Parenthetical,
    Transition,
    Separator,
}

impl ParagraphStyle {
    fn word(self) -> &'static str {
        match self {
            Self::Title => "HetuTitle",
            Self::Author => "HetuAuthor",
            Self::Heading1 => "Heading1",
            Self::Heading2 => "Heading2",
            Self::Body => "Normal",
            Self::Scene => "HetuScene",
            Self::Character => "HetuCharacter",
            Self::Dialogue => "HetuDialogue",
            Self::Parenthetical => "HetuParenthetical",
            Self::Transition => "HetuTransition",
            Self::Separator => "HetuSeparator",
        }
    }
    fn from_word(value: &str) -> Option<Self> {
        Some(match value {
            "Title" | "HetuTitle" => Self::Title,
            "Subtitle" | "HetuAuthor" => Self::Author,
            "Heading1" | "Heading 1" => Self::Heading1,
            "Heading2" | "Heading 2" => Self::Heading2,
            "Normal" | "BodyText" | "Body Text" | "" => Self::Body,
            "HetuScene" => Self::Scene,
            "HetuCharacter" => Self::Character,
            "HetuDialogue" => Self::Dialogue,
            "HetuParenthetical" => Self::Parenthetical,
            "HetuTransition" => Self::Transition,
            "HetuSeparator" => Self::Separator,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug)]
pub struct Run {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
}

#[derive(Clone, Debug)]
pub struct Paragraph {
    pub style: ParagraphStyle,
    pub text: String,
    pub runs: Vec<Run>,
}

impl Paragraph {
    fn plain(style: ParagraphStyle, text: impl Into<String>) -> Self {
        let text = text.into();
        Self {
            style,
            runs: vec![Run {
                text: text.clone(),
                bold: false,
                italic: false,
            }],
            text,
        }
    }
    fn push(&mut self, text: &str, bold: bool, italic: bool) {
        self.text.push_str(text);
        if let Some(last) = self
            .runs
            .last_mut()
            .filter(|run| run.bold == bold && run.italic == italic)
        {
            last.text.push_str(text);
        } else {
            self.runs.push(Run {
                text: text.to_owned(),
                bold,
                italic,
            });
        }
    }
}

fn problem(code: &str, message: &str) -> Value {
    json!({"code":code,"message":message})
}
fn issue(list: &mut Vec<Value>, code: &str, message: &str) {
    if !list.iter().any(|item| item["code"] == code) {
        list.push(problem(code, message));
    }
}
fn format_error(message: &str) -> Error {
    Error::new("hetu.format_unrepresentable", message)
}
fn package_error() -> Error {
    Error::new(
        "hetu.invalid_document_package",
        "DOCX 包结构损坏或包含不支持的活动内容。",
    )
}
fn valid_profile(profile: &str) -> Result<()> {
    ensure(
        matches!(
            profile,
            "source/1" | "hetu-novel-zh/1" | "hetu-screenplay-zh/1"
        ),
        "hetu.unsupported_delivery_profile",
        "交稿模板版本不受支持。",
    )
}
fn valid_text(text: &str) -> Result<()> {
    ensure(
        text.len() <= TEXT_LIMIT,
        "hetu.budget_exceeded",
        "单次格式转换正文超过 16 MiB。",
    )?;
    ensure(
        !text.chars().any(|c| {
            (c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
                || matches!(c, '\u{fffe}' | '\u{ffff}')
        }),
        "invalid_input",
        "正文包含不能安全交换的控制字符。",
    )
}

fn printed_markdown(input: &str, losses: &mut Vec<Value>) -> Result<String> {
    let mut output = String::new();
    let mut cursor = 0;
    let mut spans: Vec<std::ops::Range<usize>> = Vec::new();
    // 只移除解析器识别的注释，代码示例中的注释字样仍是可见正文。
    for (event, range) in Parser::new(input).into_offset_iter() {
        if matches!(event, MarkdownEvent::Html(_) | MarkdownEvent::InlineHtml(_)) {
            // pulldown-cmark 将块级 HTML 逐行返回，先合并才判断多行注释是否闭合。
            if let Some(previous) = spans
                .last_mut()
                .filter(|previous| previous.end == range.start)
            {
                previous.end = range.end;
            } else {
                spans.push(range);
            }
        }
    }
    for range in spans {
        let mut rest = &input[range.clone()];
        while !rest.trim().is_empty() {
            rest = rest.trim_start();
            ensure(
                rest.starts_with("<!--"),
                "hetu.format_unrepresentable",
                "当前交稿子集不支持原始 HTML，请先将 HTML 转成可见正文；HTML 和脚本不会执行。",
            )?;
            let end = rest[4..]
                .find("-->")
                .ok_or_else(|| format_error("Markdown 隐藏注释未闭合。"))?;
            rest = &rest[4 + end + 3..];
        }
        output.push_str(&input[cursor..range.start]);
        for _ in input[range.clone()].chars().filter(|c| *c == '\n') {
            output.push('\n');
        }
        cursor = range.end;
        issue(
            losses,
            "markdown_hidden_notes_removed",
            "Markdown 隐藏注释未进入交稿正文。",
        );
    }
    output.push_str(&input[cursor..]);
    Ok(output)
}

/// 从显示文本移除 Fountain 的非打印注释；不接受未闭合注释后猜测剩余正文。
fn printed_fountain(input: &str, losses: &mut Vec<Value>) -> Result<String> {
    let mut output = String::new();
    let mut cursor = 0;
    while cursor < input.len() {
        let rest = &input[cursor..];
        let next = [
            rest.find("/*").map(|p| (p, "/*", "*/")),
            rest.find("[[").map(|p| (p, "[[", "]]")),
        ]
        .into_iter()
        .flatten()
        .min_by_key(|item| item.0);
        let Some((offset, opening, closing)) = next else {
            output.push_str(rest);
            break;
        };
        output.push_str(&rest[..offset]);
        let start = cursor + offset + opening.len();
        let end = input[start..]
            .find(closing)
            .ok_or_else(|| format_error("Fountain 注释未闭合，请先核对原稿。"))?;
        // 保留行边界，防止注释移除把人物名与上一段拼接。
        for _ in input[start..start + end].chars().filter(|c| *c == '\n') {
            output.push('\n');
        }
        cursor = start + end + closing.len();
        issue(
            losses,
            "fountain_nonprinting_removed",
            "Fountain 注释、便笺与非打印材料未进入交稿正文。",
        );
    }
    Ok(output)
}

fn markdown_paragraphs(content: &str, losses: &mut Vec<Value>) -> Result<Vec<Paragraph>> {
    let content = printed_markdown(content, losses)?;
    let mut output = Vec::new();
    let mut current: Option<Paragraph> = None;
    let mut bold = 0;
    let mut italic = 0;
    let mut image = 0;
    let mut link = Vec::new();
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_FOOTNOTES | Options::ENABLE_STRIKETHROUGH;
    for event in Parser::new_ext(&content, options) {
        match event {
            MarkdownEvent::Start(Tag::Paragraph) => {
                current.get_or_insert_with(|| Paragraph::plain(ParagraphStyle::Body, ""));
            }
            MarkdownEvent::Start(Tag::Heading { level, .. }) => {
                current = Some(Paragraph::plain(
                    if level as usize <= 1 {
                        ParagraphStyle::Heading1
                    } else {
                        ParagraphStyle::Heading2
                    },
                    "",
                ));
                if level as usize > 2 {
                    issue(
                        losses,
                        "heading_depth_flattened",
                        "三级及更深标题映射为二级交稿标题。",
                    );
                }
            }
            MarkdownEvent::End(TagEnd::Paragraph | TagEnd::Heading(_)) => {
                if let Some(paragraph) = current.take() {
                    output.push(paragraph);
                }
            }
            MarkdownEvent::Start(Tag::Strong) => bold += 1,
            MarkdownEvent::End(TagEnd::Strong) => bold -= 1,
            MarkdownEvent::Start(Tag::Emphasis) => italic += 1,
            MarkdownEvent::End(TagEnd::Emphasis) => italic -= 1,
            MarkdownEvent::Start(Tag::Image { .. }) => {
                image += 1;
                issue(
                    losses,
                    "markdown_image_omitted",
                    "正文中的图片未嵌入交稿文件；素材须从交付选择中明确加入。",
                );
            }
            MarkdownEvent::End(TagEnd::Image) => image -= 1,
            MarkdownEvent::Start(Tag::Link { dest_url, .. }) if image == 0 => {
                ensure(
                    dest_url.starts_with("https://")
                        || dest_url.starts_with("http://")
                        || dest_url.starts_with('#'),
                    "hetu.format_unrepresentable",
                    "正文链接必须是公开 HTTP(S) 或篇内链接，不接受本机路径和活动链接。",
                )?;
                if !dest_url.starts_with('#') {
                    let url = url::Url::parse(&dest_url)
                        .map_err(|_| format_error("正文链接地址无效。"))?;
                    ensure(
                        url.username().is_empty()
                            && url.password().is_none()
                            && url.query().is_none(),
                        "hetu.format_unrepresentable",
                        "交稿链接不能含凭据或私有查询参数。",
                    )?;
                }
                link.push(dest_url.into_string());
            }
            MarkdownEvent::End(TagEnd::Link) if image == 0 => {
                if let Some(url) = link.pop() {
                    current
                        .get_or_insert_with(|| Paragraph::plain(ParagraphStyle::Body, ""))
                        .push(&format!(" ({url})"), false, false);
                }
            }
            MarkdownEvent::Text(text) if image == 0 => current
                .get_or_insert_with(|| Paragraph::plain(ParagraphStyle::Body, ""))
                .push(&text, bold > 0, italic > 0),
            MarkdownEvent::Code(text) if image == 0 => {
                current
                    .get_or_insert_with(|| Paragraph::plain(ParagraphStyle::Body, ""))
                    .push(&text, false, false);
                issue(
                    losses,
                    "markdown_code_plaintext",
                    "行内代码按文字交付，不保留代码字体。",
                );
            }
            MarkdownEvent::SoftBreak | MarkdownEvent::HardBreak if image == 0 => current
                .get_or_insert_with(|| Paragraph::plain(ParagraphStyle::Body, ""))
                .push("\n", bold > 0, italic > 0),
            MarkdownEvent::Rule => {
                output.push(Paragraph::plain(ParagraphStyle::Separator, "* * *"))
            }
            MarkdownEvent::Start(Tag::Table(_)) => issue(
                losses,
                "markdown_table_flattened",
                "表格按单元格文字投影，表格结构不保留。",
            ),
            MarkdownEvent::Start(Tag::CodeBlock(_)) => issue(
                losses,
                "markdown_codeblock_plaintext",
                "代码块按普通文字交付，不保留代码版式。",
            ),
            MarkdownEvent::End(TagEnd::CodeBlock) => {
                if let Some(paragraph) = current.take() {
                    output.push(paragraph);
                }
            }
            MarkdownEvent::Start(Tag::Item) => {
                if let Some(paragraph) = current.take() {
                    output.push(paragraph);
                }
                current = Some(Paragraph::plain(ParagraphStyle::Body, "• "));
                issue(
                    losses,
                    "markdown_list_plaintext",
                    "列表按带标记的正文交付，编号及层级不保留。",
                );
            }
            MarkdownEvent::End(TagEnd::Item | TagEnd::TableCell) => {
                if let Some(paragraph) = current.take() {
                    output.push(paragraph);
                }
            }
            MarkdownEvent::FootnoteReference(_)
            | MarkdownEvent::Start(Tag::FootnoteDefinition(_)) => issue(
                losses,
                "markdown_footnotes_unlinked",
                "脚注与正文关联不保留，请在预览中核对脚注文字。",
            ),
            MarkdownEvent::Start(Tag::BlockQuote(_)) => issue(
                losses,
                "markdown_blockquote_plaintext",
                "引用块按普通正文交付，不保留引用块版式。",
            ),
            MarkdownEvent::Start(Tag::Strikethrough) => issue(
                losses,
                "markdown_strikethrough_plaintext",
                "删除线按可见文字交付，不据此删除内容。",
            ),
            _ => {}
        }
    }
    if let Some(paragraph) = current {
        output.push(paragraph);
    }
    Ok(output)
}

fn fountain_paragraphs(content: &str, losses: &mut Vec<Value>) -> Result<Vec<Paragraph>> {
    let content = printed_fountain(content, losses)?;
    let mut output: Vec<Paragraph> = Vec::new();
    let mut dialogue = false;
    let mut title_field = None;
    let mut title_page = content.lines().next().is_some_and(|line| {
        line.split_once(':')
            .is_some_and(|(key, _)| key.trim().eq_ignore_ascii_case("Title"))
    });
    let lines: Vec<_> = content.lines().collect();
    for (index, raw) in lines.iter().enumerate() {
        let line = raw.trim_end_matches('\r');
        if title_page {
            if line.trim().is_empty() {
                title_page = false;
                title_field = None;
            } else if line.starts_with([' ', '\t']) && title_field.is_some() {
                let index: usize = title_field.unwrap();
                let text = format!("{}\n{}", output[index].text, line.trim());
                output[index] =
                    Paragraph::plain(output[index].style, text.trim_start_matches('\n'));
            } else if let Some((key, value)) = line.split_once(':') {
                let style = match key.trim().to_ascii_lowercase().as_str() {
                    "title" => Some(ParagraphStyle::Title),
                    "author" => Some(ParagraphStyle::Author),
                    _ => None,
                };
                title_field = if let Some(style) = style {
                    output.push(Paragraph::plain(style, value.trim()));
                    Some(output.len() - 1)
                } else {
                    issue(
                        losses,
                        "fountain_title_metadata_omitted",
                        "除作品标题与作者署名外的 Fountain 标题页字段未进入阅读稿。",
                    );
                    None
                };
            } else {
                issue(
                    losses,
                    "fountain_title_metadata_omitted",
                    "除作品标题与作者署名外的 Fountain 标题页字段未进入阅读稿。",
                );
            }
            continue;
        }
        if line.trim().is_empty() {
            dialogue = false;
            continue;
        }
        let trimmed = line.trim();
        let uppercase = trimmed.chars().any(|c| c.is_ascii_alphabetic())
            && trimmed.chars().all(|c| !c.is_ascii_lowercase());
        let style;
        let displayed;
        if trimmed.starts_with('#') {
            style = if trimmed.starts_with("##") {
                ParagraphStyle::Heading2
            } else {
                ParagraphStyle::Heading1
            };
            displayed = trimmed.trim_start_matches('#').trim().to_owned();
            dialogue = false;
        } else if trimmed.starts_with('=') {
            issue(
                losses,
                "fountain_synopsis_omitted",
                "Fountain 非打印梗概未进入交稿正文。",
            );
            continue;
        } else if trimmed.starts_with("INT.")
            || trimmed.starts_with("EXT.")
            || trimmed.starts_with("INT./EXT.")
            || trimmed.starts_with("I/E.")
            || trimmed.starts_with("EST.")
            || (trimmed.starts_with('.') && !trimmed.starts_with(".."))
        {
            style = ParagraphStyle::Scene;
            displayed = trimmed.strip_prefix('.').unwrap_or(trimmed).to_owned();
            dialogue = false;
            if trimmed.starts_with('.') {
                issue(
                    losses,
                    "fountain_scene_requires_review",
                    "强制场景标题可能缺少内外景或日夜，正式制片交付前需要作者核对。",
                );
            }
        } else if trimmed.starts_with('>') || uppercase && trimmed.ends_with("TO:") {
            style = if trimmed.ends_with('<') {
                ParagraphStyle::Body
            } else {
                ParagraphStyle::Transition
            };
            displayed = trimmed
                .trim_start_matches('>')
                .trim_end_matches('<')
                .trim()
                .to_owned();
            dialogue = false;
        } else if trimmed.starts_with('@')
            || (!dialogue
                && uppercase
                && index > 0
                && lines[index - 1].trim().is_empty()
                && lines
                    .get(index + 1)
                    .is_some_and(|next| !next.trim().is_empty()))
        {
            style = ParagraphStyle::Character;
            displayed = trimmed
                .trim_start_matches('@')
                .trim_end_matches('^')
                .trim()
                .to_owned();
            if trimmed.ends_with('^') {
                issue(
                    losses,
                    "fountain_dual_dialogue_sequential",
                    "双栏对白按先后顺序显示，双栏版式不保留。",
                );
            }
            ensure(
                !displayed.is_empty(),
                "hetu.format_unrepresentable",
                "Fountain 人物标记缺少可读名称。",
            )?;
            dialogue = true;
        } else if dialogue && trimmed.starts_with('(') && trimmed.ends_with(')') {
            style = ParagraphStyle::Parenthetical;
            displayed = line.to_owned();
        } else {
            style = if dialogue {
                ParagraphStyle::Dialogue
            } else {
                ParagraphStyle::Body
            };
            displayed = line.strip_prefix('!').unwrap_or(line).to_owned();
        }
        output.push(Paragraph::plain(style, displayed));
    }
    Ok(output)
}

/// PDF 与 DOCX 共用段落语义，避免不同阅读稿重新猜测中文人物及对白。
pub fn paragraphs(sources: &[Source]) -> Result<(Vec<Paragraph>, Vec<Value>)> {
    ensure(
        !sources.is_empty() && sources.len() <= 128,
        "invalid_input",
        "请选择 1～128 个正文修订。",
    )?;
    let mut result = Vec::new();
    let mut losses = Vec::new();
    let mut count = 0usize;
    for source in sources {
        valid_text(&source.content)?;
        valid_text(&source.title)?;
        valid_text(&source.author)?;
        ensure(
            !source.title.trim().is_empty(),
            "invalid_input",
            "交稿文档必须有标题。",
        )?;
        ensure(
            matches!(source.kind.as_str(), "novel_chapter" | "drama_script"),
            "invalid_input",
            "此文档类型不属于正文交稿范围。",
        )?;
        ensure(
            (source.kind == "drama_script") == (source.source_format == "fountain")
                && matches!(source.source_format.as_str(), "markdown" | "fountain"),
            "invalid_input",
            "文档类型与权威源格式不一致。",
        )?;
        count = count
            .checked_add(source.content.len())
            .ok_or_else(|| format_error("正文大小溢出。"))?;
        ensure(
            count <= TEXT_LIMIT,
            "hetu.budget_exceeded",
            "单次交稿正文合计超过 16 MiB。",
        )?;
        let mut projected = if source.source_format == "fountain" {
            fountain_paragraphs(&source.content, &mut losses)?
        } else {
            markdown_paragraphs(&source.content, &mut losses)?
        };
        projected.retain(|p| {
            !matches!(p.style, ParagraphStyle::Title | ParagraphStyle::Author)
                || !p.text.trim().is_empty()
        });
        if !projected.iter().any(|p| p.style == ParagraphStyle::Title) {
            projected.insert(0, Paragraph::plain(ParagraphStyle::Title, &source.title));
        }
        if !source.author.is_empty() && !projected.iter().any(|p| p.style == ParagraphStyle::Author)
        {
            projected.insert(1, Paragraph::plain(ParagraphStyle::Author, &source.author));
        }
        result.extend(projected);
    }
    Ok((result, losses))
}

pub(crate) fn document_metadata(paragraphs: &[Paragraph]) -> (&str, &str) {
    let title = paragraphs.first().map(|p| p.text.as_str()).unwrap_or("");
    let author = paragraphs
        .iter()
        .skip(1)
        .take_while(|p| p.style != ParagraphStyle::Title)
        .find(|p| p.style == ParagraphStyle::Author)
        .map(|p| p.text.as_str())
        .unwrap_or("");
    (title, author)
}

pub fn render(sources: &[Source], format: &str, profile: &str) -> Result<Converted> {
    valid_profile(profile)?;
    let (paragraphs, projection_losses) = paragraphs(sources)?;
    // 原生交换稿保留语法；只有阅读稿采用段落投影的损失清单。
    let mut losses = if matches!(format, "txt" | "docx") {
        projection_losses
    } else {
        Vec::new()
    };
    if profile == "hetu-novel-zh/1" {
        ensure(
            sources.iter().all(|s| s.kind == "novel_chapter"),
            "invalid_input",
            "小说模板只能用于小说正文。",
        )?;
    }
    if profile == "hetu-screenplay-zh/1" {
        ensure(
            sources.iter().all(|s| s.kind == "drama_script"),
            "invalid_input",
            "剧本模板只能用于剧本正文。",
        )?;
    }
    let mut warnings = Vec::new();
    let (bytes, media_type, extension) = match format {
        "markdown" | "md" => {
            ensure(
                sources.iter().all(|s| s.source_format == "markdown"),
                "hetu.format_unrepresentable",
                "Fountain 不自动改写为小说 Markdown。",
            )?;
            let mut output = String::new();
            for source in sources {
                if sources.len() > 1 {
                    output.push_str(&format!("# {}\n\n", escape_markdown(&source.title)));
                }
                output.push_str(&printed_markdown(&source.content, &mut losses)?);
                if sources.len() > 1 {
                    output.push_str("\n\n");
                }
            }
            (output.into_bytes(), "text/markdown; charset=utf-8", "md")
        }
        "fountain" => {
            ensure(
                sources.len() == 1 && sources[0].source_format == "fountain",
                "hetu.format_unrepresentable",
                "每份 Fountain 交换稿必须选择一部剧本，不把小说自动编写为剧本。",
            )?;
            let printed = printed_fountain(&sources[0].content, &mut losses)?;
            let printed = printed
                .lines()
                .filter(|line| !line.trim_start().starts_with('='))
                .collect::<Vec<_>>()
                .join("\n");
            let printed = if sources[0].content.ends_with('\n') {
                printed + "\n"
            } else {
                printed
            };
            (
                printed.into_bytes(),
                "text/plain; charset=utf-8",
                "fountain",
            )
        }
        "txt" => {
            issue(
                &mut losses,
                "plaintext_inline_formatting",
                "TXT 保留可读文字、标题与段落，不保留强调及字体版式；普通链接展开为文字地址。",
            );
            (
                paragraphs
                    .iter()
                    .map(|p| p.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n\n")
                    .into_bytes(),
                "text/plain; charset=utf-8",
                "txt",
            )
        }
        "docx" => {
            issue(
                &mut warnings,
                "fonts_not_embedded",
                "DOCX 记录中文及西文字体名称，不附带字体文件；接收方应核对实际字体、替代字体与分页。",
            );
            (
                write_docx(&paragraphs, sources, profile)?,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "docx",
            )
        }
        _ => {
            return Err(Error::new(
                "hetu.unsupported_document_format",
                "此格式不在当前交稿转换范围。",
            ));
        }
    };
    ensure(
        bytes.len() <= PACKAGE_LIMIT,
        "hetu.budget_exceeded",
        "格式转换产物超过 32 MiB。",
    )?;
    let newline = if format == "docx" {
        "not_applicable"
    } else {
        let text =
            std::str::from_utf8(&bytes).map_err(|_| format_error("转换产物不是有效 UTF-8。"))?;
        let crlf = text.matches("\r\n").count();
        let lf = text.matches('\n').count();
        let cr = text.matches('\r').count();
        if cr == 0 {
            "LF"
        } else if cr == crlf && lf == crlf {
            "CRLF"
        } else {
            "mixed"
        }
    };
    let report = json!({"schema_version":"1.0.0","converter":CONVERTER,"profile":profile,"format":format,"encoding":"UTF-8","newline":newline,"input_count":sources.len(),"output_sha256":digest(&bytes),"output_size_bytes":bytes.len(),"warnings":warnings,"losses":losses,"confirmation_required":!losses.is_empty(),"coverage":{"status":"supported_subset","industry_interoperability":"not_verified"}});
    Ok(Converted {
        bytes,
        media_type,
        extension,
        report,
    })
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn escape_markdown(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars() {
        if matches!(
            character,
            '\\' | '`'
                | '*'
                | '_'
                | '{'
                | '}'
                | '['
                | ']'
                | '('
                | ')'
                | '#'
                | '+'
                | '-'
                | '!'
                | '>'
                | '|'
        ) {
            result.push('\\');
        }
        result.push(character);
    }
    result
}

fn write_docx(paragraphs: &[Paragraph], sources: &[Source], profile: &str) -> Result<Vec<u8>> {
    let mut document = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><w:body>",
    );
    let language = sources
        .first()
        .map(|s| s.language_tag.as_str())
        .unwrap_or("zh-CN");
    let mut titles = 0;
    for paragraph in paragraphs {
        document.push_str("<w:p><w:pPr>");
        document.push_str(&format!("<w:pStyle w:val=\"{}\"/>", paragraph.style.word()));
        if paragraph.style == ParagraphStyle::Title {
            if titles > 0 {
                document.push_str("<w:pageBreakBefore/>");
            }
            titles += 1;
        }
        document.push_str("</w:pPr>");
        for run in &paragraph.runs {
            document.push_str("<w:r><w:rPr>");
            document.push_str(&format!(
                "<w:lang w:val=\"{}\" w:eastAsia=\"{}\"/>",
                escape_xml(language),
                escape_xml(language)
            ));
            if run.bold {
                document.push_str("<w:b/>");
            }
            if run.italic {
                document.push_str("<w:i/>");
            }
            document.push_str("</w:rPr>");
            for (index, line) in run.text.split('\n').enumerate() {
                if index > 0 {
                    document.push_str("<w:br/>");
                }
                for (tab, part) in line.split('\t').enumerate() {
                    if tab > 0 {
                        document.push_str("<w:tab/>");
                    }
                    document.push_str(&format!(
                        "<w:t xml:space=\"preserve\">{}</w:t>",
                        escape_xml(part)
                    ));
                }
            }
            document.push_str("</w:r>");
        }
        document.push_str("</w:p>");
    }
    document.push_str("<w:sectPr><w:footerReference w:type=\"default\" r:id=\"rFooter\"/><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"720\" w:footer=\"720\"/><w:pgNumType w:start=\"1\"/></w:sectPr></w:body></w:document>");
    let styles = r#"<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl/><w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:ind w:firstLine="480"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="HetuTitle"><w:name w:val="Hetu Title"/><w:pPr><w:keepNext/><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="HetuAuthor"><w:name w:val="Hetu Author"/><w:pPr><w:keepNext/><w:jc w:val="center"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="HetuScene"><w:name w:val="Hetu Scene"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="160"/></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="HetuCharacter"><w:name w:val="Hetu Character"/><w:pPr><w:keepNext/><w:ind w:left="2400"/><w:spacing w:after="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="HetuDialogue"><w:name w:val="Hetu Dialogue"/><w:pPr><w:keepLines/><w:ind w:left="1200" w:right="1200"/><w:spacing w:after="80"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="HetuParenthetical"><w:name w:val="Hetu Parenthetical"/><w:pPr><w:keepNext/><w:ind w:left="1800" w:right="1200"/><w:spacing w:after="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="HetuTransition"><w:name w:val="Hetu Transition"/><w:pPr><w:jc w:val="right"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="HetuSeparator"><w:name w:val="Hetu Separator"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style></w:styles>"#;
    let content_types = r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>"#;
    let relations = r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"#;
    let document_relations = r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>"#;
    let footer = r#"<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>"#;
    let settings = r#"<?xml version="1.0" encoding="UTF-8"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/><w:compat/></w:settings>"#;
    let (title, author) = document_metadata(paragraphs);
    let core = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>{}</dc:title><dc:creator>{}</dc:creator><dc:description>{}</dc:description></cp:coreProperties>",
        escape_xml(title),
        escape_xml(author),
        escape_xml(profile)
    );
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (path, content) in [
        ("[Content_Types].xml", content_types),
        ("_rels/.rels", relations),
        ("word/document.xml", document.as_str()),
        ("word/styles.xml", styles),
        ("word/_rels/document.xml.rels", document_relations),
        ("word/footer1.xml", footer),
        ("word/settings.xml", settings),
        ("docProps/core.xml", core.as_str()),
    ] {
        zip.start_file(
            path,
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
        )
        .map_err(|_| package_error())?;
        zip.write_all(content.as_bytes())?;
    }
    Ok(zip.finish().map_err(|_| package_error())?.into_inner())
}

fn checked_package(bytes: &[u8], losses: &mut Vec<Value>) -> Result<BTreeMap<String, Vec<u8>>> {
    ensure(
        bytes.len() <= PACKAGE_LIMIT,
        "hetu.budget_exceeded",
        "DOCX 文件超过 32 MiB 导入预算。",
    )?;
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|_| package_error())?;
    ensure(
        archive.len() <= 512,
        "hetu.budget_exceeded",
        "DOCX 条目超过 512 个。",
    )?;
    let mut files = BTreeMap::new();
    let mut paths = BTreeSet::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|_| package_error())?;
        let name = file.name().map_err(|_| package_error())?.into_owned();
        ensure(
            !name.starts_with('/')
                && !name.contains(['\\', '\0', ':'])
                && name
                    .trim_end_matches('/')
                    .split('/')
                    .all(|s| !s.is_empty() && !matches!(s, "." | ".."))
                && paths.insert(name.clone()),
            "hetu.unsafe_path",
            "DOCX 含跳转、重复条目或非法包路径。",
        )?;
        ensure(
            !file.encrypted(),
            "hetu.unsupported_document_format",
            "请先使用原编辑器解除 DOCX 加密再导入。",
        )?;
        ensure(
            file.unix_mode()
                .is_none_or(|mode| matches!(mode & 0o170000, 0 | 0o100000 | 0o040000)),
            "hetu.unsafe_path",
            "DOCX 不接受链接或特殊文件条目。",
        )?;
        total = total.checked_add(file.size()).ok_or_else(package_error)?;
        ensure(
            file.size() <= TEXT_LIMIT as u64
                && total <= PACKAGE_LIMIT as u64
                && file.size() <= file.compressed_size().max(1).saturating_mul(200),
            "hetu.budget_exceeded",
            "DOCX 解压体积或压缩比超过导入预算。",
        )?;
        let lower = name.to_ascii_lowercase();
        ensure(
            !lower.contains("vbaproject")
                && !lower.contains("activex")
                && !lower.contains("embeddings/")
                && !lower.ends_with(".bin"),
            "hetu.unsupported_document_format",
            "DOCX 含宏、活动控件或内嵌对象，请先在原编辑器转为纯正文。",
        )?;
        if file.is_dir() {
            continue;
        }
        let expected = file.size();
        let mut content = Vec::new();
        (&mut file)
            .take(TEXT_LIMIT as u64 + 1)
            .read_to_end(&mut content)
            .map_err(|_| package_error())?;
        ensure(
            content.len() as u64 == expected,
            "hetu.integrity_failure",
            "DOCX 条目长度与清单不符。",
        )?;
        if lower.ends_with(".xml") || lower.ends_with(".rels") {
            inspect_xml(&content, lower.ends_with(".rels"))?;
        }
        if lower.starts_with("word/media/") {
            issue(
                losses,
                "docx_media_omitted",
                "DOCX 内嵌图片未作为小说正文导入，请另行选择素材。",
            );
        }
        if lower.starts_with("word/comments") {
            issue(
                losses,
                "docx_comments_omitted",
                "DOCX 批注未导入正文，原文件仍须保留供作者核对。",
            );
        }
        if lower.starts_with("word/footnotes") || lower.starts_with("word/endnotes") {
            issue(
                losses,
                "docx_notes_omitted",
                "DOCX 脚注、尾注未导入正文，请先核对原文。",
            );
        }
        files.insert(name, content);
    }
    ensure(
        files.contains_key("[Content_Types].xml")
            && files.contains_key("_rels/.rels")
            && files.contains_key("word/document.xml"),
        "hetu.invalid_document_package",
        "DOCX 缺少标准内容类型、根关系或正文。",
    )?;
    validate_package_identity(&files)?;
    Ok(files)
}

fn attribute_value(
    reader: &NsReader<&[u8]>,
    element: &quick_xml::events::BytesStart<'_>,
    name: &[u8],
    namespace: Option<&[u8]>,
) -> Result<Option<String>> {
    for attribute in element.attributes() {
        let attribute = attribute.map_err(|_| package_error())?;
        let (resolved, local) = reader.resolver().resolve_attribute(attribute.key);
        let matches_namespace = match (&resolved, namespace) {
            (ResolveResult::Bound(actual), Some(expected)) => actual.as_ref() == expected,
            (ResolveResult::Unbound, None) => true,
            _ => false,
        };
        if local.as_ref() == name && matches_namespace {
            return Ok(Some(
                attribute
                    .decode_and_unescape_value(reader.decoder())
                    .map_err(|_| package_error())?
                    .into_owned(),
            ));
        }
    }
    Ok(None)
}

fn validate_package_identity(files: &BTreeMap<String, Vec<u8>>) -> Result<()> {
    let mut reader = NsReader::from_reader(files["[Content_Types].xml"].as_slice());
    let mut document_types = 0;
    loop {
        let (namespace, event) = reader.read_resolved_event().map_err(|_| package_error())?;
        let content_types = matches!(namespace, ResolveResult::Bound(ref actual) if actual.as_ref() == CONTENT_TYPES_NS);
        match event {
            Event::Start(element) | Event::Empty(element) if content_types => {
                if let Some(content_type) =
                    attribute_value(&reader, &element, b"ContentType", None)?
                {
                    ensure(
                        !content_type.to_ascii_lowercase().contains("macroenabled"),
                        "hetu.unsupported_document_format",
                        "只支持无宏的标准 DOCX 文档容器。",
                    )?;
                    if element.local_name().as_ref() == b"Override"
                        && attribute_value(&reader, &element, b"PartName", None)?.as_deref()
                            == Some("/word/document.xml")
                    {
                        ensure(
                            content_type
                                == "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
                            "hetu.unsupported_document_format",
                            "DOCX 正文内容类型不受支持。",
                        )?;
                        document_types += 1;
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    ensure(
        document_types == 1,
        "hetu.invalid_document_package",
        "DOCX 必须声明唯一的标准正文内容类型。",
    )?;
    let mut reader = NsReader::from_reader(files["_rels/.rels"].as_slice());
    let mut documents = 0;
    loop {
        let (namespace, event) = reader.read_resolved_event().map_err(|_| package_error())?;
        let relationships = matches!(namespace, ResolveResult::Bound(ref actual) if actual.as_ref() == PACKAGE_RELS_NS);
        match event {
            Event::Start(element) | Event::Empty(element)
                if relationships && element.local_name().as_ref() == b"Relationship" =>
            {
                if attribute_value(&reader, &element, b"Type", None)?.as_deref()
                    == Some(
                        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
                    )
                {
                    ensure(
                        attribute_value(&reader, &element, b"Target", None)?.as_deref()
                            == Some("word/document.xml"),
                        "hetu.invalid_document_package",
                        "当前 DOCX 子集要求根正文关系指向 word/document.xml。",
                    )?;
                    documents += 1;
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    ensure(
        documents == 1,
        "hetu.invalid_document_package",
        "DOCX 必须有唯一的根正文关系。",
    )
}

fn inspect_xml(content: &[u8], relationships: bool) -> Result<()> {
    let xml = std::str::from_utf8(content).map_err(|_| package_error())?;
    valid_text(xml)?;
    let mut reader = quick_xml::Reader::from_str(xml);
    reader.config_mut().check_end_names = true;
    let mut depth = 0usize;
    let mut roots = 0usize;
    loop {
        let event = reader.read_event().map_err(|_| package_error())?;
        match event {
            Event::DocType(_) => {
                return Err(Error::new(
                    "hetu.unsafe_document",
                    "DOCX 不允许 DTD 或外部实体。",
                ));
            }
            Event::PI(_) => {
                return Err(Error::new(
                    "hetu.unsafe_document",
                    "DOCX 不接受可执行的 XML 处理指令。",
                ));
            }
            Event::Start(ref element) | Event::Empty(ref element) => {
                if depth == 0 {
                    roots += 1;
                }
                ensure(
                    roots == 1,
                    "hetu.invalid_document_package",
                    "DOCX XML 必须有唯一根节点。",
                )?;
                ensure(
                    depth < 128,
                    "hetu.budget_exceeded",
                    "DOCX XML 嵌套超过 128 层。",
                )?;
                if !matches!(event, Event::Empty(_)) {
                    depth += 1;
                }
                let name = element.local_name();
                let name = name.as_ref();
                if matches!(
                    name,
                    b"ins"
                        | b"del"
                        | b"delText"
                        | b"moveFrom"
                        | b"moveTo"
                        | b"moveFromRangeStart"
                        | b"moveFromRangeEnd"
                        | b"moveToRangeStart"
                        | b"moveToRangeEnd"
                        | b"cellIns"
                        | b"cellDel"
                        | b"numberingChange"
                ) || name.ends_with(b"PrChange")
                {
                    return Err(Error::new(
                        "hetu.document_revisions_require_review",
                        "DOCX 含跟踪修订，请在原编辑器审阅并明确接受或拒绝后导入。",
                    ));
                }
                let hidden = matches!(name, b"vanish" | b"webHidden" | b"specVanish");
                let mut enabled = true;
                for attribute in element.attributes() {
                    let attribute = attribute.map_err(|_| package_error())?;
                    let value = attribute
                        .decode_and_unescape_value(reader.decoder())
                        .map_err(|_| package_error())?;
                    if hidden && attribute.key.local_name().as_ref() == b"val" {
                        enabled = !matches!(value.as_ref(), "0" | "false" | "off");
                    }
                    if relationships && attribute.key.local_name().as_ref() == b"TargetMode" {
                        ensure(
                            !value.eq_ignore_ascii_case("External"),
                            "hetu.unsafe_document",
                            "DOCX 外部链接或自动远程引用不会执行，请先在原编辑器移除外部关系。",
                        )?;
                    }
                    if relationships && attribute.key.local_name().as_ref() == b"Target" {
                        ensure(
                            !value.contains("://")
                                && !value.starts_with(['/', '\\'])
                                && !value.to_ascii_lowercase().starts_with("file:"),
                            "hetu.unsafe_document",
                            "DOCX 关系不能指向网络或本机绝对路径。",
                        )?;
                    }
                }
                ensure(
                    !hidden || !enabled,
                    "hetu.document_hidden_content_requires_review",
                    "DOCX 含隐藏文字或隐藏样式，请在原编辑器核对并明确处理后导入。",
                )?;
            }
            Event::Decl(declaration) => {
                if let Some(encoding) = declaration.encoding() {
                    ensure(
                        encoding
                            .map_err(|_| package_error())?
                            .eq_ignore_ascii_case(b"utf-8"),
                        "hetu.unsupported_document_format",
                        "DOCX XML 子集只接受 UTF-8 编码。",
                    )?;
                }
            }
            Event::End(_) => {
                depth = depth.checked_sub(1).ok_or_else(package_error)?;
            }
            Event::Text(text) if depth == 0 => {
                ensure(
                    text.decode()
                        .map_err(|_| package_error())?
                        .trim()
                        .is_empty(),
                    "hetu.invalid_document_package",
                    "DOCX XML 根节点之外存在正文。",
                )?;
            }
            Event::GeneralRef(reference) => {
                let reference = reference.decode().map_err(|_| package_error())?;
                quick_xml::escape::unescape(&format!("&{reference};"))
                    .map_err(|_| package_error())?;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    ensure(
        depth == 0 && roots == 1,
        "hetu.invalid_document_package",
        "DOCX XML 根节点缺失或未闭合。",
    )?;
    Ok(())
}

fn word_paragraphs(content: &[u8], losses: &mut Vec<Value>) -> Result<Vec<Paragraph>> {
    let xml = std::str::from_utf8(content).map_err(|_| package_error())?;
    let mut reader = NsReader::from_str(xml);
    reader.config_mut().check_end_names = true;
    let mut body = false;
    let mut in_text = false;
    let mut paragraph: Option<Paragraph> = None;
    let mut result = Vec::new();
    let mut bold = false;
    let mut italic = false;
    let mut skipped = 0usize;
    loop {
        let (namespace, event) = reader.read_resolved_event().map_err(|_| package_error())?;
        let word = matches!(namespace, ResolveResult::Bound(ref n) if n.as_ref() == WORD_NS);
        if skipped > 0 {
            match event {
                Event::Start(_) => skipped += 1,
                Event::End(_) => skipped -= 1,
                Event::Eof => return Err(package_error()),
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(ref element) | Event::Empty(ref element) if word => {
                let name = element.local_name();
                let name = name.as_ref();
                let empty = matches!(event, Event::Empty(_));
                if matches!(name, b"object" | b"altChunk" | b"subDoc") {
                    return Err(Error::new(
                        "hetu.unsafe_document",
                        "DOCX 含活动对象或外部正文，不自动执行或展开。",
                    ));
                }
                if name == b"body" {
                    body = true;
                }
                if !body {
                    continue;
                }
                match name {
                    b"p" => {
                        ensure(
                            paragraph.is_none(),
                            "hetu.invalid_document_package",
                            "DOCX 段落不能嵌套。",
                        )?;
                        paragraph = Some(Paragraph::plain(ParagraphStyle::Body, ""));
                    }
                    b"r" => {
                        bold = false;
                        italic = false;
                    }
                    b"pStyle" => {
                        if let Some(value) =
                            attribute_value(&reader, element, b"val", Some(WORD_NS))?
                        {
                            if let Some(p) = paragraph.as_mut() {
                                p.style = ParagraphStyle::from_word(&value).unwrap_or_else(|| {
                                    issue(
                                        losses,
                                        "docx_unknown_style_plaintext",
                                        "未识别的 DOCX 段落样式按普通正文导入，请核对章节与对白。",
                                    );
                                    ParagraphStyle::Body
                                });
                            }
                        }
                    }
                    b"b" => {
                        bold = !attribute_value(&reader, element, b"val", Some(WORD_NS))?
                            .is_some_and(|value| matches!(value.as_str(), "0" | "false" | "off"))
                    }
                    b"i" => {
                        italic = !attribute_value(&reader, element, b"val", Some(WORD_NS))?
                            .is_some_and(|value| matches!(value.as_str(), "0" | "false" | "off"))
                    }
                    b"t" => in_text = true,
                    b"tab" => {
                        if let Some(p) = paragraph.as_mut() {
                            p.push("\t", bold, italic);
                        }
                    }
                    b"br" | b"cr" => {
                        if let Some(p) = paragraph.as_mut() {
                            p.push("\n", bold, italic);
                        }
                    }
                    b"tbl" => issue(
                        losses,
                        "docx_table_flattened",
                        "DOCX 表格按段落文字导入，行列关系不保留。",
                    ),
                    b"drawing" | b"pict" | b"txbxContent" => {
                        issue(
                            losses,
                            "docx_drawing_omitted",
                            "DOCX 图形及文本框不作为正文导入，请核对原文件。",
                        );
                        if !empty {
                            skipped = 1;
                        }
                    }
                    b"footnoteReference" | b"endnoteReference" => issue(
                        losses,
                        "docx_notes_omitted",
                        "脚注与尾注未导入正文，请核对原文件。",
                    ),
                    b"fldChar" | b"fldSimple" => issue(
                        losses,
                        "docx_fields_frozen",
                        "DOCX 域不执行，正文仅保留已缓存的可见文字。",
                    ),
                    b"sym" => issue(
                        losses,
                        "docx_symbol_omitted",
                        "依赖特殊字体的 DOCX 符号无法可靠转换为 Unicode，请核对原文件。",
                    ),
                    b"numPr" => issue(
                        losses,
                        "docx_numbering_omitted",
                        "DOCX 自动列表编号不作为正文文字导入，请核对原文件。",
                    ),
                    b"hyperlink" => issue(
                        losses,
                        "docx_hyperlink_plaintext",
                        "DOCX 内部链接按可见文字导入，不保留链接跳转。",
                    ),
                    _ => {}
                }
                if empty && name == b"t" {
                    in_text = false;
                }
                if empty && name == b"p" {
                    if let Some(p) = paragraph.take() {
                        result.push(p);
                    }
                }
            }
            Event::End(element) if word => match element.local_name().as_ref() {
                b"t" => in_text = false,
                b"r" => {
                    bold = false;
                    italic = false;
                }
                b"p" if body => {
                    if let Some(p) = paragraph.take() {
                        result.push(p);
                    }
                }
                b"body" => body = false,
                _ => {}
            },
            Event::Text(text) if body && in_text => {
                let decoded = text.decode().map_err(|_| package_error())?;
                if let Some(p) = paragraph.as_mut() {
                    p.push(&decoded, bold, italic);
                }
            }
            Event::CData(text) if body && in_text => {
                let decoded = text.decode().map_err(|_| package_error())?;
                if let Some(p) = paragraph.as_mut() {
                    p.push(&decoded, bold, italic);
                }
            }
            Event::GeneralRef(reference) if body && in_text => {
                let name = reference.decode().map_err(|_| package_error())?;
                let escaped = format!("&{name};");
                let value = quick_xml::escape::unescape(&escaped).map_err(|_| package_error())?;
                if let Some(p) = paragraph.as_mut() {
                    p.push(&value, bold, italic);
                }
            }
            Event::Start(_) if body => {
                issue(
                    losses,
                    "docx_extensions_omitted",
                    "DOCX 扩展命名空间内容不属于当前正文子集，未导入部分须对照原文核对。",
                );
                skipped = 1;
            }
            Event::Empty(_) if body => issue(
                losses,
                "docx_extensions_omitted",
                "DOCX 扩展命名空间内容不属于当前正文子集，未导入部分须对照原文核对。",
            ),
            Event::Eof => break,
            _ => {}
        }
    }
    ensure(
        !result.is_empty(),
        "hetu.invalid_document_package",
        "DOCX 缺少可导入的正文段落或命名空间不受支持。",
    )?;
    Ok(result)
}

fn paragraphs_to_source(
    paragraphs: &[Paragraph],
    screenplay: bool,
    losses: &mut Vec<Value>,
) -> (String, Value) {
    let mut content = String::new();
    let mut title = String::new();
    let mut author = String::new();
    for paragraph in paragraphs {
        match paragraph.style {
            ParagraphStyle::Title if title.is_empty() => {
                title = paragraph.text.clone();
                continue;
            }
            ParagraphStyle::Author if author.is_empty() => {
                author = paragraph.text.clone();
                continue;
            }
            _ => {}
        }
        if screenplay {
            match paragraph.style {
                ParagraphStyle::Character => {
                    if !content.ends_with("\n\n") {
                        content.push('\n');
                    }
                    content.push('@');
                    content.push_str(&paragraph.text);
                    content.push('\n');
                }
                ParagraphStyle::Dialogue | ParagraphStyle::Parenthetical => {
                    content.push_str(&paragraph.text);
                    content.push('\n');
                }
                ParagraphStyle::Scene => {
                    content.push('\n');
                    if !["INT.", "EXT.", "I/E.", "EST."]
                        .iter()
                        .any(|prefix| paragraph.text.starts_with(prefix))
                    {
                        content.push('.');
                    }
                    content.push_str(&paragraph.text);
                    content.push_str("\n\n");
                }
                ParagraphStyle::Heading1 | ParagraphStyle::Heading2 | ParagraphStyle::Title => {
                    content.push_str(if paragraph.style == ParagraphStyle::Heading2 {
                        "\n## "
                    } else {
                        "\n# "
                    });
                    content.push_str(&paragraph.text);
                    content.push_str("\n\n");
                }
                ParagraphStyle::Transition => {
                    content.push_str("\n> ");
                    content.push_str(&paragraph.text);
                    content.push_str("\n\n");
                }
                _ => {
                    content.push('\n');
                    content.push_str(&paragraph.text);
                    content.push_str("\n\n");
                }
            }
            if paragraph.runs.iter().any(|run| run.bold || run.italic) {
                issue(
                    losses,
                    "docx_fountain_emphasis_plaintext",
                    "DOCX 强调按可见文字导入 Fountain，不生成推测的语法。",
                );
            }
        } else {
            match paragraph.style {
                ParagraphStyle::Heading1 | ParagraphStyle::Title => content.push_str("# "),
                ParagraphStyle::Heading2 => content.push_str("## "),
                _ => {}
            }
            for run in &paragraph.runs {
                let escaped = escape_markdown(&run.text);
                if run.bold {
                    content.push_str("**");
                }
                if run.italic {
                    content.push('*');
                }
                content.push_str(&escaped);
                if run.italic {
                    content.push('*');
                }
                if run.bold {
                    content.push_str("**");
                }
            }
            content.push_str("\n\n");
        }
    }
    if screenplay && !title.is_empty() {
        let mut title_page = format!("Title: {}\n", title.replace('\n', "\n    "));
        if !author.is_empty() {
            title_page.push_str(&format!("Author: {}\n", author.replace('\n', "\n    ")));
        }
        content = format!("{title_page}\n{content}");
    }
    (content, json!({"title":title,"author":author}))
}

/// 只返回候选与损失清单；登记新修订仍需可信作者入口的明确确认。
pub fn import(bytes: &[u8], format: &str, profile: &str) -> Result<Value> {
    valid_profile(profile)?;
    let mut warnings = Vec::new();
    let mut losses = Vec::new();
    let mut metadata = json!({});
    let source_format;
    let content;
    let mut chapter_candidates = Vec::new();
    match format {
        "markdown" | "md" | "txt" | "fountain" => {
            ensure(
                bytes.len() <= TEXT_LIMIT,
                "hetu.budget_exceeded",
                "文本文件超过 16 MiB 导入预算。",
            )?;
            let raw = std::str::from_utf8(bytes).map_err(|_| {
                Error::new(
                    "hetu.encoding_confirmation_required",
                    "文件不是有效 UTF-8，请先明确原编码并转换，不使用替换字符修复。",
                )
            })?;
            let raw = if let Some(value) = raw.strip_prefix('\u{feff}') {
                issue(
                    &mut warnings,
                    "utf8_bom_removed",
                    "已识别 UTF-8 BOM，正文候选不包含 BOM。",
                );
                value
            } else {
                raw
            };
            valid_text(raw)?;
            if raw.contains('\u{fffd}') {
                issue(
                    &mut warnings,
                    "replacement_character_present",
                    "原文件含替换字符，请核对原始编码与文字。",
                );
            }
            source_format = if format == "fountain" {
                "fountain"
            } else {
                "markdown"
            };
            content = if format == "txt" {
                issue(
                    &mut warnings,
                    "txt_chapters_require_confirmation",
                    "章节候选只供预览，不按“第×章”字样自动拆分或创建章节。",
                );
                for (line, text) in raw.lines().enumerate() {
                    let trimmed = text.trim();
                    if trimmed.starts_with('第')
                        && trimmed
                            .chars()
                            .take(32)
                            .any(|c| matches!(c, '章' | '卷' | '节'))
                    {
                        chapter_candidates.push(json!({"line":line+1,"title":trimmed}));
                    }
                }
                raw.lines()
                    .map(escape_markdown)
                    .collect::<Vec<_>>()
                    .join(if raw.contains("\r\n") { "\r\n" } else { "\n" })
                    + if raw.ends_with('\n') {
                        if raw.contains("\r\n") { "\r\n" } else { "\n" }
                    } else {
                        ""
                    }
            } else {
                if source_format == "markdown" {
                    let _ = markdown_paragraphs(raw, &mut losses)?;
                } else {
                    let _ = fountain_paragraphs(raw, &mut losses)?;
                }
                raw.to_owned()
            };
        }
        "docx" => {
            let files = checked_package(bytes, &mut losses)?;
            let paragraphs = word_paragraphs(&files["word/document.xml"], &mut losses)?;
            let screenplay = profile == "hetu-screenplay-zh/1"
                || profile == "source/1"
                    && paragraphs.iter().any(|p| {
                        matches!(
                            p.style,
                            ParagraphStyle::Scene
                                | ParagraphStyle::Character
                                | ParagraphStyle::Dialogue
                        )
                    });
            source_format = if screenplay { "fountain" } else { "markdown" };
            (content, metadata) = paragraphs_to_source(&paragraphs, screenplay, &mut losses);
            issue(
                &mut warnings,
                "docx_layout_not_preserved",
                "DOCX 只导入声明的正文语义子集；页眉页脚、纸张、分页及直接版式不是第二份权威正文。",
            );
        }
        _ => {
            return Err(Error::new(
                "hetu.unsupported_document_format",
                "此格式不能导入为权威可编辑正文。",
            ));
        }
    }
    valid_text(&content)?;
    ensure(
        (profile != "hetu-novel-zh/1" || source_format == "markdown")
            && (profile != "hetu-screenplay-zh/1" || source_format == "fountain"),
        "invalid_input",
        "导入格式与所选交稿模板不一致。",
    )?;
    Ok(
        json!({"schema_version":"1.0.0","converter":CONVERTER,"source_sha256":digest(bytes),"source_size_bytes":bytes.len(),"input_format":format,"profile":profile,"source_format":source_format,"content":content,"metadata":metadata,"chapter_candidates":chapter_candidates,"warnings":warnings,"losses":losses,"confirmation_required":true,"coverage":{"status":"supported_subset","industry_interoperability":"not_verified"}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source(format: &str, content: &str) -> Source {
        Source {
            title: "雾港 & 来信".into(),
            author: "示例作者".into(),
            kind: if format == "fountain" {
                "drama_script"
            } else {
                "novel_chapter"
            }
            .into(),
            source_format: format.into(),
            language_tag: "zh-CN".into(),
            content: content.into(),
        }
    }
    fn package(files: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, value) in files {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(value.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    fn replace_part(path: &str, value: &str) -> Vec<u8> {
        let original = render(&[source("markdown", "正文。")], "docx", "source/1").unwrap();
        let mut files = checked_package(&original.bytes, &mut Vec::new()).unwrap();
        files.insert(path.into(), value.as_bytes().to_vec());
        let pairs: Vec<_> = files
            .iter()
            .map(|(path, value)| (path.as_str(), std::str::from_utf8(value).unwrap()))
            .collect();
        package(&pairs)
    }
    #[test]
    fn native_markdown_keeps_syntax_and_reports_only_actual_losses() {
        let text = "# 章节\r\n\r\n![封面](https://public.test/cover.png)\r\n\r\n| 人物 | 地点 |\r\n| --- | --- |\r\n| 林舟 | 旧宅 |\r\n";
        let native = render(&[source("markdown", text)], "markdown", "source/1").unwrap();
        assert_eq!(native.bytes, text.as_bytes());
        assert_eq!(native.report["newline"], "CRLF");
        assert!(native.report["losses"].as_array().unwrap().is_empty());
        let preview = render(&[source("markdown", text)], "txt", "source/1").unwrap();
        assert!(
            preview.report["losses"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["code"] == "markdown_image_omitted")
        );
    }
    #[test]
    fn markdown_comments_are_removed_without_touching_visible_code() {
        let text = "可见文字。\n\n<!-- 私密\n审稿便笺 -->\n\n`<!-- 代码示例 -->`\n";
        let native = render(&[source("markdown", text)], "markdown", "source/1").unwrap();
        let text = String::from_utf8(native.bytes).unwrap();
        assert!(!text.contains("私密") && !text.contains("审稿便笺"));
        assert!(text.contains("`<!-- 代码示例 -->`"));
        assert!(
            native.report["losses"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["code"] == "markdown_hidden_notes_removed")
        );
        assert!(
            render(
                &[source("markdown", "<script>执行</script>")],
                "docx",
                "source/1"
            )
            .is_err()
        );
        assert!(
            render(
                &[source(
                    "markdown",
                    "[私有链接](https://public.test/path?token=placeholder)"
                )],
                "docx",
                "source/1"
            )
            .is_err()
        );
    }
    #[test]
    fn profiles_must_match_the_selected_source_kind() {
        assert!(
            render(
                &[source("fountain", "@林舟\n你好。")],
                "docx",
                "hetu-novel-zh/1"
            )
            .is_err()
        );
        assert!(
            render(
                &[source("markdown", "正文。")],
                "docx",
                "hetu-screenplay-zh/1"
            )
            .is_err()
        );
    }
    #[test]
    fn docx_identity_and_hidden_material_require_review() {
        let missing_relationship = replace_part(
            "_rels/.rels",
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"/>",
        );
        assert_eq!(
            import(&missing_relationship, "docx", "source/1")
                .unwrap_err()
                .code,
            "hetu.invalid_document_package"
        );
        for property in ["<w:vanish/>", "<w:pPrChange/>"] {
            let doc = format!(
                "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:rPr>{property}</w:rPr><w:t>未公开内容</w:t></w:r></w:p></w:body></w:document>"
            );
            let bytes = replace_part("word/document.xml", &doc);
            assert!(import(&bytes, "docx", "source/1").is_err());
        }
    }
    #[test]
    fn docx_extensions_are_disclosed_and_disabled_emphasis_stays_plain() {
        let xml = "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:x=\"urn:unsupported\"><w:body><w:p><w:r><w:rPr><w:b w:val=\"false\"/><w:i w:val=\"0\"/></w:rPr><w:t><![CDATA[可见正文]]></w:t></w:r><x:unknown><w:r><w:t>扩展文字</w:t></w:r></x:unknown><w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>文本框文字</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p></w:body></w:document>";
        let restored = import(&replace_part("word/document.xml", xml), "docx", "source/1").unwrap();
        let text = restored["content"].as_str().unwrap();
        assert!(text.contains("可见正文") && !text.contains('*'));
        assert!(!text.contains("扩展文字") && !text.contains("文本框文字"));
        assert!(
            restored["losses"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["code"] == "docx_extensions_omitted")
        );
        assert!(
            restored["losses"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["code"] == "docx_drawing_omitted")
        );
    }
    #[test]
    fn xml_limits_apply_to_all_namespaces() {
        let deep = format!("{}{}", "<x>".repeat(129), "</x>".repeat(129));
        assert_eq!(
            inspect_xml(deep.as_bytes(), false).unwrap_err().code,
            "hetu.budget_exceeded"
        );
        assert!(inspect_xml(b"<first/><second/>", false).is_err());
        assert!(inspect_xml(b"<?xml version=\"1.0\" encoding=\"UTF-16\"?><root/>", false).is_err());
    }
    #[test]
    fn invalid_utf8_is_never_repaired_and_txt_candidates_do_not_split() {
        assert_eq!(
            import(&[0xff], "txt", "source/1").unwrap_err().code,
            "hetu.encoding_confirmation_required"
        );
        let result = import(
            "第一章 初见\r\n　　保留缩进🌿\r\n# 普通文字\r\n".as_bytes(),
            "txt",
            "hetu-novel-zh/1",
        )
        .unwrap();
        assert_eq!(result["chapter_candidates"].as_array().unwrap().len(), 1);
        assert!(
            result["content"]
                .as_str()
                .unwrap()
                .contains("　　保留缩进🌿\r\n\\# 普通文字")
        );
        assert_eq!(result["confirmation_required"], true);
    }
    #[test]
    fn markdown_emphasis_and_escaping_roundtrip_through_ooxml() {
        let s = source(
            "markdown",
            "# 第一章\n\n　　**甲 & 乙**与*海风*。\n\n尾声🌿\n",
        );
        let output = render(&[s], "docx", "hetu-novel-zh/1").unwrap();
        let restored = import(&output.bytes, "docx", "hetu-novel-zh/1").unwrap();
        let content = restored["content"].as_str().unwrap();
        assert!(content.contains("# 第一章"));
        assert!(content.contains("**甲 & 乙**与*海风*。"), "{content}");
        assert!(content.contains("　　"));
        assert_eq!(restored["metadata"]["title"], "雾港 & 来信");
        assert_eq!(restored["metadata"]["author"], "示例作者");
    }
    #[test]
    fn fountain_title_page_survives_reading_copy_and_docx_roundtrip() {
        for (content, title, author) in [
            (
                "Title: 原稿书名\nAuthor: 原稿署名\n\n@林舟\n你好。",
                "原稿书名",
                "原稿署名",
            ),
            (
                "Title:\n    雾港\n    来信\nAuthor:\n    林舟\n    闻溪\n\n@林舟\n你好。",
                "雾港\n来信",
                "林舟\n闻溪",
            ),
        ] {
            let s = source("fountain", content);
            let (projected, _) = paragraphs(&[s.clone()]).unwrap();
            assert_eq!(document_metadata(&projected), (title, author));
            let docx = render(&[s], "docx", "hetu-screenplay-zh/1").unwrap();
            let restored = import(&docx.bytes, "docx", "hetu-screenplay-zh/1").unwrap();
            assert_eq!(restored["metadata"]["title"], title);
            assert_eq!(restored["metadata"]["author"], author);
            let (again, _) =
                paragraphs(&[source("fountain", restored["content"].as_str().unwrap())]).unwrap();
            assert_eq!(document_metadata(&again), (title, author));
            let files = checked_package(&docx.bytes, &mut Vec::new()).unwrap();
            let metadata = std::str::from_utf8(&files["docProps/core.xml"]).unwrap();
            assert!(metadata.contains(&format!("<dc:title>{title}</dc:title>")));
            assert!(metadata.contains(&format!("<dc:creator>{author}</dc:creator>")));
        }
        let mut s = source("fountain", "Title: 无署名稿\n\n@林舟\n你好。");
        s.author.clear();
        let docx = render(&[s], "docx", "hetu-screenplay-zh/1").unwrap();
        let restored = import(&docx.bytes, "docx", "hetu-screenplay-zh/1").unwrap();
        assert!(!restored["content"].as_str().unwrap().contains("Author:"));
    }

    #[test]
    fn chinese_fountain_roles_are_explicit_and_notes_do_not_leak() {
        let s = source(
            "fountain",
            "Title: 原稿\nAuthor: 原作者\n\n# 第1集\n\nINT. 旧宅 - DAY #1#\n\n/* 不外发 */\n@林舟\n(低声)\n有人在吗？\n\n[[ 私密说明 ]]\n",
        );
        let (paragraphs, losses) = paragraphs(&[s.clone()]).unwrap();
        assert!(
            paragraphs
                .iter()
                .any(|p| p.style == ParagraphStyle::Character && p.text == "林舟")
        );
        assert!(
            paragraphs
                .iter()
                .any(|p| p.style == ParagraphStyle::Dialogue && p.text == "有人在吗？")
        );
        assert!(!losses.is_empty());
        let docx = render(&[s.clone()], "docx", "hetu-screenplay-zh/1").unwrap();
        let restored = import(&docx.bytes, "docx", "hetu-screenplay-zh/1").unwrap();
        let text = restored["content"].as_str().unwrap();
        assert!(text.contains("@林舟\n(低声)\n有人在吗？"), "{text}");
        assert!(text.contains("INT. 旧宅 - DAY #1#"));
        assert!(!text.contains("不外发") && !text.contains("私密说明"));
        let fountain = render(&[s], "fountain", "source/1").unwrap();
        assert!(
            !String::from_utf8(fountain.bytes)
                .unwrap()
                .contains("不外发")
        );
    }
    #[test]
    fn docx_rejects_external_relations_dtd_and_tracked_changes() {
        let original = render(&[source("markdown", "正文。")], "docx", "source/1").unwrap();
        let files = checked_package(&original.bytes, &mut Vec::new()).unwrap();
        for (path, value, code) in [
            (
                "word/_rels/document.xml.rels",
                "<Relationships><Relationship TargetMode=\"External\" Target=\"https://invalid.test\"/></Relationships>",
                "hetu.unsafe_document",
            ),
            (
                "word/document.xml",
                "<!DOCTYPE foo [<!ENTITY x SYSTEM \"file:///private\">]><w:document/>",
                "hetu.unsafe_document",
            ),
            (
                "word/document.xml",
                "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:ins><w:r><w:t>未确认修订</w:t></w:r></w:ins></w:p></w:body></w:document>",
                "hetu.document_revisions_require_review",
            ),
        ] {
            let mut changed = files.clone();
            changed.insert(path.into(), value.as_bytes().to_vec());
            let pairs: Vec<_> = changed
                .iter()
                .map(|(path, value)| (path.as_str(), std::str::from_utf8(value).unwrap()))
                .collect();
            assert_eq!(
                import(&package(&pairs), "docx", "source/1")
                    .unwrap_err()
                    .code,
                code
            );
        }
    }
    #[test]
    fn unsafe_and_overbudget_packages_are_rejected_without_extraction() {
        let bad = package(&[("../outside.xml", "x")]);
        assert_eq!(
            import(&bad, "docx", "source/1").unwrap_err().code,
            "hetu.unsafe_path"
        );
        let large = "x".repeat(TEXT_LIMIT + 1);
        let bad = package(&[("word/document.xml", &large)]);
        assert_eq!(
            import(&bad, "docx", "source/1").unwrap_err().code,
            "hetu.budget_exceeded"
        );
    }
    #[test]
    fn unknown_styles_and_images_have_visible_loss_records() {
        let original = render(&[source("markdown", "正文。")], "docx", "source/1").unwrap();
        let mut files = checked_package(&original.bytes, &mut Vec::new()).unwrap();
        files.insert("word/document.xml".into(),b"<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:pPr><w:pStyle w:val=\"CustomNovel\"/></w:pPr><w:r><w:t>literal &amp; text</w:t></w:r></w:p><w:p><w:r><w:drawing/></w:r></w:p></w:body></w:document>".to_vec());
        let pairs: Vec<_> = files
            .iter()
            .map(|(path, value)| (path.as_str(), std::str::from_utf8(value).unwrap()))
            .collect();
        let restored = import(&package(&pairs), "docx", "source/1").unwrap();
        assert!(
            restored["content"]
                .as_str()
                .unwrap()
                .contains("literal & text")
        );
        assert!(
            restored["losses"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["code"] == "docx_unknown_style_plaintext")
        );
        assert!(
            restored["losses"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["code"] == "docx_drawing_omitted")
        );
    }
}
