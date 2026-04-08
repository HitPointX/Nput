// ============================================================
// web.rs — HTTP server for the OBS / browser overlay
//
// Runs on port 8766 alongside the WebSocket server on 8765.
// Everything the browser needs lives here:
//
//   GET /              → web/index.html  (the overlay page)
//   GET /web-renderer.js → compiled canvas renderer (no Electron)
//   GET /assets/**     → keyboard and controller images
//   GET /layout.json   → the element position mapping
//
// OBS setup: Add Source → Browser Source → http://localhost:8766
// Set width/height to match your chosen layout (see layout.json).
//
// The overlay also works in any regular browser tab — useful for
// testing without OBS or for a floating picture-in-picture window.
// ============================================================

use axum::{
    http::{header, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use std::path::PathBuf;
use tower_http::{cors::CorsLayer, services::ServeDir};

pub const HTTP_ADDR: &str = "127.0.0.1:8766";

/// Build and run the HTTP server.  Never returns unless the
/// server hits an unrecoverable error.
pub async fn start(
    web_dir:    PathBuf,
    assets_dir: PathBuf,
    config_dir: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    // Clone paths for the closure — axum handlers need 'static lifetime
    let layout_path = config_dir.join("layout.json");

    let app = Router::new()
        // layout.json is served dynamically so hot-edits are picked up
        // without restarting the backend.
        .route(
            "/layout.json",
            get(move || {
                let p = layout_path.clone();
                async move { serve_json_file(p).await }
            }),
        )
        // Static asset files (images) for the overlay
        .nest_service("/assets", ServeDir::new(&assets_dir))
        // Everything else (index.html, web-renderer.js) comes from web/
        .fallback_service(ServeDir::new(&web_dir))
        // Allow cross-origin requests — handy if someone loads the page
        // from a different local port during dev
        .layer(CorsLayer::permissive());

    let listener = tokio::net::TcpListener::bind(HTTP_ADDR).await?;
    log::info!("HTTP overlay server up → http://{}", HTTP_ADDR);
    log::info!("OBS: Browser Source → http://{}", HTTP_ADDR);

    axum::serve(listener, app).await?;
    Ok(())
}

// ── Handlers ─────────────────────────────────────────────────

/// Read a JSON file from disk and return it with the right content-type.
/// Re-reads on every request — layout.json is tiny, and this means
/// the user can tune positions without restarting anything.
async fn serve_json_file(path: PathBuf) -> impl IntoResponse {
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            content,
        )
            .into_response(),
        Err(e) => {
            log::error!("Failed to read {:?}: {}", path, e);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}
