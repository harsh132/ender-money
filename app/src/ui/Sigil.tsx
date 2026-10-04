/**
 * Urbit sigil as the wallet's avatar (ported from wallet2). The address's first
 * 32 bits (a private address's: its owner key's) name an Urbit planet, and @urbit/sigil-js draws that name. Same
 * address, same picture, on every device. Decoration over public data, not a
 * checksum: four bytes collide long before an address does, so screens that
 * confirm a recipient always show the address text too.
 */
import sigil from '@urbit/sigil-js/core';
import { useMemo } from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { patp } from 'urbit-ob';
import { bytesToHex } from 'viem';
import { decodePrivateAddress } from '../../../protocol/recipient';
import { c } from '../lib/theme';
import { Avatar } from './kit';

/** Galaxies and stars draw one or two glyphs; force everything into the four-glyph planet range. */
const PLANET_FLOOR = 0x10000;

/** A private address (ender1…) draws from its owner key's first four bytes. */
const head = (address: string) => {
  const packed = address.startsWith('ender1') ? decodePrivateAddress(address) : null;
  return packed ? bytesToHex(packed.subarray(0, 4)).slice(2) : /^0x([0-9a-fA-F]{8})/.exec(address)?.[1];
};

const pointFor = (address: string): string | null => {
  const hex = head(address);
  if (!hex) return null;
  const n = Number.parseInt(hex, 16);
  try {
    return patp(n < PLANET_FLOOR ? n + PLANET_FLOOR : n);
  } catch {
    return null;
  }
};

/** `fill`: share of the disc the glyphs take; 0.64 is the most that clears the rim. */
export const Sigil = ({ address, fallback, size = 48, fill = 0.64 }: { address: string | undefined; fallback: string; size?: number; fill?: number }) => {
  // Gold: a sigil is an identity mark, one of the small marks the palette allows the accent on.
  // Drawn edge to edge (space: none), then centred in the disc.
  const inner = Math.round(size * fill);
  const xml = useMemo(() => {
    const point = address ? pointFor(address) : null;
    if (!point) return null;
    try {
      return sigil({ point, size: inner, background: c.surface2, foreground: c.accent, detail: 'none', space: 'none' })
        // DOM markup: a CSS style string react-native-svg ignores, and a lowercase viewbox it doesn't parse.
        .replace(/\sstyle="[^"]*"/, '')
        .replace(/\sviewbox=/, ' viewBox=');
    } catch {
      return null;
    }
  }, [address, inner]);

  if (!xml) return <Avatar label={fallback} size={size} />;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden', backgroundColor: c.surface2, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
      <SvgXml xml={xml} width={inner} height={inner} />
    </View>
  );
};
