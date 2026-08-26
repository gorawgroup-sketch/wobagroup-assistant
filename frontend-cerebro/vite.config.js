import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Servido por el Express principal en /cerebro (ver src/server.ts) — base
// tiene que coincidir con esa ruta, o las referencias a los assets
// generados en index.html/dist apuntarían a la raíz del dominio en vez de
// /cerebro/assets/...
export default defineConfig({
  base: '/cerebro/',
  plugins: [react()],
})
