use super::*;

impl Kernel {
    /// 私有桌面媒体适配器；不加入领域动作目录，也不向管理或插件连接开放下载。
    pub fn open_asset_media(&self, input: &Value) -> Result<AssetMedia> {
        ensure(
            self.is_author(),
            "forbidden",
            "媒体预览只允许可信作者宿主。",
        )?;
        schema(
            input,
            &json!({"type":"object","additionalProperties":false,
            "required":["work_ref","asset_id","revision","sha256"],"properties":{
                "work_ref":{"type":"object"},"asset_id":{"type":"string"},
                "revision":{"type":"integer","minimum":1},
                "sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"}}}),
        )?;
        let _lock = self.store.read_lock()?;
        self.work_record(&input["work_ref"], None)?;
        let (asset, sha, _) = self.read_media_record(
            "asset",
            text(input, "asset_id")?,
            input["revision"].as_u64(),
        )?;
        ensure(
            asset.get("work_ref") == Some(&input["work_ref"]),
            "forbidden",
            "素材不属于当前作品。",
        )?;
        ensure(
            input["sha256"] == sha,
            "revision_conflict",
            "素材固定版本摘要不一致。",
        )?;
        let file = self.store.managed_media(text(&asset["blob"], "path")?)?;
        AssetMedia::open(
            file,
            &asset["blob"],
            json!({
                "work_ref":input["work_ref"],"asset_id":asset["asset_id"],
                "revision":asset["revision"],"sha256":sha,
            }),
        )
    }
}
