use std::sync::Arc;

use tokio::sync::{watch, RwLock};
use tracing::warn;

use crate::{
    broker::BrokerConfig,
    codex::CodexBridge,
    protocol::{
        ApprovalDecision, ApprovalDecisionInput, ApprovalReceipt, HeartbeatInput,
        PairingDecision, PairingDecisionInput, PairingDecisionReceipt, PairingStartInput,
        PairingTicketView, ResumeSessionInput, RevokeDeviceReceipt, SendMessageInput,
        SessionSnapshot, StartSessionInput, TakeOverInput, ThreadsResponse,
    },
};

use super::persistence::{spawn_persistence_task, PersistedRelayState, PersistenceStore};
use super::{
    expire_controller_if_needed, filter_threads, non_empty, require_device_id, short_device_id,
    unix_now, RelayState, SecurityProfile, THREAD_SCAN_LIMIT,
};

#[derive(Clone)]
pub struct AppState {
    relay: Arc<RwLock<RelayState>>,
    codex: Arc<CodexBridge>,
    change_tx: watch::Sender<u64>,
}

impl AppState {
    pub async fn new() -> Result<Self, String> {
        let security = SecurityProfile::from_env()?;
        let cwd = std::env::current_dir()
            .map_err(|error| format!("failed to resolve current directory: {error}"))?
            .canonicalize()
            .map_err(|error| format!("failed to canonicalize current directory: {error}"))?;
        let persistence = PersistenceStore::resolve(&cwd);
        let restored_state = match persistence.load().await {
            Ok(state) => state,
            Err(error) => {
                warn!(
                    "failed to load relay state from {}: {}",
                    persistence.path().display(),
                    error
                );
                None
            }
        };
        let (change_tx, _) = watch::channel(0_u64);
        let relay = Arc::new(RwLock::new(RelayState::new(
            cwd.display().to_string(),
            change_tx.clone(),
            security,
        )));

        if let Some(ref persisted) = restored_state {
            let mut relay = relay.write().await;
            relay.apply_persisted(persisted);
            relay.push_log(
                "info",
                format!(
                    "Loaded persisted relay state from {}.",
                    persistence.path().display()
                ),
            );
            relay.notify();
        }

        {
            let mut relay = relay.write().await;
            relay.push_log("info", security.summary());
        }

        let codex = Arc::new(CodexBridge::spawn(relay.clone()).await?);
        spawn_persistence_task(relay.clone(), change_tx.subscribe(), persistence.clone());

        let state = Self {
            relay,
            codex,
            change_tx,
        };

        crate::broker::spawn_broker_task(state.clone())?;

        if let Some(persisted) = restored_state {
            state.restore_persisted_session(persisted).await;
        }

        Ok(state)
    }

    pub async fn snapshot(&self) -> SessionSnapshot {
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        relay.snapshot()
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.change_tx.subscribe()
    }

    pub async fn list_threads(
        &self,
        limit: usize,
        cwd: Option<String>,
    ) -> Result<ThreadsResponse, String> {
        let cwd = non_empty(cwd);
        let scan_limit = if cwd.is_some() {
            limit.max(THREAD_SCAN_LIMIT)
        } else {
            limit
        };
        let threads = self.codex.list_threads(scan_limit).await?;
        let response_threads = filter_threads(threads.clone(), cwd.as_deref(), limit);
        let mut relay = self.relay.write().await;
        relay.threads = threads;
        relay.notify();
        Ok(ThreadsResponse {
            threads: response_threads,
        })
    }

    pub async fn start_session(&self, input: StartSessionInput) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let defaults = self.defaults().await;
        let cwd = non_empty(input.cwd).unwrap_or(defaults.current_cwd);
        let model = non_empty(input.model).unwrap_or(defaults.model);
        let approval_policy = non_empty(input.approval_policy).unwrap_or(defaults.approval_policy);
        let sandbox = non_empty(input.sandbox).unwrap_or(defaults.sandbox);
        let effort = non_empty(input.effort).unwrap_or(defaults.reasoning_effort);

        let thread = self
            .codex
            .start_thread(&cwd, &model, &approval_policy, &sandbox)
            .await?;

        {
            let mut relay = self.relay.write().await;
            relay.activate_thread(
                thread,
                &cwd,
                &model,
                &approval_policy,
                &sandbox,
                &effort,
                &device_id,
            );
            relay.push_log(
                "info",
                format!(
                    "Started a new Codex thread in {cwd}. Control is now on {}.",
                    short_device_id(&device_id)
                ),
            );
            relay.notify();
        }

        if let Some(initial_prompt) = non_empty(input.initial_prompt) {
            return self
                .send_message(SendMessageInput {
                    text: initial_prompt,
                    effort: Some(effort),
                    device_id: Some(device_id),
                })
                .await;
        }

        let _ = self.list_threads(20, None).await;
        Ok(self.snapshot().await)
    }

    pub async fn resume_session(
        &self,
        input: ResumeSessionInput,
    ) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let defaults = self.defaults().await;
        let approval_policy = non_empty(input.approval_policy).unwrap_or(defaults.approval_policy);
        let sandbox = non_empty(input.sandbox).unwrap_or(defaults.sandbox);
        let effort = non_empty(input.effort).unwrap_or(defaults.reasoning_effort);

        self.codex
            .resume_thread(&input.thread_id, &approval_policy, &sandbox)
            .await?;

        let thread_data = self.codex.read_thread(&input.thread_id).await?;
        {
            let mut relay = self.relay.write().await;
            relay.load_thread_data(thread_data, &approval_policy, &sandbox, &effort, &device_id);
            relay.push_log(
                "info",
                format!(
                    "Resumed thread {}. Control is now on {}.",
                    input.thread_id,
                    short_device_id(&device_id)
                ),
            );
            relay.notify();
        }

        let _ = self.list_threads(20, None).await;
        Ok(self.snapshot().await)
    }

    pub async fn send_message(&self, input: SendMessageInput) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        self.expire_stale_controller_if_needed().await;
        let defaults = self.defaults().await;
        let text = non_empty(Some(input.text))
            .ok_or_else(|| "message text cannot be empty".to_string())?;
        let effort = non_empty(input.effort).unwrap_or(defaults.reasoning_effort);
        let thread_id = {
            let relay = self.relay.read().await;
            relay.ensure_device_can_send_message(&device_id)?;
            relay
                .active_thread_id
                .clone()
                .ok_or_else(|| "there is no active Codex thread to send to".to_string())?
        };

        let turn_id = self.codex.start_turn(&thread_id, &text, &effort).await?;
        {
            let mut relay = self.relay.write().await;
            relay.assign_active_controller(&device_id, unix_now());
            relay.active_turn_id = turn_id;
            relay.reasoning_effort = effort.clone();
            relay.push_log(
                "info",
                format!("Sent a prompt to thread {thread_id} with {effort} effort."),
            );
            relay.notify();
        }

        Ok(self.snapshot().await)
    }

    pub async fn heartbeat_session(
        &self,
        input: HeartbeatInput,
    ) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        relay.refresh_controller_lease(&device_id, unix_now());
        Ok(relay.snapshot())
    }

    pub async fn take_over_control(&self, input: TakeOverInput) -> Result<SessionSnapshot, String> {
        let device_id = require_device_id(input.device_id)?;
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
        if relay.active_thread_id.is_none() {
            return Err("there is no active session to take over".to_string());
        }

        let changed = relay.set_active_controller(&device_id);
        if changed {
            relay.push_log(
                "info",
                format!("Control moved to {}.", short_device_id(&device_id)),
            );
            relay.notify();
        }

        Ok(relay.snapshot())
    }

    pub async fn decide_approval(
        &self,
        request_id: &str,
        input: ApprovalDecisionInput,
    ) -> Result<ApprovalReceipt, ApprovalError> {
        let device_id =
            require_device_id(input.device_id.clone()).map_err(ApprovalError::Bridge)?;
        let pending = {
            let relay = self.relay.read().await;
            relay
                .ensure_device_can_approve(&device_id)
                .map_err(ApprovalError::Bridge)?;
            relay
                .pending_approvals
                .get(request_id)
                .cloned()
                .ok_or(ApprovalError::NoPendingRequest)?
        };

        self.codex
            .respond_to_approval(&pending, &input)
            .await
            .map_err(ApprovalError::Bridge)?;

        let mut relay = self.relay.write().await;
        relay.pending_approvals.remove(request_id);
        relay.push_log(
            "info",
            format!(
                "Responded to approval {request_id} with {:?} from {}.",
                input.decision,
                short_device_id(&device_id)
            ),
        );
        relay.notify();

        Ok(ApprovalReceipt {
            request_id: request_id.to_string(),
            decision: input.decision,
            resulting_state: "approval_response_sent".to_string(),
            message: match input.decision {
                ApprovalDecision::Approve => "Remote approval sent to Codex.".to_string(),
                ApprovalDecision::Deny => "Remote denial sent to Codex.".to_string(),
                ApprovalDecision::Cancel => "Remote cancel sent to Codex.".to_string(),
            },
        })
    }

    pub async fn start_pairing(
        &self,
        input: PairingStartInput,
    ) -> Result<PairingTicketView, String> {
        let broker = BrokerConfig::from_env()?.ok_or_else(|| {
            "broker pairing is unavailable because RELAY_BROKER_URL is not configured".to_string()
        })?;

        let mut relay = self.relay.write().await;
        let ticket = relay.issue_pairing_ticket(
            broker.public_base_url(),
            &broker.channel_id,
            &broker.peer_id,
            input.expires_in_seconds,
        );
        relay.push_log(
            "info",
            format!(
                "Started pairing ticket {} for broker channel {}.",
                ticket.pairing_id, ticket.broker_channel_id
            ),
        );
        relay.notify();
        Ok(ticket)
    }

    pub async fn revoke_device(&self, device_id: &str) -> Result<RevokeDeviceReceipt, String> {
        let mut relay = self.relay.write().await;
        let revoked = relay.revoke_paired_device(device_id);
        if revoked {
            relay.push_log("info", format!("Revoked paired device {device_id}."));
            relay.notify();
        }
        Ok(RevokeDeviceReceipt {
            device_id: device_id.to_string(),
            revoked,
        })
    }

    pub async fn decide_pairing_request(
        &self,
        pairing_id: &str,
        input: PairingDecisionInput,
    ) -> Result<PairingDecisionReceipt, String> {
        let mut relay = self.relay.write().await;
        let result = relay.decide_pairing_request(
            pairing_id,
            matches!(input.decision, PairingDecision::Approve),
            unix_now(),
        )?;
        let message = match input.decision {
            PairingDecision::Approve => {
                relay.push_log(
                    "info",
                    format!(
                        "Approved pairing request {pairing_id} for {}.",
                        result
                            .device
                            .as_ref()
                            .map(|device| device.device_id.as_str())
                            .unwrap_or("unknown-device")
                    ),
                );
                "Pairing request approved on the local relay.".to_string()
            }
            PairingDecision::Reject => {
                relay.push_log(
                    "info",
                    format!("Rejected pairing request {pairing_id}."),
                );
                "Pairing request rejected on the local relay.".to_string()
            }
        };
        relay
            .pending_broker_messages
            .push(super::BrokerPendingMessage::PairingResult(result));
        relay.notify();
        Ok(PairingDecisionReceipt {
            pairing_id: pairing_id.to_string(),
            decision: input.decision,
            resulting_state: match input.decision {
                PairingDecision::Approve => "approved".to_string(),
                PairingDecision::Reject => "rejected".to_string(),
            },
            message,
        })
    }

    async fn defaults(&self) -> SessionDefaults {
        let relay = self.relay.read().await;
        SessionDefaults {
            current_cwd: relay.current_cwd.clone(),
            model: relay.model.clone(),
            approval_policy: relay.approval_policy.clone(),
            sandbox: relay.sandbox.clone(),
            reasoning_effort: relay.reasoning_effort.clone(),
        }
    }

    async fn expire_stale_controller_if_needed(&self) {
        let mut relay = self.relay.write().await;
        expire_controller_if_needed(&mut relay);
    }

    async fn restore_persisted_session(&self, persisted: PersistedRelayState) {
        let Some(thread_id) = persisted.active_thread_id.clone() else {
            return;
        };

        let restore_result = match self
            .codex
            .resume_thread(&thread_id, &persisted.approval_policy, &persisted.sandbox)
            .await
        {
            Ok(()) => self.codex.read_thread(&thread_id).await,
            Err(error) => Err(error),
        };

        match restore_result {
            Ok(thread_data) => {
                let mut relay = self.relay.write().await;
                relay.restore_thread_data(thread_data, &persisted);
                expire_controller_if_needed(&mut relay);
                relay.push_log(
                    "info",
                    format!("Restored persisted session for thread {thread_id}."),
                );
                relay.notify();
            }
            Err(error) => {
                let mut relay = self.relay.write().await;
                relay.clear_active_session();
                relay.push_log(
                    "warn",
                    format!("Failed to restore persisted session for thread {thread_id}: {error}"),
                );
                relay.notify();
            }
        }
    }

    pub(crate) async fn set_broker_channel(
        &self,
        channel_id: Option<String>,
        peer_id: Option<String>,
    ) {
        let mut relay = self.relay.write().await;
        relay.set_broker_target(channel_id, peer_id);
        relay.notify();
    }

    pub(crate) async fn set_broker_connection(&self, connected: bool) {
        let mut relay = self.relay.write().await;
        if relay.broker_connected == connected {
            return;
        }
        relay.set_broker_connection(connected);
        relay.notify();
    }

    pub(crate) async fn push_runtime_log(&self, kind: &'static str, message: String) {
        let mut relay = self.relay.write().await;
        relay.push_log(kind, message);
        relay.notify();
    }

    pub(crate) async fn complete_pairing(
        &self,
        pairing_id: &str,
        requested_device_id: Option<String>,
        device_label: Option<String>,
        device_verify_key: String,
        peer_id: &str,
    ) -> Result<crate::protocol::PendingPairingRequestView, String> {
        let mut relay = self.relay.write().await;
        let request = relay.register_pairing_request(
            pairing_id,
            requested_device_id,
            device_label,
            peer_id,
            device_verify_key,
            unix_now(),
        )?;
        relay.push_log(
            "info",
            format!(
                "Registered pending pairing request {} from broker peer {}.",
                pairing_id, peer_id
            ),
        );
        relay.notify();
        Ok(request)
    }

    pub(crate) async fn drain_pending_broker_messages(&self) -> Vec<super::BrokerPendingMessage> {
        let mut relay = self.relay.write().await;
        relay.drain_pending_broker_messages()
    }

    pub(crate) async fn authenticate_remote_device(
        &self,
        device_id: &str,
        device_token: &str,
        peer_id: &str,
    ) -> Result<String, String> {
        let mut relay = self.relay.write().await;
        let device_id =
            relay.authenticate_paired_device(device_id, device_token, peer_id, unix_now())?;
        relay.notify();
        Ok(device_id)
    }

    pub(crate) async fn pending_pairing_secret(&self, pairing_id: &str) -> Result<String, String> {
        let mut relay = self.relay.write().await;
        relay.pending_pairing_secret(pairing_id, unix_now())
    }

    pub(crate) async fn completed_pairing_result(
        &self,
        pairing_id: &str,
        device_verify_key: &str,
        peer_id: &str,
    ) -> Result<Option<super::PendingPairingResult>, String> {
        let mut relay = self.relay.write().await;
        relay.completed_pairing_result(pairing_id, device_verify_key, peer_id, unix_now())
    }

    pub(crate) async fn paired_device_secret(&self, device_id: &str) -> Result<String, String> {
        let relay = self.relay.read().await;
        relay.paired_device_shared_secret(device_id)
    }

    pub(crate) async fn mark_remote_device_seen(
        &self,
        device_id: &str,
        peer_id: &str,
    ) -> Result<(), String> {
        let mut relay = self.relay.write().await;
        relay.mark_paired_device_seen(device_id, peer_id, unix_now())?;
        relay.notify();
        Ok(())
    }

    pub(crate) async fn broker_can_read_content(&self) -> bool {
        let relay = self.relay.read().await;
        relay.snapshot().broker_can_read_content
    }

    pub(crate) async fn broker_targets(&self) -> Vec<BrokerTarget> {
        let relay = self.relay.read().await;
        relay
            .paired_devices
            .values()
            .filter_map(|device| {
                device.last_peer_id.as_ref().map(|peer_id| BrokerTarget {
                    device_id: device.device_id.clone(),
                    peer_id: peer_id.clone(),
                    shared_secret: device.shared_secret.clone(),
                })
            })
            .collect()
    }
}

#[derive(Debug)]
pub enum ApprovalError {
    NoPendingRequest,
    Bridge(String),
}

#[derive(Clone)]
struct SessionDefaults {
    current_cwd: String,
    model: String,
    approval_policy: String,
    sandbox: String,
    reasoning_effort: String,
}

#[derive(Clone)]
pub(crate) struct BrokerTarget {
    pub(crate) device_id: String,
    pub(crate) peer_id: String,
    pub(crate) shared_secret: String,
}
