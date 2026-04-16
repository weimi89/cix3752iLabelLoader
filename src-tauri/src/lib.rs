use std::path::PathBuf;
use std::sync::Mutex;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

/// 持久化設定（存入 config.json）
#[derive(Serialize, Deserialize, Default)]
struct AppConfig {
    #[serde(default)]
    cache_dir: Option<String>,
}

/// 應用程式共享狀態
struct AppState {
    /// API 基礎 URL（例如 https://local-18001.build-site.dev）
    api_base: Mutex<String>,
    /// Passport Bearer Token
    token: Mutex<String>,
    /// HTTP Client（共用連線池）
    client: Client,
    /// 圖片快取目錄
    cache_dir: Mutex<PathBuf>,
    /// 設定檔路徑
    config_path: PathBuf,
}

/// 面單圖片清單回應（proxy=集運單, forward=轉寄單）
#[derive(Serialize, Deserialize, Clone)]
struct LabelGroup {
    proxy: serde_json::Value,
    forward: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone)]
struct LabelImages {
    count: LabelGroup,
    items: LabelGroup,
}

/// 下載單張圖片結果
#[derive(Serialize)]
struct DownloadResult {
    path: String,
    success: bool,
    cached_path: String,
}

/// 設定 API 連線資訊（Personal Access Token，不走 OAuth 流程）
#[tauri::command]
async fn connect(
    state: State<'_, AppState>,
    api_base: String,
    token: String,
) -> Result<(), String> {
    let base = api_base.trim_end_matches('/').to_string();

    // 驗證 token 是否有效：嘗試呼叫 API
    let url = format!("{}/api/v1/label-loader/images", base);
    let resp = state
        .client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("連線失敗: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!("Token 無效或 API 無法存取 ({})", status));
    }

    *state.api_base.lock().unwrap() = base;
    *state.token.lock().unwrap() = token;

    Ok(())
}

/// 取得面單圖片清單
#[tauri::command]
async fn fetch_labels(state: State<'_, AppState>) -> Result<LabelImages, String> {
    let api_base = state.api_base.lock().unwrap().clone();
    let token = state.token.lock().unwrap().clone();

    if api_base.is_empty() || token.is_empty() {
        return Err("尚未登入".to_string());
    }

    let url = format!("{}/api/v1/label-loader/images", api_base);

    let resp = state
        .client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("請求失敗: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("API 錯誤 ({}): {}", status, body));
    }

    let labels: LabelImages = resp.json().await.map_err(|e| format!("解析回應失敗: {}", e))?;

    Ok(labels)
}

/// 批次檢查哪些圖片已存在本地快取，回傳尚未下載的路徑清單
#[tauri::command]
fn filter_uncached(state: State<'_, AppState>, paths: Vec<String>) -> Vec<String> {
    let cache_dir = state.cache_dir.lock().unwrap().clone();
    paths
        .into_iter()
        .filter(|p| {
            let local = p.strip_prefix("labels/").unwrap_or(p);
            !cache_dir.join(local).exists()
        })
        .collect()
}

/// 透過 API 端點下載單張面單圖片到本地快取
///
/// path 為 API 回傳的相對路徑（如 labels/TCat/20260410/xxx.png），
/// 透過 GET /api/v1/label-loader/image?path={path} 帶 Bearer token 下載。
#[tauri::command]
async fn download_image(state: State<'_, AppState>, path: String) -> Result<DownloadResult, String> {
    let api_base = state.api_base.lock().unwrap().clone();
    let token = state.token.lock().unwrap().clone();
    let cache_dir = state.cache_dir.lock().unwrap().clone();

    if api_base.is_empty() || token.is_empty() {
        return Err("尚未登入".to_string());
    }

    // 去掉 "labels/" 前綴，保留後續資料夾結構（如 ECOnline/20260410/xxx.png）
    let local_path = path.strip_prefix("labels/").unwrap_or(&path);
    let cached_path = cache_dir.join(local_path);

    // 已快取則跳過下載
    if cached_path.exists() {
        return Ok(DownloadResult {
            path: path.clone(),
            success: true,
            cached_path: cached_path.to_string_lossy().to_string(),
        });
    }

    let url = format!("{}/api/v1/label-loader/image", api_base);

    let resp = state
        .client
        .get(&url)
        .query(&[("path", &path)])
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("下載失敗: {}", e))?;

    if !resp.status().is_success() {
        return Ok(DownloadResult {
            path,
            success: false,
            cached_path: String::new(),
        });
    }

    let bytes = resp.bytes().await.map_err(|e| format!("讀取失敗: {}", e))?;

    // 確保完整路徑的父目錄存在
    if let Some(parent) = cached_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("建立快取目錄失敗: {}", e))?;
    }

    tokio::fs::write(&cached_path, &bytes)
        .await
        .map_err(|e| format!("寫入快取失敗: {}", e))?;

    Ok(DownloadResult {
        path,
        success: true,
        cached_path: cached_path.to_string_lossy().to_string(),
    })
}

/// 取得目前儲存目錄路徑
#[tauri::command]
fn get_cache_dir(state: State<'_, AppState>) -> String {
    state.cache_dir.lock().unwrap().to_string_lossy().to_string()
}

/// 設定儲存目錄路徑（同時持久化到 config.json）
#[tauri::command]
fn set_cache_dir(state: State<'_, AppState>, dir: String) -> String {
    let path = PathBuf::from(&dir);
    *state.cache_dir.lock().unwrap() = path;

    // 寫入設定檔
    let config = AppConfig {
        cache_dir: Some(dir.clone()),
    };
    if let Ok(json) = serde_json::to_string_pretty(&config) {
        let _ = std::fs::create_dir_all(state.config_path.parent().unwrap());
        let _ = std::fs::write(&state.config_path, json);
    }

    dir
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .expect("無法取得 app data 目錄");

            let config_path = app_data.join("config.json");

            // 讀取設定檔，決定快取目錄
            let default_cache_dir = app_data.join("cache");
            let cache_dir = std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|s| serde_json::from_str::<AppConfig>(&s).ok())
                .and_then(|c| c.cache_dir)
                .map(PathBuf::from)
                .unwrap_or(default_cache_dir);

            app.manage(AppState {
                api_base: Mutex::new(String::new()),
                token: Mutex::new(String::new()),
                client: Client::builder()
                    .danger_accept_invalid_certs(true)
                    .build()
                    .expect("無法建立 HTTP client"),
                cache_dir: Mutex::new(cache_dir),
                config_path,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            fetch_labels,
            filter_uncached,
            download_image,
            get_cache_dir,
            set_cache_dir,
        ])
        .run(tauri::generate_context!())
        .expect("啟動應用程式失敗");
}
