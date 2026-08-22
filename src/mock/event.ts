/** Stub for `@tauri-apps/api/event`. See ./README.md. */

type Handler = (e: { payload: any }) => void;

const subs: Record<string, Handler[]> = {};

export async function listen(name: string, handler: Handler) {
  (subs[name] ||= []).push(handler);
  return () => {
    subs[name] = (subs[name] ?? []).filter((h) => h !== handler);
  };
}

const emit = (name: string, payload: unknown) =>
  (subs[name] ?? []).forEach((h) => h({ payload }));

// A moving analyser, or every screenshot of the player is a flat line. Rolling
// hump across the bands with a high-frequency rolloff, at roughly 30 fps.
let t = 0;
setInterval(() => {
  t += 0.08;
  emit(
    "spectrum",
    Array.from({ length: 48 }, (_, i) =>
      Math.max(0.02, (0.55 + 0.45 * Math.sin(t + i * 0.35)) * Math.exp(-i / 26)),
    ),
  );
}, 33);

// One shot, after mount, so the Smart panel has something to rank against.
setTimeout(
  () =>
    emit("features", {
      bands: Array(10).fill(-20),
      need: [3, 2, 1, 0, -1, -1, 0, 1, 2, 3],
      slope: -3.2,
      centroid_hz: 1840,
      flux: 0.4,
      crest_db: 9,
      loudness_db: -14,
      active: true,
    }),
  600,
);
