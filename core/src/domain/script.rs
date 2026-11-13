use super::{Result, drama, ensure, plot::TimeOfDay};
use serde_json::{Value, json};

pub const RENDERER_VERSION: &str = "hetu-fountain-structure/1";
pub struct Rendered {
    pub content: String,
    pub scenes: Vec<Value>,
}

// 仅写标题和场景结构。原著证据、批注、人物提示和对白均不进入正文。
pub fn render(
    skeleton: &drama::Skeleton,
    blueprint: &Value,
    title: &str,
    language: &str,
) -> Result<Rendered> {
    ensure(
        matches!(language, "zh-CN" | "en"),
        "invalid_input",
        "剧本语言不受支持。",
    )?;
    line(title)?;
    let mut content = format!("Title: {title}\n\n");
    let mut scenes = Vec::new();
    for episode in &skeleton.episodes {
        let section = if language == "en" {
            format!("Episode {}", episode.episode_number)
        } else {
            format!("第{}集", episode.episode_number)
        };
        line(&episode.title)?;
        content.push_str(&format!(
            "# {section}{}\n\n",
            if episode.title.is_empty() {
                String::new()
            } else {
                format!(" {}", episode.title)
            }
        ));
        for scene in &episode.scenes {
            let location = scene
                .location_ref
                .as_ref()
                .and_then(|reference| {
                    blueprint["locations"]
                        .as_array()?
                        .iter()
                        .find(|l| l["location_id"] == *reference)?["name"]
                        .as_str()
                })
                .unwrap_or(if language == "en" {
                    "LOCATION UNSET"
                } else {
                    "地点待补充"
                });
            line(location)?;
            ensure(
                !location.starts_with('.'),
                "hetu.format_unrepresentable",
                "地点以句点开头，不能直接用作 Fountain 场景标题。",
            )?;
            let prefix = match scene.interior_exterior.as_str() {
                "interior" => "INT. ",
                "exterior" => "EXT. ",
                "mixed" => "INT./EXT. ",
                _ => ".",
            };
            let time = match scene.time_of_day {
                TimeOfDay::Day => " - DAY",
                TimeOfDay::Night => " - NIGHT",
                TimeOfDay::Dawn => " - DAWN",
                TimeOfDay::Dusk => " - DUSK",
                TimeOfDay::Unknown => "",
            };
            let heading = format!(
                "{prefix}{location}{time} #{}-{}#",
                episode.episode_number, scene.scene_number
            );
            let start = content.len();
            content.push_str(&heading);
            let end = content.len();
            content.push_str("\n\n");
            scenes.push(json!({"episode_id":episode.episode_id,"scene_id":scene.scene_id,"episode_number":episode.episode_number,"scene_number":scene.scene_number,"byte_start":start,"byte_end":end,"quote":heading}));
            ensure(
                content.len() <= drama::OUTPUT_LIMIT,
                "hetu.budget_exceeded",
                "结构剧本超过输出预算。",
            )?;
        }
    }
    ensure(!scenes.is_empty(), "invalid_input", "空骨架不能建立剧本。")?;
    Ok(Rendered { content, scenes })
}

fn line(value: &str) -> Result<()> {
    ensure(
        value == value.trim()
            && !value.chars().any(|c| {
                c.is_control()
                    || matches!(c, '\u{2028}' | '\u{2029}' | '#' | '*' | '[' | ']' | '\\')
            }),
        "hetu.format_unrepresentable",
        "标题或地点含有不能直接表示为 Fountain 结构的换行或控制标记，请先修改对应字段。",
    )
}
