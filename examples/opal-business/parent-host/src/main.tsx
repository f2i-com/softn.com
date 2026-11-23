import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/host.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
