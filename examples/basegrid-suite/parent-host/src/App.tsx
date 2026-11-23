import { useState } from 'react';
import { MarketingSite } from './components/MarketingSite';
import { WorkspaceHost } from './components/WorkspaceHost';

export function App() {
  const [mode, setMode] = useState<'site' | 'workspace'>(() => {
    if (typeof window !== 'undefined' && window.location.hash.startsWith('#workspace')) {
      return 'workspace';
    }
    return 'site';
  });

  const [launchAppId, setLaunchAppId] = useState<string | undefined>(() => {
    if (typeof window !== 'undefined' && window.location.hash.startsWith('#workspace/')) {
      return window.location.hash.slice('#workspace/'.length) || undefined;
    }
    return undefined;
  });

  const handleLaunch = (appId?: string) => {
    setLaunchAppId(appId);
    setMode('workspace');
    if (typeof window !== 'undefined') {
      window.location.hash = appId ? `#workspace/${appId}` : '#workspace';
    }
  };

  const handleBackToSite = () => {
    setMode('site');
    if (typeof window !== 'undefined') {
      window.location.hash = '';
    }
  };

  if (mode === 'workspace') {
    return (
      <WorkspaceHost
        initialAppId={launchAppId}
        onBackToSite={handleBackToSite}
      />
    );
  }

  return <MarketingSite onLaunchWorkspace={handleLaunch} />;
}
