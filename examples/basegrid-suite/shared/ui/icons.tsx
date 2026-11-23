import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

const base = (size = 15) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.85,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  style: { flexShrink: 0, display: 'inline-block' } as React.CSSProperties,
});

export const IconGrid: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <path d="M3 9h18M3 15h18M9 3v18M15 9v12" />
  </svg>
);

export const IconKanban: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="4" width="5" height="15" rx="1.5" />
    <rect x="10" y="4" width="5" height="10" rx="1.5" />
    <rect x="17" y="4" width="4" height="13" rx="1.5" />
  </svg>
);

export const IconCalendar: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="4" width="18" height="17" rx="2.5" />
    <path d="M8 2v4M16 2v4M3 10h18" />
  </svg>
);

export const IconGallery: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="3" width="8" height="8" rx="2" />
    <rect x="13" y="3" width="8" height="8" rx="2" />
    <rect x="3" y="13" width="8" height="8" rx="2" />
    <rect x="13" y="13" width="8" height="8" rx="2" />
  </svg>
);

export const IconTimeline: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M3 6h9M8 12h11M5 18h8" strokeWidth="2.4" />
    <circle cx="15" cy="6" r="1.5" fill="currentColor" />
    <circle cx="16" cy="18" r="1.5" fill="currentColor" />
  </svg>
);

export const IconList: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
  </svg>
);

export const IconInbox: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M4 4h16l2 10v6H2v-6L4 4z" />
    <path d="M2 14h6l2 3h4l2-3h6" />
  </svg>
);

export const IconPlus: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconSearch: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const IconFilter: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M3 5h18l-7 8v6l-4-2v-4L3 5z" />
  </svg>
);

export const IconSort: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M8 6v12M4 10l4-4 4 4M16 18V6M12 14l4 4 4-4" />
  </svg>
);

export const IconLayers: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="m12 3 9 4.5-9 4.5-9-4.5L12 3z" />
    <path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5" />
  </svg>
);

export const IconSparkles: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
    <path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z" />
  </svg>
);

export const IconBolt: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
  </svg>
);

export const IconGlobe: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18" />
  </svg>
);

export const IconSync: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M21 12a9 9 0 0 1-15.5 6.3M3 12a9 9 0 0 1 15.5-6.3" />
    <path d="M21 5v5h-5M3 19v-5h5" />
  </svg>
);

export const IconShield: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3 4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-3z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

export const IconDatabase: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </svg>
);

export const IconForm: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="4" y="3" width="16" height="18" rx="2.5" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </svg>
);

export const IconChart: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M4 19h16M7 16V9M12 16V5M17 16v-4" />
  </svg>
);

export const IconChat: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M21 12a8 8 0 0 1-11.7 7.1L4 20l1.1-4.8A8 8 0 1 1 21 12z" />
  </svg>
);

export const IconHistory: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5M12 7v5l3 2" />
  </svg>
);

export const IconPlay: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <polygon points="6,4 20,12 6,20" fill="currentColor" stroke="none" />
  </svg>
);

export const IconDownload: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M12 4v11M7 11l5 5 5-5M4 19h16" />
  </svg>
);

export const IconUpload: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M12 16V5M7 9l5-5 5 5M4 19h16" />
  </svg>
);

export const IconTrash: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M4 6h16M10 6V4h4v2M6 6l1 14h10l1-14" />
  </svg>
);

export const IconCheck: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="m5 12 4.5 4.5L19 7" />
  </svg>
);

export const IconLink: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M10 13a5 5 0 0 0 7.54.54l2.92-2.92a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-2.92 2.92a5 5 0 0 0 7.07 7.07l1.5-1.5" />
  </svg>
);

export const IconEye: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconClose: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const IconCopy: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
