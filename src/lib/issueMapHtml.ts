/**
 * Issue map export: one self-contained HTML file of the map, to hand around.
 *
 * Same layout, legend, click/double-click behaviour, zoom and drag, and
 * footer as the modal, drawn with the Maestro palette (dark by default, light when the
 * reader's system asks for it). No external resources, so the file works
 * offline and from a mail attachment. A banner at the top says who made it
 * and when, because the file is a snapshot that goes stale the moment any
 * issue changes.
 */

import {
  descriptionText,
  ENCODING_EXPLANATION,
  EPICS_COLUMN,
  HINT,
  type IssueMap,
  type IssueMapKind,
  type IssueMapNode,
  type IssueMapStatus,
  type IssueMapTone,
  KIND_FILL,
  KIND_META,
  KIND_ORDER,
  LEVEL_EXPLANATION,
  LIMIT_WARNING,
  MAP_BAND_Y,
  MAP_CHIP_FONT,
  MAP_CHIP_H,
  MAP_CHIP_Y,
  MAP_COL_W,
  MAP_LABEL_Y,
  MAP_NODE_H,
  MAP_NODE_W,
  MAP_ROW_H,
  MAP_X0,
  MAP_Y0,
  nodeText,
  problemText,
  START_HIDDEN_KINDS,
  START_HIDDEN_STATUSES,
  STATUS_META,
  STATUS_ORDER,
} from "./issueMap";

export interface IssueMapHtmlOptions {
  /** Repository name shown in the title, e.g. "owner/repo". */
  repo: string;
  /** Who saved the file (GitHub login). */
  createdBy: string;
  /** When it was saved, already formatted for people. */
  createdAt: string;
  /** True when the fetch hit the issue limit, so the map may be missing issues. */
  truncated?: boolean;
}

/** The per-issue data the embedded script needs for tooltips and filters. */
interface ExportMeta {
  title: string;
  state: string;
  status: IssueMapStatus;
  kind: IssueMapKind;
  kindLabel: string | null;
  level: number;
  labels: string[];
  /** Plain-text description, already cut for the tooltip. */
  body: string;
  assignees: string[];
  url: string;
  blockers: Array<{ n: number; title: string; state: string }>;
  waiting: number[];
  /** The drawn epic this story belongs to, else null. */
  parent: number | null;
  /** An epic's stories; empty for anything else. */
  stories: Array<{ n: number; title: string; state: string }>;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** JSON that is safe inside a <script> block (no "</script>" escape). */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028|\u2029/g, " ");

// Translucent box fill per palette colour, same alpha the modal uses.
const TONE_FILL: Record<IssueMapTone, string> = {
  green: "rgba(63,185,80,.22)",
  red: "rgba(220,38,38,.22)",
  blue: "rgba(59,130,246,.22)",
  yellow: "rgba(234,179,8,.22)",
  purple: "rgba(188,140,255,.22)",
};

// `.k-<kind>` on a box rect or a legend/tooltip swatch paints the kind's fill.
const KIND_CSS = KIND_ORDER.map(
  (k) =>
    `.node.k-${k} rect{fill:${TONE_FILL[KIND_FILL[k]]}}` +
    `.i.k-${k}{background:${TONE_FILL[KIND_FILL[k]]}}`,
).join("");

// Maestro palette (src/styles/globals.css), inlined so the file stands alone.
const CSS = `
:root{--bg:#0d0d10;--surface:#121316;--card:#18191c;--border:#26262c;--text:#e8e8ec;--muted:#82828e;--blue:#3b82f6;--green:#3fb950;--red:#dc2626;--yellow:#eab308;--purple:#bc8cff}
@media (prefers-color-scheme:light){:root{--bg:#f6f6f8;--surface:#fff;--card:#fafafc;--border:#dcdce2;--text:#101014;--muted:#646470}}
html,body{height:100%}
body{display:flex;flex-direction:column;overflow:hidden;margin:0;font:14px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text)}
header{padding:12px 24px;background:var(--surface);border-bottom:1px solid var(--border);flex:none;z-index:2}
h1{font-size:16px;font-weight:600;margin:0 0 6px}
h1 .sub{font-weight:400;font-size:12px;color:var(--muted);margin-left:8px}
#banner{background:rgba(234,179,8,.1);color:var(--yellow);border:1px solid rgba(234,179,8,.4);border-radius:6px;padding:6px 12px;margin:0 0 8px;font-size:12px}
#limit{color:var(--yellow);font-size:12px;margin:0 0 8px}
.leg{font-size:12px}.leg span{display:inline-block;margin-right:14px;margin-bottom:3px}
.leg i{display:inline-block;width:18px;height:18px;border-radius:5px;vertical-align:-3px;margin-right:4px;border:3px solid var(--border);font-style:normal;background:transparent}
.leg i.xs{background:linear-gradient(to top right,transparent 46%,var(--red) 46%,var(--red) 54%,transparent 54%),linear-gradient(to top left,transparent 46%,var(--red) 46%,var(--red) 54%,transparent 54%)}
.leg b.ax{display:inline-block;width:160px;color:var(--muted);font-weight:700}
.leg label{display:inline-block;margin-right:12px;margin-bottom:3px;cursor:pointer;user-select:none;padding:1px 8px;border-radius:999px}
.leg label:hover{background:var(--card)}.leg label.unchecked{opacity:.4;text-decoration:line-through}.leg input{display:none}
.leg .cnt{color:var(--muted);font-size:11px;margin-left:3px}
#count{font-weight:700;margin-left:8px}a{color:var(--blue)}
#wrap{flex:1;min-height:0;position:relative;overflow:hidden;cursor:grab;touch-action:none}#wrap.drag{cursor:grabbing}
#map{width:100%;height:100%;display:block;user-select:none}
#zoom{position:absolute;right:16px;top:12px;z-index:3;display:flex;gap:6px;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:5px 8px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
#zoom button{font:inherit;font-weight:700;min-width:32px;height:30px;border:1px solid var(--border);border-radius:7px;background:var(--card);color:var(--text);cursor:pointer}#zoom button:hover{border-color:var(--muted)}
#zpct{color:var(--muted);font-size:12px;min-width:40px;text-align:right}
.band.b0{fill:var(--card);fill-opacity:.45}.band.b1{fill:var(--card)}
.wl{font-size:15px;font-weight:700;fill:var(--text)}.wc{font-weight:500;fill:var(--muted);font-size:12px}
.e{fill:none;stroke-width:1.6;opacity:.6}.e.closed{stroke:var(--muted)}.e.open{stroke:var(--red);stroke-width:2}
.e.epl{stroke:var(--purple);stroke-dasharray:5 4;opacity:.45}
.node rect{stroke:var(--border);stroke-width:4;cursor:pointer;rx:7}.node text,.node line{pointer-events:none}
.num{font-weight:700;font-size:13px;fill:var(--text)}.ic{font-size:12px;font-family:"Segoe UI Emoji",system-ui}
.ep{font-size:11px;fill:var(--muted)}.tt{font-size:12px;fill:var(--text)}.as{font-size:11px;fill:var(--muted);font-weight:700}
.lb rect{fill:var(--card);stroke:var(--border);stroke-width:1;rx:8}.lb text{font-size:10px;fill:var(--muted)}
.node.off,.e.off,.band.off,.wl.off{display:none}
.node .x{stroke:var(--red);stroke-width:2;opacity:.55}
${KIND_CSS}
.node.k-decision .tt{fill:var(--muted);font-style:italic}
svg.focus .node,svg.focus .e{opacity:.12}svg.focus .node.hl,svg.focus .e.hl{opacity:1}svg.focus .e.hl{stroke-width:3}svg.focus .node.sel rect{stroke-width:7}
#enc,#hint{color:var(--muted);font-size:12px;margin-top:4px}
#tip{position:fixed;z-index:9;display:none;max-width:480px;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.4);padding:10px 14px;font-size:13px;pointer-events:auto;color:var(--text)}
#tip h3{margin:0 0 4px;font-size:14px;font-weight:700}
#tip .lbl{display:inline-block;padding:0 7px;border-radius:999px;border:1px solid var(--border);background:var(--card);font-size:11px;margin:1px 2px 1px 0}
#tip .lbl.k{font-weight:700;border-color:var(--text)}
#tip .desc{max-height:160px;overflow:auto;white-space:pre-wrap;font-size:12px;color:var(--muted);margin-top:2px;padding:4px 6px;border:1px solid var(--border);border-radius:6px}
#tip .st{display:inline-block;padding:1px 9px;border-radius:999px;border:3px solid var(--border);font-weight:700;margin:2px 0}
#tip .row{margin:3px 0}#tip ul{margin:4px 0 0;padding-left:18px}#tip .m{color:var(--muted)}
#tip .c{text-decoration:line-through;color:var(--muted)}#tip .o{color:var(--red);font-weight:700}#tip .pin{color:var(--muted);font-size:12px;margin-top:6px}
footer{flex:none;max-height:4.5em;overflow:auto;border-top:1px solid var(--border);padding:6px 24px;color:var(--muted);font-size:11px}
footer details{margin-top:6px}footer summary{cursor:pointer}footer ul{margin:4px 0 0;padding-left:18px}
`.trim();

// Runs in the reader's browser: click-only chain focus and tooltip, filters
// that take hidden issues off the map and re-pack the rest, zoom and drag.
const SCRIPT = `
const down={};for(const n in up){for(const b of up[n]){(down[b]=down[b]||[]).push(+n)}}
const svg=document.getElementById('map');const tip=document.getElementById('tip');let pinned=null;let GW=G.W0,GH=G.H0;let zoomReady=false;
function walk(start,adj){const s=new Set();const q=[start];while(q.length){const n=q.pop();for(const m of (adj[n]||[])){if(!s.has(m)){s.add(m);q.push(m)}}}return s}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function list(items,cls){return '<ul>'+items.map(b=>'<li class="'+cls(b)+'">#'+b.n+' '+esc(b.title)+' ('+esc(b.state.toLowerCase())+')</li>').join('')+'</ul>'}
function tipHtml(id){const m=META[id];const [ic,name,mean]=STATUS[m.status];const [kname,kmean]=KIND[m.kind];
let h='<h3>#'+id+' '+esc(m.title)+'</h3>';
h+='<div class="row"><b>Progress</b> <span class="st">'+ic+' '+name+'</span> <span class="m">'+esc(mean)+'</span></div>';
h+='<div class="row"><b>Who takes it</b> <span class="st i k-'+m.kind+'">'+kname+'</span> <span class="m">'+esc(kmean)+'</span></div>';
h+='<span class="m">'+(m.kind==='epic'?EPICS:'Level '+m.level)+' · GitHub state: '+esc(m.state)+(m.assignees.length?' · assigned to '+esc(m.assignees.join(', ')):' · nobody assigned')+'</span>';
h+='<div class="row"><b>Labels:</b> '+(m.labels.length?m.labels.map(l=>'<span class="lbl'+(l===m.kindLabel?' k':'')+'">'+esc(l)+'</span>').join(''):'none')+'</div>';
h+='<div class="row"><b>Description</b><div class="desc">'+(m.body?esc(m.body):'<i>empty</i>')+'</div></div>';
if(m.kind==='epic'){h+='<div style="margin-top:6px"><b>Stories:</b> '+(m.stories.length?'':'none linked as sub-issues')+'</div>';
if(m.stories.length){h+=list(m.stories,b=>b.state==='CLOSED'?'c':'')}}
else{if(m.parent!==null&&META[m.parent]){h+='<div class="row"><b>Epic</b> #'+m.parent+' '+esc(META[m.parent].title)+'</div>'}
h+='<div style="margin-top:6px"><b>Blocked by:</b> '+(m.blockers.length?'':'nothing')+'</div>';
if(m.blockers.length){h+=list(m.blockers,b=>b.state==='OPEN'?'o':'c')}
h+='<div style="margin-top:6px"><b>Waiting on it:</b> '+(m.waiting.length?m.waiting.map(w=>'#'+w).join(', '):'nothing')+'</div>'}
h+='<div class="pin">Click the box again to clear · double-click opens it on GitHub</div>';return h}
function showTip(id,ev){tip.innerHTML=tipHtml(id);tip.style.display='block';moveTip(ev)}
function moveTip(ev){if(!ev)return;const r=tip.getBoundingClientRect();let x=ev.clientX+16,y=ev.clientY+16;if(x+r.width>innerWidth-8)x=ev.clientX-r.width-16;if(y+r.height>innerHeight-8)y=ev.clientY-r.height-16;tip.style.left=Math.max(8,x)+'px';tip.style.top=Math.max(8,y)+'px'}
function focus(id,ev){svg.classList.add('focus');const m=META[id];const u=walk(id,up),dn=walk(id,down);const all=new Set([...u,...dn,id,...m.stories.map(k=>k.n)]);if(m.parent!==null)all.add(m.parent);
document.querySelectorAll('.node').forEach(g=>{const n=+g.dataset.id;g.classList.toggle('hl',all.has(n));g.classList.toggle('sel',n===id)});
document.querySelectorAll('.e').forEach(e=>{const f=+e.dataset.from,t=+e.dataset.to;e.classList.toggle('hl',all.has(f)&&all.has(t))});
document.getElementById('hint').textContent=m.kind==='epic'?'#'+id+': '+m.stories.length+' stories in this epic, lit up across the levels.':'#'+id+': '+u.size+' issue(s) upstream must close first (left), '+dn.size+' wait on it (right).';showTip(id,ev)}
function clear(){svg.classList.remove('focus');document.querySelectorAll('.hl,.sel').forEach(e=>e.classList.remove('hl','sel'));document.getElementById('hint').textContent=HINT;tip.style.display='none'}
document.getElementById('hint').textContent=HINT;
document.querySelectorAll('.node').forEach(g=>{const id=+g.dataset.id;
g.addEventListener('click',ev=>{if(pinned===id){pinned=null;clear()}else{pinned=id;focus(id,ev)}});
g.addEventListener('dblclick',()=>window.open(META[id].url,'_blank'))});
document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&pinned!==null){pinned=null;clear()}});
const ALL=Object.keys(META).map(Number);
function matches(n,ax,v){const m=META[n];if(ax==='who'){return v==='nobody'?m.assignees.length===0:m.assignees.includes(v)}return m[ax]===v}
function on(ax){return new Set([...document.querySelectorAll('input[data-ax='+ax+']:checked')].map(i=>i.value))}
function applyFilter(){const onS=on('status'),onK=on('kind'),onW=on('who');
const vis=new Set(ALL.filter(n=>onS.has(META[n].status)&&onK.has(META[n].kind)&&(META[n].assignees.length?META[n].assignees.some(a=>onW.has(a)):onW.has('nobody'))));
document.querySelectorAll('.node').forEach(g=>g.classList.toggle('off',!vis.has(+g.dataset.id)));
document.querySelectorAll('.e').forEach(e=>e.classList.toggle('off',!(vis.has(+e.dataset.from)&&vis.has(+e.dataset.to))));
document.querySelectorAll('.leg label').forEach(l=>{const i=l.querySelector('input');l.classList.toggle('unchecked',!i.checked);const ax=i.dataset.ax,v=i.value;const tot=ALL.filter(n=>matches(n,ax,v)).length;const shown=ALL.filter(n=>vis.has(n)&&matches(n,ax,v)).length;l.querySelector('.cnt').textContent=shown+'/'+tot});
document.getElementById('count').textContent='Showing '+vis.size+' of '+ALL.length+' issues';relayout(vis)}
function relayout(vis){const cols=LAYOUT.map((m,j)=>({j,m:m.filter(n=>vis.has(n))})).filter(c=>c.m.length);const rows=Math.max(1,...cols.map(c=>c.m.length));
const xy={};GH=G.Y0+rows*G.ROWH+30;GW=Math.max(1,cols.length)*G.COLW-10;
document.querySelectorAll('.band,.wl').forEach(e=>e.classList.add('off'));
cols.forEach((c,k)=>{const x=G.X0+k*G.COLW,off=(rows-c.m.length)*G.ROWH/2;
const band=document.querySelector('.band[data-col="'+c.j+'"]'),wl=document.querySelector('.wl[data-col="'+c.j+'"]');
band.classList.remove('off','b0','b1');band.classList.add('b'+(k%2));band.setAttribute('x',x-(G.COLW-G.NODEW)/2);band.setAttribute('height',GH-G.BANDY);
wl.classList.remove('off');wl.setAttribute('x',x+G.NODEW/2);
c.m.forEach((n,i)=>{xy[n]=[x,G.Y0+off+i*G.ROWH];document.querySelector('.node[data-id="'+n+'"]').setAttribute('transform','translate('+xy[n][0]+','+xy[n][1]+')')})});
document.querySelectorAll('.e').forEach(e=>{const a=xy[e.dataset.from],b=xy[e.dataset.to];if(!a||!b)return;const sx=a[0]+G.NODEW,sy=a[1]+G.NODEH/2,tx=b[0],ty=b[1]+G.NODEH/2,mx=(sx+tx)/2;
e.setAttribute('d','M'+sx+','+sy+' C'+mx+','+sy+' '+mx+','+ty+' '+tx+','+ty)});
if(zoomReady)fit(false)}
document.querySelectorAll('.leg input').forEach(i=>i.addEventListener('change',applyFilter));
document.getElementById('all').addEventListener('click',()=>{document.querySelectorAll('.leg input').forEach(i=>i.checked=true);applyFilter()});
applyFilter();
const wrap=document.getElementById('wrap'),vp=document.getElementById('vp');let z=1,tx=0,ty=0;
function paint(){vp.setAttribute('transform','translate('+tx+','+ty+') scale('+z+')');document.getElementById('zpct').textContent=Math.round(z*100)+'%'}
function zoomAt(f,cx,cy){const nz=Math.min(3,Math.max(0.05,z*f));tx=cx-(cx-tx)*nz/z;ty=cy-(cy-ty)*nz/z;z=nz;paint()}
function fit(all){const w=wrap.clientWidth,h=wrap.clientHeight;if(w<=0||h<=0)return;z=Math.max(0.05,Math.min(1,(w-20)/GW,all?(h-20)/GH:9));tx=(w-GW*z)/2;ty=all?(h-GH*z)/2:10;paint()}
wrap.addEventListener('wheel',ev=>{ev.preventDefault();const r=wrap.getBoundingClientRect();zoomAt(Math.exp(-ev.deltaY*0.0015),ev.clientX-r.left,ev.clientY-r.top)},{passive:false});
let drag=null,moved=false;
wrap.addEventListener('pointerdown',ev=>{if(ev.button!==0||ev.target.closest('#zoom'))return;drag={x:ev.clientX,y:ev.clientY,tx,ty};moved=false});
addEventListener('pointermove',ev=>{if(!drag)return;const dx=ev.clientX-drag.x,dy=ev.clientY-drag.y;if(!moved&&Math.hypot(dx,dy)<4)return;moved=true;wrap.classList.add('drag');tip.style.display='none';tx=drag.tx+dx;ty=drag.ty+dy;paint()});
addEventListener('pointerup',()=>{drag=null;wrap.classList.remove('drag')});
wrap.addEventListener('click',ev=>{if(moved){ev.stopPropagation();moved=false}},true);
const mid=()=>[wrap.clientWidth/2,wrap.clientHeight/2];
document.getElementById('zin').onclick=()=>zoomAt(1.25,...mid());document.getElementById('zout').onclick=()=>zoomAt(0.8,...mid());
document.getElementById('zfit').onclick=()=>fit(true);document.getElementById('z100').onclick=()=>{const [cx,cy]=mid();zoomAt(1/z,cx,cy)};
zoomReady=true;fit(false);
`.trim();

function legendEntry(
  axis: string,
  value: string,
  swatch: string,
  label: string,
  checked = true,
): string {
  return (
    `<label><input type="checkbox"${checked ? " checked" : ""} data-ax="${axis}" value="${escapeHtml(value)}">` +
    `${swatch}${escapeHtml(label)}<span class="cnt"></span></label>`
  );
}

function nodeSvg(node: IssueMapNode): string {
  const text = nodeText(node);
  const w = MAP_NODE_W;
  const h = MAP_NODE_H;
  let out =
    `<g class="node ${node.status} k-${node.kind}" data-id="${node.number}" ` +
    `transform="translate(${node.x},${node.y})"><rect width="${w}" height="${h}"/>`;
  if (node.status === "closed") {
    out +=
      `<line class="x" x1="4" y1="4" x2="${w - 4}" y2="${h - 4}"/>` +
      `<line class="x" x1="${w - 4}" y1="4" x2="4" y2="${h - 4}"/>`;
  }
  out +=
    `<text class="num" x="10" y="18">#${node.number} <tspan class="ic">${text.icons}</tspan></text>` +
    `<text class="ep" x="${w - 10}" y="18" text-anchor="end">${escapeHtml(text.tag)}</text>` +
    `<text class="tt" x="10" y="36">${escapeHtml(text.title)}</text>` +
    `<text class="as" x="10" y="52">${escapeHtml(text.assignees)}</text>`;
  for (const chip of text.chips) {
    out +=
      `<g class="lb" transform="translate(${10 + chip.x},${MAP_CHIP_Y})">` +
      `<rect width="${chip.w}" height="${MAP_CHIP_H}"/>` +
      `<text x="${chip.w / 2}" y="${MAP_CHIP_H - 4}" text-anchor="middle" font-size="${MAP_CHIP_FONT}">` +
      `${escapeHtml(chip.text)}</text></g>`;
  }
  return `${out}</g>`;
}

/** Render the map as one standalone HTML document. */
export function buildIssueMapHtml(map: IssueMap, options: IssueMapHtmlOptions): string {
  const { repo, createdBy, createdAt, truncated = false } = options;
  const title = `${repo} · issue map: what is blocked by what, level by level`;

  const bands = map.columns
    .map(
      (col, i) =>
        `<rect class="band b${i % 2}" data-col="${i}" x="${col.x - (MAP_COL_W - MAP_NODE_W) / 2}" ` +
        `y="${MAP_BAND_Y}" width="${MAP_COL_W}" height="${map.height - MAP_BAND_Y}"/>` +
        `<text class="wl" data-col="${i}" x="${col.x + MAP_NODE_W / 2}" y="${MAP_LABEL_Y}" ` +
        `text-anchor="middle">` +
        `${escapeHtml(col.label)} <tspan class="wc">${col.closed}/${col.total} closed</tspan></text>`,
    )
    .join("");
  const edges = map.edges
    .map(
      (e) =>
        `<path class="e ${e.open ? "open" : "closed"}" data-from="${e.from}" data-to="${e.to}" d="${e.path}"/>`,
    )
    .join("");
  const epicEdges = map.epicEdges
    .map((e) => `<path class="e epl" data-from="${e.from}" data-to="${e.to}" d="${e.path}"/>`)
    .join("");
  const nodes = map.nodes.map(nodeSvg).join("");

  const logins = Array.from(new Set(map.nodes.flatMap((n) => n.assignees))).sort((a, b) =>
    a.localeCompare(b),
  );
  const legend =
    `<b class="ax">Background = who takes it</b>` +
    KIND_ORDER.map((k) =>
      legendEntry(
        "kind",
        k,
        `<i class="i k-${k}"></i>`,
        KIND_META[k].name,
        !START_HIDDEN_KINDS.includes(k),
      ),
    ).join("") +
    `<br><b class="ax">Icon = progress</b>` +
    STATUS_ORDER.filter((s) => s !== "closed")
      .map((s) => legendEntry("status", s, "", `${STATUS_META[s].icon} ${STATUS_META[s].name}`))
      .join("") +
    `<br><b class="ax">Cross = closed</b>` +
    legendEntry(
      "status",
      "closed",
      `<i class="i xs"></i>`,
      STATUS_META.closed.name,
      !START_HIDDEN_STATUSES.includes("closed"),
    ) +
    `<br><b class="ax">Assignee</b>` +
    logins.map((l) => legendEntry("who", l, "", `\u{1F464} ${l}`)).join("") +
    legendEntry("who", "nobody", "", "nobody assigned") +
    `<span id="count"></span> <a href="#" id="all" style="font-size:12px" onclick="return false">show all</a>` +
    `<br><b class="ax">Lines</b>` +
    `<span><i style="border:none;border-top:3px solid var(--muted);height:0;border-radius:0;vertical-align:2px"></i>blocker closed</span>` +
    `<span><i style="border:none;border-top:3px solid var(--red);height:0;border-radius:0;vertical-align:2px"></i>blocker still open</span>` +
    `<span><i style="border:none;border-top:3px dashed var(--purple);height:0;border-radius:0;vertical-align:2px"></i>epic to its story</span>`;

  const meta: Record<number, ExportMeta> = {};
  for (const n of map.nodes) {
    meta[n.number] = {
      title: n.title,
      state: n.state,
      status: n.status,
      kind: n.kind,
      kindLabel: n.kindLabel,
      level: n.level,
      labels: n.labels,
      body: descriptionText(n.body),
      assignees: n.assignees,
      url: n.url,
      blockers: n.blockers.map((b) => ({ n: b.number, title: b.title, state: b.state })),
      waiting: n.waiting,
      parent: n.parent,
      stories: n.stories.map((k) => ({ n: k.number, title: k.title, state: k.state })),
    };
  }
  const statusDict = Object.fromEntries(
    STATUS_ORDER.map((s) => [
      s,
      [STATUS_META[s].icon, STATUS_META[s].name, STATUS_META[s].meaning],
    ]),
  );
  const kindDict = Object.fromEntries(
    KIND_ORDER.map((k) => [k, [KIND_META[k].name, KIND_META[k].meaning]]),
  );

  const linkCount = map.edges.length;
  const epicCount = map.nodes.filter((n) => n.kind === "epic").length;
  const issueCount = map.nodes.length - epicCount;
  // The browser re-packs these columns when a filter hides issues.
  const layout = map.columns.map((col) => col.members);
  const geometry = {
    W0: map.width,
    H0: map.height,
    COLW: MAP_COL_W,
    NODEW: MAP_NODE_W,
    NODEH: MAP_NODE_H,
    ROWH: MAP_ROW_H,
    X0: MAP_X0,
    Y0: MAP_Y0,
    BANDY: MAP_BAND_Y,
  };
  const problems =
    map.problems.length === 0
      ? " No data problems."
      : `<details><summary>${map.problems.length} data problem${
          map.problems.length === 1 ? "" : "s"
        } (links dropped or sources disagreeing)</summary><ul>${map.problems
          .map((p) => `<li>${escapeHtml(problemText(p))}</li>`)
          .join("")}</ul></details>`;
  const banner =
    `⚠ Transient snapshot, not a source of truth. Generated by <b>${escapeHtml(createdBy)}</b> ` +
    `on <b>${escapeHtml(createdAt)}</b> from the GitHub issues as they were at that moment; ` +
    `it goes stale as soon as any issue changes. The live state is always GitHub.`;

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>` +
    `<header><h1>${escapeHtml(title)}<span class="sub">${issueCount} issue${
      issueCount === 1 ? "" : "s"
    } + ${epicCount} epic${epicCount === 1 ? "" : "s"} · ${linkCount} blocked-by link${
      linkCount === 1 ? "" : "s"
    }</span></h1>` +
    `<div id="banner">${banner}</div>` +
    (truncated ? `<div id="limit">${escapeHtml(LIMIT_WARNING)}</div>` : "") +
    `<div class="leg">${legend}</div><div id="enc">${escapeHtml(ENCODING_EXPLANATION)}</div>` +
    `<div id="hint"></div></header>` +
    `<div id="tip"></div>` +
    `<div id="wrap"><div id="zoom"><button id="zin" title="Zoom in">+</button>` +
    `<button id="zout" title="Zoom out">−</button><button id="zfit" title="Fit the whole map">Fit</button>` +
    `<button id="z100" title="Actual size">100%</button><span id="zpct"></span></div>` +
    `<svg id="map"><g id="vp">${bands}${edges}${epicEdges}${nodes}</g></svg></div>` +
    `<footer>${escapeHtml(LEVEL_EXPLANATION)} A line always runs from the blocker to the issue ` +
    `that waits for it; an issue opens the moment every line coming into it is grey.${problems}</footer>` +
    `<script>const up=${scriptJson(map.up)};const META=${scriptJson(meta)};` +
    `const STATUS=${scriptJson(statusDict)};const KIND=${scriptJson(kindDict)};` +
    `const HINT=${scriptJson(HINT)};const LAYOUT=${scriptJson(layout)};` +
    `const G=${scriptJson(geometry)};const EPICS=${scriptJson(EPICS_COLUMN)};\n${SCRIPT}</script></body></html>`
  );
}
