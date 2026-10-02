import { Redirect } from 'expo-router';
import { useStore } from '../lib/store';

export default function Index() {
  const wallet = useStore((s) => s.wallet);
  return <Redirect href={wallet ? '/home' : '/welcome'} />;
}
