use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoredBlock {
    pub entity_id: String,
    pub block_uid: String,
    pub block_type: String,
    pub json: String,
    pub parent_id: Option<String>,
    pub position: i64,
    pub deleted: bool,
    pub deleted_at: Option<i64>,
    pub prev_parent: Option<String>,
    pub prev_index: Option<i64>,
    pub is_object: bool,
    pub object_name: Option<String>,
    pub created: i64,
    pub modified: i64,
    pub content_text: String,
    pub tags_text: String,
    pub properties_text: String,
    pub block_refs_json: String,
    pub block_backrefs_json: String,
    pub object_refs_json: String,
    pub object_backrefs_json: String,
}

impl StoredBlock {
    /// Converts the stable Block JSON boundary into the SQLite projection used by the native layer.
    /// The original JSON is retained verbatim so fields unknown to Rust are not discarded.
    pub fn from_block_json(json: &str) -> std::result::Result<Self, String> {
        let value: serde_json::Value =
            serde_json::from_str(json).map_err(|error| format!("Block JSON 无法解析: {error}"))?;
        let object = value
            .as_object()
            .ok_or_else(|| "Block JSON 必须是对象".to_owned())?;
        let required_string = |name: &str| {
            object
                .get(name)
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| format!("Block 缺少字符串字段: {name}"))
        };
        let optional_string = |name: &str| {
            object
                .get(name)
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        };
        let array_json = |name: &str| {
            object
                .get(name)
                .filter(|value| value.is_array())
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]))
                .to_string()
        };
        let bool_value = |name: &str| {
            object
                .get(name)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        };
        let integer = |name: &str| {
            object
                .get(name)
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0)
        };
        let content = object
            .get("content")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut content_text = content
            .iter()
            .filter_map(|fragment| fragment.get("v").and_then(serde_json::Value::as_str))
            .collect::<String>();
        // 附件块的可见文字是 payload 里的原名（content 恒空）——不拼进来，按文件名搜不到附件（`13-媒体设计` §7）。
        // 图片块的图注走 content，天然已进；嵌入块按 §7 不进索引。
        if object.get("type").and_then(serde_json::Value::as_str) == Some("file") {
            if let Some(name) = object
                .get("asset")
                .and_then(|asset| asset.get("originalName"))
                .and_then(serde_json::Value::as_str)
            {
                if !content_text.is_empty() {
                    content_text.push(' ');
                }
                content_text.push_str(name);
            }
        }
        let tags_text = object
            .get("tags")
            .and_then(serde_json::Value::as_array)
            .map(|tags| {
                tags.iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        let properties_text = object
            .get("properties")
            .and_then(serde_json::Value::as_array)
            .map(|properties| {
                properties
                    .iter()
                    .map(|property| property.to_string())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();

        Ok(Self {
            entity_id: required_string("entityId")?,
            block_uid: required_string("blockUid")?,
            block_type: required_string("type")?,
            json: json.to_owned(),
            parent_id: object
                .get("parent")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            position: integer("position"),
            deleted: bool_value("deleted"),
            deleted_at: object.get("deletedAt").and_then(serde_json::Value::as_i64),
            prev_parent: object
                .get("prevParent")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            prev_index: object.get("prevIndex").and_then(serde_json::Value::as_i64),
            is_object: bool_value("isObject"),
            object_name: optional_string("objectName"),
            created: integer("created"),
            modified: integer("modified"),
            content_text,
            tags_text,
            properties_text,
            block_refs_json: array_json("blockRefs"),
            block_backrefs_json: array_json("blockBackRefs"),
            object_refs_json: array_json("objectRefs"),
            object_backrefs_json: array_json("objectBackRefs"),
        })
    }
}

impl StoredBlock {
    /// A2（`13-属性区重规划` §7.1-A2）：把检索文本从"原始 JSON"换成**可读文本**——
    /// 每条属性写「名称: 显示值」、标签写名字。`registry` = `app_metadata('registry')` 的解析结果。
    ///
    /// **与前端内存端（`application/searchSubstring.ts`）同一套口径**（`SEARCH-PARITY-1`）：
    /// 定义缺失就退回裸值（select 退回 `optionId`、标签退回 id）——老库 / 专测数据没有注册表也不丢命中；
    /// 显示值为空（如空文本）的整条跳过，不给索引添噪声。
    pub fn apply_search_text(&mut self, registry: Option<&serde_json::Value>) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&self.json) else {
            return;
        };
        let Some(object) = value.as_object() else {
            return;
        };
        self.tags_text = object
            .get("tags")
            .and_then(serde_json::Value::as_array)
            .map(|tags| {
                tags.iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(|id| {
                        registry
                            .and_then(|r| r.get("tags"))
                            .and_then(serde_json::Value::as_array)
                            .and_then(|list| {
                                list.iter().find(|item| {
                                    item.get("id").and_then(serde_json::Value::as_str) == Some(id)
                                })
                            })
                            .and_then(|item| item.get("name"))
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned)
                            .unwrap_or_else(|| id.to_owned())
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        self.properties_text = object
            .get("properties")
            .and_then(serde_json::Value::as_array)
            .map(|properties| {
                properties
                    .iter()
                    .filter_map(|property| {
                        let def_id = property.get("defId").and_then(serde_json::Value::as_str)?;
                        let def = registry
                            .and_then(|r| r.get("properties"))
                            .and_then(serde_json::Value::as_array)
                            .and_then(|list| {
                                list.iter().find(|item| {
                                    item.get("id").and_then(serde_json::Value::as_str)
                                        == Some(def_id)
                                })
                            });
                        let display = property_display_text(property, def);
                        if display.is_empty() {
                            return None;
                        }
                        Some(
                            match def
                                .and_then(|d| d.get("name"))
                                .and_then(serde_json::Value::as_str)
                            {
                                Some(name) => format!("{name}: {display}"),
                                None => display,
                            },
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
    }
}

/// 一条属性值的**显示文本**（与前端 `resolvePropertyText` 同口径；定义缺失时退回裸值）。
fn property_display_text(value: &serde_json::Value, def: Option<&serde_json::Value>) -> String {
    match value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
    {
        "checkbox" => {
            if value
                .get("value")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                "已完成".to_owned()
            } else {
                "未完成".to_owned()
            }
        }
        "select" => {
            let option_id = value
                .get("optionId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            def.and_then(|d| d.get("options"))
                .and_then(serde_json::Value::as_array)
                .and_then(|list| {
                    list.iter().find(|item| {
                        item.get("id").and_then(serde_json::Value::as_str) == Some(option_id)
                    })
                })
                .and_then(|item| item.get("label"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| option_id.to_owned())
        }
        "number" => value
            .get("value")
            .map(|raw| match raw {
                serde_json::Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .unwrap_or_default(),
        _ => value
            .get("value")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_owned(),
    }
}

/// V2b：这两个结构现在会**跨越 Tauri 边界**（`commit_transaction` 命令），
/// 而前端一律用 camelCase（`opId` / `transactionId` / `deviceId` / `inverseJson`），
/// 所以按 camelCase 序列化。`operations_json` 是写进去又读回来的（自洽），
/// 且本字段此前从未被真实运行写过（只有 Rust 测试），切换命名不存在迁移问题。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedOperation {
    pub op_id: String,
    pub json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTransaction {
    pub transaction_id: String,
    pub source: String,
    pub device_id: String,
    pub operations: Vec<PersistedOperation>,
    pub inverse_json: String,
    pub created: i64,
}
