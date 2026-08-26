fn main() {
    // 仅在启用 tauri-app 特性时才真正调用 tauri_build
    #[cfg(feature = "tauri-app")]
    {
        tauri_build::build()
    }
    #[cfg(not(feature = "tauri-app"))]
    {
        // 离线 cargo check 无需 tauri_build
    }
}
