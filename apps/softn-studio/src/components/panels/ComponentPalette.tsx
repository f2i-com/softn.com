import React, { useState } from 'react';
import { Icon } from '../common/Icon';

interface PaletteComponent {
  name: string;
  icon: string;
}

interface PaletteCategory {
  name: string;
  components: PaletteComponent[];
}

const categories: PaletteCategory[] = [
  {
    name: 'Layout',
    components: [
      { name: 'Stack', icon: 'S' },
      { name: 'Box', icon: 'B' },
      { name: 'Card', icon: 'C' },
      { name: 'Grid', icon: 'G' },
      { name: 'Container', icon: 'Co' },
      { name: 'Section', icon: 'Se' },
      { name: 'Sidebar', icon: 'Sb' },
      { name: 'Split', icon: 'Sp' },
    ],
  },
  {
    name: 'Form',
    components: [
      { name: 'Button', icon: 'Bt' },
      { name: 'Input', icon: 'In' },
      { name: 'TextArea', icon: 'Ta' },
      { name: 'Select', icon: 'Sl' },
      { name: 'Checkbox', icon: 'Cb' },
      { name: 'Switch', icon: 'Sw' },
      { name: 'Radio', icon: 'Ra' },
      { name: 'Slider', icon: 'Sr' },
      { name: 'DatePicker', icon: 'Dp' },
      { name: 'ColorPicker', icon: 'Cp' },
      { name: 'FileChooser', icon: 'Fc' },
    ],
  },
  {
    name: 'Display',
    components: [
      { name: 'Text', icon: 'Tx' },
      { name: 'Heading', icon: 'Hd' },
      { name: 'Badge', icon: 'Bg' },
      { name: 'Avatar', icon: 'Av' },
      { name: 'Progress', icon: 'Pr' },
      { name: 'Image', icon: 'Im' },
      { name: 'Icon', icon: 'Ic' },
    ],
  },
  {
    name: 'Feedback',
    components: [
      { name: 'Alert', icon: 'Al' },
      { name: 'Modal', icon: 'Mo' },
      { name: 'Toast', icon: 'To' },
      { name: 'Drawer', icon: 'Dr' },
      { name: 'EmptyState', icon: 'Em' },
    ],
  },
  {
    name: 'Data',
    components: [
      { name: 'Table', icon: 'Tb' },
      { name: 'List', icon: 'Li' },
      { name: 'DataGrid', icon: 'Dg' },
      { name: 'Pagination', icon: 'Pg' },
    ],
  },
  {
    name: 'Navigation',
    components: [
      { name: 'Tabs', icon: 'Ts' },
      { name: 'Menu', icon: 'Mn' },
      { name: 'Breadcrumb', icon: 'Bc' },
    ],
  },
  {
    name: 'Smart',
    components: [
      { name: 'SmartGrid', icon: 'SG' },
      { name: 'SmartForm', icon: 'SF' },
      { name: 'SmartCards', icon: 'SC' },
      { name: 'SmartStats', icon: 'SS' },
      { name: 'SmartList', icon: 'SL' },
      { name: 'SmartTimeline', icon: 'ST' },
    ],
  },
  {
    name: 'Charts',
    components: [
      { name: 'LineChart', icon: 'LC' },
      { name: 'BarChart', icon: 'BC' },
      { name: 'PieChart', icon: 'PC' },
      { name: 'AreaChart', icon: 'AC' },
    ],
  },
];

export const ComponentPalette: React.FC = () => {
  const [search, setSearch] = useState('');
  const [expandedCat, setExpandedCat] = useState<string>('Layout');

  const filtered = search
    ? categories.map((c) => ({
        ...c,
        components: c.components.filter((comp) =>
          comp.name.toLowerCase().includes(search.toLowerCase()),
        ),
      })).filter((c) => c.components.length > 0)
    : categories;

  return (
    <div style={styles.container}>
      {/* Search */}
      <div style={styles.searchRow}>
        <Icon name="search" size={14} color="var(--studio-text-dim)" />
        <input
          style={styles.searchInput}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search components..."
        />
      </div>

      {/* Categories */}
      <div style={styles.list}>
        {filtered.map((cat) => (
          <div key={cat.name}>
            <button
              onClick={() => setExpandedCat(expandedCat === cat.name ? '' : cat.name)}
              style={styles.catHeader}
            >
              <Icon
                name={expandedCat === cat.name ? 'chevron-down' : 'chevron-right'}
                size={14}
              />
              <span style={styles.catName}>{cat.name}</span>
              <span style={styles.catCount}>{cat.components.length}</span>
            </button>
            {(expandedCat === cat.name || search) && (
              <div style={styles.grid}>
                {cat.components.map((comp) => (
                  <div
                    key={comp.name}
                    style={styles.componentCard}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('softn/component', comp.name);
                    }}
                  >
                    <div style={styles.compIcon}>{comp.icon}</div>
                    <span style={styles.compName}>{comp.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
  },
  searchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderBottom: '1px solid var(--studio-border)',
  },
  searchInput: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    color: 'var(--studio-text)',
    fontSize: 12,
    outline: 'none',
    fontFamily: 'inherit',
  },
  list: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
    padding: '4px 0',
  },
  catHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '8px 12px',
    background: 'transparent',
    border: 'none',
    color: 'var(--studio-text-muted)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
  },
  catName: {
    flex: 1,
  },
  catCount: {
    fontSize: 10,
    color: 'var(--studio-text-dim)',
    background: 'var(--studio-surface-hover)',
    padding: '1px 6px',
    borderRadius: 8,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 4,
    padding: '4px 10px 8px',
  },
  componentCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    padding: '10px 4px',
    background: 'var(--studio-surface)',
    border: '1px solid var(--studio-border-subtle)',
    borderRadius: 6,
    cursor: 'grab',
    transition: 'all 0.15s',
    userSelect: 'none',
  },
  compIcon: {
    width: 28,
    height: 28,
    borderRadius: 6,
    background: 'var(--studio-accent-soft)',
    color: 'var(--studio-accent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 10,
    fontWeight: 700,
  },
  compName: {
    fontSize: 10,
    color: 'var(--studio-text-muted)',
    textAlign: 'center',
  },
};
