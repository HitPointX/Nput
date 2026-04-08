// ============================================================
// server/mod.rs — WebSocket broadcast server
//
// Two things happen here:
//   1. State updates from the Rust backend are broadcast to all
//      connected clients (via a broadcast channel).
//   2. Incoming messages from any client are forwarded to the
//      main loop via a control channel — this is how the
//      frontend toggles the active mode.
//
// Multiple clients can connect simultaneously (handy if you
// want the overlay open in OBS AND in a standalone window).
// ============================================================

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::{accept_async, tungstenite::Message};

pub const WS_ADDR: &str = "127.0.0.1:8765";

/// Start the WebSocket server.
///
/// `broadcast_tx` — the backend pushes state JSON here; it gets
///                  fanned out to every connected client.
///
/// `control_tx`   — raw text messages from clients land here;
///                  the main loop parses them for mode toggles.
pub async fn start(
    broadcast_tx: broadcast::Sender<String>,
    control_tx: mpsc::UnboundedSender<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(WS_ADDR).await?;
    log::info!("WebSocket server up → ws://{}", WS_ADDR);

    loop {
        let (stream, addr) = listener.accept().await?;
        log::info!("Client connected: {}", addr);

        let mut bcast_rx = broadcast_tx.subscribe();
        let ctrl_tx = control_tx.clone();

        tokio::spawn(async move {
            let ws = match accept_async(stream).await {
                Ok(ws) => ws,
                Err(e) => {
                    log::error!("Handshake failed for {}: {}", addr, e);
                    return;
                }
            };

            let (mut sink, mut stream) = ws.split();

            // Forward broadcast messages → this client
            let send_task = tokio::spawn(async move {
                loop {
                    match bcast_rx.recv().await {
                        Ok(msg) => {
                            if sink.send(Message::Text(msg)).await.is_err() {
                                break; // client went away
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            // Client is too slow — skip old messages and carry on
                            log::warn!("Client {} lagged, dropped {} messages", addr, n);
                        }
                    }
                }
            });

            // Read incoming messages from this client and forward to main loop
            while let Some(msg) = stream.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        log::debug!("Client {} → ctrl: {}", addr, text);
                        let _ = ctrl_tx.send(text.to_string());
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {} // ignore binary, ping, pong
                }
            }

            log::info!("Client disconnected: {}", addr);
            send_task.abort();
        });
    }
}
