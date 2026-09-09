import { createRoot } from 'react-dom/client';
import { registerRuntimeComponents } from '@softn/components/lazy';
import { Failure } from '../../softn-single/src/SingleApp';
import { readBoot } from './boot';
import { ServedApp } from './ServedApp';
import '../../softn-single/src/style.css';
// The same registration as softn-single: the minimal set eagerly, every other
// built-in as a loader the registry runs when a document first needs it.
registerRuntimeComponents();
let boot: ReturnType<typeof readBoot> | null = null;
try {
  boot = readBoot(document);
} catch {
  boot = null;
}
createRoot(document.getElementById('root')!).render(boot ? <ServedApp boot={boot} /> : <Failure />);
