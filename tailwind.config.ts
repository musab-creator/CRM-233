import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eff6ff",
          100: "#dbeafe",
          200: "#bfdbfe",
          300: "#93c5fd",
          400: "#60a5fa",
          500: "#1e40af",
          600: "#1e3a8a",
          700: "#1e3370",
          800: "#172554",
          900: "#0f172a",
        },
        storm: {
          hail: "#7c3aed",
          wind: "#0ea5e9",
          tornado: "#dc2626",
        },
        status: {
          lead: "#f59e0b",
          inspection: "#3b82f6",
          contingency: "#8b5cf6",
          filed: "#06b6d4",
          adjusting: "#f97316",
          approved: "#10b981",
          supplement: "#ec4899",
          scheduled: "#14b8a6",
          inProgress: "#6366f1",
          completed: "#22c55e",
          invoiced: "#84cc16",
          collected: "#059669",
        },
      },
    },
  },
  plugins: [],
};

export default config;
