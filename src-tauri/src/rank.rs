//! "Smart organise" - propose a priority order without the user dragging
//! thirty endpoints into place.
//!
//! Ranking is driven by what Windows actually reports (form factor, bus,
//! endpoint state), never by matching brand names, because a virtual device is
//! free to call itself "Speakers" and several of them do.

use crate::audio::{form, Device, Flow};

/// Being plugged in and usable beats every quality consideration - a superb
/// endpoint that is not there is worse than a mediocre one that is.
const PRESENT: i32 = 100;

/// Score an output. Higher wins.
fn render_score(d: &Device) -> i32 {
    if d.virtual_device {
        // Steam streaming, Oculus, virtual cables: never an automatic choice.
        return -1000;
    }
    let base = match d.form_factor {
        form::HEADPHONES => 80,
        form::HEADSET => 74,
        form::SPEAKERS => 62,
        form::LINE_LEVEL => 56,
        form::SPDIF => 46,
        // A monitor or TV over HDMI - usually the fallback nobody wants.
        form::DISPLAY => 18,
        _ => 30,
    };
    // Picking the Hands-Free endpoint collapses the Bluetooth link out of A2DP,
    // so music turns into a phone call. Never rank it for listening.
    let hfp = if d.hands_free { -70 } else { 0 };
    // A device we can actually equalise is worth a nudge, no more.
    let eq = if d.eapo { 8 } else { 0 };
    base + hfp + eq + if d.present() { PRESENT } else { 0 }
}

/// Score an input. `paired` is the adapter of the winning output, so the
/// microphone belonging to the headset you are listening on floats up.
fn capture_score(d: &Device, paired: Option<&str>) -> i32 {
    if d.virtual_device {
        return -1000;
    }
    let base = match d.form_factor {
        form::HEADSET => 70,
        form::MICROPHONE => 64,
        _ => 30,
    };
    // Same trap as above: selecting a Bluetooth headset's mic drags the link
    // into HFP and wrecks playback quality, so it loses to any wired mic.
    let hfp = if d.hands_free { -45 } else { 0 };
    // Prefer the mic that belongs to the headset already chosen for output -
    // but not when that means switching the link to Hands-Free.
    let pair = match paired {
        Some(a) if !d.hands_free && belongs_to(&d.adapter, a) => 20,
        _ => 0,
    };
    base + hfp + pair + if d.present() { PRESENT } else { 0 }
}

/// "Crusher ANC 2 Hands-Free" belongs to "Crusher ANC 2"; so does the exact
/// same name. Compared case-insensitively on a word boundary so "Logi Z607"
/// never claims "Logi C615".
fn belongs_to(candidate: &str, owner: &str) -> bool {
    if owner.is_empty() {
        return false;
    }
    let (c, o) = (candidate.to_lowercase(), owner.to_lowercase());
    c == o || c.strip_prefix(&o).is_some_and(|rest| rest.starts_with(' '))
}

/// Propose a full priority order: outputs ranked, then inputs ranked.
/// Both flows share one list; the winner is chosen per flow, so interleaving
/// would be harmless - keeping them grouped just reads better in the UI.
pub fn smart_order(devices: &[Device]) -> Vec<String> {
    let mut render: Vec<&Device> = devices.iter().filter(|d| d.flow == Flow::Render).collect();
    render.sort_by(|a, b| {
        render_score(b)
            .cmp(&render_score(a))
            .then_with(|| a.adapter.cmp(&b.adapter))
    });

    // Whatever ends up first is what the user will be listening on.
    let paired = render
        .first()
        .filter(|d| d.present())
        .map(|d| d.adapter.as_str());

    let mut capture: Vec<&Device> = devices.iter().filter(|d| d.flow == Flow::Capture).collect();
    capture.sort_by(|a, b| {
        capture_score(b, paired)
            .cmp(&capture_score(a, paired))
            .then_with(|| a.adapter.cmp(&b.adapter))
    });

    render
        .into_iter()
        .chain(capture)
        .map(|d| d.id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(id: &str, adapter: &str, flow: Flow, ff: u32, state: &'static str) -> Device {
        Device {
            id: id.into(),
            name: "x".into(),
            adapter: adapter.into(),
            flow,
            state,
            is_default: false,
            eapo: false,
            channels: 2,
            sample_rate: 48000,
            form_factor: ff,
            virtual_device: false,
            bluetooth: false,
            hands_free: false,
        }
    }

    /// Ranked ids for one flow, most wanted first.
    fn order(devices: &[Device], flow: Flow) -> Vec<String> {
        let ids = smart_order(devices);
        ids.into_iter()
            .filter(|id| devices.iter().any(|d| &d.id == id && d.flow == flow))
            .collect()
    }

    #[test]
    fn virtual_devices_sink_below_everything_real() {
        let mut steam = d("steam", "Steam Streaming Speakers", Flow::Render, form::SPEAKERS, "active");
        steam.virtual_device = true;
        let hdmi = d("hdmi", "NVIDIA", Flow::Render, form::DISPLAY, "active");
        let out = order(&[steam, hdmi], Flow::Render);
        assert_eq!(out, vec!["hdmi", "steam"], "a virtual 'Speakers' must lose to a real HDMI out");
    }

    #[test]
    fn present_devices_beat_better_but_absent_ones() {
        let good = d("phones", "Crusher", Flow::Render, form::HEADPHONES, "unplugged");
        let meh = d("tv", "NVIDIA", Flow::Render, form::DISPLAY, "active");
        assert_eq!(order(&[good, meh], Flow::Render), vec!["tv", "phones"]);
    }

    #[test]
    fn hands_free_never_wins_playback() {
        let mut hfp = d("hfp", "Crusher ANC 2 Hands-Free", Flow::Render, form::HEADSET, "active");
        hfp.hands_free = true;
        hfp.bluetooth = true;
        let a2dp = d("a2dp", "Crusher ANC 2", Flow::Render, form::HEADPHONES, "active");
        assert_eq!(
            order(&[hfp, a2dp], Flow::Render),
            vec!["a2dp", "hfp"],
            "HFP is mono 16 kHz - it must never outrank the A2DP endpoint"
        );
    }

    #[test]
    fn headphones_outrank_speakers_outrank_display() {
        let ph = d("ph", "A", Flow::Render, form::HEADPHONES, "active");
        let sp = d("sp", "B", Flow::Render, form::SPEAKERS, "active");
        let hd = d("hd", "C", Flow::Render, form::DISPLAY, "active");
        assert_eq!(order(&[hd, sp, ph], Flow::Render), vec!["ph", "sp", "hd"]);
    }

    #[test]
    fn mic_of_the_chosen_headset_floats_up() {
        let out = d("gt808-out", "GAMING HEADSET GT808", Flow::Render, form::HEADPHONES, "active");
        let webcam = d("cam", "Logi C615 HD WebCam", Flow::Capture, form::MICROPHONE, "active");
        let headset_mic = d("gt808-mic", "GAMING HEADSET GT808", Flow::Capture, form::MICROPHONE, "active");
        assert_eq!(
            order(&[out, webcam, headset_mic], Flow::Capture),
            vec!["gt808-mic", "cam"],
            "listening on the GT808 should select the GT808 microphone"
        );
    }

    #[test]
    fn bluetooth_mic_does_not_get_the_pairing_bonus() {
        // Listening on the Crusher over A2DP must NOT pull in its HFP mic,
        // because that would collapse playback to phone-call quality.
        let out = d("crusher", "Crusher ANC 2", Flow::Render, form::HEADPHONES, "active");
        let mut bt_mic = d("crusher-mic", "Crusher ANC 2 Hands-Free", Flow::Capture, form::MICROPHONE, "active");
        bt_mic.hands_free = true;
        let webcam = d("cam", "Logi C615 HD WebCam", Flow::Capture, form::MICROPHONE, "active");
        assert_eq!(
            order(&[out, bt_mic, webcam], Flow::Capture),
            vec!["cam", "crusher-mic"]
        );
    }

    #[test]
    fn pairing_matches_on_a_word_boundary_only() {
        assert!(belongs_to("Crusher ANC 2 Hands-Free", "Crusher ANC 2"));
        assert!(belongs_to("Logi Z607", "Logi Z607"));
        assert!(!belongs_to("Logi C615 HD WebCam", "Logi C6"));
        assert!(!belongs_to("anything", ""));
    }

    #[test]
    fn every_device_appears_exactly_once() {
        let devs = vec![
            d("a", "A", Flow::Render, form::HEADPHONES, "active"),
            d("b", "B", Flow::Render, form::DISPLAY, "notpresent"),
            d("c", "C", Flow::Capture, form::MICROPHONE, "active"),
        ];
        let out = smart_order(&devs);
        assert_eq!(out.len(), 3);
        for x in ["a", "b", "c"] {
            assert_eq!(out.iter().filter(|i| *i == x).count(), 1, "{x} missing or duplicated");
        }
    }
}
