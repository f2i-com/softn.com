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
    background: '#f8fafc',
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
  toolbar: {
    padding: '8px 16px',
    borderBottom: '1px solid #e2e8f0',
    background: '#fff',
    display: 'flex',
    gap: 12,
    alignItems: 'center',
  },
  toolbarTitle: {
    fontWeight: 600,
    fontSize: 14,
    color: '#1e293b',
    marginRight: 16,
  },
  btn: {
    padding: '6px 12px',
    background: '#3b82f6',
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
    background: '#f1f5f9',
    color: '#374151',
  },
  hint: {
    marginLeft: 'auto',
    fontSize: 11,
    color: '#94a3b8',
  },
};

const nodeTypes: NodeTypes = {
  entity: EntityNode as any,
};

export function SchemaDesigner() {
  const {
    entities,
    relationships,
    selectedEntityId,
    addEntity,
    updateEntity,
    selectEntity,
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
        style: { stroke: '#94a3b8' },
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
        style: { stroke: '#94a3b8' },
      }))
    );
  }, [relationships, setEdges]);

  // Handle node position changes
  const handleNodesChange = useCallback(
    (changes: any) => {
      onNodesChange(changes);

      // Update positions in store
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          updateEntity(change.id, { position: change.position });
        }
      }
    },
    [onNodesChange, updateEntity]
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
      const bounds = (event.target as HTMLElement).getBoundingClientRect();
      const position = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      };
      addEntity(position);
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
            fitView
            snapToGrid
            snapGrid={[16, 16]}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#cbd5e1" />
            <Controls />
            <MiniMap
              nodeColor={(node) => (node.selected ? '#3b82f6' : '#94a3b8')}
              style={{ background: '#f8fafc' }}
            />
          </ReactFlow>
        </div>

        <EntityEditor />
      </div>

      <DataEntryPanel />
    </div>
  );
}
