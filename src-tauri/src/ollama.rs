use crate::qmd::cmd;
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::{sleep, Instant};

pub const API_BASE_URL: &str = "http://localhost:11434";

const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(350);
const GENERATE_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OllamaModelInfo {
    pub name: String,
    pub size_bytes: Option<u64>,
    pub installed: bool,
    pub parameter_size: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TagsResponse {
    #[serde(default)]
    models: Vec<TagModel>,
}

#[derive(Debug, Deserialize)]
struct TagModel {
    #[serde(default)]
    name: String,
    size: Option<u64>,
    details: Option<TagModelDetails>,
}

#[derive(Debug, Deserialize)]
struct TagModelDetails {
    parameter_size: Option<String>,
}

#[derive(Debug, Serialize)]
struct GenerateRequest<'a> {
    model: &'a str,
    prompt: &'a str,
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct GenerateResponse {
    response: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ErrorResponse {
    error: Option<String>,
}

pub fn api_url(path: &str) -> String {
    if path.starts_with('/') {
        format!("{API_BASE_URL}{path}")
    } else {
        format!("{API_BASE_URL}/{path}")
    }
}

pub async fn ensure_ollama_running() -> Result<(), String> {
    if request_installed_models(HEALTH_TIMEOUT).await.is_ok() {
        return Ok(());
    }

    let startup_lock = startup_lock();
    let _guard = startup_lock.lock().await;

    if request_installed_models(HEALTH_TIMEOUT).await.is_ok() {
        return Ok(());
    }

    eprintln!("ollama: starting local server...");
    cmd("ollama")
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start ollama serve: {e}"))?;

    let started_at = Instant::now();
    let mut last_error = "ollama API did not respond".to_string();
    while started_at.elapsed() < STARTUP_TIMEOUT {
        sleep(STARTUP_POLL_INTERVAL).await;
        match request_installed_models(HEALTH_TIMEOUT).await {
            Ok(_) => return Ok(()),
            Err(err) => last_error = err,
        }
    }

    Err(format!(
        "Ollama API was not reachable after starting ollama serve: {last_error}"
    ))
}

pub async fn installed_models() -> Result<Vec<OllamaModelInfo>, String> {
    ensure_ollama_running().await?;
    request_installed_models(HEALTH_TIMEOUT).await
}

pub async fn list_model_options() -> Vec<OllamaModelInfo> {
    match installed_models().await {
        Ok(models) => models,
        Err(err) => {
            eprintln!("ollama: unable to list installed models: {err}");
            Vec::new()
        }
    }
}

pub async fn model_available(model: &str) -> bool {
    match installed_models().await {
        Ok(models) => find_model_name(&models, model).is_some(),
        Err(err) => {
            eprintln!("ollama: unavailable: {err}");
            false
        }
    }
}

pub async fn generate(model: &str, prompt: &str) -> Result<String, String> {
    ensure_ollama_running().await?;

    let client = client(GENERATE_TIMEOUT)?;
    let response = client
        .post(api_url("/api/generate"))
        .json(&GenerateRequest {
            model,
            prompt,
            stream: false,
        })
        .send()
        .await
        .map_err(|e| format!("ollama generate request failed: {e}"))?;

    let body = response_body(response, "ollama generate").await?;
    parse_generate_response(&body)
}

pub fn find_model_name(models: &[OllamaModelInfo], requested: &str) -> Option<String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return None;
    }

    models
        .iter()
        .find(|model| model.name == requested)
        .or_else(|| {
            models
                .iter()
                .find(|model| model_name_matches(&model.name, requested))
        })
        .map(|model| model.name.clone())
}

pub fn first_matching_model_name(
    models: &[OllamaModelInfo],
    candidates: &[&str],
) -> Option<String> {
    candidates
        .iter()
        .find_map(|candidate| find_model_name(models, candidate))
}

async fn request_installed_models(
    timeout_duration: Duration,
) -> Result<Vec<OllamaModelInfo>, String> {
    let client = client(timeout_duration)?;
    let response = client
        .get(api_url("/api/tags"))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to ollama API: {e}"))?;

    let body = response_body(response, "ollama tags").await?;
    parse_tags_response(&body)
}

async fn response_body(response: reqwest::Response, context: &str) -> Result<String, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read {context} response: {e}"))?;

    if status.is_success() {
        return Ok(body);
    }

    if let Some(error) = parse_error_message(&body) {
        return Err(format!("{context} failed: {error}"));
    }
    if body.trim().is_empty() {
        Err(format!("{context} failed: HTTP {status}"))
    } else {
        Err(format!("{context} failed: HTTP {status}: {}", body.trim()))
    }
}

fn client(timeout_duration: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(HEALTH_TIMEOUT)
        .timeout(timeout_duration)
        .build()
        .map_err(|e| format!("Failed to create ollama HTTP client: {e}"))
}

fn startup_lock() -> &'static Mutex<()> {
    static STARTUP_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    STARTUP_LOCK.get_or_init(|| Mutex::new(()))
}

fn parse_tags_response(body: &str) -> Result<Vec<OllamaModelInfo>, String> {
    let parsed: TagsResponse = serde_json::from_str(body)
        .map_err(|e| format!("Failed to parse ollama tags response: {e}"))?;

    Ok(parsed
        .models
        .into_iter()
        .filter_map(|model| {
            let name = model.name.trim();
            if name.is_empty() {
                return None;
            }
            Some(OllamaModelInfo {
                name: name.to_string(),
                size_bytes: model.size,
                installed: true,
                parameter_size: model
                    .details
                    .and_then(|details| details.parameter_size)
                    .filter(|value| !value.trim().is_empty()),
            })
        })
        .collect())
}

fn parse_generate_response(body: &str) -> Result<String, String> {
    let parsed: GenerateResponse = serde_json::from_str(body)
        .map_err(|e| format!("Failed to parse ollama generate response: {e}"))?;

    if let Some(error) = parsed.error.filter(|error| !error.trim().is_empty()) {
        return Err(format!("ollama generate failed: {error}"));
    }

    parsed
        .response
        .ok_or_else(|| "ollama generate response did not include text".to_string())
}

fn parse_error_message(body: &str) -> Option<String> {
    serde_json::from_str::<ErrorResponse>(body)
        .ok()
        .and_then(|response| response.error)
        .filter(|error| !error.trim().is_empty())
}

fn model_name_matches(installed: &str, requested: &str) -> bool {
    let installed = installed.trim();
    let requested = requested.trim();
    if installed.is_empty() || requested.is_empty() {
        return false;
    }

    installed == requested
        || strip_latest(installed) == requested
        || installed == format!("{requested}:latest")
        || strip_latest(installed) == strip_latest(requested)
}

fn strip_latest(name: &str) -> &str {
    name.strip_suffix(":latest").unwrap_or(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(name: &str) -> OllamaModelInfo {
        OllamaModelInfo {
            name: name.to_string(),
            size_bytes: None,
            installed: true,
            parameter_size: None,
        }
    }

    #[test]
    fn parse_tags_response_extracts_installed_models() {
        let body = r#"{
            "models": [
                {
                    "name": "llama3.2:latest",
                    "size": 2019393189,
                    "details": { "parameter_size": "3.2B" }
                },
                { "name": "" }
            ]
        }"#;

        let models = parse_tags_response(body).expect("tags should parse");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "llama3.2:latest");
        assert_eq!(models[0].size_bytes, Some(2019393189));
        assert_eq!(models[0].parameter_size.as_deref(), Some("3.2B"));
    }

    #[test]
    fn model_matching_accepts_latest_variants() {
        let models = vec![model("llama3.2:latest"), model("qwen2.5:1.5b")];

        assert_eq!(
            find_model_name(&models, "llama3.2"),
            Some("llama3.2:latest".to_string())
        );
        assert_eq!(
            find_model_name(&models, "llama3.2:latest"),
            Some("llama3.2:latest".to_string())
        );
        assert_eq!(find_model_name(&models, "qwen2.5"), None);
    }

    #[test]
    fn first_matching_model_preserves_candidate_order() {
        let models = vec![model("qwen2.5:1.5b"), model("mistral:latest")];
        let candidates = ["llama3.2", "mistral", "qwen2.5:1.5b"];

        assert_eq!(
            first_matching_model_name(&models, &candidates),
            Some("mistral:latest".to_string())
        );
    }

    #[test]
    fn parse_generate_response_returns_text() {
        let body = "{ \"response\": \"## Summary\\nDone\", \"done\": true }";

        assert_eq!(
            parse_generate_response(body).expect("generate should parse"),
            "## Summary\nDone"
        );
    }

    #[test]
    fn parse_generate_response_surfaces_error() {
        let body = r#"{ "error": "model not found" }"#;

        assert!(parse_generate_response(body)
            .expect_err("error should be returned")
            .contains("model not found"));
    }
}
