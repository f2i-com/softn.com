import React from 'react';
import './lazy.css';

// Loaded when asked for, with a stylesheet of its own: Vite fetches both, and waits for the
// stylesheet before it runs this.
export default function Lazy() {
  return <p id="lazy" className="lazy">Lazy loaded</p>;
}
