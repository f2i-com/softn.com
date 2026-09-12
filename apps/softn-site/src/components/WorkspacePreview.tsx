import React, { useState } from 'react';
import previewImage from '../assets/workspace-preview.png';
import dataImage from '../assets/workspace-data.png';

const VIEWS = [
  { id: 'preview', label: 'App preview', image: previewImage, alt: 'Fieldnotes running inside Softn Builder, with a task form, task list and dashboard totals.', caption: 'A form, a saved task and a dashboard that updates. This is Fieldnotes, a real, editable example.' },
  { id: 'data', label: 'Data collections', image: dataImage, alt: 'Softn Builder’s Data view showing the Fieldnotes tasks collection, fields and sample records.', caption: 'The same app’s data: a tasks collection with a title, focus and completion status.' },
];

/** Real product screenshots, kept static until the visitor chooses another view. */
export function WorkspacePreview(): React.ReactElement {
  const [selected, setSelected] = useState(0);
  const view = VIEWS[selected];
  return (
    <figure className="workspace-preview">
      <div className="workspace-preview-head">
        <span className="workspace-preview-label"><span aria-hidden="true" /> Inside Builder</span>
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
            aria-controls="workspace-image" tabIndex={index === selected ? 0 : -1} onClick={() => setSelected(index)}>
            {item.label}
          </button>
        ))}
      </div>
      <div id="workspace-image" role="tabpanel" aria-labelledby={`workspace-tab-${view.id}`}>
        <a className="workspace-preview-image" href={view.image} target="_blank" rel="noreferrer" aria-label={`View full-size screenshot: ${view.label}`}>
          <img src={view.image} alt={view.alt} width="2160" height="1650" />
          <span className="workspace-preview-expand">View full size ↗</span>
        </a>
      </div>
      <figcaption>{view.caption}</figcaption>
    </figure>
  );
}
