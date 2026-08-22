//! Diagnostic dump: what Windows reports, how we would rank it, and the exact
//! Equalizer APO config we would write. Read-only - writes nothing.
//!
//!     cargo run --example probe

fn main() {
    let devices = portal_equalizer_lib::probe_devices();
    let order = portal_equalizer_lib::probe_smart_order(&devices);

    println!("Equalizer APO: {:?}\n", portal_equalizer_lib::probe_eapo_dir());

    for flow in ["render", "capture"] {
        println!("=== {} (smart-organise order) ===", flow.to_uppercase());
        let mut rank = 0;
        for id in &order {
            let Some(d) = devices.iter().find(|d| &d.id == id) else { continue };
            if format!("{:?}", d.flow).to_lowercase() != flow {
                continue;
            }
            rank += 1;
            let tags: Vec<&str> = [
                ("virtual", d.virtual_device),
                ("hfp", d.hands_free),
                ("bt", d.bluetooth),
                ("eq", d.eapo),
            ]
            .iter()
            .filter(|(_, on)| *on)
            .map(|(t, _)| *t)
            .collect();
            println!(
                "{:>2}. {:<10} {:<40} ff={:<2} {}",
                rank,
                d.state,
                format!("{} / {}", d.name, d.adapter),
                d.form_factor,
                tags.join(",")
            );
        }
        println!();
    }

    println!(
        "=== per-app rules Windows is holding (routing API: {}) ===",
        match portal_equalizer_lib::probe_app_routing() {
            Ok(()) => "available".to_string(),
            Err(e) => e,
        }
    );
    let rules = portal_equalizer_lib::probe_app_rules();
    if rules.is_empty() {
        println!("(none)");
    }
    for (exe, flow, device) in &rules {
        let name = devices
            .iter()
            .find(|d| d.id.eq_ignore_ascii_case(device))
            .map(|d| format!("{} / {}", d.name, d.adapter))
            // Rules Windows wrote itself store a PnP path, not an endpoint id,
            // so there is nothing to look up - see docs/per-app-routing.md.
            .unwrap_or_else(|| {
                if device.is_empty() {
                    "(pinned by Windows, endpoint not recorded)".to_string()
                } else {
                    device.clone()
                }
            });
        println!("{:<28} {:<8} -> {}", exe, flow.to_lowercase(), name);
    }
    println!();

    println!("=== generated config.txt ===");
    println!("{}", portal_equalizer_lib::probe_config());
}
