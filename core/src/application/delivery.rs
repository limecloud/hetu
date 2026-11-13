use super::*;
use crate::domain::delivery_formats::{self, Converted, Source};
use crate::infrastructure::exports::{self, Payload, PayloadData};
use std::collections::BTreeSet;
use std::io::{Read, Seek, SeekFrom, Write};

const PAYLOAD_MEMORY_LIMIT: u64 = 256 * 1024 * 1024;

pub(super) fn definition(name: &str) -> Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    let source = SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../contracts/schemas/delivery.schema.json"
        ))
        .expect("embedded delivery schema")
    });
    domain::schema::definition(source, name)
}

fn seal(mut value: Value) -> Result<Value> {
    value["sha256"] = json!(digest(serde_json_canonicalizer::to_vec(&value)?));
    Ok(value)
}

fn references<'a>(selection: &'a Value, field: &str) -> &'a [Value] {
    selection[field]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn add_payload(
    payloads: &mut Vec<Payload>,
    path: String,
    media_type: &str,
    source: Value,
    content: Vec<u8>,
) -> Result<()> {
    ensure(
        !payloads.iter().any(|payload| payload.path == path),
        "invalid_input",
        "交付选集存在重复文件，请只选一个对象修订。",
    )?;
    let current: u64 = payloads
        .iter()
        .filter_map(|p| match &p.data {
            PayloadData::Bytes(bytes) => Some(bytes.len() as u64),
            _ => None,
        })
        .sum();
    ensure(
        current + content.len() as u64 <= PAYLOAD_MEMORY_LIMIT,
        "hetu.budget_exceeded",
        "本次交付的文本与格式转换产物超过 256 MiB，请缩小选集。",
    )?;
    payloads.push(Payload {
        path,
        media_type: media_type.into(),
        source,
        data: PayloadData::Bytes(content),
    });
    Ok(())
}

fn json_payload(
    payloads: &mut Vec<Payload>,
    path: String,
    source: Value,
    content: &Value,
) -> Result<()> {
    add_payload(payloads, path, "application/json", source, bytes(content)?)
}

fn convert(sources: &[Source], format: &str, profile: &str) -> Result<Converted> {
    if format == "pdf" {
        domain::delivery_pdf::render(sources, profile)
    } else {
        delivery_formats::render(sources, format, profile)
    }
}

struct Prepared {
    preview: Value,
    payloads: Vec<Payload>,
    document: Option<Converted>,
}

impl Kernel {
    fn delivery_sources(
        &self,
        refs: &[Value],
        production: bool,
    ) -> Result<(Vec<Source>, Vec<Value>, Vec<Value>, Vec<Value>)> {
        ensure(
            !refs.is_empty() && refs.len() <= 128,
            "invalid_input",
            "请选择 1～128 个固定正文修订。",
        )?;
        let mut sources = Vec::new();
        let mut inputs = Vec::new();
        let mut blockers = Vec::new();
        let mut provenance = Vec::new();
        let mut source_bytes = 0usize;
        let mut seen = BTreeSet::new();
        let author = self
            .novel()?
            .and_then(|novel| novel["metadata"]["author_name"].as_str().map(str::to_owned))
            .unwrap_or_default();
        for reference in refs {
            let doc_id = text(reference, "document_id")?;
            ensure(
                seen.insert(doc_id.to_owned()),
                "invalid_input",
                "同一本次交付中不能重复选择同一文档。",
            )?;
            self.document_root(doc_id)?;
            let fixed = self.document_content(doc_id, Some(text(reference, "revision_id")?))?;
            let document = &fixed["document"];
            let content = text(&fixed, "content")?;
            source_bytes = source_bytes
                .checked_add(content.len())
                .ok_or_else(|| Error::new("hetu.budget_exceeded", "正文大小溢出。"))?;
            ensure(
                source_bytes <= delivery_formats::TEXT_LIMIT,
                "hetu.budget_exceeded",
                "本次交付正文合计超过 16 MiB，请缩小选集。",
            )?;
            ensure(
                document["draft_source_id"].is_null()
                    && matches!(
                        document["kind"].as_str(),
                        Some("novel_chapter" | "drama_script")
                    ),
                "forbidden",
                "交付选集仅接受作者正文，不能把参考稿证据当作定稿。",
            )?;
            ensure(
                fixed["revision"]["sha256"] == reference["sha256"],
                "hetu.integrity_failure",
                "所选正文摘要与不可变修订不符。",
            )?;
            let confirmed = !document["finalization_ref"].is_null()
                && document["approved_revision_id"] == reference["revision_id"]
                && document["finalization_ref"] == reference["finalization_ref"];
            if production && !confirmed {
                blockers.push(json!({"code":"hetu.finalization_required","document_id":doc_id,"message":"正式交付必须选择仍有效的作者定稿及其确切确认记录。"}));
            }
            let mut finalization = Value::Null;
            if confirmed {
                let history = self.document_lifecycle(&json!({"document_id":doc_id}))?;
                let record = history["finalizations"]
                    .as_array()
                    .and_then(|records| {
                        records.iter().find(|record| {
                            record["finalization_id"]
                                == document["finalization_ref"]["finalization_id"]
                        })
                    })
                    .ok_or_else(|| Error::new("hetu.integrity_failure", "定稿确认记录不存在。"))?;
                ensure(
                    record["decision"] == "confirmed"
                        && record["document_ref"]["revision_id"] == reference["revision_id"]
                        && record["document_ref"]["sha256"] == reference["sha256"],
                    "hetu.integrity_failure",
                    "定稿记录与所选正文修订不一致。",
                )?;
                finalization = json!({"reference":document["finalization_ref"],"created_at":record["created_at"],"report_refs":record["report_refs"],"coverage_acknowledgement":record["coverage_acknowledgement"]});
            }
            let mut fixed_ref = reference.clone();
            fixed_ref["finalization_ref"] = if confirmed {
                document["finalization_ref"].clone()
            } else {
                Value::Null
            };
            inputs.push(fixed_ref.clone());
            // 仅投影实际采纳的来源摘要，不携带参考稿快照、私有批注或 Prompt。
            provenance.push(json!({"document_ref":fixed_ref,"title":document["title"],"source_format":fixed["revision"]["source_format"],"origin_kind":fixed["revision"]["origin_kind"],"import_ref":fixed["revision"]["import_ref"],"finalization":finalization,"contribution_refs":fixed["revision"]["contribution_refs"].as_array().cloned().unwrap_or_default()}));
            sources.push(Source {
                title: text(document, "title")?.into(),
                author: author.clone(),
                kind: text(document, "kind")?.into(),
                source_format: text(&fixed["revision"], "source_format")?.into(),
                language_tag: document["language_tag"].as_str().unwrap_or("zh-CN").into(),
                content: content.into(),
            });
        }
        Ok((sources, inputs, blockers, provenance))
    }

    fn prepare_bundle(&self, request: &Value) -> Result<Prepared> {
        let selection = &request["selection"];
        let production = request["profile"] == "production_delivery";
        let bp_ref = &selection["blueprint_ref"];
        let (bp, bp_sha) = self.blueprint_revision(Some(integer(bp_ref, "revision")?))?;
        ensure(
            bp_ref["sha256"] == bp_sha,
            "hetu.integrity_failure",
            "设定集固定摘要不符。",
        )?;
        let (sources, documents, mut blockers, provenance) =
            self.delivery_sources(references(selection, "document_refs"), production)?;
        for source in sources
            .iter()
            .filter(|source| source.kind == "drama_script")
        {
            let (paragraphs, _) = delivery_formats::paragraphs(std::slice::from_ref(source))?;
            let scenes: Vec<_> = paragraphs
                .iter()
                .filter(|paragraph| paragraph.style == delivery_formats::ParagraphStyle::Scene)
                .collect();
            let incomplete = scenes.is_empty()
                || scenes.iter().any(|scene| {
                    let heading = scene.text.to_uppercase();
                    !["INT.", "EXT.", "INT./EXT.", "I/E.", "EST."]
                        .iter()
                        .any(|prefix| heading.starts_with(prefix))
                        || ![" - DAY", " - NIGHT", " - DAWN", " - DUSK"]
                            .iter()
                            .any(|time| heading.contains(time))
                        || heading.contains("地点待补充")
                        || heading.contains("LOCATION UNSET")
                });
            if production && incomplete {
                blockers.push(json!({"code":"hetu.incomplete_screenplay","title":source.title,"message":"正式剧本交付需要可核对的场景、内外景和日夜；请补齐或选择审阅包。"}));
            }
        }
        let mut inputs = json!({"blueprint_ref":bp_ref,"document_refs":documents,"skeleton_refs":[],"report_refs":[],"comparison_refs":[],"cue_refs":[],"asset_refs":[]});
        let mut payloads = Vec::new();
        let mut warnings = Vec::new();
        let mut reviews = Vec::new();
        let mut exclusions = vec![
            json!({"kind":"private_workspace_data","reason":"不包含 Prompt、未采用候选、私有批注、inbox、配对材料、凭据、恢复日志、缓存及 Git 对象库。"}),
        ];
        json_payload(
            &mut payloads,
            "shared/blueprint.json".into(),
            bp_ref.clone(),
            &bp,
        )?;
        for (index, source) in sources.iter().enumerate() {
            let reference = &documents[index];
            let extension = if source.source_format == "fountain" {
                "fountain"
            } else {
                "md"
            };
            let package = if source.kind == "drama_script" {
                "drama/scripts"
            } else {
                "novel"
            };
            let path = format!(
                "{package}/{:03}-{}.{extension}",
                index + 1,
                text(reference, "document_id")?
            );
            let rendered = convert(
                std::slice::from_ref(source),
                if extension == "md" {
                    "markdown"
                } else {
                    "fountain"
                },
                "source/1",
            )?;
            if rendered.report["losses"]
                .as_array()
                .is_some_and(|losses| !losses.is_empty())
            {
                warnings.push(json!({"code":"source_projection","document_ref":reference,"report":rendered.report}));
            }
            json_payload(
                &mut payloads,
                format!("{path}.report.json"),
                reference.clone(),
                &rendered.report,
            )?;
            add_payload(
                &mut payloads,
                path,
                rendered.media_type,
                reference.clone(),
                rendered.bytes,
            )?;
        }
        let reading_formats = request["reading_formats"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![json!("docx"), json!("pdf")]);
        for kind in ["novel_chapter", "drama_script"] {
            let selected_refs: Vec<Value> = sources
                .iter()
                .zip(documents.iter())
                .filter(|(source, _)| source.kind == kind)
                .map(|(_, reference)| reference.clone())
                .collect();
            let selected: Vec<Source> = sources
                .iter()
                .filter(|source| source.kind == kind)
                .map(|source| Source {
                    title: source.title.clone(),
                    author: source.author.clone(),
                    kind: source.kind.clone(),
                    source_format: source.source_format.clone(),
                    language_tag: source.language_tag.clone(),
                    content: source.content.clone(),
                })
                .collect();
            if selected.is_empty() {
                continue;
            }
            let name = if kind == "drama_script" {
                "drama"
            } else {
                "novel"
            };
            for format in &reading_formats {
                let format = format.as_str().unwrap();
                let profile = if kind == "drama_script" {
                    "hetu-screenplay-zh/1"
                } else {
                    "hetu-novel-zh/1"
                };
                let rendered = convert(&selected, format, profile)?;
                if rendered.report["losses"]
                    .as_array()
                    .is_some_and(|losses| !losses.is_empty())
                    || rendered.report["warnings"]
                        .as_array()
                        .is_some_and(|values| !values.is_empty())
                {
                    warnings.push(json!({"code":"format_conversion","kind":name,"format":format,"report":rendered.report}));
                }
                let path = format!("reading/{name}.{}", rendered.extension);
                json_payload(
                    &mut payloads,
                    format!("reading/{name}-{}.report.json", rendered.extension),
                    json!({"kind":"conversion_report","profile":profile}),
                    &rendered.report,
                )?;
                add_payload(
                    &mut payloads,
                    path,
                    rendered.media_type,
                    json!({"kind":"reading_copy","profile":profile,"document_refs":selected_refs}),
                    rendered.bytes,
                )?;
            }
        }
        for reference in references(selection, "skeleton_refs") {
            let (skeleton, sha) = self.read_skeleton(
                text(reference, "skeleton_id")?,
                Some(integer(reference, "revision")?),
            )?;
            ensure(
                reference["sha256"] == sha,
                "hetu.integrity_failure",
                "骨架修订摘要不符。",
            )?;
            if serde_json::to_value(&skeleton)?["status"] == "partial" {
                warnings.push(json!({"code":"partial_skeleton","reference":reference}));
            }
            json_payload(
                &mut payloads,
                format!(
                    "drama/skeletons/{}-{}.json",
                    skeleton.skeleton_id, skeleton.revision
                ),
                reference.clone(),
                &serde_json::to_value(skeleton)?,
            )?;
            inputs["skeleton_refs"]
                .as_array_mut()
                .unwrap()
                .push(reference.clone());
        }
        let mut report_refs = references(selection, "report_refs").to_vec();
        if report_refs.is_empty() {
            for entry in &provenance {
                for reference in references(&entry["finalization"], "report_refs") {
                    if !report_refs.contains(reference) {
                        report_refs.push(reference.clone());
                    }
                }
            }
        }
        for reference in report_refs {
            let report = self.read_report(text(&reference, "report_id")?)?;
            let state = self.report_result(&report, true)?;
            ensure(
                state["reference"] == reference,
                "hetu.stale_evidence",
                "所选诊断报告或作者处置记录已变化。",
            )?;
            let covered = report["input_snapshot"]["blueprint_revision"] == bp_ref["revision"]
                && report["input_snapshot"]["blueprint_sha256"] == bp_ref["sha256"]
                && documents.iter().all(|selected| {
                    references(&report["input_snapshot"], "source_revisions")
                        .iter()
                        .any(|source| {
                            ["document_id", "revision_id", "sha256"]
                                .iter()
                                .all(|field| source[*field] == selected[*field])
                        })
                });
            if !covered || report["status"] == "partial" {
                warnings.push(json!({"code":"report_coverage","reference":reference,"message":"报告只描述清单内的固定输入；部分覆盖或不同设定集不能解释为最新完整检查。"}));
            }
            // 不发布处置历史中的私有文字，只保留结论及固定报告。
            json_payload(
                &mut payloads,
                format!("reports/{}.json", text(&reference, "report_id")?),
                reference.clone(),
                &report,
            )?;
            let dispositions: Vec<Value> = references(&state, "dispositions").iter().map(|entry| json!({"finding_id":entry["finding_id"],"disposition":entry["current"]["disposition"],"created_at":entry["current"]["created_at"]})).collect();
            reviews.push(json!({"report_ref":reference,"dispositions":dispositions}));
            inputs["report_refs"]
                .as_array_mut()
                .unwrap()
                .push(reference);
        }
        for reference in references(selection, "comparison_refs") {
            let comparison =
                self.get_comparison(&json!({"comparison_id":reference["comparison_id"]}))?;
            let report = &comparison["comparison"];
            ensure(
                digest(serde_json::to_vec(report)?) == reference["sha256"],
                "hetu.integrity_failure",
                "改编差异报告摘要不符。",
            )?;
            json_payload(
                &mut payloads,
                format!("reports/{}.json", text(reference, "comparison_id")?),
                reference.clone(),
                report,
            )?;
            inputs["comparison_refs"]
                .as_array_mut()
                .unwrap()
                .push(reference.clone());
        }
        for reference in references(selection, "cue_refs") {
            let value = self
                .get_cue(&json!({"cue_id":reference["cue_id"],"revision":reference["revision"]}))?;
            ensure(
                value["sha256"] == reference["sha256"],
                "hetu.integrity_failure",
                "线索修订摘要不符。",
            )?;
            let cue = &value["cue"];
            if references(cue, "narrative_refs").iter().any(|source| {
                !documents.iter().any(|document| {
                    document["document_id"] == source["document_id"]
                        && document["revision_id"] == source["revision_id"]
                })
            }) {
                warnings.push(json!({"code":"cue_source_not_selected","cue_ref":reference,"message":"所选线索引用了未包含在本包中的正文修订；本包仅保留这些来源引用。"}));
            }
            if references(cue, "asset_refs")
                .iter()
                .any(|asset| !references(selection, "asset_refs").contains(asset))
            {
                warnings.push(json!({"code":"cue_asset_not_selected","cue_ref":reference,"message":"所选线索的部分关联素材未选入本包，未自动附带这些媒体。"}));
            }
            json_payload(
                &mut payloads,
                format!(
                    "cues/{}/{}.json",
                    if cue["kind"] == "music" {
                        "music"
                    } else {
                        "visual"
                    },
                    text(reference, "cue_id")?
                ),
                reference.clone(),
                cue,
            )?;
            inputs["cue_refs"]
                .as_array_mut()
                .unwrap()
                .push(reference.clone());
        }
        for reference in references(selection, "asset_refs") {
            let value = self.asset_delivery_metadata(
                &json!({"asset_id":reference["asset_id"],"revision":reference["revision"]}),
            )?;
            ensure(
                value["sha256"] == reference["sha256"],
                "hetu.integrity_failure",
                "素材元数据修订摘要不符。",
            )?;
            let asset = &value["asset"];
            let mut public = asset.clone();
            public["blob"].as_object_mut().unwrap().remove("path");
            if value["delivery_eligible"] == true {
                let ext = Path::new(text(&asset["blob"], "path")?)
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .ok_or_else(|| Error::new("hetu.integrity_failure", "受管素材缺少扩展名。"))?;
                let path = format!("assets/{}/source.{ext}", text(reference, "asset_id")?);
                public["blob"]["bundle_path"] = json!(path);
                payloads.push(Payload {
                    path,
                    media_type: text(&asset["blob"], "media_type")?.into(),
                    source: reference.clone(),
                    data: PayloadData::File {
                        file: self.store.managed_media(text(&asset["blob"], "path")?)?,
                        size: integer(&asset["blob"], "size_bytes")?,
                        sha256: text(&asset["blob"], "sha256")?.into(),
                    },
                });
            } else {
                exclusions.push(json!({"asset_ref":reference,"reason":"所选或当前权利声明不允许默认再分发，仅包含元数据。"}));
            }
            json_payload(
                &mut payloads,
                format!("assets/{}/metadata.json", text(reference, "asset_id")?),
                reference.clone(),
                &public,
            )?;
            inputs["asset_refs"]
                .as_array_mut()
                .unwrap()
                .push(json!({"reference":reference,"embedded":value["delivery_eligible"]}));
        }
        if !production {
            warnings.push(json!({"code":"review_delivery","message":"本包用于审阅，不能把未定稿内容作为正式定稿。"}));
        }
        if inputs["report_refs"].as_array().unwrap().is_empty() {
            warnings.push(json!({"code":"reports_not_selected","message":"未包含诊断报告，不表示作品已经通过完整检查。"}));
        }
        if production {
            for reference in &documents {
                if reference["finalization_ref"].is_null()
                    && !blockers
                        .iter()
                        .any(|blocker| blocker["document_id"] == reference["document_id"])
                {
                    blockers.push(json!({"code":"hetu.finalization_required","document_id":reference["document_id"]}));
                }
            }
        }
        json_payload(
            &mut payloads,
            "provenance/version-log.json".into(),
            json!({"kind":"fixed_revision_history"}),
            &json!({"documents":provenance}),
        )?;
        json_payload(
            &mut payloads,
            "provenance/reviews.json".into(),
            json!({"kind":"public_review_summary"}),
            &json!({"reports":reviews}),
        )?;
        let mut reading = format!(
            "# 河图洛书交付包\n\n交付配置：{}\n\n本包只包含 manifest.json 中列明的固定修订。正式定稿以作者确认记录为准，审阅包不能代替定稿。\n\n## 内容\n\n",
            text(request, "profile")?
        );
        for payload in &payloads {
            reading.push_str(&format!("- `{}`\n", payload.path));
        }
        reading.push_str("\n## 范围与权利\n\n清单与 SHA-256 用于检查文件完整性，不证明版权或来源声明真实。未包含的素材、格式转换损失和诊断覆盖范围见下方记录。私有批注、完整 Prompt、凭据和恢复日志不在交付范围内。\n\n");
        for item in warnings
            .iter()
            .chain(exclusions.iter())
            .chain(blockers.iter())
        {
            for message in delivery_issue_messages(item) {
                reading.push_str(&format!("- {message}\n"));
            }
        }
        add_payload(
            &mut payloads,
            "DELIVERY.md".into(),
            "text/markdown",
            json!({"kind":"delivery_instructions"}),
            reading.into_bytes(),
        )?;
        let descriptors: Vec<Value> = payloads.iter().map(Payload::descriptor).collect();
        let estimated: u64 = descriptors
            .iter()
            .filter_map(|file| file["size_bytes"].as_u64())
            .sum();
        ensure(
            estimated <= 4 * 1024 * 1024 * 1024,
            "hetu.budget_exceeded",
            "交付包展开总量超过 4 GiB。",
        )?;
        let preview = seal(
            json!({"workspace_id":self.scope(),"request":request,"inputs":inputs,"files":descriptors,"warnings":warnings,"exclusions":exclusions,"blockers":blockers,"eligible":blockers.is_empty(),"estimated_bytes":estimated,"coverage":{"kind":"fixed_inputs","semantic_completeness":"not_asserted"}}),
        )?;
        Ok(Prepared {
            preview,
            payloads,
            document: None,
        })
    }

    fn prepare_document_export(&self, request: &Value) -> Result<Prepared> {
        let (sources, inputs, _, provenance) =
            self.delivery_sources(references(request, "revision_refs"), false)?;
        let rendered = convert(
            &sources,
            text(request, "format")?,
            text(request, "profile")?,
        )?;
        let descriptor = json!({"path":format!("document.{}",rendered.extension),"size_bytes":rendered.bytes.len(),"sha256":digest(&rendered.bytes),"media_type":rendered.media_type});
        let preview = seal(
            json!({"workspace_id":self.scope(),"request":request,"inputs":{"document_refs":inputs},"files":[descriptor],"warnings":[{"code":"format_report","report":rendered.report}],"exclusions":[],"blockers":[],"eligible":true,"estimated_bytes":rendered.bytes.len(),"coverage":{"kind":"selected_revisions","finalization":"see_provenance"},"provenance":provenance}),
        )?;
        Ok(Prepared {
            preview,
            payloads: Vec::new(),
            document: Some(rendered),
        })
    }

    pub(super) fn preview_bundle(&self, input: &Value) -> Result<Value> {
        Ok(json!({"preview":self.prepare_bundle(input)?.preview}))
    }

    pub(super) fn preview_document_export(&self, input: &Value) -> Result<Value> {
        Ok(json!({"preview":self.prepare_document_export(input)?.preview}))
    }
}

impl Kernel {
    fn delivery_context(&self) -> Result<()> {
        self.store.recover()?;
        ensure(
            digest(self.store.read(self.config_path())?) == self.config_sha,
            "revision_conflict",
            "作品配置已变化，请重新打开。",
        )?;
        self.check_task_session()
    }

    fn prepare_delivery(&self, action: &str, preview: &Value) -> Result<Prepared> {
        ensure(
            preview["workspace_id"] == self.scope(),
            "forbidden",
            "交付预览属于其他作品。",
        )?;
        let bundle = action == "hetu.bundles.export";
        schema(
            &preview["request"],
            &definition(if bundle {
                "bundle_preview_input"
            } else {
                "document_preview_input"
            }),
        )?;
        let prepared = if bundle {
            self.prepare_bundle(&preview["request"])?
        } else {
            self.prepare_document_export(&preview["request"])?
        };
        ensure(
            prepared.preview == *preview,
            "revision_conflict",
            "交付预览或所选输入已变化，请重新预览并确认。",
        )?;
        ensure(
            preview["eligible"] == true,
            "hetu.finalization_required",
            "交付仍有阻断项，请先处理。",
        )?;
        Ok(prepared)
    }

    pub(super) fn execute_delivery(
        &self,
        action: &str,
        input: &Value,
        metadata: &Value,
    ) -> Result<Value> {
        ensure(
            !text(input, "acknowledgement")?.trim().is_empty(),
            "hetu.author_confirmation_required",
            "请确认所选内容、格式损失及素材权利范围。",
        )?;
        let key = text(input, "operation_key")?;
        let input_digest = Self::input_digest(input)?;
        let op_path = self.operation_record_path(action, key);
        let lock = self.store.lock()?;
        self.delivery_context()?;
        self.store.directory(".hetu/deliveries")?;
        self.store.directory(".hetu/bundles")?;
        self.store.directory("exports")?;
        let (intent, operation, mut prepared) = if self.store.exists(&op_path)? {
            let previous = self.store.json(&op_path)?;
            self.check_operation_task(&previous)?;
            ensure(
                previous["input_digest"] == input_digest
                    && previous["result"]["contract_revision"] == metadata["contract_revision"],
                "idempotency_conflict",
                "原操作键已绑定其他输入或合同版本。",
            )?;
            if previous["result"]["status"] == "succeeded" {
                return Ok(previous["result"].clone());
            }
            let delivery_id = checked_id(text(&previous, "delivery_id")?, "delivery")?;
            let intent = self
                .store
                .json(&format!(".hetu/deliveries/{delivery_id}/intent.json"))?;
            ensure(
                previous["intent_sha256"] == digest(bytes(&intent)?)
                    && intent["action"] == action
                    && intent["preview"] == input["preview"],
                "hetu.integrity_failure",
                "原交付意图与操作记录不一致。",
            )?;
            (intent, previous["result"]["operation"].clone(), None)
        } else {
            let prepared = self.prepare_delivery(action, &input["preview"])?;
            let delivery_id = id("delivery");
            let bundle = action == "hetu.bundles.export";
            let artifact_id = id(if bundle { "bundle" } else { "export" });
            let extension = prepared
                .document
                .as_ref()
                .map(|document| document.extension)
                .unwrap_or("zip");
            let destination = format!(
                "exports/hetu-{}-{artifact_id}.{extension}",
                if bundle { "bundle" } else { "document" }
            );
            let manifest = if bundle {
                json!({"schema_version":"1.0.0","bundle_id":artifact_id,"workspace_id":self.scope(),"title":self.config["title"],"created_at":now(),"provenance":{"engine_build":env!("CARGO_PKG_VERSION"),"converter":delivery_formats::CONVERTER,"version_log":"provenance/version-log.json","reviews":"provenance/reviews.json"},"profile":input["preview"]["request"]["profile"],"preview_sha256":input["preview"]["sha256"],"inputs":input["preview"]["inputs"],"files":input["preview"]["files"],"warnings":input["preview"]["warnings"],"exclusions":input["preview"]["exclusions"],"coverage":input["preview"]["coverage"]})
            } else {
                Value::Null
            };
            let intent = json!({"schema_version":"1.0.0","delivery_id":delivery_id,"artifact_id":artifact_id,"action":action,"destination":destination,"preview":input["preview"],"manifest":manifest,"created_at":now()});
            let operation = Self::operation(key, &input_digest);
            let mut pending = domain::failure(
                action,
                self.scope(),
                &Error::new(
                    "result_unknown",
                    "交付已登记；请使用原操作键恢复，勿创建第二份交付。",
                ),
            );
            pending["operation"] = operation.clone();
            pending["data"] = json!({"delivery_id":delivery_id,"artifact_id":artifact_id});
            let record = json!({"operation_id":operation["id"],"action":action,"key":key,"actor_scope":"author","input_digest":input_digest,"delivery_id":delivery_id,"intent_sha256":digest(bytes(&intent)?),"result":pending});
            let mut changes = Changes::new();
            changes.insert(
                format!(".hetu/deliveries/{delivery_id}/intent.json"),
                bytes(&intent)?,
            );
            changes.insert(op_path.clone(), bytes(&record)?);
            self.store.transaction(&changes)?;
            (intent, operation, Some(prepared))
        };
        let delivery_id = checked_id(text(&intent, "delivery_id")?, "delivery")?;
        let _lease = self.store.lock_delivery(&delivery_id)?;
        let staging = format!(".hetu/deliveries/{delivery_id}/artifact.tmp");
        let ready_path = format!(".hetu/deliveries/{delivery_id}/ready.json");
        let destination = text(&intent, "destination")?;
        // 已发布但回执尚未落盘时，优先核验原产物；不因当前写作稿前进生成第二份文件。
        if self
            .store
            .recover_export_publication(&staging, destination)?
        {
            let ready = self.store.json(&ready_path)?;
            drop(lock);
            self.verify_delivery_artifact(&intent, &ready)?;
            let _lock = self.store.lock()?;
            self.delivery_context()?;
            return self.complete_delivery(
                &intent,
                &operation,
                &op_path,
                &input_digest,
                &ready,
                metadata,
            );
        }
        if prepared.is_none() {
            prepared = Some(self.prepare_delivery(action, &intent["preview"])?);
        }
        let mut prepared = prepared.unwrap();
        if self.store.exists(&staging)? {
            self.store.discard_export_staging(&staging)?;
        }
        let mut file = self.store.create_export_file(&staging)?;
        drop(lock);
        let generated = (|| -> Result<Value> {
            let info = if action == "hetu.bundles.export" {
                let (mut completed, info) =
                    exports::write_bundle(file, &intent["manifest"], &mut prepared.payloads)?;
                let verified = exports::verify_bundle(&mut completed)?;
                ensure(
                    verified["manifest"] == intent["manifest"]
                        && verified["sha256"] == info["sha256"],
                    "hetu.integrity_failure",
                    "交付包写入后核验失败。",
                )?;
                info
            } else {
                let document = prepared.document.take().unwrap();
                file.write_all(&document.bytes)?;
                file.sync_all()?;
                let info = file_summary(&mut file)?;
                ensure(
                    info["sha256"] == intent["preview"]["files"][0]["sha256"],
                    "hetu.integrity_failure",
                    "格式文件写入摘要不符。",
                )?;
                info
            };
            Ok(
                json!({"delivery_id":delivery_id,"intent_sha256":digest(bytes(&intent)?),"artifact":info}),
            )
        })();
        let ready = match generated {
            Ok(value) => value,
            Err(error) => {
                let mut output = self.delivery_unknown(
                    action,
                    &operation,
                    &delivery_id,
                    "文件生成或核验未完成；保留原操作键和临时文件以便恢复。",
                );
                output["data"]["cause"] = json!({"code":error.code,"message":error.message});
                return Ok(output);
            }
        };
        let _lock = match self.store.lock() {
            Ok(lock) => lock,
            Err(_) => {
                return Ok(self.delivery_unknown(
                    action,
                    &operation,
                    &delivery_id,
                    "文件已生成，作品正在被其他操作使用；请查询并恢复原操作。",
                ));
            }
        };
        self.delivery_context()?;
        // 压缩期间允许继续写作；发布前复核定稿未撤回、素材再分发权利未撤回。
        self.recheck_delivery_authority(&intent["preview"], action)?;
        self.store.install(&ready_path, &bytes(&ready)?, false)?;
        if self
            .store
            .publish_export_file(&staging, destination)
            .is_err()
        {
            return Ok(self.delivery_unknown(
                action,
                &operation,
                &delivery_id,
                "发布结果尚待核验，请恢复原操作，勿换键重试。",
            ));
        }
        self.complete_delivery(
            &intent,
            &operation,
            &op_path,
            &input_digest,
            &ready,
            metadata,
        )
    }

    fn delivery_unknown(
        &self,
        action: &str,
        operation: &Value,
        delivery_id: &str,
        message: &str,
    ) -> Value {
        let mut output =
            domain::failure(action, self.scope(), &Error::new("result_unknown", message));
        output["operation"] = operation.clone();
        output["data"] = json!({"delivery_id":delivery_id});
        output
    }

    fn recheck_delivery_authority(&self, preview: &Value, action: &str) -> Result<()> {
        let production = action == "hetu.bundles.export"
            && preview["request"]["profile"] == "production_delivery";
        let (_, refs, blockers, _) =
            self.delivery_sources(references(&preview["inputs"], "document_refs"), production)?;
        ensure(
            blockers.is_empty()
                && refs.as_slice() == references(&preview["inputs"], "document_refs"),
            "hetu.stale_evidence",
            "交付所选定稿或来源已变化，请重新预览。",
        )?;
        for entry in references(&preview["inputs"], "asset_refs") {
            let reference = &entry["reference"];
            let asset = self.asset_delivery_metadata(
                &json!({"asset_id":reference["asset_id"],"revision":reference["revision"]}),
            )?;
            ensure(
                entry["embedded"] != true || asset["delivery_eligible"] == true,
                "hetu.stale_evidence",
                "素材交付权利已撤回，不能发布旧预览。",
            )?;
        }
        for reference in references(&preview["inputs"], "report_refs") {
            let report = self.read_report(text(reference, "report_id")?)?;
            ensure(
                self.report_result(&report, true)?["reference"] == *reference,
                "hetu.stale_evidence",
                "报告处置已变化，请重新预览交付。",
            )?;
        }
        Ok(())
    }

    fn verify_delivery_artifact(&self, intent: &Value, ready: &Value) -> Result<Value> {
        ensure(
            ready["delivery_id"] == intent["delivery_id"]
                && ready["intent_sha256"] == digest(bytes(intent)?),
            "hetu.integrity_failure",
            "产物摘要记录与原交付意图不符。",
        )?;
        let mut file = self.store.open_export_file(text(intent, "destination")?)?;
        let verified = if intent["action"] == "hetu.bundles.export" {
            let value = exports::verify_bundle(&mut file)?;
            ensure(
                value["manifest"] == intent["manifest"],
                "hetu.integrity_failure",
                "交付包清单与原操作不符。",
            )?;
            value
        } else {
            let value = file_summary(&mut file)?;
            ensure(
                value["sha256"] == intent["preview"]["files"][0]["sha256"]
                    && value["size_bytes"] == intent["preview"]["files"][0]["size_bytes"],
                "hetu.integrity_failure",
                "格式产物偏离作者确认的输出摘要。",
            )?;
            value
        };
        ensure(
            verified["sha256"] == ready["artifact"]["sha256"]
                && verified["size_bytes"] == ready["artifact"]["size_bytes"],
            "hetu.integrity_failure",
            "已发布产物被修改，请保留证据。",
        )?;
        Ok(verified)
    }

    fn complete_delivery(
        &self,
        intent: &Value,
        operation: &Value,
        op_path: &str,
        input_digest: &str,
        ready: &Value,
        metadata: &Value,
    ) -> Result<Value> {
        let action = text(intent, "action")?;
        let data = json!({"delivery_id":intent["delivery_id"],"artifact_id":intent["artifact_id"],"bundle_id":if action=="hetu.bundles.export" {intent["artifact_id"].clone()} else {Value::Null},"path":intent["destination"],"sha256":ready["artifact"]["sha256"],"size_bytes":ready["artifact"]["size_bytes"],"preview_sha256":intent["preview"]["sha256"],"manifest":intent["manifest"],"conversion_report":intent["preview"]["warnings"],"provenance":intent["preview"]["provenance"]});
        let mut output = domain::success(action, self.scope(), data.clone());
        output["contract_revision"] = metadata["contract_revision"].clone();
        output["operation"] = operation.clone();
        let mut changes = Changes::new();
        let record = json!({"operation_id":operation["id"],"action":action,"key":operation["key"],"input_digest":input_digest,"actor_scope":"author","result":output});
        changes.insert(op_path.into(), bytes(&record)?);
        changes.insert(
            format!(
                ".hetu/deliveries/{}/receipt.json",
                text(intent, "delivery_id")?
            ),
            bytes(&data)?,
        );
        if action == "hetu.bundles.export" {
            changes.insert(format!(".hetu/bundles/{}.json",text(intent,"artifact_id")?),bytes(&json!({"delivery_id":intent["delivery_id"],"path":intent["destination"],"sha256":ready["artifact"]["sha256"]}))?);
        }
        changes.insert(format!(".hetu/audit/{}.json",text(operation,"id")?),bytes(&json!({"schema_version":"1.0.0","operation_id":operation["id"],"action":action,"actor_ref":self.actor(),"input_digest":input_digest,"created_at":now(),"status":"succeeded"}))?);
        match self.store.transaction(&changes) {
            Ok(()) => Ok(output),
            Err(_) => Ok(self.delivery_unknown(
                action,
                operation,
                text(intent, "delivery_id")?,
                "产物已发布，回执登记未完成，请恢复原操作。",
            )),
        }
    }

    pub(super) fn verify_delivery_bundle(&self, input: &Value) -> Result<Value> {
        let bundle_id = checked_id(text(input, "bundle_id")?, "bundle")?;
        let index = self
            .store
            .json(&format!(".hetu/bundles/{bundle_id}.json"))?;
        let delivery_id = checked_id(text(&index, "delivery_id")?, "delivery")?;
        let intent = self
            .store
            .json(&format!(".hetu/deliveries/{delivery_id}/intent.json"))?;
        ensure(
            intent["artifact_id"] == bundle_id && intent["destination"] == index["path"],
            "hetu.integrity_failure",
            "交付包索引与原操作不一致。",
        )?;
        let ready = self
            .store
            .json(&format!(".hetu/deliveries/{delivery_id}/ready.json"))?;
        let verified = self.verify_delivery_artifact(&intent, &ready)?;
        ensure(
            index["sha256"] == verified["sha256"],
            "hetu.integrity_failure",
            "交付包摘要与索引不符。",
        )?;
        Ok(verified)
    }

    fn prepare_document_import(&self, request: &Value) -> Result<(Value, Vec<u8>)> {
        schema(request, &definition("import_preview_input"))?;
        let mut file =
            crate::infrastructure::media::selected_file(Path::new(text(request, "file_path")?))?;
        let before = file.metadata()?;
        ensure(
            file.metadata()?.len() <= 8 * 1024 * 1024,
            "hetu.budget_exceeded",
            "导入源文件超过 8 MiB，请拆分后导入。",
        )?;
        let mut original = Vec::new();
        Read::by_ref(&mut file)
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut original)?;
        ensure(
            original.len() <= 8 * 1024 * 1024,
            "hetu.budget_exceeded",
            "导入文件读取期间超过预算。",
        )?;
        ensure(
            stable_file(&before, &file.metadata()?) && before.len() == original.len() as u64,
            "revision_conflict",
            "导入文件在读取期间发生变化，请重新选择。",
        )?;
        let converted = delivery_formats::import(
            &original,
            text(request, "format")?,
            text(request, "profile")?,
        )?;
        ensure(
            converted["content"]
                .as_str()
                .is_some_and(|content| content.len() <= 8 * 1024 * 1024),
            "hetu.budget_exceeded",
            "转换正文超过导入预算。",
        )?;
        let preview = seal(
            json!({"workspace_id":self.scope(),"request":request,"source_sha256":digest(&original),"source_size_bytes":original.len(),"converted":converted}),
        )?;
        ensure(
            bytes(&preview)?.len() <= 12 * 1024 * 1024,
            "hetu.budget_exceeded",
            "导入预览超过交互预算。",
        )?;
        Ok((preview, original))
    }

    pub(super) fn preview_document_import(&self, input: &Value) -> Result<Value> {
        Ok(json!({"preview":self.prepare_document_import(input)?.0}))
    }

    pub(super) fn import_document(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        ensure(
            !text(input, "acknowledgement")?.trim().is_empty(),
            "hetu.author_confirmation_required",
            "请先确认导入预览与格式损失。",
        )?;
        let (preview, original) = self.prepare_document_import(&input["preview"]["request"])?;
        ensure(
            preview == input["preview"],
            "revision_conflict",
            "导入文件或预览已变化，请重新选择并确认。",
        )?;
        let mut created = self.create_document(&json!({"kind":input["kind"],"title":input["title"],"language_tag":input["language_tag"],"volume_id":input["volume_id"],"source_format":preview["converted"]["source_format"],"content":preview["converted"]["content"]}),changes)?;
        let document_id = text(&created["document"], "document_id")?.to_owned();
        let root = format!(".hetu/imports/{document_id}");
        let report = json!({"schema_version":"1.0.0","document_ref":{"document_id":document_id,"revision_id":created["revision"]["revision_id"],"sha256":created["revision"]["sha256"]},"source_sha256":preview["source_sha256"],"source_size_bytes":preview["source_size_bytes"],"format":preview["request"]["format"],"profile":preview["request"]["profile"],"converter":preview["converted"]["converter"],"coverage":preview["converted"]["coverage"],"warnings":preview["converted"]["warnings"],"losses":preview["converted"]["losses"],"created_at":now()});
        let revision_path = format!(
            "packages/{}/documents/{document_id}/revisions/{}.json",
            if input["kind"] == "drama_script" {
                "drama"
            } else {
                "novel"
            },
            text(&created["revision"], "revision_id")?
        );
        created["revision"]["origin_kind"] = json!("import");
        created["revision"]["import_ref"] = json!({"source_sha256":preview["source_sha256"],"format":preview["request"]["format"],"profile":preview["request"]["profile"],"converter":preview["converted"]["converter"],"report_sha256":digest(bytes(&report)?)});
        changes.insert(revision_path, bytes(&created["revision"])?);
        changes.insert(format!("{root}/original"), original);
        changes.insert(format!("{root}/report.json"), bytes(&report)?);
        let mut result = created;
        result["import_report"] = report;
        Ok(result)
    }
}

fn file_summary(file: &mut std::fs::File) -> Result<Value> {
    use sha2::{Digest, Sha256};
    let before = file.metadata()?;
    file.seek(SeekFrom::Start(0))?;
    let mut sha = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        ensure(
            total <= 4 * 1024 * 1024 * 1024,
            "hetu.budget_exceeded",
            "产物超过 4 GiB。",
        )?;
        sha.update(&buffer[..count]);
    }
    ensure(
        stable_file(&before, &file.metadata()?) && before.len() == total,
        "revision_conflict",
        "格式文件在核验期间发生变化。",
    )?;
    Ok(json!({"sha256":format!("{:x}",sha.finalize()),"size_bytes":total}))
}

fn stable_file(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
        && after.is_file()
        && after.nlink() == 1
}

fn delivery_issue_messages(item: &Value) -> Vec<String> {
    let mut messages = Vec::new();
    if let Some(message) = item["message"].as_str().or_else(|| item["reason"].as_str()) {
        messages.push(message.to_owned());
    }
    for field in ["warnings", "losses"] {
        for entry in references(&item["report"], field) {
            if let Some(message) = entry["message"].as_str() {
                messages.push(message.to_owned());
            }
        }
    }
    if messages.is_empty() {
        messages.push(
            if item["code"] == "partial_skeleton" {
                "所选骨架仍有未覆盖的内容，请结合固定原文与报告审阅。"
            } else {
                "请核对本包清单中标注的未覆盖范围。"
            }
            .into(),
        );
    }
    messages
}
