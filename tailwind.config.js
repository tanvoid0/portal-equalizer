/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 900: "#07080c", 800: "#0c0e14", 700: "#12151e", 600: "#1a1e2b" },
        glow: { DEFAULT: "#5eead4", warm: "#fb923c", hot: "#f43f5e", cool: "#818cf8" },
        // The title bar is the same surface as the body, so its text and glyphs
        // are the only thing separating it - they get their own knobs.
        bar: { title: "#e2e8f0", sub: "#64748b", icon: "#94a3b8", "icon-hot": "#f1f5f9" },
      },
      fontFamily: { sans: ["Inter var", "Inter", "Segoe UI", "system-ui", "sans-serif"] },
    },
  },
  plugins: [],
};
