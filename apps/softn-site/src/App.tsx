import React from 'react';
import { Nav } from './components/Nav';
import { Hero } from './components/Hero';
import { Doors } from './components/Doors';
import { Language } from './components/Language';
import { Pipeline } from './components/Pipeline';
import { ComponentIndex } from './components/ComponentIndex';
import { Footer } from './components/Footer';

export default function App(): React.ReactElement {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Doors />
        <Language />
        <Pipeline />
        <ComponentIndex />
      </main>
      <Footer />
    </>
  );
}
