const paths = {
  finance: <><path d="M4 19V9m5 10V5m5 14v-8m5 8V3M2 21h20" /></>,
  operations: <><path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" /></>,
  insurance: <><path d="M12 2 4 6v6c0 5 8 10 8 10s8-5 8-10V6l-8-4Z" /><path d="m8 12 3 3 5-6" /></>,
  corporate: <><path d="M4 21V4h11v17M15 10h5v11M2 21h20M8 8h3M8 12h3M8 16h3" /></>,
  people: <><circle cx="9" cy="7" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-3-5" /></>,
  marketing: <><path d="M3 10h5l12-6v16L8 14H3v-4Zm5 4 2 7H6l-1-7m15-5 2 1v4l-2 1" /></>,
  commercial: <><path d="M3 17 9 11l4 4 8-10m-6 0h6v6M3 21h18" /></>,
  procurement: <><path d="M4 8h16l-1 13H5L4 8Zm4 0V6a4 4 0 0 1 8 0v2" /></>,
  compliance: <><path d="M12 3v17M5 6h14M3 14l3-7 3 7H3Zm12 0 3-7 3 7h-6ZM7 21h10" /></>,
  quality: <><circle cx="12" cy="9" r="6" /><path d="m9 9 2 2 4-4M8 14l-2 8 6-3 6 3-2-8" /></>,
  technology: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4M10 10h4v4h-4z" /></>,
};
export const AREA_COLORS = ['#52ddf5','#8faaff','#60e6ba','#69c8ff','#d9a0ff','#db9bfa','#72dcc9','#f2c780','#87b9ff','#8edbc2','#b6a5fc'];
export default function AreaIcon({ id }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[id] || paths.technology}</svg>;
}
