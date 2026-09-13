import { OperatorConsole } from '@/app/_components/operator-console';
import { dayThreeEvidence } from '@/data/day-three';

export default function Home() {
  return <OperatorConsole evidence={dayThreeEvidence} />;
}
