# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案概述

面單貼標加載器 — Tauri v2 桌面應用程式，從遠端 API 下載並快取物流面單圖片（集運單 proxy / 轉寄單 forward）。

## 技術架構

- **Frontend**: Vanilla JS (ES6 modules) + HTML + CSS，無打包工具，Tauri 直接載入 `src/` 目錄
- **Backend**: Rust (2021 edition) + Tauri v2，使用 reqwest (rustls-tls) 做 HTTP、tokio 做 async I/O
- **IPC**: 透過 `#[tauri::command]` 註冊，前端以 `window.__TAURI__.core.invoke()` 呼叫

### Tauri Commands（lib.rs）

| Command | 用途 |
|---------|------|
| `connect(api_base, token)` | 驗證 Bearer Token 並儲存連線資訊 |
| `fetch_labels()` | 取得面單圖片清單（proxy/forward 分組） |
| `download_image(path)` | 下載單張圖片至本地快取（已存在則跳過） |
| `get_cache_dir()` / `set_cache_dir(dir)` | 取得/設定圖片快取目錄 |

### 共享狀態（AppState）

以 `Mutex` 管理 `api_base`、`token`、`cache_dir`，`Client` 為共用 HTTP 連線池。注意：`danger_accept_invalid_certs(true)` 已啟用。

### 前端流程（main.js）

登入 → connect → showMain → fetchLabels → 使用者按「執行」→ downloadSequentially 逐張下載 → 即時更新 SVG 進度環與日誌。設定資訊存於 localStorage。

## 常用指令

```bash
# 開發模式（啟動 Tauri + 前端 hot reload）
npm run tauri dev

# 建置發行版
npm run tauri build

# 僅編譯 Rust 後端（快速檢查語法）
cd src-tauri && cargo check

# 執行 Rust 測試
cd src-tauri && cargo test
```

## API 端點

後端呼叫的遠端 API：
- `GET /api/v1/label-loader/images` — 取得面單清單
- `GET /api/v1/label-loader/image?path={path}` — 下載單張圖片

## 注意事項

- 前端無打包步驟，`tauri.conf.json` 的 `frontendDist` 直接指向 `../src`
- `withGlobalTauri: true`：前端透過 `window.__TAURI__` 存取 Tauri API，不需 npm import
- 快取目錄預設為 `{app_data}/cache/labels`，使用者可透過 UI 變更
- UI 語言為繁體中文
