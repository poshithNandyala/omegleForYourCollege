/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html"
  ],
  theme: {
    extend: {
      colors: {
        background: '#FFF8E7',
        surface: '#FFFFFF',
        primary: '#FF49DB',
        secondary: '#2563EB',
        'accent-mint': '#E2F5E9',
        'accent-lilac': '#EBE4F6',
        'accent-yellow': '#FFF3C7',
        'text-primary': '#121212',
        'text-secondary': '#4A4A4A',
        border: '#121212',
      },
      fontFamily: {
        heading: ['"Bricolage Grotesque"', 'sans-serif'],
        body: ['Outfit', 'sans-serif'],
      },
      boxShadow: {
        'brutal': '4px 4px 0px #121212',
        'brutal-lg': '6px 6px 0px #121212',
        'brutal-primary': '4px 4px 0px #FF49DB',
        'brutal-secondary': '4px 4px 0px #2563EB',
      }
    },
  },
  plugins: [],
}
