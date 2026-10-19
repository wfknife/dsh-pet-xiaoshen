-- 角色连续状态库（SQLite）。单内核写入者；所有写入都在 BEGIN IMMEDIATE 事务内完成。
-- 对应总规 §11.2。字段用结构化列承载索引/约束，可变业务细节放 JSON。
-- 本文件只被 character/storage/store.cjs 读取并整体执行一次（幂等：全部 IF NOT EXISTS）。

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  checksum TEXT NOT NULL
);

-- 一个角色、一条权威状态线、一个活跃写入 epoch（不变量 1）
CREATE TABLE IF NOT EXISTS characters (
  character_id TEXT PRIMARY KEY,
  identity_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  writer_epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 身份版本账本。模型替换只改 modelBinding，不改这里（§10.1）
CREATE TABLE IF NOT EXISTS identity_revisions (
  character_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (character_id, revision)
);

-- 来源：现实观察 / 用户自述 / 虚拟 / 系统 / 派生，权限与保留分离
CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  world TEXT NOT NULL,
  trust TEXT NOT NULL,
  permission TEXT NOT NULL,
  payload_ref TEXT,
  source_hash TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  committed_seq INTEGER,
  permission_ref TEXT
);
CREATE INDEX IF NOT EXISTS sources_world ON sources (character_id, world, permission);

-- 可擦除正文。删除决定先于内容清理（§11.3）
CREATE TABLE IF NOT EXISTS payloads (
  payload_id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  retention_class TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS payloads_retention ON payloads (retention_class, created_at);

-- 事件头可长期保留；正文在 payloads
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  character_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT,
  payload_ref TEXT,
  world TEXT NOT NULL,
  trust TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT NOT NULL,
  source_event_id TEXT,
  occurred_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  committed_at INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  retention_class TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS events_source_dedupe ON events (character_id, source_id, source_event_id);
CREATE INDEX IF NOT EXISTS events_kind_time ON events (character_id, kind, occurred_at);
CREATE INDEX IF NOT EXISTS events_correlation ON events (correlation_id);

-- 角色状态与 events 同事务；revision 单调
CREATE TABLE IF NOT EXISTS state (
  character_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  identity_revision INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  updated_seq INTEGER NOT NULL
);

-- 结构化事实：有效时间与提交时间分开（§13.2）
CREATE TABLE IF NOT EXISTS assertions (
  assertion_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  value_json TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'owner',
  world TEXT NOT NULL,
  trust TEXT NOT NULL,
  valid_from INTEGER,
  valid_to INTEGER,
  status TEXT NOT NULL,
  superseded_by TEXT,
  confidence REAL NOT NULL,
  confidence_class TEXT NOT NULL,
  memory_lifecycle TEXT NOT NULL DEFAULT 'active',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  quote_span_json TEXT,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assertions_lookup ON assertions (character_id, subject, predicate, scope, status);
CREATE INDEX IF NOT EXISTS assertions_status ON assertions (character_id, status, memory_lifecycle);

-- 派生关系：来源撤销时用它可以找到“失去唯一依据”的派生物
CREATE TABLE IF NOT EXISTS evidence_edges (
  derived_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  PRIMARY KEY (derived_id, source_id, relation)
);
CREATE INDEX IF NOT EXISTS evidence_edges_source ON evidence_edges (source_id);

CREATE TABLE IF NOT EXISTS episodes (
  episode_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  world TEXT NOT NULL,
  title TEXT NOT NULL,
  body_ref TEXT,
  status TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  created_seq INTEGER NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS episodes_time ON episodes (character_id, occurred_at);

CREATE TABLE IF NOT EXISTS appraisals (
  appraisal_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  episode_id TEXT,
  body_ref TEXT,
  status TEXT NOT NULL,
  confidence_class TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS concerns (
  concern_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  desired_outcome TEXT NOT NULL,
  status TEXT NOT NULL,
  priority REAL NOT NULL DEFAULT 0.5,
  origin TEXT NOT NULL DEFAULT 'self',
  created_at INTEGER NOT NULL,
  next_check_at INTEGER,
  expires_at INTEGER,
  last_contact_at INTEGER,
  exit_condition TEXT,
  revision INTEGER NOT NULL,
  body_json TEXT NOT NULL DEFAULT '{}',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  updated_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS concerns_due ON concerns (character_id, status, next_check_at);
CREATE UNIQUE INDEX IF NOT EXISTS concerns_topic ON concerns (character_id, topic_key);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  step_cursor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  next_wake_at INTEGER,
  deadline INTEGER,
  revision INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'self',
  body_json TEXT NOT NULL DEFAULT '{}',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  updated_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_wake ON projects (character_id, status, next_wake_at);

-- 持久待办：jobs 表才是安排本身，timer 只是唤醒器（§12.2）
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  character_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  lease_epoch INTEGER,
  lease_until INTEGER,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  payload_ref TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs (status, due_at);
CREATE INDEX IF NOT EXISTS jobs_character ON jobs (character_id, kind, status);

-- 副作用：operation ID + 契约版本 + 授权范围 + 结果状态（不变量 4）
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  capability_version INTEGER NOT NULL,
  provider TEXT NOT NULL,
  effect TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  deadline INTEGER,
  receipt_ref TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  plan_revision INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  unknown_reason TEXT,
  dedupe_key TEXT
);
CREATE INDEX IF NOT EXISTS operations_status ON operations (character_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS operations_dedupe ON operations (character_id, dedupe_key);

CREATE TABLE IF NOT EXISTS operation_attempts (
  operation_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  idempotency_key TEXT,
  detail_json TEXT,
  PRIMARY KEY (operation_id, attempt)
);

CREATE TABLE IF NOT EXISTS outbox (
  dispatch_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (status, next_attempt_at);

-- 表现回执：生成/发布/播放完成分别记账（不变量 8）
CREATE TABLE IF NOT EXISTS deliveries (
  presentation_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  phase TEXT NOT NULL,
  operation_id TEXT,
  renderer_session TEXT,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  detail_json TEXT,
  PRIMARY KEY (presentation_id, channel, phase)
);
CREATE INDEX IF NOT EXISTS deliveries_operation ON deliveries (operation_id);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  hash TEXT NOT NULL,
  world TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS skills (
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (skill_id, version)
);

CREATE TABLE IF NOT EXISTS packages (
  package_id TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  data_namespace TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (package_id, version)
);

CREATE TABLE IF NOT EXISTS projection_cursors (
  consumer TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL,
  projection_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  import_id TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  detail_json TEXT
);

-- 命令去重：同 ID 同正文返回既有回执；同 ID 不同正文明确冲突（C01）
CREATE TABLE IF NOT EXISTS command_receipts (
  command_id TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  result_json TEXT NOT NULL
);

-- 感知观测带 freshness TTL；旧窗口标题不等于当前活动（§15）
CREATE TABLE IF NOT EXISTS observations (
  observation_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  fresh_until INTEGER NOT NULL,
  source_id TEXT,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS observations_fresh ON observations (character_id, kind, fresh_until);

-- 反思是待整合变更，不是已经发生的真理（§16）
CREATE TABLE IF NOT EXISTS reflections (
  reflection_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  status TEXT NOT NULL,
  body_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  created_seq INTEGER NOT NULL,
  decided_at INTEGER,
  decision TEXT
);

-- 模型与主动联系的窗口计数（§14.3）
CREATE TABLE IF NOT EXISTS budget_usage (
  window_key TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- 成长变更账本：旧值、新值、规则版本、上限、撤销方式（§16）
CREATE TABLE IF NOT EXISTS growth_events (
  growth_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_key TEXT NOT NULL,
  old_value_json TEXT NOT NULL,
  new_value_json TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  rule_limit_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  created_seq INTEGER NOT NULL,
  reverted_at INTEGER,
  reverted_by TEXT
);

-- 一层短计划（plan）状态：模型不能生成无限动态树（§6.1 / §17.2）
CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  opportunity_id TEXT,
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  step_cursor INTEGER NOT NULL DEFAULT 0,
  steps_json TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS plans_active ON plans (character_id, status);
