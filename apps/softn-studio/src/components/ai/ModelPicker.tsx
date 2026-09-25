import React, { useId, useMemo, useState } from 'react';
import { chatModels, type ModelInfo } from '../../lib/providerConnection';

interface ModelPickerProps {
  /** The provider's models, as it listed them; null while there is no list. */
  models: ModelInfo[] | null;
  value: string;
  onChange(id: string): void;
  /** Visible label for the group. */
  label: string;
  /**
   * An extra first choice with an empty value — "Same as the provider's
   * model" for a per-role override.
   */
  emptyChoice?: string;
  /** Hide models whose ids say they are not for chat (embeddings, speech…), with a toggle to show them. */
  filterNonChat?: boolean;
  /** Start with the typed-id field open, for when there is no list to pick from. */
  manualByDefault?: boolean;
}

const MONTH = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });

/**
 * Pick a model from what the provider says it has.
 *
 * The list is data from the provider, never a list kept here: a search
 * box, the matches as radio buttons (arrow keys move between them, as with
 * any radio group), newest first when the provider dates them. Models
 * whose ids name another capability are hidden behind "Show all". When
 * there is no list — the server does not offer one, or it is empty — or
 * the one wanted is not in it, "Type a model id" takes any id as written.
 */
export const ModelPicker: React.FC<ModelPickerProps> = ({
  models,
  value,
  onChange,
  label,
  emptyChoice,
  filterNonChat = true,
  manualByDefault = false,
}) => {
  const id = useId();
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const inList = !!models?.some((model) => model.id === value);
  const [manual, setManual] = useState(manualByDefault || (!!value && !!models && !inList));

  const { visible, hidden } = useMemo(() => {
    const all = models ?? [];
    const filtered = filterNonChat && !showAll ? chatModels(all) : { models: all, hidden: 0 };
    const q = query.trim().toLowerCase();
    const matches = q
      ? filtered.models.filter((model) => model.id.toLowerCase().includes(q) || model.label?.toLowerCase().includes(q))
      : filtered.models;
    return { visible: matches, hidden: filterNonChat ? chatModels(all).hidden : 0 };
  }, [models, filterNonChat, showAll, query]);

  const hasList = !!models && models.length > 0;
  const showManual = manual || !hasList;

  return (
    <div className="st-models" role="group" aria-labelledby={`${id}-label`}>
      <div className="st-models-head">
        <span id={`${id}-label`} className="st-field-label">{label}</span>
        {hasList && (
          <button type="button" className="st-link-btn" onClick={() => setManual(!manual)} aria-expanded={manual}>
            {manual ? 'Pick from the list' : 'Type a model id'}
          </button>
        )}
      </div>

      {showManual ? (
        <div className="st-field">
          <label htmlFor={`${id}-manual`} className="st-field-hint st-field-hint-top">
            {hasList
              ? 'Any id the provider accepts, exactly as it spells it.'
              : models
                ? 'The provider listed no models. Type the id of one it serves, exactly as it spells it.'
                : 'Type the id of a model the provider serves, exactly as it spells it.'}
          </label>
          <input
            id={`${id}-manual`}
            className="st-input st-input-mono"
            value={value}
            onChange={(e) => onChange(e.target.value.trim())}
            autoComplete="off"
            spellCheck={false}
            aria-label={`${label}: model id`}
          />
        </div>
      ) : (
        <>
          <input
            type="search"
            className="st-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${models!.length} model${models!.length === 1 ? '' : 's'}`}
            aria-label={`Search ${label.toLowerCase()}`}
            aria-controls={`${id}-list`}
            autoComplete="off"
            spellCheck={false}
          />
          <div id={`${id}-list`} className="st-model-list" role="radiogroup" aria-labelledby={`${id}-label`}>
            {emptyChoice && !query && (
              <label className="st-model-option" data-checked={value === '' || undefined}>
                <input type="radio" name={`${id}-model`} checked={value === ''} onChange={() => onChange('')} />
                <span className="st-model-name st-model-name-plain">{emptyChoice}</span>
              </label>
            )}
            {visible.map((model) => (
              <label key={model.id} className="st-model-option" data-checked={value === model.id || undefined}>
                <input type="radio" name={`${id}-model`} value={model.id} checked={value === model.id} onChange={() => onChange(model.id)} />
                <span className="st-model-text">
                  <span className="st-model-name">{model.id}</span>
                  {model.label && <span className="st-model-label">{model.label}</span>}
                </span>
                {model.created !== undefined && <span className="st-model-date">{MONTH.format(model.created)}</span>}
              </label>
            ))}
            {visible.length === 0 && (
              <p className="st-model-empty">
                No model matches “{query}”.{' '}
                <button type="button" className="st-link-btn" onClick={() => { setManual(true); onChange(query.trim()); }}>
                  Use “{query.trim()}” as typed
                </button>
              </p>
            )}
          </div>
          {hidden > 0 && (
            <label className="st-check">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Show all {models!.length} models, including {hidden} that {hidden === 1 ? 'looks' : 'look'} like {hidden === 1 ? 'an embedding, speech, image or moderation model' : 'embedding, speech, image or moderation models'}
            </label>
          )}
        </>
      )}
    </div>
  );
};
