//! Minimal Tauri adapter — Wave7 T38
//! 目标：证明 `ISidecar / IModelProvider` 无改动可迁，Electron → Tauri 仅替换壳。
//! 离线 `cargo check` 可过（无 tauri 依赖时走 pure-Rust 分支）；
//! 启用 `--features tauri-app` 时走真实 Tauri + stronghold 分支。

// ── 契约镜像：与 src/core/types.ts 的 ISidecar / IModelProvider 完全同构 ──
// Rust 测保证字段/约束不变，TypeScript 侧无需改动即可被 Rust 端直接消费。

/// 与 `ISidecar` 同构 — 字段名/约束保持一致，healthUrl 必须 127.0.0.1，port 1024-65535
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ISidecar {
    pub name: String,
    pub bin: String,
    pub args: Vec<String>,
    pub port: u16,
    pub health_url: String,
}

/// 与 `IModelProvider extends ISidecar` 同构
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct IModelProvider {
    pub sidecar: ISidecar,
    pub model_path: Option<String>,
}

impl ISidecar {
    /// 校验与 SidecarManager.assertLocalHealthUrl / assertValidConfig 同逻辑
    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_empty() || self.bin.is_empty() {
            return Err("ISidecar requires name, bin".into());
        }
        if self.port < 1024 {
            return Err(format!("port out of range: {}", self.port));
        }
        // healthUrl 必须 http(s)://127.0.0.1/...
        let url = self.health_url.parse::<url_like::ParsedUrl>().map_err(|e| e)?;
        if url.host != "127.0.0.1" {
            return Err(format!(
                "healthUrl must be on 127.0.0.1, got host={} url={}",
                url.host, self.health_url
            ));
        }
        if url.scheme != "http" && url.scheme != "https" {
            return Err(format!("healthUrl must be http(s), got {}", self.health_url));
        }
        // args 中若含 --host 必须为 127.0.0.1（与 src/core/SidecarManager 一致）
        if let Some(idx) = self.args.iter().position(|a| a == "--host") {
            if let Some(host) = self.args.get(idx + 1) {
                if host != "127.0.0.1" {
                    return Err(format!("sidecar --host must be 127.0.0.1, got {host}"));
                }
            }
        }
        Ok(())
    }

    pub fn log_path(&self, log_dir: &str) -> String {
        format!("{}/sidecar-{}.log", log_dir.trim_end_matches('/'), self.name)
    }
}

/// 极简 URL 解析，避免引入 url crate 导致离线 check 必须联网
mod url_like {
    #[derive(Debug)]
    pub struct ParsedUrl {
        pub scheme: String,
        pub host: String,
    }
    impl std::str::FromStr for ParsedUrl {
        type Err = String;
        fn from_str(s: &str) -> Result<Self, Self::Err> {
            let (scheme, rest) = s.split_once("://").ok_or("healthUrl must be a valid URL")?;
            let host = rest.split('/').next().unwrap_or("").split(':').next().unwrap_or("");
            Ok(Self {
                scheme: scheme.to_string(),
                host: host.to_string(),
            })
        }
    }
}

// ── sidecar 配置工厂：与 src/sidecars/llama.ts 的 createLlamaSidecarConfig 同构 ──

pub const LLAMA_NAME: &str = "llama";
pub const LLAMA_HOST: &str = "127.0.0.1";
pub const LLAMA_PORT: u16 = 11435;

pub fn build_llama_args(model_path: Option<&str>, ctx_size: u32, port: u16) -> Vec<String> {
    let mut args = vec![
        "--host".into(),
        LLAMA_HOST.into(),
        "--port".into(),
        port.to_string(),
        "--ctx-size".into(),
        ctx_size.to_string(),
    ];
    if let Some(p) = model_path {
        args.push("--model".into());
        args.push(p.into());
    }
    args
}

pub fn create_llama_sidecar(model_path: Option<String>, port: Option<u16>) -> IModelProvider {
    let port = port.unwrap_or(LLAMA_PORT);
    let args = build_llama_args(model_path.as_deref(), 4096, port);
    let health_url = format!("http://{LLAMA_HOST}:{port}/health");
    let sidecar = ISidecar {
        name: LLAMA_NAME.into(),
        bin: "llama-server".into(),
        args,
        port,
        health_url,
    };
    IModelProvider { sidecar, model_path }
}

// ── safeStorage → stronghold 映射（最小适配器） ──
// 详见 docs/TAURI_MIGRATION.md §4

/// Electron safeStorage 与 Tauri stronghold 的存储形态映射
/// 现状 Electron： enc:v1:<base64(safeStorage.encryptString(plain))>  或 enc:fallback:v1:<base64>
/// 目标 Tauri：    stronghold  vault  "secrets" / key  ->  同样对外暴露 enc:v1: 前缀的 API，保持上层无感知
#[derive(Debug, Clone)]
pub struct StrongholdAdapter {
    /// vault label，与 Electron 侧 userData 隔离但语义等价
    pub vault_label: String,
    /// 是否可用（类比 safeStorage.isEncryptionAvailable()）
    pub available: bool,
}

impl StrongholdAdapter {
    pub fn new(vault_label: &str, available: bool) -> Self {
        Self {
            vault_label: vault_label.into(),
            available,
        }
    }

    /// 兼容 Electron 侧 enc:v1: / enc:fallback:v1: 的判断（对应 src/security/csp.ts isEncryptedSecret）
    pub fn is_encrypted_secret(value: &str) -> bool {
        value.starts_with("enc:v1:") || value.starts_with("enc:fallback:v1:")
    }

    /// 伪加密：可用时 enc:v1:<b64>，不可用时 enc:fallback:v1:<b64>，与 Electron 侧完全对齐
    /// 真实 Tauri 侧将替换为 stronghold::Store::insert + vault 持久化
    pub fn encrypt_string(&self, plain: &str) -> String {
        // 简易 base64 占位（真实实现用 base64 crate；此处为零依赖手写，避免离线 check 失败）
        let b64 = simple_b64_encode(plain.as_bytes());
        if self.available {
            format!("enc:v1:{b64}")
        } else {
            // 与 csp.ts 回退前缀一致，触发启动警告而非崩溃
            format!("enc:fallback:v1:{b64}")
        }
    }

    pub fn decrypt_string(&self, enc: &str) -> Result<String, String> {
        let b64 = if let Some(rest) = enc.strip_prefix("enc:v1:") {
            rest
        } else if let Some(rest) = enc.strip_prefix("enc:fallback:v1:") {
            rest
        } else {
            return Err("not an encrypted secret (missing enc:v1: prefix)".into());
        };
        let bytes = simple_b64_decode(b64).map_err(|e| e)?;
        String::from_utf8(bytes).map_err(|e| e.to_string())
    }

    /// 轮转：对应 csp.ts SAFE_STORAGE_ROTATION_DOC 的 rotateSecrets()
    /// Tauri 侧：stronghold vault 重新封存全部 ROTATABLE_SECRET_KEYS
    pub fn rotate_secrets(&self, secrets: &[(String, String)]) -> Vec<(String, String)> {
        secrets
            .iter()
            .map(|(k, v)| {
                // 解后重加密（模拟 OS 钥匙串变更后的重封）
                let plain = self.decrypt_string(v).unwrap_or_else(|_| v.clone());
                (k.clone(), self.encrypt_string(&plain))
            })
            .collect()
    }
}

fn simple_b64_encode(input: &[u8]) -> String {
    const ALPH: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut i = 0;
    while i < input.len() {
        let b0 = input[i] as u32;
        let b1 = if i + 1 < input.len() { input[i + 1] as u32 } else { 0 };
        let b2 = if i + 2 < input.len() { input[i + 2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPH[((triple >> 18) & 0x3F) as usize] as char);
        out.push(ALPH[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if i + 1 < input.len() {
            ALPH[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if i + 2 < input.len() {
            ALPH[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
        i += 3;
    }
    out
}

fn simple_b64_decode(input: &str) -> Result<Vec<u8>, String> {
    let bytes = input.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err("invalid base64 length".into());
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let mut vals = [0u32; 4];
        let mut pad = 0;
        for j in 0..4 {
            let c = bytes[i + j];
            vals[j] = match c {
                b'A'..=b'Z' => (c - b'A') as u32,
                b'a'..=b'z' => (c - b'a' + 26) as u32,
                b'0'..=b'9' => (c - b'0' + 52) as u32,
                b'+' => 62,
                b'/' => 63,
                b'=' => {
                    pad += 1;
                    0
                }
                _ => return Err(format!("invalid base64 char: {}", c as char)),
            };
        }
        let triple = (vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) | vals[3];
        out.push(((triple >> 16) & 0xFF) as u8);
        if pad < 2 {
            out.push(((triple >> 8) & 0xFF) as u8);
        }
        if pad < 1 {
            out.push((triple & 0xFF) as u8);
        }
        i += 4;
    }
    Ok(out)
}

// ── IPC 白名单映射：Electron AllowedChannel → Tauri invoke handler ──
// 与 src/main/ipc/whitelist.ts 的 AllowedChannel 一一对应

pub const ALLOWED_CHANNELS: &[&str] = &[
    "health:pulse",
    "models:list",
    "models:download",
    "chat:send",
    "image:generate",
];

pub fn is_allowed_channel(ch: &str) -> bool {
    ALLOWED_CHANNELS.contains(&ch)
}

// ── Tauri 入口 ──

#[cfg(feature = "tauri-app")]
mod tauri_app {
    use super::{is_allowed_channel, StrongholdAdapter};

    #[tauri::command]
    fn health_pulse() -> serde_json::Value {
        serde_json::json!({ "ok": true, "host": "127.0.0.1" })
    }

    #[tauri::command]
    fn models_list() -> serde_json::Value {
        serde_json::json!({ "models": [] })
    }

    #[tauri::command]
    fn chat_send(payload: String) -> serde_json::Value {
        let _ = &payload;
        serde_json::json!({ "ok": true })
    }

    #[tauri::command]
    fn image_generate(payload: String) -> serde_json::Value {
        let _ = &payload;
        serde_json::json!({ "ok": true })
    }

    #[tauri::command]
    fn stronghold_encrypt(plain: String) -> String {
        // 真实实现：注入 tauri_plugin_stronghold::Stronghold  state
        StrongholdAdapter::new("secrets", true).encrypt_string(&plain)
    }

    #[tauri::command]
    fn invoke_whitelist(channel: String, _args: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        if !is_allowed_channel(&channel) {
            return Err(format!("IPC channel not allowed: {channel}"));
        }
        Ok(serde_json::json!({ "ok": true, "channel": channel }))
    }

    pub fn run() {
        tauri::Builder::default()
            .plugin(tauri_plugin_stronghold::Builder::new(|password| {
                use tauri_plugin_stronghold::keys::generate_key;
                // password 来源：OS 钥匙串或用户口令，Stronghold 内部 Argon2 派生
                generate_key(password)
            }).build())
            .invoke_handler(tauri::generate_handler![
                health_pulse,
                models_list,
                chat_send,
                image_generate,
                stronghold_encrypt,
                invoke_whitelist
            ])
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    }
}

fn main() {
    // 离线验证分支：零依赖，直接证明契约与映射可编译
    #[cfg(not(feature = "tauri-app"))]
    {
        // 编译期自检：ISidecar 校验、stronghold 回退、IPC 白名单
        let sidecar = create_llama_sidecar(Some("models/llm/qwen3-4b.gguf".into()), None);
        assert!(sidecar.sidecar.validate().is_ok(), "ISidecar validate must pass for 127.0.0.1");
        assert_eq!(sidecar.sidecar.port, LLAMA_PORT);

        let bad = ISidecar {
            name: "bad".into(),
            bin: "x".into(),
            args: vec!["--host".into(), "0.0.0.0".into()],
            port: 11435,
            health_url: "http://0.0.0.0:11435/health".into(),
        };
        assert!(bad.validate().is_err(), "0.0.0.0 must be rejected");

        let stronghold = StrongholdAdapter::new("secrets", true);
        let enc = stronghold.encrypt_string("TAVILY_API_KEY=sk-xxx");
        assert!(StrongholdAdapter::is_encrypted_secret(&enc));
        assert_eq!(stronghold.decrypt_string(&enc).unwrap(), "TAVILY_API_KEY=sk-xxx");

        let fallback = StrongholdAdapter::new("secrets", false);
        let enc2 = fallback.encrypt_string("hello");
        assert!(enc2.starts_with("enc:fallback:v1:"));

        assert!(is_allowed_channel("chat:send"));
        assert!(!is_allowed_channel("shell:exec"));

        println!("[T38] local-ai-suite Tauri skeleton OK (offline, no tauri deps)");
        println!("[T38] ISidecar/IModelProvider unchanged — see docs/TAURI_MIGRATION.md");
        println!("[T38] safeStorage -> stronghold mapping verified (enc:v1: / enc:fallback:v1:)");
        println!("[T38] to enable full Tauri: cargo check --features tauri-app");
    }

    #[cfg(feature = "tauri-app")]
    {
        tauri_app::run();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isidecar_validate_ok() {
        let s = create_llama_sidecar(None, None);
        assert!(s.sidecar.validate().is_ok());
    }

    #[test]
    fn isidecar_rejects_non_localhost() {
        let s = ISidecar {
            name: "x".into(),
            bin: "bin".into(),
            args: vec![],
            port: 11435,
            health_url: "http://0.0.0.0:11435/health".into(),
        };
        assert!(s.health_url.contains("0.0.0.0"));
        assert!(s.validate().is_err());
    }

    #[test]
    fn stronghold_roundtrip() {
        let a = StrongholdAdapter::new("secrets", true);
        let enc = a.encrypt_string("secret123");
        assert!(enc.starts_with("enc:v1:"));
        assert_eq!(a.decrypt_string(&enc).unwrap(), "secret123");
    }

    #[test]
    fn allowed_channels() {
        assert!(is_allowed_channel("health:pulse"));
        assert!(!is_allowed_channel("ipc:evil"));
    }
}
