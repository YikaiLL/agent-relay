//! Task team — the relay-side surface.
//!
//! Nothing lives here anymore. The RECORD is a serialization contract and sits in
//! `relay-api`, where the relay that persists it, the views the UI renders, and
//! the engine that advances it can all name it. The PRODUCT layer — driver loop,
//! phase transitions, reply parsers, and prompts — is behind
//! `relay_api::TeamDriver`, which a build may or may not have. The public relay
//! implements only `TeamPort`.
//!
//! This module remains only so every existing `crate::state::…` path keeps
//! resolving.

pub(crate) use relay_api::team::*;
