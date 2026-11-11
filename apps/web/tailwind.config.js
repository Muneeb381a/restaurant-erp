/**
 * Design tokens. The default Tailwind palettes are REPLACED so every existing class (bg-emerald-600,
 * text-slate-500, ...) lands on the restaurant palette:
 *   slate   -> warm paper / ink neutrals
 *   emerald -> pine green  (the "go" colour: take payment, confirm, free)
 *   amber   -> saffron     (attention: occupied, waiting, warnings)
 *   rose    -> chilli red  (danger, destructive, unpaid)
 *   sky     -> slate blue  (billed / in progress)
 * Colours are never the only signal: states also carry text and shape (see docs/design/UI-GUIDE.md).
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      white: '#ffffff',
      black: '#000000',
      slate: {
        50: '#fbf8f2',
        100: '#f5f0e6',
        200: '#e9e1d0',
        300: '#ddd4c3',
        400: '#b9ad97',
        500: '#8a806e',
        600: '#6b6254',
        700: '#4f483d',
        800: '#342f27',
        900: '#1e1b16',
      },
      emerald: {
        50: '#e8f3ef',
        100: '#cfe6de',
        200: '#9fcdbe',
        300: '#6fb39d',
        400: '#3f8f78',
        500: '#1f7561',
        600: '#0e5a49',
        700: '#0a4638',
        800: '#08352b',
        900: '#05241d',
      },
      rose: {
        50: '#fceeea',
        100: '#f8d9d1',
        200: '#f0b2a3',
        300: '#e58a74',
        400: '#d4604a',
        500: '#bc4430',
        600: '#9f3322',
        700: '#7f271a',
        800: '#5e1d13',
        900: '#3f130d',
      },
      amber: {
        50: '#fdf6e3',
        100: '#faebbf',
        200: '#f5d886',
        300: '#edc04c',
        400: '#e0a024',
        500: '#c48514',
        600: '#9e6710',
        700: '#7a4e0e',
        800: '#5a390c',
        900: '#3b2508',
      },
      sky: {
        50: '#edf1f8',
        100: '#dbe3f1',
        200: '#b7c6e0',
        300: '#8da2c9',
        400: '#637fb0',
        500: '#46619a',
        600: '#374e7d',
        700: '#2b3c61',
        800: '#1f2b47',
        900: '#151e33',
      },
    },
    extend: {
      fontFamily: {
        sans: [
          '"IBM Plex Sans"',
          '"IBM Plex Sans Arabic"',
          'system-ui',
          '"Segoe UI"',
          'sans-serif',
        ],
        urdu: [
          '"IBM Plex Sans Arabic"',
          '"IBM Plex Sans"',
          '"Noto Naskh Arabic"',
          'system-ui',
          'sans-serif',
        ],
      },
      borderRadius: { DEFAULT: '6px', md: '6px', lg: '8px', xl: '10px', '2xl': '12px' },
      minHeight: { touch: '3rem', primary: '3.5rem' }, // 48 px targets, 56 px for the main action
      minWidth: { touch: '3rem' },
      animation: { flash: 'flash 1.2s ease-out 2' },
      keyframes: {
        flash: {
          '0%': { boxShadow: '0 0 0 0 rgba(224,160,36,.9)' },
          '100%': { boxShadow: '0 0 0 14px rgba(224,160,36,0)' },
        },
        shake: {
          '0%,100%': { transform: 'translateX(0)' },
          '25%': { transform: 'translateX(-6px)' },
          '75%': { transform: 'translateX(6px)' },
        },
      },
      boxShadow: {
        // flat by default: hairlines carry the structure; shadow only lifts overlays
        sm: 'none',
        DEFAULT: 'none',
        sheet: '0 12px 40px rgba(30, 27, 22, 0.22)',
      },
    },
  },
  plugins: [],
};
