import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          950: '#0a0a0b',
          900: '#111114',
          800: '#17171c',
          700: '#1f1f26',
          600: '#2a2a33',
          500: '#3a3a46',
        },
        brand: {
          400: '#7c8cff',
          500: '#5b6eff',
          600: '#4253ea',
        },
        clip: {
          video: '#3f6fff',
          audio: '#1fa27a',
          image: '#c66bff',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};

export default config;
