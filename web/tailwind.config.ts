import type { Config } from "tailwindcss";

// Preflight OFF — the ported design-system CSS (globals.css, from design/mockup.html) owns
// the reset and component styling. Tailwind is here for occasional layout utilities, with the
// token palette mapped to the same CSS variables the mockup uses.
const config: Config = {
  corePlugins: { preflight: false },
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        card: "var(--card)",
        border: "var(--border)",
        text: "var(--text)",
        "text-2": "var(--text-2)",
        "text-3": "var(--text-3)",
        accent: "var(--accent)",
        "accent-strong": "var(--accent-strong)",
      },
      fontFamily: {
        serif: "var(--serif)",
        sans: "var(--sans)",
        mono: "var(--mono)",
      },
    },
  },
  plugins: [],
};
export default config;
