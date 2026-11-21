import { createRoot } from 'react-dom/client';
import { Failure } from '@softn/single-shell/SingleApp';
import { readBoot } from './boot';
import { ServedApp } from './ServedApp';
import '@softn/single-shell/style.css';
let boot: ReturnType<typeof readBoot> | null = null;
try {
  boot = readBoot(document);
} catch {
  boot = null;
}
createRoot(document.getElementById('root')!).render(boot ? <ServedApp boot={boot} /> : <Failure />);
