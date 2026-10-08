/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Акцент склада — бирюзовый из исходного макета учёта производства
        brand: {
          50: '#EEF7F6', 100: '#D6ECEA', 200: '#AED8D4', 300: '#7FBFB9', 400: '#46A29A',
          500: '#178A82', 600: '#0D6B66', 700: '#0A5652', 800: '#084441', 900: '#06322F',
        },
      },
      fontFamily: {
        ui: ['Onest', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: true,
  },
};
