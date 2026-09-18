import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({base:'/softn-host/',plugins:[react()],server:{port:5173,proxy:{'/v1':'http://localhost:8787','/leased-modules':'http://localhost:8787','/vendor':'http://localhost:8787','/leased-config.json':'http://localhost:8787','/runtime.config.json':'http://localhost:8787','/leased.softn':'http://localhost:8787','/style.css':'http://localhost:8787','/host-dialog.mjs':'http://localhost:8787','/compute-worker.mjs':'http://localhost:8787'}}});
