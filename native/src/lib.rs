use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use regex::Regex;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::LazyLock;

// ── 1. Complexity Analysis (15+ regex patterns at native speed) ─────

/// Pre-compiled regex patterns — compiled once, reused forever
static GREETING_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(hi|hello|hey|thanks?|bye|goodbye|good morning|good evening|good afternoon|good night|howdy|greetings|welcome)\b").unwrap());

static YES_NO_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(yes|no|ok|okay|sure|y|n|yep|nope|yea|nah|affirmative|negative|roger|copy)\s*[.!?]*$").unwrap());

static SIMPLE_QUESTION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(what|where|when|who|how|why|which|is|are|do|does|can|could|will|would|should)\b.{0,80}[?]?\s*$").unwrap());

static TECHNICAL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(function|class|module|import|export|async|await|promise|api|database|server|client|component|interface|struct|enum|trait|impl|const|let|var|def|return|throw|catch|try|if|else|for|while|loop|match|switch|case)\b").unwrap());

static SECURITY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(security|audit|vulnerab|exploit|injection|xss|csrf|auth|encrypt|decrypt|certificate|tls|ssl|oauth|jwt|token|permission|privilege|sanitize|escape|hash|salt)\b").unwrap());

static ARCHITECTURE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(architect|design|pattern|microservice|monolith|scale|distributed|event.?driven|cqrs|saga|domain.?driven|hexagonal|clean.?arch|solid|dry|kiss)\b").unwrap());

static REFACTOR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(refactor|restructure|reorganize|rewrite|rearchitect|decompos|extract|consolidat|simplif|clean.?up|tech.?debt)\b").unwrap());

static MULTI_FILE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(all files|every file|entire|codebase|project.?wide|across.?the|multiple files|several files|many files)\b").unwrap());

static CONCURRENCY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(async|await|concurrent|parallel|thread|mutex|lock|deadlock|race.?condition|semaphore|channel|atomic|worker|pool)\b").unwrap());

static PERFORMANCE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(performance|optimize|bottleneck|profil|benchmark|latency|throughput|cache|memory.?leak|cpu|heap|gc|garbage)\b").unwrap());

static DATABASE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(database|sql|query|migration|schema|index|transaction|join|aggregate|stored.?proc|trigger|view|orm|sequelize|prisma|knex|typeorm)\b").unwrap());

static REASONING_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(step.?by.?step|think.*through|analyz|compar|trade.?off|pros?.?and?.?cons|evaluat|assess|consider|weigh|reason|logic|deduc)\b").unwrap());

static FORCE_CLOUD_RE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        Regex::new(r"(?i)\bsecurity\s+(audit|review)\b").unwrap(),
        Regex::new(r"(?i)\barchitect(ure)?\s+(design|review)\b").unwrap(),
        Regex::new(r"(?i)\b(complete|full|entire)\s+codebase\s+refactor").unwrap(),
        Regex::new(r"(?i)\bcode\s+review\b").unwrap(),
        Regex::new(r"(?i)\bpr\s+review\b").unwrap(),
        Regex::new(r"(?i)\bcomplex\s+debug").unwrap(),
        Regex::new(r"(?i)\bproduction\s+(incident|outage|issue)\b").unwrap(),
    ]
});

static FORCE_LOCAL_RE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        Regex::new(r"(?i)^(hi|hello|hey|thanks?|bye|goodbye)\s*[.!?]*$").unwrap(),
        Regex::new(r"(?i)^what\s+time\s+is\s+it").unwrap(),
        Regex::new(r"(?i)^(yes|no|ok|okay|sure|y|n)\s*[.!?]*$").unwrap(),
        Regex::new(r"(?i)^(help|commands?|menu)\s*[.!?]*$").unwrap(),
    ]
});

#[napi(object)]
pub struct ComplexityResult {
    pub score: u32,
    pub force_local: bool,
    pub force_cloud: bool,
    pub token_score: u32,
    pub task_type_score: u32,
    pub code_complexity_score: u32,
    pub reasoning_score: u32,
}

/// Analyze request complexity — Rust regex engine is 10-50x faster than JS RegExp
#[napi]
pub fn analyze_complexity_native(content: String, token_estimate: u32, tool_count: u32) -> ComplexityResult {
    // Force patterns (short-circuit)
    let force_local = FORCE_LOCAL_RE.iter().any(|re| re.is_match(&content));
    if force_local {
        return ComplexityResult {
            score: 0,
            force_local: true,
            force_cloud: false,
            token_score: 0,
            task_type_score: 0,
            code_complexity_score: 0,
            reasoning_score: 0,
        };
    }

    let force_cloud = FORCE_CLOUD_RE.iter().any(|re| re.is_match(&content));

    // Token score (0-20)
    let token_score = match token_estimate {
        0..500 => 0,
        500..1000 => 4,
        1000..2000 => 8,
        2000..4000 => 12,
        4000..8000 => 16,
        _ => 20,
    };

    // Tool score (0-20)
    let tool_score = match tool_count {
        0 => 0,
        1..=3 => 4,
        4..=6 => 8,
        7..=10 => 12,
        11..=15 => 16,
        _ => 20,
    };

    // Task type (0-25)
    let task_type_score = if GREETING_RE.is_match(&content) || YES_NO_RE.is_match(&content) {
        0
    } else if SIMPLE_QUESTION_RE.is_match(&content) {
        3
    } else if REFACTOR_RE.is_match(&content) {
        16
    } else if MULTI_FILE_RE.is_match(&content) {
        22
    } else if force_cloud {
        25
    } else if TECHNICAL_RE.is_match(&content) {
        10
    } else {
        5
    };

    // Code complexity (0-20)
    let mut code_score: u32 = 0;
    if MULTI_FILE_RE.is_match(&content) { code_score += 5; }
    if ARCHITECTURE_RE.is_match(&content) { code_score += 5; }
    if SECURITY_RE.is_match(&content) { code_score += 4; }
    if CONCURRENCY_RE.is_match(&content) { code_score += 3; }
    if PERFORMANCE_RE.is_match(&content) { code_score += 3; }
    if DATABASE_RE.is_match(&content) { code_score += 3; }
    let code_complexity_score = code_score.min(20);

    // Reasoning (0-15)
    let reasoning_score = if REASONING_RE.is_match(&content) { 4 } else { 0 };

    let total = (token_score + tool_score + task_type_score + code_complexity_score + reasoning_score).min(100);

    ComplexityResult {
        score: if force_cloud { total.max(76) } else { total },
        force_local: false,
        force_cloud,
        token_score,
        task_type_score,
        code_complexity_score,
        reasoning_score,
    }
}

// ── 2. Cache Key Computation (recursive sort + SHA-256) ─────────────

/// Recursively sort all object keys and produce a stable SHA-256 hash.
/// This is the hot path for prompt cache key generation.
#[napi]
pub fn compute_cache_key(json_str: String) -> String {
    let normalized = match serde_json::from_str::<serde_json::Value>(&json_str) {
        Ok(val) => normalize_value(&val),
        Err(_) => {
            // Fallback: hash the raw string
            let mut hasher = Sha256::new();
            hasher.update(json_str.as_bytes());
            return hex::encode(hasher.finalize());
        }
    };

    let stable = serde_json::to_string(&normalized).unwrap_or(json_str);
    let mut hasher = Sha256::new();
    hasher.update(stable.as_bytes());
    hex::encode(hasher.finalize())
}

/// Recursively normalize a JSON value: sort object keys, preserve arrays
fn normalize_value(val: &serde_json::Value) -> serde_json::Value {
    match val {
        serde_json::Value::Object(map) => {
            let mut sorted = BTreeMap::new();
            for (k, v) in map {
                sorted.insert(k.clone(), normalize_value(v));
            }
            serde_json::Value::Object(sorted.into_iter().collect())
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(normalize_value).collect())
        }
        other => other.clone(),
    }
}

// ── 3. Structural Similarity (Jaccard on line sets) ─────────────────

/// Compute Jaccard similarity between two text blocks using normalized line sets.
/// Used by Distill compression for dedup detection.
#[napi]
pub fn structural_similarity(a: String, b: String) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }

    let set_a: std::collections::HashSet<&str> = a.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    let set_b: std::collections::HashSet<&str> = b.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    if set_a.is_empty() && set_b.is_empty() {
        return 1.0;
    }

    let intersection = set_a.intersection(&set_b).count();
    let union = set_a.union(&set_b).count();

    if union == 0 { 0.0 } else { intersection as f64 / union as f64 }
}

// ── 4. Text Normalization (ANSI strip + whitespace collapse) ────────

static ANSI_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])").unwrap());

/// Strip ANSI escape codes and normalize whitespace.
/// Used by Distill compression on every tool result.
#[napi]
pub fn normalize_text(text: String) -> String {
    let stripped = ANSI_RE.replace_all(&text, "");
    let normalized = stripped
        .replace("\r\n", "\n")
        .replace('\r', "\n");

    // Collapse whitespace runs
    let mut result = String::with_capacity(normalized.len());
    let mut prev_space = false;
    let mut newline_count = 0;

    for ch in normalized.chars() {
        if ch == '\n' {
            newline_count += 1;
            if newline_count <= 2 {
                result.push('\n');
            }
            prev_space = false;
        } else if ch == ' ' || ch == '\t' {
            if !prev_space {
                result.push(' ');
                prev_space = true;
            }
            newline_count = 0;
        } else {
            result.push(ch);
            prev_space = false;
            newline_count = 0;
        }
    }

    result.trim().to_string()
}

// ── 5. Payload Size Estimation ──────────────────────────────────────

/// Estimate payload content size without full JSON serialization.
/// Scans for base64 image data and text content lengths.
#[napi]
pub fn estimate_payload_size(json_str: String) -> u64 {
    let val: serde_json::Value = match serde_json::from_str(&json_str) {
        Ok(v) => v,
        Err(_) => return json_str.len() as u64,
    };

    let messages = match val.get("messages").and_then(|m| m.as_array()) {
        Some(m) => m,
        None => return 0,
    };

    let mut size: u64 = 0;

    for msg in messages {
        if let Some(content) = msg.get("content") {
            if let Some(s) = content.as_str() {
                size += s.len() as u64;
            } else if let Some(arr) = content.as_array() {
                for block in arr {
                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                        size += text.len() as u64;
                    }
                    if let Some(data) = block.pointer("/source/data").and_then(|d| d.as_str()) {
                        size += data.len() as u64;
                    }
                    if let Some(url) = block.pointer("/image_url/url").and_then(|u| u.as_str()) {
                        if url.starts_with("data:") {
                            size += url.len() as u64;
                        }
                    }
                }
            }
        }
    }

    size
}
