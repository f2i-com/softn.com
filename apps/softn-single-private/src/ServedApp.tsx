import { useEffect, useState } from 'react';
import { Application, Failure, Loading, type RunnableApplication } from '@softn/single-shell';
import type { BootConfig } from './boot';
import { loadServedApplication } from './load';

export function ServedApp({ boot }: { boot: BootConfig }) {
  const [app, setApp] = useState<RunnableApplication | null>(null);
  // Why the app could not load, kept so the failure page can say it.
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
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
      .catch((error: unknown) => {
        if (!active) return;
        console.error('[SoftN] The application could not open:', error);
        setFailure({ error });
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
      {failure ? <Failure error={failure.error} /> : app ? <Application app={app} /> : <Loading text={boot.loadingText} />}
    </main>
  );
}
