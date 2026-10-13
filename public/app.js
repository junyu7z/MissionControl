/* ============================================================
 *  Mission Control — board UI
 *
 *  Data lives on the server (see /server). This file keeps an in-memory
 *  copy in the shapes the renderers below were built around:
 *    PROJECTS        [{ id, title, key, status, tint, description,
 *                       startDate:{mode,date}, endDate:{mode,date},
 *                       members:[{id,userId,role}], milestones:[...], items:[...] }]
 *    TEAM_OTHERS     userId -> work items that belong to no project
 *    MEMBER_LEAVES   userId -> time-off entries
 *    USERS           userId -> { id, name, email, active, isAdmin }
 *  Every edit updates this copy immediately (so the UI stays snappy) and is
 *  saved through the `Save` helpers; changes made by teammates arrive over
 *  the realtime stream and are merged in by `applyRemoteEvent`.
 *
 *  All dates are 'YYYY-MM-DD' strings (calendar days, no timezone).
 * ============================================================ */

/* ------------------------------------------------------------
 *  Calendar + timeline
 * ------------------------------------------------------------ */
const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const DOW = ["SUN","MON","TUE","WED","THU","FRI","SAT"];

function isWorkday(d){ const x=d.getDay(); return x!==0 && x!==6; }
function addDays(d,n){ const c=new Date(d); c.setDate(c.getDate()+n); return c; }
function toISODate(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function parseISODate(s){
  const [y,m,d] = String(s).split('-').map(Number);
  return new Date(y, (m||1)-1, d||1);
}
/* Today in the viewer's own timezone — teammates in different timezones each see their own "today". */
function localToday(){ const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function todayISO(){ return toISODate(localToday()); }
const capWord = s => s.charAt(0) + s.slice(1).toLowerCase();
/* "MAY 4" — compact label used in lists and pickers. */
function fmtShortDate(iso){ const d = parseISODate(iso); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; }
/* "2026/05/04" — label on the date buttons in popovers. */
function fmtSlashDate(iso){ return String(iso || '').replace(/-/g, '/'); }

let TODAY = localToday();
let SPRINT = { anchorDate: '2026-04-27', anchorNumber: 29 };
function sprintAnchor(){ return parseISODate(SPRINT.anchorDate); }

function workdayDelta(date){
  // signed workday count between the sprint anchor and date
  const anchor = sprintAnchor();
  const a = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const b = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if(b.getTime() === a.getTime()) return 0;
  const sign = b > a ? 1 : -1;
  let lo = sign>0 ? a : b, hi = sign>0 ? b : a;
  let n = 0;
  const c = new Date(lo);
  while(c < hi){
    c.setDate(c.getDate() + 1);
    if(isWorkday(c)) n++;
  }
  return sign * n;
}

function buildTimeline(){
  // Range: 6 months back to 12 months forward, snapped to Mon..Fri week boundaries
  let start = new Date(TODAY); start.setMonth(start.getMonth()-6);
  let end   = new Date(TODAY); end.setMonth(end.getMonth()+12);
  while(start.getDay() !== 1) start = addDays(start, 1);   // first Monday
  while(end.getDay() !== 5) end = addDays(end, -1);        // last Friday

  const out = [];
  let wd = workdayDelta(start);
  for(let c = new Date(start); c <= end; c = addDays(c,1)){
    if(!isWorkday(c)) continue;
    const sprintOffset = Math.floor(wd / 10);
    const wdMod = ((wd % 10) + 10) % 10;
    const dow = c.getDay();
    out.push({
      date: new Date(c),
      iso: toISODate(c),
      ts: c.getTime(),
      d: DOW[dow],
      n: c.getDate(),
      m: MONTHS[c.getMonth()],
      y: c.getFullYear(),
      sprint: SPRINT.anchorNumber + sprintOffset,
      week: wdMod < 5 ? 1 : 2,
      today: c.getTime() === TODAY.getTime(),
      weekStart: dow === 1,
    });
    wd++;
  }
  return out;
}

let TIMELINE = [];
let TIMELINE_INDEX = new Map(); // iso -> index
let TODAY_IDX = -1;
function rebuildTimeline(){
  TODAY = localToday();
  TIMELINE = buildTimeline();
  TIMELINE_INDEX = new Map(TIMELINE.map((t, i) => [t.iso, i]));
  TODAY_IDX = TIMELINE.findIndex(t=>t.today);
  // Weekend "today": point at the following Monday so the Today button still lands sensibly.
  if(TODAY_IDX < 0){
    const ts = TODAY.getTime();
    TODAY_IDX = TIMELINE.findIndex(t => t.ts > ts);
  }
}

/* Current sprint label for the toolbar, e.g. "Sprint 41 | Oct 12 – Oct 23, 2026". */
function currentSprintLabel(){
  const i = Math.max(0, TODAY_IDX);
  const t = TIMELINE[i];
  if(!t) return '';
  let s = i, e = i;
  while(s > 0 && TIMELINE[s-1].sprint === t.sprint) s--;
  while(e < TIMELINE.length-1 && TIMELINE[e+1].sprint === t.sprint) e++;
  const a = TIMELINE[s], b = TIMELINE[e];
  return `Sprint ${t.sprint} | ${capWord(a.m)} ${a.n} – ${capWord(b.m)} ${b.n}, ${b.y}`;
}

function projectTintRangeFromMs(p, msIdxs){
  const total = TIMELINE.length;
  let startIdx = 0, endIdx = total;
  const sd = p.startDate || { mode:'undefined' };
  const ed = p.endDate || { mode:'undefined' };
  if(sd.mode === 'date' && sd.date){
    startIdx = idxOf(sd.date);
  } else if(sd.mode === 'milestone' && msIdxs.length){
    startIdx = Math.min(...msIdxs);
  }
  if(ed.mode === 'date' && ed.date){
    endIdx = idxOf(ed.date) + 1;
  } else if(ed.mode === 'milestone' && msIdxs.length){
    endIdx = Math.max(...msIdxs);
  }
  if(startIdx < 0) startIdx = 0;
  if(endIdx > total) endIdx = total;
  if(endIdx < startIdx) endIdx = startIdx;
  return { startIdx, endIdx };
}
function projectTintRange(p){
  const msIdxs = (p.milestones || []).map(m=> idxOf(m.date));
  return projectTintRangeFromMs(p, msIdxs);
}
/* Timeline index for a 'YYYY-MM-DD' date — weekends and out-of-range dates clamp to the nearest workday. */
function idxOf(iso){
  const exact = TIMELINE_INDEX.get(iso);
  if(exact !== undefined) return exact;
  const target = parseISODate(iso).getTime();
  let best = 0, bestDiff = Infinity;
  for(let i=0;i<TIMELINE.length;i++){
    const diff = Math.abs(TIMELINE[i].ts - target);
    if(diff < bestDiff){ bestDiff = diff; best = i; }
  }
  return best;
}
function isoFromTimelineIdx(i){
  const t = TIMELINE[Math.max(0, Math.min(TIMELINE.length-1, i))];
  return t ? t.iso : todayISO();
}

const TINTS = {
  indigo: { tint: "#6e7cd9", bg: "rgba(110,124,217,0.15)", bgMember: "rgba(110,124,217,0.07)", wi: "rgba(110,124,217,0.16)", wiBd: "#8893de" },
  blue:   { tint: "#4d8ddb", bg: "rgba(77,141,219,0.15)",  bgMember: "rgba(77,141,219,0.07)",  wi: "rgba(77,141,219,0.16)",  wiBd: "#6ea1e0" },
  cyan:   { tint: "#1aa3b8", bg: "rgba(26,163,184,0.15)",  bgMember: "rgba(26,163,184,0.07)",  wi: "rgba(26,163,184,0.16)",  wiBd: "#4fb5c9" },
  teal:   { tint: "#3aaf9b", bg: "rgba(58,175,155,0.15)",  bgMember: "rgba(58,175,155,0.07)",  wi: "rgba(58,175,155,0.16)",  wiBd: "#4fbfa8" },
  green:  { tint: "#5fa961", bg: "rgba(95,169,97,0.15)",   bgMember: "rgba(95,169,97,0.07)",   wi: "rgba(95,169,97,0.16)",   wiBd: "#6fbf73" },
  yellow: { tint: "#d4a017", bg: "rgba(212,160,23,0.15)",  bgMember: "rgba(212,160,23,0.07)",  wi: "rgba(212,160,23,0.18)",  wiBd: "#dcaf3a" },
  orange: { tint: "#e08a3c", bg: "rgba(224,138,60,0.15)",  bgMember: "rgba(224,138,60,0.07)",  wi: "rgba(224,138,60,0.18)",  wiBd: "#e29a4f" },
  rose:   { tint: "#e15c6d", bg: "rgba(225,92,109,0.15)",  bgMember: "rgba(225,92,109,0.07)",  wi: "rgba(225,92,109,0.16)",  wiBd: "#e57787" },
  pink:   { tint: "#d670c2", bg: "rgba(214,112,194,0.15)", bgMember: "rgba(214,112,194,0.07)", wi: "rgba(214,112,194,0.16)", wiBd: "#dc88cc" },
  purple: { tint: "#b75cdd", bg: "rgba(183,92,221,0.15)",  bgMember: "rgba(183,92,221,0.07)",  wi: "rgba(183,92,221,0.16)",  wiBd: "#b07cc6" },
  /* Neutral gray — used for the team-view "Others" row (work that isn't tracked on this board). */
  gray:   { tint: "#a8a39a", bg: "rgba(168,163,154,0.15)", bgMember: "rgba(168,163,154,0.07)", wi: "rgba(168,163,154,0.20)", wiBd: "#bdbab2" },
};

/* ------------------------------------------------------------
 *  People
 * ------------------------------------------------------------ */
const USERS = new Map(); // id -> user
let ME = null;
function userName(uid){
  const u = USERS.get(uid);
  return u ? u.name : 'Unknown';
}
/* Active people, alphabetical — the choices offered in member / owner pickers. */
function workspaceMembers(){
  return [...USERS.values()]
    .filter(u => u.active)
    .sort((a,b)=> a.name.localeCompare(b.name))
    .map(u => u.id);
}
const AVATAR_COLORS = ["#b07cc6","#4fb5c9","#e29a4f","#6fbf73","#4fbfa8","#d97757","#a08acb","#e0a44b"];
function colorForName(name){
  let h = 0; for(const c of name) h = (h*31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initialsForName(name){
  const p = name.split(" ").filter(Boolean);
  return ((p[0]?.[0]||"") + (p[1]?.[0]||"")).toUpperCase();
}
/* Avatar helpers take a user id. Initials are escaped because names are user-entered. */
function avatarColor(uid){ return colorForName(userName(uid)); }
function initials(uid){ return escape(initialsForName(userName(uid))); }

/* ------------------------------------------------------------
 *  Board data (filled from the server by loadState)
 * ------------------------------------------------------------ */
let PROJECTS = [];
let MEMBER_LEAVES = Object.create(null);
let TEAM_OTHERS = Object.create(null);
function othersFor(uid){ return (TEAM_OTHERS[uid] || []).slice(); }
function othersPid(uid){ return `__others__:${uid}`; }

let projectView = 'active'; // 'active' | 'archived'
let viewMode = 'project';   // 'project' | 'team'
const teamExpanded = Object.create(null); // userId -> bool

/* Project expand/collapse is a personal view preference, remembered per browser. */
const EXPANDED_KEY = 'mc.expandedProjects';
function loadExpandedIds(){
  try { return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]')); } catch(_) { return new Set(); }
}
function saveExpandedIds(){
  try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(PROJECTS.filter(p=>p.expanded).map(p=>p.id))); } catch(_) {}
}

/* Ids for new things are made in the browser so an item can be shown and
   edited immediately, before the server has confirmed it. */
function nid(){ return crypto.randomUUID(); }

/* Synthetic project lookup for the per-member "Others" row.
   The sentinel pid is `__others__:<userId>`; we hand the existing drag/resize
   /popover pipeline a project-shaped object whose `items` array is bound live
   to TEAM_OTHERS[member] (via getter/setter so push/=filter both work). */
function othersSyntheticProject(uid){
  const synth = {
    id: othersPid(uid),
    title: 'Others',
    key: '',
    status: '',
    tint: 'gray',
    description: '',
    expanded: true,
    members: [{ id: '__others__', userId: uid, role: 'Other' }],
    milestones: [],
    __isOthers: true,
    __member: uid,
  };
  Object.defineProperty(synth, 'items', {
    get(){ return TEAM_OTHERS[uid] || (TEAM_OTHERS[uid] = []); },
    set(v){ TEAM_OTHERS[uid] = v; },
    configurable: true,
    enumerable: true,
  });
  return synth;
}
function findProject(pid){
  const s = String(pid || '');
  if(s.startsWith('__others__:')) return othersSyntheticProject(s.slice('__others__:'.length));
  return PROJECTS.find(p=> String(p.id) === s);
}
function findMilestone(pid, mid){
  const p = findProject(pid); if(!p) return null;
  return p.milestones.find(m=> String(m.id) === String(mid)) || null;
}
function findItem(pid, wid){
  const p = findProject(pid); if(!p) return null;
  return p.items.find(it=> String(it.id) === String(wid)) || null;
}

/* ============================================================
 *  Component renderers
 * ============================================================ */
const ZOOM_LEVELS = [16, 24, 32, 40, 48, 60, 72, 88, 104, 120, 144, 168];
let zoomIndex = 6; // default 72
let dayW = ZOOM_LEVELS[zoomIndex];
const sidebarW = 320;

const STATUS_CLASS = { "On Track":"ontrack", "At Risk":"atrisk", "Off Track":"offtrack", "Archived":"archived" };

function escape(s){ return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

/* ----------- TopToolbar ----------- */
function TopToolbar(){ return `
  <div class="toolbar">
    <div class="brand">
      <div class="brand-icon">M</div>
      <div>
        <div class="brand-title">Mission Control</div>
        <div class="brand-sub">ArcSite Project Kanban</div>
      </div>
    </div>
    <div class="spacer"></div>
    <div class="seg" role="tablist">
      <button class="${viewMode==='project'?'active':''}" data-view="project">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="10" height="3"/><rect x="2" y="8" width="6" height="3"/></svg>
        By project
      </button>
      <button class="${viewMode==='team'?'active':''}" data-view="team">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="5" r="2"/><circle cx="10" cy="5" r="2"/><path d="M2 12c0-2 1.5-3 3-3s3 1 3 3"/><path d="M8 12c0-2 1.5-3 3-3"/></svg>
        By team
      </button>
    </div>
    <div class="spacer"></div>
    <div class="right-cluster">
      <div class="sprint-range" id="sprintRange">${escape(currentSprintLabel())}</div>
      <button class="btn" id="todayBtn">
        <svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5"/><path d="M7 4v3l2 1.5"/></svg>
        Today
      </button>
      <button class="btn" id="expandAllBtn">
        <svg viewBox="0 0 14 14"><path d="M3 5l4-3 4 3"/><path d="M3 9l4 3 4-3"/></svg>
        Expand All
      </button>
      <div class="zoom-group">
        <button class="ico-btn" id="zoomInBtn" title="Zoom in"><svg viewBox="0 0 14 14"><circle cx="6" cy="6" r="4"/><path d="M9 9l3 3"/><path d="M4 6h4M6 4v4"/></svg></button>
        <button class="ico-btn" id="zoomOutBtn" title="Zoom out"><svg viewBox="0 0 14 14"><circle cx="6" cy="6" r="4"/><path d="M9 9l3 3"/><path d="M4 6h4"/></svg></button>
      </div>
      <button class="ico-btn" id="moreBtn" title="More"><svg viewBox="0 0 14 14"><circle cx="3" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="7" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="11" cy="7" r="1" fill="currentColor" stroke="none"/></svg></button>
      ${ME ? `<button class="user-btn" id="userBtn" title="${escape(ME.name)} · ${escape(ME.email)}"><span class="avatar" style="background:${avatarColor(ME.id)}">${initials(ME.id)}</span></button>` : ''}
    </div>
  </div>`;
}

/* ----------- TimelineHeader ----------- */
function TimelineHeader(){
  // Group timeline by month for the top label row
  const monthGroups = [];
  TIMELINE.forEach((t,i)=>{
    const last = monthGroups[monthGroups.length-1];
    if(!last || last.m !== t.m){ monthGroups.push({m:t.m, y:t.y, count:1}); }
    else last.count++;
  });
  // Sprint groups (5 days each)
  const sprintGroups = [];
  for(let i=0;i<TIMELINE.length;i+=5){
    const t = TIMELINE[i];
    sprintGroups.push({sprint:t.sprint, week:t.week});
  }

  const headerLeft = viewMode === 'team'
    ? `<div class="active-projects" id="teamViewLabel">Team Workload</div>`
    : `<div class="active-projects" id="projectViewToggle">
        ${projectView === 'archived' ? 'Archived Projects' : 'Active Projects'}
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3l2.5 2.5L7 3"/></svg>
      </div>
      <button class="add-project-pill" id="addProjectBtn" title="Add project">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5.5 2v7M2 5.5h7"/></svg>
        <span class="label">Add Project</span>
      </button>`;
  return `
  <div class="header">
    <div class="header-left">
      ${headerLeft}
    </div>
    <div class="header-right">
      <div class="month-row">
        ${monthGroups.map(g=>`
          <div class="month-cell" style="flex:0 0 calc(${g.count} * var(--day-w))">
            ${g.m} <em>${g.y}</em>
          </div>`).join("")}
      </div>
      <div class="day-row">
        ${TIMELINE.map((t,i)=>`
          <div class="day ${t.today?"today":""} ${t.weekStart?"weekstart":""}">
            <div class="dow">${t.d}</div>
            <div class="mon">${t.m}</div>
            <div class="num">${t.n}</div>
          </div>`).join("")}
      </div>
      <div class="sprint-row">
        ${sprintGroups.map((g,idx)=>`
          <div class="sprint-cell" style="background:${idx%2===0?'rgba(0,0,0,0.03)':'transparent'}">
            <span class="sc-full">SPRINT ${g.sprint} <em>|</em> WEEK ${g.week}</span>
            <span class="sc-abbr">S${g.sprint} <em>|</em> W${g.week}</span>
          </div>
        `).join("")}
      </div>
    </div>
  </div>`;
}

/* ----------- Helpers for lanes ----------- */
function weekDividers(){ return ""; }

function weekOverlay(){
  const lines = TIMELINE.filter(t=>t.weekStart)
    .map(t => TIMELINE.indexOf(t))
    .map(i => `<div class="week-overlay-line" style="left:${sidebarW + i*dayW}px"></div>`)
    .join("");
  return `<div class="week-overlay">${lines}</div>`;
}

/* A milestone with no title shows its type ("Kick Off", "Release", …). */
function msDisplayTitle(ms){ return ms.title || (ms.type === 'Kickoff' ? 'Kick Off' : (ms.type || 'Milestone')); }

function MilestoneMarker(ms, tintHex, withSidebarOffset, labelSpan, pid){
  const i = idxOf(ms.date);
  const left = withSidebarOffset
    ? `calc(var(--sidebar-w) + ${i} * var(--day-w) - 1px)`
    : `calc(${i} * var(--day-w) - 1px)`;
  const span = labelSpan ?? 8;
  const t = TIMELINE[i];
  const cap = s => s.charAt(0) + s.slice(1).toLowerCase();
  const dateLabel = t ? `${cap(t.d)}, ${cap(t.m)} ${t.n}, ${t.y}` : '';
  return `
    <div class="milestone" data-idx="${i}" data-date="${escape(dateLabel)}" data-pid="${pid}" data-mid="${ms.id}" style="left:${left};--ms:${tintHex};--label-span:${span}">
      <div class="ms-hit"></div>
      <div class="ms-flag">${escape(ms.type || "Milestone")}</div>
      <div class="ms-tooltip">Drag to move · Click to edit</div>
      <div class="ms-title">${escape(msDisplayTitle(ms))}</div>
      <div class="ms-desc">${escape(ms.desc)}</div>
    </div>`;
}

/* Per-bar hatch overlay: tinted stripes painted only at OFF-day positions
   inside the bar. The SVG uses bar-local coords (offset by -4px to match
   the bar's left padding), and .wi's overflow:clip trims any overhang.
   Extracted so the drag/resize handler can re-emit it live as the bar
   moves over different OFF cells. */
function wiHatchHtml(who, s, e){
  const leaves = (MEMBER_LEAVES[who] || []).filter(l => {
    const idx = idxOf(l.date);
    return idx >= s && idx < e;
  });
  if(leaves.length === 0) return '';
  const id = `wih${++__laneHatchSeq}`;
  const rects = leaves.map(l => {
    const idx = idxOf(l.date);
    const xExpr = l.type === 'pm'
      ? `calc((${idx} - ${s}) * var(--day-w) - 4px + var(--day-w) * 0.5)`
      : `calc((${idx} - ${s}) * var(--day-w) - 4px)`;
    const wExpr = (l.type === 'am' || l.type === 'pm')
      ? `calc(var(--day-w) * 0.5)`
      : `var(--day-w)`;
    return `<rect style="x:${xExpr};y:0;width:${wExpr};height:100%" fill="url(#${id})"/>`;
  }).join('');
  return `<svg class="wi-hatch" data-pattern-id="${id}" preserveAspectRatio="none">
    <defs>
      <pattern id="${id}" patternUnits="userSpaceOnUse" width="11.3137" height="11.3137">
        <line x1="-2" y1="2" x2="2" y2="-2" stroke="currentColor" stroke-width="4"/>
        <line x1="-2" y1="13.3137" x2="13.3137" y2="-2" stroke="currentColor" stroke-width="4"/>
        <line x1="9.3137" y1="13.3137" x2="13.3137" y2="9.3137" stroke="currentColor" stroke-width="4"/>
      </pattern>
    </defs>
    ${rects}
  </svg>`;
}

function WorkItemBar(item, palette, pid){
  const s = idxOf(item.start);
  const e = idxOf(item.end);
  const span = Math.max(e - s, 1);
  const label = item.label || "Work item";
  const hatchHtml = wiHatchHtml(item.who, s, e);
  const isOthers = String(pid || '').startsWith('__others__:');
  const outlineSvg = isOthers
    ? `<svg class="wi-outline" preserveAspectRatio="none" aria-hidden="true">
         <rect x="0" y="0" width="100%" height="100%" rx="4" ry="4" fill="none" stroke="${palette.wiBd}" stroke-width="2" stroke-dasharray="6 2.5"/>
       </svg>`
    : '';
  return `<div class="wi${isOthers ? ' is-others' : ''}" data-pid="${pid}" data-wid="${item.id}" style="left:calc(${s} * var(--day-w) + 4px);width:calc(${span} * var(--day-w) - 8px);--wi-bg:${palette.wi};--wi-bd:${palette.wiBd}">
    ${outlineSvg}${hatchHtml}<span class="wi-handle l"></span><span class="wi-label">${escape(label)}</span><span class="wi-handle r"></span>
  </div>`;
}

/* Per-lane SVG hatch overlay. Each SVG defines its own <pattern> with a
   unique id; alignHatchOverlays() then writes patternTransform="translate(
   -globalX -globalY)" so the pattern is sampled from a single imaginary
   grid anchored at the .rows top-left, identical across all lanes. */
let __laneHatchSeq = 0;
function MemberLaneHatchSvg(memberName, kind){
  const leaves = MEMBER_LEAVES[memberName] || [];
  if(leaves.length === 0) return '';
  const id = `lh${++__laneHatchSeq}`;
  const klass = kind === 'gray-base'
    ? 'lane-hatch lane-hatch--gray-base'
    : (kind === 'dark' ? 'lane-hatch lane-hatch--dark' : 'lane-hatch');
  const rects = leaves.map(l => {
    const idx = idxOf(l.date);
    if(idx < 0 || idx >= TIMELINE.length) return '';
    const xExpr = l.type === 'pm'
      ? `calc(${idx} * var(--day-w) + var(--day-w) * 0.5)`
      : `calc(${idx} * var(--day-w))`;
    const wExpr = (l.type === 'am' || l.type === 'pm')
      ? `calc(var(--day-w) * 0.5)`
      : `var(--day-w)`;
    // Single hatch rect — the gaps between stripes are transparent, letting
    // the lane background (and any row-tint ::before behind) show through.
    // That keeps OFF cells participating in row hover tint highlights.
    // Uses SVG2 CSS geometry properties (x/width via style:) so they track
    // --day-w as the timeline zooms.
    return `<rect style="x:${xExpr};y:0;width:${wExpr};height:100%" fill="url(#${id})"/>`;
  }).join('');
  // Tile is 8√2 ≈ 11.3137 — the perpendicular spacing between -45° stripes
  // is exactly 8 (4px stripe + 4px gap, matching the original CSS gradient).
  // Three lines per tile cover the three stripe-constant levels that the
  // tile straddles: c=0 (origin corner), c=11.3137 (main diagonal),
  // c=22.6274 (opposite corner). Endpoints extend just past the tile edges
  // so stroke caps produce no visible notch where adjacent tiles join.
  return `<svg class="${klass}" data-pattern-id="${id}" preserveAspectRatio="none">
    <defs>
      <pattern id="${id}" patternUnits="userSpaceOnUse" width="11.3137" height="11.3137">
        <line x1="-2" y1="2" x2="2" y2="-2" stroke="currentColor" stroke-width="4"/>
        <line x1="-2" y1="13.3137" x2="13.3137" y2="-2" stroke="currentColor" stroke-width="4"/>
        <line x1="9.3137" y1="13.3137" x2="13.3137" y2="9.3137" stroke="currentColor" stroke-width="4"/>
      </pattern>
    </defs>
    ${rects}
  </svg>`;
}
function MemberLaneLeaveOverlays(memberName, hasTintRange){
  // In project view (hasTintRange=true), paint a gray base hatch beneath the
  // tinted hatch. CSS clips the tinted layer to [--tint-left, --tint-width],
  // so OFF cells outside the project's duration fall back to neutral gray.
  // Team view doesn't carry a project tint range, so it renders only the
  // tinted layer (which the project-view-scoped tint rule leaves as gray).
  const tinted = MemberLaneHatchSvg(memberName, 'light');
  if(!hasTintRange) return tinted;
  return MemberLaneHatchSvg(memberName, 'gray-base') + tinted;
}

/* Anchor every hatched OFF-day overlay (lane background overlays + team
   workload row OFF stripes) to a single global origin so adjacent cells —
   horizontally and vertically — show one continuous diagonal pattern. We
   read each element's own viewport-relative position so cell padding and
   borders don't cause sub-pixel drift between the two overlay types. */
function alignHatchOverlays(){
  const rows = document.querySelector('.rows');
  if(!rows) return;
  const rowsRect = rows.getBoundingClientRect();
  // Each SVG's pattern uses userSpaceOnUse, so patternTransform translate
  // shifts where the pattern's (0,0) lands within the SVG. Setting it to
  // (-globalX, -globalY) makes the pattern grid line up to the .rows
  // origin — every lane's SVG samples the same imaginary global grid.
  document.querySelectorAll('.lane-hatch, .wi-hatch').forEach(svg => {
    const r = svg.getBoundingClientRect();
    const x = r.left - rowsRect.left;
    const y = r.top - rowsRect.top;
    const pat = svg.querySelector('pattern');
    if(pat) pat.setAttribute('patternTransform', `translate(${-x} ${-y})`);
  });
}

/* ----------- ProjectSidebar ----------- */
function ProjectSidebar(p){
  const sc = STATUS_CLASS[p.status] || "ontrack";
  const palette = TINTS[p.tint];
  const owner = p.members[0] || { userId: null };
  const ownerName = userName(owner.userId);
  return `
    <div class="project-side" data-pid="${p.id}" style="--tint:${palette.tint};--tint-bg:${palette.bg}">
      <div class="project-head">
        <div class="project-title" data-action="open-panel" data-pid="${p.id}" title="${escape(p.title)}">${escape(p.title)}</div>
        <span class="status ${sc}" data-action="open-panel" data-pid="${p.id}">${escape(p.status)}</span>
      </div>
      <div class="key-row" data-action="open-panel" data-pid="${p.id}">${escape(p.key)}</div>
      <div class="owner-row" ${p.expanded ? 'style="display:none"' : ''}>
        <div class="owner-chip">
          <div class="avatar" style="background:${avatarColor(owner.userId)}">${initials(owner.userId)}</div>
          <span class="owner-name">${escape(ownerName)}</span>
          ${p.members.length > 1 ? `<span class="owner-extra">+ ${p.members.length - 1} project member${p.members.length - 1 === 1 ? '' : 's'}</span>` : ''}
          <span class="owner-hint">is the owner pm, click to view planned schedule.</span>
        </div>
        <div class="tooltip"><strong>Owner/PM: ${escape(ownerName)}</strong>Expand to view all members and planned schedule</div>
      </div>
      <div class="expand-controls" ${p.expanded ? '' : 'style="display:none"'}>
        <a class="show-toggle" href="#">Show less</a>
        <a class="add-member" href="#" title="Add member"><svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5.5 2v7M2 5.5h7"/></svg><span class="label">Add Member</span></a>
      </div>
    </div>`;
}

/* ----------- MemberRow ----------- */
function MemberRow(m, palette, p){
  const range = projectTintRange(p);
  // Per-row milestone line segments. The outer .milestone marker (in
  // project-group, z=4) is hidden behind member-row stacking — render
  // a thin line inside member-lane at z=1 so the marker sits above the
  // hatch (z=0) but below the work item bar's label (which lives in
  // .wi z=2 with sticky positioning).
  const msLines = (p.milestones || []).map(ms => {
    const i = idxOf(ms.date);
    return `<div class="ms-line" style="left:calc(${i} * var(--day-w) - 1px);background:${palette.tint}"></div>`;
  }).join('');
  return `
    <div class="member-row" data-pid="${p.id}" data-mid="${m.id}" data-uid="${escape(m.userId)}">
      <div class="member-side" style="--tint:${palette.tint};--tint-bg:${palette.bgMember}">
        <div class="avatar" style="background:${avatarColor(m.userId)}">${initials(m.userId)}</div>
        <div class="member-meta">
          <div class="member-name">${escape(userName(m.userId))}</div>
          <div class="member-role">${escape(m.role)}</div>
        </div>
      </div>
      <div class="member-lane" style="--tint:${palette.tint};--tint-bg:${palette.bgMember};--tint-left:calc(${range.startIdx} * var(--day-w));--tint-width:calc(${range.endIdx - range.startIdx} * var(--day-w))" data-pid="${p.id}" data-member="${escape(m.userId)}">${MemberLaneLeaveOverlays(m.userId, true)}${msLines}</div>
    </div>`;
}

/* ----------- ProjectRow ----------- */
function ProjectRow(p, isLast){
  const palette = TINTS[p.tint];
  const projectSummaryItems = ""; // milestones rendered in summary lane

  const memberRows = p.members.map(m => MemberRow(m, palette, p)).join("");

  return `
    <div class="project-group" data-pid="${p.id}">
      <div class="project ${p.expanded ? 'has-members' : ''}" data-tint="${p.tint}">
        ${ProjectSidebar(p)}
        <div class="project-lane" style="--tint:${palette.tint};--tint-bg:${palette.bg};--tint-left:calc(${projectTintRange(p).startIdx} * var(--day-w));--tint-width:calc(${projectTintRange(p).endIdx - projectTintRange(p).startIdx} * var(--day-w))">
          <div class="project-summary" data-pid="${p.id}"></div>
        </div>
      </div>
      <div class="member-block" data-pid="${p.id}" ${p.expanded ? '' : 'style="display:none"'}>${memberRows}</div>
      ${(()=>{
        const sorted = p.milestones
          .map(ms => ({ ms, idx: idxOf(ms.date) }))
          .sort((a,b) => a.idx - b.idx);
        return sorted.map((entry, k) => {
          const next = sorted[k+1];
          const span = next ? (next.idx - entry.idx) : 8;
          return MilestoneMarker(entry.ms, palette.tint, true, span, p.id);
        }).join("");
      })()}
    </div>
  `;
}

/* ----------- ProjectBoard ----------- */
function visibleProjects(){
  return PROJECTS.filter(p => projectView === 'archived' ? p.status === 'Archived' : p.status !== 'Archived');
}
function ProjectBoard(){
  const list = visibleProjects();
  return `
    <div class="board${dayW <= 32 ? ' is-week-mode' : ''}${dayW <= 24 ? ' is-tight' : ''}" style="--sidebar-w:${sidebarW}px;--day-w:${dayW}px">
      ${TimelineHeader()}
      <div class="rows" style="position:relative;padding-top:4px">
        ${list.length === 0
          ? `<div style="padding:40px 20px;color:var(--ink-3);font-size:12px">No ${projectView === 'archived' ? 'archived' : 'active'} projects.</div>`
          : list.map((p,i)=>ProjectRow(p, i===list.length-1)).join("")}
        ${weekOverlay()}
      </div>
    </div>`;
}

/* ----------- Team-view derivation -----------
   Source of truth = PROJECTS. We re-group:
   Project → Members → Items   becomes   Member → Projects → Items
   No new dataset is introduced; mutating PROJECTS automatically updates this view. */
function deriveTeamData(){
  const memberMap = new Map();
  function ensure(uid, role){
    let e = memberMap.get(uid);
    if(!e){ e = { uid, role: role || '', projects: new Map() }; memberMap.set(uid, e); }
    else if(!e.role && role){ e.role = role; }
    return e;
  }
  visibleProjects().forEach(p=>{
    p.members.forEach(m => ensure(m.userId, m.role));
    p.items.forEach(it=>{
      const role = (p.members.find(m=> m.userId === it.who) || {}).role;
      const e = ensure(it.who, role);
      let pe = e.projects.get(p.id);
      if(!pe){ pe = { project: p, items: [] }; e.projects.set(p.id, pe); }
      pe.items.push(it);
    });
  });
  // Surface members who only have "Others" items (no board-tracked projects).
  Object.entries(TEAM_OTHERS).forEach(([uid, items])=>{
    if(items && items.length > 0) ensure(uid, '');
  });
  // Drop members with zero items (project items OR Others items).
  const teams = Array.from(memberMap.values()).filter(e =>
    e.projects.size > 0 || (TEAM_OTHERS[e.uid] || []).length > 0
  );
  teams.sort((a,b)=> userName(a.uid).localeCompare(userName(b.uid)));
  return teams;
}
function workloadLevel(itemCount){
  if(itemCount <= 1) return 'light';
  if(itemCount <= 3) return 'normal';
  return 'heavy';
}

/* ----------- TeamMemberSidebar / TeamProjectRow / TeamMemberRow / TeamBoard ----------- */
function TeamMemberSidebar(tm, itemCount, projCount, expanded){
  const wl = workloadLevel(itemCount);
  return `
    <div class="project-side team-side" data-team="${escape(tm.uid)}" style="--tint:transparent;--tint-bg:transparent">
      <div class="project-head">
        <div class="avatar" style="background:${avatarColor(tm.uid)}">${initials(tm.uid)}</div>
        <div class="project-title" title="${escape(userName(tm.uid))}">${escape(userName(tm.uid))}</div>
        <span class="workload-tag ${wl}" title="Workload: ${wl}" style="display:none">${wl}</span>
      </div>
      <button class="key-row team-toggle" type="button" title="Show / hide projects">
        ${projCount} project${projCount===1?'':'s'}
        <svg class="team-toggle-chev" width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 3l2.5 2.5L7 3"/></svg>
      </button>
    </div>`;
}

function TeamProjectRow(teamName, pe){
  const p = pe.project;
  const palette = TINTS[p.tint];
  return `
    <div class="member-row team-project-row" data-team="${escape(teamName)}" data-pid="${p.id}">
      <div class="member-side" style="--tint:${palette.tint};--tint-bg:${palette.bgMember}">
        <div class="member-meta">
          <div class="member-name">${escape(p.title)}</div>
        </div>
      </div>
      <div class="member-lane" style="--tint:${palette.tint};--tint-bg:${palette.bgMember}" data-pid="${p.id}" data-member="${escape(teamName)}">${MemberLaneLeaveOverlays(teamName)}</div>
    </div>`;
}

/* Per-member "Others" row — gray, neutral. Only rendered in team view to
   surface work that isn't tracked on this board. */
function TeamOthersRow(teamName){
  const palette = TINTS.gray;
  const opid = othersPid(teamName);
  return `
    <div class="member-row team-project-row team-others-row" data-team="${escape(teamName)}" data-pid="${escape(opid)}">
      <div class="member-side" style="--tint:${palette.tint};--tint-bg:${palette.bgMember}">
        <div class="member-meta">
          <div class="member-name">Others</div>
        </div>
      </div>
      <div class="member-lane" style="--tint:${palette.tint};--tint-bg:${palette.bgMember}" data-pid="${escape(opid)}" data-member="${escape(teamName)}">${MemberLaneLeaveOverlays(teamName)}</div>
    </div>`;
}

function TeamMemberRow(tm){
  const projEntries = Array.from(tm.projects.values());
  const othersCount = (TEAM_OTHERS[tm.uid] || []).length;
  const itemCount = projEntries.reduce((n, pe) => n + pe.items.length, 0) + othersCount;
  const projCount = projEntries.length;
  const expanded = !!teamExpanded[tm.uid];
  const childRows = projEntries.map(pe => TeamProjectRow(tm.uid, pe)).join('') + TeamOthersRow(tm.uid);
  return `
    <div class="project-group team-group" data-team="${escape(tm.uid)}">
      <div class="project ${expanded ? 'has-members' : ''}">
        ${TeamMemberSidebar(tm, itemCount, projCount, expanded)}
        <div class="project-lane" style="--tint-bg:transparent">
          <div class="project-summary" data-team="${escape(tm.uid)}"></div>
        </div>
      </div>
      <div class="member-block team-block" data-team="${escape(tm.uid)}" ${expanded ? '' : 'style="display:none"'}>${childRows}</div>
    </div>`;
}

function TeamBoard(){
  const teams = deriveTeamData();
  const empty = teams.length === 0;
  return `
    <div class="board team-board${dayW <= 32 ? ' is-week-mode' : ''}${dayW <= 24 ? ' is-tight' : ''}" style="--sidebar-w:${sidebarW}px;--day-w:${dayW}px">
      ${TimelineHeader()}
      <div class="rows" style="position:relative">
        ${empty
          ? `<div class="team-empty"><div class="es-title">No assigned work items</div><p class="es-desc">Work items assigned to team members will appear on this timeline.</p></div>`
          : teams.map(tm => TeamMemberRow(tm)).join('')}
        ${weekOverlay()}
      </div>
    </div>`;
}

/* ----------- FooterStatusBar ----------- */
function FooterStatusBar(){
  return `
    <div class="footer">
      <div class="footer-status" id="footerStatus">${footerStatusHtml()}</div>
      <div class="right">Drag the timeline to pan · Click magnifier to zoom · Click <span class="kbd">Today</span> to recenter</div>
    </div>`;
}

/* ----------- App ----------- */
function App(){
  return `
    ${TopToolbar()}
    <div class="board-scroll" id="boardScroll">
      ${viewMode === 'team' ? TeamBoard() : ProjectBoard()}
    </div>
    ${FooterStatusBar()}
  `;
}


/* During fast interactions (work item drag/resize), batch redundant heatmap
   refreshes to at most one per animation frame so we don't spend the frame
   budget rebuilding cells the user will never see. */
let __heatmapPending = null;
function refreshTeamHeatmapDeferred(teamName){
  if(__heatmapPending){
    __heatmapPending.team = teamName || __heatmapPending.team;
    return;
  }
  __heatmapPending = { team: teamName };
  requestAnimationFrame(()=>{
    const team = __heatmapPending && __heatmapPending.team;
    __heatmapPending = null;
    renderTeamHeatmap(team);
  });
}
/* Rebuild every OFF-day hatch overlay derived from MEMBER_LEAVES[memberName]:
   - the per-lane background SVGs (.lane-hatch) on every .member-lane the
     member owns, and
   - the per-bar overlays (.wi-hatch) on every .wi work-item bar in those
     lanes. Milestone lines and the bars themselves are left untouched. */
function refreshMemberLaneHatches(memberName){
  document.querySelectorAll('.member-lane').forEach(lane => {
    if(lane.dataset.member !== memberName) return;
    // Lane background hatch.
    lane.querySelectorAll(':scope > .lane-hatch').forEach(s => s.remove());
    const group = lane.closest('.project-group');
    const hasTintRange = !!(group && !group.classList.contains('team-group'));
    const html = MemberLaneLeaveOverlays(memberName, hasTintRange);
    if(html) lane.insertAdjacentHTML('afterbegin', html);
    // Per-bar hatch on every work item in this lane.
    lane.querySelectorAll(':scope > .wi[data-wid]').forEach(wi => {
      const old = wi.querySelector(':scope > .wi-hatch');
      if(old) old.remove();
      const pid = wi.dataset.pid || '';
      let item = null;
      if(pid.startsWith('__others__:')){
        item = (TEAM_OTHERS[memberName] || []).find(it => String(it.id) === String(wi.dataset.wid)) || null;
      } else {
        item = findItem(pid, wi.dataset.wid);
      }
      if(!item) return;
      const s = idxOf(item.start);
      const e = idxOf(item.end);
      const wiHatch = wiHatchHtml(memberName, s, e);
      if(!wiHatch) return;
      const handle = wi.querySelector(':scope > .wi-handle.l');
      if(handle) handle.insertAdjacentHTML('beforebegin', wiHatch);
      else wi.insertAdjacentHTML('afterbegin', wiHatch);
    });
  });
  alignHatchOverlays();
}
/* After mount: place work items into the appropriate lanes for the active view. */
function renderTeamHeatmap(filterTeamName){
  const N = TIMELINE.length;
  // Skip the per-row fit pass during item drags — the heatmap is rebuilt many
  // times per drag and leave tags don't change, so renderApp on mouseup will
  // run the fit once.
  const skipFit = document.body.classList.contains('is-item-dragging');
  document.querySelectorAll('.project-group.team-group .project-summary').forEach(summary=>{
    const teamName = summary.dataset.team;
    if(filterTeamName && teamName !== filterTeamName) return;
    // Per-day list of project-colored items.
    const perDay = Array.from({length:N}, () => []);
    visibleProjects().forEach(p=>{
      (p.items || []).forEach(it=>{
        if(it.who !== teamName) return;
        const s = idxOf(it.start);
        const e = idxOf(it.end);
        for(let i = s; i < e; i++){
          if(i >= 0 && i < N) perDay[i].push({ pid:p.id, tint:p.tint, label:it.label });
        }
      });
    });
    // Per-member "Others" items — neutral gray, also count toward workload.
    (TEAM_OTHERS[teamName] || []).forEach(it=>{
      const s = idxOf(it.start);
      const e = idxOf(it.end);
      for(let i = s; i < e; i++){
        if(i >= 0 && i < N) perDay[i].push({ pid: othersPid(teamName), tint:'gray', label:it.label });
      }
    });
    // Per-day leave entries — keep the full leave object so the cell can render
    // the category label and the hover tooltip can pull notes/day-type.
    const leaveByDay = {};
    (MEMBER_LEAVES[teamName] || []).forEach(l=>{
      const idx = idxOf(l.date);
      if(idx >= 0 && idx < N) leaveByDay[idx] = l;
    });

    const html = perDay.map((items, i)=>{
      const leaveObj = leaveByDay[i];
      const leaveType = leaveObj ? leaveObj.type : null;
      if(!leaveType && items.length === 0){
        // The "+" affordance for empty cells is provided by a single shared
        // overlay that follows the cursor (see setupTeamSummaryAddHover).
        // Putting one button per empty cell would add ~3000 DOM nodes.
        return `<div class="team-load-cell is-empty" data-idx="${i}" style="left:calc(${i} * var(--day-w))"><div class="team-load-block"></div></div>`;
      }
      const stripes = [];
      const cat = leaveObj
        ? (TIME_OFF_CATEGORIES.find(c => c.value === (leaveObj.category || 'vacation')) || TIME_OFF_CATEGORIES[0])
        : null;
      const catLabel = cat ? cat.label : '';
      const catShort = cat ? cat.short : '';
      const fullLeaveHtml = `<div class="team-load-stripe is-leave"><span class="pto-tag" data-full="${escape(catLabel)}" data-short="${escape(catShort)}">${escape(catLabel)}</span></div>`;
      const halfLeaveHtml = `<div class="team-load-stripe is-leave"></div>`;
      if(leaveType === 'full'){
        stripes.push(fullLeaveHtml);
      } else if(leaveType === 'am' || leaveType === 'pm'){
        if(items.length === 0){
          stripes.push(`<div class="team-load-stripe is-empty-half"></div>`);
          stripes.push(halfLeaveHtml);
        } else {
          stripes.push(halfLeaveHtml);
          items.forEach(it => stripes.push(workloadStripe(it)));
        }
      } else {
        items.forEach(it => stripes.push(workloadStripe(it)));
      }
      // Tooltips are handled per-stripe via JS (showTipHTML) so we can render
      // multiline content (project name + work item label, or category + day-type + notes).
      const firstTint = items[0] ? (TINTS[items[0].tint] || {}).tint : null;
      const bdColor = leaveType === 'full' ? '#bdbab2'
        : (firstTint || (leaveType && items.length > 0 ? '#bdbab2' : null));
      const bdStyle = bdColor ? `--bd:${bdColor};` : '';
      return `<div class="team-load-cell${leaveType ? ' has-leave' : ''}" data-idx="${i}" style="left:calc(${i} * var(--day-w))"><div class="team-load-block" style="${bdStyle}">${stripes.join('')}</div></div>`;
    }).join('');
    // OFF-day hatch is now painted inside each .team-load-stripe.is-leave
    // (clipped by the workload block's rounded overflow), so no full-row
    // SVG overlay is needed here.
    summary.innerHTML = html;
    // Fit the row's leave labels synchronously, scoped to this summary, so the
    // very next paint already shows the abbreviated text. Doing this on a
    // deferred frame caused a visible flash: after the innerHTML rewrite
    // every .pto-tag is reborn with the full label, so an add/delete on the
    // row briefly showed siblings as "Vacation" before they snapped back to
    // "VAC" on the next frame. Per-row scope keeps the layout cost bounded
    // (one row's tags, one layout flush per affected summary).
    if(!skipFit) fitPtoTagsIn(summary);
  });
}
let __fitPtoTagsScheduled = false;
function scheduleFitPtoTags(){
  if(__fitPtoTagsScheduled) return;
  __fitPtoTagsScheduled = true;
  requestAnimationFrame(()=>{
    __fitPtoTagsScheduled = false;
    if(document.body.classList.contains('is-item-dragging')) return;
    fitPtoTags();
  });
}
/* For each rendered .pto-tag, prefer the full label; fall back to the short
   abbreviation if the full label overflows; hide entirely if even the short
   label can't fit. Reads and writes are batched into separate phases so we
   only force one layout flush per phase instead of one per tag. */
function fitPtoTagsIn(scope){
  const tags = (scope || document).querySelectorAll('.team-load-stripe.is-leave > .pto-tag');
  if(tags.length === 0) return;
  // Phase 1: writes — reset every tag to its full label.
  tags.forEach(tag => {
    tag.style.display = '';
    tag.textContent = tag.dataset.full || '';
  });
  // Phase 2: reads — first read flushes layout once; the rest are cached.
  const measured = [];
  tags.forEach(tag => {
    measured.push({ tag, fits: tag.scrollWidth <= tag.clientWidth + 0.5 });
  });
  // Phase 3: writes — swap overflowing tags to the short label.
  const swapped = [];
  measured.forEach(m => {
    if(m.fits) return;
    m.tag.textContent = m.tag.dataset.short || m.tag.dataset.full || '';
    swapped.push(m.tag);
  });
  if(swapped.length === 0) return;
  // Phase 4: reads — re-measure only the swapped tags (one more layout flush).
  const stillTooBig = swapped.filter(tag => tag.scrollWidth > tag.clientWidth + 0.5);
  // Phase 5: writes — hide the ones that still overflow.
  stillTooBig.forEach(tag => { tag.style.display = 'none'; });
}
function fitPtoTags(){ fitPtoTagsIn(document); }
function workloadStripe(it){
  const palette = TINTS[it.tint] || {};
  const base = palette.bg || palette.tint || '#bbb';
  // Others items are visually neutral — use a lower alpha so they read as
  // background context rather than competing with project-colored stripes.
  const alpha = it.tint === 'gray' ? '0.3' : '0.6';
  const bg = typeof base === 'string' ? base.replace(/,\s*0?\.\d+\)/, `,${alpha})`) : base;
  return `<div class="team-load-stripe" style="--blk:${bg}" data-pid="${it.pid}" data-label="${escape(it.label || '')}"></div>`;
}

function placeWorkItems(opts){
  // The post-insert alignHatchOverlays() call reads getBoundingClientRect, which
  // forces a synchronous full-document layout. After a fresh innerHTML rewrite
  // that costs ~100ms with thousands of timeline cells. mountBoard defers the
  // alignment to the next frame so the browser can paint first; other callers
  // (drag commit, etc.) still want it synchronous to avoid visible misalignment.
  const skipAlign = !!(opts && opts.skipAlign);
  // Team-view heatmap rendering creates ~3500 absolutely-positioned cells
  // across 9 team summaries. That's the dominant paint cost on a project →
  // team switch (~150ms of browser layout/paint after the JS finishes).
  // Deferring it via a *double* requestAnimationFrame splits the work across
  // two frames: frame 1 paints the new view's structure (empty heatmap rows
  // visible immediately), frame 2 fills in the cells. A single rAF wouldn't
  // help here because every rAF queued in the same JS task runs before the
  // next paint.
  const deferHeatmap = !!(opts && opts.deferHeatmap);
  if(viewMode === 'team'){
    if(deferHeatmap){
      requestAnimationFrame(()=> requestAnimationFrame(()=> renderTeamHeatmap()));
    } else {
      renderTeamHeatmap();
    }
    document.querySelectorAll('.member-block.team-block').forEach(block=>{
      // Collapsed team-blocks have display:none on their wrapper. Their child
      // rows are still in the DOM but never visible, so skip the work-item
      // insertion entirely — saves a lot of insertAdjacentHTML calls on a
      // large board (the items will be re-inserted when the team is expanded
      // and the next renderApp runs).
      if(block.style.display === 'none') return;
      // Mark the block as populated so subsequent incremental updates
      // (refreshWorkItemUI on a popover edit / add) know they can safely
      // insert into this block's lanes — without this flag, fresh blocks
      // produced by renderApp would be skipped because expandGroup wasn't
      // the path that populated them.
      block.__wiPopulated = true;
      const teamName = block.dataset.team;
      block.querySelectorAll('.member-row.team-project-row').forEach(row=>{
        const lane = row.querySelector('.member-lane');
        if(!lane) return;
        if(row.classList.contains('team-others-row')){
          const palette = TINTS.gray;
          const opid = row.dataset.pid;
          (TEAM_OTHERS[teamName] || []).forEach(it=>{
            lane.insertAdjacentHTML('beforeend', WorkItemBar(it, palette, opid));
          });
          return;
        }
        const proj = findProject(row.dataset.pid);
        if(!proj) return;
        const palette = TINTS[proj.tint];
        proj.items
          .filter(it => it.who === teamName)
          .forEach(it => lane.insertAdjacentHTML('beforeend', WorkItemBar(it, palette, proj.id)));
      });
    });
    if(!skipAlign) alignHatchOverlays();
    return;
  }
  document.querySelectorAll(".member-block").forEach(block=>{
    if(block.classList.contains('team-block')) return;
    const proj = findProject(block.dataset.pid);
    if(!proj) return;
    const palette = TINTS[proj.tint];
    proj.items.forEach(it=>{
      const lane = block.querySelector(`.member-lane[data-member="${cssEscape(it.who)}"]`);
      if(!lane) return;
      lane.insertAdjacentHTML("beforeend", WorkItemBar(it, palette, proj.id));
    });
  });
  if(!skipAlign) alignHatchOverlays();
}
/* Insert TODAY vertical marker on top of header + lanes. */
let __todayInterval = null;
let __startPanAt = null;
function placeTodayMarker(){
  if(__todayInterval){ clearInterval(__todayInterval); __todayInterval = null; }
  document.querySelectorAll('.now-floor').forEach(el=> el.remove());
  // No marker on weekends (the timeline only has workdays).
  if(TODAY_IDX<0 || !TIMELINE[TODAY_IDX].today) return;
  const board = document.querySelector(".board");
  const header = document.querySelector(".header");
  const boardScroll = document.getElementById("boardScroll");
  const headerH = header.getBoundingClientRect().height;
  const sprintRowH = 18;
  const markerTop = headerH - sprintRowH - 1;

  function markerLeftCalc(){
    const now = new Date();
    const fraction = (now.getHours() * 60 + now.getMinutes()) / (24 * 60);
    return `calc(var(--sidebar-w) + ${TODAY_IDX + fraction} * var(--day-w))`;
  }

  function nowLabelText(){
    const now = new Date();
    const h = String(now.getHours()).padStart(2,'0');
    const m = String(now.getMinutes()).padStart(2,'0');
    const off = -now.getTimezoneOffset() / 60;
    const tz = 'UTC' + (off >= 0 ? '+' : '') + off;
    return `NOW ${h}:${m} <${tz}>`;
  }
  function nowLabel(){
    return escape(nowLabelText());
  }
  function todayDateLabel(){
    const t = TIMELINE[TODAY_IDX];
    if(!t) return '';
    const cap = s => s.charAt(0) + s.slice(1).toLowerCase();
    return escape(`${cap(t.d)}, ${cap(t.m)} ${t.n}`);
  }

  board.insertAdjacentHTML("beforeend",
    `<div class="today-marker" style="left:${markerLeftCalc()};top:${markerTop}px;bottom:0">
       <div class="tm-line"></div>
     </div>`);
  board.style.position = "relative";

  const marker = board.querySelector(".today-marker");

  // Floor marker (bottom arrow + NOW label) lives outside the scroll content,
  // pinned to the viewport so it stays just above the footer.
  const floor = document.createElement('div');
  floor.className = 'now-floor';
  floor.innerHTML = `<div class="tm-arrow"></div><div class="now-date">${todayDateLabel()}</div><div class="now-label">${nowLabel()}</div>`;
  document.body.appendChild(floor);
  const label = floor.querySelector(".now-label");

  function syncFloor(){
    const r = marker.getBoundingClientRect();
    const footer = document.querySelector('.footer');
    const footerTop = footer ? footer.getBoundingClientRect().top : window.innerHeight;
    const scrollR = boardScroll.getBoundingClientRect();
    // Hide if the marker is scrolled out of the visible timeline region.
    const inView = r.left >= scrollR.left + 1 && r.left <= scrollR.right - 1;
    floor.style.display = inView ? '' : 'none';
    floor.style.left = r.left + 'px';
    // Align the arrow's base with the marker line's visible bottom (the
    // .board-scroll's bottom edge = footerTop), so the line and the down-arrow
    // touch with no gap.
    floor.style.top  = footerTop + 'px';
    floor.classList.toggle('is-week-mode', !!board.classList.contains('is-week-mode'));
  }
  syncFloor();
  boardScroll.addEventListener('scroll', syncFloor, { passive:true });
  window.addEventListener('resize', syncFloor);
  window.addEventListener('scroll', syncFloor, { passive:true });

  __todayInterval = setInterval(()=>{
    // Past midnight: move "today" and re-render.
    if(todayISO() !== toISODate(TODAY)){ onCalendarChanged(); return; }
    marker.style.left = markerLeftCalc();
    label.textContent = nowLabel().replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    syncFloor();
  }, 60000);
}
/* Escape a value for use inside a double-quoted CSS attribute selector. */
function cssEscape(s){ return String(s).replace(/["\\]/g,'\\$&'); }

/* Project card expand / collapse — also handles team-member groups in team view. */
function expandGroup(group){
  const side = group.querySelector('.project-side');
  const block = group.querySelector('.member-block');
  const ownerRow = side.querySelector('.owner-row');
  const controls = side.querySelector('.expand-controls');
  const proj = group.querySelector('.project');
  if(ownerRow) ownerRow.style.display = 'none';
  if(controls) controls.style.display = 'flex';
  if(block) block.style.display = '';
  proj.classList.add('has-members');
  const pid = group.dataset.pid;
  if(pid){ const p = findProject(pid); if(p){ p.expanded = true; saveExpandedIds(); } }
  const team = group.dataset.team;
  if(team){ teamExpanded[team] = true; }
  // In team view, work-item bars are not inserted into collapsed team-blocks
  // (placeWorkItems skips them). Now that we're expanding, populate any rows
  // that don't yet have their bars. We check `__wiPopulated` to avoid duplicate
  // inserts on subsequent expand→collapse→expand cycles.
  if(team && block && !block.__wiPopulated){
    block.__wiPopulated = true;
    block.querySelectorAll('.member-row.team-project-row').forEach(row=>{
      const lane = row.querySelector('.member-lane');
      if(!lane) return;
      if(row.classList.contains('team-others-row')){
        const palette = TINTS.gray;
        const opid = row.dataset.pid;
        (TEAM_OTHERS[team] || []).forEach(it=>{
          lane.insertAdjacentHTML('beforeend', WorkItemBar(it, palette, opid));
        });
        return;
      }
      const p = findProject(row.dataset.pid);
      if(!p) return;
      const palette = TINTS[p.tint];
      p.items
        .filter(it => it.who === team)
        .forEach(it => lane.insertAdjacentHTML('beforeend', WorkItemBar(it, palette, p.id)));
    });
  }
  // alignHatchOverlays() and refreshExpandAllBtn() are intentionally NOT called
  // here — callers that need them (e.g., the "Expand All" button) batch them
  // once at the end so we avoid 9× layout flushes for 9 group expansions.
}
function collapseGroup(group){
  const side = group.querySelector('.project-side');
  const block = group.querySelector('.member-block');
  const ownerRow = side.querySelector('.owner-row');
  const controls = side.querySelector('.expand-controls');
  const proj = group.querySelector('.project');
  if(controls) controls.style.display = 'none';
  if(ownerRow) ownerRow.style.display = '';
  if(block) block.style.display = 'none';
  proj.classList.remove('has-members');
  const pid = group.dataset.pid;
  if(pid){ const p = findProject(pid); if(p){ p.expanded = false; saveExpandedIds(); } }
  const team = group.dataset.team;
  if(team){ teamExpanded[team] = false; }
  // alignHatchOverlays + refreshExpandAllBtn are batched by callers — see
  // expandGroup for the rationale.
}
function setupExpandCollapse(){
  document.querySelectorAll('.owner-row').forEach(row=>{
    row.addEventListener('click', ()=>{
      expandGroup(row.closest('.project-group'));
      alignHatchOverlays();
      refreshExpandAllBtn();
    });
  });
  document.querySelectorAll('.show-toggle').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.preventDefault();
      collapseGroup(btn.closest('.project-group'));
      alignHatchOverlays();
      refreshExpandAllBtn();
    });
  });
  document.querySelectorAll('.team-side .team-toggle').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.preventDefault(); e.stopPropagation();
      const group = btn.closest('.project-group');
      const isOpen = group.querySelector('.project').classList.contains('has-members');
      if(isOpen) collapseGroup(group); else expandGroup(group);
      alignHatchOverlays();
      refreshExpandAllBtn();
    });
  });
}
/* Today button: scroll so current week starts near left edge of timeline */
function scrollToToday(smooth){
  const el = document.getElementById('boardScroll');
  if(!el || TODAY_IDX < 0) return;
  let weekStart = TODAY_IDX;
  while(weekStart > 0 && TIMELINE[weekStart].d !== 'MON') weekStart--;
  el.scrollTo({ left: weekStart * dayW, behavior: smooth ? 'smooth' : 'auto' });
}

/* Project reordering: drag a project card (left sidebar) to another slot.
   Live preview via FLIP — other projects shift in real-time with animation. */
(function projectReorder(){
  let down=false, dragging=false, source=null, startX=0, startY=0;
  let lastInsertKey = '';
  const SKIP_INNER = 'button, a, input, .owner-chip, .show-toggle, .add-member, .add-row, .add-project-pill';

  function rows(){ return Array.from(document.querySelectorAll('.project-group')); }

  function flipMove(mutate){
    const groups = rows();
    const before = new Map();
    groups.forEach(g => before.set(g, g.getBoundingClientRect().top));
    mutate();
    rows().forEach(g => {
      if(!before.has(g)) return;
      const dy = before.get(g) - g.getBoundingClientRect().top;
      if(dy === 0) return;
      g.style.transition = 'none';
      g.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(()=>{
        g.style.transition = 'transform 220ms cubic-bezier(.2,.7,.2,1)';
        g.style.transform = '';
      });
    });
  }

  function clearTransforms(){
    rows().forEach(g => { g.style.transition=''; g.style.transform=''; });
  }

  document.addEventListener('mousedown', e=>{
    if(e.button !== 0) return;
    const side = e.target.closest('.project-side');
    if(!side) return;
    if(side.classList.contains('team-side')) return; // no reorder in team view
    if(e.target.closest(SKIP_INNER)) return;
    source = side.closest('.project-group');
    startX = e.pageX; startY = e.pageY;
    down = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', e=>{
    if(!down || !source) return;
    if(!dragging){
      if(Math.abs(e.pageX-startX)+Math.abs(e.pageY-startY) < 5) return;
      dragging = true;
      document.body.classList.add('is-proj-dragging');
      source.classList.add('is-proj-source');
      lastInsertKey = '';
    }
    let target = null, insertAfter = false;
    for(const g of rows()){
      if(g === source) continue;
      const r = g.getBoundingClientRect();
      if(e.clientY >= r.top && e.clientY <= r.bottom){
        target = g;
        insertAfter = e.clientY > r.top + r.height/2;
        break;
      }
    }
    if(!target) return;
    const key = rows().indexOf(target) + (insertAfter ? 'A' : 'B');
    if(key === lastInsertKey) return;
    lastInsertKey = key;
    flipMove(()=>{
      const parent = source.parentNode;
      if(insertAfter) parent.insertBefore(source, target.nextSibling);
      else parent.insertBefore(source, target);
    });
  });

  document.addEventListener('mouseup', ()=>{
    if(!down) return;
    down = false;
    if(!dragging){ source = null; return; }
    document.body.classList.remove('is-proj-dragging');
    source.classList.remove('is-proj-source');
    // Sync PROJECTS array to current DOM order (projects not on screen, e.g.
    // archived ones, keep their relative order after the visible ones).
    const order = rows().map(g => g.dataset.pid);
    const rank = p => { const i = order.indexOf(String(p.id)); return i === -1 ? order.length : i; };
    PROJECTS.sort((a,b)=> rank(a) - rank(b));
    Save.reorderProjects();
    setTimeout(clearTransforms, 260);
    source = null;
    dragging = false;
  });

  // Suppress click after drag (prevent accidental expand / open-panel).
  // Auto-clear on a microtask so a missing synthesized click (e.g. drag
  // released over a different element) doesn't strand the flag.
  let justDragged = false;
  document.addEventListener('mouseup', ()=>{
    if(dragging){
      justDragged = true;
      setTimeout(()=>{ justDragged = false; }, 0);
    }
  }, true);
  document.addEventListener('click', e=>{
    if(justDragged && e.target.closest('.project-side')){
      e.stopPropagation(); e.preventDefault();
    }
  }, true);
})();

/* Member reordering inside a project — owner stays first; others can be reordered.
   Live preview via FLIP — sibling rows shift in real-time with animation. */
(function memberReorder(){
  let down=false, dragging=false, source=null, startX=0, startY=0;
  const SKIP_INNER = 'button, a, input, .avatar';

  function rowsIn(block){ return Array.from(block.querySelectorAll(':scope > .member-row')); }
  function isOwnerRow(row){
    const siblings = rowsIn(row.parentNode);
    return siblings[0] === row;
  }

  function flipMove(block, mutate){
    const items = rowsIn(block);
    const before = new Map();
    items.forEach(g => before.set(g, g.getBoundingClientRect().top));
    mutate();
    rowsIn(block).forEach(g => {
      if(!before.has(g)) return;
      const dy = before.get(g) - g.getBoundingClientRect().top;
      if(dy === 0) return;
      g.style.transition = 'none';
      g.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(()=>{
        g.style.transition = 'transform 200ms cubic-bezier(.2,.7,.2,1)';
        g.style.transform = '';
      });
    });
  }

  document.addEventListener('mousedown', e=>{
    if(e.button !== 0) return;
    const side = e.target.closest('.member-side');
    if(!side) return;
    if(e.target.closest(SKIP_INNER)) return;
    const row = side.closest('.member-row');
    if(!row) return;
    if(row.classList.contains('team-project-row')) return; // no reorder in team view
    if(isOwnerRow(row)) return; // owner is fixed
    source = row;
    startX = e.pageX; startY = e.pageY;
    down = true;
  });

  document.addEventListener('mousemove', e=>{
    if(!down || !source) return;
    if(!dragging){
      if(Math.abs(e.pageX-startX)+Math.abs(e.pageY-startY) < 5) return;
      dragging = true;
      document.body.classList.add('is-member-dragging');
      source.classList.add('is-member-source');
    }
    const block = source.parentNode;
    const rows = rowsIn(block);
    let target = null, insertAfter = false;
    for(let i=1;i<rows.length;i++){ // skip owner at index 0
      const g = rows[i];
      if(g === source) continue;
      const r = g.getBoundingClientRect();
      if(e.clientY >= r.top && e.clientY <= r.bottom){
        target = g;
        insertAfter = e.clientY > r.top + r.height/2;
        break;
      }
    }
    if(!target) return;
    // Don't allow inserting before the owner — clamp to "after owner" minimum.
    let willBeIndex = rows.indexOf(target) + (insertAfter ? 1 : 0);
    if(willBeIndex < 1) return;
    const sourceIdx = rows.indexOf(source);
    if(willBeIndex === sourceIdx || willBeIndex === sourceIdx + 1) return; // no-op
    flipMove(block, ()=>{
      if(insertAfter) block.insertBefore(source, target.nextSibling);
      else block.insertBefore(source, target);
    });
  });

  document.addEventListener('mouseup', ()=>{
    if(!down) return;
    down = false;
    if(!dragging){ source = null; return; }
    document.body.classList.remove('is-member-dragging');
    source.classList.remove('is-member-source');
    // Sync PROJECTS.members to current DOM order
    const block = source.parentNode;
    const proj = findProject(block.dataset.pid);
    if(proj){
      const order = rowsIn(block).map(r => r.dataset.uid);
      proj.members.sort((a,b) => order.indexOf(a.userId) - order.indexOf(b.userId));
      Save.putMembers(proj);
    }
    setTimeout(()=>{
      rowsIn(block).forEach(g => { g.style.transition=''; g.style.transform=''; });
    }, 240);
    source = null;
    dragging = false;
  });
})();

/* Body-level tooltip helper (escapes sticky-sidebar clipping) */
let __tipEl = null;
function ensureTip(){
  if(!__tipEl){
    __tipEl = document.createElement('div');
    __tipEl.className = 'floating-tip';
    document.body.appendChild(__tipEl);
  }
  return __tipEl;
}
function isInteractionSuppressed(){
  return document.body.classList.contains('is-item-dragging')
    || document.body.classList.contains('is-proj-dragging')
    || document.body.classList.contains('is-member-dragging')
    || !!document.getElementById('boardScroll')?.classList.contains('is-dragging');
}
/* Unified tooltip timing:
     - Cold show: 400ms appear delay, then fade in.
     - Hide: 50ms fade-out (CSS transition on opacity).
     - Warm hand-off: if a new tooltip is requested while the old one is still
       visible OR within the 50ms fade-out window, snap the new content in
       instantly — no appear delay, no fade-in animation.
   The appear delay is JS-driven (setTimeout) so we control whether to skip it
   for warm hand-offs; it isn't expressed as CSS transition-delay anymore. */
const __TIP_DELAY_MS = 400;
const __TIP_FADE_OUT_MS = 50;
let __tipShowTimer = null;
let __tipHideAt = 0;
function __isWarmShow(t){
  if(t.classList.contains('show')) return true;
  return __tipHideAt && (performance.now() - __tipHideAt) < __TIP_FADE_OUT_MS;
}
function __scheduleShow(t, isWarm){
  if(isWarm){
    // Snap to fully visible: kill any in-flight transition, add .show, flush
    // layout, then restore the CSS-driven transition for future changes.
    t.style.transition = 'none';
    t.classList.add('show');
    void t.offsetWidth;
    t.style.transition = '';
  } else {
    __tipShowTimer = setTimeout(() => {
      t.classList.add('show');
      __tipShowTimer = null;
    }, __TIP_DELAY_MS);
  }
}
/* Position the tip above the anchor rect (centered horizontally), flipping
   below when the viewport doesn't have room. Horizontal clamp keeps it
   fully on-screen on tight edges. Used by both showTip and showTipHTML. */
function __positionTipForAnchor(t, anchor){
  t.classList.add('tip-anchored');
  const tw = t.offsetWidth;
  const th = t.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  const gap = 6, edge = 8;
  let top = anchor.top - th - gap;
  if(top < edge) top = Math.min(anchor.bottom + gap, vh - th - edge);
  let left = anchor.left + anchor.width / 2 - tw / 2;
  left = Math.max(edge, Math.min(left, vw - tw - edge));
  t.style.left = left + 'px';
  t.style.top = top + 'px';
}
function showTip(text, x, y, opts){
  if(isInteractionSuppressed()) return;
  const t = ensureTip();
  if(__tipShowTimer){ clearTimeout(__tipShowTimer); __tipShowTimer = null; }
  const isWarm = __isWarmShow(t);
  t.textContent = text;
  t.classList.remove('multiline');
  if(opts && opts.anchor){
    __positionTipForAnchor(t, opts.anchor);
  } else {
    t.classList.remove('tip-anchored');
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  }
  __scheduleShow(t, isWarm);
}
function showTipHTML(html, x, y, opts){
  if(isInteractionSuppressed()) return;
  const t = ensureTip();
  if(__tipShowTimer){ clearTimeout(__tipShowTimer); __tipShowTimer = null; }
  const isWarm = __isWarmShow(t);
  t.innerHTML = html;
  if(opts && opts.multiline) t.classList.add('multiline'); else t.classList.remove('multiline');
  if(opts && opts.anchor){
    __positionTipForAnchor(t, opts.anchor);
  } else {
    t.classList.remove('tip-anchored');
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  }
  __scheduleShow(t, isWarm);
}
function hideTip(){
  if(__tipShowTimer){ clearTimeout(__tipShowTimer); __tipShowTimer = null; }
  if(__tipEl){
    if(__tipEl.classList.contains('show')) __tipHideAt = performance.now();
    __tipEl.classList.remove('show');
  }
}

/* Owner-row tooltip — body-level so it can't be clipped by the sticky sidebar */
function setupOwnerTip(){
  document.querySelectorAll('.owner-row').forEach(row=>{
    const owner = row.querySelector('.owner-name')?.textContent || '';
    row.addEventListener('mouseenter', ()=>{
      if(document.body.classList.contains('is-proj-dragging')) return;
      const r = row.getBoundingClientRect();
      const html = `<strong>Owner/PM: ${escape(owner)}</strong>Expand to view all members and planned schedule`;
      // Anchor below the owner-row, aligned to its left edge
      showTipHTML(html, r.left, r.bottom + 4, {multiline:true});
    });
    row.addEventListener('mouseleave', hideTip);
  });
}
/* Timeline cell hover: highlight the hovered cell and show "+" on empty cells */
function setupCellHover(){
  const board = document.querySelector('.board');
  if(!board) return;

  function cellWidthPx(){
    const dw = parseFloat(getComputedStyle(board).getPropertyValue('--day-w')) || 72;
    return board.classList.contains('is-week-mode') ? dw * 5 : dw;
  }

  function setupLane(lane, kind){
    let overlay = null;
    function ensureOverlay(){
      if(overlay) return overlay;
      overlay = document.createElement('div');
      overlay.className = 'cell-hover';
      const btn = document.createElement('button');
      btn.className = 'add-btn';
      btn.textContent = '+';
      btn.dataset.tip = kind === 'milestone' ? 'Add milestone' : 'Add work item';
      btn.addEventListener('mouseenter', ()=>{
        const r = btn.getBoundingClientRect();
        showTip(btn.dataset.tip, r.left + r.width/2, r.top - 6);
      });
      btn.addEventListener('mouseleave', hideTip);
      btn.addEventListener('click', e=>{
        e.stopPropagation();
        hideTip();
        // Always compute day index using dayW so the chosen cell matches the
        // actual date the user clicked on, even in week-display mode (where
        // a cell is 5 days wide). The overlay's left is already snapped to
        // the cell's leading edge (Monday in week mode).
        const cellLeft = parseFloat(overlay.style.left) || 0;
        const startIdx = Math.round(cellLeft / dayW);
        const isWeek = document.querySelector('.board').classList.contains('is-week-mode');
        const tuple = isoFromTimelineIdx(startIdx);
        const r = btn.getBoundingClientRect();
        if(kind === 'milestone'){
          const pid = lane.dataset.pid;
          openMilestonePopover({ pid, ms:null, defaultDate:tuple, anchor:r });
        } else {
          const pid = lane.dataset.pid;
          const memberName = lane.dataset.member;
          // In week mode default to the full Mon–Fri span; otherwise a 1-day item.
          const endIdx = isWeek ? Math.min(TIMELINE.length-1, startIdx + 5) : startIdx;
          const startTuple = tuple;
          const endTuple = isoFromTimelineIdx(endIdx);
          openWorkItemPopover({ pid, item:null, defaultMember:memberName, defaultStart:startTuple, defaultEnd:endTuple, anchor:r });
        }
      });
      overlay.appendChild(btn);
      lane.appendChild(overlay);
      return overlay;
    }

    function occupant(cellLeft, cellW){
      const laneRect = lane.getBoundingClientRect();
      const left = laneRect.left + cellLeft;
      const right = left + cellW;
      const items = kind === 'work'
        ? lane.querySelectorAll(':scope > .wi')
        : lane.closest('.project-group').querySelectorAll(':scope > .milestone');
      for(const el of items){
        const r = el.getBoundingClientRect();
        // For milestones the bar is only 2px wide — use the bar's center to find the cell.
        const probe = kind === 'milestone' ? (r.left + r.right)/2 : null;
        if(probe !== null){
          if(probe >= left && probe < right) return el;
        } else {
          if(r.right > left + 2 && r.left < right - 2) return el;
        }
      }
      return null;
    }

    let hoveredMilestone = null;
    function clearHoveredMilestone(){
      if(hoveredMilestone){ hoveredMilestone.classList.remove('is-hovered'); hoveredMilestone = null; }
    }
    function applyMilestoneCardVars(ms){
      const idx = parseInt(ms.dataset.idx, 10);
      const dw = parseFloat(getComputedStyle(board).getPropertyValue('--day-w')) || 72;
      const isWeek = board.classList.contains('is-week-mode');
      const cellW = isWeek ? dw * 5 : dw;
      // Card always starts at the milestone marker, not at the week's cell-start.
      const cardL = 0;
      // Anchor card to the .project (header row) so it spans the row's full visual
      // height — works the same whether member rows are collapsed or expanded.
      const projectEl = ms.closest('.project-group').querySelector('.project');
      const msRect = ms.getBoundingClientRect();
      const pRect  = projectEl.getBoundingClientRect();
      const cardT = pRect.top - msRect.top;
      const cardH = pRect.height;
      // Content extent — cover flag/title/desc + a touch of right padding
      const titleEl = ms.querySelector('.ms-title');
      const descEl  = ms.querySelector('.ms-desc');
      const flagEl  = ms.querySelector('.ms-flag');
      const contentRight = Math.max(
        flagEl  ? flagEl.offsetLeft  + flagEl.offsetWidth  : 0,
        titleEl ? titleEl.offsetLeft + titleEl.scrollWidth : 0,
        descEl  ? descEl.offsetLeft  + descEl.scrollWidth  : 0
      );
      const cardW = Math.min(360, Math.max(cellW, contentRight - cardL + 12));
      ms.style.setProperty('--card-l', cardL + 'px');
      ms.style.setProperty('--card-t', cardT + 'px');
      ms.style.setProperty('--card-h', cardH + 'px');
      ms.style.setProperty('--card-w', cardW + 'px');
      // In week mode, the tooltip shows the milestone date on its own line above the action hint.
      const tip = ms.querySelector('.ms-tooltip');
      if(tip){
        tip.innerHTML = isWeek
          ? `<strong>${escape(ms.dataset.date || '')}</strong>Drag to move · Click to edit`
          : 'Drag to move · Click to edit';
      }
    }

    lane.addEventListener('mousemove', e=>{
      const ov = ensureOverlay();
      // Suppress cell hover while dragging/resizing a work item, dragging a milestone,
      // or panning the timeline
      if(document.body.classList.contains('is-item-dragging')
        || document.getElementById('boardScroll')?.classList.contains('is-dragging')){
        ov.classList.remove('is-active');
        clearHoveredMilestone();
        return;
      }
      // Defer to the work item hover state when directly over one
      if(e.target.closest('.wi')){
        ov.classList.remove('is-active');
        clearHoveredMilestone();
        return;
      }
      const rect = lane.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const cellW = cellWidthPx();
      if(cellW <= 0) return;
      const idx = Math.floor(x / cellW);
      const cellLeft = idx * cellW;
      const occ = occupant(cellLeft, cellW);

      if(kind === 'milestone' && occ){
        // Cell contains a milestone — promote it to hovered state, hide cell overlay
        ov.classList.remove('is-active');
        if(hoveredMilestone !== occ){
          clearHoveredMilestone();
          hoveredMilestone = occ;
          applyMilestoneCardVars(hoveredMilestone);
          hoveredMilestone.classList.add('is-hovered');
        }
        return;
      }
      clearHoveredMilestone();
      ov.style.left = cellLeft + 'px';
      ov.style.width = cellW + 'px';
      ov.classList.add('is-active');
      ov.classList.toggle('is-occupied', !!occ);
    });
    lane.addEventListener('mouseleave', (e)=>{
      // Don't clear if the cursor moved onto the currently-hovered milestone (e.g., onto its flag).
      if(hoveredMilestone){
        const r = e.relatedTarget;
        if(r && r.closest && r.closest('.milestone') === hoveredMilestone){
          if(overlay) overlay.classList.remove('is-active');
          return;
        }
      }
      if(overlay) overlay.classList.remove('is-active');
      clearHoveredMilestone();
    });

    // Also engage hover state when the cursor sits directly on a milestone's flag —
    // the flag is a sibling of the lane (not a descendant), so lane.mousemove never fires there.
    // The .ms-hit element handles the rest of the hover-card area when a popover is open
    // (it gets pointer-events:auto only in that state to avoid flicker normally).
    if(kind === 'milestone'){
      const group = lane.closest('.project-group');
      function engageHover(ms){
        if(document.body.classList.contains('is-item-dragging')) return;
        if(document.getElementById('boardScroll')?.classList.contains('is-dragging')) return;
        if(hoveredMilestone === ms) return;
        if(overlay) overlay.classList.remove('is-active');
        clearHoveredMilestone();
        hoveredMilestone = ms;
        applyMilestoneCardVars(hoveredMilestone);
        hoveredMilestone.classList.add('is-hovered');
      }
      function maybeReleaseHover(e, ms){
        const r = e.relatedTarget;
        // Returning to the lane — lane.mousemove will re-evaluate.
        if(r && r.closest && r.closest('.project-summary') === lane) return;
        // Moving to another part of the same milestone — keep hovered.
        if(r && r.closest && r.closest('.milestone') === ms) return;
        clearHoveredMilestone();
      }
      group.querySelectorAll(':scope > .milestone').forEach(ms=>{
        const flag = ms.querySelector('.ms-flag');
        if(flag){
          flag.addEventListener('mouseenter', ()=> engageHover(ms));
          flag.addEventListener('mouseleave', e=> maybeReleaseHover(e, ms));
        }
        const hit = ms.querySelector('.ms-hit');
        if(hit){
          hit.addEventListener('mouseenter', ()=> engageHover(ms));
          hit.addEventListener('mouseleave', e=> maybeReleaseHover(e, ms));
        }
      });
    }
  }

  document.querySelectorAll('.member-lane').forEach(l => setupLane(l, 'work'));
  document.querySelectorAll('.project-summary').forEach(l => {
    // Team-view summary rows have no milestones — skip the milestone-add affordance.
    if(l.closest('.team-group')) return;
    setupLane(l, 'milestone');
  });
}
/* Per-summary "+" affordance: a single overlay element follows the cursor across
   the team-summary row and shows a "+" when the cursor is over an EMPTY cell.
   This replaces the previous per-cell button (one button per empty cell added
   ~3000 DOM nodes per render). The overlay is re-attached on each renderApp
   from mountBoard's deferred setup. */
function setupTeamSummaryAddHover(){
  document.querySelectorAll('.project-group.team-group .project-summary').forEach(summary => {
    if(summary.__addHoverBound) return;
    summary.__addHoverBound = true;
    let overlay = null;
    function ensureOverlay(){
      // Re-attach if the cached element was wiped by an innerHTML rebuild
      // (refreshTeamHeatmapDeferred replaces summary.innerHTML on add/delete).
      if(overlay && overlay.isConnected) return overlay;
      if(!overlay){
        overlay = document.createElement('div');
        overlay.className = 'team-load-add-overlay';
        overlay.innerHTML = '<button type="button" class="team-load-add" tabindex="-1">+</button>';
      }
      summary.appendChild(overlay);
      return overlay;
    }
    summary.addEventListener('mousemove', e=>{
      if(document.body.classList.contains('is-item-dragging')
        || document.getElementById('boardScroll')?.classList.contains('is-dragging')){
        if(overlay) overlay.classList.remove('is-active');
        return;
      }
      // Only activate the overlay when the cursor is over an actual workload
      // block — the 4px gutter between cells has pointer-events:none on the
      // .team-load-cell so its own events fall through to the summary, which
      // is exactly what we want to ignore here. If the cursor lands on the
      // overlay itself (e.g. the "+" button), keep the overlay's current
      // state — deactivating would hide the button and cause flicker as the
      // cursor immediately re-enters the block underneath.
      if(e.target && e.target.closest && e.target.closest('.team-load-add-overlay')) return;
      const block = e.target && e.target.closest && e.target.closest('.team-load-block');
      const cell = block && block.closest('.team-load-cell');
      if(!cell){
        if(overlay) overlay.classList.remove('is-active');
        return;
      }
      const idx = parseInt(cell.dataset.idx, 10);
      if(isNaN(idx)){
        if(overlay) overlay.classList.remove('is-active');
        return;
      }
      const cssDayW = parseFloat(getComputedStyle(summary).getPropertyValue('--day-w')) || 72;
      const ov = ensureOverlay();
      ov.style.left = (idx * cssDayW) + 'px';
      ov.dataset.idx = String(idx);
      ov.classList.add('is-active');
      // The tint shows on every cell. The "+" shows on empty + workload
      // cells (so users can add time off on top of existing assignments);
      // it stays hidden on cells that already have a leave — those open
      // the popover via a click on the leave stripe itself.
      ov.classList.toggle('is-addable', !cell.classList.contains('has-leave'));
      // Richer tint on cells that carry actual workload stripes (excluding
      // pure-leave cells and the empty-half spacer used for am/pm leaves).
      const hasWork = !!cell.querySelector('.team-load-stripe:not(.is-leave):not(.is-empty-half)');
      ov.classList.toggle('is-occupied', hasWork);
      // Clip the tint to the stripe under the cursor in multi-stripe cells, so
      // the user sees which specific work item / leave they're about to click.
      // Cells with one stripe (or cursor not on any stripe — e.g. on the "+"
      // button) fall back to a cell-wide tint via the var() defaults.
      const stripeEl = e.target && e.target.closest && e.target.closest('.team-load-stripe');
      const clipStripe = stripeEl
        && cell.contains(stripeEl)
        && !stripeEl.classList.contains('is-empty-half')
        && cell.querySelectorAll('.team-load-stripe:not(.is-empty-half)').length > 1;
      if(clipStripe){
        const sr = stripeEl.getBoundingClientRect();
        const orect = ov.getBoundingClientRect();
        ov.style.setProperty('--hl-top', (sr.top - orect.top) + 'px');
        ov.style.setProperty('--hl-bottom', (orect.bottom - sr.bottom) + 'px');
      } else {
        ov.style.removeProperty('--hl-top');
        ov.style.removeProperty('--hl-bottom');
      }
    });
    summary.addEventListener('mouseleave', ()=>{
      if(overlay) overlay.classList.remove('is-active');
    });
  });
}
(function setupTeamLoadAdd(){
  if(document.body.__teamLoadAddBound) return;
  document.body.__teamLoadAddBound = true;
  document.addEventListener('mouseenter', e=>{
    const btn = e.target && e.target.closest && e.target.closest('.team-load-add');
    if(!btn) return;
    // Anchor on the underlying cell so the tip sits above the workload block,
    // not inside it. The "+" button is in a separate overlay layer; reading
    // its idx from the parent overlay is how we know which cell it covers.
    const overlay = btn.closest('.team-load-add-overlay');
    const summary = btn.closest('.project-summary');
    const idx = overlay && parseInt(overlay.dataset.idx, 10);
    const cell = (summary && !isNaN(idx))
      ? summary.querySelector(`.team-load-cell[data-idx="${idx}"]`)
      : null;
    const anchor = (cell || btn).getBoundingClientRect();
    showTip('Add time off', 0, 0, { anchor });
  }, true);
  document.addEventListener('mouseleave', e=>{
    const btn = e.target && e.target.closest && e.target.closest('.team-load-add');
    if(!btn) return;
    hideTip();
  }, true);
  // Multiline tooltip on existing leave stripes — bold day-type, optional notes line.
  document.addEventListener('mouseenter', e=>{
    const stripe = e.target && e.target.closest && e.target.closest('.team-load-stripe.is-leave');
    if(!stripe) return;
    const cell = stripe.closest('.team-load-cell');
    const summary = stripe.closest('.project-summary');
    if(!cell || !summary) return;
    const memberName = summary.dataset.team;
    const idx = parseInt(cell.dataset.idx, 10);
    if(isNaN(idx) || !memberName) return;
    const tuple = isoFromTimelineIdx(idx);
    const dayIdx = idxOf(tuple);
    const leave = (MEMBER_LEAVES[memberName] || []).find(l =>
      idxOf(l.date) === dayIdx);
    if(!leave) return;
    const dayLabel = (TIME_OFF_DAY_TYPES.find(d => d.value === leave.type) || {}).label || 'Full day';
    const catLabel = (TIME_OFF_CATEGORIES.find(c => c.value === (leave.category || 'vacation')) || {}).label || 'Vacation';
    const notes = (leave.notes || '').trim();
    const html = `<strong>${escape(catLabel)} (${escape(dayLabel)})</strong>${notes ? escape(notes) : ''}<span class="tip-hint">Click to edit</span>`;
    showTipHTML(html, 0, 0, { multiline:true, anchor: cell.getBoundingClientRect() });
  }, true);
  document.addEventListener('mouseleave', e=>{
    const stripe = e.target && e.target.closest && e.target.closest('.team-load-stripe.is-leave');
    if(!stripe) return;
    hideTip();
  }, true);
  // Multiline tooltip on workload stripes — bold project name, work item label below.
  document.addEventListener('mouseenter', e=>{
    const stripe = e.target && e.target.closest && e.target.closest('.team-load-stripe');
    if(!stripe) return;
    if(stripe.classList.contains('is-leave') || stripe.classList.contains('is-empty-half')) return;
    const pid = stripe.dataset.pid;
    const label = stripe.dataset.label || '';
    if(!pid) return;
    const projectName = pid.startsWith('__others__:')
      ? 'Others'
      : ((findProject(pid) || {}).title || '');
    const html = `<strong>${escape(projectName)}</strong>${label ? escape(label) : ''}`;
    const cell = stripe.closest('.team-load-cell');
    showTipHTML(html, 0, 0, { multiline:true, anchor: (cell || stripe).getBoundingClientRect() });
  }, true);
  document.addEventListener('mouseleave', e=>{
    const stripe = e.target && e.target.closest && e.target.closest('.team-load-stripe');
    if(!stripe) return;
    if(stripe.classList.contains('is-leave') || stripe.classList.contains('is-empty-half')) return;
    hideTip();
  }, true);
  // Empty workload cell tooltip — shown only on truly empty days (no items, no
  // leave). The "+" button lives in a sibling overlay (pointer-events:none on
  // the wrapper, auto on the button) so when the cursor is over the button
  // the cell itself isn't the event target — its mouseenter/leave naturally
  // hand off to the "Add time off" tip via the unified tooltip's warm window.
  document.addEventListener('mouseenter', e=>{
    const cell = e.target && e.target.closest && e.target.closest('.team-load-cell.is-empty');
    if(!cell) return;
    const r = cell.getBoundingClientRect();
    showTip('No planned work this day', r.left + r.width/2, r.top - 6);
  }, true);
  document.addEventListener('mouseleave', e=>{
    const cell = e.target && e.target.closest && e.target.closest('.team-load-cell.is-empty');
    if(!cell) return;
    hideTip();
  }, true);
  document.addEventListener('click', e=>{
    // Empty cell "+" → add new time off. The button now lives inside a
    // per-summary roaming overlay (not inside a specific cell), so we read
    // the day idx from the overlay's data-idx that mousemove sets.
    const btn = e.target.closest && e.target.closest('.team-load-add');
    if(btn){
      e.stopPropagation();
      hideTip();
      const overlay = btn.closest('.team-load-add-overlay');
      const summary = btn.closest('.project-summary');
      if(!overlay || !summary) return;
      const memberName = summary.dataset.team;
      const idx = parseInt(overlay.dataset.idx, 10);
      if(isNaN(idx) || !memberName) return;
      const tuple = isoFromTimelineIdx(idx);
      const r = btn.getBoundingClientRect();
      openTimeOffPopover({ memberName, defaultDate: tuple, anchor: r });
      return;
    }
    // Existing leave stripe → edit it.
    const stripe = e.target.closest && e.target.closest('.team-load-stripe.is-leave');
    if(stripe){
      e.stopPropagation();
      hideTip();
      const cell = stripe.closest('.team-load-cell');
      const summary = stripe.closest('.project-summary');
      if(!cell || !summary) return;
      const memberName = summary.dataset.team;
      const idx = parseInt(cell.dataset.idx, 10);
      if(isNaN(idx) || !memberName) return;
      const tuple = isoFromTimelineIdx(idx);
      const dayIdx = idxOf(tuple);
      const leave = (MEMBER_LEAVES[memberName] || []).find(l =>
        idxOf(l.date) === dayIdx);
      if(!leave) return;
      const r = stripe.getBoundingClientRect();
      openTimeOffPopover({ memberName, leave, anchor: r });
    }
  });
})();

/* ============================================================
 *  Re-render engine
 * ============================================================ */
function mountBoard(opts){
  // Synchronous: insert work-item HTML so the next paint shows the new state.
  // scrollToToday is intentionally NOT called here — renderApp restores the
  // user's previous scroll position immediately after mountBoard returns,
  // and forcing a scroll-then-restore cycle costs ~80ms of redundant layout.
  // The team-view heatmap is the single dominant paint cost (~150ms for ~3500
  // cells); for view switches we double-rAF its render so the user sees the
  // new view structure on the very next paint. For data-change renders (drag
  // commit etc.) we render synchronously to avoid the heatmap visibly going
  // empty for two frames before refilling.
  const deferHeatmap = !!(opts && opts.deferHeatmap);
  placeWorkItems({ skipAlign: true, deferHeatmap });
  // Bind the team-summary "+" overlay synchronously so hovering works on the
  // very first frame — adding event listeners is cheap and doesn't read
  // layout, so it doesn't block the first paint. (The other setup steps below
  // do force layout, so they stay deferred.)
  setupTeamSummaryAddHover();
  // Deferred: layout-reading setup. After the innerHTML rewrite the first
  // getBoundingClientRect costs ~100ms (full-document reflow with thousands
  // of timeline cells), so we wait for the next frame — the browser paints
  // first, then this work runs without blocking visible feedback.
  requestAnimationFrame(()=>{
    alignHatchOverlays();
    placeTodayMarker();
    setupCellHover();
    setupOwnerTip();
    setupExpandCollapse();
    setupBoardScrollbar();
    setupWiLabelClamp();
    setupPan();
    setupTodayBtn();
    setupZoomBtns();
    setupExpandAllBtn();
    setupMoreBtn();
    setupUserBtn();
  });
}
let __renderAppViewMode = viewMode;
function renderApp(){
  // Track viewMode across renders so we know when to update the toolbar's
  // segmented view-toggle's active highlight. Initialized to the current
  // viewMode so the very first user-driven switch is detected correctly.
  const isViewSwitch = __renderAppViewMode !== viewMode;
  __renderAppViewMode = viewMode;
  // Always preserve the existing #boardScroll element — only replace its
  // children. scrollLeft/scrollTop are kept intact by the browser so the user
  // stays at the same point on the timeline (across data changes AND view
  // switches), and we avoid the ~80ms forced-layout flush that read+restoring
  // scrollLeft after a full innerHTML rebuild used to cost.
  const existingScroll = document.getElementById('boardScroll');
  if(existingScroll){
    existingScroll.innerHTML = (viewMode === 'team' ? TeamBoard() : ProjectBoard());
    if(PROJECTS.length === 0){
      const board = existingScroll.querySelector('.board .rows');
      if(board){
        board.insertAdjacentHTML('beforeend', `
          <div class="empty-state">
            <div class="es-title">No active projects yet</div>
            <p class="es-desc">Add your first project to start mapping milestones and team work items on the Mission Control timeline.</p>
            <button class="btn-primary" id="emptyAddProjectBtn">
              <svg width="10" height="10" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5.5 2v7M2 5.5h7"/></svg>
              Add Project
            </button>
          </div>
        `);
      }
    }
    if(isViewSwitch){
      // The only toolbar element that depends on viewMode is the .seg toggle's
      // active highlight — flip it with a cheap class toggle (no layout cost)
      // instead of rebuilding the toolbar.
      document.querySelectorAll('.toolbar .seg button[data-view]').forEach(b=>{
        b.classList.toggle('active', b.dataset.view === viewMode);
      });
    }
    mountBoard({ deferHeatmap: isViewSwitch });
    return;
  }
  // No existing board (first mount path): full rebuild of #app.
  document.getElementById('app').innerHTML = App();
  // Insert empty state if no projects
  if(PROJECTS.length === 0){
    const board = document.querySelector('.board .rows');
    if(board){
      board.insertAdjacentHTML('beforeend', `
        <div class="empty-state">
          <div class="es-title">No active projects yet</div>
          <p class="es-desc">Add your first project to start mapping milestones and team work items on the Mission Control timeline.</p>
          <button class="btn-primary" id="emptyAddProjectBtn">
            <svg width="10" height="10" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5.5 2v7M2 5.5h7"/></svg>
            Add Project
          </button>
        </div>
      `);
    }
  }
  // First-mount path defers the heatmap too — it has the same ~150ms paint
  // cost as a view switch and we want the empty state to show fast.
  mountBoard({ deferHeatmap: true });
}

/* Refactor existing handlers into named setup fns so we can re-bind after render. */
function setupBoardScrollbar(){
  const el = document.getElementById('boardScroll');
  if(!el || el.__scrollbarBound) return;
  let timer;
  el.addEventListener('scroll', ()=>{
    el.classList.add('is-panning');
    clearTimeout(timer);
    timer = setTimeout(()=> el.classList.remove('is-panning'), 800);
  }, {passive:true});
  el.__scrollbarBound = true;
}
/* Clamp wi-label max-width to the visible portion of the bar past the sidebar,
   so the sticky label shrinks with ellipsis as the bar scrolls left out of view. */
function setupWiLabelClamp(){
  const el = document.getElementById('boardScroll');
  if(!el || el.__wiLabelBound) return;
  const sidebarW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 320;
  let raf = null;
  function update(){
    raf = null;
    const threshold = el.getBoundingClientRect().left + sidebarW + 6;
    el.querySelectorAll('.wi').forEach(wi => {
      const label = wi.querySelector('.wi-label');
      if(!label) return;
      const r = wi.getBoundingClientRect();
      if(r.left >= threshold || r.right <= threshold){
        label.style.maxWidth = '';
      } else {
        label.style.maxWidth = Math.max(0, r.right - threshold - 6) + 'px';
      }
    });
  }
  function schedule(){ if(!raf) raf = requestAnimationFrame(update); }
  el.addEventListener('scroll', schedule, {passive:true});
  window.addEventListener('resize', schedule);
  schedule();
  el.__wiLabelBound = true;
}
function setupPan(){
  const el = document.getElementById('boardScroll');
  if(!el || el.__panBound) return;
  let down=false, startX=0, startY=0, startSL=0, startST=0, moved=false;
  // Buttons that should NOT short-circuit panning — i.e., a mousedown on them
  // can begin a pan drag, and the click is suppressed if the cursor moved.
  // .add-btn = project view's cell-hover "+" affordance.
  // .team-load-add = team view's hover-overlay "+" affordance for time-off.
  const SKIP = 'button:not(.add-btn):not(.team-load-add), a, input, .wi, .ms-flag, .owner-chip, .add-project-pill, .show-toggle, .add-member, .project-side, .member-side, .empty-state';
  __startPanAt = (pageX, pageY)=>{
    down = true; moved = false;
    startX = pageX; startY = pageY;
    startSL = el.scrollLeft; startST = el.scrollTop;
    el.classList.add('is-dragging');
  };
  el.addEventListener('mousedown', e=>{
    if(e.button !== 0) return;
    if(e.target.closest(SKIP)) return;
    __startPanAt(e.pageX, e.pageY);
  });
  window.addEventListener('mousemove', e=>{
    if(!down) return;
    const dx = e.pageX - startX, dy = e.pageY - startY;
    const wasMoved = moved;
    if(Math.abs(dx)+Math.abs(dy) > 3) moved=true;
    if(moved && !wasMoved){
      // Real pan started — only NOW clear hovers and tooltips so a plain click
      // (no drag) on a cell-hover '+' button still reaches its click handler.
      hideTip();
      document.querySelectorAll('.milestone.is-hovered').forEach(m=> m.classList.remove('is-hovered'));
      document.querySelectorAll('.cell-hover.is-active').forEach(o=> o.classList.remove('is-active'));
    }
    el.scrollLeft = startSL - dx;
    el.scrollTop  = startST - dy;
  });
  window.addEventListener('mouseup', ()=>{
    if(!down) return;
    down=false;
    el.classList.remove('is-dragging');
  });
  el.addEventListener('click', e=>{
    if(moved){ e.stopPropagation(); e.preventDefault(); moved=false; }
  }, true);
  el.__panBound = true;
}
function setupTodayBtn(){
  const btn = document.getElementById('todayBtn');
  if(!btn || btn.__bound) return;
  btn.addEventListener('click', ()=> scrollToToday(true));
  btn.__bound = true;
}
function setupZoomBtns(){
  const board = document.querySelector('.board');
  const scroller = document.getElementById('boardScroll');
  if(!board || !scroller) return;
  const inBtn = document.getElementById('zoomInBtn');
  const outBtn = document.getElementById('zoomOutBtn');
  if(!inBtn || inBtn.__bound) {} else {
    inBtn.addEventListener('click', ()=> zoomBy(+1));
    inBtn.__bound = true;
  }
  if(!outBtn || outBtn.__bound) {} else {
    outBtn.addEventListener('click', ()=> zoomBy(-1));
    outBtn.__bound = true;
  }
}
function zoomBy(dir){
  const board = document.querySelector('.board');
  const scroller = document.getElementById('boardScroll');
  const prev = dayW;
  zoomIndex = Math.max(0, Math.min(ZOOM_LEVELS.length-1, zoomIndex + dir));
  dayW = ZOOM_LEVELS[zoomIndex];
  const anchor = scroller.scrollLeft + (scroller.clientWidth - sidebarW)/2;
  const ratio = dayW / prev;
  board.style.setProperty('--day-w', dayW + 'px');
  board.classList.toggle('is-week-mode', dayW <= 32);
  board.classList.toggle('is-tight', dayW <= 24);
  scroller.scrollLeft = anchor * ratio - (scroller.clientWidth - sidebarW)/2;
  alignHatchOverlays();
  // Re-fit time-off labels: the team-load cells aren't re-rendered on zoom
  // (only --day-w changes), so we need to re-measure them against the new width.
  requestAnimationFrame(fitPtoTags);
}
function setupMoreBtn(){
  const btn = document.getElementById('moreBtn');
  if(!btn || btn.__bound) return;
  btn.addEventListener('click', e=>{
    e.preventDefault();
    e.stopPropagation();
    const items = [
      { act: 'activity', label: 'Recent changes' },
      ...(ME && ME.isAdmin ? [{ act: 'admin', label: 'People & sprint settings' }] : []),
    ];
    openMenu(btn, items, act=>{
      if(act === 'activity') openActivityModal();
      if(act === 'admin') openAdminModal();
    }, { align: 'right', width: 200 });
  });
  btn.__bound = true;
}
function setupUserBtn(){
  const btn = document.getElementById('userBtn');
  if(!btn || btn.__bound) return;
  btn.addEventListener('click', e=>{
    e.preventDefault();
    e.stopPropagation();
    openMenu(btn, [
      { act: 'who', label: `${ME.name} · ${ME.email}`, disabled: true },
      { act: 'logout', label: 'Sign out' },
    ], async act=>{
      if(act !== 'logout') return;
      await Save.flushAll();
      try { await apiFetch('POST', '/auth/logout'); } catch(_){}
      location.href = '/login';
    }, { align: 'right', width: 240 });
  });
  btn.__bound = true;
}
/* Small dropdown menu anchored under a toolbar button. */
function openMenu(anchorEl, items, onPick, { align = 'left', width = 180 } = {}){
  document.querySelectorAll('.dropdown.__moredrop').forEach(d=> d.remove());
  const r = anchorEl.getBoundingClientRect();
  const dd = document.createElement('div');
  dd.className = 'dropdown __moredrop';
  dd.style.minWidth = width + 'px';
  dd.innerHTML = items.map(it => `<div class="opt${it.disabled ? ' is-info' : ''}" data-act="${escape(it.act)}"><span class="opt-name">${escape(it.label)}</span></div>`).join('');
  dd.style.left = (align === 'right' ? r.right - width : r.left) + 'px';
  dd.style.top  = (r.bottom + 4) + 'px';
  document.body.appendChild(dd);
  dd.querySelectorAll('.opt:not(.is-info)').forEach(o => o.addEventListener('click', ()=>{
    dd.remove();
    onPick(o.dataset.act);
  }));
  setTimeout(()=> bindOutside(dd), 0);
}

function isAllGroupsExpanded(){
  const groups = [...document.querySelectorAll('.project-group')];
  if(groups.length === 0) return false;
  return groups.every(g => g.querySelector('.project')?.classList.contains('has-members'));
}
function refreshExpandAllBtn(){
  const btn = document.getElementById('expandAllBtn');
  if(!btn) return;
  const ICON_EXPAND   = '<path d="M3 5l4-3 4 3"/><path d="M3 9l4 3 4-3"/>';
  const ICON_COLLAPSE = '<path d="M3 2l4 3 4-3"/><path d="M3 12l4-3 4 3"/>';
  const svg = btn.querySelector('svg');
  const allExp = isAllGroupsExpanded();
  if(svg) svg.innerHTML = allExp ? ICON_COLLAPSE : ICON_EXPAND;
  btn.lastChild.textContent = allExp ? '\n        Collapse All\n      ' : '\n        Expand All\n      ';
}
function setupExpandAllBtn(){
  const btn = document.getElementById('expandAllBtn');
  if(!btn) return;
  if(!btn.__bound){
    btn.addEventListener('click', ()=>{
      const target = !isAllGroupsExpanded();
      document.querySelectorAll('.project-group').forEach(g => target ? expandGroup(g) : collapseGroup(g));
      if(viewMode === 'project'){ PROJECTS.forEach(p=> p.expanded = target); saveExpandedIds(); }
      // Batch the layout-flushing alignment + button refresh once at the end —
      // expandGroup/collapseGroup intentionally skip them so we don't pay for
      // 9 layout flushes when toggling all 9 teams at once.
      alignHatchOverlays();
      refreshExpandAllBtn();
    });
    btn.__bound = true;
  }
  // Re-sync label/icon to the current view's actual state — important after
  // a view switch, where expansion state is per-view (project vs team).
  refreshExpandAllBtn();
}

/* ============================================================
 *  Modal / popover / panel infrastructure
 * ============================================================ */
let __overlayStack = [];
function closeAllOverlays(){
  __overlayStack.forEach(el => el.remove());
  __overlayStack = [];
  __openPanelPid = null;
  __refreshOpenPanelMilestones = null;
  document.removeEventListener('keydown', onOverlayKey);
}
function onOverlayKey(e){
  if(e.key === 'Escape'){ closeAllOverlays(); }
}
function pushOverlay(el){
  __overlayStack.push(el);
  document.body.appendChild(el);
  document.addEventListener('keydown', onOverlayKey);
}
function closePopoversOnly(){
  __overlayStack = __overlayStack.filter(el=>{
    if(el.classList && (el.classList.contains('popover') || el.classList.contains('popover-scrim'))){
      el.remove();
      return false;
    }
    return true;
  });
}
function closePopover(pop){
  __overlayStack = __overlayStack.filter(el=> el !== pop && el !== pop.__scrim);
  if(pop.__scrim){ pop.__scrim.remove(); pop.__scrim = null; }
  pop.remove();
}
let __openPanelPid = null;
let __refreshOpenPanelMilestones = null;
function refreshOpenPanel(){
  if(__refreshOpenPanelMilestones && document.querySelector('.modal.project-edit-modal')){
    __refreshOpenPanelMilestones();
  }
}
function buildScrim(onBackdrop){
  const s = document.createElement('div');
  s.className = 'scrim';
  s.addEventListener('mousedown', e=>{
    if(e.target === s){ if(onBackdrop) onBackdrop(); else closeAllOverlays(); }
  });
  return s;
}

/* ----------------- Add Project modal ----------------- */
function openAddProjectModal(){
  closeAllOverlays();
  const scrim = buildScrim();
  const modal = document.createElement('div');
  modal.className = 'modal project-edit-modal';

  const tintKeys = Object.keys(TINTS);
  // The draft doubles as a project-shaped object so the milestone popover
  // can mutate `draft.milestones` directly without us pre-pushing into PROJECTS.
  const draft = {
    id: nid(),
    __draft: true, // milestone edits stay local until "Add project" is pressed
    title: "",
    key: "",
    ownerId: "",
    memberIds: [],
    status: "On Track",
    tint: tintKeys.filter(k => k !== 'gray')[PROJECTS.length % (tintKeys.length - 1)],
    milestones: [{ id: nid(), date: todayISO(), title: "Kick Off", desc: "", type: "Kickoff" }],
    startDate: { mode: 'milestone' },
    endDate: { mode: 'undefined' },
    mode: 'manual',
  };

  modal.innerHTML = `
    <div class="modal-color-band" data-bind="band" style="background:${TINTS[draft.tint].tint}"></div>
    <div class="modal-body" style="max-height:calc(100vh - 160px);overflow:auto">
      <div class="seg add-mode-seg" role="tablist">
        <button class="active" data-tab="manual">Manual input</button>
        <button data-tab="jira">Import from Jira</button>
      </div>

      <div data-pane="jira-input" style="display:none">
        <div class="field">
          <label>Jira issue link <span class="req">*</span></label>
          <div data-bind="jira-link-slot">
            <input data-bind="jira-link" type="text" placeholder="https://arcsite.atlassian.net/browse/ARC-1234" />
          </div>
          <span class="hint" data-bind="jira-status">Paste the full Jira URL of the project epic.</span>
        </div>
      </div>

      <div data-pane="form">
        <div class="title-req-wrap">
          <textarea class="modal-title-input" data-bind="title" rows="1" placeholder="Project title"></textarea>
          <span class="title-req-row" aria-hidden="true"><span class="title-req-ghost">Project title</span><span class="title-req">*</span></span>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Owner / PM <span class="req">*</span></label>
            <div data-bind="owner"></div>
          </div>
          <div class="field">
            <label>Status</label>
            <button type="button" class="status-pick" data-bind="status-tag"></button>
          </div>
          <div class="field">
            <label>Jira key</label>
            <div data-bind="jira-wrap"></div>
          </div>
        </div>
        <div class="field">
          <label>Members</label>
          <div data-bind="members"></div>
        </div>
        <div class="field">
          <label>Project color</label>
          <div class="color-swatches" data-bind="color"></div>
        </div>

        <div class="section-head" style="justify-content:flex-start;gap:6px">Duration</div>
        <div class="field-row dur-row">
          <div class="field dur-field">
            <label>Start</label>
            <button type="button" class="dur-pick" data-bind="start-pick"></button>
            <input type="date" data-bind="start-date" class="date-btn-input" tabindex="-1" />
          </div>
          <div class="field dur-field">
            <label>End</label>
            <button type="button" class="dur-pick" data-bind="end-pick"></button>
            <input type="date" data-bind="end-date" class="date-btn-input" tabindex="-1" />
          </div>
        </div>

        <div class="section-head" style="justify-content:flex-start;gap:6px">Milestones<span style="color:var(--ink-3)">·</span><span data-bind="ms-count"></span></div>
        <div data-bind="ms-list"></div>
      </div>
    </div>
    <div class="modal-foot" style="justify-content:space-between">
      <button class="btn-secondary" data-act="cancel">Cancel</button>
      <button class="btn-primary" data-act="save" disabled>Add project</button>
    </div>
  `;
  scrim.appendChild(modal);
  pushOverlay(scrim);

  const formPane = modal.querySelector('[data-pane="form"]');
  const jiraInputPane = modal.querySelector('[data-pane="jira-input"]');

  // Pin the modal's top edge so it doesn't drift up/down when the tab change
  // grows or shrinks the content. We snapshot the current center-aligned top
  // once and switch to flex-start anchoring with that top as a margin.
  requestAnimationFrame(()=>{
    const r = modal.getBoundingClientRect();
    scrim.style.alignItems = 'flex-start';
    modal.style.marginTop = Math.max(8, r.top) + 'px';
  });

  // Tabs — switch between Manual (form visible) and Jira (link input first; form
  // appears once a key is detected and a mock import "completes").
  // FLIP-style height animation keeps the swap smooth.
  modal.querySelectorAll('.add-mode-seg button').forEach(b=>{
    b.addEventListener('click', ()=>{
      if(b.classList.contains('active')) return;
      const oldH = modal.offsetHeight;
      modal.querySelectorAll('.add-mode-seg button').forEach(x=> x.classList.toggle('active', x===b));
      draft.mode = b.dataset.tab;
      if(draft.mode === 'manual'){
        jiraInputPane.style.display = 'none';
        formPane.style.display = '';
      } else {
        jiraInputPane.style.display = '';
        formPane.style.display = 'none';
      }
      validate();
      // Animate height from oldH → newH, then release back to auto.
      modal.style.height = 'auto';
      const newH = modal.offsetHeight;
      modal.style.height = oldH + 'px';
      // force reflow so the next height assignment animates
      void modal.offsetHeight;
      modal.style.transition = 'height 220ms cubic-bezier(.2,.7,.2,1)';
      modal.style.height = newH + 'px';
      const done = ()=>{
        modal.style.transition = '';
        modal.style.height = '';
        modal.removeEventListener('transitionend', done);
      };
      modal.addEventListener('transitionend', done);
    });
  });

  // Title
  const titleEl = formPane.querySelector('[data-bind="title"]');
  titleEl.value = draft.title;
  titleEl.addEventListener('input', e=>{ draft.title = e.target.value; validate(); });

  // Owner picker (project-edit style)
  const ownerWrap = formPane.querySelector('[data-bind="owner"]');
  function renderOwner(){
    if(draft.ownerId){
      ownerWrap.innerHTML = `
        <button type="button" class="owner-pick-btn">
          <span class="avatar" style="background:${avatarColor(draft.ownerId)};width:18px;height:18px;font-size:9px">${initials(draft.ownerId)}</span>
          ${escape(userName(draft.ownerId))}
        </button>`;
    } else {
      ownerWrap.innerHTML = `
        <button type="button" class="add-member-btn">
          <span style="font-size:13px;line-height:1">+</span><span class="label">Choose owner</span>
        </button>`;
    }
    ownerWrap.firstElementChild.addEventListener('click', e=>{
      const r = e.currentTarget.getBoundingClientRect();
      openMemberDropdown(r, workspaceMembers(), uid=>{
        draft.ownerId = uid;
        // Don't keep the owner in the members chips
        draft.memberIds = draft.memberIds.filter(n=> n !== uid);
        renderOwner(); renderMembers(); validate();
      });
    });
  }
  renderOwner();

  // Status tag picker
  const statusTag = formPane.querySelector('[data-bind="status-tag"]');
  function renderStatusTag(){
    const sc = STATUS_CLASS[draft.status] || "ontrack";
    statusTag.className = 'status-pick ' + sc;
    statusTag.textContent = draft.status;
  }
  renderStatusTag();
  statusTag.addEventListener('click', e=>{
    e.preventDefault();
    const r = statusTag.getBoundingClientRect();
    document.querySelectorAll('.dropdown.__pickdrop').forEach(d=> d.remove());
    const dd = document.createElement('div');
    dd.className = 'dropdown __pickdrop';
    const opts = ['On Track','At Risk','Off Track'];
    dd.innerHTML = opts.map(s=>{
      const c = STATUS_CLASS[s] || 'ontrack';
      return `<div class="opt" data-val="${escape(s)}"><span class="status-pick ${c}" style="pointer-events:none">${escape(s)}</span></div>`;
    }).join('');
    positionDropdown(dd, r);
    document.body.appendChild(dd);
    dd.querySelectorAll('.opt').forEach(o=>{
      o.addEventListener('click', ()=>{
        draft.status = o.dataset.val;
        renderStatusTag();
        dd.remove();
      });
    });
    setTimeout(()=> bindOutside(dd), 0);
  });

  // Jira key inline (matches detail modal: input → display chip)
  const jiraWrap = formPane.querySelector('[data-bind="jira-wrap"]');
  function renderJiraKey(focusInput){
    const v = (draft.key || "").trim();
    if(v){
      const m = v.match(/([A-Z][A-Z0-9]+-\d+)/);
      const key = m ? m[1] : v;
      const href = /^https?:\/\//i.test(v) ? v : `https://jira/browse/${encodeURIComponent(key)}`;
      jiraWrap.innerHTML = `
        <div class="jira-display">
          <a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(key)}</a>
          <button class="x-btn" data-act="clear-jira" title="Remove">
            <svg width="9" height="9" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 2l7 7M9 2l-7 7"/></svg>
          </button>
        </div>`;
      jiraWrap.querySelector('[data-act="clear-jira"]').addEventListener('click', e=>{
        e.preventDefault();
        draft.key = '';
        renderJiraKey(true);
      });
    } else {
      jiraWrap.innerHTML = `<input data-bind="key" type="text" placeholder="Add URL" />`;
      const inp = jiraWrap.querySelector('input');
      inp.value = '';
      inp.addEventListener('input', e=>{ draft.key = e.target.value; });
      inp.addEventListener('blur', ()=>{
        if((draft.key || '').trim()) renderJiraKey(false);
      });
      if(focusInput) inp.focus();
    }
  }
  renderJiraKey(false);

  // Members chips
  const membersWrap = formPane.querySelector('[data-bind="members"]');
  function renderMembers(){
    membersWrap.innerHTML = `<div class="member-list"></div>`;
    const wrap = membersWrap.querySelector('.member-list');
    draft.memberIds.forEach(uid=>{
      const c = document.createElement('span');
      c.className = 'chip';
      c.innerHTML = `<span class="avatar" style="background:${avatarColor(uid)}">${initials(uid)}</span>${escape(userName(uid))}<span class="x" title="Remove">×</span>`;
      c.querySelector('.x').addEventListener('click', ()=>{
        draft.memberIds = draft.memberIds.filter(n=> n !== uid);
        renderMembers();
      });
      wrap.appendChild(c);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add-member-btn';
    add.innerHTML = '<span style="font-size:13px;line-height:1">+</span><span class="label">Add member</span>';
    add.addEventListener('click', ()=>{
      const r = add.getBoundingClientRect();
      const exclude = new Set([draft.ownerId, ...draft.memberIds].filter(Boolean));
      const avail = workspaceMembers().filter(n=> !exclude.has(n));
      openMemberDropdown(r, avail, uid=>{
        if(!draft.memberIds.includes(uid)) draft.memberIds.push(uid);
        renderMembers();
      });
    });
    wrap.appendChild(add);
  }
  renderMembers();

  // Color swatches
  const colorWrap = formPane.querySelector('[data-bind="color"]');
  const colorBand = modal.querySelector('[data-bind="band"]');
  function renderColor(){
    colorWrap.innerHTML = '';
    Object.entries(TINTS).forEach(([key, t])=>{
      if(key === 'gray') return; // reserved for the "Others" rows
      const sw = document.createElement('span');
      sw.className = 'sw' + (draft.tint === key ? ' active' : '');
      sw.style.background = t.tint;
      sw.title = key;
      sw.addEventListener('click', ()=>{
        draft.tint = key;
        colorWrap.querySelectorAll('.sw').forEach(s=> s.classList.remove('active'));
        sw.classList.add('active');
        if(colorBand) colorBand.style.background = TINTS[key].tint;
        renderMilestonesSection();
      });
      colorWrap.appendChild(sw);
    });
  }
  renderColor();

  // Duration pickers (mirrors detail modal). Operates on draft.startDate / endDate.
  function durLabel(side){
    const v = side==='start' ? draft.startDate : draft.endDate;
    if(v.mode === 'undefined') return 'Undefined';
    if(v.mode === 'milestone') return side==='start' ? 'First Milestone' : 'Last Milestone';
    if(v.mode === 'date' && v.date) return `${fmtShortDate(v.date)}`;
    return 'Undefined';
  }
  function renderDurPick(side){
    const btn = formPane.querySelector(`[data-bind="${side}-pick"]`);
    if(btn) btn.textContent = durLabel(side);
  }
  function openDurDropdown(side, anchor){
    const isStart = side==='start';
    const v = isStart ? draft.startDate : draft.endDate;
    document.querySelectorAll('.dropdown.__pickdrop').forEach(d=> d.remove());
    const opts = [
      { mode:'undefined', label:'Undefined' },
      { mode:'milestone', label: isStart ? 'First Milestone' : 'Last Milestone' },
      { mode:'date', label: 'Specific date…' },
    ];
    const dd = document.createElement('div');
    dd.className = 'dropdown __pickdrop';
    dd.innerHTML = opts.map(o=>`<div class="opt${v.mode===o.mode?' is-current':''}" data-mode="${o.mode}">${escape(o.label)}</div>`).join('');
    positionDropdown(dd, anchor);
    document.body.appendChild(dd);
    dd.querySelectorAll('.opt').forEach(o=>{
      o.addEventListener('click', ()=>{
        const mode = o.dataset.mode;
        if(mode === 'date'){
          const target = isStart ? draft.startDate : draft.endDate;
          target.mode = 'date';
          if(!target.date) target.date = todayISO();
          renderDurPick(side);
          const inp = formPane.querySelector(`[data-bind="${side}-date"]`);
          inp.value = target.date;
          try { inp.showPicker?.(); } catch(_){}
        } else {
          if(isStart) draft.startDate = { mode };
          else draft.endDate = { mode };
          renderDurPick(side);
        }
        dd.remove();
      });
    });
    setTimeout(()=> bindOutside(dd), 0);
  }
  formPane.querySelector('[data-bind="start-pick"]').addEventListener('click', e=>{
    openDurDropdown('start', e.currentTarget.getBoundingClientRect());
  });
  formPane.querySelector('[data-bind="end-pick"]').addEventListener('click', e=>{
    openDurDropdown('end', e.currentTarget.getBoundingClientRect());
  });
  formPane.querySelector('[data-bind="start-date"]').addEventListener('change', e=>{
    const t = (e.target.value || null);
    if(t){ draft.startDate = { mode:'date', date:t }; renderDurPick('start'); }
  });
  formPane.querySelector('[data-bind="end-date"]').addEventListener('change', e=>{
    const t = (e.target.value || null);
    if(t){ draft.endDate = { mode:'date', date:t }; renderDurPick('end'); }
  });
  renderDurPick('start');
  renderDurPick('end');

  // Milestones section (mirrors detail modal). Operates directly on
  // draft.milestones; the popover edits the same array via the proj override.
  let selectedMsId = null;
  function renderMilestonesSection(){
    const msList = formPane.querySelector('[data-bind="ms-list"]');
    if(!msList) return;
    msList.innerHTML = '';
    const countEl = formPane.querySelector('[data-bind="ms-count"]');
    if(countEl) countEl.textContent = draft.milestones.length;
    const palette = TINTS[draft.tint];
    [...draft.milestones]
      .sort((a,b)=> idxOf(a.date) - idxOf(b.date))
      .forEach(ms=>{
        const row = document.createElement('div');
        row.className = 'ms-list-row' + (ms.id === selectedMsId ? ' is-selected' : '');
        row.style.setProperty('--ms', palette.tint);
        const titleText = msDisplayTitle(ms);
        row.innerHTML = `
          <span class="ms-dot"></span>
          <span class="ms-name" title="${escape(titleText)}">${escape(titleText)}</span>
          <span class="ms-meta">${fmtShortDate(ms.date)}</span>
          <button class="x-btn" title="Delete">
            <svg width="9" height="9" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 2l7 7M9 2l-7 7"/></svg>
          </button>
        `;
        row.addEventListener('click', e=>{
          if(e.target.closest('.x-btn, .ms-confirm-actions')) return;
          const anchor = row.getBoundingClientRect();
          selectedMsId = ms.id;
          renderMilestonesSection();
          openMilestonePopover({ proj: draft, ms, anchor });
        });
        row.querySelector('.x-btn').addEventListener('click', ()=>{
          if(row.classList.contains('is-confirming')) return;
          row.classList.add('is-confirming');
          row.innerHTML = `
            <span class="ms-confirm-msg">Delete this milestone?</span>
            <span class="ms-confirm-actions">
              <button class="no" data-act="cancel">Cancel</button>
              <button class="yes" data-act="confirm">Delete</button>
            </span>
          `;
          row.querySelector('[data-act="cancel"]').addEventListener('click', ()=>{
            renderMilestonesSection();
          });
          row.querySelector('[data-act="confirm"]').addEventListener('click', ()=>{
            draft.milestones = draft.milestones.filter(x=> x.id !== ms.id);
            // If the user deletes their way down to no milestones while
            // duration is still tracking them, fall back to today's date so
            // the project still has a meaningful start/end.
            if(draft.milestones.length === 0){
              if(draft.startDate.mode === 'milestone'){
                draft.startDate = { mode: 'date', date: todayISO() };
                renderDurPick('start');
              }
              if(draft.endDate.mode === 'milestone'){
                draft.endDate = { mode: 'date', date: todayISO() };
                renderDurPick('end');
              }
            }
            renderMilestonesSection();
          });
        });
        msList.appendChild(row);
      });
    const addMs = document.createElement('button');
    addMs.type = 'button';
    addMs.className = 'add-ms-btn';
    addMs.textContent = '+ Add milestone';
    addMs.addEventListener('click', ()=>{
      let defaultDate;
      if(draft.milestones.length){
        const lastIdx = Math.max(...draft.milestones.map(m=> idxOf(m.date)));
        defaultDate = isoFromTimelineIdx(lastIdx + 1);
      }
      openMilestonePopover({ proj: draft, defaultDate, anchor: addMs.getBoundingClientRect() });
    });
    msList.appendChild(addMs);
  }
  renderMilestonesSection();
  // Wire into the shared refresh hook so the milestone popover's edits update
  // the list rendered above (the modal carries the .project-edit-modal class).
  __refreshOpenPanelMilestones = renderMilestonesSection;

  // Jira import flow
  const jiraLinkSlot = jiraInputPane.querySelector('[data-bind="jira-link-slot"]');
  const jiraStatus = jiraInputPane.querySelector('[data-bind="jira-status"]');
  let jiraUrl = '';
  let jiraImported = false;
  function jiraKeyFromUrl(s){
    const m = (s || '').trim().match(/([A-Z]{2,}-\d+)/);
    return m ? m[1] : null;
  }
  function jiraKeyFromLink(){
    const inp = jiraLinkSlot.querySelector('input');
    return jiraKeyFromUrl(inp ? inp.value : jiraUrl);
  }
  function renderJiraLinkInput(){
    jiraLinkSlot.innerHTML = `<input data-bind="jira-link" type="text" placeholder="https://arcsite.atlassian.net/browse/ARC-1234" />`;
    const inp = jiraLinkSlot.querySelector('input');
    inp.value = jiraUrl;
    inp.addEventListener('input', e=>{
      jiraUrl = e.target.value;
      validate();
    });
    inp.focus();
  }
  function renderJiraLinkDisplay(){
    const key = jiraKeyFromUrl(jiraUrl) || jiraUrl;
    const href = /^https?:\/\//i.test(jiraUrl) ? jiraUrl : `https://jira/browse/${encodeURIComponent(key)}`;
    jiraLinkSlot.innerHTML = `
      <div class="jira-display">
        <a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(jiraUrl)}</a>
        <button class="x-btn" data-act="clear-link" title="Clear">
          <svg width="9" height="9" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 2l7 7M9 2l-7 7"/></svg>
        </button>
      </div>`;
    jiraLinkSlot.querySelector('[data-act="clear-link"]').addEventListener('click', ()=>{
      // Clear → back to input, hide imported form, reset hint.
      jiraUrl = '';
      jiraImported = false;
      formPane.style.display = 'none';
      jiraStatus.textContent = 'Paste the full Jira URL of the project epic.';
      jiraStatus.removeAttribute('style');
      renderJiraLinkInput();
      validate();
    });
  }
  renderJiraLinkInput();
  function isFetchMode(){
    return draft.mode === 'jira' && !jiraImported;
  }
  async function fetchJiraProject(){
    const key = jiraKeyFromLink();
    if(!key) return;
    // Snapshot the URL value before swapping the input out.
    const inp = jiraLinkSlot.querySelector('input');
    if(inp) jiraUrl = inp.value;
    jiraStatus.innerHTML = `<div class="jira-loading"><span class="spinner"></span>Fetching from Jira…</div>`;
    let issue;
    try {
      issue = await apiFetch('GET', `/api/jira/issue/${encodeURIComponent(key)}`);
    } catch(err){
      jiraStatus.innerHTML = `<div class="jira-loading" style="color:var(--status-off)">${escape(err.message)}</div>`;
      return;
    }
    if(!modal.isConnected) return;
    draft.title = issue.title || draft.title;
    draft.key = issue.url || issue.key;
    draft.status = "On Track";
    // Jira's assignee becomes the Owner / PM when they're on the board.
    if(issue.ownerId){
      draft.ownerId = issue.ownerId;
      draft.memberIds = draft.memberIds.filter(n=> n !== issue.ownerId);
    }
    // Apply Jira's start date if present; otherwise keep the auto Kick Off
    // milestone (created when the modal opened) and anchor start to it.
    if(issue.startDate){
      draft.startDate = { mode: 'date', date: issue.startDate };
    } else {
      const hasKickoff = draft.milestones.some(m=> m.type === 'Kickoff');
      if(!hasKickoff){
        draft.milestones.unshift({
          id: nid(), date: todayISO(),
          title: 'Kick Off', desc: '', type: 'Kickoff'
        });
      }
      draft.startDate = { mode: 'milestone' };
    }
    if(issue.dueDate) draft.endDate = { mode: 'date', date: issue.dueDate };

    const ownerNote = issue.ownerId ? '' : (issue.assigneeName ? ` (assignee ${issue.assigneeName} isn't on the board yet — choose an owner)` : ' — choose an owner');
    jiraStatus.innerHTML = `<div class="jira-loading" style="color:var(--status-on)">✓ Imported from ${escape(issue.key)}${escape(ownerNote)} — review &amp; edit below</div>`;
    jiraImported = true;
    renderJiraLinkDisplay();
    // Reflect into the form pane and reveal it
    titleEl.value = draft.title;
    renderOwner(); renderStatusTag(); renderJiraKey(false); renderMembers(); renderMilestonesSection();
    renderDurPick('start'); renderDurPick('end');
    formPane.style.display = '';
    validate();
  }

  function validate(){
    const saveBtn = modal.querySelector('[data-act="save"]');
    if(isFetchMode()){
      saveBtn.textContent = 'Fetch project data';
      saveBtn.disabled = !jiraKeyFromLink();
    } else {
      saveBtn.textContent = 'Add project';
      saveBtn.disabled = !(draft.title.trim() && draft.ownerId);
    }
  }
  validate();

  modal.querySelector('[data-act="cancel"]').addEventListener('click', closeAllOverlays);
  modal.querySelector('[data-act="save"]').addEventListener('click', ()=>{
    if(isFetchMode()){ fetchJiraProject(); return; }
    const memberObjs = [
      { id: nid(), userId: draft.ownerId, role: "Owner / PM" },
      ...draft.memberIds.map(uid => ({ id: nid(), userId: uid, role: "Member" })),
    ];
    // Commit any pending-default titles in the milestone drafts.
    const milestones = draft.milestones.map(ms=>{
      const out = { ...ms };
      if(!out.title) out.title = out.type === 'Kickoff' ? 'Kick Off' : (out.type || 'Milestone');
      delete out.__pending;
      return out;
    });
    const newProj = {
      id: draft.id,
      title: draft.title.trim(),
      key: (draft.key || "").trim(),
      status: draft.status,
      tint: draft.tint,
      expanded: false,
      description: "",
      members: memberObjs,
      milestones,
      startDate: draft.startDate,
      endDate: draft.endDate,
      items: [],
      version: 0,
    };
    PROJECTS.push(newProj);
    Save.createProject(newProj);
    closeAllOverlays();
    renderApp();
  });
}

/* ----------------- Member dropdown (used by panel + modal) ----------------- */
/* Person picker. `names` is a list of user ids; onPick receives the chosen id. */
function openMemberDropdown(anchorRect, names, onPick, opts){
  // Close other dropdowns
  document.querySelectorAll('.dropdown.__pickdrop').forEach(d=> d.remove());
  if(!names.length){
    const dd = document.createElement('div');
    dd.className = 'dropdown __pickdrop';
    dd.innerHTML = `<div class="opt" style="color:var(--ink-3)">No more members</div>`;
    positionDropdown(dd, anchorRect);
    document.body.appendChild(dd);
    setTimeout(()=> bindOutside(dd), 0);
    return;
  }
  const current = opts && opts.current;
  const dd = document.createElement('div');
  dd.className = 'dropdown __pickdrop';
  dd.innerHTML = names.map(n=>`
    <div class="opt${n===current?' is-current':''}" data-name="${escape(n)}">
      <span class="avatar" style="background:${avatarColor(n)};width:18px;height:18px;font-size:9px">${initials(n)}</span>
      <span class="opt-name">${escape(userName(n))}</span>
      ${n===current?'<span class="opt-current">Assigned</span>':''}
    </div>`).join("");
  positionDropdown(dd, anchorRect);
  document.body.appendChild(dd);
  dd.querySelectorAll('.opt').forEach(o=>{
    o.addEventListener('click', ()=>{
      onPick(o.dataset.name);
      dd.remove();
    });
  });
  setTimeout(()=> bindOutside(dd), 0);
}
function positionDropdown(dd, anchor){
  dd.style.left = anchor.left + 'px';
  dd.style.top  = (anchor.bottom + 4) + 'px';
  dd.style.minWidth = Math.max(160, anchor.width) + 'px';
}
function bindOutside(dd){
  function off(e){
    if(!dd.contains(e.target)){ dd.remove(); document.removeEventListener('mousedown', off, true); }
  }
  document.addEventListener('mousedown', off, true);
}

/* ----------------- Project detail side panel ----------------- */
function openProjectPanel(pid){
  closeAllOverlays();
  __openPanelPid = pid;
  const proj = findProject(pid);
  if(!proj){ __openPanelPid = null; return; }
  const scrim = buildScrim();
  scrim.style.background = 'rgba(31,29,24,.45)';

  const panel = document.createElement('div');
  panel.className = 'modal project-edit-modal';
  panel.innerHTML = `
    <div class="modal-color-band" style="background:${TINTS[proj.tint].tint}"></div>
    <div class="modal-body" style="max-height:calc(100vh - 160px);overflow:auto">
      <textarea class="modal-title-input" data-bind="title" rows="1" placeholder="Project title"></textarea>
      <div class="field-row">
        <div class="field">
          <label>Owner / PM</label>
          <div data-bind="owner"></div>
        </div>
        <div class="field">
          <label>Status</label>
          <button type="button" class="status-pick" data-bind="status-tag"></button>
        </div>
        <div class="field">
          <label>Jira key</label>
          <div data-bind="jira-wrap"></div>
        </div>
      </div>
      <div class="field">
        <label>Members</label>
        <div data-bind="members"></div>
      </div>
      <div class="field">
        <label>Goals / Notes</label>
        <textarea data-bind="desc" placeholder="Add project goals or notes"></textarea>
      </div>
      <div class="field">
        <label>Project color</label>
        <div class="color-swatches" data-bind="color"></div>
      </div>

      <div class="section-head" style="justify-content:flex-start;gap:6px">Duration</div>
      <div class="field-row dur-row">
        <div class="field dur-field">
          <label>Start</label>
          <button type="button" class="dur-pick" data-bind="start-pick"></button>
          <input type="date" data-bind="start-date" class="date-btn-input" tabindex="-1" />
        </div>
        <div class="field dur-field">
          <label>End</label>
          <button type="button" class="dur-pick" data-bind="end-pick"></button>
          <input type="date" data-bind="end-date" class="date-btn-input" tabindex="-1" />
        </div>
      </div>

      <div class="section-head" style="justify-content:flex-start;gap:6px">Milestones<span style="color:var(--ink-3)">·</span><span data-bind="ms-count"></span></div>
      <div data-bind="ms-list"></div>
    </div>
    <div class="modal-foot" style="justify-content:space-between">
      <button class="btn-secondary" data-act="more" style="display:inline-flex;align-items:center;gap:6px">More actions <span style="display:inline-flex;align-items:center;gap:2px;opacity:.7"><span style="width:2px;height:2px;border-radius:50%;background:currentColor"></span><span style="width:2px;height:2px;border-radius:50%;background:currentColor"></span><span style="width:2px;height:2px;border-radius:50%;background:currentColor"></span></span></button>
      <button class="btn-primary" data-act="close">Done</button>
    </div>
  `;

  function fill(){
    panel.querySelector('[data-bind="title"]').value = proj.title;
    panel.querySelector('[data-bind="desc"]').value = proj.description || "";

    // Duration: start / end with three modes (undefined / milestone / date)
    if(!proj.startDate) proj.startDate = { mode: 'undefined' };
    if(!proj.endDate) proj.endDate = { mode: 'undefined' };
    function durLabel(side){
      const v = side==='start' ? proj.startDate : proj.endDate;
      if(v.mode === 'undefined') return 'Undefined';
      if(v.mode === 'milestone') return side==='start' ? 'First Milestone' : 'Last Milestone';
      if(v.mode === 'date' && v.date) return `${fmtShortDate(v.date)}`;
      return 'Undefined';
    }
    function renderDurPick(side){
      const btn = panel.querySelector(`[data-bind="${side}-pick"]`);
      if(btn) btn.textContent = durLabel(side);
    }
    function openDurDropdown(side, anchor){
      const isStart = side==='start';
      const v = isStart ? proj.startDate : proj.endDate;
      document.querySelectorAll('.dropdown.__pickdrop').forEach(d=> d.remove());
      const opts = [
        { mode:'undefined', label:'Undefined' },
        { mode:'milestone', label: isStart ? 'First Milestone' : 'Last Milestone' },
        { mode:'date', label: 'Specific date…' },
      ];
      const dd = document.createElement('div');
      dd.className = 'dropdown __pickdrop';
      dd.innerHTML = opts.map(o=>`<div class="opt${v.mode===o.mode?' is-current':''}" data-mode="${o.mode}">${escape(o.label)}</div>`).join('');
      positionDropdown(dd, anchor);
      document.body.appendChild(dd);
      dd.querySelectorAll('.opt').forEach(o=>{
        o.addEventListener('click', ()=>{
          const mode = o.dataset.mode;
          const target = isStart ? proj.startDate : proj.endDate;
          if(mode === 'date'){
            target.mode = 'date';
            if(!target.date) target.date = todayISO();
            renderDurPick(side);
            const inp = panel.querySelector(`[data-bind="${side}-date"]`);
            inp.value = target.date;
            try { inp.showPicker?.(); } catch(_){}
          } else {
            if(isStart) proj.startDate = { mode };
            else proj.endDate = { mode };
            renderDurPick(side);
          }
          Save.patchProject(proj, [isStart ? 'startDate' : 'endDate']);
          renderApp();
          dd.remove();
        });
      });
      setTimeout(()=> bindOutside(dd), 0);
    }
    panel.querySelector('[data-bind="start-pick"]').addEventListener('click', e=>{
      openDurDropdown('start', e.currentTarget.getBoundingClientRect());
    });
    panel.querySelector('[data-bind="end-pick"]').addEventListener('click', e=>{
      openDurDropdown('end', e.currentTarget.getBoundingClientRect());
    });
    panel.querySelector('[data-bind="start-date"]').addEventListener('change', e=>{
      const t = (e.target.value || null);
      if(t){ proj.startDate = { mode:'date', date:t }; renderDurPick('start'); Save.patchProject(proj, ['startDate']); renderApp(); }
    });
    panel.querySelector('[data-bind="end-date"]').addEventListener('change', e=>{
      const t = (e.target.value || null);
      if(t){ proj.endDate = { mode:'date', date:t }; renderDurPick('end'); Save.patchProject(proj, ['endDate']); renderApp(); }
    });
    renderDurPick('start');
    renderDurPick('end');

    // Jira key — display/edit like work item Add URL
    const jiraWrap = panel.querySelector('[data-bind="jira-wrap"]');
    function renderJiraKey(focusInput){
      const v = (proj.key || "").trim();
      if(v){
        const m = v.match(/([A-Z][A-Z0-9]+-\d+)/);
        const key = m ? m[1] : v;
        const href = /^https?:\/\//i.test(v) ? v : `https://jira/browse/${encodeURIComponent(key)}`;
        jiraWrap.innerHTML = `
          <div class="jira-display">
            <a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(key)}</a>
            <button class="x-btn" data-act="clear-jira" title="Remove">
              <svg width="9" height="9" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 2l7 7M9 2l-7 7"/></svg>
            </button>
          </div>`;
        jiraWrap.querySelector('[data-act="clear-jira"]').addEventListener('click', e=>{
          e.preventDefault();
          proj.key = '';
          Save.patchProject(proj, ['key']);
          renderApp();
          renderJiraKey(true);
        });
      } else {
        jiraWrap.innerHTML = `<input data-bind="key" type="text" placeholder="Add URL" />`;
        const inp = jiraWrap.querySelector('input');
        inp.value = '';
        inp.addEventListener('input', e=>{ proj.key = e.target.value; Save.patchProject(proj, ['key'], { debounce: true }); renderApp(); });
        inp.addEventListener('blur', ()=>{
          if((proj.key || '').trim()) renderJiraKey(false);
        });
        if(focusInput) inp.focus();
      }
    }
    renderJiraKey(false);

    // status tag picker
    const statusTag = panel.querySelector('[data-bind="status-tag"]');
    function renderStatusTag(){
      const sc = STATUS_CLASS[proj.status] || "ontrack";
      statusTag.className = 'status-pick ' + sc;
      statusTag.textContent = proj.status;
    }
    renderStatusTag();
    statusTag.addEventListener('click', e=>{
      e.preventDefault();
      const r = statusTag.getBoundingClientRect();
      document.querySelectorAll('.dropdown.__pickdrop').forEach(d=> d.remove());
      const dd = document.createElement('div');
      dd.className = 'dropdown __pickdrop';
      const opts = ['On Track','At Risk','Off Track'];
      dd.innerHTML = opts.map(s=>{
        const c = STATUS_CLASS[s] || 'ontrack';
        return `<div class="opt" data-val="${escape(s)}"><span class="status-pick ${c}" style="pointer-events:none">${escape(s)}</span></div>`;
      }).join('');
      positionDropdown(dd, r);
      document.body.appendChild(dd);
      dd.querySelectorAll('.opt').forEach(o=>{
        o.addEventListener('click', ()=>{
          proj.status = o.dataset.val;
          renderStatusTag();
          Save.patchProject(proj, ['status']);
          renderApp();
          dd.remove();
        });
      });
      setTimeout(()=> bindOutside(dd), 0);
    });

    // owner picker
    const ownerWrap = panel.querySelector('[data-bind="owner"]');
    function renderOwner(){
      const owner = proj.members[0] || { userId: null };
      ownerWrap.innerHTML = `
        <button type="button" class="owner-pick-btn">
          <span class="avatar" style="background:${avatarColor(owner.userId)};width:18px;height:18px;font-size:9px">${initials(owner.userId)}</span>
          ${escape(userName(owner.userId))}
        </button>`;
      ownerWrap.firstElementChild.addEventListener('click', e=>{
        const r = e.currentTarget.getBoundingClientRect();
        openMemberDropdown(r, workspaceMembers(), uid=>{
          const oldOwner = proj.members[0];
          if(oldOwner && oldOwner.userId === uid) return;
          // If new owner is already a member, remove that member entry
          proj.members = proj.members.filter((m,i)=> i===0 || m.userId !== uid);
          // Demote old owner to a member and put them right after the owner slot
          const demoted = oldOwner ? { id: oldOwner.id, userId: oldOwner.userId, role: "Member" } : null;
          proj.members[0] = { id: nid(), userId: uid, role: "Owner / PM" };
          if(demoted) proj.members.splice(1, 0, demoted);
          Save.putMembers(proj);
          renderOwner(); renderMembers();
          renderApp();
        });
      });
    }
    renderOwner();

    // members chips (excluding owner)
    const membersWrap = panel.querySelector('[data-bind="members"]');
    function renderMembers(){
      membersWrap.innerHTML = `<div class="member-list"></div>`;
      const wrap = membersWrap.querySelector('.member-list');
      proj.members.slice(1).forEach(m=>{
        const c = document.createElement('span');
        c.className = 'chip';
        c.innerHTML = `<span class="avatar" style="background:${avatarColor(m.userId)}">${initials(m.userId)}</span>${escape(userName(m.userId))}<span class="x" title="Remove">×</span>`;
        c.querySelector('.x').addEventListener('click', ()=>{
          proj.members = proj.members.filter(x=> x.id !== m.id);
          Save.putMembers(proj);
          renderMembers();
          renderApp();
        });
        wrap.appendChild(c);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'add-member-btn';
      add.innerHTML = '<span style="font-size:13px;line-height:1">+</span><span class="label">Add member</span>';
      add.addEventListener('click', ()=>{
        const r = add.getBoundingClientRect();
        const exclude = new Set(proj.members.map(m=> m.userId));
        const avail = workspaceMembers().filter(n=> !exclude.has(n));
        openMemberDropdown(r, avail, uid=>{
          proj.members.push({ id: nid(), userId: uid, role: "Member" });
          Save.putMembers(proj);
          renderMembers();
          renderApp();
        });
      });
      wrap.appendChild(add);
    }
    renderMembers();

    // color swatches
    const colorWrap = panel.querySelector('[data-bind="color"]');
    colorWrap.innerHTML = "";
    Object.entries(TINTS).forEach(([key, t])=>{
      if(key === 'gray') return; // reserved for the "Others" rows
      const sw = document.createElement('span');
      sw.className = 'sw' + (proj.tint === key ? ' active' : '');
      sw.style.background = t.tint;
      sw.title = key;
      sw.addEventListener('click', ()=>{
        proj.tint = key;
        Save.patchProject(proj, ['tint']);
        colorWrap.querySelectorAll('.sw').forEach(s=> s.classList.remove('active'));
        sw.classList.add('active');
        const band = panel.querySelector('.modal-color-band');
        if(band) band.style.background = TINTS[key].tint;
        renderMilestonesSection();
        renderApp();
      });
      colorWrap.appendChild(sw);
    });

    renderMilestonesSection();
  }
  let selectedMsId = null;
  function renderMilestonesSection(){
    const msList = panel.querySelector('[data-bind="ms-list"]');
    if(!msList) return;
    msList.innerHTML = "";
    const countEl = panel.querySelector('[data-bind="ms-count"]');
    if(countEl) countEl.textContent = proj.milestones.length;
    const palette = TINTS[proj.tint];
    [...proj.milestones]
      .sort((a,b)=> idxOf(a.date) - idxOf(b.date))
      .forEach(ms=>{
        const row = document.createElement('div');
        row.className = 'ms-list-row' + (ms.id === selectedMsId ? ' is-selected' : '');
        row.style.setProperty('--ms', palette.tint);
        row.innerHTML = `
          <span class="ms-dot"></span>
          <span class="ms-name" title="${escape(msDisplayTitle(ms))}">${escape(msDisplayTitle(ms))}</span>
          <span class="ms-meta">${fmtShortDate(ms.date)}</span>
          <button class="x-btn" title="Delete">
            <svg width="9" height="9" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 2l7 7M9 2l-7 7"/></svg>
          </button>
        `;
        row.addEventListener('click', e=>{
          if(e.target.closest('.x-btn, .ms-confirm-actions')) return;
          const anchor = row.getBoundingClientRect();
          selectedMsId = ms.id;
          renderMilestonesSection();
          openMilestonePopover({ pid: proj.id, ms, anchor });
        });
        row.querySelector('.x-btn').addEventListener('click', ()=>{
          if(row.classList.contains('is-confirming')) return;
          row.classList.add('is-confirming');
          row.innerHTML = `
            <span class="ms-confirm-msg">Delete this milestone?</span>
            <span class="ms-confirm-actions">
              <button class="no" data-act="cancel">Cancel</button>
              <button class="yes" data-act="confirm">Delete</button>
            </span>
          `;
          row.querySelector('[data-act="cancel"]').addEventListener('click', ()=>{
            renderMilestonesSection();
          });
          row.querySelector('[data-act="confirm"]').addEventListener('click', ()=>{
            proj.milestones = proj.milestones.filter(x=> x.id !== ms.id);
            Save.deleteMilestone(ms);
            renderApp();
            renderMilestonesSection();
          });
        });
        msList.appendChild(row);
      });
    const addMs = document.createElement('button');
    addMs.type = 'button';
    addMs.className = 'add-ms-btn';
    addMs.textContent = '+ Add milestone';
    addMs.addEventListener('click', ()=>{
      let defaultDate;
      if(proj.milestones.length){
        const lastIdx = Math.max(...proj.milestones.map(m=> idxOf(m.date)));
        defaultDate = isoFromTimelineIdx(lastIdx + 1);
      }
      openMilestonePopover({ pid: proj.id, defaultDate, anchor: addMs.getBoundingClientRect() });
    });
    msList.appendChild(addMs);
  }
  fill();
  __refreshOpenPanelMilestones = renderMilestonesSection;

  panel.querySelector('[data-bind="title"]').addEventListener('keydown', e=>{
    if(e.key === 'Enter'){ e.preventDefault(); e.target.blur(); }
  });
  panel.querySelector('[data-bind="title"]').addEventListener('input', e=>{ proj.title = e.target.value; Save.patchProject(proj, ['title'], { debounce: true }); renderApp(); });
  panel.querySelector('[data-bind="desc"]').addEventListener('input', e=>{ proj.description = e.target.value; Save.patchProject(proj, ['description'], { debounce: true }); });

  panel.querySelector('[data-act="close"]').addEventListener('click', closeAllOverlays);
  panel.querySelector('[data-act="more"]').addEventListener('click', e=>{
    e.preventDefault();
    e.stopPropagation();
    if(panel.querySelector('.modal-foot.confirm-foot')) return;
    document.querySelectorAll('.dropdown.__moreactdrop').forEach(d=> d.remove());
    const r = e.currentTarget.getBoundingClientRect();
    const dd = document.createElement('div');
    dd.className = 'dropdown __moreactdrop';
    const isArchived = proj.status === 'Archived';
    dd.innerHTML = `
      <div class="opt" data-val="${isArchived ? 'reactivate' : 'archive'}"><span class="opt-name">${isArchived ? 'Reactivate project' : 'Archive project'}</span></div>
      <div class="opt" data-val="delete"><span class="opt-name" style="color:var(--status-off)">Delete project</span></div>
    `;
    dd.style.left = r.left + 'px';
    dd.style.top  = (r.top - 4) + 'px';
    dd.style.transform = 'translateY(-100%)';
    dd.style.minWidth = Math.max(160, r.width) + 'px';
    document.body.appendChild(dd);
    setTimeout(()=> bindOutside(dd), 0);
    dd.querySelectorAll('.opt').forEach(o=>{
      o.addEventListener('click', ()=>{
        const action = o.dataset.val;
        dd.remove();
        if(action === 'reactivate'){
          proj.status = 'On Track';
          Save.patchProject(proj, ['status']);
          closeAllOverlays();
          renderApp();
          return;
        }
        const foot = panel.querySelector('.modal-foot');
        if(foot.classList.contains('confirm-foot')) return;
        foot.classList.add('confirm-foot');
        if(action === 'delete'){
          foot.innerHTML = `
            <span class="msg">Delete this project? This cannot be undone.</span>
            <span class="confirm-actions">
              <button class="btn-secondary" data-act="cancel-act">Cancel</button>
              <button class="btn-danger" data-act="confirm-act">Delete</button>
            </span>
          `;
          foot.querySelector('[data-act="cancel-act"]').addEventListener('click', ()=>{ closeAllOverlays(); openProjectPanel(proj.id); });
          foot.querySelector('[data-act="confirm-act"]').addEventListener('click', ()=>{
            const idx = PROJECTS.findIndex(p=> p.id === proj.id);
            if(idx>=0) PROJECTS.splice(idx,1);
            Save.deleteProject(proj);
            closeAllOverlays();
            renderApp();
          });
        } else {
          foot.innerHTML = `
            <span class="msg">Archive this project? Its status will become Archived.</span>
            <span class="confirm-actions">
              <button class="btn-secondary" data-act="cancel-act">Cancel</button>
              <button class="btn-primary" data-act="confirm-act">Archive</button>
            </span>
          `;
          foot.querySelector('[data-act="cancel-act"]').addEventListener('click', ()=>{ closeAllOverlays(); openProjectPanel(proj.id); });
          foot.querySelector('[data-act="confirm-act"]').addEventListener('click', ()=>{
            proj.status = 'Archived';
            Save.patchProject(proj, ['status']);
            closeAllOverlays();
            renderApp();
          });
        }
      });
    });
  });

  panel.addEventListener('mousedown', e=>{
    if(!document.querySelector('.popover-scrim')) return;
    if(e.target.closest('.ms-list-row, .popover')) return;
    closePopoversOnly();
    selectedMsId = null;
    renderMilestonesSection();
    e.preventDefault();
  });
  // Clear the selected milestone visual when the milestone popover closes via
  // any other path (delete, popover-scrim click, ESC).
  const popoverObserver = new MutationObserver(()=>{
    if(selectedMsId && !document.querySelector('.popover-scrim') && !document.querySelector('.popover')){
      selectedMsId = null;
      renderMilestonesSection();
    }
  });
  popoverObserver.observe(document.body, { childList: true });

  scrim.appendChild(panel);
  pushOverlay(scrim);
}

/* ----------------- Milestone popover (instant save) ----------------- */
function openMilestonePopover({ pid, proj: projArg, ms, defaultDate, anchor }){
  closePopoversOnly();
  const proj = projArg || findProject(pid);
  if(!proj) return;
  // In the "Add project" dialog the project doesn't exist on the server yet;
  // its milestones are sent along when the project is created.
  const persist = !proj.__draft;
  // Add mode: create the milestone up-front and push so all edits are live.
  const isAdd = !ms;
  if(!ms){
    // First milestone in a project defaults to a Kickoff; subsequent ones default to Milestone.
    const isFirst = proj.milestones.length === 0;
    ms = {
      id: nid(),
      title: "",
      desc: "",
      date: defaultDate || todayISO(),
      type: isFirst ? "Kickoff" : "Milestone",
      projectId: proj.id,
      version: 0,
      __pending: true,
    };
    proj.milestones.push(ms);
    if(persist) Save.createMilestone(ms);
    renderApp();
    refreshOpenPanel();
  }
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.innerHTML = `
    <button class="popover-trash" data-act="delete" title="Delete milestone">
      <svg viewBox="0 0 14 14"><path d="M3 4h8M5.5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4 4l.5 7.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L10 4"/></svg>
    </button>
    <div class="popover-body">
      <div class="field">
        <div class="duration-row">
          <button type="button" class="type-tag" data-bind="type-tag" style="--tag-bg:${TINTS[proj.tint].tint}"></button>
          <button type="button" class="date-btn" data-bind="date-btn"></button>
          <input class="date-btn-input" data-bind="date" type="date" tabindex="-1" />
        </div>
      </div>
      <textarea class="popover-title-input" data-bind="title" rows="1"></textarea>
      <div class="field">
        <textarea data-bind="desc" placeholder="Add notes"></textarea>
      </div>
    </div>
  `;
  pop.querySelector('[data-bind="title"]').value = ms.title || "";
  pop.querySelector('[data-bind="desc"]').value = ms.desc || "";

  const MS_TYPES = ['Milestone','Kickoff','Release','Review','Beta','Launch'];
  const typeTag = pop.querySelector('[data-bind="type-tag"]');
  const titleEl = pop.querySelector('[data-bind="title"]');
  function defaultMsTitle(t){ return t === 'Kickoff' ? 'Kick Off' : (t || 'Milestone'); }
  function syncTypeTag(){
    typeTag.textContent = ms.type || 'Milestone';
    titleEl.placeholder = isAdd ? defaultMsTitle(ms.type) : 'Add milestone label';
  }
  syncTypeTag();
  typeTag.addEventListener('click', e=>{
    e.preventDefault();
    const r = typeTag.getBoundingClientRect();
    document.querySelectorAll('.dropdown.__pickdrop').forEach(d=> d.remove());
    const dd = document.createElement('div');
    dd.className = 'dropdown __pickdrop';
    dd.innerHTML = MS_TYPES.map(t=>`<div class="opt" data-val="${escape(t)}">${escape(t)}</div>`).join('');
    positionDropdown(dd, r);
    document.body.appendChild(dd);
    dd.querySelectorAll('.opt').forEach(o=>{
      o.addEventListener('click', ()=>{
        ms.type = o.dataset.val;
        if(persist) Save.patchMilestone(ms, ['type']);
        syncTypeTag();
        dd.remove();
        renderApp();
        refreshOpenPanel();
      });
    });
    setTimeout(()=> bindOutside(dd), 0);
  });

  const dateInp = pop.querySelector('[data-bind="date"]');
  const dateBtn = pop.querySelector('[data-bind="date-btn"]');
  function syncDateBtn(){
    dateInp.value = ms.date;
    dateBtn.textContent = fmtSlashDate(ms.date);
  }
  syncDateBtn();
  dateBtn.addEventListener('click', ()=>{ try{ dateInp.showPicker?.(); }catch(_){} });

  function autoGrow(ta){ ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
  pop.querySelectorAll('textarea').forEach(ta=>{
    ta.addEventListener('input', ()=> autoGrow(ta));
  });
  requestAnimationFrame(()=>{
    pop.querySelectorAll('textarea').forEach(autoGrow);
    if(isAdd){
      const titleEl = pop.querySelector('[data-bind="title"]');
      titleEl.focus();
      const len = titleEl.value.length;
      try { titleEl.setSelectionRange(len, len); } catch(_){}
      setTimeout(()=> { if(document.activeElement !== titleEl) titleEl.focus(); }, 0);
    }
  });
  pop.querySelector('[data-bind="title"]').addEventListener('keydown', e=>{
    if(e.key === 'Enter'){ e.preventDefault(); e.target.blur(); }
  });
  pop.querySelector('[data-bind="title"]').addEventListener('input', e=>{
    ms.title = e.target.value;
    if(persist) Save.patchMilestone(ms, ['title'], { debounce: true });
    renderApp(); refreshOpenPanel();
  });
  dateInp.addEventListener('change', e=>{
    const t = (e.target.value || null);
    if(t){ ms.date = t; if(persist) Save.patchMilestone(ms, ['date']); syncDateBtn(); renderApp(); refreshOpenPanel(); }
  });
  pop.querySelector('[data-bind="desc"]').addEventListener('input', e=>{
    ms.desc = e.target.value;
    if(persist) Save.patchMilestone(ms, ['desc'], { debounce: true });
    renderApp(); refreshOpenPanel();
  });

  // Top-right trash with light secondary confirmation.
  const trashBtn = pop.querySelector('[data-act="delete"]');
  let confirmEl = null;
  function dismissTrashConfirm(){
    if(!confirmEl) return;
    confirmEl.remove(); confirmEl = null;
    pop.removeEventListener('mousedown', onPopMousedown, true);
    pop.removeEventListener('focusin', onPopFocusin, true);
  }
  function onPopMousedown(ev){
    if(!confirmEl) return;
    if(confirmEl.contains(ev.target)) return;
    if(trashBtn.contains(ev.target)) return;
    dismissTrashConfirm();
  }
  function onPopFocusin(ev){
    if(!confirmEl) return;
    if(confirmEl.contains(ev.target)) return;
    dismissTrashConfirm();
  }
  trashBtn.addEventListener('click', e=>{
    e.stopPropagation();
    if(confirmEl) return;
    confirmEl = document.createElement('div');
    confirmEl.className = 'trash-confirm';
    confirmEl.innerHTML = `<span class="msg">Delete this milestone?</span><span class="actions"><button class="no" data-act="no">Cancel</button><button class="yes" data-act="yes">Delete</button></span>`;
    pop.appendChild(confirmEl);
    confirmEl.querySelector('[data-act="no"]').addEventListener('click', ev=>{
      ev.stopPropagation();
      dismissTrashConfirm();
    });
    confirmEl.querySelector('[data-act="yes"]').addEventListener('click', ev=>{
      ev.stopPropagation();
      proj.milestones = proj.milestones.filter(x=> x.id !== ms.id);
      if(persist) Save.deleteMilestone(ms);
      closePopover(pop); renderApp(); refreshOpenPanel();
    });
    pop.addEventListener('mousedown', onPopMousedown, true);
    pop.addEventListener('focusin', onPopFocusin, true);
  });

  // Commit pending default title into ms.title when the popover closes.
  if(isAdd){
    const obs = new MutationObserver(()=>{
      if(!document.body.contains(pop)){
        obs.disconnect();
        if(ms.__pending && proj.milestones.includes(ms)){
          if(!ms.title){
            ms.title = defaultMsTitle(ms.type);
            if(persist) Save.patchMilestone(ms, ['title']);
          }
          delete ms.__pending;
          renderApp(); refreshOpenPanel();
        } else {
          delete ms.__pending;
        }
      }
    });
    obs.observe(document.body, { childList: true });
  }

  // Transparent scrim catches clicks/hovers behind the popover.
  const scrim = document.createElement('div');
  scrim.className = 'popover-scrim';
  scrim.addEventListener('mousedown', e=>{
    if(e.target !== scrim) return;
    closePopover(pop);
    // Forward to pan: a mousedown-and-drag on the timeline area should close
    // the popover AND begin panning, so the user's drag continues seamlessly.
    if(typeof __startPanAt === 'function') __startPanAt(e.pageX, e.pageY);
  });
  document.body.appendChild(scrim);
  pop.__scrim = scrim;
  __overlayStack.push(scrim);

  if(persist){
    pop.dataset.entity = 'milestone';
    pop.dataset.entityId = ms.id;
  }
  positionPopover(pop, anchor);
  __overlayStack.push(pop);
  document.body.appendChild(pop);
  document.addEventListener('keydown', onOverlayKey);
}

/* ----------------- Work item popover (instant save) ----------------- */
/* Scoped UI updates for a single work item — used by the work-item popover
   in place of renderApp() so we don't pay the cost of rebuilding the entire
   board (which in team view also rebuilds ~3500 team-summary cells) on every
   keystroke or picker change.
   - Replaces (or inserts) the .wi bar in the matching member-lane.
   - In team view, schedules a scoped refresh of the affected team's heatmap row;
     if the assignee changed, also refreshes the old team's row. */
function refreshWorkItemUI(proj, item, oldWho){
  if(!proj || !item) return;
  const palette = TINTS[proj.tint];
  const newHtml = WorkItemBar(item, palette, proj.id);
  // Drop every existing bar for this item — the assignee may have changed,
  // moving the bar to a different lane, so we don't try to swap in place.
  document.querySelectorAll(`.wi[data-pid="${proj.id}"][data-wid="${item.id}"]`).forEach(wi => wi.remove());
  if(viewMode === 'project'){
    const block = document.querySelector(`.member-block[data-pid="${proj.id}"]:not(.team-block)`);
    const lane = block?.querySelector(`.member-lane[data-member="${cssEscape(item.who)}"]`);
    if(lane) lane.insertAdjacentHTML('beforeend', newHtml);
  } else if(viewMode === 'team'){
    const teamBlock = document.querySelector(`.member-block.team-block[data-team="${cssEscape(item.who)}"]`);
    if(teamBlock && teamBlock.style.display !== 'none' && teamBlock.__wiPopulated){
      const row = teamBlock.querySelector(`.member-row.team-project-row[data-pid="${proj.id}"]`);
      const lane = row?.querySelector('.member-lane');
      if(lane) lane.insertAdjacentHTML('beforeend', newHtml);
    }
    refreshTeamHeatmapDeferred(item.who);
    if(oldWho && oldWho !== item.who) refreshTeamHeatmapDeferred(oldWho);
  }
}
function removeWorkItemUI(proj, item){
  if(!proj || !item) return;
  document.querySelectorAll(`.wi[data-pid="${proj.id}"][data-wid="${item.id}"]`).forEach(wi => wi.remove());
  if(viewMode === 'team') refreshTeamHeatmapDeferred(item.who);
}

function openWorkItemPopover({ pid, item, defaultMember, defaultStart, defaultEnd, anchor }){
  closePopoversOnly();
  const proj = findProject(pid);
  if(!proj) return;
  // Add mode: create the item up-front and push to the project so all edits are live.
  const isAdd = !item;
  if(isAdd){
    item = {
      id: nid(),
      projectId: proj.__isOthers ? null : proj.id,
      label: "",
      who: defaultMember || (proj.members[0] && proj.members[0].userId),
      start: defaultStart || todayISO(),
      end: defaultEnd || defaultStart || todayISO(),
      jira: "",
      notes: "",
      version: 0,
    };
    proj.items.push(item);
    Save.createWorkItem(item);
    refreshWorkItemUI(proj, item);
  }
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.width = '300px';
  pop.innerHTML = `
    <button class="popover-trash" data-act="delete" title="Delete work item">
      <svg viewBox="0 0 14 14"><path d="M3 4h8M5.5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4 4l.5 7.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L10 4"/></svg>
    </button>
    <div class="popover-body">
      <div class="field">
        <div class="duration-row">
          <button type="button" class="assignee-pick" data-bind="who-btn"></button>
          <button type="button" class="date-btn" data-bind="start-btn"></button>
          <input class="date-btn-input" data-bind="start" type="date" tabindex="-1" />
          <span class="duration-sep">–</span>
          <button type="button" class="date-btn" data-bind="end-btn"></button>
          <input class="date-btn-input" data-bind="end" type="date" tabindex="-1" />
        </div>
      </div>
      <textarea class="popover-title-input" data-bind="label" rows="1" placeholder="Work item"></textarea>
      <div class="field">
        <textarea data-bind="notes" placeholder="Add notes"></textarea>
      </div>
      <div class="field" data-bind="jira-wrap"></div>
    </div>
  `;
  pop.querySelector('[data-bind="label"]').value = item.label || "";
  const whoBtn = pop.querySelector('[data-bind="who-btn"]');
  function renderAssignee(){
    const uid = item.who || (proj.members[0] && proj.members[0].userId) || "";
    whoBtn.innerHTML = uid
      ? `<span class="avatar" style="background:${avatarColor(uid)}">${initials(uid)}</span><span class="name">${escape(userName(uid))}</span>`
      : `<span style="color:var(--ink-3)">Unassigned</span>`;
  }
  renderAssignee();
  whoBtn.addEventListener('click', e=>{
    e.preventDefault();
    hideTip();
    const r = whoBtn.getBoundingClientRect();
    const names = proj.members.map(m=> m.userId);
    openMemberDropdown(r, names, uid=>{
      const oldWho = item.who;
      item.who = uid;
      Save.patchWorkItem(item, ['who']);
      renderAssignee();
      refreshWorkItemUI(proj, item, oldWho);
    }, { current: item.who });
  });
  whoBtn.addEventListener('mouseenter', ()=>{
    const name = item.who ? userName(item.who) : (proj.members[0] ? userName(proj.members[0].userId) : "Unassigned");
    const pr = pop.getBoundingClientRect();
    const tip = ensureTip();
    showTip(`${name}, click to reassign`, pr.left, pr.top - 8);
    tip.style.transform = 'translateY(-100%)';
  });
  whoBtn.addEventListener('mouseleave', ()=>{
    hideTip();
    const tip = ensureTip();
    tip.style.transform = '';
  });
  const startInp = pop.querySelector('[data-bind="start"]');
  const endInp   = pop.querySelector('[data-bind="end"]');
  const startBtn = pop.querySelector('[data-bind="start-btn"]');
  const endBtn   = pop.querySelector('[data-bind="end-btn"]');
  const fmtDate = fmtSlashDate;
  function syncDateBtns(){
    startInp.value = item.start;
    endInp.value   = item.end;
    startBtn.textContent = fmtDate(item.start);
    endBtn.textContent   = fmtDate(item.end);
  }
  syncDateBtns();
  pop.querySelector('[data-bind="notes"]').value = item.notes || "";

  // Jira link: shows as a clickable key when set, or as an "Add URL" input when empty.
  const jiraWrap = pop.querySelector('[data-bind="jira-wrap"]');
  function renderJira(focusInput){
    if(item.jira && item.jira.trim()){
      const v = item.jira.trim();
      const m = v.match(/([A-Z][A-Z0-9]+-\d+)/);
      const key = m ? m[1] : v;
      const href = /^https?:\/\//i.test(v) ? v : `https://jira/browse/${encodeURIComponent(key)}`;
      jiraWrap.innerHTML = `
        <div class="jira-display">
          <a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(key)}</a>
          <button class="x-btn" data-act="clear-jira" title="Remove">
            <svg width="9" height="9" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 2l7 7M9 2l-7 7"/></svg>
          </button>
        </div>`;
      jiraWrap.querySelector('[data-act="clear-jira"]').addEventListener('click', e=>{
        e.preventDefault();
        item.jira = '';
        Save.patchWorkItem(item, ['jira']);
        renderJira(true);
      });
    } else {
      jiraWrap.innerHTML = `<input data-bind="jira" type="text" placeholder="Add URL" />`;
      const inp = jiraWrap.querySelector('input');
      inp.value = '';
      inp.addEventListener('input', e=>{ item.jira = e.target.value; Save.patchWorkItem(item, ['jira'], { debounce: true }); });
      inp.addEventListener('blur', ()=>{
        if(item.jira && item.jira.trim()) renderJira(false);
      });
      if(focusInput) inp.focus();
    }
  }
  renderJira(false);

  const onSt = e=>{
    const t = (e.target.value || null);
    if(t){
      item.start = t;
      const sIdx = idxOf(item.start);
      const eIdx = idxOf(item.end);
      if(eIdx < sIdx || item.end < item.start) item.end = item.start;
      Save.patchWorkItem(item, ['start', 'end']);
      syncDateBtns();
      refreshWorkItemUI(proj, item);
    }
  };
  const onEn = e=>{
    const t = (e.target.value || null);
    if(t){
      const sIdx = idxOf(item.start);
      const eIdx = idxOf(t);
      if(eIdx < sIdx || t < item.start) return;
      item.end = t;
      Save.patchWorkItem(item, ['end']);
      syncDateBtns();
      refreshWorkItemUI(proj, item);
    }
  };
  function autoGrow(ta){ ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
  pop.querySelectorAll('textarea').forEach(ta=>{
    ta.addEventListener('input', ()=> autoGrow(ta));
  });
  requestAnimationFrame(()=>{
    pop.querySelectorAll('textarea').forEach(autoGrow);
    if(isAdd){
      const titleEl = pop.querySelector('[data-bind="label"]');
      titleEl.focus();
      const len = titleEl.value.length;
      try { titleEl.setSelectionRange(len, len); } catch(_){}
      // Belt-and-suspenders: re-attempt after the click sequence fully settles,
      // in case any later mousedown/blur on the lane (now re-rendered) steals focus.
      setTimeout(()=> { if(document.activeElement !== titleEl) titleEl.focus(); }, 0);
    }
  });
  pop.querySelector('[data-bind="label"]').addEventListener('keydown', e=>{
    if(e.key === 'Enter'){ e.preventDefault(); e.target.blur(); }
  });
  pop.querySelector('[data-bind="label"]').addEventListener('input', e=>{
    item.label = e.target.value;
    Save.patchWorkItem(item, ['label'], { debounce: true });
    refreshWorkItemUI(proj, item);
  });
  startInp.addEventListener('change', onSt);
  endInp.addEventListener('change', onEn);
  // Visible buttons trigger their hidden picker.
  startBtn.addEventListener('click', ()=>{ try{ startInp.showPicker?.(); }catch(_){} });
  endBtn.addEventListener('click', ()=>{ try{ endInp.showPicker?.(); }catch(_){} });
  pop.querySelector('[data-bind="notes"]').addEventListener('input', e=>{ item.notes = e.target.value; Save.patchWorkItem(item, ['notes'], { debounce: true }); });

  // Top-right trash with light secondary confirmation.
  const trashBtn = pop.querySelector('[data-act="delete"]');
  let confirmEl = null;
  function dismissTrashConfirm(){
    if(!confirmEl) return;
    confirmEl.remove(); confirmEl = null;
    pop.removeEventListener('mousedown', onPopMousedown, true);
    pop.removeEventListener('focusin', onPopFocusin, true);
  }
  function onPopMousedown(e){
    if(!confirmEl) return;
    if(confirmEl.contains(e.target)) return;
    if(trashBtn.contains(e.target)) return;
    dismissTrashConfirm();
  }
  function onPopFocusin(e){
    if(!confirmEl) return;
    if(confirmEl.contains(e.target)) return;
    dismissTrashConfirm();
  }
  function showTrashConfirm(){
    if(confirmEl) return;
    confirmEl = document.createElement('div');
    confirmEl.className = 'trash-confirm';
    confirmEl.innerHTML = `<span class="msg">Delete this work item?</span><span class="actions"><button class="no" data-act="no">Cancel</button><button class="yes" data-act="yes">Delete</button></span>`;
    pop.appendChild(confirmEl);
    confirmEl.querySelector('[data-act="no"]').addEventListener('click', e=>{
      e.stopPropagation();
      dismissTrashConfirm();
    });
    confirmEl.querySelector('[data-act="yes"]').addEventListener('click', e=>{
      e.stopPropagation();
      proj.items = proj.items.filter(x=> x.id !== item.id);
      Save.deleteWorkItem(item);
      closePopover(pop);
      removeWorkItemUI(proj, item);
    });
    pop.addEventListener('mousedown', onPopMousedown, true);
    pop.addEventListener('focusin', onPopFocusin, true);
  }
  trashBtn.addEventListener('click', e=>{
    e.stopPropagation();
    showTrashConfirm();
  });

  // Transparent scrim catches clicks/hovers behind the popover.
  const scrim = document.createElement('div');
  scrim.className = 'popover-scrim';
  scrim.addEventListener('mousedown', e=>{
    if(e.target !== scrim) return;
    closePopover(pop);
    // Forward to pan: a mousedown-and-drag on the timeline area should close
    // the popover AND begin panning, so the user's drag continues seamlessly.
    if(typeof __startPanAt === 'function') __startPanAt(e.pageX, e.pageY);
  });
  document.body.appendChild(scrim);
  pop.__scrim = scrim;
  __overlayStack.push(scrim);

  pop.dataset.entity = 'workItem';
  pop.dataset.entityId = item.id;
  positionPopover(pop, anchor);
  __overlayStack.push(pop);
  document.body.appendChild(pop);
  document.addEventListener('keydown', onOverlayKey);
}

/* Mocked time-off categories — used as the popover's "label" select.
   `short` is the 3–4 char fallback shown when the full label can't fit on the timeline. */
const TIME_OFF_CATEGORIES = [
  { value:"vacation",    label:"Vacation",    short:"VAC"  },
  { value:"sick",        label:"Sick",        short:"SICK" },
  { value:"holiday",     label:"Holiday",     short:"HOL"  },
  { value:"personal",    label:"Personal",    short:"PERS" },
  { value:"bereavement", label:"Bereavement", short:"BRV"  },
  { value:"jury",        label:"Jury duty",   short:"JURY" },
  { value:"other",       label:"Other",       short:"OTHR" },
];
const TIME_OFF_DAY_TYPES = [
  { value:"full", label:"Full day" },
  { value:"am",   label:"Morning"  },
  { value:"pm",   label:"Afternoon"},
];

function openTimeOffPopover({ memberName, leave, defaultDate, anchor }){
  closePopoversOnly();
  if(!memberName) return;
  const list = (MEMBER_LEAVES[memberName] = MEMBER_LEAVES[memberName] || []);
  const isAdd = !leave;
  if(isAdd){
    // Add mode: create the leave up-front and push live so all edits are reflected.
    leave = {
      id: nid(),
      userId: memberName,
      date: defaultDate || todayISO(),
      type: 'full',
      category: 'vacation',
      notes: '',
      version: 0,
    };
    list.push(leave);
    Save.createTimeOff(leave);
    // Scoped refresh — only the affected team's heatmap row needs to redraw.
    // Full renderApp would rebuild the entire app (including ~3500 team-summary
    // cells across all teams) and force a ~80ms layout flush; we only need the
    // one team's summary to reflect the new leave.
    refreshTeamHeatmapDeferred(memberName);
    refreshMemberLaneHatches(memberName);
  }

  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.width = '300px';
  pop.innerHTML = `
    <button class="popover-trash" data-act="delete" title="Delete time off">
      <svg viewBox="0 0 14 14"><path d="M3 4h8M5.5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4 4l.5 7.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L10 4"/></svg>
    </button>
    <div class="popover-body">
      <div class="field">
        <div class="duration-row">
          <button type="button" class="date-btn" data-bind="date-btn"></button>
          <input class="date-btn-input" data-bind="date" type="date" tabindex="-1" />
          <button type="button" class="date-btn date-btn-pick" data-bind="day-type" style="margin-left:2px"></button>
        </div>
      </div>
      <button type="button" class="popover-title-pick" data-bind="category"></button>
      <div class="field">
        <textarea data-bind="notes" placeholder="Add notes"></textarea>
      </div>
    </div>
  `;

  // Date input + visible button.
  const dateInp = pop.querySelector('[data-bind="date"]');
  const dateBtn = pop.querySelector('[data-bind="date-btn"]');
  const fmtDate = fmtSlashDate;
  function syncDateBtn(){
    dateInp.value = leave.date;
    dateBtn.textContent = fmtDate(leave.date);
  }
  syncDateBtn();
  dateInp.addEventListener('change', e=>{
    const t = (e.target.value || null);
    if(!t) return;
    // One time-off entry per person per day.
    if((MEMBER_LEAVES[memberName] || []).some(l => l !== leave && l.date === t)){
      showToast(`${userName(memberName)} already has time off on ${fmtShortDate(t)}.`, 'warn');
      syncDateBtn();
      return;
    }
    leave.date = t; Save.patchTimeOff(leave, ['date']); syncDateBtn(); refreshTeamHeatmapDeferred(memberName); refreshMemberLaneHatches(memberName);
  });
  dateBtn.addEventListener('click', ()=>{ try{ dateInp.showPicker?.(); }catch(_){} });

  // Helper: open a milestone-style custom dropdown anchored to a button.
  function openPickDropdown(triggerEl, options, currentValue, onPick){
    document.querySelectorAll('.dropdown.__pickdrop').forEach(d=> d.remove());
    const dd = document.createElement('div');
    dd.className = 'dropdown __pickdrop';
    dd.innerHTML = options.map(o =>
      `<div class="opt${o.value===currentValue ? ' is-current' : ''}" data-val="${escape(o.value)}"><span class="opt-name">${escape(o.label)}</span></div>`
    ).join('');
    const r = triggerEl.getBoundingClientRect();
    positionDropdown(dd, r);
    document.body.appendChild(dd);
    triggerEl.classList.add('is-open');
    dd.querySelectorAll('.opt').forEach(opt => {
      opt.addEventListener('click', ()=>{
        onPick(opt.dataset.val);
        dd.remove();
        triggerEl.classList.remove('is-open');
      });
    });
    // Outside-click dismissal — also clears the trigger's open state.
    setTimeout(()=>{
      function off(e){
        if(!dd.contains(e.target)){
          dd.remove();
          triggerEl.classList.remove('is-open');
          document.removeEventListener('mousedown', off, true);
        }
      }
      document.addEventListener('mousedown', off, true);
    }, 0);
  }

  // Day-type picker (Full day / Morning / Afternoon).
  const dayTypeBtn = pop.querySelector('[data-bind="day-type"]');
  function syncDayType(){
    const o = TIME_OFF_DAY_TYPES.find(x => x.value === leave.type);
    dayTypeBtn.textContent = o ? o.label : 'Full day';
  }
  syncDayType();
  dayTypeBtn.addEventListener('click', e=>{
    e.preventDefault();
    openPickDropdown(dayTypeBtn, TIME_OFF_DAY_TYPES, leave.type, val => {
      leave.type = val;
      Save.patchTimeOff(leave, ['type']);
      syncDayType();
      refreshTeamHeatmapDeferred(memberName);
      refreshMemberLaneHatches(memberName);
    });
  });

  // Category picker — acts as the popover's title.
  const catBtn = pop.querySelector('[data-bind="category"]');
  function syncCat(){
    const o = TIME_OFF_CATEGORIES.find(x => x.value === leave.category);
    catBtn.textContent = o ? o.label : 'Vacation';
  }
  syncCat();
  catBtn.addEventListener('click', e=>{
    e.preventDefault();
    openPickDropdown(catBtn, TIME_OFF_CATEGORIES, leave.category, val => {
      leave.category = val;
      Save.patchTimeOff(leave, ['category']);
      syncCat();
      refreshTeamHeatmapDeferred(memberName);
    });
  });

  // Notes textarea — auto-grow.
  const notesEl = pop.querySelector('[data-bind="notes"]');
  notesEl.value = leave.notes || '';
  function autoGrow(ta){ ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
  notesEl.addEventListener('input', e=>{
    leave.notes = e.target.value;
    Save.patchTimeOff(leave, ['notes'], { debounce: true });
    autoGrow(notesEl);
  });
  requestAnimationFrame(()=> autoGrow(notesEl));

  // Trash button with light secondary confirmation (mirrors the work-item popover).
  const trashBtn = pop.querySelector('[data-act="delete"]');
  let confirmEl = null;
  function dismissTrashConfirm(){
    if(!confirmEl) return;
    confirmEl.remove(); confirmEl = null;
    pop.removeEventListener('mousedown', onPopMousedown, true);
    pop.removeEventListener('focusin', onPopFocusin, true);
  }
  function onPopMousedown(e){
    if(!confirmEl) return;
    if(confirmEl.contains(e.target)) return;
    if(trashBtn.contains(e.target)) return;
    dismissTrashConfirm();
  }
  function onPopFocusin(e){
    if(!confirmEl) return;
    if(confirmEl.contains(e.target)) return;
    dismissTrashConfirm();
  }
  function showTrashConfirm(){
    if(confirmEl) return;
    confirmEl = document.createElement('div');
    confirmEl.className = 'trash-confirm';
    confirmEl.innerHTML = `<span class="msg">Delete this time off?</span><span class="actions"><button class="no" data-act="no">Cancel</button><button class="yes" data-act="yes">Delete</button></span>`;
    pop.appendChild(confirmEl);
    confirmEl.querySelector('[data-act="no"]').addEventListener('click', e=>{
      e.stopPropagation();
      dismissTrashConfirm();
    });
    confirmEl.querySelector('[data-act="yes"]').addEventListener('click', e=>{
      e.stopPropagation();
      MEMBER_LEAVES[memberName] = (MEMBER_LEAVES[memberName] || []).filter(x=> x.id !== leave.id);
      Save.deleteTimeOff(leave);
      closePopover(pop);
      refreshTeamHeatmapDeferred(memberName);
      refreshMemberLaneHatches(memberName);
    });
    pop.addEventListener('mousedown', onPopMousedown, true);
    pop.addEventListener('focusin', onPopFocusin, true);
  }
  trashBtn.addEventListener('click', e=>{
    e.stopPropagation();
    showTrashConfirm();
  });

  // Transparent scrim catches clicks/hovers behind the popover.
  const scrim = document.createElement('div');
  scrim.className = 'popover-scrim';
  scrim.addEventListener('mousedown', e=>{
    if(e.target !== scrim) return;
    closePopover(pop);
    if(typeof __startPanAt === 'function') __startPanAt(e.pageX, e.pageY);
  });
  document.body.appendChild(scrim);
  pop.__scrim = scrim;
  __overlayStack.push(scrim);

  pop.dataset.entity = 'timeOff';
  pop.dataset.entityId = leave.id;
  positionPopover(pop, anchor);
  __overlayStack.push(pop);
  document.body.appendChild(pop);
  document.addEventListener('keydown', onOverlayKey);

  // Focus the category select so the user can immediately pick a type.
  requestAnimationFrame(()=>{
    try { catBtn.focus(); } catch(_){}
  });
}

function positionPopover(pop, anchor){
  // Position the popover near the anchor; clamp to viewport.
  document.body.appendChild(pop);
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left = (anchor ? anchor.left : 200);
  let top  = (anchor ? anchor.bottom + 6 : 120);
  if(left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  if(top + h > window.innerHeight - 8) top  = (anchor ? anchor.top - h - 6 : 80);
  if(left < 8) left = 8;
  if(top < 8) top = 8;
  pop.style.left = left + 'px';
  pop.style.top  = top + 'px';
  pop.remove(); // pushOverlay will append
}

/* ============================================================
 *  Drag/Resize: work items + milestones
 * ============================================================ */
function ensureDragTip(){
  let t = document.getElementById('__dragtip');
  if(!t){
    t = document.createElement('div');
    t.id = '__dragtip';
    t.className = 'drag-tip';
    document.body.appendChild(t);
  }
  return t;
}
function clearDragTip(){
  const t = document.getElementById('__dragtip');
  if(t) t.remove();
}
function rangeLabelFromIdx(sIdx, eIdx){
  const s = TIMELINE[Math.max(0,Math.min(TIMELINE.length-1,sIdx))];
  const e = TIMELINE[Math.max(0,Math.min(TIMELINE.length-1,eIdx))];
  if(!s) return '';
  const fmt = t => `${t.m} ${t.n}`;
  if(sIdx === eIdx) return fmt(s);
  return `${fmt(s)} → ${fmt(e)}`;
}

(function setupItemAndMilestoneInteractions(){
  // Track the drag-or-click distinction
  let down = null; // {type, el, startX, startY, ...state}

  document.addEventListener('mousedown', e=>{
    if(e.button !== 0) return;
    if(e.target.closest('.scrim, .popover, .dropdown')) return;

    // Work item handle / body
    const handle = e.target.closest('.wi-handle');
    const wi = e.target.closest('.wi');
    if(wi){
      e.stopPropagation();
      const pid = wi.dataset.pid;
      const proj = findProject(pid);
      const item = findItem(pid, wi.dataset.wid);
      if(!proj || !item) return;
      const sIdx = idxOf(item.start);
      const eIdx = idxOf(item.end);
      down = {
        type: handle ? (handle.classList.contains('l') ? 'wi-resize-l' : 'wi-resize-r') : 'wi-move',
        el: wi, pid, item, startX: e.pageX, startY: e.pageY,
        origS: sIdx, origE: eIdx, moved:false,
      };
      wi.classList.add('is-dragging');
      document.body.classList.add('is-item-dragging');
      if(handle) document.body.classList.add('is-item-resizing');
      // Lock the hover highlight to the source row only — other rows should
      // not light up under the cursor for the duration of the drag.
      const sourceRow = wi.closest('.member-row');
      if(sourceRow){
        sourceRow.classList.add('is-drag-source-row');
        down.sourceRow = sourceRow;
      }
      return;
    }
    // Milestone flag (always clickable) — and ms-hit (pointer-events enabled
    // only when a popover is open, so the entire card area becomes a drag target).
    const flag = e.target.closest('.ms-flag, .ms-hit');
    if(flag){
      e.stopPropagation();
      const ms = flag.closest('.milestone');
      if(!ms) return;
      const pid = ms.dataset.pid;
      const proj = findProject(pid);
      const mObj = findMilestone(pid, ms.dataset.mid);
      if(!proj || !mObj) return;
      const idx = parseInt(ms.dataset.idx, 10);
      down = { type: 'ms-move', el: ms, pid, msObj: mObj, startX: e.pageX, startY: e.pageY, origIdx: idx, moved:false };
      ms.classList.add('is-dragging');
      document.body.classList.add('is-item-dragging');
      document.body.classList.add('is-item-resizing');
      return;
    }
    // Hovered milestone card — bounding-rect hit-test (avoids pointer-events
    // flicker that would break cell-hover tracking).
    const hoveredMs = document.querySelector('.milestone.is-hovered');
    if(hoveredMs){
      const rect = hoveredMs.getBoundingClientRect();
      const cs = getComputedStyle(hoveredMs);
      const cardL = parseFloat(cs.getPropertyValue('--card-l')) || 0;
      const cardT = parseFloat(cs.getPropertyValue('--card-t')) || 0;
      const cardW = parseFloat(cs.getPropertyValue('--card-w')) || 0;
      const cardH = parseFloat(cs.getPropertyValue('--card-h')) || 0;
      const left = rect.left + cardL;
      const top  = rect.top  + cardT;
      if(e.clientX >= left && e.clientX <= left + cardW &&
         e.clientY >= top  && e.clientY <= top  + cardH){
        e.stopPropagation();
        const pid = hoveredMs.dataset.pid;
        const proj = findProject(pid);
        const mObj = findMilestone(pid, hoveredMs.dataset.mid);
        if(!proj || !mObj) return;
        const idx = parseInt(hoveredMs.dataset.idx, 10);
        down = { type: 'ms-move', el: hoveredMs, pid, msObj: mObj, startX: e.pageX, startY: e.pageY, origIdx: idx, moved:false };
        hoveredMs.classList.add('is-dragging');
        document.body.classList.add('is-item-dragging');
        document.body.classList.add('is-item-resizing');
        return;
      }
    }
  }, true);

  document.addEventListener('mousemove', e=>{
    if(!down) return;
    const dx = e.pageX - down.startX, dy = e.pageY - down.startY;
    if(!down.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    down.moved = true;
    // Drag/resize always snaps by individual day even in week-display mode,
    // so users can still place items on specific weekdays at any zoom.
    const deltaIdx = Math.round(dx / dayW);

    if(down.type === 'wi-move' || down.type === 'wi-resize-l' || down.type === 'wi-resize-r'){
      let s = down.origS, ed = down.origE;
      if(down.type === 'wi-move'){
        s = down.origS + deltaIdx;
        ed = down.origE + deltaIdx;
      } else if(down.type === 'wi-resize-l'){
        s = Math.min(down.origE, down.origS + deltaIdx);
      } else if(down.type === 'wi-resize-r'){
        ed = Math.max(down.origS, down.origE + deltaIdx);
      }
      // Clamp
      s = Math.max(0, Math.min(TIMELINE.length-1, s));
      ed = Math.max(0, Math.min(TIMELINE.length-1, ed));
      // Snap to workdays (TIMELINE is already workdays, so any int in range is fine)
      const span = Math.max(ed - s, 1);
      down.el.style.left  = `calc(${s} * var(--day-w) + 4px)`;
      down.el.style.width = `calc(${span} * var(--day-w) - 4px)`;
      // In team view, refresh the per-day workload heatmap so it tracks the
      // bar's new range during drag — but only when the snapped day index
      // actually changes, and limited to the affected member's row. The
      // refresh is rAF-coalesced so a fast drag doesn't rebuild cells on
      // every mousemove (which can run faster than the display can paint).
      if(viewMode === 'team' && (s !== down._tmpS || ed !== down._tmpE)){
        down.item.start = isoFromTimelineIdx(s);
        down.item.end   = isoFromTimelineIdx(ed);
        refreshTeamHeatmapDeferred(down.item.who);
      }
      // Live-refresh the wi-hatch so OFF-day stripes appear/disappear and
      // realign as the bar slides. Only fire when the snapped day index
      // changes (cheap) and there are leaves to consider for this member.
      if((s !== down._tmpS || ed !== down._tmpE) && (MEMBER_LEAVES[down.item.who] || []).length > 0){
        const old = down.el.querySelector(':scope > .wi-hatch');
        if(old) old.remove();
        const html = wiHatchHtml(down.item.who, s, ed);
        if(html){
          // Insert before the label/handles so the hatch sits below them.
          const handle = down.el.querySelector(':scope > .wi-handle.l');
          if(handle) handle.insertAdjacentHTML('beforebegin', html);
          else down.el.insertAdjacentHTML('afterbegin', html);
          alignHatchOverlays();
        }
      }
      down._tmpS = s; down._tmpE = ed;
      const tip = ensureDragTip();
      tip.textContent = rangeLabelFromIdx(s, ed);
      tip.style.left = (e.clientX + 12) + 'px';
      tip.style.top  = (e.clientY - 22) + 'px';
    } else if(down.type === 'ms-move'){
      let i = down.origIdx + deltaIdx;
      i = Math.max(0, Math.min(TIMELINE.length-1, i));
      down.el.style.left = `calc(var(--sidebar-w) + ${i} * var(--day-w))`;
      down._tmpIdx = i;
      const tip = ensureDragTip();
      tip.textContent = rangeLabelFromIdx(i, i);
      tip.style.left = (e.clientX + 12) + 'px';
      tip.style.top  = (e.clientY - 22) + 'px';
      // Live update of project tint range (covers first/last milestone case).
      const proj = findProject(down.pid);
      if(proj){
        const msIdxs = proj.milestones.map(m=>
          String(m.id) === String(down.msObj.id)
            ? i
            : idxOf(m.date)
        );
        const range = projectTintRangeFromMs(proj, msIdxs);
        const left = `calc(${range.startIdx} * var(--day-w))`;
        const width = `calc(${range.endIdx - range.startIdx} * var(--day-w))`;
        document.querySelectorAll(`.project-group[data-pid="${down.pid}"] .project-lane, .project-group[data-pid="${down.pid}"] .member-lane`).forEach(el=>{
          el.style.setProperty('--tint-left', left);
          el.style.setProperty('--tint-width', width);
        });
      }
    }
  }, true);

  document.addEventListener('mouseup', e=>{
    if(!down) return;
    const d = down; down = null;
    clearDragTip();
    document.body.classList.remove('is-item-dragging');
    document.body.classList.remove('is-item-resizing');
    if(d.el) d.el.classList.remove('is-dragging');
    // Keep the source-row highlight locked across the post-release renderApp()
    // — the rebuild would otherwise cause the :hover state to drop for a frame
    // and flicker. Capture identifiers so we can re-find the row in the new
    // DOM, plus the cursor position so we only lock if the cursor is still
    // physically over the row.
    const lockSourceRow = d.sourceRow ? {
      team: d.sourceRow.dataset.team || '',
      pid: d.sourceRow.dataset.pid || '',
      mid: d.sourceRow.dataset.mid || '',
      x: e.clientX, y: e.clientY,
    } : null;
    if(d.sourceRow) d.sourceRow.classList.remove('is-drag-source-row');
    if(!d.moved){
      // Click — open editor popover
      const r = (d.el.querySelector('.ms-flag') || d.el).getBoundingClientRect();
      if(d.type.startsWith('wi')){
        openWorkItemPopover({ pid: d.pid, item: d.item, anchor: r });
      } else if(d.type === 'ms-move'){
        openMilestonePopover({ pid: d.pid, ms: d.msObj, anchor: r });
      }
      return;
    }
    // Persist
    if(d.type.startsWith('wi')){
      const s = d._tmpS ?? d.origS;
      const ed = d._tmpE ?? d.origE;
      d.item.start = isoFromTimelineIdx(s);
      d.item.end   = isoFromTimelineIdx(ed);
      Save.patchWorkItem(d.item, ['start', 'end']);
      renderApp();
      relockSourceRowHover(lockSourceRow);
    } else if(d.type === 'ms-move'){
      const i = d._tmpIdx ?? d.origIdx;
      d.msObj.date = isoFromTimelineIdx(i);
      Save.patchMilestone(d.msObj, ['date']);
      renderApp();
    }
  }, true);

  /* After renderApp() rebuilds the DOM at drag commit, the cursor's :hover
     state on the source row may not re-engage for a frame — visible as a
     hover-flicker. If the cursor is still physically over the source row,
     re-attach .is-drag-source-row (which forces the highlight) and remove
     it the moment the cursor leaves the row. */
  function relockSourceRowHover(lock){
    if(!lock) return;
    // Team view rows: data-team + data-pid
    // Project view rows: data-pid + data-mid
    const sel = lock.team
      ? `.member-row[data-team="${cssEscape(lock.team)}"][data-pid="${cssEscape(lock.pid)}"]`
      : (lock.pid && lock.mid ? `.member-row[data-pid="${cssEscape(lock.pid)}"][data-mid="${cssEscape(lock.mid)}"]` : null);
    if(!sel) return;
    const row = document.querySelector(sel);
    if(!row) return;
    const r = row.getBoundingClientRect();
    if(lock.x < r.left || lock.x >= r.right || lock.y < r.top || lock.y >= r.bottom) return;
    // Suppress transitions on the lane backgrounds, hatch overlays, AND the
    // pseudo-elements used by the team-view opacity highlight for one frame:
    // applying .is-drag-source-row triggers style changes on the freshly
    // mounted DOM, and the existing transitions (color on wi-hatch, opacity
    // on member-side::after / member-lane::before) would animate the change —
    // visible as a flicker even though the start and end states are both the
    // highlighted look (drag-state → render-resting → relock-highlighted).
    // Element transitions go via inline style; pseudo-element transitions
    // require a CSS override class (.is-render-locked).
    const transitionVictims = row.querySelectorAll('.lane-hatch, .wi-hatch');
    transitionVictims.forEach(el => { el.style.transition = 'none'; });
    row.classList.add('is-render-locked');
    row.classList.add('is-drag-source-row');
    void row.offsetHeight; // flush computed styles
    requestAnimationFrame(() => {
      transitionVictims.forEach(el => { el.style.transition = ''; });
      row.classList.remove('is-render-locked');
    });
    const release = () => row.classList.remove('is-drag-source-row');
    row.addEventListener('mouseleave', release, { once: true });
  }
})();

/* ============================================================
 *  Click delegation: project title/key/status -> open panel
 * ============================================================ */
document.addEventListener('click', e=>{
  // Skip if a drag just ended in the project-side area (handled by reorder)
  if(document.body.classList.contains('is-proj-dragging')) return;
  // Segmented view switcher: By project / By team
  const segBtn = e.target.closest('.toolbar .seg button[data-view]');
  if(segBtn){
    const next = segBtn.dataset.view;
    if(next !== viewMode){
      viewMode = next;
      renderApp();
    }
    return;
  }
  // Add Project (header pill or empty state)
  const addBtn = e.target.closest('#addProjectBtn, #emptyAddProjectBtn');
  if(addBtn){
    e.preventDefault();
    if(projectView !== 'active'){ projectView = 'active'; renderApp(); }
    openAddProjectModal();
    return;
  }
  // Project view toggle (Active / Archived)
  const viewToggle = e.target.closest('#projectViewToggle');
  if(viewToggle){
    e.preventDefault(); e.stopPropagation();
    document.querySelectorAll('.dropdown.__viewdrop').forEach(d=> d.remove());
    const r = viewToggle.getBoundingClientRect();
    const dd = document.createElement('div');
    dd.className = 'dropdown __viewdrop';
    const opts = [
      { val:'active',   label:'Active Projects' },
      { val:'archived', label:'Archived Projects' },
    ];
    dd.innerHTML = opts.map(o=>`<div class="opt ${projectView===o.val?'is-current':''}" data-val="${o.val}"><span class="opt-name">${o.label}</span></div>`).join('');
    positionDropdown(dd, r);
    document.body.appendChild(dd);
    dd.querySelectorAll('.opt').forEach(o=>{
      o.addEventListener('click', ()=>{
        projectView = o.dataset.val;
        dd.remove();
        renderApp();
      });
    });
    setTimeout(()=> bindOutside(dd), 0);
    return;
  }
  const opener = e.target.closest('[data-action="open-panel"]');
  if(opener){
    e.preventDefault(); e.stopPropagation();
    openProjectPanel(opener.dataset.pid);
    return;
  }
});

/* ============================================================
 *  Server sync
 *
 *  Saving: each edited thing (project, milestone, work item, time off) has
 *  its own queue so its requests go out one at a time and in order. Text
 *  fields are debounced; values are read when the request is sent, so the
 *  latest text always wins. Each update carries the version we last saw; if
 *  a teammate saved in between, the server answers 409 and we merge:
 *    - they changed other fields  -> keep theirs, re-send ours (no fuss)
 *    - they changed the same field -> keep theirs and tell the user
 *
 *  Receiving: the server streams every committed change (Server-Sent
 *  Events). Changes newer than what we have are merged in, never touching
 *  fields the user is still editing. After a dropped connection the browser
 *  resumes from the last event id, so nothing is missed.
 * ============================================================ */
const CLIENT_ID = crypto.randomUUID();

class ApiError extends Error {
  constructor(status, body){
    super((body && body.error) || (status ? `Request failed (${status})` : 'Could not reach the server.'));
    this.status = status;
    this.body = body || {};
  }
}
let __redirectingToLogin = false;
function goToLogin(){
  if(__redirectingToLogin) return;
  __redirectingToLogin = true;
  location.href = '/login';
}
async function apiFetch(method, url, body){
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'X-Requested-With': 'mission-control',
        'X-Client-Id': CLIENT_ID,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch(_){
    throw new ApiError(0, { error: 'Could not reach the server. Check your connection.' });
  }
  let data = null;
  try { data = await res.json(); } catch(_){}
  if(res.status === 401){ goToLogin(); throw new ApiError(401, data); }
  if(!res.ok) throw new ApiError(res.status, data);
  return data;
}

/* ---------- entity metadata ---------- */
const ENTITY = {
  project:   { url: '/api/projects',   noun: 'project',   fields: ['title','key','status','tint','description','startDate','endDate','members'] },
  milestone: { url: '/api/milestones', noun: 'milestone', fields: ['date','title','desc','type'] },
  workItem:  { url: '/api/work-items', noun: 'work item', fields: ['who','start','end','label','notes','jira'] },
  timeOff:   { url: '/api/time-off',   noun: 'time off',  fields: ['date','type','category','notes'] },
};
const FIELD_LABEL = {
  title:'title', key:'Jira key', status:'status', tint:'color', description:'goals / notes', startDate:'start', endDate:'end',
  members:'members', date:'date', desc:'notes', type:'type', who:'assignee', start:'start date', end:'end date',
  label:'title', notes:'notes', jira:'Jira link', category:'category',
};
const clone = v => (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* Last state confirmed by the server for each local object (used to tell
   "their change" from "our change" when a save conflicts). */
const SERVER_COPY = new WeakMap();
function rememberServerCopy(kind, obj, data){
  const copy = { version: data.version };
  ENTITY[kind].fields.forEach(f => { if(f in data) copy[f] = clone(data[f]); });
  SERVER_COPY.set(obj, copy);
}

/* ---------- lookups by id ---------- */
function findProjectById(id){ return PROJECTS.find(p => p.id === id) || null; }
function findMilestoneById(id){
  for(const p of PROJECTS){ const ms = p.milestones.find(m => m.id === id); if(ms) return ms; }
  return null;
}
function workItemList(item){
  if(item.projectId){ const p = findProjectById(item.projectId); return p ? p.items : null; }
  return TEAM_OTHERS[item.who] || (TEAM_OTHERS[item.who] = []);
}
function findWorkItemById(id){
  for(const p of PROJECTS){ const it = p.items.find(x => x.id === id); if(it) return it; }
  for(const list of Object.values(TEAM_OTHERS)){ const it = list.find(x => x.id === id); if(it) return it; }
  return null;
}
function findTimeOffById(id){
  for(const list of Object.values(MEMBER_LEAVES)){ const l = list.find(x => x.id === id); if(l) return l; }
  return null;
}
function findLocal(kind, id){
  return kind === 'project' ? findProjectById(id)
    : kind === 'milestone' ? findMilestoneById(id)
    : kind === 'workItem' ? findWorkItemById(id)
    : kind === 'timeOff' ? findTimeOffById(id) : null;
}

/* ---------- building local objects from server data ---------- */
function projectFromServer(d, expandedIds){
  const p = {
    id: d.id, title: d.title, key: d.key, status: d.status, tint: d.tint, description: d.description || '',
    startDate: clone(d.startDate), endDate: clone(d.endDate),
    members: d.members.map(m => ({ ...m })),
    milestones: [], items: [],
    expanded: expandedIds ? expandedIds.has(d.id) : false,
    version: d.version,
  };
  rememberServerCopy('project', p, d);
  return p;
}
function localFromServer(kind, d){
  const obj = { ...clone(d) };
  rememberServerCopy(kind, obj, d);
  return obj;
}
function insertLocal(kind, d){
  if(kind === 'project'){
    const p = projectFromServer(d, null);
    PROJECTS.push(p);
    (d.milestones || []).forEach(ms => insertLocal('milestone', ms));
    return p;
  }
  if(kind === 'milestone'){
    const p = findProjectById(d.projectId); if(!p) return null;
    const ms = localFromServer(kind, d); p.milestones.push(ms); return ms;
  }
  if(kind === 'workItem'){
    const obj = localFromServer(kind, d);
    const list = workItemList(obj); if(!list) return null;
    list.push(obj); return obj;
  }
  if(kind === 'timeOff'){
    const obj = localFromServer(kind, d);
    (MEMBER_LEAVES[d.userId] || (MEMBER_LEAVES[d.userId] = [])).push(obj);
    return obj;
  }
  return null;
}
function removeLocal(kind, obj){
  if(!obj) return false;
  if(kind === 'project'){
    const i = PROJECTS.indexOf(obj); if(i < 0) return false;
    PROJECTS.splice(i, 1); return true;
  }
  if(kind === 'milestone'){
    const p = findProjectById(obj.projectId); if(!p) return false;
    const n = p.milestones.length; p.milestones = p.milestones.filter(m => m !== obj); return p.milestones.length !== n;
  }
  if(kind === 'workItem'){
    if(obj.projectId){
      const p = findProjectById(obj.projectId); if(!p) return false;
      const n = p.items.length; p.items = p.items.filter(x => x !== obj); return p.items.length !== n;
    }
    for(const uid of Object.keys(TEAM_OTHERS)){
      const n = TEAM_OTHERS[uid].length;
      TEAM_OTHERS[uid] = TEAM_OTHERS[uid].filter(x => x !== obj);
      if(TEAM_OTHERS[uid].length !== n) return true;
    }
    return false;
  }
  if(kind === 'timeOff'){
    for(const uid of Object.keys(MEMBER_LEAVES)){
      const n = MEMBER_LEAVES[uid].length;
      MEMBER_LEAVES[uid] = MEMBER_LEAVES[uid].filter(x => x !== obj);
      if(MEMBER_LEAVES[uid].length !== n) return true;
    }
  }
  return false;
}

/* Merge authoritative server data into a local object. Ignores data that is
   not newer than what we already have, and never overwrites a field the
   user has unsaved edits in. Returns true when something visible changed. */
function acceptServerData(kind, obj, data, { force = [] } = {}){
  const known = SERVER_COPY.get(obj);
  if(known && data.version <= known.version && !force.length) return false;
  const q = SAVE_QUEUES.get(`${kind}:${obj.id}`);
  const dirty = new Set(q ? [...q.pending, ...q.inflight] : []);
  force.forEach(f => dirty.delete(f));
  const prevWho = obj.who;
  let changed = false;
  ENTITY[kind].fields.forEach(f => {
    if(!(f in data) || dirty.has(f)) return;
    if(sameValue(obj[f], data[f])) return;
    obj[f] = clone(data[f]);
    changed = true;
  });
  if(!known || data.version > known.version || force.length){
    obj.version = Math.max(obj.version || 0, data.version);
    rememberServerCopy(kind, obj, data);
  }
  // An "Others" work item handed to someone else moves to their row.
  if(kind === 'workItem' && !obj.projectId && prevWho !== obj.who){
    if(TEAM_OTHERS[prevWho]) TEAM_OTHERS[prevWho] = TEAM_OTHERS[prevWho].filter(x => x !== obj);
    (TEAM_OTHERS[obj.who] || (TEAM_OTHERS[obj.who] = [])).push(obj);
  }
  return changed;
}

/* ---------- save queues ---------- */
const SAVE_QUEUES = new Map();
const DEBOUNCE_MS = 500;
let __savesOutstanding = 0;
let __offline = false;

function saveQueue(kind, obj){
  const key = `${kind}:${obj.id}`;
  let q = SAVE_QUEUES.get(key);
  if(!q){
    q = { key, kind, obj, chain: Promise.resolve(), pending: new Set(), inflight: new Set(), timer: null, deleted: false, cancelled: false };
    SAVE_QUEUES.set(key, q);
  }
  q.obj = obj;
  return q;
}
function isTransient(err){ return err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504; }
function enqueue(q, what, fn, attempt = 0){
  __savesOutstanding++;
  updateFooter();
  q.chain = q.chain.then(async ()=>{
    if(q.cancelled) return;
    try {
      await fn();
      if(__offline){ __offline = false; updateFooter(); }
    } catch(err){
      if(isTransient(err) && attempt < 10){
        // Network hiccup or deploy in progress: keep the change and try again.
        __offline = true;
        const delay = Math.min(30000, 1000 * 2 ** attempt);
        setTimeout(()=> enqueue(q, what, fn, attempt + 1), delay);
        return;
      }
      handleSaveError(q, err, what);
    }
  }).finally(()=>{
    __savesOutstanding--;
    updateFooter();
  });
  return q.chain;
}

function schedulePatch(kind, obj, fields, { debounce = false } = {}){
  if(!obj || !obj.id) return;
  const q = saveQueue(kind, obj);
  if(q.deleted) return;
  fields.forEach(f => q.pending.add(f));
  clearTimeout(q.timer);
  q.timer = null;
  if(debounce){
    q.timer = setTimeout(()=>{ q.timer = null; enqueueFlush(q); }, DEBOUNCE_MS);
    updateFooter();
  } else {
    enqueueFlush(q);
  }
}
function enqueueFlush(q){
  return enqueue(q, `save your change to this ${ENTITY[q.kind].noun}`, ()=> flushFields(q));
}
async function flushFields(q){
  const fields = [...q.pending];
  q.pending.clear();
  if(!fields.length || q.deleted) return;
  const obj = q.obj, meta = ENTITY[q.kind];
  fields.forEach(f => q.inflight.add(f));
  try {
    if(q.kind === 'project' && fields.includes('members')){
      const res = await apiFetch('PUT', `${meta.url}/${obj.id}/members`, {
        members: obj.members.map(m => ({ userId: m.userId, role: m.role })),
      });
      q.inflight.delete('members');
      // Adopt the server's member ids so later edits refer to the same rows.
      if(sameValue(obj.members.map(m => m.userId), res.members.map(m => m.userId))) obj.members = res.members.map(m => ({ ...m }));
      if(acceptServerData('project', obj, res)) scheduleRemoteRender();
    }
    const rest = fields.filter(f => f !== 'members');
    if(!rest.length) return;
    const body = { version: obj.version };
    rest.forEach(f => { body[f] = clone(obj[f]); });
    let res;
    try {
      res = await apiFetch('PATCH', `${meta.url}/${obj.id}`, body);
    } catch(err){
      if(err.status === 409 && err.body && err.body.current){
        resolveConflict(q, rest, err.body.current);
        return;
      }
      if(isTransient(err)) rest.forEach(f => q.pending.add(f));
      throw err;
    }
    rest.forEach(f => q.inflight.delete(f));
    if(acceptServerData(q.kind, obj, res)) scheduleRemoteRender();
  } finally {
    fields.forEach(f => q.inflight.delete(f));
  }
}
/* Someone saved this item after we last heard from the server. */
function resolveConflict(q, fields, current){
  const obj = q.obj, base = SERVER_COPY.get(obj) || {};
  // Fields they changed since we last heard from the server.
  const theirs = fields.filter(f => !sameValue(current[f], base[f]));
  const retry = fields.filter(f => !theirs.includes(f));
  fields.forEach(f => q.inflight.delete(f));
  // Our other fields stay "dirty" so the merge below can't overwrite them.
  retry.forEach(f => q.pending.add(f));
  // Take everything they changed; where both edited the same field, keep
  // theirs, since ours never reached the server.
  acceptServerData(q.kind, obj, current, { force: theirs });
  theirs.forEach(f => q.pending.delete(f));
  if(theirs.length){
    const names = theirs.map(f => FIELD_LABEL[f] || f).join(', ');
    showToast(`Someone else changed this ${ENTITY[q.kind].noun}'s ${names} at the same moment. Their version was kept — please check it.`, 'warn');
    refreshOpenPopoverFields(q.kind, obj);
    refreshOpenEditors();
  }
  scheduleRemoteRender();
  if(retry.length) enqueueFlush(q);
}
function handleSaveError(q, err, what){
  if(err.status === 401) return;
  if(err.status === 404){
    // Deleted by someone else while we were editing it.
    q.cancelled = true;
    SAVE_QUEUES.delete(q.key);
    if(removeLocal(q.kind, q.obj)) scheduleRemoteRender();
    closeOrphanedOverlays();
    showToast(`This ${ENTITY[q.kind].noun} was deleted by someone else, so your change could not be saved.`, 'warn');
    return;
  }
  showToast(`Couldn't ${what}: ${err.message}`, 'error');
  resyncAll();
}

const Save = {
  createProject(p){
    const q = saveQueue('project', p);
    enqueue(q, 'add the project', async ()=>{
      const res = await apiFetch('POST', ENTITY.project.url, {
        id: p.id, title: p.title, key: p.key, status: p.status, tint: p.tint, description: p.description || '',
        startDate: p.startDate, endDate: p.endDate,
        members: p.members.map(m => ({ userId: m.userId, role: m.role })),
        milestones: p.milestones.map(ms => ({ id: ms.id, date: ms.date, title: ms.title, desc: ms.desc || '', type: ms.type })),
      });
      p.members = res.project.members.map(m => ({ ...m }));
      acceptServerData('project', p, res.project);
      res.milestones.forEach(sm => {
        const lm = p.milestones.find(m => m.id === sm.id);
        if(lm){ lm.projectId = p.id; acceptServerData('milestone', lm, sm); }
      });
    });
  },
  patchProject(p, fields, opts){ if(!p.__draft) schedulePatch('project', p, fields, opts); },
  putMembers(p){ if(!p.__draft) schedulePatch('project', p, ['members']); },
  deleteProject(p){
    // Its milestones and work items go with it; drop any edits still queued for them.
    for(const q of SAVE_QUEUES.values()){
      if(q.obj && q.obj.projectId === p.id){ q.cancelled = true; clearTimeout(q.timer); SAVE_QUEUES.delete(q.key); }
    }
    deleteEntity('project', p);
  },
  reorderProjects(){
    const q = saveQueue('order', { id: 'projects' });
    enqueue(q, 'save the project order', async ()=>{
      await apiFetch('PUT', '/api/projects/order', { ids: PROJECTS.map(p => p.id) });
    });
  },

  createMilestone(ms){ createEntity('milestone', ms, { id: ms.id, projectId: ms.projectId, date: ms.date, title: ms.title, desc: ms.desc, type: ms.type }); },
  patchMilestone(ms, fields, opts){ schedulePatch('milestone', ms, fields, opts); },
  deleteMilestone(ms){ deleteEntity('milestone', ms); },

  createWorkItem(it){ createEntity('workItem', it, { id: it.id, projectId: it.projectId, who: it.who, start: it.start, end: it.end, label: it.label, notes: it.notes, jira: it.jira }); },
  patchWorkItem(it, fields, opts){ schedulePatch('workItem', it, fields, opts); },
  deleteWorkItem(it){ deleteEntity('workItem', it); },

  createTimeOff(l){ createEntity('timeOff', l, { id: l.id, userId: l.userId, date: l.date, type: l.type, category: l.category, notes: l.notes }); },
  patchTimeOff(l, fields, opts){ schedulePatch('timeOff', l, fields, opts); },
  deleteTimeOff(l){ deleteEntity('timeOff', l); },

  /* Send every debounced edit now (before signing out / leaving the page). */
  async flushAll(){
    for(const q of SAVE_QUEUES.values()){
      if(q.timer){ clearTimeout(q.timer); q.timer = null; enqueueFlush(q); }
    }
    await Promise.all([...SAVE_QUEUES.values()].map(q => q.chain));
  },
  hasUnsaved(){
    return __savesOutstanding > 0 || [...SAVE_QUEUES.values()].some(q => q.timer || q.pending.size);
  },
};
function createEntity(kind, obj, body){
  const q = saveQueue(kind, obj);
  enqueue(q, `add the ${ENTITY[kind].noun}`, async ()=>{
    // Send current values — the user may have typed since this was queued.
    Object.keys(body).forEach(k => { if(k in obj) body[k] = clone(obj[k]); });
    const res = await apiFetch('POST', ENTITY[kind].url, body);
    acceptServerData(kind, obj, res);
  });
}
function deleteEntity(kind, obj){
  const q = saveQueue(kind, obj);
  clearTimeout(q.timer);
  q.timer = null;
  q.pending.clear();
  q.deleted = true;
  enqueue(q, `delete the ${ENTITY[kind].noun}`, async ()=>{
    await apiFetch('DELETE', `${ENTITY[kind].url}/${obj.id}`);
    SAVE_QUEUES.delete(q.key);
  });
}

/* ---------- full reload (after errors or a long disconnect) ---------- */
let __resyncing = null;
function resyncAll(){
  if(__resyncing) return __resyncing;
  __resyncing = (async ()=>{
    for(const q of SAVE_QUEUES.values()){ q.cancelled = true; clearTimeout(q.timer); }
    SAVE_QUEUES.clear();
    try {
      const state = await apiFetch('GET', '/api/state');
      applyState(state);
      closeAllOverlays();
      onCalendarChanged();
    } catch(err){
      showToast(`Couldn't reload the board: ${err.message}`, 'error');
    } finally {
      __resyncing = null;
    }
  })();
  return __resyncing;
}

function applyState(state){
  ME = state.me;
  USERS.clear();
  state.users.forEach(u => USERS.set(u.id, u));
  if(state.settings && state.settings.sprint) SPRINT = state.settings.sprint;
  const expanded = loadExpandedIds();
  PROJECTS = state.projects.map(p => projectFromServer(p, expanded));
  TEAM_OTHERS = Object.create(null);
  MEMBER_LEAVES = Object.create(null);
  state.milestones.forEach(ms => insertLocal('milestone', ms));
  state.workItems.forEach(it => insertLocal('workItem', it));
  state.timeOff.forEach(l => insertLocal('timeOff', l));
  __lastEventId = state.lastEventId;
  __lastChange = state.lastChange;
}

/* ---------- realtime stream ---------- */
let __lastEventId = 0;
let __lastChange = null;
let __conn = 'connecting'; // 'connecting' | 'live' | 'reconnecting'
let __eventSource = null;

function connectEvents(){
  if(__eventSource) __eventSource.close();
  const es = new EventSource(`/api/events?since=${__lastEventId}`);
  __eventSource = es;
  es.addEventListener('open', ()=>{ __conn = 'live'; updateFooter(); });
  es.addEventListener('change', e=>{
    try { applyRemoteEvent(JSON.parse(e.data)); }
    catch(err){ console.error('Could not apply change', err); resyncAll(); }
  });
  es.addEventListener('resync', ()=>{ Save.flushAll().finally(resyncAll); });
  es.addEventListener('signed-out', ()=>{ es.close(); goToLogin(); });
  es.addEventListener('error', ()=>{
    __conn = 'reconnecting';
    updateFooter();
    if(es.readyState === EventSource.CLOSED){
      // The browser gave up (e.g. the session ended). Check, then reconnect.
      setTimeout(async ()=>{
        try { await apiFetch('GET', '/api/activity?limit=1'); } catch(_){ /* 401 redirects */ }
        if(!__redirectingToLogin) connectEvents();
      }, 3000);
    }
  });
}

function applyRemoteEvent(ev){
  if(ev.id <= __lastEventId) return;
  __lastEventId = ev.id;
  __lastChange = { at: ev.at, actorId: ev.actorId };
  const mine = ev.clientId === CLIENT_ID;
  let changed = false;
  const kind = ev.entity;

  if(ENTITY[kind]){
    const obj = findLocal(kind, ev.entityId);
    if(ev.op === 'delete'){
      if(obj){
        const q = SAVE_QUEUES.get(`${kind}:${obj.id}`);
        if(q){ q.cancelled = true; clearTimeout(q.timer); SAVE_QUEUES.delete(q.key); }
        changed = removeLocal(kind, obj);
        if(changed && !mine) noteRemoteDeletion(kind, obj, ev);
      }
    } else if(obj){
      changed = acceptServerData(kind, obj, ev.data);
      if(kind === 'project' && ev.op === 'create'){
        (ev.data.milestones || []).forEach(ms => {
          const lm = findMilestoneById(ms.id);
          if(lm) acceptServerData('milestone', lm, ms); else { insertLocal('milestone', ms); changed = true; }
        });
      }
    } else {
      // New to us (created by a teammate, or a create we only now hear about).
      const q = SAVE_QUEUES.get(`${kind}:${ev.entityId}`);
      if(!(q && q.deleted)) changed = !!insertLocal(kind, ev.data);
    }
  } else if(kind === 'projectOrder'){
    if(!mine){
      const ids = ev.data.ids || [];
      const rank = p => { const i = ids.indexOf(p.id); return i === -1 ? ids.length : i; };
      PROJECTS.sort((a,b)=> rank(a) - rank(b));
      changed = true;
    }
  } else if(kind === 'user'){
    USERS.set(ev.data.id, ev.data);
    if(ME && ev.data.id === ME.id) ME = ev.data;
    changed = true;
    refreshAdminModal();
  } else if(kind === 'settings'){
    if(ev.data.sprint){ SPRINT = ev.data.sprint; onCalendarChanged(); }
    refreshAdminModal();
  }

  updateFooter();
  if(changed){
    closeOrphanedOverlays();
    if(!mine) refreshOpenEditors();
    scheduleRemoteRender();
  }
}

function noteRemoteDeletion(kind, obj, ev){
  const who = userName(ev.actorId);
  const openPop = document.querySelector(`.popover[data-entity="${kind}"][data-entity-id="${cssEscape(obj.id)}"]`);
  if(openPop){
    showToast(`${who} deleted this ${ENTITY[kind].noun}.`, 'warn');
  } else if(kind === 'project' && String(__openPanelPid) === String(obj.id)){
    showToast(`${who} deleted the project “${obj.title}”.`, 'warn');
  }
}

/* Close any popover / panel whose subject no longer exists. */
function closeOrphanedOverlays(){
  document.querySelectorAll('.popover[data-entity]').forEach(pop => {
    if(!findLocal(pop.dataset.entity, pop.dataset.entityId)) closePopover(pop);
  });
  if(__openPanelPid && !findProjectById(__openPanelPid) && document.querySelector('.modal.project-edit-modal')){
    closeAllOverlays();
  }
}
/* Refresh open editors that show data a teammate just changed. Inputs the
   user is typing in are left alone. */
function refreshOpenEditors(){
  refreshOpenPanel();
  const panel = document.querySelector('.modal.project-edit-modal');
  const proj = __openPanelPid && findProjectById(__openPanelPid);
  if(panel && proj){
    const t = panel.querySelector('[data-bind="title"]');
    const d = panel.querySelector('[data-bind="desc"]');
    if(t && document.activeElement !== t && t.value !== proj.title) t.value = proj.title;
    if(d && document.activeElement !== d && d.value !== (proj.description || '')) d.value = proj.description || '';
  }
}

/* After a conflict, show the kept value in an open popover's text boxes. */
function refreshOpenPopoverFields(kind, obj){
  const pop = document.querySelector(`.popover[data-entity="${kind}"][data-entity-id="${cssEscape(obj.id)}"]`);
  if(!pop) return;
  const map = { milestone: { title: 'title', desc: 'desc' }, workItem: { label: 'label', notes: 'notes' }, timeOff: { notes: 'notes' } }[kind] || {};
  Object.entries(map).forEach(([field, bind]) => {
    const el = pop.querySelector(`[data-bind="${bind}"]`);
    if(el && 'value' in el) el.value = obj[field] || '';
  });
}

/* Re-render for remote changes, but never in the middle of a drag. */
let __remoteRenderPending = false;
function scheduleRemoteRender(){
  if(__remoteRenderPending) return;
  __remoteRenderPending = true;
  requestAnimationFrame(flushDeferredRemoteRender);
}
function isUserDragging(){
  const b = document.body.classList;
  return b.contains('is-item-dragging') || b.contains('is-proj-dragging') || b.contains('is-member-dragging');
}
function flushDeferredRemoteRender(){
  if(!__remoteRenderPending) return;
  if(isUserDragging()) return; // picked up again on mouseup
  __remoteRenderPending = false;
  renderApp();
  refreshOpenPanel();
}
document.addEventListener('mouseup', ()=> setTimeout(flushDeferredRemoteRender, 0));

/* Sprint settings changed or the date rolled over. */
function onCalendarChanged(){
  rebuildTimeline();
  const label = document.getElementById('sprintRange');
  if(label) label.textContent = currentSprintLabel();
  if(document.getElementById('boardScroll')) renderApp();
}

/* ---------- footer status ---------- */
function fmtDateTime(iso){
  const d = new Date(iso);
  if(Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function footerStatusHtml(){
  const conn = __offline || __conn === 'reconnecting'
    ? `<span class="sync-dot is-off"></span>${__offline ? 'Offline — will retry' : 'Reconnecting…'}`
    : __conn === 'live'
      ? `<span class="sync-dot is-live"></span>Live`
      : `<span class="sync-dot"></span>Connecting…`;
  const saving = Save.hasUnsaved() ? 'Saving…' : 'All changes saved';
  const last = __lastChange && __lastChange.at
    ? ` · Last change ${escape(fmtDateTime(__lastChange.at))}${__lastChange.actorId ? ` by ${escape(userName(__lastChange.actorId))}` : ''}`
    : '';
  return `${conn} · ${saving}${last}`;
}
function updateFooter(){
  const el = document.getElementById('footerStatus');
  if(el) el.innerHTML = footerStatusHtml();
}
window.addEventListener('beforeunload', e=>{
  if(!Save.hasUnsaved()) return;
  Save.flushAll();
  e.preventDefault();
  e.returnValue = '';
});
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'hidden') Save.flushAll();
});

/* ---------- toasts ---------- */
function showToast(message, kind = 'info'){
  let stack = document.querySelector('.toast-stack');
  if(!stack){
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  const t = document.createElement('div');
  t.className = `toast is-${kind}`;
  t.textContent = message;
  t.title = 'Click to dismiss';
  t.addEventListener('click', ()=> t.remove());
  stack.appendChild(t);
  setTimeout(()=> t.remove(), kind === 'info' ? 5000 : 9000);
}

/* ============================================================
 *  Recent changes (activity log)
 * ============================================================ */
function describeEvent(ev){
  const who = ev.actorId ? userName(ev.actorId) : 'Someone';
  const d = ev.data || {};
  const verb = ev.op === 'create' ? 'added' : ev.op === 'delete' ? 'deleted' : 'updated';
  const projTitle = pid => { const p = pid && findProjectById(pid); return p ? `“${p.title}”` : (pid ? 'a deleted project' : 'Others'); };
  let what = '';
  switch(ev.entity){
    case 'project':   what = `project “${d.title || ''}”`; break;
    case 'milestone': what = `milestone “${msDisplayTitle(d)}” in ${projTitle(d.projectId)}`; break;
    case 'workItem':  what = `work item “${d.label || 'Work item'}” (${userName(d.who)}) in ${projTitle(d.projectId)}`; break;
    case 'timeOff':   what = `time off for ${userName(d.userId)} on ${d.date ? fmtShortDate(d.date) : ''}`; break;
    case 'user':      what = `person ${d.name || ''}`; break;
    case 'settings':  what = 'sprint settings'; break;
    default:          what = ev.entity;
  }
  const details = [];
  const ch = ev.changes || {};
  const show = v => {
    if(v === null || v === undefined || v === '') return '—';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 40 ? s.slice(0, 40) + '…' : s;
  };
  Object.entries(ch).forEach(([col, pair])=>{
    if(!Array.isArray(pair)) return;
    const [a, b] = pair;
    if(col === 'members'){
      const names = list => (list || []).map(m => userName(m.userId)).join(', ');
      details.push(`members: ${names(b)}`);
    } else if(col === 'user_id'){
      details.push(`assignee: ${userName(a)} → ${userName(b)}`);
    } else if(col === 'description' || col === 'notes'){
      details.push('edited notes');
    } else {
      const label = { jira_key:'Jira key', start_date:'start', end_date:'end', start_mode:'start', end_mode:'end', day_type:'day' }[col] || col;
      details.push(`${label}: ${show(a)} → ${show(b)}`);
    }
  });
  return { who, text: `${verb} ${what}`, details };
}

async function openActivityModal(){
  closeAllOverlays();
  const scrim = buildScrim();
  const modal = document.createElement('div');
  modal.className = 'modal activity-modal';
  modal.innerHTML = `
    <div class="modal-head">
      <div class="modal-title">Recent changes</div>
      <button class="modal-close" aria-label="Close"><svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 2l7 7M9 2l-7 7"/></svg></button>
    </div>
    <div class="modal-body"><div class="activity-list"><div class="activity-empty">Loading…</div></div></div>
    <div class="modal-foot"><button class="btn-secondary" data-act="more" style="display:none">Load older</button><button class="btn-primary" data-act="close">Close</button></div>`;
  modal.querySelector('.modal-close').addEventListener('click', closeAllOverlays);
  modal.querySelector('[data-act="close"]').addEventListener('click', closeAllOverlays);
  scrim.appendChild(modal);
  pushOverlay(scrim);
  const list = modal.querySelector('.activity-list');
  const moreBtn = modal.querySelector('[data-act="more"]');
  let oldest = null;
  async function load(){
    moreBtn.disabled = true;
    try {
      const rows = await apiFetch('GET', `/api/activity?limit=50${oldest ? `&before=${oldest}` : ''}`);
      if(oldest === null) list.innerHTML = '';
      if(rows.length === 0 && oldest === null) list.innerHTML = '<div class="activity-empty">No changes yet.</div>';
      rows.forEach(ev => {
        const { who, text, details } = describeEvent(ev);
        const row = document.createElement('div');
        row.className = 'activity-row';
        row.innerHTML = `
          <span class="avatar" style="background:${ev.actorId ? avatarColor(ev.actorId) : '#bbb'}">${ev.actorId ? initials(ev.actorId) : '?'}</span>
          <div class="activity-main">
            <div><strong>${escape(who)}</strong> ${escape(text)}</div>
            ${details.length ? `<div class="activity-details">${details.map(escape).join(' · ')}</div>` : ''}
          </div>
          <span class="activity-time">${escape(fmtDateTime(ev.at))}</span>`;
        list.appendChild(row);
      });
      if(rows.length) oldest = rows[rows.length - 1].id;
      moreBtn.style.display = rows.length === 50 ? '' : 'none';
    } catch(err){
      list.innerHTML = `<div class="activity-empty">${escape(err.message)}</div>`;
    } finally {
      moreBtn.disabled = false;
    }
  }
  moreBtn.addEventListener('click', load);
  load();
}

/* ============================================================
 *  Admin: people + sprint settings
 * ============================================================ */
let __refreshAdmin = null;
function refreshAdminModal(){ if(__refreshAdmin && document.querySelector('.admin-modal')) __refreshAdmin(); }

function openAdminModal(){
  closeAllOverlays();
  const scrim = buildScrim();
  const modal = document.createElement('div');
  modal.className = 'modal admin-modal';
  modal.innerHTML = `
    <div class="modal-head">
      <div class="modal-title">People &amp; sprint settings</div>
      <button class="modal-close" aria-label="Close"><svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 2l7 7M9 2l-7 7"/></svg></button>
    </div>
    <div class="modal-body">
      <div class="section-head" style="justify-content:flex-start">People</div>
      <p class="admin-hint">Teammates are added automatically the first time they sign in with Google. Add someone here to assign work to them before that. Turning someone off hides them from pickers and signs them out; their past work stays on the board.</p>
      <div class="people-list" data-bind="people"></div>
      <form class="add-person" data-bind="add-person">
        <input name="name" type="text" placeholder="Name" maxlength="120" required />
        <input name="email" type="email" placeholder="name@arcsite.com" maxlength="254" required />
        <button class="btn-secondary" type="submit">Add person</button>
      </form>
      <div class="section-head" style="justify-content:flex-start;margin-top:18px">Sprints</div>
      <p class="admin-hint">Sprints are two work weeks long. Pick any Monday that starts a sprint and that sprint's number; every other sprint is counted from it.</p>
      <form class="sprint-form" data-bind="sprint">
        <div class="field"><label>Sprint start (a Monday)</label><input name="anchorDate" type="date" required /></div>
        <div class="field"><label>Sprint number</label><input name="anchorNumber" type="number" min="0" step="1" required /></div>
        <button class="btn-secondary" type="submit">Save sprints</button>
      </form>
    </div>
    <div class="modal-foot"><button class="btn-primary" data-act="close">Done</button></div>`;
  modal.querySelector('.modal-close').addEventListener('click', closeAllOverlays);
  modal.querySelector('[data-act="close"]').addEventListener('click', closeAllOverlays);
  scrim.appendChild(modal);
  pushOverlay(scrim);

  const peopleEl = modal.querySelector('[data-bind="people"]');
  async function patchUser(uid, body){
    try {
      const u = await apiFetch('PATCH', `/api/users/${uid}`, body);
      USERS.set(u.id, u);
      if(ME && u.id === ME.id) ME = u;
      renderPeople();
      scheduleRemoteRender();
    } catch(err){
      showToast(err.message, 'error');
      renderPeople();
    }
  }
  function renderPeople(){
    const users = [...USERS.values()].sort((a,b)=> (b.active - a.active) || a.name.localeCompare(b.name));
    peopleEl.innerHTML = users.map(u => `
      <div class="person-row${u.active ? '' : ' is-inactive'}" data-uid="${escape(u.id)}">
        <span class="avatar" style="background:${avatarColor(u.id)}">${initials(u.id)}</span>
        <input class="person-name" type="text" value="${escape(u.name)}" maxlength="120" aria-label="Name" />
        <span class="person-email">${escape(u.email)}</span>
        <label class="person-flag"><input type="checkbox" data-flag="isAdmin" ${u.isAdmin ? 'checked' : ''} ${u.id === ME.id ? 'disabled' : ''}/> Admin</label>
        <label class="person-flag"><input type="checkbox" data-flag="active" ${u.active ? 'checked' : ''} ${u.id === ME.id ? 'disabled' : ''}/> Active</label>
      </div>`).join('');
    peopleEl.querySelectorAll('.person-row').forEach(row => {
      const uid = row.dataset.uid;
      const nameInp = row.querySelector('.person-name');
      nameInp.addEventListener('change', ()=>{
        const v = nameInp.value.trim();
        if(v && v !== userName(uid)) patchUser(uid, { name: v }); else nameInp.value = userName(uid);
      });
      nameInp.addEventListener('keydown', e=>{ if(e.key === 'Enter') nameInp.blur(); });
      row.querySelectorAll('input[data-flag]').forEach(cb => cb.addEventListener('change', ()=> patchUser(uid, { [cb.dataset.flag]: cb.checked })));
    });
  }
  const addForm = modal.querySelector('[data-bind="add-person"]');
  addForm.addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(addForm);
    try {
      const u = await apiFetch('POST', '/api/users', { name: String(fd.get('name')).trim(), email: String(fd.get('email')).trim() });
      USERS.set(u.id, u);
      addForm.reset();
      renderPeople();
    } catch(err){
      showToast(err.message, 'error');
    }
  });
  const sprintForm = modal.querySelector('[data-bind="sprint"]');
  function fillSprint(){
    if(sprintForm.contains(document.activeElement)) return;
    sprintForm.anchorDate.value = SPRINT.anchorDate;
    sprintForm.anchorNumber.value = SPRINT.anchorNumber;
  }
  sprintForm.addEventListener('submit', async e=>{
    e.preventDefault();
    try {
      const settings = await apiFetch('PUT', '/api/settings/sprint', {
        anchorDate: sprintForm.anchorDate.value,
        anchorNumber: Number(sprintForm.anchorNumber.value),
      });
      SPRINT = settings.sprint;
      onCalendarChanged();
      showToast('Sprint settings saved.');
    } catch(err){
      showToast(err.message, 'error');
    }
  });
  __refreshAdmin = ()=>{ renderPeople(); fillSprint(); };
  __refreshAdmin();
}

/* ============================================================
 *  Start-up
 * ============================================================ */
async function boot(){
  const app = document.getElementById('app');
  let state;
  try {
    state = await apiFetch('GET', '/api/state');
  } catch(err){
    if(err.status === 401) return;
    app.innerHTML = `<div class="boot-msg"><div>Couldn't load Mission Control.</div><div class="boot-detail">${escape(err.message)}</div><button class="btn-secondary" id="bootRetry">Try again</button></div>`;
    document.getElementById('bootRetry').addEventListener('click', ()=>{ app.innerHTML = '<div class="boot-msg">Loading Mission Control…</div>'; boot(); });
    return;
  }
  applyState(state);
  rebuildTimeline();
  renderApp();
  // Wait for mountBoard's deferred layout pass before scrolling.
  requestAnimationFrame(()=> requestAnimationFrame(()=> scrollToToday(false)));
  connectEvents();
}
boot();
