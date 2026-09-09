import { useEffect, useState } from 'react';
import {
  Application,
  Failure,
  Loading,
  type RunnableApplication,
} from '../../softn-single/src/SingleApp';
import type { BootConfig } from './boot';
import { loadServedApplication } from './load';

export function ServedApp({ boot }: { boot: BootConfig }) {
  const [app, setApp] = useState<RunnableApplication | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let owned: RunnableApplication | null = null;
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 60000);
    void loadServedApplication(boot.endpoint, document.baseURI, controller.signal)
      .then((result) => {
        owned = result;
        if (!active) {
          result.assets.dispose();
          return;
        }
        // The server wrote the title and icon into the page already; this
        // only matters if the pack disagrees with the shell it came with.
        document.title = result.config.title;
        setApp(result);
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
      owned?.assets.dispose();
    };
  }, [boot.endpoint]);
  return (
    <main className="single-app">
      {failed ? <Failure /> : app ? <Application app={app} /> : <Loading text={boot.loadingText} />}
    </main>
  );
}
