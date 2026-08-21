// A one-shot confetti micro-burst for a completed checklist.
//
// Hand-rolled on a throwaway canvas: ~40 particles, under a second, no
// dependency, removed from the DOM when the last particle dies. Respects
// prefers-reduced-motion by doing nothing at all.

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rotation: number;
  spin: number;
  color: string;
  life: number;
}

const COLORS = [
  "oklch(0.8 0.15 95)",
  "oklch(0.72 0.14 160)",
  "oklch(0.68 0.13 235)",
  "oklch(0.7 0.15 18)",
  "oklch(0.7 0.13 296)",
  "oklch(0.75 0.14 50)",
];

const PARTICLES = 40;
const LIFE_MS = 900;
const GRAVITY = 0.12;

/** Fire a burst from (x, y) in viewport coordinates. */
export function confettiBurst(x: number, y: number): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.createElement("canvas");
  canvas.className = "bb-fn-confetti";
  canvas.width = window.innerWidth * window.devicePixelRatio;
  canvas.height = window.innerHeight * window.devicePixelRatio;
  const context = canvas.getContext("2d");
  if (context === null) return;
  context.scale(window.devicePixelRatio, window.devicePixelRatio);
  document.body.append(canvas);

  const particles: Particle[] = Array.from({ length: PARTICLES }, (_, index) => {
    const angle = (Math.PI * 2 * index) / PARTICLES + Math.random() * 0.5;
    const speed = 2 + Math.random() * 4;
    return {
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2.5,
      size: 3 + Math.random() * 4,
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.3,
      color: COLORS[index % COLORS.length]!,
      life: 1,
    };
  });

  const started = performance.now();
  const frame = (now: number) => {
    const elapsed = now - started;
    if (elapsed > LIFE_MS) {
      canvas.remove();
      return;
    }
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const fade = 1 - elapsed / LIFE_MS;
    for (const particle of particles) {
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.vy += GRAVITY;
      particle.rotation += particle.spin;
      context.save();
      context.globalAlpha = fade;
      context.translate(particle.x, particle.y);
      context.rotate(particle.rotation);
      context.fillStyle = particle.color;
      context.fillRect(
        -particle.size / 2,
        -particle.size / 2,
        particle.size,
        particle.size * 0.6,
      );
      context.restore();
    }
    window.requestAnimationFrame(frame);
  };
  window.requestAnimationFrame(frame);
}
