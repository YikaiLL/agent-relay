use futures_util::stream::SplitSink;
use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite::Message;

use crate::{
    protocol::{
        ApprovalDecisionInput, ApprovalReceipt, HeartbeatInput, ResumeSessionInput,
        SendMessageInput, SessionSnapshot, StartSessionInput, TakeOverInput, ThreadsQuery,
        ThreadsResponse,
    },
    state::{AppState, ApprovalError},
};

use super::{
    crypto::{decrypt_json, encrypt_json, EncryptedEnvelope},
    issue_session_claim, publish_payload, verify_session_claim, BrokerSocket,
    OutboundBrokerPayload,
};

#[derive(Debug, Clone, Deserialize)]
pub(super) struct RemoteDeviceAuth {
    pub(super) device_id: String,
    pub(super) device_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum RemoteActionRequest {
    ClaimDevice,
    StartSession {
        input: StartSessionInput,
    },
    ResumeSession {
        input: ResumeSessionInput,
    },
    SendMessage {
        input: SendMessageInput,
    },
    TakeOver {
        input: TakeOverInput,
    },
    Heartbeat {
        input: HeartbeatInput,
    },
    ListThreads {
        query: ThreadsQuery,
    },
    DecideApproval {
        request_id: String,
        input: ApprovalDecisionInput,
    },
}

impl RemoteActionRequest {
    pub(super) fn kind(&self) -> RemoteActionKind {
        match self {
            Self::ClaimDevice => RemoteActionKind::ClaimDevice,
            Self::StartSession { .. } => RemoteActionKind::StartSession,
            Self::ResumeSession { .. } => RemoteActionKind::ResumeSession,
            Self::SendMessage { .. } => RemoteActionKind::SendMessage,
            Self::TakeOver { .. } => RemoteActionKind::TakeOver,
            Self::Heartbeat { .. } => RemoteActionKind::Heartbeat,
            Self::ListThreads { .. } => RemoteActionKind::ListThreads,
            Self::DecideApproval { .. } => RemoteActionKind::DecideApproval,
        }
    }

    fn bind_device(self, device_id: String) -> Self {
        match self {
            Self::ClaimDevice => Self::ClaimDevice,
            Self::StartSession { mut input } => {
                input.device_id = Some(device_id);
                Self::StartSession { input }
            }
            Self::ResumeSession { mut input } => {
                input.device_id = Some(device_id);
                Self::ResumeSession { input }
            }
            Self::SendMessage { mut input } => {
                input.device_id = Some(device_id);
                Self::SendMessage { input }
            }
            Self::TakeOver { mut input } => {
                input.device_id = Some(device_id);
                Self::TakeOver { input }
            }
            Self::Heartbeat { mut input } => {
                input.device_id = Some(device_id);
                Self::Heartbeat { input }
            }
            Self::ListThreads { query } => Self::ListThreads { query },
            Self::DecideApproval {
                request_id,
                mut input,
            } => {
                input.device_id = Some(device_id);
                Self::DecideApproval { request_id, input }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum RemoteActionKind {
    ClaimDevice,
    StartSession,
    ResumeSession,
    SendMessage,
    TakeOver,
    Heartbeat,
    ListThreads,
    DecideApproval,
}

impl RemoteActionKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::ClaimDevice => "claim_device",
            Self::StartSession => "start_session",
            Self::ResumeSession => "resume_session",
            Self::SendMessage => "send_message",
            Self::TakeOver => "take_over",
            Self::Heartbeat => "heartbeat",
            Self::ListThreads => "list_threads",
            Self::DecideApproval => "decide_approval",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct RemoteActionResultPlaintext {
    action: RemoteActionKind,
    ok: bool,
    snapshot: SessionSnapshot,
    receipt: Option<ApprovalReceipt>,
    threads: Option<ThreadsResponse>,
    session_claim: Option<String>,
    session_claim_expires_at: Option<u64>,
    error: Option<String>,
}

#[derive(Debug, Default)]
pub(super) struct RemoteActionOutcome {
    pub(super) receipt: Option<ApprovalReceipt>,
    pub(super) threads: Option<ThreadsResponse>,
    pub(super) session_claim: Option<String>,
    pub(super) session_claim_expires_at: Option<u64>,
}

pub(super) async fn handle_remote_action(
    state: &AppState,
    sender: &mut SplitSink<BrokerSocket, Message>,
    from_peer_id: String,
    action_id: String,
    session_claim: Option<String>,
    device_id: Option<String>,
    auth: Option<RemoteDeviceAuth>,
    request: RemoteActionRequest,
) -> Result<(), String> {
    if !state.broker_can_read_content().await {
        return Err("plaintext remote actions are disabled in private mode".to_string());
    }
    let action_kind = request.kind();
    state
        .push_runtime_log(
            "info",
            format!(
                "Broker action `{}` received from {}.",
                action_kind.as_str(),
                from_peer_id
            ),
        )
        .await;

    let resolved_device_id = match resolve_plain_remote_device(
        state,
        &from_peer_id,
        session_claim.as_deref(),
        auth.as_ref(),
        &request,
    )
    .await
    {
        Ok(device_id) => device_id,
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Broker action `{}` from {} failed: {error}",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            let snapshot = state.snapshot().await;
            let result_device_id = auth
                .as_ref()
                .map(|auth| auth.device_id.clone())
                .or(device_id)
                .unwrap_or_else(|| "unknown-device".to_string());
            return publish_plain_remote_action_result(
                sender,
                from_peer_id,
                action_id,
                action_kind,
                snapshot,
                RemoteActionOutcome::default(),
                Some(error),
                false,
                result_device_id,
            )
            .await;
        }
    };
    let result = if matches!(request, RemoteActionRequest::ClaimDevice) {
        issue_claim_outcome(state, &resolved_device_id, &from_peer_id).await
    } else {
        execute_remote_action(state, request.bind_device(resolved_device_id.clone())).await
    };
    let snapshot = state.snapshot().await;

    let (ok, outcome, error) = match result {
        Ok(outcome) => (true, outcome, None),
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Broker action `{}` from {} failed: {error}",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            (false, RemoteActionOutcome::default(), Some(error))
        }
    };
    publish_plain_remote_action_result(
        sender,
        from_peer_id,
        action_id,
        action_kind,
        snapshot,
        outcome,
        error,
        ok,
        resolved_device_id,
    )
    .await
}

pub(super) async fn handle_encrypted_remote_action(
    state: &AppState,
    sender: &mut SplitSink<BrokerSocket, Message>,
    from_peer_id: String,
    action_id: String,
    session_claim: Option<String>,
    device_id: Option<String>,
    envelope: EncryptedEnvelope,
) -> Result<(), String> {
    let hinted_device_id = device_id.clone();
    let (device_id, action_kind) = match resolve_encrypted_action_context(
        state,
        &from_peer_id,
        session_claim.as_deref(),
        device_id.as_deref(),
        &envelope,
    )
    .await
    {
        Ok(context) => context,
        Err(error) => {
            let Some(device_id) = hinted_device_id else {
                return Err(error);
            };
            let action_kind = decrypt_remote_action_kind(state, &device_id, &envelope)
                .await
                .unwrap_or(RemoteActionKind::ClaimDevice);
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Encrypted broker action `{}` from {} failed: {error}",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            let snapshot = state.snapshot().await;
            if let Err(publish_error) = publish_remote_action_result_private(
                state,
                sender,
                from_peer_id,
                device_id,
                action_id,
                action_kind,
                snapshot,
                None,
                None,
                None,
                None,
                Some(error),
                false,
            )
            .await
            {
                if publish_error.contains("device is not paired") {
                    state
                        .push_runtime_log(
                            "warn",
                            "Skipped encrypted broker error reply because the device is no longer paired."
                                .to_string(),
                        )
                        .await;
                    return Ok(());
                }
                return Err(publish_error);
            }
            return Ok(());
        }
    };
    state
        .push_runtime_log(
            "info",
            format!(
                "Encrypted broker action `{}` received from {}.",
                action_kind.as_str(),
                from_peer_id
            ),
        )
        .await;

    let result = match decrypt_remote_action(state, &device_id, &envelope).await {
        Ok(request) => {
            state
                .mark_remote_device_seen(&device_id, &from_peer_id)
                .await?;
            if matches!(request, RemoteActionRequest::ClaimDevice) {
                issue_claim_outcome(state, &device_id, &from_peer_id).await
            } else {
                execute_remote_action(state, request.bind_device(device_id.clone())).await
            }
        }
        Err(error) => Err(error),
    };
    let snapshot = state.snapshot().await;
    let (ok, receipt, threads, issued_claim, issued_claim_expires_at, error) = match result {
        Ok(outcome) => (
            true,
            outcome.receipt,
            outcome.threads,
            outcome.session_claim,
            outcome.session_claim_expires_at,
            None,
        ),
        Err(error) => {
            state
                .push_runtime_log(
                    "warn",
                    format!(
                        "Encrypted broker action `{}` from {} failed: {error}",
                        action_kind.as_str(),
                        from_peer_id
                    ),
                )
                .await;
            (false, None, None, None, None, Some(error))
        }
    };

    match publish_remote_action_result_private(
        state,
        sender,
        from_peer_id,
        device_id,
        action_id,
        action_kind,
        snapshot,
        receipt,
        threads,
        issued_claim,
        issued_claim_expires_at,
        error,
        ok,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(publish_error) if publish_error.contains("device is not paired") => {
            state
                .push_runtime_log(
                    "warn",
                    "Skipped encrypted broker action result because the device is no longer paired."
                        .to_string(),
                )
                .await;
            Ok(())
        }
        Err(publish_error) => Err(publish_error),
    }
}

async fn execute_remote_action(
    state: &AppState,
    request: RemoteActionRequest,
) -> Result<RemoteActionOutcome, String> {
    match request {
        RemoteActionRequest::ClaimDevice => {
            Err("claim_device must be handled before generic action execution".to_string())
        }
        RemoteActionRequest::StartSession { input } => state
            .start_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ResumeSession { input } => state
            .resume_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::SendMessage { input } => state
            .send_message(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::TakeOver { input } => state
            .take_over_control(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::Heartbeat { input } => state
            .heartbeat_session(input)
            .await
            .map(|_| RemoteActionOutcome::default()),
        RemoteActionRequest::ListThreads { query } => state
            .list_threads(query.limit.unwrap_or(80).clamp(1, 200), query.cwd)
            .await
            .map(|threads| RemoteActionOutcome {
                receipt: None,
                threads: Some(threads),
                session_claim: None,
                session_claim_expires_at: None,
            }),
        RemoteActionRequest::DecideApproval { request_id, input } => state
            .decide_approval(&request_id, input)
            .await
            .map(|receipt| RemoteActionOutcome {
                receipt: Some(receipt),
                threads: None,
                session_claim: None,
                session_claim_expires_at: None,
            })
            .map_err(approval_error_message),
    }
}

async fn decrypt_remote_action_kind(
    state: &AppState,
    device_id: &str,
    envelope: &EncryptedEnvelope,
) -> Result<RemoteActionKind, String> {
    let request = decrypt_remote_action(state, device_id, envelope).await?;
    Ok(request.kind())
}

async fn decrypt_remote_action(
    state: &AppState,
    device_id: &str,
    envelope: &EncryptedEnvelope,
) -> Result<RemoteActionRequest, String> {
    let secret = state.paired_device_secret(device_id).await?;
    decrypt_json(&secret, envelope)
}

async fn resolve_plain_remote_device(
    state: &AppState,
    from_peer_id: &str,
    session_claim: Option<&str>,
    auth: Option<&RemoteDeviceAuth>,
    request: &RemoteActionRequest,
) -> Result<String, String> {
    if let Some(claim) = session_claim {
        return verify_session_claim(state, claim, from_peer_id).await;
    }

    let auth = auth.ok_or_else(|| match request {
        RemoteActionRequest::ClaimDevice => "claim_device requires device auth".to_string(),
        _ => "session claim is missing or expired".to_string(),
    })?;

    state
        .authenticate_remote_device(&auth.device_id, &auth.device_token, from_peer_id)
        .await
}

async fn resolve_encrypted_action_context(
    state: &AppState,
    from_peer_id: &str,
    session_claim: Option<&str>,
    device_id: Option<&str>,
    envelope: &EncryptedEnvelope,
) -> Result<(String, RemoteActionKind), String> {
    if let Some(claim) = session_claim {
        let device_id = verify_session_claim(state, claim, from_peer_id).await?;
        let action_kind = decrypt_remote_action_kind(state, &device_id, envelope).await?;
        return Ok((device_id, action_kind));
    }

    let device_id = device_id
        .map(str::to_string)
        .ok_or_else(|| "encrypted remote action is missing device_id".to_string())?;
    let action_kind = decrypt_remote_action_kind(state, &device_id, envelope).await?;
    if !matches!(action_kind, RemoteActionKind::ClaimDevice) {
        return Err("session claim is missing or expired".to_string());
    }
    Ok((device_id, action_kind))
}

async fn issue_claim_outcome(
    state: &AppState,
    device_id: &str,
    peer_id: &str,
) -> Result<RemoteActionOutcome, String> {
    state.mark_remote_device_seen(device_id, peer_id).await?;
    let claim = issue_session_claim(device_id, peer_id)?;
    Ok(RemoteActionOutcome {
        receipt: None,
        threads: None,
        session_claim: Some(claim.token),
        session_claim_expires_at: Some(claim.expires_at),
    })
}

fn approval_error_message(error: ApprovalError) -> String {
    match error {
        ApprovalError::NoPendingRequest => {
            "there is no approval request waiting for a remote decision".to_string()
        }
        ApprovalError::Bridge(message) => message,
    }
}

async fn publish_plain_remote_action_result(
    sender: &mut SplitSink<BrokerSocket, Message>,
    target_peer_id: String,
    action_id: String,
    action: RemoteActionKind,
    snapshot: SessionSnapshot,
    outcome: RemoteActionOutcome,
    error: Option<String>,
    ok: bool,
    _device_id: String,
) -> Result<(), String> {
    publish_payload(
        sender,
        OutboundBrokerPayload::RemoteActionResult {
            action_id,
            target_peer_id,
            action,
            ok,
            snapshot,
            receipt: outcome.receipt,
            threads: outcome.threads,
            session_claim: outcome.session_claim,
            session_claim_expires_at: outcome.session_claim_expires_at,
            error,
        },
    )
    .await
    .map_err(|error| format!("broker action result publish failed: {error}"))
}

async fn publish_remote_action_result_private(
    state: &AppState,
    sender: &mut SplitSink<BrokerSocket, Message>,
    target_peer_id: String,
    device_id: String,
    action_id: String,
    action: RemoteActionKind,
    snapshot: SessionSnapshot,
    receipt: Option<ApprovalReceipt>,
    threads: Option<ThreadsResponse>,
    session_claim: Option<String>,
    session_claim_expires_at: Option<u64>,
    error: Option<String>,
    ok: bool,
) -> Result<(), String> {
    let secret = state.paired_device_secret(&device_id).await?;
    let envelope = encrypt_json(
        &secret,
        &RemoteActionResultPlaintext {
            action,
            ok,
            snapshot,
            receipt,
            threads,
            session_claim,
            session_claim_expires_at,
            error,
        },
    )?;

    publish_payload(
        sender,
        OutboundBrokerPayload::EncryptedRemoteActionResult {
            action_id,
            target_peer_id,
            device_id,
            envelope,
        },
    )
    .await
    .map_err(|error| format!("encrypted broker action result publish failed: {error}"))
}
