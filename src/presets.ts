/** Gains are dB per band, in the order of `BANDS`: 31 62 125 250 500 1k 2k 4k 8k 16k. */
export interface Preset {
  name: string;
  group: Group;
  /** Second-level heading inside a group. Groups without one render flat. */
  sub?: string;
  blurb: string;
  gains: number[];
}

export const GROUPS = ["Signature", "Genre", "Scene", "Headphones", "Utility"] as const;
export type Group = (typeof GROUPS)[number];

export const PRESETS: Preset[] = [
  // --- Signature: broad tone shapes, nothing genre-specific -----------------
  { name: "Flat", group: "Signature", blurb: "No colouring. The reference.",
    gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: "Bass Boost", group: "Signature", blurb: "Weight below 250 Hz, everything else left alone.",
    gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 1] },
  { name: "Bass Cut", group: "Signature", blurb: "Tames boom in small rooms and on desks.",
    gains: [-6, -5, -4, -2, 0, 0, 0, 0, 0, 0] },
  { name: "Sub Lift", group: "Signature", blurb: "Only the bottom two octaves. Felt more than heard.",
    gains: [8, 6, 2, 0, 0, 0, 0, 0, 0, 0] },
  { name: "Treble Boost", group: "Signature", blurb: "Air and detail up top.",
    gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  { name: "Treble Cut", group: "Signature", blurb: "Takes the edge off bright or compressed sources.",
    gains: [0, 0, 0, 0, 0, -1, -2, -4, -5, -6] },
  { name: "V-Shape", group: "Signature", blurb: "Scooped mids. Fun, loud, not neutral.",
    gains: [6, 5, 2, -1, -3, -3, -1, 2, 5, 6] },
  { name: "Deep V", group: "Signature", blurb: "The same idea, twice as rude.",
    gains: [8, 7, 3, -2, -5, -5, -2, 3, 7, 8] },
  { name: "Vocal", group: "Signature", blurb: "Pushes voices forward out of a busy mix.",
    gains: [-3, -2, 0, 2, 4, 4, 3, 1, 0, -1] },
  { name: "Mid Forward", group: "Signature", blurb: "Everything moves a row closer.",
    gains: [-2, -2, 0, 2, 3, 3, 2, 0, -1, -1] },
  { name: "Warm", group: "Signature", blurb: "Low mids up, top gently rolled off.",
    gains: [3, 3, 2, 1, 0, -1, -2, -2, -1, 0] },
  { name: "Bright", group: "Signature", blurb: "Opens up dull or lossy sources.",
    gains: [-1, -1, 0, 0, 0, 1, 2, 3, 4, 4] },
  { name: "Dark", group: "Signature", blurb: "Long listens without fatigue.",
    gains: [2, 2, 1, 0, 0, -1, -2, -4, -5, -6] },
  { name: "Punch", group: "Signature", blurb: "Kick and snare body at 125 Hz, no sub bloat.",
    gains: [1, 3, 5, 3, 0, 0, 1, 1, 0, 0] },
  { name: "Airy", group: "Signature", blurb: "Top octave only. Space without brightness.",
    gains: [0, 0, 0, 0, 0, 0, 0, 1, 3, 6] },

  // --- Genre / Rock & Metal -------------------------------------------------
  { name: "Rock", group: "Genre", sub: "Rock & Metal", blurb: "Guitars with body, cymbals with bite.",
    gains: [5, 4, 2, -1, -2, 0, 2, 4, 5, 5] },
  { name: "Classic Rock", group: "Genre", sub: "Rock & Metal", blurb: "Analogue-era masters, gently modernised.",
    gains: [4, 3, 2, 0, -1, 0, 2, 3, 4, 3] },
  { name: "Hard Rock", group: "Genre", sub: "Rock & Metal", blurb: "Wall of guitar, drums still audible.",
    gains: [5, 4, 3, 0, -2, 0, 3, 4, 4, 3] },
  { name: "Metal", group: "Genre", sub: "Rock & Metal", blurb: "Scooped mids, double-kick definition.",
    gains: [6, 5, 2, -2, -3, 0, 3, 5, 5, 4] },
  { name: "Punk", group: "Genre", sub: "Rock & Metal", blurb: "Fast, mid-heavy, snare forward.",
    gains: [4, 4, 3, 1, -1, 1, 3, 4, 3, 1] },
  { name: "Grunge", group: "Genre", sub: "Rock & Metal", blurb: "Thick and murky on purpose.",
    gains: [4, 4, 2, 0, -2, 0, 2, 3, 3, 2] },
  { name: "Indie", group: "Genre", sub: "Rock & Metal", blurb: "Jangle and reverb, kept clear.",
    gains: [2, 2, 1, 0, 0, 1, 2, 3, 3, 3] },
  { name: "Blues", group: "Genre", sub: "Rock & Metal", blurb: "Valve warmth with the string detail intact.",
    gains: [3, 3, 2, 1, 0, 0, 1, 2, 3, 3] },

  // --- Genre / Electronic ---------------------------------------------------
  { name: "Electronic", group: "Genre", sub: "Electronic", blurb: "Deep bottom, crisp hats.",
    gains: [6, 5, 1, 0, -2, 2, 1, 1, 4, 5] },
  { name: "House", group: "Genre", sub: "Electronic", blurb: "Four-to-the-floor kick, open top.",
    gains: [5, 5, 2, 0, -1, 1, 1, 2, 4, 4] },
  { name: "Techno", group: "Genre", sub: "Electronic", blurb: "Relentless low end, metallic percussion.",
    gains: [6, 5, 1, -1, -2, 1, 2, 2, 4, 4] },
  { name: "Trance", group: "Genre", sub: "Electronic", blurb: "Wide pads and a lifted top octave.",
    gains: [5, 4, 1, 0, -1, 1, 2, 3, 5, 6] },
  { name: "Drum & Bass", group: "Genre", sub: "Electronic", blurb: "Sub weight under a fast break.",
    gains: [8, 6, 2, -1, -2, 1, 2, 2, 4, 5] },
  { name: "Dubstep", group: "Genre", sub: "Electronic", blurb: "All the sub, mids out of the way.",
    gains: [9, 7, 2, -2, -3, 1, 2, 2, 4, 4] },
  { name: "Trap", group: "Genre", sub: "Electronic", blurb: "808 slide plus hi-hat rolls.",
    gains: [8, 6, 1, -1, -2, 0, 2, 3, 4, 4] },
  { name: "Synthwave", group: "Genre", sub: "Electronic", blurb: "Analogue synths, tape-warm.",
    gains: [5, 4, 2, 0, -1, 0, 1, 2, 4, 5] },
  { name: "Lo-Fi", group: "Genre", sub: "Electronic", blurb: "Deliberately dull top. Leans into the aesthetic.",
    gains: [4, 4, 3, 1, 0, -1, -2, -3, -4, -5] },
  { name: "Ambient", group: "Genre", sub: "Electronic", blurb: "Nothing pushed. Just gently widened.",
    gains: [3, 2, 1, 0, 0, 0, 0, 1, 2, 3] },

  // --- Genre / Hip-Hop & R&B ------------------------------------------------
  { name: "Hip-Hop", group: "Genre", sub: "Hip-Hop & R&B", blurb: "Sub weight and snap on the snare.",
    gains: [6, 5, 2, 3, -1, -1, 1, -1, 2, 3] },
  { name: "Boom Bap", group: "Genre", sub: "Hip-Hop & R&B", blurb: "Sampled drums, mids left alone.",
    gains: [5, 5, 3, 2, 0, 0, 1, 1, 2, 2] },
  { name: "R&B", group: "Genre", sub: "Hip-Hop & R&B", blurb: "Smooth low end, silky vocal top.",
    gains: [5, 4, 2, 1, 0, 1, 2, 2, 3, 3] },
  { name: "Soul", group: "Genre", sub: "Hip-Hop & R&B", blurb: "Everything a little rounder.",
    gains: [4, 3, 2, 1, 1, 1, 1, 1, 2, 2] },
  { name: "Funk", group: "Genre", sub: "Hip-Hop & R&B", blurb: "Slap bass and horn cut.",
    gains: [4, 4, 3, 1, -1, 0, 2, 3, 3, 2] },
  { name: "Reggae / Dub", group: "Genre", sub: "Hip-Hop & R&B", blurb: "Bassline leads, skank stays crisp.",
    gains: [7, 6, 3, 0, -2, 0, 1, 2, 3, 3] },
  { name: "Afrobeats", group: "Genre", sub: "Hip-Hop & R&B", blurb: "Percussive, warm, wide.",
    gains: [6, 5, 2, 0, -1, 1, 2, 2, 3, 3] },
  { name: "Latin", group: "Genre", sub: "Hip-Hop & R&B", blurb: "Congas and brass without harshness.",
    gains: [4, 3, 2, 0, 0, 1, 2, 3, 3, 3] },

  // --- Genre / Pop & Vocal --------------------------------------------------
  { name: "Pop", group: "Genre", sub: "Pop & Vocal", blurb: "Forward vocal, controlled low end.",
    gains: [-1, 0, 2, 4, 4, 2, 0, -1, -1, -1] },
  { name: "Modern Pop", group: "Genre", sub: "Pop & Vocal", blurb: "Loud masters given back their extremes.",
    gains: [4, 3, 1, 0, 0, 1, 2, 2, 3, 4] },
  { name: "K-Pop", group: "Genre", sub: "Pop & Vocal", blurb: "Dense mix, vocals kept on top.",
    gains: [4, 3, 1, 0, 1, 2, 2, 3, 4, 4] },
  { name: "Country", group: "Genre", sub: "Pop & Vocal", blurb: "Acoustic body, steel-string detail.",
    gains: [2, 2, 2, 1, 1, 1, 2, 3, 3, 2] },
  { name: "Songwriter", group: "Genre", sub: "Pop & Vocal", blurb: "Voice and one instrument. Barely touched.",
    gains: [1, 1, 1, 1, 2, 2, 2, 2, 2, 1] },
  { name: "Disco", group: "Genre", sub: "Pop & Vocal", blurb: "Strings, hats and a moving bassline.",
    gains: [5, 4, 2, 0, -1, 0, 2, 3, 4, 4] },

  // --- Genre / Acoustic & Classical -----------------------------------------
  { name: "Jazz", group: "Genre", sub: "Acoustic & Classical", blurb: "Warm, roomy, easy on the mids.",
    gains: [4, 3, 1, 2, -1, -1, 0, 1, 3, 4] },
  { name: "Vocal Jazz", group: "Genre", sub: "Acoustic & Classical", blurb: "Singer centred, band behind.",
    gains: [1, 1, 0, 1, 3, 3, 2, 1, 2, 2] },
  { name: "Classical", group: "Genre", sub: "Acoustic & Classical", blurb: "Wide and gentle. Nothing shouted.",
    gains: [4, 3, 2, 0, -1, -1, 0, 2, 3, 4] },
  { name: "Orchestral", group: "Genre", sub: "Acoustic & Classical", blurb: "Hall scale: timpani weight, string air.",
    gains: [5, 4, 2, 0, -1, -1, 1, 2, 4, 5] },
  { name: "Opera", group: "Genre", sub: "Acoustic & Classical", blurb: "Voice above the pit, no shrillness.",
    gains: [0, 1, 1, 1, 2, 3, 3, 2, 2, 2] },
  { name: "Piano", group: "Genre", sub: "Acoustic & Classical", blurb: "Even across the keyboard.",
    gains: [2, 2, 1, 0, 1, 1, 1, 2, 3, 3] },
  { name: "Acoustic", group: "Genre", sub: "Acoustic & Classical", blurb: "Natural strings and breath.",
    gains: [3, 2, 1, 0, 1, 1, 2, 2, 2, 1] },
  { name: "Choral", group: "Genre", sub: "Acoustic & Classical", blurb: "Massed voices stay separated.",
    gains: [2, 2, 1, 0, 1, 2, 2, 2, 3, 3] },

  // --- Scene: what you are doing, not what is playing ------------------------
  { name: "Cinema", group: "Scene", blurb: "Explosions land, dialogue stays readable.",
    gains: [5, 4, 1, 0, 1, 2, 2, 1, 2, 4] },
  { name: "Dialogue", group: "Scene", blurb: "For mumbled film dialogue. Centre band up, rumble down.",
    gains: [-4, -3, -1, 1, 4, 5, 4, 2, 0, -1] },
  { name: "Gaming", group: "Scene", blurb: "Footsteps and reloads sit at 1-4 kHz. This lifts them.",
    gains: [-2, -3, -1, 1, 3, 5, 6, 4, 2, 0] },
  { name: "Competitive FPS", group: "Scene", blurb: "Positional cues only. Music and explosions get out of the way.",
    gains: [-6, -5, -2, 0, 2, 5, 7, 6, 3, 0] },
  { name: "Late Night", group: "Scene", blurb: "Quiet listening. Less sub, less sizzle, same intelligibility.",
    gains: [-5, -4, -1, 1, 3, 3, 2, 1, -2, -4] },
  { name: "Sleep", group: "Scene", blurb: "Nothing that can startle. Top end removed.",
    gains: [-2, -2, -1, 0, 1, 1, 0, -2, -5, -8] },
  { name: "Podcast", group: "Scene", blurb: "Speech only. Kills rumble and hiss.",
    gains: [-6, -4, -1, 2, 4, 4, 3, 2, 0, -2] },
  { name: "Audiobook", group: "Scene", blurb: "Hours of one voice, as clear as it gets.",
    gains: [-6, -5, -2, 1, 4, 5, 4, 2, -1, -3] },
  { name: "Study / Focus", group: "Scene", blurb: "Present but undistracting. Nothing grabs you.",
    gains: [-3, -2, 0, 1, 2, 2, 1, 0, -1, -2] },
  { name: "Workout", group: "Scene", blurb: "Drive and energy. Loud room, loud music.",
    gains: [7, 6, 2, 0, -1, 1, 2, 3, 5, 5] },
  { name: "Commute", group: "Scene", blurb: "Fights train and traffic noise at both ends.",
    gains: [6, 5, 1, -1, 0, 2, 3, 3, 3, 2] },
  { name: "Party", group: "Scene", blurb: "Across a room, over conversation.",
    gains: [7, 6, 3, 0, -2, 0, 2, 4, 6, 6] },

  // --- Headphones: compensation for a transducer class -----------------------
  { name: "Open-Back", group: "Headphones", blurb: "Gives back the sub these lose by design.",
    gains: [3, 2, 1, 0, 0, 0, 0, 0, 1, 2] },
  { name: "Closed-Back", group: "Headphones", blurb: "Drains the trapped bass, opens the top.",
    gains: [-2, -2, -2, -1, 1, 1, 1, 1, 2, 3] },
  { name: "In-Ear (IEM)", group: "Headphones", blurb: "Sealed fit already has bass. Adds detail instead.",
    gains: [2, 1, 0, 0, 1, 1, 1, 2, 3, 3] },
  { name: "Earbuds", group: "Headphones", blurb: "Unsealed fit leaks bass and air. Both back.",
    gains: [4, 3, 1, 0, 1, 1, 1, 2, 3, 4] },
  { name: "Gaming Headset", group: "Headphones", blurb: "Fixes the muddy mids most headsets ship with.",
    gains: [-2, -2, -1, 0, 2, 3, 4, 3, 2, 1] },
  { name: "ANC Compensation", group: "Headphones", blurb: "Counters the tonal dip noise cancelling leaves.",
    gains: [3, 2, 1, 0, 0, 1, 1, 1, 2, 3] },

  // --- Utility: fixing a problem, not choosing a taste -----------------------
  { name: "Loudness", group: "Utility", blurb: "Equal-loudness tilt for low volume listening.",
    gains: [7, 5, 2, 0, -1, 0, 1, 3, 6, 7] },
  { name: "Small Speakers", group: "Utility", blurb: "Stops desktop speakers flapping.",
    gains: [-8, -6, -2, 1, 2, 2, 2, 2, 1, 0] },
  { name: "Laptop Speakers", group: "Utility", blurb: "No bass to give. Spends it all on clarity.",
    gains: [-10, -8, -3, 2, 3, 3, 3, 3, 2, 1] },
  { name: "Phone Speaker", group: "Utility", blurb: "For a single tiny driver.",
    gains: [-12, -10, -4, 2, 4, 4, 3, 3, 2, 0] },
  { name: "TV Speakers", group: "Utility", blurb: "Down-firing panel speakers, dialogue rescued.",
    gains: [-4, -3, -1, 1, 3, 3, 3, 2, 1, 0] },
  { name: "Soundbar", group: "Utility", blurb: "Light touch. The bar already voices itself.",
    gains: [3, 2, 0, 0, 1, 1, 1, 1, 2, 3] },
  { name: "Car", group: "Utility", blurb: "Cabin gain plus road noise at 250-500 Hz.",
    gains: [5, 4, 0, -2, 0, 1, 2, 3, 3, 2] },
  { name: "Bluetooth Lift", group: "Utility", blurb: "Counters the dull top end of A2DP codecs.",
    gains: [1, 1, 0, 0, 0, 1, 2, 3, 4, 5] },
  { name: "Rumble Filter", group: "Utility", blurb: "Removes sub-bass noise nothing musical lives in.",
    gains: [-12, -6, -1, 0, 0, 0, 0, 0, 0, 0] },
  { name: "Tame Boom", group: "Utility", blurb: "One-note bass from a desk or corner. Cut where it rings.",
    gains: [0, -2, -5, -4, -1, 0, 0, 0, 0, 0] },
  { name: "De-Harsh", group: "Utility", blurb: "Pulls down the 2-4 kHz shout that causes fatigue.",
    gains: [0, 0, 0, 0, 0, -1, -3, -4, -1, 0] },
  { name: "De-Ess", group: "Utility", blurb: "Sibilance only. Everything else untouched.",
    gains: [0, 0, 0, 0, 0, 0, 0, -1, -4, -2] },
];

/** Ordered second-level headings inside a group; empty when the group is flat. */
export const subsOf = (group: Group) => [
  ...new Set(PRESETS.filter((p) => p.group === group && p.sub).map((p) => p.sub!)),
];

export const findPreset = (name: string) => PRESETS.find((p) => p.name === name);

/** Whether a gain array still matches the preset it claims to be. */
export const matchesPreset = (gains: number[], name: string) => {
  const p = findPreset(name);
  return !!p && p.gains.every((g, i) => Math.abs(g - gains[i]) < 0.05);
};
