use std::net::SocketAddr;

use tokio::net::TcpListener;
use tracing::info;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "relay_broker=debug,tower_http=info".into()),
        )
        .init();

    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8788);
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(address)
        .await
        .expect("failed to bind broker tcp listener");

    info!("relay-broker listening on ws://localhost:{port}/ws/:channel_id");
    axum::serve(
        listener,
        relay_broker::app(relay_broker::BrokerState::default()),
    )
    .await
    .expect("relay-broker exited unexpectedly");
}
