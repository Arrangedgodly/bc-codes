/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{js,ts,jsx,tsx}"],
  plugins: [require("daisyui")],
  daisyui: {
    themes: [
      {
        mytheme: {
          primary: "#111827",
          secondary: "#374151",
          accent: "#6b7280",
          neutral: "#d1d5db",
          "base-100": "#f5f5f4",
          info: "#22d3ee",
          success: "#34d399",
          warning: "#fde047",
          error: "#fda4af",
        },
      },
    ],
  },
};
