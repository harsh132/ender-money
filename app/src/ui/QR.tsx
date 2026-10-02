import qrcodeGenerator from 'qrcode-generator';
import { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import { c } from '../lib/theme';

/** Dark modules on cream, drawn as one path. */
export const QR = ({ value, size = 216 }: { value: string; size?: number }) => {
  const { d, n } = useMemo(() => {
    const qr = qrcodeGenerator(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let path = '';
    for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) if (qr.isDark(y, x)) path += `M${x} ${y}h1v1h-1z`;
    return { d: path, n: count };
  }, [value]);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${n} ${n}`}>
      <Rect width={n} height={n} fill={c.fg} />
      <Path d={d} fill={c.bg} />
    </Svg>
  );
};
