/* Sidebar icons that act out their meaning on hover (bars grow, bell swings,
   gear turns…). The row needs class "si-item"; motion lives in shell.css.
   Icons without an animated version fall back to the normal icon set. */
import { Icon } from "@/components/ui";

const P = { pathLength: 1 };
const ICONS = {
  board: (
    <svg className="si si-board" viewBox="0 0 24 24"><rect {...P} x="3" y="4" width="4.5" height="16" rx="1.5" /><rect {...P} x="9.75" y="4" width="4.5" height="11" rx="1.5" /><rect {...P} x="16.5" y="4" width="4.5" height="7" rx="1.5" /></svg>
  ),
  list: (
    <svg className="si si-list" viewBox="0 0 24 24"><path {...P} d="M9 6h11" /><path {...P} d="M9 12h11" /><path {...P} d="M9 18h11" /><circle {...P} cx="4.5" cy="6" r="1" /><circle {...P} cx="4.5" cy="12" r="1" /><circle {...P} cx="4.5" cy="18" r="1" /></svg>
  ),
  doc: (
    <svg className="si si-docs" viewBox="0 0 24 24"><g className="si-pg"><path {...P} d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path {...P} d="M14 3v5h5" /></g><path {...P} className="si-ln" d="M9 13h6" /><path {...P} className="si-ln" d="M9 17h4" /></svg>
  ),
  alarm: (
    <svg className="si si-remind" viewBox="0 0 24 24"><circle {...P} cx="12" cy="13" r="7" /><path {...P} className="si-hand" d="M12 9.5V13l2.2 1.6" /><path {...P} d="M5 4 3 6" /><path {...P} d="m19 4 2 2" /></svg>
  ),
  bell: (
    <svg className="si si-notif" viewBox="0 0 24 24"><g className="si-bell"><path {...P} d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z" /></g><path {...P} className="si-clap" d="M10 20.5a2 2 0 0 0 4 0" /></svg>
  ),
  book: (
    <svg className="si si-manual" viewBox="0 0 24 24"><path {...P} d="M12 6.5C10 5 7 4.5 4 5v13.5c3-.5 6 0 8 1.5z" /><path {...P} className="si-pr" d="M12 6.5C14 5 17 4.5 20 5v13.5c-3-.5-6 0-8 1.5z" /></svg>
  ),
  live: (
    <svg className="si si-live" viewBox="0 0 24 24"><path {...P} className="si-pulse" d="M2.5 12h4l2.2-5.5 4.3 11 2.3-5.5h3.2" /><circle {...P} className="si-ring" cx="20.5" cy="12" r="1.3" strokeWidth="1.2" /><circle {...P} cx="20.5" cy="12" r="1.3" /></svg>
  ),
  inbox: (
    <svg className="si si-queue" viewBox="0 0 24 24"><path {...P} d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" /><path {...P} d="M3 13h5l1.5 2.5h5L16 13h5" /><path {...P} className="si-qitem" d="M9.5 9.5h5" /></svg>
  ),
  upload: (
    <svg className="si si-upload" viewBox="0 0 24 24"><g className="si-arr"><path {...P} d="M12 15V4" /><path {...P} d="M7.5 8.5 12 4l4.5 4.5" /></g><path {...P} d="M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2" /></svg>
  ),
  dash: (
    <svg className="si si-dash" viewBox="0 0 24 24"><rect {...P} x="3.5" y="3.5" width="7" height="9" rx="1.5" /><rect {...P} x="13.5" y="3.5" width="7" height="5" rx="1.5" /><rect {...P} x="13.5" y="11.5" width="7" height="9" rx="1.5" /><rect {...P} x="3.5" y="15.5" width="7" height="5" rx="1.5" /></svg>
  ),
  people: (
    <svg className="si si-people" viewBox="0 0 24 24"><g className="si-p1"><circle {...P} cx="9" cy="8" r="3.2" /><path {...P} d="M3 19.5c.6-3.3 3-5 6-5s5.4 1.7 6 5" /></g><g className="si-p2"><circle {...P} cx="17" cy="9" r="2.5" /><path {...P} d="M16.5 14.5c2.4.1 4 1.6 4.6 4.5" /></g></svg>
  ),
  chart: (
    <svg className="si si-reports" viewBox="0 0 24 24"><path {...P} d="M3.5 20h17" /><rect {...P} className="si-bar" x="5.5" y="13" width="3" height="7" rx="1" /><rect {...P} className="si-bar" x="10.5" y="7" width="3" height="13" rx="1" /><rect {...P} className="si-bar" x="15.5" y="10" width="3" height="10" rx="1" /></svg>
  ),
  gear: (
    <svg className="si si-settings" viewBox="0 0 24 24"><circle {...P} cx="12" cy="12" r="3.2" /><path {...P} d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" /></svg>
  ),
  timeline: (
    <svg className="si si-timeline" viewBox="0 0 24 24"><path {...P} className="si-tl" d="M3 12h18" /><circle {...P} className="si-dot" cx="6" cy="12" r="2" /><circle {...P} className="si-dot" cx="12" cy="12" r="2" /><circle {...P} className="si-dot" cx="18" cy="12" r="2" /><path {...P} d="M6 6.5v3M12 4.5v5M18 7.5v2" /></svg>
  ),
  camera: (
    <svg className="si si-camera" viewBox="0 0 24 24"><path {...P} d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" /><circle {...P} className="si-lens" cx="12" cy="13.2" r="3.3" /><circle {...P} className="si-flash" cx="17.6" cy="10.6" r=".6" /></svg>
  ),
};

export default function SideIcon({ n }) {
  /* Any icon without its own motion still gets a small wiggle (shell.css). */
  return ICONS[n] || <span className="si-fallback"><Icon n={n} size={20} /></span>;
}
