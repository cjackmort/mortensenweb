/**
 * Small line icons for service/capability cards. No icon library — a
 * handful of shapes used a few times each doesn't earn a dependency on a
 * static-export brochure site.
 */
type IconProps = { className?: string };

const commonProps = {
  width: 28,
  height: 28,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  "aria-hidden": true,
} as const;

export function DesignIcon({ className = "card__icon" }: IconProps) {
  return (
    <svg className={className} {...commonProps}>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 9h18M8 9v11" />
    </svg>
  );
}

export function ShieldIcon({ className = "card__icon" }: IconProps) {
  return (
    <svg className={className} {...commonProps}>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function EditIcon({ className = "card__icon" }: IconProps) {
  return (
    <svg className={className} {...commonProps}>
      <path d="M4 20l1-4L16 5l3 3L8 19l-4 1z" />
      <path d="M13 8l3 3" />
    </svg>
  );
}

export function PhoneIcon({ className = "card__icon" }: IconProps) {
  return (
    <svg className={className} {...commonProps}>
      <rect x="7" y="2" width="10" height="20" rx="1.5" />
      <path d="M11 18h2" />
    </svg>
  );
}

export function ChartIcon({ className = "card__icon" }: IconProps) {
  return (
    <svg className={className} {...commonProps}>
      <path d="M4 20V10M12 20V4M20 20v-7" />
      <path d="M3 20h18" />
    </svg>
  );
}

export function SearchIcon({ className = "card__icon" }: IconProps) {
  return (
    <svg className={className} {...commonProps}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M20 20l-5-5" />
    </svg>
  );
}
