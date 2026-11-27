/**
 * Screen-change goal checks, run *after* the sample has been answered.
 *
 * A live-map sample is a cheap read that the panel polls for; the goal check is
 * the expensive half, because it has to read the foreground window's labels (up
 * to four seconds of OCR). Doing both on the caller's stack made every changed
 * sample wait for the checker. This scheduler takes the change, decides which
 * agents want it, and returns immediately; the read and the records happen on a
 * later tick, so the panel is answered at the speed of the sample.
 *
 * Only one read runs at a time. A change that arrives while a read is in flight
 * is skipped rather than queued: the next sample after the read finishes is a
 * fresher description of the screen anyway, and a queue of stale samples would
 * spend OCR passes on a screen that no longer exists.
 */
import { agentGoal, checkGoal, recordGoalCheck, shouldCheckScreen } from './goal-check.js';

/**
 * @param {object} options
 * @param {() => Promise<object>} options.readScreen  background window labels
 * @param {() => void} [options.persist]              saves the recorded checks
 * @param {() => string} [options.now]                ISO clock; the caller owns it
 * @param {(fn: () => Promise<void>) => void} [options.schedule]  deferred runner
 */
export function createScreenGoalChecker({
  readScreen,
  persist = () => {},
  now = () => new Date().toISOString(),
  schedule = (fn) => setImmediate(fn),
} = {}) {
  if (typeof readScreen !== 'function') throw new Error('createScreenGoalChecker needs a screen reader');
  let running = false;

  return {
    /**
     * Ask for the checks this change deserves and return at once.
     *
     * @param {object} sample  the live-map sample that just changed
     * @param {Array<object>} agents  every agent, enabled or not; the opt-in and
     *   the throttle are decided by `shouldCheckScreen`
     * @returns {boolean} whether a deferred check was started
     */
    trigger(sample, agents = []) {
      if (running || !sample || sample.error) return false;
      const at = now();
      const clock = Date.parse(at);
      const due = (Array.isArray(agents) ? agents : []).filter((agent) =>
        shouldCheckScreen(agent, sample, { at: Number.isFinite(clock) ? clock : Date.now() })
      );
      if (!due.length) return false;
      running = true;
      schedule(async () => {
        try {
          const screen = await readScreen();
          for (const agent of due) {
            agent.screenCheckedAt = at;
            recordGoalCheck(agent, checkGoal({ goal: agentGoal(agent), trigger: 'screen', screen, at }));
          }
          persist();
        } catch {
          // A failed read is the checker's problem, never the sample's.
        } finally {
          running = false;
        }
      });
      return true;
    },
    get busy() {
      return running;
    },
  };
}
