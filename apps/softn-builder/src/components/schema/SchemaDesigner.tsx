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
  Connection,
  Edge,
  Node,
  BackgroundVariant,
  type NodeTypes,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useSchemaStore } from '../../stores/schemaStore';
import { EntityNode } from './EntityNode';
import { EntityEditor } from './EntityEditor';
import { DataEntryPanel } from './DataEntryPanel';

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
    overflow: 'hidden',
  },
  flowContainer: {
    flex: 1,
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

export function SchemaDesigner() {
  const {
    entities,
    relationships,
    selectedEntityId,
    addEntity,
    updateEntity,
    selectEntity,
    deleteEntity,
    addRelationship,
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
      relationships.map((rel) => ({
        id: rel.id,
        source: rel.sourceEntityId,
        target: rel.targetEntityId,
        label: rel.type,
        type: 'smoothstep',
        animated: true,
        style: { stroke: 'var(--dimmer)' },
      })),
    [relationships]
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
    setEdges(
      relationships.map((rel) => ({
        id: rel.id,
        source: rel.sourceEntityId,
        target: rel.targetEntityId,
        label: rel.type,
        type: 'smoothstep',
        animated: true,
        style: { stroke: 'var(--dimmer)' },
      }))
    );
  }, [relationships, setEdges]);

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
          selectEntity(change.selected ? change.id : null);
        }
        // Pressing Delete removed the node from the canvas and left the entity
        // in the schema: it vanished from the diagram, kept its seed rows, and
        // came straight back on the next render from the store.
        if (change.type === 'remove') {
          deleteEntity(change.id);
        }
      }
    },
    [onNodesChange, updateEntity, selectEntity, deleteEntity]
  );

  // Handle edge connections
  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        addRelationship({
          sourceEntityId: connection.source,
          sourceFieldId: '',
          targetEntityId: connection.target,
          type: 'one-to-many',
        });
      }
    },
    [addRelationship]
  );

  // Handle node selection
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      selectEntity(node.id);
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
      const bounds = target.getBoundingClientRect();
      addEntity({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    },
    [addEntity]
  );

  // Handle background click to deselect
  const onPaneClick = useCallback(() => {
    selectEntity(null);
  }, [selectEntity]);

  // Handle edge deletion
  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      if (window.confirm('Delete this relationship?')) {
        deleteRelationship(edge.id);
      }
    },
    [deleteRelationship]
  );

  const handleAddEntity = useCallback(() => {
    // Add entity at center of canvas
    addEntity({ x: 100 + entities.length * 50, y: 100 + entities.length * 30 });
  }, [addEntity, entities.length]);

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <span style={styles.toolbarTitle}>Schema Designer</span>
        <button style={styles.btn} onClick={handleAddEntity}>
          + Add Entity
        </button>
        <span style={styles.hint}>
          Double-click canvas to add entity • Drag between nodes to connect
        </span>
      </div>

      <div style={styles.main}>
        <div style={styles.flowContainer}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onDoubleClick={onPaneDoubleClick}
            onEdgeClick={onEdgeClick}
            nodeTypes={nodeTypes}
            // React Flow zooms on double-click by default and consumes the
            // event, so the gesture the toolbar advertises never reached the
            // handler above — "double-click canvas to add entity" did nothing.
            zoomOnDoubleClick={false}
            fitView
            snapToGrid
            snapGrid={[16, 16]}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--line)" />
            <Controls />
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

        <EntityEditor />
      </div>

      <DataEntryPanel />
    </div>
  );
}
