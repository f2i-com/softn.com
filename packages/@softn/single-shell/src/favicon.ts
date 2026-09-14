/** Use the bundle's extracted image, never an external URL or executable document. */
export function installFavicon(icon?: string): () => void {
  const existing = document.querySelector<HTMLLinkElement>('link#application-icon');
  const link = existing ?? document.createElement('link');
  const previous = link.getAttribute('href');
  link.id = 'application-icon';
  link.rel = 'icon';
  link.href = icon ?? 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';
  if (!existing) document.head.append(link);
  return () => {
    if (!existing) link.remove();
    else if (previous === null) link.removeAttribute('href');
    else link.setAttribute('href', previous);
  };
}
