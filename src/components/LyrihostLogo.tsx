export function LyrihostLogo() {
  return (
    <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
      <svg
        width="26"
        height="26"
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="shrink-0"
      >
        <path
          d="M16 2L28.5 9.2V22.8L16 30L3.5 22.8V9.2L16 2Z"
          stroke="#dc2626"
          strokeWidth="1.5"
          fill="#120508"
        />
        <path
          d="M16 5.5L25.5 11V21L16 26.5L6.5 21V11L16 5.5Z"
          stroke="#7f1d1d"
          strokeWidth="1"
          fill="none"
        />
        <path
          d="M12.5 11.5V20H19.5"
          stroke="#f87171"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="20.5" cy="12" r="2" fill="#ef4444" />
      </svg>
      <span className="font-display text-xl font-semibold tracking-tight text-slate-100">
        Lyri<span className="italic text-red-400">host</span>
      </span>
    </div>
  );
}
