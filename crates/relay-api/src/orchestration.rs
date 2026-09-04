//! Content-blind orchestration protocol.
//!
//! This module is the public, shared vocabulary for a future Cloud driver and a
//! future local sidecar. It deliberately contains no transport, entitlement,
//! template execution, provider calls, repository access, or driver policy.
//!
//! The privacy contract is allowlist-only. Cloud-visible messages may contain:
//! closed enums, counters, booleans, protocol and driver versions, stable
//! command/event identities, expected revisions, opaque ids, and opaque artifact
//! references. They must not contain task prose, repository paths or content,
//! prompts, transcripts, diffs, findings, logs, URLs, shell commands, arbitrary
//! text/blob fields, or `serde_json::Value`.

use std::{fmt, marker::PhantomData};

use serde::{
    de::{self, IgnoredAny, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize, Serializer,
};

/// First protocol version defined by the public repository.
pub const CURRENT_PROTOCOL_VERSION: u32 = 1;
/// Oldest protocol version this crate can negotiate.
pub const MIN_PROTOCOL_VERSION: u32 = 1;

pub const MAX_OPAQUE_ID_LEN: usize = 96;
pub const MAX_DRIVER_VERSION_LEN: usize = 64;
pub const MAX_COMMAND_BINDINGS: usize = 16;
pub const MAX_CANDIDATE_THREADS: usize = 16;
pub const MAX_CURSOR_ARTIFACTS: usize = 64;

/// Error produced while constructing a bounded protocol value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolValueError {
    Empty(&'static str),
    TooLong {
        field: &'static str,
        max: usize,
        actual: usize,
    },
    InvalidCharacter {
        field: &'static str,
        character: char,
    },
    TooManyItems {
        field: &'static str,
        max: usize,
        actual: usize,
    },
    NoCompatibleProtocol {
        local_min: u32,
        local_max: u32,
        peer_min: u32,
        peer_max: u32,
    },
    InvalidRange {
        min: u32,
        max: u32,
    },
}

impl fmt::Display for ProtocolValueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty(field) => write!(f, "{field} must not be empty"),
            Self::TooLong { field, max, actual } => {
                write!(f, "{field} is too long ({actual} > {max})")
            }
            Self::InvalidCharacter { field, character } => {
                write!(f, "{field} contains invalid character {character:?}")
            }
            Self::TooManyItems { field, max, actual } => {
                write!(f, "{field} has too many items ({actual} > {max})")
            }
            Self::NoCompatibleProtocol {
                local_min,
                local_max,
                peer_min,
                peer_max,
            } => write!(
                f,
                "no compatible orchestration protocol version (local {local_min}-{local_max}, peer {peer_min}-{peer_max})"
            ),
            Self::InvalidRange { min, max } => {
                write!(f, "invalid protocol version range {min}-{max}")
            }
        }
    }
}

impl std::error::Error for ProtocolValueError {}

fn validate_token(
    field: &'static str,
    raw: impl Into<String>,
    max_len: usize,
) -> Result<String, ProtocolValueError> {
    let raw = raw.into();
    if raw.is_empty() {
        return Err(ProtocolValueError::Empty(field));
    }
    if raw.len() > max_len {
        return Err(ProtocolValueError::TooLong {
            field,
            max: max_len,
            actual: raw.len(),
        });
    }
    for character in raw.chars() {
        let allowed = character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.');
        if !allowed {
            return Err(ProtocolValueError::InvalidCharacter { field, character });
        }
    }
    Ok(raw)
}

fn deserialize_supported_protocol_version<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let version = u32::deserialize(deserializer)?;
    if (MIN_PROTOCOL_VERSION..=CURRENT_PROTOCOL_VERSION).contains(&version) {
        Ok(version)
    } else {
        Err(de::Error::custom(format!(
            "unsupported orchestration protocol version {version}"
        )))
    }
}

struct LenientString(Option<String>);

impl<'de> Deserialize<'de> for LenientString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct LenientStringVisitor;

        impl<'de> Visitor<'de> for LenientStringVisitor {
            type Value = LenientString;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a string-like persisted field")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(Some(value.to_owned())))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(Some(value)))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(None))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(None))
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                LenientString::deserialize(deserializer)
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(None))
            }

            fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(None))
            }

            fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(None))
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientString(None))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(LenientString(None))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(LenientString(None))
            }
        }

        deserializer.deserialize_any(LenientStringVisitor)
    }
}

struct LenientU32(Option<u32>);

impl<'de> Deserialize<'de> for LenientU32 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct LenientU32Visitor;

        impl<'de> Visitor<'de> for LenientU32Visitor {
            type Value = LenientU32;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a u32-like persisted field")
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(u32::try_from(value).ok()))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(u32::try_from(value).ok()))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(None))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(None))
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                LenientU32::deserialize(deserializer)
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(None))
            }

            fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(None))
            }

            fn visit_string<E>(self, _value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(None))
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU32(None))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(LenientU32(None))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(LenientU32(None))
            }
        }

        deserializer.deserialize_any(LenientU32Visitor)
    }
}

struct LenientU64(Option<u64>);

impl<'de> Deserialize<'de> for LenientU64 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct LenientU64Visitor;

        impl<'de> Visitor<'de> for LenientU64Visitor {
            type Value = LenientU64;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a u64-like persisted field")
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(Some(value)))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(u64::try_from(value).ok()))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(None))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(None))
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                LenientU64::deserialize(deserializer)
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(None))
            }

            fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(None))
            }

            fn visit_string<E>(self, _value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(None))
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(LenientU64(None))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(LenientU64(None))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(LenientU64(None))
            }
        }

        deserializer.deserialize_any(LenientU64Visitor)
    }
}

macro_rules! bounded_token {
    ($name:ident, $field:literal, $max:expr) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            pub fn new(raw: impl Into<String>) -> Result<Self, ProtocolValueError> {
                validate_token($field, raw, $max).map(Self)
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let raw = String::deserialize(deserializer)?;
                Self::new(raw).map_err(de::Error::custom)
            }
        }
    };
}

bounded_token!(CommandId, "command_id", MAX_OPAQUE_ID_LEN);
bounded_token!(EventId, "event_id", MAX_OPAQUE_ID_LEN);
bounded_token!(DriverRunId, "driver_run_id", MAX_OPAQUE_ID_LEN);
bounded_token!(ThreadHandle, "thread_handle", MAX_OPAQUE_ID_LEN);
bounded_token!(TemplateId, "template_id", MAX_OPAQUE_ID_LEN);
bounded_token!(ArtifactId, "artifact_id", MAX_OPAQUE_ID_LEN);
bounded_token!(DriverVersion, "driver_version", MAX_DRIVER_VERSION_LEN);

/// A vector whose deserializer rejects oversized protocol payloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedVec<T, const MAX: usize> {
    items: Vec<T>,
}

impl<T, const MAX: usize> BoundedVec<T, MAX> {
    pub fn new(field: &'static str, items: Vec<T>) -> Result<Self, ProtocolValueError> {
        if items.len() > MAX {
            return Err(ProtocolValueError::TooManyItems {
                field,
                max: MAX,
                actual: items.len(),
            });
        }
        Ok(Self { items })
    }

    pub fn empty() -> Self {
        Self { items: Vec::new() }
    }

    pub fn as_slice(&self) -> &[T] {
        &self.items
    }

    pub fn into_vec(self) -> Vec<T> {
        self.items
    }
}

impl<T, const MAX: usize> Default for BoundedVec<T, MAX> {
    fn default() -> Self {
        Self::empty()
    }
}

impl<T, const MAX: usize> Serialize for BoundedVec<T, MAX>
where
    T: Serialize,
{
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.items.serialize(serializer)
    }
}

impl<'de, T, const MAX: usize> Deserialize<'de> for BoundedVec<T, MAX>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct BoundedVecVisitor<T, const MAX: usize> {
            marker: PhantomData<T>,
        }

        impl<'de, T, const MAX: usize> Visitor<'de> for BoundedVecVisitor<T, MAX>
        where
            T: Deserialize<'de>,
        {
            type Value = BoundedVec<T, MAX>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "a bounded sequence with at most {MAX} items")
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let capacity = seq.size_hint().unwrap_or(0).min(MAX);
                let mut items = Vec::with_capacity(capacity);
                while let Some(item) = seq.next_element()? {
                    if items.len() == MAX {
                        return Err(de::Error::custom(ProtocolValueError::TooManyItems {
                            field: "bounded_vector",
                            max: MAX,
                            actual: MAX + 1,
                        }));
                    }
                    items.push(item);
                }
                Ok(BoundedVec { items })
            }
        }

        deserializer.deserialize_seq(BoundedVecVisitor {
            marker: PhantomData,
        })
    }
}

/// Durable backend pin for one task-team run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrchestrationBackendRef {
    /// The current in-process private driver. This is the default for all
    /// existing and newly-created runs in T1-T3.
    LegacyEmbedded,
    /// Future hosted content-blind driver. It is inert until a later task adds a
    /// transport and executor.
    Cloud {
        protocol_version: u32,
        driver_version: DriverVersion,
        cloud_run_id: DriverRunId,
    },
    /// Future licensed local sidecar. It is inert until a later task adds IPC.
    LocalSidecar {
        protocol_version: u32,
        driver_version: DriverVersion,
    },
    /// A backend written by a newer build. The run record survives, but this
    /// build must not execute it.
    UnknownNonExecuting,
}

impl Default for OrchestrationBackendRef {
    fn default() -> Self {
        Self::LegacyEmbedded
    }
}

impl OrchestrationBackendRef {
    pub fn kind(&self) -> OrchestrationBackendKind {
        match self {
            Self::LegacyEmbedded => OrchestrationBackendKind::LegacyEmbedded,
            Self::Cloud { .. } => OrchestrationBackendKind::Cloud,
            Self::LocalSidecar { .. } => OrchestrationBackendKind::LocalSidecar,
            Self::UnknownNonExecuting => OrchestrationBackendKind::UnknownNonExecuting,
        }
    }

    pub fn is_legacy_embedded(&self) -> bool {
        matches!(self, Self::LegacyEmbedded)
    }

    pub fn non_executing_reason(&self) -> Option<&'static str> {
        match self {
            Self::LegacyEmbedded => None,
            Self::Cloud { .. } => Some(
                "this task is pinned to Cloud orchestration, but this relay build has no Cloud transport",
            ),
            Self::LocalSidecar { .. } => Some(
                "this task is pinned to a local sidecar, but this relay build has no sidecar transport",
            ),
            Self::UnknownNonExecuting => Some(
                "this task is pinned to an orchestration backend this relay build does not understand",
            ),
        }
    }
}

impl Serialize for OrchestrationBackendRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeMap;

        let mut len = 1;
        if matches!(self, Self::Cloud { .. }) {
            len = 4;
        } else if matches!(self, Self::LocalSidecar { .. }) {
            len = 3;
        }
        let mut map = serializer.serialize_map(Some(len))?;
        match self {
            Self::LegacyEmbedded => {
                map.serialize_entry("kind", "legacy_embedded")?;
            }
            Self::Cloud {
                protocol_version,
                driver_version,
                cloud_run_id,
            } => {
                map.serialize_entry("kind", "cloud")?;
                map.serialize_entry("protocol_version", protocol_version)?;
                map.serialize_entry("driver_version", driver_version)?;
                map.serialize_entry("cloud_run_id", cloud_run_id)?;
            }
            Self::LocalSidecar {
                protocol_version,
                driver_version,
            } => {
                map.serialize_entry("kind", "local_sidecar")?;
                map.serialize_entry("protocol_version", protocol_version)?;
                map.serialize_entry("driver_version", driver_version)?;
            }
            Self::UnknownNonExecuting => {
                map.serialize_entry("kind", "unknown_non_executing")?;
            }
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for OrchestrationBackendRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        enum Field {
            Kind,
            ProtocolVersion,
            DriverVersion,
            CloudRunId,
            Unknown,
        }

        impl<'de> Deserialize<'de> for Field {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let raw = String::deserialize(deserializer)?;
                Ok(match raw.as_str() {
                    "kind" => Self::Kind,
                    "protocol_version" => Self::ProtocolVersion,
                    "driver_version" => Self::DriverVersion,
                    "cloud_run_id" => Self::CloudRunId,
                    _ => Self::Unknown,
                })
            }
        }

        struct BackendVisitor;

        impl<'de> Visitor<'de> for BackendVisitor {
            type Value = OrchestrationBackendRef;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an orchestration backend object")
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::UnknownNonExecuting)
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::UnknownNonExecuting)
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::UnknownNonExecuting)
            }

            fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::UnknownNonExecuting)
            }

            fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::UnknownNonExecuting)
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::UnknownNonExecuting)
            }

            fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::UnknownNonExecuting)
            }

            fn visit_string<E>(self, _value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(OrchestrationBackendRef::UnknownNonExecuting)
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(OrchestrationBackendRef::UnknownNonExecuting)
            }

            fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut kind: Option<String> = None;
                let mut protocol_version: Option<u32> = None;
                let mut driver_version: Option<String> = None;
                let mut cloud_run_id: Option<String> = None;
                let mut unsupported_shape = false;
                let mut kind_seen = false;
                let mut protocol_version_seen = false;
                let mut driver_version_seen = false;
                let mut cloud_run_id_seen = false;

                while let Some(field) = map.next_key()? {
                    match field {
                        Field::Kind => {
                            if kind_seen {
                                unsupported_shape = true;
                                let _: IgnoredAny = map.next_value()?;
                                continue;
                            }
                            kind_seen = true;
                            kind = map.next_value::<LenientString>()?.0;
                            if kind.is_none() {
                                unsupported_shape = true;
                            }
                        }
                        Field::ProtocolVersion => {
                            if protocol_version_seen {
                                unsupported_shape = true;
                                let _: IgnoredAny = map.next_value()?;
                                continue;
                            }
                            protocol_version_seen = true;
                            protocol_version = map.next_value::<LenientU32>()?.0;
                            if protocol_version.is_none() {
                                unsupported_shape = true;
                            }
                        }
                        Field::DriverVersion => {
                            if driver_version_seen {
                                unsupported_shape = true;
                                let _: IgnoredAny = map.next_value()?;
                                continue;
                            }
                            driver_version_seen = true;
                            driver_version = map.next_value::<LenientString>()?.0;
                            if driver_version.is_none() {
                                unsupported_shape = true;
                            }
                        }
                        Field::CloudRunId => {
                            if cloud_run_id_seen {
                                unsupported_shape = true;
                                let _: IgnoredAny = map.next_value()?;
                                continue;
                            }
                            cloud_run_id_seen = true;
                            cloud_run_id = map.next_value::<LenientString>()?.0;
                            if cloud_run_id.is_none() {
                                unsupported_shape = true;
                            }
                        }
                        Field::Unknown => {
                            unsupported_shape = true;
                            let _: IgnoredAny = map.next_value()?;
                        }
                    }
                }

                match kind.as_deref() {
                    None => Ok(OrchestrationBackendRef::UnknownNonExecuting),
                    Some("legacy_embedded") => {
                        if unsupported_shape
                            || protocol_version.is_some()
                            || driver_version.is_some()
                            || cloud_run_id.is_some()
                        {
                            return Ok(OrchestrationBackendRef::UnknownNonExecuting);
                        }
                        Ok(OrchestrationBackendRef::LegacyEmbedded)
                    }
                    Some("cloud") => {
                        if unsupported_shape {
                            return Ok(OrchestrationBackendRef::UnknownNonExecuting);
                        }
                        let Some(protocol_version) = protocol_version else {
                            return Ok(OrchestrationBackendRef::UnknownNonExecuting);
                        };
                        let Some(driver_version) =
                            driver_version.and_then(|raw| DriverVersion::new(raw).ok())
                        else {
                            return Ok(OrchestrationBackendRef::UnknownNonExecuting);
                        };
                        let Some(cloud_run_id) =
                            cloud_run_id.and_then(|raw| DriverRunId::new(raw).ok())
                        else {
                            return Ok(OrchestrationBackendRef::UnknownNonExecuting);
                        };
                        Ok(OrchestrationBackendRef::Cloud {
                            protocol_version,
                            driver_version,
                            cloud_run_id,
                        })
                    }
                    Some("local_sidecar") => {
                        if unsupported_shape || cloud_run_id.is_some() {
                            return Ok(OrchestrationBackendRef::UnknownNonExecuting);
                        }
                        let Some(protocol_version) = protocol_version else {
                            return Ok(OrchestrationBackendRef::UnknownNonExecuting);
                        };
                        let Some(driver_version) =
                            driver_version.and_then(|raw| DriverVersion::new(raw).ok())
                        else {
                            return Ok(OrchestrationBackendRef::UnknownNonExecuting);
                        };
                        Ok(OrchestrationBackendRef::LocalSidecar {
                            protocol_version,
                            driver_version,
                        })
                    }
                    Some("unknown_non_executing") => {
                        Ok(OrchestrationBackendRef::UnknownNonExecuting)
                    }
                    Some(_) => Ok(OrchestrationBackendRef::UnknownNonExecuting),
                }
            }
        }

        deserializer.deserialize_any(BackendVisitor)
    }
}

/// Durable progress that lets a later command journal resume without guessing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DriverProgress {
    pub state_revision: u64,
    pub last_command_seq: u64,
    pub last_event_seq: u64,
    pub in_flight_command_id: Option<CommandId>,
}

impl<'de> Deserialize<'de> for DriverProgress {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        enum Field {
            StateRevision,
            LastCommandSeq,
            LastEventSeq,
            InFlightCommandId,
            Unknown,
        }

        impl<'de> Deserialize<'de> for Field {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let raw = String::deserialize(deserializer)?;
                Ok(match raw.as_str() {
                    "state_revision" => Self::StateRevision,
                    "last_command_seq" => Self::LastCommandSeq,
                    "last_event_seq" => Self::LastEventSeq,
                    "in_flight_command_id" => Self::InFlightCommandId,
                    _ => Self::Unknown,
                })
            }
        }

        struct ProgressVisitor;

        impl<'de> Visitor<'de> for ProgressVisitor {
            type Value = DriverProgress;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a persisted driver progress object")
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::default())
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::default())
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::default())
            }

            fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::default())
            }

            fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::default())
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::default())
            }

            fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::default())
            }

            fn visit_string<E>(self, _value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DriverProgress::default())
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(DriverProgress::default())
            }

            fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut progress = DriverProgress::default();
                let mut state_revision_seen = false;
                let mut last_command_seq_seen = false;
                let mut last_event_seq_seen = false;
                let mut in_flight_command_id_seen = false;

                while let Some(field) = map.next_key()? {
                    match field {
                        Field::StateRevision => {
                            if state_revision_seen {
                                let _: IgnoredAny = map.next_value()?;
                                continue;
                            }
                            state_revision_seen = true;
                            progress.state_revision =
                                map.next_value::<LenientU64>()?.0.unwrap_or_default();
                        }
                        Field::LastCommandSeq => {
                            if last_command_seq_seen {
                                let _: IgnoredAny = map.next_value()?;
                                continue;
                            }
                            last_command_seq_seen = true;
                            progress.last_command_seq =
                                map.next_value::<LenientU64>()?.0.unwrap_or_default();
                        }
                        Field::LastEventSeq => {
                            if last_event_seq_seen {
                                let _: IgnoredAny = map.next_value()?;
                                continue;
                            }
                            last_event_seq_seen = true;
                            progress.last_event_seq =
                                map.next_value::<LenientU64>()?.0.unwrap_or_default();
                        }
                        Field::InFlightCommandId => {
                            if in_flight_command_id_seen {
                                let _: IgnoredAny = map.next_value()?;
                                continue;
                            }
                            in_flight_command_id_seen = true;
                            progress.in_flight_command_id = map
                                .next_value::<LenientString>()?
                                .0
                                .and_then(|raw| CommandId::new(raw).ok());
                        }
                        Field::Unknown => {
                            let _: IgnoredAny = map.next_value()?;
                        }
                    }
                }

                Ok(progress)
            }
        }

        deserializer.deserialize_any(ProgressVisitor)
    }
}

/// Backend kind safe for a driver cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrchestrationBackendKind {
    LegacyEmbedded,
    Cloud,
    LocalSidecar,
    UnknownNonExecuting,
}

/// Sanitized team status for the content-blind driver cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriverRunStatus {
    Queued,
    Running,
    PausePending,
    Paused,
    AwaitingUser,
    Done,
    Escalated,
    Blocked,
    Resolving,
    Failed,
    Interrupted,
    Cancelled,
}

impl DriverRunStatus {
    pub fn from_team_status(status: crate::team::TeamRunStatus) -> Self {
        match status {
            crate::team::TeamRunStatus::Queued => Self::Queued,
            crate::team::TeamRunStatus::Running => Self::Running,
            crate::team::TeamRunStatus::PausePending => Self::PausePending,
            crate::team::TeamRunStatus::Paused => Self::Paused,
            crate::team::TeamRunStatus::AwaitingUser => Self::AwaitingUser,
            crate::team::TeamRunStatus::Done => Self::Done,
            crate::team::TeamRunStatus::Escalated => Self::Escalated,
            crate::team::TeamRunStatus::Blocked => Self::Blocked,
            crate::team::TeamRunStatus::Resolving => Self::Resolving,
            crate::team::TeamRunStatus::Failed => Self::Failed,
            crate::team::TeamRunStatus::Interrupted => Self::Interrupted,
            crate::team::TeamRunStatus::Cancelled => Self::Cancelled,
        }
    }
}

/// Sanitized team phase for the content-blind driver cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriverPhase {
    Intake,
    Design,
    DesignReview,
    Planning,
    SubTasks,
    MrGate,
    Wrapping,
    Finished,
}

impl DriverPhase {
    pub fn from_team_phase(phase: crate::team::TeamPhase) -> Self {
        match phase {
            crate::team::TeamPhase::Intake => Self::Intake,
            crate::team::TeamPhase::Design => Self::Design,
            crate::team::TeamPhase::DesignReview => Self::DesignReview,
            crate::team::TeamPhase::Planning => Self::Planning,
            crate::team::TeamPhase::SubTasks => Self::SubTasks,
            crate::team::TeamPhase::MrGate => Self::MrGate,
            crate::team::TeamPhase::Wrapping => Self::Wrapping,
            crate::team::TeamPhase::Finished => Self::Finished,
        }
    }
}

/// Stable role vocabulary for content-blind protocol v1.
///
/// This intentionally mirrors today's local [`crate::team::TeamRole`] variants
/// without reusing that enum on the wire; local runtime roles may evolve without
/// silently changing the v1 protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriverRole {
    Tl,
    Dev,
    Reviewer,
}

impl DriverRole {
    pub fn from_team_role(role: crate::team::TeamRole) -> Self {
        match role {
            crate::team::TeamRole::Tl => Self::Tl,
            crate::team::TeamRole::Dev => Self::Dev,
            crate::team::TeamRole::Reviewer => Self::Reviewer,
        }
    }

    pub fn as_team_role(self) -> crate::team::TeamRole {
        match self {
            Self::Tl => crate::team::TeamRole::Tl,
            Self::Dev => crate::team::TeamRole::Dev,
            Self::Reviewer => crate::team::TeamRole::Reviewer,
        }
    }
}

impl From<crate::team::TeamRole> for DriverRole {
    fn from(role: crate::team::TeamRole) -> Self {
        Self::from_team_role(role)
    }
}

/// A local artifact handle. The handle is opaque; resolving it is local-only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRef {
    pub artifact_id: ArtifactId,
    pub kind: ArtifactKind,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

/// Closed artifact classes. The bytes behind these classes never cross this
/// protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    TaskSpec,
    Plan,
    Design,
    Report,
    SubTaskBrief,
    WorkspaceDiff,
    ReviewVerdict,
    TranscriptDigest,
}

/// Which local template slot an artifact satisfies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactBindingSlot {
    TaskSpec,
    Plan,
    Design,
    Report,
    SubTaskBrief,
    Diff,
    Verdict,
    PriorSummary,
}

/// Binding from a closed slot to a local artifact reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactBinding {
    pub slot: ArtifactBindingSlot,
    pub artifact: ArtifactRef,
}

/// Minimal cursor a content-blind driver can use to choose the next command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DriverCursor {
    #[serde(deserialize_with = "deserialize_supported_protocol_version")]
    pub protocol_version: u32,
    pub backend: OrchestrationBackendKind,
    pub status: DriverRunStatus,
    pub phase: DriverPhase,
    pub state_revision: u64,
    pub last_command_seq: u64,
    pub last_event_seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_flight_command_id: Option<CommandId>,
    pub current_sub_task_index: u32,
    pub sub_task_count: u32,
    pub current_rounds_used: u32,
    pub max_review_rounds: u32,
    pub design_review_rounds: u32,
    pub mr_rounds_used: u32,
    pub tl_generation: u32,
    pub pause_requested: bool,
    pub awaiting_user: bool,
    #[serde(default)]
    pub artifacts: BoundedVec<ArtifactRef, MAX_CURSOR_ARTIFACTS>,
}

impl DriverCursor {
    pub fn from_team_run(
        run: &crate::team::TeamRun,
        artifacts: Vec<ArtifactRef>,
    ) -> Result<Self, ProtocolValueError> {
        let current = run.current_sub_task();
        let current_rounds_used = current
            .and_then(|index| run.sub_tasks.get(index))
            .map(|task| task.rounds_used)
            .unwrap_or(0);
        Ok(Self {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            backend: run.orchestration_backend.kind(),
            status: DriverRunStatus::from_team_status(run.status),
            phase: DriverPhase::from_team_phase(run.phase),
            state_revision: run.driver_progress.state_revision,
            last_command_seq: run.driver_progress.last_command_seq,
            last_event_seq: run.driver_progress.last_event_seq,
            in_flight_command_id: run.driver_progress.in_flight_command_id.clone(),
            current_sub_task_index: bounded_usize_to_u32(current.unwrap_or(run.sub_tasks.len())),
            sub_task_count: bounded_usize_to_u32(run.sub_tasks.len()),
            current_rounds_used,
            max_review_rounds: run.max_review_rounds,
            design_review_rounds: run.design_review_rounds,
            mr_rounds_used: run.mr_rounds_used,
            tl_generation: bounded_usize_to_u32(run.tl_generation_count()),
            pause_requested: run.pause_requested,
            awaiting_user: run.awaiting.is_some(),
            artifacts: BoundedVec::new("artifacts", artifacts)?,
        })
    }
}

fn bounded_usize_to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// Command envelope with stable identity and expected revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DriverCommandEnvelope {
    #[serde(deserialize_with = "deserialize_supported_protocol_version")]
    pub protocol_version: u32,
    pub command_id: CommandId,
    pub sequence: u64,
    pub expected_revision: u64,
    pub command: DriverCommand,
}

/// Closed commands a future content-blind driver may ask the local executor to
/// perform. Template ids and artifact bindings select audited local behavior;
/// they do not carry prompts or commands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DriverCommand {
    RequireWorkspace {},
    StartThread {
        role: DriverRole,
    },
    ResumeOrStartThread {
        role: DriverRole,
        candidates: BoundedVec<ThreadHandle, MAX_CANDIDATE_THREADS>,
    },
    RunTemplate {
        thread: ThreadHandle,
        role: DriverRole,
        template_id: TemplateId,
        bindings: BoundedVec<ArtifactBinding, MAX_COMMAND_BINDINGS>,
    },
    CheckpointCommit {},
    CollectDiff {
        scope: DiffScope,
    },
    MergeBase {
        target: MergeBaseTarget,
    },
    Commit {
        message_template_id: TemplateId,
        bindings: BoundedVec<ArtifactBinding, MAX_COMMAND_BINDINGS>,
    },
    PauseAtBoundary {},
    SettleRun {
        status: DriverRunStatus,
    },
}

/// Diff target selected without exposing refs or paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffScope {
    Head,
    CurrentSubTask,
    MergeBaseTarget,
}

/// Merge-base target selected by local policy, never by a driver-supplied ref.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeBaseTarget {
    PinnedTarget,
}

/// Event envelope returned by the local executor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DriverEventEnvelope {
    #[serde(deserialize_with = "deserialize_supported_protocol_version")]
    pub protocol_version: u32,
    pub event_id: EventId,
    pub sequence: u64,
    pub command_id: CommandId,
    pub observed_revision: u64,
    pub event: DriverEvent,
}

/// Closed events a local executor may return to a content-blind driver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DriverEvent {
    CommandAccepted {},
    CommandRejected {
        reason: CommandRejection,
    },
    WorkspaceReady {},
    ThreadReady {
        thread: ThreadHandle,
        role: DriverRole,
    },
    TurnFinished {
        outcome: TurnOutcomeKind,
        artifact: Option<ArtifactRef>,
    },
    DiffCollected {
        changed: bool,
        artifact: ArtifactRef,
    },
    MergeBaseResolved {
        available: bool,
        artifact: Option<ArtifactRef>,
    },
    CommitRecorded {
        changed: bool,
        artifact: Option<ArtifactRef>,
    },
    CursorAdvanced {
        cursor: DriverCursor,
    },
    RunSettled {
        status: DriverRunStatus,
    },
}

/// Closed refusal reasons. Human-readable diagnostics stay local.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandRejection {
    UnknownRevision,
    DuplicateCommand,
    StaleCommand,
    BackendMismatch,
    PermissionDenied,
    WorkspaceUnavailable,
    TemplateUnavailable,
    ArtifactUnavailable,
    ExecutorBusy,
    InvalidState,
    UnsupportedProtocol,
}

/// Closed turn outcome. Any text the provider produced is stored as a local
/// artifact and referenced separately.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcomeKind {
    Replied,
    Silent,
    Failed,
    Blocked,
}

/// Version range advertised by one endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ProtocolRange {
    pub min: u32,
    pub max: u32,
}

impl ProtocolRange {
    pub fn new(min: u32, max: u32) -> Result<Self, ProtocolValueError> {
        if min == 0 || max == 0 || min > max {
            return Err(ProtocolValueError::InvalidRange { min, max });
        }
        Ok(Self { min, max })
    }

    pub fn current() -> Self {
        Self {
            min: MIN_PROTOCOL_VERSION,
            max: CURRENT_PROTOCOL_VERSION,
        }
    }
}

impl<'de> Deserialize<'de> for ProtocolRange {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            min: u32,
            max: u32,
        }

        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.min, wire.max).map_err(de::Error::custom)
    }
}

/// Version negotiation request. Later transports can carry this as their first
/// typed message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolHello {
    pub supported: ProtocolRange,
    pub driver_version: DriverVersion,
    pub backend: OrchestrationBackendKind,
}

/// Successful protocol negotiation result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolNegotiation {
    #[serde(deserialize_with = "deserialize_supported_protocol_version")]
    pub selected_version: u32,
}

pub fn negotiate_protocol(
    local: ProtocolRange,
    peer: ProtocolRange,
) -> Result<ProtocolNegotiation, ProtocolValueError> {
    let local_min = local.min.max(MIN_PROTOCOL_VERSION);
    let local_max = local.max.min(CURRENT_PROTOCOL_VERSION);
    if local_min > local_max {
        return Err(ProtocolValueError::NoCompatibleProtocol {
            local_min,
            local_max,
            peer_min: peer.min,
            peer_max: peer.max,
        });
    }

    let min = local_min.max(peer.min);
    let max = local_max.min(peer.max);
    if min > max {
        return Err(ProtocolValueError::NoCompatibleProtocol {
            local_min,
            local_max,
            peer_min: peer.min,
            peer_max: peer.max,
        });
    }
    Ok(ProtocolNegotiation {
        selected_version: max,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team::{AwaitingUser, SubTask, SubTaskStatus, TaskSpec, TeamPhase, TeamRun};
    use std::collections::BTreeSet;

    fn token(raw: &str) -> TemplateId {
        TemplateId::new(raw).expect("valid test token")
    }

    fn artifact(raw: &str, kind: ArtifactKind) -> ArtifactRef {
        ArtifactRef {
            artifact_id: ArtifactId::new(raw).expect("valid artifact id"),
            kind,
            revision: 7,
            size_bytes: Some(42),
        }
    }

    fn binding(slot: ArtifactBindingSlot, raw: &str, kind: ArtifactKind) -> ArtifactBinding {
        ArtifactBinding {
            slot,
            artifact: artifact(raw, kind),
        }
    }

    fn assert_cloud_visible_json_is_allowlisted(value: &serde_json::Value) {
        let allowed_keys = BTreeSet::from([
            "artifact",
            "artifact_id",
            "artifacts",
            "available",
            "awaiting_user",
            "backend",
            "bindings",
            "candidates",
            "changed",
            "cloud_run_id",
            "command",
            "command_id",
            "cursor",
            "current_rounds_used",
            "current_sub_task_index",
            "design_review_rounds",
            "driver_version",
            "event",
            "event_id",
            "expected_revision",
            "in_flight_command_id",
            "kind",
            "last_command_seq",
            "last_event_seq",
            "max",
            "max_review_rounds",
            "message_template_id",
            "min",
            "mr_rounds_used",
            "observed_revision",
            "outcome",
            "pause_requested",
            "phase",
            "protocol_version",
            "reason",
            "revision",
            "role",
            "scope",
            "selected_version",
            "sequence",
            "size_bytes",
            "slot",
            "state_revision",
            "status",
            "sub_task_count",
            "supported",
            "target",
            "template_id",
            "thread",
            "tl_generation",
        ]);

        fn walk(value: &serde_json::Value, allowed_keys: &BTreeSet<&'static str>) {
            match value {
                serde_json::Value::Object(map) => {
                    for (key, value) in map {
                        assert!(
                            allowed_keys.contains(key.as_str()),
                            "unexpected Cloud-visible key {key:?} in {map:?}"
                        );
                        walk(value, allowed_keys);
                    }
                }
                serde_json::Value::Array(values) => {
                    for value in values {
                        walk(value, allowed_keys);
                    }
                }
                serde_json::Value::String(value) => {
                    for forbidden in ["CANARY", "http://", "https://", "/", "\n", "\r"] {
                        assert!(
                            !value.contains(forbidden),
                            "Cloud-visible string {value:?} contains forbidden marker {forbidden:?}"
                        );
                    }
                }
                serde_json::Value::Null
                | serde_json::Value::Bool(_)
                | serde_json::Value::Number(_) => {}
            }
        }

        walk(value, &allowed_keys);
    }

    fn command_envelope(command: DriverCommand, index: u64) -> DriverCommandEnvelope {
        DriverCommandEnvelope {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            command_id: CommandId::new(format!("cmd-{index}")).unwrap(),
            sequence: index,
            expected_revision: 9,
            command,
        }
    }

    fn event_envelope(event: DriverEvent, index: u64) -> DriverEventEnvelope {
        DriverEventEnvelope {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            event_id: EventId::new(format!("event-{index}")).unwrap(),
            sequence: index,
            command_id: CommandId::new(format!("cmd-{index}")).unwrap(),
            observed_revision: 10,
            event,
        }
    }

    #[test]
    fn command_and_event_round_trip() {
        let binding = binding(
            ArtifactBindingSlot::Plan,
            "artifact.plan.1",
            ArtifactKind::Plan,
        );
        let command = DriverCommandEnvelope {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            command_id: CommandId::new("cmd-1").unwrap(),
            sequence: 11,
            expected_revision: 9,
            command: DriverCommand::RunTemplate {
                thread: ThreadHandle::new("thread-1").unwrap(),
                role: DriverRole::Tl,
                template_id: token("tl.plan"),
                bindings: BoundedVec::new("bindings", vec![binding.clone()]).unwrap(),
            },
        };
        let encoded = serde_json::to_string(&command).expect("serialize command");
        let decoded: DriverCommandEnvelope =
            serde_json::from_str(&encoded).expect("deserialize command");
        assert_eq!(decoded, command);

        let event = DriverEventEnvelope {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            event_id: EventId::new("event-1").unwrap(),
            sequence: 12,
            command_id: command.command_id.clone(),
            observed_revision: 10,
            event: DriverEvent::TurnFinished {
                outcome: TurnOutcomeKind::Replied,
                artifact: Some(binding.artifact),
            },
        };
        let encoded = serde_json::to_string(&event).expect("serialize event");
        let decoded: DriverEventEnvelope =
            serde_json::from_str(&encoded).expect("deserialize event");
        assert_eq!(decoded, event);
    }

    #[test]
    fn protocol_negotiation_selects_highest_overlap() {
        let selected = negotiate_protocol(
            ProtocolRange::new(1, 1).unwrap(),
            ProtocolRange::new(1, 4).unwrap(),
        )
        .expect("overlap");
        assert_eq!(selected.selected_version, CURRENT_PROTOCOL_VERSION);

        let clipped = negotiate_protocol(
            ProtocolRange::new(1, 3).unwrap(),
            ProtocolRange::new(1, 3).unwrap(),
        )
        .expect("overlap clipped to this crate's supported protocol");
        assert_eq!(clipped.selected_version, CURRENT_PROTOCOL_VERSION);

        let refused = negotiate_protocol(
            ProtocolRange::new(1, 1).unwrap(),
            ProtocolRange::new(2, 2).unwrap(),
        );
        assert!(matches!(
            refused,
            Err(ProtocolValueError::NoCompatibleProtocol { .. })
        ));

        let refused_future_local = negotiate_protocol(
            ProtocolRange::new(2, 3).unwrap(),
            ProtocolRange::new(2, 3).unwrap(),
        );
        assert!(matches!(
            refused_future_local,
            Err(ProtocolValueError::NoCompatibleProtocol { .. })
        ));

        let invalid: Result<ProtocolRange, _> = serde_json::from_str(r#"{"min":3,"max":2}"#);
        assert!(invalid.is_err(), "invalid ranges must fail during decode");
    }

    #[test]
    fn bounded_tokens_reject_paths_urls_and_over_limit_values() {
        assert!(ThreadHandle::new("/tmp/repo").is_err());
        assert!(ThreadHandle::new("https://example.test/run").is_err());
        assert!(ThreadHandle::new("shell echo hi").is_err());
        let too_long = "x".repeat(MAX_OPAQUE_ID_LEN + 1);
        assert!(CommandId::new(too_long).is_err());
    }

    #[test]
    fn bounded_collections_reject_over_limit_payloads() {
        let mut refs = Vec::new();
        for index in 0..=MAX_CURSOR_ARTIFACTS {
            refs.push(artifact(
                &format!("artifact-{index}"),
                ArtifactKind::WorkspaceDiff,
            ));
        }
        let result = BoundedVec::<ArtifactRef, MAX_CURSOR_ARTIFACTS>::new("artifacts", refs);
        assert!(matches!(
            result,
            Err(ProtocolValueError::TooManyItems { .. })
        ));

        let json = format!(
            r#"{{
                "protocol_version":1,
                "command_id":"cmd-1",
                "sequence":1,
                "expected_revision":1,
                "command":{{
                    "kind":"resume_or_start_thread",
                    "role":"dev",
                    "candidates":[{}]
                }}
            }}"#,
            (0..=MAX_CANDIDATE_THREADS)
                .map(|index| format!("\"thread-{index}\""))
                .collect::<Vec<_>>()
                .join(",")
        );
        let decoded: Result<DriverCommandEnvelope, _> = serde_json::from_str(&json);
        assert!(
            decoded.is_err(),
            "oversized candidate lists must fail closed"
        );
    }

    #[test]
    fn cloud_visible_json_shape_is_structurally_allowlisted() {
        let task_spec = artifact("artifact.task.1", ArtifactKind::TaskSpec);
        let plan = artifact("artifact.plan.1", ArtifactKind::Plan);
        let design = artifact("artifact.design.1", ArtifactKind::Design);
        let report = artifact("artifact.report.1", ArtifactKind::Report);
        let sub_task = artifact("artifact.subtask.1", ArtifactKind::SubTaskBrief);
        let diff = artifact("artifact.diff.1", ArtifactKind::WorkspaceDiff);
        let verdict = artifact("artifact.verdict.1", ArtifactKind::ReviewVerdict);
        let transcript = artifact("artifact.transcript.1", ArtifactKind::TranscriptDigest);

        let cursor = DriverCursor {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            backend: OrchestrationBackendKind::Cloud,
            status: DriverRunStatus::Running,
            phase: DriverPhase::SubTasks,
            state_revision: 9,
            last_command_seq: 8,
            last_event_seq: 7,
            in_flight_command_id: Some(CommandId::new("cmd-8").unwrap()),
            current_sub_task_index: 1,
            sub_task_count: 3,
            current_rounds_used: 1,
            max_review_rounds: 2,
            design_review_rounds: 1,
            mr_rounds_used: 0,
            tl_generation: 2,
            pause_requested: false,
            awaiting_user: false,
            artifacts: BoundedVec::new(
                "artifacts",
                vec![
                    task_spec,
                    plan.clone(),
                    design,
                    report.clone(),
                    sub_task,
                    diff.clone(),
                    verdict,
                    transcript.clone(),
                ],
            )
            .unwrap(),
        };

        let bindings = BoundedVec::new(
            "bindings",
            vec![
                binding(
                    ArtifactBindingSlot::TaskSpec,
                    "artifact.task.2",
                    ArtifactKind::TaskSpec,
                ),
                binding(
                    ArtifactBindingSlot::Plan,
                    "artifact.plan.2",
                    ArtifactKind::Plan,
                ),
                binding(
                    ArtifactBindingSlot::Design,
                    "artifact.design.2",
                    ArtifactKind::Design,
                ),
                binding(
                    ArtifactBindingSlot::Report,
                    "artifact.report.2",
                    ArtifactKind::Report,
                ),
                binding(
                    ArtifactBindingSlot::SubTaskBrief,
                    "artifact.subtask.2",
                    ArtifactKind::SubTaskBrief,
                ),
                binding(
                    ArtifactBindingSlot::Diff,
                    "artifact.diff.2",
                    ArtifactKind::WorkspaceDiff,
                ),
                binding(
                    ArtifactBindingSlot::Verdict,
                    "artifact.verdict.2",
                    ArtifactKind::ReviewVerdict,
                ),
                binding(
                    ArtifactBindingSlot::PriorSummary,
                    "artifact.summary.2",
                    ArtifactKind::TranscriptDigest,
                ),
            ],
        )
        .unwrap();

        let mut samples = vec![
            serde_json::to_value(OrchestrationBackendRef::LegacyEmbedded).unwrap(),
            serde_json::to_value(OrchestrationBackendRef::Cloud {
                protocol_version: CURRENT_PROTOCOL_VERSION,
                driver_version: DriverVersion::new("driver.1").unwrap(),
                cloud_run_id: DriverRunId::new("cloud-run-1").unwrap(),
            })
            .unwrap(),
            serde_json::to_value(OrchestrationBackendRef::LocalSidecar {
                protocol_version: CURRENT_PROTOCOL_VERSION,
                driver_version: DriverVersion::new("driver.1").unwrap(),
            })
            .unwrap(),
            serde_json::to_value(OrchestrationBackendRef::UnknownNonExecuting).unwrap(),
            serde_json::to_value(ProtocolHello {
                supported: ProtocolRange::current(),
                driver_version: DriverVersion::new("driver.1").unwrap(),
                backend: OrchestrationBackendKind::Cloud,
            })
            .unwrap(),
            serde_json::to_value(ProtocolNegotiation {
                selected_version: CURRENT_PROTOCOL_VERSION,
            })
            .unwrap(),
            serde_json::to_value(cursor.clone()).unwrap(),
        ];

        for (index, command) in [
            DriverCommand::RequireWorkspace {},
            DriverCommand::StartThread {
                role: DriverRole::Tl,
            },
            DriverCommand::ResumeOrStartThread {
                role: DriverRole::Dev,
                candidates: BoundedVec::new(
                    "candidates",
                    vec![ThreadHandle::new("thread-1").unwrap()],
                )
                .unwrap(),
            },
            DriverCommand::RunTemplate {
                thread: ThreadHandle::new("thread-2").unwrap(),
                role: DriverRole::Reviewer,
                template_id: token("review.template"),
                bindings: bindings.clone(),
            },
            DriverCommand::CheckpointCommit {},
            DriverCommand::CollectDiff {
                scope: DiffScope::CurrentSubTask,
            },
            DriverCommand::MergeBase {
                target: MergeBaseTarget::PinnedTarget,
            },
            DriverCommand::Commit {
                message_template_id: token("message.commit"),
                bindings: bindings.clone(),
            },
            DriverCommand::PauseAtBoundary {},
            DriverCommand::SettleRun {
                status: DriverRunStatus::Done,
            },
        ]
        .into_iter()
        .enumerate()
        {
            samples
                .push(serde_json::to_value(command_envelope(command, index as u64 + 1)).unwrap());
        }

        for (index, event) in [
            DriverEvent::CommandAccepted {},
            DriverEvent::CommandRejected {
                reason: CommandRejection::InvalidState,
            },
            DriverEvent::WorkspaceReady {},
            DriverEvent::ThreadReady {
                thread: ThreadHandle::new("thread-3").unwrap(),
                role: DriverRole::Dev,
            },
            DriverEvent::TurnFinished {
                outcome: TurnOutcomeKind::Replied,
                artifact: Some(transcript),
            },
            DriverEvent::DiffCollected {
                changed: true,
                artifact: diff,
            },
            DriverEvent::MergeBaseResolved {
                available: true,
                artifact: Some(plan),
            },
            DriverEvent::CommitRecorded {
                changed: true,
                artifact: Some(report),
            },
            DriverEvent::CursorAdvanced { cursor },
            DriverEvent::RunSettled {
                status: DriverRunStatus::Done,
            },
        ]
        .into_iter()
        .enumerate()
        {
            samples.push(serde_json::to_value(event_envelope(event, index as u64 + 1)).unwrap());
        }

        for value in samples {
            assert_cloud_visible_json_is_allowlisted(&value);
        }
    }

    #[test]
    fn persisted_backend_ref_degrades_future_or_malformed_shapes() {
        let extra_cloud: OrchestrationBackendRef = serde_json::from_str(
            r#"{
                "kind":"cloud",
                "protocol_version":1,
                "driver_version":"driver.1",
                "cloud_run_id":"cloud-run-1",
                "future_field":true
            }"#,
        )
        .expect("future cloud shape must not invalidate persisted state");
        assert_eq!(extra_cloud, OrchestrationBackendRef::UnknownNonExecuting);

        let bad_cloud_id: OrchestrationBackendRef = serde_json::from_str(
            r#"{
                "kind":"cloud",
                "protocol_version":1,
                "driver_version":"driver.1",
                "cloud_run_id":"https://example.test/run"
            }"#,
        )
        .expect("malformed cloud id must degrade without invalidating state");
        assert_eq!(bad_cloud_id, OrchestrationBackendRef::UnknownNonExecuting);

        let duplicate_cloud_field: OrchestrationBackendRef = serde_json::from_str(
            r#"{
                "kind":"cloud",
                "protocol_version":1,
                "driver_version":"driver.1",
                "cloud_run_id":"cloud-run-1",
                "cloud_run_id":"cloud-run-2"
            }"#,
        )
        .expect("duplicate backend fields must degrade without invalidating state");
        assert_eq!(
            duplicate_cloud_field,
            OrchestrationBackendRef::UnknownNonExecuting
        );

        let extra_legacy: OrchestrationBackendRef =
            serde_json::from_str(r#"{"kind":"legacy_embedded","driver_version":"future"}"#)
                .expect("future legacy shape must not invalidate persisted state");
        assert_eq!(extra_legacy, OrchestrationBackendRef::UnknownNonExecuting);

        let missing_kind_backend: OrchestrationBackendRef =
            serde_json::from_str(r#"{}"#).expect("empty backend object must decode");
        assert_eq!(
            missing_kind_backend,
            OrchestrationBackendRef::UnknownNonExecuting
        );

        let null_backend: OrchestrationBackendRef =
            serde_json::from_str(r#"null"#).expect("null backend must decode");
        assert_eq!(null_backend, OrchestrationBackendRef::UnknownNonExecuting);

        let scalar_backend: OrchestrationBackendRef =
            serde_json::from_str(r#""cloud_v99""#).expect("scalar future backend must decode");
        assert_eq!(scalar_backend, OrchestrationBackendRef::UnknownNonExecuting);
    }

    #[test]
    fn persisted_driver_progress_keeps_valid_identity_and_drops_bad_shapes() {
        let valid: DriverProgress = serde_json::from_str(
            r#"{
                "state_revision":42,
                "last_command_seq":7,
                "last_event_seq":6,
                "in_flight_command_id":"cmd-future",
                "future_progress_field":{"ignored":true}
            }"#,
        )
        .expect("valid progress plus future fields must decode");
        assert_eq!(valid.state_revision, 42);
        assert_eq!(valid.last_command_seq, 7);
        assert_eq!(valid.last_event_seq, 6);
        assert_eq!(
            valid.in_flight_command_id.as_ref().map(|id| id.as_str()),
            Some("cmd-future")
        );

        let malformed: DriverProgress = serde_json::from_str(
            r#"{
                "state_revision":"forty-two",
                "last_command_seq":-1,
                "last_event_seq":{"future":true},
                "in_flight_command_id":"https://example.test/cmd"
            }"#,
        )
        .expect("malformed progress must not invalidate persisted state");
        assert_eq!(malformed, DriverProgress::default());

        let whole_value_malformed: DriverProgress = serde_json::from_str(r#"["future-progress"]"#)
            .expect("future progress shape must not invalidate persisted state");
        assert_eq!(whole_value_malformed, DriverProgress::default());
    }

    #[test]
    fn commands_reject_unknown_variants_and_escape_hatch_fields() {
        let unknown_command = r#"{
            "protocol_version":1,
            "command_id":"cmd-1",
            "sequence":1,
            "expected_revision":1,
            "command":{"kind":"send_raw_prompt","template_id":"x"}
        }"#;
        assert!(serde_json::from_str::<DriverCommandEnvelope>(unknown_command).is_err());

        let command_bodies = [
            r#"{"kind":"require_workspace"}"#,
            r#"{"kind":"start_thread","role":"tl"}"#,
            r#"{"kind":"resume_or_start_thread","role":"dev","candidates":[]}"#,
            r#"{"kind":"run_template","thread":"thread-1","role":"tl","template_id":"tl.intake","bindings":[]}"#,
            r#"{"kind":"checkpoint_commit"}"#,
            r#"{"kind":"collect_diff","scope":"head"}"#,
            r#"{"kind":"merge_base","target":"pinned_target"}"#,
            r#"{"kind":"commit","message_template_id":"commit.message","bindings":[]}"#,
            r#"{"kind":"pause_at_boundary"}"#,
            r#"{"kind":"settle_run","status":"done"}"#,
        ];
        let forbidden_fields = [
            "task",
            "task_text",
            "user_prose",
            "repository_content",
            "cwd",
            "path",
            "prompt",
            "transcript",
            "diff_text",
            "finding",
            "findings",
            "log",
            "url",
            "shell_command",
            "payload",
            "blob",
            "message",
            "text",
        ];
        for body in command_bodies {
            let prefix = body.strip_suffix('}').expect("command object body");
            for forbidden in forbidden_fields {
                let command = format!("{prefix},\"{forbidden}\":\"CANARY\"}}");
                let raw = format!(
                    r#"{{
                    "protocol_version":1,
                    "command_id":"cmd-1",
                    "sequence":1,
                    "expected_revision":1,
                    "command":{command}
                }}"#
                );
                assert!(
                    serde_json::from_str::<DriverCommandEnvelope>(&raw).is_err(),
                    "{forbidden} must not be accepted on command body {body}"
                );
            }
        }
    }

    #[test]
    fn unknown_fields_on_cursor_and_events_fail_closed() {
        let cursor_with_path = r#"{
            "protocol_version":1,
            "backend":"cloud",
            "status":"running",
            "phase":"sub_tasks",
            "state_revision":1,
            "last_command_seq":1,
            "last_event_seq":1,
            "current_sub_task_index":0,
            "sub_task_count":1,
            "current_rounds_used":0,
            "max_review_rounds":2,
            "design_review_rounds":0,
            "mr_rounds_used":0,
            "tl_generation":1,
            "pause_requested":false,
            "awaiting_user":false,
            "artifacts":[],
            "cwd":"/tmp/repo"
        }"#;
        assert!(serde_json::from_str::<DriverCursor>(cursor_with_path).is_err());

        let event_with_log = r#"{
            "protocol_version":1,
            "event_id":"event-1",
            "sequence":1,
            "command_id":"cmd-1",
            "observed_revision":1,
            "event":{"kind":"command_rejected","reason":"invalid_state","log":"CANARY"}
        }"#;
        assert!(serde_json::from_str::<DriverEventEnvelope>(event_with_log).is_err());
    }

    #[test]
    fn wire_messages_reject_unsupported_protocol_versions() {
        let zero_version = r#"{
            "protocol_version":0,
            "command_id":"cmd-1",
            "sequence":1,
            "expected_revision":1,
            "command":{"kind":"require_workspace"}
        }"#;
        assert!(serde_json::from_str::<DriverCommandEnvelope>(zero_version).is_err());

        let future_version = format!(
            r#"{{
                "protocol_version":{},
                "event_id":"event-1",
                "sequence":1,
                "command_id":"cmd-1",
                "observed_revision":1,
                "event":{{"kind":"command_accepted"}}
            }}"#,
            CURRENT_PROTOCOL_VERSION + 1
        );
        assert!(serde_json::from_str::<DriverEventEnvelope>(&future_version).is_err());
    }

    #[test]
    fn driver_cursor_projection_excludes_sensitive_run_fields() {
        let mut run = TeamRun::new(
            "team-sensitive".to_string(),
            TaskSpec {
                title: "CANARY_TASK_TITLE".to_string(),
                context: "CANARY_CONTEXT_PROSE".to_string(),
                acceptance_criteria: "CANARY_ACCEPTANCE".to_string(),
                agreed_scope: "CANARY_SCOPE".to_string(),
                quality_rules: "CANARY_RULES".to_string(),
            },
            "/Users/example/private/repo/.sealwire/worktrees/canary".to_string(),
            "device-sensitive".to_string(),
        );
        run.status = crate::team::TeamRunStatus::AwaitingUser;
        run.phase = TeamPhase::SubTasks;
        run.tl_thread_id = "tl-sensitive".to_string();
        run.branch = "task/secret-branch".to_string();
        run.target_ref = "refs/heads/private-main".to_string();
        run.sub_tasks = vec![SubTask {
            id: "st-sensitive".to_string(),
            title: "CANARY_SUBTASK_TITLE".to_string(),
            brief: "CANARY_SUBTASK_BRIEF".to_string(),
            status: SubTaskStatus::Implementing,
            rounds_used: 1,
            result_summary: Some("CANARY_RESULT_SUMMARY".to_string()),
            error: Some("CANARY_SUBTASK_ERROR".to_string()),
            ..SubTask::default()
        }];
        run.unresolved = vec!["CANARY_FINDING_TEXT".to_string()];
        run.error = Some("CANARY_ERROR_LOG".to_string());
        run.awaiting = Some(AwaitingUser {
            thread_id: "dev-sensitive".to_string(),
            request_id: "ask-sensitive".to_string(),
            role: "dev".to_string(),
            asked_at: 1,
        });
        run.driver_progress.state_revision = 4;
        run.driver_progress.last_command_seq = 2;
        run.driver_progress.last_event_seq = 3;
        run.driver_progress.in_flight_command_id = Some(CommandId::new("cmd-2").unwrap());

        let cursor = DriverCursor::from_team_run(
            &run,
            vec![artifact("artifact.task.1", ArtifactKind::TaskSpec)],
        )
        .expect("cursor");
        let encoded = serde_json::to_string(&cursor).expect("serialize cursor");

        for canary in [
            "CANARY_TASK_TITLE",
            "CANARY_CONTEXT_PROSE",
            "CANARY_ACCEPTANCE",
            "CANARY_SCOPE",
            "CANARY_RULES",
            "/Users/example/private/repo",
            "tl-sensitive",
            "task/secret-branch",
            "private-main",
            "CANARY_SUBTASK_TITLE",
            "CANARY_SUBTASK_BRIEF",
            "CANARY_RESULT_SUMMARY",
            "CANARY_FINDING_TEXT",
            "CANARY_ERROR_LOG",
            "dev-sensitive",
            "ask-sensitive",
        ] {
            assert!(
                !encoded.contains(canary),
                "cursor leaked sensitive canary {canary}: {encoded}"
            );
        }
        assert!(encoded.contains("artifact.task.1"));
        assert!(encoded.contains("\"state_revision\":4"));
        assert!(encoded.contains("\"awaiting_user\":true"));
    }
}

#[cfg(test)]
mod scratch_adversarial {
    use super::*;

    fn envelope(command_body: &str) -> String {
        format!(
            r#"{{"protocol_version":1,"command_id":"cmd-1","sequence":1,"expected_revision":1,"command":{command_body}}}"#
        )
    }

    #[test]
    fn s01_duplicate_tag_key() {
        for body in [
            r#"{"kind":"require_workspace","kind":"start_thread"}"#,
            r#"{"kind":"start_thread","kind":"require_workspace","role":"tl"}"#,
            r#"{"kind":"require_workspace","kind":"CANARY"}"#,
        ] {
            let r = serde_json::from_str::<DriverCommandEnvelope>(&envelope(body));
            println!("s01 {body} => {:?}", r.map(|v| format!("{:?}", v.command)));
        }
    }

    #[test]
    fn s02_nested_cursor_unknown_field_inside_tagged_event() {
        let raw = r#"{
            "protocol_version":1,"event_id":"e","sequence":1,"command_id":"c","observed_revision":1,
            "event":{"kind":"cursor_advanced","cursor":{
                "protocol_version":1,"backend":"cloud","status":"running","phase":"sub_tasks",
                "state_revision":1,"last_command_seq":1,"last_event_seq":1,
                "current_sub_task_index":0,"sub_task_count":1,"current_rounds_used":0,
                "max_review_rounds":2,"design_review_rounds":0,"mr_rounds_used":0,
                "tl_generation":1,"pause_requested":false,"awaiting_user":false,"artifacts":[],
                "cwd":"/tmp/CANARY"}}}"#;
        let r = serde_json::from_str::<DriverEventEnvelope>(raw);
        println!("s02 nested cursor unknown field => {:?}", r.is_err());
        assert!(r.is_err(), "SMUGGLED: {r:?}");
    }

    #[test]
    fn s03_nested_artifact_unknown_field_inside_tagged_event() {
        let raw = r#"{
            "protocol_version":1,"event_id":"e","sequence":1,"command_id":"c","observed_revision":1,
            "event":{"kind":"diff_collected","changed":true,
              "artifact":{"artifact_id":"a1","kind":"workspace_diff","revision":1,"path":"/tmp/CANARY"}}}"#;
        let r = serde_json::from_str::<DriverEventEnvelope>(raw);
        println!("s03 nested artifact unknown field => {:?}", r.is_err());
        assert!(r.is_err(), "SMUGGLED: {r:?}");
    }

    #[test]
    fn s04_protocol_range_pub_field_bypass_round_trip() {
        let bogus = ProtocolRange { min: 3, max: 2 };
        let encoded = serde_json::to_string(&bogus).unwrap();
        let back = serde_json::from_str::<ProtocolRange>(&encoded);
        println!("s04 {encoded} => {back:?}");
        let zero = ProtocolRange { min: 0, max: 0 };
        let encoded0 = serde_json::to_string(&zero).unwrap();
        println!(
            "s04 zero {encoded0} => {:?}",
            serde_json::from_str::<ProtocolRange>(&encoded0)
        );
        let hello = ProtocolHello {
            supported: bogus,
            driver_version: DriverVersion::new("d.1").unwrap(),
            backend: OrchestrationBackendKind::Cloud,
        };
        let he = serde_json::to_string(&hello).unwrap();
        println!(
            "s04 hello {he} => {:?}",
            serde_json::from_str::<ProtocolHello>(&he)
        );
    }

    #[test]
    fn s05_cursor_pub_field_bypass_round_trip() {
        let mut cursor = DriverCursor {
            protocol_version: 999,
            backend: OrchestrationBackendKind::Cloud,
            status: DriverRunStatus::Running,
            phase: DriverPhase::SubTasks,
            state_revision: 1,
            last_command_seq: 1,
            last_event_seq: 1,
            in_flight_command_id: None,
            current_sub_task_index: 0,
            sub_task_count: 1,
            current_rounds_used: 0,
            max_review_rounds: 2,
            design_review_rounds: 0,
            mr_rounds_used: 0,
            tl_generation: 1,
            pause_requested: false,
            awaiting_user: false,
            artifacts: BoundedVec::empty(),
        };
        let encoded = serde_json::to_string(&cursor).unwrap();
        println!(
            "s05 protocol_version 999 round trip => {:?}",
            serde_json::from_str::<DriverCursor>(&encoded).is_err()
        );
        cursor.protocol_version = 0;
        let encoded = serde_json::to_string(&cursor).unwrap();
        println!(
            "s05 protocol_version 0 round trip => {:?}",
            serde_json::from_str::<DriverCursor>(&encoded).is_err()
        );
    }

    #[test]
    fn s06_token_grammar_accepts_relative_path_components() {
        for raw in ["..", ".", "...", "-", "_", "..-..", ".git", "-rf"] {
            println!("s06 token {raw:?} => {:?}", ArtifactId::new(raw).is_ok());
        }
        assert!(
            ArtifactId::new("..").is_ok(),
            "expected `..` to be accepted (documenting)"
        );
    }

    #[test]
    fn s07_backend_ref_round_trips() {
        for backend in [
            OrchestrationBackendRef::LegacyEmbedded,
            OrchestrationBackendRef::Cloud {
                protocol_version: 1,
                driver_version: DriverVersion::new("d.1").unwrap(),
                cloud_run_id: DriverRunId::new("r.1").unwrap(),
            },
            OrchestrationBackendRef::LocalSidecar {
                protocol_version: 1,
                driver_version: DriverVersion::new("d.1").unwrap(),
            },
            OrchestrationBackendRef::UnknownNonExecuting,
        ] {
            let encoded = serde_json::to_string(&backend).unwrap();
            let back: OrchestrationBackendRef = serde_json::from_str(&encoded).unwrap();
            println!("s07 {encoded} => same={}", back == backend);
            assert_eq!(back, backend, "asymmetric round trip for {encoded}");
        }
    }

    #[test]
    fn s08_backend_ref_future_shape_is_lossy_on_resave() {
        let future = r#"{"kind":"cloud","protocol_version":2,"driver_version":"d.2","cloud_run_id":"r.2","region":"eu"}"#;
        let decoded: OrchestrationBackendRef = serde_json::from_str(future).unwrap();
        let resaved = serde_json::to_string(&decoded).unwrap();
        println!("s08 {future}\n  -> {decoded:?}\n  -> {resaved}");
        assert_eq!(resaved, r#"{"kind":"unknown_non_executing"}"#);
    }

    #[test]
    fn s09_driver_progress_duplicate_keys_take_the_first() {
        let p: DriverProgress =
            serde_json::from_str(r#"{"state_revision":1,"state_revision":99}"#).unwrap();
        println!("s09 duplicate state_revision => {}", p.state_revision);
        let b: OrchestrationBackendRef =
            serde_json::from_str(r#"{"kind":"legacy_embedded","kind":"legacy_embedded"}"#).unwrap();
        println!("s09 duplicate kind backend => {b:?}");
    }

    #[test]
    fn s10_driver_progress_number_shapes() {
        for raw in [
            r#"{"state_revision":18446744073709551615}"#,
            r#"{"state_revision":18446744073709551616}"#,
            r#"{"state_revision":1e3}"#,
            r#"{"state_revision":-1}"#,
            r#"{"state_revision":1.0}"#,
        ] {
            let p: DriverProgress = serde_json::from_str(raw).unwrap();
            println!("s10 {raw} => {}", p.state_revision);
        }
    }

    #[test]
    fn s11_negotiate_with_unvalidated_ranges() {
        for (l, p) in [
            (ProtocolRange { min: 0, max: 0 }, ProtocolRange::current()),
            (ProtocolRange::current(), ProtocolRange { min: 0, max: 0 }),
            (ProtocolRange::current(), ProtocolRange { min: 5, max: 1 }),
            (ProtocolRange { min: 5, max: 1 }, ProtocolRange::current()),
            (
                ProtocolRange::current(),
                ProtocolRange {
                    min: 0,
                    max: u32::MAX,
                },
            ),
        ] {
            println!("s11 local={l:?} peer={p:?} => {:?}", negotiate_protocol(l, p));
        }
    }

    #[test]
    fn s12_duplicate_known_field_in_tagged_variant() {
        for body in [
            r#"{"kind":"start_thread","role":"tl","role":"dev"}"#,
            r#"{"kind":"settle_run","status":"done","status":"failed"}"#,
        ] {
            let r = serde_json::from_str::<DriverCommandEnvelope>(&envelope(body));
            println!("s12 {body} => {:?}", r.map(|v| format!("{:?}", v.command)));
        }
    }

    #[test]
    fn s13_top_level_duplicate_and_unknown() {
        for raw in [
            r#"{"protocol_version":1,"command_id":"cmd-1","sequence":1,"expected_revision":1,"command":{"kind":"require_workspace"},"note":"CANARY"}"#,
            r#"{"protocol_version":1,"command_id":"cmd-1","command_id":"cmd-2","sequence":1,"expected_revision":1,"command":{"kind":"require_workspace"}}"#,
        ] {
            println!(
                "s13 => {:?}",
                serde_json::from_str::<DriverCommandEnvelope>(raw).is_err()
            );
        }
    }

    #[test]
    fn s14_bounded_vec_exact_max_and_non_seq() {
        let items: Vec<String> = (0..MAX_CANDIDATE_THREADS)
            .map(|i| format!("\"thread-{i}\""))
            .collect();
        let raw = format!("[{}]", items.join(","));
        let v: Result<BoundedVec<ThreadHandle, MAX_CANDIDATE_THREADS>, _> =
            serde_json::from_str(&raw);
        println!("s14 exact MAX => ok={}", v.is_ok());
        let v2: Result<BoundedVec<ThreadHandle, MAX_CANDIDATE_THREADS>, _> =
            serde_json::from_str(r#"{"a":"b"}"#);
        println!("s14 map => err={}", v2.is_err());
        let v3: Result<BoundedVec<ThreadHandle, MAX_CANDIDATE_THREADS>, _> =
            serde_json::from_str("null");
        println!("s14 null => err={}", v3.is_err());
    }

    #[test]
    fn s15_via_serde_json_value_path() {
        let raw = serde_json::json!({
            "protocol_version":1,"command_id":"cmd-1","sequence":1,"expected_revision":1,
            "command":{"kind":"require_workspace","payload":"CANARY"}
        });
        println!(
            "s15 from_value unknown field => err={}",
            serde_json::from_value::<DriverCommandEnvelope>(raw).is_err()
        );
        let raw2 = serde_json::json!({
            "protocol_version":1,"command_id":"cmd-1","sequence":1,"expected_revision":1,
            "command":{"kind":"start_thread","role":"tl","prompt":"CANARY"}
        });
        println!(
            "s15 from_value unknown field on struct variant => err={}",
            serde_json::from_value::<DriverCommandEnvelope>(raw2).is_err()
        );
    }

    #[test]
    fn s16_hello_unknown_fields() {
        println!(
            "s16 hello extra => err={}",
            serde_json::from_str::<ProtocolHello>(
                r#"{"supported":{"min":1,"max":1},"driver_version":"d","backend":"cloud","note":"CANARY"}"#
            )
            .is_err()
        );
        println!(
            "s16 range extra => err={}",
            serde_json::from_str::<ProtocolHello>(
                r#"{"supported":{"min":1,"max":1,"note":"CANARY"},"driver_version":"d","backend":"cloud"}"#
            )
            .is_err()
        );
        println!(
            "s16 negotiation extra => err={}",
            serde_json::from_str::<ProtocolNegotiation>(
                r#"{"selected_version":1,"note":"CANARY"}"#
            )
            .is_err()
        );
    }

    #[test]
    fn s17_zero_field_variants_accept_non_map_content() {
        for body in [
            r#"{"kind":"require_workspace"}"#,
            r#"{"kind":"checkpoint_commit"}"#,
            r#"{"kind":"pause_at_boundary"}"#,
        ] {
            println!(
                "s17 {body} => ok={}",
                serde_json::from_str::<DriverCommandEnvelope>(&envelope(body)).is_ok()
            );
        }
        for body in [
            r#"{"kind":"require_workspace","artifact":{"artifact_id":"a","kind":"plan","revision":1}}"#,
        ] {
            println!(
                "s17 smuggle {body} => err={}",
                serde_json::from_str::<DriverCommandEnvelope>(&envelope(body)).is_err()
            );
        }
    }

    #[test]
    fn s18_turn_finished_missing_optional_artifact() {
        let raw = r#"{"protocol_version":1,"event_id":"e","sequence":1,"command_id":"c","observed_revision":1,"event":{"kind":"turn_finished","outcome":"replied"}}"#;
        println!(
            "s18 missing artifact => {:?}",
            serde_json::from_str::<DriverEventEnvelope>(raw).is_ok()
        );
        let v = DriverEvent::TurnFinished {
            outcome: TurnOutcomeKind::Silent,
            artifact: None,
        };
        println!("s18 serialized => {}", serde_json::to_string(&v).unwrap());
    }
}

#[cfg(test)]
mod scratch_adversarial2 {
    use super::*;

    fn art(id: &str) -> ArtifactRef {
        ArtifactRef {
            artifact_id: ArtifactId::new(id).unwrap(),
            kind: ArtifactKind::Plan,
            revision: 3,
            size_bytes: None,
        }
    }

    fn cursor() -> DriverCursor {
        DriverCursor {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            backend: OrchestrationBackendKind::Cloud,
            status: DriverRunStatus::Running,
            phase: DriverPhase::SubTasks,
            state_revision: u64::MAX,
            last_command_seq: 9007199254740993,
            last_event_seq: 7,
            in_flight_command_id: Some(CommandId::new("cmd-8").unwrap()),
            current_sub_task_index: 1,
            sub_task_count: 3,
            current_rounds_used: 1,
            max_review_rounds: 2,
            design_review_rounds: 1,
            mr_rounds_used: 0,
            tl_generation: 2,
            pause_requested: false,
            awaiting_user: true,
            artifacts: BoundedVec::new("artifacts", vec![art("a.1"), art("a.2")]).unwrap(),
        }
    }

    #[test]
    fn t01_every_command_variant_round_trips() {
        let bindings = BoundedVec::new(
            "bindings",
            vec![ArtifactBinding {
                slot: ArtifactBindingSlot::Plan,
                artifact: art("a.1"),
            }],
        )
        .unwrap();
        let commands = vec![
            DriverCommand::RequireWorkspace {},
            DriverCommand::StartThread {
                role: DriverRole::Tl,
            },
            DriverCommand::ResumeOrStartThread {
                role: DriverRole::Dev,
                candidates: BoundedVec::new("c", vec![ThreadHandle::new("t-1").unwrap()]).unwrap(),
            },
            DriverCommand::ResumeOrStartThread {
                role: DriverRole::Dev,
                candidates: BoundedVec::empty(),
            },
            DriverCommand::RunTemplate {
                thread: ThreadHandle::new("t-2").unwrap(),
                role: DriverRole::Reviewer,
                template_id: TemplateId::new("tpl.1").unwrap(),
                bindings: bindings.clone(),
            },
            DriverCommand::CheckpointCommit {},
            DriverCommand::CollectDiff {
                scope: DiffScope::Head,
            },
            DriverCommand::MergeBase {
                target: MergeBaseTarget::PinnedTarget,
            },
            DriverCommand::Commit {
                message_template_id: TemplateId::new("m.1").unwrap(),
                bindings,
            },
            DriverCommand::PauseAtBoundary {},
            DriverCommand::SettleRun {
                status: DriverRunStatus::Cancelled,
            },
        ];
        for command in commands {
            let env = DriverCommandEnvelope {
                protocol_version: CURRENT_PROTOCOL_VERSION,
                command_id: CommandId::new("cmd-1").unwrap(),
                sequence: u64::MAX,
                expected_revision: u64::MAX - 1,
                command,
            };
            let encoded = serde_json::to_string(&env).unwrap();
            match serde_json::from_str::<DriverCommandEnvelope>(&encoded) {
                Ok(back) => assert_eq!(back, env, "value changed for {encoded}"),
                Err(e) => panic!("ROUND TRIP FAILED {encoded}: {e}"),
            }
        }
        println!("t01 all command variants round trip");
    }

    #[test]
    fn t02_every_event_variant_round_trips() {
        let events = vec![
            DriverEvent::CommandAccepted {},
            DriverEvent::CommandRejected {
                reason: CommandRejection::UnknownRevision,
            },
            DriverEvent::WorkspaceReady {},
            DriverEvent::ThreadReady {
                thread: ThreadHandle::new("t-3").unwrap(),
                role: DriverRole::Dev,
            },
            DriverEvent::TurnFinished {
                outcome: TurnOutcomeKind::Blocked,
                artifact: None,
            },
            DriverEvent::TurnFinished {
                outcome: TurnOutcomeKind::Replied,
                artifact: Some(art("a.9")),
            },
            DriverEvent::DiffCollected {
                changed: false,
                artifact: art("a.10"),
            },
            DriverEvent::MergeBaseResolved {
                available: false,
                artifact: None,
            },
            DriverEvent::CommitRecorded {
                changed: true,
                artifact: Some(art("a.11")),
            },
            DriverEvent::CursorAdvanced { cursor: cursor() },
            DriverEvent::RunSettled {
                status: DriverRunStatus::Failed,
            },
        ];
        for event in events {
            let env = DriverEventEnvelope {
                protocol_version: CURRENT_PROTOCOL_VERSION,
                event_id: EventId::new("e-1").unwrap(),
                sequence: u64::MAX,
                command_id: CommandId::new("cmd-1").unwrap(),
                observed_revision: u64::MAX - 3,
                event,
            };
            let encoded = serde_json::to_string(&env).unwrap();
            match serde_json::from_str::<DriverEventEnvelope>(&encoded) {
                Ok(back) => assert_eq!(back, env, "VALUE CHANGED for {encoded}"),
                Err(e) => panic!("ROUND TRIP FAILED {encoded}: {e}"),
            }
        }
        println!("t02 all event variants round trip");
    }

    #[test]
    fn t03_oversized_candidates_error_reason() {
        let json = format!(
            r#"{{"protocol_version":1,"command_id":"cmd-1","sequence":1,"expected_revision":1,"command":{{"kind":"resume_or_start_thread","role":"dev","candidates":[{}]}}}}"#,
            (0..=MAX_CANDIDATE_THREADS)
                .map(|i| format!("\"thread-{i}\""))
                .collect::<Vec<_>>()
                .join(",")
        );
        println!(
            "t03 oversized => {:?}",
            serde_json::from_str::<DriverCommandEnvelope>(&json).map(|_| ()).unwrap_err()
        );
        let cursor_json = format!(
            r#"{{"protocol_version":1,"event_id":"e","sequence":1,"command_id":"c","observed_revision":1,"event":{{"kind":"cursor_advanced","cursor":{{"protocol_version":1,"backend":"cloud","status":"running","phase":"sub_tasks","state_revision":1,"last_command_seq":1,"last_event_seq":1,"current_sub_task_index":0,"sub_task_count":1,"current_rounds_used":0,"max_review_rounds":2,"design_review_rounds":0,"mr_rounds_used":0,"tl_generation":1,"pause_requested":false,"awaiting_user":false,"artifacts":[{}]}}}}}}"#,
            (0..=MAX_CURSOR_ARTIFACTS)
                .map(|i| format!(r#"{{"artifact_id":"a{i}","kind":"plan","revision":1}}"#))
                .collect::<Vec<_>>()
                .join(",")
        );
        println!(
            "t03 oversized nested cursor artifacts => {:?}",
            serde_json::from_str::<DriverEventEnvelope>(&cursor_json).map(|_| ()).unwrap_err()
        );
    }

    #[test]
    fn t04_bound_is_not_a_decode_time_input_bound_for_tagged_payloads() {
        // Direct (untagged) BoundedVec: parser should stop at MAX+1 and never
        // reach the trailing garbage.
        let mut direct = String::from("[");
        for i in 0..(MAX_CANDIDATE_THREADS + 5) {
            direct.push_str(&format!("\"t-{i}\","));
        }
        direct.push_str("@@@GARBAGE@@@]");
        let d = serde_json::from_str::<BoundedVec<ThreadHandle, MAX_CANDIDATE_THREADS>>(&direct);
        println!("t04 direct => {:?}", d.map(|_| ()).unwrap_err());

        // Same array inside an internally tagged variant.
        let tagged = format!(
            r#"{{"protocol_version":1,"command_id":"c","sequence":1,"expected_revision":1,"command":{{"kind":"resume_or_start_thread","role":"dev","candidates":{direct}}}}}"#
        );
        let t = serde_json::from_str::<DriverCommandEnvelope>(&tagged);
        println!("t04 tagged  => {:?}", t.map(|_| ()).unwrap_err());
    }

    #[test]
    fn t05_tagged_enum_rejects_non_map_and_string_variants() {
        for body in ["\"require_workspace\"", "[]", "5", "null", "true"] {
            let raw = format!(
                r#"{{"protocol_version":1,"command_id":"c","sequence":1,"expected_revision":1,"command":{body}}}"#
            );
            println!(
                "t05 command={body} => err={}",
                serde_json::from_str::<DriverCommandEnvelope>(&raw).is_err()
            );
        }
    }

    #[test]
    fn t06_driver_progress_drops_future_fields_on_resave() {
        let future = r#"{"state_revision":42,"last_command_seq":7,"last_event_seq":6,"in_flight_command_id":"cmd-a","in_flight_event_id":"evt-a","journal_epoch":3}"#;
        let p: DriverProgress = serde_json::from_str(future).unwrap();
        println!("t06 {future}\n  -> {}", serde_json::to_string(&p).unwrap());
    }

    #[test]
    fn t07_command_id_over_limit_silently_dropped_in_progress() {
        let long = "c".repeat(MAX_OPAQUE_ID_LEN + 1);
        let raw = format!(r#"{{"state_revision":5,"in_flight_command_id":"{long}"}}"#);
        let p: DriverProgress = serde_json::from_str(&raw).unwrap();
        println!(
            "t07 state_revision={} in_flight={:?}",
            p.state_revision,
            p.in_flight_command_id.as_ref().map(|c| c.as_str())
        );
    }

    #[test]
    fn t08_cursor_artifacts_default_when_absent() {
        let raw = r#"{"protocol_version":1,"backend":"cloud","status":"running","phase":"sub_tasks","state_revision":1,"last_command_seq":1,"last_event_seq":1,"current_sub_task_index":0,"sub_task_count":1,"current_rounds_used":0,"max_review_rounds":2,"design_review_rounds":0,"mr_rounds_used":0,"tl_generation":1,"pause_requested":false,"awaiting_user":false}"#;
        println!(
            "t08 absent artifacts => {:?}",
            serde_json::from_str::<DriverCursor>(raw).map(|c| c.artifacts.as_slice().len())
        );
        let raw_null = raw.replace("}", r#","artifacts":null}"#);
        println!(
            "t08 null artifacts => err={}",
            serde_json::from_str::<DriverCursor>(&raw_null).is_err()
        );
    }

    #[test]
    fn t09_backend_ref_from_serde_json_value() {
        let v = serde_json::json!({"kind":"legacy_embedded"});
        println!(
            "t09 from_value legacy => {:?}",
            serde_json::from_value::<OrchestrationBackendRef>(v)
        );
        let v2 = serde_json::json!({"kind":"cloud","protocol_version":1,"driver_version":"d","cloud_run_id":"r"});
        println!(
            "t09 from_value cloud => {:?}",
            serde_json::from_value::<OrchestrationBackendRef>(v2)
        );
    }

    #[test]
    fn t10_negotiation_selected_version_bounds() {
        let n = negotiate_protocol(
            ProtocolRange::new(1, u32::MAX).unwrap(),
            ProtocolRange::new(1, u32::MAX).unwrap(),
        )
        .unwrap();
        println!("t10 selected={}", n.selected_version);
        let encoded = serde_json::to_string(&n).unwrap();
        println!(
            "t10 round trip ok={}",
            serde_json::from_str::<ProtocolNegotiation>(&encoded).is_ok()
        );
    }
}
