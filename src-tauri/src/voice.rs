//! Voice input: speech to text with OpenAI's Whisper, run locally.
//!
//! The webview records the microphone and hands over 16 kHz mono PCM; this module
//! turns it into text with Whisper running on the CPU through `candle` (pure Rust,
//! so no C++ toolchain is needed to build Mango). Nothing leaves the machine except
//! the one-time model download from Hugging Face, which is pinned to a commit and
//! checked against SHA-256 hashes before it is used.
//!
//! The Whisper tokenizer is only ever *decoded* here, so instead of pulling in a
//! tokenizer crate we read the vocabulary from `tokenizer.json` and undo GPT-2's
//! byte-level encoding ourselves.

use std::collections::HashMap;
use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use candle_core::{Device, IndexOp, Tensor, D};
use candle_nn::VarBuilder;
use candle_transformers::models::whisper::{self as wh, audio, model::Whisper, Config};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

// ---------------------------------------------------------------------------
// The models on offer
// ---------------------------------------------------------------------------

struct ModelFile {
    name: &'static str,
    size: u64,
    sha256: &'static str,
}

struct ModelSpec {
    id: &'static str,
    name: &'static str,
    /// Hugging Face repository and the commit every file is fetched from.
    repo: &'static str,
    revision: &'static str,
    files: [ModelFile; 3],
}

const TOKENIZER_SHA: &str = "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566";

/// Multilingual Whisper checkpoints (they detect the spoken language themselves).
const MODELS: [ModelSpec; 3] = [
    ModelSpec {
        id: "tiny",
        name: "Tiny",
        repo: "openai/whisper-tiny",
        revision: "169d4a4341b33bc18d8881c4b69c2e104e1cc0af",
        files: [
            ModelFile { name: "config.json", size: 1983, sha256: "ffdccec4f3211f4c63310f2b7098f309fe70f3952cedc5e4d11e43f5b2379b98" },
            ModelFile { name: "tokenizer.json", size: 2480466, sha256: TOKENIZER_SHA },
            ModelFile { name: "model.safetensors", size: 151061672, sha256: "7ebd0e69e78190ffe1438491fa05cc1f5c1aa3a4c4db3bc1723adbb551ea2395" },
        ],
    },
    ModelSpec {
        id: "base",
        name: "Base",
        repo: "openai/whisper-base",
        revision: "e37978b90ca9030d5170a5c07aadb050351a65bb",
        files: [
            ModelFile { name: "config.json", size: 1983, sha256: "a153c53883a6799b6f056b4a8d1a515c9926d03994682ba88a7616618d7da0c1" },
            ModelFile { name: "tokenizer.json", size: 2480466, sha256: TOKENIZER_SHA },
            ModelFile { name: "model.safetensors", size: 290403936, sha256: "07cadb9f25677c8d50df603e66a98fbd842cce45047139baeb16e6219a1e807b" },
        ],
    },
    ModelSpec {
        id: "small",
        name: "Small",
        repo: "openai/whisper-small",
        revision: "973afd24965f72e36ca33b3055d56a652f456b4d",
        files: [
            ModelFile { name: "config.json", size: 1967, sha256: "e6a2b489da1b5aed65a8eb8d1e7466fa867ad5643a8bc138ba708bd56b2875c4" },
            ModelFile { name: "tokenizer.json", size: 2480466, sha256: TOKENIZER_SHA },
            ModelFile { name: "model.safetensors", size: 966995080, sha256: "1d7734884874f1a1513ed9aa760a4f8e97aaa02fd6d93a3a85d27b2ae9ca596b" },
        ],
    },
];

fn spec(id: &str) -> Result<&'static ModelSpec, String> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("There is no speech model called \"{id}\"."))
}

impl ModelSpec {
    fn total_size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("models"))
        .map_err(|e| format!("Could not locate the app data folder: {e}"))
}

fn model_dir(app: &AppHandle, m: &ModelSpec) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(format!("whisper-{}", m.id)))
}

/// Downloaded and complete. Hashes were checked when the files were written;
/// here the sizes are enough to notice a file that was cut short or replaced.
fn is_downloaded(dir: &Path, m: &ModelSpec) -> bool {
    m.files
        .iter()
        .all(|f| fs::metadata(dir.join(f.name)).map(|md| md.len() == f.size).unwrap_or(false))
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// The loaded model (kept between dictations, loading takes a second or two)
/// and the downloads in flight with their cancel flags.
#[derive(Default)]
pub struct VoiceState {
    loaded: Arc<Mutex<Option<Loaded>>>,
    downloads: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

struct Loaded {
    id: &'static str,
    engine: Engine,
}

// ---------------------------------------------------------------------------
// IPC types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModel {
    pub id: String,
    pub name: String,
    /// Bytes to download (all files).
    pub size_bytes: u64,
    pub downloaded: bool,
    pub downloading: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProgress {
    pub model: String,
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub text: String,
    /// The language that was used, e.g. "en"; detected unless one was asked for.
    pub language: Option<String>,
    /// Seconds of audio that were transcribed.
    pub duration: f32,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn voice_models(app: AppHandle, state: State<'_, VoiceState>) -> Result<Vec<VoiceModel>, String> {
    let active: Vec<String> = state
        .downloads
        .lock()
        .map_err(|_| "Voice state is unavailable.")?
        .keys()
        .cloned()
        .collect();
    let root = models_dir(&app)?;
    Ok(MODELS
        .iter()
        .map(|m| VoiceModel {
            id: m.id.into(),
            name: m.name.into(),
            size_bytes: m.total_size(),
            downloaded: is_downloaded(&root.join(format!("whisper-{}", m.id)), m),
            downloading: active.iter().any(|a| a == m.id),
        })
        .collect())
}

/// Downloads a model from Hugging Face, verifying every file's SHA-256.
/// Emits `voice://progress`. Resolves when the model is ready to use.
#[tauri::command]
pub async fn voice_download(app: AppHandle, state: State<'_, VoiceState>, model: String) -> Result<(), String> {
    let m = spec(&model)?;
    let dir = model_dir(&app, m)?;
    if is_downloaded(&dir, m) {
        return Ok(());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut downloads = state.downloads.lock().map_err(|_| "Voice state is unavailable.")?;
        if downloads.contains_key(m.id) {
            return Err(format!("The {} model is already downloading.", m.name));
        }
        downloads.insert(m.id.into(), cancel.clone());
    }
    let result = download(&app, m, &dir, &cancel).await;
    if let Ok(mut downloads) = state.downloads.lock() {
        downloads.remove(m.id);
    }
    result
}

#[tauri::command]
pub async fn voice_download_cancel(state: State<'_, VoiceState>, model: String) -> Result<(), String> {
    if let Some(flag) = state.downloads.lock().map_err(|_| "Voice state is unavailable.")?.get(&model) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn voice_delete(app: AppHandle, state: State<'_, VoiceState>, model: String) -> Result<(), String> {
    let m = spec(&model)?;
    if state.downloads.lock().map_err(|_| "Voice state is unavailable.")?.contains_key(m.id) {
        return Err(format!("The {} model is downloading. Cancel the download first.", m.name));
    }
    if let Ok(mut loaded) = state.loaded.lock() {
        if loaded.as_ref().is_some_and(|l| l.id == m.id) {
            *loaded = None;
        }
    }
    let dir = model_dir(&app, m)?;
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not delete {}: {e}", dir.display())),
    }
}

/// Transcribes `audio`: base64 of little-endian 16-bit PCM, mono, 16 kHz.
/// `language` is a Whisper code such as "en" or "de"; null detects it.
#[tauri::command]
pub async fn voice_transcribe(
    app: AppHandle,
    state: State<'_, VoiceState>,
    model: String,
    audio: String,
    language: Option<String>,
) -> Result<Transcript, String> {
    let m = spec(&model)?;
    let dir = model_dir(&app, m)?;
    if !is_downloaded(&dir, m) {
        return Err(format!("The {} speech model is not downloaded yet. Download it in Settings > Voice.", m.name));
    }
    let samples = decode_pcm(&audio)?;
    let loaded = state.loaded.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut slot = loaded.lock().map_err(|_| "The speech model is unavailable.")?;
        if slot.as_ref().is_none_or(|l| l.id != m.id) {
            *slot = None; // free the old model before loading the next
            *slot = Some(Loaded { id: m.id, engine: Engine::load(&dir).map_err(|e| format!("Could not load the speech model: {e}"))? });
        }
        let engine = &mut slot.as_mut().expect("loaded above").engine;
        let duration = samples.len() as f32 / wh::SAMPLE_RATE as f32;
        let (text, language) = engine
            .transcribe(&samples, language.as_deref())
            .map_err(|e| format!("Transcription failed: {e}"))?;
        Ok(Transcript { text, language, duration })
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async fn download(app: &AppHandle, m: &ModelSpec, dir: &Path, cancel: &AtomicBool) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("Mango/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Could not start the download: {e}"))?;

    let total = m.total_size();
    let mut done: u64 = 0;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut emit = |done: u64, force: bool| {
        if force || last_emit.elapsed() >= Duration::from_millis(150) {
            last_emit = Instant::now();
            let _ = app.emit("voice://progress", VoiceProgress { model: m.id.into(), downloaded: done, total });
        }
    };
    emit(0, true);

    for f in &m.files {
        let target = dir.join(f.name);
        if fs::metadata(&target).map(|md| md.len() == f.size).unwrap_or(false) {
            done += f.size;
            emit(done, true);
            continue;
        }
        let part = dir.join(format!("{}.part", f.name));
        let url = format!("https://huggingface.co/{}/resolve/{}/{}", m.repo, m.revision, f.name);
        let res = fetch_file(&client, &url, &part, f, cancel, |n| emit(done + n, false)).await;
        if let Err(e) = res {
            let _ = fs::remove_file(&part);
            return Err(e);
        }
        fs::rename(&part, &target).map_err(|e| format!("Could not save {}: {e}", target.display()))?;
        done += f.size;
        emit(done, true);
    }
    Ok(())
}

async fn fetch_file(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    f: &ModelFile,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    let unreachable = |e: reqwest::Error| {
        if e.is_timeout() || e.is_connect() {
            "Could not reach Hugging Face to download the speech model. Check your connection and try again.".to_string()
        } else {
            format!("The speech model download failed: {e}")
        }
    };
    let mut res = client.get(url).send().await.map_err(unreachable)?;
    if !res.status().is_success() {
        return Err(format!("Hugging Face answered {} for {}.", res.status(), f.name));
    }
    let mut out = fs::File::create(part).map_err(|e| format!("Could not write {}: {e}", part.display()))?;
    let mut hasher = Sha256::new();
    let mut got: u64 = 0;
    while let Some(chunk) = res.chunk().await.map_err(unreachable)? {
        if cancel.load(Ordering::Relaxed) {
            return Err("Download cancelled.".into());
        }
        got += chunk.len() as u64;
        if got > f.size {
            return Err(format!("{} is larger than expected; the download was stopped.", f.name));
        }
        hasher.update(&chunk);
        out.write_all(&chunk).map_err(|e| format!("Could not write {}: {e}", part.display()))?;
        progress(got);
    }
    out.flush().map_err(|e| format!("Could not write {}: {e}", part.display()))?;
    let hash = hex(&hasher.finalize());
    if got != f.size || hash != f.sha256 {
        return Err(format!("{} did not match its checksum and was discarded. Try the download again.", f.name));
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Audio in
// ---------------------------------------------------------------------------

/// Longest recording accepted, in seconds.
const MAX_SECONDS: usize = 10 * 60;

fn decode_pcm(b64: &str) -> Result<Vec<f32>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| "The recording could not be read.")?;
    if bytes.len() % 2 != 0 {
        return Err("The recording could not be read.".into());
    }
    if bytes.len() / 2 > MAX_SECONDS * wh::SAMPLE_RATE {
        return Err(format!("Recordings can be at most {} minutes long.", MAX_SECONDS / 60));
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect())
}

// ---------------------------------------------------------------------------
// Whisper
// ---------------------------------------------------------------------------

type E = Box<dyn std::error::Error + Send + Sync>;

struct Engine {
    model: Whisper,
    vocab: Vocab,
    filters: Vec<f32>,
    device: Device,
    /// Added to the logits at every step: -inf for tokens never to produce.
    suppress: Tensor,
    sot: u32,
    eot: u32,
    transcribe: u32,
    no_timestamps: u32,
    no_speech: Option<u32>,
    /// (code, token id) for every language the model knows.
    languages: Vec<(String, u32)>,
}

impl Engine {
    fn load(dir: &Path) -> Result<Self, E> {
        let device = Device::Cpu;
        let config: Config = serde_json::from_str(&fs::read_to_string(dir.join("config.json"))?)?;
        let vocab = Vocab::load(&dir.join("tokenizer.json"))?;
        // SAFETY: the file is ours (verified on download) and is not modified while mapped.
        let vb = unsafe { VarBuilder::from_mmaped_safetensors(&[dir.join("model.safetensors")], wh::DTYPE, &device)? };
        let model = Whisper::load(&vb, config.clone())?;

        let id = |t: &str| vocab.special.get(t).copied().ok_or_else(|| format!("tokenizer.json has no {t}"));
        let sot = id(wh::SOT_TOKEN)?;
        let eot = id(wh::EOT_TOKEN)?;
        let transcribe = id(wh::TRANSCRIBE_TOKEN)?;
        let no_timestamps = id(wh::NO_TIMESTAMPS_TOKEN)?;
        let no_speech = wh::NO_SPEECH_TOKENS.iter().find_map(|t| vocab.special.get(*t).copied());
        let mut languages: Vec<(String, u32)> = vocab
            .special
            .iter()
            .filter_map(|(t, &i)| {
                let code = t.strip_prefix("<|")?.strip_suffix("|>")?;
                (code.len() <= 3 && !code.is_empty() && code.bytes().all(|b| b.is_ascii_lowercase())).then(|| (code.to_string(), i))
            })
            .collect();
        languages.sort_by_key(|(_, i)| *i);

        // Never produce timestamps (we decode without them) or the config's suppressed tokens.
        let first_timestamp = no_timestamps + 1;
        let suppress: Vec<f32> = (0..config.vocab_size as u32)
            .map(|i| {
                if config.suppress_tokens.contains(&i) || i == no_timestamps || i >= first_timestamp {
                    f32::NEG_INFINITY
                } else {
                    0.0
                }
            })
            .collect();
        let suppress = Tensor::new(suppress.as_slice(), &device)?;
        let filters = mel_filters(config.num_mel_bins, wh::N_FFT, wh::SAMPLE_RATE);

        Ok(Self { model, vocab, filters, device, suppress, sot, eot, transcribe, no_timestamps, no_speech, languages })
    }

    fn transcribe(&mut self, samples: &[f32], language: Option<&str>) -> Result<(String, Option<String>), E> {
        let samples = trim_silence(samples);
        // Under a quarter second there is nothing to hear; Whisper would invent something.
        if samples.len() < wh::SAMPLE_RATE / 4 {
            return Ok((String::new(), language.map(str::to_string)));
        }
        let n_mels = self.model.config.num_mel_bins;
        let mel = audio::pcm_to_mel(&self.model.config, samples, &self.filters);
        let frames = mel.len() / n_mels;
        let mel = Tensor::from_vec(mel, (1, n_mels, frames), &self.device)?;
        let content_frames = samples.len() / wh::HOP_LENGTH;

        let mut language_token: Option<(String, u32)> = match language {
            Some(code) => Some(
                self.languages
                    .iter()
                    .find(|(c, _)| c == code)
                    .cloned()
                    .ok_or_else(|| format!("Whisper does not know the language \"{code}\"."))?,
            ),
            None => None,
        };

        let mut text = String::new();
        let mut seek = 0;
        while seek < content_frames {
            let len = wh::N_FRAMES.min(frames - seek);
            let segment = mel.narrow(2, seek, len)?;
            let features = self.model.encoder.forward(&segment, true)?;
            if language_token.is_none() {
                language_token = Some(self.detect_language(&features)?);
            }
            let lang = language_token.as_ref().map(|(_, t)| *t);
            if let Some(piece) = self.decode(&features, lang)? {
                let piece = piece.trim();
                if !piece.is_empty() {
                    if !text.is_empty() {
                        text.push(' ');
                    }
                    text.push_str(piece);
                }
            }
            seek += wh::N_FRAMES.min(content_frames - seek);
        }
        Ok((text, language_token.map(|(c, _)| c)))
    }

    fn detect_language(&mut self, features: &Tensor) -> Result<(String, u32), E> {
        let tokens = Tensor::new(&[[self.sot]], &self.device)?;
        let ys = self.model.decoder.forward(&tokens, features, true)?;
        let logits = self.model.decoder.final_linear(&ys.i(..1)?)?.i(0)?.i(0)?;
        let ids: Vec<u32> = self.languages.iter().map(|(_, i)| *i).collect();
        let ids = Tensor::new(ids.as_slice(), &self.device)?;
        let best = logits.index_select(&ids, 0)?.argmax(D::Minus1)?.to_scalar::<u32>()? as usize;
        Ok(self.languages[best].clone())
    }

    /// Greedy decoding of one 30-second window. `None` when it holds no speech.
    fn decode(&mut self, features: &Tensor, language: Option<u32>) -> Result<Option<String>, E> {
        let mut tokens = vec![self.sot];
        tokens.extend(language);
        tokens.extend([self.transcribe, self.no_timestamps]);
        let prompt_len = tokens.len();
        let max_len = self.model.config.max_target_positions;
        let mut sum_logprob = 0f64;
        let mut no_speech_prob = 0f64;

        for i in 0..max_len / 2 {
            let input = Tensor::new(tokens.as_slice(), &self.device)?.unsqueeze(0)?;
            let ys = self.model.decoder.forward(&input, features, i == 0)?;
            if i == 0 {
                if let Some(ns) = self.no_speech {
                    let logits = self.model.decoder.final_linear(&ys.i(..1)?)?.i(0)?.i(0)?;
                    no_speech_prob = candle_nn::ops::softmax(&logits, 0)?.i(ns as usize)?.to_scalar::<f32>()? as f64;
                }
            }
            let (_, seq_len, _) = ys.dims3()?;
            let logits = self.model.decoder.final_linear(&ys.i((..1, seq_len - 1..))?)?.i(0)?.i(0)?;
            let mut logits = logits.broadcast_add(&self.suppress)?;
            if i == 0 {
                // Like OpenAI's decoder: the text never starts with a blank or ends at once.
                let mut first = vec![0f32; logits.dim(0)?];
                for t in [220usize, self.eot as usize] {
                    if t < first.len() {
                        first[t] = f32::NEG_INFINITY;
                    }
                }
                logits = logits.broadcast_add(&Tensor::new(first.as_slice(), &self.device)?)?;
            }
            let next = logits.argmax(0)?.to_scalar::<u32>()?;
            let logprob = candle_nn::ops::log_softmax(&logits, D::Minus1)?.i(next as usize)?.to_scalar::<f32>()? as f64;
            if next == self.eot || tokens.len() >= max_len - 1 {
                break;
            }
            sum_logprob += logprob;
            tokens.push(next);
        }

        let generated = &tokens[prompt_len..];
        let avg_logprob = sum_logprob / generated.len().max(1) as f64;
        if no_speech_prob > wh::NO_SPEECH_THRESHOLD && avg_logprob < wh::LOGPROB_THRESHOLD {
            return Ok(None);
        }
        Ok(Some(self.vocab.decode(generated, self.eot)))
    }
}

/// Drops leading and trailing near-silence (keeping a little padding), so a
/// pause before speaking doesn't cost time or invite made-up words.
fn trim_silence(samples: &[f32]) -> &[f32] {
    const WINDOW: usize = wh::SAMPLE_RATE / 50; // 20 ms
    const THRESHOLD: f32 = 0.004;
    let loud = |w: &[f32]| (w.iter().map(|s| s * s).sum::<f32>() / w.len() as f32).sqrt() > THRESHOLD;
    let windows: Vec<bool> = samples.chunks(WINDOW).map(loud).collect();
    let (Some(first), Some(last)) = (windows.iter().position(|&l| l), windows.iter().rposition(|&l| l)) else {
        return &samples[..0];
    };
    let pad = wh::SAMPLE_RATE / 5 / WINDOW; // 200 ms
    let start = first.saturating_sub(pad) * WINDOW;
    let end = ((last + 1 + pad) * WINDOW).min(samples.len());
    &samples[start..end]
}

/// Slaney-style mel filterbank, as librosa (and so Whisper) builds it:
/// `n_mels` rows of `n_fft / 2 + 1` weights.
fn mel_filters(n_mels: usize, n_fft: usize, sample_rate: usize) -> Vec<f32> {
    const F_SP: f64 = 200.0 / 3.0;
    const MIN_LOG_HZ: f64 = 1000.0;
    const MIN_LOG_MEL: f64 = MIN_LOG_HZ / F_SP;
    let logstep = 6.4f64.ln() / 27.0;
    let hz_to_mel = |f: f64| if f >= MIN_LOG_HZ { MIN_LOG_MEL + (f / MIN_LOG_HZ).ln() / logstep } else { f / F_SP };
    let mel_to_hz = |m: f64| if m >= MIN_LOG_MEL { MIN_LOG_HZ * (logstep * (m - MIN_LOG_MEL)).exp() } else { F_SP * m };

    let bins = n_fft / 2 + 1;
    let fft_freqs: Vec<f64> = (0..bins).map(|k| k as f64 * sample_rate as f64 / n_fft as f64).collect();
    let max_mel = hz_to_mel(sample_rate as f64 / 2.0);
    let mel_f: Vec<f64> = (0..n_mels + 2).map(|i| mel_to_hz(max_mel * i as f64 / (n_mels + 1) as f64)).collect();

    let mut out = vec![0f32; n_mels * bins];
    for i in 0..n_mels {
        let (lo, mid, hi) = (mel_f[i], mel_f[i + 1], mel_f[i + 2]);
        let norm = 2.0 / (hi - lo);
        for (k, &f) in fft_freqs.iter().enumerate() {
            let lower = (f - lo) / (mid - lo);
            let upper = (hi - f) / (hi - mid);
            out[i * bins + k] = (lower.min(upper).max(0.0) * norm) as f32;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Token decoding
// ---------------------------------------------------------------------------

struct Vocab {
    /// Id -> token text in GPT-2's byte-to-unicode alphabet.
    tokens: Vec<String>,
    /// Special tokens such as `<|en|>`, by text.
    special: HashMap<String, u32>,
    /// The inverse of GPT-2's byte-to-unicode table.
    unbyte: HashMap<char, u8>,
}

impl Vocab {
    fn load(path: &Path) -> Result<Self, E> {
        let mut text = String::new();
        fs::File::open(path)?.read_to_string(&mut text)?;
        let json: serde_json::Value = serde_json::from_str(&text)?;
        let vocab = json["model"]["vocab"].as_object().ok_or("tokenizer.json has no vocabulary")?;
        let mut tokens = vec![String::new(); vocab.len()];
        for (tok, id) in vocab {
            let id = id.as_u64().ok_or("bad token id")? as usize;
            if id >= tokens.len() {
                tokens.resize(id + 1, String::new());
            }
            tokens[id] = tok.clone();
        }
        let special = json["added_tokens"]
            .as_array()
            .ok_or("tokenizer.json has no added tokens")?
            .iter()
            .filter_map(|t| Some((t["content"].as_str()?.to_string(), t["id"].as_u64()? as u32)))
            .collect();
        Ok(Self { tokens, special, unbyte: byte_decoder() })
    }

    /// Text of the given tokens; specials (and anything from `eot` up) are skipped.
    fn decode(&self, ids: &[u32], eot: u32) -> String {
        let mut bytes = Vec::new();
        for &id in ids {
            if id >= eot {
                continue;
            }
            if let Some(tok) = self.tokens.get(id as usize) {
                bytes.extend(tok.chars().filter_map(|c| self.unbyte.get(&c).copied()));
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

/// GPT-2's table maps every byte to a printable character; this is its inverse.
fn byte_decoder() -> HashMap<char, u8> {
    let printable = |b: u8| (b'!'..=b'~').contains(&b) || (0xA1..=0xAC).contains(&b) || (0xAE..=0xFF).contains(&b);
    let mut map = HashMap::with_capacity(256);
    let mut n = 0u32;
    for b in 0..=255u8 {
        let c = if printable(b) {
            char::from(b)
        } else {
            n += 1;
            char::from_u32(255 + n).expect("valid char")
        };
        map.insert(c, b);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_decoder_round_trips_gpt2_alphabet() {
        let m = byte_decoder();
        assert_eq!(m.len(), 256);
        assert_eq!(m[&'Ġ'], b' '); // "Ġ" is GPT-2's space
        assert_eq!(m[&'Ċ'], b'\n');
        assert_eq!(m[&'a'], b'a');
    }

    #[test]
    fn mel_filters_look_like_librosa() {
        let f = mel_filters(80, 400, 16000);
        assert_eq!(f.len(), 80 * 201);
        assert!(f.iter().all(|w| *w >= 0.0));
        // Every filter has some weight, and the first one peaks at bin 1 (40 Hz is near its centre).
        for row in f.chunks(201) {
            assert!(row.iter().any(|w| *w > 0.0));
        }
        let first = &f[..201];
        let peak = first.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
        assert_eq!(peak, 1);
    }

    #[test]
    fn pcm_decodes_and_is_capped() {
        let b64 = base64::engine::general_purpose::STANDARD.encode([0x00, 0x40, 0x00, 0xC0]);
        assert_eq!(decode_pcm(&b64).unwrap(), vec![0.5, -0.5]);
        assert!(decode_pcm("not base64!").is_err());
    }

    #[test]
    fn silence_is_trimmed_away() {
        assert!(trim_silence(&vec![0.0; 16000]).is_empty());
        let mut s = vec![0.0; 32000];
        for x in &mut s[16000..17600] {
            *x = 0.3;
        }
        let t = trim_silence(&s);
        assert!(t.len() < 16000 && t.len() >= 1600);
    }

    #[test]
    fn model_specs_are_complete() {
        for m in &MODELS {
            assert_eq!(m.revision.len(), 40);
            for f in &m.files {
                assert_eq!(f.sha256.len(), 64);
            }
        }
        assert!(spec("base").is_ok());
        assert!(spec("../x").is_err());
    }

    /// Runs a real model over a WAV file. Needs a downloaded model:
    /// `MANGO_WHISPER_DIR=<app data>/models/whisper-base MANGO_WHISPER_WAV=clip.wav cargo test real_whisper -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_whisper() {
        let dir = PathBuf::from(std::env::var("MANGO_WHISPER_DIR").expect("MANGO_WHISPER_DIR"));
        let wav = fs::read(std::env::var("MANGO_WHISPER_WAV").expect("MANGO_WHISPER_WAV")).unwrap();
        // 16 kHz mono 16-bit PCM WAV: the samples follow the "data" chunk header.
        let at = wav.windows(4).position(|w| w == b"data").expect("a WAV file") + 8;
        let samples: Vec<f32> = wav[at..].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
        let mut engine = Engine::load(&dir).unwrap();
        let t = Instant::now();
        let (text, lang) = engine.transcribe(&samples, None).unwrap();
        println!("[{lang:?}] {text} ({:.1}s)", t.elapsed().as_secs_f32());
        assert!(!text.is_empty());
    }
}
