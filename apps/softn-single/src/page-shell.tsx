import { SingleApp, loadPageApplication, type PageSource } from '@softn/single-shell';
import '@softn/single-shell/style.css';

/** The shell, loading the app from the page it is mounted on. */
export function pageApp(page: PageSource) {
  return <SingleApp load={(signal, progress) => loadPageApplication(page, signal, progress)} />;
}
