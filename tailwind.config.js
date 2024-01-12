/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        amatic: ["Amatic SC", "sans-serif"],
      },
    },
  },
  plugins: [require("daisyui")],
  daisyui: {
    themes: ['nord', 'dracula'],
  },
};

/* 
mytheme: {
          primary: "#78716c",
          secondary: "#44403c",
          accent: "#292524",
          neutral: "#d6d3d1",
          "base-100": "#d1d5db",
          info: "#a5f3fc",
          success: "#bbf7d0",
          warning: "#fef08a",
          error: "#fecdd3",
        } 
*/