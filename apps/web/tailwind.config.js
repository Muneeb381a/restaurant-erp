/**
 * Design tokens. The default Tailwind palettes are REPLACED so every existing class (bg-emerald-600,
 * text-slate-500, ...) lands on the restaurant palette:
 *   slate   -> cool neutrals (docs/design/REDESIGN-2026.md)
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
        50: '#f7f8fa',
        100: '#f0f2f5',
        200: '#e4e7ec',
        300: '#d0d5dd',
        400: '#98a2b3',
        500: '#667085',
        600: '#475467',
        700: '#344054',
        800: '#1d2939',
        900: '#101828',
      },
      emerald: {
        50: '#ecfdf3',
        100: '#d1fadf',
        200: '#a6f4c5',
        300: '#6ce9a6',
        400: '#32d583',
        500: '#12a05f',
        600: '#08794a',
        700: '#066239',
        800: '#054f31',
        900: '#043d27',
      },
      rose: {
        50: '#fef3f2',
        100: '#fee4e2',
        200: '#fecdca',
        300: '#fda29b',
        400: '#f97066',
        500: '#f04438',
        600: '#d92d20',
        700: '#b42318',
        800: '#912018',
        900: '#7a271a',
      },
      amber: {
        50: '#fffaeb',
        100: '#fef0c7',
        200: '#fedf89',
        300: '#fec84b',
        400: '#fdb022',
        500: '#f79009',
        600: '#dc6803',
        700: '#b54708',
        800: '#93370d',
        900: '#7a2e0e',
      },
      // accents for menu categories only (never a state colour)
      violet: { 50: '#f4f3ff', 100: '#ebe9fe', 500: '#7a5af8', 700: '#5925dc' },
      teal: { 50: '#f0fdf9', 100: '#ccfbef', 500: '#15b79e', 700: '#0e7090' },
      pink: { 50: '#fdf2fa', 100: '#fce7f6', 500: '#ee46bc', 700: '#c11574' },
      orange: { 50: '#fff6ed', 100: '#ffead5', 500: '#fb6514', 700: '#c4320a' },
      sky: {
        50: '#eff8ff',
        100: '#d1e9ff',
        200: '#b2ddff',
        300: '#84caff',
        400: '#53b1fd',
        500: '#2e90fa',
        600: '#1570ef',
        700: '#175cd3',
        800: '#1849a9',
        900: '#194185',
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
      borderRadius: { DEFAULT: '8px', md: '8px', lg: '10px', xl: '14px', '2xl': '18px' },
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
        // soft, cool shadows: cards sit just above the page, sheets float
        sm: '0 1px 2px rgba(16, 24, 40, 0.06)',
        DEFAULT: '0 1px 3px rgba(16, 24, 40, 0.08), 0 1px 2px rgba(16, 24, 40, 0.05)',
        md: '0 4px 12px -2px rgba(16, 24, 40, 0.08), 0 2px 4px -2px rgba(16, 24, 40, 0.05)',
        sheet: '0 20px 48px -8px rgba(16, 24, 40, 0.28)',
      },
    },
  },
  plugins: [],
};
