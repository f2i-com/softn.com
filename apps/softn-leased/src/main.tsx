import {createRoot} from 'react-dom/client';
import {registerRuntimeComponents} from '@softn/components/lazy';
import {SingleApp} from '@softn/single-shell';
import '@softn/single-shell/style.css';
registerRuntimeComponents();
// The host imports fixed deployment modules, never URLs supplied by a .logic action.
const controllerURL = '/leased-modules/controller.mjs';
const bridgeURL = '/leased-modules/softn-bridge.mjs';
const dialogURL = '/host-dialog.mjs';
const [{LeasedController},{createSoftnBridge},{hostDialog}] = await Promise.all([
  import(/* @vite-ignore */ controllerURL), import(/* @vite-ignore */ bridgeURL), import(/* @vite-ignore */ dialogURL),
]);
const config = await fetch('/leased-config.json').then(r=>r.json());
const controller = new LeasedController(config);

/** What the bridge hands the host when an app asks to contribute compute. The
 * shape is the bridge's, written out here rather than left as `any`: this is
 * the text a person reads before agreeing to spend their own electricity, and
 * a typo in a field name would quietly render "undefined" into that sentence. */
type ContributionRequest = {
  model: {label: string};
  first: number; last: number; memoryMB: number;
  serveWeights: boolean;
  estimate: {admissionBytes: number};
};
const backendCall = createSoftnBridge(controller, {
  askSecret: () => hostDialog({title:'Connect to a private LEASED pool',body:'The pool key is held by the trusted host, not the .softn app.',secret:true,confirmLabel:'Connect'}),
  confirmPeer: (id: string) => hostDialog({title:'Approve a compute endpoint',body:`Compare this fingerprint with its owner before proceeding:\n\n${id}\n\nThis is trust in that endpoint, not proof of correct computation.`,confirmLabel:'Approve fingerprint'}),
  confirmContribution: (g: ContributionRequest) => hostDialog({title:'Contribute compute for other people',body:`Model: ${g.model.label}\nLayers: ${g.first} to ${g.last}\nMemory admission estimate: ${Math.ceil(g.estimate.admissionBytes/1024**2)} MiB\nGrant: ${g.memoryMB} MiB\nWeight-piece sharing: ${g.serveWeights?'enabled':'disabled'}\n\nThis uses electricity and bandwidth. Compute peers can inspect activations. Hiding this tab stops contribution.`,confirmLabel:'Contribute'}),
});
// Arrive ready. The host holds the key and the tracker address, so a person
// opening this app should not have to press Connect and then Refresh before
// there is anything to choose. On a loopback server the key came down with the
// configuration; anywhere else this joins nothing and the app's Connect button
// asks, exactly as before.
void (async () => {
  try {
    if (config.autoConnect && config.poolKey) await controller.connect(config.poolKey);
    await controller.listModels();
    await controller.refresh().catch(() => {});
  } catch (e) { console.warn('LEASED host could not prepare:', e); }
})();
document.addEventListener('visibilitychange',()=>{if(document.hidden){controller.cancel();void controller.stopContributing();}});
window.addEventListener('pagehide',()=>{void controller.close();});
createRoot(document.getElementById('root')!).render(<SingleApp source={{configUrl:new URL('/runtime.config.json',location.origin).href}} backendCall={backendCall} />);
