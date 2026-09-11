import React from "react";

interface CircularProgressRingProps {
  progress: number; // 0 - 100
  sizePx?: number;
  strokeWidth?: number;
  isIndeterminate?: boolean;
  centerText?: string;
  subText?: string;
}

export function CircularProgressRing({
  progress,
  sizePx = 96,
  strokeWidth = 6.5,
  isIndeterminate = false,
  centerText,
  subText,
}: CircularProgressRingProps) {
  // Radius for the inner progress bar (leaving room for the outer animated loop)
  const outerPadding = 6;
  const innerSize = sizePx - outerPadding * 2;
  const radius = (innerSize - strokeWidth * 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const clampedProgress = Math.min(100, Math.max(0, progress));
  const strokeDashoffset = circumference - (clampedProgress / 100) * circumference;

  return (
    <div
      className="relative inline-flex items-center justify-center shrink-0 select-none"
      style={{ width: sizePx, height: sizePx }}
    >
      {/* Outer continuous looping animation ring */}
      <div className="absolute inset-0 rounded-full animate-spin [animation-duration:2.2s] pointer-events-none p-0.5">
        <div className="h-full w-full rounded-full border-[2px] border-slate-200 border-t-[#11120d]" />
      </div>

      {/* Inner deterministic progress SVG ring */}
      <svg
        className="h-full w-full -rotate-90 transform p-1.5"
        viewBox={`0 0 ${innerSize} ${innerSize}`}
      >
        {/* Inner background track */}
        <circle
          cx={innerSize / 2}
          cy={innerSize / 2}
          r={radius}
          fill="none"
          stroke="#E5E7EB"
          strokeWidth={strokeWidth}
        />

        {/* Inner active progress track with solid brand black color */}
        <circle
          cx={innerSize / 2}
          cy={innerSize / 2}
          r={radius}
          fill="none"
          stroke="#11120d"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={isIndeterminate ? circumference * 0.75 : strokeDashoffset}
          className={isIndeterminate ? "animate-pulse" : "transition-[stroke-dashoffset] duration-700 ease-out"}
        />
      </svg>

      {/* Center percentage & page text */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-1">
        <span className="text-[17px] font-black text-[#11120d] tracking-tight tabular-nums">
          {centerText ?? `${clampedProgress}%`}
        </span>
        {subText ? (
          <span className="text-[9.5px] font-extrabold uppercase text-slate-500 tracking-wider">
            {subText}
          </span>
        ) : null}
      </div>
    </div>
  );
}
