import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
// Robust manual Escher tessellation builder.
// Key ideas:
// 1) Start from a base tile (rectangle). Users draw polygons (by clicking) to CUT & SLIDE left↔right / top↔bottom.
// 2) Boolean operations (Union / Subtract) against the tile using drawn polygons.
// 3) Manual assembly canvas: clone tiles and drag them around to build a tessellation puzzle (no auto preview).
// 4) Full undo/redo/reset. Export tile SVG and assembly SVG/PNG.
// 5) No auto tiling; users must piece shapes together by eye with optional snapping.

// NPM deps (available in ChatGPT Apps):
//   npm: polygon-clipping (robust polygon boolean ops)
//   npm: zustand (optional – we do our own history here, to keep single-file simplicity)

import * as pc from "polygon-clipping"; // MultiPolygon boolean ops

/******************** Geometry Helpers ********************/
// A MultiPolygon is: number[][][][] per polygon-clipping: Array<Polygon>
// Polygon = Array<Ring>; Ring = Array<[x,y]>; First ring is outer, then holes.

const rectMultiPolygon = (w, h) => [ [ [ [0,0], [w,0], [w,h], [0,h] ] ] ];

const cloneMP = (mp) => JSON.parse(JSON.stringify(mp));

const translateRing = (ring, dx, dy) => ring.map(([x,y]) => [x+dx, y+dy]);
const translatePoly = (poly, dx, dy) => poly.map(ring => translateRing(ring, dx, dy));
const translateMP = (mp, dx, dy) => mp.map(poly => translatePoly(poly, dx, dy));

const withinBounds = (x, y, w, h) => x >= 0 && x <= w && y >= 0 && y <= h;

// Convert MultiPolygon to SVG path string
const ringToPath = (ring) => ring.map((p, i) => `${i===0?"M":"L"}${p[0]} ${p[1]}`).join(" ") + " Z";
const polyToPath = (poly) => poly.map(ringToPath).join(" ");
const mpToPath = (mp) => mp.map(polyToPath).join(" ");

// Convert a simple polygon (array of [x,y]) into MultiPolygon structure expected by polygon-clipping
const simplePolygonToMP = (points) => [ [ points ] ];

// Intersect an MP with the tile bounds (keeps geometry inside)
const intersectWithBounds = (mp, w, h) => {
  const bounds = rectMultiPolygon(w, h);
  try {
    const out = pc.intersection(mp, bounds);
    if (!out || out.length === 0) return [];
    return out;
  } catch (e) {
    console.warn("Intersection error", e);
    return mp; // if something fails, keep original
  }
};

// Safe boolean ops that always intersect back with bounds for the tile shape
const mpUnion = (a, b, w, h) => {
  try {
    const u = pc.union(a, b);
    return intersectWithBounds(u, w, h);
  } catch (e) {
    console.warn("Union error", e);
    return a;
  }
};

const mpDiff = (a, b, w, h) => {
  try {
    const d = pc.difference(a, b);
    return intersectWithBounds(d, w, h);
  } catch (e) {
    console.warn("Diff error", e);
    return a;
  }
};

const mpIntersect = (a, b, w, h) => {
  try {
    const i = pc.intersection(a, b);
    return intersectWithBounds(i, w, h);
  } catch (e) {
    console.warn("Intersect error", e);
    return a;
  }
};

// Simple point helpers
const distance = (a,b) => Math.hypot(a[0]-b[0], a[1]-b[1]);

/******************** Undo/Redo History Hook ********************/
function useHistory(initialState) {
  const [present, setPresent] = useState(initialState);
  const pastRef = useRef([]); // stack
  const futureRef = useRef([]);

  const set = useCallback((updater) => {
    pastRef.current.push(JSON.stringify(present));
    const next = typeof updater === 'function' ? updater(present) : updater;
    setPresent(next);
    futureRef.current = [];
  }, [present]);

  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;

  const undo = useCallback(() => {
    if (!canUndo) return;
    const prev = pastRef.current.pop();
    futureRef.current.push(JSON.stringify(present));
    setPresent(JSON.parse(prev));
  }, [present, canUndo]);

  const redo = useCallback(() => {
    if (!canRedo) return;
    const next = futureRef.current.pop();
    pastRef.current.push(JSON.stringify(present));
    setPresent(JSON.parse(next));
  }, [present, canRedo]);

  const reset = useCallback((state) => {
    pastRef.current = [];
    futureRef.current = [];
    setPresent(state);
  }, []);

  return { present, set, undo, redo, reset, canUndo, canRedo };
}

/******************** Types (JSDoc) ********************/
/**
 * EditorState shape:
 * {
 *   tileW: number,
 *   tileH: number,
 *   tileMP: MultiPolygon,
 *   draftShape: Array<[x,y]>, // points for currently drawn polygon
 *   mode: 'select'|'draw'|'cutSlideLR'|'cutSlideRL'|'cutSlideTB'|'cutSlideBT'|'booleanAdd'|'booleanSub',
 *   snap: boolean,
 *   gridSize: number,
 *   instances: Array<{id:string, x:number, y:number, rot:number}>,
 * }
 */

/******************** Main Component ********************/
export default function EscherLab() {
  const initial = useMemo(() => ({
    tileW: 240,
    tileH: 160,
    tileMP: rectMultiPolygon(240,160),
    draftShape: [],
    mode: 'draw',
    snap: true,
    gridSize: 16,
    instances: [],
  }), []);

  const { present, set, undo, redo, reset, canUndo, canRedo } = useHistory(initial);
  const { tileW, tileH, tileMP, draftShape, mode, snap, gridSize, instances } = present;

  const editorSvgRef = useRef(null);
  const assemblySvgRef = useRef(null);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y')) {
        e.preventDefault();
        redo();
      }
      if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        reset({ ...initial });
      }
      if (e.key === 'Enter' && mode === 'draw' && draftShape.length >= 3) {
        e.preventDefault();
        // close polygon automatically
        set(s => ({ ...s, draftShape: [...s.draftShape, s.draftShape[0]] }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, reset, initial, mode, draftShape.length, set]);

  // Helpers for snapping and clamping
  const snapPoint = useCallback((p) => {
    if (!snap) return p;
    const [x,y] = p;
    const sx = Math.round(x / gridSize) * gridSize;
    const sy = Math.round(y / gridSize) * gridSize;
    return [sx, sy];
  }, [snap, gridSize]);

  /******** Drawing in Tile Editor ********/
  const onEditorClick = useCallback((e) => {
    if (mode !== 'draw') return;
    const svg = editorSvgRef.current;
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const screenCTM = svg.getScreenCTM();
    const local = pt.matrixTransform(screenCTM.inverse());
    let p = [local.x, local.y];
    // Clamp inside tile bounds
    p[0] = Math.max(0, Math.min(tileW, p[0]));
    p[1] = Math.max(0, Math.min(tileH, p[1]));
    p = snapPoint(p);
    set(s => ({ ...s, draftShape: [...s.draftShape, p] }));
  }, [mode, tileW, tileH, snapPoint, set]);

  const clearDraft = useCallback(() => set(s => ({ ...s, draftShape: [] })), [set]);

  // Apply boolean ops using the current draft shape
  const applyBoolean = useCallback((op) => {
    set(s => {
      if (s.draftShape.length < 3) return s;
      const clean = closeIfNeeded(s.draftShape);
      const mp = simplePolygonToMP(clean);
      let nextTile = s.tileMP;
      if (op === 'add') nextTile = mpUnion(s.tileMP, mp, s.tileW, s.tileH);
      if (op === 'sub') nextTile = mpDiff(s.tileMP, mp, s.tileW, s.tileH);
      return { ...s, tileMP: nextTile, draftShape: [] };
    });
  }, [set]);

  // Cut & Slide helpers
  const applyCutSlide = useCallback((direction) => {
    // direction: 'LR' | 'RL' | 'TB' | 'BT'
    set(s => {
      if (s.draftShape.length < 3) return s;
      const clean = closeIfNeeded(s.draftShape);
      const cutMP = simplePolygonToMP(clean);
      const { tileW, tileH } = s;
      let tmp = mpDiff(s.tileMP, cutMP, tileW, tileH); // remove from source edge side
      let moved = cutMP;
      if (direction === 'LR') moved = translateMP(cutMP, tileW, 0);
      if (direction === 'RL') moved = translateMP(cutMP, -tileW, 0);
      if (direction === 'TB') moved = translateMP(cutMP, 0, tileH);
      if (direction === 'BT') moved = translateMP(cutMP, 0, -tileH);
      tmp = mpUnion(tmp, moved, tileW, tileH);
      return { ...s, tileMP: tmp, draftShape: [] };
    });
  }, [set]);

  const closeIfNeeded = (pts) => {
    if (pts.length <= 2) return pts;
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (distance(first, last) > 1e-6) return [...pts, first];
    return pts;
  };

  /******** Assembly (manual tiling) ********/
  // Add a new instance of the constructed tile
  const addInstance = useCallback(() => {
    set(s => {
      const id = Math.random().toString(36).slice(2);
      return { ...s, instances: [...s.instances, { id, x: 20, y: 20, rot: 0 }] };
    });
  }, [set]);

  const clearInstances = useCallback(() => set(s => ({ ...s, instances: [] })), [set]);

  // Drag logic for instances
  const draggingRef = useRef(null); // {id, offsetX, offsetY}

  const onAssemblyMouseDown = useCallback((e) => {
    const svg = assemblySvgRef.current; if (!svg) return;
    const target = e.target;
    const id = target.getAttribute('data-id');
    if (!id) return;
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const screenCTM = svg.getScreenCTM();
    const local = pt.matrixTransform(screenCTM.inverse());

    set(s => {
      const inst = s.instances.find(i => i.id === id);
      if (!inst) return s;
      const off = [local.x - inst.x, local.y - inst.y];
      draggingRef.current = { id, off };
      return s;
    });
  }, [set]);

  const onAssemblyMouseMove = useCallback((e) => {
    if (!draggingRef.current) return;
    const svg = assemblySvgRef.current; if (!svg) return;
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const screenCTM = svg.getScreenCTM();
    const local = pt.matrixTransform(screenCTM.inverse());
    const { id, off } = draggingRef.current;
    set(s => {
      const insts = s.instances.map(i => {
        if (i.id !== id) return i;
        let nx = local.x - off[0];
        let ny = local.y - off[1];
        if (s.snap) {
          nx = Math.round(nx / s.tileW) * s.tileW; // snap to tile size grid for easy tessellation
          ny = Math.round(ny / s.tileH) * s.tileH;
        }
        return { ...i, x: nx, y: ny };
      });
      return { ...s, instances: insts };
    });
  }, [set]);

  const onAssemblyMouseUp = useCallback(() => { draggingRef.current = null; }, []);
  useEffect(() => {
    window.addEventListener('mouseup', onAssemblyMouseUp);
    return () => window.removeEventListener('mouseup', onAssemblyMouseUp);
  }, [onAssemblyMouseUp]);

  /******** Export Helpers ********/
  const download = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const exportTileSVG = useCallback(() => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${tileH}" viewBox="0 0 ${tileW} ${tileH}">\n` +
      `<path d="${mpToPath(tileMP)}" fill="none" stroke="black" stroke-width="2"/>\n</svg>`;
    download(new Blob([svg], { type: 'image/svg+xml' }), 'tile.svg');
  }, [tileMP, tileW, tileH]);

  const exportAssemblySVG = useCallback(() => {
    const padding = 40;
    const w = 1200, h = 800;
    const path = mpToPath(tileMP);
    const items = instances.map(i => `<g transform="translate(${i.x + padding}, ${i.y + padding}) rotate(${i.rot})">` +
      `<path d="${path}" fill="none" stroke="black" stroke-width="2"/>` + `</g>`).join('\n');
    const grid = renderGridSVG(w, h, gridSize, '#eee');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${grid}\n${items}\n</svg>`;
    download(new Blob([svg], { type: 'image/svg+xml' }), 'assembly.svg');
  }, [instances, tileMP, gridSize]);

  const exportAssemblyPNG = useCallback(() => {
    // Rasterize the current assembly SVG to a PNG
    const w = 1200, h = 800;
    const svgEl = assemblySvgRef.current; if (!svgEl) return;
    const ser = new XMLSerializer();
    const raw = ser.serializeToString(svgEl);
    const svgBlob = new Blob([raw], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0,0,w,h);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) download(blob, 'assembly.png');
        URL.revokeObjectURL(url);
      });
    };
    img.src = url;
  }, []);

  /******** UI Helpers ********/
  const changeMode = (m) => set(s => ({ ...s, mode: m }));
  const toggleSnap = () => set(s => ({ ...s, snap: !s.snap }));

  const setTileSize = (w, h) => set(s => ({ ...s, tileW: w, tileH: h, tileMP: intersectWithBounds(s.tileMP, w, h) }));

  const applyModeAction = () => {
    if (mode === 'booleanAdd') return applyBoolean('add');
    if (mode === 'booleanSub') return applyBoolean('sub');
    if (mode === 'cutSlideLR') return applyCutSlide('LR');
    if (mode === 'cutSlideRL') return applyCutSlide('RL');
    if (mode === 'cutSlideTB') return applyCutSlide('TB');
    if (mode === 'cutSlideBT') return applyCutSlide('BT');
  };

  const resetTile = () => set(s => ({ ...s, tileMP: rectMultiPolygon(s.tileW, s.tileH), draftShape: [] }));

  // Grid rendering for SVG
  function renderGridSVG(w, h, step, color) {
    const lines = [];
    for (let x = 0; x <= w; x += step) lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="${color}" stroke-width="1"/>`);
    for (let y = 0; y <= h; y += step) lines.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${color}" stroke-width="1"/>`);
    return lines.join('\n');
  }

  // JSX Grid as elements
  const Grid = ({ w, h, step, color }) => {
    const lines = [];
    for (let x = 0; x <= w; x += step) lines.push(<line key={`vx${x}`} x1={x} y1={0} x2={x} y2={h} stroke={color} strokeWidth={1} />);
    for (let y = 0; y <= h; y += step) lines.push(<line key={`hz${y}`} x1={0} y1={y} x2={w} y2={y} stroke={color} strokeWidth={1} />);
    return <g>{lines}</g>;
  };

  // Draft shape path for display
  const draftPath = useMemo(() => {
    if (draftShape.length < 2) return '';
    const pts = draftShape.map((p,i) => `${i===0?"M":"L"}${p[0]} ${p[1]}`).join(' ');
    return pts;
  }, [draftShape]);

  const toolbarButton = (label, active, onClick, title) => (
    <button onClick={onClick} title={title}
      className={`px-3 py-1 rounded-xl border ${active?"bg-black text-white":"bg-white hover:bg-gray-100"}`}>{label}</button>
  );

  return (
    <div className="w-full min-h-screen bg-[#f7f7f8] text-gray-900">
      <header className="sticky top-0 z-10 bg-white border-b">
        <div className="max-w-7xl mx-auto p-3 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold mr-4">Escher Tessellation Lab_ dan</h1>
          {toolbarButton('Draw', mode==='draw', () => changeMode('draw'), 'Click to place polygon points; Enter closes it')}
          {toolbarButton('Union', mode==='booleanAdd', () => changeMode('booleanAdd'), 'Add polygon to tile')}
          {toolbarButton('Subtract', mode==='booleanSub', () => changeMode('booleanSub'), 'Subtract polygon from tile')}
          <div className="h-6 w-px bg-gray-300 mx-1"/>
          {toolbarButton('Cut → (L→R)', mode==='cutSlideLR', () => changeMode('cutSlideLR'), 'Cut from left, slide to right')}
          {toolbarButton('Cut ← (R→L)', mode==='cutSlideRL', () => changeMode('cutSlideRL'), 'Cut from right, slide to left')}
          {toolbarButton('Cut ↓ (T→B)', mode==='cutSlideTB', () => changeMode('cutSlideTB'), 'Cut from top, slide to bottom')}
          {toolbarButton('Cut ↑ (B→T)', mode==='cutSlideBT', () => changeMode('cutSlideBT'), 'Cut from bottom, slide to top')}
          <div className="h-6 w-px bg-gray-300 mx-1"/>
          <button onClick={applyModeAction} className="px-3 py-1 rounded-xl bg-blue-600 text-white hover:bg-blue-700">Apply</button>
          <button onClick={clearDraft} className="px-2 py-1 rounded-xl border hover:bg-gray-100">Clear Draft</button>
          <div className="h-6 w-px bg-gray-300 mx-1"/>
          <button disabled={!canUndo} onClick={undo} className={`px-2 py-1 rounded-xl border ${canUndo ? 'hover:bg-gray-100':'opacity-40'}`}>Undo</button>
          <button disabled={!canRedo} onClick={redo} className={`px-2 py-1 rounded-xl border ${canRedo ? 'hover:bg-gray-100':'opacity-40'}`}>Redo</button>
          <button onClick={() => resetTile()} className="px-2 py-1 rounded-xl border hover:bg-gray-100">Reset Tile</button>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={snap} onChange={toggleSnap}/> Snap</label>
            <label className="text-sm flex items-center gap-1">Grid
              <input type="number" min={4} max={80} step={1} value={gridSize}
                onChange={(e)=> set(s => ({...s, gridSize: Math.max(2, parseInt(e.target.value||'16',10))}))}
                className="w-16 border rounded px-2 py-1"/>
            </label>
            <button onClick={exportTileSVG} className="px-3 py-1 rounded-xl border hover:bg-gray-100">Export Tile SVG</button>
          </div>
        </div>
      </header>

      {/* Work Area */}
      <div className="max-w-7xl mx-auto grid md:grid-cols-2 gap-6 p-4">
        {/* Tile Designer */}
        <section className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold">1) Tile Designer</h2>
            <div className="flex items-center gap-2 text-sm">
              <label>W <input className="w-20 border rounded px-2 py-1 ml-1" type="number" value={tileW}
                onChange={(e)=> setTileSize(Math.max(40,parseInt(e.target.value||'100',10)), tileH)}/></label>
              <label>H <input className="w-20 border rounded px-2 py-1 ml-1" type="number" value={tileH}
                onChange={(e)=> setTileSize(tileW, Math.max(40,parseInt(e.target.value||'100',10)))}/></label>
            </div>
          </div>

          <div className="border rounded-xl overflow-hidden relative">
            <svg ref={editorSvgRef} width={tileW} height={tileH} viewBox={`0 0 ${tileW} ${tileH}`} className="w-full h-auto bg-[url('data:image/svg+xml;utf8,')] cursor-crosshair" onClick={onEditorClick}>
              <Grid w={tileW} h={tileH} step={gridSize} color="#f0f0f0"/>
              {/* Base Tile Boundary */}
              <rect x={0} y={0} width={tileW} height={tileH} fill="none" stroke="#e2e8f0" strokeWidth={2}/>
              {/* Current tile shape */}
              <path d={mpToPath(tileMP)} fill="#dbeafe" stroke="#1e40af" strokeWidth={2} />
              {/* Draft shape */}
              {draftShape.length>=1 && (
                <>
                  <path d={draftPath} fill="none" stroke="#ef4444" strokeDasharray="4 4" strokeWidth={2}/>
                  {draftShape.map((p,idx) => (
                    <circle key={idx} cx={p[0]} cy={p[1]} r={3} fill={idx===0?"#22c55e":"#ef4444"}/>
                  ))}
                </>
              )}
            </svg>
          </div>
          <p className="text-sm text-gray-600 mt-2 leading-relaxed">
            Draw a polygon inside the tile (click points; <kbd>Enter</kbd> closes). Choose an action (Union/Subtract or a Cut&Slide direction) then click <b>Apply</b>.
            Cut&Slide emulates Escher's method: remove a piece on one edge and translate it to the opposite edge. Keep drawing + applying to sculpt your tile.
          </p>
        </section>

        {/* Assembly Canvas */}
        <section className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold">2) Manual Assembly (No Auto Preview)</h2>
            <div className="flex items-center gap-2 text-sm">
              <button onClick={addInstance} className="px-2 py-1 rounded-xl border hover:bg-gray-100">Add Tile</button>
              <button onClick={clearInstances} className="px-2 py-1 rounded-xl border hover:bg-gray-100">Clear Tiles</button>
              <button onClick={exportAssemblySVG} className="px-2 py-1 rounded-xl border hover:bg-gray-100">Export SVG</button>
              <button onClick={exportAssemblyPNG} className="px-2 py-1 rounded-xl border hover:bg-gray-100">Export PNG</button>
            </div>
          </div>

          <div className="border rounded-xl overflow-hidden">
            <svg ref={assemblySvgRef} width={1200} height={800} viewBox="0 0 1200 800"
              onMouseDown={onAssemblyMouseDown} onMouseMove={onAssemblyMouseMove}
              className="w-full bg-white">
              <Grid w={1200} h={800} step={gridSize} color="#f1f5f9"/>
              {/* Draw each instance */}
              {instances.map(inst => (
                <g key={inst.id} transform={`translate(${inst.x}, ${inst.y}) rotate(${inst.rot})`}>
                  <path data-id={inst.id} d={mpToPath(tileMP)} fill="#e2e8f0" stroke="#0f172a" strokeWidth={1.5} className="cursor-move"/>
                </g>
              ))}
            </svg>
          </div>
          <p className="text-sm text-gray-600 mt-2">Drag tiles to fit them together like a puzzle. With Snap on, tiles snap to the base tile size grid ({tileW}×{tileH}). No automatic duplication is performed.</p>
        </section>
      </div>

      <footer className="max-w-7xl mx-auto px-4 pb-10 text-xs text-gray-500">
        <p>Tips: Use small polygons repeatedly to carve detail. Make sure your cut polygons cross the intended edge; the tool translates the exact shape by the tile size. Try alternating horizontal and vertical cut-slides to get complex Escher-like tiles.</p>
      </footer>
    </div>
  );
}
