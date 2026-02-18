use crate::qmd::cmd;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;

// ── Public types ────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct RecordingState {
    pub active: bool,
    pub note_id: Option<String>,
    pub elapsed_seconds: u64,
}

#[derive(Clone, Serialize, serde::Deserialize)]
pub struct InputDeviceInfo {
    pub name: String,
    pub is_default: bool,
}

#[derive(Clone, Serialize)]
struct ProgressPayload {
    note_id: String,
    stage: String,
    detail: String,
}

#[derive(Clone, Serialize)]
struct RecordingCompletePayload {
    note_id: String,
    summary: Option<String>,
    transcript: Option<String>,
}

#[derive(Clone, Serialize)]
struct TickPayload {
    elapsed_seconds: u64,
    mic_level: f32,
    system_level: f32,
}

// ── Job persistence for crash recovery ──────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, PartialOrd)]
pub enum JobStage {
    Recording,
    Mixing,
    Transcribing,
    Summarizing,
    Saving,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordingJob {
    pub note_id: String,
    pub stage: JobStage,
    pub notes_dir: String,
    pub mic_path: String,
    pub system_path: String,
    pub final_wav_path: String,
    pub has_system: bool,
    pub transcript: Option<String>,
    pub summary: Option<String>,
    pub created_at: String,
}

impl RecordingJob {
    fn job_path(notes_dir: &str, note_id: &str) -> PathBuf {
        PathBuf::from(notes_dir)
            .join("meetings/.audio")
            .join(format!("{note_id}.job.json"))
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::job_path(&self.notes_dir, &self.note_id);
        let tmp = path.with_extension("tmp");
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("serialize job: {e}"))?;
        std::fs::write(&tmp, &json).map_err(|e| format!("write job tmp: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("rename job: {e}"))?;
        Ok(())
    }

    pub fn delete(&self) {
        let path = Self::job_path(&self.notes_dir, &self.note_id);
        let _ = std::fs::remove_file(path);
    }

    pub fn scan(notes_dir: &str) -> Vec<RecordingJob> {
        let pattern = PathBuf::from(notes_dir)
            .join("meetings/.audio/*.job.json")
            .to_string_lossy()
            .to_string();
        let mut jobs = Vec::new();
        for entry in glob::glob(&pattern).into_iter().flatten().flatten() {
            if let Ok(json) = std::fs::read_to_string(&entry) {
                if let Ok(job) = serde_json::from_str::<RecordingJob>(&json) {
                    jobs.push(job);
                }
            }
        }
        jobs
    }
}

/// Shared peak level updated by audio callbacks, read+reset by the tick emitter.
type AudioLevel = Arc<AtomicU32>;

fn level_store(level: &AudioLevel, peak: f32) {
    // Store the max of current and new peak.
    loop {
        let current = f32::from_bits(level.load(Ordering::Relaxed));
        if peak <= current {
            break;
        }
        match level.compare_exchange_weak(
            current.to_bits(),
            peak.to_bits(),
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => break,
            Err(_) => continue,
        }
    }
}

fn level_take(level: &AudioLevel) -> f32 {
    f32::from_bits(level.swap(0.0_f32.to_bits(), Ordering::Relaxed))
}

// ── Messages ────────────────────────────────────────────────────────

enum Msg {
    Start {
        note_id: String,
        notes_dir: String,
        preferred_device: Option<String>,
    },
    Stop,
    Shutdown,
}

// ── Handle ──────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct RecordingHandle {
    tx: mpsc::UnboundedSender<Msg>,
    active: Arc<AtomicBool>,
    note_id: Arc<std::sync::Mutex<Option<String>>>,
    elapsed: Arc<std::sync::atomic::AtomicU64>,
}

impl RecordingHandle {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let active = Arc::new(AtomicBool::new(false));
        let note_id: Arc<std::sync::Mutex<Option<String>>> =
            Arc::new(std::sync::Mutex::new(None));
        let elapsed = Arc::new(std::sync::atomic::AtomicU64::new(0));

        let worker_active = active.clone();
        let worker_note_id = note_id.clone();
        let worker_elapsed = elapsed.clone();

        tauri::async_runtime::spawn(async move {
            run_worker(rx, app_handle, worker_active, worker_note_id, worker_elapsed).await;
        });

        Self {
            tx,
            active,
            note_id,
            elapsed,
        }
    }

    pub fn start(&self, note_id: &str, notes_dir: &str, preferred_device: Option<String>) {
        let _ = self.tx.send(Msg::Start {
            note_id: note_id.to_string(),
            notes_dir: notes_dir.to_string(),
            preferred_device,
        });
    }

    pub fn stop(&self) {
        let _ = self.tx.send(Msg::Stop);
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(Msg::Shutdown);
    }

    pub fn state(&self) -> RecordingState {
        RecordingState {
            active: self.active.load(Ordering::Relaxed),
            note_id: self.note_id.lock().ok().and_then(|g| g.clone()),
            elapsed_seconds: self.elapsed.load(Ordering::Relaxed),
        }
    }
}

// ── Worker ──────────────────────────────────────────────────────────

async fn run_worker(
    mut rx: mpsc::UnboundedReceiver<Msg>,
    app_handle: tauri::AppHandle,
    active: Arc<AtomicBool>,
    note_id_slot: Arc<std::sync::Mutex<Option<String>>>,
    elapsed: Arc<std::sync::atomic::AtomicU64>,
) {
    loop {
        match rx.recv().await {
            Some(Msg::Start { note_id, notes_dir, preferred_device }) => {
                let audio_dir = PathBuf::from(&notes_dir).join("meetings/.audio");
                if let Err(e) = std::fs::create_dir_all(&audio_dir) {
                    eprintln!("recording: failed to create audio dir: {e}");
                    let _ = app_handle.emit(
                        "recording-error",
                        format!("Failed to create audio directory: {e}"),
                    );
                    continue;
                }

                // Set state
                active.store(true, Ordering::Relaxed);
                elapsed.store(0, Ordering::Relaxed);
                if let Ok(mut slot) = note_id_slot.lock() {
                    *slot = Some(note_id.clone());
                }
                let _ = app_handle.emit("recording-started", &note_id);

                // Spawn audio capture on a dedicated std::thread (cpal callbacks are real-time).
                let stop_flag = Arc::new(AtomicBool::new(false));
                let stop_flag_thread = stop_flag.clone();
                let mic_path = audio_dir.join(format!("{note_id}_mic.wav"));
                let system_path = audio_dir.join(format!("{note_id}_system.wav"));
                let final_wav = audio_dir.join(format!("{note_id}.wav"));

                // Create job file immediately.
                let mut job = RecordingJob {
                    note_id: note_id.clone(),
                    stage: JobStage::Recording,
                    notes_dir: notes_dir.clone(),
                    mic_path: mic_path.to_string_lossy().to_string(),
                    system_path: system_path.to_string_lossy().to_string(),
                    final_wav_path: final_wav.to_string_lossy().to_string(),
                    has_system: false,
                    transcript: None,
                    summary: None,
                    created_at: chrono::Local::now().to_rfc3339(),
                };
                if let Err(e) = job.save() {
                    eprintln!("recording: failed to save job file: {e}");
                }

                let mic_level: AudioLevel = Arc::new(AtomicU32::new(0.0_f32.to_bits()));
                let system_level: AudioLevel = Arc::new(AtomicU32::new(0.0_f32.to_bits()));

                let mic_path_clone = mic_path.clone();
                let system_path_clone = system_path.clone();
                let mic_level_capture = mic_level.clone();
                let system_level_capture = system_level.clone();

                let capture_thread = std::thread::spawn(move || {
                    capture_audio(
                        &mic_path_clone,
                        &system_path_clone,
                        stop_flag_thread,
                        preferred_device,
                        mic_level_capture,
                        system_level_capture,
                    )
                });

                // Tick elapsed every second while recording.
                let elapsed_clone = elapsed.clone();
                let active_clone = active.clone();
                let app_clone = app_handle.clone();
                let tick_handle = tauri::async_runtime::spawn(async move {
                    let mut seconds = 0u64;
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                        if !active_clone.load(Ordering::Relaxed) {
                            break;
                        }
                        seconds = seconds.wrapping_add(1);
                        let secs = seconds / 6; // ~150ms ticks → seconds
                        elapsed_clone.store(secs, Ordering::Relaxed);
                        let _ = app_clone.emit("recording-tick", TickPayload {
                            elapsed_seconds: secs,
                            mic_level: level_take(&mic_level),
                            system_level: level_take(&system_level),
                        });
                    }
                });

                // Wait for Stop or Shutdown message.
                let mut is_shutdown = false;
                loop {
                    match rx.recv().await {
                        Some(Msg::Stop) => {
                            stop_flag.store(true, Ordering::Relaxed);
                            active.store(false, Ordering::Relaxed);
                            tick_handle.abort();
                            let _ = app_handle.emit("recording-stopped", &note_id);

                            let capture_result = capture_thread.join();
                            let has_system = match &capture_result {
                                Ok(Ok(has_sys)) => *has_sys,
                                Ok(Err(e)) => {
                                    eprintln!("recording: capture error: {e}");
                                    false
                                }
                                Err(_) => {
                                    eprintln!("recording: capture thread panicked");
                                    false
                                }
                            };

                            job.has_system = has_system;
                            job.stage = JobStage::Mixing;
                            let _ = job.save();

                            // Run post-processing in the background so the worker can
                            // accept a new recording immediately.
                            let app_handle_clone = app_handle.clone();
                            tauri::async_runtime::spawn(async move {
                                process_recording(&app_handle_clone, &mut job).await;
                            });

                            if let Ok(mut slot) = note_id_slot.lock() {
                                *slot = None;
                            }
                            break;
                        }
                        Some(Msg::Shutdown) => {
                            // Graceful shutdown: save job for next startup, don't process.
                            stop_flag.store(true, Ordering::Relaxed);
                            active.store(false, Ordering::Relaxed);
                            tick_handle.abort();

                            // Wait for capture thread with 5-second timeout.
                            let thread_result = tokio::time::timeout(
                                std::time::Duration::from_secs(5),
                                tokio::task::spawn_blocking(move || capture_thread.join()),
                            )
                            .await;

                            let has_system = match thread_result {
                                Ok(Ok(Ok(Ok(has_sys)))) => has_sys,
                                _ => false,
                            };

                            job.has_system = has_system;
                            job.stage = JobStage::Mixing;
                            let _ = job.save();
                            eprintln!("recording: shutdown — job saved for resume on next startup");

                            if let Ok(mut slot) = note_id_slot.lock() {
                                *slot = None;
                            }
                            is_shutdown = true;
                            break;
                        }
                        Some(Msg::Start { .. }) => {
                            // Already recording, ignore.
                            eprintln!("recording: ignoring start while already recording");
                        }
                        None => {
                            stop_flag.store(true, Ordering::Relaxed);
                            active.store(false, Ordering::Relaxed);
                            tick_handle.abort();
                            is_shutdown = true;
                            break;
                        }
                    }
                }
                if is_shutdown {
                    break;
                }
            }
            Some(Msg::Stop) => {
                // Not recording, ignore.
            }
            Some(Msg::Shutdown) | None => break,
        }
    }
}

// ── Audio capture ───────────────────────────────────────────────────

/// Check and request screen capture / system audio permission on macOS.
/// Returns true if permission is granted.
#[cfg(target_os = "macos")]
fn check_screen_capture_permission() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    unsafe {
        let preflight = CGPreflightScreenCaptureAccess();
        eprintln!("recording: screen capture permission preflight = {preflight}");
        if preflight {
            return true;
        }
        let requested = CGRequestScreenCaptureAccess();
        eprintln!("recording: screen capture permission requested = {requested}");
        requested
    }
}

/// Capture audio from mic (and optionally system via CoreAudio tap).
/// Returns Ok(true) if system audio was captured, Ok(false) if mic-only.
fn capture_audio(
    mic_path: &Path,
    system_path: &Path,
    stop: Arc<AtomicBool>,
    preferred_device: Option<String>,
    mic_level: AudioLevel,
    system_level: AudioLevel,
) -> Result<bool, String> {
    use cpal::traits::{DeviceTrait, HostTrait};

    // Check/request screen capture permission (needed for system audio on macOS).
    #[cfg(target_os = "macos")]
    {
        let has_permission = check_screen_capture_permission();
        if !has_permission {
            eprintln!("recording: WARNING — screen capture permission NOT granted. System audio will be silent.");
            eprintln!("recording: Go to System Settings > Privacy & Security > Screen & System Audio Recording and add this app.");
        }
    }

    // Spawn system audio capture on a separate thread.
    // cpal 0.17+ on macOS: building an input stream on the default OUTPUT
    // device captures system audio via a CoreAudio process tap.
    let system_stop = stop.clone();
    let system_path_owned = system_path.to_path_buf();
    let system_handle = std::thread::spawn(move || -> Result<(), String> {
        let host = cpal::default_host();
        if let Some(output_device) = host.default_output_device() {
            eprintln!(
                "recording: capturing system audio from output device: {}",
                output_device.name().unwrap_or_default()
            );
            record_loopback(&output_device, &system_path_owned, system_stop, Some(system_level))?;
        }
        Ok(())
    });

    // Mic recording on this thread.
    let host = cpal::default_host();
    let mic_device = if let Some(ref pref) = preferred_device {
        find_device_by_name(&host, pref).unwrap_or_else(|| {
            eprintln!("recording: preferred device '{pref}' not found, falling back to heuristic");
            pick_best_input_device(&host).unwrap_or_else(|_| {
                host.default_input_device().expect("No input device available")
            })
        })
    } else {
        pick_best_input_device(&host)?
    };

    eprintln!(
        "recording: using mic device: {}",
        mic_device.name().unwrap_or_default()
    );

    record_device(&mic_device, mic_path, stop, Some(mic_level))?;

    // Wait for system audio thread and check result.
    let has_system = match system_handle.join() {
        Ok(Ok(())) => {
            eprintln!("recording: system audio captured successfully");
            true
        }
        Ok(Err(e)) => {
            eprintln!("recording: system audio capture failed: {e}");
            false
        }
        Err(_) => {
            eprintln!("recording: system audio thread panicked");
            false
        }
    };

    Ok(has_system)
}

/// List available input devices, filtering out virtual/loopback devices.
pub fn list_input_devices() -> Vec<InputDeviceInfo> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();

    let devices = match host.input_devices() {
        Ok(d) => d.collect::<Vec<_>>(),
        Err(_) => return vec![],
    };

    devices
        .into_iter()
        .filter_map(|device| {
            let name = device.name().ok()?;
            let lower = name.to_lowercase();
            if lower.contains("loopback") || lower.contains("virtual") {
                return None;
            }
            Some(InputDeviceInfo {
                is_default: name == default_name,
                name,
            })
        })
        .collect()
}

/// Find an input device by exact name match.
fn find_device_by_name(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    use cpal::traits::{DeviceTrait, HostTrait};

    host.input_devices().ok()?.find(|d| {
        d.name().ok().as_deref() == Some(name)
    })
}

/// Pick the best input device, preferring dedicated USB microphones over
/// monitor speakers and built-in mics.
fn pick_best_input_device(host: &cpal::Host) -> Result<cpal::Device, String> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let default = host
        .default_input_device()
        .ok_or_else(|| "No microphone found".to_string())?;

    let devices: Vec<cpal::Device> = match host.input_devices() {
        Ok(d) => d.collect(),
        Err(_) => return Ok(default),
    };

    // Score each device: higher = better.
    // Dedicated USB mics (SoloCast, Yeti, etc.) > webcam mics > monitor mics > built-in.
    let mut best: Option<(i32, cpal::Device)> = None;
    for device in devices {
        let name = device.name().unwrap_or_default().to_lowercase();

        // Skip non-mic devices (virtual, loopback, display output).
        if name.contains("loopback") || name.contains("virtual") {
            continue;
        }

        let score = if name.contains("solocast")
            || name.contains("yeti")
            || name.contains("snowball")
            || name.contains("at2020")
            || name.contains("rode")
            || name.contains("scarlett")
            || name.contains("focusrite")
            || name.contains("shure")
            || name.contains("elgato")
            || name.contains("samson")
        {
            100 // Known dedicated USB mics
        } else if name.contains("microphone") && !name.contains("display") && !name.contains("lg") {
            60 // Generic "microphone" label (webcam, built-in) but not a display
        } else if name.contains("obsbot") || name.contains("webcam") || name.contains("camera") {
            50 // Webcam mic — decent fallback
        } else if name.contains("macbook") || name.contains("built-in") {
            30 // Built-in mic
        } else if name.contains("display") || name.contains("monitor") || name.contains("lg ") || name.contains("dell ") || name.contains("samsung") {
            10 // Monitor mic — usually bad quality
        } else {
            40 // Unknown device — rank it middle
        };

        if best.as_ref().map_or(true, |(s, _)| score > *s) {
            best = Some((score, device));
        }
    }

    Ok(best.map(|(_, d)| d).unwrap_or(default))
}

fn record_device(
    device: &cpal::Device,
    output_path: &Path,
    stop: Arc<AtomicBool>,
    level: Option<AudioLevel>,
) -> Result<(), String> {
    record_device_inner(device, output_path, stop, false, level)
}

/// Record from an output device via CoreAudio loopback (system audio).
fn record_loopback(
    device: &cpal::Device,
    output_path: &Path,
    stop: Arc<AtomicBool>,
    level: Option<AudioLevel>,
) -> Result<(), String> {
    record_device_inner(device, output_path, stop, true, level)
}

fn record_device_inner(
    device: &cpal::Device,
    output_path: &Path,
    stop: Arc<AtomicBool>,
    loopback: bool,
    level: Option<AudioLevel>,
) -> Result<(), String> {
    use cpal::traits::{DeviceTrait, StreamTrait};
    use cpal::{SampleFormat, StreamConfig};
    use std::sync::atomic::AtomicU64;
    use std::sync::Mutex;

    // For loopback (system audio), use the output config since the device
    // is an output device. cpal 0.17 will automatically create a CoreAudio
    // process tap when build_input_stream is called on an output device.
    let config = if loopback {
        device
            .default_output_config()
            .map_err(|e| format!("No output config for loopback: {e}"))?
    } else {
        device
            .default_input_config()
            .map_err(|e| format!("No input config: {e}"))?
    };

    let sample_rate = config.sample_rate();
    let channels = config.channels();
    let sample_format = config.sample_format();
    let label = if loopback { "system" } else { "mic" };

    eprintln!(
        "recording: [{label}] config: {sample_rate}Hz, {channels}ch, {sample_format:?}"
    );

    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let writer = hound::WavWriter::create(output_path, spec)
        .map_err(|e| format!("Failed to create WAV: {e}"))?;
    let writer = Arc::new(Mutex::new(Some(writer)));
    let writer_clone = writer.clone();

    let total_samples = Arc::new(AtomicU64::new(0));
    let nonzero_samples = Arc::new(AtomicU64::new(0));
    let total_clone = total_samples.clone();
    let nonzero_clone = nonzero_samples.clone();

    let label_owned = label.to_string();
    let err_fn = move |err: cpal::StreamError| {
        eprintln!("recording: [{label_owned}] stream error: {err}");
    };

    let stream_config: StreamConfig = config.clone().into();

    let stream = match sample_format {
        SampleFormat::I16 => {
            let writer = writer_clone;
            let total = total_clone;
            let nonzero = nonzero_clone;
            let level = level.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        total.fetch_add(data.len() as u64, Ordering::Relaxed);
                        let nz = data.iter().filter(|&&s| s != 0).count() as u64;
                        nonzero.fetch_add(nz, Ordering::Relaxed);
                        if let Some(ref lvl) = level {
                            let peak = data.iter().map(|&s| (s as f32 / 32768.0).abs()).fold(0.0_f32, f32::max);
                            level_store(lvl, peak);
                        }
                        if let Ok(mut guard) = writer.lock() {
                            if let Some(ref mut w) = *guard {
                                for &sample in data {
                                    let _ = w.write_sample(sample);
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build i16 stream: {e}"))?
        }
        SampleFormat::F32 => {
            let writer = writer_clone;
            let total = total_clone;
            let nonzero = nonzero_clone;
            let level = level.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        total.fetch_add(data.len() as u64, Ordering::Relaxed);
                        let nz = data.iter().filter(|&&s| s.abs() > 1e-10).count() as u64;
                        nonzero.fetch_add(nz, Ordering::Relaxed);
                        if let Some(ref lvl) = level {
                            let peak = data.iter().map(|s| s.abs()).fold(0.0_f32, f32::max);
                            level_store(lvl, peak);
                        }
                        if let Ok(mut guard) = writer.lock() {
                            if let Some(ref mut w) = *guard {
                                for &sample in data {
                                    let s = (sample * 32767.0).clamp(-32768.0, 32767.0) as i16;
                                    let _ = w.write_sample(s);
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build f32 stream: {e}"))?
        }
        _ => {
            return Err(format!("Unsupported sample format: {sample_format:?}"));
        }
    };

    stream
        .play()
        .map_err(|e| format!("Failed to play stream: {e}"))?;

    // Block until stop flag is set.
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    drop(stream);

    let total = total_samples.load(Ordering::Relaxed);
    let nonzero = nonzero_samples.load(Ordering::Relaxed);
    eprintln!(
        "recording: [{label}] done — {total} samples, {nonzero} non-zero ({:.1}%)",
        if total > 0 { nonzero as f64 / total as f64 * 100.0 } else { 0.0 }
    );

    // Finalize WAV.
    if let Ok(mut guard) = writer.lock() {
        if let Some(w) = guard.take() {
            let _ = w.finalize();
        }
    }

    Ok(())
}

// ── Processing pipeline ─────────────────────────────────────────────

async fn process_recording(
    app_handle: &tauri::AppHandle,
    job: &mut RecordingJob,
) {
    let mic_path = PathBuf::from(&job.mic_path);
    let system_path = PathBuf::from(&job.system_path);
    let final_wav = PathBuf::from(&job.final_wav_path);

    // Step 1: Mix/convert audio (skip if already past this stage)
    if job.stage <= JobStage::Mixing {
        if final_wav.exists() {
            // Already mixed — skip
            eprintln!("recording: final wav exists, skipping mix");
        } else {
            emit_progress(app_handle, &job.note_id, "mixing", "Mixing audio...");

            let mix_ok = if job.has_system && system_path.exists() && mic_path.exists() {
                mix_audio(&mic_path, &system_path, &final_wav).await
            } else if mic_path.exists() {
                convert_mono(&mic_path, &final_wav).await
            } else {
                Err("No audio files found".to_string())
            };

            if let Err(e) = &mix_ok {
                eprintln!("recording: mix failed: {e}");
                let _ = app_handle.emit("recording-error", format!("Audio mixing failed: {e}"));
                create_error_note(app_handle, &job.notes_dir, &job.note_id, "Audio processing failed").await;
                job.delete();
                return;
            }
        }

        // Clean up intermediate files.
        let _ = std::fs::remove_file(&mic_path);
        if job.has_system {
            let _ = std::fs::remove_file(&system_path);
        }

        job.stage = JobStage::Transcribing;
        let _ = job.save();
    }

    // Step 2: Transcribe (skip if already past this stage)
    if job.stage <= JobStage::Transcribing {
        if job.transcript.is_some() {
            eprintln!("recording: transcript already available, skipping");
        } else {
            emit_progress(app_handle, &job.note_id, "transcribing", "Transcribing audio...");
            let transcript = transcribe(&final_wav).await;

            match transcript {
                Ok(t) => {
                    job.transcript = Some(t);
                }
                Err(e) => {
                    eprintln!("recording: transcription failed: {e}");
                    let _ = app_handle.emit(
                        "recording-error",
                        format!("Transcription failed: {e}"),
                    );
                    create_error_note(
                        app_handle,
                        &job.notes_dir,
                        &job.note_id,
                        &format!(
                            "Transcription failed. Audio saved at `meetings/.audio/{}.wav`.",
                            job.note_id
                        ),
                    )
                    .await;
                    job.delete();
                    return;
                }
            }
        }

        job.stage = JobStage::Summarizing;
        let _ = job.save();
    }

    let transcript_text = job.transcript.clone().unwrap_or_default();

    // Step 3: Summarize (skip if already past this stage)
    if job.stage <= JobStage::Summarizing {
        if job.summary.is_some() {
            eprintln!("recording: summary already available, skipping");
        } else {
            emit_progress(app_handle, &job.note_id, "summarizing", "Summarizing transcript...");
            let summary = summarize(&transcript_text).await.unwrap_or_else(|e| {
                eprintln!("recording: summarization failed: {e}");
                "*Summary unavailable — ollama not reachable.*".to_string()
            });
            job.summary = Some(summary);
        }

        job.stage = JobStage::Saving;
        let _ = job.save();
    }

    let summary = job.summary.clone().unwrap_or_default();

    // Step 4: Create meeting note or emit data for existing note
    let note_exists = app_handle
        .try_state::<AppState>()
        .and_then(|state| {
            state.index.lock().ok().map(|idx| idx.notes.contains_key(&job.note_id))
        })
        .unwrap_or(false);

    if note_exists {
        // Note already exists in the index — let the frontend append transcript/summary
        emit_progress(app_handle, &job.note_id, "saving", "Saving meeting data...");
        job.delete();
        let _ = app_handle.emit("recording-complete", RecordingCompletePayload {
            note_id: job.note_id.clone(),
            summary: Some(summary),
            transcript: Some(transcript_text),
        });
    } else {
        // No existing note — create a new meeting note
        emit_progress(app_handle, &job.note_id, "saving", "Creating meeting note...");
        create_meeting_note(app_handle, &job.notes_dir, &job.note_id, &summary, &transcript_text).await;
        job.delete();
        let _ = app_handle.emit("recording-complete", RecordingCompletePayload {
            note_id: job.note_id.clone(),
            summary: None,
            transcript: None,
        });
    }
}

fn emit_progress(app_handle: &tauri::AppHandle, note_id: &str, stage: &str, detail: &str) {
    let _ = app_handle.emit(
        "recording-progress",
        ProgressPayload {
            note_id: note_id.to_string(),
            stage: stage.to_string(),
            detail: detail.to_string(),
        },
    );
}

async fn mix_audio(mic: &Path, system: &Path, output: &Path) -> Result<(), String> {
    let out = cmd("ffmpeg")
        .args([
            "-y",
            "-i",
            &mic.to_string_lossy(),
            "-i",
            &system.to_string_lossy(),
            "-filter_complex",
            "[0:a][1:a]amix=inputs=2:duration=longest",
            "-ar",
            "16000",
            "-ac",
            "1",
            &output.to_string_lossy(),
        ])
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed to start: {e}"))?;

    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

async fn convert_mono(input: &Path, output: &Path) -> Result<(), String> {
    let out = cmd("ffmpeg")
        .args([
            "-y",
            "-i",
            &input.to_string_lossy(),
            "-ar",
            "16000",
            "-ac",
            "1",
            &output.to_string_lossy(),
        ])
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed to start: {e}"))?;

    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

// ── Transcription ───────────────────────────────────────────────────

async fn find_whisper_model() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/default".to_string());
    let search_dirs = [
        format!("{home}/.local/share/whisper-cpp/models"),
        format!("{home}/whisper.cpp/models"),
        "/opt/homebrew/share/whisper-cpp/models".to_string(),
        format!("{home}/Library/Application Support/com.pais.handy/models"),
    ];

    let preferred = [
        "ggml-large-v3-turbo.bin",
        "ggml-large-v3.bin",
        "ggml-medium.bin",
        "whisper-medium-q4_1.bin",
        "ggml-small.bin",
        "ggml-base.bin",
        "ggml-tiny.bin",
    ];

    for dir in &search_dirs {
        let dir_path = Path::new(dir);
        if !dir_path.is_dir() {
            continue;
        }
        // Try preferred models in order.
        for model_name in &preferred {
            let candidate = dir_path.join(model_name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
        // Fall back to any .bin file.
        if let Ok(entries) = std::fs::read_dir(dir_path) {
            for entry in entries.flatten() {
                if entry
                    .path()
                    .extension()
                    .map(|e| e == "bin")
                    .unwrap_or(false)
                {
                    return Some(entry.path());
                }
            }
        }
    }

    None
}

async fn transcribe(wav_path: &Path) -> Result<String, String> {
    let model = find_whisper_model()
        .await
        .ok_or_else(|| "No whisper model found. Download a ggml model.".to_string())?;

    eprintln!(
        "recording: transcribing with model {}",
        model.display()
    );

    let wav_str = wav_path.to_string_lossy();
    let model_str = model.to_string_lossy();

    // Output JSON to a temp file alongside the wav.
    let output_base = wav_path.with_extension("");
    let output_base_str = output_base.to_string_lossy();

    let out = cmd("whisper-cli")
        .args([
            "-m",
            &model_str,
            "-f",
            &wav_str,
            "-oj",
            "-of",
            &output_base_str,
        ])
        .output()
        .await
        .map_err(|e| format!("whisper-cli failed to start: {e}"))?;

    if !out.status.success() {
        return Err(format!(
            "whisper-cli failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    // Parse JSON output.
    let json_path = PathBuf::from(format!("{}.json", output_base_str));
    if json_path.exists() {
        let json_str =
            std::fs::read_to_string(&json_path).map_err(|e| format!("Read JSON: {e}"))?;
        let _ = std::fs::remove_file(&json_path);
        return parse_whisper_json(&json_str);
    }

    // Fall back to stdout text.
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        Err("whisper produced no output".to_string())
    } else {
        Ok(text)
    }
}

fn parse_whisper_json(json: &str) -> Result<String, String> {
    let val: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Parse whisper JSON: {e}"))?;

    let mut lines = Vec::new();

    if let Some(transcription) = val.get("transcription").and_then(|v| v.as_array()) {
        for segment in transcription {
            let start = segment
                .get("timestamps")
                .and_then(|t| t.get("from"))
                .and_then(|v| v.as_str())
                .unwrap_or("00:00:00");
            let text = segment
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if !text.is_empty() {
                // Trim to MM:SS format.
                let ts = format_timestamp(start);
                lines.push(format!("[{ts}] {text}"));
            }
        }
    }

    if lines.is_empty() {
        // Try top-level "text" field.
        if let Some(text) = val.get("text").and_then(|v| v.as_str()) {
            return Ok(text.trim().to_string());
        }
        return Err("No transcription data found".to_string());
    }

    Ok(lines.join("\n"))
}

/// Convert timestamp string like "00:01:30.500" to "01:30".
fn format_timestamp(ts: &str) -> String {
    let parts: Vec<&str> = ts.split(':').collect();
    match parts.len() {
        3 => {
            let hours: u32 = parts[0].parse().unwrap_or(0);
            let minutes: u32 = parts[1].parse().unwrap_or(0);
            let seconds: f64 = parts[2].parse().unwrap_or(0.0);
            let total_minutes = hours * 60 + minutes;
            format!("{:02}:{:02}", total_minutes, seconds as u32)
        }
        _ => ts.to_string(),
    }
}

// ── Summarization ───────────────────────────────────────────────────

async fn find_ollama_model() -> Option<String> {
    let candidates = ["llama3.2", "mistral", "qwen2.5:7b", "qwen2.5:1.5b"];
    for model in &candidates {
        let out = cmd("ollama")
            .args(["show", model])
            .output()
            .await;
        if let Ok(o) = out {
            if o.status.success() {
                return Some(model.to_string());
            }
        }
    }
    None
}

async fn summarize(transcript: &str) -> Result<String, String> {
    let model = find_ollama_model()
        .await
        .ok_or_else(|| "No ollama model available".to_string())?;

    eprintln!("recording: summarizing with model {model}");

    // Truncate transcript to ~4000 chars for the prompt.
    let truncated: String = transcript.chars().take(4000).collect();
    let prompt = format!(
        "Summarize this meeting transcript into key points, decisions, and action items. Use markdown formatting.\n\n{}",
        truncated
    );

    let out = cmd("ollama")
        .args(["run", &model, &prompt])
        .output()
        .await
        .map_err(|e| format!("ollama failed to start: {e}"))?;

    if !out.status.success() {
        return Err(format!(
            "ollama failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let summary = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if summary.is_empty() {
        Err("ollama returned empty output".to_string())
    } else {
        Ok(summary)
    }
}

// ── Note creation ───────────────────────────────────────────────────

async fn create_meeting_note(
    app_handle: &tauri::AppHandle,
    notes_dir: &str,
    note_id: &str,
    summary: &str,
    transcript: &str,
) {
    let now = chrono::Local::now();
    let timestamp = now.format("%Y%m%d%H%M%S").to_string();
    let date_display = now.format("%Y-%m-%d %H:%M").to_string();
    let created = now.to_rfc3339();

    let frontmatter = format!(
        "---\nid: {note_id}\ncreated: {created}\nmodified: {created}\ntags:\n  - meeting\nstarred: false\ntype: meeting\naudio_path: meetings/.audio/{note_id}.wav\n---\n"
    );

    let body = format!(
        "# Meeting {date_display}\n\n## Summary\n\n{summary}\n\n## Transcript\n\n{transcript}\n"
    );

    let full_content = format!("{frontmatter}{body}");

    // Ensure meetings/ directory exists.
    let meetings_dir = PathBuf::from(notes_dir).join("meetings");
    let _ = std::fs::create_dir_all(&meetings_dir);

    let filename = format!("{timestamp}-meeting.md");
    let file_path = meetings_dir.join(&filename);
    let rel_path = format!("meetings/{filename}");

    if let Err(e) = std::fs::write(&file_path, &full_content) {
        eprintln!("recording: failed to write meeting note: {e}");
        let _ = app_handle.emit(
            "recording-error",
            format!("Failed to write meeting note: {e}"),
        );
        return;
    }

    // Insert into the index.
    if let Some(state) = app_handle.try_state::<AppState>() {
        let meta = crate::notes::NoteMetadata {
            id: note_id.to_string(),
            path: rel_path.clone(),
            title: format!("Meeting {date_display}"),
            created: created.clone(),
            modified: created,
            tags: vec!["meeting".to_string()],
            starred: false,
        };

        if let Ok(mut index) = state.index.lock() {
            index.notes.insert(note_id.to_string(), meta);
            // Save index to disk.
            let dir = state.notes_dir.lock().ok();
            if let Some(dir) = dir {
                let _ = crate::notes::save_index_pub(&dir, &index);
            }
        }

        // Notify git.
        if let Ok(git) = state.git.lock() {
            git.notify_change(&rel_path, &format!("Meeting {date_display}"), true);
        }
    }

    let _ = app_handle.emit("notes-changed", ());
}

// ── Resume pending jobs ─────────────────────────────────────────────

pub async fn resume_pending_jobs(app_handle: &tauri::AppHandle, notes_dir: &str) {
    let jobs = RecordingJob::scan(notes_dir);
    if jobs.is_empty() {
        return;
    }
    eprintln!("recording: found {} pending job(s) to resume", jobs.len());

    for mut job in jobs {
        // If still in Recording stage, check if we have any audio to work with.
        if job.stage == JobStage::Recording {
            let mic_exists = PathBuf::from(&job.mic_path).exists();
            let final_exists = PathBuf::from(&job.final_wav_path).exists();
            if !mic_exists && !final_exists {
                eprintln!("recording: no audio found for job {}, deleting", job.note_id);
                job.delete();
                continue;
            }
            job.stage = JobStage::Mixing;
            let _ = job.save();
        }

        emit_progress(app_handle, &job.note_id, "resuming", "Resuming processing...");
        process_recording(app_handle, &mut job).await;
    }
}

async fn create_error_note(
    app_handle: &tauri::AppHandle,
    notes_dir: &str,
    note_id: &str,
    error_message: &str,
) {
    let now = chrono::Local::now();
    let timestamp = now.format("%Y%m%d%H%M%S").to_string();
    let date_display = now.format("%Y-%m-%d %H:%M").to_string();
    let created = now.to_rfc3339();

    let frontmatter = format!(
        "---\nid: {note_id}\ncreated: {created}\nmodified: {created}\ntags:\n  - meeting\nstarred: false\ntype: meeting\n---\n"
    );

    let body = format!(
        "# Meeting {date_display}\n\n## Summary\n\n{error_message}\n\n## Transcript\n\n*Processing failed.*\n"
    );

    let full_content = format!("{frontmatter}{body}");

    let meetings_dir = PathBuf::from(notes_dir).join("meetings");
    let _ = std::fs::create_dir_all(&meetings_dir);

    let filename = format!("{timestamp}-meeting.md");
    let file_path = meetings_dir.join(&filename);
    let rel_path = format!("meetings/{filename}");

    if let Err(e) = std::fs::write(&file_path, &full_content) {
        eprintln!("recording: failed to write error note: {e}");
        return;
    }

    if let Some(state) = app_handle.try_state::<AppState>() {
        let meta = crate::notes::NoteMetadata {
            id: note_id.to_string(),
            path: rel_path.clone(),
            title: format!("Meeting {date_display}"),
            created: created.clone(),
            modified: created,
            tags: vec!["meeting".to_string()],
            starred: false,
        };

        if let Ok(mut index) = state.index.lock() {
            index.notes.insert(note_id.to_string(), meta);
            let dir = state.notes_dir.lock().ok();
            if let Some(dir) = dir {
                let _ = crate::notes::save_index_pub(&dir, &index);
            }
        }

        if let Ok(git) = state.git.lock() {
            git.notify_change(&rel_path, &format!("Meeting {date_display}"), true);
        }
    }

    let _ = app_handle.emit("notes-changed", ());
    let _ = app_handle.emit("recording-complete", RecordingCompletePayload {
        note_id: note_id.to_string(),
        summary: None,
        transcript: None,
    });
}
