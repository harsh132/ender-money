import Svg, { Path, Rect } from 'react-native-svg';
import { c } from '../lib/theme';

/** App mark: a speech bubble carrying a dollar sign, gold on surface. */
export const Mark = ({ size = 96 }: { size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 96 96">
    <Rect x={0.5} y={0.5} width={95} height={95} rx={30} fill={c.surface} stroke={c.line} />
    <Path d="M26 30h44a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H44l-12 10v-10h-6a4 4 0 0 1-4-4V34a4 4 0 0 1 4-4z" fill="none" stroke={c.accent} strokeWidth={3.5} strokeLinejoin="round" />
    <Path d="M53 39.5c-1.2-1.6-3-2.5-5-2.5-3 0-5 1.6-5 4s2.2 3.3 5 4 5 1.6 5 4-2 4-5 4c-2.2 0-4-1-5.2-2.6M48 34v3M48 53v3" fill="none" stroke={c.accent} strokeWidth={3} strokeLinecap="round" />
  </Svg>
);
