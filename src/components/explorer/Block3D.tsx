import type { CSSProperties, ReactNode } from "react";

interface Block3DProps {
  /** CSS color expression for cube faces, e.g. `var(--fee-3)` */
  color: string;
  /** Size of the cube face in px. Defaults to 140. */
  size?: number;
  /** Cube depth in px. Defaults to 40. */
  depth?: number;
  /** Tilt about Y axis (deg). Negative shows right face on the right. */
  rotateY?: number;
  /** Tilt about X axis (deg). Negative shows top face. */
  rotateX?: number;
  /** Optional scale (for receding chain). */
  scale?: number;
  /** "Empty" portion from the top — 0 means fully filled, 100 means fully empty. */
  emptyPct?: number;
  /** Content rendered on the front face. */
  children: ReactNode;
  className?: string;
}

/**
 * A real CSS 3D cube — front / top / right faces with photorealistic shading
 * (multi-stop gradients, specular highlight, inset bevels, ambient occlusion).
 * Uses the centered-face pattern: each face is placed at the cube's center
 * then translated to its half-extent and rotated.
 */
export function Block3D({
  color,
  size = 140,
  depth = 40,
  rotateY = -28,
  rotateX = -18,
  scale = 1,
  emptyPct = 0,
  children,
  className,
}: Block3DProps) {
  const halfD = depth / 2;
  const halfS = size / 2;

  const containerStyle: CSSProperties = {
    width: size,
    height: size,
    position: "relative",
    transformStyle: "preserve-3d",
    transform: `rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(${scale})`,
    ["--c" as any]: color,
    ["--empty" as any]: `${emptyPct}%`,
  };

  const faceBase: CSSProperties = {
    position: "absolute",
    top: "50%",
    left: "50%",
    boxSizing: "border-box",
  };

  return (
    <div
      className={`cube-3d ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        position: "relative",
        // outer wrapper just for hover lift; cube nested for transform
      }}
    >
      <div style={containerStyle}>
        {/* Top face: size × depth, translated up by S/2, rotated −90deg around X */}
        <div
          className="cube-face cube-top"
          style={{
            ...faceBase,
            width: size,
            height: depth,
            transform: `translate(-50%, -50%) translate3d(0, -${halfS}px, 0) rotateX(90deg) translateZ(${halfD}px)`,
          }}
        />
        {/* Right face: depth × size */}
        <div
          className="cube-face cube-right"
          style={{
            ...faceBase,
            width: depth,
            height: size,
            transform: `translate(-50%, -50%) translate3d(${halfS}px, 0, 0) rotateY(90deg) translateZ(${halfD}px)`,
          }}
        />
        {/* Front face: size × size, translated forward by D/2 */}
        <div
          className="cube-face cube-front"
          style={{
            ...faceBase,
            width: size,
            height: size,
            transform: `translate(-50%, -50%) translateZ(${halfD}px)`,
          }}
        >
          <div className="cube-front-fill" />
          <div className="relative z-10 size-full flex flex-col items-center justify-center text-white text-center px-2">
            {children}
          </div>
        </div>
        <div className="cube-shadow" />
      </div>
    </div>
  );
}
