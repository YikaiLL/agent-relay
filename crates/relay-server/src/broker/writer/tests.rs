use std::sync::{Arc, Mutex};

use super::*;

/// Collects what the writer wrote, in order, so the scheduling policy can be asserted
/// without a websocket.
struct RecordingSink {
    written: Arc<Mutex<Vec<String>>>,
    fail_with: Option<String>,
}

impl FrameSink for RecordingSink {
    async fn send_frame(&mut self, message: Message) -> Result<(), String> {
        if let Some(error) = &self.fail_with {
            return Err(error.clone());
        }
        match message {
            Message::Text(text) => self.written.lock().unwrap().push(text),
            Message::Ping(_) => self.written.lock().unwrap().push("PING".to_string()),
            _ => {}
        }
        Ok(())
    }
}

/// A sink whose writes never complete, for asserting the session can still tear the
/// writer down.
struct StalledSink;

impl FrameSink for StalledSink {
    async fn send_frame(&mut self, _message: Message) -> Result<(), String> {
        std::future::pending::<()>().await;
        unreachable!("a stalled sink never completes a write")
    }
}

/// Presence the test can flip mid-train.
#[derive(Clone)]
struct FakePresence {
    online: Arc<Mutex<bool>>,
}

impl SurfacePresence for FakePresence {
    async fn is_online(&self, _peer_id: &str) -> bool {
        *self.online.lock().unwrap()
    }
}

fn always_online() -> FakePresence {
    FakePresence {
        online: Arc::new(Mutex::new(true)),
    }
}

fn recorder() -> (Arc<Mutex<Vec<String>>>, RecordingSink) {
    let written = Arc::new(Mutex::new(Vec::new()));
    (
        Arc::clone(&written),
        RecordingSink {
            written,
            fail_with: None,
        },
    )
}

fn text(label: &str) -> Message {
    Message::Text(label.to_string())
}

fn train_of(prefix: &str, count: usize) -> Vec<Message> {
    (0..count)
        .map(|index| text(&format!("{prefix}{index}")))
        .collect()
}

fn train_of_labels(prefix: &str, count: usize) -> Vec<String> {
    (0..count).map(|index| format!("{prefix}{index}")).collect()
}

fn plain_train(chunks: Vec<Message>, interval_ms: u64) -> TrainFrame {
    TrainFrame {
        chunks,
        interval: Duration::from_millis(interval_ms),
        watch_target: None,
    }
}

/// The point of the whole module: a snapshot queued while a 21-chunk reply is pacing
/// must not wait out the reply.
#[tokio::test(start_paused = true)]
async fn ordinary_traffic_goes_out_during_a_trains_pacing_gap() {
    let (written, sink) = recorder();
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));

    train_tx
        .send(plain_train(train_of("chunk-", 5), 250))
        .await
        .expect("train should queue");

    tokio::time::sleep(Duration::from_millis(10)).await;
    now_tx
        .send(text("snapshot"))
        .await
        .expect("snapshot should queue");

    drop(now_tx);
    drop(train_tx);
    writer
        .await
        .expect("writer joins")
        .expect("writer succeeds");

    let written = written.lock().unwrap().clone();
    let snapshot_at = written
        .iter()
        .position(|entry| entry == "snapshot")
        .unwrap();
    assert_eq!(written[0], "chunk-0", "the first chunk is due immediately");
    assert_eq!(
        snapshot_at, 1,
        "the snapshot must go out in the very next pacing gap, not after all 5 chunks; \
         got order {written:?}"
    );
    assert_eq!(
        written.len(),
        6,
        "and every chunk still arrives: {written:?}"
    );
}

/// The train must not be starved by sustained ordinary traffic either.
#[tokio::test(start_paused = true)]
async fn a_train_still_completes_under_sustained_ordinary_traffic() {
    let (written, sink) = recorder();
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));

    train_tx
        .send(plain_train(train_of("chunk-", 4), 100))
        .await
        .expect("train should queue");

    for index in 0..20 {
        now_tx
            .send(text(&format!("noise-{index}")))
            .await
            .expect("noise should queue");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    drop(now_tx);
    drop(train_tx);
    writer
        .await
        .expect("writer joins")
        .expect("writer succeeds");

    let written = written.lock().unwrap().clone();
    let chunks: Vec<&String> = written
        .iter()
        .filter(|entry| entry.starts_with("chunk-"))
        .collect();
    assert_eq!(
        chunks,
        vec!["chunk-0", "chunk-1", "chunk-2", "chunk-3"],
        "a paced reply must survive a noisy relay, in order: {written:?}"
    );
}

/// Chunks keep their order relative to each other.
#[tokio::test(start_paused = true)]
async fn a_train_keeps_its_chunk_order() {
    let (written, sink) = recorder();
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));

    train_tx
        .send(plain_train(train_of("chunk-", 21), 250))
        .await
        .expect("train should queue");
    drop(now_tx);
    drop(train_tx);
    writer
        .await
        .expect("writer joins")
        .expect("writer succeeds");

    assert_eq!(
        written.lock().unwrap().clone(),
        train_of_labels("chunk-", 21)
    );
}

/// The backlog bound. A train is a whole action reply — a workspace diff can be
/// megabytes across hundreds of chunks — and the writer emits four chunks a second.
///
/// An earlier revision drained trains eagerly out of the channel into an unbounded
/// internal queue, so the producer never waited and a surface replaying a cached large
/// result could grow the backlog without limit. The pre-writer code was crudely bounded
/// (it published inline, so nothing else could be accepted until a reply had gone out);
/// moving pacing off the read loop must not throw that bound away.
#[tokio::test(start_paused = true)]
async fn a_third_train_waits_instead_of_growing_the_backlog() {
    let (_written, sink) = recorder();
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(TRAIN_QUEUE_CAPACITY);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));

    // One becomes resident in the writer, one waits in the channel.
    train_tx
        .send(plain_train(train_of("a-", 40), 250))
        .await
        .expect("first train is accepted");
    tokio::time::sleep(Duration::from_millis(10)).await;
    train_tx
        .send(plain_train(train_of("b-", 40), 250))
        .await
        .expect("second train fills the channel");

    // The third must not be absorbed: that is the bound.
    let third = train_tx.try_send(plain_train(train_of("c-", 40), 250));
    assert!(
        third.is_err(),
        "a third outstanding reply must not be absorbed into an unbounded backlog — \
         that is what stops a replayed large result from growing memory without limit"
    );

    drop(now_tx);
    drop(train_tx);
    writer
        .await
        .expect("writer joins")
        .expect("writer succeeds");
}

/// A train stops once the surface it is for has demonstrably left.
///
/// Only meaningful because the read loop no longer blocks while the writer paces: before
/// that, the presence frame saying "that surface left" could not be read until the train
/// had already finished, so the signal was frozen for exactly the window it was supposed
/// to react to.
#[tokio::test(start_paused = true)]
async fn a_train_stops_once_its_surface_is_seen_to_leave() {
    let (written, sink) = recorder();
    let presence = always_online();
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        presence.clone(),
    ));

    train_tx
        .send(TrainFrame {
            chunks: train_of("chunk-", 21),
            interval: Duration::from_millis(250),
            watch_target: Some("surface-a".to_string()),
        })
        .await
        .expect("train should queue");

    // The surface reloads away while its answer is still pacing.
    tokio::time::sleep(Duration::from_millis(300)).await;
    *presence.online.lock().unwrap() = false;

    drop(now_tx);
    drop(train_tx);
    writer
        .await
        .expect("writer joins")
        .expect("writer succeeds");

    let written = written.lock().unwrap().clone();
    assert!(
        written.len() <= 3,
        "the train must stop promptly instead of publishing all 21 chunks into the \
         void: got {written:?}"
    );
}

/// The asymmetry that keeps a truncated reply from ever being a client-visible failure.
///
/// A client resolves a chunked reply only once EVERY chunk has arrived, so a train
/// abandoned halfway is not a saving — it is a guaranteed client timeout. Absence from
/// the presence set is therefore not enough to stop a train; only an observed departure
/// is.
#[tokio::test(start_paused = true)]
async fn a_train_for_a_surface_never_seen_online_is_delivered_whole() {
    let (written, sink) = recorder();
    let presence = FakePresence {
        online: Arc::new(Mutex::new(false)),
    };
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(ping_rx, now_rx, train_rx, sink, presence));

    train_tx
        .send(plain_train(train_of("chunk-", 6), 250))
        .await
        .expect("train should queue");
    drop(now_tx);
    drop(train_tx);
    writer
        .await
        .expect("writer joins")
        .expect("writer succeeds");

    assert_eq!(
        written.lock().unwrap().len(),
        6,
        "a cold presence set must not truncate a valid answer into a client timeout"
    );
}

/// A write failure ends the writer, which is how the session learns the socket is gone.
#[tokio::test(start_paused = true)]
async fn a_failed_write_stops_the_writer() {
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (_train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        RecordingSink {
            written: Arc::new(Mutex::new(Vec::new())),
            fail_with: Some("socket is gone".to_string()),
        },
        always_online(),
    ));

    now_tx
        .send(text("snapshot"))
        .await
        .expect("frame should queue");

    let error = writer
        .await
        .expect("writer joins")
        .expect_err("a failed send must surface");
    assert_eq!(error, "socket is gone");
}

/// The writer must be cancellable mid-write, which is what ties it to its session.
///
/// Closing the channels is not enough on its own: a send to a peer that has stopped
/// reading never completes, so a stalled task cannot observe the closure. Without an
/// abort it sits on a dead socket while `run_broker_loop` reconnects, and can still emit
/// frames onto it afterwards. `BrokerWriterGuard` is what performs that abort; this pins
/// the property the guard depends on.
#[tokio::test(start_paused = true)]
async fn a_stalled_writer_can_be_cancelled_when_its_session_ends() {
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let task = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        StalledSink,
        always_online(),
    ));

    now_tx
        .send(text("frame-that-never-lands"))
        .await
        .expect("frame should queue");
    tokio::time::sleep(Duration::from_millis(10)).await;

    // The session ends. Dropping the handles alone cannot stop a task parked on a write.
    drop(now_tx);
    drop(train_tx);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !task.is_finished(),
        "a task parked on a socket write cannot observe channel closure — which is \
         exactly why the session needs a guard that aborts it"
    );

    task.abort();
    let outcome = task.await;
    assert!(
        outcome.is_err_and(|error| error.is_cancelled()),
        "the abort must actually cancel it — that is all BrokerWriterGuard does on drop"
    );
}

/// Bounding the backlog must not re-park the relay's only reader.
///
/// `send_train` is called from inside the session's inline message handler. An earlier
/// revision bounded memory by awaiting a full channel there, which is correct for memory
/// and wrong for liveness: the relay has exactly one reader, so parking it stops
/// presence frames, heartbeat pongs, and every other surface's requests — the same stall
/// this module was written to remove, just needing three large replies instead of one.
/// Cheap to reach, too: a replayed action id is served from cache without redoing work.
#[tokio::test(start_paused = true)]
async fn a_saturated_train_queue_reports_busy_instead_of_parking_the_caller() {
    let (writer, _now_rx, _train_rx) = test_writer();

    assert_eq!(
        writer
            .send_train(train_of("a-", 4), Duration::from_millis(250), None)
            .expect("first train is accepted"),
        TrainHandoff::Queued
    );

    // Nothing is draining the queue, so the next one cannot be taken on.
    let second = tokio::time::timeout(
        Duration::from_millis(50),
        std::future::ready(writer.send_train(train_of("b-", 4), Duration::from_millis(250), None)),
    )
    .await
    .expect("send_train must not block the caller")
    .expect("a full queue is not a session error");

    assert_eq!(
        second,
        TrainHandoff::Busy,
        "a saturated writer must report Busy so the caller can answer the client, not \
         park the relay's only reader until the queue drains"
    );
}

/// A heartbeat ping must not wait behind data.
///
/// Two independent reasons, both of which cost a healthy session:
///
///   * The broker's publish allowance counts only `ClientMessage::Publish` frames — a
///     websocket Ping is a control frame it answers separately — so a ping is never
///     what puts this relay over a limit, and delaying it buys nothing.
///   * The session arms its pong deadline when it *hands a ping over*, not when the
///     ping reaches the socket. A ping queued behind a burst of snapshots therefore
///     reads as a dead peer, and the session tears itself down while the connection is
///     perfectly fine — taking every queued frame with it, since the guard aborts the
///     writer on the way out.
#[tokio::test(start_paused = true)]
async fn a_heartbeat_ping_overtakes_queued_data() {
    let (written, sink) = recorder();
    let (ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);

    // Queue data first, and a train, so every other lane has work waiting.
    for index in 0..40 {
        now_tx
            .send(text(&format!("snapshot-{index}")))
            .await
            .expect("data should queue");
    }
    train_tx
        .send(plain_train(train_of("chunk-", 10), 250))
        .await
        .expect("train should queue");
    ping_tx
        .send(Message::Ping(vec![7]))
        .await
        .expect("ping should queue");

    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));
    tokio::time::sleep(Duration::from_millis(1)).await;

    let seen = written.lock().unwrap().len();
    drop(ping_tx);
    drop(now_tx);
    drop(train_tx);
    let _ = writer.await;

    let written = written.lock().unwrap().clone();
    let ping_at = written
        .iter()
        .position(|entry| entry == "PING")
        .unwrap_or_else(|| panic!("the ping must be sent at all; got {written:?}"));
    assert_eq!(
        ping_at, 0,
        "the ping must go out before the queued snapshots, not after {ping_at} of them"
    );
    let _ = seen;
}

/// …including when the writer is idle, which is where it spends almost all its time.
///
/// The overtaking test above pre-queues data, so it only proves the ping wins a race it
/// was already in. The idle wait is a different code path, and a version of it that
/// forgets the ping arm does not merely delay a heartbeat: nothing notices the ping
/// until some unrelated frame happens to wake the loop, so a quiet, healthy connection
/// times out on its own pong deadline. That is how this was actually broken.
#[tokio::test(start_paused = true)]
async fn an_idle_writer_still_notices_a_ping() {
    let (written, sink) = recorder();
    let (ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(64);
    let (train_tx, train_rx) = mpsc::channel(1);
    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));

    // Let the writer settle into its idle wait with nothing queued at all.
    tokio::time::sleep(Duration::from_millis(50)).await;
    ping_tx
        .send(Message::Ping(vec![1]))
        .await
        .expect("ping should queue");
    tokio::time::sleep(Duration::from_millis(10)).await;

    let seen = written.lock().unwrap().clone();
    drop(ping_tx);
    drop(now_tx);
    drop(train_tx);
    let _ = writer.await;

    assert_eq!(
        seen,
        vec!["PING".to_string()],
        "an idle writer must wake for a ping without needing other traffic to nudge it"
    );
}

/// A reply must start streaming even while ordinary traffic keeps arriving.
///
/// The writer drains an ordinary frame and loops, and only looks for a new train when
/// the ordinary queue is momentarily empty. A slow socket, a reconnect's delta backlog,
/// or plain sustained snapshot traffic can therefore keep a queued reply from ever being
/// *accepted* — and the client, which cannot see any of this, just times out.
///
/// The neighbouring "sustained traffic" test queues the train first, so it only proves a
/// train already under way survives noise. This is the order that actually breaks:
/// noise first, train second.
#[tokio::test(start_paused = true)]
async fn a_train_starts_even_while_ordinary_traffic_keeps_arriving() {
    let (written, sink) = recorder();
    let (_ping_tx, ping_rx) = mpsc::channel(4);
    let (now_tx, now_rx) = mpsc::channel(512);
    let (train_tx, train_rx) = mpsc::channel(1);

    // A backlog is already waiting when the reply is queued behind it.
    for index in 0..200 {
        now_tx
            .send(text(&format!("noise-{index}")))
            .await
            .expect("noise should queue");
    }
    train_tx
        .send(plain_train(train_of("chunk-", 5), 250))
        .await
        .expect("train should queue");

    let writer = tokio::spawn(drive_writer(
        ping_rx,
        now_rx,
        train_rx,
        sink,
        always_online(),
    ));
    tokio::time::sleep(Duration::from_millis(5)).await;

    let seen = written.lock().unwrap().clone();
    drop(now_tx);
    drop(train_tx);
    let _ = writer.await;

    let first_chunk_at = seen
        .iter()
        .position(|entry| entry.starts_with("chunk-"))
        .unwrap_or_else(|| panic!("the reply never started; wrote {} frames", seen.len()));
    assert!(
        first_chunk_at < 20,
        "the reply waited behind {first_chunk_at} ordinary frames before its first chunk \
         went out; a backlog must not postpone a reply the client is timing"
    );
}
