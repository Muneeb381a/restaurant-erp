/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        urdu: ['Noto Nastaliq Urdu', 'Noto Naskh Arabic', 'Jameel Noori Nastaleeq', 'serif'],
      },
      minHeight: { touch: '3rem' }, // 48 px minimum touch target (CLAUDE.md)
      minWidth: { touch: '3rem' },
    },
  },
  plugins: [],
};
