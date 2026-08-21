// A checklist's state as one small ring: quiet while in progress, a filled
// check the moment everything is done.
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export function ProgressRing({
  done,
  total,
  className,
}: {
  done: number;
  total: number;
  className?: string;
}) {
  if (total <= 0) return null;
  if (done >= total) {
    return (
      <Icon
        name="Check"
        className={cn("size-3.5 text-primary", className)}
        aria-label={`${total} tasks, all done`}
      />
    );
  }
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.max(0, Math.min(1, done / total));
  return (
    <svg
      viewBox="0 0 14 14"
      className={cn("size-3.5 -rotate-90", className)}
      role="img"
      aria-label={`${done} of ${total} tasks done`}
    >
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        strokeWidth="2"
        className="stroke-border"
      />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-primary"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
      />
    </svg>
  );
}
