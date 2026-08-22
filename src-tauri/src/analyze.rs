//! Rolling fingerprint of whatever is playing, and the EQ correction it implies.
//!
//! Fed from the same FFT frames the spectrum bars come from, so it costs one
//! extra pass over the magnitudes and no extra capture.
//!
//! The correction is *tonal*, not stylistic: it fits a line through the measured
//! octave-band levels and asks two questions — is this mix darker or brighter
//! than a well-balanced one (the tilt), and does any single band stick out of
//! its own trend (the residual). Genre is deliberately not guessed here; a
//! spectrum cannot tell techno from a synth-heavy film score. That judgement is
//! the language model's job in `ai.rs`, which gets these numbers as evidence.

use crate::eapo::BANDS;
use crate::spectrum::FFT_SIZE;
use serde::Serialize;

/// dB per octave a balanced mix falls at. Music is not flat: it is roughly pink,
/// and a curve that "corrects" it to flat sounds thin and harsh.
const REF_SLOPE: f32 = -3.5;
/// How much of the measured tilt error and per-band error to hand back. Half of
/// each: a suggestion, not a mastering job.
const TILT_W: f32 = 0.5;
const RES_W: f32 = 0.5;
const MAX_CORRECTION: f32 = 9.0;
/// Bands this far below the loudest one are mostly noise; they barely steer the fit.
const WEIGHT_RANGE_DB: f32 = 40.0;
/// EMA coefficient per frame at ~62 fps. 0.004 is roughly a 4 second memory —
/// long enough to average over a bar or two of music, short enough to notice a
/// track change.
const SLOW: f32 = 0.004;
/// Envelope follower for the crest factor: fast up, slow down.
const PEAK_DECAY: f32 = 0.15;
/// Below this the endpoint is silent and no suggestion is offered.
const SILENCE_DB: f32 = -60.0;
const DB_FLOOR: f32 = -90.0;
/// Same normalisation the bars use, so both read in the same units.
const SCALE: f32 = FFT_SIZE as f32 / 4.0;
const SQRT2: f32 = std::f32::consts::SQRT_2;

/// What the UI and the model both get to reason from.
#[derive(Clone, Debug, Serialize, Default)]
pub struct Features {
    /// Mean level of each EQ band, dB relative to full scale.
    pub bands: Vec<f32>,
    /// Suggested correction per band, dB. Zero-mean: a tone shape, not a volume.
    pub need: Vec<f32>,
    /// Measured spectral slope, dB per octave. Around -3.5 is normal; -8 is dark.
    pub slope: f32,
    /// Geometric spectral centroid, Hz. Where the "brightness" sits.
    pub centroid_hz: f32,
    /// Onset density, 0-1. Percussive, fast material trends high; pads trend low.
    pub flux: f32,
    /// Peak-to-average of the loudness envelope, dB. Low means heavily compressed.
    pub crest_db: f32,
    pub loudness_db: f32,
    /// False when the output is silent - the UI shows no suggestion.
    pub active: bool,
}

pub struct Analyzer {
    bands: [f32; 10],
    prev: Vec<f32>,
    flux: f32,
    centroid_log2: f32,
    loud: f32,
    peak: f32,
    seeded: bool,
}

impl Default for Analyzer {
    fn default() -> Self {
        Self {
            bands: [DB_FLOOR; 10],
            prev: Vec::new(),
            flux: 0.0,
            centroid_log2: 1000f32.log2(),
            loud: DB_FLOOR,
            peak: DB_FLOOR,
            seeded: false,
        }
    }
}

impl Analyzer {
    /// Fold one FFT frame in. `mags` is the magnitude spectrum up to Nyquist.
    pub fn push(&mut self, mags: &[f32], bin_hz: f32) {
        let mut band_db = [DB_FLOOR; 10];
        for (i, &fc) in BANDS.iter().enumerate() {
            band_db[i] = band_level(mags, bin_hz, fc);
        }

        let total: f32 = mags.iter().skip(1).map(|m| (m / SCALE).powi(2)).sum();
        let loud = 10.0 * total.max(1e-12).log10();

        // Magnitude-weighted centroid in log frequency, so an octave counts the
        // same whether it is low or high.
        let (mut num, mut den) = (0.0f32, 0.0f32);
        for (i, &m) in mags.iter().enumerate().skip(1) {
            let f = i as f32 * bin_hz;
            if f < 20.0 || f > 20_000.0 {
                continue;
            }
            num += m * f.log2();
            den += m;
        }
        let centroid_log2 = if den > 1e-9 { num / den } else { self.centroid_log2 };

        // Spectral flux: how much energy appeared since the last frame. Rising
        // edges only, normalised, so it measures onsets rather than loudness.
        let flux = if self.prev.len() == mags.len() {
            let (mut up, mut sum) = (0.0f32, 0.0f32);
            for (i, &m) in mags.iter().enumerate().skip(1) {
                up += (m - self.prev[i]).max(0.0);
                sum += m;
            }
            if sum > 1e-9 { (up / sum).min(1.0) } else { 0.0 }
        } else {
            0.0
        };
        self.prev.clear();
        self.prev.extend_from_slice(mags);

        if !self.seeded {
            self.seeded = true;
            self.bands = band_db;
            self.loud = loud;
            self.peak = loud;
            self.centroid_log2 = centroid_log2;
            self.flux = flux;
            return;
        }

        for i in 0..10 {
            self.bands[i] += SLOW * (band_db[i] - self.bands[i]);
        }
        self.loud += SLOW * (loud - self.loud);
        self.centroid_log2 += SLOW * (centroid_log2 - self.centroid_log2);
        self.flux += SLOW * (flux - self.flux);
        self.peak = loud.max(self.peak - PEAK_DECAY);
    }

    pub fn features(&self) -> Features {
        let (need, slope) = correction(&self.bands);
        Features {
            bands: self.bands.iter().map(|v| round_half(*v)).collect(),
            need: need.to_vec(),
            slope: round_half(slope),
            centroid_hz: self.centroid_log2.exp2().round(),
            flux: (self.flux * 100.0).round() / 100.0,
            crest_db: round_half(self.peak - self.loud),
            loudness_db: round_half(self.loud),
            active: self.seeded && self.loud > SILENCE_DB,
        }
    }
}

/// Mean power in the octave around `fc`, as dB.
fn band_level(mags: &[f32], bin_hz: f32, fc: f32) -> f32 {
    let i0 = (((fc / SQRT2) / bin_hz).round() as usize).max(1);
    let i1 = (((fc * SQRT2) / bin_hz).round() as usize)
        .min(mags.len().saturating_sub(1))
        .max(i0);
    let n = (i1 - i0 + 1) as f32;
    let p: f32 = (i0..=i1).map(|i| (mags[i] / SCALE).powi(2)).sum();
    (10.0 * (p / n).max(1e-12).log10()).max(DB_FLOOR)
}

/// The whole algorithm: weighted least-squares line through the band levels in
/// log frequency, then correct (a) the difference between its slope and a
/// balanced mix's, and (b) each band's departure from that line.
///
/// Returns the per-band correction and the measured slope in dB/octave.
fn correction(bands: &[f32; 10]) -> ([f32; 10], f32) {
    let peak = bands.iter().cloned().fold(f32::MIN, f32::max);
    let w: Vec<f32> = bands
        .iter()
        .map(|b| ((b - (peak - WEIGHT_RANGE_DB)) / WEIGHT_RANGE_DB).clamp(0.05, 1.0))
        .collect();
    let x: Vec<f32> = BANDS.iter().map(|f| f.log2()).collect();

    let sw: f32 = w.iter().sum();
    let mx: f32 = x.iter().zip(&w).map(|(a, b)| a * b).sum::<f32>() / sw;
    let my: f32 = bands.iter().zip(&w).map(|(a, b)| a * b).sum::<f32>() / sw;
    let num: f32 = (0..10).map(|i| w[i] * (x[i] - mx) * (bands[i] - my)).sum();
    let den: f32 = (0..10).map(|i| w[i] * (x[i] - mx) * (x[i] - mx)).sum();
    let slope = if den > 1e-6 { num / den } else { 0.0 };

    let mut out = [0.0f32; 10];
    for i in 0..10 {
        let residual = bands[i] - (my + slope * (x[i] - mx));
        let tilt = (REF_SLOPE - slope) * (x[i] - mx);
        out[i] = (TILT_W * tilt - RES_W * residual).clamp(-MAX_CORRECTION, MAX_CORRECTION);
    }
    // Zero-mean it: a preset is a tone shape, the preamp handles level.
    let mean = out.iter().sum::<f32>() / 10.0;
    for v in out.iter_mut() {
        *v = round_half((*v - mean).clamp(-MAX_CORRECTION, MAX_CORRECTION));
    }
    (out, slope)
}

fn round_half(v: f32) -> f32 {
    (v * 2.0).round() / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Band levels for a mix falling at `slope` dB/octave, plus optional bumps.
    fn ramp(slope: f32, bumps: &[(usize, f32)]) -> [f32; 10] {
        let mut b = [0.0f32; 10];
        for i in 0..10 {
            b[i] = -20.0 + slope * (BANDS[i].log2() - BANDS[0].log2());
        }
        for &(i, d) in bumps {
            b[i] += d;
        }
        b
    }

    #[test]
    fn a_balanced_mix_needs_almost_nothing() {
        let (need, slope) = correction(&ramp(REF_SLOPE, &[]));
        assert!((slope - REF_SLOPE).abs() < 0.2, "slope was {slope}");
        assert!(
            need.iter().all(|v| v.abs() <= 0.5),
            "a reference tilt should not be corrected: {need:?}"
        );
    }

    #[test]
    fn a_dark_mix_gets_treble_and_a_bright_one_gets_cut() {
        let (dark, _) = correction(&ramp(-8.0, &[]));
        assert!(dark[9] > 2.0 && dark[0] < 0.0, "dark mix: {dark:?}");

        let (bright, _) = correction(&ramp(0.0, &[]));
        assert!(bright[9] < -2.0 && bright[0] > 0.0, "bright mix: {bright:?}");
    }

    #[test]
    fn a_band_sticking_out_of_its_own_trend_gets_cut() {
        // +10 dB of one-note boom at 125 Hz on an otherwise balanced mix.
        let (need, _) = correction(&ramp(REF_SLOPE, &[(2, 10.0)]));
        assert!(need[2] < -3.0, "boom at 125 Hz should be cut: {need:?}");
        assert!(need[1] > need[2] && need[3] > need[2], "only that band: {need:?}");
    }

    #[test]
    fn the_correction_is_a_tone_shape_not_a_volume_change() {
        for slope in [-10.0, -3.5, 0.0, 2.0] {
            let (need, _) = correction(&ramp(slope, &[(5, 6.0)]));
            let mean: f32 = need.iter().sum::<f32>() / 10.0;
            assert!(mean.abs() < 0.6, "slope {slope} mean {mean}: {need:?}");
            assert!(need.iter().all(|v| v.abs() <= MAX_CORRECTION));
        }
    }

    #[test]
    fn silence_is_never_reported_as_active() {
        let a = Analyzer::default();
        assert!(!a.features().active);

        let mut a = Analyzer::default();
        let quiet = vec![0.0f32; FFT_SIZE / 2];
        for _ in 0..10 {
            a.push(&quiet, 23.4);
        }
        assert!(!a.features().active, "digital silence must not suggest anything");
    }

    #[test]
    fn a_tone_lands_in_the_band_that_owns_it() {
        let bin_hz = 48_000.0 / FFT_SIZE as f32;
        let mut mags = vec![0.0f32; FFT_SIZE / 2];
        let bin = (1000.0 / bin_hz).round() as usize;
        mags[bin] = SCALE;

        let mut a = Analyzer::default();
        a.push(&mags, bin_hz);
        let f = a.features();
        let hottest = f
            .bands
            .iter()
            .enumerate()
            .max_by(|x, y| x.1.partial_cmp(y.1).unwrap())
            .unwrap()
            .0;
        assert_eq!(BANDS[hottest], 1000.0, "got {:?}", f.bands);
        assert!((f.centroid_hz - 1000.0).abs() < 50.0, "centroid {}", f.centroid_hz);
    }
}
