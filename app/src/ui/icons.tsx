/** Stroke icons, 24-unit grid. Colour defaults to cream; pass c.accent for gold marks. */
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { c } from '../lib/theme';

type P = { size?: number; color?: string; width?: number };

const icon = (draw: (color: string) => React.ReactNode) =>
  function Icon({ size = 24, color = c.fg, width = 2 }: P) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
        {draw(color)}
      </Svg>
    );
  };

export const ArrowUp = icon(() => <Path d="M7 17 17 7M8 7h9v9" />);
export const ArrowDown = icon(() => <Path d="M17 7 7 17M16 17H7V8" />);
export const Back = icon(() => <Path d="M15 5l-7 7 7 7" />);
export const Close = icon(() => <Path d="M6 6l12 12M18 6 6 18" />);
export const Check = icon(() => <Path d="M5 12.5l4.5 4.5L19 7.5" />);
export const Scan = icon(() => (
  <>
    <Path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
    <Path d="M7 12h10" />
  </>
));
export const Home = icon(() => <Path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />);
export const List = icon(() => <Path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />);
export const Gear = icon(() => (
  <>
    <Circle cx={12} cy={12} r={3} />
    <Path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </>
));
export const Copy = icon(() => (
  <>
    <Rect x={9} y={9} width={11} height={11} rx={2} />
    <Path d="M5 15V5a1 1 0 0 1 1-1h10" />
  </>
));
export const Share = icon(() => <Path d="M12 4v11M7 9l5-5 5 5M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />);
export const Fingerprint = icon(() => (
  <Path d="M12 11v3a8 8 0 0 1-1.5 4.7M8.5 7.6A5 5 0 0 1 17 11v2a12 12 0 0 1-.6 3.8M7 11a5 5 0 0 1 .3-1.7M7 14.5a12 12 0 0 1-1.2 3.3M20 12.5V11a8 8 0 0 0-14.2-5M4 11v1.5M14 19.5c.3-.6.6-1.3.8-2" />
));
export const Message = icon(() => <Path d="M4 5h16v11H9l-5 4z" />);
export const Globe = icon(() => (
  <>
    <Circle cx={12} cy={12} r={9} />
    <Path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </>
));
export const Person = icon(() => (
  <>
    <Circle cx={12} cy={8} r={4} />
    <Path d="M4 20a8 8 0 0 1 16 0" />
  </>
));
export const Phone = icon(() => <Path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z" />);
export const Bolt = icon(() => <Path d="M13 3 5 13h6l-1 8 8-10h-6z" />);
export const Torch = icon(() => <Path d="M8 3h8v4l-2 3v11h-4V10L8 7zM8 7h8" />);
export const Alert = icon(() => <Path d="M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />);
export const Signal = icon(() => <Path d="M4 20v-3M9 20v-6M14 20V9M19 20V4" />);
export const Plus = icon(() => <Path d="M12 5v14M5 12h14" />);
export const Chevron = icon(() => <Path d="M9 6l6 6-6 6" />);
