import { useState } from 'react';
import { initialsOf } from '../../../../shared/ui/format';
import type { ChannelMessage, DiscussChannel } from '../types';

interface DiscussChannelsViewProps {
  channels: DiscussChannel[];
  activeChannel: DiscussChannel | null;
  messages: ChannelMessage[];
  onSelectChannel: (channel: DiscussChannel) => Promise<void>;
  onPostMessage: (channelId: number, author: string, body: string) => Promise<void>;
  onTogglePin: (messageId: number) => Promise<void>;
  onCreateChannel: (name: string, topic: string) => Promise<void>;
}

export function DiscussChannelsView({
  channels,
  activeChannel,
  messages,
  onSelectChannel,
  onPostMessage,
  onTogglePin,
  onCreateChannel,
}: DiscussChannelsViewProps) {
  const [body, setBody] = useState('');
  const [author, setAuthor] = useState('Alex Rivera');
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelTopic, setNewChannelTopic] = useState('');

  return (
    <div className="split-2" style={{ gridTemplateColumns: 'minmax(240px, 0.7fr) minmax(380px, 1.8fr)' }}>
      <div className="panel">
        <div className="panel-header"><h2>Team Channels</h2></div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {channels.map((ch) => (
            <button
              key={ch.id}
              type="button"
              className="kanban-card"
              style={{
                textAlign: 'left',
                borderColor: activeChannel?.id === ch.id ? '#4f46e5' : undefined,
                background: activeChannel?.id === ch.id ? '#eef2ff' : undefined,
              }}
              onClick={() => void onSelectChannel(ch)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                <strong>{ch.name}</strong>
                <span className="badge badge-neutral">{ch.message_count ?? 0}</span>
              </div>
              <div className="muted" style={{ fontSize: '11.5px' }}>{ch.topic || ch.kind}</div>
            </button>
          ))}

          <form
            style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '6px' }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newChannelName.trim()) return;
              await onCreateChannel(newChannelName, newChannelTopic);
              setNewChannelName('');
              setNewChannelTopic('');
            }}
          >
            <strong style={{ fontSize: '12px' }}>New Channel</strong>
            <input className="input" placeholder="#project-launch" value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} />
            <input className="input" placeholder="Topic (optional)" value={newChannelTopic} onChange={(e) => setNewChannelTopic(e.target.value)} />
            <button type="submit" className="btn btn-sm btn-primary">+ Create Channel</button>
          </form>
        </div>
      </div>

      <div className="panel">
        {activeChannel ? (
          <>
            <div className="panel-header">
              <div>
                <h2>{activeChannel.name}</h2>
                <div className="muted" style={{ fontSize: '12px' }}>{activeChannel.topic || 'Team discussion channel'}</div>
              </div>
              <span className="badge badge-accent">{activeChannel.kind}</span>
            </div>
            <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {messages.map((m) => (
                <div key={m.id} className={`chatter-item ${m.pinned ? 'internal' : ''}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="avatar">{initialsOf(m.author_name)}</span>
                      <strong>{m.author_name}</strong>
                      <span className="muted" style={{ fontSize: '11.5px' }}>{m.created_at}</span>
                      {m.pinned === 1 && <span className="badge badge-warning">Pinned</span>}
                    </div>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => void onTogglePin(m.id)}>
                      {m.pinned === 1 ? 'Unpin' : 'Pin'}
                    </button>
                  </div>
                  <div style={{ fontSize: '13.5px', paddingLeft: '36px' }}>{m.body}</div>
                </div>
              ))}
              {messages.length === 0 && <div className="empty-state">No messages yet in {activeChannel.name}. Start the thread below.</div>}

              <form
                style={{ display: 'flex', gap: '8px', paddingTop: '10px', borderTop: '1px solid var(--border)' }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!body.trim()) return;
                  await onPostMessage(activeChannel.id, author, body);
                  setBody('');
                }}
              >
                <input className="input" style={{ width: '140px' }} value={author} onChange={(e) => setAuthor(e.target.value)} />
                <input className="input" style={{ flex: 1 }} placeholder={`Message ${activeChannel.name}...`} value={body} onChange={(e) => setBody(e.target.value)} />
                <button type="submit" className="btn btn-primary">Send</button>
              </form>
            </div>
          </>
        ) : (
          <div className="empty-state">Select a channel</div>
        )}
      </div>
    </div>
  );
}
