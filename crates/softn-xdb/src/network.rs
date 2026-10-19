//! XDB Network Module
//! Handles P2P networking via libp2p with GossipSub and (optional) mDNS discovery.
//!
//! Policy (September 2026 ecosystem review, XD-01/XD-02/XD-03):
//!
//! - Networking is a separate, explicit step from opening a database. Nothing in
//!   this module starts because a database was opened; the host decides through
//!   [`NetworkOptions`] and persists that choice (see `tauri::NetworkSettings`).
//! - The v1 protocol is a **trusted-LAN development feature**: one shared topic,
//!   one default namespace, mDNS discovery. Messages are signed by the transport
//!   key and the claimed sender is checked against the signer, but that is
//!   transport identity, not application authorization. Named-app data never
//!   enters this protocol (`tauri::supports_legacy_sync`).
//! - Convergence is explicit work, not a side effect of connectivity. On every
//!   new peer the node announces its collections and requests reconciliation for
//!   each of them; a bounded periodic repair pass repeats that while peers are
//!   connected; an announced collection this node has never seen is requested
//!   with an empty state vector so it is discovered, not skipped.
//! - Every message carries the collection's reset epoch. A peer that is behind
//!   an acknowledged reset cannot reintroduce pre-reset state; a peer that is
//!   ahead is told to adopt the reset before its updates apply.
//! - Status is honest: the node reports what it *did* (publishes that reached a
//!   peer versus none, updates applied versus rejected, last reconcile time),
//!   never a single "synced" boolean. Queueing a publish is not peer receipt,
//!   and peer receipt is not peer persistence.

use crate::db::{RemoteApplyOutcome, SharedDb, XdbDatabase};
use futures::StreamExt;
use libp2p::{
    gossipsub::{self, IdentTopic, MessageAuthenticity, ValidationMode},
    identify, mdns, noise,
    swarm::{behaviour::toggle::Toggle, NetworkBehaviour, SwarmEvent},
    tcp, yamux, PeerId, Swarm,
};
use libp2p::swarm::dial_opts::{DialOpts, PeerCondition};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, Mutex};
use tracing::{debug, error, info, warn};

const SYNC_TOPIC: &str = "xdb-sync";
const PROTOCOL_VERSION: &str = "/xdb/1.0.0";

/// How often mDNS re-queries the LAN for peers (see `NetworkNode::new`).
pub const MDNS_QUERY_INTERVAL: Duration = Duration::from_secs(30);

/// How often the bounded repair pass runs while at least one peer is connected.
pub const REPAIR_INTERVAL: Duration = Duration::from_secs(30);
/// Maximum collections announced / requested per announce or repair pass.
pub const MAX_COLLECTIONS_PER_PASS: usize = 200;
/// Collections requested per repair tick (round-robin over the local set).
pub const REPAIR_BATCH: usize = 25;

#[derive(NetworkBehaviour)]
pub struct XdbBehaviour {
    gossipsub: gossipsub::Behaviour,
    mdns: Toggle<mdns::tokio::Behaviour>,
    identify: identify::Behaviour,
}

/// What the host allows this node to do. All three default to OFF at the type
/// level so a forgotten setting can never mean "listen on every interface".
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct NetworkOptions {
    /// Advertise and look for peers on the local network (mDNS).
    pub discovery: bool,
    /// Accept inbound connections on all interfaces.
    pub listen: bool,
}

impl NetworkOptions {
    /// The trusted-LAN development configuration (discovery + listening).
    pub fn trusted_lan() -> Self {
        Self {
            discovery: true,
            listen: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NetworkMessage {
    SyncUpdate {
        collection: String,
        update: Vec<u8>,
        sender_id: String,
        #[serde(default)]
        epoch: u64,
    },
    SyncRequest {
        collection: String,
        state_vector: Vec<u8>,
        requester_id: String,
        #[serde(default)]
        epoch: u64,
    },
    SyncResponse {
        collection: String,
        update: Vec<u8>,
        requester_id: String,
        responder_id: String,
        #[serde(default)]
        epoch: u64,
    },
    /// Sent on connection and on every repair pass: the collections this peer
    /// holds, so the receiver can request the ones it does not know yet.
    PeerAnnounce {
        peer_id: String,
        collections: Vec<String>,
    },
    /// An administrative reset of a whole collection (audit XD-03). Receivers
    /// with an older epoch clear the collection and adopt the epoch; updates
    /// from peers still on the old epoch are rejected from then on.
    CollectionReset {
        collection: String,
        epoch: u64,
        origin_id: String,
    },
}

impl NetworkMessage {
    pub fn collection(&self) -> Option<&str> {
        match self {
            NetworkMessage::SyncUpdate { collection, .. }
            | NetworkMessage::SyncRequest { collection, .. }
            | NetworkMessage::SyncResponse { collection, .. }
            | NetworkMessage::CollectionReset { collection, .. } => Some(collection),
            NetworkMessage::PeerAnnounce { .. } => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PeerInfo {
    pub peer_id: String,
    pub addresses: Vec<String>,
}

/// What the node actually did, for an honest status display. Counters are
/// cumulative for the node's lifetime; timestamps are RFC 3339 UTC.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncStats {
    /// Publishes that gossipsub accepted with at least one subscribed peer.
    /// This is delivery to the mesh, NOT an acknowledgement that a peer
    /// applied or persisted the update.
    pub publishes_sent: u64,
    /// Publishes made while no peer was subscribed. The local write is safe;
    /// the update was not delivered and will be reconciled on the next
    /// announce/repair pass.
    pub publishes_without_peers: u64,
    pub publish_failures: u64,
    pub updates_applied: u64,
    pub updates_rejected_stale: u64,
    pub updates_skipped_paused: u64,
    pub resets_applied: u64,
    pub sync_requests_sent: u64,
    pub sync_responses_applied: u64,
    pub last_announce_at: Option<String>,
    pub last_repair_at: Option<String>,
    pub last_update_applied_at: Option<String>,
}

/// Pause switch shared between the host and the event loop (audit XD-03):
/// after a local-scope restore, synchronization is held until the operator
/// decides whether that restore stays local, forks or replaces shared state.
#[derive(Debug, Default)]
pub struct SyncGate {
    paused: AtomicBool,
}

/// Everything the event loop can do that touches protected data or asks a
/// peer to (R3-XD-01). The gate decides each of them in ONE place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncActivity {
    /// Apply an inbound update or sync response to the database.
    ApplyUpdate,
    /// Adopt an inbound collection reset (clears local state).
    ApplyReset,
    /// Answer a peer's sync request with local data (and possibly a reset).
    AnswerRequest,
    /// Announce local collections and request data from peers (join, repair,
    /// reconnect, the Reconcile command, a peer's announce).
    Reconcile,
    /// Publish a locally committed update.
    PublishUpdate,
    /// Publish a committed reset plan: this IS the resolution of a `replace`
    /// restore, so it is the one data-bearing message allowed while paused.
    PublishReset,
}

impl SyncGate {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }
    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
    }
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// The synchronization policy while a restore is unresolved (R3-XD-01):
    /// nothing reads, writes, requests or answers protected data. Connection
    /// bookkeeping (mDNS, connect/disconnect events) is not an activity here
    /// and continues; the only data-bearing message that may leave is the
    /// committed reset plan that resolves a `replace` restore.
    pub fn permits(&self, activity: SyncActivity) -> bool {
        if !self.is_paused() {
            return true;
        }
        matches!(activity, SyncActivity::PublishReset)
    }
}

#[derive(Clone)]
pub struct NetworkNode {
    local_peer_id: PeerId,
    command_tx: mpsc::Sender<NetworkCommand>,
    connected_peers: Arc<Mutex<HashSet<PeerId>>>,
    options: NetworkOptions,
    stats: Arc<StdMutex<SyncStats>>,
    gate: Arc<SyncGate>,
}

#[derive(Debug, Clone)]
pub enum NetworkCommand {
    Publish { message: NetworkMessage },
    /// Announce local collections and request reconciliation for every one of them.
    Reconcile,
    /// Retry a dial to a discovered peer after a failed attempt (see `dial_discovered`).
    Redial { peer_id: PeerId, attempt: u32 },
    Shutdown,
}

/// How many times a failed dial to a still-discovered peer is retried with
/// exponential back-off before waiting for the next mDNS re-discovery.
pub const MAX_DIAL_RETRIES: u32 = 5;

#[derive(Debug, Clone)]
pub enum NetworkEvent {
    MessageReceived(NetworkMessage),
    PeerConnected(PeerInfo),
    PeerDisconnected(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishOutcome {
    /// Accepted by gossipsub with at least one subscribed peer.
    Sent,
    /// No subscribed peer: nothing was delivered.
    NoPeers,
    Failed,
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

// GossipSub validates the signature against `message.source`. The propagation
// source is only the last relay, which can differ from the original author.
fn message_matches_author(message: &NetworkMessage, author: &PeerId) -> bool {
    let author = author.to_string();
    match message {
        NetworkMessage::SyncUpdate { sender_id, .. } => sender_id == &author,
        NetworkMessage::SyncRequest { requester_id, .. } => requester_id == &author,
        NetworkMessage::SyncResponse { responder_id, .. } => responder_id == &author,
        NetworkMessage::PeerAnnounce { peer_id, .. } => peer_id == &author,
        NetworkMessage::CollectionReset { origin_id, .. } => origin_id == &author,
    }
}

fn publish_message(
    behaviour: &mut gossipsub::Behaviour,
    topic: &IdentTopic,
    message: &NetworkMessage,
    stats: &Arc<StdMutex<SyncStats>>,
) -> PublishOutcome {
    let outcome = match serde_json::to_vec(message) {
        Ok(data) => match behaviour.publish(topic.clone(), data) {
            Ok(_) => PublishOutcome::Sent,
            Err(gossipsub::PublishError::NoPeersSubscribedToTopic) => {
                // Local writes have already been persisted. An offline node
                // cannot deliver this update; this is not a database failure,
                // and it is NOT delivery either — the counters say which.
                debug!("No subscribed peers available to receive XDB message");
                PublishOutcome::NoPeers
            }
            Err(e) => {
                error!("Failed to publish message: {}", e);
                PublishOutcome::Failed
            }
        },
        Err(e) => {
            error!("Failed to serialize network message: {}", e);
            PublishOutcome::Failed
        }
    };
    if let Ok(mut s) = stats.lock() {
        match outcome {
            PublishOutcome::Sent => s.publishes_sent += 1,
            PublishOutcome::NoPeers => s.publishes_without_peers += 1,
            PublishOutcome::Failed => s.publish_failures += 1,
        }
        if matches!(message, NetworkMessage::SyncRequest { .. }) && outcome == PublishOutcome::Sent {
            s.sync_requests_sent += 1;
        }
    }
    outcome
}

/// Which gate activity an outbound message is (R3-XD-01).
fn publish_activity(message: &NetworkMessage) -> SyncActivity {
    match message {
        NetworkMessage::CollectionReset { .. } => SyncActivity::PublishReset,
        NetworkMessage::SyncUpdate { .. } | NetworkMessage::SyncResponse { .. } => SyncActivity::PublishUpdate,
        NetworkMessage::SyncRequest { .. } | NetworkMessage::PeerAnnounce { .. } => SyncActivity::Reconcile,
    }
}

fn connection_event(
    peers: &mut HashSet<PeerId>,
    peer_id: PeerId,
    connection_count: u32,
    address: Option<String>,
) -> Option<NetworkEvent> {
    if connection_count == 0 {
        peers
            .remove(&peer_id)
            .then(|| NetworkEvent::PeerDisconnected(peer_id.to_string()))
    } else if peers.insert(peer_id) {
        Some(NetworkEvent::PeerConnected(PeerInfo {
            peer_id: peer_id.to_string(),
            addresses: address.into_iter().collect(),
        }))
    } else {
        None
    }
}

/// Which collections a repair tick should request next: a round-robin window
/// over the local set, so a large database is reconciled in bounded slices.
fn repair_window(collections: &[String], cursor: &mut usize, batch: usize) -> Vec<String> {
    if collections.is_empty() {
        *cursor = 0;
        return Vec::new();
    }
    let start = *cursor % collections.len();
    let out: Vec<String> = collections
        .iter()
        .cycle()
        .skip(start)
        .take(batch.min(collections.len()))
        .cloned()
        .collect();
    *cursor = (start + out.len()) % collections.len();
    out
}

/// Deterministic per-node jitter so a LAN full of peers does not repair in
/// lock-step: 0–4999 ms derived from the peer id bytes.
fn repair_jitter(peer_id: &PeerId) -> Duration {
    let sum: u64 = peer_id.to_bytes().iter().map(|b| *b as u64).sum();
    Duration::from_millis(sum % 5000)
}

impl NetworkNode {
    pub async fn new(
        db: SharedDb,
        event_tx: broadcast::Sender<NetworkEvent>,
        options: NetworkOptions,
        gate: Arc<SyncGate>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let id_keys = libp2p::identity::Keypair::generate_ed25519();
        let local_peer_id = id_keys.public().to_peer_id();

        info!(
            "Local peer ID: {} (discovery={}, listen={})",
            local_peer_id, options.discovery, options.listen
        );

        // Create gossipsub config
        let gossipsub_config = gossipsub::ConfigBuilder::default()
            .heartbeat_interval(Duration::from_secs(1))
            .validation_mode(ValidationMode::Strict)
            .message_id_fn(|message: &gossipsub::Message| {
                gossipsub::MessageId::from(
                    format!("{:?}{:?}", message.source, message.sequence_number).into_bytes(),
                )
            })
            .build()
            .map_err(|e| format!("Gossipsub config error: {}", e))?;

        // Create gossipsub behaviour
        let gossipsub = gossipsub::Behaviour::new(
            MessageAuthenticity::Signed(id_keys.clone()),
            gossipsub_config,
        )
        .map_err(|e| format!("Gossipsub behaviour error: {}", e))?;

        // mDNS only when discovery was explicitly enabled.
        let mdns = if options.discovery {
            Toggle::from(Some(mdns::tokio::Behaviour::new(
                mdns::Config {
                    // libp2p's default re-query interval is five minutes. Two
                    // nodes starting within a moment of each other can both send
                    // their single initial query before the other has joined the
                    // multicast group, and then not find each other until that
                    // interval elapses. A 30 s re-query is one small multicast
                    // packet on a trusted LAN and bounds discovery after such a
                    // race (and after a peer restart) to well under a minute.
                    query_interval: MDNS_QUERY_INTERVAL,
                    ..mdns::Config::default()
                },
                local_peer_id,
            )?))
        } else {
            Toggle::from(None)
        };

        // Create identify behaviour
        let identify = identify::Behaviour::new(identify::Config::new(
            PROTOCOL_VERSION.to_string(),
            id_keys.public(),
        ));

        // Build the swarm
        let mut swarm = libp2p::SwarmBuilder::with_existing_identity(id_keys)
            .with_tokio()
            .with_tcp(
                tcp::Config::default(),
                noise::Config::new,
                yamux::Config::default,
            )?
            .with_behaviour(|_key| XdbBehaviour {
                gossipsub,
                mdns,
                identify,
            })?
            .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
            .build();

        // Subscribe to sync topic
        let topic = IdentTopic::new(SYNC_TOPIC);
        swarm.behaviour_mut().gossipsub.subscribe(&topic)?;

        // Listen on all interfaces only when the host asked for it.
        if options.listen {
            swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse()?)?;
        }

        // Create command channel
        let (command_tx, mut command_rx) = mpsc::channel::<NetworkCommand>(100);

        let connected_peers = Arc::new(Mutex::new(HashSet::new()));
        let peers_clone = connected_peers.clone();
        let stats = Arc::new(StdMutex::new(SyncStats::default()));
        let stats_clone = stats.clone();
        let gate_clone = gate.clone();

        // Spawn the network loop
        let db_clone = db.clone();
        let peer_id_clone = local_peer_id;
        let redial_tx = command_tx.clone();
        tokio::spawn(async move {
            Self::run_event_loop(
                swarm,
                &mut command_rx,
                redial_tx,
                event_tx,
                db_clone,
                peers_clone,
                peer_id_clone,
                stats_clone,
                gate_clone,
            )
            .await;
        });

        Ok(Self {
            local_peer_id,
            command_tx,
            connected_peers,
            options,
            stats,
            gate,
        })
    }

    /// Announce local collections and request reconciliation for each of them
    /// (bounded). Returns the number of requests queued.
    #[allow(clippy::too_many_arguments)]
    fn reconcile_locally(
        swarm: &mut Swarm<XdbBehaviour>,
        topic: &IdentTopic,
        db: &SharedDb,
        local_peer_id: &PeerId,
        stats: &Arc<StdMutex<SyncStats>>,
        collections: &[String],
        announce: bool,
        gate: &Arc<SyncGate>,
    ) -> usize {
        if !gate.permits(SyncActivity::Reconcile) {
            debug!("Synchronization paused; not announcing or requesting {} collections", collections.len());
            return 0;
        }
        let plan = match db.lock() {
            Ok(mut db_lock) => {
                let mut plan = Vec::with_capacity(collections.len());
                for collection in collections {
                    match (
                        db_lock.get_state_vector(collection),
                        db_lock.get_epoch(collection),
                    ) {
                        (Ok(sv), Ok(epoch)) => plan.push((collection.clone(), sv, epoch)),
                        (Err(e), _) | (_, Err(e)) => {
                            warn!("Cannot prepare reconciliation for {}: {}", collection, e)
                        }
                    }
                }
                plan
            }
            Err(e) => {
                error!("DB lock poisoned, skipping reconciliation: {}", e);
                return 0;
            }
        };
        if announce {
            publish_message(
                &mut swarm.behaviour_mut().gossipsub,
                topic,
                &NetworkMessage::PeerAnnounce {
                    peer_id: local_peer_id.to_string(),
                    collections: collections.to_vec(),
                },
                stats,
            );
        }
        let mut queued = 0;
        for (collection, state_vector, epoch) in plan {
            let request = NetworkMessage::SyncRequest {
                collection,
                state_vector,
                requester_id: local_peer_id.to_string(),
                epoch,
            };
            if publish_message(&mut swarm.behaviour_mut().gossipsub, topic, &request, stats)
                == PublishOutcome::Sent
            {
                queued += 1;
            }
        }
        queued
    }

    fn local_collections(db: &SharedDb) -> Vec<String> {
        match db.lock() {
            Ok(db_lock) => db_lock
                .get_collections()
                .unwrap_or_default()
                .into_iter()
                .take(MAX_COLLECTIONS_PER_PASS)
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Apply an inbound update honouring reset epochs. Returns true when applied.
    #[allow(clippy::too_many_arguments)]
    fn apply_inbound(
        db: &SharedDb,
        collection: &str,
        epoch: u64,
        update: &[u8],
        author: &str,
        stats: &Arc<StdMutex<SyncStats>>,
        gate: &Arc<SyncGate>,
        response: bool,
    ) -> bool {
        if !gate.permits(SyncActivity::ApplyUpdate) {
            Self::hold_paused(stats, collection);
            return false;
        }
        let mut db_lock = match db.lock() {
            Ok(l) => l,
            Err(e) => {
                error!("DB lock poisoned, dropping update for {}: {}", collection, e);
                return false;
            }
        };
        Self::apply_inbound_locked(&mut db_lock, collection, epoch, update, author, stats, gate, response)
    }

    fn hold_paused(stats: &Arc<StdMutex<SyncStats>>, collection: &str) {
        if let Ok(mut s) = stats.lock() {
            s.updates_skipped_paused += 1;
        }
        debug!("Synchronization paused; holding update for {}", collection);
    }

    /// The part of `apply_inbound` that runs under the database lock. The
    /// gate is checked AGAIN here (R3-XD-01): a restore that paused the gate
    /// while this update was waiting for the lock takes precedence, because
    /// the pause and the replacement are decided under this same mutex.
    #[allow(clippy::too_many_arguments)]
    fn apply_inbound_locked(
        db_lock: &mut XdbDatabase,
        collection: &str,
        epoch: u64,
        update: &[u8],
        author: &str,
        stats: &Arc<StdMutex<SyncStats>>,
        gate: &Arc<SyncGate>,
        response: bool,
    ) -> bool {
        if !gate.permits(SyncActivity::ApplyUpdate) {
            Self::hold_paused(stats, collection);
            return false;
        }
        for _attempt in 0..2 {
            match db_lock.apply_remote_update_at_epoch(collection, epoch, update) {
                Ok(RemoteApplyOutcome::Applied(_)) => {
                    if let Ok(mut s) = stats.lock() {
                        s.updates_applied += 1;
                        if response {
                            s.sync_responses_applied += 1;
                        }
                        s.last_update_applied_at = Some(now_rfc3339());
                    }
                    return true;
                }
                Ok(RemoteApplyOutcome::StaleEpoch { local, remote }) => {
                    if let Ok(mut s) = stats.lock() {
                        s.updates_rejected_stale += 1;
                    }
                    warn!(
                        "Rejected update for {} from {}: sender epoch {} is behind local reset epoch {}",
                        collection, author, remote, local
                    );
                    return false;
                }
                Ok(RemoteApplyOutcome::MissingReset { local, remote }) => {
                    // The sender has acknowledged a reset this node never saw:
                    // adopt it (clearing pre-reset state) and apply the update.
                    info!(
                        "Adopting reset epoch {} for {} announced by {} (local was {})",
                        remote, collection, author, local
                    );
                    match db_lock.apply_remote_reset(collection, remote, author) {
                        Ok(true) => {
                            if let Ok(mut s) = stats.lock() {
                                s.resets_applied += 1;
                            }
                            continue;
                        }
                        Ok(false) => return false,
                        Err(e) => {
                            error!("Failed to adopt reset for {}: {}", collection, e);
                            return false;
                        }
                    }
                }
                Err(e) => {
                    error!("Failed to apply update for {}: {}", collection, e);
                    return false;
                }
            }
        }
        false
    }

    /// Adopt an inbound reset under the gate, re-checked under the database
    /// lock (R3-XD-01). Returns true when the reset was applied.
    fn apply_inbound_reset(
        db: &SharedDb,
        collection: &str,
        epoch: u64,
        author: &str,
        stats: &Arc<StdMutex<SyncStats>>,
        gate: &Arc<SyncGate>,
    ) -> bool {
        if !gate.permits(SyncActivity::ApplyReset) {
            Self::hold_paused(stats, collection);
            return false;
        }
        let applied = match db.lock() {
            Ok(mut db_lock) => {
                if !gate.permits(SyncActivity::ApplyReset) {
                    Self::hold_paused(stats, collection);
                    return false;
                }
                match db_lock.apply_remote_reset(collection, epoch, author) {
                    Ok(applied) => applied,
                    Err(e) => {
                        error!("Failed to apply reset for {}: {}", collection, e);
                        false
                    }
                }
            }
            Err(e) => {
                error!("DB lock poisoned, dropping reset for {}: {}", collection, e);
                false
            }
        };
        if applied {
            if let Ok(mut s) = stats.lock() {
                s.resets_applied += 1;
            }
        }
        applied
    }

    #[allow(clippy::too_many_arguments)]
    /// Dial a peer mDNS discovered, from a FRESH source port (R4 LAN run).
    ///
    /// libp2p's default dial reuses the listening port as the source port.
    /// Two peers that discover each other in the same instant (two nodes
    /// answering the same query) then dial each other at once with mirrored
    /// 4-tuples, the kernel merges the two dials into one TCP simultaneous
    /// open, both sides run the Noise handshake as initiator, and both fail
    /// with "input error"; nothing retried, so the peers never connected.
    /// A fresh source port keeps the two dials distinct (at worst two
    /// connections, which the swarm handles), and `Redial` covers a dial
    /// that still fails. The addresses come from the mDNS behaviour at dial
    /// time, so a stale discovery dials nothing.
    fn dial_discovered(swarm: &mut Swarm<XdbBehaviour>, peer_id: PeerId, attempt: u32) {
        if swarm.is_connected(&peer_id) {
            return;
        }
        let known = swarm
            .behaviour()
            .mdns
            .as_ref()
            .map(|m| m.discovered_nodes().any(|id| id == &peer_id))
            .unwrap_or(false);
        if !known {
            debug!("Not dialing {}: no longer discovered", peer_id);
            return;
        }
        let opts = DialOpts::peer_id(peer_id)
            .condition(PeerCondition::DisconnectedAndNotDialing)
            .allocate_new_port()
            .build();
        match swarm.dial(opts) {
            Ok(()) => debug!("Dialing discovered peer {} (attempt {})", peer_id, attempt),
            Err(e) => debug!("Dial of {} not started: {}", peer_id, e),
        }
    }

    /// Schedule a retry after a failed dial: exponential back-off with jitter
    /// derived from BOTH peer ids, so two peers retrying each other do not
    /// collide again on the same instant.
    fn schedule_redial(redial_tx: &mpsc::Sender<NetworkCommand>, local: &PeerId, peer_id: PeerId, attempt: u32) {
        if attempt > MAX_DIAL_RETRIES {
            warn!("Giving up dialing {} after {} attempts; the next mDNS discovery will retry", peer_id, attempt - 1);
            return;
        }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        use std::hash::{Hash, Hasher};
        local.hash(&mut hasher);
        peer_id.hash(&mut hasher);
        let jitter = Duration::from_millis(hasher.finish() % 700);
        let delay = Duration::from_millis(400 * (1u64 << attempt.min(6))) + jitter;
        let tx = redial_tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = tx.send(NetworkCommand::Redial { peer_id, attempt }).await;
        });
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_event_loop(
        mut swarm: Swarm<XdbBehaviour>,
        command_rx: &mut mpsc::Receiver<NetworkCommand>,
        redial_tx: mpsc::Sender<NetworkCommand>,
        event_tx: broadcast::Sender<NetworkEvent>,
        db: SharedDb,
        connected_peers: Arc<Mutex<HashSet<PeerId>>>,
        local_peer_id: PeerId,
        stats: Arc<StdMutex<SyncStats>>,
        gate: Arc<SyncGate>,
    ) {
        let topic = IdentTopic::new(SYNC_TOPIC);
        // Failed dial attempts per discovered peer; cleared when it connects.
        let mut dial_attempts: HashMap<PeerId, u32> = HashMap::new();
        let mut repair = tokio::time::interval(REPAIR_INTERVAL + repair_jitter(&local_peer_id));
        repair.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut repair_cursor = 0usize;

        loop {
            tokio::select! {
                // Bounded periodic repair (audit XD-02): while peers are connected,
                // re-announce and request a round-robin slice of local collections.
                _ = repair.tick() => {
                    if connected_peers.lock().await.is_empty() {
                        continue;
                    }
                    if !gate.permits(SyncActivity::Reconcile) {
                        continue;
                    }
                    let all = Self::local_collections(&db);
                    let window = repair_window(&all, &mut repair_cursor, REPAIR_BATCH);
                    Self::reconcile_locally(&mut swarm, &topic, &db, &local_peer_id, &stats, &window, true, &gate);
                    if let Ok(mut s) = stats.lock() {
                        let now = now_rfc3339();
                        s.last_repair_at = Some(now.clone());
                        s.last_announce_at = Some(now);
                    }
                }

                // Handle swarm events
                event = swarm.select_next_some() => {
                    match event {
                        SwarmEvent::Behaviour(XdbBehaviourEvent::Mdns(mdns::Event::Discovered(peers))) => {
                            let mut seen = HashSet::new();
                            for (peer_id, addr) in peers {
                                info!("Discovered peer via mDNS: {} at {}", peer_id, addr);
                                if seen.insert(peer_id) {
                                    // The explicit-peer registration happens once the
                                    // connection exists (ConnectionEstablished): letting
                                    // gossipsub dial here would reuse the listen port and
                                    // collide with the peer's own dial.
                                    dial_attempts.insert(peer_id, 0);
                                    Self::dial_discovered(&mut swarm, peer_id, 0);
                                }
                            }
                        }
                        SwarmEvent::Behaviour(XdbBehaviourEvent::Mdns(mdns::Event::Expired(peers))) => {
                            for (peer_id, _addr) in peers {
                                info!("Peer expired: {}", peer_id);
                                // One address expiring does not mean the peer
                                // disappeared, nor does it close live connections.
                                let still_known = swarm
                                    .behaviour()
                                    .mdns
                                    .as_ref()
                                    .map(|m| m.discovered_nodes().any(|id| id == &peer_id))
                                    .unwrap_or(false);
                                if !still_known {
                                    swarm.behaviour_mut().gossipsub.remove_explicit_peer(&peer_id);
                                }
                            }
                        }
                        SwarmEvent::Behaviour(XdbBehaviourEvent::Gossipsub(gossipsub::Event::Message {
                            propagation_source: _,
                            message_id: _,
                            message,
                        })) => {
                            match serde_json::from_slice::<NetworkMessage>(&message.data) {
                                Ok(msg) => {
                                    let Some(author) = message.source else {
                                        warn!("Dropping XDB message without a signed author");
                                        continue;
                                    };
                                    if author == local_peer_id {
                                        continue;
                                    }
                                    if !message_matches_author(&msg, &author) {
                                        warn!("Dropping XDB message whose claimed sender differs from its signed author");
                                        continue;
                                    }
                                    let author_id = author.to_string();
                                    // Only notify subscribers after an update was applied.
                                    match &msg {
                                        NetworkMessage::SyncUpdate { collection, update, epoch, .. } => {
                                            info!("Received sync update for collection: {}", collection);
                                            if !Self::apply_inbound(&db, collection, *epoch, update, &author_id, &stats, &gate, false) {
                                                continue;
                                            }
                                        }
                                        NetworkMessage::SyncRequest { collection, state_vector, requester_id, epoch } => {
                                            info!("Received sync request for collection: {}", collection);
                                            if !gate.permits(SyncActivity::AnswerRequest) {
                                                debug!("Synchronization paused; not answering request for {}", collection);
                                                continue;
                                            }
                                            let reply = match db.lock() {
                                                Ok(mut db_lock) => {
                                                    // Re-checked under the lock (R3-XD-01).
                                                    if !gate.permits(SyncActivity::AnswerRequest) {
                                                        continue;
                                                    }
                                                    let local_epoch = db_lock.get_epoch(collection).unwrap_or(0);
                                                    if *epoch < local_epoch {
                                                        // The requester is behind a reset: tell it, then
                                                        // give it the whole post-reset state.
                                                        publish_message(&mut swarm.behaviour_mut().gossipsub, &topic, &NetworkMessage::CollectionReset {
                                                            collection: collection.clone(),
                                                            epoch: local_epoch,
                                                            origin_id: local_peer_id.to_string(),
                                                        }, &stats);
                                                        db_lock.get_full_state(collection).map(|update| (update, local_epoch))
                                                    } else if *epoch > local_epoch {
                                                        // We are behind: ask so the peer sends its reset + state.
                                                        match db_lock.get_state_vector(collection) {
                                                            Ok(sv) => {
                                                                publish_message(&mut swarm.behaviour_mut().gossipsub, &topic, &NetworkMessage::SyncRequest {
                                                                    collection: collection.clone(),
                                                                    state_vector: sv,
                                                                    requester_id: local_peer_id.to_string(),
                                                                    epoch: local_epoch,
                                                                }, &stats);
                                                            }
                                                            Err(e) => warn!("Cannot request newer epoch for {}: {}", collection, e),
                                                        }
                                                        continue;
                                                    } else {
                                                        db_lock.get_updates_since(collection, state_vector).map(|update| (update, local_epoch))
                                                    }
                                                }
                                                Err(e) => {
                                                    error!("DB lock poisoned, dropping sync request for {}: {}", collection, e);
                                                    continue;
                                                }
                                            };
                                            match reply {
                                                Ok((update, local_epoch)) => {
                                                    let response = NetworkMessage::SyncResponse {
                                                        collection: collection.clone(),
                                                        update,
                                                        requester_id: requester_id.clone(),
                                                        responder_id: local_peer_id.to_string(),
                                                        epoch: local_epoch,
                                                    };
                                                    publish_message(&mut swarm.behaviour_mut().gossipsub, &topic, &response, &stats);
                                                }
                                                Err(e) => {
                                                    warn!("Failed to prepare sync response for {}: {}", collection, e);
                                                    continue;
                                                }
                                            }
                                        }
                                        NetworkMessage::SyncResponse { collection, update, requester_id, epoch, .. } => {
                                            if requester_id != &local_peer_id.to_string() {
                                                continue;
                                            }
                                            info!("Received sync response for collection: {}", collection);
                                            if !Self::apply_inbound(&db, collection, *epoch, update, &author_id, &stats, &gate, true) {
                                                continue;
                                            }
                                        }
                                        NetworkMessage::PeerAnnounce { collections, .. } => {
                                            // Discover collections this node has never seen: an
                                            // unknown collection gets an empty state vector, which
                                            // asks the peer for everything (audit XD-02).
                                            let wanted: Vec<String> = collections.iter().take(MAX_COLLECTIONS_PER_PASS).cloned().collect();
                                            Self::reconcile_locally(&mut swarm, &topic, &db, &local_peer_id, &stats, &wanted, false, &gate);
                                            continue;
                                        }
                                        NetworkMessage::CollectionReset { collection, epoch, .. } => {
                                            if !Self::apply_inbound_reset(&db, collection, *epoch, &author_id, &stats, &gate) {
                                                continue;
                                            }
                                            // Fetch the post-reset state from the origin.
                                            Self::reconcile_locally(&mut swarm, &topic, &db, &local_peer_id, &stats, std::slice::from_ref(collection), false, &gate);
                                        }
                                    }
                                    let _ = event_tx.send(NetworkEvent::MessageReceived(msg));
                                }
                                Err(e) => {
                                    warn!("Failed to deserialize network message: {}", e);
                                }
                            }
                        }
                        SwarmEvent::NewListenAddr { address, .. } => {
                            info!("Listening on: {}", address);
                        }
                        SwarmEvent::ConnectionEstablished { peer_id, endpoint, num_established, .. } => {
                            info!("Connection established with: {}", peer_id);
                            dial_attempts.remove(&peer_id);
                            // A LAN peer is an explicit gossipsub peer: messages always
                            // reach it even when the mesh is thin. Registered only now,
                            // so gossipsub never issues its own port-reusing dial.
                            let discovered = swarm
                                .behaviour()
                                .mdns
                                .as_ref()
                                .map(|m| m.discovered_nodes().any(|id| id == &peer_id))
                                .unwrap_or(false);
                            if discovered {
                                swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                            }
                            let event = connection_event(
                                &mut *connected_peers.lock().await,
                                peer_id,
                                num_established.get(),
                                Some(endpoint.get_remote_address().to_string()),
                            );
                            if let Some(event) = event {
                                // Join reconciliation (audit XD-02): announce and request every
                                // local collection as soon as a NEW peer is connected.
                                // While a restore is unresolved the connection is kept but
                                // nothing is announced or requested (R3-XD-01).
                                if gate.permits(SyncActivity::Reconcile) {
                                    let all = Self::local_collections(&db);
                                    Self::reconcile_locally(&mut swarm, &topic, &db, &local_peer_id, &stats, &all, true, &gate);
                                    if let Ok(mut s) = stats.lock() {
                                        s.last_announce_at = Some(now_rfc3339());
                                    }
                                }
                                let _ = event_tx.send(event);
                            }
                        }
                        SwarmEvent::OutgoingConnectionError { peer_id, error, .. } => {
                            warn!("Outgoing connection to {:?} failed: {}", peer_id, error);
                            if let Some(peer_id) = peer_id {
                                if !swarm.is_connected(&peer_id) {
                                    let attempt = dial_attempts.entry(peer_id).or_insert(0);
                                    *attempt += 1;
                                    Self::schedule_redial(&redial_tx, &local_peer_id, peer_id, *attempt);
                                }
                            }
                        }
                        SwarmEvent::IncomingConnectionError { send_back_addr, error, .. } => {
                            warn!("Incoming connection from {} failed: {}", send_back_addr, error);
                        }
                        SwarmEvent::Dialing { peer_id, .. } => {
                            debug!("Dialing {:?}", peer_id);
                        }
                        SwarmEvent::ConnectionClosed { peer_id, num_established, .. } => {
                            info!("Connection closed with: {}", peer_id);
                            let event = connection_event(
                                &mut *connected_peers.lock().await,
                                peer_id,
                                num_established,
                                None,
                            );
                            if let Some(event) = event {
                                let _ = event_tx.send(event);
                            }
                        }
                        _ => {}
                    }
                }

                // Handle commands
                command = command_rx.recv() => {
                    match command {
                        Some(NetworkCommand::Publish { message }) => {
                            if !gate.permits(publish_activity(&message)) {
                                debug!("Synchronization paused; not publishing {:?}", message.collection());
                                if let Ok(mut s) = stats.lock() {
                                    s.updates_skipped_paused += 1;
                                }
                                continue;
                            }
                            publish_message(&mut swarm.behaviour_mut().gossipsub, &topic, &message, &stats);
                        }
                        Some(NetworkCommand::Reconcile) => {
                            if !gate.permits(SyncActivity::Reconcile) {
                                debug!("Synchronization paused; ignoring reconcile request");
                                continue;
                            }
                            let all = Self::local_collections(&db);
                            Self::reconcile_locally(&mut swarm, &topic, &db, &local_peer_id, &stats, &all, true, &gate);
                            if let Ok(mut s) = stats.lock() {
                                s.last_announce_at = Some(now_rfc3339());
                            }
                        }
                        Some(NetworkCommand::Redial { peer_id, attempt }) => {
                            Self::dial_discovered(&mut swarm, peer_id, attempt);
                        }
                        Some(NetworkCommand::Shutdown) | None => {
                            info!("Network node shutting down");
                            break;
                        }
                    }
                }
            }
        }
        connected_peers.lock().await.clear();
    }

    pub fn local_peer_id(&self) -> String {
        self.local_peer_id.to_string()
    }

    pub fn is_running(&self) -> bool {
        !self.command_tx.is_closed()
    }

    pub fn options(&self) -> NetworkOptions {
        self.options
    }

    pub fn gate(&self) -> Arc<SyncGate> {
        self.gate.clone()
    }

    pub fn stats(&self) -> SyncStats {
        self.stats
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default()
    }

    pub async fn publish(&self, message: NetworkMessage) -> Result<(), String> {
        self.command_tx
            .send(NetworkCommand::Publish { message })
            .await
            .map_err(|e| e.to_string())
    }

    /// Queue an update for delivery. Success means the command was queued in
    /// this process — see `stats()` for whether any peer was subscribed.
    pub async fn broadcast_update(
        &self,
        collection: &str,
        epoch: u64,
        update: Vec<u8>,
    ) -> Result<(), String> {
        self.publish(NetworkMessage::SyncUpdate {
            collection: collection.to_string(),
            update,
            sender_id: self.local_peer_id.to_string(),
            epoch,
        })
        .await
    }

    pub async fn broadcast_reset(&self, collection: &str, epoch: u64) -> Result<(), String> {
        self.publish(NetworkMessage::CollectionReset {
            collection: collection.to_string(),
            epoch,
            origin_id: self.local_peer_id.to_string(),
        })
        .await
    }

    pub async fn request_sync(
        &self,
        collection: &str,
        epoch: u64,
        state_vector: Vec<u8>,
    ) -> Result<(), String> {
        self.publish(NetworkMessage::SyncRequest {
            collection: collection.to_string(),
            state_vector,
            requester_id: self.local_peer_id.to_string(),
            epoch,
        })
        .await
    }

    /// Announce and request reconciliation for every local collection now.
    pub async fn reconcile(&self) -> Result<(), String> {
        self.command_tx
            .send(NetworkCommand::Reconcile)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn get_connected_peers(&self) -> Vec<String> {
        self.connected_peers
            .lock()
            .await
            .iter()
            .map(|p| p.to_string())
            .collect()
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        self.command_tx
            .send(NetworkCommand::Shutdown)
            .await
            .map_err(|e| e.to_string())
    }
}

pub type SharedNetwork = Arc<Mutex<Option<NetworkNode>>>;

pub fn create_shared_network() -> SharedNetwork {
    Arc::new(Mutex::new(None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_remains_connected_until_its_last_connection_closes() {
        let peer = PeerId::random();
        let mut peers = HashSet::new();
        let event = connection_event(&mut peers, peer, 1, Some("/memory/1".into()));
        assert!(matches!(event, Some(NetworkEvent::PeerConnected(_))));
        assert!(connection_event(&mut peers, peer, 2, Some("/memory/2".into())).is_none());
        assert!(connection_event(&mut peers, peer, 1, None).is_none());
        assert!(peers.contains(&peer));
        assert!(matches!(
            connection_event(&mut peers, peer, 0, None),
            Some(NetworkEvent::PeerDisconnected(_))
        ));
        assert!(peers.is_empty());
        assert!(connection_event(&mut peers, peer, 0, None).is_none());
    }

    #[test]
    fn sync_messages_match_the_original_signed_author() {
        let author = PeerId::random();
        let relay = PeerId::random();
        let messages = [
            NetworkMessage::SyncUpdate {
                collection: "notes".into(),
                update: vec![],
                sender_id: author.to_string(),
                epoch: 0,
            },
            NetworkMessage::SyncRequest {
                collection: "notes".into(),
                state_vector: vec![],
                requester_id: author.to_string(),
                epoch: 0,
            },
            NetworkMessage::SyncResponse {
                collection: "notes".into(),
                update: vec![],
                requester_id: relay.to_string(),
                responder_id: author.to_string(),
                epoch: 0,
            },
            NetworkMessage::PeerAnnounce {
                peer_id: author.to_string(),
                collections: vec![],
            },
            NetworkMessage::CollectionReset {
                collection: "notes".into(),
                epoch: 1,
                origin_id: author.to_string(),
            },
        ];
        for message in messages {
            assert!(message_matches_author(&message, &author));
            assert!(!message_matches_author(&message, &relay));
        }
    }

    #[tokio::test]
    async fn closed_network_task_reports_stopped_and_rejects_new_work() {
        let (command_tx, command_rx) = mpsc::channel(1);
        let node = NetworkNode {
            local_peer_id: PeerId::random(),
            command_tx,
            connected_peers: Arc::new(Mutex::new(HashSet::new())),
            options: NetworkOptions::default(),
            stats: Arc::new(StdMutex::new(SyncStats::default())),
            gate: SyncGate::new(),
        };
        assert!(node.is_running());
        drop(command_rx);
        assert!(!node.is_running());
        assert!(node.broadcast_update("notes", 0, vec![]).await.is_err());
        assert!(node.reconcile().await.is_err());
    }

    // ── R3-XD-01: one policy for every activity while a restore is unresolved ──

    #[test]
    fn a_paused_gate_permits_only_publishing_the_committed_reset_plan() {
        let gate = SyncGate::new();
        let all = [
            SyncActivity::ApplyUpdate,
            SyncActivity::ApplyReset,
            SyncActivity::AnswerRequest,
            SyncActivity::Reconcile,
            SyncActivity::PublishUpdate,
            SyncActivity::PublishReset,
        ];
        for activity in all {
            assert!(gate.permits(activity), "{activity:?} is allowed while open");
        }
        gate.pause();
        for activity in all {
            assert_eq!(gate.permits(activity), activity == SyncActivity::PublishReset, "{activity:?} while paused");
        }
        gate.resume();
        assert!(gate.permits(SyncActivity::ApplyUpdate));

        let author = PeerId::random().to_string();
        assert_eq!(publish_activity(&NetworkMessage::CollectionReset { collection: "n".into(), epoch: 1, origin_id: author.clone() }), SyncActivity::PublishReset);
        assert_eq!(publish_activity(&NetworkMessage::SyncUpdate { collection: "n".into(), update: vec![], sender_id: author.clone(), epoch: 0 }), SyncActivity::PublishUpdate);
        assert_eq!(publish_activity(&NetworkMessage::SyncResponse { collection: "n".into(), update: vec![], requester_id: author.clone(), responder_id: author.clone(), epoch: 0 }), SyncActivity::PublishUpdate);
        assert_eq!(publish_activity(&NetworkMessage::SyncRequest { collection: "n".into(), state_vector: vec![], requester_id: author.clone(), epoch: 0 }), SyncActivity::Reconcile);
        assert_eq!(publish_activity(&NetworkMessage::PeerAnnounce { peer_id: author, collections: vec![] }), SyncActivity::Reconcile);
    }

    fn peer_update(dir: &tempfile::TempDir, collection: &str) -> Vec<u8> {
        let mut peer = crate::db::XdbDatabase::open(dir.path().join("peer.sqlite")).unwrap();
        peer.create_record(collection, serde_json::json!({"title": "from peer"})).unwrap();
        peer.get_full_state(collection).unwrap()
    }

    #[test]
    fn an_update_waiting_for_the_database_lock_is_held_when_the_pause_lands_first() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::create_shared_db(dir.path().join("data.sqlite")).unwrap();
        let update = peer_update(&dir, "notes");
        let stats = Arc::new(StdMutex::new(SyncStats::default()));
        let gate = SyncGate::new();

        // The gate is OPEN when the update arrives, so the pre-check passes;
        // the update then waits for the database lock, which the test holds.
        let guard = db.lock().unwrap();
        let worker = {
            let (db, update, stats, gate) = (db.clone(), update.clone(), stats.clone(), gate.clone());
            std::thread::spawn(move || NetworkNode::apply_inbound(&db, "notes", 0, &update, "peer", &stats, &gate, false))
        };
        std::thread::sleep(std::time::Duration::from_millis(300));
        // A restore pauses the gate while the update is still waiting.
        gate.pause();
        drop(guard);
        assert!(!worker.join().unwrap(), "the pause that landed first wins");
        assert!(db.lock().unwrap().get_collection("notes").unwrap().is_empty(), "protected data unchanged");
        assert_eq!(stats.lock().unwrap().updates_skipped_paused, 1);
        assert_eq!(stats.lock().unwrap().updates_applied, 0);

        // The same decision, exercised directly under a held lock.
        {
            let mut locked = db.lock().unwrap();
            assert!(!NetworkNode::apply_inbound_locked(&mut locked, "notes", 0, &update, "peer", &stats, &gate, true));
            assert!(locked.get_collection("notes").unwrap().is_empty());
        }
        assert_eq!(stats.lock().unwrap().updates_skipped_paused, 2);

        // Resolution lifts the hold: the held update is not lost, the repair
        // pass re-fetches it, and a fresh delivery applies.
        gate.resume();
        assert!(NetworkNode::apply_inbound(&db, "notes", 0, &update, "peer", &stats, &gate, false));
        assert_eq!(db.lock().unwrap().get_collection("notes").unwrap().len(), 1);
        assert_eq!(stats.lock().unwrap().updates_applied, 1);
    }

    #[test]
    fn inbound_resets_are_held_while_paused_and_adopted_afterwards() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::create_shared_db(dir.path().join("data.sqlite")).unwrap();
        db.lock().unwrap().create_record("notes", serde_json::json!({"title": "local"})).unwrap();
        let stats = Arc::new(StdMutex::new(SyncStats::default()));
        let gate = SyncGate::new();
        gate.pause();
        assert!(!NetworkNode::apply_inbound_reset(&db, "notes", 3, "peer", &stats, &gate));
        assert_eq!(db.lock().unwrap().get_epoch("notes").unwrap(), 0, "no reset adopted while paused");
        assert_eq!(db.lock().unwrap().get_collection("notes").unwrap().len(), 1, "local records untouched");
        assert_eq!(stats.lock().unwrap().updates_skipped_paused, 1);
        assert_eq!(stats.lock().unwrap().resets_applied, 0);
        gate.resume();
        assert!(NetworkNode::apply_inbound_reset(&db, "notes", 3, "peer", &stats, &gate));
        assert_eq!(db.lock().unwrap().get_epoch("notes").unwrap(), 3);
        assert_eq!(stats.lock().unwrap().resets_applied, 1);
    }

    #[test]
    fn network_options_default_to_local_only() {
        let options = NetworkOptions::default();
        assert!(!options.discovery);
        assert!(!options.listen);
        assert_eq!(
            NetworkOptions::trusted_lan(),
            NetworkOptions {
                discovery: true,
                listen: true
            }
        );
    }

    #[test]
    fn messages_from_peers_without_epochs_still_deserialize_as_epoch_zero() {
        // Wire compatibility with nodes built before reset epochs existed.
        let legacy = r#"{"SyncUpdate":{"collection":"notes","update":[1,2],"sender_id":"peer"}}"#;
        let message: NetworkMessage = serde_json::from_str(legacy).unwrap();
        match message {
            NetworkMessage::SyncUpdate { epoch, collection, .. } => {
                assert_eq!(epoch, 0);
                assert_eq!(collection, "notes");
            }
            other => panic!("unexpected message: {other:?}"),
        }
        let request = r#"{"SyncRequest":{"collection":"notes","state_vector":[],"requester_id":"peer"}}"#;
        assert!(matches!(
            serde_json::from_str::<NetworkMessage>(request).unwrap(),
            NetworkMessage::SyncRequest { epoch: 0, .. }
        ));
    }

    #[test]
    fn repair_window_walks_the_collection_set_in_bounded_slices() {
        let collections: Vec<String> = (0..7).map(|i| format!("c{i}")).collect();
        let mut cursor = 0;
        assert_eq!(
            repair_window(&collections, &mut cursor, 3),
            vec!["c0", "c1", "c2"]
        );
        assert_eq!(
            repair_window(&collections, &mut cursor, 3),
            vec!["c3", "c4", "c5"]
        );
        assert_eq!(
            repair_window(&collections, &mut cursor, 3),
            vec!["c6", "c0", "c1"]
        );
        assert!(repair_window(&[], &mut cursor, 3).is_empty());
        assert_eq!(cursor, 0);
        let mut cursor = 0;
        assert_eq!(repair_window(&collections, &mut cursor, 50).len(), 7);
    }

    #[test]
    fn sync_gate_pauses_and_resumes() {
        let gate = SyncGate::new();
        assert!(!gate.is_paused());
        gate.pause();
        assert!(gate.is_paused());
        gate.resume();
        assert!(!gate.is_paused());
    }

    #[test]
    fn repair_jitter_is_bounded_and_deterministic() {
        let peer = PeerId::random();
        assert_eq!(repair_jitter(&peer), repair_jitter(&peer));
        assert!(repair_jitter(&peer) < Duration::from_secs(5));
    }
}

#[cfg(test)]
#[path = "network_tests.rs"]
mod loopback_tests;
