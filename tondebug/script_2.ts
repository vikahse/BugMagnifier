import type { Message } from './tondebug.ts';

const typePriority: Record<Message['type'], number> = {
  'external-in':    0,
  'internal':       1,
  'external-out':   2,
};

export function modifyQueue(queue: Message[]): void {
  queue.sort((a, b) => {
    const byType = typePriority[a.type] - typePriority[b.type];
    if (byType !== 0) return byType;
    const coinsA = a.value?.coins ?? 0n;
    const coinsB = b.value?.coins ?? 0n;
    return coinsB > coinsA ? 1 : coinsB < coinsA ? -1 : 0;
  });
}
