import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

/** The mark: one trajectory crossing the separatrix and splitting into both branches. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="lg-up" x1="0" x2="1"><stop offset="0" stopColor="#e9f0ee" /><stop offset="1" stopColor="#3fd8c0" /></linearGradient>
        <linearGradient id="lg-down" x1="0" x2="1"><stop offset="0" stopColor="#e9f0ee" /><stop offset="1" stopColor="#f2a25c" /></linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="#0f161a" stroke="rgba(214,236,230,.14)" />
      <path d="M5 16h7" stroke="#e9f0ee" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M12 16c4 0 6-7 15-8" stroke="url(#lg-up)" strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <path d="M12 16c4 0 6 7 15 8" stroke="url(#lg-down)" strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <circle cx="12" cy="16" r="1.7" fill="#e9f0ee" />
    </svg>
  );
}

export const IconGithub = ({ size = 16, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...rest}>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);
export const IconStar = ({ size = 15, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
    <path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" />
  </svg>
);
export const IconPlay = (p: P) => <Svg {...p}><path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" /></Svg>;
export const IconPause = (p: P) => <Svg {...p}><path d="M8 5v14M16 5v14" strokeWidth={3} /></Svg>;
export const IconReplay = (p: P) => <Svg {...p}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></Svg>;
export const IconShare = (p: P) => <Svg {...p}><path d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" /><path d="M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" /></Svg>;
export const IconDownload = (p: P) => <Svg {...p}><path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 20h16" /></Svg>;
export const IconCopy = (p: P) => <Svg {...p}><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Svg>;
export const IconCheck = (p: P) => <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>;
export const IconX = (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>;
export const IconMenu = (p: P) => <Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>;
export const IconArrow = (p: P) => <Svg className="i-arrow" {...p}><path d="M5 12h14m-5-5 5 5-5 5" /></Svg>;
export const IconBolt = (p: P) => <Svg {...p}><path d="M13 2 4.5 13.5H12L11 22l8.5-11.5H12z" /></Svg>;
export const IconShield = (p: P) => <Svg {...p}><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V6z" /><path d="m9 12 2 2 4-4" /></Svg>;
export const IconCode = (p: P) => <Svg {...p}><path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" /></Svg>;
export const IconAtom = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="1.6" fill="currentColor" />
    <ellipse cx="12" cy="12" rx="10" ry="4.2" />
    <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(120 12 12)" />
  </Svg>
);
export const IconGraph = (p: P) => <Svg {...p}><circle cx="5" cy="6" r="2.2" /><circle cx="19" cy="7" r="2.2" /><circle cx="8" cy="18" r="2.2" /><circle cx="18" cy="17" r="2.2" /><path d="M7 6.6 16.8 7M6 8l1.5 7.9M10.2 18l5.6-.8M18.7 9.2l-.4 5.6M6.8 7.6l9.5 8" /></Svg>;
export const IconScale = (p: P) => <Svg {...p}><path d="M12 3v18M5 21h14M4 8h16M7 8l-3 7a3.5 3.5 0 0 0 6 0zM17 8l-3 7a3.5 3.5 0 0 0 6 0z" /></Svg>;
export const IconDots = (p: P) => <Svg {...p}><circle cx="6" cy="7" r="2.2" /><circle cx="18" cy="7" r="2.2" /><circle cx="12" cy="17" r="2.2" fill="currentColor" /><circle cx="6" cy="17" r="2.2" fill="currentColor" /><path d="M8 7h8" /></Svg>;
export const IconChart = (p: P) => <Svg {...p}><path d="M4 20V4M4 20h16" /><path d="m7 15 4-5 3 3 5-6" /></Svg>;
export const IconMatrix = (p: P) => <Svg {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16" /></Svg>;
export const IconExternal = (p: P) => <Svg {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Svg>;
export const IconDice = (p: P) => <Svg {...p}><rect x="4" y="4" width="16" height="16" rx="3.5" /><circle cx="9" cy="9" r="1" fill="currentColor" /><circle cx="15" cy="15" r="1" fill="currentColor" /><circle cx="15" cy="9" r="1" fill="currentColor" /><circle cx="9" cy="15" r="1" fill="currentColor" /></Svg>;
