/**
 * @param {import('../tondebug/tondebug.ts').Message[]} queue
 */
export function modifyQueue(queue) {
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
}

// module.exports.modifyQueue = modifyQueue;