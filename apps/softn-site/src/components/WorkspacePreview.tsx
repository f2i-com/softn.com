import React, { useState } from 'react';
import dataImage from '../assets/workspace-data.png';
import { LiveAppPreview } from './LiveAppPreview';

const VIEWS = [
  { id: 'preview', label: 'App preview', image: '', alt: '', caption: 'Try adding or completing a task right here. This preview uses temporary sample data; open the runtime for a full workspace that saves your tasks.' },
  { id: 'data', label: 'Data collections', image: dataImage, alt: 'Softn Builder’s Data view showing the Fieldnotes tasks collection, fields and sample records.', caption: 'The same app’s data: a tasks collection with a title, focus and completion status.' },
];

/** A live app alongside a view of the collections behind it. */
export function WorkspacePreview(): React.ReactElement {
  const [selected, setSelected] = useState(0);
  const view = VIEWS[selected];
  return (
    <figure className="workspace-preview">
      <div className="workspace-preview-head">
        <span className="workspace-preview-label"><span aria-hidden="true" /> {view.id === 'preview' ? 'Meet Fieldnotes' : 'Inside Builder'}</span>
        <a className="workspace-preview-example" href="#try-it">Try Fieldnotes ↓</a>
      </div>
      <div className="workspace-preview-tabs" role="tablist" aria-label="Explore Builder" onKeyDown={(event) => {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1
          : event.key === 'ArrowRight' ? (selected + 1) % VIEWS.length
          : event.key === 'ArrowLeft' ? (selected + VIEWS.length - 1) % VIEWS.length : null;
        if (next === null) return;
        event.preventDefault();
        setSelected(next);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
        {VIEWS.map((item, index) => (
          <button type="button" role="tab" key={item.id} id={`workspace-tab-${item.id}`} aria-selected={index === selected}
            aria-controls={`workspace-panel-${item.id}`} tabIndex={index === selected ? 0 : -1} onClick={() => setSelected(index)}>
            {item.label}
          </button>
        ))}
      </div>
      <div id="workspace-panel-preview" role="tabpanel" aria-labelledby="workspace-tab-preview" hidden={selected !== 0}>
        <LiveAppPreview />
      </div>
      <div id="workspace-panel-data" role="tabpanel" aria-labelledby="workspace-tab-data" hidden={selected !== 1}>
        <a className="workspace-preview-image" href={VIEWS[1].image} target="_blank" rel="noreferrer" aria-label="View full-size screenshot: Data collections">
          <img src={VIEWS[1].image} alt={VIEWS[1].alt} width="2160" height="1650" />
          <span className="workspace-preview-expand">View full size ↗</span>
        </a>
      </div>
      <figcaption>{view.caption}</figcaption>
    </figure>
  );
}
