/**
 * SchemaDesigner - Visual ER diagram editor using React Flow
 */

import React, { useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useNodesInitialized,
  useReactFlow,
  useStore,
  Connection,
  Edge,
  Node,
  BackgroundVariant,
  MarkerType,
  type NodeTypes,
  type NodeChange,
  type EdgeChange,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useSchemaStore } from '../../stores/schemaStore';
import { EntityNode } from './EntityNode';
import { EntityEditor } from './EntityEditor';
import { DataEntryPanel } from './DataEntryPanel';
import { useInitialSchemaFit } from '../../hooks/useInitialSchemaFit';
import { RelationshipDialog } from './RelationshipDialog';
import { RelationshipList, relationshipCardinality, relationshipName } from './RelationshipList';
import type { RelationshipDraft } from '../../types/builder';

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--ink)',
  },
  main: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  flowContainer: {
    flex: 1,
    minWidth: 0,
    position: 'relative' as const,
  },
  // Sits over the canvas without stealing it: the wrapper ignores the pointer so
  // double-clicking through it still creates a collection, and only the button
  // takes clicks back.
  emptyOverlay: {
    position: 'absolute' as const,
    inset: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    textAlign: 'center' as const,
    pointerEvents: 'none' as const,
  },
  emptyTitle: {
    fontFamily: 'var(--b-display)',
    fontSize: 19,
    fontWeight: 600,
    letterSpacing: '-0.02em',
    color: 'var(--paper)',
  },
  emptyBody: {
    margin: 0,
    maxWidth: 430,
    fontSize: 13.5,
    lineHeight: 1.6,
    color: 'var(--dim)',
  },
  emptyCode: {
    fontFamily: 'var(--b-mono)',
    fontSize: '0.92em',
    color: 'var(--coral)',
  },
  emptyBtn: {
    pointerEvents: 'auto' as const,
    marginTop: 4,
    padding: '9px 18px',
    background: 'var(--coral)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontFamily: 'inherit',
    fontSize: 13.5,
    fontWeight: 600,
    cursor: 'pointer',
  },
  emptyHint: {
    margin: 0,
    maxWidth: 400,
    fontSize: 12.5,
    lineHeight: 1.5,
    color: 'var(--dimmer)',
  },
  toolbar: {
    padding: '8px 16px',
    borderBottom: '1px solid var(--line-soft)',
    background: 'var(--ink-2)',
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  toolbarTitle: {
    fontWeight: 600,
    fontSize: 14,
    color: 'var(--paper)',
    marginRight: 16,
  },
  btn: {
    padding: '6px 12px',
    background: 'var(--coral)',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  btnSecondary: {
    background: 'var(--ink-3)',
    color: 'var(--dim)',
  },
  hint: {
    marginLeft: 'auto',
    fontSize: 11,
    color: 'var(--dimmer)',
  },
};

const nodeTypes: NodeTypes = {
  entity: EntityNode,
};

// Fit a small schema at its authored size, rather than enlarging a single
// collection to 200% above the seed table. Manual zoom remains available.
const schemaFitOptions = { padding: 0.2, maxZoom: 1 };
const schemaDeleteKeys = ['Backspace', 'Delete'];

function InitialSchemaFit({ interacted, requiredNodeId }: { interacted: React.RefObject<boolean>; requiredNodeId?: string }) {
  const nodesReady = useNodesInitialized();
  const { fitView, viewportInitialized } = useReactFlow();
  const width = useStore(state => state.width);
  const height = useStore(state => state.height);
  const requestedNodeReady = useStore(state => !requiredNodeId || !!state.nodeLookup.get(requiredNodeId)?.measured?.width);
  const fit = useCallback(() => { void fitView(schemaFitOptions); }, [fitView]);
  useInitialSchemaFit({ ready: nodesReady && viewportInitialized && requestedNodeReady, width, height, fit, interacted });
  return null;
}

/** Put a new collection beside existing ones without moving authored positions. */
export function nextEntityPosition(nodes: Node[], selectedId: string | null, center: { x: number; y: number }): { x: number; y: number } {
  if (!nodes.length) return { x: center.x - 110, y: center.y - 70 };
  const bounds = nodes.map(node => ({ id: node.id, x: node.position.x, y: node.position.y, width: node.measured?.width ?? node.width ?? 220, height: node.measured?.height ?? node.height ?? 160 }));
  const nearest = bounds.reduce((best, node) =>
    Math.hypot(node.x + node.width / 2 - center.x, node.y + node.height / 2 - center.y)
      < Math.hypot(best.x + best.width / 2 - center.x, best.y + best.height / 2 - center.y) ? node : best);
  const anchor = bounds.find(node => node.id === selectedId) ?? nearest;
  const position = { x: anchor.x + anchor.width + 80, y: anchor.y };
  // New entities have one short key field. Reserve extra height and spacing
  // so a neighbouring collection's longer field list cannot overlap it.
  for (let attempt = 0; attempt <= bounds.length; attempt++) {
    const collisions = bounds.filter(node => position.x < node.x + node.width + 32 && position.x + 220 + 32 > node.x && position.y < node.y + node.height + 32 && position.y + 160 + 32 > node.y);
    if (!collisions.length) break;
    position.x = Math.max(...collisions.map(node => node.x + node.width)) + 80;
  }
  return position;
}

export function SchemaDesigner() {
  const viewportInteracted = React.useRef(false);
  const flowInstance = React.useRef<ReactFlowInstance | null>(null);
  const flowContainer = React.useRef<HTMLDivElement>(null);
  const [panel, setPanel] = React.useState<'collection' | 'relationships'>('collection');
  const [selectedRelationshipId, setSelectedRelationshipId] = React.useState<string | null>(null);
  const [relationshipDialog, setRelationshipDialog] = React.useState<{ key: string; id?: string; initial: RelationshipDraft } | null>(null);
  const [addedEntityFit, setAddedEntityFit] = React.useState<{ id: string; interacted: { current: boolean } } | null>(null);
  const dialogSequence = React.useRef(0);
  const {
    entities,
    relationships,
    selectedEntityId,
    addEntity,
    updateEntity,
    selectEntity,
    deleteEntity,
    addRelationship,
    updateRelationship,
    deleteRelationship,
  } = useSchemaStore();

  // Convert entities to React Flow nodes
  const initialNodes: Node[] = useMemo(
    () =>
      entities.map((entity) => ({
        id: entity.id,
        type: 'entity',
        position: entity.position,
        data: { entity, selected: entity.id === selectedEntityId },
        selected: entity.id === selectedEntityId,
      })),
    [entities, selectedEntityId]
  );

  // Convert relationships to React Flow edges
  const initialEdges: Edge[] = useMemo(
    () =>
      relationships.map((rel) => {
        const field = entities.find(entity => entity.id === rel.sourceEntityId)?.fields.find(candidate => candidate.id === rel.sourceFieldId);
        const selected = rel.id === selectedRelationshipId;
        const color = selected ? 'var(--coral)' : 'var(--dim)';
        return {
          id: rel.id,
          source: rel.sourceEntityId,
          target: rel.targetEntityId,
          sourceHandle: field ? `field-${field.id}` : 'collection-source',
          targetHandle: 'collection-target',
          label: `${field ? `${field.name} · ` : ''}${relationshipCardinality[rel.type]}`,
          ariaLabel: `${relationshipName(rel, entities)}, ${relationshipCardinality[rel.type]}. Use Relationships to edit.`,
          type: 'smoothstep',
          selected,
          animated: false,
          style: { stroke: color, strokeWidth: selected ? 2.5 : 1.5, strokeDasharray: field ? undefined : '5 4' },
          markerEnd: { type: MarkerType.ArrowClosed, color },
          labelStyle: { fill: 'var(--paper)', fontSize: 12, fontWeight: 600 },
          labelBgStyle: { fill: 'var(--ink-2)', stroke: 'var(--line)' },
          labelBgPadding: [8, 5] as [number, number],
          labelBgBorderRadius: 4,
        };
      }),
    [relationships, entities, selectedRelationshipId]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Sync nodes with store when entities change
  React.useEffect(() => {
    setNodes(
      entities.map((entity) => ({
        id: entity.id,
        type: 'entity',
        position: entity.position,
        data: { entity, selected: entity.id === selectedEntityId },
        selected: entity.id === selectedEntityId,
      }))
    );
  }, [entities, selectedEntityId, setNodes]);

  // Sync edges with store when relationships change
  React.useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  // Handle node position changes
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);

      // Update positions in store
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          updateEntity(change.id, { position: change.position });
        }
        // Selecting a node with the keyboard, or with React Flow's own selection
        // rather than our click handler, has to open the editor too — otherwise
        // a keyboard user can move the highlight around the canvas and the panel
        // beside it never changes.
        if (change.type === 'select') {
          if (change.selected) { selectEntity(change.id); setSelectedRelationshipId(null); setPanel('collection'); }
          else if (selectedEntityId === change.id) selectEntity(null);
        }
        // Pressing Delete removed the node from the canvas and left the entity
        // in the schema: it vanished from the diagram, kept its seed rows, and
        // came straight back on the next render from the store.
        if (change.type === 'remove') {
          deleteEntity(change.id);
        }
      }
    },
    [onNodesChange, updateEntity, selectEntity, selectedEntityId, deleteEntity]
  );

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    onEdgesChange(changes);
    for (const change of changes) {
      if (change.type === 'remove') {
        deleteRelationship(change.id);
        setSelectedRelationshipId(current => current === change.id ? null : current);
      }
      if (change.type === 'select') {
        setSelectedRelationshipId(current => change.selected ? change.id : current === change.id ? null : current);
        if (change.selected) { selectEntity(null); setPanel('relationships'); }
      }
    }
  }, [onEdgesChange, deleteRelationship, selectEntity]);

  const openRelationship = useCallback((initial: RelationshipDraft, id?: string) => {
    setPanel('relationships');
    if (id) { setSelectedRelationshipId(id); selectEntity(null); }
    setRelationshipDialog({ key: `${id ?? 'new'}-${++dialogSequence.current}`, id, initial });
  }, [selectEntity]);

  // Handle edge connections
  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        openRelationship({
          sourceEntityId: connection.source,
          sourceFieldId: connection.sourceHandle?.startsWith('field-') ? connection.sourceHandle.slice('field-'.length) : '',
          targetEntityId: connection.target,
          type: 'many-to-one',
        });
      }
    },
    [openRelationship]
  );

  // Handle node selection
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      selectEntity(node.id);
      setSelectedRelationshipId(null);
      setPanel('collection');
    },
    [selectEntity]
  );

  // Handle double-click to add entity
  const onPaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      // Pane only. This ran for any double-click anywhere inside the flow —
      // including on a node, or on the zoom buttons — and then measured the
      // position against whatever had been clicked, so double-clicking an
      // existing collection spawned a new one on top of it and double-clicking
      // the zoom control spawned one in the corner.
      const target = event.target as HTMLElement;
      if (!target.classList.contains('react-flow__pane')) return;
      if (!flowInstance.current) return;
      addEntity(flowInstance.current.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [addEntity]
  );

  // Handle background click to deselect
  const onPaneClick = useCallback(() => {
    selectEntity(null);
    setSelectedRelationshipId(null);
  }, [selectEntity]);

  const editRelationship = useCallback((id: string) => {
    const relationship = relationships.find(candidate => candidate.id === id);
    if (relationship) openRelationship(relationship, id);
  }, [relationships, openRelationship]);

  const removeRelationship = useCallback((id: string) => {
    deleteRelationship(id);
    setSelectedRelationshipId(current => current === id ? null : current);
  }, [deleteRelationship]);

  const addRelationshipFromToolbar = useCallback(() => {
    if (!entities.length) return;
    const source = entities.find(entity => entity.id === selectedEntityId) ?? entities[0];
    openRelationship({
      sourceEntityId: source.id, sourceFieldId: '',
      targetEntityId: entities.find(entity => entity.id !== source.id)?.id ?? source.id,
      type: 'many-to-one',
    });
  }, [entities, selectedEntityId, openRelationship]);

  // Clicking an edge opens its settings; removing it is an explicit action.
  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      editRelationship(edge.id);
    },
    [editRelationship]
  );

  const handleAddEntity = useCallback(() => {
    const bounds = flowContainer.current?.getBoundingClientRect();
    const center = bounds && flowInstance.current
      ? flowInstance.current.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
      : { x: 200, y: 150 };
    const measured = new Map((flowInstance.current?.getNodes() ?? []).map(node => [node.id, node]));
    const current = useSchemaStore.getState();
    const placementNodes: Node[] = current.entities.map(entity => ({ id: entity.id, position: entity.position, measured: measured.get(entity.id)?.measured, data: {} }));
    const id = addEntity(nextEntityPosition(placementNodes, current.selectedEntityId, center));
    setAddedEntityFit({ id, interacted: { current: false } });
    setPanel('collection');
  }, [addEntity]);

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <span style={styles.toolbarTitle}>Schema Designer</span>
        <button style={styles.btn} onClick={handleAddEntity}>
          + Add Entity
        </button>
        <button style={{ ...styles.btn, ...styles.btnSecondary, opacity: entities.length ? 1 : 0.5 }} disabled={!entities.length} onClick={addRelationshipFromToolbar}>
          + Add relationship
        </button>
        <span style={styles.hint}>
          Drag a right connector to a left connector to create a relationship
        </span>
      </div>

      <div style={styles.main}>
        <div style={styles.flowContainer} ref={flowContainer} tabIndex={-1}
          onKeyDownCapture={event => {
            if (relationshipDialog || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !['Delete', 'Backspace'].includes(event.key)) return;
            const focusedEdge = event.target instanceof Element ? event.target.closest('.react-flow__edge') : null;
            const id = focusedEdge?.getAttribute('data-id');
            if (!id) return;
            // List selection and React Flow's internal edge store synchronize
            // after paint. Delete must act on the SVG that owns focus even if
            // the very next keystroke arrives before that selection is copied.
            event.preventDefault(); event.stopPropagation();
            if (!event.repeat) removeRelationship(id);
            flowContainer.current?.focus();
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onInit={instance => { flowInstance.current = instance; }}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onDoubleClick={onPaneDoubleClick}
            onEdgeClick={onEdgeClick}
            // Keep the listener installed when focus changes: installing it
            // in an effect after SVG focus can miss the very next key press.
            // The live focus guard below decides whether deletion is allowed.
            deleteKeyCode={schemaDeleteKeys}
            onBeforeDelete={async () => {
              const focused = document.activeElement;
              return !relationshipDialog && !!flowContainer.current?.contains(focused) && !!focused?.closest('.react-flow__node, .react-flow__edge');
            }}
            onMoveStart={event => { if (event) { viewportInteracted.current = true; if (addedEntityFit) addedEntityFit.interacted.current = true; } }}
            onNodeDragStart={() => { viewportInteracted.current = true; if (addedEntityFit) addedEntityFit.interacted.current = true; }}
            nodeTypes={nodeTypes}
            // React Flow zooms on double-click by default and consumes the
            // event, so the gesture the toolbar advertises never reached the
            // handler above — "double-click canvas to add entity" did nothing.
            zoomOnDoubleClick={false}
            snapToGrid
            snapGrid={[16, 16]}
          >
            <InitialSchemaFit interacted={viewportInteracted} />
            {addedEntityFit && <InitialSchemaFit key={addedEntityFit.id} requiredNodeId={addedEntityFit.id} interacted={addedEntityFit.interacted} />}
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--line)" />
            <Controls fitViewOptions={schemaFitOptions} />
            {/* A minimap of nothing is a grey rectangle claiming a corner of the
                canvas for no reason. It appears once there is something to map. */}
            {entities.length > 0 && (
              <MiniMap
                nodeColor={(node) => (node.selected ? 'var(--coral)' : 'var(--dimmer)')}
                style={{ background: 'var(--ink)' }}
              />
            )}
          </ReactFlow>

          {/* The empty canvas used to say nothing at all. The only instructions
              were eleven-pixel grey text in the far top-right corner, on the
              opposite side of a 1300px canvas from where anyone looks first —
              so the screen that opens the Data section read as broken rather
              than empty. This sits where the eye lands and offers the action. */}
          {entities.length === 0 && (
            <div style={styles.emptyOverlay}>
              <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="var(--dimmer)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
                <path d="M4.5 5.5v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6" />
                <path d="M4.5 11.5v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6" />
              </svg>
              <div style={styles.emptyTitle}>No collections yet</div>
              <p style={styles.emptyBody}>
                A collection is a table your app reads and writes — customers, invoices, whatever
                it keeps. Add one, give it fields, and it ships inside the bundle as an{' '}
                <code style={styles.emptyCode}>.xdb</code> file.
              </p>
              <button style={styles.emptyBtn} onClick={handleAddEntity}>
                + Add your first collection
              </button>
              <p style={styles.emptyHint}>
                Or double-click anywhere on the canvas. Drag between two collections to relate them.
              </p>
            </div>
          )}
        </div>

        <aside style={{ width: 300, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--ink-2)', borderLeft: '1px solid var(--line-soft)' }} aria-label="Schema details">
          <div role="tablist" aria-label="Schema details" style={{ display: 'flex', borderBottom: '1px solid var(--line-soft)', flexShrink: 0 }}>
            {(['collection', 'relationships'] as const).map(tab => (
              <button key={tab} id={`schema-${tab}-tab`} role="tab" tabIndex={panel === tab ? 0 : -1} aria-selected={panel === tab} aria-controls={`schema-${tab}-panel`} onClick={() => setPanel(tab)}
                onKeyDown={event => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const next = event.key === 'Home' ? 'collection' : event.key === 'End' ? 'relationships' : panel === 'collection' ? 'relationships' : 'collection';
                  setPanel(next);
                  event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#schema-${next}-tab`)?.focus();
                }}
                style={{ flex: 1, padding: '10px 8px', background: 'transparent', border: 0, borderBottom: `2px solid ${panel === tab ? 'var(--coral)' : 'transparent'}`, color: panel === tab ? 'var(--paper)' : 'var(--dim)', cursor: 'pointer', fontSize: 12 }}>
                {tab === 'collection' ? 'Collection' : `Relationships (${relationships.length})`}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`schema-${panel}-panel`} aria-labelledby={`schema-${panel}-tab`} style={{ minHeight: 0, flex: 1, display: 'flex', overflow: 'hidden' }}>
            {panel === 'collection' ? <EntityEditor /> : <RelationshipList entities={entities} relationships={relationships} selectedId={selectedRelationshipId} onSelect={id => { setSelectedRelationshipId(id); selectEntity(null); }} onEdit={editRelationship} onRemove={removeRelationship} onAdd={addRelationshipFromToolbar} />}
          </div>
        </aside>
      </div>

      <DataEntryPanel />
      {relationshipDialog && <RelationshipDialog
        key={relationshipDialog.key}
        entities={entities}
        initial={relationshipDialog.initial}
        editing={!!relationshipDialog.id}
        onSave={draft => relationshipDialog.id ? updateRelationship(relationshipDialog.id, draft) : addRelationship(draft)}
        onClose={() => setRelationshipDialog(null)}
      />}
    </div>
  );
}
