-- 拟议缓存数据库；只能在内存或独立样例库验证，不能作为现有产品 Migration。
-- 所有记录来自核验后的权威文件，不持有授权、密钥或第二份正文。
PRAGMA foreign_keys = ON;

CREATE TABLE plugin_object_index (
    workspace_id TEXT NOT NULL,
    work_kind TEXT NOT NULL,
    work_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    object_kind TEXT NOT NULL,
    current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
    current_sha256 TEXT NOT NULL CHECK (length(current_sha256) = 64),
    schema_version TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, work_kind, work_id, plugin_id, object_id)
);

CREATE INDEX plugin_object_by_kind ON plugin_object_index
    (workspace_id, work_kind, work_id, plugin_id, object_kind, updated_at);

CREATE TABLE plugin_revision_index (
    workspace_id TEXT NOT NULL,
    work_kind TEXT NOT NULL,
    work_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    parent_revision INTEGER,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    schema_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, work_kind, work_id, plugin_id, object_id, revision),
    FOREIGN KEY (workspace_id, work_kind, work_id, plugin_id, object_id)
        REFERENCES plugin_object_index
        (workspace_id, work_kind, work_id, plugin_id, object_id)
        ON DELETE CASCADE
);

CREATE TABLE plugin_binding_index (
    workspace_id TEXT NOT NULL,
    work_kind TEXT NOT NULL,
    work_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    required_contract TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    enabled_contributions_json TEXT NOT NULL CHECK (json_valid(enabled_contributions_json)),
    PRIMARY KEY (workspace_id, work_kind, work_id, binding_id)
);

CREATE TABLE plugin_reference_index (
    workspace_id TEXT NOT NULL,
    work_kind TEXT NOT NULL,
    work_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    reference_index INTEGER NOT NULL CHECK (reference_index >= 0),
    target_owner_ref_json TEXT NOT NULL CHECK (json_valid(target_owner_ref_json)),
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    target_revision TEXT NOT NULL,
    target_sha256 TEXT NOT NULL CHECK (length(target_sha256) = 64),
    PRIMARY KEY (workspace_id, work_kind, work_id, plugin_id, object_id, revision, reference_index),
    FOREIGN KEY (workspace_id, work_kind, work_id, plugin_id, object_id, revision)
        REFERENCES plugin_revision_index
        (workspace_id, work_kind, work_id, plugin_id, object_id, revision)
        ON DELETE CASCADE
);

CREATE TABLE plugin_artifact_index (
    workspace_id TEXT NOT NULL,
    work_kind TEXT NOT NULL,
    work_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    artifact_index INTEGER NOT NULL CHECK (artifact_index >= 0),
    artifact_ref_json TEXT NOT NULL CHECK (json_valid(artifact_ref_json)),
    purpose TEXT NOT NULL,
    PRIMARY KEY (workspace_id, work_kind, work_id, plugin_id, object_id, revision, artifact_index),
    FOREIGN KEY (workspace_id, work_kind, work_id, plugin_id, object_id, revision)
        REFERENCES plugin_revision_index
        (workspace_id, work_kind, work_id, plugin_id, object_id, revision)
        ON DELETE CASCADE
);

CREATE TABLE plugin_job_index (
    workspace_id TEXT NOT NULL,
    work_kind TEXT NOT NULL,
    work_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    package_sha256 TEXT NOT NULL CHECK (length(package_sha256) = 64),
    operation_key TEXT NOT NULL,
    input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
    state TEXT NOT NULL CHECK (state IN
        ('queued', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled', 'unknown')),
    recovery_ref_json TEXT NOT NULL CHECK (json_valid(recovery_ref_json)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, work_kind, work_id, job_id),
    UNIQUE (workspace_id, work_kind, work_id, operation_key)
);

CREATE INDEX plugin_job_by_state ON plugin_job_index
    (workspace_id, work_kind, work_id, state, updated_at);
