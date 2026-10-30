const PATHS: Record<string, string> = {
  check: "M4 10.5l4 4 8-9",
  block: "M10 2.5a7.5 7.5 0 100 15 7.5 7.5 0 000-15zM4.7 4.7l10.6 10.6",
  pause: "M7.5 4.5v11M12.5 4.5v11",
  user: "M10 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM3.5 17c.8-3.2 3.3-5 6.5-5s5.7 1.8 6.5 5",
  send: "M3 10h13M11 4.5l5.5 5.5-5.5 5.5",
  paid: "M10 2.5a7.5 7.5 0 100 15 7.5 7.5 0 000-15zM6.5 10.3l2.4 2.4 4.6-5.2",
  alert: "M10 3l8 14H2L10 3zM10 8.5v4M10 14.8v.2",
  agent: "M5 7h10a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2V9a2 2 0 012-2zM10 3v4M7.5 12h.01M12.5 12h.01",
  shield: "M10 2.5l6.5 2.5v4.5c0 4-2.7 6.8-6.5 8-3.8-1.2-6.5-4-6.5-8V5L10 2.5z",
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name] ?? PATHS.shield} />
    </svg>
  );
}
