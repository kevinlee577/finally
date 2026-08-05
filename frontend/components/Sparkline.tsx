/**
 * Watchlist mini-chart (PLAN §10). Points accumulate on the client from the SSE
 * stream since page load, so this fills in progressively rather than showing
 * history the app never received.
 *
 * Hand-drawn SVG rather than a charting library: one of these renders per
 * watchlist row on every tick, and a polyline is the whole job.
 */
interface SparklineProps {
  points: number[];
  width?: number;
  height?: number;
  /** Direction over the whole window, which is what colours the line. */
  tone: "up" | "down" | "flat";
  label?: string;
}

const TONE_VAR = {
  up: "var(--color-up)",
  down: "var(--color-down)",
  flat: "var(--color-faint)",
} as const;

export function Sparkline({ points, width = 64, height = 18, tone, label }: SparklineProps) {
  if (points.length < 2) {
    // One point is not a trend. A flat hairline reads as "still filling in".
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label ? `${label}: not enough data yet` : "not enough data yet"}
        data-testid="sparkline-empty"
      >
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--color-edge-strong)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const pad = 1.5;
  const usable = height - pad * 2;

  const coords = points.map((price, index) => {
    const x = index * step;
    const y = pad + (1 - (price - min) / span) * usable;
    return [x, y] as const;
  });

  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} ${width},${height} 0,${height}`;
  const stroke = TONE_VAR[tone];
  const [lastX, lastY] = coords[coords.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label ? `${label} price trend, ${tone}` : `price trend, ${tone}`}
      data-testid="sparkline"
      data-tone={tone}
    >
      <polygon points={area} fill={stroke} opacity={0.1} />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lastX} cy={lastY} r={1.5} fill={stroke} />
    </svg>
  );
}
