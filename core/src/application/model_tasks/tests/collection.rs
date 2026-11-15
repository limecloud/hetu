use super::*;

#[test]
fn image_collection_requires_complete_decode_and_keeps_original_file() {
    let f = fixture("cover");
    let r = prepare(&f, "image");
    approve(&f, &r);
    let service = ModelService::open(f.connection.path()).unwrap();
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::RgbImage::new(64, 64)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    let bytes = bytes.into_inner();
    let output = json!({"sha256":digest(&bytes),"size":bytes.len(),"mime_type":"image/png","width":64,"height":64});
    ok(f.agent
        .execute_model_remote_with(
            "hetu.model_tasks.submit",
            &input(&f, &r),
            &service,
            |_, _, _, _| Ok(remote(&r, output.clone())),
            |_, _| panic!(),
        )
        .unwrap());
    let result = ok(f
        .agent
        .execute_model_remote_with(
            "hetu.model_tasks.collect",
            &input(&f, &r),
            &service,
            |_, _, _, _| Ok(remote(&r, output.clone())),
            |_, _| Ok(bytes.clone()),
        )
        .unwrap());
    assert_eq!(result["sha256"], digest(&bytes));
    assert_eq!(result["media_type"], "image/png");
    let submitted = ok(call(
        &f.agent,
        "creative_tasks.submit_result",
        json!({"task_ref":f.task["task_ref"],"request_sha256":f.task["request_sha256"],"candidates":[{"kind":"image","title":"模型封面候选","source_format":"image","source_ref_indices":[],"file_name":result["file_name"],"sha256":result["sha256"]}],"complete":true,"missing_items":[],"provenance":{"client":"test","skill_version":"1"},"operation_key":"submit-candidate"}),
    ));
    let selection = json!({"source":{"kind":"creative_task","reference":{"task_ref":f.task["task_ref"],"submission_id":submitted["submission"]["submission_id"],"candidate_id":submitted["submission"]["candidates"][0]["candidate_id"]}},"expected_cover":null,"presentation":{"crop_rect":{"x":0,"y":0,"width":1,"height":1},"title_overlay":"","author_overlay":""},"operation_key":"choose-cover"});
    assert_eq!(
        call(&f.agent, "covers.select", selection.clone())["error"]["code"],
        "forbidden"
    );
    let chosen = ok(call(&f.author, "covers.select", selection));
    assert_eq!(chosen["cover"]["source_ref"]["kind"], "creative_task");
    assert_eq!(
        chosen["cover"]["source_ref"]["candidate"]["sha256"],
        result["sha256"]
    );
    assert_eq!(
        chosen["cover"]["source_ref"]["request_sha256"],
        f.task["request_sha256"]
    );
    ok(call(&f.author, "covers.get", json!({})));
    let truncated = &bytes[..bytes.len() / 2];
    assert!(crate::infrastructure::media::decode_image_bytes(truncated).is_err());
}
