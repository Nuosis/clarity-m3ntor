// Desktop window for the local M3NT0R owner view. The service must be running;
// set M3NTOR_URL when it does not use the default port.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let address = std::env::var("M3NTOR_URL").unwrap_or_else(|_| "http://127.0.0.1:4317/".to_string());
    let url: url::Url = address.parse().expect("M3NTOR_URL must be a URL");
    tauri::Builder::default()
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url.clone()))
                .title("M3NT0R")
                .inner_size(1200.0, 820.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start the M3NT0R window");
}
