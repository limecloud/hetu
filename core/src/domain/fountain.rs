//! 固定Fountain原文的场次范围；只是投影，不生成持久场次身份或改写原稿。
use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Debug, Serialize)]
pub struct Scene {
    pub byte_start: usize,
    pub byte_end: usize,
    pub heading_start: usize,
    pub heading_end: usize,
    pub heading: String,
    pub number: Option<String>,
}
fn space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000b}' | '\u{000c}' | '\r' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
fn title_key(text: &str) -> bool {
    text.split_once(':').is_some_and(|(key, _)| {
        key.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && key
                .bytes()
                .all(|c| c.is_ascii_alphabetic() || c == b' ' || c == b'-')
    })
}
fn natural_scene(text: &str) -> bool {
    static PREFIXES: OnceLock<Vec<String>> = OnceLock::new();
    let prefixes = PREFIXES.get_or_init(|| {
        let source: Value =
            serde_json::from_str(include_str!("../../../contracts/fountain-structure.json"))
                .expect("Fountain structure contract");
        source["scene_prefixes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_ascii_lowercase())
            .collect()
    });
    let lower = text.to_ascii_lowercase();
    prefixes.iter().any(|prefix| {
        lower
            .strip_prefix(prefix)
            .is_some_and(|tail| tail.is_empty() || tail.chars().next().is_some_and(space))
    })
}
fn close(scenes: &mut [Scene], at: usize) {
    if let Some(scene) = scenes.last_mut() {
        scene.byte_end = scene.byte_end.min(at);
    }
}

pub fn scenes(source: &str) -> Vec<Scene> {
    let mut rows = Vec::new();
    let mut start = 0;
    let bytes = source.as_bytes();
    while start < bytes.len() {
        let end = bytes[start..]
            .iter()
            .position(|c| matches!(*c, b'\r' | b'\n'))
            .map(|n| start + n)
            .unwrap_or(bytes.len());
        rows.push((start, &source[start..end]));
        start = end;
        if bytes.get(start) == Some(&b'\r') {
            start += 1;
            if bytes.get(start) == Some(&b'\n') {
                start += 1;
            }
        } else if bytes.get(start) == Some(&b'\n') {
            start += 1;
        }
    }
    let mut first = 0;
    if rows.first().is_some_and(|(_, line)| title_key(line)) {
        while let Some((_, line)) = rows.get(first) {
            let continuation = line.trim_start_matches([' ', '\t']);
            if title_key(line)
                || (continuation.len() < line.len()
                    && continuation.chars().next().is_some_and(|c| !space(c)))
            {
                first += 1;
            } else {
                break;
            }
        }
    }
    let mut scenes = Vec::new();
    let mut omitted = false;
    for (index, (from, raw)) in rows.iter().enumerate().skip(first) {
        let text = raw.trim_matches(space);
        if omitted || text.starts_with("/*") {
            omitted = !text.contains("*/");
            continue;
        }
        if text.is_empty() || text.starts_with("[[") && text.ends_with("]]") {
            continue;
        }
        let previous_blank = index == 0 || rows[index - 1].1.trim_matches(space).is_empty();
        let section = text.trim_start_matches('#');
        let section_prefix = text.len() - section.len();
        if (1..=6).contains(&section_prefix) && section.chars().next().is_some_and(space)
            || text.len() >= 3 && text.bytes().all(|c| c == b'=')
        {
            close(&mut scenes, *from);
            continue;
        }
        if !(text.starts_with('.') && !text.starts_with("..")
            || previous_blank && natural_scene(text))
        {
            continue;
        }
        close(&mut scenes, *from);
        let leading = raw.len() - raw.trim_start_matches(space).len();
        let heading_start = from + leading + usize::from(text.starts_with('.'));
        let mut heading_end = from + leading + text.len();
        let mut number = None;
        if let Some(without_end) = text.strip_suffix('#') {
            if let Some(open) = without_end.rfind('#') {
                let before = &text[..open];
                let value = &without_end[open + 1..];
                if !value.is_empty() && before.chars().last().is_some_and(space) {
                    let before = before.trim_end_matches(space);
                    heading_end = from + leading + before.len();
                    number = Some(value.to_owned());
                }
            }
        }
        heading_end = heading_end.max(heading_start);
        scenes.push(Scene {
            byte_start: *from,
            byte_end: source.len(),
            heading_start,
            heading_end,
            heading: source[heading_start..heading_end].to_owned(),
            number,
        });
    }
    scenes
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_display_fixtures_have_identical_headings_and_valid_original_byte_ranges() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/fountain-scenes.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let source = case["source"].as_str().unwrap();
            let index = scenes(source);
            let headings: Vec<_> = index
                .iter()
                .map(|scene| serde_json::json!({"heading":scene.heading,"number":scene.number}))
                .collect();
            assert_eq!(
                serde_json::json!(headings),
                case["expected"],
                "{}",
                case["name"]
            );
            for (position, scene) in index.iter().enumerate() {
                assert_eq!(
                    &source[scene.heading_start..scene.heading_end],
                    scene.heading
                );
                assert!(
                    scene.byte_start < scene.byte_end
                        && scene.heading_start >= scene.byte_start
                        && scene.heading_end <= scene.byte_end
                );
                assert!(position == 0 || index[position - 1].byte_end <= scene.byte_start);
                assert!(source.get(scene.byte_start..scene.byte_end).is_some());
            }
        }
    }
}
