//! Task team — the relay-side surface.
//!
//! Nothing lives here anymore. The RECORD is a serialization contract and sits in
//! `relay-api`, where the relay that persists it, the views the UI renders, and
//! the engine that advances it can all name it. The DECISION layer — the
//! transition table, the reply parsers, the prompts — is behind
//! `relay_api::TeamBrain`, which a build may or may not have.
//!
//! This module remains only so every existing `crate::state::…` path keeps
//! resolving.

pub(crate) use relay_api::team::*;
