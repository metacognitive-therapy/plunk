import {describe, it, expect} from 'vitest';
import {WorkflowTriggerType} from '@plunk/db';
import {EventService} from '../../apps/api/src/services/EventService';
import {factories, getPrismaClient} from '../helpers';

/**
 * Performance test: docs/issues/06-trigger-name-cache.md
 *
 * `EventService.trackEvent` must consult the cached set of trigger event names (and the
 * wait-for-event flag) BEFORE running workflow-trigger evaluation or the waiting-execution
 * lookup, and skip both for an event name that cannot possibly match. The cost of tracking
 * a non-triggering event must therefore stay flat as the variety of distinct event names
 * seen by the project grows - it must never scale with how many different names have been
 * tracked before.
 *
 * Deliberately does NOT follow the seed-heavy `beforeEach` pattern that
 * docs/issues/09-fix-perf-test-fixtures.md diagnoses: no fixture here is seeded in a
 * `beforeEach` ahead of the global per-test `afterEach` truncation, and each `it` creates
 * only the small amount of data it personally needs, once, inline.
 */
describe('Performance: trigger-name cache keeps per-event cost flat', () => {
  const prisma = getPrismaClient();

  it('does not slow down as the number of distinct non-triggering event names grows', async () => {
    const {project} = await factories.createUserWithProject();
    const projectId = project.id;
    const contact = await factories.createContact({projectId});

    // One enabled workflow exists, but it triggers on a name none of the tracked events below
    // will ever use - every tracked event here is a miss against the cached trigger-name set.
    await factories.createWorkflow({
      projectId,
      enabled: true,
      triggerType: WorkflowTriggerType.EVENT,
      triggerConfig: {eventName: 'real.trigger.never.fired'},
    });

    async function trackDistinctEvents(count: number, offset: number): Promise<number> {
      const start = process.hrtime.bigint();
      for (let i = 0; i < count; i++) {
        await EventService.trackEvent(projectId, `noop.event.${offset + i}`, contact.id);
      }
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      return elapsedMs / count;
    }

    // Warm the cache (first call always pays the cache-miss cost of computing the entry).
    await trackDistinctEvents(5, 0);

    // A small batch, then a much larger one - both made up of event names never seen before.
    // If cost scaled with the number of distinct names the project has accumulated, the
    // second batch's per-event average would be far higher than the first's.
    const smallBatchAvgMs = await trackDistinctEvents(20, 1000);
    const largeBatchAvgMs = await trackDistinctEvents(300, 100000);

    // Every event is still recorded in full, regardless of the short-circuit.
    const totalEvents = await prisma.event.count({where: {projectId}});
    expect(totalEvents).toBe(5 + 20 + 300);

    // Generous multiplier: this guards against O(n) growth (or worse), not against normal
    // run-to-run jitter on a shared/contended machine.
    expect(largeBatchAvgMs).toBeLessThan(smallBatchAvgMs * 5 + 20);

    // And an absolute ceiling in line with the project's write-latency target - tracking a
    // non-triggering event is one INSERT plus one cache read, not a workflow evaluation.
    expect(largeBatchAvgMs).toBeLessThan(200);
  }, 60000);
});
