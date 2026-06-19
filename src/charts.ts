/**
 * charts.ts
 * -----------------------------------------------------------------------------
 * A tiny, ZERO-DEPENDENCY SVG chart kit for the dashboard webview. Every function
 * is pure: it takes plain numbers and returns an SVG (or HTML) string. Nothing is
 * fetched, no library is bundled — which is exactly what keeps the webview inside
 * its locked-down CSP (`default-src 'none'`, script only via nonce). The visuals
 * are themed entirely through VS Code's chart palette, so they track light/dark
 * automatically and match the rest of the editor.
 *
 * Hover behaviour piggybacks on the dashboard's single floating tooltip: any
 * element carrying a `data-tip="…"` attribute (including SVG <rect>/<path>) is
 * picked up by the existing `closest('[data-tip]')` listener — so charts get rich
 * tooltips for free, with no extra script.
 *
 * Design split, on purpose:
 *   • SVG  — sparkline, stacked daily columns, ring, donut (shapes that are
 *            awkward in CSS). Plots stretch to full width via a viewBox with
 *            preserveAspectRatio="none"; all *text* lives in the surrounding HTML
 *            so nothing distorts. Strokes use vector-effect to stay crisp.
 *   • HTML  — ranked horizontal bars and the 100%-segmented bar (crisp text,
 *            naturally responsive). Still hand-built and dependency-free.
 */

/** VS Code chart palette, with hard fallbacks for non-VS Code contexts. */
export const CHART = {
  blue: 'var(--vscode-charts-blue, #3794ff)',
  green: 'var(--vscode-charts-green, #4ec9b0)',
  yellow: 'var(--vscode-charts-yellow, #d7ba7d)',
  orange: 'var(--vscode-charts-orange, #d18616)',
  red: 'var(--vscode-charts-red, #f14c4c)',
  purple: 'var(--vscode-charts-purple, #b180d7)',
  grid: 'var(--vscode-widget-border, rgba(127,127,127,0.22))',
  track: 'color-mix(in srgb, var(--vscode-foreground) 12%, transparent)',
  axis: 'var(--vscode-descriptionForeground, #8b8b8b)',
} as const;

/** Semantic colours shared across the dashboard so the legend reads consistently. */
export const SEMANTIC = {
  fresh: CHART.blue, // fresh input — billed full price
  cached: CHART.green, // cached input — ~80% cheaper
  output: CHART.purple, // generated output
} as const;

/** Minimal attribute-escaping for any text we drop into a `data-tip`. */
function escAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Round to a short, SVG-friendly number (avoids 0.30000000000004 in paths). */
function n(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}

// ---------------------------------------------------------------------------
// Sparkline — a word-sized trend line for a KPI card.
// ---------------------------------------------------------------------------

export interface SparkOpts {
  width?: number;
  height?: number;
  color?: string;
  /** Soft area fill under the line (defaults on). */
  fill?: boolean;
  /** Emphasise the final point with a dot (defaults on). */
  dot?: boolean;
  strokeWidth?: number;
}

/**
 * Tiny inline trend line. Stretches to its container width (viewBox + 100%
 * style) while the stroke stays 1px-crisp via vector-effect. Returns '' for
 * fewer than two points — a single value isn't a trend.
 */
export function sparkline(values: number[], opts: SparkOpts = {}): string {
  const w = opts.width ?? 120;
  const h = opts.height ?? 34;
  const color = opts.color ?? CHART.blue;
  const fill = opts.fill ?? true;
  const dot = opts.dot ?? true;
  const sw = opts.strokeWidth ?? 1.75;
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 2) {
    return '';
  }
  const pad = 2;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const stepX = (w - pad * 2) / (pts.length - 1);
  const x = (i: number) => pad + i * stepX;
  const y = (v: number) => pad + (h - pad * 2) * (1 - (v - min) / span);
  const line = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${n(x(i))} ${n(y(v))}`).join(' ');
  const lastX = x(pts.length - 1);
  const lastY = y(pts[pts.length - 1]);
  const area = fill
    ? `<path d="${line} L${n(lastX)} ${n(h - pad)} L${n(x(0))} ${n(h - pad)} Z" fill="${color}" opacity="0.13" />`
    : '';
  const dotEl = dot
    ? `<circle cx="${n(lastX)}" cy="${n(lastY)}" r="2.4" fill="${color}" stroke="var(--vscode-editor-background)" stroke-width="1" />`
    : '';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" aria-hidden="true">
    ${area}
    <path d="${line}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    ${dotEl}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Stacked columns — daily spend split into fresh / cached / output.
// ---------------------------------------------------------------------------

export interface ColumnSeries {
  key: string;
  label: string;
  color: string;
}

export interface ColumnBar {
  /** Per-series values, aligned to the `series` array order. */
  values: number[];
  /** Rich tooltip for the whole column (the day). */
  tip?: string;
}

export interface ColumnOpts {
  height?: number;
  /** Virtual plot width — bars stretch to fill the container regardless. */
  width?: number;
  /** Number of horizontal gridlines (defaults 3). */
  gridlines?: number;
}

/**
 * Stacked column plot (SVG shapes only — labels/legend are HTML around it).
 * preserveAspectRatio="none" lets the columns stretch to the panel width; only
 * rectangles and horizontal gridlines are drawn, so nothing looks distorted.
 */
export function columns(bars: ColumnBar[], series: ColumnSeries[], opts: ColumnOpts = {}): string {
  const h = opts.height ?? 132;
  const w = opts.width ?? 600;
  const grid = opts.gridlines ?? 3;
  if (bars.length === 0) {
    return '';
  }
  const totals = bars.map((b) => b.values.reduce((s, v) => s + Math.max(0, v), 0));
  const max = Math.max(...totals, 1);
  const padTop = 6;
  const padBottom = 4;
  const plotH = h - padTop - padBottom;
  // Gap scales down as the number of days grows so a full month still breathes.
  const slot = w / bars.length;
  const gap = Math.min(slot * 0.3, 6);
  const barW = Math.max(1, slot - gap);

  const gridEls: string[] = [];
  for (let i = 1; i <= grid; i++) {
    const gy = padTop + (plotH * i) / (grid + 1);
    gridEls.push(
      `<line x1="0" y1="${n(gy)}" x2="${w}" y2="${n(gy)}" stroke="${CHART.grid}" stroke-width="1" vector-effect="non-scaling-stroke" />`
    );
  }

  const colEls = bars
    .map((b, i) => {
      const x = i * slot + gap / 2;
      let yCursor = h - padBottom;
      const segs = series
        .map((s, si) => {
          const v = Math.max(0, b.values[si] ?? 0);
          if (v <= 0) {
            return '';
          }
          const segH = (v / max) * plotH;
          yCursor -= segH;
          // Round only the very top of the stack for a clean cap.
          const isTop = b.values.slice(si + 1).every((x2) => (x2 ?? 0) <= 0);
          const r = isTop ? Math.min(2.5, barW / 2) : 0;
          return `<rect x="${n(x)}" y="${n(yCursor)}" width="${n(barW)}" height="${n(segH)}" rx="${r}" fill="${s.color}" />`;
        })
        .join('');
      const tip = b.tip ? ` data-tip="${escAttr(b.tip)}" class="col-hit"` : '';
      // A transparent full-height hit-rect makes the whole column hoverable.
      const hit = b.tip
        ? `<rect x="${n(i * slot)}" y="0" width="${n(slot)}" height="${h}" fill="transparent"${tip} />`
        : '';
      return `<g>${segs}${hit}</g>`;
    })
    .join('');

  return `<svg class="cols" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}">
    ${gridEls.join('')}
    ${colEls}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Ring — a progress ring with a label in the middle (Efficiency / Cache).
// ---------------------------------------------------------------------------

export interface RingOpts {
  size?: number;
  thickness?: number;
  color?: string;
  /** Big centre text (e.g. a grade letter or "71%"). */
  label?: string;
  /** Small centre sub-text under the label. */
  sub?: string;
}

/**
 * A single-value progress ring (value 0..1) over a faint track, with centre
 * text. Keeps its aspect ratio (it's a circle) so it is sized in fixed px, not
 * stretched. Used for the efficiency grade and the cache hit rate.
 */
export function ring(value: number, opts: RingOpts = {}): string {
  const size = opts.size ?? 92;
  const th = opts.thickness ?? 9;
  const color = opts.color ?? CHART.blue;
  const v = Math.max(0, Math.min(1, value));
  const r = (size - th) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  const cy = size / 2;
  const dash = `${n(c * v)} ${n(c * (1 - v))}`;
  const label = opts.label
    ? `<text x="${cx}" y="${cy}" class="ring-label" text-anchor="middle" dominant-baseline="central">${escAttr(opts.label)}</text>`
    : '';
  const sub = opts.sub
    ? `<text x="${cx}" y="${cy + size * 0.18}" class="ring-sub" text-anchor="middle" dominant-baseline="central">${escAttr(opts.sub)}</text>`
    : '';
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    <circle cx="${cx}" cy="${cy}" r="${n(r)}" fill="none" stroke="${CHART.track}" stroke-width="${th}" />
    <circle cx="${cx}" cy="${cy}" r="${n(r)}" fill="none" stroke="${color}" stroke-width="${th}"
      stroke-linecap="round" stroke-dasharray="${dash}" transform="rotate(-90 ${cx} ${cy})" />
    ${label}${sub}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Donut — a multi-segment ring with a centre total (token mix breakdown).
// ---------------------------------------------------------------------------

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
  tip?: string;
}

export interface DonutOpts {
  size?: number;
  thickness?: number;
  label?: string;
  sub?: string;
}

/** A multi-segment donut. Segments are drawn as dash-offset arcs over a track. */
export function donut(segments: DonutSegment[], opts: DonutOpts = {}): string {
  const size = opts.size ?? 108;
  const th = opts.thickness ?? 13;
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const r = (size - th) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  const cy = size / 2;
  if (total <= 0) {
    return '';
  }
  let offset = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const frac = s.value / total;
      const len = c * frac;
      // Tiny gap between arcs for definition, but never larger than the arc.
      const gap = Math.min(2, len * 0.18);
      const dash = `${n(Math.max(0, len - gap))} ${n(c - Math.max(0, len - gap))}`;
      const dashoffset = n(-offset);
      offset += len;
      const tip = s.tip ? ` data-tip="${escAttr(s.tip)}"` : '';
      return `<circle cx="${cx}" cy="${cy}" r="${n(r)}" fill="none" stroke="${s.color}" stroke-width="${th}"
        stroke-dasharray="${dash}" stroke-dashoffset="${dashoffset}" transform="rotate(-90 ${cx} ${cy})"${tip} />`;
    })
    .join('');
  const label = opts.label
    ? `<text x="${cx}" y="${cy}" class="ring-label" text-anchor="middle" dominant-baseline="central">${escAttr(opts.label)}</text>`
    : '';
  const sub = opts.sub
    ? `<text x="${cx}" y="${cy + size * 0.17}" class="ring-sub" text-anchor="middle" dominant-baseline="central">${escAttr(opts.sub)}</text>`
    : '';
  return `<svg class="donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    <circle cx="${cx}" cy="${cy}" r="${n(r)}" fill="none" stroke="${CHART.track}" stroke-width="${th}" />
    ${arcs}${label}${sub}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Segmented bar — a single 100%-width stacked bar (HTML; crisp text).
// ---------------------------------------------------------------------------

export interface BarSegment {
  label: string;
  value: number;
  color: string;
  tip?: string;
}

/**
 * One horizontal 100%-stacked bar plus a wrapped legend. HTML/flexbox rather
 * than SVG so the legend text stays crisp and wraps naturally. Used for the
 * token mix (in/out) and the per-message context split.
 */
export function segmentedBar(segments: BarSegment[], opts: { legend?: boolean } = {}): string {
  const showLegend = opts.legend ?? true;
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (total <= 0) {
    return '';
  }
  const parts = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const pct = (s.value / total) * 100;
      const tip = s.tip ? ` data-tip="${escAttr(s.tip)}"` : '';
      return `<span class="segbar-part${s.tip ? ' tip' : ''}" style="width:${n(pct)}%;background:${s.color}"${tip}></span>`;
    })
    .join('');
  const legend = showLegend
    ? `<div class="segbar-legend">${segments
        .filter((s) => s.value > 0)
        .map((s) => {
          const pct = Math.round((s.value / total) * 100);
          return `<span class="segbar-key"><span class="segbar-dot" style="background:${s.color}"></span>${escAttr(
            s.label
          )} <span class="muted">${pct}%</span></span>`;
        })
        .join('')}</div>`
    : '';
  return `<div class="segbar-wrap"><div class="segbar">${parts}</div>${legend}</div>`;
}

// ---------------------------------------------------------------------------
// Ranked bars — labelled horizontal bars, biggest first (HTML; crisp text).
// ---------------------------------------------------------------------------

export interface RankedRow {
  /** Left label — pre-escaped HTML is allowed (e.g. a model <span class="badge">). */
  labelHtml: string;
  value: number;
  /** Right-hand value text — pre-escaped HTML allowed. */
  valueHtml: string;
  color?: string;
  tip?: string;
}

/**
 * Horizontal ranked bars sharing one scale (max = the largest value), so the
 * lengths are directly comparable. Used for model spend. Label and value are
 * passed as already-escaped HTML so callers can embed badges/tags.
 */
export function rankedBars(rows: RankedRow[]): string {
  if (rows.length === 0) {
    return '';
  }
  const max = Math.max(...rows.map((r) => Math.max(0, r.value)), 1);
  return `<div class="ranked">${rows
    .map((r) => {
      const pct = (Math.max(0, r.value) / max) * 100;
      const color = r.color ?? CHART.blue;
      const tip = r.tip ? ` data-tip="${escAttr(r.tip)}"` : '';
      return `<div class="ranked-row${r.tip ? ' tip' : ''}"${tip}>
        <div class="ranked-label">${r.labelHtml}</div>
        <div class="ranked-track"><span class="ranked-fill" style="width:${n(pct)}%;background:${color}"></span></div>
        <div class="ranked-value">${r.valueHtml}</div>
      </div>`;
    })
    .join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Interactive line chart — a trend over time with a crosshair + per-point
// tooltip that follows the mouse. The hover logic lives in the dashboard's
// nonce'd script (it reads the `data-pts` JSON this function emits).
// ---------------------------------------------------------------------------

export interface LinePoint {
  /** X-axis label (e.g. a short date). */
  label: string;
  /** Y value, in the chart's [min,max] domain. */
  value: number;
  /** Rich tooltip shown when this point is hovered. */
  tip: string;
  /** Dot colour (e.g. by grade). Falls back to the line colour. */
  dotColor?: string;
}

export interface LineOpts {
  height?: number;
  min?: number;
  max?: number;
  lineColor?: string;
  /** Faint horizontal zone tints, in value units — give the height meaning. */
  bands?: { from: number; to: number; color: string }[];
  /** Dashed reference gridlines at these values. */
  gridAt?: number[];
  /** Compact "sparkline" mode: no border, bands, gridlines, labels, or static
   *  dots — just the area + line, with the same crosshair/tooltip on hover. For
   *  embedding a glanceable interactive trend inside a small KPI card. */
  bare?: boolean;
}

/**
 * A responsive, interactive line chart. The plot (bands + area + line) is a
 * width-stretched SVG, but the DOTS and the hover marker are HTML elements
 * positioned by percentage — so circles stay perfectly round no matter how wide
 * the panel gets (an SVG <circle> under preserveAspectRatio="none" would smear
 * into an ellipse, which is exactly the stretched "dot" we want to avoid).
 *
 * A fixed [min,max] domain (default 0–100) keeps a tiny real change from looking
 * like a cliff, and the optional grade bands turn the vertical position into
 * something readable at a glance.
 */
export function lineChart(points: LinePoint[], opts: LineOpts = {}): string {
  if (points.length === 0) {
    return '';
  }
  const H = opts.height ?? 160;
  const W = 1000;
  const min = opts.min ?? 0;
  const max = opts.max ?? 100;
  const span = max - min || 1;
  const len = points.length;
  const bare = opts.bare ?? false;
  // Keep a 6% breathing margin top/bottom so points never clip at the edges.
  const vmTop = 0.06;
  const vmBot = 0.06;
  const xpct = (i: number) => (len === 1 ? 50 : (i / (len - 1)) * 100);
  const ypct = (v: number) => {
    const t = Math.max(0, Math.min(1, (v - min) / span));
    return (vmTop + (1 - t) * (1 - vmTop - vmBot)) * 100;
  };
  const sx = (i: number) => (xpct(i) / 100) * W;
  const sy = (v: number) => (ypct(v) / 100) * H;

  const bands = bare
    ? ''
    : (opts.bands ?? [])
        .map((b) => {
          const yTop = sy(b.to);
          const yBot = sy(b.from);
          return `<rect x="0" y="${n(yTop)}" width="${W}" height="${n(Math.max(0, yBot - yTop))}" fill="${b.color}" />`;
        })
        .join('');
  const grids = bare
    ? ''
    : (opts.gridAt ?? [])
        .map(
          (g) =>
            `<line x1="0" y1="${n(sy(g))}" x2="${W}" y2="${n(sy(g))}" stroke="${CHART.grid}" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke" />`
        )
        .join('');

  const lineColor = opts.lineColor ?? CHART.green;
  const linePath = points.map((p, i) => `${i ? 'L' : 'M'}${n(sx(i))} ${n(sy(p.value))}`).join(' ');
  const areaPath = `${linePath} L${n(sx(len - 1))} ${n(H)} L${n(sx(0))} ${n(H)} Z`;

  // Static per-day dots only in full mode; bare mode shows just the hover dot.
  const dots = bare
    ? ''
    : points
        .map(
          (p, i) =>
            `<span class="lc-dot" style="left:${n(xpct(i))}%;top:${n(ypct(p.value))}%;background:${p.dotColor ?? lineColor}"></span>`
        )
        .join('');

  // Thin the x labels so a long history doesn't crowd; always keep the last.
  const step = Math.max(1, Math.ceil(len / 10));
  const labels = bare
    ? ''
    : points
        .map((p, i) => {
          const show = i % step === 0 || i === len - 1;
          return `<span class="lc-xlabel"${show ? '' : ' style="visibility:hidden"'}>${escAttr(p.label)}</span>`;
        })
        .join('');

  // Per-point data for the hover script (positions as %, plus colour + tip).
  const pj = JSON.stringify(
    points.map((p, i) => ({ x: +n(xpct(i)), y: +n(ypct(p.value)), c: p.dotColor ?? lineColor, t: p.tip }))
  );

  return `<div class="linechart-wrap${bare ? ' bare' : ''}">
    <div class="linechart-plot" style="height:${H}px" data-pts="${escAttr(pj)}">
      <svg class="linechart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="${H}">
        ${bands}${grids}
        <path d="${areaPath}" fill="${lineColor}" opacity="0.14" />
        <path d="${linePath}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      </svg>
      <div class="lc-dots">${dots}</div>
      <div class="lc-cross"></div>
      <div class="lc-hot"></div>
      <div class="lc-hit"></div>
    </div>
    ${bare ? '' : `<div class="linechart-x">${labels}</div>`}
  </div>`;
}
