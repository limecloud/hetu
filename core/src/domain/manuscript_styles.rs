//! 文稿的受限呈现标记；只解析合同属性，不执行HTML或CSS。
use base64::Engine;
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{ops::Range, sync::LazyLock};

pub static CATALOG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../contracts/manuscript-styles.json"))
        .expect("文稿样式合同必须有效")
});

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Presentation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alignment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<String>,
    #[serde(rename = "cardLayout", skip_serializing_if = "Option::is_none")]
    pub card_layout: Option<String>,
    #[serde(rename = "cardPreview", skip_serializing_if = "Option::is_none")]
    pub card_preview: Option<String>,
    #[serde(rename = "cardColor", skip_serializing_if = "Option::is_none")]
    pub card_color: Option<String>,
    #[serde(rename = "cardGradient", skip_serializing_if = "Option::is_none")]
    pub card_gradient: Option<String>,
    #[serde(rename = "cardImage", skip_serializing_if = "Option::is_none")]
    pub card_image: Option<String>,
}
impl Presentation {
    fn inherit(&mut self, child: &Self) {
        if child.color.is_some() {
            self.color = child.color.clone();
        }
        if child.font.is_some() {
            self.font = child.font.clone();
        }
        if child.alignment.is_some() {
            self.alignment = child.alignment.clone();
        }
        if child.block.is_some() {
            self.block = child.block.clone();
        }
    }
    pub fn inline_tag(&self) -> String {
        let mut attributes = Vec::new();
        if let Some(value) = self.color.as_deref().filter(|value| valid_color(value)) {
            attributes.push(format!(
                "data-hetu-color=\"{}\"",
                value.to_ascii_lowercase()
            ));
        }
        if let Some(value) = self
            .font
            .as_deref()
            .filter(|value| CATALOG["fonts"].get(*value).is_some())
        {
            attributes.push(format!("data-hetu-font=\"{value}\""));
        }
        if attributes.is_empty() {
            String::new()
        } else {
            format!("<span {}>", attributes.join(" "))
        }
    }
    pub fn block_tag(&self) -> String {
        let mut attributes = Vec::new();
        for (key, value, values) in [
            ("data-hetu-align", &self.alignment, "alignments"),
            ("data-hetu-block", &self.block, "blocks"),
        ] {
            if let Some(value) = value.as_deref().filter(|value| allowed(values, value)) {
                attributes.push(format!("{key}=\"{value}\""));
            }
        }
        if attributes.is_empty() {
            String::new()
        } else {
            format!("<div {}>", attributes.join(" "))
        }
    }
}

#[derive(Clone, Debug)]
pub struct StyledSpan {
    pub opening: Range<usize>,
    pub closing: Range<usize>,
    pub attributes: Presentation,
}
#[derive(Default, Debug)]
pub struct StyleMarkup {
    pub spans: Vec<StyledSpan>,
}
struct Token {
    range: Range<usize>,
    tag: String,
    close: bool,
    attributes: Option<Presentation>,
}

pub fn valid_color(value: &str) -> bool {
    CATALOG["colors"].get(value).is_some()
        || value.len() == 7
            && value.starts_with('#')
            && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}
pub fn color_hex(value: &str) -> Option<String> {
    if !valid_color(value) {
        return None;
    }
    Some(
        CATALOG["colors"][value]["light"]
            .as_str()
            .unwrap_or(value)
            .trim_start_matches('#')
            .to_ascii_uppercase(),
    )
}
fn allowed(key: &str, value: &str) -> bool {
    CATALOG[key]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(value)))
}
fn card_allowed(key: &str, value: &str) -> bool {
    CATALOG["card"][key]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(value)))
}
fn valid_card_image(value: &str) -> bool {
    let Some((kind, encoded)) = value
        .strip_prefix("data:")
        .and_then(|value| value.split_once(";base64,"))
    else {
        return false;
    };
    let limit = CATALOG["card"]["max_image_bytes"].as_u64().unwrap() as usize;
    if !card_allowed("image_types", kind) || encoded.len() > limit.div_ceil(3) * 4 {
        return false;
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return false;
    };
    bytes.len() <= limit
        && match kind {
            "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
            "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
            _ => false,
        }
}
fn valid_card(value: &Presentation) -> bool {
    let values = [
        &value.card_layout,
        &value.card_preview,
        &value.card_color,
        &value.card_gradient,
        &value.card_image,
    ];
    values.iter().all(|value| value.is_none())
        || value.block.as_deref() == Some("card")
            && [&value.card_color, &value.card_gradient, &value.card_image]
                .iter()
                .filter(|value| value.is_some())
                .count()
                <= 1
}
fn parse_token(source: &str, range: Range<usize>) -> Option<Token> {
    let raw = &source[range.clone()];
    let text = raw.trim();
    if text.contains(['\r', '\n']) || !text.ends_with('>') {
        return None;
    }
    let (close, rest) = text
        .strip_prefix("</")
        .map(|rest| (true, rest))
        .or_else(|| text.strip_prefix('<').map(|rest| (false, rest)))?;
    let end = rest.find(|character: char| character.is_ascii_whitespace() || character == '>')?;
    let tag = &rest[..end];
    if !matches!(tag, "span" | "div") {
        return None;
    }
    let from = range.start + raw.find(text)?;
    let to = from + text.len();
    if tag == "div" {
        let start = source[..from].rfind(['\r', '\n']).map_or(0, |at| at + 1);
        let end = source[to..]
            .find(['\r', '\n'])
            .map_or(source.len(), |at| to + at);
        if !source[start..from].trim().is_empty() || !source[to..end].trim().is_empty() {
            return None;
        }
    }
    let attributes = if close {
        if !rest[end..rest.len() - 1].trim().is_empty() {
            return None;
        }
        None
    } else {
        let mut reader = quick_xml::Reader::from_str(text);
        let parsed = match reader.read_event().ok()? {
            quick_xml::events::Event::Start(element)
                if reader.buffer_position() == text.len() as u64 =>
            {
                let mut value = Presentation::default();
                let mut valid = true;
                let mut count = 0;
                for attribute in element.attributes() {
                    let Ok(attribute) = attribute else {
                        valid = false;
                        break;
                    };
                    let Ok(key) = std::str::from_utf8(attribute.key.as_ref()) else {
                        valid = false;
                        break;
                    };
                    let Ok(raw) = std::str::from_utf8(attribute.value.as_ref()) else {
                        valid = false;
                        break;
                    };
                    match (tag, key) {
                        ("span", "data-hetu-color") if valid_color(raw) => {
                            value.color = Some(raw.to_ascii_lowercase())
                        }
                        ("span", "data-hetu-font") if CATALOG["fonts"].get(raw).is_some() => {
                            value.font = Some(raw.into())
                        }
                        ("div", "data-hetu-align") if allowed("alignments", raw) => {
                            value.alignment = Some(raw.into())
                        }
                        ("div", "data-hetu-block") if allowed("blocks", raw) => {
                            value.block = Some(raw.into())
                        }
                        ("div", "data-hetu-card-layout") if card_allowed("layouts", raw) => {
                            value.card_layout = Some(raw.into())
                        }
                        ("div", "data-hetu-card-preview") if card_allowed("previews", raw) => {
                            value.card_preview = Some(raw.into())
                        }
                        ("div", "data-hetu-card-color") if valid_color(raw) => {
                            value.card_color = Some(raw.into())
                        }
                        ("div", "data-hetu-card-gradient")
                            if raw.split_once(',').is_some_and(|(a, b)| {
                                a.starts_with('#')
                                    && b.starts_with('#')
                                    && valid_color(a)
                                    && valid_color(b)
                            }) =>
                        {
                            value.card_gradient = Some(raw.into())
                        }
                        ("div", "data-hetu-card-image") if valid_card_image(raw) => {
                            value.card_image = Some(raw.into())
                        }
                        _ => {
                            valid = false;
                            break;
                        }
                    }
                    count += 1;
                }
                (valid && count > 0 && valid_card(&value)).then_some(value)
            }
            _ => None,
        };
        parsed
    };
    Some(Token {
        range: from..to,
        tag: tag.into(),
        close,
        attributes,
    })
}

impl StyleMarkup {
    pub fn parse(source: &str) -> Self {
        if !source.contains("data-hetu-") {
            return Self::default();
        }
        let mut tokens = Vec::new();
        let mut html_block = None;
        let mut excluded = 0;
        for (event, range) in Parser::new(source).into_offset_iter() {
            match event {
                Event::Start(Tag::Link { .. } | Tag::Image { .. }) => excluded += 1,
                Event::End(TagEnd::Link | TagEnd::Image) => excluded -= 1,
                Event::Start(Tag::HtmlBlock) => html_block = Some(range.start),
                Event::End(TagEnd::HtmlBlock) => {
                    if let Some(start) = html_block.take() {
                        if let Some(token) = parse_token(source, start..range.end) {
                            tokens.push(token);
                        }
                    }
                }
                Event::InlineHtml(_) | Event::Html(_) if excluded == 0 && html_block.is_none() => {
                    if let Some(token) = parse_token(source, range) {
                        tokens.push(token);
                    }
                }
                _ => {}
            }
        }
        let mut stack: Vec<Token> = Vec::new();
        let mut spans = Vec::new();
        for token in tokens {
            if !token.close {
                if stack.len() >= CATALOG["max_depth"].as_u64().unwrap_or(16) as usize {
                    return Self::default();
                }
                stack.push(token);
            } else {
                let Some(opening) = stack.pop() else {
                    return Self::default();
                };
                if opening.tag != token.tag {
                    return Self::default();
                }
                if let Some(attributes) = opening.attributes {
                    spans.push(StyledSpan {
                        opening: opening.range,
                        closing: token.range,
                        attributes,
                    });
                }
            }
        }
        if !stack.is_empty() {
            return Self::default();
        }
        spans.sort_by_key(|span| (span.opening.start, std::cmp::Reverse(span.closing.end)));
        Self { spans }
    }
    pub fn is_marker(&self, source: &str, range: &Range<usize>) -> bool {
        let raw = &source[range.clone()];
        let text = raw.trim();
        let from = range.start + raw.find(text).unwrap_or(0);
        let to = from + text.len();
        self.spans
            .iter()
            .any(|span| span.opening == (from..to) || span.closing == (from..to))
    }
    pub fn at(&self, position: usize) -> Presentation {
        let mut result = Presentation::default();
        for span in &self.spans {
            if span.opening.end <= position && position <= span.closing.start {
                result.inherit(&span.attributes);
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_fixtures_keep_source_and_known_attributes() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/manuscript-styles.json"
        ))
        .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let source = fixture["source"].as_str().unwrap();
            let markup = StyleMarkup::parse(source);
            let mut markers: Vec<_> = markup
                .spans
                .iter()
                .flat_map(|span| [span.opening.clone(), span.closing.clone()])
                .collect();
            markers.sort_by_key(|range| range.start);
            let mut visible = String::new();
            let mut cursor = 0;
            for marker in markers {
                visible.push_str(&source[cursor..marker.start]);
                cursor = marker.end;
            }
            visible.push_str(&source[cursor..]);
            assert_eq!(
                visible,
                fixture["without_style"].as_str().unwrap(),
                "{}",
                fixture["name"]
            );
            assert_eq!(
                serde_json::to_value(
                    markup
                        .spans
                        .iter()
                        .map(|span| &span.attributes)
                        .collect::<Vec<_>>()
                )
                .unwrap(),
                fixture["attributes"],
                "{}",
                fixture["name"]
            );
        }
    }
}
