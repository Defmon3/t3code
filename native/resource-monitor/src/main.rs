use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::io::{self, BufRead, BufWriter, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{
    MINIMUM_CPU_UPDATE_INTERVAL, Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind,
};

const PROTOCOL_VERSION: u32 = 4;
const MIN_SAMPLE_INTERVAL_MS: u64 = 250;
const MAX_SAMPLE_INTERVAL_MS: u64 = 60_000;
const PROCESS_START_TIME_PRECISION_MS: u64 = 1_000;
const HISTORY_RETENTION_MS: u64 = 60 * 60_000;
const MAX_HISTORY_SNAPSHOTS: usize = 3_600;
const INPUT_QUEUE_CAPACITY: usize = 64;
const MAX_HISTORY_RETAINED_ENTRIES: usize = 20_000;
const MAX_HISTORY_RETAINED_BYTES: usize = 64 * 1024 * 1024;
const MAX_PROCESS_NAME_BYTES: usize = 1_024;
const MAX_PROCESS_COMMAND_BYTES: usize = 16 * 1_024;
const MAX_PROCESS_ARGV_ENTRIES: usize = 256;
const MAX_PROCESS_CWD_BYTES: usize = 16 * 1_024;
const MAX_PROCESS_STATUS_BYTES: usize = 256;
const HISTORY_CHUNK_SNAPSHOTS: usize = 32;
const MAX_DISCOVERY_ROOTS: usize = 512;
const MAX_DISCOVERY_ROOT_PATH_BYTES: usize = 16 * 1024;
const MAX_DISCOVERY_PROCESSES: usize = 512;
const MAX_DISCOVERY_TOTAL_PROCESSES: usize = 4_096;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalProcess {
    pid: u32,
    #[serde(default)]
    start_time_ms: Option<u64>,
}

impl ExternalProcess {
    fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Command {
    Configure {
        version: u32,
        root_pid: u32,
        sample_interval_ms: u64,
        #[serde(default)]
        external_processes: Vec<ExternalProcess>,
    },
    SetExternalProcesses {
        version: u32,
        processes: Vec<ExternalProcess>,
    },
    SetSampleInterval {
        version: u32,
        sample_interval_ms: u64,
    },
    SetStreaming {
        version: u32,
        enabled: bool,
    },
    SampleNow {
        version: u32,
        request_id: String,
    },
    ReadHistory {
        version: u32,
        request_id: String,
        window_ms: u64,
    },
    DiscoverProcesses {
        version: u32,
        request_id: String,
        roots: Vec<String>,
    },
    Shutdown {
        version: u32,
    },
}

impl Command {
    fn version(&self) -> u32 {
        match self {
            Self::Configure { version, .. }
            | Self::SetExternalProcesses { version, .. }
            | Self::SetSampleInterval { version, .. }
            | Self::SetStreaming { version, .. }
            | Self::SampleNow { version, .. }
            | Self::ReadHistory { version, .. }
            | Self::DiscoverProcesses { version, .. }
            | Self::Shutdown { version } => *version,
        }
    }
}

enum Input {
    Command(Command),
    Invalid(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    cumulative_cpu_time: bool,
    current_cpu_percent: bool,
    resident_memory: bool,
    virtual_memory: bool,
    io_bytes: bool,
    process_start_time: bool,
    process_tree: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HelloEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    sidecar_version: &'static str,
    sidecar_pid: u32,
    platform: &'static str,
    arch: &'static str,
    capabilities: Capabilities,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum IoSemantics {
    Storage,
    AllIo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessSample {
    pid: u32,
    ppid: u32,
    start_time_ms: u64,
    run_time_ms: u64,
    name: String,
    command: String,
    status: String,
    cpu_percent: f32,
    cpu_time_ms: u64,
    resident_bytes: u64,
    virtual_bytes: u64,
    io_read_bytes: u64,
    io_write_bytes: u64,
    io_semantics: IoSemantics,
}

impl ProcessSample {
    fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            .saturating_add(self.name.len())
            .saturating_add(self.command.len())
            .saturating_add(self.status.len())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveredProcessSample {
    #[serde(flatten)]
    process: ProcessSample,
    #[serde(skip_serializing_if = "Option::is_none")]
    argv: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    sequence: u64,
    sampled_at_unix_ms: u64,
    collection_duration_micros: u64,
    scanned_process_count: usize,
    retained_process_count: usize,
    inaccessible_process_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    external_processes: Vec<ExternalProcess>,
    processes: Vec<ProcessSample>,
}

impl SnapshotEvent {
    fn retained_entry_count(&self) -> usize {
        self.processes
            .len()
            .saturating_add(self.external_processes.len())
    }

    fn estimated_history_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            .saturating_add(
                self.processes
                    .iter()
                    .map(ProcessSample::estimated_history_bytes)
                    .sum::<usize>(),
            )
            .saturating_add(
                self.external_processes
                    .iter()
                    .map(ExternalProcess::estimated_history_bytes)
                    .sum::<usize>(),
            )
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryChunkEvent<'a> {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    request_id: &'a str,
    done: bool,
    snapshots: &'a [SnapshotEvent],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessDiscoveryEvent<'a> {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    request_id: &'a str,
    done: bool,
    processes: &'a [DiscoveredProcessSample],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    version: u32,
    #[serde(rename = "type")]
    event_type: &'static str,
    code: &'static str,
    message: String,
    recoverable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}

#[derive(Debug, Clone)]
struct CollectorConfig {
    root_pid: u32,
    sample_interval: Option<Duration>,
    external_processes: HashMap<u32, Option<u64>>,
}

struct DiscoveryError {
    code: &'static str,
    message: String,
}

#[derive(Default)]
struct HistoryRecorder {
    snapshots: VecDeque<SnapshotEvent>,
    retained_entry_count: usize,
    retained_bytes: usize,
}

impl HistoryRecorder {
    fn record(&mut self, snapshot: &SnapshotEvent) {
        self.record_with_limits(
            snapshot,
            MAX_HISTORY_SNAPSHOTS,
            MAX_HISTORY_RETAINED_ENTRIES,
            MAX_HISTORY_RETAINED_BYTES,
        );
    }

    fn record_with_limits(
        &mut self,
        snapshot: &SnapshotEvent,
        max_snapshots: usize,
        max_retained_entries: usize,
        max_retained_bytes: usize,
    ) {
        let clock_moved_backward = self
            .snapshots
            .back()
            .is_some_and(|previous| previous.sampled_at_unix_ms > snapshot.sampled_at_unix_ms);
        let mut retained = snapshot.clone();
        retained.request_id = None;
        self.retained_entry_count = self
            .retained_entry_count
            .saturating_add(retained.retained_entry_count());
        self.retained_bytes = self
            .retained_bytes
            .saturating_add(retained.estimated_history_bytes());
        self.snapshots.push_back(retained);
        self.trim_to_limits(
            snapshot.sampled_at_unix_ms,
            max_snapshots,
            max_retained_entries,
            max_retained_bytes,
            clock_moved_backward,
        );
    }

    fn trim_to_limits(
        &mut self,
        now_ms: u64,
        max_snapshots: usize,
        max_retained_entries: usize,
        max_retained_bytes: usize,
        clock_moved_backward: bool,
    ) {
        if clock_moved_backward {
            let mut future_entry_count = 0usize;
            let mut future_bytes = 0usize;
            self.snapshots.retain(|snapshot| {
                let keep = snapshot.sampled_at_unix_ms <= now_ms;
                if !keep {
                    future_entry_count =
                        future_entry_count.saturating_add(snapshot.retained_entry_count());
                    future_bytes = future_bytes.saturating_add(snapshot.estimated_history_bytes());
                }
                keep
            });
            self.retained_entry_count =
                self.retained_entry_count.saturating_sub(future_entry_count);
            self.retained_bytes = self.retained_bytes.saturating_sub(future_bytes);
        }

        while self.snapshots.front().is_some_and(|snapshot| {
            snapshot.sampled_at_unix_ms < now_ms.saturating_sub(HISTORY_RETENTION_MS)
                || self.snapshots.len() > max_snapshots
                || self.retained_entry_count > max_retained_entries
                || self.retained_bytes > max_retained_bytes
        }) {
            if let Some(removed) = self.snapshots.pop_front() {
                self.retained_entry_count = self
                    .retained_entry_count
                    .saturating_sub(removed.retained_entry_count());
                self.retained_bytes = self
                    .retained_bytes
                    .saturating_sub(removed.estimated_history_bytes());
            }
        }
    }

    fn read(&self, window_ms: u64, now_ms: u64) -> Vec<SnapshotEvent> {
        let started_at_ms = now_ms.saturating_sub(window_ms.min(HISTORY_RETENTION_MS));
        self.snapshots
            .iter()
            .filter(|snapshot| {
                snapshot.sampled_at_unix_ms >= started_at_ms
                    && snapshot.sampled_at_unix_ms <= now_ms
            })
            .cloned()
            .collect()
    }
}

struct Collector {
    system: System,
    discovery_system: System,
    sequence: u64,
    cpu_baseline_refreshed_at: Option<Instant>,
    discovery_cpu_baseline_refreshed_at: Option<Instant>,
}

impl Collector {
    fn new() -> Self {
        Self {
            system: System::new(),
            discovery_system: System::new(),
            sequence: 0,
            cpu_baseline_refreshed_at: None,
            discovery_cpu_baseline_refreshed_at: None,
        }
    }

    fn prime_cpu_usage(&mut self) {
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            global_process_refresh_kind(),
        );
        self.cpu_baseline_refreshed_at = Some(Instant::now());
    }

    fn sample(&mut self, config: &CollectorConfig, request_id: Option<String>) -> SnapshotEvent {
        if let Some(delay) =
            remaining_cpu_measurement_delay(self.cpu_baseline_refreshed_at.take(), Instant::now())
        {
            thread::sleep(delay);
        }
        let collection_started = Instant::now();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            global_process_refresh_kind(),
        );
        self.cpu_baseline_refreshed_at = Some(Instant::now());

        let rows = self
            .system
            .processes()
            .iter()
            .map(|(pid, process)| {
                let pid = pid.as_u32();
                let ppid = process.parent().map(Pid::as_u32).unwrap_or(0);
                (pid, ppid, process.start_time().saturating_mul(1_000))
            })
            .collect::<Vec<_>>();
        let external_processes = config
            .external_processes
            .iter()
            .filter_map(|(pid, expected_start_time_ms)| {
                let (_, _, actual_start_time_ms) = rows
                    .iter()
                    .find(|(candidate_pid, _, _)| candidate_pid == pid)?;
                matches_external_identity(*actual_start_time_ms, *expected_start_time_ms).then_some(
                    ExternalProcess {
                        pid: *pid,
                        start_time_ms: Some(*actual_start_time_ms),
                    },
                )
            })
            .collect::<Vec<_>>();
        let mut roots = external_processes
            .iter()
            .map(|process| process.pid)
            .collect::<HashSet<_>>();
        roots.insert(config.root_pid);
        let tracked = select_tracked_pids(&rows, &roots);
        let tracked_process_count = tracked.len();
        let mut processes = tracked
            .into_iter()
            .filter_map(|pid| {
                self.system
                    .process(Pid::from_u32(pid))
                    .map(|process| process_sample(pid, process))
            })
            .collect::<Vec<_>>();
        processes.sort_by_key(|process| process.pid);
        self.sequence = self.sequence.saturating_add(1);

        SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: self.sequence,
            sampled_at_unix_ms: unix_time_ms(),
            collection_duration_micros: collection_started.elapsed().as_micros() as u64,
            scanned_process_count: self.system.processes().len(),
            retained_process_count: processes.len(),
            inaccessible_process_count: inaccessible_process_count(
                tracked_process_count,
                processes.len(),
            ),
            request_id,
            external_processes,
            processes,
        }
    }

    fn discover_processes(
        &mut self,
        roots: Vec<String>,
    ) -> Result<Vec<DiscoveredProcessSample>, DiscoveryError> {
        let roots = normalize_discovery_roots(roots).map_err(|message| DiscoveryError {
            code: "invalid-discovery",
            message,
        })?;
        let primed_pids = self.refresh_discovery_cpu_usage();
        let rows = self
            .discovery_system
            .processes()
            .iter()
            .map(|(pid, process)| {
                (
                    pid.as_u32(),
                    process.parent().map(Pid::as_u32).unwrap_or(0),
                    process
                        .cwd()
                        .is_some_and(|cwd| cwd_is_within_roots(&cwd.to_string_lossy(), &roots)),
                    discovery_process_has_cpu_sample(pid.as_u32(), &primed_pids),
                )
            })
            .collect::<Vec<_>>();
        let discovered_pids = select_discovery_pids(&rows);
        if discovered_pids.len() > MAX_DISCOVERY_TOTAL_PROCESSES {
            return Err(DiscoveryError {
                code: "discovery-limit-exceeded",
                message: format!(
                    "discoverProcesses found more than {MAX_DISCOVERY_TOTAL_PROCESSES} processes; narrow the requested roots"
                ),
            });
        }
        let mut processes = discovered_pids
            .into_iter()
            .filter_map(|pid| {
                self.discovery_system
                    .process(Pid::from_u32(pid))
                    .map(|process| discovered_process_sample(pid, process))
            })
            .collect::<Vec<_>>();
        sort_discovered_processes(&mut processes);
        Ok(processes)
    }

    fn refresh_discovery_cpu_usage(&mut self) -> HashSet<u32> {
        if self.discovery_cpu_baseline_refreshed_at.is_none() {
            self.discovery_system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                discovery_cpu_priming_refresh_kind(),
            );
            self.discovery_cpu_baseline_refreshed_at = Some(Instant::now());
        }
        let primed_pids = self
            .discovery_system
            .processes()
            .keys()
            .map(|pid| pid.as_u32())
            .collect::<HashSet<_>>();
        if let Some(delay) = remaining_cpu_measurement_delay(
            self.discovery_cpu_baseline_refreshed_at.take(),
            Instant::now(),
        ) {
            thread::sleep(delay);
        }
        self.discovery_system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            discovery_process_refresh_kind(),
        );
        self.discovery_cpu_baseline_refreshed_at = Some(Instant::now());
        primed_pids
    }
}

fn discovery_process_has_cpu_sample(pid: u32, primed_pids: &HashSet<u32>) -> bool {
    primed_pids.contains(&pid)
}

fn sort_discovered_processes(processes: &mut [DiscoveredProcessSample]) {
    processes.sort_by_key(|process| process.process.pid);
}

fn process_sample(pid: u32, process: &sysinfo::Process) -> ProcessSample {
    let disk_usage = process.disk_usage();
    let command = bounded_process_argv(process.cmd()).map_or_else(
        || process.name().to_string_lossy().into_owned(),
        |argv| argv.join(" "),
    );
    ProcessSample {
        pid,
        ppid: process.parent().map(Pid::as_u32).unwrap_or(0),
        start_time_ms: process.start_time().saturating_mul(1_000),
        run_time_ms: process.run_time().saturating_mul(1_000),
        name: truncate_utf8(
            process.name().to_string_lossy().into_owned(),
            MAX_PROCESS_NAME_BYTES,
        ),
        command: truncate_utf8(command, MAX_PROCESS_COMMAND_BYTES),
        status: truncate_utf8(format!("{:?}", process.status()), MAX_PROCESS_STATUS_BYTES),
        cpu_percent: process.cpu_usage(),
        cpu_time_ms: process.accumulated_cpu_time(),
        resident_bytes: process.memory(),
        virtual_bytes: process.virtual_memory(),
        io_read_bytes: disk_usage.total_read_bytes,
        io_write_bytes: disk_usage.total_written_bytes,
        io_semantics: io_semantics(),
    }
}

fn discovered_process_sample(pid: u32, process: &sysinfo::Process) -> DiscoveredProcessSample {
    DiscoveredProcessSample {
        process: process_sample(pid, process),
        argv: bounded_process_argv(process.cmd()),
        cwd: process
            .cwd()
            .map(|path| truncate_utf8(path.to_string_lossy().into_owned(), MAX_PROCESS_CWD_BYTES)),
    }
}

fn global_process_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_memory()
        .with_cpu()
        .with_disk_usage()
        .with_cmd(UpdateKind::Always)
        .without_tasks()
}

fn discovery_process_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_memory()
        .with_cpu()
        .with_disk_usage()
        .with_cmd(UpdateKind::OnlyIfNotSet)
        .with_cwd(UpdateKind::OnlyIfNotSet)
        .without_tasks()
}

fn discovery_cpu_priming_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing().with_cpu().without_tasks()
}

fn normalize_discovery_roots(roots: Vec<String>) -> Result<Vec<String>, String> {
    if roots.is_empty() || roots.len() > MAX_DISCOVERY_ROOTS {
        return Err(format!(
            "discoverProcesses requires between 1 and {MAX_DISCOVERY_ROOTS} roots"
        ));
    }
    let mut normalized = HashSet::new();
    for root in roots {
        if root.len() > MAX_DISCOVERY_ROOT_PATH_BYTES {
            return Err(format!(
                "discoverProcesses root exceeds {MAX_DISCOVERY_ROOT_PATH_BYTES} bytes"
            ));
        }
        let root = normalize_discovery_path(&root);
        if root.is_empty() {
            return Err("discoverProcesses roots must be non-empty".to_owned());
        }
        normalized.insert(root);
    }
    let mut roots = normalized.into_iter().collect::<Vec<_>>();
    roots.sort();
    Ok(roots)
}

fn normalize_discovery_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    let path = if path == "/" {
        path.as_str()
    } else {
        path.trim_end_matches('/')
    };
    #[cfg(windows)]
    {
        path.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_owned()
    }
}

fn cwd_is_within_roots(cwd: &str, roots: &[String]) -> bool {
    let cwd = normalize_discovery_path(cwd);
    roots.iter().any(|root| {
        cwd == *root
            || cwd
                .strip_prefix(root)
                .is_some_and(|suffix| suffix.starts_with('/'))
    })
}

fn inaccessible_process_count(selected: usize, materialized: usize) -> usize {
    selected.saturating_sub(materialized)
}

fn remaining_cpu_measurement_delay(
    baseline_refreshed_at: Option<Instant>,
    now: Instant,
) -> Option<Duration> {
    baseline_refreshed_at
        .and_then(|baseline| MINIMUM_CPU_UPDATE_INTERVAL.checked_sub(now.duration_since(baseline)))
        .filter(|delay| !delay.is_zero())
}

fn matches_external_identity(
    actual_start_time_ms: u64,
    expected_start_time_ms: Option<u64>,
) -> bool {
    // sysinfo reports process starts at whole-second precision. Normalize the
    // higher-resolution Electron timestamp to that same bucket instead of
    // accepting adjacent seconds, which could attach a quickly reused PID.
    expected_start_time_ms.is_none_or(|expected| {
        actual_start_time_ms == expected - (expected % PROCESS_START_TIME_PRECISION_MS)
    })
}

fn select_discovery_pids(rows: &[(u32, u32, bool, bool)]) -> HashSet<u32> {
    let mut children_by_parent = HashMap::<u32, Vec<u32>>::new();
    let mut primed_pids = HashSet::new();
    let mut roots = Vec::new();
    for (pid, ppid, cwd_is_within_root, has_cpu_sample) in rows {
        children_by_parent.entry(*ppid).or_default().push(*pid);
        if *has_cpu_sample {
            primed_pids.insert(*pid);
            if *cwd_is_within_root {
                roots.push(*pid);
            }
        }
    }

    let mut selected = HashSet::new();
    let mut pending = roots;
    while let Some(pid) = pending.pop() {
        if !selected.insert(pid) {
            continue;
        }
        pending.extend(children_by_parent.get(&pid).into_iter().flatten().copied());
    }
    selected.retain(|pid| primed_pids.contains(pid));
    selected
}

fn select_tracked_pids(rows: &[(u32, u32, u64)], roots: &HashSet<u32>) -> HashSet<u32> {
    let mut children_by_parent = HashMap::<u32, Vec<(u32, u64)>>::new();
    let mut start_time_by_pid = HashMap::<u32, u64>::new();
    for (pid, ppid, start_time_ms) in rows {
        children_by_parent
            .entry(*ppid)
            .or_default()
            .push((*pid, *start_time_ms));
        start_time_by_pid.insert(*pid, *start_time_ms);
    }

    let mut tracked = HashSet::new();
    let mut visited_identities = HashSet::new();
    let mut queue = roots
        .iter()
        .filter_map(|pid| {
            start_time_by_pid
                .get(pid)
                .map(|start_time_ms| (*pid, *start_time_ms))
        })
        .collect::<VecDeque<_>>();

    while let Some((pid, start_time_ms)) = queue.pop_front() {
        if !visited_identities.insert((pid, start_time_ms)) {
            continue;
        }
        tracked.insert(pid);
        if let Some(children) = children_by_parent.get(&pid) {
            queue.extend(
                children
                    .iter()
                    .copied()
                    .filter(|(_, child_start_time_ms)| *child_start_time_ms >= start_time_ms),
            );
        }
    }

    tracked
}

fn truncate_utf8(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while !value.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    value.truncate(boundary);
    value
}

fn bounded_process_argv(command: &[OsString]) -> Option<Vec<String>> {
    if command.is_empty() {
        return None;
    }
    let mut argv = Vec::with_capacity(command.len().min(MAX_PROCESS_ARGV_ENTRIES));
    let mut serialized_bytes = 2usize;
    for part in command.iter().take(MAX_PROCESS_ARGV_ENTRIES) {
        let entry_overhead = 2 + usize::from(!argv.is_empty());
        if serialized_bytes.saturating_add(entry_overhead) > MAX_PROCESS_COMMAND_BYTES {
            break;
        }
        let remaining_bytes = MAX_PROCESS_COMMAND_BYTES
            .saturating_sub(serialized_bytes)
            .saturating_sub(entry_overhead);
        let value = truncate_utf8(part.to_string_lossy().into_owned(), remaining_bytes);
        serialized_bytes = serialized_bytes
            .saturating_add(entry_overhead)
            .saturating_add(value.len());
        argv.push(value);
    }
    Some(argv)
}

#[cfg(test)]
fn estimated_argv_json_bytes(argv: &[String]) -> usize {
    if argv.is_empty() {
        return 0;
    }
    2usize
        .saturating_add(argv.len().saturating_mul(2))
        .saturating_add(argv.len().saturating_sub(1))
        .saturating_add(argv.iter().map(String::len).sum::<usize>())
}

fn io_semantics() -> IoSemantics {
    if cfg!(target_os = "windows") {
        IoSemantics::AllIo
    } else {
        IoSemantics::Storage
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn clamp_sample_interval(sample_interval_ms: u64) -> Option<Duration> {
    (sample_interval_ms > 0).then(|| {
        Duration::from_millis(
            sample_interval_ms.clamp(MIN_SAMPLE_INTERVAL_MS, MAX_SAMPLE_INTERVAL_MS),
        )
    })
}

fn spawn_input_reader() -> Receiver<Input> {
    let (sender, receiver) = mpsc::sync_channel(INPUT_QUEUE_CAPACITY);
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let _ = sender.send(Input::Invalid(format!(
                        "failed reading command stream: {error}"
                    )));
                    return;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Command>(&line) {
                Ok(command) => {
                    if sender.send(Input::Command(command)).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    if sender
                        .send(Input::Invalid(format!("invalid command: {error}")))
                        .is_err()
                    {
                        return;
                    }
                }
            }
        }
    });
    receiver
}

fn sample_now_deadline(
    current: Option<Instant>,
    interval: Option<Duration>,
    now: Instant,
) -> Option<Instant> {
    current.or_else(|| interval.map(|duration| now + duration))
}

fn write_event<T: Serialize>(writer: &mut impl Write, event: &T) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, event)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn write_error(
    writer: &mut impl Write,
    code: &'static str,
    message: impl Into<String>,
    recoverable: bool,
) -> io::Result<()> {
    write_event(
        writer,
        &ErrorEvent {
            version: PROTOCOL_VERSION,
            event_type: "error",
            code,
            message: message.into(),
            recoverable,
            request_id: None,
        },
    )
}

fn write_discovery_error(
    writer: &mut impl Write,
    request_id: String,
    code: &'static str,
    message: impl Into<String>,
) -> io::Result<()> {
    write_event(
        writer,
        &ErrorEvent {
            version: PROTOCOL_VERSION,
            event_type: "error",
            code,
            message: message.into(),
            recoverable: true,
            request_id: Some(request_id),
        },
    )
}

fn write_history(
    writer: &mut impl Write,
    request_id: &str,
    snapshots: &[SnapshotEvent],
) -> io::Result<()> {
    if snapshots.is_empty() {
        return write_event(
            writer,
            &HistoryChunkEvent {
                version: PROTOCOL_VERSION,
                event_type: "historyChunk",
                request_id,
                done: true,
                snapshots,
            },
        );
    }

    let chunk_count = snapshots.len().div_ceil(HISTORY_CHUNK_SNAPSHOTS);
    for (index, chunk) in snapshots.chunks(HISTORY_CHUNK_SNAPSHOTS).enumerate() {
        write_event(
            writer,
            &HistoryChunkEvent {
                version: PROTOCOL_VERSION,
                event_type: "historyChunk",
                request_id,
                done: index + 1 == chunk_count,
                snapshots: chunk,
            },
        )?;
    }
    Ok(())
}

fn discovery_chunk_count(process_count: usize) -> usize {
    process_count.div_ceil(MAX_DISCOVERY_PROCESSES).max(1)
}

fn write_process_discovery(
    writer: &mut impl Write,
    request_id: &str,
    processes: &[DiscoveredProcessSample],
) -> io::Result<()> {
    if processes.is_empty() {
        return write_event(
            writer,
            &ProcessDiscoveryEvent {
                version: PROTOCOL_VERSION,
                event_type: "processDiscovery",
                request_id,
                done: true,
                processes,
            },
        );
    }

    let chunk_count = discovery_chunk_count(processes.len());
    for (index, chunk) in processes.chunks(MAX_DISCOVERY_PROCESSES).enumerate() {
        write_event(
            writer,
            &ProcessDiscoveryEvent {
                version: PROTOCOL_VERSION,
                event_type: "processDiscovery",
                request_id,
                done: index + 1 == chunk_count,
                processes: chunk,
            },
        )?;
    }
    Ok(())
}

fn main() -> io::Result<()> {
    let mut writer = BufWriter::new(io::stdout().lock());
    write_event(
        &mut writer,
        &HelloEvent {
            version: PROTOCOL_VERSION,
            event_type: "hello",
            sidecar_version: env!("CARGO_PKG_VERSION"),
            sidecar_pid: std::process::id(),
            platform: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            capabilities: Capabilities {
                cumulative_cpu_time: true,
                current_cpu_percent: true,
                resident_memory: true,
                virtual_memory: true,
                io_bytes: true,
                process_start_time: true,
                process_tree: true,
            },
        },
    )?;

    let receiver = spawn_input_reader();
    let mut collector = Collector::new();
    let mut history = HistoryRecorder::default();
    let mut config: Option<CollectorConfig> = None;
    let mut next_sample_at: Option<Instant> = None;
    let mut streaming_enabled = false;

    loop {
        if next_sample_at.is_some_and(|deadline| deadline <= Instant::now()) {
            if let Some(current) = config.as_ref() {
                if let Some(interval) = current.sample_interval {
                    let event = collector.sample(current, None);
                    history.record(&event);
                    if streaming_enabled {
                        write_event(&mut writer, &event)?;
                    }
                    next_sample_at = Some(Instant::now() + interval);
                } else {
                    next_sample_at = None;
                }
            } else {
                next_sample_at = None;
            }
            continue;
        }

        let timeout = next_sample_at
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(60));

        match receiver.recv_timeout(timeout) {
            Ok(Input::Invalid(message)) => {
                write_error(&mut writer, "invalid-command", message, true)?;
            }
            Ok(Input::Command(command)) => {
                if command.version() != PROTOCOL_VERSION {
                    write_error(
                        &mut writer,
                        "protocol-mismatch",
                        format!(
                            "unsupported protocol version {}; expected {PROTOCOL_VERSION}",
                            command.version()
                        ),
                        false,
                    )?;
                    continue;
                }

                match command {
                    Command::Configure {
                        root_pid,
                        sample_interval_ms,
                        external_processes,
                        ..
                    } => {
                        let sample_interval = clamp_sample_interval(sample_interval_ms);
                        config = Some(CollectorConfig {
                            root_pid,
                            sample_interval,
                            external_processes: external_processes
                                .into_iter()
                                .map(|process| (process.pid, process.start_time_ms))
                                .collect(),
                        });
                        collector.prime_cpu_usage();
                        next_sample_at = sample_interval.map(|_| Instant::now());
                    }
                    Command::SetExternalProcesses { processes, .. } => {
                        if let Some(current) = config.as_mut() {
                            current.external_processes = processes
                                .into_iter()
                                .map(|process| (process.pid, process.start_time_ms))
                                .collect();
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before external processes",
                                true,
                            )?;
                        }
                    }
                    Command::SetSampleInterval {
                        sample_interval_ms, ..
                    } => {
                        if let Some(current) = config.as_mut() {
                            current.sample_interval = clamp_sample_interval(sample_interval_ms);
                            next_sample_at = current
                                .sample_interval
                                .map(|interval| Instant::now() + interval);
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before changing the sample interval",
                                true,
                            )?;
                        }
                    }
                    Command::SetStreaming { enabled, .. } => {
                        streaming_enabled = enabled;
                    }
                    Command::SampleNow { request_id, .. } => {
                        if let Some(current) = config.as_ref() {
                            let event = collector.sample(current, Some(request_id));
                            history.record(&event);
                            write_event(&mut writer, &event)?;
                            next_sample_at = sample_now_deadline(
                                next_sample_at,
                                current.sample_interval,
                                Instant::now(),
                            );
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before sampling",
                                true,
                            )?;
                        }
                    }
                    Command::ReadHistory {
                        request_id,
                        window_ms,
                        ..
                    } => {
                        if config.is_some() {
                            let snapshots = history.read(window_ms, unix_time_ms());
                            write_history(&mut writer, &request_id, &snapshots)?;
                        } else {
                            write_error(
                                &mut writer,
                                "not-configured",
                                "configure must be sent before reading history",
                                true,
                            )?;
                        }
                    }
                    Command::DiscoverProcesses {
                        request_id, roots, ..
                    } => match collector.discover_processes(roots) {
                        Ok(processes) => {
                            write_process_discovery(&mut writer, &request_id, &processes)?
                        }
                        Err(error) => write_discovery_error(
                            &mut writer,
                            request_id,
                            error.code,
                            error.message,
                        )?,
                    },
                    Command::Shutdown { .. } => return Ok(()),
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn discovered_process(pid: u32) -> DiscoveredProcessSample {
        DiscoveredProcessSample {
            process: ProcessSample {
                pid,
                ppid: 0,
                start_time_ms: 0,
                run_time_ms: 0,
                name: "process".to_owned(),
                command: "vp test".to_owned(),
                status: "Run".to_owned(),
                cpu_percent: 0.0,
                cpu_time_ms: 0,
                resident_bytes: 0,
                virtual_bytes: 0,
                io_read_bytes: 0,
                io_write_bytes: 0,
                io_semantics: IoSemantics::Storage,
            },
            argv: Some(vec!["vp".to_owned(), "test".to_owned()]),
            cwd: Some("/workspace".to_owned()),
        }
    }

    #[test]
    fn selects_roots_and_all_descendants() {
        let rows = vec![
            (10, 1, 1_000),
            (11, 10, 1_100),
            (12, 11, 1_200),
            (20, 1, 2_000),
            (21, 20, 2_100),
            (30, 99, 3_000),
        ];
        let tracked = select_tracked_pids(&rows, &HashSet::from([10, 20]));

        assert_eq!(tracked, HashSet::from([10, 11, 12, 20, 21]));
    }

    #[test]
    fn rejects_descendants_older_than_a_reused_parent_pid() {
        let rows = vec![
            (20, 1, 5_000),
            (21, 20, 4_000),
            (22, 20, 5_100),
            (23, 21, 5_200),
        ];
        let tracked = select_tracked_pids(&rows, &HashSet::from([20]));

        assert_eq!(tracked, HashSet::from([20, 22]));
    }

    #[test]
    fn ignores_missing_roots() {
        let rows = vec![(10, 1, 1_000), (11, 10, 1_100)];
        let tracked = select_tracked_pids(&rows, &HashSet::from([99]));

        assert!(tracked.is_empty());
    }

    #[test]
    fn validates_external_process_start_identity() {
        assert!(matches_external_identity(10_000, None));
        assert!(matches_external_identity(10_000, Some(10_999)));
        assert!(!matches_external_identity(10_000, Some(11_000)));
        assert!(!matches_external_identity(10_000, Some(9_999)));
    }

    #[test]
    fn decodes_protocol_commands() {
        let configure = serde_json::from_str::<Command>(
            r#"{"version":4,"type":"configure","rootPid":42,"sampleIntervalMs":1000,"externalProcesses":[{"pid":7}]}"#,
        )
        .expect("configure command");

        match configure {
            Command::Configure {
                root_pid,
                sample_interval_ms,
                external_processes,
                ..
            } => {
                assert_eq!(root_pid, 42);
                assert_eq!(sample_interval_ms, 1_000);
                assert_eq!(external_processes[0].pid, 7);
                assert_eq!(external_processes[0].start_time_ms, None);
            }
            _ => panic!("unexpected command"),
        }

        let read_history = serde_json::from_str::<Command>(
            r#"{"version":4,"type":"readHistory","requestId":"history-1","windowMs":60000}"#,
        )
        .expect("read history command");
        assert!(matches!(
            read_history,
            Command::ReadHistory {
                request_id,
                window_ms: 60_000,
                ..
            } if request_id == "history-1"
        ));

        let discovery = serde_json::from_str::<Command>(
            r#"{"version":4,"type":"discoverProcesses","requestId":"discovery-1","roots":["/workspace"]}"#,
        )
        .expect("discovery command");
        assert!(matches!(
            discovery,
            Command::DiscoverProcesses { request_id, roots, .. }
                if request_id == "discovery-1" && roots == ["/workspace"]
        ));
    }

    #[test]
    fn clamps_sample_interval() {
        assert_eq!(clamp_sample_interval(0), None);
        assert_eq!(clamp_sample_interval(1), Some(Duration::from_millis(250)));
        assert_eq!(
            clamp_sample_interval(100_000),
            Some(Duration::from_millis(60_000))
        );
    }

    #[test]
    fn counts_selected_processes_that_could_not_be_materialized() {
        assert_eq!(inaccessible_process_count(5, 3), 2);
        assert_eq!(inaccessible_process_count(3, 5), 0);
    }

    #[test]
    fn waits_for_a_cpu_measurement_window_after_priming() {
        let baseline = Instant::now();

        assert_eq!(
            remaining_cpu_measurement_delay(Some(baseline), baseline),
            Some(MINIMUM_CPU_UPDATE_INTERVAL)
        );
        assert_eq!(
            remaining_cpu_measurement_delay(Some(baseline), baseline + MINIMUM_CPU_UPDATE_INTERVAL),
            None
        );
        assert_eq!(remaining_cpu_measurement_delay(None, baseline), None);
    }

    #[test]
    fn retains_bounded_history_without_request_ids() {
        let mut history = HistoryRecorder::default();
        for sequence in 0..=MAX_HISTORY_SNAPSHOTS {
            history.record(&SnapshotEvent {
                version: PROTOCOL_VERSION,
                event_type: "snapshot",
                sequence: sequence as u64,
                sampled_at_unix_ms: sequence as u64 * 1_000,
                collection_duration_micros: 1,
                scanned_process_count: 0,
                retained_process_count: 0,
                inaccessible_process_count: 0,
                request_id: Some("request".to_owned()),
                external_processes: vec![ExternalProcess {
                    pid: 7,
                    start_time_ms: Some(1_000),
                }],
                processes: Vec::new(),
            });
        }

        assert_eq!(history.snapshots.len(), MAX_HISTORY_SNAPSHOTS);
        assert!(
            history
                .snapshots
                .iter()
                .all(|snapshot| snapshot.request_id.is_none())
        );
        assert!(history.snapshots.iter().all(|snapshot| {
            snapshot.external_processes.len() == 1
                && snapshot.external_processes[0].pid == 7
                && snapshot.external_processes[0].start_time_ms == Some(1_000)
        }));
        assert_eq!(
            history
                .read(10_000, MAX_HISTORY_SNAPSHOTS as u64 * 1_000)
                .len(),
            11
        );
    }

    #[test]
    fn retains_sampled_descendants_of_registered_root_seeds() {
        let selected = select_discovery_pids(&[
            (10, 1, true, true),
            (11, 10, false, true),
            (12, 11, false, true),
            (13, 12, false, false),
            (20, 1, false, true),
        ]);

        assert_eq!(selected, HashSet::from([10, 11, 12]));
    }

    #[test]
    fn excludes_and_trims_future_history_after_the_clock_moves_backward() {
        let mut history = HistoryRecorder::default();
        let snapshot = SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: 1,
            sampled_at_unix_ms: 2_000,
            collection_duration_micros: 1,
            scanned_process_count: 0,
            retained_process_count: 0,
            inaccessible_process_count: 0,
            request_id: None,
            external_processes: Vec::new(),
            processes: Vec::new(),
        };
        history.record(&snapshot);

        assert!(history.read(0, 1_000).is_empty());

        history.record(&SnapshotEvent {
            sequence: 2,
            sampled_at_unix_ms: 1_000,
            ..snapshot
        });
        assert_eq!(history.snapshots.len(), 1);
        assert_eq!(
            history.snapshots.front().map(|entry| entry.sequence),
            Some(2)
        );
    }

    #[test]
    fn bounds_history_by_estimated_process_bytes() {
        let mut history = HistoryRecorder::default();
        let command = "x".repeat(128);
        let process = ProcessSample {
            pid: 1,
            ppid: 0,
            start_time_ms: 0,
            run_time_ms: 0,
            name: "process".to_owned(),
            command,
            status: "Run".to_owned(),
            cpu_percent: 0.0,
            cpu_time_ms: 0,
            resident_bytes: 0,
            virtual_bytes: 0,
            io_read_bytes: 0,
            io_write_bytes: 0,
            io_semantics: IoSemantics::Storage,
        };
        let snapshot_bytes =
            std::mem::size_of::<SnapshotEvent>() + process.estimated_history_bytes();
        for sequence in 0..3 {
            history.record_with_limits(
                &SnapshotEvent {
                    version: PROTOCOL_VERSION,
                    event_type: "snapshot",
                    sequence,
                    sampled_at_unix_ms: sequence * 1_000,
                    collection_duration_micros: 1,
                    scanned_process_count: 1,
                    retained_process_count: 1,
                    inaccessible_process_count: 0,
                    request_id: None,
                    external_processes: Vec::new(),
                    processes: vec![ProcessSample {
                        pid: sequence as u32 + 1,
                        start_time_ms: sequence * 1_000,
                        ..process.clone()
                    }],
                },
                3,
                3,
                snapshot_bytes * 2,
            );
        }

        assert!(history.retained_bytes <= snapshot_bytes * 2);
        assert_eq!(history.snapshots.len(), 2);
        assert_eq!(
            history.snapshots.front().map(|snapshot| snapshot.sequence),
            Some(1)
        );
    }

    #[test]
    fn counts_external_processes_toward_history_limits() {
        let mut history = HistoryRecorder::default();
        let external_processes = (1..=128)
            .map(|pid| ExternalProcess {
                pid,
                start_time_ms: Some(u64::from(pid) * 1_000),
            })
            .collect::<Vec<_>>();
        let snapshot = SnapshotEvent {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: 0,
            sampled_at_unix_ms: 0,
            collection_duration_micros: 1,
            scanned_process_count: 0,
            retained_process_count: 0,
            inaccessible_process_count: 0,
            request_id: None,
            external_processes,
            processes: Vec::new(),
        };
        let snapshot_bytes = snapshot.estimated_history_bytes();
        let snapshot_entries = snapshot.retained_entry_count();

        for sequence in 0..3 {
            history.record_with_limits(
                &SnapshotEvent {
                    sequence,
                    sampled_at_unix_ms: sequence * 1_000,
                    ..snapshot.clone()
                },
                3,
                snapshot_entries * 2,
                snapshot_bytes * 2,
            );
        }

        assert_eq!(history.retained_entry_count, snapshot_entries * 2);
        assert!(history.retained_bytes <= snapshot_bytes * 2);
        assert_eq!(history.snapshots.len(), 2);
        assert_eq!(
            history.snapshots.front().map(|snapshot| snapshot.sequence),
            Some(1)
        );
    }

    #[test]
    fn truncates_process_strings_at_utf8_boundaries() {
        let value = "é".repeat(MAX_PROCESS_NAME_BYTES);
        let truncated = truncate_utf8(value, MAX_PROCESS_NAME_BYTES - 1);

        assert!(truncated.len() < MAX_PROCESS_NAME_BYTES);
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    #[test]
    fn preserves_a_bounded_structured_process_argv() {
        let argv = bounded_process_argv(&[OsString::from("codex"), OsString::from("app-server")]);
        assert_eq!(
            argv,
            Some(vec!["codex".to_owned(), "app-server".to_owned()])
        );

        let oversized =
            bounded_process_argv(&[OsString::from("x".repeat(MAX_PROCESS_COMMAND_BYTES + 1))]);
        assert_eq!(
            oversized.as_ref().map(|argv| argv[0].len()),
            Some(MAX_PROCESS_COMMAND_BYTES - 4)
        );
        assert_eq!(
            oversized
                .as_ref()
                .map(|argv| estimated_argv_json_bytes(argv)),
            Some(MAX_PROCESS_COMMAND_BYTES)
        );
    }

    #[test]
    fn keeps_discovery_metadata_out_of_snapshot_samples() {
        let process = ProcessSample {
            pid: 1,
            ppid: 0,
            start_time_ms: 0,
            run_time_ms: 0,
            name: "process".to_owned(),
            command: "process".to_owned(),
            status: "Run".to_owned(),
            cpu_percent: 0.0,
            cpu_time_ms: 0,
            resident_bytes: 0,
            virtual_bytes: 0,
            io_read_bytes: 0,
            io_write_bytes: 0,
            io_semantics: IoSemantics::Storage,
        };
        let snapshot = serde_json::to_value(&process).expect("serialize snapshot process");
        assert!(snapshot.get("argv").is_none());
        assert!(snapshot.get("cwd").is_none());

        let discovery = DiscoveredProcessSample {
            process,
            argv: Some(vec!["codex".to_owned()]),
            cwd: Some("/workspace".to_owned()),
        };
        let discovery = serde_json::to_value(&discovery).expect("serialize discovery process");
        assert_eq!(discovery["argv"][0], "codex");
        assert_eq!(discovery["cwd"], "/workspace");
    }

    #[test]
    fn bounds_structured_process_argv_entries_and_empty_argument_overhead() {
        let command = vec![OsString::new(); MAX_PROCESS_ARGV_ENTRIES * 2];
        let argv = bounded_process_argv(&command).expect("argv");

        assert_eq!(argv.len(), MAX_PROCESS_ARGV_ENTRIES);
        assert!(argv.iter().all(String::is_empty));
        assert!(estimated_argv_json_bytes(&argv) <= MAX_PROCESS_COMMAND_BYTES);
    }

    #[test]
    fn refreshes_global_metrics_without_discovery_metadata() {
        let global_refresh_kind = global_process_refresh_kind();
        let discovery_refresh_kind = discovery_process_refresh_kind();
        let priming_refresh_kind = discovery_cpu_priming_refresh_kind();

        assert_eq!(global_refresh_kind.cmd(), UpdateKind::Always);
        assert_eq!(global_refresh_kind.cwd(), UpdateKind::Never);
        assert!(!global_refresh_kind.tasks());
        assert!(global_refresh_kind.cpu());
        assert!(global_refresh_kind.memory());
        assert!(global_refresh_kind.disk_usage());
        assert_eq!(discovery_refresh_kind.cmd(), UpdateKind::OnlyIfNotSet);
        assert_eq!(discovery_refresh_kind.cwd(), UpdateKind::OnlyIfNotSet);
        assert!(discovery_refresh_kind.cpu());
        assert!(discovery_refresh_kind.memory());
        assert!(priming_refresh_kind.cpu());
        assert_eq!(priming_refresh_kind.cmd(), UpdateKind::Never);
        assert_eq!(priming_refresh_kind.cwd(), UpdateKind::Never);
        assert!(!priming_refresh_kind.memory());
        assert!(!priming_refresh_kind.disk_usage());
        assert!(!priming_refresh_kind.tasks());
    }

    #[test]
    fn keeps_discovery_refresh_state_separate_from_sampling_state() {
        let collector = Collector::new();

        assert_ne!(
            std::ptr::addr_of!(collector.system),
            std::ptr::addr_of!(collector.discovery_system)
        );
        assert!(collector.cpu_baseline_refreshed_at.is_none());
        assert!(collector.discovery_cpu_baseline_refreshed_at.is_none());
    }

    #[test]
    fn splits_discovery_results_into_bounded_chunks() {
        let mut processes = (1..=513).rev().map(discovered_process).collect::<Vec<_>>();

        sort_discovered_processes(&mut processes);
        let mut output = Vec::new();
        write_process_discovery(&mut output, "discovery-1", &processes)
            .expect("write discovery chunks");
        let chunks = String::from_utf8(output)
            .expect("utf8 output")
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("chunk json"))
            .collect::<Vec<_>>();

        assert_eq!(processes.len(), 513);
        assert_eq!(
            processes.last().map(|process| process.process.pid),
            Some(513)
        );
        assert_eq!(discovery_chunk_count(processes.len()), 2);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0]["processes"].as_array().map(Vec::len), Some(512));
        assert_eq!(chunks[1]["processes"].as_array().map(Vec::len), Some(1));
        assert_eq!(chunks[1]["done"], true);
    }

    #[test]
    fn completes_empty_discovery_with_one_chunk() {
        let mut output = Vec::new();
        write_process_discovery(&mut output, "discovery-1", &[])
            .expect("write empty discovery completion");
        let completion =
            serde_json::from_slice::<serde_json::Value>(&output).expect("completion json");

        assert_eq!(discovery_chunk_count(0), 1);
        assert_eq!(discovery_chunk_count(MAX_DISCOVERY_PROCESSES), 1);
        assert_eq!(discovery_chunk_count(MAX_DISCOVERY_PROCESSES + 1), 2);
        assert_eq!(completion["done"], true);
        assert_eq!(completion["processes"].as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn bounds_total_discovery_results_without_silent_truncation() {
        assert_eq!(MAX_DISCOVERY_TOTAL_PROCESSES, 4_096);
    }

    #[test]
    fn normalizes_and_deduplicates_discovery_roots() {
        assert_eq!(
            normalize_discovery_roots(vec!["/workspace/".to_owned(), "/workspace".to_owned()]),
            Ok(vec!["/workspace".to_owned()])
        );
    }

    #[test]
    fn only_matches_cwds_equal_to_or_below_a_discovery_root() {
        let roots = vec!["/workspace/project".to_owned()];
        assert!(cwd_is_within_roots("/workspace/project", &roots));
        assert!(cwd_is_within_roots("/workspace/project/src", &roots));
        assert!(!cwd_is_within_roots("/workspace/project-other", &roots));
    }

    #[test]
    fn sample_now_does_not_postpone_an_existing_periodic_deadline() {
        let now = Instant::now();
        let deadline = now + Duration::from_secs(1);

        assert_eq!(
            sample_now_deadline(
                Some(deadline),
                Some(Duration::from_secs(5)),
                now + Duration::from_millis(100)
            ),
            Some(deadline)
        );
    }
}
