use super::{Kind, Method, TimeOfDay};
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use std::ops::Range;
use std::time::Instant;

#[derive(Clone, Copy)]
pub enum BlockKind {
    Heading,
    Prose,
    Scene,
    Dialogue,
}
pub struct Block {
    pub range: Range<usize>,
    pub kind: BlockKind,
    pub speaker: Option<Range<usize>>,
}
pub struct Skip {
    pub range: Range<usize>,
    pub reason: &'static str,
}
pub struct Parsed {
    pub mask: String,
    pub blocks: Vec<Block>,
    pub skipped: Vec<Skip>,
    pub stopped_at: Option<usize>,
}
pub struct Spec {
    pub kind: Kind,
    pub range: Range<usize>,
    pub method: Method,
    pub speaker: Option<Range<usize>>,
    pub time_of_day: TimeOfDay,
}

pub fn parse(content: &str, format: &str, deadline: Instant) -> Parsed {
    if format == "fountain" {
        fountain(content, deadline)
    } else {
        markdown(content, deadline)
    }
}
fn markdown(content: &str, deadline: Instant) -> Parsed {
    let mut visible = vec![b' '; content.len()];
    let mut blocks = Vec::new();
    let mut skipped = Vec::new();
    let mut block = None;
    let mut stopped_at = None;
    let mut code_block = false;
    let bom = if content.starts_with('\u{feff}') {
        3
    } else {
        0
    };
    for (event, range) in Parser::new(&content[bom..]).into_offset_iter() {
        let range = range.start + bom..range.end + bom;
        if Instant::now() >= deadline {
            stopped_at = Some(range.start);
            break;
        }
        match event {
            Event::Start(Tag::Paragraph) => {
                block = Some(Block {
                    range,
                    kind: BlockKind::Prose,
                    speaker: None,
                })
            }
            Event::Start(Tag::Heading { .. }) => {
                block = Some(Block {
                    range,
                    kind: BlockKind::Heading,
                    speaker: None,
                })
            }
            Event::End(TagEnd::Paragraph | TagEnd::Heading(_)) => {
                if let Some(value) = block.take() {
                    blocks.push(value);
                }
            }
            Event::Text(_) if code_block => {}
            Event::Text(text) => {
                if text.as_ref() == &content[range.clone()] {
                    visible[range.clone()].copy_from_slice(content[range].as_bytes());
                } else {
                    skipped.push(Skip {
                        range,
                        reason: "escaped_text",
                    });
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                visible[range.clone()].copy_from_slice(content[range].as_bytes())
            }
            Event::Start(Tag::CodeBlock(_)) => {
                code_block = true;
                skipped.push(Skip {
                    range,
                    reason: "code",
                });
            }
            Event::End(TagEnd::CodeBlock) => code_block = false,
            Event::Code(_) => skipped.push(Skip {
                range,
                reason: "code",
            }),
            Event::Html(_) | Event::InlineHtml(_) => skipped.push(Skip {
                range,
                reason: "html",
            }),
            _ => {}
        }
    }
    Parsed {
        mask: String::from_utf8(visible).expect("original UTF8 spans and ASCII masking"),
        blocks,
        skipped,
        stopped_at,
    }
}
fn lines(content: &str) -> Vec<Range<usize>> {
    let mut offset = 0;
    content
        .split_inclusive('\n')
        .map(|line| {
            let start = offset;
            offset += line.len();
            trim(content, start..offset)
        })
        .collect()
}
fn fountain(content: &str, deadline: Instant) -> Parsed {
    let mut mask = content.as_bytes().to_vec();
    let mut blocks = Vec::new();
    let mut skipped = Vec::new();
    let mut position = 0;
    while position < content.len() {
        let next = [("[[", "]]"), ("/*", "*/")]
            .into_iter()
            .filter_map(|(open, close)| {
                content[position..]
                    .find(open)
                    .map(|offset| (position + offset, close))
            })
            .min_by_key(|(offset, _)| *offset);
        let Some((start, close)) = next else { break };
        if Instant::now() >= deadline {
            break;
        }
        if content[..start].ends_with('\\') {
            position = start + 2;
            continue;
        }
        let end = content[start + 2..]
            .find(close)
            .map_or(content.len(), |offset| start + 2 + offset + 2);
        mask[start..end].fill(b' ');
        // 保留换行边界，避免注释前后两个对白块被错误连为一块。
        for (offset, byte) in content.as_bytes()[start..end].iter().enumerate() {
            if matches!(byte, b'\r' | b'\n') {
                mask[start + offset] = *byte;
            }
        }
        skipped.push(Skip {
            range: start..end,
            reason: "fountain_metadata",
        });
        position = end;
    }
    if content.starts_with('\u{feff}') {
        mask[0..3].fill(b' ');
    }
    let visible = String::from_utf8(mask.clone()).expect("original UTF8 and ASCII masks");
    let lines = lines(&visible);
    let mut index = 0;
    let mut title_page = false;
    let mut body_started = false;
    let mut stopped_at = None;
    while index < lines.len() {
        let range = lines[index].clone();
        let text = &visible[range.clone()];
        if Instant::now() >= deadline {
            stopped_at = Some(range.start);
            break;
        }
        if text.is_empty() {
            title_page = false;
            index += 1;
            continue;
        }
        let lower = text.to_ascii_lowercase();
        let title_field = [
            "title:",
            "credit:",
            "author:",
            "authors:",
            "source:",
            "draft date:",
            "contact:",
            "copyright:",
        ]
        .iter()
        .any(|prefix| lower.starts_with(prefix));
        if !body_started && title_field {
            title_page = true;
        }
        if title_page
            || title_field
            || text.starts_with('#')
            || text.starts_with('=')
            || text.starts_with('>')
            || text.ends_with("TO:")
        {
            mask[range.clone()].fill(b' ');
            skipped.push(Skip {
                range,
                reason: "fountain_metadata",
            });
            index += 1;
            continue;
        }
        body_started = true;
        if scene_line(text) {
            blocks.push(Block {
                range,
                kind: BlockKind::Scene,
                speaker: None,
            });
            index += 1;
            continue;
        }
        let previous_blank = index == 0 || lines[index - 1].is_empty();
        if previous_blank && cue(text) && index + 1 < lines.len() && !lines[index + 1].is_empty() {
            let speaker = speaker_name(content, range.clone());
            index += 1;
            let start = lines[index].start;
            let mut end = lines[index].end;
            while index < lines.len() && !lines[index].is_empty() {
                end = lines[index].end;
                index += 1;
            }
            blocks.push(Block {
                range: start..end,
                kind: BlockKind::Dialogue,
                speaker: Some(speaker),
            });
            continue;
        }
        let start = range.start;
        let mut end = range.end;
        index += 1;
        while index < lines.len()
            && !lines[index].is_empty()
            && !scene_line(&visible[lines[index].clone()])
        {
            end = lines[index].end;
            index += 1;
        }
        blocks.push(Block {
            range: start..end,
            kind: BlockKind::Prose,
            speaker: None,
        });
    }
    if content.starts_with('\u{feff}') {
        mask[0..3].fill(b' ');
    }
    Parsed {
        mask: String::from_utf8(mask).expect("original UTF8 and ASCII masks"),
        blocks,
        skipped,
        stopped_at,
    }
}
pub fn scene_line(text: &str) -> bool {
    let upper = text.to_ascii_uppercase();
    ["INT.", "EXT.", "INT/EXT.", "INT./EXT.", "I/E.", "EST."]
        .iter()
        .any(|p| upper.starts_with(p))
        || (text.starts_with('.') && !text.starts_with("..") && text.len() > 1)
}
fn cue(text: &str) -> bool {
    if text.starts_with('@') {
        return text.chars().count() <= 100;
    }
    let name = text.split(['(', '（']).next().unwrap_or("").trim();
    !name.is_empty()
        && name.len() <= 100
        && name.chars().any(|c| c.is_ascii_uppercase())
        && !name.chars().any(|c| c.is_lowercase())
        && !name.ends_with(':')
}
fn speaker_name(content: &str, range: Range<usize>) -> Range<usize> {
    let text = &content[range.clone()];
    let start = range.start + usize::from(text.starts_with('@'));
    let name = &content[start..range.end];
    let end = name.find(['(', '（']).map_or(range.end, |end| start + end);
    trim(content, start..end)
}
pub fn trim(content: &str, range: Range<usize>) -> Range<usize> {
    let text = &content[range.clone()];
    let leading = text.len()
        - text
            .trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
            .len();
    let trimmed = text[leading..].trim_end();
    range.start + leading..range.start + leading + trimmed.len()
}
pub fn specs(content: &str, parsed: &Parsed, block: &Block) -> (Vec<Spec>, Vec<Skip>) {
    let mut result = Vec::new();
    let mut skipped = Vec::new();
    let visible = &parsed.mask[block.range.clone()];
    let range = trim(&parsed.mask, block.range.clone());
    if range.is_empty() {
        return (result, skipped);
    }
    let text = &parsed.mask[range.clone()];
    let scene_marker = text.starts_with("【场景：")
        || text.starts_with("【场景:")
        || text.to_ascii_lowercase().starts_with("[scene:");
    match block.kind {
        BlockKind::Heading | BlockKind::Scene => result.push(Spec {
            kind: Kind::Scene,
            range: block.range.clone(),
            method: if matches!(block.kind, BlockKind::Heading) {
                Method::MarkdownHeading
            } else {
                Method::FountainScene
            },
            speaker: None,
            time_of_day: time_of_day(text),
        }),
        BlockKind::Dialogue => result.push(Spec {
            kind: Kind::Dialogue,
            range: block.range.clone(),
            method: Method::FountainDialogue,
            speaker: block.speaker.clone(),
            time_of_day: TimeOfDay::Unknown,
        }),
        BlockKind::Prose if scene_marker => result.push(Spec {
            kind: Kind::Scene,
            range: block.range.clone(),
            method: Method::SceneMarker,
            speaker: None,
            time_of_day: time_of_day(text),
        }),
        BlockKind::Prose => {
            let speaker = label(content, &parsed.mask, range.clone());
            let (quotes, unclosed) = quotes(&parsed.mask, range.clone());
            if let Some(start) = unclosed {
                skipped.push(Skip {
                    range: start..range.end,
                    reason: "unclosed_quote",
                });
            }
            if !quotes.is_empty() {
                for quote in quotes {
                    let line_start = parsed.mask[range.start..quote.start]
                        .rfind('\n')
                        .map_or(range.start, |offset| range.start + offset + 1);
                    let speaker = label(content, &parsed.mask, line_start..quote.start);
                    result.push(Spec {
                        kind: Kind::Dialogue,
                        range: quote,
                        method: Method::QuotedDialogue,
                        speaker,
                        time_of_day: TimeOfDay::Unknown,
                    });
                }
            } else if speaker.is_some() || text.starts_with("——") {
                let start = speaker.as_ref().map_or(range.start, |name| {
                    content[name.end..range.end]
                        .find([':', '：'])
                        .map_or(range.start, |p| {
                            name.end
                                + p
                                + content[name.end + p..].chars().next().unwrap().len_utf8()
                        })
                });
                let body = trim(&parsed.mask, start..range.end);
                if !body.is_empty() {
                    result.push(Spec {
                        kind: Kind::Dialogue,
                        range: body,
                        method: if speaker.is_some() {
                            Method::SpeakerLabel
                        } else {
                            Method::DashDialogue
                        },
                        speaker: speaker.clone(),
                        time_of_day: TimeOfDay::Unknown,
                    });
                }
            }
            let quoted: Vec<_> = result
                .iter()
                .filter(|s| s.kind == Kind::Dialogue)
                .map(|s| s.range.clone())
                .collect();
            let mut start = range.start;
            for (offset, ch) in visible.char_indices() {
                if !matches!(ch, '。' | '！' | '？' | '.' | '!' | '?' | '\n') {
                    continue;
                }
                let end = block.range.start + offset + ch.len_utf8();
                sentence(&parsed.mask, start..end, &quoted, &mut result);
                start = end;
            }
            if start < range.end {
                sentence(&parsed.mask, start..range.end, &quoted, &mut result);
            }
        }
    }
    result.sort_by_key(|spec| (spec.range.start, spec.range.end));
    (result, skipped)
}
fn label(content: &str, mask: &str, range: Range<usize>) -> Option<Range<usize>> {
    let text = &mask[range.clone()];
    let position = text.find([':', '：'])?;
    let prefix = trim(mask, range.start..range.start + position);
    let name = &content[prefix.clone()];
    if name.chars().count() > 40
        || name.is_empty()
        || name.contains(['\n', '。', '，', '！', '？', '"', '“', '”', '：', ':'])
    {
        return None;
    }
    Some(speaker_name(content, prefix))
}
fn quotes(mask: &str, range: Range<usize>) -> (Vec<Range<usize>>, Option<usize>) {
    let mut stack: Vec<(char, usize)> = Vec::new();
    let mut result = Vec::new();
    let mut slashes = 0;
    for (offset, ch) in mask[range.clone()].char_indices() {
        let at = range.start + offset;
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        let escaped = slashes % 2 == 1;
        slashes = 0;
        if escaped {
            continue;
        }
        if stack.last().is_some_and(|(close, _)| *close == ch) {
            let (_, start) = stack.pop().unwrap();
            if stack.is_empty() {
                result.push(start..at + ch.len_utf8());
            }
        } else if let Some(close) = match ch {
            '“' => Some('”'),
            '「' => Some('」'),
            '『' => Some('』'),
            '"' => Some('"'),
            _ => None,
        } {
            stack.push((close, at));
        }
    }
    (result, stack.first().map(|(_, start)| *start))
}
fn sentence(mask: &str, range: Range<usize>, quoted: &[Range<usize>], result: &mut Vec<Spec>) {
    if range.start >= range.end {
        return;
    }
    let range = trim(mask, range);
    if range.is_empty() {
        return;
    }
    // 对白内的动词不能同时被当成已发生的动作。
    let mut visible = mask[range.clone()].as_bytes().to_vec();
    for quote in quoted {
        let start = range.start.max(quote.start);
        let end = range.end.min(quote.end);
        if start < end {
            visible[start - range.start..end - range.start].fill(b' ');
        }
    }
    let text = String::from_utf8(visible).expect("UTF8 boundaries");
    let (kind, method) =
        if text.contains("【伏笔") || text.to_ascii_lowercase().contains("[foreshadow:") {
            (Kind::ForeshadowCandidate, Method::ForeshadowMarker)
        } else if text.contains("【冲突")
            || text.to_ascii_lowercase().contains("[conflict:")
            || ["拒绝", "阻止", "争夺", "反对"]
                .iter()
                .any(|term| text.contains(term))
        {
            (Kind::ConflictCandidate, Method::ConflictMarker)
        } else if action(&text) {
            (Kind::Action, Method::ActionTerms)
        } else {
            return;
        };
    result.push(Spec {
        kind,
        range,
        method,
        speaker: None,
        time_of_day: TimeOfDay::Unknown,
    });
}
fn action(text: &str) -> bool {
    if [
        "走", "推", "拉", "抬", "握", "跑", "转身", "拿", "放", "看", "击", "踢", "打开", "关上",
        "跃", "点燃", "进入", "离开", "递给", "站", "坐",
    ]
    .iter()
    .any(|term| text.contains(term))
    {
        return true;
    }
    text.split(|ch: char| !ch.is_alphabetic()).any(|word| {
        [
            "walk", "walks", "walked", "run", "runs", "ran", "turn", "turns", "turned", "open",
            "opens", "opened", "close", "closes", "closed", "look", "looks", "looked", "give",
            "gives", "gave", "take", "takes", "took", "enter", "enters", "entered", "leave",
            "leaves", "left", "push", "pushes", "pushed", "pull", "pulls", "pulled", "stand",
            "stands", "stood", "sit", "sits", "sat", "attack", "attacks", "attacked", "refuse",
            "refuses", "refused",
        ]
        .iter()
        .any(|term| word.eq_ignore_ascii_case(term))
    })
}
fn time_of_day(text: &str) -> TimeOfDay {
    let last = text
        .rsplit(['-', '—', '|', '｜'])
        .next()
        .unwrap_or(text)
        .trim()
        .trim_end_matches(['】', ']'])
        .trim();
    match last.to_ascii_lowercase().as_str() {
        "day" | "日" | "白天" => TimeOfDay::Day,
        "night" | "夜" | "夜晚" => TimeOfDay::Night,
        "dawn" | "黎明" | "清晨" => TimeOfDay::Dawn,
        "dusk" | "黄昏" | "傍晚" => TimeOfDay::Dusk,
        _ => TimeOfDay::Unknown,
    }
}
