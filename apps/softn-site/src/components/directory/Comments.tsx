import React, { useEffect, useState } from 'react';
import { ApiError, getComments, postComment, type Comment } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Pagination } from './Controls';

const NAME_KEY = 'softn.site.commentName';

export function Comments({ slug, onCount }: { slug: string; onCount?: (n: number) => void }): React.ReactElement {
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Comment[]>([]);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [body, setBody] = useState('');
  const [website, setWebsite] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    getComments(slug, page, ac.signal)
      .then((r) => {
        setItems(r.items);
        setPages(r.pages);
        setTotal(r.total);
        setError(null);
        onCount?.(r.total);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, page]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setSendError(null);
    try {
      const c = await postComment(slug, name.trim(), body.trim(), website);
      try {
        localStorage.setItem(NAME_KEY, name.trim());
      } catch {
        /* storage blocked */
      }
      setBody('');
      if (page === 1) setItems((prev) => [c, ...prev]);
      setTotal((t) => t + 1);
      onCount?.(total + 1);
    } catch (err) {
      setSendError(err instanceof ApiError && err.retryAfter ? `${err.message} (about ${Math.ceil(err.retryAfter / 60)} min)` : err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="comments" id="comments">
      <h2 className="section-title">
        Comments <span className="section-count">{total}</span>
      </h2>
      <form className="comment-form" onSubmit={submit}>
        <div className="comment-form-row">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (optional)" maxLength={40} aria-label="Your name" />
          {/* A field no person sees or fills in; a form-filling script does. */}
          <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} className="comment-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" />
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="What did you think? Tips for other players, ideas for a remix…" rows={3} maxLength={2000} aria-label="Your comment" required minLength={2} />
        <div className="comment-form-foot">
          <span className="comment-form-note">No account needed. Be kind; the site owner can remove what is not.</span>
          <button type="submit" className="cta cta-primary" disabled={sending || body.trim().length < 2}>
            {sending ? 'Posting…' : 'Post comment'}
          </button>
        </div>
        {sendError && <p className="form-error">{sendError}</p>}
      </form>
      {error && <p className="form-error">{error}</p>}
      {loading && items.length === 0 ? (
        <p className="muted">Loading comments…</p>
      ) : items.length === 0 ? (
        <p className="muted">Nobody has said anything yet. Be the first.</p>
      ) : (
        <ul className="comment-list">
          {items.map((c) => (
            <li key={c.id} className="comment">
              <div className="comment-head">
                <span className="comment-name">{c.name}</span>
                <time className="comment-time" dateTime={c.createdAt}>
                  {timeAgo(c.createdAt)}
                </time>
              </div>
              <p className="comment-body">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      <Pagination page={page} pages={pages} hrefFor={(p) => `#comments-${p}`} onPage={setPage} />
    </section>
  );
}
