/* Inline stroke icons (the set the design canvas uses). <Icon n="board" size={20} /> */
const PATHS = {
  chev: ['0 0 16 16', '<path d="M4 6l4 4 4-4"/>'],
  cright: ['0 0 16 16', '<path d="M6 4l4 4-4 4"/>'],
  cleft: ['0 0 16 16', '<path d="M10 4L6 8l4 4"/>'],
  search: ['0 0 24 24', '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'],
  plus: ['0 0 24 24', '<path d="M12 5v14M5 12h14"/>'],
  bell: ['0 0 24 24', '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>'],
  board: ['0 0 24 24', '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="8" rx="1"/>'],
  list: ['0 0 24 24', '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'],
  timeline: ['0 0 24 24', '<path d="M3 7h10M7 12h12M3 17h8"/>'],
  doc: ['0 0 24 24', '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>'],
  alarm: ['0 0 24 24', '<circle cx="12" cy="13" r="7"/><path d="M12 9v4l3 2M5 4l2 2M19 4l-2 2"/>'],
  live: ['0 0 24 24', '<path d="M3 12h4l3-7 4 14 3-7h4"/>'],
  inbox: ['0 0 24 24', '<path d="M3 13l2-8h14l2 8v6H3z"/><path d="M3 13h5l1 2h6l1-2h5"/>'],
  dash: ['0 0 24 24', '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="5" rx="1"/><rect x="13" y="10" width="8" height="11" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/>'],
  chart: ['0 0 24 24', '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>'],
  gear: ['0 0 24 24', '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'],
  people: ['0 0 24 24', '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 15.5a5 5 0 0 1 5.5 4.5"/>'],
  camera: ['0 0 24 24', '<path d="M4 8h4l2-3h4l2 3h4v12H4z"/><circle cx="12" cy="13" r="3.5"/>'],
  book: ['0 0 24 24', '<path d="M4 4h7v16H4zM13 4h7v16h-7z"/>'],
  upload: ['0 0 24 24', '<path d="M12 16V4M6 10l6-6 6 6M4 20h16"/>'],
  download: ['0 0 24 24', '<path d="M12 4v12M6 10l6 6 6-6M4 20h16"/>'],
  user: ['0 0 24 24', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
  home: ['0 0 24 24', '<path d="M3 11l9-7 9 7v10H3z"/><path d="M10 21v-6h4v6"/>'],
  cash: ['0 0 24 24', '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>'],
  check: ['0 0 24 24', '<path d="M4 12l5 5L20 6"/>'],
  x: ['0 0 24 24', '<path d="M6 6l12 12M18 6L6 18"/>'],
  more: ['0 0 24 24', '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>'],
  pen: ['0 0 24 24', '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M13 7l4 4"/>'],
  trash: ['0 0 24 24', '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'],
  pause: ['0 0 24 24', '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'],
  play: ['0 0 24 24', '<path d="M7 4l12 8-12 8z"/>'],
  zip: ['0 0 24 24', '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M10 3v4h4V3M10 11h4M10 15h4"/>'],
  eye: ['0 0 24 24', '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'],
  eyeoff: ['0 0 24 24', '<path d="M3 3l18 18M10.6 10.6A3 3 0 0 0 13.4 13.4M9.9 5.1A10.4 10.4 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C4 8.4 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 3.4-.6"/>'],
  cal: ['0 0 24 24', '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'],
  flag: ['0 0 24 24', '<path d="M5 21V4h12l-2 4 2 4H5"/>'],
  link: ['0 0 24 24', '<path d="M10 14a4 4 0 0 1 0-5.7l3-3a4 4 0 0 1 5.7 5.7l-1.5 1.5"/><path d="M14 10a4 4 0 0 1 0 5.7l-3 3a4 4 0 0 1-5.7-5.7L6.8 11.5"/>'],
  menu: ['0 0 24 24', '<path d="M4 7h16M4 12h16M4 17h16"/>'],
  swap: ['0 0 24 24', '<path d="M4 7h12l-3-3M20 17H8l3 3"/>'],
  warn: ['0 0 24 24', '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17h.01"/>'],
  info: ['0 0 24 24', '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'],
  palette: ['0 0 24 24', '<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h3a5 5 0 0 0 5-5c0-3-4-5-8-5z"/><circle cx="7.5" cy="11" r="1" fill="currentColor"/><circle cx="10" cy="7" r="1" fill="currentColor"/><circle cx="15" cy="7" r="1" fill="currentColor"/>'],
  logout: ['0 0 24 24', '<path d="M10 4H5v16h5M14 8l5 4-5 4M19 12H9"/>'],
  up: ['0 0 16 16', '<path d="M4 10l4-4 4 4"/>'],
  up2: ['0 0 16 16', '<path d="M4 9l4-4 4 4M4 13l4-4 4 4"/>'],
  dash1: ['0 0 16 16', '<path d="M4 8h8"/>'],
  clock: ['0 0 24 24', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  paperclip: ['0 0 24 24', '<path d="M21 12l-8.5 8.5a5 5 0 0 1-7-7L14 5a3.3 3.3 0 0 1 4.7 4.7L10.5 18a1.6 1.6 0 0 1-2.3-2.3L16 8"/>'],
  filter: ['0 0 24 24', '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>'],
  sun: ['0 0 24 24', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'],
  moon: ['0 0 24 24', '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>'],
  monitor: ['0 0 24 24', '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'],
  star: ['0 0 24 24', '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>'],
  bolt: ['0 0 24 24', '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'],
  copy: ['0 0 24 24', '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>'],
  branch: ['0 0 24 24', '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11 8"/>'],
};

export default function Icon({ n, size = 20, stroke = 2, className = "", label }) {
  const def = PATHS[n] || PATHS.info;
  const [viewBox, inner] = def;
  return (
    <svg
      className={className} width={size} height={size} viewBox={viewBox} fill="none" stroke="currentColor"
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden={label ? undefined : "true"} role={label ? "img" : undefined} aria-label={label}
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}

export const ICONS = Object.keys(PATHS);
