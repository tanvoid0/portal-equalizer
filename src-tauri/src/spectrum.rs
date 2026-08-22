//! Live spectrum off the default output device via WASAPI loopback.
//!
//! The audio callback only ever appends to a ring buffer - all the FFT work and
//! all the IPC happens on our own worker thread, so a slow frontend can never
//! stall the audio engine.

use crate::analyze::Analyzer;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rustfft::{num_complex::Complex, FftPlanner};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// FFT window. 2048 @ 48 kHz is ~43 ms - enough resolution at the bottom end to
/// separate the 31 and 62 Hz bands without visible lag up top.
pub const FFT_SIZE: usize = 2048;
/// Number of bars sent to the UI.
pub const BARS: usize = 48;
/// Frames between `features` emissions. ~0.5 s at 62 fps - the fingerprint is a
/// 4 second average, so there is nothing to see faster than this.
const FEATURE_EVERY: u32 = 32;
const F_MIN: f32 = 30.0;
const F_MAX: f32 = 16_000.0;
/// Bottom of the displayed dynamic range.
const FLOOR_DB: f32 = -72.0;
/// How fast a bar falls once the sound stops. Per frame at ~60 fps.
const DECAY: f32 = 0.86;

#[derive(Default)]
struct Ring {
    buf: Vec<f32>,
}

impl Ring {
    fn push(&mut self, samples: &[f32], channels: usize) {
        // Downmix to mono; the bars represent overall content, not per-channel.
        if channels <= 1 {
            self.buf.extend_from_slice(samples);
        } else {
            for frame in samples.chunks_exact(channels) {
                self.buf
                    .push(frame.iter().sum::<f32>() / channels as f32);
            }
        }
        // Keep only the freshest window or two; anything older is already stale.
        let cap = FFT_SIZE * 2;
        if self.buf.len() > cap {
            let drop = self.buf.len() - cap;
            self.buf.drain(..drop);
        }
    }

    fn latest(&self) -> Option<Vec<f32>> {
        (self.buf.len() >= FFT_SIZE).then(|| self.buf[self.buf.len() - FFT_SIZE..].to_vec())
    }
}

pub struct Engine {
    restart: Arc<AtomicBool>,
}

impl Engine {
    /// Ask the capture stream to reopen - call this when the default output
    /// device changes, since loopback is bound to one endpoint.
    pub fn restart(&self) {
        self.restart.store(true, Ordering::Relaxed);
    }
}

pub fn start(app: AppHandle) -> Engine {
    let ring: Arc<Mutex<Ring>> = Arc::new(Mutex::new(Ring::default()));
    let restart = Arc::new(AtomicBool::new(false));
    // Whatever the current endpoint actually runs at - Bluetooth is usually
    // 44.1 kHz while most wired gear is 48 kHz, and guessing shifts every bar.
    let rate = Arc::new(AtomicU32::new(48_000));

    // Capture thread: owns the cpal stream, reopens it on demand.
    {
        let ring = ring.clone();
        let restart = restart.clone();
        let rate = rate.clone();
        std::thread::spawn(move || loop {
            let stream = open_loopback(&ring, &rate);
            let alive = stream.is_some();
            // No device yet (or it vanished) - wait and retry rather than spin.
            if !alive {
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            restart.store(false, Ordering::Relaxed);
            while !restart.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(100));
            }
            drop(stream);
        });
    }

    // Analysis thread: FFT -> bars -> UI.
    {
        let ring = ring.clone();
        let rate = rate.clone();
        std::thread::spawn(move || {
            let mut planner = FftPlanner::<f32>::new();
            let fft = planner.plan_fft_forward(FFT_SIZE);
            let window: Vec<f32> = (0..FFT_SIZE)
                .map(|i| {
                    // Hann.
                    0.5 - 0.5
                        * (std::f32::consts::TAU * i as f32 / (FFT_SIZE as f32 - 1.0)).cos()
                })
                .collect();
            let mut smoothed = vec![0.0f32; BARS];
            let edges = band_edges();
            let mut analyzer = Analyzer::default();
            let mut frame: u32 = 0;
            let silence = vec![0.0f32; FFT_SIZE / 2];

            loop {
                std::thread::sleep(Duration::from_millis(16));
                frame = frame.wrapping_add(1);
                let bin_hz = rate.load(Ordering::Relaxed) as f32 / FFT_SIZE as f32;
                let samples = { ring.lock().ok().and_then(|r| r.latest()) };
                let Some(samples) = samples else {
                    // Nothing captured - let the bars fall to rest, and feed the
                    // analyser silence so its fingerprint decays too rather than
                    // freezing on the last thing that played.
                    analyzer.push(&silence, bin_hz);
                    if frame % FEATURE_EVERY == 0 {
                        let _ = app.emit("features", analyzer.features());
                    }
                    if smoothed.iter().any(|v| *v > 0.001) {
                        for v in smoothed.iter_mut() {
                            *v *= DECAY;
                        }
                        let _ = app.emit("spectrum", &smoothed);
                    }
                    continue;
                };

                let mut buf: Vec<Complex<f32>> = samples
                    .iter()
                    .zip(&window)
                    .map(|(s, w)| Complex::new(s * w, 0.0))
                    .collect();
                fft.process(&mut buf);

                // One magnitude pass feeds both the bars and the fingerprint.
                let mags: Vec<f32> = buf[..FFT_SIZE / 2].iter().map(|c| c.norm()).collect();
                analyzer.push(&mags, bin_hz);
                if frame % FEATURE_EVERY == 0 {
                    let _ = app.emit("features", analyzer.features());
                }

                for b in 0..BARS {
                    let (lo, hi) = (edges[b], edges[b + 1]);
                    let i0 = ((lo / bin_hz).floor() as usize).max(1);
                    let i1 = ((hi / bin_hz).ceil() as usize).min(FFT_SIZE / 2 - 1).max(i0);
                    let peak = (i0..=i1).map(|i| mags[i]).fold(0.0f32, f32::max);
                    let db = 20.0 * (peak / (FFT_SIZE as f32 / 4.0)).max(1e-9).log10();
                    let level = ((db - FLOOR_DB) / -FLOOR_DB).clamp(0.0, 1.0);
                    // Instant attack, gentle decay - the classic analyser feel.
                    smoothed[b] = level.max(smoothed[b] * DECAY);
                }
                let _ = app.emit("spectrum", &smoothed);
            }
        });
    }

    Engine { restart }
}

/// Log-spaced band edges, BARS+1 of them.
fn band_edges() -> Vec<f32> {
    let ratio = (F_MAX / F_MIN).powf(1.0 / BARS as f32);
    (0..=BARS).map(|i| F_MIN * ratio.powi(i as i32)).collect()
}

/// Open a WASAPI loopback stream on the current default output device.
/// cpal opens an output device for input in loopback mode, which is exactly
/// what we want: whatever Windows is playing, without a virtual cable.
fn open_loopback(ring: &Arc<Mutex<Ring>>, rate: &Arc<AtomicU32>) -> Option<cpal::Stream> {
    let host = cpal::default_host();
    let device = host.default_output_device()?;
    let config = device.default_output_config().ok()?;
    let channels = config.channels() as usize;
    rate.store(config.sample_rate().0, Ordering::Relaxed);
    let ring = ring.clone();

    let stream = device
        .build_input_stream(
            &config.config(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if let Ok(mut r) = ring.lock() {
                    r.push(data, channels);
                }
            },
            |_err| {},
            None,
        )
        .ok()?;
    stream.play().ok()?;
    Some(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn band_edges_span_the_audible_range_monotonically() {
        let e = band_edges();
        assert_eq!(e.len(), BARS + 1);
        assert!((e[0] - F_MIN).abs() < 0.01);
        assert!((e[BARS] - F_MAX).abs() < 1.0);
        assert!(e.windows(2).all(|w| w[1] > w[0]));
    }

    #[test]
    fn ring_downmixes_and_caps() {
        let mut r = Ring::default();
        // Stereo frames: L=1.0, R=3.0 -> mono 2.0
        r.push(&[1.0, 3.0, 1.0, 3.0], 2);
        assert_eq!(r.buf, vec![2.0, 2.0]);

        r.push(&vec![0.0; FFT_SIZE * 6], 1);
        assert_eq!(r.buf.len(), FFT_SIZE * 2, "ring must not grow unbounded");
        assert!(r.latest().is_some());
    }
}
